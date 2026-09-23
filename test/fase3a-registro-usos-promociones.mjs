// Fase 3A: auditoria multicanal de promociones.
// Esta suite ALTERA estructura: solo corre contra una base desechable test_*.
import assert from 'assert';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { arrancarServidor } from './lib-servidor.mjs';

const SEED = JSON.parse(readFileSync(new URL('./.datos-prueba.json', import.meta.url), 'utf8'));

process.env.XABOR_PROMO_AUDIT_STATEMENT_TIMEOUT_MS ||= '1200';
process.env.XABOR_PROMO_AUDIT_LOCK_TIMEOUT_MS ||= '900';
process.env.XABOR_PROMO_AUDIT_QUERY_TIMEOUT_MS ||= '1600';
process.env.XABOR_PROMO_AUDIT_CONNECTION_TIMEOUT_MS ||= '250';
process.env.XABOR_PROMO_AUDIT_MAX ||= '1';

const { pool } = await import('../src/services/database.js');
const { rows: [identidadDb] } = await pool.query('SELECT current_database() AS nombre');
if (!String(identidadDb?.nombre || '').startsWith('test_')) {
  console.error(`[GUARDIA] Se requiere una base desechable test_*; actual=${identidadDb?.nombre || '(desconocida)'}`);
  await pool.end();
  process.exit(2);
}

const {
  calcularPromociones, guardarCampana, guardarPromocion,
  liberarUsosPromociones, registrarUsosPromociones, reservarUsosPromociones,
} = await import('../src/services/tiendaPromociones.js');
const {
  cerrarPoolAuditoria, reconciliarUsosPromocionesFaltantes,
  registrarUsosDeVenta, telefonoDeAuditoria,
} = await import('../src/services/promoUsosAuditoria.js');
const {
  confirmarPedidoPendientePago, convertirPedidoAProgramado,
  previsualizarPedido, registrarPedido,
} = await import('../src/orders/orderManager.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0;
let fallidas = 0;
const fallos = [];
async function t(categoria, nombre, fn) {
  try {
    await fn();
    pasadas++;
    console.log(`  OK  [${categoria}] ${nombre}`);
  } catch (e) {
    fallidas++;
    fallos.push(`[${categoria}] ${nombre}: ${e.stack || e.message}`);
    console.log(`FALLO [${categoria}] ${nombre}: ${e.message}`);
  }
}

async function reafirmarGuardia() {
  const { rows: [r] } = await pool.query('SELECT current_database() AS nombre');
  assert.match(r.nombre, /^test_/, 'operacion destructiva fuera de test_*');
}

async function montarNegocio(slug, nombre) {
  return (await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1,$2)
     ON CONFLICT (slug) DO UPDATE SET nombre=$1 RETURNING id`,
    [nombre, slug])).rows[0].id;
}

async function categoria(negocioId, nombre) {
  const { rows } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, orden)
     VALUES ($1,$2,0) ON CONFLICT DO NOTHING RETURNING id`, [negocioId, nombre]);
  if (rows[0]) return rows[0].id;
  return (await pool.query(
    `SELECT id FROM menu_categorias WHERE negocio_id=$1 AND nombre=$2 LIMIT 1`,
    [negocioId, nombre])).rows[0].id;
}

async function producto(negocioId, categoriaId, nombre, precio) {
  return (await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [negocioId, categoriaId, nombre, precio])).rows[0].id;
}

async function limpiar(negocioId) {
  await reafirmarGuardia();
  for (const sql of [
    `DELETE FROM tienda_promocion_usos WHERE negocio_id=$1`,
    `DELETE FROM pedidos_programados WHERE negocio_id=$1`,
    `DELETE FROM pedidos_activos WHERE negocio_id=$1`,
    `DELETE FROM tienda_promociones WHERE negocio_id=$1`,
    `DELETE FROM tienda_campanas WHERE negocio_id=$1`,
    `DELETE FROM menu_productos WHERE negocio_id=$1`,
    `DELETE FROM menu_categorias WHERE negocio_id=$1`,
  ]) await pool.query(sql, [negocioId]).catch(() => {});
}

async function nuevaPromo(negocioId, {
  nombre, categorias, campaniaId = null,
  canales = ['pos', 'whatsapp', 'tienda_online'], limitePorCliente = null, valor = 10,
}) {
  return (await guardarPromocion(negocioId, {
    nombre, tipo: 'porcentaje', automatica: true, valor, categorias,
    canales, campaniaId, limitePorCliente,
  })).id;
}

async function usos(negocioId, folio) {
  return (await pool.query(
    `SELECT * FROM tienda_promocion_usos
      WHERE negocio_id=$1 AND pedido_folio=$2 ORDER BY promocion_id`,
    [negocioId, folio])).rows;
}

function promoSnapshot(id, monto = 10, campaniaId = null, nombre = 'Promo') {
  return { promocionId: id, campaniaId, nombre, monto, tipo: 'porcentaje', codigo: null };
}

function ordenPos(negocioId, productoId, promociones = [], extra = {}) {
  const descuento = promociones.reduce((n, p) => n + Number(p.monto || 0), 0);
  return {
    negocioId,
    items: [{ producto_id: productoId, nombre: 'Producto Fase3A', cantidad: 1, precio_unitario: 100 }],
    cliente: { telefono: '8780000001', nombre: 'Cliente POS' },
    subtotal: 100, total: Math.max(0, 100 - descuento), forma_pago: 'efectivo', modalidad: 'recoger',
    descuentos: {
      manual: { monto: 0, tipo: null, motivo: null, autorizadoPor: null },
      promociones, rewards: { monto: 0, puntos: 0 }, total: descuento,
    },
    ...extra,
  };
}

function ordenWhatsapp(negocioId, telefono = '8780000002') {
  return {
    negocioId, items: [{ nombre: 'Producto Fase3A', cantidad: 1 }],
    cliente: { telefono, nombre: 'Cliente WA' }, telefono_conversacion: telefono,
    forma_pago: 'efectivo',
  };
}

async function insertarSnapshot({ negocioId, folio, datos, estado = 'nuevo', programado = false }) {
  if (programado) {
    await pool.query(
      `INSERT INTO pedidos_programados
         (folio, datos, programado_para, activado, negocio_id)
       VALUES ($1,$2,NOW()+INTERVAL '1 day',FALSE,$3)`,
      [folio, JSON.stringify(datos), negocioId]);
  } else {
    await pool.query(
      `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id)
       VALUES ($1,$2,$3,$4)`,
      [folio, estado, JSON.stringify(datos), negocioId]);
  }
}

const sufijo = Date.now().toString(36);
const NEG_A = await montarNegocio(`fase3a-a-${sufijo}`, 'Fase3A A');
const NEG_B = await montarNegocio(`fase3a-b-${sufijo}`, 'Fase3A B');
await limpiar(NEG_A);
await limpiar(NEG_B);
const CAT_A = await categoria(NEG_A, `FASE3A-${sufijo}`);
const CAT_B = await categoria(NEG_B, `FASE3A-${sufijo}`);
const PROD_A = await producto(NEG_A, CAT_A, 'Producto Fase3A', 100);
await producto(NEG_B, CAT_B, 'Producto Fase3A B', 100);

await t('PREDEPLOY', '091 converge una 090 nullable y es reejecutable con escritor viejo', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'Legacy', categorias: [CAT_A] });
  await reafirmarGuardia();
  await pool.query(`ALTER TABLE public.tienda_promocion_usos ADD COLUMN IF NOT EXISTS canal text`);
  await pool.query(`ALTER TABLE public.tienda_promocion_usos ALTER COLUMN canal DROP NOT NULL`);
  await pool.query(`ALTER TABLE public.tienda_promocion_usos ALTER COLUMN canal DROP DEFAULT`);
  const folioLegacy = `F3A-LEGACY-${sufijo}`;
  await pool.query(
    `INSERT INTO tienda_promocion_usos
       (negocio_id,promocion_id,pedido_folio,monto_descuento,monto_venta,estado,canal)
     VALUES ($1,$2,$3,10,90,'consumida',NULL)`, [NEG_A, promoId, folioLegacy]);

  const script = fileURLToPath(new URL('../scripts/predeploy-091-tienda-promocion-usos-canal.mjs', import.meta.url));
  execFileSync(process.execPath, [script], { env: process.env, stdio: 'pipe' });
  assert.strictEqual((await usos(NEG_A, folioLegacy))[0].canal, 'tienda_online');
  const { rows: [col] } = await pool.query(`
    SELECT is_nullable, column_default FROM information_schema.columns
     WHERE table_schema='public' AND table_name='tienda_promocion_usos' AND column_name='canal'`);
  assert.strictEqual(col.is_nullable, 'NO');
  assert.match(col.column_default, /tienda_online/);

  const folioViejo = `F3A-OLD-${sufijo}`;
  await pool.query(
    `INSERT INTO tienda_promocion_usos
       (negocio_id,promocion_id,pedido_folio,monto_descuento,monto_venta,estado)
     VALUES ($1,$2,$3,10,90,'consumida')`, [NEG_A, promoId, folioViejo]);
  execFileSync(process.execPath, [script], { env: process.env, stdio: 'pipe' });
  assert.strictEqual((await usos(NEG_A, folioViejo))[0].canal, 'tienda_online');
});

await t('REGISTRO', 'POS inserta dos promociones atomica e idempotentemente', async () => {
  const p1 = await nuevaPromo(NEG_A, { nombre: 'Pos 1', categorias: [CAT_A] });
  const p2 = await nuevaPromo(NEG_A, { nombre: 'Pos 2', categorias: [CAT_A] });
  const pedido = await registrarPedido(ordenPos(NEG_A, PROD_A, [promoSnapshot(p1), promoSnapshot(p2, 5)]), 'pos');
  assert.strictEqual((await usos(NEG_A, pedido.id)).length, 2);
  const replay = await registrarUsosDeVenta({
    negocioId: NEG_A, folio: pedido.id, promociones: [promoSnapshot(p1), promoSnapshot(p2, 5)],
    telefono: '8780000001', montoVenta: pedido.total, canal: 'pos',
  });
  assert.strictEqual(replay.registrados, 0);
  assert.deepStrictEqual(replay.omitidos, []);
});

await t('REGISTRO', 'WhatsApp real registra canal y telefono de conversacion', async () => {
  const p = await nuevaPromo(NEG_A, { nombre: 'WA', categorias: [CAT_A] });
  const pedido = await registrarPedido(ordenWhatsapp(NEG_A, '5218781234567'), 'whatsapp');
  assert.ok(pedido.descuentos.promociones.some(x => x.promocionId === p));
  const [fila] = await usos(NEG_A, pedido.id);
  assert.strictEqual(fila.canal, 'whatsapp');
  assert.strictEqual(fila.cliente_telefono, '5218781234567');
});

await t('IDENTIDAD', 'telefono_conversacion prevalece y placeholders POS quedan NULL', async () => {
  assert.strictEqual(telefonoDeAuditoria({ telefono_conversacion: '+52 1 878 111 2233', cliente: { telefono: '8789999999' } }), '5218781112233');
  assert.strictEqual(telefonoDeAuditoria({ cliente: { telefono: '—' } }), null);
});

await t('ALLOWLIST', 'voz, api, preview y pedido sin promociones no escriben usos', async () => {
  await nuevaPromo(NEG_A, { nombre: 'Allow', categorias: [CAT_A], canales: ['voz', 'api', 'whatsapp'] });
  const voz = await registrarPedido(ordenWhatsapp(NEG_A, '8781000001'), 'voz');
  const api = await registrarPedido(ordenWhatsapp(NEG_A, '8781000002'), 'api');
  assert.ok(voz.descuentos.promociones.length && api.descuentos.promociones.length);
  assert.strictEqual((await usos(NEG_A, voz.id)).length, 0);
  assert.strictEqual((await usos(NEG_A, api.id)).length, 0);
  const antes = (await pool.query(`SELECT COUNT(*)::int n FROM tienda_promocion_usos WHERE negocio_id=$1`, [NEG_A])).rows[0].n;
  const prev = await previsualizarPedido(ordenWhatsapp(NEG_A, '8781000003'), NEG_A, { canal: 'whatsapp' });
  assert.ok(prev.ok);
  const sinPromo = await registrarPedido(ordenPos(NEG_A, PROD_A, []), 'pos');
  assert.strictEqual((await usos(NEG_A, sinPromo.id)).length, 0);
  const despues = (await pool.query(`SELECT COUNT(*)::int n FROM tienda_promocion_usos WHERE negocio_id=$1`, [NEG_A])).rows[0].n;
  assert.strictEqual(despues, antes);
});

await t('CUPO', 'auditoria POS no consume limite global ni limite por cliente de tienda', async () => {
  const telefono = '8782223344';
  const p = await nuevaPromo(NEG_A, { nombre: 'Cupo tienda', categorias: [CAT_A], limitePorCliente: 1 });
  const antes = (await pool.query(`SELECT usos FROM tienda_promociones WHERE id=$1`, [p])).rows[0].usos;
  await registrarUsosDeVenta({
    negocioId: NEG_A, folio: `F3A-CUPO-${sufijo}`, promociones: [promoSnapshot(p)],
    telefono, montoVenta: 90, canal: 'pos',
  });
  const despues = (await pool.query(`SELECT usos FROM tienda_promociones WHERE id=$1`, [p])).rows[0].usos;
  assert.strictEqual(despues, antes);
  const calculada = await calcularPromociones({
    negocioId: NEG_A, subtotal: 100,
    items: [{ producto_id: PROD_A, categoria_id: CAT_A, cantidad: 1, precio_unitario: 100 }],
    telefono, canal: 'tienda_online', modalidad: 'recoger',
  });
  assert.ok(calculada.aplicadas.some(x => x.id === p), 'el calculo debe ignorar POS');
  const token = `f3a-cupo-${sufijo}`;
  const reservada = await reservarUsosPromociones(NEG_A, calculada.aplicadas, { checkoutToken: token, telefono });
  assert.ok(reservada.reservadas.some(x => x.id === p), 'la reserva debe ignorar POS');
  await liberarUsosPromociones(NEG_A, reservada.reservadas, { checkoutToken: token });
});

await t('PAGO', 'pendiente no registra; al confirmar usa telefono y campania historicos', async () => {
  const c1 = (await guardarCampana(NEG_A, { nombre: `C1-${sufijo}` })).id;
  const c2 = (await guardarCampana(NEG_A, { nombre: `C2-${sufijo}` })).id;
  const p = await nuevaPromo(NEG_A, { nombre: 'Pago', categorias: [CAT_A], campaniaId: c1 });
  const orden = ordenPos(NEG_A, PROD_A, [promoSnapshot(p, 10, c1)], {
    requierePagoAnticipado: true, telefono_conversacion: '5218787654321',
    cliente: { telefono: '8780000999', nombre: 'Entrega distinta' },
  });
  const pedido = await registrarPedido(orden, 'whatsapp');
  assert.strictEqual(pedido.estado, 'pendiente_pago');
  assert.strictEqual((await usos(NEG_A, pedido.id)).length, 0);
  await pool.query(`UPDATE tienda_promociones SET campania_id=$2 WHERE id=$1`, [p, c2]);
  await confirmarPedidoPendientePago(pedido.id, NEG_A);
  const fila = (await usos(NEG_A, pedido.id)).find(x => x.promocion_id === p);
  assert.ok(fila, 'debe existir la fila de la promocion bajo prueba');
  assert.strictEqual(fila.campania_id, c1);
  assert.strictEqual(fila.cliente_telefono, '5218787654321');
  const totalTrasPrimera = (await usos(NEG_A, pedido.id)).length;
  await confirmarPedidoPendientePago(pedido.id, NEG_A);
  const trasReplay = await usos(NEG_A, pedido.id);
  assert.strictEqual(trasReplay.length, totalTrasPrimera);
  assert.strictEqual(trasReplay.filter(x => x.promocion_id === p).length, 1);
});

await t('CTE', 'ID inexistente se reporta sin convertir conflictos en omitidos', async () => {
  const p = await nuevaPromo(NEG_A, { nombre: 'CTE', categorias: [CAT_A] });
  const fantasma = '00000000-0000-0000-0000-000000000000';
  const folio = `F3A-CTE-${sufijo}`;
  const r = await registrarUsosDeVenta({
    negocioId: NEG_A, folio, promociones: [promoSnapshot(p), promoSnapshot(fantasma)],
    montoVenta: 90, canal: 'pos',
  });
  assert.strictEqual(r.registrados, 1);
  assert.deepStrictEqual(r.omitidos, [fantasma]);
  const replay = await registrarUsosDeVenta({
    negocioId: NEG_A, folio, promociones: [promoSnapshot(p)], montoVenta: 90, canal: 'pos',
  });
  assert.deepStrictEqual(replay, { registrados: 0, omitidos: [] });
});

await t('ATOMICIDAD', 'error numeric revierte las dos promociones y el pedido sigue persistido', async () => {
  const p1 = await nuevaPromo(NEG_A, { nombre: 'Atom 1', categorias: [CAT_A] });
  const p2 = await nuevaPromo(NEG_A, { nombre: 'Atom 2', categorias: [CAT_A] });
  const folio = `F3A-ATOM-${sufijo}`;
  await assert.rejects(registrarUsosDeVenta({
    negocioId: NEG_A, folio,
    promociones: [promoSnapshot(p1, 10), promoSnapshot(p2, 1_000_000_000)],
    montoVenta: 90, canal: 'pos',
  }), /numeric field overflow|out of range/i);
  assert.strictEqual((await usos(NEG_A, folio)).length, 0);
  const pedido = await registrarPedido(ordenPos(NEG_A, PROD_A, [
    promoSnapshot(p1, 10), promoSnapshot(p2, 1_000_000_000),
  ]), 'pos');
  assert.ok((await pool.query(`SELECT 1 FROM pedidos_activos WHERE folio=$1`, [pedido.id])).rowCount);
  assert.strictEqual((await usos(NEG_A, pedido.id)).length, 0);
  // El snapshot desbordado ya cumplio su propósito; se retira para que el
  // reconciliador de las pruebas siguientes no lo reintente deliberadamente.
  await pool.query(`DELETE FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [pedido.id, NEG_A]);
});

await t('RECONCILIACION', 'deuda parcial inserta solo la promocion faltante y segunda pasada cero', async () => {
  const p1 = await nuevaPromo(NEG_A, { nombre: 'Parcial 1', categorias: [CAT_A] });
  const p2 = await nuevaPromo(NEG_A, { nombre: 'Parcial 2', categorias: [CAT_A] });
  const folio = `F3A-PARC-${sufijo}`;
  const datos = ordenPos(NEG_A, PROD_A, [promoSnapshot(p1), promoSnapshot(p2, 5)]);
  Object.assign(datos, { id: folio, canal: 'pos', estado: 'nuevo' });
  await insertarSnapshot({ negocioId: NEG_A, folio, datos });
  await registrarUsosDeVenta({ negocioId: NEG_A, folio, promociones: [promoSnapshot(p1)], montoVenta: 85, canal: 'pos' });
  const r1 = await reconciliarUsosPromocionesFaltantes();
  assert.ok(r1.filasInsertadas >= 1);
  assert.strictEqual((await usos(NEG_A, folio)).length, 2);
  const r2 = await reconciliarUsosPromocionesFaltantes();
  assert.strictEqual(r2.filasInsertadas, 0);
});

await t('RECONCILIACION', 'repara programado confirmado y omite programados no confirmados', async () => {
  const p = await nuevaPromo(NEG_A, { nombre: 'Programado', categorias: [CAT_A] });
  const clienteLock = await pool.connect();
  await clienteLock.query('BEGIN');
  await clienteLock.query(`SELECT id FROM tienda_promociones WHERE id=$1 FOR UPDATE`, [p]);
  const inicio = Date.now();
  const pedido = await registrarPedido(ordenPos(NEG_A, PROD_A, [promoSnapshot(p)], {
    programado_para: new Date(Date.now() + 86_400_000).toISOString(),
  }), 'pos');
  assert.ok(Date.now() - inicio < 2_500, 'el hook con lock debe respetar su presupuesto total');
  assert.strictEqual((await usos(NEG_A, pedido.id)).length, 0);
  const conv = await convertirPedidoAProgramado(pedido, pedido.programado_para);
  assert.ok(conv.ok, conv.razon);
  await clienteLock.query('ROLLBACK');
  clienteLock.release();
  const rr = await reconciliarUsosPromocionesFaltantes();
  assert.ok(rr.filasInsertadas >= 1);
  assert.strictEqual((await usos(NEG_A, pedido.id)).length, 1);

  const noPagado = `PP-${sufijo}`;
  const datos = { ...ordenPos(NEG_A, PROD_A, [promoSnapshot(p)]), id: noPagado, canal: 'pos', estado: 'pendiente_pago' };
  await insertarSnapshot({ negocioId: NEG_A, folio: noPagado, datos, programado: true });
  await reconciliarUsosPromocionesFaltantes();
  assert.strictEqual((await usos(NEG_A, noPagado)).length, 0);
});

await t('TIMEOUT', 'pool de auditoria saturado no bloquea el pedido y luego se reconcilia', async () => {
  const pBloqueada = await nuevaPromo(NEG_A, { nombre: 'Pool lock', categorias: [CAT_A] });
  const pPedido = await nuevaPromo(NEG_A, { nombre: 'Pool pedido', categorias: [CAT_A] });
  const clienteLock = await pool.connect();
  await clienteLock.query('BEGIN');
  await clienteLock.query(`SELECT id FROM tienda_promociones WHERE id=$1 FOR UPDATE`, [pBloqueada]);
  const ocupante = registrarUsosDeVenta({
    negocioId: NEG_A, folio: `PL-${sufijo}`, promociones: [promoSnapshot(pBloqueada)],
    montoVenta: 90, canal: 'pos',
  }).then(() => null, e => e);
  await new Promise(resolve => setTimeout(resolve, 100));

  const inicio = Date.now();
  const pedido = await registrarPedido(ordenPos(NEG_A, PROD_A, [promoSnapshot(pPedido)]), 'pos');
  assert.ok(Date.now() - inicio < 1_500, 'connectionTimeoutMillis debe sacar al pedido del pool saturado');
  assert.strictEqual((await usos(NEG_A, pedido.id)).length, 0);
  const errorOcupante = await ocupante;
  await clienteLock.query('ROLLBACK');
  clienteLock.release();
  assert.ok(errorOcupante instanceof Error, 'la consulta retenida debe terminar por timeout');

  await reconciliarUsosPromocionesFaltantes();
  assert.strictEqual((await usos(NEG_A, pedido.id)).filter(x => x.promocion_id === pPedido).length, 1);
});

await t('RECONCILIACION', 'campania viene del snapshot aunque la promocion vigente cambie', async () => {
  const c1 = (await guardarCampana(NEG_A, { nombre: `Hist1-${sufijo}` })).id;
  const c2 = (await guardarCampana(NEG_A, { nombre: `Hist2-${sufijo}` })).id;
  const p = await nuevaPromo(NEG_A, { nombre: 'Historica', categorias: [CAT_A], campaniaId: c1 });
  const folio = `F3A-HIST-${sufijo}`;
  const datos = { ...ordenPos(NEG_A, PROD_A, [promoSnapshot(p, 10, c1)]), id: folio, canal: 'pos', estado: 'nuevo' };
  await insertarSnapshot({ negocioId: NEG_A, folio, datos });
  await pool.query(`UPDATE tienda_promociones SET campania_id=$2 WHERE id=$1`, [p, c2]);
  await reconciliarUsosPromocionesFaltantes();
  assert.strictEqual((await usos(NEG_A, folio))[0].campania_id, c1);

  const folioLegacy = `HL-${sufijo}`;
  const promoLegacy = promoSnapshot(p);
  delete promoLegacy.campaniaId;
  await insertarSnapshot({
    negocioId: NEG_A, folio: folioLegacy,
    datos: { ...ordenPos(NEG_A, PROD_A, [promoLegacy]), id: folioLegacy, canal: 'pos', estado: 'nuevo' },
  });
  await reconciliarUsosPromocionesFaltantes();
  assert.strictEqual((await usos(NEG_A, folioLegacy))[0].campania_id, null,
    'un snapshot anterior al despliegue no inventa la campaña vigente');
});

await t('RECONCILIACION', 'UUID malformado y promociones no-array no bloquean otra reparacion', async () => {
  const p = await nuevaPromo(NEG_A, { nombre: 'JSON seguro', categorias: [CAT_A] });
  const folioMal = `JM-${sufijo}`;
  const folioObj = `JO-${sufijo}`;
  const folioOk = `JK-${sufijo}`;
  const folioViejo = `JV-${sufijo}`;
  await insertarSnapshot({
    negocioId: NEG_A, folio: folioMal,
    datos: { negocioId: NEG_A, canal: 'pos', estado: 'nuevo', total: 90, descuentos: { promociones: [{ promocionId: 'no-es-uuid', monto: 10 }] } },
  });
  await insertarSnapshot({
    negocioId: NEG_A, folio: folioObj,
    datos: { negocioId: NEG_A, canal: 'pos', estado: 'nuevo', total: 90, descuentos: { promociones: { promocionId: p } } },
  });
  await insertarSnapshot({
    negocioId: NEG_A, folio: folioOk,
    datos: { negocioId: NEG_A, canal: 'pos', estado: 'nuevo', total: 90, descuentos: { promociones: [promoSnapshot(p)] } },
  });
  await insertarSnapshot({
    negocioId: NEG_A, folio: folioViejo,
    datos: { negocioId: NEG_A, canal: 'pos', estado: 'nuevo', total: 90, descuentos: { promociones: [promoSnapshot(p)] } },
  });
  await pool.query(
    `UPDATE pedidos_activos SET created_at=NOW()-INTERVAL '49 hours' WHERE folio=$1 AND negocio_id=$2`,
    [folioViejo, NEG_A]);
  await reconciliarUsosPromocionesFaltantes();
  assert.strictEqual((await usos(NEG_A, folioMal)).length, 0);
  assert.strictEqual((await usos(NEG_A, folioObj)).length, 0);
  assert.strictEqual((await usos(NEG_A, folioOk)).length, 1);
  assert.strictEqual((await usos(NEG_A, folioViejo)).length, 0, 'la ventana de 48h limita el barrido');
});

await t('RECONCILIACION', 'dos pasadas simultaneas no se solapan', async () => {
  const [a, b] = await Promise.all([
    reconciliarUsosPromocionesFaltantes(), reconciliarUsosPromocionesFaltantes(),
  ]);
  assert.ok(a.saltada || b.saltada);
  assert.notStrictEqual(a.saltada, b.saltada);
});

await t('AISLAMIENTO', 'mismo folio literal en dos negocios no cruza promociones', async () => {
  const pA = await nuevaPromo(NEG_A, { nombre: 'Aislada A', categorias: [CAT_A] });
  const pB = await nuevaPromo(NEG_B, { nombre: 'Aislada B', categorias: [CAT_B] });
  const folio = `F3A-ISO-${sufijo}`;
  await Promise.all([
    registrarUsosDeVenta({ negocioId: NEG_A, folio, promociones: [promoSnapshot(pA)], montoVenta: 90, canal: 'pos' }),
    registrarUsosDeVenta({ negocioId: NEG_B, folio, promociones: [promoSnapshot(pB)], montoVenta: 90, canal: 'whatsapp' }),
  ]);
  assert.strictEqual((await usos(NEG_A, folio))[0].canal, 'pos');
  assert.strictEqual((await usos(NEG_B, folio))[0].canal, 'whatsapp');
});

await t('TIENDA', 'ciclo reserva-consumo conserva canal tienda_online explicito', async () => {
  const p = await nuevaPromo(NEG_A, { nombre: 'Tienda', categorias: [CAT_A], canales: ['tienda_online'] });
  const token = `f3a-store-${sufijo}`;
  const aplicadas = [{ id: p, campaniaId: null, nombre: 'Tienda', descuento: 10 }];
  const r = await reservarUsosPromociones(NEG_A, aplicadas, { checkoutToken: token, telefono: '8783334455' });
  assert.strictEqual(r.reservadas.length, 1);
  const folio = `F3A-STORE-${sufijo}`;
  await registrarUsosPromociones({
    negocioId: NEG_A, folio, aplicadas, telefono: '8783334455', montoVenta: 90,
    checkoutToken: token,
  });
  assert.strictEqual((await usos(NEG_A, folio))[0].canal, 'tienda_online');
});

await t('ENTRYPOINT', 'POST /api/pos/pedidos conserva campaña y registra el uso POS', async () => {
  const negocioId = SEED.negocioA;
  const catHttp = await categoria(negocioId, `F3A-HTTP-${sufijo}`);
  const prodHttp = await producto(negocioId, catHttp, `Producto HTTP ${sufijo}`, 100);
  const campaniaId = (await guardarCampana(negocioId, { nombre: `HTTP-${sufijo}` })).id;
  const promoId = await nuevaPromo(negocioId, {
    nombre: `Promo HTTP ${sufijo}`, categorias: [catHttp], campaniaId,
    canales: ['pos'],
  });
  await pool.query(
    `INSERT INTO negocio_modulos (negocio_id, modulo, estado)
     VALUES ($1,'pos','activo')
     ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [negocioId]);

  const puerto = process.env.TEST_PORT_FASE3A || '4791';
  const srv = await arrancarServidor({ PORT: puerto, TZ: 'America/Matamoros' }, { timeoutMs: 60_000 });
  try {
    const token = crearTokenSesion({
      usuarioId: SEED.adminNegocioAUsuarioId, negocioId, rol: 'admin',
    });
    const respuesta = await fetch(`${srv.base}/api/pos/pedidos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `xabor_sesion=${encodeURIComponent(token)}` },
      body: JSON.stringify({
        tipo: 'recoger', cliente: { nombre: 'HTTP', telefono: '8785556677' },
        items: [{ producto_id: prodHttp, cantidad: 1 }], formaPago: 'efectivo',
      }),
    });
    const body = await respuesta.json();
    assert.strictEqual(respuesta.status, 200, JSON.stringify(body));
    const fila = (await usos(negocioId, body.pedido.id)).find(x => x.promocion_id === promoId);
    assert.ok(fila, 'el entrypoint POS debe registrar la promocion aplicada');
    assert.strictEqual(fila.canal, 'pos');
    assert.strictEqual(fila.campania_id, campaniaId);
  } finally {
    const detenido = new Promise(resolve => srv.proc.once('exit', resolve));
    srv.detener();
    await detenido;
  }
});

await limpiar(NEG_A);
await limpiar(NEG_B);
await cerrarPoolAuditoria();
await pool.end();

console.log(`\n${pasadas} OK · ${fallidas} fallos`);
if (fallidas) {
  console.log('\nFallos:');
  for (const fallo of fallos) console.log(` - ${fallo}`);
}
process.exitCode = fallidas ? 1 : 0;
