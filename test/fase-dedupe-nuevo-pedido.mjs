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
function cargarDedupeDelPanel() {
  const codigo = readFileSync(join(__dirname, '..', 'panel', 'dedupeEventos.js'), 'utf8');
  const almacenado = new Map();
  const fakeWindow = {
    localStorage: {
      getItem: (k) => (almacenado.has(k) ? almacenado.get(k) : null),
      setItem: (k, v) => almacenado.set(k, String(v)),
      removeItem: (k) => almacenado.delete(k),
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', `${codigo}\n;window.__ok = true;`)(fakeWindow);
  assert.strictEqual(fakeWindow.__ok, true, 'el módulo del panel no se ejecutó');
  return { api: fakeWindow.XaborDedupeEventos, almacenado, fakeWindow };
}

/** Panel simulado: cuenta EFECTOS, no mensajes recibidos. */
function panelSimulado(negocioId, dedupeApi) {
  const dedupe = dedupeApi.crear(negocioId);
  const efectos = { tarjetas: new Set(), sonidos: 0, contador: 0, impresiones: 0, cuentasFinales: 0 };
  return {
    dedupe,
    efectos,
    // Copia fiel de la rama del panel: reclamar y, solo entonces, actuar.
    recibir(msg) {
      if (msg.tipo !== 'nuevo_pedido') return;
      if (!dedupe.reclamar(msg.eventId)) return;
      if (msg.pedido?.tipo_comanda === 'cuenta_final') {
        efectos.cuentasFinales++;
        efectos.sonidos++;
        if (!msg.impresionEdge) efectos.impresiones++;
        return;
      }
      efectos.tarjetas.add(msg.pedido.id);
      efectos.contador++;
      efectos.sonidos++;
      if (!msg.impresionEdge) efectos.impresiones++;
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
    const { api } = cargarDedupeDelPanel();
    const panel = panelSimulado(NEG, api);
    const pedido = pedidoDe('DED-0050');
    const msg = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido }, pedido);
    for (let i = 0; i < 50; i++) panel.recibir(msg);
    assert.strictEqual(panel.efectos.tarjetas.size, 1, '50 avisos dejaron más de una tarjeta');
    assert.strictEqual(panel.efectos.contador, 1, 'el contador se incrementó de más');
    assert.strictEqual(panel.efectos.sonidos, 1, 'sonó más de una vez');
    assert.strictEqual(panel.efectos.impresiones, 1, 'se imprimió más de una vez');
  });

  await t('6. dos instancias del backend emiten el mismo pedido: un efecto', () => {
    const { api } = cargarDedupeDelPanel();
    const panel = panelSimulado(NEG, api);
    const pedido = pedidoDe('DED-0060');
    // Cada instancia construye el mensaje por su cuenta. La clave sale igual.
    const deA = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido, impresionEdge: false }, pedido);
    const deB = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido, impresionEdge: true }, pedido);
    assert.strictEqual(deA.eventId, deB.eventId, 'dos instancias produjeron claves distintas');
    panel.recibir(deA);
    panel.recibir(deB);
    assert.strictEqual(panel.efectos.contador, 1);
    assert.strictEqual(panel.efectos.sonidos, 1);
  });

  await t('7. EL CASO CENTRAL: crash tras el broadcast, antes de la marca durable', () => {
    // Proceso A: emite y muere antes de marcar la derivación. Proceso B (el
    // retry) recupera la deuda y vuelve a emitir. El backend manda DOS veces --
    // no puede hacer otra cosa -- y el panel hace UN efecto.
    const { api } = cargarDedupeDelPanel();
    const panel = panelSimulado(NEG, api);
    const pedido = pedidoDe('DED-0070');

    const desdeA = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido }, pedido);
    panel.recibir(desdeA);              // el panel YA lo vio
    // ... aquí muere A, sin escribir la marca ...
    const desdeB = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido }, pedido);
    panel.recibir(desdeB);              // el retry reemite lo mismo

    assert.strictEqual(desdeA.eventId, desdeB.eventId,
      'el retry generó otra identidad: para el panel sería un pedido nuevo');
    assert.strictEqual(panel.efectos.tarjetas.size, 1, 'el pedido apareció dos veces');
    assert.strictEqual(panel.efectos.contador, 1, 'el contador se incrementó dos veces');
    assert.strictEqual(panel.efectos.sonidos, 1, 'sonó dos veces');
    assert.strictEqual(panel.efectos.impresiones, 1, 'se mandó a imprimir dos veces');
  });

  await t('8. F5 del panel: el registro es DURABLE, no un Set de memoria', () => {
    const { api, almacenado } = cargarDedupeDelPanel();
    const pedido = pedidoDe('DED-0080');
    const msg = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido }, pedido);

    const antes = panelSimulado(NEG, api);
    antes.recibir(msg);
    assert.strictEqual(antes.efectos.contador, 1);
    assert.ok(almacenado.size > 0, 'no se persistió nada: al recargar se repetiría el efecto');

    // Recarga: instancia nueva sobre el MISMO almacenamiento.
    const despues = panelSimulado(NEG, api);
    despues.recibir(msg);
    assert.strictEqual(despues.efectos.contador, 0,
      'tras recargar la página el mismo pedido volvió a producir efecto');
    assert.strictEqual(despues.efectos.sonidos, 0);
  });

  await t('9. reconexión: el volcado inicial no vuelve a sonar ni a imprimir', () => {
    const { api } = cargarDedupeDelPanel();
    const panel = panelSimulado(NEG, api);
    const pedidos = ['DED-0091', 'DED-0092', 'DED-0093'].map(f => pedidoDe(f));
    for (const p of pedidos) panel.recibir(conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: p }, p));
    assert.strictEqual(panel.efectos.contador, 3);

    // El panel se reconecta y el servidor le manda TODO lo activo otra vez.
    for (let vuelta = 0; vuelta < 5; vuelta++) {
      for (const p of pedidos) {
        panel.recibir(conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: p, replay: true }, p));
      }
    }
    assert.strictEqual(panel.efectos.contador, 3, 'la reconexión duplicó pedidos');
    assert.strictEqual(panel.efectos.sonidos, 3, 'la reconexión volvió a sonar');
    assert.strictEqual(panel.efectos.impresiones, 3, 'la reconexión volvió a imprimir');
  });

  await t('10. el ticket de CUENTA FINAL también se dedupea', () => {
    const { api } = cargarDedupeDelPanel();
    const panel = panelSimulado(NEG, api);
    const cuenta = { ...pedidoDe('DED-0100'), tipo_comanda: 'cuenta_final' };
    const msg = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: cuenta }, cuenta);
    for (let i = 0; i < 10; i++) panel.recibir(msg);
    assert.strictEqual(panel.efectos.cuentasFinales, 1,
      'el ticket de cuenta final se imprimió más de una vez');
    assert.strictEqual(panel.efectos.impresiones, 1);

    // Y la comanda del MISMO folio sigue siendo un efecto propio.
    const comanda = pedidoDe('DED-0100');
    panel.recibir(conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: comanda }, comanda));
    assert.strictEqual(panel.efectos.tarjetas.size, 1,
      'el ticket de cuenta tapó la comanda del mismo pedido');
  });

  await t('11. un pedido ya despachado NO resucita con un reenvío', () => {
    // El defecto que tenía el panel: dedupeaba mirando si la tarjeta seguía en
    // el DOM. Retirada la tarjeta (pedido entregado), un reenvío la recreaba
    // con sonido e impresión.
    const { api } = cargarDedupeDelPanel();
    const panel = panelSimulado(NEG, api);
    const pedido = pedidoDe('DED-0110');
    const msg = conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido }, pedido);
    panel.recibir(msg);
    panel.efectos.tarjetas.clear();          // el operador lo despachó

    panel.recibir(msg);
    assert.strictEqual(panel.efectos.tarjetas.size, 0,
      'un pedido ya despachado resucitó al llegar un reenvío');
    assert.strictEqual(panel.efectos.sonidos, 1);
    assert.strictEqual(panel.efectos.impresiones, 1);
  });

  await t('12. dos negocios: el evento de A jamás silencia el de B', () => {
    const { api } = cargarDedupeDelPanel();
    const panelA = panelSimulado(NEG, api);
    const panelB = panelSimulado(NEG_B, api);
    const enA = pedidoDe('DED-MISMO-FOLIO', NEG);
    const enB = pedidoDe('DED-MISMO-FOLIO', NEG_B);

    panelA.recibir(conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: enA }, enA));
    panelB.recibir(conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: enB }, enB));

    assert.strictEqual(panelA.efectos.contador, 1);
    assert.strictEqual(panelB.efectos.contador, 1,
      '¡el pedido del negocio B quedó silenciado por el del negocio A!');

    // Y repetirlos sigue sin cruzarse.
    panelA.recibir(conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: enA }, enA));
    panelB.recibir(conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: enB }, enB));
    assert.strictEqual(panelA.efectos.contador, 1);
    assert.strictEqual(panelB.efectos.contador, 1);
  });

  await t('13. sin eventId no se dedupea: nunca se silencia un pedido real', () => {
    const { api } = cargarDedupeDelPanel();
    const panel = panelSimulado(NEG, api);
    const pedido = pedidoDe('DED-0130');
    // Servidor viejo, sin identidad en el mensaje.
    for (let i = 0; i < 3; i++) panel.recibir({ tipo: 'nuevo_pedido', pedido });
    assert.strictEqual(panel.efectos.contador, 3,
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
      const { api } = cargarDedupeDelPanel();
      const panel = panelSimulado(NEG, api);
      for (const m of nuevos) panel.recibir(m);
      assert.strictEqual(panel.efectos.contador, 1,
        `${nuevos.length} mensajes reales produjeron ${panel.efectos.contador} efectos`);
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

    try {
      const { api } = cargarDedupeDelPanel();
      const panel = panelSimulado(NEG, api);
      let vistos = 0;
      // Cinco reconexiones: el servidor vuelca todo lo activo en cada una.
      for (let i = 0; i < 5; i++) {
        const ws = await abrirPanelWS(COOKIE_A);
        const rec = escuchar(ws);
        await esperar(600);
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
      assert.strictEqual(panel.efectos.contador, 1,
        `${vistos} mensajes de reconexion produjeron ${panel.efectos.contador} efectos`);
      assert.strictEqual(panel.efectos.sonidos, 1);
      assert.strictEqual(panel.efectos.impresiones, 1);
    } finally {
      await pool.query(`DELETE FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, NEG]);
    }
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
