// LO OPERADO SIN INTERNET, INCORPORADO A LA NUBE.
//
// Va de punta a punta: el motor local del Edge (`edge/sala/operacionLocal.js`)
// genera un lote real, y `sincronizacionSala.js` lo ingiere en Postgres. No se
// simula el lote a mano a propósito -- si las dos mitades dejaran de encajar,
// una prueba con datos inventados no se enteraría.
//
// Lo que protege:
//   · Subir el mismo lote dos veces NO duplica ventas ni pagos.
//   · Una venta cobrada sin enlace entra al corte igual que una en vivo.
//   · Un conflicto de una mesa no bloquea las demás ventas del día.
//   · Un cobro es un hecho: se guarda aunque la nube ya haya cerrado la cuenta,
//     pero la venta NO se recalcula.
//
// Uso: DATABASE_URL=... node test/fase-sala-sincronizacion.mjs
import assert from 'assert';
import { randomUUID } from 'node:crypto';

const { pool } = await import('../src/services/database.js');
const { crearSalaLocal } = await import('../edge/sala/operacionLocal.js');
const { sincronizarLoteSala, CONFLICTOS } = await import('../src/services/sincronizacionSala.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixture ─────────────────────────────────────────────────────────────────
const q1 = async (sql, params) => (await pool.query(sql, params)).rows[0];
const NEG = (await q1(`INSERT INTO negocios (nombre, slug) VALUES ('Sala Offline','sala-offline-sync')
   ON CONFLICT (slug) DO UPDATE SET nombre='Sala Offline' RETURNING id`)).id;
const OTRO = (await q1(`INSERT INTO negocios (nombre, slug) VALUES ('Sala Offline Ajena','sala-offline-ajena')
   ON CONFLICT (slug) DO UPDATE SET nombre='Sala Offline Ajena' RETURNING id`)).id;

async function limpiar() {
  for (const n of [NEG, OTRO]) {
    await pool.query(`DELETE FROM restaurante_cuenta_pagos WHERE negocio_id=$1`, [n]).catch(() => {});
    await pool.query(`DELETE FROM restaurante_cuenta_items WHERE negocio_id=$1`, [n]).catch(() => {});
    await pool.query(`DELETE FROM restaurante_cuentas WHERE negocio_id=$1`, [n]).catch(() => {});
    await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1`, [n]).catch(() => {});
  }
}
await limpiar();

// `usuarios_identidad_check` exige email o pin_hash: un mesero se identifica
// por PIN, así que el fixture usa uno de mentira (nunca se autentica aquí).
const crearUsuario = async (negocio, nombre) => {
  const u = await q1(`INSERT INTO usuarios (negocio_id, nombre, activo, pin_hash)
     VALUES ($1,$2,true,'pin-de-prueba') RETURNING id`, [negocio, nombre]);
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo)
     VALUES ($1,$2,'mesero',true) ON CONFLICT DO NOTHING`, [u.id, negocio]);
  return u.id;
};
const MESERO = await crearUsuario(NEG, 'Ana Mesera');

// Una sala local nueva por prueba: uuid real (como en el Edge) y reloj fijo.
const sala = () => crearSalaLocal({ uuid: randomUUID, ahora: () => new Date('2026-09-09T20:00:00Z') });
const item = (producto, precio, cantidad = 1) => ({ producto, precio_unitario: precio, cantidad });

/** Mesa completa cobrada sin enlace: el caso normal al reconectar. */
function mesaCobrada(s, mesa, items, pagos) {
  const c = s.abrirMesa({ mesaNumero: mesa, personas: 2, meseroUsuarioId: MESERO, meseroNombre: 'Ana Mesera' });
  s.agregarItems(c.id, items);
  s.enviarComanda(c.id);
  for (const p of pagos) s.registrarPago(c.id, p);
  const cerrada = s.cerrarCuenta(c.id);
  return { cuentaId: c.id, ventaFolio: cerrada.ventaFolio };
}

const contarVenta = async (folio) => (await q1(
  `SELECT COUNT(*)::int AS n FROM pedidos_activos WHERE folio=$1`, [folio])).n;
const venta = async (folio) => (await q1(`SELECT datos FROM pedidos_activos WHERE folio=$1`, [folio]))?.datos;

// ═══ S1/S2. Incorporación e idempotencia ═══════════════════════════════════
await t('S1. una mesa cobrada sin internet entra completa: cuenta, items, pagos y venta', async () => {
  await limpiar();
  const s = sala();
  const { cuentaId, ventaFolio } = mesaCobrada(s, 1,
    [item('Chilaquiles', 195), item('Café', 45, 2)],
    [{ metodo: 'efectivo', monto: 285, propina: 30 }]);

  const r = await sincronizarLoteSala(NEG, s.exportarLote());
  assert.strictEqual(r.conflictos, 0, JSON.stringify(r.reporte));
  assert.strictEqual(r.aplicadas, 1);

  const cta = await q1(`SELECT estado, venta_folio, mesa_numero FROM restaurante_cuentas WHERE id=$1`, [cuentaId]);
  assert.strictEqual(cta.estado, 'cerrada');
  assert.strictEqual(cta.venta_folio, ventaFolio, 'el folio que se imprimió es el que quedó');
  assert.strictEqual(cta.mesa_numero, 1);

  const items = await q1(`SELECT COUNT(*)::int AS n FROM restaurante_cuenta_items WHERE cuenta_id=$1`, [cuentaId]);
  assert.strictEqual(items.n, 2);
  const v = await venta(ventaFolio);
  assert.ok(v, 'la venta consolidada existe');
  assert.strictEqual(Number(v.total), 285);
  assert.strictEqual(Number(v.propinas), 30);
  assert.strictEqual(v.sincronizada_offline, true, 'queda marcada como cobrada sin enlace');
});

await t('S2. subir el MISMO lote otra vez no duplica nada', async () => {
  await limpiar();
  const s = sala();
  const { cuentaId, ventaFolio } = mesaCobrada(s, 2, [item('Plato', 100)], [{ metodo: 'efectivo', monto: 100 }]);
  const lote = s.exportarLote();

  await sincronizarLoteSala(NEG, lote);
  const r2 = await sincronizarLoteSala(NEG, lote);   // el Edge reintenta porque perdió el ACK
  assert.strictEqual(r2.conflictos, 0, JSON.stringify(r2.reporte));

  assert.strictEqual(await contarVenta(ventaFolio), 1, 'una sola venta, no dos');
  const pagos = await q1(`SELECT COUNT(*)::int AS n FROM restaurante_cuenta_pagos WHERE cuenta_id=$1`, [cuentaId]);
  assert.strictEqual(pagos.n, 1, 'un cobro no puede contarse dos veces en la caja');
  const items = await q1(`SELECT COUNT(*)::int AS n FROM restaurante_cuenta_items WHERE cuenta_id=$1`, [cuentaId]);
  assert.strictEqual(items.n, 1);
});

await t('S3. el total de la venta coincide con lo que calculó el Edge (centavos incluidos)', async () => {
  await limpiar();
  const s = sala();
  const { ventaFolio } = mesaCobrada(s, 3,
    [item('A', 19.99), item('B', 0.1), item('C', 0.2)],
    [{ metodo: 'efectivo', monto: 20.29 }]);
  await sincronizarLoteSala(NEG, s.exportarLote());
  const v = await venta(ventaFolio);
  assert.strictEqual(Number(v.total), 20.29, 'sin deriva de flotante entre el ticket y la nube');
});

// ═══ S4/S5. Conflictos que exigen decisión humana ══════════════════════════
await t('S4. otra cuenta abierta en la misma mesa → conflicto, y NO se inserta nada', async () => {
  await limpiar();
  // La nube ya tiene la mesa 7 abierta (otro dispositivo siguió en línea).
  const ajena = randomUUID();
  await pool.query(
    `INSERT INTO restaurante_cuentas (id, negocio_id, mesa_numero, personas, mesero_usuario_id, abierta_por)
     VALUES ($1,$2,7,2,$3,$3)`, [ajena, NEG, MESERO]);

  const s = sala();
  const c = s.abrirMesa({ mesaNumero: 7, personas: 2, meseroUsuarioId: MESERO });
  s.agregarItems(c.id, [item('Plato', 100)]);

  const r = await sincronizarLoteSala(NEG, s.exportarLote());
  assert.strictEqual(r.conflictos, 1);
  assert.strictEqual(r.reporte[0].conflicto, CONFLICTOS.MESA_OCUPADA);
  const existe = await q1(`SELECT COUNT(*)::int AS n FROM restaurante_cuentas WHERE id=$1`, [c.id]);
  assert.strictEqual(existe.n, 0, 'no se fuerza: dos cuentas en una mesa las resuelve una persona');
  assert.strictEqual(r.eventosConfirmados.length, 0, 'y el Edge conserva sus eventos para reintentar');
});

await t('S5. un mesero que ya no existe en la nube se reporta, no revienta', async () => {
  await limpiar();
  const s = sala();
  const c = s.abrirMesa({ mesaNumero: 8, personas: 1, meseroUsuarioId: randomUUID() });
  s.agregarItems(c.id, [item('Plato', 100)]);
  const r = await sincronizarLoteSala(NEG, s.exportarLote());
  assert.strictEqual(r.conflictos, 1);
  assert.strictEqual(r.reporte[0].conflicto, CONFLICTOS.USUARIO_DESCONOCIDO);
});

// ═══ S6. El dinero cobrado es un hecho ═════════════════════════════════════
await t('S6. pagos de una cuenta que la nube YA cerró se guardan, sin recalcular la venta', async () => {
  await limpiar();
  const s = sala();
  const { cuentaId, ventaFolio } = mesaCobrada(s, 9, [item('Plato', 100)], [{ metodo: 'efectivo', monto: 100 }]);
  await sincronizarLoteSala(NEG, s.exportarLote());
  const totalAntes = Number((await venta(ventaFolio)).total);

  // Llega tarde otro cobro de esa misma cuenta (propina capturada al final).
  const s2 = crearSalaLocal({
    uuid: randomUUID, ahora: () => new Date('2026-09-09T21:00:00Z'),
    estadoInicial: s.serializar(),
  });
  s2.marcarLoteSincronizado(s.exportarLote().eventos.map((e) => e.id));
  const cuenta = s2.serializar().cuentas.find((c) => c.id === cuentaId);
  cuenta.pagos.push({
    id: randomUUID(), metodo: 'efectivo', monto_centavos: 5000, propina_centavos: 0,
    cubre: 'llegó tarde', referencia: null, registrado_por: MESERO, created_at: new Date().toISOString(),
  });

  const r = await sincronizarLoteSala(NEG, { cuentas: [cuenta], eventos: [] });
  assert.strictEqual(r.conflictos, 0);
  assert.strictEqual(r.reporte[0].conflicto, CONFLICTOS.PAGO_SOBRE_CUENTA_CERRADA,
    'se reporta para que alguien lo mire');
  const pagos = await q1(`SELECT COUNT(*)::int AS n FROM restaurante_cuenta_pagos WHERE cuenta_id=$1`, [cuentaId]);
  assert.strictEqual(pagos.n, 2, 'el cobro se guarda: es un hecho');
  assert.strictEqual(Number((await venta(ventaFolio)).total), totalAntes,
    'pero la venta ya contabilizada NO se recalcula sola');
});

// ═══ S7/S8. Aislamiento y resistencia del lote ═════════════════════════════
await t('S7. una mesa en conflicto no bloquea las otras ventas del lote', async () => {
  await limpiar();
  const ajena = randomUUID();
  await pool.query(
    `INSERT INTO restaurante_cuentas (id, negocio_id, mesa_numero, personas, mesero_usuario_id, abierta_por)
     VALUES ($1,$2,11,2,$3,$3)`, [ajena, NEG, MESERO]);

  const s = sala();
  const buena1 = mesaCobrada(s, 12, [item('Plato', 100)], [{ metodo: 'efectivo', monto: 100 }]);
  const enConflicto = s.abrirMesa({ mesaNumero: 11, personas: 2, meseroUsuarioId: MESERO });
  s.agregarItems(enConflicto.id, [item('Plato', 50)]);
  const buena2 = mesaCobrada(s, 13, [item('Otro', 70)], [{ metodo: 'terminal', monto: 70 }]);

  const r = await sincronizarLoteSala(NEG, s.exportarLote());
  assert.strictEqual(r.aplicadas, 2, 'las dos mesas cobradas entran');
  assert.strictEqual(r.conflictos, 1);
  assert.strictEqual(await contarVenta(buena1.ventaFolio), 1);
  assert.strictEqual(await contarVenta(buena2.ventaFolio), 1);
});

await t('S8. el lote nunca escribe en otro negocio', async () => {
  await limpiar();
  const s = sala();
  const { cuentaId } = mesaCobrada(s, 14, [item('Plato', 100)], [{ metodo: 'efectivo', monto: 100 }]);
  // El mesero es de NEG, no de OTRO: sincronizar contra OTRO debe rechazarlo.
  const r = await sincronizarLoteSala(OTRO, s.exportarLote());
  assert.strictEqual(r.conflictos, 1);
  assert.strictEqual(r.reporte[0].conflicto, CONFLICTOS.USUARIO_DESCONOCIDO);
  const enOtro = await q1(`SELECT COUNT(*)::int AS n FROM restaurante_cuentas WHERE id=$1 AND negocio_id=$2`, [cuentaId, OTRO]);
  assert.strictEqual(enOtro.n, 0);
});

await t('S9. una mesa todavía abierta sube como abierta y NO genera venta', async () => {
  await limpiar();
  const s = sala();
  const c = s.abrirMesa({ mesaNumero: 15, personas: 3, meseroUsuarioId: MESERO });
  s.agregarItems(c.id, [item('Plato', 100)]);
  s.enviarComanda(c.id);

  const r = await sincronizarLoteSala(NEG, s.exportarLote());
  assert.strictEqual(r.conflictos, 0, JSON.stringify(r.reporte));
  const cta = await q1(`SELECT estado, venta_folio, comandas_emitidas FROM restaurante_cuentas WHERE id=$1`, [c.id]);
  assert.strictEqual(cta.estado, 'abierta', 'la mesa sigue viva: se puede seguir atendiendo desde la nube');
  assert.strictEqual(cta.venta_folio, null, 'sin cobro no hay venta');
  assert.strictEqual(cta.comandas_emitidas, 1);
  const ventas = await q1(`SELECT COUNT(*)::int AS n FROM pedidos_activos WHERE negocio_id=$1`, [NEG]);
  assert.strictEqual(ventas.n, 0);
});

await t('S10. solo se confirman los eventos de lo que sí entró', async () => {
  await limpiar();
  const ajena = randomUUID();
  await pool.query(
    `INSERT INTO restaurante_cuentas (id, negocio_id, mesa_numero, personas, mesero_usuario_id, abierta_por)
     VALUES ($1,$2,20,2,$3,$3)`, [ajena, NEG, MESERO]);
  const s = sala();
  mesaCobrada(s, 21, [item('Plato', 100)], [{ metodo: 'efectivo', monto: 100 }]);
  const choca = s.abrirMesa({ mesaNumero: 20, personas: 2, meseroUsuarioId: MESERO });
  s.agregarItems(choca.id, [item('Plato', 50)]);

  const lote = s.exportarLote();
  const r = await sincronizarLoteSala(NEG, lote);
  const confirmados = new Set(r.eventosConfirmados);
  const delConflicto = lote.eventos.filter((e) => e.cuentaId === choca.id);
  assert.ok(delConflicto.length > 0);
  assert.ok(delConflicto.every((e) => !confirmados.has(e.id)),
    'lo no aplicado no se confirma: el Edge lo conserva y lo reintenta');

  const descartados = s.marcarLoteSincronizado(r.eventosConfirmados);
  assert.strictEqual(s.pendientesDeSincronizar(), delConflicto.length,
    'y en la cola local queda exactamente lo que falta por resolver');
  assert.ok(descartados > 0);
});

// ═══ S11. La caja del día correcto ═════════════════════════════════════════
await t('S11. la venta cobrada sin enlace entra al corte del día en que SE COBRÓ', async () => {
  await limpiar();
  // Se cobró el sábado a las 20:00 UTC; el enlace no volvió hasta el domingo.
  const cobradaAt = new Date('2026-09-05T20:00:00Z');
  const s = crearSalaLocal({ uuid: randomUUID, ahora: () => cobradaAt });
  const { ventaFolio } = mesaCobrada(s, 30, [item('Plato', 250)], [{ metodo: 'efectivo', monto: 250 }]);

  await sincronizarLoteSala(NEG, s.exportarLote());   // se sincroniza HOY

  // OJO con el tipo: `pedidos_activos.created_at` es `timestamp WITHOUT time
  // zone` y `entregado_at` es `timestamptz`. Leer la primera con el driver la
  // reinterpreta como hora local de la máquina y parece corrida; la comparación
  // honesta se hace del lado de Postgres, que es quien la va a comparar en el
  // corte.
  const fila = await q1(
    `SELECT to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS creada,
            to_char(entregado_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS entregada
       FROM pedidos_activos WHERE folio=$1`, [ventaFolio]);
  assert.strictEqual(fila.creada, '2026-09-05T20:00:00',
    'si created_at fuera el de la sincronización, el dinero del sábado aparecería en el corte del domingo');
  assert.strictEqual(fila.entregada, '2026-09-05T20:00:00');
});

await t('S12. y el corte de ese día la cuenta como efectivo', async () => {
  await limpiar();
  const { calcularCorteVivo } = await import('../src/services/cortesCaja.js');
  const cobradaAt = new Date('2026-09-05T20:00:00Z');
  const s = crearSalaLocal({ uuid: randomUUID, ahora: () => cobradaAt });
  mesaCobrada(s, 31, [item('Plato', 250)], [{ metodo: 'efectivo', monto: 250 }]);
  await sincronizarLoteSala(NEG, s.exportarLote());

  const corte = await calcularCorteVivo(NEG, '2026-09-05');
  assert.ok(corte, 'el corte del sábado existe');
  assert.strictEqual(Number(corte.ventas_efectivo), 250,
    `la venta cobrada sin enlace debe estar en el efectivo del sábado; corte: ${JSON.stringify(corte.ventas_efectivo)}`);
  assert.strictEqual(Number(corte.pedidos_count), 1, 'y contarse como una venta del día');

  // Control: el día de la sincronización NO debe llevarse ese dinero.
  const domingo = await calcularCorteVivo(NEG, '2026-09-06');
  assert.strictEqual(Number(domingo.ventas_efectivo), 0,
    'el dinero del sábado no puede aparecer en el corte del domingo');
});

await limpiar();
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
