// ─── Captura ≠ cobro: ciclo real de un pedido Para llevar ───────────────────
// Cubre los 21 casos obligatorios de la revisión: crear sin forma de pago,
// aparecer en el tablero, comanda una sola vez, cobro inmediato SIN esperas
// artificiales (contrato de persistencia), cobro tardío, doble cobro
// idempotente, cancelación sin ingreso, Rewards reservado/consumido, cálculo
// y autorización de descuento en servidor, aislamiento entre negocios,
// cambio en efectivo, mixto, corte (pendientes fuera del efectivo esperado y
// visibles como "por cobrar"), ventas sin duplicar, impresión no repetida y
// no-regresión de Recoger/Domicilio/Restaurante.
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4199';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const cookie = (usuarioId, negocioId, rol) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const ADMIN_A = cookie(SEED.adminNegocioAUsuarioId, NEG_A, 'admin');
const STAFF_A = cookie(SEED.staffNegocioAUsuarioId, NEG_A, 'staff');

async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}

// Catálogo propio de la suite (precios conocidos para verificar el cálculo).
let PROD = {};
async function prepararCatalogo() {
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,987) RETURNING id`,
    [NEG_A, 'Cobro diferido (test)']);
  for (const [nombre, precio] of [['Taco cobro', 50], ['Agua cobro', 25]]) {
    const { rows: [p] } = await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
       VALUES ($1,$2,$3,$4,TRUE,FALSE,1) RETURNING id`, [NEG_A, cat.id, nombre, precio]);
    PROD[nombre] = p.id;
  }
}

await fijarModulo(NEG_A, 'pos', 'activo');
await fijarModulo(NEG_A, 'caja', 'activo');
await fijarModulo(NEG_B, 'pos', 'activo');
await prepararCatalogo();

// timeout amplio: la base de pruebas acumula pedidos y el arranque carga
// todos los activos antes de abrir el puerto.
const srv = await arrancarServidor({ PORT: PUERTO, TZ: 'America/Matamoros' }, { timeoutMs: 60000 });
const BASE = srv.base;

const api = (ruta, opts = {}, ck = ADMIN_A) => fetch(BASE + ruta, {
  ...opts,
  headers: { 'Content-Type': 'application/json', Cookie: ck, ...(opts.headers || {}) },
});
// Crea un Para llevar ABIERTO (sin forma de pago) y devuelve el pedido.
async function crearAbierto({ items, ck = ADMIN_A, extra = {} } = {}) {
  const r = await api('/api/pedido-presencial', {
    method: 'POST',
    body: JSON.stringify({
      items: items || [{ producto_id: PROD['Taco cobro'], cantidad: 2 }],
      nombre: 'Cliente cobro', ...extra,
    }),
  }, ck);
  const d = await r.json();
  return { r, d, folio: d?.pedido?.id };
}
const leerFila = async (folio, negocioId = NEG_A) => (await pool.query(
  `SELECT datos, estado FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, negocioId])).rows[0];

// rewards_accounts.telefono es FK hacia clientes.telefono y su UNIQUE es
// (telefono, tenant_id) — hay que crear el cliente antes que la cuenta.
async function crearCuentaRewards(telefono, nombre, puntos) {
  await pool.query(
    `INSERT INTO clientes (telefono, nombre, negocio_id) VALUES ($1,$2,$3)
     ON CONFLICT (telefono) DO NOTHING`, [telefono, nombre, NEG_A]);
  await pool.query(
    `INSERT INTO rewards_accounts (tenant_id, telefono, nombre, puntos_balance, negocio_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (telefono, tenant_id) DO UPDATE SET puntos_balance = $4`,
    [NEG_A, telefono, nombre, puntos, NEG_A]);
}
const saldoRewards = async (telefono) => Number((await pool.query(
  `SELECT puntos_balance FROM rewards_accounts WHERE tenant_id=$1 AND telefono=$2`,
  [NEG_A, telefono])).rows[0]?.puntos_balance);

try {

// ─── 1-3. Crear sin forma de pago ───────────────────────────────────────────
let folioBase;
await t('CREAR', '1. Para llevar se crea SIN forma de pago final', async () => {
  const { r, d, folio } = await crearAbierto();
  assert.strictEqual(r.status, 200, `status ${r.status}`);
  assert.ok(d.ok && folio, 'no devolvió pedido');
  folioBase = folio;
  const fila = await leerFila(folio);
  assert.ok(fila, 'no se persistió la fila operativa');
  assert.strictEqual(fila.datos.forma_pago, 'por_cobrar');
  assert.strictEqual(fila.datos.pago_confirmado, false);
  assert.strictEqual(Number(fila.datos.total), 100, 'total inicial = subtotal');
});

await t('CREAR', '2. el pedido abierto aparece en el tablero (pedidos activos en memoria y DB)', async () => {
  const fila = await leerFila(folioBase);
  assert.ok(fila, 'no está en pedidos_activos');
  assert.ok(['nuevo', 'en_preparacion', 'listo'].includes(fila.estado), `estado inesperado: ${fila.estado}`);
  // El tablero se alimenta del WS + esta misma tabla; el historial la lee igual.
  const r = await api('/api/historial');
  assert.ok(r.ok, 'el historial no responde');
});

await t('CREAR', '3. crear emite comanda una sola vez: no hay trabajos duplicados', async () => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM impresion_trabajos WHERE negocio_id = $1 AND origen_id = $2`,
    [NEG_A, folioBase]);
  // Sin Edge vinculado no se encolan trabajos; lo que importa es que nunca
  // haya MÁS de uno por documento y que el cobro no agregue (caso 17).
  assert.ok(rows[0].n <= 1, `hay ${rows[0].n} trabajos para el mismo pedido`);
});

// ─── 4. Cobro INMEDIATO sin esperas artificiales ────────────────────────────
await t('CARRERA', '4. cobrar INMEDIATAMENTE después de crear (sin sleep) funciona', async () => {
  const { d, folio } = await crearAbierto();
  assert.ok(d.ok, 'no se creó');
  // Sin await extra, sin retry: la respuesta de creación ya garantiza persistencia.
  const r = await api(`/pedidos/${folio}/cobro`, {
    method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo' }),
  });
  const dc = await r.json();
  assert.strictEqual(r.status, 200, `status ${r.status}: ${JSON.stringify(dc)}`);
  assert.strictEqual(dc.total, 100);
  const fila = await leerFila(folio);
  assert.strictEqual(fila.datos.pago_confirmado, true);
  assert.strictEqual(fila.datos.forma_pago, 'efectivo');
});

// ─── 5. Cobro tardío ────────────────────────────────────────────────────────
await t('CICLO', '5. un pedido puede cobrarse mucho después (tras cambiar de estado)', async () => {
  const { folio } = await crearAbierto();
  await api(`/pedidos/${folio}/estado`, { method: 'PATCH', body: JSON.stringify({ estado: 'listo' }) });
  await new Promise(r => setTimeout(r, 400));
  const r = await api(`/pedidos/${folio}/cobro`, {
    method: 'PATCH', body: JSON.stringify({ forma_pago: 'terminal (tarjeta presente)' }),
  });
  const dc = await r.json();
  assert.strictEqual(r.status, 200, JSON.stringify(dc));
  const fila = await leerFila(folio);
  assert.strictEqual(fila.datos.forma_pago, 'terminal (tarjeta presente)');
  assert.strictEqual(fila.datos.pago_confirmado, true);
});

// ─── 6. Doble cobro concurrente ─────────────────────────────────────────────
await t('IDEMPOTENCIA', '6. doble request simultáneo de cobro → UN solo cobro', async () => {
  const { folio } = await crearAbierto();
  const body = JSON.stringify({ forma_pago: 'efectivo', billete: 200 });
  const [r1, r2] = await Promise.all([
    api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body }),
    api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body }),
  ]);
  const [d1, d2] = [await r1.json(), await r2.json()];
  assert.ok(r1.ok && r2.ok, 'alguna petición falló');
  const yaCobrados = [d1, d2].filter(d => d.yaCobrado).length;
  assert.strictEqual(yaCobrados, 1, 'exactamente una debe reportar yaCobrado');
  const fila = await leerFila(folio);
  assert.strictEqual(Number(fila.datos.total), 100, 'el total no se recalculó dos veces');
  assert.strictEqual(fila.datos.pago_confirmado, true);
});

await t('IDEMPOTENCIA', '6b. re-cobrar después no cambia forma de pago ni total', async () => {
  const { folio } = await crearAbierto();
  await api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo' }) });
  const r = await api(`/pedidos/${folio}/cobro`, {
    method: 'PATCH', body: JSON.stringify({ forma_pago: 'terminal (tarjeta presente)', descuento: 50, motivo_descuento: 'intento' }),
  });
  const d = await r.json();
  assert.strictEqual(d.yaCobrado, true);
  const fila = await leerFila(folio);
  assert.strictEqual(fila.datos.forma_pago, 'efectivo', 'la segunda llamada pisó la forma de pago');
  assert.strictEqual(Number(fila.datos.total), 100, 'la segunda llamada aplicó descuento');
});

// ─── 7. Cancelar pendiente ──────────────────────────────────────────────────
await t('CANCELACION', '7. cancelar un pedido por cobrar no genera ingreso ni permite cobro', async () => {
  const { folio } = await crearAbierto();
  const rc = await api(`/api/admin/pedido/${folio}/cancelar`, {
    method: 'POST', body: JSON.stringify({ motivo: 'prueba cobro diferido' }),
  });
  assert.ok(rc.ok, 'no se pudo cancelar');
  const r = await api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo' }) });
  assert.ok([404, 409].includes(r.status), `debía rechazar el cobro, status ${r.status}`);
});

// ─── 8. Rewards: reserva en captura, consumo al cobrar ──────────────────────
await t('REWARDS', '8. el canje se RESERVA al crear y solo se consume al cobrar', async () => {
  await fijarModulo(NEG_A, 'rewards', 'activo');
  await pool.query(
    `INSERT INTO rewards_config (tenant_id, activo, puntos_por_peso, canje_minimo)
     VALUES ($1, TRUE, 0.5, 100)
     ON CONFLICT (tenant_id) DO UPDATE SET activo = TRUE, puntos_por_peso = 0.5, canje_minimo = 100`,
    [NEG_A]).catch(() => {});
  const tel = '5218780000777';
  await crearCuentaRewards(tel, 'Cliente Rewards', 500);
  const saldoDe = () => saldoRewards(tel);
  const antes = await saldoDe();
  const { folio } = await crearAbierto({ extra: { rewards_telefono: tel, rewards_nombre: 'Cliente Rewards', rewards_canje_puntos: 100 } });
  const trasCrear = await saldoDe();
  assert.strictEqual(Number(trasCrear), Number(antes), 'el canje se consumió al CREAR (debía reservarse)');
  const fila = await leerFila(folio);
  assert.strictEqual(Number(fila.datos.rewards_pendiente?.puntos), 100, 'no quedó la reserva');

  const r = await api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo' }) });
  const d = await r.json();
  assert.ok(r.ok, JSON.stringify(d));
  const trasCobrar = await saldoDe();
  assert.strictEqual(Number(trasCobrar), Number(antes) - 100, 'no se consumieron los puntos al cobrar');
  assert.strictEqual(d.total, 50, 'el canje (100 pts × 0.5 = $50) no se restó del total');
});

await t('REWARDS', '8b. cancelar un pedido con canje RESERVADO no quema puntos', async () => {
  const tel = '5218780000778';
  await crearCuentaRewards(tel, 'Cliente Rewards 2', 300);
  const { folio } = await crearAbierto({ extra: { rewards_telefono: tel, rewards_canje_puntos: 100 } });
  await api(`/api/admin/pedido/${folio}/cancelar`, { method: 'POST', body: JSON.stringify({ motivo: 'cancelado antes de cobrar' }) });
  await new Promise(r => setTimeout(r, 500)); // la reversión de Rewards es fire-and-forget
  assert.strictEqual(await saldoRewards(tel), 300, 'se perdieron puntos de un pedido nunca cobrado');
});

await t('REWARDS', '8c. doble cobro con canje no duplica el consumo de puntos', async () => {
  const tel = '5218780000779';
  await crearCuentaRewards(tel, 'Cliente Rewards 3', 400);
  const { folio } = await crearAbierto({ extra: { rewards_telefono: tel, rewards_canje_puntos: 100 } });
  const body = JSON.stringify({ forma_pago: 'efectivo' });
  await Promise.all([
    api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body }),
    api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body }),
  ]);
  assert.strictEqual(await saldoRewards(tel), 300, 'se canjearon puntos dos veces');
  const { rows: movs } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM rewards_movements WHERE tenant_id=$1 AND folio_venta=$2 AND tipo='canje'`, [NEG_A, folio]);
  assert.strictEqual(movs[0].n, 1, 'hay más de un movimiento de canje');
});

// ─── 9-10. Descuento: cálculo y autorización en servidor ────────────────────
await t('DESCUENTO', '9. el descuento lo recalcula el servidor sobre el subtotal real', async () => {
  const { folio } = await crearAbierto();
  const r = await api(`/pedidos/${folio}/cobro`, {
    method: 'PATCH',
    // El cliente manda además un total falso: debe ignorarse.
    body: JSON.stringify({ forma_pago: 'efectivo', descuento: 20, motivo_descuento: 'cortesía', total: 1 }),
  });
  const d = await r.json();
  assert.strictEqual(r.status, 200, JSON.stringify(d));
  assert.strictEqual(d.subtotal, 100);
  assert.strictEqual(d.total, 80, 'el total no es subtotal − descuento');
  const fila = await leerFila(folio);
  assert.strictEqual(Number(fila.datos.total), 80);
});

await t('DESCUENTO', '9b. descuento sin motivo se rechaza', async () => {
  const { folio } = await crearAbierto();
  const r = await api(`/pedidos/${folio}/cobro`, {
    method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo', descuento: 10 }),
  });
  assert.strictEqual(r.status, 400);
  const fila = await leerFila(folio);
  assert.notStrictEqual(fila.datos.pago_confirmado, true, 'se cobró pese al rechazo');
});

await t('DESCUENTO', '10. staff no puede exceder el 10% permitido (admin sí)', async () => {
  const { folio } = await crearAbierto();
  const rStaff = await api(`/pedidos/${folio}/cobro`, {
    method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo', descuento: 30, motivo_descuento: 'staff intenta 30%' }),
  }, STAFF_A);
  assert.strictEqual(rStaff.status, 403, 'staff pudo aplicar 30% de descuento');
  const rStaffOk = await api(`/pedidos/${folio}/cobro`, {
    method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo', descuento: 10, motivo_descuento: 'staff 10%' }),
  }, STAFF_A);
  assert.strictEqual(rStaffOk.status, 200, 'staff no pudo aplicar su 10% permitido');

  const { folio: folio2 } = await crearAbierto();
  const rAdmin = await api(`/pedidos/${folio2}/cobro`, {
    method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo', descuento: 30, motivo_descuento: 'admin autoriza' }),
  }, ADMIN_A);
  assert.strictEqual(rAdmin.status, 200, 'admin no pudo aplicar descuento mayor');
});

// ─── 11. Aislamiento entre negocios ─────────────────────────────────────────
await t('SEGURIDAD', '11. una sesión de otro negocio no puede cobrar un folio del negocio A', async () => {
  const { folio } = await crearAbierto();
  // Sesión firmada apuntando a otro negocio: la membresía (requireAuthSeguro)
  // la rechaza con 403 antes de llegar al endpoint; si por alguna ruta llegara,
  // el propio cobro filtra por negocio_id y devolvería 404. Ambas son cierre
  // correcto — lo que NUNCA debe pasar es que el pedido quede cobrado.
  const ckB = cookie(SEED.adminNegocioAUsuarioId, NEG_B, 'admin');
  const r = await api(`/pedidos/${folio}/cobro`, {
    method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo' }),
  }, ckB);
  assert.ok([403, 404].includes(r.status), `debía cerrar (403/404), fue ${r.status}`);
  const fila = await leerFila(folio);
  assert.notStrictEqual(fila.datos.pago_confirmado, true, 'el tenant ajeno cobró el pedido');
});

await t('SEGURIDAD', '11c. el filtro por negocio del cobro es real (folio inexistente → 404)', async () => {
  // Mismo endpoint, sesión legítima de A, folio que no le pertenece.
  const r = await api('/pedidos/XAB-0000000/cobro', {
    method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo' }),
  });
  assert.strictEqual(r.status, 404);
});

await t('SEGURIDAD', '11b. sin sesión no se puede cobrar', async () => {
  const { folio } = await crearAbierto();
  const r = await fetch(`${BASE}/pedidos/${folio}/cobro`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ forma_pago: 'efectivo' }),
  });
  assert.ok([401, 403].includes(r.status), `status ${r.status}`);
});

// ─── 12-13. Efectivo y mixto ────────────────────────────────────────────────
await t('PAGO', '12. efectivo calcula el cambio correcto', async () => {
  const { folio } = await crearAbierto();
  const r = await api(`/pedidos/${folio}/cobro`, {
    method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo', billete: 200 }),
  });
  const d = await r.json();
  assert.strictEqual(d.total, 100);
  assert.strictEqual(d.cambio, 100, 'cambio incorrecto');
  const fila = await leerFila(folio);
  assert.strictEqual(Number(fila.datos.billete), 200);
  assert.strictEqual(Number(fila.datos.cambio), 100);
});

await t('PAGO', '12b. billete insuficiente se rechaza', async () => {
  const { folio } = await crearAbierto();
  const r = await api(`/pedidos/${folio}/cobro`, {
    method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo', billete: 50 }),
  });
  assert.strictEqual(r.status, 400);
});

await t('PAGO', '13. mixto debe cubrir el total (y se rechaza si no)', async () => {
  const { folio } = await crearAbierto();
  const rMal = await api(`/pedidos/${folio}/cobro`, {
    method: 'PATCH', body: JSON.stringify({ forma_pago: 'mixto', mixto_efectivo: 30, mixto_terminal: 20 }),
  });
  assert.strictEqual(rMal.status, 400, 'aceptó un mixto que no cubre el total');
  const rOk = await api(`/pedidos/${folio}/cobro`, {
    method: 'PATCH', body: JSON.stringify({ forma_pago: 'mixto', mixto_efectivo: 60, mixto_terminal: 40 }),
  });
  const d = await rOk.json();
  assert.strictEqual(rOk.status, 200, JSON.stringify(d));
  const fila = await leerFila(folio);
  assert.strictEqual(Number(fila.datos.mixto_efectivo), 60);
  assert.strictEqual(Number(fila.datos.mixto_terminal), 40);
  assert.strictEqual(Number(fila.datos.total), 100);
});

// ─── 14-16. Corte y ventas ──────────────────────────────────────────────────
await t('CORTE', '14-15. el corte excluye pendientes del efectivo y los muestra por cobrar', async () => {
  const corteAntes = await (await api('/api/corte-caja')).json();
  const { folio } = await crearAbierto();          // queda pendiente
  const corteConPendiente = await (await api('/api/corte-caja')).json();
  assert.strictEqual(
    Number(corteConPendiente.efectivo_esperado).toFixed(2), Number(corteAntes.efectivo_esperado).toFixed(2),
    'un pedido sin cobrar movió el efectivo esperado');
  assert.ok(corteConPendiente.pendiente.num >= 1, 'no aparece en "por cobrar"');
  assert.ok(corteConPendiente.pendiente.total >= 100, 'el monto por cobrar no incluye el pedido');
  assert.ok(!Object.keys(corteConPendiente.por_pago || {}).includes('por_cobrar'),
    'por_cobrar aparece como forma de pago');

  // Al cobrarlo en efectivo, el mismo pedido pasa de pendiente a efectivo.
  await api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo' }) });
  const corteDespues = await (await api('/api/corte-caja')).json();
  assert.strictEqual(corteDespues.pendiente.num, corteConPendiente.pendiente.num - 1, 'sigue contando como pendiente');
  assert.strictEqual(
    Number(corteDespues.efectivo_esperado).toFixed(2),
    (Number(corteConPendiente.efectivo_esperado) + 100).toFixed(2),
    'el cobro no entró al efectivo esperado');
});

await t('VENTAS', '16. cobrar NO duplica la venta: una operación, un importe', async () => {
  const desde = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const hasta = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const resumen = (await (await api(`/api/ventas/resumen?desde=${desde}&hasta=${hasta}`)).json());
  const { folio } = await crearAbierto();
  const conPendiente = (await (await api(`/api/ventas/resumen?desde=${desde}&hasta=${hasta}`)).json());
  assert.strictEqual(Number(conPendiente.total_ventas).toFixed(2), Number(resumen.total_ventas).toFixed(2),
    'un pedido sin cobrar sumó a total_ventas (ingreso cobrado)');
  assert.strictEqual(conPendiente.num_pedidos, resumen.num_pedidos + 1, 'la operación no se contó');
  assert.ok(Number(conPendiente.por_cobrar_total) >= 100, 'no se reporta el monto por cobrar');

  await api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo' }) });
  const cobrado = (await (await api(`/api/ventas/resumen?desde=${desde}&hasta=${hasta}`)).json());
  assert.strictEqual(Number(cobrado.total_ventas).toFixed(2), (Number(resumen.total_ventas) + 100).toFixed(2),
    'el cobro no sumó exactamente una vez');
  assert.strictEqual(cobrado.num_pedidos, conPendiente.num_pedidos, 'se creó una segunda venta al cobrar');
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, NEG_A]);
  assert.strictEqual(rows[0].n, 1, 'hay más de una fila para el mismo folio');
});

// ─── 17-18. Impresión ───────────────────────────────────────────────────────
await t('IMPRESION', '17. cobrar no agrega trabajos de impresión (la comanda ya salió)', async () => {
  const { folio } = await crearAbierto();
  const contar = async () => (await pool.query(
    `SELECT COUNT(*)::int AS n FROM impresion_trabajos WHERE negocio_id = $1 AND origen_id = $2`, [NEG_A, folio])).rows[0].n;
  const antes = await contar();
  await api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo' }) });
  await new Promise(r => setTimeout(r, 400));
  assert.strictEqual(await contar(), antes, 'el cobro generó impresión nueva');
});

await t('IMPRESION', '18. el endpoint de cobro no expone ninguna orden de comanda', async () => {
  const { folio } = await crearAbierto();
  const r = await api(`/pedidos/${folio}/cobro`, { method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo' }) });
  const d = await r.json();
  const claves = Object.keys(d).join(',');
  assert.ok(!/comanda|imprimir|print/i.test(claves), `la respuesta habla de impresión: ${claves}`);
});

// ─── 19-21. No regresión de las otras modalidades ───────────────────────────
await t('REGRESION', '19-20. Recoger y Domicilio conservan su forma de pago al crear', async () => {
  for (const [tipo, esperado] of [['recoger', 'recoger en tienda'], ['domicilio', 'entrega a domicilio']]) {
    const r = await api('/api/pos/pedidos', {
      method: 'POST',
      headers: { 'Idempotency-Key': `cobro-test-${tipo}-${Date.now()}` },
      body: JSON.stringify({
        tipo,
        cliente: { nombre: 'Cliente envío', telefono: '5218780000123' },
        ...(tipo === 'domicilio' ? { direccion: { calle: 'Calle 1', colonia: 'Centro' }, costoEnvio: 20 } : {}),
        items: [{ producto_id: PROD['Agua cobro'], cantidad: 2 }],
        formaPago: 'efectivo',
      }),
    });
    const d = await r.json();
    assert.strictEqual(r.status, 200, `${tipo}: status ${r.status} ${JSON.stringify(d)}`);
    const folio = d.pedido?.id || d.folio;
    const fila = await leerFila(folio);
    assert.strictEqual(fila.datos.modalidad, esperado, `${tipo}: modalidad incorrecta`);
    assert.strictEqual(fila.datos.forma_pago, 'efectivo', `${tipo}: perdió su forma de pago`);
    assert.notStrictEqual(fila.datos.forma_pago, 'por_cobrar', `${tipo}: quedó como por cobrar`);
  }
});

await t('REGRESION', '21. el flujo clásico (crear=cobrar) sigue disponible en presencial', async () => {
  const r = await api('/api/pedido-presencial', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ producto_id: PROD['Taco cobro'], cantidad: 1 }],
      nombre: 'Clásico', forma_pago: 'efectivo', billete: 100,
    }),
  });
  const d = await r.json();
  assert.ok(d.ok, 'no se creó el pedido clásico');
  const fila = await leerFila(d.pedido.id);
  assert.strictEqual(fila.datos.forma_pago, 'efectivo');
  assert.notStrictEqual(fila.datos.forma_pago, 'por_cobrar');
});

await t('REGRESION', '21b. Restaurante conserva su cierre propio (cuenta ≠ pedido del tablero)', async () => {
  // El cierre de mesas vive en restauranteService.cerrarCuenta y genera folios
  // RM-*; el endpoint de cobro del tablero no lo toca.
  const r = await api('/pedidos/RM-INEXISTENTE-0/cobro', {
    method: 'PATCH', body: JSON.stringify({ forma_pago: 'efectivo' }),
  });
  assert.strictEqual(r.status, 404, 'el cobro del tablero aceptó un folio de restaurante');
});

// ─── Contrato de UI ─────────────────────────────────────────────────────────
await t('PANEL-HTML', 'la captura no tiene formulario de pago y el modal Cobrar existe', () => {
  const html = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');
  assert.ok(html.includes('id="modal-cobro"'), 'falta el modal Cobrar');
  assert.ok(html.includes('function confirmarCobro'), 'falta confirmarCobro');
  assert.ok(html.includes('/cobro`'), 'el panel no llama al endpoint de cobro');
  // Los controles de pago viven SOLO en el modal (prefijo cobro-)
  assert.ok(!html.includes('id="pos-billete"'), 'el billete sigue en la captura');
  assert.ok(!html.includes('id="mixto-efectivo"'), 'el mixto sigue en la captura');
  assert.ok(!html.includes('id="pos-descuento-val"'), 'el descuento sigue en la captura');
  assert.ok(html.includes('Crear pedido'), 'el botón de captura no dice "Crear pedido"');
});

} finally {
  srv.detener();
  await new Promise((r) => { srv.proc.once('exit', r); setTimeout(r, 3000); });
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre = 'Cobro diferido (test)'`, [NEG_A]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); process.exit(1); }
