// Suite persistida: módulo de cotizaciones (generador + versionado + envío
// por WhatsApp), activable por negocio vía negocio_modulos ('cotizaciones' y
// 'generador_cotizaciones'). Cubre: pertenencia por negocio, versionado con
// historial conservado, que el PDF corresponde a la versión actual, que
// enviar actualiza el estado, y permisos admin/operador/sin sesión.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4103';

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
await fijarModulo(SEED.negocioA, 'cotizaciones', 'activo');
await fijarModulo(SEED.negocioA, 'generador_cotizaciones', 'activo');
await fijarModulo(SEED.negocioA, 'chat_documentos_pdf', 'activo');
await fijarModulo(SEED.negocioB, 'cotizaciones', 'no_contratado');
await fijarModulo(SEED.negocioB, 'generador_cotizaciones', 'no_contratado');

await pool.query(`DELETE FROM cotizaciones WHERE negocio_id = $1 AND telefono = $2`, [SEED.negocioA, '5218789930001']);
await pool.query(`INSERT INTO clientes (telefono, nombre, negocio_id) VALUES ('5218789930001','Cliente Cotizacion',$1) ON CONFLICT (telefono) DO UPDATE SET negocio_id = $1`, [SEED.negocioA]);
await actualizarConfiguracion({ int_wa_phone_id: 'PNID_COT_A', int_wa_token: 'fake-token-cot-a' }, SEED.negocioA);

const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
const cookieStaffA = cookieHeader(SEED.staffNegocioAUsuarioId, SEED.negocioA, 'staff');
const cookieAdminB = cookieHeader(SEED.superadminUsuarioId, SEED.negocioB, 'admin');

const metaMock = await arrancarMetaMock();
const srv = await arrancarServidor({ PORT: PUERTO, META_GRAPH_BASE_URL: metaMock.baseUrl }, { timeoutMs: 30000 });

const cuerpoBase = {
  telefono: '5218789930001',
  evento: { nombre: 'Boda Ana y Luis', fecha: '2026-12-05', lugar: 'Salón Jardín', cantidadPersonas: 120 },
  vigenciaHasta: '2026-09-30',
  anticipoRequerido: 5000,
  notas: 'Cliente pidió flores blancas',
  terminos: 'El anticipo no es reembolsable.',
  items: [
    { tipo: 'servicio', descripcion: 'Arreglo floral centro de mesa', cantidad: 12, precioUnitario: 450, descuento: 0 },
    { tipo: 'producto', descripcion: 'Ramo de novia', cantidad: 1, precioUnitario: 1200, descuento: 100 },
  ],
};

try {
  await t('PERMISOS', 'sin sesión -> 401 al crear', async () => {
    const r = await api(srv.base, '/api/cotizaciones', { method: 'POST', body: cuerpoBase });
    assert.strictEqual(r.status, 401);
  });

  await t('PERMISOS', 'staff (operador) no puede crear -> 403', async () => {
    const r = await api(srv.base, '/api/cotizaciones', { cookie: cookieStaffA, method: 'POST', body: cuerpoBase });
    assert.strictEqual(r.status, 403);
  });

  await t('MODULO', 'negocio sin el módulo -> 403 al crear', async () => {
    const r = await api(srv.base, '/api/cotizaciones', { cookie: cookieAdminB, method: 'POST', body: cuerpoBase });
    assert.strictEqual(r.status, 403);
  });

  let cotizacionId, folioOriginal, pdfKeyV1;
  await t('CREAR', 'admin crea la cotización -> pertenece al negocio correcto, folio asignado', async () => {
    const r = await api(srv.base, '/api/cotizaciones', { cookie: cookieAdminA, method: 'POST', body: cuerpoBase });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.folio.startsWith('COT-'));
    assert.strictEqual(r.body.negocio_id, SEED.negocioA);
    assert.strictEqual(r.body.version, 1);
    assert.strictEqual(Number(r.body.total), 12 * 450 + (1200 - 100));
    cotizacionId = r.body.id;
    folioOriginal = r.body.folio;
  });

  await t('AISLAMIENTO', 'negocio ajeno no puede leer la cotización -> 403', async () => {
    const r = await api(srv.base, `/api/cotizaciones/${cotizacionId}`, { cookie: cookieAdminB });
    assert.strictEqual(r.status, 403);
  });

  await t('PERMISOS', 'staff SÍ puede leer (solo lectura)', async () => {
    const r = await api(srv.base, `/api/cotizaciones/${cotizacionId}`, { cookie: cookieStaffA });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.folio, folioOriginal);
  });

  await t('PDF', 'el PDF generado corresponde a la versión actual (v1)', async () => {
    const r = await fetch(`${srv.base}/api/cotizaciones/${cotizacionId}/pdf`, { headers: { Cookie: cookieAdminA } });
    assert.strictEqual(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.subarray(0, 5).toString('latin1') === '%PDF-', 'debe ser un PDF real');
    const { rows } = await pool.query(`SELECT pdf_storage_key, version FROM cotizaciones WHERE id = $1`, [cotizacionId]);
    assert.strictEqual(rows[0].version, 1);
    assert.ok(rows[0].pdf_storage_key);
    pdfKeyV1 = rows[0].pdf_storage_key;
  });

  await t('VERSIONADO', 'editar crea una nueva versión y conserva la anterior en el historial', async () => {
    const r = await api(srv.base, `/api/cotizaciones/${cotizacionId}`, {
      cookie: cookieAdminA, method: 'PATCH',
      body: { items: [...cuerpoBase.items, { tipo: 'servicio', descripcion: 'Iluminación', cantidad: 1, precioUnitario: 3000, descuento: 0 }] },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.version, 2);
    assert.strictEqual(r.body.estado, 'modificada');
    assert.strictEqual(r.body.pdf_storage_key, null); // el PDF de la v1 ya no es válido para la v2

    const { rows: historial } = await pool.query(`SELECT * FROM cotizaciones_historial WHERE cotizacion_id = $1 ORDER BY version`, [cotizacionId]);
    assert.strictEqual(historial.length, 1);
    assert.strictEqual(historial[0].version, 1);
    assert.strictEqual(historial[0].pdf_storage_key, pdfKeyV1);
  });

  await t('PDF', 'el PDF regenerado corresponde ahora a la versión 2 (nuevo storage_key)', async () => {
    const r = await fetch(`${srv.base}/api/cotizaciones/${cotizacionId}/pdf`, { headers: { Cookie: cookieAdminA } });
    assert.strictEqual(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.subarray(0, 5).toString('latin1') === '%PDF-', 'debe ser un PDF real');
    const { rows } = await pool.query(`SELECT pdf_storage_key, version FROM cotizaciones WHERE id = $1`, [cotizacionId]);
    assert.strictEqual(rows[0].version, 2);
    assert.notStrictEqual(rows[0].pdf_storage_key, pdfKeyV1);
  });

  await t('ENVIO', 'enviar la cotización actualiza el estado a "enviada"', async () => {
    const r = await api(srv.base, `/api/cotizaciones/${cotizacionId}/enviar`, { cookie: cookieAdminA, method: 'POST' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.cotizacion.estado, 'enviada');
    assert.ok(r.body.cotizacion.sent_at);
    assert.ok(r.body.documento.id);
  });

  await t('MENSAJES', 'un mensaje de texto normal en la misma conversación no se rompe (coexiste con el documento enviado)', async () => {
    const { guardarMensaje } = await import('../src/services/database.js');
    const msg = await guardarMensaje('5218789930001', null, 'saliente', 'Gracias por tu preferencia', SEED.negocioA, 'humano');
    assert.ok(msg);
    assert.strictEqual(msg.tipo, 'texto');
    const r = await api(srv.base, `/api/conversacion/5218789930001`, { cookie: cookieAdminA });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.some(m => m.tipo === 'documento'));
    assert.ok(r.body.some(m => m.tipo === 'texto' && m.texto === 'Gracias por tu preferencia'));
  });
} finally {
  srv.detener();
  metaMock.detener();
  // No dejar credenciales de WhatsApp de prueba en negocioA -- otras suites
  // (fase-chat-manual.mjs) asumen que negocioA no tiene credenciales reales
  // configuradas para poder probar el camino fail-closed (409).
  await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave IN ('int_wa_phone_id','int_wa_token')`, [SEED.negocioA]);
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('\nDetalle de fallos:'); fallos.forEach(f => console.log('  - ' + f)); }
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
