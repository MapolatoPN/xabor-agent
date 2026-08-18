// ─── El backfill de la 058 frente a folios reciclados ───────────────────────
//
// El backfill excluye del ledger un pedido histórico si existe una fila en
// `pedidos_activos` con el mismo (negocio_id, folio) que esté `pendiente_pago`
// o cancelada por expiración de pago. Ese par NO identifica una instancia de
// pedido: el folio se recicla.
//
// Escenario que rompía la versión original:
//
//   · el cliente VIEJO compró de verdad con XAB-0042 hace meses;
//   · el tablero se purgó y el contador retrocedió;
//   · el cliente NUEVO recibió también XAB-0042 y no pagó — sigue pendiente.
//
// El `NOT EXISTS` miraba solo el folio, veía el pendiente del cliente NUEVO, y
// borraba retrospectivamente la compra del VIEJO. El error cae del lado caro:
// ese cliente vuelve a parecer primerizo y se le regala la promoción.
//
// QUÉ VÍNCULO DURABLE HAY ENTRE LAS DOS TABLAS — medido, no supuesto:
//   · `pedidos.created_at` vs `pedidos_activos.created_at` para el mismo folio:
//     0 de 6 pares idénticos, delta medio ~234 305 s (unas 65 horas). Son
//     INSERT separados, cada uno con su propio DEFAULT NOW(): no se pueden
//     correlacionar por tiempo.
//   · `pedidos` tiene 337 folios repetidos (1259 filas) en la base local.
//   · No queda ninguna otra clave común: solo (negocio_id, folio), ambiguo por
//     definición en cuanto el folio se reemitió.
//
// POLÍTICA, en consecuencia: se excluye solo lo INEQUÍVOCO — un folio con una
// única fila histórica y un único activo demostrablemente no-compra. En cuanto
// hay ambigüedad manda el riesgo asimétrico ya declarado en la migración:
// AMBIGUO LEGACY → cuenta como compra (`legacy_desconocido`). Negar un
// descuento es revisable a mano; regalar dinero no tiene vuelta atrás.
//
// La prueba ejecuta el SQL REAL de migrations/058_compras_reales.sql, no una
// reimplementación: si el archivo cambia, esta suite lo nota.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

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
const marca = String(Date.now()).slice(-6);
const tel = (p) => `899${p}${marca}`.slice(0, 10);

/**
 * Extrae el INSERT del backfill del archivo de migración REAL y lo ejecuta.
 * Nada de reescribir la consulta aquí: eso probaría mi copia, no el SQL que se
 * aplicará en producción.
 */
function sqlDelBackfill() {
  const sql = readFileSync(join(__dirname, '..', 'migrations', '058_compras_reales.sql'), 'utf8');
  const i = sql.indexOf('INSERT INTO compras_reales');
  assert.ok(i > 0, 'no se encontró el INSERT del backfill en la migración');
  const fin = sql.indexOf(';', sql.indexOf('ON CONFLICT', i));
  assert.ok(fin > i, 'no se encontró el final del INSERT del backfill');
  return sql.slice(i, fin + 1);
}

const compras = async (telefono) => (await pool.query(
  `SELECT folio, origen, pedido_creado_at FROM compras_reales
    WHERE negocio_id=$1 AND cliente_telefono=$2`, [NEG, telefono])).rows;

async function crearCliente(telefono, nombre) {
  await pool.query(
    `INSERT INTO clientes (telefono, nombre, negocio_id) VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING`, [telefono, nombre, NEG]);
}
async function historico(folio, telefono, hace) {
  await pool.query(
    `INSERT INTO pedidos (folio, telefono, nombre_cliente, items, total, modalidad,
                          canal, forma_pago, negocio_id, created_at)
     VALUES ($1,$2,'X','[]'::jsonb,300,'recoger','tienda_online','efectivo',$3,
             NOW() - $4::interval)`, [folio, telefono, NEG, hace]);
}
async function activo(folio, telefono, estado, extra = {}) {
  await pool.query(
    `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos)
     VALUES ($1,$2,$3,$4::jsonb)`,
    [folio, NEG, estado, JSON.stringify({
      id: folio, cliente: { telefono, nombre: 'X' }, total: 300,
      canal: 'tienda_online', ...extra })]);
}

const FOLIOS = [];
async function limpiar() {
  for (const f of FOLIOS) {
    await pool.query(`DELETE FROM compras_reales WHERE negocio_id=$1 AND folio=$2`, [NEG, f]);
    await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2`, [NEG, f]);
    await pool.query(`DELETE FROM pedidos WHERE negocio_id=$1 AND folio=$2`, [NEG, f]);
  }
}

try {
  await limpiar();

  // ═══ EL CASO QUE ROMPÍA ══════════════════════════════════════════════════
  await t('1. folio reciclado: el pendiente del cliente NUEVO no borra la compra del VIEJO', async () => {
    const F = `XAB-RECI-${marca}`;
    FOLIOS.push(F);
    const VIEJO = tel('70'), NUEVO = tel('71');
    await crearCliente(VIEJO, 'Viejo'); await crearCliente(NUEVO, 'Nuevo');

    // Hace meses: compra real del cliente viejo.
    await historico(F, VIEJO, '120 days');
    // Hoy, tras purgar el tablero: el contador retrocedió y el MISMO folio
    // salió para otro cliente, que no ha pagado.
    await activo(F, NUEVO, 'pendiente_pago');

    await pool.query(sqlDelBackfill());

    const delViejo = await compras(VIEJO);
    assert.strictEqual(delViejo.length, 1,
      'la compra del cliente viejo desapareció: un pedido pendiente ajeno la borró retrospectivamente');
    assert.strictEqual(delViejo[0].origen, 'legacy_desconocido');
    assert.strictEqual((await compras(NUEVO)).length, 0,
      'el pedido pendiente del cliente nuevo se contó como compra');
  });

  await t('2. folio reciclado con el activo CANCELADO por falta de pago: igual', async () => {
    const F = `XAB-RECC-${marca}`;
    FOLIOS.push(F);
    const VIEJO = tel('72'), NUEVO = tel('73');
    await crearCliente(VIEJO, 'Viejo'); await crearCliente(NUEVO, 'Nuevo');
    await historico(F, VIEJO, '200 days');
    await activo(F, NUEVO, 'cancelado', { expirado_por_pago: true });

    await pool.query(sqlDelBackfill());

    assert.strictEqual((await compras(VIEJO)).length, 1,
      'un pedido ajeno cancelado por impago borró la compra histórica del mismo folio');
    assert.strictEqual((await compras(NUEVO)).length, 0);
  });

  // ═══ LA POLÍTICA FINAL: AMBIGUO LEGACY -> CUENTA ═════════════════════════
  await t('3. un pendiente sin pagar TAMBIÉN entra: no se puede demostrar que sea ése', async () => {
    // Antes esto se excluía. Se retiró: cuando el folio se recicla, el pedido
    // nuevo aún no está en `pedidos`, así que "una historia + un activo" es
    // exactamente lo mismo que se ve en el caso legítimo. Indistinguibles.
    //
    // Marcar de más le niega un descuento a un cliente antiguo ambiguo --
    // reversible a mano. Marcar de menos regala una primera compra por haber
    // borrado una compra real -- irreversible. Manda el riesgo asimétrico.
    //
    // Esto NO relaja nada para los pedidos nuevos: su marca se escribe cuando la
    // compra ocurre, y desde la 059 el folio ya no se recicla.
    const F = `XAB-UNIC-${marca}`;
    FOLIOS.push(F);
    const T = tel('74');
    await crearCliente(T, 'Unico');
    await historico(F, T, '1 day');
    await activo(F, T, 'pendiente_pago');

    await pool.query(sqlDelBackfill());

    assert.strictEqual((await compras(T)).length, 1,
      'una fila histórica ambigua se excluyó: la política conservadora se rompió');
  });

  await t('3b. P0-12: el MISMO cliente con folio reciclado conserva su compra antigua', async () => {
    // El caso exacto que la regla del teléfono resolvía mal. Cliente A compró de
    // verdad con XAB-0042 hace meses; el contador retrocedió y hoy tiene otro
    // XAB-0042 sin pagar. Negocio + folio + teléfono coinciden y NO demuestran
    // nada: son dos pedidos distintos.
    const F = `XAB-P012-${marca}`;
    FOLIOS.push(F);
    const A = tel('79');
    await crearCliente(A, 'Cliente A');
    await historico(F, A, '180 days');          // la compra real de hace meses
    await activo(F, A, 'pendiente_pago');       // el pedido reciclado, sin pagar

    await pool.query(sqlDelBackfill());

    assert.strictEqual((await compras(A)).length, 1,
      'la compra antigua del cliente se borró por un pedido reciclado suyo sin pagar');
  });

  await t('4. sin reciclaje y sin activo que lo desmienta: cuenta', async () => {
    const F = `XAB-SOLO-${marca}`;
    FOLIOS.push(F);
    const T = tel('75');
    await crearCliente(T, 'Solo');
    await historico(F, T, '30 days');

    await pool.query(sqlDelBackfill());

    const c = await compras(T);
    assert.strictEqual(c.length, 1, 'un histórico sin nada que lo desmienta no entró');
    assert.strictEqual(c[0].origen, 'legacy_desconocido');
  });

  // ═══ IDEMPOTENCIA ════════════════════════════════════════════════════════
  await t('5. reejecutar el backfill no duplica ni cambia nada', async () => {
    const antes = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM compras_reales WHERE negocio_id=$1`, [NEG])).rows[0].n;
    await pool.query(sqlDelBackfill());
    await pool.query(sqlDelBackfill());
    const despues = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM compras_reales WHERE negocio_id=$1`, [NEG])).rows[0].n;
    assert.strictEqual(despues, antes, 'el backfill no es idempotente');
  });

  await t('6. dos emisiones del mismo folio, ambas compradas: dos compras distintas', async () => {
    const F = `XAB-DOSC-${marca}`;
    FOLIOS.push(F);
    const A = tel('76'), B = tel('77');
    await crearCliente(A, 'A'); await crearCliente(B, 'B');
    await historico(F, A, '300 days');
    await historico(F, B, '10 days');

    await pool.query(sqlDelBackfill());

    assert.strictEqual((await compras(A)).length, 1, 'se perdió la compra del primer cliente');
    assert.strictEqual((await compras(B)).length, 1, 'se perdió la compra del segundo cliente');
  });

  await t('7. MISMO cliente con folio reciclado: un pendiente no borra sus compras previas', async () => {
    // Este es el caso que justifica la condicion de unicidad, y sin el la
    // condicion no tendria ningun diente: quitarla dejaba la suite verde.
    //
    // El cliente compro DOS veces con el mismo numero -- el contador retrocedio
    // entre una y otra -- y hoy tiene un tercer pedido con ese folio, sin
    // pagar. Como el telefono coincide, la regla del telefono no descarta nada;
    // lo unico que impide borrar sus dos compras reales es que el folio tiene
    // varias historias y por tanto nada es atribuible.
    const F = `XAB-MISMO-${marca}`;
    FOLIOS.push(F);
    const T = tel('78');
    await crearCliente(T, 'Reincidente');
    await historico(F, T, '400 days');
    await historico(F, T, '150 days');
    await activo(F, T, 'pendiente_pago');

    await pool.query(sqlDelBackfill());

    assert.strictEqual((await compras(T)).length, 2,
      'un pendiente sin pagar borro las compras previas del mismo cliente con folio reciclado');
    // Y con la exclusion ya retirada por completo, esto se sostiene sin depender
    // de ninguna heuristica de unicidad.
    assert.ok((await compras(T)).every(c => c.origen === 'legacy_desconocido'));
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL');
} finally {
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-backfill-058-folio-reciclado: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('Fallos: ' + fallos.join(' | ')); }
process.exit(fallidas ? 1 : 0);
