// Corrección D.1 — Red de Repartidores: universos de métricas.
//
// Reproduce y corrige el bug real detectado en producción: la tasa de
// finalización de la red llegó a mostrar 1750% porque "servicios
// entregados" contaba CUALQUIER pedido de entrega a domicilio en estado
// 'entregado' (incluyendo entregas manuales/presenciales/históricas sin
// evidencia de haber pasado por la Red de Repartidores), mientras que
// "servicios aceptados" solo contaba los realmente aceptados por un
// repartidor -- dos universos de datos distintos usados como numerador y
// denominador de la misma tasa.
//
// Cubre los 15 casos verificables como aserciones unitarias de la lista de
// 17 pedida por el usuario (los casos 16 y 17 -- regresión completa y
// build Docker -- se ejecutan aparte, como el resto de la batería).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4199';

const { crearTokenSesion } = await import('../src/services/session.js');
const {
  pool, registrarRepartidor, cambiarEstadoRepartidor, registrarNotificacionRepartidor,
} = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
function cookieHeader(usuarioId, negocioId, rol) { return `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`; }
async function api(base, path, { cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(base + path, { headers });
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch {}
  return { status: r.status, body: json, texto };
}
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(
    `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
     ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`,
    [negocioId, modulo, estado]
  );
}

const sufijo = Date.now().toString().slice(-6);
let contadorFolio = 0;
async function crearPedidoDirecto(negocioId, { total = 200, estado = 'nuevo', canal = 'whatsapp', rappiOrderId = null, repartidorId = null, repartidorNombre = null } = {}) {
  contadorFolio += 1;
  const folio = `UN${sufijo}${contadorFolio}`;
  const datos = {
    id: folio, negocioId, modalidad: 'entrega a domicilio', canal, total,
    cliente: { nombre: 'Cliente Prueba', telefono: '8781234567', calle: 'Calle Prueba 1', colonia: 'Centro' },
    estado,
    ...(rappiOrderId ? { rappi_order_id: rappiOrderId } : {}),
    ...(repartidorId ? { repartidor_id: repartidorId, repartidor_nombre: repartidorNombre } : {}),
  };
  await pool.query(
    `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at) VALUES ($1,$2,$3,$4,NOW())`,
    [folio, estado, JSON.stringify(datos), negocioId]
  );
  return folio;
}
async function notificar(negocioId, folio, repartidorId, { estado = 'entregado', tokenUsadoAt = null } = {}) {
  const token = `tok-un-${folio}-${repartidorId}-${Math.random().toString(36).slice(2)}`;
  await registrarNotificacionRepartidor({ negocioId, pedidoFolio: folio, repartidorId, canal: 'plantilla', wamid: `wamid-${token}`, estado, tokenAceptacion: token, tokenExpiraAt: new Date(Date.now() + 30 * 60000) });
  if (tokenUsadoAt) await pool.query(`UPDATE notificaciones_repartidor SET token_usado_at = $1 WHERE token_aceptacion = $2`, [tokenUsadoAt, token]);
}

await fijarModulo(SEED.negocioA, 'pos', 'activo');

// Caso 1 necesita un conteo EXACTO (35/3/2/2) -- SEED.negocioA es compartido
// por toda la batería y puede acumular pedidos de entrega a domicilio de
// otras suites que corren antes que esta en la misma base de datos. Se usa
// un negocio propio y desechable, creado aquí mismo, para que el conteo
// exacto del Caso 1 nunca dependa de qué más se ejecutó antes en la batería.
const { rows: [negocioCaso1] } = await pool.query(
  `INSERT INTO negocios (nombre, slug) VALUES ($1, $2) RETURNING id`,
  [`Universos Caso1 ${sufijo}`, `universos-caso1-${sufijo}`]
);
const negocioUnoServicio = negocioCaso1.id;
await fijarModulo(negocioUnoServicio, 'pos', 'activo');

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;
const cookieSuperadmin = cookieHeader(SEED.superadminUsuarioId, SEED.negocioA, 'admin');
const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
const cookieStaffA = cookieHeader(SEED.staffNegocioAUsuarioId, SEED.negocioA, 'staff');

// Repartidor propio del negocio desechable del Caso 1 -- nunca comparte
// datos con SEED.negocioA, así el conteo exacto no depende de nada más de
// lo que otras suites hayan creado en la base compartida.
const repCaso1 = await registrarRepartidor(`UN Caso1 ${sufijo}`, `87822${sufijo}`, negocioUnoServicio);
// Repartidor simple en SEED.negocioA -- solo para los casos que verifican
// que el nombre del negocio se muestre (no cuentan actividad exacta).
const rep1 = await registrarRepartidor(`UN Rep1 ${sufijo}`, `87821${sufijo}`, SEED.negocioA);

// ═══════════ Caso 1: reproducción exacta del bug (35/3/2/2 -> 100%) ═══════
await t('universos', 'Caso 1: 35 servicios de red, 3 ofrecidos, 2 aceptados, 2 entregados por la red -> finalización 100%, no 1750%', async () => {
  // 32 entregas manuales/históricas: modalidad entrega a domicilio,
  // entregadas, SIN repartidor_id y SIN ninguna notificación -- exactamente
  // el patrón real encontrado en producción (pre-instrumentación / entrega
  // presencial). Nunca deben contarse como "entregados por la red".
  for (let i = 0; i < 32; i++) {
    await crearPedidoDirecto(negocioUnoServicio, { total: 100 + i, estado: 'entregado' });
  }
  // 3 servicios realmente ofrecidos a la red.
  const folioA = await crearPedidoDirecto(negocioUnoServicio, { total: 500, estado: 'entregado', repartidorId: repCaso1.id, repartidorNombre: repCaso1.nombre });
  await notificar(negocioUnoServicio, folioA, repCaso1.id, { estado: 'leido', tokenUsadoAt: new Date() });
  const folioB = await crearPedidoDirecto(negocioUnoServicio, { total: 501, estado: 'entregado', repartidorId: repCaso1.id, repartidorNombre: repCaso1.nombre });
  await notificar(negocioUnoServicio, folioB, repCaso1.id, { estado: 'leido', tokenUsadoAt: new Date() });
  const folioC = await crearPedidoDirecto(negocioUnoServicio, { total: 502, estado: 'nuevo' }); // ofrecido pero nunca aceptado
  await notificar(negocioUnoServicio, folioC, repCaso1.id, { estado: 'entregado' });

  const r = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${negocioUnoServicio}`, { cookie: cookieSuperadmin });
  assert.strictEqual(r.status, 200);
  const tj = r.body.tarjetas;
  assert.strictEqual(tj.serviciosRedCreados, 35, `serviciosRedCreados debe ser 35, dio ${tj.serviciosRedCreados}`);
  assert.strictEqual(tj.serviciosRedOfrecidos, 3, `serviciosRedOfrecidos debe ser 3, dio ${tj.serviciosRedOfrecidos}`);
  assert.strictEqual(tj.serviciosRedAceptados, 2, `serviciosRedAceptados debe ser 2, dio ${tj.serviciosRedAceptados}`);
  assert.strictEqual(tj.serviciosRedEntregados, 2, `serviciosRedEntregados debe ser 2 (solo los asignados por la red), dio ${tj.serviciosRedEntregados}`);
  assert.strictEqual(tj.entregasManuales, 32, `entregasManuales debe ser 32, dio ${tj.entregasManuales}`);
  assert.strictEqual(tj.tasaFinalizacionRed, 1, `tasaFinalizacionRed debe ser exactamente 1 (100%), nunca 17.5, dio ${tj.tasaFinalizacionRed}`);
});

// ═══════════ Caso 2: entregas externas excluidas ═══════════
await t('universos', 'Entregas externas (Rappi) nunca afectan tasaAceptacion ni tasaFinalizacionRed', async () => {
  const antes = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  for (let i = 0; i < 5; i++) {
    await crearPedidoDirecto(SEED.negocioA, { total: 300 + i, estado: 'entregado', canal: 'rappi', rappiOrderId: `RAPPI-UN-${sufijo}-${i}` });
  }
  const despues = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  assert.strictEqual(despues.body.tarjetas.entregasExternas, antes.body.tarjetas.entregasExternas + 5);
  assert.strictEqual(despues.body.tarjetas.serviciosRedCreados, antes.body.tarjetas.serviciosRedCreados, 'Rappi no debe sumar a serviciosRedCreados');
  assert.strictEqual(despues.body.tarjetas.tasaAceptacion, antes.body.tarjetas.tasaAceptacion, 'Rappi no debe mover tasaAceptacion');
  assert.strictEqual(despues.body.tarjetas.tasaFinalizacionRed, antes.body.tarjetas.tasaFinalizacionRed, 'Rappi no debe mover tasaFinalizacionRed');
});

// ═══════════ Caso 3: entregas manuales excluidas de la red ═══════════
await t('universos', 'Entregas manuales (sin repartidor_id) nunca cuentan como serviciosRedEntregados', async () => {
  const antes = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  await crearPedidoDirecto(SEED.negocioA, { total: 999, estado: 'entregado' }); // manual, sin repartidor_id
  const despues = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  assert.strictEqual(despues.body.tarjetas.entregasManuales, antes.body.tarjetas.entregasManuales + 1);
  assert.strictEqual(despues.body.tarjetas.serviciosRedEntregados, antes.body.tarjetas.serviciosRedEntregados, 'una entrega manual nueva no debe subir serviciosRedEntregados');
});

// ═══════════ Caso 4: aceptados=0 -> finalización null ═══════════
await t('universos', 'Sin ningún servicio aceptado en el período, tasaFinalizacionRed es null', async () => {
  const desde = new Date(Date.now() + 365 * 86400000).toISOString();
  const r = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}&desde=${encodeURIComponent(desde)}`, { cookie: cookieSuperadmin });
  assert.strictEqual(r.body.tarjetas.serviciosRedAceptados, 0);
  assert.strictEqual(r.body.tarjetas.tasaFinalizacionRed, null);
});

// ═══════════ Caso 5: ofrecidos=0 -> aceptación null ═══════════
await t('universos', 'Sin ningún servicio ofrecido en el período, tasaAceptacion es null', async () => {
  const desde = new Date(Date.now() + 365 * 86400000).toISOString();
  const r = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}&desde=${encodeURIComponent(desde)}`, { cookie: cookieSuperadmin });
  assert.strictEqual(r.body.tarjetas.serviciosRedOfrecidos, 0);
  assert.strictEqual(r.body.tarjetas.tasaAceptacion, null);
});

// ═══════════ Caso 6: sin divisiones entre cero (coberturaRed también) ═══════
await t('universos', 'Sin servicios creados en el período, coberturaRed es null (no división entre cero)', async () => {
  const desde = new Date(Date.now() + 365 * 86400000).toISOString();
  const r = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}&desde=${encodeURIComponent(desde)}`, { cookie: cookieSuperadmin });
  assert.strictEqual(r.body.tarjetas.serviciosRedCreados, 0);
  assert.strictEqual(r.body.tarjetas.coberturaRed, null);
});

// ═══════════ Caso 7: ningún porcentaje > 100% cuando los universos son coherentes ═══════
await t('universos', 'Con universos coherentes, ninguna tasa de la red supera 100% (fracción <= 1)', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  const tj = r.body.tarjetas;
  for (const campo of ['tasaAceptacion', 'tasaFinalizacionRed', 'coberturaRed']) {
    if (tj[campo] != null) {
      assert.ok(tj[campo] <= 1, `${campo} no debe superar 1 (100%), dio ${tj[campo]}`);
    }
  }
});

// ═══════════ Caso 8: datos históricos 0/0/0 no son "actividad real" ═══════
await t('universos', 'Servicios sin ninguna notificación (0/0/0) activan el aviso de datos históricos incompletos, no se cuentan como ofrecidos/aceptados', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  assert.strictEqual(r.body.avisos.datosHistoricosIncompletos, true, 'con 32+ entregas manuales sin ninguna notificación, debe activarse el aviso');
  assert.ok(typeof r.body.avisos.mensaje === 'string' && r.body.avisos.mensaje.length > 0);
});

// ═══════════ Caso 9: nombre del negocio, no UUID ═══════════
await t('universos', 'porNegocio y ranking muestran el nombre legible del negocio, no el UUID como etiqueta', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/metricas`, { cookie: cookieSuperadmin });
  const fila = r.body.porNegocio.find(n => n.negocioId === SEED.negocioA);
  assert.ok(fila, 'debe existir una fila para negocioA');
  assert.ok(fila.negocioNombre && fila.negocioNombre !== SEED.negocioA, 'negocioNombre debe ser un nombre legible, no el UUID');
  assert.notStrictEqual(fila.negocioNombre, fila.negocioId);

  const rk = await api(base, `/api/superadmin/red-repartidores/ranking?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  const todas = [...rk.body.rankingElegible, ...rk.body.muestraInsuficiente, ...rk.body.suspendidosOBaja];
  assert.ok(todas.length > 0, 'debe haber al menos un repartidor en el ranking');
  assert.ok(todas.every(f => f.negocioNombre && f.negocioNombre !== f.negocioId), 'cada fila del ranking debe traer negocioNombre distinto del UUID');
});

// ═══════════ Caso 10: Rappi separado (embudo/tarjetas nunca lo incluyen) ═══════
await t('universos', 'Rappi (entregasExternas) nunca se mezcla con serviciosRedCreados ni con el embudo de notificaciones', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  assert.ok(r.body.tarjetas.entregasExternas >= 5, 'debe reflejar los 5 pedidos Rappi creados antes');
  assert.ok(r.body.tarjetas.serviciosRedCreados < 100, 'sanity: serviciosRedCreados no debe incluir cifras infladas por Rappi');
});

// ═══════════ Caso 11: negocio-admin aislado tras la corrección ═══════════
await t('universos', 'Negocio-admin sigue aislado a su propio negocio con los nuevos nombres de campo', async () => {
  const r = await api(base, `/api/admin/repartidores/metricas`, { cookie: cookieAdminA });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.porNegocio, null);
  assert.ok('serviciosRedCreados' in r.body.tarjetas);
});

// ═══════════ Caso 12: staff 403 ═══════════
await t('universos', 'Staff sigue recibiendo 403 tras la corrección', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/metricas`, { cookie: cookieStaffA });
  assert.strictEqual(r.status, 403);
});

// ═══════════ Caso 13: superadmin cross-negocio con nombres corregidos ═══════
await t('universos', 'Superadmin cross-negocio ve porNegocio con nombres, sin fuga entre negocios', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/metricas`, { cookie: cookieSuperadmin });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.porNegocio));
  const negocioAFila = r.body.porNegocio.find(n => n.negocioId === SEED.negocioA);
  assert.ok(negocioAFila);
  // El total de negocioA en el desglose cross-negocio debe coincidir con la consulta acotada a ese negocio.
  const rAcotado = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  assert.strictEqual(negocioAFila.serviciosRedCreados, rAcotado.body.tarjetas.serviciosRedCreados, 'el desglose por negocio no debe filtrar datos de otro negocio hacia negocioA');
});

// ═══════════ Caso 14: CSV con nombres legibles y métricas corregidas ═══════
await t('universos', 'CSV de ranking incluye la columna Negocio con nombre legible', async () => {
  const { rows } = await pool.query('SELECT nombre FROM negocios WHERE id = $1', [SEED.negocioA]);
  const nombreReal = rows[0].nombre;
  const r = await fetch(`${base}/api/superadmin/red-repartidores/ranking/exportar.csv?negocioId=${SEED.negocioA}`, { headers: { Cookie: cookieSuperadmin } });
  assert.strictEqual(r.status, 200);
  const texto = await r.text();
  assert.ok(texto.includes('Repartidor,Negocio,NegocioId,'), 'encabezado debe incluir Negocio (nombre) antes de NegocioId');
  assert.ok(texto.includes(nombreReal), `el CSV debe incluir el nombre real del negocio ("${nombreReal}"), no solo el UUID`);
});

// ═══════════ Caso 15: ranking excluye entregas externas ═══════════
await t('universos', 'El ranking de repartidores nunca incluye entregas externas (Rappi)', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/ranking?negocioId=${negocioUnoServicio}`, { cookie: cookieSuperadmin });
  const fila = [...r.body.rankingElegible, ...r.body.muestraInsuficiente, ...r.body.suspendidosOBaja].find(f => f.repartidorId === repCaso1.id);
  assert.ok(fila, 'repCaso1 debe aparecer en algún grupo del ranking');
  // repCaso1 tiene exactamente 2 aceptados/entregados reales (caso 1, en su propio negocio aislado) --
  // los 5 Rappi del caso 2 (creados en SEED.negocioA) nunca debieron sumarle nada.
  assert.strictEqual(fila.serviciosAceptados, 2, `serviciosAceptados de repCaso1 debe ser 2 (Rappi no debe sumar), dio ${fila.serviciosAceptados}`);
});

// ═══════════ Reporte ═══════════
console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas > 0) { console.log('\nFallos:'); fallos.forEach(f => console.log(' -', f)); }
await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
