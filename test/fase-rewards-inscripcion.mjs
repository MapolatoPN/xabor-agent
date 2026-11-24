// Saneamiento de Clientes, Campañas y Rewards — FASE 3 (Rewards, puntos 10–17).
//
// Lo que esta suite sostiene, punto por punto:
//
//   10. Acumula SOLO una cuenta inscrita, activa, de una persona: nunca el
//       registro genérico del mostrador, un teléfono del negocio ni un
//       interno. Lo decide el servidor (acumularPuntos), no la pantalla.
//   11. Inscripción explícita (caja, tienda; WhatsApp manda a la tienda).
//       Comprar no inscribe. Una cuenta automática que se inscribe conserva
//       sus puntos.
//   12/14. El script de saneamiento: sin --aplicar no escribe; aplicado deja
//       bitácora y se revierte.
//   15. Vencimiento apagado de entrada; encendido, cuenta desde la última
//       compra y nunca desde antes del día en que se encendió.
//   16. Rewards y la Lista dan las mismas cifras.
//   17. Sin los botones repetidos del encabezado de Rewards.
//
// Negocios: A (del seed) para las rutas de administrador; dos negocios
// PROPIOS de la suite (T: tienda con cuentas; S: script y vencimiento) para
// que nada de lo que hagan otras suites cambie las cuentas que se miden.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_RWI || '4733';

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const rw = await import('../src/services/rewardsService.js');
const { vencerPuntos } = await import('../src/services/rewardsVencimiento.js');
const { planDeCanje } = await import('../src/services/tiendaRewards.js');
const { resumenClientesCrm } = await import('../src/services/clientesCrm.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const leer = (...p) => readFileSync(join(RAIZ, ...p), 'utf8');

const NEG_A = SEED.negocioA;
const ADMIN_A = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: NEG_A, rol: 'admin' }))}`;
const suf = Date.now().toString().slice(-6);
const tel = (n) => `66${suf}${String(n).padStart(2, '0')}`;   // 10 dígitos exactos
const GENERICO = `pos-${randomBytes(6).toString('hex')}`;
const SLUG_T = `rw-insc-${suf}`;
let NEG_T = null, NEG_S = null;
const TELS = [];
const usar = (n) => { const x = tel(n); TELS.push(x, `52${x}`, `521${x}`); return x; };

// Teléfonos de A
const T_INS = usar(1), T_AUTO = usar(2), T_PROPIO = usar(3), T_INTERNO = usar(4), T_FMT = usar(5),
  T_POS = usar(6), T_CAJA = usar(7), T_CAJA_AUTO = usar(8), T_MESA = usar(9);
// De T (tienda)
const T_TIENDA = usar(20), T_TIENDA_PROPIO = usar(21);
// De S (script y vencimiento)
const S_FUS = usar(30), S_REN = usar(31), S_PROPIO = usar(32), S_SOLO = usar(33),
  V_VIEJO = usar(40), V_RECIENTE = usar(41), V_AUTO = usar(42);

// ── HTTP ────────────────────────────────────────────────────────────────
let base;
async function pedir(ruta, { method = 'GET', body, cookie } = {}) {
  const r = await fetch(`${base}${ruta}`, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = r.headers.get('set-cookie') || '';
  return { status: r.status, body: await r.json().catch(() => ({})), set };
}
async function entrarTienda(slug, telefono, nombre) {
  const otp = await pedir(`/api/tienda/${slug}/cuenta/otp`, { method: 'POST', body: { telefono } });
  assert.strictEqual(otp.status, 200, `OTP: ${JSON.stringify(otp.body)}`);
  const v = await pedir(`/api/tienda/${slug}/cuenta/otp/verificar`, { method: 'POST', body: { telefono, codigo: otp.body.codigoDev, nombre } });
  assert.strictEqual(v.status, 200, `verificar: ${JSON.stringify(v.body)}`);
  const m = /xabor_cliente=([^;]*)/.exec(v.set);
  assert.ok(m && m[1], 'no quedó cookie de cliente');
  return `xabor_cliente=${m[1]}`;
}

// ── Fixtures ────────────────────────────────────────────────────────────
async function fijarModulo(negocioId, modulo, estado = 'activo') {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}
async function fijarRewards(negocioId, extra = {}) {
  const c = { activo: true, canal_mostrador: true, canal_tienda: true, ...extra };
  await pool.query(
    `INSERT INTO rewards_config (tenant_id, activo, monto_por_punto, puntos_por_peso, canje_minimo,
       canal_mostrador, canal_whatsapp, canal_telefono, canal_rappi, canal_tienda, vigencia_dias, vigencia_desde)
     VALUES ($1,$2,10,0.5,100,$3,TRUE,TRUE,FALSE,$4,NULL,NULL)
     ON CONFLICT (tenant_id) DO UPDATE SET activo=$2, monto_por_punto=10, puntos_por_peso=0.5, canje_minimo=100,
       canal_mostrador=$3, canal_whatsapp=TRUE, canal_telefono=TRUE, canal_rappi=FALSE, canal_tienda=$4,
       vigencia_dias=NULL, vigencia_desde=NULL`,
    [negocioId, c.activo, c.canal_mostrador, c.canal_tienda]);
}
// Una cuenta como las que dejó el motor ANTES de la fase 3: nacida al
// comprar, sin inscripción. `inscrita` la marca como inscrita en caja.
async function cuenta(negocioId, telefono, puntos, { inscrita = false, nombre = null } = {}) {
  await pool.query(`INSERT INTO clientes (telefono, nombre) VALUES ($1,$2) ON CONFLICT (telefono) DO NOTHING`, [telefono, nombre]);
  const { rows: [a] } = await pool.query(
    `INSERT INTO rewards_accounts (telefono, tenant_id, nombre, puntos_balance, puntos_acumulados_total,
       inscrito_at, inscripcion_origen, inscrito_por)
     VALUES ($1,$2,$3,$4,$4, CASE WHEN $5 THEN NOW() END, CASE WHEN $5 THEN 'caja' END, CASE WHEN $5 THEN 'suite' END)
     RETURNING *`, [telefono, negocioId, nombre, puntos, inscrita]);
  if (puntos > 0) {
    await pool.query(
      `INSERT INTO rewards_movements (account_id, tenant_id, tipo, puntos, balance_anterior, balance_posterior, folio_venta, usuario, motivo)
       VALUES ($1,$2,'acumulacion',$3,0,$3,$4,'sistema','Compra de prueba')`,
      [a.id, negocioId, puntos, `RWI-${suf}-${a.id}`]);
  }
  return a;
}
const saldo = async (negocioId, telefono) =>
  (await pool.query('SELECT puntos_balance, activo, inscrito_at FROM rewards_accounts WHERE tenant_id=$1 AND telefono=$2', [negocioId, telefono])).rows[0] || null;
const venta = (telefono, total = 500, canal = 'presencial') => ({ total, canal, cliente: { telefono, nombre: 'Cliente RWI' } });
let folioN = 0;
const folio = () => `RWI-${suf}-v${++folioN}`;

async function huella(negocioId) {
  const { rows: [r] } = await pool.query(`
    SELECT (SELECT md5(COALESCE(string_agg(row_to_json(a)::text, '|' ORDER BY id), '')) FROM rewards_accounts a WHERE tenant_id = $1) AS c,
           (SELECT md5(COALESCE(string_agg(row_to_json(m)::text, '|' ORDER BY id), '')) FROM rewards_movements m WHERE tenant_id = $1) AS m,
           (SELECT md5(COALESCE(string_agg(row_to_json(b)::text, '|' ORDER BY id), '')) FROM rewards_bitacora b WHERE tenant_id = $1) AS b,
           (SELECT count(*) FROM clientes WHERE telefono = ANY($2)) AS k`, [negocioId, TELS]);
  return JSON.stringify(r);
}
// El saldo de cada cuenta es la suma de su libro de movimientos. El script
// escribe los dos juntos; si un día escribe solo el movimiento, aquí se ve.
async function libroCuadra(negocioId) {
  const { rows } = await pool.query(
    `SELECT a.id, a.puntos_balance, COALESCE(sum(m.puntos), 0)::int AS libro
       FROM rewards_accounts a LEFT JOIN rewards_movements m ON m.account_id = a.id
      WHERE a.tenant_id = $1 GROUP BY a.id, a.puntos_balance
     HAVING a.puntos_balance <> COALESCE(sum(m.puntos), 0)`, [negocioId]);
  assert.deepStrictEqual(rows, [], `saldo distinto de su libro: ${JSON.stringify(rows)}`);
}
function script(...args) {
  const r = spawnSync(process.execPath, ['scripts/rewards-saneamiento.mjs', ...args],
    { cwd: RAIZ, env: { ...process.env }, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const lote = (out) => /Lote: ([0-9a-f-]{36})/.exec(out)?.[1];

async function crearNegocio(etiqueta) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1, $2) RETURNING id::text AS id`,
    [`RW Inscripción ${etiqueta} ${suf}`, `rw-insc-${etiqueta}-${suf}`]);
  return n.id;
}

async function limpiar() {
  const negs = [NEG_A, NEG_T, NEG_S].filter(Boolean);
  const todos = [...TELS, GENERICO];
  for (const n of negs) {
    const ids = `(SELECT id FROM rewards_accounts WHERE tenant_id = $1 AND telefono = ANY($2))`;
    await pool.query(`DELETE FROM rewards_movements WHERE account_id IN ${ids}`, [n, todos]).catch(() => {});
    await pool.query(`DELETE FROM rewards_bitacora WHERE account_id IN ${ids}`, [n, todos]).catch(() => {});
    await pool.query(`DELETE FROM rewards_accounts WHERE tenant_id = $1 AND telefono = ANY($2)`, [n, todos]).catch(() => {});
    await pool.query(`DELETE FROM negocio_telefonos_propios WHERE negocio_id = $1 AND telefono = ANY($2)`, [n, todos]).catch(() => {});
    await pool.query(`DELETE FROM cliente_sesiones WHERE negocio_id = $1`, [n]).catch(() => {});
    if (n !== NEG_A) {
      await pool.query(`DELETE FROM rewards_bitacora WHERE tenant_id = $1`, [n]).catch(() => {});
      for (const tb of ['cliente_consentimientos', 'cliente_direcciones', 'cliente_sesiones']) {
        await pool.query(`DELETE FROM ${tb} WHERE negocio_id = $1`, [n]).catch(() => {});
      }
    }
    await pool.query(`DELETE FROM clientes_negocio WHERE negocio_id = $1 AND telefono = ANY($2)`, [n, todos]).catch(() => {});
  }
  await pool.query(`DELETE FROM cliente_otp WHERE telefono = ANY($1)`, [TELS]).catch(() => {});
  await pool.query(`DELETE FROM clientes WHERE telefono = ANY($1)`, [todos]).catch(() => {});
}
async function borrarNegocio(id) {
  if (!id) return;
  for (const tb of ['rewards_config']) await pool.query(`DELETE FROM ${tb} WHERE tenant_id = $1`, [id]).catch(() => {});
  for (const tb of ['menu_productos', 'tienda_productos', 'menu_categorias', 'tienda_config', 'negocio_modulos', 'configuracion', 'metodos_pago', 'clientes_negocio']) {
    await pool.query(`DELETE FROM ${tb} WHERE negocio_id = $1`, [id]).catch(() => {});
  }
  await pool.query('DELETE FROM negocios WHERE id = $1', [id]).catch(e => console.log(`  (el negocio de prueba ${id} quedó: ${e.message})`));
}

let servidor = null;
try {
  NEG_T = await crearNegocio('t');
  NEG_S = await crearNegocio('s');
  await limpiar();

  for (const n of [NEG_A, NEG_T, NEG_S]) { await fijarModulo(n, 'rewards'); await fijarRewards(n); }
  for (const m of ['tienda_online', 'pos', 'menu']) await fijarModulo(NEG_T, m);
  // Tienda de T: publicada, con cuentas de cliente y un producto.
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'RWI (test)',TRUE,940) RETURNING id`, [NEG_T]);
  const { rows: [prod] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
     VALUES ($1,$2,'Pizza RWI',200,TRUE,1) RETURNING id`, [NEG_T, cat.id]);
  await pool.query(`INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)`, [NEG_T, prod.id]);
  await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'reglas_atencion',$2)
    ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`, [NEG_T, JSON.stringify({
    horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
      .map(d => [d, { abierto: true, apertura: '00:00', cierre: '23:59' }])),
    pedidos: { costo_envio: 0, pedido_minimo_entrega: 0, entrega_gratis_desde: 0, zonas_entrega: [],
      tiempo_preparacion_minutos: 20, tiempo_entrega_min_minutos: 30, tiempo_entrega_max_minutos: 45 },
  })]);
  await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'tienda_metodos_pago','["efectivo"]')
    ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = '["efectivo"]'`, [NEG_T]);
  await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado) VALUES ($1,'efectivo',TRUE)
    ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [NEG_T]).catch(() => {});
  await pool.query(
    `INSERT INTO tienda_config (negocio_id, estado, slug_publico, titular, modalidades, cuentas_clientes)
     VALUES ($1,'publicada',$2,'RWI',$3,TRUE)`, [NEG_T, SLUG_T, JSON.stringify(['recoger'])]);

  servidor = await arrancarServidor({
    PORT: PUERTO, XABOR_OTP_DEV_EXPONER: 'true', XABOR_OTP_LIMITE_IP: '100000',
    XABOR_TIENDA_LIMITE_CHECKOUT: '100000', XABOR_TIENDA_LIMITE_COTIZAR: '100000', XABOR_TIENDA_LIMITE_LECTURA: '100000',
  }, { timeoutMs: 60000, omitir: ['OTP_PROVEEDOR', 'NODE_ENV'] });
  base = servidor.base || `http://localhost:${PUERTO}`;

  // ══ 10. Quién acumula ══════════════════════════════════════════════════
  await t('ACU', 'un cliente inscrito acumula', async () => {
    await cuenta(NEG_A, T_INS, 0, { inscrita: true });
    const r = await rw.acumularPuntos(folio(), venta(T_INS, 500), NEG_A);
    assert.ok(r && r.puntos === 50, JSON.stringify(r));
    assert.strictEqual((await saldo(NEG_A, T_INS)).puntos_balance, 50);
  });

  await t('ACU', 'una cuenta automática (sin inscribir) no acumula y conserva su saldo', async () => {
    await cuenta(NEG_A, T_AUTO, 120);
    const r = await rw.acumularPuntos(folio(), venta(T_AUTO, 500), NEG_A);
    assert.strictEqual(r, null, 'acumuló sin inscripción');
    assert.strictEqual((await saldo(NEG_A, T_AUTO)).puntos_balance, 120);
  });

  await t('ACU', 'el registro genérico del mostrador no acumula ni crea cuenta', async () => {
    const r = await rw.acumularPuntos(folio(), venta(GENERICO, 900), NEG_A);
    assert.strictEqual(r, null);
    assert.strictEqual(await saldo(NEG_A, GENERICO), null, 'se creó una cuenta para el genérico');
  });

  await t('ACU', 'un teléfono del negocio no acumula aunque tenga cuenta inscrita', async () => {
    await cuenta(NEG_A, T_PROPIO, 0, { inscrita: true });
    await pool.query(`INSERT INTO negocio_telefonos_propios (negocio_id, telefono, etiqueta, origen, activo)
      VALUES ($1,$2,'Caja RWI','manual',TRUE)`, [NEG_A, T_PROPIO]);
    assert.strictEqual(await rw.acumularPuntos(folio(), venta(T_PROPIO), NEG_A), null);
    assert.strictEqual((await saldo(NEG_A, T_PROPIO)).puntos_balance, 0);
  });

  await t('ACU', 'un cliente interno no acumula aunque tenga cuenta inscrita', async () => {
    await cuenta(NEG_A, T_INTERNO, 0, { inscrita: true });
    await pool.query(`INSERT INTO clientes_negocio (negocio_id, telefono, nombre, origen, es_interno, interno_motivo)
      VALUES ($1,$2,'Empleado RWI','mostrador',TRUE,'empleado')
      ON CONFLICT (negocio_id, telefono) DO UPDATE SET es_interno = TRUE`, [NEG_A, T_INTERNO]);
    assert.strictEqual(await rw.acumularPuntos(folio(), venta(T_INTERNO), NEG_A), null);
  });

  await t('ACU', 'un pedido con 521 acumula en la cuenta de 10 dígitos, sin crear otra', async () => {
    await cuenta(NEG_A, T_FMT, 0, { inscrita: true });
    const r = await rw.acumularPuntos(folio(), venta(`521${T_FMT}`, 300), NEG_A);
    assert.ok(r && r.puntos === 30, JSON.stringify(r));
    assert.strictEqual((await saldo(NEG_A, T_FMT)).puntos_balance, 30);
    assert.strictEqual(await saldo(NEG_A, `521${T_FMT}`), null, 'nació una segunda cuenta');
  });

  await t('ACU', 'el POS de envíos (canal pos) acumula bajo el interruptor «Mostrador»', async () => {
    await cuenta(NEG_A, T_POS, 0, { inscrita: true });
    const r = await rw.acumularPuntos(folio(), venta(T_POS, 200, 'pos'), NEG_A);
    assert.ok(r && r.puntos === 20, `canal pos: ${JSON.stringify(r)}`);
    await pool.query('UPDATE rewards_config SET canal_mostrador = FALSE WHERE tenant_id = $1', [NEG_A]);
    try {
      assert.strictEqual(await rw.acumularPuntos(folio(), venta(T_POS, 200, 'pos'), NEG_A), null, 'con Mostrador apagado acumuló');
    } finally { await pool.query('UPDATE rewards_config SET canal_mostrador = TRUE WHERE tenant_id = $1', [NEG_A]); }
  });

  await t('ACU', 'las mesas (restaurante_mesa) no acumulan en esta fase', async () => {
    await cuenta(NEG_A, T_MESA, 0, { inscrita: true });
    assert.strictEqual(await rw.acumularPuntos(folio(), venta(T_MESA, 400, 'restaurante_mesa'), NEG_A), null);
    assert.strictEqual(rw.MAPA_CANAL_CONFIG({ canal_mostrador: true }).restaurante_mesa, undefined);
  });

  // ══ 11. Inscripción en caja ════════════════════════════════════════════
  await t('INS', 'caja: el alta con nombre y teléfono inscribe y deja bitácora', async () => {
    const r = await pedir('/api/rewards/cliente', { method: 'POST', cookie: ADMIN_A, body: { nombre: 'Ana Caja', telefono: T_CAJA } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.nueva, true);
    assert.ok(r.body.perfil?.inscrito_at, 'el perfil no dice que está inscrita');
    const c = await saldo(NEG_A, T_CAJA);
    assert.ok(c.inscrito_at);
    const { rows } = await pool.query(
      `SELECT b.accion, b.despues FROM rewards_bitacora b JOIN rewards_accounts a ON a.id = b.account_id
        WHERE a.tenant_id = $1 AND a.telefono = $2`, [NEG_A, T_CAJA]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].accion, 'inscripcion');
    assert.strictEqual(rows[0].despues.origen, 'caja');
  });

  await t('INS', 'una cuenta automática que se inscribe conserva sus puntos', async () => {
    await cuenta(NEG_A, T_CAJA_AUTO, 250);
    const r = await pedir('/api/rewards/cliente', { method: 'POST', cookie: ADMIN_A, body: { nombre: 'Beto', telefono: `52${T_CAJA_AUTO}` } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.nueva, false);
    const c = await saldo(NEG_A, T_CAJA_AUTO);
    assert.strictEqual(c.puntos_balance, 250, 'inscribirse le cambió el saldo');
    assert.ok(c.inscrito_at);
    const { rows: [b] } = await pool.query(
      `SELECT antes FROM rewards_bitacora b JOIN rewards_accounts a ON a.id = b.account_id WHERE a.tenant_id=$1 AND a.telefono=$2`, [NEG_A, T_CAJA_AUTO]);
    assert.strictEqual(b.antes.puntos_balance, 250);
    assert.strictEqual(b.antes.inscrito_at, null);
  });

  await t('INS', 'inscribir dos veces no duplica la bitácora', async () => {
    const r = await pedir('/api/rewards/cliente', { method: 'POST', cookie: ADMIN_A, body: { nombre: 'Ana Caja', telefono: T_CAJA } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.yaInscrito, true);
    const { rows } = await pool.query(
      `SELECT 1 FROM rewards_bitacora b JOIN rewards_accounts a ON a.id = b.account_id WHERE a.tenant_id=$1 AND a.telefono=$2`, [NEG_A, T_CAJA]);
    assert.strictEqual(rows.length, 1);
  });

  await t('INS', 'caja rechaza teléfonos del negocio, internos, inválidos y sin nombre', async () => {
    const casos = [
      [{ nombre: 'Caja', telefono: T_PROPIO }, 409, 'TELEFONO_DEL_NEGOCIO'],
      [{ nombre: 'Emp', telefono: T_INTERNO }, 409, 'CLIENTE_INTERNO'],
      [{ nombre: 'X', telefono: '123' }, 400, null],
      [{ nombre: 'Sin', telefono: GENERICO }, 400, 'TELEFONO_INVALIDO'],
      [{ nombre: '', telefono: tel(10) }, 400, null],
    ];
    for (const [body, status, codigo] of casos) {
      const r = await pedir('/api/rewards/cliente', { method: 'POST', cookie: ADMIN_A, body });
      assert.strictEqual(r.status, status, `${JSON.stringify(body)} → ${r.status} ${JSON.stringify(r.body)}`);
      if (codigo) assert.strictEqual(r.body.codigo, codigo);
    }
    assert.strictEqual(await saldo(NEG_A, tel(10)), null, 'un alta rechazada dejó cuenta');
  });

  await t('INS', 'la búsqueda de caja solo trae inscritos; la de Rewards (todos=1) también los automáticos', async () => {
    const caja = await pedir(`/api/rewards/clientes/buscar?q=${T_AUTO}`, { cookie: ADMIN_A });
    assert.strictEqual(caja.status, 200);
    assert.strictEqual(caja.body.length, 0, 'la caja ofrece una cuenta sin inscribir');
    const todos = await pedir(`/api/rewards/clientes/buscar?todos=1&q=${T_AUTO}`, { cookie: ADMIN_A });
    assert.strictEqual(todos.body.length, 1);
    assert.strictEqual(todos.body[0].inscrito, false);
  });

  // ══ Canje ══════════════════════════════════════════════════════════════
  await t('CAN', 'una cuenta sin inscribir no canjea (servidor, plan de tienda y caja)', async () => {
    await assert.rejects(() => rw.registrarCanje(folio(), T_AUTO, 100, 'suite', NEG_A), /no está inscrito/);
    assert.strictEqual((await saldo(NEG_A, T_AUTO)).puntos_balance, 120, 'el canje rechazado movió el saldo');
    assert.strictEqual(await planDeCanje({ negocioId: NEG_A, telefono: T_AUTO, puntosSolicitados: 100, total: 500 }), null);
    const r = await pedir(`/api/rewards/cliente/${T_AUTO}/canje-disponible?total=500`, { cookie: ADMIN_A });
    assert.strictEqual(r.body.bloques, 0);
    assert.strictEqual(r.body.puntos_balance, 0);
  });

  await t('CAN', 'la misma cuenta, ya inscrita, sí canjea', async () => {
    const r = await rw.registrarCanje(folio(), T_CAJA_AUTO, 100, 'suite', NEG_A);
    assert.ok(r, 'no canjeó');
    assert.strictEqual((await saldo(NEG_A, T_CAJA_AUTO)).puntos_balance, 150);
  });

  // ══ 16. Una sola fuente para las cifras ════════════════════════════════
  await t('CIF', 'Rewards y la Lista muestran los mismos inscritos y puntos', async () => {
    await cuenta(NEG_A, GENERICO, 999);
    const rRw = await pedir('/api/rewards/resumen', { cookie: ADMIN_A });
    const rLi = await pedir('/api/admin/clientes/v2/resumen', { cookie: ADMIN_A });
    assert.strictEqual(rRw.status, 200); assert.strictEqual(rLi.status, 200);
    assert.strictEqual(rLi.body.con_rewards, rRw.body.clientes_inscritos, 'inscritos distintos');
    assert.strictEqual(rLi.body.puntos_vivos, rRw.body.saldo_total, 'puntos distintos');
    assert.strictEqual(rLi.body.rewards_sin_inscribir, rRw.body.sin_inscribir);
    assert.strictEqual(rLi.body.puntos_sin_inscribir, rRw.body.saldo_sin_inscribir);
    const c = await rw.cifrasRewards(NEG_A);
    assert.strictEqual(c.inscritos, rRw.body.clientes_inscritos);
    assert.ok(c.fueraDelPrograma >= 3, 'el genérico, el teléfono del negocio y el interno van aparte');
  });

  await t('CIF', 'el genérico, los del negocio y los internos no cuentan ni salen en la lista', async () => {
    const lista = await rw.listarClientesRewards(NEG_A);
    const tels = lista.map(x => x.telefono);
    for (const fuera of [GENERICO, T_PROPIO, T_INTERNO]) assert.ok(!tels.includes(fuera), `${fuera} salió en la lista`);
    const ins = lista.find(x => x.telefono === T_INS), auto = lista.find(x => x.telefono === T_AUTO);
    assert.ok(ins?.inscrito === true && auto?.inscrito === false);
    assert.ok(lista.indexOf(ins) < lista.indexOf(auto), 'los inscritos van primero');
  });

  await t('CIF', 'la tabla de la Lista usa la misma definición (puntos solo de inscritos)', async () => {
    const r = await resumenClientesCrm(NEG_A);
    const c = await rw.cifrasRewards(NEG_A);
    assert.strictEqual(r.con_rewards, c.inscritos);
    assert.strictEqual(r.puntos_vivos, c.saldoInscritos);
  });

  // ══ Tienda (T) ═════════════════════════════════════════════════════════
  let galleta = null;
  await t('TIE', 'la ruta pública de puntos no dice si alguien está inscrito', async () => {
    const r = await pedir(`/api/tienda/${SLUG_T}/rewards?total=200&telefono=${T_TIENDA}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.activo, true);
    assert.ok(!('inscrito' in r.body), JSON.stringify(r.body));
  });

  await t('TIE', 'Mi cuenta de un cliente con puntos viejos: sin inscribir, puntos guardados, nada canjeable', async () => {
    await cuenta(NEG_T, `52${T_TIENDA}`, 300);
    galleta = await entrarTienda(SLUG_T, T_TIENDA, 'Clara Tienda');
    const r = await pedir(`/api/tienda/${SLUG_T}/cuenta/rewards`, { cookie: galleta });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.inscrito, false);
    assert.strictEqual(r.body.puntosGuardados, 300);
    assert.strictEqual(r.body.puntosCanjeables, 0);
  });

  await t('TIE', 'la cotización con sesión dice «no inscrito»; sin sesión no lo dice', async () => {
    const cuerpo = { items: [{ productoId: prod.id, cantidad: 1 }], modalidad: 'recoger', telefono: T_TIENDA };
    const con = await pedir(`/api/tienda/${SLUG_T}/cotizar`, { method: 'POST', cookie: galleta, body: cuerpo });
    assert.strictEqual(con.status, 200, JSON.stringify(con.body));
    assert.strictEqual(con.body.rewards?.inscrito, false, JSON.stringify(con.body.rewards));
    assert.ok(con.body.rewards.puntosQueGanaria > 0);
    const sin = await pedir(`/api/tienda/${SLUG_T}/cotizar`, { method: 'POST', body: cuerpo });
    assert.strictEqual(sin.body.rewards?.requiereSesion, true);
    assert.ok(!('inscrito' in sin.body.rewards), 'sin sesión se reveló la inscripción');
  });

  await t('TIE', 'inscribirse en Mi cuenta: queda inscrito por la tienda y sus puntos se pueden usar', async () => {
    const r = await pedir(`/api/tienda/${SLUG_T}/cuenta/rewards/inscripcion`, { method: 'POST', cookie: galleta, body: {} });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.rewards.inscrito, true);
    assert.strictEqual(r.body.rewards.puntosCanjeables, 300, 'la cuenta de 52… debía quedar como la principal');
    const { rows: [a] } = await pool.query(
      `SELECT inscripcion_origen, inscrito_por, puntos_balance FROM rewards_accounts WHERE tenant_id=$1 AND telefono=$2`, [NEG_T, `52${T_TIENDA}`]);
    assert.strictEqual(a.inscripcion_origen, 'tienda');
    assert.match(a.inscrito_por, /^cliente:/);
    assert.strictEqual(a.puntos_balance, 300);
  });

  await t('TIE', 'sin sesión no se inscribe (401) y con cuentas apagadas la ruta no existe (404)', async () => {
    const r = await pedir(`/api/tienda/${SLUG_T}/cuenta/rewards/inscripcion`, { method: 'POST', body: { nombre: 'Intruso' } });
    assert.strictEqual(r.status, 401);
    await pool.query('UPDATE tienda_config SET cuentas_clientes = FALSE WHERE negocio_id = $1', [NEG_T]);
    try {
      const r2 = await pedir(`/api/tienda/${SLUG_T}/cuenta/rewards/inscripcion`, { method: 'POST', cookie: galleta, body: {} });
      assert.strictEqual(r2.status, 404);
      // Sin cuentas, el teléfono lo teclea cualquiera: ni la cotización ni la
      // ruta pública dicen si ese número está inscrito.
      const cot = await pedir(`/api/tienda/${SLUG_T}/cotizar`, { method: 'POST',
        body: { items: [{ productoId: prod.id, cantidad: 1 }], modalidad: 'recoger', telefono: T_TIENDA } });
      assert.strictEqual(cot.status, 200, JSON.stringify(cot.body));
      assert.strictEqual(cot.body.rewards?.puntos, 300, 'sin cuentas se sigue viendo el saldo del teléfono tecleado');
      assert.ok(!('inscrito' in cot.body.rewards), 'la cotización sin cuentas revela la inscripción');
      const pub = await pedir(`/api/tienda/${SLUG_T}/rewards?total=200&telefono=${T_TIENDA}`);
      assert.ok(!('inscrito' in pub.body), 'la ruta pública sin cuentas revela la inscripción');
    } finally { await pool.query('UPDATE tienda_config SET cuentas_clientes = TRUE WHERE negocio_id = $1', [NEG_T]); }
  });

  await t('TIE', 'un teléfono del negocio no se inscribe desde la tienda', async () => {
    await pool.query(`INSERT INTO negocio_telefonos_propios (negocio_id, telefono, etiqueta, origen, activo)
      VALUES ($1,$2,'WhatsApp RWI','manual',TRUE)`, [NEG_T, T_TIENDA_PROPIO]);
    const g = await entrarTienda(SLUG_T, T_TIENDA_PROPIO, 'Sucursal');
    const r = await pedir(`/api/tienda/${SLUG_T}/cuenta/rewards/inscripcion`, { method: 'POST', cookie: g, body: {} });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.codigo, 'NO_INSCRIBIBLE');
    assert.strictEqual(await saldo(NEG_T, T_TIENDA_PROPIO), null);
  });

  // ══ 15. Vencimiento (S) ════════════════════════════════════════════════
  const DIA = 86400000;
  const enDias = (d) => new Date(Date.now() + d * DIA);
  await t('VEN', 'apagado de entrada: no vence nada aunque pase un año', async () => {
    const c = await rw.obtenerConfig(NEG_S);
    assert.strictEqual(c.vigencia_dias ?? null, null);
    await cuenta(NEG_S, V_VIEJO, 200, { inscrita: true });
    await cuenta(NEG_S, V_RECIENTE, 300, { inscrita: true });
    await cuenta(NEG_S, V_AUTO, 400);
    // El «viejo» se inscribió y compró por última vez hace 200 días: mucho
    // antes de que se encienda el vencimiento. Encenderlo no puede vencerlo
    // de golpe; el plazo le corre desde ese día.
    await pool.query(`UPDATE rewards_accounts SET inscrito_at = $3 WHERE tenant_id = $1 AND telefono = $2`, [NEG_S, V_VIEJO, enDias(-200)]);
    await pool.query(`UPDATE rewards_movements SET created_at = $3 WHERE tenant_id = $1 AND account_id =
      (SELECT id FROM rewards_accounts WHERE tenant_id=$1 AND telefono=$2)`, [NEG_S, V_VIEJO, enDias(-200)]);
    await vencerPuntos({ ahora: enDias(400), negocioId: NEG_S });
    assert.strictEqual((await saldo(NEG_S, V_VIEJO)).puntos_balance, 200);
  });

  await t('VEN', 'al encenderlo el plazo cuenta desde ese día, no desde antes', async () => {
    const r = await rw.actualizarConfig(NEG_S, { vigencia_dias: 90 });
    assert.strictEqual(Number(r.vigencia_dias), 90);
    assert.ok(r.vigencia_desde, 'no se fijó vigencia_desde');
    assert.ok(Math.abs(new Date(r.vigencia_desde) - Date.now()) < 120000, 'vigencia_desde no es ahora');
    await vencerPuntos({ ahora: enDias(60), negocioId: NEG_S });
    assert.strictEqual((await saldo(NEG_S, V_VIEJO)).puntos_balance, 200, 'venció antes del plazo');
  });

  await t('VEN', 'pasado el plazo vence el inscrito sin compra; no el que compró ni el automático', async () => {
    // La compra del «reciente» cae dentro del plazo (a 20 días de hoy).
    await pool.query(`UPDATE rewards_movements SET created_at = $3 WHERE tenant_id = $1 AND account_id =
      (SELECT id FROM rewards_accounts WHERE tenant_id=$1 AND telefono=$2)`, [NEG_S, V_RECIENTE, enDias(20)]);
    const r = await vencerPuntos({ ahora: enDias(100), negocioId: NEG_S });
    assert.ok(r.cuentas >= 1);
    assert.strictEqual((await saldo(NEG_S, V_VIEJO)).puntos_balance, 0);
    assert.strictEqual((await saldo(NEG_S, V_RECIENTE)).puntos_balance, 300, 'venció a quien compró dentro del plazo');
    assert.strictEqual((await saldo(NEG_S, V_AUTO)).puntos_balance, 400, 'tocó una cuenta sin inscribir');
    const { rows } = await pool.query(
      `SELECT m.puntos, m.motivo, m.balance_anterior FROM rewards_movements m JOIN rewards_accounts a ON a.id = m.account_id
        WHERE a.tenant_id=$1 AND a.telefono=$2 AND m.tipo='expiracion'`, [NEG_S, V_VIEJO]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].puntos, -200);
    assert.match(rows[0].motivo, /3 meses sin compra/);
  });

  await t('VEN', 'una segunda pasada no vuelve a vencer', async () => {
    await vencerPuntos({ ahora: enDias(100), negocioId: NEG_S });
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM rewards_movements m JOIN rewards_accounts a ON a.id = m.account_id
        WHERE a.tenant_id=$1 AND m.tipo='expiracion'`, [NEG_S]);
    assert.strictEqual(rows[0].n, 1);
  });

  await t('VEN', 'pausar y reanudar el programa reinicia el plazo; apagarlo lo borra', async () => {
    await pool.query(`UPDATE rewards_config SET vigencia_desde = NOW() - INTERVAL '30 days' WHERE tenant_id = $1`, [NEG_S]);
    await rw.actualizarConfig(NEG_S, { activo: false });
    const r = await rw.actualizarConfig(NEG_S, { activo: true });
    assert.ok(Math.abs(new Date(r.vigencia_desde) - Date.now()) < 120000, 'reanudar no reinició el plazo');
    const off = await rw.actualizarConfig(NEG_S, { vigencia_dias: null });
    assert.strictEqual(off.vigencia_dias ?? null, null);
    assert.strictEqual(off.vigencia_desde ?? null, null);
  });

  await t('VEN', 'el panel no acepta un plazo fuera de rango', async () => {
    const r = await pedir('/api/rewards/config', { method: 'PATCH', cookie: ADMIN_A, body: { vigencia_dias: 10 } });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body.codigo, 'VIGENCIA_INVALIDA');
    const ok = await pedir('/api/rewards/config', { method: 'PATCH', cookie: ADMIN_A, body: { vigencia_dias: 180 } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const off = await pedir('/api/rewards/config', { method: 'PATCH', cookie: ADMIN_A, body: { vigencia_dias: null } });
    assert.strictEqual(off.body.config.vigencia_dias ?? null, null);
  });

  // ══ 12/14. Script de saneamiento (S) ═══════════════════════════════════
  let loteAnular = null, loteNorm = null;
  await t('SCR', 'sin --aplicar no escribe: anular y normalizar en modo de prueba', async () => {
    await cuenta(NEG_S, GENERICO, 777);
    await cuenta(NEG_S, S_FUS, 50, { inscrita: true, nombre: 'Fausto' });
    await cuenta(NEG_S, `521${S_FUS}`, 100);
    await cuenta(NEG_S, `52${S_REN}`, 40, { inscrita: true });
    await cuenta(NEG_S, `52${S_PROPIO}`, 70);
    await cuenta(NEG_S, S_SOLO, 10, { inscrita: true });
    await pool.query(`INSERT INTO negocio_telefonos_propios (negocio_id, telefono, etiqueta, origen, activo)
      VALUES ($1,$2,'Caja S','manual',TRUE)`, [NEG_S, S_PROPIO]);
    const antes = await huella(NEG_S);
    for (const sub of ['anular-generico', 'normalizar', 'reporte']) {
      const r = script(sub, '--negocio', NEG_S);
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.out, /MODO DE PRUEBA/);
    }
    assert.strictEqual(await huella(NEG_S), antes, 'el modo de prueba escribió en la base');
    const n = script('normalizar', '--negocio', NEG_S).out;
    assert.match(n, /fusionar cuenta/); assert.match(n, /→ 10 dígitos/);
    assert.match(n, /teléfono del negocio o interno, no se toca/);
    assert.ok(!n.includes(S_FUS) && !n.includes(S_REN), 'la salida trae un teléfono completo');
  });

  await t('SCR', 'anular el genérico: saldo a cero con movimiento, fuera del programa y en bitácora', async () => {
    const r = script('anular-generico', '--negocio', NEG_S, '--aplicar', '--usuario', 'suite');
    assert.strictEqual(r.code, 0, r.out);
    loteAnular = lote(r.out);
    assert.ok(loteAnular, r.out);
    const g = await saldo(NEG_S, GENERICO);
    assert.strictEqual(g.puntos_balance, 0); assert.strictEqual(g.activo, false);
    const { rows: [m] } = await pool.query(
      `SELECT m.tipo, m.puntos, m.metadata FROM rewards_movements m JOIN rewards_accounts a ON a.id = m.account_id
        WHERE a.tenant_id=$1 AND a.telefono=$2 AND m.tipo <> 'acumulacion'`, [NEG_S, GENERICO]);
    assert.strictEqual(m.tipo, 'ajuste_negativo'); assert.strictEqual(m.puntos, -777);
    assert.strictEqual(m.metadata.lote, loteAnular);
    const { rows: [b] } = await pool.query(`SELECT accion, antes, usuario FROM rewards_bitacora WHERE lote = $1`, [loteAnular]);
    assert.strictEqual(b.accion, 'anulacion'); assert.strictEqual(b.antes.puntos_balance, 777); assert.strictEqual(b.usuario, 'suite');
    assert.strictEqual((await rw.cifrasRewards(NEG_S)).fueraDelPrograma, 1, 'solo debe quedar fuera el teléfono del negocio');
    await libroCuadra(NEG_S);
  });

  await t('SCR', 'normalizar: fusiona el 521 en la de 10 dígitos y renombra el 52 sin perder un punto', async () => {
    const totalAntes = (await pool.query(`SELECT sum(puntos_balance)::int s FROM rewards_accounts WHERE tenant_id=$1 AND activo`, [NEG_S])).rows[0].s;
    const r = script('normalizar', '--negocio', NEG_S, '--aplicar', '--usuario', 'suite');
    assert.strictEqual(r.code, 0, r.out);
    loteNorm = lote(r.out);
    const f = await saldo(NEG_S, S_FUS);
    assert.strictEqual(f.puntos_balance, 150);
    assert.strictEqual((await saldo(NEG_S, `521${S_FUS}`)).activo, false);
    assert.strictEqual((await saldo(NEG_S, S_REN)).puntos_balance, 40, 'el 52 no quedó en 10 dígitos');
    assert.strictEqual(await saldo(NEG_S, `52${S_REN}`), null);
    assert.strictEqual((await saldo(NEG_S, `52${S_PROPIO}`)).puntos_balance, 70, 'tocó un teléfono del negocio');
    const totalDespues = (await pool.query(`SELECT sum(puntos_balance)::int s FROM rewards_accounts WHERE tenant_id=$1 AND activo`, [NEG_S])).rows[0].s;
    assert.strictEqual(totalDespues, totalAntes, 'normalizar cambió los puntos del negocio');
    await libroCuadra(NEG_S);
    const { rows } = await pool.query(`SELECT accion FROM rewards_bitacora WHERE lote = $1 ORDER BY id`, [loteNorm]);
    assert.deepStrictEqual(rows.map(x => x.accion).sort(), ['fusion', 'normalizacion']);
    // Y la persona fusionada cuenta UNA vez.
    const lista = await rw.listarClientesRewards(NEG_S);
    assert.strictEqual(lista.filter(x => x.telefono === S_FUS).length, 1);
    assert.strictEqual(lista.find(x => x.telefono === S_FUS).cuentas, 1);
  });

  await t('SCR', 'repetir normalizar no hace nada', async () => {
    const antes = await huella(NEG_S);
    const r = script('normalizar', '--negocio', NEG_S, '--aplicar');
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /nada que hacer/);
    assert.strictEqual(await huella(NEG_S), antes);
  });

  await t('SCR', 'revertir en modo de prueba no escribe; aplicado deja todo como estaba', async () => {
    const antes = await huella(NEG_S);
    const p = script('revertir', '--lote', loteNorm);
    assert.strictEqual(p.code, 0, p.out);
    assert.strictEqual(await huella(NEG_S), antes);
    const r = script('revertir', '--lote', loteNorm, '--aplicar', '--usuario', 'suite');
    assert.strictEqual(r.code, 0, r.out);
    assert.strictEqual((await saldo(NEG_S, S_FUS)).puntos_balance, 50);
    const o = await saldo(NEG_S, `521${S_FUS}`);
    assert.strictEqual(o.puntos_balance, 100); assert.strictEqual(o.activo, true);
    assert.strictEqual((await saldo(NEG_S, `52${S_REN}`)).puntos_balance, 40);
    assert.strictEqual(await saldo(NEG_S, S_REN), null);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM rewards_bitacora WHERE lote = $1 AND revertido_at IS NULL`, [loteNorm]);
    assert.strictEqual(rows[0].n, 0, 'quedaron filas sin marcar como revertidas');
    await libroCuadra(NEG_S);
    const dos = script('revertir', '--lote', loteNorm, '--aplicar');
    assert.match(dos.out, /ya revertida/);
  });

  await t('SCR', 'revertir la anulación devuelve el saldo al genérico', async () => {
    const r = script('revertir', '--lote', loteAnular, '--aplicar');
    assert.strictEqual(r.code, 0, r.out);
    const g = await saldo(NEG_S, GENERICO);
    assert.strictEqual(g.puntos_balance, 777); assert.strictEqual(g.activo, true);
    await libroCuadra(NEG_S);
  });

  await t('SCR', 'no revierte una fusión cuyos puntos ya se gastaron (y no toca nada)', async () => {
    const r1 = script('normalizar', '--negocio', NEG_S, '--aplicar');
    const l = lote(r1.out);
    assert.ok(l, r1.out);
    await rw.ajustarPuntosManual(S_FUS, 120, 'ajuste_negativo', 'gasto de prueba', 'suite', NEG_S);
    const antes = await huella(NEG_S);
    const r = script('revertir', '--lote', l, '--aplicar');
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /ya gastó/);
    assert.strictEqual(await huella(NEG_S), antes, 'un revertir fallido dejó cambios');
  });

  await t('SCR', 'argumentos: sin negocio no corre; el modo de prueba es READ ONLY', async () => {
    assert.strictEqual(script('normalizar').code, 2);
    assert.strictEqual(script('revertir', '--lote', 'x').code, 2);
    assert.strictEqual(script('borrar-todo', '--negocio', NEG_S).code, 2);
    const src = leer('scripts', 'rewards-saneamiento.mjs');
    assert.match(src, /APLICAR \? 'BEGIN' : 'BEGIN READ ONLY'/);
    assert.ok(!/DELETE FROM/i.test(src), 'el script borra filas');
  });

  // ══ WhatsApp y prompt (R3) ═════════════════════════════════════════════
  await t('TXT', '«¿cuántos puntos tengo?» por WhatsApp: textos fijos según la inscripción', async () => {
    const previo = process.env.XABOR_URL_PUBLICA;
    process.env.XABOR_URL_PUBLICA = 'https://ejemplo.test';
    try {
      assert.strictEqual(await rw.ligaMiCuenta(NEG_T), `https://ejemplo.test/t/${SLUG_T}#mi-cuenta`);
      const ins = await rw.textoPuntosWhatsApp(NEG_A, T_INS);
      assert.match(ins, /\*50 puntos\*/);
      const auto = await rw.textoPuntosWhatsApp(NEG_A, T_AUTO);
      assert.match(auto, /120 puntos/); assert.match(auto, /todavía no estás inscrito/);
      const nadie = await rw.textoPuntosWhatsApp(NEG_T, tel(99));
      assert.match(nadie, /Todavía no estás inscrito/);
      assert.ok(nadie.includes(`/t/${SLUG_T}#mi-cuenta`), 'no manda la liga de Mi cuenta');
      await pool.query('UPDATE rewards_config SET activo = FALSE WHERE tenant_id = $1', [NEG_T]);
      assert.match(await rw.textoPuntosWhatsApp(NEG_T, tel(99)), /en pausa/);
      await pool.query('UPDATE rewards_config SET activo = TRUE WHERE tenant_id = $1', [NEG_T]);
      assert.match(await rw.textoPuntosWhatsApp('00000000-0000-0000-0000-000000000000', tel(99)), /no tenemos programa de puntos/);
      for (const x of [ins, auto, nadie]) assert.ok(!/autom[aá]tic/i.test(x), `promete puntos automáticos: ${x}`);
    } finally {
      if (previo === undefined) delete process.env.XABOR_URL_PUBLICA; else process.env.XABOR_URL_PUBLICA = previo;
    }
  });

  await t('TXT', 'whatsapp-meta usa el texto fijo y el prompt ya no promete puntos automáticos ni la Focaccia gratis', () => {
    const wa = leer('src', 'channels', 'whatsapp-meta.js');
    assert.match(wa, /textoPuntosWhatsApp\(negocioId, telefono\)/);
    assert.ok(!/Aún no tienes puntos Rewards acumulados/.test(wa), 'sigue el texto viejo que prometía puntos automáticos');
    const pr = leer('src', 'agent', 'prompts.js');
    const rw = pr.slice(pr.indexOf('## PROGRAMA DE LEALTAD'), pr.indexOf('Cómo canjear:', pr.indexOf('## PROGRAMA DE LEALTAD')) + 600);
    assert.ok(rw.length > 600, 'no se encontró la sección del programa en el prompt');
    assert.ok(!/1 punto autom[aá]ticamente/.test(pr), 'el prompt sigue diciendo que los puntos se ganan solos');
    assert.ok(!/Focaccia Bar gratis|rwPtsFocaccia/.test(pr), 'el prompt sigue ofreciendo la Focaccia como meta de Rewards');
    assert.ok(!/XABOR REWARDS/.test(pr), 'el prompt sigue llamando «Xabor Rewards» al programa de cualquier negocio');
    assert.match(rw, /Comprar sin estar inscrito NO da puntos/);
    assert.match(rw, /INSCRIBIRSE, gratis, con nombre y teléfono/);
  });

  // ══ 17. Panel y tienda ═════════════════════════════════════════════════
  await t('PAN', 'Rewards: sin los botones repetidos del encabezado; quedan las cuatro pestañas', () => {
    const html = leer('panel', 'index.html');
    const vista = html.slice(html.indexOf('<div id="vista-rewards"'), html.indexOf('<!-- /vista-rewards -->'));
    const cab = vista.slice(0, vista.indexOf('id="rw-subtabs"'));
    assert.ok(!/<button/.test(cab), 'el encabezado sigue teniendo botones');
    const pest = vista.slice(vista.indexOf('id="rw-subtabs"'), vista.indexOf('rw-vista-resumen'));
    assert.strictEqual((pest.match(/class="rw-stab/g) || []).length, 4);
    for (const p of ['Resumen', 'Clientes', 'Movimientos', 'Config']) assert.ok(pest.includes(`>${p}</button>`), p);
  });

  await t('PAN', 'tarjetas, insignia, búsqueda y vencimiento en el panel', () => {
    const html = leer('panel', 'index.html');
    for (const s of ['id="rw-sin-inscribir"', 'id="rw-nota-cifras"', 'Saldo de inscritos', 'Sin inscribir (automático)',
      "/api/rewards/clientes/buscar?todos=1&q=", 'id="rw-cfg-vencimiento"', 'vigencia_dias:', 'Mostrador y POS de envíos',
      'Inscritos en Rewards']) {
      assert.ok(html.includes(s), `falta «${s}»`);
    }
    const pos = html.slice(html.indexOf('function rwPosBuscar'), html.indexOf('function rwPosSelPrimero'));
    assert.ok(!pos.includes('todos=1'), 'la caja no debe ofrecer cuentas sin inscribir');
  });

  await t('PAN', 'tienda: inscripción explícita, liga #mi-cuenta y «te da N puntos» solo al inscrito', () => {
    const html = leer('panel', 'tienda.html');
    assert.ok(html.includes("API + '/cuenta/rewards/inscripcion'"));
    assert.ok(html.includes("location.hash !== '#mi-cuenta'"));
    assert.ok(html.includes('Inscríbete en Mi cuenta</button> y gana'));
    const i = html.indexOf('Esta compra te da');
    assert.ok(i > 0 && html.indexOf('Esta compra te da', i + 1) < 0, '«Esta compra te da» debe aparecer una sola vez');
    assert.ok(html.slice(i - 200, i).includes('w.inscrito === true'), 'la promesa de puntos no depende de la inscripción');
  });

  await t('MIG', 'la 149 está en el runner y es aditiva', () => {
    const runner = leer('scripts', 'predeploy-run-032-033.mjs');
    assert.ok(runner.indexOf("'149-rewards-inscripcion'") > runner.indexOf("'146-aviso-promociones'"));
    const sql = leer('migrations', '149_rewards_inscripcion.sql').replace(/--.*$/gm, '');
    assert.ok(!/\b(DROP|DELETE|TRUNCATE|UPDATE)\b/i.test(sql), 'la 149 no es aditiva');
  });

} catch (e) {
  console.error('ERROR FATAL EN LA SUITE:', e);
  fallidas++; fallos.push(`fatal: ${e.message}`);
} finally {
  if (servidor) servidor.detener();
  await limpiar().catch(() => {});
  await borrarNegocio(NEG_T); await borrarNegocio(NEG_S);
  await pool.end().catch(() => {});
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
