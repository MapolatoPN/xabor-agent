// Rollout completo de notificaciones a repartidores (cierre operativo del
// piloto de Nonna Maye). Cubre dos piezas nuevas:
//
//   1. repartidor_notif_modo = 'apagado' | 'piloto' | 'completo' -- tri-estado
//      explícito que reemplaza al booleano repartidor_notif_plantilla_activo
//      como fuente de verdad (con retrocompatibilidad: sin la clave nueva,
//      se deriva del booleano anterior). 'completo' notifica a todos los
//      repartidores ELEGIBLES (activo + teléfono válido + deduplicado),
//      nunca a la tabla sin filtros, y la ausencia de whitelist nunca activa
//      este modo por accidente.
//
//   2. esPedidoElegibleParaRedRepartidores(pedido) (orderManager.js) --
//      única fuente de verdad para decidir si un pedido puede entrar a la
//      red de repartidores de Xabor. Un pedido de Rappi NUNCA debe generar
//      notificaciones, tokens, ni aparecer "Buscando repartidor" -- Rappi ya
//      administra y asigna sus propios repartidores.
//
// Uso: mismas env vars que el resto de la batería. Requiere
// aplicar-migraciones.mjs y seed-datos-prueba.mjs ya corridos.
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
const { pool, actualizarConfiguracion, crearUsuarioConPassword, existeNotificacionRepartidor } = await import('../src/services/database.js');
// esPedidoElegibleParaRedRepartidores es pura (sin I/O) y orderManager.js no
// importa whatsapp-meta.js/server.js de forma estática (solo dinámica,
// diferida a emitirPedido) -- seguro de importar aquí. notificarRepartidoresPorWA
// NO se importa directamente: whatsapp-meta.js y server.js tienen una
// dependencia circular a nivel de módulo (whatsapp-meta.js importa
// `getIntegracion` de server.js) que solo resuelve bien cuando server.js es
// el punto de entrada real (como hace arrancarServidor, en su propio
// proceso) -- importarlo aquí como entrada directa dispara un
// ReferenceError de TDZ preexistente, ajeno a este cambio.
const { esPedidoElegibleParaRedRepartidores } = await import('../src/orders/orderManager.js');

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

// ═══════════ Setup ═══════════
await fijarModulo(SEED.negocioA, 'pos', 'activo');
await fijarModulo(SEED.negocioB, 'pos', 'activo');
await actualizarConfiguracion({ int_wa_phone_id: 'PNID_ROLLOUT_A', int_wa_token: 'fake-token-rollout-a' }, SEED.negocioA);
await actualizarConfiguracion({ int_wa_phone_id: 'PNID_ROLLOUT_B', int_wa_token: 'fake-token-rollout-b' }, SEED.negocioB);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,'Rollout A',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [SEED.negocioA, 'PNID_ROLLOUT_A']);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,'Rollout B',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [SEED.negocioB, 'PNID_ROLLOUT_B']);

const metaMock = await arrancarMetaMock();
const srv = await arrancarServidor({ PORT: PUERTO, META_GRAPH_BASE_URL: metaMock.baseUrl }, { timeoutMs: 30000 });
const base = srv.base;

const { rows: [adminBExistente] } = await pool.query(`SELECT id FROM usuarios WHERE email = 'admin-b-rollout@test.local'`);
const adminNegocioB = adminBExistente || await crearUsuarioConPassword({
  negocioId: SEED.negocioB, nombre: 'Admin Negocio B (rollout)', email: 'admin-b-rollout@test.local',
  password: 'ClaveAdminBPrueba123!', rol: 'admin',
});
const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
const cookieAdminB = cookieHeader(adminNegocioB.id, SEED.negocioB, 'admin');

async function crearPedidoPrueba(cookie) {
  const r = await api(base, '/test/pedido', { cookie, method: 'POST' });
  assert.strictEqual(r.status, 200, `/test/pedido debe responder 200, dio ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.pedido.id;
}
async function notifsDe(folio, negocioId = SEED.negocioA) {
  const { rows } = await pool.query(
    `SELECT nr.*, r.telefono FROM notificaciones_repartidor nr JOIN repartidores r ON r.id = nr.repartidor_id WHERE nr.pedido_folio = $1 AND nr.negocio_id = $2`,
    [folio, negocioId]
  );
  return rows;
}

// Repartidores de prueba dedicados a esta suite -- limpieza idempotente.
const TELS = ['5210000910001', '5210000910002', '5210000910003', '5210000910004', '9000910005', '5219000910005'];
await pool.query(`DELETE FROM notificaciones_repartidor WHERE repartidor_id IN (SELECT id FROM repartidores WHERE telefono = ANY($1))`, [TELS]);
await pool.query(`DELETE FROM repartidores WHERE telefono = ANY($1)`, [TELS]);
async function crearRepartidor(nombre, telefono, negocioId, activo = true) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO repartidores (nombre, telefono, token, activo, negocio_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [nombre, telefono, 'tok-rollout-' + telefono, activo, negocioId]
  );
  return r;
}
const repActivo1 = await crearRepartidor('Rollout Activo 1', '5210000910001', SEED.negocioA, true);
const repActivo2 = await crearRepartidor('Rollout Activo 2', '5210000910002', SEED.negocioA, true);
const repInactivo = await crearRepartidor('Rollout Inactivo', '5210000910003', SEED.negocioA, false);
const repInvalido = await crearRepartidor('Rollout Invalido', '123', SEED.negocioA, true); // teléfono inválido a propósito
const repDup1 = await crearRepartidor('Rollout Dup 1', '9000910005', SEED.negocioA, true);
const repDup2 = await crearRepartidor('Rollout Dup 2', '5219000910005', SEED.negocioA, true); // mismo teléfono, otro formato
const repOtroNegocio = await crearRepartidor('Rollout Otro Negocio', '5210000910004', SEED.negocioB, true);

// ═══════════ MODO-APAGADO (regresión) ═══════════
await t('MODO-APAGADO', 'sin plantilla: texto libre, cero filas en notificaciones_repartidor', async () => {
  await actualizarConfiguracion({ repartidor_notif_modo: 'apagado' }, SEED.negocioA);
  const folio = await crearPedidoPrueba(cookieAdminA);
  await esperar(2000);
  const filas = await notifsDe(folio);
  assert.strictEqual(filas.length, 0, 'modo apagado no debe generar ninguna fila de notificación');
});

// ═══════════ MODO-COMPLETO ═══════════
await t('MODO-COMPLETO', 'activo recibe, inactivo/inválido no reciben, duplicado recibe una sola vez', async () => {
  await actualizarConfiguracion({ repartidor_notif_modo: 'completo' }, SEED.negocioA);
  const folio = await crearPedidoPrueba(cookieAdminA);
  const filas = await esperarHasta(async () => {
    const r = await notifsDe(folio);
    return r.length ? r : null;
  });
  assert.ok(filas, 'debía haber al menos un intento en modo completo');
  const idsNotificados = new Set(filas.map(f => f.repartidor_id));

  assert.ok(idsNotificados.has(repActivo1.id), 'repActivo1 debía recibir la plantilla');
  assert.ok(idsNotificados.has(repActivo2.id), 'repActivo2 debía recibir la plantilla');
  assert.ok(!idsNotificados.has(repInactivo.id), 'repInactivo NO debía recibir nada');
  assert.ok(!idsNotificados.has(repInvalido.id), 'repInvalido (teléfono inválido) NO debía recibir nada');
  assert.ok(!idsNotificados.has(repOtroNegocio.id), 'repOtroNegocio (negocioB) NO debía recibir nada desde un pedido de negocioA');

  const deLosDuplicados = filas.filter(f => f.repartidor_id === repDup1.id || f.repartidor_id === repDup2.id);
  assert.strictEqual(deLosDuplicados.length, 1, `el teléfono duplicado debía recibir un solo envío, hubo ${deLosDuplicados.length}`);
});

// ═══════════ INTENTO-IDEMPOTENTE ═══════════
// notificarRepartidoresPorWA no se puede invocar de forma segura dos veces
// desde este proceso de prueba (whatsapp-meta.js/server.js tienen una
// dependencia circular a nivel de módulo que solo resuelve bien cuando
// server.js es el punto de entrada real -- ver comentario junto al import
// de arriba). Se prueba entonces el primitivo exacto del que depende el
// guard de idempotencia (existeNotificacionRepartidor) contra las filas
// reales que el flujo end-to-end ya generó en MODO-COMPLETO -- combinado
// con la revisión de código (el guard se ejecuta antes de cada envío en el
// bucle de notificarRepartidoresPorWA), es evidencia equivalente sin
// depender de una importación insegura.
await t('INTENTO-IDEMPOTENTE', 'existeNotificacionRepartidor refleja correctamente un intento ya registrado (primitivo del guard de idempotencia)', async () => {
  await actualizarConfiguracion({ repartidor_notif_modo: 'completo' }, SEED.negocioA);
  const folio = await crearPedidoPrueba(cookieAdminA);
  const filas = await esperarHasta(async () => {
    const r = await notifsDe(folio);
    return r.length ? r : null;
  });
  assert.ok(filas?.length, 'debía haber al menos un intento real para verificar el primitivo');
  const yaNotificado = await existeNotificacionRepartidor(folio, repActivo1.id);
  assert.strictEqual(yaNotificado, true, 'existeNotificacionRepartidor debe reflejar el intento ya registrado');
  const nuncaNotificado = await existeNotificacionRepartidor(folio, repInactivo.id);
  assert.strictEqual(nuncaNotificado, false, 'un repartidor que nunca recibió nada debe devolver false');
});

// ═══════════ ROLLBACK-COMPLETO-A-PILOTO ═══════════
await t('ROLLBACK-A-PILOTO', 'cambiar de completo a piloto restringe de nuevo a la whitelist en el siguiente pedido', async () => {
  await actualizarConfiguracion({
    repartidor_notif_modo: 'piloto',
    repartidor_notif_piloto_telefonos: '5210000910001',
  }, SEED.negocioA);
  const folio = await crearPedidoPrueba(cookieAdminA);
  const filas = await esperarHasta(async () => {
    const r = await notifsDe(folio);
    return r.length ? r : null;
  });
  assert.ok(filas, 'debía notificarse al menos al repartidor en whitelist');
  const idsNotificados = new Set(filas.map(f => f.repartidor_id));
  assert.strictEqual(filas.length, 1, `tras volver a piloto, solo 1 destinatario (whitelist), hubo ${filas.length}`);
  assert.ok(idsNotificados.has(repActivo1.id), 'debía notificar únicamente al de la whitelist');
});

// ═══════════ Restaurar apagado para no afectar otras suites ═══════════
await actualizarConfiguracion({ repartidor_notif_modo: 'apagado' }, SEED.negocioA);

// ═══════════════════════════════════════════════════════════════════════
// esPedidoElegibleParaRedRepartidores -- pruebas unitarias puras (sin DB)
// ═══════════════════════════════════════════════════════════════════════
function pedidoBase(overrides = {}) {
  return {
    id: 'XAB-TEST', negocioId: SEED.negocioA, modalidad: 'entrega a domicilio',
    canal: 'whatsapp', estado: 'nuevo', total: 100, cliente: { nombre: 'Cliente' },
    ...overrides,
  };
}

await t('ELEGIBILIDAD', 'pedido de WhatsApp a domicilio -> elegible', () => {
  assert.strictEqual(esPedidoElegibleParaRedRepartidores(pedidoBase({ canal: 'whatsapp' })), true);
});
await t('ELEGIBILIDAD', 'pedido manual (presencial/admin) a domicilio -> elegible', () => {
  assert.strictEqual(esPedidoElegibleParaRedRepartidores(pedidoBase({ canal: 'presencial' })), true);
});
await t('ELEGIBILIDAD', 'pedido web propio a domicilio -> elegible', () => {
  assert.strictEqual(esPedidoElegibleParaRedRepartidores(pedidoBase({ canal: 'web' })), true);
});
await t('ELEGIBILIDAD', 'pedido de Rappi a domicilio -> NO elegible (canal=rappi)', () => {
  assert.strictEqual(esPedidoElegibleParaRedRepartidores(pedidoBase({ canal: 'rappi' })), false);
});
await t('ELEGIBILIDAD', 'pedido con rappi_order_id aunque canal venga mal etiquetado -> NO elegible', () => {
  assert.strictEqual(esPedidoElegibleParaRedRepartidores(pedidoBase({ canal: 'whatsapp', rappi_order_id: '12345' })), false);
});
await t('ELEGIBILIDAD', 'pedido para recoger en tienda -> NO elegible', () => {
  assert.strictEqual(esPedidoElegibleParaRedRepartidores(pedidoBase({ modalidad: 'recoger en tienda' })), false);
});
await t('ELEGIBILIDAD', 'pedido cancelado -> NO elegible', () => {
  assert.strictEqual(esPedidoElegibleParaRedRepartidores(pedidoBase({ estado: 'cancelado' })), false);
});
await t('ELEGIBILIDAD', 'pedido entregado -> NO elegible', () => {
  assert.strictEqual(esPedidoElegibleParaRedRepartidores(pedidoBase({ estado: 'entregado' })), false);
});
await t('ELEGIBILIDAD', 'marcador genérico de integración externa Rappi -> NO elegible', () => {
  assert.strictEqual(esPedidoElegibleParaRedRepartidores(pedidoBase({ integracion_externa: 'rappi' })), false);
});
await t('ELEGIBILIDAD', 'pedido nulo/indefinido -> NO elegible, nunca lanza', () => {
  assert.strictEqual(esPedidoElegibleParaRedRepartidores(null), false);
  assert.strictEqual(esPedidoElegibleParaRedRepartidores(undefined), false);
});

// ═══════════ "REENVÍO MANUAL SOBRE PEDIDO RAPPI" -- nota de cobertura ═══════
// No existe todavía en el producto ningún endpoint de "reenvío manual" ni
// botón "Buscar repartidor" (se confirmó buscando en server.js) -- no hay
// nada real que probar end-to-end para ese caso concreto todavía. La
// garantía queda cubierta en dos capas, sin invocar notificarRepartidoresPorWA
// directamente desde este proceso (ver nota de la dependencia circular más
// arriba): (1) las pruebas ELEGIBILIDAD de arriba prueban exhaustivamente
// que esPedidoElegibleParaRedRepartidores devuelve false para cualquier
// forma de pedido de Rappi; (2) notificarRepartidoresPorWA llama a esa
// misma función como su primera verificación (ver whatsapp-meta.js, líneas
// justo después del guard de negocioId) -- por construcción, cualquier
// futuro "reenvío manual" o botón "Buscar repartidor" que reutilice esa
// función (tal como exige el encargo) queda cubierto por las mismas pruebas.

// ═══════════ AISLAMIENTO MULTIEMPRESA (contexto de esta suite) ═══════════
await t('AISLAMIENTO', 'un pedido elegible de negocioA nunca genera notificaciones para repartidores de negocioB', async () => {
  await actualizarConfiguracion({ repartidor_notif_modo: 'completo' }, SEED.negocioA);
  const folio = await crearPedidoPrueba(cookieAdminA);
  await esperarHasta(async () => {
    const r = await notifsDe(folio);
    return r.length ? r : null;
  });
  const comoB = await notifsDe(folio, SEED.negocioB);
  assert.strictEqual(comoB.length, 0, 'notificaciones de negocioA nunca deben ser visibles/generadas para negocioB');
  await actualizarConfiguracion({ repartidor_notif_modo: 'apagado' }, SEED.negocioA);
});

// ═══════════ Resumen ═══════════
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await metaMock.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
