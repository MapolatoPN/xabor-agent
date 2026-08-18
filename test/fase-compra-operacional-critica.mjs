// ─── La compra operacional no puede ser best-effort ─────────────────────────
//
// Efectivo, terminal y pago al recibir entran a operación sin webhook que
// esperar: la comanda sale a cocina y el dinero físico se cobra después. Ese es
// el momento en que Xabor se compromete, y por tanto el momento en que la
// compra tiene que quedar DURABLE.
//
// Antes la marca era `registrarCompraReal(...).catch(log)` y el flujo seguía.
// Un fallo de base dejaba el pedido cocinado, impreso y en el tablero, pero sin
// compra registrada: el cliente volvía a parecer nuevo y podía gastar otra vez
// la promoción de primera compra que ya había usado. Un efecto externo
// irreversible respaldado por un registro que no existe.
//
// REGLA: si no se puede AFIRMAR durablemente la compra, no sale NADA — ni Edge,
// ni `nuevo_pedido` al panel, ni impresión, ni oferta a repartidores. El pedido
// ya está persistido en `pedidos_activos`, así que el retry lo recupera entero.
//
// CÓMO SE COMPRUEBA CADA EFECTO
//
//   · Edge + impresión .... `impresion_trabajos` del folio, que es durable y
//                           compartido con el proceso de prueba;
//   · panel + repartidores  por CONTRATO DE ORDEN sobre el código fuente: la
//                           marca tiene que preceder a emitirComandaDePedidoPorEdge,
//                           al broadcast y a emitirTrabajoImpresion. Se afirma
//                           así, y no observando el WebSocket, porque `/ws/panel`
//                           exige sesión autenticada; el orden es lo que hace
//                           imposible que esos efectos ocurran, y una mutación
//                           que lo altere pone roja esta prueba.
//
// Los cuatro puntos de fallo (A-D) usan `XABOR_PEDIDOS_FALLA_EN`, con el mismo
// candado de producción que el resto del proyecto: inerte salvo en pruebas.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}

const NEG = SEED.negocioA;
const SLUG = 'operacional-critica';
const PUERTO = Number(process.env.TEST_PORT_OC || 4381);
const base = `http://localhost:${PUERTO}`;
const tel = (p) => `899${p}${String(Date.now()).slice(-5)}`;
const tokenNuevo = () => randomBytes(24).toString('hex');

let PRODUCTO = null;
const comprar = (cuerpo) => fetch(`${base}/api/tienda/${SLUG}/checkout`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const carrito = (telefono) => ({
  checkoutToken: tokenNuevo(), items: [{ productoId: PRODUCTO, cantidad: 1 }],
  modalidad: 'recoger', cliente: { nombre: 'Cliente OC', telefono },
  metodoPago: 'efectivo',
});

const comprasDe = async (telefono) => (await pool.query(
  `SELECT * FROM compras_reales WHERE negocio_id=$1 AND cliente_telefono=$2`, [NEG, telefono])).rows;
const pedidoDe = async (folio) => (await pool.query(
  `SELECT estado, datos, created_at FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`,
  [folio, NEG])).rows[0] || null;
const trabajosDe = async (folio) => (await pool.query(
  `SELECT id, estado FROM impresion_trabajos WHERE negocio_id=$1 AND origen_id=$2`,
  [NEG, folio])).rows;

async function esperar(cond, que, ms = 10000) {
  const lim = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > lim) throw new Error(`tiempo agotado esperando: ${que}`);
    await new Promise(r => setTimeout(r, 120));
  }
}

async function montarImpresion() {
  const { crearEdge } = await import('../src/services/edgeService.js');
  const { crearImpresora, crearRuta } = await import('../src/services/impresionService.js');
  const { DESTINOS } = await import('../src/services/impresionSelfService.js');
  await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [NEG]);
  const term = await crearEdge(NEG, { nombre: 'OC PRINT' });
  const imp = await crearImpresora(NEG, {
    terminalId: term.id, nombre: 'Impresora OC', transporte: 'windows_spooler',
    anchoColumnas: 42, config: { spoolerNombre: 'Impresora OC' } });
  await crearRuta(NEG, { impresoraId: imp.id, ambito: 'documento', clave: DESTINOS.cocina.clave });
}

async function limpiar() {
  await pool.query(`DELETE FROM compras_reales WHERE negocio_id=$1 AND origen <> 'legacy_desconocido'`, [NEG]);
  await pool.query(`DELETE FROM tienda_pedidos WHERE negocio_id=$1`, [NEG]);
  await pool.query(
    `DELETE FROM pedidos_activos WHERE negocio_id=$1 AND datos->>'canal'='tienda_online'`, [NEG]);
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM impresoras WHERE negocio_id=$1`, [NEG]);
  await pool.query(
    `DELETE FROM edge_emparejamientos WHERE terminal_id IN
      (SELECT t.id FROM terminales t JOIN sucursales s ON s.id=t.sucursal_id
        WHERE s.negocio_id=$1 AND t.nombre='OC PRINT')`, [NEG]);
  await pool.query(
    `DELETE FROM terminales WHERE nombre='OC PRINT' AND sucursal_id IN
      (SELECT id FROM sucursales WHERE negocio_id=$1)`, [NEG]);
  await pool.query(`DELETE FROM tienda_productos WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM tienda_config WHERE negocio_id=$1`, [NEG]);
  await pool.query(
    `DELETE FROM menu_productos WHERE categoria_id IN
      (SELECT id FROM menu_categorias WHERE negocio_id=$1 AND nombre='OpCritica (test)')`, [NEG]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre='OpCritica (test)'`, [NEG]);
}

async function preparar() {
  await limpiar();
  for (const m of ['tienda_online', 'pos', 'menu']) {
    await pool.query(
      `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
       ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [NEG, m]);
  }
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden)
     VALUES ($1,'OpCritica (test)',TRUE,942) RETURNING id`, [NEG]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
     VALUES ($1,$2,'Producto OC',250,TRUE,1) RETURNING id`, [NEG, cat.id]);
  PRODUCTO = p.id;
  await pool.query(
    `INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)`, [NEG, PRODUCTO]);
  const reglas = {
    horarios: Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo']
      .map(d => [d, { abierto: true, apertura: '00:00', cierre: '23:59' }])),
    pedidos: { costo_envio: 0, pedido_minimo_entrega: 0, tiempo_preparacion_minutos: 10 },
  };
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'reglas_atencion',$2)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor=$2`, [NEG, JSON.stringify(reglas)]);
  await pool.query(`UPDATE metodos_pago SET habilitado=FALSE WHERE negocio_id=$1`, [NEG]);
  await pool.query(
    `INSERT INTO metodos_pago (negocio_id, tipo, habilitado) VALUES ($1,'efectivo',TRUE)
     ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado=TRUE`, [NEG]);
  await pool.query(
    `INSERT INTO tienda_config (negocio_id, estado, slug_publico, titular, modalidades)
     VALUES ($1,'publicada',$2,'OC',$3)
     ON CONFLICT (negocio_id) DO UPDATE SET estado='publicada', slug_publico=$2, modalidades=$3`,
    [NEG, SLUG, JSON.stringify(['recoger'])]);
  await montarImpresion();
}

const ENV_BASE = {
  PORT: String(PUERTO), XABOR_RUTAS_PRUEBA: '1',
  XABOR_TIENDA_LIMITE_CHECKOUT: '2000', XABOR_TIENDA_LIMITE_LECTURA: '5000',
  XABOR_URL_PUBLICA: base,
};

let srv = null;
const levantar = async (extra = {}) => {
  srv = await arrancarServidor({ ...ENV_BASE, ...extra }, { timeoutMs: 90000 });
};
const bajar = async () => { try { if (srv) await srv.detener(); } catch { /* ya estaba abajo */ } srv = null; };

/**
 * Compra en efectivo. Devuelve { status, folio }.
 *
 * Con un fallo inyectado el checkout responde ERROR, y eso es lo correcto: la
 * emision va dentro de `derivacionCritica`, asi que Xabor no le dice al cliente
 * "tu pedido esta hecho" cuando no pudo confirmar la comanda. El folio se busca
 * en la base por telefono, porque en ese camino la respuesta no lo trae.
 */
async function comprarEfectivo(telefono) {
  const r = await comprar(carrito(telefono));
  if (r.body?.folio) return { status: r.status, folio: r.body.folio };
  const { rows } = await pool.query(
    `SELECT folio FROM pedidos_activos
      WHERE negocio_id=$1 AND datos->'cliente'->>'telefono'=$2
      ORDER BY created_at DESC LIMIT 1`, [NEG, telefono]);
  return { status: r.status, folio: rows[0]?.folio || null };
}

/** Ningún efecto externo pudo ocurrir para este folio. */
async function sinEfectosExternos(status, folio, telefono) {
  assert.notStrictEqual(status, 200,
    'el checkout respondio EXITO sin poder afirmar la compra ni emitir la comanda');
  assert.strictEqual((await comprasDe(telefono)).length, 0,
    'quedo una compra registrada pese al fallo');
  if (folio) {
    assert.strictEqual((await trabajosDe(folio)).length, 0,
      'salio un trabajo de impresion pese a que la compra no quedo durable');
  }
  // El pedido puede quedar durable (para el retry) o revertirse con el
  // checkout. Ambas son fail closed; lo que no puede haber es efecto externo
  // sin compra, que es lo que se acaba de comprobar.
}

try {
  await preparar();

  // ═══ A — FALLA LEER LA IDENTIDAD DEL PEDIDO ══════════════════════════════
  await levantar({ XABOR_PEDIDOS_FALLA_EN: 'antes_creado_at' });
  await t('A. falla obtener created_at: cero comanda, cero impresion, pedido recuperable', async () => {
    const T = tel('40');
    const { status, folio } = await comprarEfectivo(T);
    await new Promise(r => setTimeout(r, 800));   // margen para efectos tardios
    await sinEfectosExternos(status, folio, T);
  });
  await bajar();

  // ═══ C — FALLA EL INSERT DE LA COMPRA ════════════════════════════════════
  await levantar({ XABOR_PEDIDOS_FALLA_EN: 'antes_compra_real' });
  await t('C. falla el INSERT de compras_reales: cero comanda, cero impresion', async () => {
    const T = tel('41');
    const { status, folio } = await comprarEfectivo(T);
    await new Promise(r => setTimeout(r, 800));   // margen para efectos tardios
    await sinEfectosExternos(status, folio, T);
  });
  await bajar();

  // ═══ D — CRASH DESPUÉS DEL COMMIT DE LA COMPRA ═══════════════════════════
  await levantar({ XABOR_PEDIDOS_FALLA_EN: 'despues_compra_real' });
  await t('D. la compra COMMITEA y el proceso muere antes de Edge', async () => {
    const T = tel('42');
    const { folio } = await comprarEfectivo(T);
    assert.ok(folio, 'el pedido no quedo durable: no hay nada que reintentar');
    await esperar(async () => (await comprasDe(T)).length === 1, 'la compra committeada');
    await new Promise(r => setTimeout(r, 800));

    assert.strictEqual((await comprasDe(T)).length, 1);
    assert.strictEqual((await trabajosDe(folio)).length, 0,
      'la comanda salio pese a que el proceso murio antes de Edge');
    // El pedido sigue durable: el retry puede terminar la operacion.
    assert.ok(await pedidoDe(folio));
    globalThis.__folioD = folio; globalThis.__telD = T;
  });
  await bajar();

  // ═══ RETRY: una compra, una comanda ══════════════════════════════════════
  await levantar();
  await t('D-retry: reemitir tras el crash NO duplica la compra y SI termina la comanda', async () => {
    const folio = globalThis.__folioD, T = globalThis.__telD;
    assert.ok(folio, 'el caso D no dejo pedido que reintentar');

    const fila = await pedidoDe(folio);
    const { emitirPedido } = await import('../src/orders/orderManager.js');
    await emitirPedido({ ...fila.datos, id: folio, negocioId: NEG, estado: fila.estado });

    await esperar(async () => (await trabajosDe(folio)).length >= 1, 'la comanda del retry');
    assert.strictEqual((await comprasDe(T)).length, 1,
      'el retry duplico la compra: la identidad no protegio la idempotencia');
    assert.strictEqual((await trabajosDe(folio)).length, 1,
      'el retry genero mas de una comanda');
  });

  // ═══ B — created_at NULL (el pedido ya no esta en el tablero) ════════════
  await t('B. sin identidad del pedido: fail closed, ni compra ni comanda', async () => {
    const T = tel('43');
    const folio = `XAB-FANTASMA-${Date.now()}`;
    const { registrarCompraReal, obtenerCreadoAtPedidoActivo } = await import('../src/services/database.js');

    assert.strictEqual(await obtenerCreadoAtPedidoActivo(NEG, folio), null,
      'el fixture no reproduce la ausencia de identidad');
    const r = await registrarCompraReal(null,
      { negocioId: NEG, folio, telefono: T, origen: 'operacion', pedidoCreadoAt: null });
    assert.strictEqual(r.ok, false, 'se escribio una compra con identidad inventada');
    assert.strictEqual(r.razon, 'sin_identidad');
    assert.strictEqual((await comprasDe(T)).length, 0);

    // Y emitirPedido no puede continuar con un pedido sin fila durable.
    const { emitirPedido } = await import('../src/orders/orderManager.js');
    await assert.rejects(
      () => emitirPedido({ id: folio, negocioId: NEG, estado: 'nuevo',
                           cliente: { telefono: T, nombre: 'Fantasma' }, items: [], total: 100 }),
      /COMPRA_NO_DURABLE/,
      'emitirPedido siguio adelante sin poder afirmar la compra');
    assert.strictEqual((await trabajosDe(folio)).length, 0);
  });

  // ═══ EL ORDEN ES EL INVARIANTE ═══════════════════════════════════════════
  await t('el contrato de orden: la marca precede a TODOS los efectos externos', async () => {
    // Los casos de arriba comprueban impresion (durable y observable). El
    // evento de panel y la oferta a repartidores no se pueden observar sin
    // sesion autenticada, asi que se afirma lo que los hace imposibles: que
    // ocurren DESPUES de la marca, y que la marca lanza en vez de seguir.
    // P0-11: el orden real ahora vive en `_ejecutarEfectosOperacionales`
    // (el nucleo idempotente que `emitirPedido` ejecuta bajo el claim de la
    // deuda de emision) -- ya no dentro de `emitirPedido` mismo, que hoy solo
    // reclama la deuda y delega. El invariante (la marca precede a TODOS los
    // efectos, y el fallo se propaga) sigue siendo el mismo, solo cambio de
    // funcion.
    const src = readFileSync(join(__dirname, '..', 'src', 'orders', 'orderManager.js'), 'utf8');
    const iNucleo = src.indexOf('async function _ejecutarEfectosOperacionales');
    assert.ok(iNucleo > 0, 'orderManager.js ya no tiene _ejecutarEfectosOperacionales: revisar donde vive el nucleo de emitirPedido ahora');
    const cuerpo = src.slice(iNucleo, src.indexOf('export async function emitirPedido'));

    const iMarca = cuerpo.indexOf('registrarCompraReal');
    const iEdge = cuerpo.indexOf('emitirComandaDePedidoPorEdge(pedido)');
    const iPanel = cuerpo.indexOf("tipo: 'nuevo_pedido'");
    const iPrint = cuerpo.indexOf('emitirTrabajoImpresion(pedido)');
    const iReparto = cuerpo.indexOf('notificarRepartidoresPorWA');

    assert.ok(iMarca > 0, 'emitirPedido dejo de registrar la compra real');
    for (const [nombre, i] of [['Edge', iEdge], ['panel', iPanel],
                               ['impresion', iPrint], ['repartidores', iReparto]]) {
      assert.ok(i > 0, `no se encontro el efecto: ${nombre}`);
      assert.ok(iMarca < i, `la marca de compra dejo de preceder a ${nombre}`);
    }
    // Y el fallo se propaga: nada de volver al `.catch(log)` que continuaba.
    assert.ok(/COMPRA_NO_DURABLE/.test(cuerpo),
      'emitirPedido ya no falla cuando la compra no queda durable');
    assert.ok(!/registrarCompraReal[\s\S]{0,400}?\.catch\(e => console\.error/.test(cuerpo),
      'la marca volvio a ser best-effort: su error se traga y el flujo continua');
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL');
} finally {
  await bajar();
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-compra-operacional-critica: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('Fallos: ' + fallos.join(' | ')); }
process.exit(fallidas ? 1 : 0);
