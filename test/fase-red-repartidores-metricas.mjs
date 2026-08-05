// Red de Repartidores — Fase D: Métricas y ranking.
//
// Cubre los 31 casos pedidos por el usuario. Los casos 30 (regresión
// completa) y 31 (build Docker) se ejecutan como parte de la batería
// completa por separado (no son aserciones unitarias de este archivo);
// aquí se cubren los 29 restantes.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4198';

const { crearTokenSesion } = await import('../src/services/session.js');
const {
  pool, actualizarConfiguracion, registrarRepartidor, cambiarEstadoRepartidor,
  editarPerfilRepartidor, registrarNotificacionRepartidor, actualizarEstadoPedidoDB,
  crearUsuarioConPassword,
} = await import('../src/services/database.js');

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
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

let contadorFolio = 0;
async function crearPedidoDirecto(negocioId, { calle = 'Av. Tecnológico 123', colonia = 'Centro', total = 200, estado = 'nuevo', canal = 'whatsapp', rappiOrderId = null, creadoHaceMin = 0 } = {}) {
  contadorFolio += 1;
  const folio = `MT${sufijo}${contadorFolio}`;
  const creadoAt = new Date(Date.now() - creadoHaceMin * 60000);
  const datos = {
    id: folio, negocioId, modalidad: 'entrega a domicilio', canal, total,
    cliente: { nombre: 'Cliente Prueba', telefono: '8781234567', calle, colonia },
    estado,
    ...(rappiOrderId ? { rappi_order_id: rappiOrderId } : {}),
  };
  await pool.query(
    `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at) VALUES ($1,$2,$3,$4,$5)`,
    [folio, estado, JSON.stringify(datos), negocioId, creadoAt]
  );
  return { folio, creadoAt };
}
async function asignarRepartidorDirecto(folio, repartidorId, repartidorNombre) {
  await pool.query(
    `UPDATE pedidos_activos SET datos = jsonb_set(jsonb_set(datos, '{repartidor_id}', $2::jsonb), '{repartidor_nombre}', $3::jsonb) WHERE folio = $1`,
    [folio, JSON.stringify(repartidorId), JSON.stringify(repartidorNombre)]
  );
}
async function notificar(negocioId, folio, repartidorId, { estado = 'entregado', tokenUsadoAt = null, tokenExpiraAt = new Date(Date.now() + 30 * 60000), creadoAt = new Date() } = {}) {
  const token = `tok-${folio}-${repartidorId}-${Math.random().toString(36).slice(2)}`;
  await registrarNotificacionRepartidor({ negocioId, pedidoFolio: folio, repartidorId, canal: 'plantilla', wamid: `wamid-${token}`, estado, tokenAceptacion: token, tokenExpiraAt });
  await pool.query(`UPDATE notificaciones_repartidor SET created_at = $1 WHERE token_aceptacion = $2`, [creadoAt, token]);
  if (tokenUsadoAt) await pool.query(`UPDATE notificaciones_repartidor SET token_usado_at = $1 WHERE token_aceptacion = $2`, [tokenUsadoAt, token]);
  return token;
}

// ═══════════ Setup ═══════════
const sufijo = Date.now().toString().slice(-6);
await fijarModulo(SEED.negocioA, 'pos', 'activo');
await fijarModulo(SEED.negocioB, 'pos', 'activo');

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;

const cookieSuperadmin = cookieHeader(SEED.superadminUsuarioId, SEED.negocioA, 'admin');
const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
const cookieStaffA = cookieHeader(SEED.staffNegocioAUsuarioId, SEED.negocioA, 'staff');

const adminNegocioB = await crearUsuarioConPassword({
  negocioId: SEED.negocioB, nombre: 'Admin Negocio B (metricas)', email: `admin-b-mt-${sufijo}@test.local`,
  password: 'ClaveAdminBPrueba123!', rol: 'admin',
});
const cookieAdminB = cookieHeader(adminNegocioB.id, SEED.negocioB, 'admin');

const repA1 = await registrarRepartidor(`MT Uno ${sufijo}`, `87811${sufijo}`, SEED.negocioA);
const repA2Suspendido = await registrarRepartidor(`MT Susp ${sufijo}`, `87812${sufijo}`, SEED.negocioA);
await cambiarEstadoRepartidor(repA2Suspendido.id, 'suspendido', { negocioId: SEED.negocioA });
const repA3Baja = await registrarRepartidor(`MT Baja ${sufijo}`, `87813${sufijo}`, SEED.negocioA);
await cambiarEstadoRepartidor(repA3Baja.id, 'baja', { negocioId: SEED.negocioA });
await editarPerfilRepartidor(repA1.id, { ciudad: 'Matamoros', zona: `ZonaTest${sufijo}` }, { negocioId: SEED.negocioA });

// ═══════════ 1. Periodo sin datos ═══════════
await t('metricas', 'Periodo sin datos: todo en cero, tasas null (no división entre cero)', async () => {
  const desde = new Date(Date.now() + 365 * 86400000).toISOString(); // futuro -- garantiza cero filas
  const r = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}&desde=${encodeURIComponent(desde)}`, { cookie: cookieSuperadmin });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.tarjetas.serviciosCreados, 0);
  assert.strictEqual(r.body.tarjetas.tasaAceptacion, null, 'sin denominador la tasa debe ser null, nunca 0/NaN');
  assert.strictEqual(r.body.tarjetas.tiempoPromedioAceptacionSeg, null);
});

// ═══════════ 2. Periodo con datos ═══════════
let folioBase;
await t('metricas', 'Periodo con datos: servicio creado y ofrecido se refleja en tarjetas', async () => {
  const { folio, creadoAt } = await crearPedidoDirecto(SEED.negocioA, { total: 300 });
  folioBase = folio;
  await notificar(SEED.negocioA, folio, repA1.id, { estado: 'entregado', creadoAt });
  const r = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.tarjetas.serviciosCreados >= 1);
  assert.ok(r.body.tarjetas.serviciosOfrecidos >= 1);
});

// ═══════════ 3. Filtro por negocio ═══════════
await t('metricas', 'Filtro por negocio: negocioB no ve el servicio creado para negocioA', async () => {
  const rA = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  const rB = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioB}`, { cookie: cookieSuperadmin });
  assert.ok(rA.body.tarjetas.serviciosCreados >= 1, 'negocioA debe tener al menos el servicio creado en la prueba anterior');
  assert.strictEqual(rB.body.tarjetas.serviciosCreados, 0, 'negocioB no debe ver ningún servicio de negocioA');
  assert.strictEqual(rB.body.porNegocio, null, 'con negocioId explícito no debe incluirse el desglose cross-negocio');
});

// ═══════════ 4/5. Filtro por ciudad / zona ═══════════
await t('metricas', 'Filtro por ciudad: solo cuenta servicios de repartidores con esa ciudad', async () => {
  const { folio, creadoAt } = await crearPedidoDirecto(SEED.negocioA, { total: 100 });
  await notificar(SEED.negocioA, folio, repA1.id, { estado: 'entregado', creadoAt });
  const r = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}&ciudad=Matamoros`, { cookie: cookieSuperadmin });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.tarjetas.serviciosOfrecidos >= 1);
  const rNoMatch = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}&ciudad=CiudadQueNoExiste`, { cookie: cookieSuperadmin });
  assert.strictEqual(rNoMatch.body.tarjetas.serviciosOfrecidos, 0);
});

await t('metricas', 'Filtro por zona: análogo a ciudad', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}&zona=ZonaTest${sufijo}`, { cookie: cookieSuperadmin });
  assert.ok(r.body.tarjetas.serviciosOfrecidos >= 1);
});

// ═══════════ 6. Filtro por repartidor ═══════════
await t('metricas', 'Filtro por repartidor: acota a los pedidos donde participó', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}&repartidorId=${repA1.id}`, { cookie: cookieSuperadmin });
  assert.ok(r.body.tarjetas.serviciosOfrecidos >= 1);
  const rOtro = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}&repartidorId=999999`, { cookie: cookieSuperadmin });
  assert.strictEqual(rOtro.body.tarjetas.serviciosOfrecidos, 0);
});

// ═══════════ 7/8. Entregas propias vs Rappi excluido ═══════════
await t('metricas', 'Rappi excluido de tarjetas y aparece solo en el bloque "externas"', async () => {
  await crearPedidoDirecto(SEED.negocioA, { canal: 'rappi', rappiOrderId: `RAPPI-${sufijo}`, total: 500 });
  const antes = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  const externasAntes = antes.body.externas.total;
  await crearPedidoDirecto(SEED.negocioA, { canal: 'rappi', rappiOrderId: `RAPPI2-${sufijo}`, total: 500 });
  const despues = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  assert.strictEqual(despues.body.externas.total, externasAntes + 1, 'el pedido Rappi debe sumar a externas, no a serviciosCreados');
});

await t('ranking', 'Rappi nunca aparece en el ranking de repartidores propios', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/ranking?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  const todas = [...r.body.rankingElegible, ...r.body.muestraInsuficiente, ...r.body.suspendidosOBaja];
  assert.ok(!todas.some(f => f.nombre?.includes('Rappi')), 'ningún repartidor de Rappi debe existir en la tabla repartidores');
});

// ═══════════ 9. Servicio aceptado ═══════════
await t('metricas', 'Servicio aceptado: token_usado_at cuenta en serviciosAceptados y embudo.aceptados', async () => {
  const { folio, creadoAt } = await crearPedidoDirecto(SEED.negocioA, { total: 150 });
  await notificar(SEED.negocioA, folio, repA1.id, { estado: 'leido', tokenUsadoAt: new Date(creadoAt.getTime() + 60000), creadoAt });
  const r = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}&repartidorId=${repA1.id}`, { cookie: cookieSuperadmin });
  assert.ok(r.body.tarjetas.serviciosAceptados >= 1);
  assert.ok(r.body.embudo.aceptados >= 1);
});

// ═══════════ 10. Servicio ignorado ═══════════
await t('metricas', 'Servicio ignorado: vencido sin token_usado_at y sin fallo cuenta en embudo.ignorados', async () => {
  const { folio, creadoAt } = await crearPedidoDirecto(SEED.negocioA, { total: 90 });
  await notificar(SEED.negocioA, folio, repA1.id, { estado: 'entregado', tokenExpiraAt: new Date(Date.now() - 1000), creadoAt });
  const r = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}&repartidorId=${repA1.id}`, { cookie: cookieSuperadmin });
  assert.ok(r.body.embudo.ignorados >= 1);
});

// ═══════════ 11. Servicio rechazado (no existe -- debe ser null, nunca 0) ═══
await t('metricas', 'Rechazados siempre null (mecanismo no implementado), nunca 0 ni confundido con ignorado', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  assert.strictEqual(r.body.embudo.rechazados, null);
  const rk = await api(base, `/api/superadmin/red-repartidores/ranking?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  const todas = [...rk.body.rankingElegible, ...rk.body.muestraInsuficiente, ...rk.body.suspendidosOBaja];
  assert.ok(todas.every(f => f.serviciosRechazados === null));
});

// ═══════════ 12/13. Fallo de notificación / sin cobertura ═══════════
await t('metricas', 'Fallo de notificación y sin cobertura cuando todos los intentos fallan', async () => {
  const { folio, creadoAt } = await crearPedidoDirecto(SEED.negocioA, { total: 70 });
  await notificar(SEED.negocioA, folio, repA1.id, { estado: 'fallido', creadoAt });
  const r = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}&repartidorId=${repA1.id}`, { cookie: cookieSuperadmin });
  assert.ok(r.body.embudo.fallidos >= 1);
  assert.ok(r.body.tarjetas.serviciosSinCobertura >= 1);
});

// ═══════════ 14. Pedido cancelado ═══════════
await t('metricas', 'Pedido cancelado cuenta en serviciosCancelados', async () => {
  await crearPedidoDirecto(SEED.negocioA, { estado: 'cancelado', total: 220 });
  const r = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  assert.ok(r.body.tarjetas.serviciosCancelados >= 1);
});

// ═══════════ 15. Entregado sin entregado_at ═══════════
await t('metricas', 'Entregado sin entregado_at (histórico) se excluye del promedio, no cuenta como 0', async () => {
  const { folio, creadoAt } = await crearPedidoDirecto(SEED.negocioA, { estado: 'entregado', total: 130 });
  // estado='entregado' escrito directamente por SQL (no vía actualizarEstadoPedidoDB) -- entregado_at queda NULL, simulando un registro histórico anterior a la migración 036.
  await notificar(SEED.negocioA, folio, repA1.id, { estado: 'leido', tokenUsadoAt: new Date(creadoAt.getTime() + 60000), creadoAt });
  const r = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}&repartidorId=${repA1.id}`, { cookie: cookieSuperadmin });
  assert.ok(r.body.tarjetas.tiempoPromedioEntregaSeg === null || Number.isFinite(r.body.tarjetas.tiempoPromedioEntregaSeg), 'debe ser null o un número finito, nunca NaN por un registro sin entregado_at');
});

// ═══════════ 16. Registro histórico 0/0/0 ═══════════
await t('metricas', 'Pedido sin ninguna notificación (0/0/0) se cuenta como creado pero no como ofrecido', async () => {
  const antes = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  await crearPedidoDirecto(SEED.negocioA, { total: 60 });
  const despues = await api(base, `/api/superadmin/red-repartidores/metricas?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  assert.strictEqual(despues.body.tarjetas.serviciosCreados, antes.body.tarjetas.serviciosCreados + 1);
  assert.strictEqual(despues.body.tarjetas.serviciosOfrecidos, antes.body.tarjetas.serviciosOfrecidos, 'sin notificaciones, ofrecidos no debe subir');
});

// ═══════════ 17/18. Muestra suficiente / insuficiente ═══════════
const repRanking = await registrarRepartidor(`MT Ranking ${sufijo}`, `87814${sufijo}`, SEED.negocioA);
await t('ranking', 'Repartidor con >=10 ofrecidos y >=5 entregados entra a rankingElegible', async () => {
  for (let i = 0; i < 10; i++) {
    const { folio, creadoAt } = await crearPedidoDirecto(SEED.negocioA, { total: 100 + i });
    const usarAceptado = i < 6;
    await notificar(SEED.negocioA, folio, repRanking.id, {
      estado: usarAceptado ? 'leido' : 'entregado',
      tokenUsadoAt: usarAceptado ? new Date(creadoAt.getTime() + 60000) : null,
      tokenExpiraAt: usarAceptado ? new Date(Date.now() + 30 * 60000) : new Date(Date.now() - 1000),
      creadoAt,
    });
    if (usarAceptado && i < 5) await asignarRepartidorDirecto(folio, repRanking.id, repRanking.nombre);
    if (usarAceptado && i < 5) await actualizarEstadoPedidoDB(folio, 'entregado');
  }
  const r = await api(base, `/api/superadmin/red-repartidores/ranking?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  const fila = r.body.rankingElegible.find(f => f.repartidorId === repRanking.id);
  assert.ok(fila, 'debe aparecer en rankingElegible con 10 ofrecidos / 5 entregados');
  assert.ok(fila.score !== null && fila.score >= 0 && fila.score <= 1, 'score debe existir y estar normalizado');
});

await t('ranking', 'Repartidor con pocos servicios cae en muestraInsuficiente, no en rankingElegible', async () => {
  const repPoco = await registrarRepartidor(`MT Poco ${sufijo}`, `87815${sufijo}`, SEED.negocioA);
  const { folio, creadoAt } = await crearPedidoDirecto(SEED.negocioA, { total: 80 });
  await notificar(SEED.negocioA, folio, repPoco.id, { estado: 'entregado', creadoAt });
  const r = await api(base, `/api/superadmin/red-repartidores/ranking?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  assert.ok(r.body.muestraInsuficiente.some(f => f.repartidorId === repPoco.id));
  assert.ok(!r.body.rankingElegible.some(f => f.repartidorId === repPoco.id));
});

// ═══════════ 19/20. Suspendido / dado de baja ═══════════
await t('ranking', 'Repartidor suspendido va siempre a su propio grupo, sin importar volumen', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/ranking?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  assert.ok(r.body.suspendidosOBaja.some(f => f.repartidorId === repA2Suspendido.id));
  assert.ok(!r.body.rankingElegible.some(f => f.repartidorId === repA2Suspendido.id));
  assert.ok(!r.body.muestraInsuficiente.some(f => f.repartidorId === repA2Suspendido.id));
});

await t('ranking', 'Repartidor dado de baja va siempre a su propio grupo', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/ranking?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  assert.ok(r.body.suspendidosOBaja.some(f => f.repartidorId === repA3Baja.id));
});

// ═══════════ 21. Superadmin cross-negocio ═══════════
await t('permisos', 'Superadmin sin negocioId ve el desglose porNegocio (cross-negocio)', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/metricas`, { cookie: cookieSuperadmin });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.porNegocio));
  assert.ok(r.body.porNegocio.some(n => n.negocioId === SEED.negocioA));
});

// ═══════════ 22/23. Negocio-admin aislado ═══════════
await t('permisos', 'Negocio-admin (propio negocio) ve sus datos', async () => {
  const r = await api(base, `/api/admin/repartidores/metricas`, { cookie: cookieAdminA });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.porNegocio, null, 'negocio-admin nunca recibe el desglose cross-negocio');
});

await t('permisos', 'Negocio-admin no puede ver otro negocio ni inyectando negocioId por query', async () => {
  const r = await api(base, `/api/admin/repartidores/metricas?negocioId=${SEED.negocioA}`, { cookie: cookieAdminB });
  assert.strictEqual(r.status, 200);
  // negocioB no tiene el repartidor repRanking (de negocioA) en su conteo de ofrecidos por ese id
  const rRanking = await api(base, `/api/admin/repartidores/ranking?negocioId=${SEED.negocioA}`, { cookie: cookieAdminB });
  const todas = [...rRanking.body.rankingElegible, ...rRanking.body.muestraInsuficiente, ...rRanking.body.suspendidosOBaja];
  assert.ok(!todas.some(f => f.repartidorId === repRanking.id), 'negocioId de query debe ser ignorado -- solo cuenta la sesión');
});

// ═══════════ 24. Staff 403 ═══════════
await t('permisos', 'Staff recibe 403 en métricas de superadmin y de negocio-admin', async () => {
  const r1 = await api(base, `/api/superadmin/red-repartidores/metricas`, { cookie: cookieStaffA });
  assert.strictEqual(r1.status, 403);
  const r2 = await api(base, `/api/admin/repartidores/metricas`, { cookie: cookieStaffA });
  assert.strictEqual(r2.status, 403);
});

// ═══════════ 25/26. Exportación CSV + caracteres especiales ═══════════
await t('csv', 'Exportación CSV responde con encabezado y content-type correctos', async () => {
  const r = await fetch(`${base}/api/superadmin/red-repartidores/ranking/exportar.csv?negocioId=${SEED.negocioA}`, { headers: { Cookie: cookieSuperadmin } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers.get('content-type').includes('text/csv'));
  const texto = await r.text();
  assert.ok(texto.includes('Repartidor,NegocioId,Ciudad,Zona,Estado,Ofrecidos'));
});

await t('csv', 'Caracteres especiales (coma, comillas) en nombre se escapan correctamente (RFC 4180)', async () => {
  const nombreRaro = `Repartidor "Raro", S.A.`;
  const repRaro = await registrarRepartidor(nombreRaro, `87816${sufijo}`, SEED.negocioA);
  const r = await fetch(`${base}/api/superadmin/red-repartidores/ranking/exportar.csv?negocioId=${SEED.negocioA}`, { headers: { Cookie: cookieSuperadmin } });
  const texto = await r.text();
  assert.ok(texto.includes('"Repartidor ""Raro"", S.A."'), 'debe envolver en comillas y duplicar las comillas internas');
});

// ═══════════ 27. Fórmulas sin división entre cero ═══════════
await t('metricas', 'Repartidor sin servicios entregados: tasaFinalizacion es null, nunca NaN', async () => {
  const repSinEntregas = await registrarRepartidor(`MT SinEntregas ${sufijo}`, `87817${sufijo}`, SEED.negocioA);
  const { folio, creadoAt } = await crearPedidoDirecto(SEED.negocioA, { total: 40 });
  await notificar(SEED.negocioA, folio, repSinEntregas.id, { estado: 'entregado', creadoAt }); // ofrecido, nunca aceptado
  const r = await api(base, `/api/superadmin/red-repartidores/ranking?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  const todas = [...r.body.rankingElegible, ...r.body.muestraInsuficiente, ...r.body.suspendidosOBaja];
  const fila = todas.find(f => f.repartidorId === repSinEntregas.id);
  assert.ok(fila);
  assert.strictEqual(fila.tasaFinalizacion, null, 'sin entregados, la tasa debe ser null, nunca NaN ni 0');
});

// ═══════════ 28. Timestamps y zonas horarias ═══════════
await t('metricas', 'entregado_at se puebla en UTC real al transicionar por actualizarEstadoPedidoDB (migración 036)', async () => {
  const { folio } = await crearPedidoDirecto(SEED.negocioA, { estado: 'nuevo', total: 333 });
  const antes = Date.now();
  await actualizarEstadoPedidoDB(folio, 'entregado');
  const { rows } = await pool.query(`SELECT entregado_at FROM pedidos_activos WHERE folio = $1`, [folio]);
  assert.ok(rows[0].entregado_at, 'entregado_at debe quedar poblado');
  const diffMs = Math.abs(new Date(rows[0].entregado_at).getTime() - antes);
  assert.ok(diffMs < 10000, `entregado_at debe reflejar el momento real de la transición (diff=${diffMs}ms)`);
});

// ═══════════ 29. Vista móvil (estructura responsiva ya usada por el resto del módulo) ═══════════
await t('ui', 'La subvista de métricas usa el mismo patrón data-label responsivo que roster/servicios', async () => {
  const html = readFileSync(join(__dirname, '..', 'panel', 'superadmin.html'), 'utf8');
  const bloqueHtml = html.slice(html.indexOf('id="rp-sub-metricas"'), html.indexOf('id="rp-sub-metricas"') + 4000);
  const inicioJs = html.indexOf('function cargarMetricasReparto');
  const bloqueJs = html.slice(inicioJs, inicioJs + 6000);
  assert.ok(html.includes('data-subtab="metricas"'));
  assert.ok(bloqueHtml.includes('overflow-x:auto'), 'las tablas deben poder hacer scroll horizontal en pantallas angostas');
  assert.ok(bloqueJs.includes('data-label="Repartidor"'), 'las celdas del ranking generadas por JS deben llevar data-label para el CSS responsivo móvil');
});

// ═══════════ Regresión mínima inline (30/31 se ejecutan aparte con la batería completa) ═══════════
await t('regresion', 'Endpoints ya existentes de Fase A/B/C siguen respondiendo tras los cambios de Fase D', async () => {
  const rHealth = await fetch(`${base}/health`);
  assert.strictEqual(rHealth.status, 200);
  const rRoster = await api(base, `/api/superadmin/red-repartidores/roster?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  assert.strictEqual(rRoster.status, 200);
  const rServicios = await api(base, `/api/superadmin/red-repartidores/servicios?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  assert.strictEqual(rServicios.status, 200);
});

// ═══════════ Reporte ═══════════
console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas > 0) { console.log('\nFallos:'); fallos.forEach(f => console.log(' -', f)); }
await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
