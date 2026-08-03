// Fase 4 del Asistente Comercial: el campo `origen` viaja en las
// respuestas HTTP de cotizaciones (para que el panel pueda distinguir
// "generada por IA" de "creada manualmente"), y el panel muestra el
// badge correspondiente + resalta partidas con precio pendiente + sabe
// reaccionar al evento WS 'cotizacion_borrador_ia'. Los checks de HTML
// son estáticos (regex sobre panel/index.html), mismo criterio que
// fase-controles-atencion-frontend.mjs -- no requieren navegador real.
//
// Uso: DATABASE_URL=... node test/fase-asistente-comercial-4-panel.mjs
// Requiere aplicar-migraciones.mjs y seed-datos-prueba.mjs ya corridos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4130';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, crearCotizacion } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
function cookieHeader(usuarioId, negocioId, rol) { return `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`; }
async function api(base, path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(
    `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
     ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`,
    [negocioId, modulo, estado]
  );
}
await fijarModulo(SEED.negocioA, 'cotizaciones', 'activo');
await fijarModulo(SEED.negocioA, 'generador_cotizaciones', 'activo');

const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = `http://localhost:${PUERTO}`;

// ═══════════ HTTP: origen viaja en las respuestas ═══════════

let cotizacionIA;
await t('HTTP', 'setup: crear una cotización con origen=whatsapp_ia directamente en DB', async () => {
  cotizacionIA = await crearCotizacion({
    negocioId: SEED.negocioA, telefono: '+528781130001', createdBy: null,
    items: [{ tipo: 'servicio', descripcion: 'Prueba panel (precio pendiente de revisión)', cantidad: 1, precioUnitario: 0 }],
    origen: 'whatsapp_ia',
  });
});

await t('HTTP', 'GET /api/cotizaciones incluye origen=whatsapp_ia para esa fila', async () => {
  const r = await api(base, '/api/cotizaciones', { cookie: cookieAdminA });
  assert.strictEqual(r.status, 200);
  const fila = r.body.find(c => c.id === cotizacionIA.id);
  assert.ok(fila, 'la cotización debe aparecer en la lista');
  assert.strictEqual(fila.origen, 'whatsapp_ia');
});

await t('HTTP', 'GET /api/cotizaciones/:id incluye origen e items con precio_unitario=0', async () => {
  const r = await api(base, `/api/cotizaciones/${cotizacionIA.id}`, { cookie: cookieAdminA });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.origen, 'whatsapp_ia');
  assert.strictEqual(Number(r.body.items[0].precio_unitario), 0);
});

let cotizacionPanel;
await t('HTTP', 'una cotización creada por el panel (POST) tiene origen=panel por defecto', async () => {
  const r = await api(base, '/api/cotizaciones', {
    cookie: cookieAdminA, method: 'POST',
    body: { telefono: '+528781130002', items: [{ tipo: 'servicio', descripcion: 'Manual', cantidad: 1, precioUnitario: 100 }] },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.origen, 'panel');
  cotizacionPanel = r.body;
});

// ═══════════ HTML estático: badge, resaltado, manejo de WS ═══════════

const html = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');

await t('HTML', 'badge "IA" condicionado a origen === whatsapp_ia', () => {
  assert.match(html, /c\.origen === 'whatsapp_ia'[\s\S]{0,400}🤖 IA/);
});

await t('HTML', 'resalta partidas con precio_unitario 0 (pendiente de revisión)', () => {
  assert.match(html, /precioPendiente = item && Number\(item\.precio_unitario\) === 0/);
  assert.match(html, /Precio pendiente de revisión/);
});

await t('HTML', 'maneja el evento WS cotizacion_borrador_ia con notificación', () => {
  assert.match(html, /msg\.tipo === 'cotizacion_borrador_ia'/);
  assert.match(html, /Nueva cotización borrador generada por el Asistente Comercial/);
  assert.match(html, /cargarCotizaciones\(\)/);
});

// ═══════════ Resumen ═══════════
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
