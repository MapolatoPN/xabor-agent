// Fase 5 del Asistente Comercial de Cotizaciones por WhatsApp -- prueba
// END TO END del flujo completo pedido en el encargo: texto por WhatsApp
// -> IntentDetector -> sesión comercial -> extracción de campos a lo
// largo de 2 turnos -> <BORRADOR_LISTO> -> cotización real en 'borrador'
// (con precio real del catálogo) -> aprobación humana explícita
// (POST /api/cotizaciones/:id/enviar, ya admin-only) -> envío real (Meta
// mockeada) -> la sesión comercial se finaliza.
//
// Nunca llama a Claude/Anthropic real (lib-anthropic-mock.mjs) ni a Meta
// real (lib-meta-mock.mjs) -- mismo criterio que el resto de esta
// batería con servicios externos de pago.
//
// Uso: DATABASE_URL=... INTEGRATIONS_ENCRYPTION_KEY=... PANEL_SECRET=...
//      SESSION_SECRET=... ADMIN_PASSWORD=... PANEL_PASSWORD=...
//      node test/fase-asistente-comercial-5-e2e.mjs
// Requiere aplicar-migraciones.mjs y seed-datos-prueba.mjs ya corridos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4140';
const TELEFONO_CLIENTE = '5218789940001';
const PNID = 'PNID_ASISTENTE_COMERCIAL_A';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, actualizarConfiguracion } = await import('../src/services/database.js');

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

// ═══════════ Setup: negocio A con el asistente habilitado ═══════════
await fijarModulo(SEED.negocioA, 'cotizaciones', 'activo');
await fijarModulo(SEED.negocioA, 'generador_cotizaciones', 'activo');
await fijarModulo(SEED.negocioA, 'chat_documentos_pdf', 'activo');
await pool.query(`UPDATE negocios SET bot_whatsapp_activo = true WHERE id = $1`, [SEED.negocioA]);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,'Prueba asistente comercial A', TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [SEED.negocioA, PNID]);
await actualizarConfiguracion({ int_wa_phone_id: PNID, int_wa_token: 'fake-token-asistente-a' }, SEED.negocioA);
await pool.query(`DELETE FROM sesiones_comerciales WHERE negocio_id = $1 AND telefono = $2`, [SEED.negocioA, TELEFONO_CLIENTE]);
await pool.query(`DELETE FROM cotizaciones WHERE negocio_id = $1 AND telefono = $2`, [SEED.negocioA, TELEFONO_CLIENTE]);
await pool.query(`DELETE FROM mensajes WHERE telefono = $1 AND negocio_id = $2`, [TELEFONO_CLIENTE, SEED.negocioA]);
// clienteCtx (y por lo tanto clienteCtx.telefono, del que depende activar
// el modo comercial) solo se construye si el cliente YA existe en
// `clientes` -- se siembra aquí para que el modo comercial pueda
// activarse desde el primer mensaje de esta prueba.
await pool.query(`INSERT INTO clientes (telefono, nombre, negocio_id) VALUES ($1,'Ana López',$2) ON CONFLICT (telefono) DO UPDATE SET negocio_id = $2`, [TELEFONO_CLIENTE, SEED.negocioA]);

// Catálogo real: el item que el cliente va a pedir SÍ existe, con precio real.
const { rows: [categoria] } = await pool.query(
  `INSERT INTO menu_categorias (nombre, negocio_id) VALUES ('Arreglos E2E', $1) RETURNING id`,
  [SEED.negocioA]
);
await pool.query(
  `INSERT INTO menu_productos (categoria_id, nombre, precio, disponible, negocio_id) VALUES ($1, 'Arreglo Floral Premium', 1500, true, $2)`,
  [categoria.id, SEED.negocioA]
);

const metaMock = await arrancarMetaMock();
const anthropicMock = await arrancarAnthropicMock();
const srv = await arrancarServidor({
  PORT: PUERTO,
  META_GRAPH_BASE_URL: metaMock.baseUrl,
  ANTHROPIC_BASE_URL: anthropicMock.baseUrl,
  ANTHROPIC_API_KEY: 'mock-key-no-es-real',
}, { timeoutMs: 30000 });
const base = srv.base;
const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');

function webhookTexto(phoneNumberId, telefono, texto, wamid, nombrePerfil) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: phoneNumberId },
      messages: [{ type: 'text', from: telefono, id: wamid, text: { body: texto } }],
      contacts: [{ profile: { name: nombrePerfil } }],
    } }] }],
  };
}
async function enviarWebhook(texto, wamid) {
  await fetch(base + '/webhook/whatsapp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(webhookTexto(PNID, TELEFONO_CLIENTE, texto, wamid, 'Ana WA')),
  });
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════ Turno 1: nombre + número de personas ═══════════

anthropicMock.encolarRespuesta(() => 'solicitud_comercial'); // clasificación
anthropicMock.encolarRespuesta(() =>
  '¡Hola Ana! Con gusto te ayudo. ¿Para qué fecha sería el evento y qué producto te interesa?' +
  '<CAMPO_COMERCIAL_CAPTURADO>{"campo":"nombre","valor":"Ana López"}</CAMPO_COMERCIAL_CAPTURADO>' +
  '<CAMPO_COMERCIAL_CAPTURADO>{"campo":"numero_personas","valor":150}</CAMPO_COMERCIAL_CAPTURADO>'
); // generación

await t('E2E', 'turno 1: el cliente pide una cotización por WhatsApp', async () => {
  await enviarWebhook('Hola, quiero una cotización para un evento, me llamo Ana López y seríamos 150 personas', 'wamid.E2E-T1');
  await esperar(7500); // debounce de 6s + margen para el turno de Claude (mock)
  const { rows } = await pool.query(
    `SELECT * FROM sesiones_comerciales WHERE negocio_id=$1 AND telefono=$2 AND estado NOT IN ('finalizada','abandonada')`,
    [SEED.negocioA, TELEFONO_CLIENTE]
  );
  assert.strictEqual(rows.length, 1, 'debe existir exactamente una sesión comercial activa');
  assert.strictEqual(rows[0].campos_capturados.nombre, 'Ana López');
  assert.strictEqual(rows[0].campos_capturados.numero_personas, 150);
  assert.strictEqual(rows[0].estado, 'descubriendo_necesidad', 'aún faltan fecha e items -- no debe haber creado borrador');
});

// ═══════════ Turno 2: fecha + item -> <BORRADOR_LISTO> ═══════════

anthropicMock.encolarRespuesta(() => 'continuacion_comercial'); // clasificación
anthropicMock.encolarRespuesta(() =>
  '¡Perfecto! Voy a preparar tu propuesta, en breve te la compartimos.' +
  '<CAMPO_COMERCIAL_CAPTURADO>{"campo":"fecha_evento","valor":"2026-09-20"}</CAMPO_COMERCIAL_CAPTURADO>' +
  '<CAMPO_COMERCIAL_CAPTURADO>{"campo":"item_solicitado","valor":{"descripcion":"Arreglo Floral Premium","cantidad":10}}</CAMPO_COMERCIAL_CAPTURADO>' +
  '<BORRADOR_LISTO>'
); // generación

let cotizacionCreada;
await t('E2E', 'turno 2: fecha + producto -> se crea el borrador con precio real del catálogo', async () => {
  await enviarWebhook('Sería el 20 de septiembre de 2026, y nos gustaría un Arreglo Floral Premium para las mesas', 'wamid.E2E-T2');
  await esperar(9000); // debounce + turno de Claude + generación del borrador (background)

  const { rows } = await pool.query(`SELECT * FROM cotizaciones WHERE negocio_id=$1 AND telefono=$2`, [SEED.negocioA, TELEFONO_CLIENTE]);
  assert.strictEqual(rows.length, 1, 'debe haberse creado exactamente una cotización');
  cotizacionCreada = rows[0];
  assert.strictEqual(cotizacionCreada.origen, 'whatsapp_ia');
  assert.strictEqual(cotizacionCreada.estado, 'borrador');
  assert.strictEqual(new Date(cotizacionCreada.fecha_evento).toISOString().slice(0, 10), '2026-09-20');
  assert.strictEqual(cotizacionCreada.cantidad_personas, 150);
  assert.ok(cotizacionCreada.notas.includes('Ana López'), 'el nombre capturado debe quedar en notas (no hay columna dedicada)');

  const { rows: items } = await pool.query(`SELECT * FROM cotizacion_items WHERE cotizacion_id=$1`, [cotizacionCreada.id]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(Number(items[0].precio_unitario), 1500, 'debe usar el precio real del catálogo, nunca uno inventado');
  assert.strictEqual(Number(items[0].cantidad), 10);
});

await t('E2E', 'la sesión queda vinculada y en esperando_aprobacion (nunca se envía sola)', async () => {
  const { rows } = await pool.query(`SELECT * FROM sesiones_comerciales WHERE negocio_id=$1 AND telefono=$2`, [SEED.negocioA, TELEFONO_CLIENTE]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].estado, 'esperando_aprobacion');
  assert.strictEqual(rows[0].cotizacion_id, cotizacionCreada.id);
});

await t('SEGURIDAD', 'brain.js nunca invoca directamente el envío/aprobación de una cotización', async () => {
  const { readFileSync: leer } = await import('fs');
  const brainSrc = leer(join(__dirname, '..', 'src', 'agent', 'brain.js'), 'utf8');
  assert.doesNotMatch(brainSrc, /marcarCotizacionEnviada/);
  assert.doesNotMatch(brainSrc, /enviarDocumento/);
  assert.doesNotMatch(brainSrc, /requireAdminSeguro/);
});

// ═══════════ Aprobación humana explícita + envío ═══════════

await t('APROBACION', 'sin sesión de admin -> 401, la IA/nadie sin autenticar puede aprobar', async () => {
  const r = await fetch(`${base}/api/cotizaciones/${cotizacionCreada.id}/enviar`, { method: 'POST' });
  assert.strictEqual(r.status, 401);
});

await t('APROBACION', 'el admin aprueba y envía -> estado enviada, documento creado', async () => {
  const r = await api(base, `/api/cotizaciones/${cotizacionCreada.id}/enviar`, { cookie: cookieAdminA, method: 'POST' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.cotizacion.estado, 'enviada');
  assert.ok(r.body.documento?.id);
});

await t('APROBACION', 'tras aprobar y enviar, la sesión comercial se finaliza', async () => {
  await esperar(500); // el hook de finalización corre en background (.then/.catch, no bloquea la respuesta)
  const { rows } = await pool.query(`SELECT estado FROM sesiones_comerciales WHERE negocio_id=$1 AND telefono=$2`, [SEED.negocioA, TELEFONO_CLIENTE]);
  assert.strictEqual(rows[0].estado, 'finalizada');
});

await t('APROBACION', 'una segunda solicitud del mismo cliente abre una sesión NUEVA (la anterior ya está finalizada)', async () => {
  anthropicMock.encolarRespuesta(() => 'solicitud_comercial');
  anthropicMock.encolarRespuesta(() => 'Con gusto, ¿me compartes tu nombre?');
  await enviarWebhook('Hola de nuevo, quiero otra cotización', 'wamid.E2E-T3');
  await esperar(7500);
  const { rows } = await pool.query(
    `SELECT id FROM sesiones_comerciales WHERE negocio_id=$1 AND telefono=$2 AND estado NOT IN ('finalizada','abandonada')`,
    [SEED.negocioA, TELEFONO_CLIENTE]
  );
  assert.strictEqual(rows.length, 1);
  assert.notStrictEqual(rows[0].id, undefined);
});

// ═══════════ Resumen ═══════════
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await metaMock.detener();
await anthropicMock.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
