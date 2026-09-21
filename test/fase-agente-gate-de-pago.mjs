// ─── EL GATE DE PAGO DEL AGENTE ───────────────────────────────────────────
//
// P0 Invariante 4, dicha en `orderManager.js`: «un pedido `pendiente_pago`
// NUNCA emite comanda, ni impresión, ni oferta a repartidores». Es la regla
// que impide que la cocina empiece a trabajar sobre dinero que todavía no
// existe.
//
// El agente crea pedidos por una puerta propia (`ordenDesdeElCarrito` ->
// `registrarPedido`), y esa puerta NO fija `requierePagoAnticipado` — la
// bandera que hace nacer el pedido en `pendiente_pago`. Hoy solo la pone el
// checkout de la tienda (`tiendaCheckout.js`). Resultado: un pedido del
// agente con `forma_pago: 'enlace_pago'` nace `nuevo`, y `emitirPedido` lo
// manda a cocina en cuanto el cliente dice «sí» — antes de que exista el
// enlace de Clip, y mucho antes de que nadie pague.
//
// Esta suite fija la regla que debe cumplirse. No es una prueba de regresión
// de algo ya resuelto: es la prueba que faltaba, y nombra el hueco.
//
// ── Por qué importa ahora ────────────────────────────────────────────────
//
// Mientras `enlace_pago` no estuvo disponible para ningún negocio, el gate P0
// de `registrarPedido` rechazaba la orden entera (`FORMA_PAGO_INVALIDA`) y el
// hueco no se podía alcanzar. Desde que un negocio tiene un proveedor de pagos
// activo como principal, sí se alcanza.
//
// ── Qué es real aquí ─────────────────────────────────────────────────────
//
// Todo menos la impresora: Postgres real, `registrarPedido` real con su gate
// P0, `emitirPedido` real con su deuda de emisión, y la lista de métodos de
// pago leída de `metodos_pago` como en producción. El proveedor de pagos se
// declara activo en la BASE de prueba; no se llama a Clip ni se cobra nada.
//
// Uso: DATABASE_URL a un Postgres LOCAL. La suite se niega con cualquier otro.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const HOST = new URL(process.env.DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(HOST)) {
  throw new Error('Esta prueba registra pedidos: solo acepta Postgres local');
}

const { pool, obtenerMetodosPagoDisponibles } = await import('../src/services/database.js');
const { registrarPedido, emitirPedido } = await import('../src/orders/orderManager.js');
const { ordenDesdeElCarrito } = await import('../src/mesero-agente/canalDelAgente.js');

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

const NEG = SEED.negocioD;
const MARCA = 'GATE ';
const IDENT = 'gate-pago-proveedor';
const TEL = '5281990077';
const folios = [];

async function limpiar() {
  for (const f of folios) {
    await pool.query('DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2', [NEG, f]).catch(() => {});
    await pool.query('DELETE FROM compras_reales WHERE negocio_id=$1 AND folio=$2', [NEG, f]).catch(() => {});
    await pool.query("DELETE FROM impresion_trabajos WHERE negocio_id=$1 AND origen_id=$2", [NEG, f]).catch(() => {});
  }
  await pool.query('DELETE FROM menu_productos WHERE negocio_id=$1 AND nombre LIKE $2', [NEG, MARCA + '%']);
  await pool.query('DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre LIKE $2', [NEG, MARCA + '%']);
  await pool.query("DELETE FROM metodos_pago WHERE negocio_id=$1 AND tipo IN ('enlace_pago','efectivo')", [NEG]);
  await pool.query('DELETE FROM integraciones_canal WHERE negocio_id=$1 AND identificador=$2', [NEG, IDENT]);
}
await limpiar();

// ── La carta ─────────────────────────────────────────────────────────────
const { rows: [cat] } = await pool.query(
  'INSERT INTO menu_categorias (negocio_id,nombre,activa,orden) VALUES ($1,$2,TRUE,992) RETURNING id',
  [NEG, MARCA + 'Cat']);
await pool.query(
  'INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio,disponible,orden) VALUES ($1,$2,$3,100,TRUE,0)',
  [NEG, cat.id, MARCA + 'Cafe']);

// ── El proveedor de pagos ACTIVO: lo que hace alcanzable el escenario ────
const { rows: [integ] } = await pool.query(
  `INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo, proveedor, estado, principal, ambiente)
   VALUES ($1,'pagos',$2,'Proveedor de prueba',TRUE,'clip','activo',TRUE,'sandbox') RETURNING id`,
  [NEG, IDENT]);
await pool.query(
  `INSERT INTO metodos_pago (negocio_id, tipo, habilitado, integracion_id, disponible_para_bot, disponible_para_operador, orden)
   VALUES ($1,'enlace_pago',TRUE,$2,TRUE,TRUE,50)`, [NEG, integ.id]);
await pool.query(
  `INSERT INTO metodos_pago (negocio_id, tipo, habilitado, disponible_para_bot, disponible_para_operador, orden)
   VALUES ($1,'efectivo',TRUE,TRUE,TRUE,10)`, [NEG]);

const ordenDe = (formaPago) => ordenDesdeElCarrito({
  negocioId: NEG,
  carrito: {
    items: [{ nombre: MARCA + 'Cafe', cantidad: 1, modificadores: [] }],
    datos: { modalidad: 'recoger en tienda', forma_pago: formaPago,
      cliente: { nombre: 'Gate', telefono: TEL } },
  },
  telefono: TEL, nombre: 'Gate',
});

async function registrar(formaPago) {
  const r = await registrarPedido(ordenDe(formaPago), 'whatsapp');
  const folio = r?.folio || r?.pedido?.id || r?.id || null;
  if (folio) folios.push(folio);
  const { rows: [fila] } = await pool.query(
    'SELECT folio, estado FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2', [NEG, folio]);
  return { resultado: r, folio, fila };
}

try {

await t('G0 el escenario es alcanzable: enlace_pago está disponible para el bot', async () => {
  // Sin esto la suite no probaría nada: el gate P0 rechazaría la orden entera
  // por FORMA_PAGO_INVALIDA y los casos siguientes pasarían por la razón
  // equivocada.
  const tipos = (await obtenerMetodosPagoDisponibles(NEG, { paraBot: true })).map((m) => m.tipo);
  assert.ok(tipos.includes('enlace_pago'),
    `el proveedor tenía que quedar activo; disponibles: ${JSON.stringify(tipos)}`);
});

await t('G1 un pedido con ENLACE DE PAGO nace pendiente_pago', async () => {
  const { fila } = await registrar('enlace_pago');
  assert.equal(fila?.estado, 'pendiente_pago',
    'el pedido nació cobrable y la cocina puede empezar sin que el cliente haya pagado');
});

await t('G2 y su comanda NO se emite hasta que el dinero esté confirmado', async () => {
  const { resultado, folio, fila } = await registrar('enlace_pago');
  const em = await emitirPedido({ ...resultado, id: folio, negocioId: NEG, estado: fila?.estado });
  assert.equal(em?.bloqueadoPorPago, true,
    'emitirPedido mandó la comanda de un pedido que nadie ha pagado');
  assert.equal(em?.seHizoCargo, false);

  const { rows } = await pool.query(
    "SELECT id FROM impresion_trabajos WHERE negocio_id=$1 AND origen_tipo='pedido' AND origen_id=$2",
    [NEG, folio]);
  assert.deepEqual(rows, [], 'se creó un trabajo de impresión para un pedido sin pagar');
});

await t('G3 el EFECTIVO no cambia: ahí el negocio ya se comprometió', async () => {
  // El gate es para el dinero que todavía no existe. Con efectivo, terminal o
  // pago al recibir, la comanda sale como siempre: no hay webhook que esperar
  // y esperarlo sería esperar algo que nunca llega.
  const { resultado, folio, fila } = await registrar('efectivo');
  assert.notEqual(fila?.estado, 'pendiente_pago', 'un pedido en efectivo no puede quedar esperando dinero');
  const em = await emitirPedido({ ...resultado, id: folio, negocioId: NEG, estado: fila?.estado });
  assert.ok(!em?.bloqueadoPorPago, 'el efectivo quedó bloqueado detrás de un pago que no existe');
});

await t('G4 la orden del agente declara que el pago va por delante', async () => {
  // La causa raíz, dicha donde se puede leer: `ordenDesdeElCarrito` es quien
  // tiene que declararlo, porque es quien sabe con qué va a pagar el cliente.
  // `registrarPedido` solo obedece a esa bandera (orderManager.js:338).
  assert.equal(ordenDe('enlace_pago').requierePagoAnticipado, true,
    'la orden no declara pago anticipado, así que el pedido nace cobrable');
  assert.notEqual(ordenDe('efectivo').requierePagoAnticipado, true,
    'el efectivo no puede declarar pago anticipado');
});

} finally {
  await limpiar();
  await pool.end().catch(() => {});
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`PASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
