// ─── UN SOLO EFECTO LÓGICO POR PEDIDO ───────────────────────────────────────
//
// La obligación financiera garantiza que un pedido se autoriza una vez. La
// EMISIÓN no: `emitirPedido()` manda `nuevo_pedido` por WebSocket y solo
// después se escribe la marca durable de derivación. Un proceso que muere en esa
// ventana obliga al retry a reemitir, y el volcado de la reconexión reenvía todo
// lo activo. El backend no puede prometer exactly-once sobre un socket.
//
// Lo que sí se promete es que el PANEL haga un solo efecto lógico: una tarjeta,
// un sonido, un contador, una impresión. Esta suite cubre las dos mitades:
//
//   · el productor manda una identidad DETERMINÍSTICA
//     (`nuevo_pedido:<negocioId>:<folio>`), la misma aunque la emita otra
//     instancia o se recupere mañana;
//   · el consumidor la reclama contra un registro DURABLE, que sobrevive al
//     F5 y al reinicio del navegador.
//
// Cero llamadas externas. Cero dinero real.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { claveEventoPedido, conIdentidadDePedido } =
  await import('../src/services/eventosPanel.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG = SEED.negocioA;
const NEG_B = SEED.negocioB;
const PUERTO = String(process.env.TEST_PORT_DEDUPE || 4351);
const base = `http://localhost:${PUERTO}`;
const COOKIE_A = `xabor_sesion=${encodeURIComponent(
  crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: NEG, rol: 'admin' }))}`;

// ── El consumidor real, cargado tal cual lo recibe el navegador ─────────────
//
// No se reimplementa la lógica: se ejecuta el MISMO archivo que sirve el panel,
// con un `localStorage` simulado. Una copia en el test podría divergir del
// original y dar verde probando otra cosa.
function cargarDedupeDelPanel(opciones = {}) {
  const dedupeJs = readFileSync(join(__dirname, '..', 'panel', 'dedupeEventos.js'), 'utf8');
  const tableroJs = readFileSync(join(__dirname, '..', 'panel', 'tableroEventos.js'), 'utf8');
  const almacenado = opciones.almacenado || new Map();
  const fakeWindow = {};
  if (!opciones.sinAlmacenamiento) {
    fakeWindow.localStorage = {
      getItem: (k) => (almacenado.has(k) ? almacenado.get(k) : null),
      setItem: (k, v) => almacenado.set(k, String(v)),
      removeItem: (k) => almacenado.delete(k),
    };
  }
  // eslint-disable-next-line no-new-func
  new Function('window', [dedupeJs, tableroJs, ';window.__ok = true;'].join(String.fromCharCode(10)))(fakeWindow);
  assert.strictEqual(fakeWindow.__ok, true, 'los modulos del panel no se ejecutaron');
  return {
    api: fakeWindow.XaborDedupeEventos,
    tablero: fakeWindow.XaborTableroEventos,
    almacenado, fakeWindow,
  };
}

/**
 * Panel simulado. Distingue ESTADO (tarjetas del tablero) de EFECTOS (sonido,
 * impresion), y enruta con el MODULO REAL del panel -- no con una copia, que
 * podria divergir del original y dar verde probando otra cosa.
 */
function panelSimulado(negocioId, cargado, opciones = {}) {
  const dedupe = cargado.api ? cargado.api.crear(negocioId, opciones.dedupe) : null;
  const estado = new Map();                // folio -> pedido: el tablero
  const efectos = { sonidos: 0, impresiones: 0, cuentasFinales: 0 };
  let ultimaCuenta = null;
  let romper = false;
  const fallos = [];

  return {
    dedupe, efectos, fallos,
    get contador() { return estado.size; },
    get tarjetas() { return new Set(estado.keys()); },
    get cuentaGuardada() { return ultimaCuenta; },
    romperProyeccion(v) { romper = v; },
    quitarDelTablero(folio) { estado.delete(folio); },
    recibir(msg) {
      return cargado.tablero.manejarEventoPedido(msg, {
        upsertPedido: (p) => {
          if (romper) throw new Error('proyeccion rota (inyectado)');
          estado.set(p.id, p);
        },
        notificar: (p, edge) => { efectos.sonidos++; if (!edge) efectos.impresiones++; },
        guardarCuentaFinal: (t) => {
          if (romper) throw new Error('proyeccion rota (inyectado)');
          ultimaCuenta = t;
        },
        notificarCuentaFinal: (t, edge) => {
          efectos.cuentasFinales++; efectos.sonidos++; if (!edge) efectos.impresiones++;
        },
        estaEnTablero: (folio) => estado.has(folio),
        dedupe,
        alFallar: (e) => fallos.push(e),
      });
    },
  };
}

const pedidoDe = (folio, negocioId = NEG) => ({
  id: folio, negocioId, total: 100, estado: 'nuevo',
  cliente: { nombre: 'Cliente dedupe', telefono: '8997700001' },
  items: [{ nombre: 'Producto', cantidad: 1, precio_unitario: 100 }],
});

function abrirPanelWS(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http://', 'ws://') + '/ws/panel', { headers: { Cookie: cookie } });
    const to = setTimeout(() => reject(new Error('timeout abriendo WS panel')), 8000);
    ws.on('open', () => { clearTimeout(to); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}
function escuchar(ws) {
  const recibidos = [];
  ws.on('message', (raw) => {
    let d; try { d = JSON.parse(raw.toString()); } catch { return; }
    recibidos.push(d);
  });
  return recibidos;
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

async function limpiar() {
  for (const n of [NEG, NEG_B]) {
    await pool.query(
      `DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio LIKE 'DED-%'`, [n]);
    await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id=$1 AND origen_id LIKE 'DED-%'`, [n]);
  }
  await pool.query(
    `DELETE FROM menu_productos WHERE categoria_id IN
      (SELECT id FROM menu_categorias WHERE negocio_id=$1 AND nombre='Dedupe (test)')`, [NEG]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre='Dedupe (test)'`, [NEG]);
}

let srv = null;
let PRODUCTO = null;

async function prepararMenu() {
  await pool.query(
    `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'pos','activo')
     ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [NEG]);
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden)
     VALUES ($1,'Dedupe (test)',TRUE,950)
     ON CONFLICT DO NOTHING RETURNING id`, [NEG]);
  const catId = cat?.id || (await pool.query(
    `SELECT id FROM menu_categorias WHERE negocio_id=$1 AND nombre='Dedupe (test)'`, [NEG])).rows[0].id;
  const { rows: [prod] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
     VALUES ($1,$2,'Producto dedupe',150,TRUE,1) RETURNING id`, [NEG, catId]);
  PRODUCTO = prod.id;
}

try {
  await limpiar();

  // ═══ IDENTIDAD DEL EVENTO ════════════════════════════════════════════════
  await t('1. la identidad es determinística: mismo pedido, misma clave siempre', () => {
    const a = claveEventoPedido({ negocioId: NEG, folio: 'DED-0001' });
    for (let i = 0; i < 50; i++) {
      assert.strictEqual(claveEventoPedido({ negocioId: NEG, folio: 'DED-0001' }), a,
        'la clave cambió entre llamadas: lleva algo que no es identidad');
    }
    assert.strictEqual(a, `nuevo_pedido:${NEG}:DED-0001`);
    // Ni timestamp, ni uuid, ni pid: nada que varíe entre procesos.
    assert.ok(!/\d{13}/.test(a), 'la clave lleva un timestamp dentro');
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(a.replace(NEG, '')),
      'la clave lleva un uuid que no es el negocio');
  });

  await t('2. el negocio SIEMPRE entra en la clave: dos folios iguales no colisionan', () => {
    const a = claveEventoPedido({ negocioId: NEG, folio: 'DED-MISMO' });
    const b = claveEventoPedido({ negocioId: NEG_B, folio: 'DED-MISMO' });
    assert.notStrictEqual(a, b,
      '¡el mismo folio en dos negocios produce la misma clave: uno silenciaría al otro!');
    assert.ok(a.includes(NEG) && b.includes(NEG_B));
  });

  await t('3. folios distintos y tipos distintos nunca colisionan', () => {
    assert.notStrictEqual(
      claveEventoPedido({ negocioId: NEG, folio: 'DED-A' }),
      claveEventoPedido({ negocioId: NEG, folio: 'DED-B' }));
    // La comanda y el ticket de cuenta final son dos efectos distintos sobre el
    // mismo folio: ninguno puede tapar al otro.
    assert.notStrictEqual(
      claveEventoPedido({ negocioId: NEG, folio: 'DED-A' }),
      claveEventoPedido({ negocioId: NEG, folio: 'DED-A', tipoComanda: 'cuenta_final' }));
  });

  await t('4. sin negocio o sin folio no hay identidad: null, nunca una clave ambigua', () => {
    for (const caso of [
      { negocioId: '', folio: 'DED-A' }, { negocioId: null, folio: 'DED-A' },
      { negocioId: NEG, folio: '' }, { negocioId: NEG, folio: null },
      { negocioId: '   ', folio: 'DED-A' },
    ]) {
      assert.strictEqual(claveEventoPedido(caso), null,
        `se fabricó una clave con ${JSON.stringify(caso)}`);
    }
    // Y el mensaje sale sin eventId, para que el panel NO lo dedupee: mejor un
    // efecto repetido que silenciar un pedido real.
    const msg = conIdentidadDePedido({ tipo: 'nuevo_pedido' }, { id: 'DED-X' });
    assert.strictEqual(msg.eventId, undefined);
  });

  // ═══ EL CONSUMIDOR ═══════════════════════════════════════════════════════
  await t('5. el mismo nuevo_pedido 50 veces: un efecto', () => {
    const cargado = cargarDedupeDelPanel();
    const panel = panelSimulado(NEG, cargado);
    const pedido = pedidoDe('DED-0050');
    const msg = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido }, pedido);
    for (let i = 0; i < 50; i++) panel.recibir(msg);
    assert.strictEqual(panel.tarjetas.size, 1, '50 avisos dejaron más de una tarjeta');
    assert.strictEqual(panel.contador, 1, 'el contador se incrementó de más');
    assert.strictEqual(panel.efectos.sonidos, 1, 'sonó más de una vez');
    assert.strictEqual(panel.efectos.impresiones, 1, 'se imprimió más de una vez');
  });

  await t('6. dos instancias del backend emiten el mismo pedido: un efecto', () => {
    const cargado = cargarDedupeDelPanel();
    const panel = panelSimulado(NEG, cargado);
    const pedido = pedidoDe('DED-0060');
    // Cada instancia construye el mensaje por su cuenta. La clave sale igual.
    const deA = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido, impresionEdge: false }, pedido);
    const deB = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido, impresionEdge: true }, pedido);
    assert.strictEqual(deA.eventId, deB.eventId, 'dos instancias produjeron claves distintas');
    panel.recibir(deA);
    panel.recibir(deB);
    assert.strictEqual(panel.contador, 1);
    assert.strictEqual(panel.efectos.sonidos, 1);
  });

  await t('7. EL CASO CENTRAL: crash tras el broadcast, antes de la marca durable', () => {
    // Proceso A: emite y muere antes de marcar la derivación. Proceso B (el
    // retry) recupera la deuda y vuelve a emitir. El backend manda DOS veces --
    // no puede hacer otra cosa -- y el panel hace UN efecto.
    const cargado = cargarDedupeDelPanel();
    const panel = panelSimulado(NEG, cargado);
    const pedido = pedidoDe('DED-0070');

    const desdeA = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido }, pedido);
    panel.recibir(desdeA);              // el panel YA lo vio
    // ... aquí muere A, sin escribir la marca ...
    const desdeB = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido }, pedido);
    panel.recibir(desdeB);              // el retry reemite lo mismo

    assert.strictEqual(desdeA.eventId, desdeB.eventId,
      'el retry generó otra identidad: para el panel sería un pedido nuevo');
    assert.strictEqual(panel.tarjetas.size, 1, 'el pedido apareció dos veces');
    assert.strictEqual(panel.contador, 1, 'el contador se incrementó dos veces');
    assert.strictEqual(panel.efectos.sonidos, 1, 'sonó dos veces');
    assert.strictEqual(panel.efectos.impresiones, 1, 'se mandó a imprimir dos veces');
  });

  await t('8. F5 del panel: el registro es DURABLE, no un Set de memoria', () => {
    const cargado = cargarDedupeDelPanel();
    const { almacenado } = cargado;
    const pedido = pedidoDe('DED-0080');
    const msg = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido }, pedido);

    const antes = panelSimulado(NEG, cargado);
    antes.recibir(msg);
    assert.strictEqual(antes.contador, 1);
    assert.ok(almacenado.size > 0, 'no se persistió nada: al recargar se repetiría el efecto');

    // F5: instancia nueva, DOM vacio, MISMO localStorage. El servidor manda el
    // snapshot porque el pedido SIGUE ACTIVO.
    const despues = panelSimulado(NEG, cargado);
    despues.recibir({ ...msg, replay: true });
    assert.strictEqual(despues.tarjetas.size, 1,
      'tras el F5 el pedido activo DESAPARECIO del tablero');
    assert.strictEqual(despues.contador, 1, 'el contador quedo en cero tras el F5');
    assert.strictEqual(despues.efectos.sonidos, 0, 'el replay volvio a sonar');
    assert.strictEqual(despues.efectos.impresiones, 0, 'el replay volvio a imprimir');
  });

  await t('9. reconexión: el volcado inicial no vuelve a sonar ni a imprimir', () => {
    const cargado = cargarDedupeDelPanel();
    const panel = panelSimulado(NEG, cargado);
    const pedidos = ['DED-0091', 'DED-0092', 'DED-0093'].map(f => pedidoDe(f));
    for (const p of pedidos) panel.recibir(conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: p }, p));
    assert.strictEqual(panel.contador, 3);

    // El panel se reconecta y el servidor le manda TODO lo activo otra vez.
    for (let vuelta = 0; vuelta < 5; vuelta++) {
      for (const p of pedidos) {
        panel.recibir(conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: p, replay: true }, p));
      }
    }
    assert.strictEqual(panel.contador, 3, 'la reconexión perdió o duplicó pedidos');
    assert.strictEqual(panel.efectos.sonidos, 3, 'la reconexión volvió a sonar');
    assert.strictEqual(panel.efectos.impresiones, 3, 'la reconexión volvió a imprimir');
  });

  await t('10. el ticket de CUENTA FINAL también se dedupea', () => {
    const cargado = cargarDedupeDelPanel();
    const panel = panelSimulado(NEG, cargado);
    const cuenta = { ...pedidoDe('DED-0100'), tipo_comanda: 'cuenta_final' };
    const msg = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: cuenta }, cuenta);
    for (let i = 0; i < 10; i++) panel.recibir(msg);
    assert.strictEqual(panel.efectos.cuentasFinales, 1,
      'el ticket de cuenta final se imprimió más de una vez');
    assert.strictEqual(panel.efectos.impresiones, 1);

    // Y la comanda del MISMO folio sigue siendo un efecto propio.
    const comanda = pedidoDe('DED-0100');
    panel.recibir(conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: comanda }, comanda));
    assert.strictEqual(panel.tarjetas.size, 1,
      'el ticket de cuenta tapó la comanda del mismo pedido');
  });

  await t('11. un pedido ya despachado NO resucita con un reenvío', () => {
    // El defecto que tenía el panel: dedupeaba mirando si la tarjeta seguía en
    // el DOM. Retirada la tarjeta (pedido entregado), un reenvío la recreaba
    // con sonido e impresión.
    const cargado = cargarDedupeDelPanel();
    const panel = panelSimulado(NEG, cargado);
    const pedido = pedidoDe('DED-0110');
    const msg = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido }, pedido);
    panel.recibir(msg);
    panel.quitarDelTablero('DED-0110');          // el operador lo despachó

    panel.recibir(msg);
    assert.strictEqual(panel.tarjetas.size, 0,
      'un pedido ya despachado resucitó al llegar un reenvío');
    assert.strictEqual(panel.efectos.sonidos, 1);
    assert.strictEqual(panel.efectos.impresiones, 1);
  });

  await t('12. dos negocios: el evento de A jamás silencia el de B', () => {
    const cargado = cargarDedupeDelPanel();
    const panelA = panelSimulado(NEG, cargado);
    const panelB = panelSimulado(NEG_B, cargado);
    const enA = pedidoDe('DED-MISMO-FOLIO', NEG);
    const enB = pedidoDe('DED-MISMO-FOLIO', NEG_B);

    panelA.recibir(conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: enA }, enA));
    panelB.recibir(conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: enB }, enB));

    assert.strictEqual(panelA.contador, 1);
    assert.strictEqual(panelB.contador, 1,
      '¡el pedido del negocio B quedó silenciado por el del negocio A!');

    // Y repetirlos sigue sin cruzarse.
    panelA.recibir(conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: enA }, enA));
    panelB.recibir(conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: enB }, enB));
    assert.strictEqual(panelA.contador, 1);
    assert.strictEqual(panelB.contador, 1);
  });

  await t('13. sin eventId no se dedupea: nunca se silencia un pedido real', () => {
    const cargado = cargarDedupeDelPanel();
    const panel = panelSimulado(NEG, cargado);
    const pedido = pedidoDe('DED-0130');
    // Servidor viejo, sin identidad en el mensaje.
    for (let i = 0; i < 3; i++) panel.recibir({ tipo: 'nuevo_pedido', pedido });
    // El ESTADO es idempotente por folio: una sola tarjeta. Lo que no se
    // dedupea sin identidad son los EFECTOS -- mejor un aviso repetido que
    // silenciar un pedido real por una clave que el servidor no supo construir.
    assert.strictEqual(panel.contador, 1, 'la proyección duplicó la tarjeta');
    assert.strictEqual(panel.efectos.sonidos, 3,
      'un mensaje sin identidad se dedupeó: podría silenciar pedidos distintos');
  });

  await t('14. el registro se poda y no crece sin límite', () => {
    const { api } = cargarDedupeDelPanel();
    const d = api.crear(NEG);
    for (let i = 0; i < api.LIMITE + 250; i++) d.marcar(`nuevo_pedido:${NEG}:DED-P${i}`);
    assert.ok(d.tamano() <= api.LIMITE,
      `el registro creció a ${d.tamano()}, por encima del límite ${api.LIMITE}`);
    // Lo más reciente sigue estando: podar no puede abrir la puerta a repetir
    // el pedido que acaba de entrar.
    assert.strictEqual(d.yaVisto(`nuevo_pedido:${NEG}:DED-P${api.LIMITE + 249}`), true,
      'la poda se llevó el evento más reciente');
  });

  await t('15. lo viejo caduca: un folio reutilizado meses después vuelve a sonar', () => {
    const { api } = cargarDedupeDelPanel();
    let ahora = Date.now();
    const d = api.crear(NEG, { ahora: () => ahora });
    d.marcar(`nuevo_pedido:${NEG}:DED-VIEJO`);
    assert.strictEqual(d.yaVisto(`nuevo_pedido:${NEG}:DED-VIEJO`), true);
    ahora += api.VIDA_MS + 60e3;
    const d2 = api.crear(NEG, { ahora: () => ahora });
    assert.strictEqual(d2.yaVisto(`nuevo_pedido:${NEG}:DED-VIEJO`), false,
      'un evento de hace días sigue bloqueando su folio para siempre');
  });

  // ═══ EL PRODUCTOR REAL, POR WEBSOCKET ════════════════════════════════════
  await prepararMenu();
  srv = await arrancarServidor({ PORT: PUERTO, XABOR_RUTAS_PRUEBA: '1' }, { timeoutMs: 90000 });

  await t('16. el POS REAL manda la identidad por el WebSocket del panel', async () => {
    // El pedido se crea por el endpoint del servidor, no desde este proceso:
    // `emitirPedido` inyecta su broadcast al arrancar el servidor, y una
    // llamada desde el test no tendria forma de llegar a ese WebSocket.
    const ws = await abrirPanelWS(COOKIE_A);
    const recibidos = escuchar(ws);
    let folio = null;
    try {
      const r = await fetch(`${base}/api/pos/pedidos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: COOKIE_A },
        body: JSON.stringify({
          tipo: 'recoger', formaPago: 'efectivo',
          cliente: { nombre: 'Cliente WS', telefono: '8997700002' },
          items: [{ producto_id: PRODUCTO, cantidad: 1 }],
        }),
      }).then(async x => ({ status: x.status, body: await x.json().catch(() => ({})) }));
      assert.strictEqual(r.status, 200, `el POS rechazo el pedido: ${JSON.stringify(r.body)}`);
      folio = r.body?.pedido?.id;
      assert.ok(folio, `sin folio: ${JSON.stringify(r.body)}`);
      await esperar(900);

      const nuevos = recibidos.filter(m => m.tipo === 'nuevo_pedido' && m.pedido?.id === folio);
      assert.ok(nuevos.length >= 1, 'el panel no recibio el evento del POS');
      assert.strictEqual(nuevos[0].eventId, `nuevo_pedido:${NEG}:${folio}`,
        `el servidor mando eventId=${nuevos[0].eventId}`);

      // Y un panel real hace UN efecto con todo lo que llegue de ese pedido.
      const cargado = cargarDedupeDelPanel();
      const panel = panelSimulado(NEG, cargado);
      for (const m of nuevos) panel.recibir(m);
      assert.strictEqual(panel.contador, 1,
        `${nuevos.length} mensajes reales produjeron ${panel.contador} efectos`);
    } finally {
      ws.close();
      if (folio) await pool.query(`DELETE FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, NEG]);
    }
  });

  await t('17. el volcado de la reconexion lleva identidad y no repite efectos', async () => {
    const r = await fetch(`${base}/api/pos/pedidos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: COOKIE_A },
      body: JSON.stringify({
        tipo: 'recoger', formaPago: 'efectivo',
        cliente: { nombre: 'Cliente replay', telefono: '8997700003' },
        items: [{ producto_id: PRODUCTO, cantidad: 1 }],
      }),
    }).then(async x => ({ status: x.status, body: await x.json().catch(() => ({})) }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const folio = r.body?.pedido?.id;
    assert.ok(folio);

    // P0-11: la emision (compra real + Edge + broadcast en vivo) ahora vive
    // detras de un claim con advisory lock -- mas ida y vuelta a la base que
    // el INSERT suelto de antes, asi que tarda mas en completarse. Sin
    // esperar a que la deuda quede 'saldada', el broadcast EN VIVO (sin
    // replay) puede caer dentro de alguna de las 5 ventanas de reconexion de
    // abajo -- y ESE evento si debe sonar (es genuinamente nuevo para un
    // panel que estuviera conectado), lo que este caso no esta probando.
    // Esperar a que la emision termine reproduce la premisa real del caso:
    // el panel se conecta DESPUES de que el pedido ya salio.
    for (let i = 0; i < 30; i++) {
      const { rows: [d] } = await pool.query(
        `SELECT estado FROM pedido_emisiones WHERE folio=$1 AND negocio_id=$2`, [folio, NEG]);
      if (d?.estado === 'saldada') break;
      await esperar(200);
    }

    try {
      const cargado = cargarDedupeDelPanel();
      const panel = panelSimulado(NEG, cargado);
      let vistos = 0;
      // Cinco reconexiones: el servidor vuelca todo lo activo en cada una.
      // Espera activa (no un sleep fijo) al mensaje esperado: un tiempo de
      // ventana constante es inherentemente fragil bajo contencion --
      // suficiente casi siempre, insuficiente a veces, sin relacion con
      // ningun cambio real de comportamiento.
      for (let i = 0; i < 5; i++) {
        const ws = await abrirPanelWS(COOKIE_A);
        const rec = escuchar(ws);
        for (let j = 0; j < 40; j++) {
          if (rec.some(m => m.tipo === 'nuevo_pedido' && m.pedido?.id === folio)) break;
          await esperar(150);
        }
        ws.close();
        const suyos = rec.filter(m => m.tipo === 'nuevo_pedido' && m.pedido?.id === folio);
        vistos += suyos.length;
        for (const m of suyos) {
          assert.strictEqual(m.eventId, `nuevo_pedido:${NEG}:${folio}`,
            'el volcado de la reconexion manda eventos sin identidad');
          panel.recibir(m);
        }
      }
      assert.ok(vistos >= 5, `el volcado solo mando el pedido ${vistos} veces en 5 reconexiones`);
      // El pedido SIEMPRE queda proyectado -- eso es lo que reconstruye el
      // tablero -- y el replay no suena ni imprime nunca.
      assert.strictEqual(panel.contador, 1,
        `${vistos} mensajes de reconexion dejaron ${panel.contador} tarjetas`);
      assert.strictEqual(panel.efectos.sonidos, 0, 'el volcado de reconexion sono');
      assert.strictEqual(panel.efectos.impresiones, 0, 'el volcado de reconexion imprimio');
    } finally {
      await pool.query(`DELETE FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, NEG]);
    }
  });

  // ═══ P0-8: EL ESTADO NO PUEDE VIVIR DETRÁS DEL DEDUPE ════════════════════
  await t('18. segunda pestaña, mismo localStorage: el pedido activo SE VE', async () => {
    // Tab A ya vio P y escribió el registro. Tab B nace con el DOM vacío y
    // recibe el snapshot. Compartir localStorage no puede dejarlo en blanco.
    const cargado = cargarDedupeDelPanel();
    const pedido = pedidoDe('DED-0180');
    const live = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido }, pedido);

    const tabA = panelSimulado(NEG, cargado);
    tabA.recibir(live);
    assert.strictEqual(tabA.contador, 1);
    assert.strictEqual(tabA.efectos.sonidos, 1);

    const tabB = panelSimulado(NEG, cargado);     // mismo almacenamiento
    tabB.recibir({ ...live, replay: true });
    assert.strictEqual(tabB.contador, 1,
      'la segunda pestaña nació vacía: el localStorage compartido bloqueó la proyección');
    assert.strictEqual(tabB.efectos.sonidos, 0, 'la segunda pestaña volvió a sonar');
  });

  await t('19. si la proyección falla, el evento NO queda marcado y el retry recupera', async () => {
    const cargado = cargarDedupeDelPanel();
    const panel = panelSimulado(NEG, cargado);
    const pedido = pedidoDe('DED-0190');
    const msg = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido }, pedido);

    panel.romperProyeccion(true);
    const r = panel.recibir(msg);
    assert.strictEqual(r.proyectado, false);
    assert.strictEqual(panel.contador, 0);
    assert.strictEqual(panel.fallos.length, 1, 'la excepción se tragó en silencio');
    assert.strictEqual(panel.dedupe.yaVisto(msg.eventId), false,
      'el evento quedó marcado pese a que el pedido nunca se mostró');

    // El retry -- o la próxima reconexión -- sí lo aplica.
    panel.romperProyeccion(false);
    panel.recibir(msg);
    assert.strictEqual(panel.contador, 1, 'el retry no recuperó el pedido');
    assert.strictEqual(panel.efectos.sonidos, 1);
  });

  await t('20. un LIVE nuevo en los primeros segundos SÍ avisa (no es replay)', async () => {
    // El heurístico viejo (`panelListo` durante 3 s) silenciaba pedidos reales
    // por el reloj. `msg.replay` distingue por semántica, no por tiempo.
    const cargado = cargarDedupeDelPanel();
    const panel = panelSimulado(NEG, cargado);
    const activo = pedidoDe('DED-0201');
    const recien = pedidoDe('DED-0202');

    // Volcado de reconexión: proyecta, no avisa.
    panel.recibir(conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: activo, replay: true }, activo));
    // Y en el mismo instante entra un pedido REAL.
    panel.recibir(conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: recien }, recien));

    assert.strictEqual(panel.contador, 2, 'se perdió un pedido');
    assert.strictEqual(panel.efectos.sonidos, 1,
      'el pedido nuevo se quedó sin aviso, o el replay avisó');
    assert.strictEqual(panel.efectos.impresiones, 1);
  });

  await t('21. snapshot autoritativo manda sobre la memoria del navegador', async () => {
    // El operador despachó P y la tarjeta se retiró. Un LIVE duplicado viejo no
    // debe resucitarlo -- pero si el SERVIDOR lo vuelve a declarar activo en un
    // snapshot, esa es la fuente de verdad y hay que mostrarlo.
    const cargado = cargarDedupeDelPanel();
    const panel = panelSimulado(NEG, cargado);
    const pedido = pedidoDe('DED-0210');
    const live = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido }, pedido);

    panel.recibir(live);
    panel.quitarDelTablero('DED-0210');            // despachado

    panel.recibir(live);                            // LIVE duplicado viejo
    assert.strictEqual(panel.contador, 0, 'un LIVE duplicado resucitó un pedido despachado');

    panel.recibir({ ...live, replay: true });       // el servidor dice que sigue activo
    assert.strictEqual(panel.contador, 1,
      'el snapshot autoritativo no pudo reconstruir el pedido');
    assert.strictEqual(panel.efectos.sonidos, 1, 'el snapshot volvió a sonar');
  });

  await t('22. cuenta final: replay no reimprime, pero tampoco desaparece', async () => {
    const cargado = cargarDedupeDelPanel();
    const panel = panelSimulado(NEG, cargado);
    const cuenta = { ...pedidoDe('DED-0220'), tipo_comanda: 'cuenta_final' };
    const msg = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: cuenta }, cuenta);

    panel.recibir(msg);
    assert.strictEqual(panel.efectos.cuentasFinales, 1);
    assert.ok(panel.cuentaGuardada, 'la cuenta no quedó recuperable');

    // F5: instancia nueva, mismo registro, el servidor la vuelve a mandar.
    const tras = panelSimulado(NEG, cargado);
    tras.recibir({ ...msg, replay: true });
    assert.ok(tras.cuentaGuardada, 'tras el F5 la última cuenta desapareció del botón');
    assert.strictEqual(tras.efectos.cuentasFinales, 0, 'el replay reimprimió la cuenta');
    assert.strictEqual(tras.efectos.impresiones, 0);

    // Y una LIVE duplicada sigue siendo un solo efecto.
    for (let i = 0; i < 10; i++) panel.recibir(msg);
    assert.strictEqual(panel.efectos.cuentasFinales, 1, 'la cuenta se reimprimió con los duplicados');
  });

  await t('23. sin localStorage: jamás se pierde un pedido', async () => {
    // Modo privado, iframe con storage bloqueado, cuota llena. Puede degradar a
    // un aviso repetido; nunca a un pedido invisible.
    const cargado = cargarDedupeDelPanel({ sinAlmacenamiento: true });
    const panel = panelSimulado(NEG, cargado);
    const pedido = pedidoDe('DED-0230');
    const msg = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido }, pedido);

    for (let i = 0; i < 3; i++) panel.recibir(msg);
    assert.strictEqual(panel.contador, 1, 'se perdió el pedido sin almacenamiento');
    assert.ok(panel.efectos.sonidos >= 1, 'no avisó ni una vez');

    const tras = panelSimulado(NEG, cargado);
    tras.recibir({ ...msg, replay: true });
    assert.strictEqual(tras.contador, 1, 'tras el F5 sin almacenamiento se perdió el pedido');
  });

  await t('24. el módulo del panel es el MISMO que carga el navegador', () => {
    // Si el HTML dejara de cargarlo, o el listener dejara de enrutarlo, las
    // pruebas de arriba seguirían verdes contra un archivo que nadie usa.
    const html = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');
    assert.ok(html.includes('/tableroEventos.js'), 'el panel no carga tableroEventos.js');
    assert.ok(html.includes('/dedupeEventos.js'), 'el panel no carga dedupeEventos.js');
    assert.ok(html.includes('XaborTableroEventos.manejarEventoPedido'),
      'el panel no enruta por el módulo compartido');
    assert.ok(html.includes('upsertPedidoEnTablero'), 'no existe la proyección de estado');
    assert.ok(html.includes('notificarPedidoNuevo'), 'no existen los efectos separados');
    // Y la proyección NO puede estar detrás del dedupe.
    assert.ok(!/if\s*\(\s*!?DEDUPE[^)]*reclamar[^)]*\)\s*\{[\s\S]{0,200}agregarPedido/.test(html),
      'la proyección volvió a quedar detrás del dedupe');
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push(`ERROR FATAL: ${e.message}`);
} finally {
  try { if (srv) await srv.detener(); } catch { /* ya estaba abajo */ }
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-dedupe-nuevo-pedido: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(`  · ${f}`)); }
process.exit(fallidas ? 1 : 0);
