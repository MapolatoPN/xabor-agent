// Portal operativo del repartidor (restauración). Cubre: registro con
// negocio obligatorio (causa raíz de la regresión), sesión por token,
// pedido actual con detalle completo SOLO del asignado, sub-estados
// recogido/en_camino, entregado atómico e idempotente, historial paginado
// con privacidad reducida, incidencias, y aislamiento total (otro
// repartidor / otro negocio / token inválido / suspendido).
//
// Uso: mismas env vars que la batería; requiere migraciones + seed.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4191';

const { pool, guardarPedidoActivo } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// ═══════════ Setup ═══════════
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}
await fijarModulo(SEED.negocioA, 'pos', 'activo');
const { rows: [negA] } = await pool.query(`SELECT slug FROM negocios WHERE id = $1`, [SEED.negocioA]);
const SLUG_A = negA.slug;

await pool.query(`DELETE FROM notificaciones_repartidor WHERE repartidor_id IN (SELECT id FROM repartidores WHERE telefono LIKE '52187811%')`);
await pool.query(`DELETE FROM repartidores WHERE telefono LIKE '52187811%'`);

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;

async function api(path, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-rep-token'] = token;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

let folioSeq = 9400;
async function pedidoDomicilio(negocioId, { telefono = '5218789990001', total = 200 } = {}) {
  const folio = `XAB-${folioSeq++}`;
  await guardarPedidoActivo({
    id: folio, negocioId, canal: 'whatsapp', estado: 'nuevo',
    modalidad: 'entrega a domicilio', forma_pago: 'efectivo', total,
    cliente: { nombre: 'Cliente <b>Portal</b>', telefono, calle: 'Calle Prueba 123', colonia: 'Colonia "XSS" <script>', entre_calles: 'A y B', referencia: 'Portón negro' },
    items: [{ nombre: 'Combo', cantidad: 1, precio_unitario: total }],
    notas: 'sin picante',
    timestamp: new Date().toISOString(),
  }, negocioId);
  return folio;
}

// ═══════════ Registro y sesión ═══════════
let tokenA = null, tokenB = null, repAId = null;
await t('REGISTRO', 'sin negocio -> 400 con mensaje claro (la causa raíz del portal roto queda cerrada)', async () => {
  const r = await api('/api/repartidor/registro', { method: 'POST', body: { nombre: 'Rep Sin Negocio', telefono: '5218781100001' } });
  assert.strictEqual(r.status, 400);
  assert.ok(r.body.error.includes('negocio'), 'el error explica que falta el negocio');
});

await t('REGISTRO', 'con slug del negocio -> alta ligada al negocio; login devuelve token y negocio', async () => {
  const r = await api('/api/repartidor/registro', { method: 'POST', body: { nombre: 'Rep Portal A', telefono: '5218781100002', negocioSlug: SLUG_A } });
  assert.strictEqual(r.status, 200);
  tokenA = r.body.token;
  const { rows: [rep] } = await pool.query(`SELECT id, negocio_id FROM repartidores WHERE token = $1`, [tokenA]);
  repAId = rep.id;
  assert.strictEqual(rep.negocio_id, SEED.negocioA, 'el alta queda ligada al negocio del slug');
  const login = await api('/api/repartidor/login', { method: 'POST', body: { telefono: '5218781100002' } });
  assert.strictEqual(login.status, 200);
  assert.ok(login.body.negocio, 'el login incluye el nombre del negocio');
  const me = await api('/api/repartidor/me', { token: tokenA });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.nombre, 'Rep Portal A');
});

await t('SESION', 'token inválido 401; repartidor suspendido (activo=false) 401', async () => {
  assert.strictEqual((await api('/api/repartidor/me', { token: 'token-falso' })).status, 401);
  const r = await api('/api/repartidor/registro', { method: 'POST', body: { nombre: 'Rep Suspendido', telefono: '5218781100003', negocioSlug: SLUG_A } });
  const tokenSusp = r.body.token;
  await pool.query(`UPDATE repartidores SET activo = FALSE WHERE token = $1`, [tokenSusp]);
  assert.strictEqual((await api('/api/repartidor/me', { token: tokenSusp })).status, 401, 'suspendido/baja no entra');
});

// Repartidor B en negocio B para aislamiento.
const { rows: [negB] } = await pool.query(`SELECT slug FROM negocios WHERE id = $1`, [SEED.negocioB]);
{
  const r = await api('/api/repartidor/registro', { method: 'POST', body: { nombre: 'Rep Portal B', telefono: '5218781100004', negocioSlug: negB.slug } });
  tokenB = r.body.token;
}

// ═══════════ Pedido actual + aceptación ═══════════
let folio1 = null;
await t('ACTUAL', 'sin pedido asignado: lista vacía; tras aceptar aparece con detalle COMPLETO y entrega_estado=asignado', async () => {
  const antes = await api('/api/repartidor/pedido-actual', { token: tokenA });
  assert.strictEqual(antes.status, 200);
  assert.strictEqual(antes.body.pedidos.length, 0);
  folio1 = await pedidoDomicilio(SEED.negocioA);
  const acc = await api(`/api/repartidor/pedido/${folio1}/aceptar`, { token: tokenA, method: 'POST' });
  assert.strictEqual(acc.status, 200);
  const r = await api('/api/repartidor/pedido-actual', { token: tokenA });
  assert.strictEqual(r.body.pedidos.length, 1);
  const p = r.body.pedidos[0];
  assert.strictEqual(p.folio, folio1);
  assert.strictEqual(p.entregaEstado, 'asignado', 'asignarRepartidor sella el sub-estado');
  assert.strictEqual(p.calle, 'Calle Prueba 123', 'dirección completa para el asignado');
  assert.strictEqual(p.entreCalles, 'A y B');
  assert.strictEqual(p.referencia, 'Portón negro');
  assert.ok(p.telefono, 'teléfono visible durante el pedido activo');
  assert.ok(r.body.negocio?.nombre, 'nombre del negocio de recogida presente');
});

await t('AISLAMIENTO', 'el pedido de A es invisible e intocable para el repartidor B (otro negocio)', async () => {
  const r = await api('/api/repartidor/pedido-actual', { token: tokenB });
  assert.strictEqual(r.body.pedidos.length, 0);
  for (const accion of ['recogido', 'en-camino', 'entregado']) {
    const rr = await api(`/api/repartidor/pedido/${folio1}/${accion}`, { token: tokenB, method: 'POST' });
    assert.ok([403, 404, 409].includes(rr.status), `${accion} de otro negocio jamás procede (dio ${rr.status})`);
  }
  const { rows: [ped] } = await pool.query(`SELECT estado, datos->>'entrega_estado' AS ee FROM pedidos_activos WHERE folio = $1`, [folio1]);
  assert.strictEqual(ped.estado, 'nuevo');
  assert.strictEqual(ped.ee, 'asignado', 'nada cambió por los intentos ajenos');
});

await t('ESTADOS', 'recogido -> en_camino con timestamps; repetir la transición es idempotente (timestamp original intacto)', async () => {
  const r1 = await api(`/api/repartidor/pedido/${folio1}/recogido`, { token: tokenA, method: 'POST' });
  assert.strictEqual(r1.status, 200);
  const { rows: [a] } = await pool.query(`SELECT datos->>'recogido_at' AS ts FROM pedidos_activos WHERE folio = $1`, [folio1]);
  assert.ok(a.ts, 'recogido_at registrado');
  await api(`/api/repartidor/pedido/${folio1}/recogido`, { token: tokenA, method: 'POST' });
  const { rows: [b] } = await pool.query(`SELECT datos->>'recogido_at' AS ts FROM pedidos_activos WHERE folio = $1`, [folio1]);
  assert.strictEqual(b.ts, a.ts, 'repetir recogido no pisa el timestamp');
  const r2 = await api(`/api/repartidor/pedido/${folio1}/en-camino`, { token: tokenA, method: 'POST' });
  assert.strictEqual(r2.status, 200);
  const actual = await api('/api/repartidor/pedido-actual', { token: tokenA });
  assert.strictEqual(actual.body.pedidos[0].entregaEstado, 'en_camino');
});

await t('INCIDENCIA', 'reportar problema queda auditado en el pedido, avisa y JAMÁS cambia el estado', async () => {
  const r = await api(`/api/repartidor/pedido/${folio1}/incidencia`, { token: tokenA, method: 'POST', body: { tipo: 'cliente_no_responde', detalle: 'Llamé dos veces' } });
  assert.strictEqual(r.status, 200);
  const mal = await api(`/api/repartidor/pedido/${folio1}/incidencia`, { token: tokenA, method: 'POST', body: { tipo: 'tipo-inventado' } });
  assert.strictEqual(mal.status, 400);
  const { rows: [ped] } = await pool.query(`SELECT estado, datos->'incidencias' AS inc, datos->>'entrega_estado' AS ee FROM pedidos_activos WHERE folio = $1`, [folio1]);
  assert.strictEqual(ped.estado, 'nuevo', 'la incidencia no cambia el estado del pedido');
  assert.strictEqual(ped.ee, 'en_camino');
  assert.strictEqual(ped.inc.length, 1);
  assert.strictEqual(ped.inc[0].tipo, 'cliente_no_responde');
  assert.strictEqual(ped.inc[0].detalle, 'Llamé dos veces');
});

await t('ENTREGADO', 'atómico con dueño; doble clic idempotente; el pedido sale de actual y entra al historial UNA vez', async () => {
  const r1 = await api(`/api/repartidor/pedido/${folio1}/entregado`, { token: tokenA, method: 'POST' });
  assert.strictEqual(r1.status, 200);
  const r2 = await api(`/api/repartidor/pedido/${folio1}/entregado`, { token: tokenA, method: 'POST' });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.body.ya, true, 'el segundo clic es idempotente, jamás error ni doble registro');
  const { rows: [ped] } = await pool.query(`SELECT estado, entregado_at, datos->>'entrega_estado' AS ee FROM pedidos_activos WHERE folio = $1`, [folio1]);
  assert.strictEqual(ped.estado, 'entregado');
  assert.ok(ped.entregado_at, 'entregado_at fijado (alimenta métricas D.1)');
  assert.strictEqual(ped.ee, 'entregado');
  const actual = await api('/api/repartidor/pedido-actual', { token: tokenA });
  assert.strictEqual(actual.body.pedidos.length, 0, 'ya no es pedido actual');
  const hist = await api('/api/repartidor/entregas?rango=hoy&estado=todos&pagina=1', { token: tokenA });
  assert.strictEqual(hist.body.entregas.filter(e => e.folio === folio1).length, 1, 'aparece UNA vez en historial');
});

await t('ENTREGADO', 'un pedido cancelado jamás se entrega; el portal informa la cancelación', async () => {
  const folio = await pedidoDomicilio(SEED.negocioA);
  await api(`/api/repartidor/pedido/${folio}/aceptar`, { token: tokenA, method: 'POST' });
  await pool.query(`UPDATE pedidos_activos SET estado = 'cancelado', datos = jsonb_set(datos, '{cancelacion}', '{"motivo":"negocio cerró"}') WHERE folio = $1`, [folio]);
  const r = await api(`/api/repartidor/pedido/${folio}/entregado`, { token: tokenA, method: 'POST' });
  assert.strictEqual(r.status, 409);
  assert.ok(r.body.error.includes('cancelado'));
  const hist = await api('/api/repartidor/entregas?rango=hoy&estado=cancelados&pagina=1', { token: tokenA });
  assert.ok(hist.body.entregas.some(e => e.folio === folio), 'el cancelado queda en el historial como cancelado');
});

// ═══════════ Historial: privacidad y paginación ═══════════
await t('HISTORIAL', 'privacidad: sin teléfono, sin calle/número/referencias — solo colonia/folio/tiempos/pago/estado', async () => {
  const r = await api('/api/repartidor/entregas?rango=hoy&estado=todos&pagina=1', { token: tokenA });
  const crudo = JSON.stringify(r.body);
  assert.ok(!crudo.includes('5218789990001'), 'sin teléfono del cliente');
  assert.ok(!crudo.includes('Calle Prueba 123'), 'sin calle/número');
  assert.ok(!crudo.includes('Portón negro'), 'sin referencias');
  assert.ok(r.body.entregas[0].colonia, 'colonia sí (zona operativa)');
});

await t('HISTORIAL', 'paginación real: 25 entregas -> página 1 con 20, página 2 con el resto; solo entregas PROPIAS', async () => {
  for (let i = 0; i < 24; i++) {
    const f = await pedidoDomicilio(SEED.negocioA);
    await api(`/api/repartidor/pedido/${f}/aceptar`, { token: tokenA, method: 'POST' });
    await api(`/api/repartidor/pedido/${f}/entregado`, { token: tokenA, method: 'POST' });
  }
  const p1 = await api('/api/repartidor/entregas?rango=hoy&estado=entregados&pagina=1', { token: tokenA });
  const p2 = await api('/api/repartidor/entregas?rango=hoy&estado=entregados&pagina=2', { token: tokenA });
  assert.strictEqual(p1.body.entregas.length, 20, 'límite duro por página');
  assert.ok(p2.body.entregas.length >= 5, 'el resto en la página 2');
  assert.ok(p1.body.total >= 25);
  const histB = await api('/api/repartidor/entregas?rango=hoy&estado=todos&pagina=1', { token: tokenB });
  assert.strictEqual(histB.body.total, 0, 'el repartidor B no ve nada del A');
});

// ═══════════ Contrato del frontend (XSS + elementos móviles) ═══════════
await t('FRONTEND', 'el portal escapa TODO dato del pedido y trae ruta/confirmación/tabs (contrato del HTML)', async () => {
  const html = readFileSync(join(__dirname, '..', 'panel', 'repartidor.html'), 'utf8');
  assert.ok(html.includes("const esc = s =>"), 'helper de escape presente');
  for (const campo of ['esc(p.cliente', 'esc([p.calle, p.colonia]', 'esc(p.entreCalles)', 'esc(p.referencia)', 'esc(p.notas)', 'esc(e.colonia']) {
    assert.ok(html.includes(campo), `campo escapado: ${campo}`);
  }
  assert.ok(html.includes('Abrir ruta'), 'botón de ruta con texto claro');
  assert.ok(html.includes('google.com/maps/dir/?api=1&destination='), 'URL de mapas segura');
  assert.ok(html.includes('encodeURIComponent'), 'dirección escapada en la URL');
  assert.ok(html.includes('p.lat') && html.includes('p.lng'), 'coordenadas con prioridad si existen');
  assert.ok(html.includes('dlg-entregar'), 'confirmación antes de entregar');
  assert.ok(html.includes('negocioSlug'), 'registro con negocio');
  assert.ok(html.includes('setInterval(refrescarTodo, 25000)'), 'polling moderado (no cada segundo)');
  assert.ok(!html.includes('new WebSocket'), 'ya no depende del WS raíz eliminado');
  assert.ok(html.includes('tel:'), 'teléfono clicable');
});

// Limpieza: las entregas ficticias de esta suite (folios XAB-94xx)
// inflarían las tasas de la suite de métricas/universos que comparte la
// misma base -- se retiran para dejar el terreno neutro.
await pool.query(`DELETE FROM pedidos_activos WHERE folio LIKE 'XAB-94%'`);

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(` - ${f}`)); }
await srv.detener();
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
