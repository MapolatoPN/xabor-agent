// Ajustes de cierre semanal — la venta original es inmutable, una venta
// facturada está bloqueada, y revertir jamás borra.
//
// Fixture: 100 ventas en la semana operativa del lunes 2026-08-10 (20
// facturadas vía facturas_pedido, 10 abiertas sin cobro confirmado, 70
// elegibles), todas de $100 para que los totales se verifiquen a mano.
//
// Uso: DATABASE_URL=... PANEL_SECRET=... SESSION_SECRET=... ADMIN_PASSWORD=...
//      node test/fase-ajustes-cierre.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4298';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, registrarFacturaEmitida } = await import('../src/services/database.js');
const {
  lunesDeSemana, semanaOperativa, ventasDeSemana, ajustesDeSemana,
  previewAjuste, aplicarAjuste, revertirAjuste, csvSemana,
} = await import('../src/services/ajustesCierre.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG_A = SEED.negocioA, NEG_B = SEED.negocioB;
const LUNES = '2026-08-10';               // semana fixture, completamente en el pasado
const FECHA = '2026-08-12';               // un miércoles de esa semana
const folio = (n) => `AJC-${String(n).padStart(4, '0')}`;

// ── Fixture ─────────────────────────────────────────────────────────────────
await pool.query(`DELETE FROM ajustes_cierre WHERE negocio_id = $1::uuid`, [NEG_A]);
await pool.query(`DELETE FROM facturas_pedido WHERE negocio_id = $1::uuid`, [NEG_A]);
await pool.query(`DELETE FROM pedidos_activos WHERE folio LIKE 'AJC-%' OR folio LIKE 'AJB-%'`);
await pool.query(
  `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'caja','activo')
   ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [NEG_A]);

// 100 ventas de $100, repartidas de lunes a domingo (10:00 local ≈ 15:00Z).
for (let i = 1; i <= 100; i++) {
  const dia = 10 + ((i - 1) % 7);         // 2026-08-10 .. 2026-08-16
  const abierta = i > 90;                 // AJC-0091..0100: sin cobro confirmado
  const datos = {
    total: 100,
    forma_pago: abierta ? 'por_cobrar' : (i % 3 === 0 ? 'terminal' : 'efectivo'),
    pago_confirmado: !abierta,
    cliente: { nombre: `Cliente ${i}` },
  };
  await pool.query(
    `INSERT INTO pedidos_activos (folio, estado, datos, created_at, updated_at, negocio_id)
     VALUES ($1, 'entregado', $2, $3, $3, $4)`,
    [folio(i), JSON.stringify(datos), `2026-08-${dia}T15:00:00Z`, NEG_A]);
}
// 20 facturadas: AJC-0001..0020 (la fuente es facturas_pedido, migración 065).
for (let i = 1; i <= 20; i++) {
  await pool.query(
    `INSERT INTO facturas_pedido (negocio_id, folio, factura_id, uuid, total, fuente)
     VALUES ($1::uuid, $2, $3, $4, 100, 'panel')`,
    [NEG_A, folio(i), `fapi-${i}`, `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`]);
}
// Una venta FUERA de la semana (lunes siguiente) y una del negocio B.
await pool.query(
  `INSERT INTO pedidos_activos (folio, estado, datos, created_at, updated_at, negocio_id)
   VALUES ('AJC-9999', 'entregado', $1, '2026-08-17T15:00:00Z', '2026-08-17T15:00:00Z', $2)`,
  [JSON.stringify({ total: 100, forma_pago: 'efectivo', pago_confirmado: true }), NEG_A]);
await pool.query(
  `INSERT INTO pedidos_activos (folio, estado, datos, created_at, updated_at, negocio_id)
   VALUES ('AJB-0001', 'entregado', $1, '2026-08-12T15:00:00Z', '2026-08-12T15:00:00Z', $2)`,
  [JSON.stringify({ total: 100, forma_pago: 'efectivo', pago_confirmado: true }), NEG_B]);
// Borde de zona horaria: domingo 23:40 HORA LOCAL (Matamoros, UTC-5 en
// agosto) = lunes 04:40 UTC. Pertenece a la semana fixture.
await pool.query(
  `INSERT INTO pedidos_activos (folio, estado, datos, created_at, updated_at, negocio_id)
   VALUES ('AJC-0777', 'entregado', $1, '2026-08-17T04:40:00Z', '2026-08-17T04:40:00Z', $2)`,
  [JSON.stringify({ total: 100, forma_pago: 'efectivo', pago_confirmado: true }), NEG_A]);

const base = { tipo: 'descuento', modo: 'fijo', valor: 5, motivo: 'prueba', fecha: FECHA };

// ═══ B23: semana, elegibilidad y totales ════════════════════════════════════
await t('1. lunesDeSemana: cualquier día cae al lunes correcto', () => {
  for (const d of ['2026-08-10', '2026-08-12', '2026-08-16']) assert.strictEqual(lunesDeSemana(d), LUNES);
  assert.strictEqual(lunesDeSemana('2026-08-17'), '2026-08-17', 'el lunes siguiente ya es otra semana');
});

await t('2. la semana operativa usa la zona del negocio', async () => {
  const s = await semanaOperativa(NEG_A, FECHA);
  assert.strictEqual(s.lunes, LUNES);
  assert.strictEqual(s.domingo, '2026-08-16');
  assert.strictEqual(s.timezone, 'America/Matamoros');
});

await t('3. ventasDeSemana: las 101 de la semana (100 + borde tz), sin la de la semana siguiente', async () => {
  const { ventas } = await ventasDeSemana(NEG_A, FECHA);
  assert.strictEqual(ventas.length, 101);
  assert.ok(!ventas.some(v => v.folio === 'AJC-9999'), 'la venta del lunes siguiente NO aparece');
  assert.ok(ventas.some(v => v.folio === 'AJC-0777'), 'el domingo 23:40 hora local SÍ pertenece a la semana');
});

await t('4. resumen: 20 facturadas / 81 no facturadas / 10 abiertas, totales a mano', async () => {
  const { resumen } = await ventasDeSemana(NEG_A, FECHA);
  assert.strictEqual(resumen.facturadas_count, 20);
  assert.strictEqual(resumen.facturadas_total, 2000);
  assert.strictEqual(resumen.no_facturadas_count, 81);
  assert.strictEqual(resumen.abiertas_count, 10);
  assert.strictEqual(resumen.total_original, 10100);
});

await t('5. una venta facturada NO es elegible; una abierta tampoco', async () => {
  const { ventas } = await ventasDeSemana(NEG_A, FECHA);
  const m = new Map(ventas.map(v => [v.folio, v]));
  assert.strictEqual(m.get(folio(1)).facturada, true);
  assert.strictEqual(m.get(folio(1)).elegible, false);
  assert.strictEqual(m.get(folio(95)).abierta, true);
  assert.strictEqual(m.get(folio(95)).elegible, false);
  assert.strictEqual(m.get(folio(50)).elegible, true);
});

// ═══ B23: vista previa ══════════════════════════════════════════════════════
await t('6. preview fijo: $5 POR TICKET en multi-selección', async () => {
  const p = await previewAjuste(NEG_A, { ...base, folios: [folio(30), folio(31), folio(32)] });
  assert.strictEqual(p.renglones.length, 3);
  assert.ok(p.renglones.every(r => r.monto_ajuste === 5 && r.monto_neto === 95));
  assert.strictEqual(p.total_ajuste, 15);
  assert.strictEqual(p.aplicable, true);
});

await t('7. preview porcentual: individual, sobre el neto disponible', async () => {
  const p = await previewAjuste(NEG_A, { ...base, modo: 'porcentual', valor: 10, folios: [folio(40)] });
  assert.strictEqual(p.renglones[0].monto_ajuste, 10);
  assert.strictEqual(p.renglones[0].monto_neto, 90);
});

await t('8. porcentual sobre varias ventas se rechaza (decisión de producto)', async () => {
  await assert.rejects(
    previewAjuste(NEG_A, { ...base, modo: 'porcentual', valor: 10, folios: [folio(40), folio(41)] }),
    (e) => e.code === 'PORCENTUAL_INDIVIDUAL');
});

await t('9. preview con venta facturada: rechazo FACTURADA, no aplicable', async () => {
  const p = await previewAjuste(NEG_A, { ...base, folios: [folio(1), folio(30)] });
  assert.strictEqual(p.aplicable, false);
  assert.deepStrictEqual(p.rechazos.map(r => `${r.folio}:${r.razon}`), [`${folio(1)}:FACTURADA`]);
});

await t('10. preview con venta abierta: rechazo ABIERTA', async () => {
  const p = await previewAjuste(NEG_A, { ...base, folios: [folio(95)] });
  assert.strictEqual(p.rechazos[0].razon, 'ABIERTA');
});

await t('11. preview que excede el neto disponible: rechazo EXCEDE_NETO', async () => {
  const p = await previewAjuste(NEG_A, { ...base, valor: 150, folios: [folio(30)] });
  assert.strictEqual(p.rechazos[0].razon, 'EXCEDE_NETO');
});

await t('12. validaciones de captura: tipo/modo/valor/motivo/folios', async () => {
  const casos = [
    [{ ...base, folios: [] }, 'FOLIOS_REQUERIDOS'],
    [{ ...base, folios: [folio(30), folio(30)] }, 'FOLIOS_DUPLICADOS'],
    [{ ...base, folios: [folio(30)], tipo: 'regalo' }, 'TIPO_INVALIDO'],
    [{ ...base, folios: [folio(30)], modo: 'magico' }, 'MODO_INVALIDO'],
    [{ ...base, folios: [folio(30)], valor: 0 }, 'VALOR_INVALIDO'],
    [{ ...base, folios: [folio(30)], valor: -5 }, 'VALOR_INVALIDO'],
    [{ ...base, folios: [folio(30)], modo: 'porcentual', valor: 120 }, 'VALOR_INVALIDO'],
    [{ ...base, folios: [folio(30)], motivo: '   ' }, 'MOTIVO_REQUERIDO'],
  ];
  for (const [sol, code] of casos) {
    await assert.rejects(previewAjuste(NEG_A, sol), (e) => e.code === code, `esperaba ${code}`);
  }
});

// ═══ B23: confirmación transaccional ════════════════════════════════════════
await t('13. aplicar fijo $5 a 5 tickets: 5 renglones, un lote, aritmética en DB', async () => {
  const folios = [folio(50), folio(51), folio(52), folio(53), folio(54)];
  const r = await aplicarAjuste(NEG_A, { ...base, folios }, SEED.adminNegocioAUsuarioId);
  assert.strictEqual(r.aplicados, 5);
  assert.strictEqual(r.total_ajuste, 25);
  const { rows } = await pool.query(
    `SELECT lote_id, monto_original, monto_ajuste, monto_neto, tipo, estado
       FROM ajustes_cierre WHERE negocio_id = $1::uuid AND folio = ANY($2)`, [NEG_A, folios]);
  assert.strictEqual(rows.length, 5);
  assert.strictEqual(new Set(rows.map(x => x.lote_id)).size, 1, 'un solo lote');
  assert.ok(rows.every(x => Number(x.monto_original) === 100 && Number(x.monto_ajuste) === 5 && Number(x.monto_neto) === 95));
});

await t('14. LA VENTA ORIGINAL NO CAMBIÓ (datos y updated_at intactos)', async () => {
  const { rows: [v] } = await pool.query(
    `SELECT datos, created_at, updated_at FROM pedidos_activos WHERE folio = $1`, [folio(50)]);
  assert.strictEqual(Number(v.datos.total), 100, 'el total original sigue siendo $100');
  // Sin touch: updated_at sigue idéntico a created_at (el fixture los creó
  // iguales; cualquier UPDATE lo habría movido).
  assert.strictEqual(new Date(v.updated_at).getTime(), new Date(v.created_at).getTime(), 'ni un touch');
});

await t('15. el neto se refleja en la semana sin tocar el original', async () => {
  const { ventas } = await ventasDeSemana(NEG_A, FECHA);
  const v = ventas.find(x => x.folio === folio(50));
  assert.strictEqual(v.total_original, 100);
  assert.strictEqual(v.ajustes_total, 5);
  assert.strictEqual(v.total_neto, 95);
});

await t('16. ajustes acumulables: el disponible descuenta los previos', async () => {
  const p = await previewAjuste(NEG_A, { ...base, valor: 96, folios: [folio(50)] });
  assert.strictEqual(p.rechazos[0].razon, 'EXCEDE_NETO', '$96 > $95 disponibles tras el primer ajuste');
  const ok = await previewAjuste(NEG_A, { ...base, valor: 95, folios: [folio(50)] });
  assert.strictEqual(ok.renglones[0].monto_neto, 0, 'hasta $95 sí cabe (neto 0 permitido)');
});

await t('17. CARRERA preview→commit: facturada en medio = lote rechazado completo', async () => {
  const folios = [folio(60), folio(61)];
  const p = await previewAjuste(NEG_A, { ...base, folios });
  assert.strictEqual(p.aplicable, true);
  // Alguien factura AJC-0060 después de la vista previa:
  await registrarFacturaEmitida({ negocioId: NEG_A, folio: folio(60), facturaId: 'fapi-carrera', fuente: 'panel' });
  await assert.rejects(aplicarAjuste(NEG_A, { ...base, folios }), (e) =>
    e.code === 'FACTURADA_TRAS_PREVIEW' && e.message.includes(folio(60)));
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ajustes_cierre WHERE negocio_id = $1::uuid AND folio = ANY($2)`,
    [NEG_A, folios]);
  assert.strictEqual(rows[0].n, 0, 'all-or-nothing: TAMPOCO se ajustó la venta no facturada');
});

await t('18. concurrencia: dos commits de $60 sobre la misma venta de $100 — solo uno pasa', async () => {
  const sol = { ...base, valor: 60, folios: [folio(70)] };
  const res = await Promise.allSettled([aplicarAjuste(NEG_A, sol), aplicarAjuste(NEG_A, sol)]);
  const ok = res.filter(r => r.status === 'fulfilled');
  const mal = res.filter(r => r.status === 'rejected');
  assert.strictEqual(ok.length, 1, 'FOR UPDATE serializa: exactamente uno gana');
  assert.strictEqual(mal[0].reason.code, 'SELECCION_NO_ELEGIBLE');
  const { rows: [s] } = await pool.query(
    `SELECT COALESCE(SUM(monto_ajuste),0) AS total FROM ajustes_cierre
      WHERE negocio_id = $1::uuid AND folio = $2 AND estado = 'aplicado'`, [NEG_A, folio(70)]);
  assert.strictEqual(Number(s.total), 60, 'el neto jamás queda negativo');
});

// ═══ B23: reversión ═════════════════════════════════════════════════════════
await t('19. revertir un ajuste: constancia, no borrado, y el neto regresa', async () => {
  const r = await aplicarAjuste(NEG_A, { ...base, folios: [folio(80)] }, SEED.adminNegocioAUsuarioId);
  const { rows: [a] } = await pool.query(
    `SELECT id FROM ajustes_cierre WHERE lote_id = $1`, [r.lote_id]);
  const rev = await revertirAjuste(NEG_A, { ajusteId: a.id, motivo: 'captura equivocada', usuarioId: SEED.adminNegocioAUsuarioId });
  assert.strictEqual(rev.revertidos, 1);
  const { rows: [fila] } = await pool.query(`SELECT estado, motivo_reversion, revertido_at FROM ajustes_cierre WHERE id = $1`, [a.id]);
  assert.strictEqual(fila.estado, 'revertido');
  assert.strictEqual(fila.motivo_reversion, 'captura equivocada');
  assert.ok(fila.revertido_at, 'fecha de reversión sellada');
  const { ventas } = await ventasDeSemana(NEG_A, FECHA);
  assert.strictEqual(ventas.find(v => v.folio === folio(80)).total_neto, 100, 'el neto regresó');
});

await t('20. revertir lote completo de una multi-selección', async () => {
  const r = await aplicarAjuste(NEG_A, { ...base, folios: [folio(81), folio(82), folio(83)] });
  const rev = await revertirAjuste(NEG_A, { loteId: r.lote_id, motivo: 'lote equivocado' });
  assert.strictEqual(rev.revertidos, 3);
});

await t('21. revertir dos veces no hace nada; sin motivo se rechaza', async () => {
  const r = await aplicarAjuste(NEG_A, { ...base, folios: [folio(84)] });
  await revertirAjuste(NEG_A, { loteId: r.lote_id, motivo: 'primera' });
  const otra = await revertirAjuste(NEG_A, { loteId: r.lote_id, motivo: 'segunda' });
  assert.strictEqual(otra.revertidos, 0, 'ya estaba revertido');
  await assert.rejects(revertirAjuste(NEG_A, { loteId: r.lote_id, motivo: '  ' }), (e) => e.code === 'MOTIVO_REQUERIDO');
});

// ═══ B23: reporte y brecha documentada ══════════════════════════════════════
await t('22. CSV: una línea por venta, facturada SI/NO, netos y totales', async () => {
  const { nombre, csv } = await csvSemana(NEG_A, FECHA);
  assert.strictEqual(nombre, `ajustes-cierre-${LUNES}.csv`);
  const lineas = csv.split('\n');
  assert.ok(lineas[0].startsWith('semana,folio,fecha_operativa'));
  assert.strictEqual(lineas.filter(l => l.includes('AJC-')).length, 101);
  const l50 = lineas.find(l => l.includes(folio(50)));
  assert.ok(l50.includes('NO') && l50.includes('95.00'), 'ajustada: neto 95, no facturada');
  const l1 = lineas.find(l => l.includes(folio(1)));
  assert.ok(l1.includes('SI'), 'facturada marcada');
  assert.ok(lineas.some(l => l.startsWith('TOTALES')));
});

await t('23. ajustada y facturada DESPUÉS: marcada para revisión manual (brecha CFDI)', async () => {
  await aplicarAjuste(NEG_A, { ...base, folios: [folio(85)] });
  await registrarFacturaEmitida({ negocioId: NEG_A, folio: folio(85), facturaId: 'fapi-post', fuente: 'whatsapp' });
  const { ventas } = await ventasDeSemana(NEG_A, FECHA);
  const v = ventas.find(x => x.folio === folio(85));
  assert.strictEqual(v.revisar_manual, true);
  assert.strictEqual(v.elegible, false, 'y ya no acepta más ajustes');
  const { csv } = await csvSemana(NEG_A, FECHA);
  assert.ok(csv.split('\n').find(l => l.includes(folio(85))).trim().endsWith('SI'));
});

await t('24. tenant isolation a nivel servicio: B no ve ni puede ajustar ventas de A', async () => {
  const { ventas } = await ventasDeSemana(NEG_B, FECHA);
  assert.ok(!ventas.some(v => v.folio.startsWith('AJC-')), 'B solo ve lo suyo');
  await assert.rejects(aplicarAjuste(NEG_B, { ...base, folios: [folio(30)] }), (e) =>
    e.code === 'SELECCION_NO_ELEGIBLE' && e.rechazos[0].razon === 'NO_EXISTE');
});

await t('25. el módulo JAMÁS escribe en ventas, pagos ni cortes (contrato de fuente)', () => {
  const SRC = readFileSync(join(RAIZ, 'src', 'services', 'ajustesCierre.js'), 'utf8');
  assert.ok(!/UPDATE\s+pedidos_activos/i.test(SRC));
  assert.ok(!/INSERT\s+INTO\s+pedidos_activos/i.test(SRC));
  assert.ok(!/UPDATE\s+(pagos|cortes_caja|movimientos_caja)/i.test(SRC));
  assert.ok(!/INSERT\s+INTO\s+(pagos|cortes_caja|movimientos_caja)/i.test(SRC));
  assert.ok(!/DELETE\s+FROM/i.test(SRC), 'reversión sin DELETE: constancia siempre');
});

await t('26. registrarFacturaEmitida: valida y NUNCA lanza', async () => {
  assert.strictEqual(await registrarFacturaEmitida({ negocioId: NEG_A, folio: 'X-1', fuente: 'sat' }), false, 'fuente inválida');
  assert.strictEqual(await registrarFacturaEmitida({ negocioId: NEG_A, folio: '', fuente: 'panel' }), false, 'sin folio');
  assert.strictEqual(await registrarFacturaEmitida({ negocioId: 'no-es-uuid', folio: 'X-1', fuente: 'panel' }), false, 'negocio inválido: la DB rechaza y la función no lanza');
  assert.strictEqual(await registrarFacturaEmitida({ negocioId: NEG_A, folio: 'AJC-0002', facturaId: 're-1', fuente: 'panel' }), true, 'refacturación legítima: segundo renglón permitido');
});

// ═══ B24: adversarial (HTTP) ════════════════════════════════════════════════
const srv = await arrancarServidor({ PORT: PUERTO, OPENAI_API_KEY: '' }, { timeoutMs: 30000 });
const BASE_URL = srv.base;
const cookie = (usuarioId, rol = 'admin') =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId: NEG_A, rol }))}`;
const http = (path, { metodo = 'GET', body, quien = 'admin' } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (quien === 'admin') headers.Cookie = cookie(SEED.adminNegocioAUsuarioId);
  else if (quien === 'staff') headers.Cookie = cookie(SEED.staffNegocioAUsuarioId, 'staff');
  return fetch(BASE_URL + path, { method: metodo, headers, body: body ? JSON.stringify(body) : undefined });
};

await t('ADV1. sin sesión → 401; staff → bloqueado (solo admin ajusta)', async () => {
  const r = await fetch(`${BASE_URL}/api/admin/ajustes-cierre/semana`);
  assert.strictEqual(r.status, 401);
  const r2 = await http('/api/admin/ajustes-cierre/aplicar', {
    metodo: 'POST', quien: 'staff', body: { ...base, folios: [folio(30)] } });
  assert.ok([401, 403].includes(r2.status), `staff respondió ${r2.status}`);
});

await t('ADV2. errores HTTP con código: 400 captura, 409 conflicto con rechazos', async () => {
  const r = await http('/api/admin/ajustes-cierre/aplicar', {
    metodo: 'POST', body: { ...base, folios: [folio(30)], valor: -1 } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await r.json()).code, 'VALOR_INVALIDO');
  const r2 = await http('/api/admin/ajustes-cierre/aplicar', {
    metodo: 'POST', body: { ...base, folios: [folio(1)] } });
  assert.strictEqual(r2.status, 409, 'venta facturada = conflicto, no error de captura');
  const d = await r2.json();
  assert.ok(Array.isArray(d.rechazos) && d.rechazos[0].razon === 'FACTURADA');
});

await t('ADV3. inyección CSV: motivo con comas/comillas queda escapado', async () => {
  await aplicarAjuste(NEG_A, { ...base, folios: [folio(86)], motivo: 'cliente "vip", cobro, =SUMA(1;2)' });
  const { csv } = await csvSemana(NEG_A, FECHA);
  const linea = csv.split('\n').find(l => l.includes(folio(86)));
  assert.ok(linea.includes('"descuento $5.00 (cliente ""vip"", cobro, =SUMA(1;2))"'),
    'campo completo entrecomillado y comillas dobladas: las comas del motivo no rompen columnas');
});

await t('ADV4. fecha malformada en la URL → 400, jamás 500', async () => {
  const r = await http('/api/admin/ajustes-cierre/semana?fecha=ayer');
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await r.json()).code, 'FECHA_INVALIDA');
});

await t('ADV5. revertir un ajuste inexistente → 404 sin efectos', async () => {
  const r = await http('/api/admin/ajustes-cierre/revertir', {
    metodo: 'POST', body: { ajusteId: '00000000-0000-4000-8000-000000000000', motivo: 'x' } });
  assert.strictEqual(r.status, 404);
});

srv.detener();
await pool.end();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
