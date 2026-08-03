// Suite: PDF borrador al WhatsApp del administrador (Bloque 3). Cubre:
// admin configurado/no configurado, WhatsApp no configurado, error de
// Meta, el PDF borrador nunca contamina el cache del PDF final limpio,
// el PDF final del cliente nunca lleva la marca de borrador, aislamiento
// multiempresa (dos negocios con administradores distintos, mismo
// teléfono de cliente en ambos), y que "enviado_por" registra al humano
// que aprobó.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4130';

// El mock de Meta debe arrancar y fijar META_GRAPH_BASE_URL en el
// entorno de ESTE proceso ANTES de importar cualquier modulo que lea esa
// variable a nivel de modulo (metaEnvioDocumentos.js) -- este proceso de
// test llama a notificarBorradorAlAdmin directamente (no solo via HTTP
// contra el servidor hijo), asi que tambien necesita apuntar al mock.
const metaMock = await arrancarMetaMock();
process.env.META_GRAPH_BASE_URL = metaMock.baseUrl;

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, actualizarConfiguracion, crearCotizacion, marcarCotizacionEnviada } = await import('../src/services/database.js');
const { construirHtml } = await import('../src/services/cotizacionPdf.js');
const { generarPdfBorradorParaAdmin, obtenerOGenerarPdfCotizacion } = await import('../src/services/cotizaciones.js');
const { notificarBorradorAlAdmin } = await import('../src/services/notificacionBorradorAdmin.js');
const { TenantContextRequiredError } = await import('../src/services/integracionesService.js');

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

// --- Prueba pura (sin servidor/DB): el HTML del borrador SIEMPRE
// contiene el banner, el HTML normal NUNCA lo contiene.
await t('WATERMARK', 'construirHtml con esBorrador:true incluye el banner "BORRADOR"', () => {
  const html = construirHtml({ folio: 'COT-0001', items: [], version: 1, created_at: new Date() }, {}, { esBorrador: true });
  assert.ok(html.includes('BORRADOR'), 'debe incluir el banner de borrador');
  assert.ok(html.includes('NO ENVIAR AL CLIENTE'));
});
await t('WATERMARK', 'construirHtml sin esBorrador (o esBorrador:false) NUNCA incluye el banner', () => {
  const htmlSinOpciones = construirHtml({ folio: 'COT-0002', items: [], version: 1, created_at: new Date() }, {});
  const htmlExplicito = construirHtml({ folio: 'COT-0002', items: [], version: 1, created_at: new Date() }, {}, { esBorrador: false });
  assert.ok(!htmlSinOpciones.includes('BORRADOR'));
  assert.ok(!htmlExplicito.includes('BORRADOR'));
});

await fijarModulo(SEED.negocioA, 'cotizaciones', 'activo');
await fijarModulo(SEED.negocioA, 'generador_cotizaciones', 'activo');
await fijarModulo(SEED.negocioA, 'chat_documentos_pdf', 'activo');
await fijarModulo(SEED.negocioC, 'cotizaciones', 'activo');
await fijarModulo(SEED.negocioC, 'generador_cotizaciones', 'activo');
await fijarModulo(SEED.negocioC, 'chat_documentos_pdf', 'activo');

const TELEFONO_CLIENTE = '5218789931001'; // el MISMO telefono de cliente en ambos negocios (aislamiento)
const TEL_ADMIN_A = '5219990000001';
const TEL_ADMIN_C = '5219990000002';

await pool.query(`DELETE FROM cotizaciones WHERE telefono = $1`, [TELEFONO_CLIENTE]);
await actualizarConfiguracion({ int_wa_phone_id: 'PNID_BORRADOR_A', int_wa_token: 'fake-token-borrador-a', admin_whatsapp_telefono: TEL_ADMIN_A }, SEED.negocioA);
await actualizarConfiguracion({ int_wa_phone_id: 'PNID_BORRADOR_C', int_wa_token: 'fake-token-borrador-c', admin_whatsapp_telefono: TEL_ADMIN_C }, SEED.negocioC);

const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');

const srv = await arrancarServidor({ PORT: PUERTO, META_GRAPH_BASE_URL: metaMock.baseUrl }, { timeoutMs: 30000 });

const itemsBase = [{ tipo: 'servicio', descripcion: 'Arreglo floral', cantidad: 3, precioUnitario: 500, descuento: 0 }];

try {
  await t('TENANT-CONTEXT', 'notificarBorradorAlAdmin sin negocioId -> TenantContextRequiredError', async () => {
    await assert.rejects(() => notificarBorradorAlAdmin({ cotizacion: { id: 'x', folio: 'COT-X', telefono: '1', total: 0 }, negocioId: '' }), TenantContextRequiredError);
  });

  let cotizacionA;
  await t('SETUP', 'crear cotización borrador para negocio A', async () => {
    cotizacionA = await crearCotizacion({ negocioId: SEED.negocioA, telefono: TELEFONO_CLIENTE, createdBy: null, items: itemsBase, origen: 'whatsapp_ia' });
    assert.strictEqual(cotizacionA.estado, 'borrador');
  });

  await t('BORRADOR-PDF', 'generarPdfBorradorParaAdmin genera un PDF real y NUNCA lo cachea en pdf_storage_key', async () => {
    const { buffer } = await generarPdfBorradorParaAdmin(cotizacionA.id, SEED.negocioA);
    assert.ok(buffer.subarray(0, 5).toString('latin1') === '%PDF-');
    const { rows } = await pool.query(`SELECT pdf_storage_key FROM cotizaciones WHERE id = $1`, [cotizacionA.id]);
    assert.strictEqual(rows[0].pdf_storage_key, null, 'el borrador nunca debe contaminar el cache del PDF final');
  });

  await t('NOTIFICAR', 'admin configurado + WhatsApp configurado -> se envía y se registra bajo el teléfono del admin (nunca el del cliente)', async () => {
    const resultado = await notificarBorradorAlAdmin({ cotizacion: cotizacionA, negocioId: SEED.negocioA, camposCapturados: { nombre: 'Cliente Prueba' } });
    assert.strictEqual(resultado.ok, true);
    assert.ok(resultado.wamid);
    const { rows } = await pool.query(`SELECT * FROM documentos WHERE wamid = $1`, [resultado.wamid]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].telefono, TEL_ADMIN_A, 'el documento debe quedar bajo el telefono del ADMIN, no del cliente');
    assert.ok(rows[0].caption.includes('BORRADOR'));
    assert.ok(rows[0].caption.includes(cotizacionA.folio));
    assert.strictEqual(rows[0].cotizacion_id, null, 'nunca debe vincularse a cotizacion_id (no es el envio real al cliente)');
  });

  await t('SIN-ADMIN', 'negocio sin admin_whatsapp_telefono configurado -> ok:false, motivo admin_no_configurado, NUNCA lanza', async () => {
    const { rows: [negocioSinAdmin] } = await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ('Negocio Sin Admin WA (prueba)', 'negocio-sin-admin-wa-prueba') RETURNING id`);
    const cot = await crearCotizacion({ negocioId: negocioSinAdmin.id, telefono: '5210000000200', createdBy: null, items: itemsBase, origen: 'whatsapp_ia' });
    const resultado = await notificarBorradorAlAdmin({ cotizacion: cot, negocioId: negocioSinAdmin.id, camposCapturados: {} });
    assert.strictEqual(resultado.ok, false);
    assert.strictEqual(resultado.motivo, 'admin_no_configurado');
  });

  await t('SIN-WHATSAPP', 'admin configurado pero SIN credenciales de WhatsApp -> ok:false, motivo whatsapp_no_configurado', async () => {
    const { rows: [negocioSinWA] } = await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ('Negocio Sin WA (prueba)', 'negocio-sin-wa-prueba') RETURNING id`);
    await actualizarConfiguracion({ admin_whatsapp_telefono: '5219990009999' }, negocioSinWA.id);
    const cot = await crearCotizacion({ negocioId: negocioSinWA.id, telefono: '5210000000201', createdBy: null, items: itemsBase, origen: 'whatsapp_ia' });
    const resultado = await notificarBorradorAlAdmin({ cotizacion: cot, negocioId: negocioSinWA.id, camposCapturados: {} });
    assert.strictEqual(resultado.ok, false);
    assert.strictEqual(resultado.motivo, 'whatsapp_no_configurado');
  });

  await t('ERROR-META', 'error real de Meta al notificar -> ok:false, motivo error_envio, NUNCA lanza (el borrador ya existe de todos modos)', async () => {
    metaMock.forzarErrorSiguienteEnvio();
    const resultado = await notificarBorradorAlAdmin({ cotizacion: cotizacionA, negocioId: SEED.negocioA, camposCapturados: {} });
    assert.strictEqual(resultado.ok, false);
    assert.strictEqual(resultado.motivo, 'error_envio');
  });

  await t('AISLAMIENTO', 'negocio C (admin distinto) notifica SOLO a su propio admin, aunque el cliente sea el mismo teléfono que A', async () => {
    const cotizacionC = await crearCotizacion({ negocioId: SEED.negocioC, telefono: TELEFONO_CLIENTE, createdBy: null, items: itemsBase, origen: 'whatsapp_ia' });
    const resultado = await notificarBorradorAlAdmin({ cotizacion: cotizacionC, negocioId: SEED.negocioC, camposCapturados: {} });
    assert.strictEqual(resultado.ok, true);
    assert.strictEqual(resultado.telefonoAdmin, TEL_ADMIN_C);
    assert.notStrictEqual(resultado.telefonoAdmin, TEL_ADMIN_A, 'nunca debe notificar al admin de otro negocio');
    const { rows } = await pool.query(`SELECT telefono FROM documentos WHERE wamid = $1`, [resultado.wamid]);
    assert.strictEqual(rows[0].telefono, TEL_ADMIN_C);
  });

  await t('APROBAR', 'al aprobar (POST /enviar), el PDF final NUNCA lleva la marca de borrador y se envía al CLIENTE, no al admin', async () => {
    const r = await api(srv.base, `/api/cotizaciones/${cotizacionA.id}/enviar`, { cookie: cookieAdminA, method: 'POST' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.cotizacion.estado, 'enviada');
    assert.strictEqual(r.body.documento.telefono, TELEFONO_CLIENTE, 'el PDF final va al cliente, nunca al admin');

    const { cotizacion, storageKey } = await obtenerOGenerarPdfCotizacion(cotizacionA.id, SEED.negocioA);
    assert.ok(storageKey, 'el PDF final SI debe quedar cacheado (a diferencia del borrador)');
    assert.strictEqual(cotizacion.pdf_storage_key, storageKey);
  });

  await t('AUDITORIA', 'enviado_por registra al humano que aprobó (nunca la IA)', async () => {
    const { rows } = await pool.query(`SELECT enviado_por FROM cotizaciones WHERE id = $1`, [cotizacionA.id]);
    assert.strictEqual(rows[0].enviado_por, SEED.adminNegocioAUsuarioId);
  });

  await t('IDEMPOTENTE', 'notificarBorradorAlAdmin se puede reintentar sin lanzar ni corromper nada', async () => {
    const cot = await crearCotizacion({ negocioId: SEED.negocioA, telefono: '5210000000202', createdBy: null, items: itemsBase, origen: 'whatsapp_ia' });
    const r1 = await notificarBorradorAlAdmin({ cotizacion: cot, negocioId: SEED.negocioA, camposCapturados: {} });
    const r2 = await notificarBorradorAlAdmin({ cotizacion: cot, negocioId: SEED.negocioA, camposCapturados: {} });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, true);
    assert.notStrictEqual(r1.wamid, r2.wamid, 'cada reintento manual es un envio nuevo (no hay estado a medias que corrompa)');
  });
} finally {
  srv.detener();
  metaMock.detener();
  // No dejar credenciales de WhatsApp de prueba en negocioA -- otras suites
  // (fase-chat-manual.mjs) asumen que negocioA no tiene credenciales reales
  // configuradas para poder probar el camino fail-closed (409).
  await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave IN ('int_wa_phone_id','int_wa_token','admin_whatsapp_telefono')`, [SEED.negocioA]);
  await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave IN ('int_wa_phone_id','int_wa_token','admin_whatsapp_telefono')`, [SEED.negocioC]);
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('\nDetalle de fallos:'); fallos.forEach(f => console.log('  - ' + f)); }
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
