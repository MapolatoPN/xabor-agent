// Número consecutivo por sucursal (migración 137): OB-152, además del folio.
//
// Lo que esta suite protege:
//   - SIN HUECOS Y SIN REPETIDOS. Cada pedido de una sucursal encendida recibe
//     el siguiente número; un INSERT que se revierte, que la barrera de folios
//     descarta o que ON CONFLICT descarta NO gasta número.
//   - NUNCA RECHAZA UN PEDIDO. Si el contador tarda o algo falla, el pedido se
//     guarda sin número (y la Caja lo enseña).
//   - APAGADO POR SUCURSAL. Sin la clave, o con otra cosa que 'true', no se
//     numera nada. Cada sucursal cuenta por su lado.
//   - EL LEDGER SOBREVIVE AL BORRADO: la Caja puede decir «OB-130 era
//     XAB-3170 y se eliminó», y un programado que vuelve recupera su número.
//   - LA CAJA explica cada número del día que no está en la lista.
//
// Usa dos negocios PROPIOS (slug prueba-numero-sucursal-*): la base de pruebas
// es compartida y encender la numeración en los negocios del seed cambiaría lo
// que ven otras suites.
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const SERVIDOR = readFileSync(join(RAIZ, 'src', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const RUNNER = readFileSync(join(RAIZ, 'scripts', 'predeploy-run-032-033.mjs'), 'utf8');
const PREDEPLOY = join(RAIZ, 'scripts', 'predeploy-137-numero-pedido-sucursal.mjs');
const MIGRACION = readFileSync(join(RAIZ, 'migrations', '137_numero_pedido_sucursal.sql'), 'utf8');

const { pool } = await import('../src/services/database.js');
const { calcularCorteVivo, cerrarCorte, obtenerCorteCerrado, rangoUtcDeFecha } = await import('../src/services/cortesCaja.js');
const { normalizarPrefijo, numeroDeFila } = await import('../src/services/numeroSucursal.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const suf = Date.now().toString().slice(-7);
const TZ = 'America/Matamoros';
// Días de Caja propios, en un año que ninguna otra suite toca.
const DIA = '2024-02-14';
const DIA_ANTES = '2024-02-12';

async function negocio(slug) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET nombre = EXCLUDED.nombre RETURNING id`,
    [`Prueba numeración ${slug}`, `prueba-numero-sucursal-${slug}`]);
  return n.id;
}
const NA = await negocio('a');
const NB = await negocio('b');
const NC = await negocio('c'); // nunca se enciende

async function limpiar() {
  for (const n of [NA, NB, NC]) {
    await pool.query(`DELETE FROM cortes_caja WHERE negocio_id = $1`, [n]).catch(() => {});
    await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = $1`, [n]);
    await pool.query(`DELETE FROM pedido_numeros_sucursal WHERE negocio_id = $1`, [n]);
    await pool.query(`DELETE FROM pedido_numero_sucursal_contador WHERE negocio_id = $1`, [n]);
    await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave LIKE 'numero_sucursal%'`, [n]);
    await pool.query(`DELETE FROM folios_pedido_usados WHERE negocio_id = $1`, [n]);
    await pool.query(`DELETE FROM pedido_emisiones WHERE negocio_id = $1`, [n]).catch(() => {});
  }
}

async function config(n, clave, valor) {
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, $2, $3)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = EXCLUDED.valor`, [n, clave, valor]);
}
const encender = (n) => config(n, 'numero_sucursal_activo', 'true');

// Un INSERT como los de producción (folio, estado, datos, negocio, created_at).
async function insertar(n, folio, { estado = 'entregado', creado = null, datos = {}, ejecutor = pool, conflicto = true } = {}) {
  const r = await ejecutor.query(
    `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at)
     VALUES ($1, $2, $3::jsonb, $4, COALESCE($5::timestamptz, NOW()))
     ${conflicto ? 'ON CONFLICT (folio) DO NOTHING' : ''}
     RETURNING numero_sucursal`,
    [folio, estado, JSON.stringify({ total: 100, forma_pago: 'efectivo', pago_confirmado: true, items: [], ...datos }), n, creado]);
  return { guardado: r.rowCount === 1, numero: r.rows[0]?.numero_sucursal ?? null };
}
const numeroDe = async (folio) =>
  (await pool.query(`SELECT numero_sucursal FROM pedidos_activos WHERE folio = $1`, [folio])).rows[0]?.numero_sucursal ?? null;
const contador = async (n) =>
  (await pool.query(`SELECT ultimo FROM pedido_numero_sucursal_contador WHERE negocio_id = $1`, [n])).rows[0]?.ultimo ?? null;
const ledger = async (n) =>
  (await pool.query(`SELECT numero, folio FROM pedido_numeros_sucursal WHERE negocio_id = $1 ORDER BY numero`, [n])).rows;

// Escribe saltándose los triggers (para armar estados que el trigger impide).
async function sinTriggers(fn) {
  const c = await pool.connect();
  try {
    await c.query(`SET session_replication_role = replica`);
    await fn(c);
  } finally {
    await c.query(`RESET session_replication_role`).catch(() => {});
    c.release();
  }
}

try {
  await limpiar();

  // ── Esquema ──────────────────────────────────────────────────────────────
  await t('1. la 137 está aplicada y su trigger es el ÚLTIMO BEFORE INSERT de pedidos_activos', async () => {
    const { rows } = await pool.query(
      `SELECT t.tgname, (t.tgtype & 2) <> 0 AS before, (t.tgtype & 4) <> 0 AS ins
         FROM pg_trigger t WHERE t.tgrelid = 'pedidos_activos'::regclass AND NOT t.tgisinternal`);
    const antesDeInsertar = rows.filter(r => r.before && r.ins).map(r => r.tgname).sort();
    assert.ok(antesDeInsertar.includes('trg_barrera_folio_historico'), antesDeInsertar.join(','));
    assert.strictEqual(antesDeInsertar.at(-1), 'trg_zz_numero_sucursal', `orden: ${antesDeInsertar.join(' → ')}`);
  });

  await t('2. el runner de Railway corre la 137 una vez, después de la 136, y nadie más usa el 137', () => {
    const lista = RUNNER.slice(RUNNER.indexOf('const SCRIPTS = ['), RUNNER.indexOf('];', RUNNER.indexOf('const SCRIPTS = [')));
    const i136 = lista.indexOf("'136-descuento-tras-cierre'"), i137 = lista.indexOf("'137-numero-pedido-sucursal'");
    assert.ok(i136 > 0 && i137 > i136, 'la 137 no está en SCRIPTS o va antes de la 136');
    assert.strictEqual(lista.split("'137-").length, 2, 'otro script del runner usa el 137');
    const mismas = readdirSync(join(RAIZ, 'migrations')).filter(f => /^137_/.test(f)).sort();
    assert.deepStrictEqual(mismas, ['137_numero_pedido_sucursal.sql', '137_numero_pedido_sucursal_down.sql']);
    const predeploys = readdirSync(join(RAIZ, 'scripts')).filter(f => /^predeploy-137-/.test(f));
    assert.deepStrictEqual(predeploys, ['predeploy-137-numero-pedido-sucursal.mjs']);
  });

  await t('3. la migración no escribe ni enciende configuración, y no hay índice único que pueda rechazar', () => {
    assert.ok(!/INSERT\s+INTO\s+configuracion/i.test(MIGRACION), 'la migración escribe configuracion');
    assert.ok(!/CREATE\s+UNIQUE\s+INDEX[^;]*pedidos_activos/i.test(MIGRACION), 'hay un índice único sobre pedidos_activos');
  });

  // ── Apagado ──────────────────────────────────────────────────────────────
  await t('4. sin la clave no se numera ni se crea contador', async () => {
    const r = await insertar(NA, `NS-${suf}-0`);
    assert.ok(r.guardado);
    assert.strictEqual(r.numero, null);
    assert.strictEqual(await contador(NA), null);
    assert.strictEqual((await ledger(NA)).length, 0);
  });

  await t('5. con un valor que no es «true» tampoco', async () => {
    for (const v of ['false', '1', 'si', '']) {
      await config(NA, 'numero_sucursal_activo', v);
      const r = await insertar(NA, `NS-${suf}-off-${v || 'vacio'}`);
      assert.strictEqual(r.numero, null, `numeró con valor «${v}»`);
    }
    assert.strictEqual(await contador(NA), null);
  });

  // ── Encendido ────────────────────────────────────────────────────────────
  await encender(NA);
  await t('6. encendido: 1, 2, 3, con su renglón en el ledger', async () => {
    const nums = [];
    for (let i = 1; i <= 3; i++) nums.push((await insertar(NA, `NS-${suf}-${i}`)).numero);
    assert.deepStrictEqual(nums, [1, 2, 3]);
    assert.strictEqual(await contador(NA), 3);
    assert.deepStrictEqual((await ledger(NA)).map(l => [l.numero, l.folio]),
      [[1, `NS-${suf}-1`], [2, `NS-${suf}-2`], [3, `NS-${suf}-3`]]);
  });

  await t('7. «TRUE» con espacios también enciende; el llamador no puede ponerse el número', async () => {
    await config(NA, 'numero_sucursal_activo', '  TRUE ');
    const r = await pool.query(
      `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, numero_sucursal)
       VALUES ($1, 'entregado', '{}'::jsonb, $2, 999) RETURNING numero_sucursal`, [`NS-${suf}-4`, NA]);
    assert.strictEqual(r.rows[0].numero_sucursal, 4);
    await encender(NA);
  });

  await t('8. un UPDATE no cambia el número (ni el que lo toca ni el de estado)', async () => {
    await pool.query(`UPDATE pedidos_activos SET numero_sucursal = 500 WHERE folio = $1`, [`NS-${suf}-2`]);
    await pool.query(`UPDATE pedidos_activos SET estado = 'cancelado', numero_sucursal = NULL WHERE folio = $1`, [`NS-${suf}-3`]);
    assert.strictEqual(await numeroDe(`NS-${suf}-2`), 2);
    assert.strictEqual(await numeroDe(`NS-${suf}-3`), 3);
    await pool.query(`UPDATE pedidos_activos SET estado = 'entregado' WHERE folio = $1`, [`NS-${suf}-3`]);
  });

  await t('9. un re-guardado del mismo folio (ON CONFLICT DO NOTHING) no gasta número ni hace ruido', async () => {
    const c = await pool.connect();
    const avisos = [];
    c.on('notice', m => avisos.push(m.message));
    let r;
    try { r = await insertar(NA, `NS-${suf}-4`, { ejecutor: c }); } finally { c.release(); }
    assert.strictEqual(r.guardado, false);
    // Es el caso normal (whatsapp-meta y el scheduler re-guardan): sin WARNING.
    assert.ok(!avisos.some(a => a.includes('[137]')), `avisó: ${avisos.join(' | ')}`);
    assert.strictEqual(await contador(NA), 4);
    assert.strictEqual((await ledger(NA)).length, 4);
    assert.strictEqual(await numeroDe(`NS-${suf}-4`), 4);
  });

  await t('10. un folio XAB que la barrera descarta no gasta número', async () => {
    const folio = `XAB-77${suf}`;
    await pool.query(`INSERT INTO folios_pedido_usados (folio, negocio_id, estado, origen) VALUES ($1, $2, 'usado', 'prueba-137')`, [folio, NA]);
    const r = await insertar(NA, folio, { conflicto: false });
    assert.strictEqual(r.guardado, false, 'la barrera no descartó el folio reclamado');
    assert.strictEqual(await contador(NA), 4);
    // Y uno XAB libre sí entra y se numera.
    const libre = await insertar(NA, `XAB-78${suf}`);
    assert.ok(libre.guardado);
    assert.strictEqual(libre.numero, 5);
  });

  await t('11. un pedido que se revierte no deja hueco: el siguiente toma su número', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await insertar(NA, `NS-${suf}-rev`, { ejecutor: c });
      assert.strictEqual(r.numero, 6);
      await c.query('ROLLBACK');
    } finally { c.release(); }
    assert.strictEqual(await contador(NA), 5);
    assert.strictEqual((await insertar(NA, `NS-${suf}-6`)).numero, 6);
  });

  await t('12. cada sucursal cuenta por su lado', async () => {
    await encender(NB);
    assert.strictEqual((await insertar(NB, `NS-${suf}-b1`)).numero, 1);
    assert.strictEqual((await insertar(NB, `NS-${suf}-b2`)).numero, 2);
    assert.strictEqual((await insertar(NA, `NS-${suf}-7`)).numero, 7);
    assert.strictEqual((await insertar(NC, `NS-${suf}-c1`)).numero, null, 'numeró una sucursal apagada');
    // Apagada, tampoco se queda el número que traiga el INSERT.
    const r = await pool.query(
      `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, numero_sucursal)
       VALUES ($1, 'entregado', '{}'::jsonb, $2, 999) RETURNING numero_sucursal`, [`NS-${suf}-c2`, NC]);
    assert.strictEqual(r.rows[0].numero_sucursal, null, 'se quedó el número inyectado');
  });

  await t('13. borrar el pedido no borra su número; si el folio vuelve, recupera EL SUYO', async () => {
    await pool.query(`DELETE FROM pedidos_activos WHERE folio = $1`, [`NS-${suf}-6`]);
    assert.ok((await ledger(NA)).some(l => l.numero === 6 && l.folio === `NS-${suf}-6`), 'el ledger perdió el 6');
    assert.strictEqual((await insertar(NA, `NS-${suf}-8`)).numero, 8, 'el borrado liberó un número');
    assert.strictEqual((await insertar(NA, `NS-${suf}-6`)).numero, 6, 'el folio que volvió no recuperó su número');
    assert.strictEqual(await contador(NA), 8);
  });

  // ── Nunca rechaza ────────────────────────────────────────────────────────
  await t('14. si el número de su folio ya lo trae otra fila, se guarda SIN número (y avisa)', async () => {
    await pool.query(`DELETE FROM pedidos_activos WHERE folio = $1`, [`NS-${suf}-8`]);
    // Otra fila con el 8 (solo se puede armar saltándose el trigger).
    await sinTriggers(c => c.query(
      `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, numero_sucursal) VALUES ($1, 'entregado', '{}'::jsonb, $2, 8)`,
      [`NS-${suf}-intruso`, NA]));
    const c = await pool.connect();
    const avisos = [];
    c.on('notice', m => avisos.push(m.message));
    try {
      const r = await insertar(NA, `NS-${suf}-8`, { ejecutor: c });
      assert.ok(r.guardado, 'el pedido se rechazó');
      assert.strictEqual(r.numero, null);
    } finally { c.release(); }
    assert.ok(avisos.some(a => a.includes('[137]') && a.includes(`NS-${suf}-8`)), `sin WARNING: ${avisos.join(' | ')}`);
    assert.strictEqual(await contador(NA), 8, 'el contador se movió');
    await pool.query(`DELETE FROM pedidos_activos WHERE folio = $1`, [`NS-${suf}-intruso`]);
  });

  await t('15. contador dañado (vuelto atrás): el pedido entra sin número y el contador no se mueve', async () => {
    await pool.query(`UPDATE pedido_numero_sucursal_contador SET ultimo = 2 WHERE negocio_id = $1`, [NA]);
    const r = await insertar(NA, `NS-${suf}-danado`);
    assert.ok(r.guardado, 'el pedido se rechazó');
    assert.strictEqual(r.numero, null);
    assert.strictEqual(await contador(NA), 2);
    await pool.query(`UPDATE pedido_numero_sucursal_contador SET ultimo = 8 WHERE negocio_id = $1`, [NA]);
  });

  await t('16. contador tomado por otra transacción: a los ~3 s entra sin número, sin esperar de más', async () => {
    const bloqueo = await pool.connect();
    const c = await pool.connect();
    try {
      await bloqueo.query('BEGIN');
      await bloqueo.query(`SELECT 1 FROM pedido_numero_sucursal_contador WHERE negocio_id = $1 FOR UPDATE`, [NA]);
      await c.query(`SET lock_timeout = '9s'`);
      await c.query('BEGIN');
      const t0 = Date.now();
      const r = await insertar(NA, `NS-${suf}-espera`, { ejecutor: c });
      const ms = Date.now() - t0;
      assert.ok(r.guardado, 'el pedido se rechazó');
      assert.strictEqual(r.numero, null);
      assert.ok(ms >= 2500 && ms < 6000, `esperó ${ms} ms`);
      // El lock_timeout de la transacción queda como estaba.
      assert.strictEqual((await c.query('SHOW lock_timeout')).rows[0].lock_timeout, '9s');
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await bloqueo.query('ROLLBACK').catch(() => {});
      await c.query('RESET lock_timeout').catch(() => {});
      bloqueo.release(); c.release();
    }
    assert.strictEqual(await contador(NA), 8);
  });

  await t('17. el lock_timeout queda igual también cuando numera, dentro de la transacción del pedido', async () => {
    // Dentro de BEGIN…COMMIT, como la venta de mesa: fuera de una transacción
    // el valor local se revierte solo y la prueba no vería nada.
    const c = await pool.connect();
    try {
      await c.query(`SET lock_timeout = '7s'`);
      await c.query('BEGIN');
      assert.strictEqual((await insertar(NA, `NS-${suf}-9`, { ejecutor: c })).numero, 9);
      assert.strictEqual((await c.query('SHOW lock_timeout')).rows[0].lock_timeout, '7s');
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.query('RESET lock_timeout').catch(() => {});
      c.release();
    }
  });

  await t('18. 40 pedidos a la vez: 10..49 exactos, sin repetidos ni huecos', async () => {
    const folios = Array.from({ length: 40 }, (_, i) => `NS-${suf}-p${i}`);
    const rs = await Promise.all(folios.map(f => insertar(NA, f)));
    assert.ok(rs.every(r => r.guardado), 'se perdió un pedido');
    const nums = rs.map(r => r.numero).sort((a, b) => a - b);
    assert.deepStrictEqual(nums, Array.from({ length: 40 }, (_, i) => 10 + i));
    assert.strictEqual(await contador(NA), 49);
    const { rows: [d] } = await pool.query(
      `SELECT COUNT(*)::int AS n, COUNT(DISTINCT numero_sucursal)::int AS distintos
         FROM pedidos_activos WHERE negocio_id = $1 AND numero_sucursal IS NOT NULL`, [NA]);
    assert.strictEqual(d.n, d.distintos, 'hay números repetidos');
  });

  await t('18b. el MISMO folio guardado 10 veces a la vez: entra una vez y gasta un solo número', async () => {
    const folio = `NS-${suf}-dup`;
    const rs = await Promise.all(Array.from({ length: 10 }, () => insertar(NA, folio)));
    assert.strictEqual(rs.filter(r => r.guardado).length, 1);
    assert.strictEqual(await numeroDe(folio), 50);
    assert.strictEqual(await contador(NA), 50, 'se gastaron números en los descartados');
  });

  // ── Caja ─────────────────────────────────────────────────────────────────
  await t('19. prefijo: A-Z y dígitos, hasta 4, en mayúsculas', () => {
    assert.strictEqual(normalizarPrefijo(' ob '), 'OB');
    assert.strictEqual(normalizarPrefijo('<b>Ac</b>'), 'BACB');
    assert.strictEqual(normalizarPrefijo('AC-1'), 'AC1');
    assert.strictEqual(normalizarPrefijo(''), null);
    assert.strictEqual(normalizarPrefijo(null), null);
    assert.strictEqual(numeroDeFila({ numero_sucursal: '12' }), 12);
    assert.strictEqual(numeroDeFila({ numero_sucursal: 0 }), null);
    assert.strictEqual(numeroDeFila({}), null);
  });

  // El día de Caja: NB, con su contador limpio para leer números redondos.
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = $1`, [NB]);
  await pool.query(`DELETE FROM pedido_numeros_sucursal WHERE negocio_id = $1`, [NB]);
  await pool.query(`DELETE FROM pedido_numero_sucursal_contador WHERE negocio_id = $1`, [NB]);
  await config(NB, 'numero_sucursal_prefijo', 'ob');
  const { inicio } = rangoUtcDeFecha(DIA, TZ);
  const { inicio: inicioAntes } = rangoUtcDeFecha(DIA_ANTES, TZ);
  const enDia = (h, m = 0) => new Date(inicio.getTime() + h * 3600000 + m * 60000);
  // Encendida «desde» las 8:00 del día.
  await sinTriggers(c => c.query(
    `UPDATE configuracion SET valor = 'true', updated_at = $2 WHERE negocio_id = $1 AND clave = 'numero_sucursal_activo'`,
    [NB, enDia(8).toISOString()]));
  // folio es varchar(20).
  const F = (k) => `NS${suf}C${k}`;
  // 1 cobrado, 2 cobrado, 3 se borra, 4 cancelado, 5 programado del 12-feb
  // (se numera hoy, pero su lista es la del 12), 6 por cobrar.
  const plan = [
    { k: 1, creado: enDia(9) },
    { k: 2, creado: enDia(10) },
    { k: 3, creado: enDia(11) },
    { k: 4, creado: enDia(12), estado: 'cancelado', datos: { cancelacion: { motivo: 'cliente' } } },
    { k: 5, creado: new Date(inicioAntes.getTime() + 18 * 3600000), datos: { programado_id: '8b4f6f1e-8b4f-4b4f-8b4f-8b4f6f1e8b4f' } },
    { k: 6, creado: enDia(13), estado: 'nuevo', datos: { pago_confirmado: false, forma_pago: 'por_cobrar' } },
  ];
  for (const p of plan) {
    const r = await insertar(NB, F(p.k), { creado: p.creado.toISOString(), estado: p.estado || 'entregado', datos: p.datos || {} });
    assert.strictEqual(r.numero, p.k, `${F(p.k)} recibió ${r.numero}`);
    // El número se dio en el día de Caja (la hora real de la corrida es otra).
    await pool.query(`UPDATE pedido_numeros_sucursal SET asignado_at = $3 WHERE negocio_id = $1 AND folio = $2`,
      [NB, F(p.k), enDia(9, p.k).toISOString()]);
  }
  await pool.query(`DELETE FROM pedidos_activos WHERE folio = $1`, [F(3)]);
  await pool.query(`DELETE FROM pedido_emisiones WHERE folio = $1`, [F(6)]).catch(() => {});
  // Uno que se quedó sin número después de encenderla (falla simulada).
  await sinTriggers(c => c.query(
    `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at)
     VALUES ($1, 'entregado', '{"total":50,"forma_pago":"efectivo","pago_confirmado":true}'::jsonb, $2, $3)`,
    [F('sin'), NB, enDia(14).toISOString()]));
  // Y uno de ANTES de encenderla: tampoco tiene número, y no es falla.
  await sinTriggers(c => c.query(
    `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at)
     VALUES ($1, 'entregado', '{"total":40,"forma_pago":"efectivo","pago_confirmado":true}'::jsonb, $2, $3)`,
    [F('previo'), NB, enDia(7).toISOString()]));

  const corte = await calcularCorteVivo(NB, DIA);
  await t('20. cada fila de Caja trae su número (cobrados, por cobrar y cancelados)', () => {
    const num = (lista, k) => lista.find(p => p.folio === F(k))?.numero_sucursal;
    assert.strictEqual(num(corte.pedidos, 1), 1);
    assert.strictEqual(num(corte.pedidos, 2), 2);
    assert.strictEqual(num(corte.cancelados, 4), 4);
    assert.strictEqual(num(corte.pendientes, 6), 6);
    const sin = corte.pedidos.find(p => p.folio === F('sin'));
    assert.ok(sin && !('numero_sucursal' in sin), 'una fila sin número trae la clave');
  });

  await t('21. la numeración del día: OB, del 1 al 6, y por qué faltan el 3 y el 5', () => {
    const n = corte.numeracion;
    assert.ok(n, 'no hay numeracion');
    assert.strictEqual(n.activa, true);
    assert.strictEqual(n.prefijo, 'OB');
    assert.strictEqual(n.desde, 1);
    assert.strictEqual(n.hasta, 6);
    assert.strictEqual(n.asignados, 6);
    assert.strictEqual(n.faltantes_total, 2);
    assert.deepStrictEqual(n.faltantes, [
      { numero: 3, folio: F(3), motivo: 'eliminado' },
      { numero: 5, folio: F(5), motivo: 'otro_dia', fecha: DIA_ANTES },
    ]);
  });

  await t('22. «sin número» enseña solo el posterior a encenderla', () => {
    assert.deepStrictEqual(corte.numeracion.sin_numero, [F('sin')]);
    assert.strictEqual(corte.numeracion.sin_numero_total, 1);
  });

  await t('23. el número no cambia el dinero: mismas ventas y efectivo que sumando a mano', () => {
    // 1, 2, sin y previo: 4 × efectivo cobrado (100 + 100 + 50 + 40).
    assert.strictEqual(corte.ventas_totales, 290);
    assert.strictEqual(corte.ventas_efectivo, 290);
    assert.strictEqual(corte.cancelaciones_count, 1);
  });

  await t('24. el día anterior no hereda la numeración de este (su programado ya trae número)', async () => {
    const antes = await calcularCorteVivo(NB, DIA_ANTES);
    assert.strictEqual(antes.pedidos.find(p => p.folio === F(5))?.numero_sucursal, 5);
    // Ese día no se asignó ningún número: lo que se enseña no inventa huecos.
    assert.strictEqual(antes.numeracion.asignados, 0);
    assert.deepStrictEqual(antes.numeracion.faltantes, []);
  });

  await t('25. una sucursal que nunca la encendió no trae numeración y su corte no cambia', async () => {
    const c = await calcularCorteVivo(NC, DIA);
    assert.strictEqual(c.numeracion, null);
    const hoy = await calcularCorteVivo(NC);
    assert.strictEqual(hoy.numeracion, null);
    assert.ok([...hoy.pedidos, ...hoy.cancelados, ...hoy.pendientes].every(p => !('numero_sucursal' in p)));
  });

  await t('26. al cerrar, la numeración queda en el corte y la ruta la entrega', async () => {
    await cerrarCorte(NB, { fecha: DIA, efectivoContado: 290, usuarioId: null });
    const cerrado = await obtenerCorteCerrado(NB, DIA);
    const s = cerrado.snapshot_json;
    assert.strictEqual(s.numeracion?.faltantes_total, 2);
    assert.strictEqual(s.pedidos.find(p => p.folio === F(1))?.numero_sucursal, 1);
    assert.ok(/numeracion: s\.numeracion && typeof s\.numeracion === 'object' \? s\.numeracion : null/.test(SERVIDOR),
      'la ruta del corte cerrado no entrega la numeración');
  });

  // ── Predeploy ────────────────────────────────────────────────────────────
  const correrPredeploy = () => {
    try {
      return { ok: true, salida: execFileSync(process.execPath, [PREDEPLOY], { env: process.env, encoding: 'utf8', stdio: 'pipe' }) };
    } catch (e) { return { ok: false, salida: `${e.stdout || ''}${e.stderr || ''}` }; }
  };
  await t('27. predeploy: aplicada = no hace nada', () => {
    const r = correrPredeploy();
    assert.ok(r.ok && /Ya aplicada/.test(r.salida), r.salida);
  });

  await t('28. predeploy: si falta el trigger, lo repone sin tocar números ni configuración', async () => {
    const antes = await contador(NA);
    await pool.query(`DROP TRIGGER IF EXISTS trg_zz_numero_sucursal ON pedidos_activos`);
    const r = correrPredeploy();
    assert.ok(r.ok && /faltaba: trigger trg_zz_numero_sucursal/.test(r.salida) && /Aplicada/.test(r.salida), r.salida);
    assert.strictEqual(await contador(NA), antes);
    assert.strictEqual((await insertar(NA, `NS-${suf}-trasprd`)).numero, antes + 1);
  });

  await t('29. predeploy: un BEFORE INSERT que corra DESPUÉS del de la 137 lo hace fallar', async () => {
    await pool.query(`CREATE OR REPLACE FUNCTION prueba_137_devuelve() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER trg_zzz_prueba_137 BEFORE INSERT ON pedidos_activos FOR EACH ROW EXECUTE FUNCTION prueba_137_devuelve()`);
    try {
      const r = correrPredeploy();
      assert.ok(!r.ok && /trg_zzz_prueba_137 corre después/.test(r.salida), r.salida);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS trg_zzz_prueba_137 ON pedidos_activos`);
      await pool.query(`DROP FUNCTION IF EXISTS prueba_137_devuelve()`);
    }
    assert.ok(correrPredeploy().ok);
  });
} catch (e) {
  console.log(`FALLO (arranque): ${e.stack || e.message}`);
  fallidas++;
} finally {
  await limpiar().catch(e => console.log('limpieza:', e.message));
  await pool.end().catch(() => {});
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) { for (const f of fallos) console.log(` - ${f}`); process.exit(1); }
