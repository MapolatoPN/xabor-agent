// Cortes de caja: cierres históricos, no resúmenes vivos.
//
// Lo que esta suite protege es dinero y constancia:
//   - VENTAS DEL PERIODO ≠ DINERO FÍSICO. Tarjeta y enlace suman a las
//     ventas y NO al efectivo del cajón. Confundirlos hace que todos los
//     arqueos salgan sobrantes.
//   - UN CORTE CERRADO NUNCA SE RECALCULA. Si mañana alguien edita un pedido
//     de ayer, el corte de ayer debe seguir diciendo exactamente lo mismo.
//   - El día operativo es el del NEGOCIO, no un día UTC: un pedido de las
//     23:40 pertenece a ese día.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const SERVIDOR = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf8').replace(/\r\n/g, '\n');

const { pool } = await import('../src/services/database.js');
const {
  calcularCorteVivo, cerrarCorte, obtenerCorteCerrado, listarCortes,
  registrarMovimiento, listarMovimientos, ticketCorte,
  fechaOperativaDe, fechaOperativaHoy, rangoUtcDeFecha, esFechaValida,
  clasificarFormaPago, zonaHorariaNegocio,
} = await import('../src/services/cortesCaja.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const USUARIO = SEED.adminNegocioAUsuarioId;
const TZ = 'America/Matamoros';
const suf = Date.now().toString().slice(-6);

// Días operativos PROPIOS de esta suite, en un año que ninguna otra suite
// toca. La base de pruebas es COMPARTIDA: sembrar sobre "hoy" o "ayer"
// reales significa medir, sin saberlo, los pedidos que dejó otra corrida --
// exactamente lo que hizo fallar la primera versión de esta suite (73
// pedidos ajenos el 22-ago).
const HOY = '2025-05-20';
const AYER = '2025-05-19';
const ANTIER = '2025-05-18';
const ESPECIFICA = '2025-04-11';
// Las fechas relativas de verdad se prueban aparte, por RESOLUCIÓN de fecha
// (que es lo que el módulo decide) y nunca por importes.
const HOY_REAL = fechaOperativaHoy(TZ);
const AYER_REAL = fechaOperativaDe(new Date(Date.parse(`${HOY_REAL}T12:00:00Z`) - 86400000), TZ);
const ANTIER_REAL = fechaOperativaDe(new Date(Date.parse(`${HOY_REAL}T12:00:00Z`) - 2 * 86400000), TZ);

async function del(sql, params) { try { await pool.query(sql, params); } catch { /* ignorado */ } }
async function limpiar() {
  for (const neg of [NEG_A, NEG_B]) {
    await del(`DELETE FROM movimientos_caja WHERE negocio_id = $1`, [neg]);
    await del(`DELETE FROM cortes_caja WHERE negocio_id = $1`, [neg]);
    await del(`DELETE FROM pagos WHERE negocio_id = $1 AND pedido_folio LIKE 'CC-%'`, [neg]);
    await del(`DELETE FROM pedidos_activos WHERE negocio_id = $1 AND folio LIKE 'CC-%'`, [neg]);
    await del(`DELETE FROM caja_fondos WHERE negocio_id = $1`, [neg]);
  }
}

// Un pedido con una hora LOCAL concreta de un día operativo concreto.
async function pedido(negocio, { fecha, hora = 13, minuto = 0, folio, formaPago, total,
  confirmado = true, estado = 'entregado', devolucion = 0 } = {}) {
  const { inicio } = rangoUtcDeFecha(fecha, TZ);
  const creado = new Date(inicio.getTime() + hora * 3600000 + minuto * 60000);
  const datos = {
    total, forma_pago: formaPago, pago_confirmado: confirmado,
    cliente: { nombre: `Cliente ${folio}` }, items: [],
  };
  if (devolucion > 0) datos.devolucion = { monto: devolucion, motivo: 'prueba' };
  await pool.query(
    `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos, created_at)
     VALUES ($1,$2,$3,$4::jsonb,$5)`,
    [folio, negocio, estado, JSON.stringify(datos), creado.toISOString()]);
  return { folio, creado };
}

async function fondo(negocio, fecha, monto) {
  await pool.query(
    `INSERT INTO caja_fondos (negocio_id, fecha, fondo) VALUES ($1,$2,$3)
     ON CONFLICT (negocio_id, fecha) DO UPDATE SET fondo = EXCLUDED.fondo`,
    [negocio, fecha, monto]);
}

try {
  await limpiar();

  // ── Fixture: un día completo con las cuatro naturalezas de dinero ────────
  await fondo(NEG_A, HOY, 500);
  await pedido(NEG_A, { fecha: HOY, hora: 10, folio: `CC-${suf}-1`, formaPago: 'efectivo', total: 180 });
  await pedido(NEG_A, { fecha: HOY, hora: 11, folio: `CC-${suf}-2`, formaPago: 'efectivo', total: 100 });
  await pedido(NEG_A, { fecha: HOY, hora: 12, folio: `CC-${suf}-3`, formaPago: 'terminal', total: 185 });
  await pedido(NEG_A, { fecha: HOY, hora: 13, folio: `CC-${suf}-4`, formaPago: 'enlace_pago', total: 644 });
  await pedido(NEG_A, { fecha: HOY, hora: 14, folio: `CC-${suf}-5`, formaPago: 'transferencia', total: 90 });
  await pedido(NEG_A, { fecha: HOY, hora: 15, folio: `CC-${suf}-6`, formaPago: 'por_cobrar', total: 300, confirmado: false });
  await pedido(NEG_A, { fecha: HOY, hora: 16, folio: `CC-${suf}-7`, formaPago: 'efectivo', total: 50, estado: 'cancelado' });
  // 23:40 hora local: el caso que un corte por día UTC partiría en dos.
  await pedido(NEG_A, { fecha: HOY, hora: 23, minuto: 40, folio: `CC-${suf}-8`, formaPago: 'efectivo', total: 40 });

  await t('1. HOY: las ventas del día salen agrupadas por naturaleza del dinero', async () => {
    const c = await calcularCorteVivo(NEG_A, HOY);
    assert.strictEqual(c.fecha_operativa, HOY);
    assert.strictEqual(c.ventas_efectivo, 320, 'efectivo = 180+100+40');
    assert.strictEqual(c.ventas_tarjeta, 185);
    assert.strictEqual(c.ventas_enlace, 644);
    assert.strictEqual(c.ventas_otros, 90, 'transferencia no es efectivo ni tarjeta ni enlace');
    assert.strictEqual(c.ventas_totales, 1239);
    assert.strictEqual(c.pedidos_count, 6);
  });

  await t('2. un pedido abierto (por_cobrar sin confirmar) no es venta ni efectivo', async () => {
    const c = await calcularCorteVivo(NEG_A, HOY);
    assert.strictEqual(c.pendiente.num, 1);
    assert.strictEqual(c.pendiente.total, 300);
    assert.ok(!c.pedidos.some(p => p.folio === `CC-${suf}-6`), 'un pedido abierto no debe listarse como cobrado');
  });

  await t('3. un pedido cancelado no cuenta como venta pero sí se reporta', async () => {
    const c = await calcularCorteVivo(NEG_A, HOY);
    assert.strictEqual(c.cancelaciones_count, 1);
    assert.ok(!c.pedidos.some(p => p.folio === `CC-${suf}-7`));
  });

  await t('4. el pedido de las 23:40 pertenece a ese día operativo, no al siguiente', async () => {
    const c = await calcularCorteVivo(NEG_A, HOY);
    assert.ok(c.pedidos.some(p => p.folio === `CC-${suf}-8`),
      'el pedido nocturno se perdió: el día se está calculando en UTC');
    const siguiente = fechaOperativaDe(new Date(Date.parse(`${HOY}T12:00:00Z`) + 86400000), TZ);
    const cSig = await calcularCorteVivo(NEG_A, siguiente);
    assert.ok(!cSig.pedidos.some(p => p.folio === `CC-${suf}-8`), 'se contó dos veces');
  });

  await t('4b. HOY / AYER / ANTIER se resuelven a los días operativos correctos', async () => {
    // Sin fecha, el corte es el de HOY en la zona del negocio.
    const hoy = await calcularCorteVivo(NEG_A);
    assert.strictEqual(hoy.fecha_operativa, HOY_REAL);
    // Y los atajos apuntan a días consecutivos hacia atrás.
    const dias = [HOY_REAL, AYER_REAL, ANTIER_REAL].map(f => Date.parse(`${f}T00:00:00Z`));
    assert.strictEqual(dias[0] - dias[1], 86400000);
    assert.strictEqual(dias[1] - dias[2], 86400000);
    for (const f of [AYER_REAL, ANTIER_REAL, ESPECIFICA]) {
      const c = await calcularCorteVivo(NEG_A, f);
      assert.strictEqual(c.fecha_operativa, f, `no se pudo consultar el día ${f}`);
      assert.ok(Number.isFinite(c.efectivo_esperado));
    }
  });

  await t('5. timezone: el rango del día sale de la zona horaria del negocio', async () => {
    assert.strictEqual(await zonaHorariaNegocio(NEG_A), TZ, 'sin configuración explícita debe caer al default');
    const rMat = rangoUtcDeFecha('2026-08-22', 'America/Matamoros');
    const rTij = rangoUtcDeFecha('2026-08-22', 'America/Tijuana');
    assert.strictEqual(rTij.inicio.getTime() - rMat.inicio.getTime(), 2 * 3600000,
      'Tijuana debe arrancar 2 horas después que Matamoros');
    assert.strictEqual(rMat.fin.getTime() - rMat.inicio.getTime(), 24 * 3600000);
    // Y una zona basura no puede tumbar la pantalla.
    assert.strictEqual(clasificarFormaPago(null), 'otros');
    assert.ok(!esFechaValida('2026-13-99') && esFechaValida('2026-08-22'));
  });

  await t('6. el fondo inicial entra al efectivo esperado y no a las ventas', async () => {
    const c = await calcularCorteVivo(NEG_A, HOY);
    assert.strictEqual(c.fondo_inicial, 500);
    assert.strictEqual(c.efectivo_esperado, 820, '500 fondo + 320 ventas en efectivo');
    assert.ok(!String(c.ventas_totales).includes('1739'), 'el fondo no puede sumar a las ventas');
  });

  await t('7. tarjeta y enlace NO aumentan el efectivo esperado', async () => {
    const c = await calcularCorteVivo(NEG_A, HOY);
    // Es el corazón del módulo: 1239 de ventas pero solo 820 de dinero físico.
    assert.strictEqual(c.ventas_totales, 1239);
    assert.strictEqual(c.efectivo_esperado, 820);
  });

  await t('8. entrada, retiro y gasto mueven el efectivo esperado en su sentido', async () => {
    await registrarMovimiento(NEG_A, { tipo: 'entrada', monto: 200, motivo: 'Cambio', usuarioId: USUARIO, fecha: HOY });
    await registrarMovimiento(NEG_A, { tipo: 'retiro', monto: 150, motivo: 'Deposito', usuarioId: USUARIO, fecha: HOY });
    await registrarMovimiento(NEG_A, { tipo: 'gasto', monto: 70, motivo: 'Servilletas', usuarioId: USUARIO, fecha: HOY });
    const c = await calcularCorteVivo(NEG_A, HOY);
    assert.strictEqual(c.entradas, 200);
    assert.strictEqual(c.retiros, 150);
    assert.strictEqual(c.gastos, 70);
    assert.strictEqual(c.efectivo_esperado, 800, '500 + 320 + 200 - 150 - 70');
    assert.strictEqual(c.movimientos.length, 3);
  });

  await t('9. un movimiento inválido se rechaza con motivo, no en silencio', async () => {
    for (const malo of [
      { tipo: 'prestamo', monto: 10, motivo: 'x' },
      { tipo: 'gasto', monto: 0, motivo: 'x' },
      { tipo: 'gasto', monto: -5, motivo: 'x' },
      { tipo: 'gasto', monto: 'abc', motivo: 'x' },
      { tipo: 'gasto', monto: 10, motivo: '   ' },
    ]) {
      await assert.rejects(() => registrarMovimiento(NEG_A, { ...malo, fecha: HOY }),
        e => ['TIPO_INVALIDO', 'MONTO_INVALIDO', 'MOTIVO_REQUERIDO'].includes(e.code),
        `se aceptó un movimiento inválido: ${JSON.stringify(malo)}`);
    }
  });

  await t('10. una devolución en efectivo baja el efectivo esperado; una con tarjeta no', async () => {
    await pedido(NEG_A, { fecha: AYER, hora: 12, folio: `CC-${suf}-D1`, formaPago: 'efectivo', total: 100, devolucion: 100 });
    await pedido(NEG_A, { fecha: AYER, hora: 13, folio: `CC-${suf}-D2`, formaPago: 'terminal', total: 200, devolucion: 200 });
    const c = await calcularCorteVivo(NEG_A, AYER);
    assert.strictEqual(c.devoluciones_total, 300, 'las dos devoluciones se reportan');
    assert.strictEqual(c.devoluciones_efectivo, 100, 'solo la de efectivo sale del cajón');
    assert.strictEqual(c.efectivo_esperado, 0, '0 fondo + 100 efectivo - 100 devuelto');
  });

  // ── Cierre y snapshot ────────────────────────────────────────────────────
  await t('11. cerrar el día produce un corte con folio y arqueo cuadrado', async () => {
    const { corte, yaExistia } = await cerrarCorte(NEG_A, {
      fecha: AYER, efectivoContado: 0, nota: null, usuarioId: USUARIO });
    assert.strictEqual(yaExistia, false);
    assert.match(corte.folio, /^COR-\d{6}$/);
    assert.strictEqual(corte.estado, 'cerrado');
    assert.strictEqual(Number(corte.diferencia), 0, 'contado 0 sobre esperado 0 es cuadrado');
    assert.ok(corte.cerrado_at);
  });

  await t('12. sobrante y faltante se calculan con signo', async () => {
    await fondo(NEG_A, ANTIER, 100);
    await pedido(NEG_A, { fecha: ANTIER, hora: 12, folio: `CC-${suf}-A1`, formaPago: 'efectivo', total: 200 });
    const { corte } = await cerrarCorte(NEG_A, { fecha: ANTIER, efectivoContado: 320, usuarioId: USUARIO });
    assert.strictEqual(Number(corte.efectivo_esperado), 300);
    assert.strictEqual(Number(corte.diferencia), 20, 'contado 320 sobre esperado 300 = +20 sobrante');

    // Faltante en otro día.
    const otra = '2025-05-02';
    await fondo(NEG_A, otra, 100);
    await pedido(NEG_A, { fecha: otra, hora: 12, folio: `CC-${suf}-A2`, formaPago: 'efectivo', total: 200 });
    const r2 = await cerrarCorte(NEG_A, { fecha: otra, efectivoContado: 280, nota: 'Falto cambio', usuarioId: USUARIO });
    assert.strictEqual(Number(r2.corte.diferencia), -20);
    assert.strictEqual(r2.corte.nota, 'Falto cambio');
  });

  await t('13. una diferencia NO impide cerrar', async () => {
    const otra = '2025-05-03';
    await pedido(NEG_A, { fecha: otra, hora: 12, folio: `CC-${suf}-A3`, formaPago: 'efectivo', total: 500 });
    const { corte } = await cerrarCorte(NEG_A, { fecha: otra, efectivoContado: 1, usuarioId: USUARIO });
    assert.strictEqual(corte.estado, 'cerrado');
    assert.strictEqual(Number(corte.diferencia), -499);
  });

  await t('14. cerrar sin contar deja contado en NULL, distinto de contar cero', async () => {
    const otra = '2025-05-04';
    await pedido(NEG_A, { fecha: otra, hora: 12, folio: `CC-${suf}-A4`, formaPago: 'efectivo', total: 100 });
    const { corte } = await cerrarCorte(NEG_A, { fecha: otra, efectivoContado: null, usuarioId: USUARIO });
    assert.strictEqual(corte.efectivo_contado, null, '"no conté" no puede confundirse con "conté $0"');
    assert.strictEqual(Number(corte.diferencia), 0);
  });

  await t('15. SNAPSHOT INMUTABLE: cambiar un pedido no altera el corte cerrado', async () => {
    const antes = await obtenerCorteCerrado(NEG_A, ANTIER);
    // Alguien edita el pedido de un día ya cerrado (y hasta agrega otro).
    await pool.query(
      `UPDATE pedidos_activos SET datos = jsonb_set(datos, '{total}', '9999') WHERE folio = $1`,
      [`CC-${suf}-A1`]);
    await pedido(NEG_A, { fecha: ANTIER, hora: 20, folio: `CC-${suf}-A9`, formaPago: 'efectivo', total: 777 });
    const despues = await obtenerCorteCerrado(NEG_A, ANTIER);
    assert.strictEqual(Number(despues.ventas_totales), Number(antes.ventas_totales),
      'el corte cerrado se recalculó: la historia financiera cambió sola');
    assert.strictEqual(Number(despues.efectivo_esperado), Number(antes.efectivo_esperado));
    assert.strictEqual(despues.folio, antes.folio);
    // Y el snapshot conserva el detalle original.
    assert.ok(!JSON.stringify(despues.snapshot_json).includes('9999'));
  });

  await t('16. refrescar la pantalla no cambia un corte cerrado', async () => {
    const uno = await obtenerCorteCerrado(NEG_A, ANTIER);
    const dos = await obtenerCorteCerrado(NEG_A, ANTIER);
    assert.deepStrictEqual(JSON.stringify(uno), JSON.stringify(dos));
  });

  await t('17. DOBLE CLICK: dos cierres simultáneos no crean dos cortes', async () => {
    const otra = '2025-05-05';
    await pedido(NEG_A, { fecha: otra, hora: 12, folio: `CC-${suf}-B1`, formaPago: 'efectivo', total: 300 });
    const [r1, r2, r3] = await Promise.all([
      cerrarCorte(NEG_A, { fecha: otra, efectivoContado: 300, usuarioId: USUARIO }),
      cerrarCorte(NEG_A, { fecha: otra, efectivoContado: 300, usuarioId: USUARIO }),
      cerrarCorte(NEG_A, { fecha: otra, efectivoContado: 300, usuarioId: USUARIO }),
    ]);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM cortes_caja WHERE negocio_id = $1 AND fecha_operativa = $2`, [NEG_A, otra]);
    assert.strictEqual(rows[0].n, 1, 'se crearon cortes duplicados para el mismo día');
    const ids = new Set([r1.corte.id, r2.corte.id, r3.corte.id]);
    assert.strictEqual(ids.size, 1, 'las tres respuestas deben referirse al mismo corte');
    assert.strictEqual([r1, r2, r3].filter(r => r.yaExistia).length, 2, 'dos debieron reportar ya_existia');
  });

  await t('18. cerrar de nuevo devuelve el corte existente, no uno nuevo ni un error', async () => {
    const r = await cerrarCorte(NEG_A, { fecha: ANTIER, efectivoContado: 99999, usuarioId: USUARIO });
    assert.strictEqual(r.yaExistia, true);
    assert.strictEqual(Number(r.corte.efectivo_contado), 320, 'el segundo intento no puede reescribir el arqueo');
  });

  await t('19. un día cerrado no admite movimientos nuevos', async () => {
    await assert.rejects(
      () => registrarMovimiento(NEG_A, { tipo: 'gasto', monto: 10, motivo: 'tarde', fecha: ANTIER }),
      e => e.code === 'CORTE_CERRADO');
  });

  await t('20. los movimientos del día quedan sellados al corte que los contó', async () => {
    const otra = '2025-05-06';
    await registrarMovimiento(NEG_A, { tipo: 'gasto', monto: 25, motivo: 'Hielo', usuarioId: USUARIO, fecha: otra });
    await cerrarCorte(NEG_A, { fecha: otra, efectivoContado: 0, usuarioId: USUARIO });
    const movs = await listarMovimientos(NEG_A, otra);
    assert.strictEqual(movs.length, 1);
    assert.ok(movs[0].corte_id, 'el movimiento quedó suelto, sin corte');
  });

  // ── Pagos tardíos ────────────────────────────────────────────────────────
  await t('21. PAGO TARDÍO: se reconoce el día que se confirmó, sin tocar el corte viejo', async () => {
    const diaPedido = '2025-04-10';
    const diaCobro = '2025-04-12';
    await pedido(NEG_A, { fecha: diaPedido, hora: 12, folio: `CC-${suf}-T1`, formaPago: 'por_cobrar', total: 500, confirmado: false });
    const { corte: corteViejo } = await cerrarCorte(NEG_A, { fecha: diaPedido, efectivoContado: 0, usuarioId: USUARIO });
    assert.strictEqual(Number(corteViejo.ventas_totales), 0, 'un pedido sin cobrar no es venta todavía');

    const { inicio } = rangoUtcDeFecha(diaCobro, TZ);
    await pool.query(
      `INSERT INTO pagos (negocio_id, pedido_folio, proveedor, referencia_interna, monto, estado, paid_at)
       VALUES ($1,$2,'clip',$3,500,'pagado',$4)`,
      [NEG_A, `CC-${suf}-T1`, `ref-${suf}-T1`, new Date(inicio.getTime() + 10 * 3600000).toISOString()]);

    const cobro = await calcularCorteVivo(NEG_A, diaCobro);
    assert.strictEqual(cobro.ventas_enlace, 500, 'el pago tardío debe reconocerse el día que se confirmó');
    assert.strictEqual(cobro.cobros_dias_anteriores.length, 1);
    assert.strictEqual(cobro.cobros_dias_anteriores[0].fecha_original, diaPedido,
      'debe quedar trazable de qué día venía');
    // Y el corte ya cerrado sigue exactamente igual.
    const revisado = await obtenerCorteCerrado(NEG_A, diaPedido);
    assert.strictEqual(Number(revisado.ventas_totales), 0, 'se reescribió historia cerrada');
  });

  await t('22. un pago tardío nunca se cuenta como efectivo físico', async () => {
    const cobro = await calcularCorteVivo(NEG_A, '2025-04-12');
    assert.strictEqual(cobro.ventas_efectivo, 0);
    assert.strictEqual(cobro.efectivo_esperado, 0, 'un cobro por enlace no pone dinero en el cajón');
  });

  // ── Aislamiento multiempresa ─────────────────────────────────────────────
  await t('23. aislamiento: el corte de A no ve ni un peso de B', async () => {
    await pedido(NEG_B, { fecha: HOY, hora: 12, folio: `CC-${suf}-B-AJENO`, formaPago: 'efectivo', total: 7777 });
    const a = await calcularCorteVivo(NEG_A, HOY);
    const b = await calcularCorteVivo(NEG_B, HOY);
    assert.ok(!a.pedidos.some(p => /AJENO/.test(p.folio)), 'se coló un pedido del otro negocio');
    assert.strictEqual(b.ventas_efectivo, 7777);
    assert.notStrictEqual(a.ventas_efectivo, b.ventas_efectivo);
  });

  await t('24. aislamiento: cada negocio numera sus cortes y ve solo los suyos', async () => {
    await cerrarCorte(NEG_B, { fecha: HOY, efectivoContado: 7777, usuarioId: null });
    const cortesA = await listarCortes(NEG_A);
    const cortesB = await listarCortes(NEG_B);
    assert.ok(cortesA.length >= 5);
    assert.strictEqual(cortesB.length, 1);
    assert.strictEqual(cortesB[0].folio, 'COR-000001', 'el folio se numera por negocio, no global');
    const idsA = new Set(cortesA.map(c => c.id));
    assert.ok(!cortesB.some(c => idsA.has(c.id)));
  });

  // ── Histórico y ticket ───────────────────────────────────────────────────
  await t('25. el histórico trae lo que la tabla necesita, del más nuevo al más viejo', async () => {
    const lista = await listarCortes(NEG_A, { limite: 100 });
    for (const c of lista) {
      for (const campo of ['fecha_operativa', 'folio', 'estado', 'ventas_totales', 'ventas_efectivo',
        'efectivo_esperado', 'efectivo_contado', 'diferencia', 'pedidos_count']) {
        assert.ok(campo in c, `falta ${campo} en el histórico`);
      }
    }
    // fecha_operativa llega como Date de pg: se compara en ISO, nunca con
    // String(Date) -- ese orden lexicográfico no significa nada.
    const iso = lista.map(c => new Date(c.fecha_operativa).toISOString().slice(0, 10));
    assert.deepStrictEqual(iso, [...iso].sort().reverse(), 'el histórico no está en orden descendente');
  });

  await t('26. un día sin corte no aparece en el histórico (nunca como "cerrado")', async () => {
    const sinCorte = '2025-04-30';
    assert.strictEqual(await obtenerCorteCerrado(NEG_A, sinCorte), null);
    const lista = await listarCortes(NEG_A, { limite: 100 });
    assert.ok(!lista.some(c => new Date(c.fecha_operativa).toISOString().slice(0, 10) === sinCorte));
    // Y el corte vivo de ese día se puede consultar, marcado como no cerrado.
    const vivo = await calcularCorteVivo(NEG_A, sinCorte);
    assert.strictEqual(vivo.fecha_operativa, sinCorte);
    assert.ok(!('folio' in vivo), 'un resumen vivo no puede tener folio de corte');
  });

  await t('27. el TICKET se arma desde el snapshot, no de volver a consultar ventas', async () => {
    const corte = await obtenerCorteCerrado(NEG_A, ANTIER);
    const ticket = ticketCorte(corte, { negocioNombre: 'Nonna Maye' });
    assert.match(ticket, /NONNA MAYE/);
    assert.match(ticket, /CORTE DE CAJA/);
    assert.match(ticket, new RegExp(corte.folio));
    assert.match(ticket, /ESPERADO/);
    assert.match(ticket, /CONTADO/);
    assert.match(ticket, /DIFERENCIA/);
    assert.match(ticket, /SOBRANTE/, 'ese corte tenía +20 y el papel debe decirlo');
    assert.match(ticket, /CORTE CERRADO/);
    assert.match(ticket, /Cancelaciones: /);
    // El pedido editado después del cierre vale 9999: no puede aparecer.
    assert.ok(!ticket.includes('9,999'), 'el ticket volvió a consultar las ventas vivas');
    // Reimprimir da EXACTAMENTE el mismo papel.
    assert.strictEqual(ticketCorte(corte, { negocioNombre: 'Nonna Maye' }), ticket);
  });

  await t('28. el ticket cabe en papel térmico y muestra los cobros de días anteriores', async () => {
    const corte = await obtenerCorteCerrado(NEG_A, ANTIER);
    for (const l of ticketCorte(corte).split('\n')) {
      assert.ok(l.length <= 32, `línea de ${l.length} caracteres no cabe en 32: "${l}"`);
    }
    // Cierre de un día con cobro tardío: el papel lo declara.
    await cerrarCorte(NEG_A, { fecha: '2025-04-12', efectivoContado: 0, usuarioId: USUARIO });
    const conTardio = await obtenerCorteCerrado(NEG_A, '2025-04-12');
    const ticket = ticketCorte(conTardio);
    assert.match(ticket, /Cobrado de dias anteriores/);
    assert.match(ticket, new RegExp(`CC-${suf}-T1`));
  });

  // ── Impresión ────────────────────────────────────────────────────────────
  await t('29. la impresión nunca gobierna el cierre (contrato en el servidor)', async () => {
    // El corte se asienta primero y la impresión va después, atrapada: una
    // impresora apagada no puede impedir que el arqueo quede registrado.
    const cerrar = SERVIDOR.slice(SERVIDOR.indexOf("app.post('/api/corte-caja/cerrar'"),
      SERVIDOR.indexOf("app.get('/api/corte-caja/:fecha/ticket'"));
    const posCierre = cerrar.indexOf('await cerrarCorte(');
    const posImpresion = cerrar.indexOf('imprimirCorte(');
    assert.ok(posCierre > -1 && posImpresion > posCierre,
      'la impresión debe ocurrir DESPUÉS de asentar el corte');
    assert.match(cerrar, /imprimirCorte\([^)]*\)\.catch\(/,
      'un fallo de impresión debe quedar atrapado, no tumbar el cierre');
    // Y el servicio de cortes no importa nada de impresión: son capas separadas.
    const servicio = readFileSync(join(__dirname, '..', 'src', 'services', 'cortesCaja.js'), 'utf8');
    assert.ok(!/impresion|impresora|Edge/i.test(servicio.replace(/\/\*[\s\S]*?\*\//g, '')),
      'el cálculo financiero no debe saber nada de impresoras');
  });

  await t('30. la impresión reutiliza Xabor Edge, sin sistema paralelo', async () => {
    assert.match(SERVIDOR, /crearTrabajosDeDocumento\(\{\s*\n?\s*negocioId, documento: 'corte_caja'/,
      'el corte debe imprimirse por la misma tubería que comandas y cuentas');
    // Reimprimir lleva origenId propio: dos reimpresiones son dos papeles.
    assert.match(SERVIDOR, /reimpresion \? `\$\{corte\.id\}:re:\$\{Date\.now\(\)\}` : corte\.id/);
  });

  // ── Contratos de la pantalla ─────────────────────────────────────────────
  await t('31. la pantalla distingue un día abierto de un corte cerrado', () => {
    const PANEL = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');
    // El estado va SIEMPRE a la vista: un resumen vivo no puede parecer un
    // arqueo firmado.
    assert.match(PANEL, /CERRADO · \$\{data\.folio\}/);
    assert.match(PANEL, /ABIERTO · resumen en vivo/);
    // Un corte cerrado se lee, no se edita.
    assert.match(PANEL, /contado\.disabled = true/);
    assert.match(PANEL, /btnCerrar\.style\.display = 'none'/);
    // Y un día cerrado esconde el alta de movimientos.
    assert.match(PANEL, /form\.style\.display = data\.cerrado \? 'none' : 'flex'/);
  });

  await t('32. la pantalla permite navegar días y reimprimir sin cerrar de nuevo', () => {
    const PANEL = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');
    for (const f of ['corteDia', 'corteIrA', 'corteIrAFecha', 'cargarHistorialCortes', 'verTicketCorte', 'reimprimirCorte']) {
      assert.ok(PANEL.includes(`function ${f}`), `falta ${f} en el panel`);
    }
    // Reimprimir usa su propio endpoint: nunca vuelve a llamar a /cerrar.
    const reimp = PANEL.slice(PANEL.indexOf('async function reimprimirCorte'));
    assert.ok(!/corte-caja\/cerrar/.test(reimp.slice(0, 900)), 'reimprimir no puede pasar por el cierre');
    assert.match(reimp, /\/imprimir`, \{ method: 'POST' \}/);
    // El histórico marca explícitamente un corte que se cerró sin contar.
    assert.match(PANEL, /sin contar/);
  });

  await t('33. la diferencia no bloquea el cierre en la pantalla', () => {
    const PANEL = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');
    const calc = PANEL.slice(PANEL.indexOf('function corteCalcularDiferencia'), PANEL.indexOf('async function cerrarCorteDia'));
    assert.ok(!/disabled = true/.test(calc), 'una diferencia no puede deshabilitar el botón de cerrar');
    assert.match(calc, /SOBRANTE|FALTANTE|CUADRADO|pintarDiferenciaCorte/);
    // Solo pide explicación cuando hay diferencia.
    assert.match(calc, /dif !== 0 \? '' : 'none'/);
  });

  await t('34. el fondo inicial se puede registrar desde la pantalla, y no en un día cerrado', () => {
    const PANEL = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');
    // Sin poder capturar el fondo, el arqueo nunca cuadra: el módulo quedaría
    // dependiendo de que alguien entre a la base.
    assert.ok(PANEL.includes('function registrarFondoCaja'), 'falta el alta de fondo en la pantalla');
    assert.match(PANEL, /id="btn-fondo-caja"/);
    assert.match(PANEL, /'\/api\/caja\/fondo', \{ method: 'POST', body: JSON\.stringify\(\{ monto, fecha: CORTE_FECHA \}\) \}/,
      'el fondo debe ir contra el día que se está viendo, no contra "hoy"');
    // Y el backend rechaza tocar el fondo de un día ya cerrado.
    assert.match(SERVIDOR, /El corte del \$\{fecha\} ya está cerrado \(\$\{cerrado\.folio\}\): su fondo no se puede cambiar/);
    const ruta = SERVIDOR.slice(SERVIDOR.indexOf("app.post('/api/caja/fondo'"), SERVIDOR.indexOf("app.get('/api/caja/fondo'"));
    assert.match(ruta, /zonaHorariaNegocio\(req\.negocioId\)/, 'el fondo debe usar el día operativo del negocio');
    assert.ok(!/fechaHoyMX\(\)/.test(ruta), 'quedó la fecha con zona horaria fija');
  });

  await t('35. DÍAS DISTINTOS a la vez: ni folios duplicados ni un día sin corte', async () => {
    // Lo destapó el gate previo al despliegue, no esta suite: el caso 17 solo
    // probaba concurrencia sobre la MISMA fecha, que el UNIQUE de (negocio,
    // fecha) ya cubría. Con fechas DISTINTAS el UNIQUE no aplica, los cierres
    // contaban lo mismo para armar el folio y el segundo reventaba contra el
    // único de folio -- ese día se quedaba SIN corte.
    const diasConc = ['2025-11-01', '2025-11-02', '2025-11-03', '2025-11-04'];
    for (const d of diasConc) {
      await pedido(NEG_A, { fecha: d, hora: 12, folio: `CC-K${suf}-${d.slice(8)}`, formaPago: 'efectivo', total: 100 });
    }
    const resultados = await Promise.allSettled(
      diasConc.flatMap(d => [0, 1, 2].map(() =>
        cerrarCorte(NEG_A, { fecha: d, efectivoContado: 100, usuarioId: USUARIO }))));
    const rechazadas = resultados.filter(r => r.status === 'rejected');
    assert.strictEqual(rechazadas.length, 0,
      `un cierre legítimo falló: ${rechazadas[0]?.reason?.message}`);
    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*)::int n, COUNT(DISTINCT folio)::int folios
         FROM cortes_caja WHERE negocio_id = $1 AND fecha_operativa >= '2025-11-01' AND fecha_operativa <= '2025-11-04'`,
      [NEG_A]);
    assert.strictEqual(c.n, 4, `se esperaban 4 cortes y quedaron ${c.n}: hay días sin corte`);
    assert.strictEqual(c.folios, 4, 'se repitió un folio entre días distintos');
  });

  await t('36. una lectura dentro de la transacción no puede agotar el pool', () => {
    const svc = readFileSync(join(__dirname, '..', 'src', 'services', 'cortesCaja.js'), 'utf8');
    const tx = svc.slice(svc.indexOf('const client = await pool.connect();'), svc.indexOf('export async function obtenerCorteCerrado'));
    // Pedir OTRO cliente del pool teniendo uno tomado cuelga el proceso bajo
    // concurrencia: dentro de la transacción todo va con `client`.
    assert.ok(!/obtenerCorteCerrado\(negocioId, fechaOperativa\)(?!,)/.test(tx),
      'hay una lectura dentro de la transacción que pide otro cliente del pool');
    assert.match(tx, /obtenerCorteCerrado\(negocioId, fechaOperativa, client\)/);
    assert.match(tx, /pg_advisory_xact_lock/, 'falta el cerrojo que serializa los cierres del negocio');
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
