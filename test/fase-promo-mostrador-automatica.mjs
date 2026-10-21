// ─── Promociones automáticas en la captura de mostrador ─────────────────────
//
// Incidente del 21-oct-2026: XAB-2094 (Obispado), 7 «Chilaquiles Sencillos»
// capturados en mostrador, se cobró en $1,550 sin el 2x1 «Miercoles de
// Chilaquiles» (le tocaban −$390). POST /api/pedido-presencial no pasaba por
// el motor; el POS de envíos sí. Ahora el mostrador aplica solas las
// promociones del canal «Punto de venta» ('pos') al dar de alta
// (services/promocionesMostrador.js).
//
//   P — el módulo: falla hacia «sin promoción», nunca cambia un total sin ella.
//   A — alta por cobrar: total, desglose, uso registrado, lo que NO aplica.
//   C — cobro: respeta la promo; descuento manual y tope de staff intactos.
//   R — Rewards: el canje reservado y el inmediato conviven con la promo.
//   K — flujo clásico (forma de pago al crear) y la bandera por negocio.
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_PROMO_MOSTRADOR || '4733';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');
const {
  promocionesParaMostrador, totalConPromoMostrador, snapshotPromocionMostrador, BANDERA_PROMOS_MOSTRADOR,
} = await import('../src/services/promocionesMostrador.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const cookie = (usuarioId, negocioId, rol) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;

const TZ = 'America/Matamoros';
const NEG_A = SEED.negocioA;
const ADMIN_A = cookie(SEED.adminNegocioAUsuarioId, NEG_A, 'admin');
const STAFF_A = cookie(SEED.staffNegocioAUsuarioId, NEG_A, 'staff');
// La bandera arranca sin fila (encendida), como en producción hoy.
await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2`, [NEG_A, BANDERA_PROMOS_MOSTRADOR]);

// ════════════════════════════════════════════════════════════════════════════
// P — El módulo, sin servidor
// ════════════════════════════════════════════════════════════════════════════
await t('P', '1. sin promoción el total queda IDÉNTICO (ni siquiera cambia de tipo)', async () => {
  assert.strictEqual(totalConPromoMostrador('250', 0), '250');
  assert.strictEqual(totalConPromoMostrador(300, 0), 300);
  assert.strictEqual(totalConPromoMostrador(undefined, 0), undefined);
});
await t('P', '2. con promoción resta y nunca baja de cero', async () => {
  assert.strictEqual(totalConPromoMostrador(415, 195), 220);
  assert.strictEqual(totalConPromoMostrador('100', 150), 0);
});
await t('P', '3. si el motor truena, el pedido sale sin promoción (no lanza)', async () => {
  const r = await promocionesParaMostrador({ negocioId: NEG_A, items: [], subtotal: 390,
    calcular: async () => { throw new Error('motor caído (sonda)'); } });
  assert.deepStrictEqual(r, { descuento: 0, promociones: [] });
});
await t('P', '4. al motor le pide canal pos, recoger y la zona del negocio; sin teléfono, cliente no identificado', async () => {
  let ctx;
  await promocionesParaMostrador({ negocioId: NEG_A, items: [{ producto_id: 1, cantidad: 2 }], subtotal: 390,
    calcular: async (c) => { ctx = c; return { aplicadas: [] }; } });
  assert.strictEqual(ctx.canal, 'pos');
  assert.strictEqual(ctx.modalidad, 'recoger');
  assert.strictEqual(ctx.costoEnvio, 0);
  assert.strictEqual(ctx.telefono, null);
  assert.strictEqual(ctx.sinClienteIdentificado, true);
  assert.ok(ctx.timezone, 'sin zona horaria');
  await promocionesParaMostrador({ negocioId: NEG_A, items: [], subtotal: 1, telefono: ' 5218780000123 ',
    calcular: async (c) => { ctx = c; return { aplicadas: [] }; } });
  assert.strictEqual(ctx.telefono, '5218780000123');
  assert.strictEqual(ctx.sinClienteIdentificado, false);
});
await t('P', '5. descarta envío gratis y descuentos en cero; la suma no pasa del subtotal', async () => {
  const a = (id, descuento, extra = {}) => ({ id, nombre: id, tipo: '2x1', valor: 0, baseCalculo: descuento,
    descuento, automatica: true, unidadesBeneficiadas: 1, acumulable: true, prioridad: 100, ...extra });
  const r = await promocionesParaMostrador({ negocioId: NEG_A, items: [], subtotal: 300,
    calcular: async () => ({ aplicadas: [a('x', 200), a('y', 0), a('z', 50, { envioGratis: true }), a('w', 180)] }) });
  assert.deepStrictEqual(r.promociones.map(p => p.id), ['x', 'w']);
  assert.strictEqual(r.descuento, 300);
});
await t('P', '6. el snapshot tiene las mismas claves que guarda el POS de envíos', async () => {
  const s = snapshotPromocionMostrador({ id: 'p', campaniaId: null, nombre: 'n', tipo: '2x1', valor: 0,
    baseCalculo: 195, descuento: 195, automatica: true, unidadesBeneficiadas: 1, acumulable: true, prioridad: 100, codigo: null });
  assert.deepStrictEqual(Object.keys(s).sort(), ['acumulable', 'automatica', 'base_calculo', 'campaniaId', 'codigo',
    'descuento', 'envio_gratis', 'id', 'nombre', 'prioridad', 'tipo', 'unidades', 'valor'].sort());
  assert.strictEqual(s.envio_gratis, false);
  assert.ok(!('manual' in s), 'una automática no lleva la huella de «Aplicar promoción»');
});

// ════════════════════════════════════════════════════════════════════════════
// Preparación con base y servidor
// ════════════════════════════════════════════════════════════════════════════
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}
for (const m of ['pos', 'caja', 'menu', 'rewards']) await fijarModulo(NEG_A, m, 'activo');
await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2`, [NEG_A, BANDERA_PROMOS_MOSTRADOR]);
await pool.query(
  `INSERT INTO rewards_config (tenant_id, activo, puntos_por_peso, canje_minimo)
   VALUES ($1, TRUE, 0.5, 100)
   ON CONFLICT (tenant_id) DO UPDATE SET activo = TRUE, puntos_por_peso = 0.5, canje_minimo = 100`,
  [NEG_A]).catch(() => {});

const sufijo = Date.now().toString(36);
const PROD = {};
{
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,989) RETURNING id`,
    [NEG_A, `Promo mostrador ${sufijo}`]);
  for (const [clave, nombre, precio] of [
    ['chila', `Chila ${sufijo}`, 195], ['agua', `Agua ${sufijo}`, 25],
    ['wa', `Solo WA ${sufijo}`, 100], ['otro', `Otro dia ${sufijo}`, 80], ['prim', `Primera ${sufijo}`, 60],
  ]) {
    const { rows: [p] } = await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
       VALUES ($1,$2,$3,$4,TRUE,FALSE,1) RETURNING id`, [NEG_A, cat.id, nombre, precio]);
    PROD[clave] = p.id;
  }
}

const srv = await arrancarServidor({ PORT: PUERTO, TZ }, { timeoutMs: 90000 });
const BASE = srv.base;
const api = (ruta, opts = {}, ck = ADMIN_A) => fetch(BASE + ruta, {
  ...opts,
  headers: { 'Content-Type': 'application/json', Cookie: ck, ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return {}; } };
const leerFila = async (folio) => (await pool.query(
  `SELECT datos, estado FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, NEG_A])).rows[0];

const hoyDia = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date())}T12:00:00Z`).getUTCDay();
const otroDia = (hoyDia + 3) % 7;

const PROMOS = [];
async function crearPromo(cuerpo) {
  const r = await api('/api/admin/tienda/promociones', { method: 'POST', body: JSON.stringify({
    tipo: '2x1', automatica: true, canales: ['pos'], cantidadRequerida: 2, cantidadBeneficiada: 1,
    activa: true, acumulable: true, ...cuerpo,
  }) });
  const d = await json(r);
  assert.strictEqual(r.status, 200, `crear promo: ${r.status} ${JSON.stringify(d)}`);
  PROMOS.push(d.id);
  return d.id;
}
async function crearMostrador(items, { ck = STAFF_A, extra = {} } = {}) {
  const r = await api('/api/pedido-presencial', { method: 'POST',
    body: JSON.stringify({ items, nombre: 'Cliente mostrador', ...extra }) }, ck);
  const d = await json(r);
  return { r, d, folio: d?.pedido?.id };
}
async function crearOk(items, opts) {
  const x = await crearMostrador(items, opts);
  assert.strictEqual(x.r.status, 200, `crear mostrador: ${x.r.status} ${JSON.stringify(x.d)}`);
  return x;
}
const cobrar = (folio, cuerpo, ck = STAFF_A) => api(`/pedidos/${folio}/cobro`,
  { method: 'PATCH', body: JSON.stringify(cuerpo) }, ck);
async function crearCuentaRewards(telefono, nombre, puntos) {
  await pool.query(`INSERT INTO clientes (telefono, nombre, negocio_id) VALUES ($1,$2,$3)
    ON CONFLICT (telefono) DO NOTHING`, [telefono, nombre, NEG_A]);
  await pool.query(`INSERT INTO rewards_accounts (tenant_id, telefono, nombre, puntos_balance, negocio_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (telefono, tenant_id) DO UPDATE SET puntos_balance = $4`,
    [NEG_A, telefono, nombre, puntos, NEG_A]);
}
const telPrueba = (n) => `52187800${String(Date.now()).slice(-4)}${n}`;
const CHILA2_AGUA = () => [{ producto_id: PROD.chila, cantidad: 2 }, { producto_id: PROD.agua, cantidad: 1 }];

let P_CHILA;
try {
P_CHILA = await crearPromo({ nombre: `Miercoles de Chilaquiles ${sufijo}`, productos: [PROD.chila] });
await crearPromo({ nombre: `Solo WhatsApp ${sufijo}`, productos: [PROD.wa], canales: ['whatsapp'] });
await crearPromo({ nombre: `Otro dia ${sufijo}`, productos: [PROD.otro], diasSemana: [otroDia] });
await crearPromo({ nombre: `Primera compra ${sufijo}`, productos: [PROD.prim], soloPrimeraCompra: true });

// ─── A — alta por cobrar ───────────────────────────────────────────────────
let folioA;
await t('A', '1. el mostrador nace con el 2x1 aplicado: total, descuento y desglose del servidor', async () => {
  const { d, folio } = await crearOk(CHILA2_AGUA());
  folioA = folio;
  assert.strictEqual(Number(d.pedido.total), 220, 'la respuesta trae el total sin promo');
  const f = await leerFila(folio);
  assert.strictEqual(f.datos.forma_pago, 'por_cobrar');
  assert.strictEqual(Number(f.datos.subtotal), 415);
  assert.strictEqual(Number(f.datos.total), 220);
  assert.strictEqual(Number(f.datos.descuento), 195);
  assert.strictEqual(f.datos.promociones.length, 1);
  assert.strictEqual(f.datos.promociones[0].id, P_CHILA);
  assert.strictEqual(f.datos.promociones[0].automatica, true);
  assert.strictEqual(f.datos.promociones[0].descuento, 195);
  assert.strictEqual(f.datos.descuentos.promociones[0].monto, 195);
  assert.strictEqual(f.datos.descuentos.total, 195);
  assert.strictEqual(f.datos.descuentos.manual.monto, 0);
  assert.ok(!f.datos.descuento_valor, 'la promo no es un descuento manual');
});

await t('A', '2. el uso queda registrado como «presencial», igual que con «Aplicar promoción»', async () => {
  let rows = [];
  for (let i = 0; i < 20 && !rows.length; i++) {
    ({ rows } = await pool.query(`SELECT canal, monto_descuento FROM tienda_promocion_usos
      WHERE negocio_id=$1 AND promocion_id=$2 AND pedido_folio=$3`, [NEG_A, P_CHILA, folioA]));
    if (!rows.length) await new Promise(r => setTimeout(r, 100));
  }
  assert.strictEqual(rows.length, 1, 'no quedó el uso');
  assert.strictEqual(rows[0].canal, 'presencial');
  assert.strictEqual(Number(rows[0].monto_descuento), 195);
});

await t('A', '3. «Aplicar promoción» la reconoce como ya aplicada y no la duplica', async () => {
  const d = await json(await api(`/api/pedidos/${folioA}/promociones-aplicables`, {}, STAFF_A));
  assert.strictEqual(d.promociones.find(p => p.id === P_CHILA).motivo, 'Ya está aplicada a este pedido');
  const r = await api(`/api/pedidos/${folioA}/promocion`, { method: 'POST', body: JSON.stringify({ promocionId: P_CHILA }) }, STAFF_A);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(Number((await leerFila(folioA)).datos.total), 220);
});

await t('A', '4. productos que no participan: el pedido nace como siempre', async () => {
  const { folio } = await crearOk([{ producto_id: PROD.agua, cantidad: 3 }]);
  const f = await leerFila(folio);
  assert.strictEqual(Number(f.datos.total), 75);
  assert.strictEqual(Number(f.datos.descuento), 0);
  assert.ok(!f.datos.promociones, 'llevó promociones');
  assert.deepStrictEqual(f.datos.descuentos.promociones, []);
});

await t('A', '5. un solo chilaquil no completa el 2x1', async () => {
  const { folio } = await crearOk([{ producto_id: PROD.chila, cantidad: 1 }]);
  assert.strictEqual(Number((await leerFila(folio)).datos.total), 195);
});

await t('A', '6. una promo que NO es de «Punto de venta» no se aplica en mostrador', async () => {
  const { folio } = await crearOk([{ producto_id: PROD.wa, cantidad: 2 }]);
  const f = await leerFila(folio);
  assert.strictEqual(Number(f.datos.total), 200);
  assert.ok(!f.datos.promociones);
});

await t('A', '7. una promo de otro día no se aplica', async () => {
  const { folio } = await crearOk([{ producto_id: PROD.otro, cantidad: 2 }]);
  assert.strictEqual(Number((await leerFila(folio)).datos.total), 160);
});

await t('A', '8. primera compra: sin cliente identificado NO se aplica sola', async () => {
  const { folio } = await crearOk([{ producto_id: PROD.prim, cantidad: 2 }]);
  const f = await leerFila(folio);
  assert.strictEqual(Number(f.datos.total), 120);
  assert.ok(!f.datos.promociones);
});

await t('A', '9. primera compra: con cliente de Rewards nuevo SÍ se aplica (el motor lo decide)', async () => {
  const tel = telPrueba(1);
  await crearCuentaRewards(tel, 'Cliente nuevo', 0);
  const { folio } = await crearOk([{ producto_id: PROD.prim, cantidad: 2 }],
    { extra: { rewards_telefono: tel, rewards_nombre: 'Cliente nuevo' } });
  const f = await leerFila(folio);
  assert.strictEqual(Number(f.datos.total), 60);
  assert.strictEqual(f.datos.cliente.telefono, tel);
});

// ─── C — cobro ─────────────────────────────────────────────────────────────
await t('C', '1. el cobro respeta la promo: total y cambio sobre $220', async () => {
  const r = await cobrar(folioA, { forma_pago: 'efectivo', billete: 500 });
  const d = await json(r);
  assert.strictEqual(r.status, 200, JSON.stringify(d));
  assert.strictEqual(d.total, 220);
  assert.strictEqual(d.cambio, 280);
  const f = await leerFila(folioA);
  assert.strictEqual(f.datos.pago_confirmado, true);
  assert.strictEqual(Number(f.datos.descuento), 195);
  assert.strictEqual(f.datos.descuentos.promociones[0].monto, 195);
});

await t('C', '2. tope de staff intacto: 10 % del SUBTOTAL, sumado a la promo', async () => {
  const { folio } = await crearOk(CHILA2_AGUA());
  const excesivo = await cobrar(folio, { forma_pago: 'efectivo', descuento: 50, motivo_descuento: 'staff 12%' });
  assert.strictEqual(excesivo.status, 403);
  const r = await cobrar(folio, { forma_pago: 'efectivo', descuento: 40, motivo_descuento: 'cortesía' });
  const d = await json(r);
  assert.strictEqual(r.status, 200, JSON.stringify(d));
  assert.strictEqual(d.total, 180);
  const f = await leerFila(folio);
  assert.strictEqual(Number(f.datos.descuento), 235);
  assert.strictEqual(f.datos.descuentos.manual.monto, 40);
  assert.strictEqual(f.datos.descuentos.total, 235);
});

await t('C', '3. admin: el manual no puede pasar lo que queda después de la promo', async () => {
  const { folio } = await crearOk(CHILA2_AGUA(), { ck: ADMIN_A });
  const r = await cobrar(folio, { forma_pago: 'efectivo', descuento: 221, motivo_descuento: '2x1 a mano' }, ADMIN_A);
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await leerFila(folio)).datos.pago_confirmado, false);
});

// ─── R — Rewards ───────────────────────────────────────────────────────────
await t('R', '1. canje reservado: se consume al cobrar y se resta DESPUÉS de la promo', async () => {
  const tel = telPrueba(2);
  await crearCuentaRewards(tel, 'Cliente Rewards', 500);
  const { folio } = await crearOk(CHILA2_AGUA(),
    { extra: { rewards_telefono: tel, rewards_nombre: 'Cliente Rewards', rewards_canje_puntos: 100 } });
  const f0 = await leerFila(folio);
  assert.strictEqual(Number(f0.datos.rewards_pendiente?.puntos), 100, 'no quedó la reserva');
  assert.strictEqual(Number(f0.datos.total), 220);
  const r = await cobrar(folio, { forma_pago: 'efectivo' });
  const d = await json(r);
  assert.strictEqual(r.status, 200, JSON.stringify(d));
  assert.strictEqual(d.total, 170, '415 − 195 promo − 50 canje');
  const f = await leerFila(folio);
  assert.strictEqual(f.datos.descuentos.rewards.monto, 50);
  assert.strictEqual(f.datos.descuentos.promociones[0].monto, 195);
});

// ─── K — flujo clásico y bandera ───────────────────────────────────────────
await t('K', '1. forma de pago al crear: promo + manual, cada uno en su lugar', async () => {
  const { d, folio } = await crearOk([{ producto_id: PROD.chila, cantidad: 2 }],
    { ck: ADMIN_A, extra: { forma_pago: 'efectivo', descuento: 20, motivo_descuento: 'cortesía' } });
  assert.strictEqual(Number(d.pedido.total), 175);
  const f = await leerFila(folio);
  assert.strictEqual(Number(f.datos.total), 175);
  assert.strictEqual(Number(f.datos.descuento), 215);
  assert.strictEqual(Number(f.datos.descuento_valor), 20);
  assert.strictEqual(f.datos.descuentos.manual.monto, 20);
  assert.strictEqual(f.datos.descuentos.promociones[0].monto, 195);
  assert.strictEqual(f.datos.descuentos.total, 215);
});

await t('K', '2. forma de pago al crear: un manual mayor que lo que queda se rechaza sin crear', async () => {
  const antes = (await pool.query(`SELECT COUNT(*)::int n FROM pedidos_activos WHERE negocio_id=$1`, [NEG_A])).rows[0].n;
  const { r } = await crearMostrador([{ producto_id: PROD.chila, cantidad: 2 }],
    { ck: ADMIN_A, extra: { forma_pago: 'efectivo', descuento: 200, motivo_descuento: '2x1 a mano' } });
  assert.strictEqual(r.status, 400);
  const despues = (await pool.query(`SELECT COUNT(*)::int n FROM pedidos_activos WHERE negocio_id=$1`, [NEG_A])).rows[0].n;
  assert.strictEqual(despues, antes, 'se creó el pedido');
});

await t('K', '3. forma de pago al crear con canje inmediato: el desglose conserva la promo', async () => {
  const tel = telPrueba(3);
  await crearCuentaRewards(tel, 'Cliente Rewards', 500);
  const { d, folio } = await crearOk(CHILA2_AGUA(), { ck: ADMIN_A,
    extra: { forma_pago: 'efectivo', rewards_telefono: tel, rewards_nombre: 'Cliente Rewards', rewards_canje_puntos: 100 } });
  assert.ok(d.canje, `sin canje: ${JSON.stringify(d)}`);
  const f = await leerFila(folio);
  assert.strictEqual(Number(f.datos.total), 170);
  assert.strictEqual(f.datos.descuentos.rewards.monto, 50);
  assert.strictEqual(f.datos.descuentos.promociones.length, 1, 'el canje borró la promo del desglose');
  assert.strictEqual(f.datos.descuentos.promociones[0].monto, 195);
});

await t('K', '4. bandera apagada («false»): el mostrador vuelve a capturar sin promoción', async () => {
  const rc = await api('/api/config', { method: 'PUT', body: JSON.stringify({ [BANDERA_PROMOS_MOSTRADOR]: 'false' }) });
  assert.strictEqual(rc.status, 200);
  try {
    const { folio } = await crearOk([{ producto_id: PROD.chila, cantidad: 2 }]);
    const f = await leerFila(folio);
    assert.strictEqual(Number(f.datos.total), 390);
    assert.ok(!f.datos.promociones);
  } finally {
    await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2`, [NEG_A, BANDERA_PROMOS_MOSTRADOR]);
  }
  const { folio } = await crearOk([{ producto_id: PROD.chila, cantidad: 2 }]);
  assert.strictEqual(Number((await leerFila(folio)).datos.total), 195, 'sin la fila vuelve a aplicar');
});

} finally {
  srv.detener();
  await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2`, [NEG_A, BANDERA_PROMOS_MOSTRADOR]).catch(() => {});
  if (PROMOS.length) {
    await pool.query(`DELETE FROM tienda_promocion_usos WHERE promocion_id = ANY($1)`, [PROMOS]).catch(() => {});
    await pool.query(`DELETE FROM tienda_promociones WHERE id = ANY($1)`, [PROMOS]).catch(() => {});
  }
  await pool.end().catch(() => {});
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log(fallos.join('\n')); process.exit(1); }
process.exit(0);
