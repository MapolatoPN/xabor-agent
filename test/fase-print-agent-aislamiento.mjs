// /ws/print-agent sin autenticar NO recibe nada, y un Edge autenticado recibe
// solo lo de su negocio, su sucursal y su terminal, con el servidor REAL.
//
// Hasta el 27-sep-2026 existía broadcast(): recorría TODOS los sockets sin
// mirar su clase. Cualquiera que abriera /ws/print-agent (sin credencial: la
// conexión vive 5 s esperando autenticarse) recibía el folio que un
// repartidor marcaba entregado y los eventos del webhook de Rappi, que no
// exige firma, de todos los negocios. También los Edge autenticados, los
// paneles de otros negocios y Superadmin.
//
//   I1  una conexión de /ws/print-agent SIN autenticar, abierta durante la
//       ráfaga de los eventos que antes eran globales (Rappi: menú aprobado,
//       cancelación de una tienda no registrada y de una registrada;
//       repartidor: incidencia y entregado) y de una impresión de prueba
//       dirigida a la terminal con la que después se autentica: cero
//       mensajes. Controles: el panel de A y Superadmin reciben lo suyo y el
//       log registra cada webhook.
//   I2  ese MISMO socket se autentica como el Edge de A (sucursal 1): recibe
//       su confirmación y exactamente sus dos trabajos pendientes.
//   I3  con los Edge autenticados: pedido de A, pedido de B, impresión de
//       prueba en la sucursal 2 de A, prueba cruzada (A sobre la impresora de
//       B: 404) y otra ráfaga de Rappi. En cada paso, una conexión nueva sin
//       autenticar no recibe nada.
//   I4  un intruso con el terminalId del Edge de A y un token falso recibe
//       solo su error, se cierra y no desplaza al Edge verdadero.
//   I5  cada Edge autenticado recibió SOLO su confirmación y trabajos de su
//       negocio, su sucursal y su terminal (comprobado contra la fila).
//   I6  el otro negocio no recibe nada de A (ni su panel ni su Edge);
//       Superadmin solo lo de su clase; el panel de A recibió sus controles.
//   I7  el servidor sigue vivo: /health, un panel nuevo abre, ningún rechazo
//       ni 'error' sin manejar. I8: las barreras estáticas pasan.
//
// Uso: DATABASE_URL=<local, sembrada> node test/fase-print-agent-aislamiento.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';

const host = new URL(process.env.DATABASE_URL).hostname;
assert(['localhost', '127.0.0.1', '::1'].includes(host), 'solo corre contra Postgres local');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_PRINT_AISLAMIENTO || '4099';
const A = SEED.negocioA;
const B = SEED.negocioB;

const { pool, crearUsuarioConPassword } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { crearEdge, generarEmparejamiento, canjearEmparejamiento } = await import('../src/services/edgeService.js');
const { crearImpresora, crearRuta } = await import('../src/services/impresionService.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, ms = 8000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (await cond()) return true; await esperar(60); }
  return false;
}
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const sufijo = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
const cookie = (usuarioId, negocioId, rol) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;

// ── Fixture ────────────────────────────────────────────────────────────────
// /test/pedido exige el módulo 'pos'. Se restaura al final.
const modulosAntes = (await pool.query(
  `SELECT negocio_id::text AS negocio, estado FROM negocio_modulos WHERE modulo = 'pos' AND negocio_id = ANY($1::uuid[])`, [[A, B]])).rows;
for (const n of [A, B]) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'pos','activo')
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [n]);
}
// Un pedido imprime en la sucursal activa más antigua de su negocio
// (resolverSucursal): ahí va el Edge «1». La sucursal 2 de A es nueva.
async function sucursalDePedidos(neg) {
  if (!(await q1('SELECT count(*)::int AS n FROM sucursales WHERE negocio_id = $1 AND activo', [neg])).n) {
    await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
      ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [neg]);
  }
  return (await q1('SELECT id::text FROM sucursales WHERE negocio_id = $1 AND activo ORDER BY created_at LIMIT 1', [neg])).id;
}
const S1 = await sucursalDePedidos(A);
const SB = await sucursalDePedidos(B);
const S2 = (await q1('INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,$2) RETURNING id::text', [A, `Aislamiento S2 ${sufijo}`])).id;
async function montarEdge(negocio, sucursal, nombre) {
  const edge = await crearEdge(negocio, { nombre, sucursalId: sucursal });
  const { codigo } = await generarEmparejamiento(negocio, edge.id);
  const cred = await canjearEmparejamiento(codigo);
  const imp = await crearImpresora(negocio, { terminalId: edge.id, nombre: `${nombre} impresora`, transporte: 'mock', anchoColumnas: 42 });
  await crearRuta(negocio, { impresoraId: imp.id, ambito: 'documento', clave: 'comanda' });
  return { negocio, sucursal, terminal: edge.id, impresora: imp.id, cred };
}
const EA1 = await montarEdge(A, S1, `Aislamiento A1 ${sufijo}`);
const EA2 = await montarEdge(A, S2, `Aislamiento A2 ${sufijo}`);
const EB1 = await montarEdge(B, SB, `Aislamiento B1 ${sufijo}`);

const adminBPrevio = await q1(`SELECT id FROM usuarios WHERE email = 'admin-b-aislamiento@test.local'`);
const adminB = adminBPrevio || await crearUsuarioConPassword({
  negocioId: B, nombre: 'Admin B (aislamiento)', email: 'admin-b-aislamiento@test.local',
  password: 'ClaveAdminBAislamiento123!', rol: 'admin',
});
const CK_A = cookie(SEED.adminNegocioAUsuarioId, A, 'admin');
const CK_B = cookie(adminB.id, B, 'admin');
const CK_SUPER = cookie(SEED.superadminUsuarioId, A, 'admin');
const slugA = (await q1('SELECT slug FROM negocios WHERE id = $1', [A])).slug;

// Rappi: una tienda registrada para A y órdenes con marcas propias.
const TIENDA_A = `rappi-aislamiento-${sufijo}`;
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo)
  VALUES ($1,'rappi',$2,'Rappi aislamiento',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [A, TIENDA_A]);
const ORDEN = { a1: `AISL-A1-${sufijo}`, a2: `AISL-A2-${sufijo}`, nr1: `AISL-NR1-${sufijo}`, nr2: `AISL-NR2-${sufijo}` };
const TIENDA_NR = `tienda-no-registrada-${sufijo}`;

// ── Clientes WebSocket ─────────────────────────────────────────────────────
function observador(ruta, ck) {
  const ws = new WebSocket(`ws://localhost:${PUERTO}${ruta}`, ck ? { headers: { Cookie: ck } } : undefined);
  const o = { ws, recibidos: [], cerrado: false, codigo: null, abiertoEn: null };
  o.abierto = new Promise((ok, mal) => {
    ws.once('open', () => { o.abiertoEn = Date.now(); ok(); });
    ws.once('unexpected-response', (req, res) => mal(new Error(`${ruta} respondió ${res.statusCode}`)));
    ws.once('error', mal);
  });
  o.abierto.catch(() => {});
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { m = { tipo: '(no JSON)', texto: raw.toString().slice(0, 80) }; }
    o.recibidos.push(m);
  });
  ws.on('close', (code) => { o.cerrado = true; o.codigo = code; });
  ws.on('error', () => {});
  return o;
}
// Un print-agent como edge/connection.js: anota TODO lo que recibe y confirma
// sus trabajos.
function printAgent({ confirmar = true } = {}) {
  const o = observador('/ws/print-agent');
  o.ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (confirmar && m.tipo === 'trabajo_impresion' && m.trabajo?.id) {
      o.ws.send(JSON.stringify({ tipo: 'ack_impresion', trabajoId: m.trabajo.id, resultado: 'enviado' }));
    }
  });
  o.autenticar = (cred) => o.ws.send(JSON.stringify({
    tipo: 'autenticar_terminal', terminalId: cred.terminalId, token: cred.token, instalacionId: `inst-${cred.terminalId.slice(0, 8)}` }));
  o.autenticado = () => o.recibidos.some((m) => m.tipo === 'terminal_autenticada');
  o.trabajos = () => o.recibidos.filter((m) => m.tipo === 'trabajo_impresion').map((m) => String(m.trabajo?.id));
  return o;
}
// Una conexión SIN autenticar abierta durante todo el paso: no puede recibir
// nada. Si el paso tardó más que su gracia de 5 s, no cubrió los eventos y la
// prueba lo dice en vez de pasar en falso.
const centinelas = [];
async function conCentinela(etiqueta, fn) {
  const c = observador('/ws/print-agent');
  await c.abierto;
  centinelas.push({ etiqueta, c });
  await fn();
  await esperar(300);
  const ms = Date.now() - c.abiertoEn;
  assert.ok(!c.cerrado && ms < 4500, `${etiqueta}: el paso tardó ${ms} ms y la conexión sin autenticar ya ${c.cerrado ? 'se cerró' : 'iba a cerrarse'}: no cubrió los eventos`);
  assert.deepEqual(c.recibidos, [], `${etiqueta}: una conexión de /ws/print-agent SIN autenticar recibió ${JSON.stringify(c.recibidos).slice(0, 300)}`);
  c.ws.close();
}

let srv = null;
let meta = null;
const marca = () => srv.obtenerSalida().length;
const desde = (m) => srv.obtenerSalida().slice(m);
const procesoVivo = () => srv.proc.exitCode === null && srv.proc.signalCode === null;
const SIN_MANEJAR = /UnhandledPromiseRejection|unhandledRejection|Unhandled 'error' event|triggerUncaughtException|ERR_UNHANDLED_REJECTION/;
async function api(ruta, { ck, token, metodo = 'GET', cuerpo } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (ck) headers.Cookie = ck;
  if (token) headers['x-rep-token'] = token;
  const r = await fetch(`${srv.base}${ruta}`, { method: metodo, headers, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  let body = null; try { body = await r.json(); } catch { /* sin JSON */ }
  return { status: r.status, body };
}
const rappi = (cuerpo) => api('/webhook/rappi', { metodo: 'POST', cuerpo });
async function pedidoDePrueba(ck) {
  const r = await api('/test/pedido', { ck, metodo: 'POST', cuerpo: {} });
  assert.equal(r.status, 200, `/test/pedido respondió ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.pedido.id;
}
// El trabajo de comanda que la emisión (asíncrona) del pedido dejó en ESA terminal.
async function trabajoDe(folio, terminal) {
  let id = null;
  await hasta(async () => {
    id = (await q1('SELECT id::text FROM impresion_trabajos WHERE origen_id = $1 AND terminal_id = $2', [folio, terminal]))?.id ?? null;
    return id !== null;
  });
  assert.ok(id, `el pedido ${folio} no dejó trabajo para la terminal ${terminal}`);
  return id;
}
const filas = async (ids) => (await pool.query(
  `SELECT id::text, negocio_id::text AS negocio, sucursal_id::text AS sucursal, terminal_id::text AS terminal, impresora_id::text AS impresora
     FROM impresion_trabajos WHERE id = ANY($1::uuid[])`, [ids])).rows;
const menciona = (m, marcas) => { const s = JSON.stringify(m); return marcas.some((x) => s.includes(x)); };
// Lo que Superadmin puede recibir: los tipos que el código manda por SU canal
// (broadcastSuperadmin, inyectado como wsBroadcastSuperadmin). Nada más.
function tiposDelCanalSuperadmin(dir) {
  const tipos = new Set();
  for (const n of readdirSync(join(__dirname, '..', dir), { withFileTypes: true })) {
    const ruta = `${dir}/${n.name}`;
    if (n.isDirectory()) { for (const x of tiposDelCanalSuperadmin(ruta)) tipos.add(x); continue; }
    if (!/\.m?js$/.test(n.name)) continue;
    const fuente = readFileSync(join(__dirname, '..', ruta), 'utf8');
    for (const m of fuente.matchAll(/(?:broadcastSuperadmin|wsBroadcastSuperadmin)\??\.?\(\s*\{\s*tipo:\s*'([\w-]+)'/g)) tipos.add(m[1]);
  }
  return tipos;
}
const TIPOS_SUPERADMIN = tiposDelCanalSuperadmin('src');
assert.ok(TIPOS_SUPERADMIN.has('repartidor_incidencia') && TIPOS_SUPERADMIN.size >= 4, `no se reconocen los tipos del canal de Superadmin: ${[...TIPOS_SUPERADMIN]}`);

const panel = { A: null, B: null };
let superadmin = null;
let edgeA1 = null;   // nace SIN autenticar (I1) y se autentica como A1 (I2)
let edgeA2 = null;
let edgeB1 = null;
let tokenRep = null;
const folios = {};
const trabajos = {};
try {
  meta = await arrancarMetaMock();
  srv = await arrancarServidor({ PORT: PUERTO, META_GRAPH_BASE_URL: meta.baseUrl },
    { timeoutMs: 60000, omitir: ['MESERO_AGENTE_MODE', 'MESERO_SHADOW_MODE', 'PEDIDO_SHADOW_MODE'] });

  // Observadores de todo el recorrido.
  panel.A = observador('/ws/panel', CK_A);
  panel.B = observador('/ws/panel', CK_B);
  superadmin = observador('/ws/superadmin', CK_SUPER);
  edgeA2 = printAgent();
  edgeB1 = printAgent();
  await Promise.all([panel.A.abierto, panel.B.abierto, superadmin.abierto, edgeA2.abierto, edgeB1.abierto]);
  edgeA2.autenticar(EA2.cred);
  edgeB1.autenticar(EB1.cred);
  assert.ok(await hasta(() => edgeA2.autenticado() && edgeB1.autenticado()), 'los Edge de A (sucursal 2) y de B no se autenticaron');

  // Un repartidor de A con un pedido aceptado: su incidencia y su entrega son
  // parte de la ráfaga de I1. La comanda del pedido queda pendiente para A1.
  const reg = await api('/api/repartidor/registro', { metodo: 'POST', cuerpo: { nombre: 'Rep Aislamiento', telefono: `5218782${sufijo}`, negocioSlug: slugA } });
  assert.equal(reg.status, 200, `registro del repartidor: ${reg.status} ${JSON.stringify(reg.body)}`);
  tokenRep = reg.body.token;
  folios.a1 = await pedidoDePrueba(CK_A);
  trabajos.a1 = await trabajoDe(folios.a1, EA1.terminal);
  const acepta = await api(`/api/repartidor/pedido/${folios.a1}/aceptar`, { token: tokenRep, metodo: 'POST' });
  assert.equal(acepta.status, 200, `aceptar: ${acepta.status} ${JSON.stringify(acepta.body)}`);

  await t('I1 /ws/print-agent SIN autenticar durante los eventos que antes eran globales y una prueba para su terminal: cero mensajes', async () => {
    const m = marca();
    edgeA1 = printAgent();
    await edgeA1.abierto;
    const [menu, noRegistrada, registrada, prueba, [incidencia, entregado]] = await Promise.all([
      rappi({ message: 'Menu Approved' }),
      rappi({ event: 'canceled_with_charge', order_id: ORDEN.nr1, store_id: TIENDA_NR }),
      rappi({ event: 'canceled_with_charge', order_id: ORDEN.a1, store_id: TIENDA_A }),
      api(`/api/impresion/impresoras/${EA1.impresora}/prueba`, { ck: CK_A, metodo: 'POST' }),
      (async () => {
        const i = await api(`/api/repartidor/pedido/${folios.a1}/incidencia`, { token: tokenRep, metodo: 'POST', cuerpo: { tipo: 'cliente_no_responde', detalle: 'aislamiento' } });
        return [i, await api(`/api/repartidor/pedido/${folios.a1}/entregado`, { token: tokenRep, metodo: 'POST' })];
      })(),
    ]);
    const estados = { menu: menu.status, noRegistrada: noRegistrada.status, registrada: registrada.status, prueba: prueba.status, incidencia: incidencia.status, entregado: entregado.status };
    assert.deepEqual(estados, { menu: 200, noRegistrada: 200, registrada: 200, prueba: 201, incidencia: 200, entregado: 200 }, JSON.stringify(estados));
    trabajos.prueba1 = String(prueba.body.trabajo.id);
    // Controles: cada evento salió de verdad.
    assert.ok(await hasta(() => {
      const s = desde(m);
      return s.includes('[Rappi] ✅ Menú aprobado') && s.includes(`[Rappi] 🚫 Cancelación orden ${ORDEN.nr1}`)
        && panel.A.recibidos.some((x) => x.tipo === 'rappi_cancelacion' && x.orderId === ORDEN.a1)
        && panel.A.recibidos.some((x) => x.tipo === 'repartidor_incidencia' && x.folio === folios.a1)
        && panel.A.recibidos.some((x) => x.tipo === 'actualizar_estado' && x.id === folios.a1 && x.estado === 'entregado')
        && superadmin.recibidos.some((x) => x.tipo === 'repartidor_incidencia' && x.folio === folios.a1);
    }, 4000), 'los controles no llegaron: los webhooks, el panel de A o Superadmin no vieron sus eventos');
    await esperar(300);
    const ms = Date.now() - edgeA1.abiertoEn;
    assert.ok(!edgeA1.cerrado && ms < 4500, `la ráfaga tardó ${ms} ms: la conexión sin autenticar ${edgeA1.cerrado ? 'ya se cerró' : 'iba a cerrarse'} y no probaría nada`);
    assert.deepEqual(edgeA1.recibidos, [], `/ws/print-agent SIN autenticar recibió: ${JSON.stringify(edgeA1.recibidos).slice(0, 400)}`);
    const pendiente = await q1('SELECT estado, terminal_id::text AS terminal FROM impresion_trabajos WHERE id = $1', [trabajos.prueba1]);
    assert.deepEqual(pendiente, { estado: 'pendiente', terminal: EA1.terminal }, 'la prueba de su terminal no quedó pendiente');
  });

  await t('I2 el MISMO socket se autentica como el Edge de A (sucursal 1): su confirmación y exactamente sus dos trabajos pendientes', async () => {
    assert.ok(edgeA1 && !edgeA1.cerrado, 'la conexión de I1 no sigue abierta');
    const esperados = (await pool.query(
      `SELECT id::text FROM impresion_trabajos WHERE terminal_id = $1 AND estado IN ('pendiente','entregado','fallido') ORDER BY id`, [EA1.terminal])).rows.map((r) => r.id);
    assert.deepEqual([...esperados].sort(), [trabajos.a1, trabajos.prueba1].sort(), 'la terminal de A1 no tenía exactamente sus dos trabajos pendientes');
    edgeA1.autenticar(EA1.cred);
    assert.ok(await hasta(() => edgeA1.autenticado() && esperados.every((id) => edgeA1.trabajos().includes(id))), 'no se autenticó o no recibió sus pendientes');
    await esperar(300);
    assert.deepEqual(edgeA1.recibidos.map((x) => x.tipo), ['terminal_autenticada', 'trabajo_impresion', 'trabajo_impresion'],
      `recibió algo más que su confirmación y sus pendientes: ${JSON.stringify(edgeA1.recibidos.map((x) => x.tipo))}`);
    const conf = edgeA1.recibidos[0];
    assert.deepEqual([conf.terminalId, conf.negocioId, conf.sucursalId], [EA1.terminal, A, S1], 'la confirmación no es la de su terminal');
  });

  await t('I3 pedidos de A y de B, prueba en la sucursal 2, prueba cruzada y otra ráfaga de Rappi: la conexión sin autenticar de cada paso no recibe nada', async () => {
    await conCentinela('pedido de A', async () => {
      folios.a2 = await pedidoDePrueba(CK_A);
      trabajos.a2 = await trabajoDe(folios.a2, EA1.terminal);
      assert.ok(await hasta(() => edgeA1.trabajos().includes(trabajos.a2)), 'el Edge de A1 no recibió la comanda del pedido de A');
      assert.ok(await hasta(() => panel.A.recibidos.some((x) => x.tipo === 'nuevo_pedido' && x.pedido?.id === folios.a2)), 'el panel de A no recibió su pedido');
    });
    await conCentinela('pedido de B', async () => {
      folios.b1 = await pedidoDePrueba(CK_B);
      trabajos.b1 = await trabajoDe(folios.b1, EB1.terminal);
      assert.ok(await hasta(() => edgeB1.trabajos().includes(trabajos.b1)), 'el Edge de B no recibió la comanda del pedido de B');
      assert.ok(await hasta(() => panel.B.recibidos.some((x) => x.tipo === 'nuevo_pedido' && x.pedido?.id === folios.b1)), 'el panel de B no recibió su pedido');
    });
    await conCentinela('prueba en la sucursal 2 de A', async () => {
      const r = await api(`/api/impresion/impresoras/${EA2.impresora}/prueba`, { ck: CK_A, metodo: 'POST' });
      assert.equal(r.status, 201, `prueba de A2: ${r.status}`);
      trabajos.prueba2 = String(r.body.trabajo.id);
      assert.ok(await hasta(() => edgeA2.trabajos().includes(trabajos.prueba2)), 'el Edge de la sucursal 2 no recibió su prueba');
    });
    await conCentinela('prueba cruzada (A sobre la impresora de B)', async () => {
      const antes = edgeB1.recibidos.length;
      const r = await api(`/api/impresion/impresoras/${EB1.impresora}/prueba`, { ck: CK_A, metodo: 'POST' });
      assert.equal(r.status, 404, `A imprimió en la impresora de B: ${r.status}`);
      await esperar(300);
      assert.equal(edgeB1.recibidos.length, antes, 'el Edge de B recibió algo por la prueba cruzada');
    });
    await conCentinela('otra ráfaga de Rappi', async () => {
      const m = marca();
      const rs = await Promise.all([
        rappi({ message: 'Menu Approved' }),
        rappi({ event: 'canceled_with_charge', order_id: ORDEN.nr2, store_id: TIENDA_NR }),
        rappi({ event: 'canceled_with_charge', order_id: ORDEN.a2, store_id: TIENDA_A }),
      ]);
      assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
      assert.ok(await hasta(() => desde(m).includes('[Rappi] ✅ Menú aprobado') && desde(m).includes(`[Rappi] 🚫 Cancelación orden ${ORDEN.nr2}`)
        && panel.A.recibidos.some((x) => x.tipo === 'rappi_cancelacion' && x.orderId === ORDEN.a2), 4000), 'los controles de Rappi no llegaron');
    });
  });

  await t('I4 intruso con el terminalId del Edge de A y un token falso: solo su error, se cierra y no desplaza al verdadero', async () => {
    const m = marca();
    const intruso = printAgent({ confirmar: false });
    await intruso.abierto;
    intruso.ws.send(JSON.stringify({ tipo: 'autenticar_terminal', terminalId: EA1.cred.terminalId, token: 'f'.repeat(64), instalacionId: 'intruso' }));
    assert.ok(await hasta(() => intruso.cerrado, 4000), 'el intruso sigue conectado');
    assert.deepEqual(intruso.recibidos, [{ tipo: 'error', mensaje: 'Autenticación fallida' }], `el intruso recibió ${JSON.stringify(intruso.recibidos).slice(0, 300)}`);
    assert.ok(desde(m).includes('[PrintAgent] Autenticación fallida (token incorrecto)'), 'no se rechazó por token incorrecto');
    await esperar(200);
    assert.ok(!edgeA1.cerrado && !edgeA1.recibidos.some((x) => x.tipo === 'desplazada'), 'el intruso desplazó al Edge verdadero');
  });

  await t('I5 cada Edge autenticado recibió SOLO su confirmación y trabajos de su negocio, su sucursal y su terminal', async () => {
    await esperar(300);
    const malas = [];
    for (const [nombre, edge, esperado, propios] of [
      ['A1', edgeA1, EA1, [trabajos.a1, trabajos.prueba1, trabajos.a2]],
      ['A2', edgeA2, EA2, [trabajos.prueba2]],
      ['B1', edgeB1, EB1, [trabajos.b1]],
    ]) {
      const ajenos = edge.recibidos.filter((x) => !['terminal_autenticada', 'trabajo_impresion'].includes(x.tipo));
      if (ajenos.length) malas.push(`${nombre} recibió ${JSON.stringify(ajenos.map((x) => x.tipo))}`);
      if (edge.recibidos[0]?.tipo !== 'terminal_autenticada') malas.push(`${nombre}: lo primero no fue su confirmación`);
      if (edge.recibidos.filter((x) => x.tipo === 'terminal_autenticada').length !== 1) malas.push(`${nombre}: más de una confirmación`);
      const ids = edge.trabajos();
      for (const f of await filas(ids)) {
        if (f.negocio !== esperado.negocio || f.sucursal !== esperado.sucursal || f.terminal !== esperado.terminal) {
          malas.push(`${nombre} recibió el trabajo ${f.id} de negocio=${f.negocio === A ? 'A' : f.negocio === B ? 'B' : f.negocio} sucursal=${f.sucursal === S1 ? 'S1' : f.sucursal === S2 ? 'S2' : f.sucursal === SB ? 'SB' : f.sucursal}`);
        }
      }
      for (const m of edge.recibidos.filter((x) => x.tipo === 'trabajo_impresion')) {
        if (String(m.trabajo?.impresoraId) !== esperado.impresora) malas.push(`${nombre} recibió un trabajo de la impresora ${m.trabajo?.impresoraId}`);
      }
      const faltan = propios.filter((id) => !ids.includes(id));
      if (faltan.length) malas.push(`${nombre} no recibió ${faltan.length} de sus trabajos`);
    }
    assert.deepEqual(malas, []);
  });

  await t('I6 el otro negocio no recibe nada de A (ni panel ni Edge), Superadmin solo lo suyo y el panel de A sus controles', async () => {
    const deA = [folios.a1, folios.a2, ORDEN.a1, ORDEN.a2, ORDEN.nr1, ORDEN.nr2, trabajos.a1, trabajos.a2, trabajos.prueba1, trabajos.prueba2];
    const malas = [];
    const panelBAjeno = panel.B.recibidos.filter((x) => menciona(x, deA) || /^rappi_/.test(String(x.tipo)) || /^repartidor_/.test(String(x.tipo)));
    if (panelBAjeno.length) malas.push(`el panel de B recibió de A o global: ${JSON.stringify(panelBAjeno.map((x) => x.tipo))}`);
    if (!panel.B.recibidos.some((x) => x.tipo === 'nuevo_pedido' && x.pedido?.id === folios.b1)) malas.push('el panel de B no recibió su propio pedido (control)');
    if (edgeB1.recibidos.some((x) => menciona(x, deA))) malas.push('el Edge de B recibió algo de A');
    const superAjeno = superadmin.recibidos.filter((x) => !TIPOS_SUPERADMIN.has(x.tipo));
    if (superAjeno.length) malas.push(`Superadmin recibió fuera de su clase: ${JSON.stringify(superAjeno.map((x) => x.tipo))}`);
    const deB = [folios.b1, trabajos.b1];
    if (panel.A.recibidos.some((x) => menciona(x, deB))) malas.push('el panel de A recibió algo de B');
    const panelAGlobal = panel.A.recibidos.filter((x) => x.tipo === 'rappi_menu_aprobado' || menciona(x, [ORDEN.nr1, ORDEN.nr2]));
    if (panelAGlobal.length) malas.push(`el panel de A recibió eventos sin negocio: ${JSON.stringify(panelAGlobal.map((x) => x.tipo))}`);
    for (const [que, ok] of [
      ['nuevo_pedido de A', panel.A.recibidos.some((x) => x.tipo === 'nuevo_pedido' && x.pedido?.id === folios.a2)],
      ['rappi_cancelacion de su tienda', panel.A.recibidos.filter((x) => x.tipo === 'rappi_cancelacion').map((x) => x.orderId).sort().join() === [ORDEN.a1, ORDEN.a2].sort().join()],
      ['actualizar_estado del repartidor', panel.A.recibidos.some((x) => x.tipo === 'actualizar_estado' && x.id === folios.a1)],
    ]) if (!ok) malas.push(`el panel de A no recibió ${que} (control)`);
    assert.deepEqual(malas, []);
  });

  await t('I7 el servidor sigue vivo: /health, un panel nuevo abre y ningún rechazo ni error sin manejar', async () => {
    assert.ok(procesoVivo(), `el proceso TERMINÓ (exit=${srv.proc.exitCode}): ${srv.obtenerSalida().slice(-600)}`);
    const salud = await fetch(`${srv.base}/health`).then((r) => r.status).catch((e) => `sin respuesta (${e.message})`);
    assert.equal(salud, 200, `/health ${salud}`);
    const nuevo = observador('/ws/panel', CK_A);
    await nuevo.abierto;
    nuevo.ws.close();
    const salida = srv.obtenerSalida();
    assert.ok(!SIN_MANEJAR.test(salida), `hubo un rechazo o un 'error' sin manejar: ${salida.match(/.*(Unhandled|unhandled|triggerUncaught).*/)?.[0]}`);
    assert.ok(!/error inesperado/.test(salida), 'un mensaje terminó en «error inesperado»');
  });
} finally {
  for (const o of [panel.A, panel.B, superadmin, edgeA1, edgeA2, edgeB1, ...centinelas.map((c) => c.c)]) { try { o?.ws.close(); } catch { /* ya cerrado */ } }
  if (srv) {
    const salida = new Promise((ok) => { srv.proc.once('exit', ok); setTimeout(ok, 3000); });
    srv.detener();
    await salida;
  }
  meta?.detener();
}

await t('I8 las barreras estáticas del predeploy pasan', async () => {
  await import('../scripts/check-websocket-lista-cerrada.mjs');
});

// ── Limpieza: lo que la suite dio de alta no debe imprimir en otras ─────────
const limpiar = async (sql, p) => pool.query(sql, p).catch(() => {});
const impresoras = [EA1.impresora, EA2.impresora, EB1.impresora];
await limpiar('DELETE FROM impresion_rutas WHERE impresora_id = ANY($1::uuid[])', [impresoras]);
await limpiar('UPDATE impresoras SET activa = false WHERE id = ANY($1::uuid[])', [impresoras]);
await limpiar('UPDATE terminales SET activo = false WHERE id = ANY($1::uuid[])', [[EA1.terminal, EA2.terminal, EB1.terminal]]);
await limpiar('UPDATE sucursales SET activo = false WHERE id = $1', [S2]);
await limpiar(`DELETE FROM integraciones_canal WHERE canal = 'rappi' AND identificador = $1`, [TIENDA_A]);
for (const n of [A, B]) {
  const previo = modulosAntes.find((x) => x.negocio === n);
  if (previo) await limpiar(`UPDATE negocio_modulos SET estado = $3 WHERE negocio_id = $1 AND modulo = $2`, [n, 'pos', previo.estado]);
  else await limpiar(`DELETE FROM negocio_modulos WHERE negocio_id = $1 AND modulo = 'pos'`, [n]);
}

console.log(`RESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
await pool.end();
process.exit(fallidas ? 1 : 0);
