// ─── Tienda Online → pago → emisión → ruteo por estación → Edge ─────────────
//
// Encadena, de punta a punta y con el servidor real: checkout de la tienda
// con pago en línea → pendiente_pago → confirmación del pago (la MISMA
// transición que dispara el webhook verificado) → emisión → ruteo por
// categoría → impresion_trabajos → Edge. Con reglas tipo Mapolato:
//
//   Café → Bebidas · Chilaquiles → Chilaquil · Hotcakes → COCINA
//   producto sin regla → fallback: SOLO COCINA, nunca las tres estaciones.
//
// Y las dos piezas de robustez: el rastro `datos.impresion_edge` con su aviso
// de "comanda sin papel", y «Reenviar a cocina» (papel nuevo, pedido intacto).
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { randomBytes } from 'crypto';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');
const { crearEdge, generarEmparejamiento, canjearEmparejamiento } = await import('../src/services/edgeService.js');
const { crearImpresora, crearRuta } = await import('../src/services/impresionService.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG = SEED.negocioA;
const cookie = (usuarioId, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId: NEG, rol }))}`;
const ADMIN = cookie(SEED.adminNegocioAUsuarioId, 'admin');
const STAFF = cookie(SEED.staffNegocioAUsuarioId, 'staff');
const SLUG = 'impresion-edge-e2e';
const SUFIJO = ' (Edge E2E)';
const PUERTO = String(process.env.TEST_PORT_IMPRESION_E2E || 4293);
const base = `http://localhost:${PUERTO}`;
const token = () => randomBytes(24).toString('hex');
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
async function hasta(condicion, { limiteMs = 8000, pasoMs = 60, que = 'la condición' } = {}) {
  const fin = Date.now() + limiteMs;
  while (Date.now() < fin) {
    const v = await condicion();
    if (v) return v;
    await esperar(pasoMs);
  }
  throw new Error(`se agotó la espera de ${que}`);
}

const PRODUCTOS = {};          // nombre → id de menu_productos
let EDGE = null, CRED = null, IMP = {}, RUTA_FALLBACK = null;
// La allow-list de métodos de la tienda es estado COMPARTIDO del negocio A
// entre suites: se fija aquí y se deja como estaba al terminar.
let ALLOWLIST_PREVIA = null, ALLOWLIST_LEIDA = false;

const comprar = (cuerpo) => fetch(`${base}/api/tienda/${SLUG}/checkout`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const carrito = (tk, nombres) => ({
  checkoutToken: tk, items: nombres.map(n => ({ productoId: PRODUCTOS[n], cantidad: 1 })),
  modalidad: 'recoger', cliente: { nombre: 'Cliente Edge E2E', telefono: '8997200001' }, metodoPago: 'enlace_pago',
});
const confirmar = (folio) => fetch(`${base}/test/confirmar-pago-tienda`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ADMIN }, body: JSON.stringify({ folio }),
});
const reenviar = (folio, ck = ADMIN) => fetch(`${base}/api/pedidos/${folio}/reenviar-cocina`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ motivo: 'prueba e2e' }),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

async function pedidoDe(folio) {
  const { rows: [r] } = await pool.query(`SELECT estado, datos FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, NEG]);
  return r || null;
}
async function trabajosDe(folio, origenTipo = 'pedido', origenId = folio) {
  const { rows } = await pool.query(
    `SELECT id, impresora_id, impresora_nombre, estado, payload, reimpreso_por, trabajo_original_id, origen_id, motivo, created_at
       FROM impresion_trabajos WHERE negocio_id = $1 AND origen_tipo = $2 AND origen_id = $3 ORDER BY impresora_nombre`, [NEG, origenTipo, origenId]);
  return rows;
}
const productosDe = (trabajo) => (trabajo.payload?.items || []).map(i => i.producto);
const porImpresora = (trabajos) => Object.fromEntries(trabajos.map(tr => [tr.impresora_nombre, productosDe(tr)]));
async function conteos() {
  const { rows: [p] } = await pool.query(`SELECT count(*)::int AS n FROM pedidos_activos WHERE negocio_id = $1`, [NEG]);
  const { rows: [g] } = await pool.query(`SELECT count(*)::int AS n, COALESCE(sum(monto), 0)::text AS monto FROM pagos WHERE negocio_id = $1`, [NEG]);
  const { rows: [c] } = await pool.query(`SELECT count(*)::int AS n FROM compras_reales WHERE negocio_id = $1`, [NEG]);
  return { pedidos: p.n, pagos: g.n, montoPagos: g.monto, compras: c.n };
}

// Espía del panel: recibe lo mismo que vería el tablero del negocio.
function abrirPanel() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http://', 'ws://') + '/ws/panel', { headers: { Cookie: ADMIN } });
    const to = setTimeout(() => reject(new Error('timeout abriendo WS panel')), 8000);
    ws.on('open', () => { clearTimeout(to); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}
function espiar(ws) {
  const vistos = [];
  ws.on('message', (raw) => { try { vistos.push(JSON.parse(raw.toString())); } catch { /* ruido */ } });
  return vistos;
}

// Un Edge falso: se autentica como la terminal real, recibe trabajos y los
// confirma como 'enviado'. Es el protocolo exacto de edge/connection.js.
function conectarEdgeFalso({ instalacionId }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http://', 'ws://') + '/ws/print-agent');
    const recibidos = [];
    const to = setTimeout(() => reject(new Error('timeout autenticando el Edge falso')), 8000);
    ws.on('open', () => ws.send(JSON.stringify({ tipo: 'autenticar_terminal', terminalId: CRED.terminalId, token: CRED.token, instalacionId })));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.tipo === 'terminal_autenticada') { clearTimeout(to); resolve({ ws, recibidos }); }
      if (m.tipo === 'trabajo_impresion' && m.trabajo?.id) {
        recibidos.push(m.trabajo);
        ws.send(JSON.stringify({ tipo: 'ack_impresion', trabajoId: m.trabajo.id, resultado: 'enviado' }));
      }
      if (m.tipo === 'error') { clearTimeout(to); reject(new Error('el servidor rechazó al Edge falso')); }
    });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

async function conectarProveedor() {
  const { guardarIntegracionPago, marcarProveedorPrincipal } = await import('../src/services/integracionesService.js');
  await guardarIntegracionPago(NEG, 'clip', { apiKey: 'test-api-key-no-real', apiSecret: 'test-api-secret-no-real' }, { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(NEG, 'clip', SEED.superadminUsuarioId);
}

async function limpiar() {
  await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'pagos'`, [NEG]);
  await pool.query(`DELETE FROM pagos WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM impresoras WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM edge_instalaciones WHERE terminal_id IN (SELECT t.id FROM terminales t JOIN sucursales s ON s.id = t.sucursal_id WHERE s.negocio_id = $1)`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM terminales WHERE sucursal_id IN (SELECT id FROM sucursales WHERE negocio_id = $1)`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM tienda_pedidos WHERE negocio_id = $1`, [NEG]);
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'canal' = 'tienda_online'`, [NEG]);
  await pool.query(`DELETE FROM tienda_productos WHERE negocio_id = $1`, [NEG]);
  await pool.query(`DELETE FROM tienda_config WHERE negocio_id = $1`, [NEG]);
  await pool.query(
    `DELETE FROM menu_productos WHERE categoria_id IN (SELECT id FROM menu_categorias WHERE negocio_id = $1 AND nombre LIKE $2)`, [NEG, '%' + SUFIJO]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre LIKE $2`, [NEG, '%' + SUFIJO]);
}

async function montarMenu() {
  const menu = [
    ['Bebidas', 'Café', 45], ['Chilaquiles', 'Chilaquiles verdes', 120], ['Desayunos', 'Hotcakes', 95], ['Postres', 'Flan sin regla', 60],
  ];
  let orden = 980;
  for (const [categoria, producto, precio] of menu) {
    const { rows: [cat] } = await pool.query(
      `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,$3) RETURNING id`, [NEG, categoria + SUFIJO, orden++]);
    const { rows: [p] } = await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden) VALUES ($1,$2,$3,$4,TRUE,1) RETURNING id`,
      [NEG, cat.id, producto + SUFIJO, precio]);
    PRODUCTOS[producto] = p.id;
    await pool.query(`INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)`, [NEG, p.id]);
  }
}

// Reglas tipo Mapolato. El fallback (documento:comanda) SOLO en COCINA.
async function montarImpresion() {
  await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal') ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [NEG]);
  EDGE = await crearEdge(NEG, { nombre: 'PC Edge E2E' });
  const { codigo } = await generarEmparejamiento(NEG, EDGE.id);
  CRED = await canjearEmparejamiento(codigo);
  for (const nombre of ['Bebidas', 'Chilaquil', 'COCINA']) {
    IMP[nombre] = await crearImpresora(NEG, { terminalId: EDGE.id, nombre, transporte: 'mock', anchoColumnas: 42 });
  }
  await crearRuta(NEG, { impresoraId: IMP.Bebidas.id, ambito: 'categoria', clave: 'Bebidas' + SUFIJO });
  await crearRuta(NEG, { impresoraId: IMP.Chilaquil.id, ambito: 'categoria', clave: 'Chilaquiles' + SUFIJO });
  await crearRuta(NEG, { impresoraId: IMP.COCINA.id, ambito: 'categoria', clave: 'Desayunos' + SUFIJO });
  RUTA_FALLBACK = await crearRuta(NEG, { impresoraId: IMP.COCINA.id, ambito: 'documento', clave: 'comanda' });
}

async function preparar() {
  await limpiar();
  for (const m of ['tienda_online', 'pos', 'menu']) {
    await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo') ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [NEG, m]);
  }
  await montarMenu();
  const reglas = {
    horarios: Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo'].map(d => [d, { abierto: true, apertura: '00:00', cierre: '23:59' }])),
    pedidos: { costo_envio: 0, pedido_minimo_entrega: 0, tiempo_preparacion_minutos: 10 },
  };
  await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'reglas_atencion',$2) ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`, [NEG, JSON.stringify(reglas)]);
  await pool.query(`UPDATE metodos_pago SET habilitado = FALSE WHERE negocio_id = $1`, [NEG]);
  await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado) VALUES ($1,'enlace_pago',TRUE) ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [NEG]);
  const { rows: [previa] } = await pool.query(`SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'tienda_metodos_pago'`, [NEG]);
  ALLOWLIST_PREVIA = previa ? previa.valor : null;
  ALLOWLIST_LEIDA = true;
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'tienda_metodos_pago',$2)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`, [NEG, JSON.stringify(['enlace_pago'])]);
  await pool.query(
    `INSERT INTO tienda_config (negocio_id, estado, slug_publico, titular, modalidades) VALUES ($1,'publicada',$2,'Edge E2E',$3)
     ON CONFLICT (negocio_id) DO UPDATE SET estado='publicada', slug_publico=$2, modalidades=$3`, [NEG, SLUG, JSON.stringify(['recoger'])]);
  await montarImpresion();
  await conectarProveedor();
}

let srv = null, panel = null, eventos = [];
let FOLIO = null;
try {
  await preparar();
  srv = await arrancarServidor({ PORT: PUERTO, XABOR_RUTAS_PRUEBA: '1' }, { timeoutMs: 90000 });
  panel = await abrirPanel();
  eventos = espiar(panel);

  await t('1. checkout con pago en línea: nace pendiente_pago, cero trabajos y el tablero no lo ve', async () => {
    const r = await comprar(carrito(token(), ['Café', 'Chilaquiles verdes', 'Hotcakes', 'Flan sin regla']));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    FOLIO = r.body.folio;
    const p = await pedidoDe(FOLIO);
    assert.strictEqual(p.estado, 'pendiente_pago', `nació '${p.estado}'`);
    await esperar(600);
    assert.strictEqual((await trabajosDe(FOLIO)).length, 0, '¡SE IMPRIMIÓ ANTES DE PAGAR!');
    assert.ok(!eventos.some(e => e.tipo === 'nuevo_pedido' && e.pedido?.id === FOLIO), 'el tablero recibió un pedido sin pagar');
    assert.strictEqual(p.datos.impresion_edge, undefined, 'no debe haber rastro de impresión antes de emitir');
  });

  await t('2. al confirmar el pago sale UNA comanda por estación: Café→Bebidas, Chilaquiles→Chilaquil, Hotcakes→COCINA', async () => {
    const rc = await confirmar(FOLIO);
    assert.strictEqual(rc.status, 200, await rc.text());
    const trabajos = await hasta(async () => { const x = await trabajosDe(FOLIO); return x.length >= 3 ? x : null; }, { que: 'las comandas' });
    assert.strictEqual((await pedidoDe(FOLIO)).estado, 'nuevo', 'no pasó a cocina');
    assert.strictEqual(trabajos.length, 3, `salieron ${trabajos.length} trabajos: ${trabajos.map(x => x.impresora_nombre).join(', ')}`);
    const mapa = porImpresora(trabajos);
    assert.deepStrictEqual(mapa.Bebidas, ['Café' + SUFIJO], 'Bebidas recibe solo el café');
    assert.deepStrictEqual(mapa.Chilaquil, ['Chilaquiles verdes' + SUFIJO], 'Chilaquil recibe solo los chilaquiles');
    assert.ok(mapa.COCINA.includes('Hotcakes' + SUFIJO), 'COCINA recibe los hotcakes');
    assert.ok(trabajos.every(x => x.estado === 'pendiente'), 'sin Edge conectado los trabajos esperan pendientes');
  });

  await t('3. el producto sin regla cae SOLO en COCINA: ni Bebidas ni Chilaquil lo reciben', async () => {
    const mapa = porImpresora(await trabajosDe(FOLIO));
    const flan = 'Flan sin regla' + SUFIJO;
    assert.ok(mapa.COCINA.includes(flan), 'COCINA debe recibir el producto sin regla (fallback)');
    assert.ok(!mapa.Bebidas.includes(flan), '¡el producto sin regla salió en Bebidas!');
    assert.ok(!mapa.Chilaquil.includes(flan), '¡el producto sin regla salió en Chilaquil!');
    const veces = Object.values(mapa).filter(items => items.includes(flan)).length;
    assert.strictEqual(veces, 1, `el producto sin regla salió en ${veces} estaciones`);
  });

  await t('4. el pedido guarda datos.impresion_edge y el panel recibe nuevo_pedido con impresionEdge=true y el rastro', async () => {
    const p = await hasta(async () => { const x = await pedidoDe(FOLIO); return x?.datos?.impresion_edge ? x : null; }, { que: 'el rastro durable' });
    const ie = p.datos.impresion_edge;
    assert.strictEqual(ie.estado, 'creado');
    assert.strictEqual(ie.trabajos, 3);
    assert.strictEqual(ie.duplicados, 0);
    assert.deepStrictEqual([...ie.impresoras].sort(), ['Bebidas', 'COCINA', 'Chilaquil']);
    assert.deepStrictEqual(ie.sin_ruta, []);
    assert.strictEqual(ie.alerta, false);
    assert.ok(ie.at, 'sin marca de tiempo');
    const ev = await hasta(async () => eventos.find(e => e.tipo === 'nuevo_pedido' && e.pedido?.id === FOLIO) || null, { que: 'nuevo_pedido en el panel' });
    assert.strictEqual(ev.impresionEdge, true, 'el panel debe saber que Edge se hizo cargo (no imprime desde el navegador)');
    assert.strictEqual(ev.pedido.impresion_edge?.estado, 'creado', 'el rastro viaja con el pedido al panel');
  });

  await t('5. cinco confirmaciones repetidas del mismo pago (webhook reintentado) dejan las mismas 3 comandas', async () => {
    await Promise.all([1, 2, 3, 4, 5].map(() => confirmar(FOLIO)));
    await esperar(900);
    const trabajos = await trabajosDe(FOLIO);
    assert.strictEqual(trabajos.length, 3, `las confirmaciones repetidas dejaron ${trabajos.length} trabajos`);
    const ie = (await pedidoDe(FOLIO)).datos.impresion_edge;
    assert.ok(['creado', 'ya_existia'].includes(ie.estado), `estado del rastro: ${ie.estado}`);
    assert.strictEqual(ie.alerta, false);
  });

  await t('5b. reemitir el mismo pedido (recuperación tras un crash) no crea trabajos: la clave de idempotencia los reconoce como duplicados', async () => {
    // Las confirmaciones repetidas las frena la transición de pago; esto
    // ejercita la ÚLTIMA defensa: el recovery operacional vuelve a correr el
    // núcleo con el mismo pedido y el trabajo ya existe.
    const { crearTrabajosDePedido } = await import('../src/services/impresionService.js');
    const p = await pedidoDe(FOLIO);
    const r = await crearTrabajosDePedido({ negocioId: NEG, pedido: { ...p.datos, id: FOLIO, negocioId: NEG } });
    assert.strictEqual(r.creados.length, 0, `la reemisión creó ${r.creados.length} trabajo(s) nuevos`);
    assert.strictEqual(r.duplicados.length, 3, 'debe reconocer los 3 trabajos existentes');
    assert.strictEqual((await trabajosDe(FOLIO)).length, 3);
  });

  await t('6. Reenviar a cocina: 3 trabajos NUEVOS de reimpresión con quién y cuándo; ni pedido nuevo, ni pago, ni compra tocados', async () => {
    const antes = await conteos();
    const originales = await trabajosDe(FOLIO);
    const r = await reenviar(FOLIO);
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.reenvio, 1);
    assert.strictEqual(r.body.repetido, false);
    assert.strictEqual(r.body.trabajos, 3, JSON.stringify(r.body));
    assert.deepStrictEqual([...r.body.impresoras].sort(), ['Bebidas', 'COCINA', 'Chilaquil']);
    const nuevos = await trabajosDe(FOLIO, 'pedido_reimpresion', `${FOLIO}#1`);
    assert.strictEqual(nuevos.length, 3, 'el reenvío debe crear un trabajo por estación');
    for (const n of nuevos) {
      assert.strictEqual(n.reimpreso_por, SEED.adminNegocioAUsuarioId, 'debe quedar quién reimprimió');
      assert.strictEqual(n.motivo, 'prueba e2e');
      assert.strictEqual(n.payload.reimpresion, true);
      assert.strictEqual(n.payload.reenvio, 1);
      const original = originales.find(o => o.impresora_id === n.impresora_id);
      assert.strictEqual(n.trabajo_original_id, original?.id, 'debe apuntar al trabajo original de esa impresora');
      assert.ok(n.created_at, 'debe quedar cuándo');
    }
    assert.deepStrictEqual(porImpresora(nuevos), porImpresora(originales), 'mismo ruteo que la comanda original');
    assert.strictEqual((await trabajosDe(FOLIO)).length, 3, 'los trabajos originales no se tocan');
    const despues = await conteos();
    assert.deepStrictEqual(despues, antes, `el reenvío alteró pedidos/pagos/compras: ${JSON.stringify({ antes, despues })}`);
    const p = await pedidoDe(FOLIO);
    assert.strictEqual(p.estado, 'nuevo', 'el reenvío no cambia el estado del pedido');
    assert.strictEqual(p.datos.impresion_edge.estado, 'creado', 'el rastro original se conserva');
    assert.strictEqual(p.datos.impresion_edge.reenvios, 1);
    assert.strictEqual(p.datos.impresion_edge.ultimo_reenvio?.por, SEED.adminNegocioAUsuarioId);
  });

  await t('7. un segundo reenvío inmediato no imprime otra vez; pasado el tiempo crea el reenvío #2', async () => {
    const r2 = await reenviar(FOLIO);
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
    assert.strictEqual(r2.body.repetido, true, 'dos clics seguidos no son dos comandas');
    assert.strictEqual(r2.body.trabajos, 0);
    const { rows: [c] } = await pool.query(
      `SELECT count(*)::int AS n FROM impresion_trabajos WHERE negocio_id = $1 AND origen_tipo = 'pedido_reimpresion' AND origen_id LIKE $2`, [NEG, `${FOLIO}#%`]);
    assert.strictEqual(c.n, 3, `el segundo clic creó trabajos: ${c.n}`);
    // El tiempo pasa: el reenvío #1 queda fuera de la ventana anti-doble-clic.
    await pool.query(`UPDATE impresion_trabajos SET created_at = created_at - interval '1 minute' WHERE negocio_id = $1 AND origen_tipo = 'pedido_reimpresion' AND origen_id = $2`, [NEG, `${FOLIO}#1`]);
    const r3 = await reenviar(FOLIO);
    assert.strictEqual(r3.status, 201, JSON.stringify(r3.body));
    assert.strictEqual(r3.body.reenvio, 2);
    assert.strictEqual((await trabajosDe(FOLIO, 'pedido_reimpresion', `${FOLIO}#2`)).length, 3);
    assert.strictEqual((await pedidoDe(FOLIO)).datos.impresion_edge.reenvios, 2);
  });

  await t('8. reenviar exige admin (staff 403), rechaza un pedido sin pagar (409) y un folio inexistente (404)', async () => {
    const staff = await reenviar(FOLIO, STAFF);
    assert.strictEqual(staff.status, 403, `staff obtuvo ${staff.status}`);
    const sinPagar = await comprar(carrito(token(), ['Café']));
    assert.strictEqual(sinPagar.status, 200, JSON.stringify(sinPagar.body));
    const r = await reenviar(sinPagar.body.folio);
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'PAGO_PENDIENTE');
    assert.strictEqual((await trabajosDe(sinPagar.body.folio, 'pedido_reimpresion', `${sinPagar.body.folio}#1`)).length, 0, '¡reenvió a cocina un pedido sin pagar!');
    const nada = await reenviar('XAB-NOEXISTE');
    assert.strictEqual(nada.status, 404);
  });

  await t('9. comanda pagada sin destino: rastro sin_trabajos con alerta, error en el log del servidor y aviso impresion_sin_trabajo al panel', async () => {
    await pool.query(`DELETE FROM impresion_rutas WHERE id = $1 AND negocio_id = $2`, [RUTA_FALLBACK.id, NEG]);
    try {
      const r = await comprar(carrito(token(), ['Flan sin regla']));
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const folio = r.body.folio;
      await confirmar(folio);
      const p = await hasta(async () => { const x = await pedidoDe(folio); return x?.datos?.impresion_edge ? x : null; }, { que: 'el rastro' });
      const ie = p.datos.impresion_edge;
      assert.strictEqual(ie.estado, 'sin_trabajos', JSON.stringify(ie));
      assert.strictEqual(ie.alerta, true, 'con impresoras activas y cero trabajos, es una alerta');
      assert.ok(ie.sin_ruta.includes('Flan sin regla' + SUFIJO), 'debe decir qué ítem se quedó sin ruta');
      assert.strictEqual((await trabajosDe(folio)).length, 0);
      const aviso = await hasta(async () => eventos.find(e => e.tipo === 'impresion_sin_trabajo' && e.folio === folio) || null, { que: 'el aviso al panel' });
      assert.ok(aviso.sinRuta.includes('Flan sin regla' + SUFIJO));
      const ev = eventos.find(e => e.tipo === 'nuevo_pedido' && e.pedido?.id === folio);
      assert.ok(ev, 'el tablero sí debe ver el pedido pagado');
      assert.strictEqual(ev.impresionEdge, false, 'y saber que Edge NO se hizo cargo');
      assert.ok(srv.obtenerSalida().includes(`COMANDA SIN PAPEL: el pedido ${folio}`), 'debe quedar un error en el log del servidor');
    } finally {
      RUTA_FALLBACK = await crearRuta(NEG, { impresoraId: IMP.COCINA.id, ambito: 'documento', clave: 'comanda' });
    }
  });

  await t('9b. en el navegador: la tarjeta muestra el rastro Edge, «Reenviar a cocina» crea el reenvío #3 y una comanda sin destino pinta el aviso', async () => {
    const puppeteer = (await import('puppeteer')).default;
    // El reenvío #2 sale de la ventana anti doble clic para que el botón cree el #3.
    await pool.query(`UPDATE impresion_trabajos SET created_at = created_at - interval '1 minute' WHERE negocio_id = $1 AND origen_tipo = 'pedido_reimpresion' AND origen_id = $2`, [NEG, `${FOLIO}#2`]);
    const nav = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const errores = [];
    try {
      const pag = await nav.newPage();
      pag.on('pageerror', e => errores.push(e.message));
      pag.on('dialog', d => d.accept().catch(() => {}));
      await pag.setViewport({ width: 1280, height: 900 });
      await pag.setCookie({ name: 'xabor_sesion', value: encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: NEG, rol: 'admin' })), domain: 'localhost', path: '/' });
      // /app a secas abre Inicio; el botón que se prueba vive en el tablero.
      await pag.goto(`${base}/app#pedidos`, { waitUntil: 'networkidle0', timeout: 60000 });
      await pag.waitForSelector(`#comanda-${FOLIO}`, { timeout: 15000 });
      const tarjeta = await pag.$eval(`#comanda-${FOLIO}`, el => el.textContent.replace(/\s+/g, ' '));
      assert.ok(tarjeta.includes('🖨 Edge'), 'la tarjeta debe mostrar el rastro de impresión por Edge');
      assert.ok(tarjeta.includes('Reenviar a cocina'), 'la tarjeta del admin debe tener el botón «Reenviar a cocina»');
      await pag.evaluate(() => { window.confirm = () => true; });
      await pag.click(`#comanda-${FOLIO} button[onclick^="reenviarACocina"]`);
      await pag.waitForFunction((folio) => (document.getElementById('avisos-panel')?.textContent || '').includes(`${folio}: comanda reenviada a`), { timeout: 15000 }, FOLIO);
      assert.strictEqual((await trabajosDe(FOLIO, 'pedido_reimpresion', `${FOLIO}#3`)).length, 3, 'el botón debe crear el reenvío #3 con sus 3 trabajos');
      // Una comanda pagada sin destino, con la página abierta: aviso y tarjeta en rojo.
      await pool.query(`DELETE FROM impresion_rutas WHERE id = $1 AND negocio_id = $2`, [RUTA_FALLBACK.id, NEG]);
      let folioSin = null;
      try {
        const r = await comprar(carrito(token(), ['Flan sin regla']));
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        folioSin = r.body.folio;
        await confirmar(folioSin);
        await pag.waitForFunction((folio) => (document.getElementById('avisos-panel')?.textContent || '').includes(`${folio}: no salió comanda por Edge`), { timeout: 15000 }, folioSin);
        await pag.waitForSelector(`#comanda-${folioSin}`, { timeout: 15000 });
        const sin = await pag.$eval(`#comanda-${folioSin}`, el => el.textContent.replace(/\s+/g, ' '));
        assert.ok(sin.includes('Sin comanda en Edge'), 'la tarjeta debe avisar que no hubo comanda por Edge');
      } finally {
        RUTA_FALLBACK = await crearRuta(NEG, { impresoraId: IMP.COCINA.id, ambito: 'documento', clave: 'comanda' });
      }
      assert.deepStrictEqual(errores, [], 'errores de JavaScript en el panel');
    } finally { await nav.close(); }
  });

  await t('10. Edge desconectado: los trabajos esperan pendientes y al conectar los recibe todos, una sola vez, y quedan enviados', async () => {
    const { rows: pendientes } = await pool.query(
      `SELECT id FROM impresion_trabajos WHERE negocio_id = $1 AND terminal_id = $2 AND estado = 'pendiente'`, [NEG, EDGE.id]);
    assert.ok(pendientes.length >= 9, `esperaba al menos 9 pendientes (3 comanda + 6 reenvíos), hay ${pendientes.length}`);
    const edge = await conectarEdgeFalso({ instalacionId: 'edge-e2e-instalacion-1' });
    try {
      await hasta(() => edge.recibidos.length >= pendientes.length, { que: 'la entrega de los pendientes' });
      await esperar(500);
      const ids = edge.recibidos.map(x => x.id);
      assert.strictEqual(new Set(ids).size, ids.length, 'un trabajo llegó dos veces al Edge');
      assert.deepStrictEqual(new Set(ids), new Set(pendientes.map(x => x.id)), 'llegó algo distinto de los pendientes');
      await hasta(async () => {
        const { rows: [c] } = await pool.query(`SELECT count(*)::int AS n FROM impresion_trabajos WHERE id = ANY($1::uuid[]) AND estado = 'enviado'`, [ids]);
        return c.n === ids.length;
      }, { que: 'los ACK' });
    } finally { edge.ws.close(); }
  });

  await t('11. al reconectar, el Edge no vuelve a recibir lo ya confirmado', async () => {
    await esperar(300);
    const edge = await conectarEdgeFalso({ instalacionId: 'edge-e2e-instalacion-1' });
    try {
      await esperar(900);
      assert.strictEqual(edge.recibidos.length, 0, `reconectar reentregó ${edge.recibidos.length} trabajo(s) ya confirmados`);
    } finally { edge.ws.close(); }
  });
} finally {
  try { panel?.close(); } catch { /* nada */ }
  console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
  if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
  if (srv) srv.detener();
  await limpiar().catch(() => {});
  if (ALLOWLIST_LEIDA) {
    if (ALLOWLIST_PREVIA === null) {
      await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'tienda_metodos_pago'`, [NEG]).catch(() => {});
    } else {
      await pool.query(
        `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'tienda_metodos_pago',$2)
         ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`, [NEG, ALLOWLIST_PREVIA]).catch(() => {});
    }
  }
  await pool.end();
  process.exitCode = fallidas > 0 ? 1 : 0;
}
