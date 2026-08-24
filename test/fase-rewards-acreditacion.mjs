// Rewards se acredita después de una venta, exactamente una vez.
//
// BUG P2 REAL (XAB-0180): el pedido, el cobro y la comanda salieron bien,
// pero los puntos no se acreditaron:
//
//   [Rewards] Error acumulando puntos
//   violates foreign key constraint rewards_accounts_telefono_fkey
//
// Causa exacta: `rewards_accounts.telefono` es FK a `clientes(telefono)`, y
// `acumularPuntos` insertaba en rewards_accounts SIN asegurar esa fila.
// Un cliente de WhatsApp siempre la tiene (la crea la conversación); uno que
// compra por POS, tienda web o Rappi puede no tenerla nunca. Ahí reventaba.
//
// La otra mitad de la suite es la idempotencia: una compra acredita UNA vez,
// aunque el webhook se repita, el reconciliador vuelva a pasar o alguien
// reintente.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

const { pool } = await import('../src/services/database.js');
const { acumularPuntos, obtenerOCrearCuenta, obtenerCuentaPorTelefono } =
  await import('../src/services/rewardsService.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const suf = Date.now().toString().slice(-6);
// Teléfonos que NO existen en clientes: es el escenario del incidente.
const TEL_NUEVO = `52899${suf}1`;
const TEL_EXISTENTE = `52899${suf}2`;
const TEL_TENANT = `52899${suf}3`;
const TEL_CONC = `52899${suf}4`;
const TELS = [TEL_NUEVO, TEL_EXISTENTE, TEL_TENANT, TEL_CONC];

async function del(sql, params) { try { await pool.query(sql, params); } catch { /* ignorado */ } }
async function limpiar() {
  await del(`DELETE FROM rewards_movements WHERE folio_venta LIKE 'RW-%'`);
  await del(`DELETE FROM rewards_accounts WHERE telefono = ANY($1)`, [TELS]);
  await del(`DELETE FROM clientes WHERE telefono = ANY($1)`, [TELS]);
}

// Deja el módulo Rewards disponible y configurado para un negocio.
async function habilitarRewards(negocioId) {
  await pool.query(
    `INSERT INTO negocio_modulos (negocio_id, modulo, estado)
     VALUES ($1,'rewards','activo')
     ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [negocioId]);
  await pool.query(
    `INSERT INTO rewards_config (tenant_id, activo, canal_mostrador, canal_whatsapp, canal_telefono, canal_rappi)
     VALUES ($1, TRUE, TRUE, TRUE, TRUE, TRUE)
     ON CONFLICT (tenant_id) DO UPDATE SET activo = TRUE, canal_mostrador = TRUE,
       canal_whatsapp = TRUE, canal_telefono = TRUE, canal_rappi = TRUE`, [negocioId]);
}

const venta = (telefono, total = 500, nombre = 'Cliente POS') => ({
  total, canal: 'presencial', cliente: { telefono, nombre },
});

try {
  await limpiar();
  await habilitarRewards(NEG_A);
  await habilitarRewards(NEG_B);

  await t('1. cliente que NUNCA existió en clientes: la venta SÍ acredita puntos', async () => {
    // Exactamente el incidente: teléfono sin fila en clientes.
    const { rows: previo } = await pool.query('SELECT 1 FROM clientes WHERE telefono = $1', [TEL_NUEVO]);
    assert.strictEqual(previo.length, 0, 'el fixture debe arrancar sin ese cliente');

    const r = await acumularPuntos(`RW-${suf}-1`, venta(TEL_NUEVO), NEG_A);
    assert.ok(r, 'no se acreditó nada: el bug sigue vivo');
    assert.ok(r.puntos > 0, `se esperaban puntos y llegaron ${r.puntos}`);

    const cuenta = await obtenerCuentaPorTelefono(TEL_NUEVO, NEG_A);
    assert.ok(cuenta, 'no quedó cuenta de rewards');
    assert.strictEqual(Number(cuenta.puntos_balance), r.puntos);
  });

  await t('2. la fila de clientes se crea con el negocio correcto, sin inventar nombre ajeno', async () => {
    const { rows } = await pool.query('SELECT telefono, nombre, negocio_id FROM clientes WHERE telefono = $1', [TEL_NUEVO]);
    assert.strictEqual(rows.length, 1, 'la FK se satisfizo pero no quedó la fila del cliente');
    assert.strictEqual(rows[0].negocio_id, NEG_A);
    assert.strictEqual(rows[0].nombre, 'Cliente POS', 'debe conservar el nombre que traía el pedido');
  });

  await t('3. cliente que YA existía: se reutiliza su fila y no se le pisa el nombre', async () => {
    await pool.query(
      `INSERT INTO clientes (telefono, nombre, negocio_id) VALUES ($1,'Nombre Original',$2)`,
      [TEL_EXISTENTE, NEG_A]);
    const r = await acumularPuntos(`RW-${suf}-3`, venta(TEL_EXISTENTE, 300, 'Nombre Del Pedido'), NEG_A);
    assert.ok(r.puntos > 0);
    const { rows } = await pool.query('SELECT nombre FROM clientes WHERE telefono = $1', [TEL_EXISTENTE]);
    assert.strictEqual(rows[0].nombre, 'Nombre Original',
      'acumular puntos no puede reescribir el perfil del cliente');
  });

  await t('4. un cliente de OTRO negocio no se muda de negocio al comprar aquí', async () => {
    // El teléfono ya existe bajo B (clientes.telefono es PK global).
    await pool.query(
      `INSERT INTO clientes (telefono, nombre, negocio_id) VALUES ($1,'Cliente de B',$2)`,
      [TEL_TENANT, NEG_B]);
    const r = await acumularPuntos(`RW-${suf}-4`, venta(TEL_TENANT, 400), NEG_A);
    assert.ok(r.puntos > 0, 'debió acreditar en A de todos modos');
    const { rows } = await pool.query('SELECT negocio_id, nombre FROM clientes WHERE telefono = $1', [TEL_TENANT]);
    assert.strictEqual(rows[0].negocio_id, NEG_B,
      'se reasignó el cliente a otro negocio: eso corrompe datos de otro tenant');
    assert.strictEqual(rows[0].nombre, 'Cliente de B');
  });

  await t('5. AISLAMIENTO: la cuenta de rewards es por negocio, con su propio saldo', async () => {
    const rB = await acumularPuntos(`RW-${suf}-5B`, venta(TEL_TENANT, 1000), NEG_B);
    const cuentaA = await obtenerCuentaPorTelefono(TEL_TENANT, NEG_A);
    const cuentaB = await obtenerCuentaPorTelefono(TEL_TENANT, NEG_B);
    assert.ok(cuentaA && cuentaB);
    assert.notStrictEqual(cuentaA.id, cuentaB.id, 'el mismo teléfono debe tener cuentas separadas por negocio');
    assert.strictEqual(Number(cuentaB.puntos_balance), rB.puntos);
    assert.notStrictEqual(Number(cuentaA.puntos_balance), Number(cuentaB.puntos_balance));
  });

  await t('6. IDEMPOTENCIA: la misma venta dos veces acredita una sola vez', async () => {
    const folio = `RW-${suf}-6`;
    const primero = await acumularPuntos(folio, venta(TEL_NUEVO, 600), NEG_A);
    const saldoTras1 = Number((await obtenerCuentaPorTelefono(TEL_NUEVO, NEG_A)).puntos_balance);
    const segundo = await acumularPuntos(folio, venta(TEL_NUEVO, 600), NEG_A);
    const saldoTras2 = Number((await obtenerCuentaPorTelefono(TEL_NUEVO, NEG_A)).puntos_balance);
    assert.ok(primero.puntos > 0);
    assert.strictEqual(saldoTras2, saldoTras1, 'el saldo se movió dos veces por la misma compra');
    assert.ok(segundo === null || segundo.yaAcreditado === true,
      'el segundo intento debe reportar que ya estaba acreditado');
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM rewards_movements WHERE folio_venta = $1 AND tipo = 'acumulacion'`, [folio]);
    assert.strictEqual(rows[0].n, 1, 'quedaron dos movimientos para la misma venta');
  });

  await t('7. CONCURRENCIA: tres acreditaciones simultáneas dejan una sola', async () => {
    const folio = `RW-${suf}-7`;
    const v = venta(TEL_CONC, 800);
    const rs = await Promise.allSettled([
      acumularPuntos(folio, v, NEG_A),
      acumularPuntos(folio, v, NEG_A),
      acumularPuntos(folio, v, NEG_A),
    ]);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM rewards_movements WHERE folio_venta = $1 AND tipo = 'acumulacion'`, [folio]);
    assert.strictEqual(rows[0].n, 1, `se acreditó ${rows[0].n} veces en paralelo`);
    const cuenta = await obtenerCuentaPorTelefono(TEL_CONC, NEG_A);
    const acreditado = rs.map(r => r.value).find(v2 => v2 && v2.puntos > 0);
    assert.strictEqual(Number(cuenta.puntos_balance), acreditado.puntos,
      'el saldo refleja más de una acreditación');
  });

  await t('8. un pedido sin cliente válido no acredita ni crea filas basura', async () => {
    const antes = (await pool.query('SELECT COUNT(*)::int n FROM clientes')).rows[0].n;
    for (const tel of [null, '', '—', '123']) {
      const r = await acumularPuntos(`RW-${suf}-8-${tel}`, venta(tel), NEG_A);
      assert.strictEqual(r, null, `acreditó con teléfono inválido: ${JSON.stringify(tel)}`);
    }
    const despues = (await pool.query('SELECT COUNT(*)::int n FROM clientes')).rows[0].n;
    assert.strictEqual(despues, antes, 'se crearon clientes a partir de teléfonos inválidos');
  });

  await t('9. sin el módulo contratado no se acredita nada', async () => {
    await pool.query(
      `UPDATE negocio_modulos SET estado = 'no_contratado' WHERE negocio_id = $1 AND modulo = 'rewards'`, [NEG_B]);
    const r = await acumularPuntos(`RW-${suf}-9`, venta(TEL_TENANT, 900), NEG_B);
    assert.strictEqual(r, null, 'un negocio sin Rewards contratado no puede acumular');
    await habilitarRewards(NEG_B);
  });

  await t('10. el alta manual ya no muere con "Cliente no existe"', async () => {
    const tel = `52899${suf}9`;
    try {
      const cuenta = await obtenerOCrearCuenta(tel, 'Alta Manual', NEG_A);
      assert.ok(cuenta && cuenta.id, 'no devolvió cuenta');
      assert.strictEqual(cuenta.nombre, 'Alta Manual');
      const { rows } = await pool.query('SELECT 1 FROM clientes WHERE telefono = $1', [tel]);
      assert.strictEqual(rows.length, 1, 'no quedó la fila de clientes que exige la FK');
    } finally {
      await del(`DELETE FROM rewards_accounts WHERE telefono = $1`, [tel]);
      await del(`DELETE FROM clientes WHERE telefono = $1`, [tel]);
    }
  });

  await t('11. un fallo de rewards NO revierte el pedido (contrato del llamador)', () => {
    const orderManager = readFileSync(join(__dirname, '..', 'src', 'orders', 'orderManager.js'), 'utf8');
    const hook = orderManager.slice(orderManager.indexOf('// Rewards'), orderManager.indexOf('// Rewards') + 900);
    // Fire-and-forget con catch propio: el pedido ya se archivó antes.
    assert.match(hook, /acumularPuntos\(/);
    assert.match(hook, /\.catch\(/, 'el hook de rewards debe atrapar su propio error');
    assert.ok(!/await\s+import\('\.\.\/services\/rewardsService/.test(hook),
      'la acumulación no puede bloquear la entrega del pedido');
  });

  await t('12. el fallo queda observable con una línea buscable', () => {
    const svc = readFileSync(join(__dirname, '..', 'src', 'services', 'rewardsService.js'), 'utf8');
    assert.match(svc, /FALLO_ACUMULACION folio=/,
      'un fallo de acreditación debe dejar rastro estructurado, no un mensaje suelto');
    assert.match(svc, /constraint=/, 'el log debe decir qué restricción falló');
    // Y el arreglo no puede ser un catch silencioso.
    assert.ok(!/catch\s*\([^)]*\)\s*\{\s*\}/.test(svc), 'quedó un catch vacío');
  });

  await t('13. la fila de clientes se asegura DENTRO de la transacción', () => {
    const svc = readFileSync(join(__dirname, '..', 'src', 'services', 'rewardsService.js'), 'utf8');
    const tx = svc.slice(svc.indexOf("await client.query('BEGIN')"), svc.indexOf('const balanceAnterior'));
    assert.match(tx, /asegurarClienteParaRewards\(client,/,
      'crear el cliente y acreditar deben ser el mismo acto atómico');
    // Y con DO NOTHING, nunca DO UPDATE: no puede pisar datos de otro negocio.
    const helper = svc.slice(svc.indexOf('async function asegurarClienteParaRewards'), svc.indexOf('export async function obtenerOCrearCuenta'));
    assert.match(helper, /ON CONFLICT \(telefono\) DO NOTHING/);
    assert.ok(!/DO UPDATE/.test(helper), 'un DO UPDATE aquí movería clientes entre negocios');
  });

} catch (e) {
  console.error('ERROR FATAL EN LA SUITE:', e);
  fallidas++; fallos.push(`fatal: ${e.message}`);
} finally {
  await limpiar();
  await pool.end();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
