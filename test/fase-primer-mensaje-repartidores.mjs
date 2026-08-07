// Cierre primer-mensaje-repartidores: el PRIMER mensaje real (plantilla de
// oferta) debe poder llevar colonia+calle SIN número exterior. Esta suite
// cubre, con lib-meta-mock capturando los POST crudos a la Graph API:
//   - plantilla real y orden de envío (oferta primero, detalle solo tras aceptar)
//   - payload v2: 4 variables en orden (negocio, ubicación, pago, enlace)
//   - ubicación resumida (formatearEntregaOferta) en todos sus formatos,
//     con el número exterior oculto y "Calle 5 de Mayo"/"Avenida 20 de
//     Noviembre" preservadas
//   - estados de plantilla en Meta simulados (aprobada / no aprobada o
//     inexistente o pendiente o rechazada [132001] / variables que no
//     coinciden [132000] / pausada [132015] / deshabilitada [132016]) y el
//     fallback auditable v2→v1 SIN datos sensibles
//   - configuración por negocio: piloto con v2, otro negocio en v1, rollback
//     apagando el flag (sin deploy)
//   - contrato de aceptación intacto: GET no consume, POST acepta, carrera
//     con nombre del ganador para el perdedor
// Requiere aplicar-migraciones.mjs y seed-datos-prueba.mjs ya corridos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4189';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, actualizarConfiguracion, crearUsuarioConPassword, obtenerNotificacionesPedido } = await import('../src/services/database.js');
const { formatearEntregaOferta } = await import('../src/utils/direccionRepartidor.js');
const { clasificarErrorPlantillaMeta } = await import('../src/utils/metaPlantillaErrores.js');

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
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperarHasta(fn, { timeoutMs = 8000, intervaloMs = 200 } = {}) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const r = await fn();
    if (r) return r;
    await esperar(intervaloMs);
  }
  return null;
}
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(
    `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
     ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`,
    [negocioId, modulo, estado]
  );
}

// ═══════════ Setup ═══════════
await fijarModulo(SEED.negocioA, 'pos', 'activo');
await fijarModulo(SEED.negocioB, 'pos', 'activo');
await actualizarConfiguracion({ int_wa_phone_id: 'PNID_PM_A', int_wa_token: 'fake-token-pm-a' }, SEED.negocioA);
await actualizarConfiguracion({ int_wa_phone_id: 'PNID_PM_B', int_wa_token: 'fake-token-pm-b' }, SEED.negocioB);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,'PM A',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [SEED.negocioA, 'PNID_PM_A']);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,'PM B',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [SEED.negocioB, 'PNID_PM_B']);

// A = negocio PILOTO de la plantilla v2; B = negocio en v1 (fallback anterior).
await actualizarConfiguracion({
  repartidor_notif_modo: 'piloto',
  repartidor_notif_piloto_telefonos: '8711000901,8711000903',
  repartidor_notif_plantilla_v2_activo: 'true',
}, SEED.negocioA);
await actualizarConfiguracion({
  repartidor_notif_modo: 'piloto',
  repartidor_notif_piloto_telefonos: '8711000902',
}, SEED.negocioB);

// La red configurable (migración 038) podría venir apagada de otra suite en
// la misma base: sin fila = comportamiento legado (procede), que es lo que
// esta suite necesita para ejercitar el motor de notificación en sí.
await pool.query(`DELETE FROM red_repartidores_config WHERE negocio_id IN ($1,$2)`, [SEED.negocioA, SEED.negocioB]);

// Repartidores exclusivos de esta suite (telefono único global) + limpieza
// para que el archivo sea re-ejecutable.
const TELS = ['8711000901', '8711000902', '8711000903'];
await pool.query(`DELETE FROM notificaciones_repartidor WHERE repartidor_id IN (SELECT id FROM repartidores WHERE telefono = ANY($1))`, [TELS]);
await pool.query(`DELETE FROM repartidores WHERE telefono = ANY($1)`, [TELS]);
await pool.query(`DELETE FROM pedidos_activos WHERE folio LIKE 'PM-9%'`);
const { rows: [repPA] } = await pool.query(
  `INSERT INTO repartidores (nombre, telefono, token, activo, negocio_id) VALUES ('Rep PrimerMsj A','8711000901','tok-pm-a',TRUE,$1) RETURNING *`, [SEED.negocioA]);
const { rows: [repPB] } = await pool.query(
  `INSERT INTO repartidores (nombre, telefono, token, activo, negocio_id) VALUES ('Rep PrimerMsj B','8711000902','tok-pm-b',TRUE,$1) RETURNING *`, [SEED.negocioB]);
const { rows: [repPA2] } = await pool.query(
  `INSERT INTO repartidores (nombre, telefono, token, activo, negocio_id) VALUES ('Rep PrimerMsj A2','8711000903','tok-pm-a2',TRUE,$1) RETURNING *`, [SEED.negocioA]);

const metaMock = await arrancarMetaMock();
const srv = await arrancarServidor({ PORT: PUERTO, META_GRAPH_BASE_URL: metaMock.baseUrl }, { timeoutMs: 30000 });
const base = srv.base;

const { rows: [adminBExistente] } = await pool.query(`SELECT id FROM usuarios WHERE email = 'admin-b-primermsj@test.local'`);
const adminNegocioB = adminBExistente || await crearUsuarioConPassword({
  negocioId: SEED.negocioB, nombre: 'Admin B (primer mensaje)', email: 'admin-b-primermsj@test.local',
  password: 'ClaveAdminBPrueba123!', rol: 'admin',
});
const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
const cookieAdminB = cookieHeader(adminNegocioB.id, SEED.negocioB, 'admin');

async function crearPedidoPrueba(cookie, body = undefined) {
  const r = await api(base, '/test/pedido', { cookie, method: 'POST', body });
  assert.strictEqual(r.status, 200, `/test/pedido debe responder 200, dio ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.pedido.id;
}
async function notifsDe(folio, negocioId = SEED.negocioA) { return obtenerNotificacionesPedido(folio, negocioId); }
function plantillasEnviadas(nombre) { return metaMock.obtenerMensajesEnviados().filter(m => m.template?.name === nombre); }
function paramsDe(msg) { return msg.template.components[0].parameters.map(p => p.text); }

// ═══════════ PLANTILLA-REAL: el PRIMER mensaje es la v2 con ubicación ═══════════
await t('PLANTILLA-REAL', 'pedido del negocio piloto: el primer mensaje es xabor_nuevo_servicio_reparto_v2 con 4 variables en orden y colonia+calle SIN número', async () => {
  const antesDetalle = plantillasEnviadas('xabor_detalle_servicio_reparto').length;
  const folio = await crearPedidoPrueba(cookieAdminA);
  const fila = await esperarHasta(async () => (await notifsDe(folio)).find(f => f.repartidor_id === repPA.id) || null);
  assert.ok(fila, 'debía registrarse la notificación');
  assert.strictEqual(fila.estado, 'aceptado_meta');
  assert.strictEqual(fila.error_detalle, null, 'sin fallback no debe haber JSON de auditoría de fallback');

  const v2 = plantillasEnviadas('xabor_nuevo_servicio_reparto_v2');
  assert.ok(v2.length > 0, 'debía salir la plantilla v2');
  const msg = v2[v2.length - 1];
  assert.strictEqual(msg.template.language.code, 'es_MX', 'idioma es_MX');
  const params = paramsDe(msg);
  assert.strictEqual(params.length, 4, `la v2 lleva exactamente 4 variables, llevó ${params.length}`);
  assert.strictEqual(params[0], 'Fase B Negocio A (whatsapp activo)', 'variable 1 = negocio');
  assert.strictEqual(params[1], 'Col. Centro, calle Av. Tecnológico', 'variable 2 = ubicación resumida sin número exterior');
  assert.strictEqual(params[2], '$544.00 MXN', 'variable 3 = pago');
  assert.ok(params[3].includes('/repartidor/aceptar/'), 'variable 4 = enlace de aceptación');
  assert.ok(!JSON.stringify(msg).includes('123'), 'el número exterior (123) jamás viaja en la oferta');
  assert.ok(!JSON.stringify(msg).includes('Cliente Prueba'), 'el nombre del cliente jamás viaja en la oferta');
  assert.ok(!JSON.stringify(msg).includes('8781234567'), 'el teléfono del cliente jamás viaja en la oferta');
  assert.ok(!JSON.stringify(msg).includes('Juárez'), 'las entre calles jamás viajan en la oferta');
  assert.strictEqual(plantillasEnviadas('xabor_detalle_servicio_reparto').length, antesDetalle, 'la plantilla de detalle NO debe salir antes de aceptar (orden de envío)');
});

// ═══════════ ORDEN-ENVIO: GET no consume; POST acepta; el portal reemplaza al detalle ═══════════
await t('ORDEN-ENVIO', 'GET del enlace no consume; POST acepta; y la plantilla de detalle YA NO se envía (el portal es la fuente del ganador)', async () => {
  const folio = await crearPedidoPrueba(cookieAdminA);
  const fila = await esperarHasta(async () => (await notifsDe(folio)).find(f => f.repartidor_id === repPA.id && f.token_aceptacion) || null);
  assert.ok(fila, 'debía existir el token');

  const pagina = await fetch(`${base}/repartidor/aceptar/${fila.token_aceptacion}`);
  assert.strictEqual(pagina.status, 200);
  const html = await pagina.text();
  assert.ok(html.includes('Pedido asignado a ti'), 'la pantalla del enlace trae el estado "Pedido asignado a ti"');
  assert.ok(html.includes('Ver mi entrega'), 'la pantalla del enlace trae la acción "Ver mi entrega" → /repartidor.html');
  assert.ok(!html.includes('llegaron a tu WhatsApp'), 'la pantalla ya no promete detalles por WhatsApp');
  const { rows: [sinConsumir] } = await pool.query(`SELECT token_usado_at FROM notificaciones_repartidor WHERE id = $1`, [fila.id]);
  assert.strictEqual(sinConsumir.token_usado_at, null, 'el GET jamás consume el token');

  const antes = plantillasEnviadas('xabor_detalle_servicio_reparto').length;
  const r = await fetch(`${base}/api/repartidor/oferta/${fila.token_aceptacion}/aceptar`, { method: 'POST' });
  assert.strictEqual(r.status, 200);
  const cuerpo = await r.json();
  assert.strictEqual(cuerpo.estado, 'asignado_a_mi');
  assert.ok(cuerpo.pedido?.direccion?.includes('123'), 'el GANADOR sí ve la dirección completa (con número) en su pantalla');

  await esperar(1500); // margen: si el detalle fuera a enviarse, ya habría salido (el envío es awaited)
  assert.strictEqual(plantillasEnviadas('xabor_detalle_servicio_reparto').length, antes,
    'la plantilla de detalle NO debe enviarse al ganador: sus datos viven en el portal autenticado');
});

// ═══════════ RECUPERACION: el ganador nunca pierde acceso a su pedido ═══════════
await t('RECUPERACION', 'cerrar la pantalla no pierde nada: reabrir el MISMO enlace da asignado_a_mi con la dirección completa (token ya usado)', async () => {
  const folio = await crearPedidoPrueba(cookieAdminA);
  const fila = await esperarHasta(async () => (await notifsDe(folio)).find(f => f.repartidor_id === repPA.id && f.token_aceptacion) || null);
  assert.ok(fila, 'debía existir el token');
  const r1 = await fetch(`${base}/api/repartidor/oferta/${fila.token_aceptacion}/aceptar`, { method: 'POST' });
  assert.strictEqual(r1.status, 200);

  // "Cerró la pestaña": vuelve a abrir el enlace de WhatsApp más tarde.
  const r2 = await fetch(`${base}/api/repartidor/oferta/${fila.token_aceptacion}`);
  assert.strictEqual(r2.status, 200);
  const estado = await r2.json();
  assert.strictEqual(estado.estado, 'asignado_a_mi', 'el ganador conserva su pantalla aunque el token ya esté consumido');
  assert.ok(estado.pedido?.direccion?.includes('123'), 'la pantalla recuperada trae la dirección completa');
  assert.strictEqual(estado.pedido?.nombreCliente, 'Cliente Prueba', 'la pantalla recuperada trae al cliente');
});

await t('RECUPERACION', 'login posterior (otro dispositivo): /api/repartidor/login con su teléfono + pedido-actual muestra el pedido completo', async () => {
  const folio = await crearPedidoPrueba(cookieAdminA);
  const fila = await esperarHasta(async () => (await notifsDe(folio)).find(f => f.repartidor_id === repPA.id && f.token_aceptacion) || null);
  assert.ok(fila, 'debía existir el token');
  await fetch(`${base}/api/repartidor/oferta/${fila.token_aceptacion}/aceptar`, { method: 'POST' });

  // Dispositivo nuevo: sin token guardado, entra a /repartidor.html y hace
  // login con su teléfono -- el mismo flujo del portal real.
  const login = await api(base, '/api/repartidor/login', { method: 'POST', body: { telefono: '8711000901' } });
  assert.strictEqual(login.status, 200, `el login por teléfono debe responder 200, dio ${login.status}`);
  assert.ok(login.body.token, 'el login devuelve el token del repartidor');

  const actual = await fetch(`${base}/api/repartidor/pedido-actual`, { headers: { 'x-rep-token': login.body.token } });
  assert.strictEqual(actual.status, 200);
  const cuerpo = await actual.json();
  const pedido = (cuerpo.pedidos || []).find(p => p.folio === folio);
  assert.ok(pedido, `"Mi entrega" debe mostrar el pedido ${folio} tras el login`);
  assert.strictEqual(pedido.calle, 'Av. Tecnológico 123', 'el portal muestra la calle completa CON número al ganador');
  assert.strictEqual(pedido.cliente, 'Cliente Prueba', 'el portal muestra al cliente');
  assert.ok(pedido.telefono, 'el portal muestra el teléfono del cliente');
});

// ═══════════ RESPALDO: el flag por negocio reactiva el detalle por WhatsApp sin deploy ═══════════
await t('RESPALDO', 'repartidor_notif_detalle_wa_activo=true reactiva la plantilla de detalle (respaldo, sin deploy)', async () => {
  await actualizarConfiguracion({ repartidor_notif_detalle_wa_activo: 'true' }, SEED.negocioA);
  try {
    const folio = await crearPedidoPrueba(cookieAdminA);
    const fila = await esperarHasta(async () => (await notifsDe(folio)).find(f => f.repartidor_id === repPA.id && f.token_aceptacion) || null);
    assert.ok(fila, 'debía existir el token');
    const antes = plantillasEnviadas('xabor_detalle_servicio_reparto').length;
    const r = await fetch(`${base}/api/repartidor/oferta/${fila.token_aceptacion}/aceptar`, { method: 'POST' });
    assert.strictEqual(r.status, 200);
    const detalle = await esperarHasta(async () => {
      const d = plantillasEnviadas('xabor_detalle_servicio_reparto');
      return d.length > antes ? d : null;
    });
    assert.ok(detalle, 'con el flag de respaldo activo, la plantilla de detalle SÍ debe enviarse');
    const params = paramsDe(detalle[detalle.length - 1]);
    assert.strictEqual(params[0], folio, 'el detalle de respaldo lleva el folio');
  } finally {
    await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'repartidor_notif_detalle_wa_activo'`, [SEED.negocioA]);
  }
});

// ═══════════ UBICACION: formatearEntregaOferta (misma función que alimenta {{2}}) ═══════════
await t('UBICACION', 'colonia + calle → "Col. Guillén, calle Boulevard CBTis 34"', () => {
  assert.strictEqual(formatearEntregaOferta('Boulevard CBTis 34 número 208', 'Guillén'), 'Col. Guillén, calle Boulevard CBTis 34');
});
await t('UBICACION', 'solo colonia → "Col. Guillén"', () => {
  assert.strictEqual(formatearEntregaOferta('', 'Guillén'), 'Col. Guillén');
});
await t('UBICACION', 'solo calle → "Calle Boulevard CBTis 34"', () => {
  assert.strictEqual(formatearEntregaOferta('Boulevard CBTis 34 número 208', ''), 'Calle Boulevard CBTis 34');
});
await t('UBICACION', 'sin calle ni colonia → "Zona por confirmar"', () => {
  assert.strictEqual(formatearEntregaOferta('', ''), 'Zona por confirmar');
  assert.strictEqual(formatearEntregaOferta(null, undefined), 'Zona por confirmar');
});
await t('UBICACION', 'número exterior e interior ocultos ("Carranza #245 int 2" → "calle Carranza")', () => {
  assert.strictEqual(formatearEntregaOferta('Carranza #245 int 2', 'Centro'), 'Col. Centro, calle Carranza');
  assert.strictEqual(formatearEntregaOferta('Av. Tecnológico 123', 'Centro'), 'Col. Centro, calle Av. Tecnológico');
});
await t('UBICACION', '"Calle 5 de Mayo" se preserva (el 5 no es número exterior)', () => {
  assert.strictEqual(formatearEntregaOferta('Calle 5 de Mayo', ''), 'Calle 5 de Mayo');
  assert.strictEqual(formatearEntregaOferta('Calle 5 de Mayo', 'Centro'), 'Col. Centro, calle 5 de Mayo');
});
await t('UBICACION', '"Avenida 20 de Noviembre" se preserva', () => {
  assert.strictEqual(formatearEntregaOferta('Avenida 20 de Noviembre', ''), 'Calle Avenida 20 de Noviembre');
});
await t('UBICACION', 'nulls y espacios no rompen ni producen "null"/"undefined"', () => {
  assert.strictEqual(formatearEntregaOferta('   ', '   '), 'Zona por confirmar');
  const r = formatearEntregaOferta('  Av. Reforma 10  ', '  Col. Centro  ');
  assert.strictEqual(r, 'Col. Centro, calle Av. Reforma');
  assert.ok(!/null|undefined/i.test(r));
});
await t('UBICACION', 'pedido sin dirección por el flujo real → la v2 sale con "Zona por confirmar"', async () => {
  const folio = await crearPedidoPrueba(cookieAdminA, { cliente: { calle: '', colonia: '', entre_calles: '' } });
  const fila = await esperarHasta(async () => (await notifsDe(folio)).find(f => f.repartidor_id === repPA.id) || null);
  assert.ok(fila, 'debía notificarse');
  const v2 = plantillasEnviadas('xabor_nuevo_servicio_reparto_v2');
  const delPedido = v2.filter(m => paramsDe(m)[1] === 'Zona por confirmar');
  assert.ok(delPedido.length > 0, 'la v2 del pedido sin dirección debía llevar "Zona por confirmar"');
});

// ═══════════ ESTADOS-META + FALLBACK auditable v2→v1 ═══════════
const CASOS_ESTADO = [
  [132001, 'template_not_approved_or_missing', 'no aprobada / inexistente / PENDING / REJECTED'],
  [132000, 'template_param_mismatch', 'variables desordenadas o de más/menos'],
  [132015, 'template_paused', 'PAUSED'],
  [132016, 'template_disabled', 'DISABLED'],
];
for (const [codigo, razon, descripcion] of CASOS_ESTADO) {
  await t('FALLBACK', `Meta responde ${codigo} (${descripcion}) → cae a v1 con auditoría {fallback:true, razonFallback:'${razon}'} sin datos sensibles`, async () => {
    metaMock.fallarPlantilla('xabor_nuevo_servicio_reparto_v2', codigo);
    try {
      const antesV1 = plantillasEnviadas('xabor_nuevo_servicio_reparto').length;
      const folio = await crearPedidoPrueba(cookieAdminA);
      const fila = await esperarHasta(async () => {
        const f = (await notifsDe(folio)).find(x => x.repartidor_id === repPA.id);
        return f && f.estado !== 'pendiente' ? f : null;
      });

      const v1 = plantillasEnviadas('xabor_nuevo_servicio_reparto');
      assert.ok(v1.length > antesV1, 'la oferta debía salir por la v1 aprobada (no perderse)');
      const params = paramsDe(v1[v1.length - 1]);
      assert.strictEqual(params.length, 3, 'la v1 lleva exactamente 3 variables');
      assert.ok(params[2].includes('/repartidor/aceptar/'), 'v1: variable 3 = enlace');

      assert.ok(fila, 'debía registrarse la notificación del intento');
      assert.strictEqual(fila.estado, 'aceptado_meta', 'el intento terminó aceptado por Meta (vía v1)');
      const audit = JSON.parse(fila.error_detalle);
      assert.deepStrictEqual(audit, {
        plantillaSolicitada: 'xabor_nuevo_servicio_reparto_v2',
        plantillaUtilizada: 'xabor_nuevo_servicio_reparto',
        ubicacionIncluida: false,
        fallback: true,
        razonFallback: razon,
      }, 'el JSON de auditoría del fallback debe ser exacto');
      const crudo = fila.error_detalle;
      assert.ok(!crudo.includes('Tecnológico') && !crudo.includes('8780000000') && !crudo.includes('Centro'),
        'la auditoría del fallback jamás incluye dirección ni teléfonos');
    } finally {
      metaMock.limpiarFallosPlantilla();
    }
  });
}
await t('FALLBACK', 'clasificarErrorPlantillaMeta clasifica códigos y desconocidos de forma estable', () => {
  assert.strictEqual(clasificarErrorPlantillaMeta('Meta API (plantilla x): {"error":{"code":132001}}'), 'template_not_approved_or_missing');
  assert.strictEqual(clasificarErrorPlantillaMeta('Meta API (plantilla x): {"error":{"code":132015}}'), 'template_paused');
  assert.strictEqual(clasificarErrorPlantillaMeta('Meta API (plantilla x): {"error":{"code":999}}'), 'error_meta_999');
  assert.strictEqual(clasificarErrorPlantillaMeta('sin json'), 'error_desconocido');
});

// ═══════════ POR-NEGOCIO: piloto con v2, el resto en v1; aislamiento ═══════════
await t('POR-NEGOCIO', 'negocio B (sin flag v2) envía la v1 directa, sin fallback, y solo a su propio repartidor', async () => {
  const antesV2 = plantillasEnviadas('xabor_nuevo_servicio_reparto_v2').length;
  const folio = await crearPedidoPrueba(cookieAdminB);
  const fila = await esperarHasta(async () => (await notifsDe(folio, SEED.negocioB)).find(f => f.repartidor_id === repPB.id) || null);
  assert.ok(fila, 'el repartidor de B debía ser notificado');
  assert.strictEqual(fila.estado, 'aceptado_meta');
  assert.strictEqual(fila.error_detalle, null, 'v1 directa: sin JSON de fallback');
  assert.strictEqual(plantillasEnviadas('xabor_nuevo_servicio_reparto_v2').length, antesV2, 'B jamás debe enviar la v2');
  const todas = await notifsDe(folio, SEED.negocioB);
  assert.ok(!todas.some(f => f.repartidor_id === repPA.id), 'el repartidor de A jamás se notifica desde un pedido de B (aislamiento)');
});
await t('POR-NEGOCIO', 'rollback sin deploy: apagar el flag v2 de A y el siguiente pedido sale por v1 sin fallback', async () => {
  await actualizarConfiguracion({ repartidor_notif_plantilla_v2_activo: 'false' }, SEED.negocioA);
  try {
    const antesV2 = plantillasEnviadas('xabor_nuevo_servicio_reparto_v2').length;
    const folio = await crearPedidoPrueba(cookieAdminA);
    const fila = await esperarHasta(async () => (await notifsDe(folio)).find(f => f.repartidor_id === repPA.id) || null);
    assert.ok(fila, 'debía notificarse');
    assert.strictEqual(fila.error_detalle, null, 'con el flag apagado es v1 directa, no un fallback');
    assert.strictEqual(plantillasEnviadas('xabor_nuevo_servicio_reparto_v2').length, antesV2, 'con el flag apagado la v2 no debe intentarse');
  } finally {
    await actualizarConfiguracion({ repartidor_notif_plantilla_v2_activo: 'true' }, SEED.negocioA);
  }
});

// ═══════════ CARRERA: contrato de aceptación intacto ═══════════
await t('CARRERA', 'dos repartidores aceptan a la vez: uno gana, el otro ve cubierto_por_otro con SOLO el nombre del ganador', async () => {
  const folio = await crearPedidoPrueba(cookieAdminA);
  const filas = await esperarHasta(async () => {
    const r = await notifsDe(folio);
    return r.length >= 2 ? r : null;
  });
  assert.ok(filas, 'ambos repartidores en whitelist debían recibir token');
  const filaA = filas.find(f => f.repartidor_id === repPA.id);
  const filaA2 = filas.find(f => f.repartidor_id === repPA2.id);
  assert.ok(filaA && filaA2, 'debían existir tokens para ambos');

  const [r1, r2] = await Promise.all([
    fetch(`${base}/api/repartidor/oferta/${filaA.token_aceptacion}/aceptar`, { method: 'POST' }),
    fetch(`${base}/api/repartidor/oferta/${filaA2.token_aceptacion}/aceptar`, { method: 'POST' }),
  ]);
  const [b1, b2] = [await r1.json(), await r2.json()];
  const estados = [b1.estado, b2.estado].sort();
  assert.deepStrictEqual(estados, ['asignado_a_mi', 'cubierto_por_otro'], `exactamente un ganador y un cubierto, hubo: ${estados}`);
  const perdedor = b1.estado === 'cubierto_por_otro' ? b1 : b2;
  assert.ok(['Rep PrimerMsj A', 'Rep PrimerMsj A2'].includes(perdedor.repartidorAsignado?.nombre), 'el perdedor ve el NOMBRE del ganador');
  const crudoPerdedor = JSON.stringify(perdedor);
  assert.ok(!crudoPerdedor.includes('Tecnológico') && !crudoPerdedor.includes('8781234567'), 'el perdedor jamás ve dirección ni teléfono del cliente');
});

// Limpieza: esta suite restaura la configuración de notificación EXACTAMENTE
// a su estado previo (claves ausentes) -- dejarlas puestas contaminaba a
// fase-repartidores-notificaciones (su caso FLAG-OFF espera que negocioB no
// tenga modo plantilla). Los pedidos XAB- de /test/pedido quedan sin
// entregar y no ensucian métricas de universos.
await pool.query(
  `DELETE FROM configuracion WHERE negocio_id IN ($1,$2)
     AND clave IN ('repartidor_notif_modo','repartidor_notif_piloto_telefonos','repartidor_notif_plantilla_v2_activo')`,
  [SEED.negocioA, SEED.negocioB]
);

// ═══════════ Resumen ═══════════
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await metaMock.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
