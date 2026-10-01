// Correcciones de caja (112): fondo inicial y movimientos capturados por error.
//
// El incidente del 1-oct-2026: se capturó un fondo de ~$90,000 y no había
// cómo corregirlo. El botón respondía "Fondo registrado" pero la base no
// cambiaba (INSERT ... ON CONFLICT DO NOTHING); un gasto o retiro mal
// capturado tampoco tenía arreglo.
//
// Lo que esta suite protege:
//   - Corregir CAMBIA de verdad lo que el corte suma, y exige motivo.
//   - Cada corrección deja antes/después/motivo/usuario en la bitácora.
//   - Un día cerrado no se corrige: ni su fondo ni sus movimientos.
//   - Un negocio no corrige movimientos de otro.
//   - Corregir y cerrar a la vez no deja un corte que no cuadre.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PANEL = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');

const { pool } = await import('../src/services/database.js');
const { calcularCorteVivo, cerrarCorte, registrarMovimiento } = await import('../src/services/cortesCaja.js');
const {
  fijarFondoCaja, corregirMovimiento, anularMovimiento, listarCorreccionesCaja,
} = await import('../src/services/cajaCorrecciones.js');

let pasadas = 0, fallidas = 0;
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; }
}
async function rechaza(promesa, code) {
  try { await promesa; } catch (e) { assert.equal(e.code, code, `se esperaba ${code}, llegó ${e.code}: ${e.message}`); return e; }
  throw new Error(`se esperaba ${code} y la operación pasó`);
}

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const USUARIO = SEED.adminNegocioAUsuarioId;
// Días propios de esta suite, en un año que ninguna otra toca.
const DIA = '2024-03-12';
const DIA_CERRADO = '2024-03-13';
const DIA_CARRERA = '2024-03-14';
const DIA_CERROJO = '2024-03-15';
const DIAS = [DIA, DIA_CERRADO, DIA_CARRERA, DIA_CERROJO];

async function limpiar() {
  for (const neg of [NEG_A, NEG_B]) {
    await pool.query(`DELETE FROM caja_correcciones WHERE negocio_id = $1 AND fecha_operativa = ANY($2::date[])`, [neg, DIAS]);
    await pool.query(`DELETE FROM movimientos_caja WHERE negocio_id = $1 AND fecha_operativa = ANY($2::date[])`, [neg, DIAS]);
    await pool.query(`DELETE FROM cortes_caja WHERE negocio_id = $1 AND fecha_operativa = ANY($2::date[])`, [neg, DIAS]);
    await pool.query(`DELETE FROM caja_fondos WHERE negocio_id = $1 AND fecha = ANY($2::date[])`, [neg, DIAS]);
  }
}
const fondoEnBase = async (neg, fecha) => {
  const { rows } = await pool.query(`SELECT fondo FROM caja_fondos WHERE negocio_id = $1 AND fecha = $2`, [neg, fecha]);
  return rows[0] ? Number(rows[0].fondo) : null;
};
const bitacora = (neg, fecha) => listarCorreccionesCaja(neg, fecha);

try {
  await limpiar();

  // ── Fondo ───────────────────────────────────────────────────────────────
  await t('1. el primer fondo se registra sin motivo', async () => {
    const r = await fijarFondoCaja(NEG_A, { monto: 90000, fecha: DIA, usuarioId: USUARIO });
    assert.equal(r.accion, 'registrado');
    assert.equal(await fondoEnBase(NEG_A, DIA), 90000);
    assert.equal((await bitacora(NEG_A, DIA)).length, 0, 'registrar no es corregir');
  });

  await t('2. corregir el fondo sin motivo se rechaza y NO cambia nada', async () => {
    await rechaza(fijarFondoCaja(NEG_A, { monto: 900, fecha: DIA, usuarioId: USUARIO }), 'MOTIVO_REQUERIDO');
    await rechaza(fijarFondoCaja(NEG_A, { monto: 900, fecha: DIA, motivo: '   ', usuarioId: USUARIO }), 'MOTIVO_REQUERIDO');
    assert.equal(await fondoEnBase(NEG_A, DIA), 90000);
  });

  await t('3. EL INCIDENTE: corregir $90,000 a $900 cambia el fondo y el efectivo esperado', async () => {
    const antes = await calcularCorteVivo(NEG_A, DIA);
    assert.equal(Number(antes.fondo_inicial), 90000);
    const r = await fijarFondoCaja(NEG_A, { monto: 900, fecha: DIA, motivo: 'Se capturó con dos ceros de más', usuarioId: USUARIO });
    assert.equal(r.accion, 'corregido');
    assert.equal(r.anterior, 90000);
    assert.equal(await fondoEnBase(NEG_A, DIA), 900);
    const despues = await calcularCorteVivo(NEG_A, DIA);
    assert.equal(Number(despues.fondo_inicial), 900);
    assert.equal(Math.round((antes.efectivo_esperado - despues.efectivo_esperado) * 100) / 100, 89100,
      'el esperado debe bajar exactamente lo que bajó el fondo');
  });

  await t('4. la corrección del fondo queda en la bitácora con antes, después, motivo y usuario', async () => {
    const b = await bitacora(NEG_A, DIA);
    assert.equal(b.length, 1);
    assert.equal(b[0].objeto, 'fondo');
    assert.equal(Number(b[0].antes.fondo), 90000);
    assert.equal(Number(b[0].despues.fondo), 900);
    assert.equal(b[0].motivo, 'Se capturó con dos ceros de más');
    assert.ok(b[0].usuario, 'falta quién corrigió');
  });

  await t('5. el mismo monto no es corrección: ni pide motivo ni ensucia la bitácora', async () => {
    const r = await fijarFondoCaja(NEG_A, { monto: 900, fecha: DIA, usuarioId: USUARIO });
    assert.equal(r.accion, 'sin_cambio');
    assert.equal((await bitacora(NEG_A, DIA)).length, 1);
  });

  await t('6. montos inválidos se rechazan', async () => {
    for (const m of [-1, 'abc', null, 1e9]) {
      await rechaza(fijarFondoCaja(NEG_A, { monto: m, fecha: DIA, motivo: 'x' }), 'MONTO_INVALIDO');
    }
    assert.equal(await fondoEnBase(NEG_A, DIA), 900);
  });

  // ── Movimientos ─────────────────────────────────────────────────────────
  let gasto, retiro;
  await t('7. corregir un gasto cambia lo que el corte resta y queda asentado', async () => {
    gasto = await registrarMovimiento(NEG_A, { tipo: 'gasto', monto: 2500, motivo: 'gas', usuarioId: USUARIO, fecha: DIA });
    retiro = await registrarMovimiento(NEG_A, { tipo: 'retiro', monto: 300, motivo: 'banco', usuarioId: USUARIO, fecha: DIA });
    const antes = await calcularCorteVivo(NEG_A, DIA);
    assert.equal(Number(antes.gastos), 2500);
    const r = await corregirMovimiento(NEG_A, gasto.id, { monto: 250, motivo: 'Era $250, no $2,500', usuarioId: USUARIO });
    assert.equal(r.accion, 'corregido');
    const despues = await calcularCorteVivo(NEG_A, DIA);
    assert.equal(Number(despues.gastos), 250);
    assert.equal(Math.round((despues.efectivo_esperado - antes.efectivo_esperado) * 100) / 100, 2250);
    const b = (await bitacora(NEG_A, DIA)).filter(c => c.objeto === 'movimiento');
    assert.equal(b.length, 1);
    assert.equal(Number(b[0].antes.monto), 2500);
    assert.equal(Number(b[0].despues.monto), 250);
    assert.equal(b[0].movimiento_id, gasto.id);
  });

  await t('8. corregir el TIPO (retiro capturado como gasto) mueve el monto de renglón', async () => {
    await corregirMovimiento(NEG_A, gasto.id, { tipo: 'retiro', descripcion: 'depósito', motivo: 'No era gasto', usuarioId: USUARIO });
    const c = await calcularCorteVivo(NEG_A, DIA);
    assert.equal(Number(c.gastos), 0);
    assert.equal(Number(c.retiros), 550);
  });

  await t('9. corregir sin motivo, con tipo o monto inválido, se rechaza sin tocar el movimiento', async () => {
    await rechaza(corregirMovimiento(NEG_A, retiro.id, { monto: 1 }), 'MOTIVO_REQUERIDO');
    await rechaza(corregirMovimiento(NEG_A, retiro.id, { tipo: 'propina', motivo: 'x' }), 'TIPO_INVALIDO');
    await rechaza(corregirMovimiento(NEG_A, retiro.id, { monto: 0, motivo: 'x' }), 'MONTO_INVALIDO');
    const { rows } = await pool.query(`SELECT tipo, monto FROM movimientos_caja WHERE id = $1`, [retiro.id]);
    assert.deepEqual([rows[0].tipo, Number(rows[0].monto)], ['retiro', 300]);
  });

  await t('10. anular quita el movimiento del corte y la bitácora guarda su copia', async () => {
    await rechaza(anularMovimiento(NEG_A, retiro.id, { motivo: '' }), 'MOTIVO_REQUERIDO');
    const r = await anularMovimiento(NEG_A, retiro.id, { motivo: 'Capturado dos veces', usuarioId: USUARIO });
    assert.equal(r.accion, 'anulado');
    const c = await calcularCorteVivo(NEG_A, DIA);
    assert.equal(Number(c.retiros), 250);
    const a = (await bitacora(NEG_A, DIA)).find(x => x.accion === 'anular');
    assert.ok(a, 'falta la anulación en la bitácora');
    assert.equal(Number(a.antes.monto), 300);
    assert.equal(a.antes.motivo, 'banco');
    await rechaza(anularMovimiento(NEG_A, retiro.id, { motivo: 'otra vez' }), 'NO_ENCONTRADO');
  });

  await t('11. otro negocio no puede corregir ni anular movimientos ajenos', async () => {
    await rechaza(corregirMovimiento(NEG_B, gasto.id, { monto: 1, motivo: 'ajeno' }), 'NO_ENCONTRADO');
    await rechaza(anularMovimiento(NEG_B, gasto.id, { motivo: 'ajeno' }), 'NO_ENCONTRADO');
    await rechaza(corregirMovimiento(NEG_A, 'no-es-uuid', { monto: 1, motivo: 'x' }), 'NO_ENCONTRADO');
    const { rows } = await pool.query(`SELECT monto FROM movimientos_caja WHERE id = $1`, [gasto.id]);
    assert.equal(Number(rows[0].monto), 250);
    assert.equal((await bitacora(NEG_B, DIA)).length, 0);
  });

  // ── Día cerrado ─────────────────────────────────────────────────────────
  await t('12. un día CERRADO no admite corregir fondo ni movimientos, y su corte no cambia', async () => {
    await fijarFondoCaja(NEG_A, { monto: 1000, fecha: DIA_CERRADO });
    const m = await registrarMovimiento(NEG_A, { tipo: 'gasto', monto: 100, motivo: 'hielo', fecha: DIA_CERRADO });
    const { corte } = await cerrarCorte(NEG_A, { fecha: DIA_CERRADO, efectivoContado: 900, usuarioId: USUARIO });
    await rechaza(fijarFondoCaja(NEG_A, { monto: 5, fecha: DIA_CERRADO, motivo: 'tarde' }), 'CORTE_CERRADO');
    await rechaza(corregirMovimiento(NEG_A, m.id, { monto: 5, motivo: 'tarde' }), 'CORTE_CERRADO');
    await rechaza(anularMovimiento(NEG_A, m.id, { motivo: 'tarde' }), 'CORTE_CERRADO');
    assert.equal(await fondoEnBase(NEG_A, DIA_CERRADO), 1000);
    const { rows } = await pool.query(`SELECT monto FROM movimientos_caja WHERE id = $1`, [m.id]);
    assert.equal(Number(rows[0].monto), 100);
    const { rows: [c2] } = await pool.query(`SELECT fondo_inicial, gastos, efectivo_esperado FROM cortes_caja WHERE id = $1`, [corte.id]);
    assert.deepEqual([Number(c2.fondo_inicial), Number(c2.gastos), Number(c2.efectivo_esperado)],
      [Number(corte.fondo_inicial), Number(corte.gastos), Number(corte.efectivo_esperado)]);
    assert.equal((await bitacora(NEG_A, DIA_CERRADO)).length, 0);
  });

  await t('13. CARRERA: anular y cerrar a la vez deja un corte que cuadra con lo que quedó', async () => {
    for (let i = 0; i < 8; i++) {
      await pool.query(`DELETE FROM caja_correcciones WHERE negocio_id = $1 AND fecha_operativa = $2`, [NEG_A, DIA_CARRERA]);
      await pool.query(`DELETE FROM movimientos_caja WHERE negocio_id = $1 AND fecha_operativa = $2`, [NEG_A, DIA_CARRERA]);
      await pool.query(`DELETE FROM cortes_caja WHERE negocio_id = $1 AND fecha_operativa = $2`, [NEG_A, DIA_CARRERA]);
      await registrarMovimiento(NEG_A, { tipo: 'gasto', monto: 70, motivo: 'fijo', fecha: DIA_CARRERA });
      const m = await registrarMovimiento(NEG_A, { tipo: 'gasto', monto: 30, motivo: 'error', fecha: DIA_CARRERA });
      const [anul, cierre] = await Promise.allSettled([
        anularMovimiento(NEG_A, m.id, { motivo: 'carrera' }),
        cerrarCorte(NEG_A, { fecha: DIA_CARRERA, efectivoContado: 0 }),
      ]);
      assert.equal(cierre.status, 'fulfilled', cierre.reason?.message);
      const corte = cierre.value.corte;
      if (anul.status === 'fulfilled') {
        assert.equal(Number(corte.gastos), 70, 'se anuló antes del cierre: el corte no debe contarlo');
      } else {
        assert.equal(anul.reason.code, 'CORTE_CERRADO');
        assert.equal(Number(corte.gastos), 100, 'el cierre ganó: el movimiento sigue y se contó');
      }
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(monto),0)::numeric AS s, COUNT(*) FILTER (WHERE corte_id IS NULL)::int AS sueltos
           FROM movimientos_caja WHERE negocio_id = $1 AND fecha_operativa = $2`, [NEG_A, DIA_CARRERA]);
      assert.equal(Number(rows[0].s), Number(corte.gastos), 'lo sellado debe ser exactamente lo que el corte sumó');
      assert.equal(rows[0].sueltos, 0, 'quedó un movimiento fuera del corte');
    }
  });

  // ── Pantalla ────────────────────────────────────────────────────────────
  // Se extraen las funciones del panel y se ejecutan con un DOM mínimo.
  function fuente(nombre) {
    const i = PANEL.indexOf(`function ${nombre}(`);
    assert.ok(i >= 0, `falta ${nombre} en el panel`);
    let j = PANEL.indexOf('{', i), nivel = 0;
    for (; j < PANEL.length; j++) {
      if (PANEL[j] === '{') nivel++;
      else if (PANEL[j] === '}' && --nivel === 0) break;
    }
    return PANEL.slice(i, j + 1);
  }
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: '', textContent: '', style: {}, value: '' });
  const ctx = vm.createContext({ document: { getElementById: el }, Intl, Number, String, Array, Math, JSON, Date });
  vm.runInContext([
    PANEL.match(/const pesosCorte = [^\n]+/)[0],
    fuente('esc'), fuente('jsArg'), fuente('corteFechaHora'), fuente('leerMontoCaja'),
    'let CORTE_MOV_EDITANDO = null; var CORTE_DATA = null;',
    fuente('pintarMovimientosCorte'), fuente('pintarCorreccionesCaja'),
  ].join('\n'), ctx);

  await t('14. PANTALLA: los montos con coma se leen bien ("900,50" no es 90,050)', () => {
    const casos = { '90,000': 90000, '900,50': 900.5, '$1,500.25': 1500.25, '900': 900, ' 1 200 ': 1200, '0': 0 };
    for (const [entrada, esperado] of Object.entries(casos)) {
      assert.equal(vm.runInContext(`leerMontoCaja(${JSON.stringify(entrada)})`, ctx), esperado, entrada);
    }
    assert.ok(Number.isNaN(vm.runInContext(`leerMontoCaja('abc')`, ctx)));
    assert.ok(Number.isNaN(vm.runInContext(`leerMontoCaja('-5')`, ctx)));
  });

  const MOV = { id: '11111111-2222-4333-8444-555555555555', tipo: 'gasto', monto: 250, motivo: 'gas', usuario: 'Ana', corte_id: null };
  await t('15. PANTALLA: día abierto muestra Editar y Anular; día cerrado o sellado, no', () => {
    ctx.__d = { cerrado: false, movimientos: [MOV], correcciones: [] };
    vm.runInContext('pintarMovimientosCorte(__d)', ctx);
    assert.match(els['corte-movimientos'].innerHTML, /editarMovimientoCaja\(/);
    assert.match(els['corte-movimientos'].innerHTML, /anularMovimientoCaja\(/);
    ctx.__d = { cerrado: true, movimientos: [MOV], correcciones: [] };
    vm.runInContext('pintarMovimientosCorte(__d)', ctx);
    assert.doesNotMatch(els['corte-movimientos'].innerHTML, /editarMovimientoCaja|anularMovimientoCaja/);
    ctx.__d = { cerrado: false, movimientos: [{ ...MOV, corte_id: 'x' }], correcciones: [] };
    vm.runInContext('pintarMovimientosCorte(__d)', ctx);
    assert.doesNotMatch(els['corte-movimientos'].innerHTML, /editarMovimientoCaja|anularMovimientoCaja/);
  });

  await t('16. PANTALLA: la bitácora se muestra y escapa lo que escribió el usuario', () => {
    const X = '<img src=x onerror=alert(1)>';
    ctx.__d = { cerrado: false, movimientos: [], timezone: 'America/Matamoros', correcciones: [
      { objeto: 'fondo', accion: 'corregir', antes: { fondo: 90000 }, despues: { fondo: 900 }, motivo: X, usuario: X, created_at: '2026-10-01T15:00:00Z' },
      { objeto: 'movimiento', accion: 'anular', antes: { tipo: 'gasto', monto: 30, motivo: X }, despues: null, motivo: 'dup', usuario: 'Ana', created_at: '2026-10-01T15:05:00Z' },
    ] };
    vm.runInContext('pintarMovimientosCorte(__d)', ctx);
    const h = els['corte-correcciones'].innerHTML;
    assert.equal(els['corte-correcciones'].style.display, '');
    assert.match(h, /Fondo inicial \$90,000\.00 → \$900\.00/);
    assert.match(h, /Anulado: gasto \$30\.00/);
    assert.ok(!h.includes('<img'), 'el motivo del usuario llegó sin escapar');
  });

  await t('17. PANTALLA: el formulario de edición escapa la descripción', () => {
    ctx.__d = { cerrado: false, movimientos: [{ ...MOV, motivo: '"><script>x</script>' }], correcciones: [] };
    vm.runInContext(`CORTE_MOV_EDITANDO = ${JSON.stringify(MOV.id)}; pintarMovimientosCorte(__d)`, ctx);
    const h = els['corte-movimientos'].innerHTML;
    assert.match(h, /id="movedit-motivo"/);
    assert.ok(!h.includes('<script>'), 'la descripción llegó sin escapar al formulario');
  });
  await t('18. PANTALLA con datos REALES: el corte vivo trae el id y aparecen Editar y Anular', async () => {
    const m = await registrarMovimiento(NEG_A, { tipo: 'entrada', monto: 40, motivo: 'cambio', fecha: DIA });
    const vivo = await calcularCorteVivo(NEG_A, DIA);
    assert.ok(vivo.movimientos.some(x => x.id === m.id), 'el corte vivo no entrega el id del movimiento');
    ctx.__d = JSON.parse(JSON.stringify({ cerrado: false, ...vivo, correcciones: await bitacora(NEG_A, DIA) }));
    vm.runInContext('CORTE_MOV_EDITANDO = null; pintarMovimientosCorte(__d)', ctx);
    assert.ok(els['corte-movimientos'].innerHTML.includes(`anularMovimientoCaja(&quot;${m.id}&quot;)`),
      'la pantalla real no ofrece anular el movimiento');
  });

  await t('19. CARRERA: un gasto que se agrega mientras se cierra, o entra al corte o se rechaza', async () => {
    for (let i = 0; i < 8; i++) {
      await pool.query(`DELETE FROM movimientos_caja WHERE negocio_id = $1 AND fecha_operativa = $2`, [NEG_A, DIA_CARRERA]);
      await pool.query(`DELETE FROM cortes_caja WHERE negocio_id = $1 AND fecha_operativa = $2`, [NEG_A, DIA_CARRERA]);
      await registrarMovimiento(NEG_A, { tipo: 'gasto', monto: 70, motivo: 'fijo', fecha: DIA_CARRERA });
      const [alta, cierre] = await Promise.allSettled([
        registrarMovimiento(NEG_A, { tipo: 'gasto', monto: 30, motivo: 'tarde', fecha: DIA_CARRERA }),
        cerrarCorte(NEG_A, { fecha: DIA_CARRERA, efectivoContado: 0 }),
      ]);
      assert.equal(cierre.status, 'fulfilled', cierre.reason?.message);
      if (alta.status === 'rejected') assert.equal(alta.reason.code, 'CORTE_CERRADO');
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(monto),0)::numeric AS s, COUNT(*) FILTER (WHERE corte_id IS NULL)::int AS sueltos
           FROM movimientos_caja WHERE negocio_id = $1 AND fecha_operativa = $2`, [NEG_A, DIA_CARRERA]);
      assert.equal(Number(rows[0].s), Number(cierre.value.corte.gastos), 'se selló un gasto que el corte no sumó');
      assert.equal(rows[0].sueltos, 0);
    }
  });
  // El cerrojo, sin depender de la suerte de una carrera: se toma a mano, la
  // operación queda esperando, el día se cierra mientras espera y al soltar
  // el cerrojo la operación debe ver el cierre.
  async function conCierreMientrasEspera(operacion, fecha) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('cortes_caja'), hashtext($1))`, [NEG_A]);
      const p = operacion();
      p.catch(() => {});
      await new Promise(r => setTimeout(r, 400));
      await c.query(`INSERT INTO cortes_caja (negocio_id, fecha_operativa, folio) VALUES ($1,$2,$3)`,
        [NEG_A, fecha, `COR-T${Date.now()}`]);
      await c.query('COMMIT');
      return await p.then(v => ({ ok: v }), e => ({ error: e }));
    } finally { c.release(); }
  }

  await t('20. CERROJO: un gasto que espera mientras se cierra el día se rechaza', async () => {
    await pool.query(`DELETE FROM movimientos_caja WHERE negocio_id = $1 AND fecha_operativa = $2`, [NEG_A, DIA_CERROJO]);
    await pool.query(`DELETE FROM cortes_caja WHERE negocio_id = $1 AND fecha_operativa = $2`, [NEG_A, DIA_CERROJO]);
    const r = await conCierreMientrasEspera(
      () => registrarMovimiento(NEG_A, { tipo: 'gasto', monto: 10, motivo: 'tarde', fecha: DIA_CERROJO }), DIA_CERROJO);
    assert.equal(r.error?.code, 'CORTE_CERRADO', 'el gasto entró a un día que se cerró mientras esperaba');
  });

  await t('21. CERROJO: una anulación que espera mientras se cierra el día se rechaza', async () => {
    await pool.query(`DELETE FROM cortes_caja WHERE negocio_id = $1 AND fecha_operativa = $2`, [NEG_A, DIA_CERROJO]);
    const m = await registrarMovimiento(NEG_A, { tipo: 'gasto', monto: 10, motivo: 'x', fecha: DIA_CERROJO });
    const r = await conCierreMientrasEspera(() => anularMovimiento(NEG_A, m.id, { motivo: 'tarde' }), DIA_CERROJO);
    assert.equal(r.error?.code, 'CORTE_CERRADO', 'se anuló un movimiento de un día que se cerró mientras esperaba');
    await pool.query(`DELETE FROM movimientos_caja WHERE id = $1`, [m.id]);
  });

  await t('22. un movimiento SELLADO no se corrige aunque su día figure abierto', async () => {
    // Estado anómalo a propósito: la defensa por sello no puede depender de
    // que la fecha del corte coincida.
    const { rows: [c] } = await pool.query(
      `SELECT id FROM cortes_caja WHERE negocio_id = $1 AND fecha_operativa = $2`, [NEG_A, DIA_CERRADO]);
    const m = await registrarMovimiento(NEG_A, { tipo: 'gasto', monto: 15, motivo: 'sellado', fecha: DIA });
    await pool.query(`UPDATE movimientos_caja SET corte_id = $1 WHERE id = $2`, [c.id, m.id]);
    await rechaza(corregirMovimiento(NEG_A, m.id, { monto: 1, motivo: 'x' }), 'CORTE_CERRADO');
    await rechaza(anularMovimiento(NEG_A, m.id, { motivo: 'x' }), 'CORTE_CERRADO');
  });
} finally {
  await limpiar().catch(() => {});
  await pool.end();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
process.exit(fallidas ? 1 : 0);
