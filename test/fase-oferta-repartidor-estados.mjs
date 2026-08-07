// Hotfix oferta-repartidor: primer mensaje con dirección parcial segura,
// pantalla del enlace con estados reales (disponible / asignado_a_mi /
// cubierto_por_otro / cancelado / expirado / completado / invalido) y
// carrera de aceptación intacta (backend como única fuente de verdad).
//
// Uso: mismas env vars que la batería. Requiere aplicar-migraciones.mjs y
// seed-datos-prueba.mjs ya corridos sobre el mismo DATABASE_URL.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { formatearEntregaOferta } from '../src/utils/direccionRepartidor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4187';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, actualizarConfiguracion, obtenerNotificacionesPedido } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const esperar = ms => new Promise(r => setTimeout(r, ms));
async function esperarHasta(fn, { timeoutMs = 8000, intervaloMs = 200 } = {}) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const r = await fn();
    if (r) return r;
    await esperar(intervaloMs);
  }
  return null;
}

// ═══════════ Formato puro de la línea "Entrega en" ═══════════
await t('FORMATO', 'colonia+calle, solo colonia, solo calle, ninguna — formatos exactos sin basura', () => {
  assert.strictEqual(formatearEntregaOferta('Carranza', 'Año 2000'), 'Col. Año 2000, calle Carranza');
  assert.strictEqual(formatearEntregaOferta('', 'Año 2000'), 'Col. Año 2000');
  assert.strictEqual(formatearEntregaOferta('Carranza', ''), 'Calle Carranza');
  assert.strictEqual(formatearEntregaOferta(null, undefined), 'Zona por confirmar');
  assert.strictEqual(formatearEntregaOferta('   ', '  '), 'Zona por confirmar');
  // Nunca literales técnicos ni comas duplicadas ni Col. Col.
  assert.strictEqual(formatearEntregaOferta('Carranza', 'Col. Año 2000'), 'Col. Año 2000, calle Carranza');
  for (const salida of [formatearEntregaOferta(undefined, null), formatearEntregaOferta('x', null)]) {
    assert.ok(!/undefined|null|,,/.test(salida), `sin basura: ${salida}`);
  }
});

await t('FORMATO', 'el número exterior se recorta de la calle; los nombres con número sobreviven', () => {
  assert.strictEqual(formatearEntregaOferta('Av. Tecnológico 123', 'Centro'), 'Col. Centro, calle Av. Tecnológico');
  assert.strictEqual(formatearEntregaOferta('Carranza #245', 'Año 2000'), 'Col. Año 2000, calle Carranza');
  assert.strictEqual(formatearEntregaOferta('Morelos No. 12 int 3', ''), 'Calle Morelos');
  // "5 de Mayo" no termina en número: intacta. "Calle 21" no se vacía.
  assert.strictEqual(formatearEntregaOferta('5 de Mayo', ''), 'Calle 5 de Mayo');
  assert.ok(formatearEntregaOferta('21', '').length > 0);
});

// ═══════════ Setup del servidor ═══════════
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}
await fijarModulo(SEED.negocioA, 'pos', 'activo');
await actualizarConfiguracion({ int_wa_phone_id: 'PNID_OFERTA_A', int_wa_token: 'fake-token-oferta-a' }, SEED.negocioA);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,'Oferta A',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [SEED.negocioA, 'PNID_OFERTA_A']);
// Plantilla activa + lista blanca con DOS repartidores (para la carrera).
await actualizarConfiguracion({
  repartidor_notif_plantilla_activo: 'true',
  repartidor_notif_piloto_telefonos: '5210000900004,5210000900005',
}, SEED.negocioA);

await pool.query(`DELETE FROM notificaciones_repartidor WHERE repartidor_id IN (SELECT id FROM repartidores WHERE telefono IN ('5210000900004','5210000900005'))`);
await pool.query(`DELETE FROM repartidores WHERE telefono IN ('5210000900004','5210000900005')`);
const { rows: [rep1] } = await pool.query(
  `INSERT INTO repartidores (nombre, telefono, token, activo, negocio_id) VALUES ('Juan Pérez Oferta','5210000900004','tok-oferta-1',TRUE,$1) RETURNING *`,
  [SEED.negocioA]
);
const { rows: [rep2] } = await pool.query(
  `INSERT INTO repartidores (nombre, telefono, token, activo, negocio_id) VALUES ('Luis Gómez Oferta','5210000900005','tok-oferta-2',TRUE,$1) RETURNING *`,
  [SEED.negocioA]
);

const metaMock = await arrancarMetaMock();
const srv = await arrancarServidor({ PORT: PUERTO, META_GRAPH_BASE_URL: metaMock.baseUrl }, { timeoutMs: 30000 });
const base = srv.base;
const cookieAdminA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: SEED.negocioA, rol: 'admin' }))}`;

async function crearPedidoPrueba() {
  const r = await fetch(base + '/test/pedido', { method: 'POST', headers: { Cookie: cookieAdminA } });
  assert.strictEqual(r.status, 200);
  return (await r.json()).pedido.id;
}
async function tokensDe(folio) {
  return esperarHasta(async () => {
    const filas = await obtenerNotificacionesPedido(folio, SEED.negocioA);
    const t1 = filas.find(f => f.repartidor_id === rep1.id && f.token_aceptacion);
    const t2 = filas.find(f => f.repartidor_id === rep2.id && f.token_aceptacion);
    return (t1 && t2) ? { t1: t1.token_aceptacion, t2: t2.token_aceptacion } : null;
  });
}
const consultar = async token => {
  const r = await fetch(`${base}/api/repartidor/oferta/${token}`);
  return { status: r.status, body: await r.json() };
};
const aceptar = async token => {
  const r = await fetch(`${base}/api/repartidor/oferta/${token}/aceptar`, { method: 'POST' });
  return { status: r.status, body: await r.json() };
};

// ═══════════ Pantalla: disponible + sin datos privados + sin consumo ═══════════
await t('DISPONIBLE', 'la consulta muestra negocio, colonia/calle SIN número, pago — y jamás datos del cliente ni consume el token', async () => {
  const folio = await crearPedidoPrueba();
  const { t1 } = await tokensDe(folio) || {};
  assert.ok(t1, 'debía existir token para rep1');
  const { status, body } = await consultar(t1);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.estado, 'disponible');
  assert.strictEqual(body.oferta.entregaEn, 'Col. Centro, calle Av. Tecnológico', 'sin el número 123');
  assert.ok(body.oferta.negocio && body.oferta.negocio !== 'null');
  assert.strictEqual(body.oferta.pago, '$544.00 MXN');
  const crudo = JSON.stringify(body);
  assert.ok(!crudo.includes('Cliente Prueba'), 'sin nombre del cliente antes de aceptar');
  assert.ok(!crudo.includes('8781234567'), 'sin teléfono del cliente');
  assert.ok(!body.oferta.entregaEn.includes('123'), 'sin número exterior');
  assert.ok(!crudo.includes('Juárez y Morelos'), 'sin referencias');
  // Recargas y multi-dispositivo: la consulta nunca consume el token.
  await consultar(t1); await consultar(t1);
  const { rows: [nr] } = await pool.query(`SELECT token_usado_at FROM notificaciones_repartidor WHERE token_aceptacion = $1`, [t1]);
  assert.strictEqual(nr.token_usado_at, null, 'consultar jamás consume');
  // La página HTML del enlace carga (contrato del botón).
  const pagina = await fetch(`${base}/repartidor/aceptar/${t1}`);
  assert.strictEqual(pagina.status, 200);
  const html = await pagina.text();
  assert.ok(html.includes('Aceptar pedido') && html.includes('/api/repartidor/oferta/'));
});

// ═══════════ Carrera: dos repartidores, un ganador, perdedor con nombre ═══════════
await t('CARRERA', 'aceptación simultánea: uno gana (asignado_a_mi), el otro ve cubierto_por_otro con el NOMBRE del ganador', async () => {
  const folio = await crearPedidoPrueba();
  const { t1, t2 } = await tokensDe(folio) || {};
  assert.ok(t1 && t2, 'ambos repartidores debían tener token');
  // Ambos ven disponible primero.
  assert.strictEqual((await consultar(t1)).body.estado, 'disponible');
  assert.strictEqual((await consultar(t2)).body.estado, 'disponible');
  // Ambos presionan aceptar A LA VEZ.
  const [r1, r2] = await Promise.all([aceptar(t1), aceptar(t2)]);
  const ganadores = [r1, r2].filter(r => r.status === 200 && r.body.estado === 'asignado_a_mi');
  const perdedores = [r1, r2].filter(r => r.status === 409);
  assert.strictEqual(ganadores.length, 1, 'exactamente un ganador');
  assert.strictEqual(perdedores.length, 1, 'exactamente un perdedor');
  assert.strictEqual(perdedores[0].body.estado, 'cubierto_por_otro');
  const nombreGanadorEsperado = (ganadores[0] === r1) ? rep1.nombre : rep2.nombre;
  assert.strictEqual(perdedores[0].body.repartidorAsignado.nombre, nombreGanadorEsperado, 'el perdedor ve el nombre real del ganador');
  // El perdedor NUNCA recibe teléfono/ids/uuid del ganador.
  const crudoPerdedor = JSON.stringify(perdedores[0].body);
  assert.ok(!crudoPerdedor.includes('521000090000'), 'sin teléfono del ganador');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(crudoPerdedor), 'sin UUIDs');
  // Una sola asignación en DB, sin sobrescritura.
  const { rows: [ped] } = await pool.query(`SELECT datos->>'repartidor_id' AS rid, datos->>'repartidor_nombre' AS rnombre FROM pedidos_activos WHERE folio = $1`, [folio]);
  const idGanador = (ganadores[0] === r1) ? rep1.id : rep2.id;
  assert.strictEqual(ped.rid, String(idGanador));
  assert.strictEqual(ped.rnombre, nombreGanadorEsperado);
  // Recargar/otro dispositivo conserva el resultado en AMBOS lados.
  const tGanador = (ganadores[0] === r1) ? t1 : t2;
  const tPerdedor = (ganadores[0] === r1) ? t2 : t1;
  assert.strictEqual((await consultar(tGanador)).body.estado, 'asignado_a_mi');
  const recarga = await consultar(tPerdedor);
  assert.strictEqual(recarga.body.estado, 'cubierto_por_otro');
  assert.strictEqual(recarga.body.repartidorAsignado.nombre, nombreGanadorEsperado);
  // El ganador SÍ ve el detalle completo (ya ganó): dirección y contacto.
  const detalle = (await consultar(tGanador)).body.pedido;
  assert.ok(detalle.direccion.includes('Av. Tecnológico 123'), 'dirección completa solo tras ganar');
  assert.strictEqual(detalle.telefonoCliente, '8781234567');
});

await t('CARRERA', 'histórico sin nombre legible: el perdedor recibe repartidorAsignado null (la UI dice "Asignado a otro repartidor"), jamás un UUID', async () => {
  const folio = await crearPedidoPrueba();
  const { t1, t2 } = await tokensDe(folio) || {};
  await aceptar(t1);
  // Integridad histórica simulada: quedó repartidor_id pero sin nombre.
  await pool.query(`UPDATE pedidos_activos SET datos = datos - 'repartidor_nombre' WHERE folio = $1`, [folio]);
  const { body } = await consultar(t2);
  assert.strictEqual(body.estado, 'cubierto_por_otro');
  assert.strictEqual(body.repartidorAsignado, null);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(JSON.stringify(body)), 'sin UUID filtrado');
});

// ═══════════ Estados restantes ═══════════
await t('ESTADOS', 'cancelado, completado, expirado e inválido responden su estado exacto', async () => {
  // Cancelado.
  const folioC = await crearPedidoPrueba();
  const { t1: tc } = await tokensDe(folioC) || {};
  await pool.query(`UPDATE pedidos_activos SET estado = 'cancelado' WHERE folio = $1`, [folioC]);
  assert.strictEqual((await consultar(tc)).body.estado, 'cancelado');
  // Completado (entregado sin repartidor: lo entregó el negocio).
  const folioE = await crearPedidoPrueba();
  const { t1: te } = await tokensDe(folioE) || {};
  await pool.query(`UPDATE pedidos_activos SET estado = 'entregado' WHERE folio = $1`, [folioE]);
  assert.strictEqual((await consultar(te)).body.estado, 'completado');
  // Expirado.
  const folioX = await crearPedidoPrueba();
  const { t1: tx } = await tokensDe(folioX) || {};
  await pool.query(`UPDATE notificaciones_repartidor SET token_expira_at = NOW() - INTERVAL '1 minute' WHERE token_aceptacion = $1`, [tx]);
  assert.strictEqual((await consultar(tx)).body.estado, 'expirado');
  const rechazo = await aceptar(tx);
  assert.strictEqual(rechazo.status, 409);
  assert.strictEqual(rechazo.body.estado, 'expirado');
  // Inválido.
  assert.strictEqual((await consultar('token-que-no-existe')).body.estado, 'invalido');
});

await t('ESTADOS', 'el ganador de un pedido ya entregado ve "completado"; la asignación manda sobre el vencimiento del token', async () => {
  const folio = await crearPedidoPrueba();
  const { t1 } = await tokensDe(folio) || {};
  await aceptar(t1);
  // El token vence después de ganar: su pantalla se conserva.
  await pool.query(`UPDATE notificaciones_repartidor SET token_expira_at = NOW() - INTERVAL '1 minute' WHERE token_aceptacion = $1`, [t1]);
  assert.strictEqual((await consultar(t1)).body.estado, 'asignado_a_mi', 'ganó: el vencimiento del token no lo borra');
  await pool.query(`UPDATE pedidos_activos SET estado = 'entregado' WHERE folio = $1`, [folio]);
  assert.strictEqual((await consultar(t1)).body.estado, 'completado');
});

// ═══════════ Primer mensaje (modo texto libre) ═══════════
await t('MENSAJE', 'el mensaje libre lleva negocio + Col./calle sin número + pago + regla del primero — y CERO datos del cliente', async () => {
  // Modo apagado = texto libre (comportamiento base sin plantilla).
  await actualizarConfiguracion({ repartidor_notif_plantilla_activo: 'false', repartidor_notif_modo: 'apagado' }, SEED.negocioA);
  metaMock.limpiarMensajes?.();
  const antes = metaMock.obtenerMensajesEnviados().length;
  await crearPedidoPrueba();
  const nuevos = await esperarHasta(async () => {
    const m = metaMock.obtenerMensajesEnviados().slice(antes).filter(x => x.text?.body);
    return m.length ? m : null;
  });
  assert.ok(nuevos && nuevos.length, 'debía enviarse el mensaje libre');
  const cuerpo = nuevos[nuevos.length - 1].text.body;
  assert.ok(cuerpo.includes('NUEVO PEDIDO DISPONIBLE'), 'encabezado nuevo');
  assert.ok(cuerpo.includes('Recoge en:'), 'negocio de recolección');
  assert.ok(cuerpo.includes('Entrega en: Col. Centro, calle Av. Tecnológico'), 'colonia y calle sin número');
  assert.ok(cuerpo.includes('Pago por entrega: $544.00 MXN'), 'pago disponible');
  assert.ok(cuerpo.includes('primer repartidor que lo acepte'), 'regla de asignación explícita');
  assert.ok(!cuerpo.includes('Cliente Prueba'), 'sin nombre del cliente');
  assert.ok(!cuerpo.includes('8781234567'), 'sin teléfono del cliente');
  assert.ok(!cuerpo.includes('123'), 'sin número exterior');
  assert.ok(!cuerpo.includes('Juárez y Morelos'), 'sin referencias');
  assert.ok(!/undefined|null/.test(cuerpo), 'sin basura técnica');
  // Restaurar plantilla para no contaminar otras suites de esta corrida.
  await actualizarConfiguracion({ repartidor_notif_plantilla_activo: 'true', repartidor_notif_modo: 'piloto' }, SEED.negocioA);
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(` - ${f}`)); }
await srv.detener();
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
