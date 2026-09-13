// ─── Rewards en la Tienda Online: suite end-to-end ────────────────────────
//
// EL FALLO QUE ESTA SUITE EXISTE PARA QUE NO VUELVA:
//
//   `rewardsService.acumularPuntos` decidía si una venta acumulaba mirando un
//   mapa de canales literal: { presencial, whatsapp, voz, rappi }. La tienda
//   en línea registra sus pedidos con canal 'tienda_online' (desde la 051), y
//   ese canal NO estaba en el mapa. `mapa['tienda_online']` es `undefined`,
//   `undefined` es falsy, y toda venta de la tienda salía por la rama "canal
//   no habilitado" — cero puntos, en silencio, para todos los negocios, con
//   un log que parecía una decisión de configuración y no un olvido.
//
//   Del lado del canje ni siquiera había olvido: la tienda pública no tenía
//   una sola línea de Rewards. Ni saldo, ni opción de usar puntos, ni nada.
//
// Las cuatro preguntas que esta suite responde:
//   1. ¿Con Rewards apagado, la tienda sigue vendiendo igual? (siempre)
//   2. ¿Una compra de la tienda acredita, y UNA sola vez? (sí, exactamente una)
//   3. ¿Puede el navegador decidir cuántos puntos vale su descuento? (jamás)
//   4. ¿Puede un cliente gastar en el negocio A los puntos del B? (jamás)
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { randomBytes } from 'crypto';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4219';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

const NEG_A = SEED.negocioA;   // Rewards ACTIVO con canal tienda encendido
const NEG_B = SEED.negocioB;   // Rewards ACTIVO pero canal tienda APAGADO
const cookie = (usuarioId, negocioId, rol) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;
const ADMIN_A = cookie(SEED.adminNegocioAUsuarioId, NEG_A, 'admin');

const SLUG_A = 'rw-tienda-a';
const SLUG_B = 'rw-tienda-b';

// Teléfonos del fixture. Sufijo por corrida: la base es compartida y dos
// ejecuciones no pueden pisarse los saldos.
//
// EXACTAMENTE 10 dígitos y solo dígitos, y no es un detalle cosmético:
// `construirOrdenPOS` normaliza con `normalizarTelefonoMX`, que se queda con
// los últimos 10 dígitos. Un fixture de 12 caracteres (o con una letra)
// entraba al pedido con un teléfono DISTINTO del que la prueba consultaba
// después, y la suite reportaba "no acumuló" cuando sí había acumulado — a
// otra cuenta.
const suf = Date.now().toString().slice(-6);
const tel = n => `88${suf}${String(n).padStart(2, '0')}`;
const TEL_RICO   = tel(1);   // saldo alto en A
const TEL_POBRE  = tel(2);   // saldo por debajo del mínimo de canje
const TEL_NUEVO  = tel(3);   // jamás ha comprado
const TEL_CRUZ   = tel(4);   // saldo en B, cero en A
const TEL_CONC   = tel(5);   // para la carrera
const TEL_ENVIO  = tel(6);
const TELS = [TEL_RICO, TEL_POBRE, TEL_NUEVO, TEL_CRUZ, TEL_CONC, TEL_ENVIO];

let base;
const url = r => `${base}${r}`;
const tokenCk = () => randomBytes(24).toString('hex');

async function get(ruta, cookieVal) {
  const r = await fetch(url(ruta), { headers: cookieVal ? { Cookie: cookieVal } : {} });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function post(ruta, cuerpo, cookieVal, metodo = 'POST') {
  const r = await fetch(url(ruta), {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(cookieVal ? { Cookie: cookieVal } : {}) },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// ── Fixtures ──────────────────────────────────────────────────────────────
const PROD = { A: {}, B: {} };

async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}

// Config de Rewards explícita y COMPLETA: la prueba no depende de lo que
// alguien haya dejado configurado antes en esta base.
async function fijarRewards(negocioId, { activo = true, canalTienda = true,
  montoPorPunto = 10, valorPunto = 0.5, canjeMinimo = 100 } = {}) {
  await pool.query(
    `INSERT INTO rewards_config (tenant_id, activo, monto_por_punto, puntos_por_peso, canje_minimo,
       canal_mostrador, canal_whatsapp, canal_telefono, canal_rappi, canal_tienda)
     VALUES ($1,$2,$3,$4,$5,TRUE,TRUE,TRUE,FALSE,$6)
     ON CONFLICT (tenant_id) DO UPDATE SET activo=$2, monto_por_punto=$3, puntos_por_peso=$4,
       canje_minimo=$5, canal_mostrador=TRUE, canal_whatsapp=TRUE, canal_telefono=TRUE,
       canal_rappi=FALSE, canal_tienda=$6`,
    [negocioId, activo, montoPorPunto, valorPunto, canjeMinimo, canalTienda]);
}

// Saldo inicial por la puerta legítima: un ajuste manual de admin, que es un
// movimiento auditable como cualquier otro. Nada de UPDATE directo al saldo.
async function sembrarSaldo(negocioId, telefono, puntos) {
  const { obtenerOCrearCuenta, ajustarPuntosManual } = await import('../src/services/rewardsService.js');
  await obtenerOCrearCuenta(telefono, 'Cliente Prueba RW', negocioId);
  if (puntos > 0) {
    await ajustarPuntosManual(telefono, puntos, 'ajuste_positivo', 'fixture de prueba', 'suite', negocioId);
  }
}

async function saldoDe(negocioId, telefono) {
  const { rows } = await pool.query(
    `SELECT puntos_balance FROM rewards_accounts WHERE tenant_id=$1 AND telefono=$2`,
    [negocioId, telefono]);
  return rows.length ? parseInt(rows[0].puntos_balance, 10) : null;
}

async function movimientos(negocioId, folio, tipo = null) {
  const { rows } = await pool.query(
    `SELECT tipo, puntos, balance_anterior, balance_posterior, usuario, motivo, metadata
       FROM rewards_movements WHERE tenant_id=$1 AND folio_venta=$2 ${tipo ? 'AND tipo=$3' : ''}
      ORDER BY id`, tipo ? [negocioId, folio, tipo] : [negocioId, folio]);
  return rows;
}

async function prepararNegocio(negocioId, etiqueta, slug, productos) {
  for (const m of ['tienda_online', 'pos', 'menu', 'rewards']) await fijarModulo(negocioId, m, 'activo');

  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,911) RETURNING id`,
    [negocioId, `RW ${etiqueta} (test)`]);
  for (const [nombre, precio] of productos) {
    const { rows: [p] } = await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
       VALUES ($1,$2,$3,$4,TRUE,1) RETURNING id`, [negocioId, cat.id, nombre, precio]);
    PROD[etiqueta][nombre] = p.id;
    await pool.query(
      `INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)
       ON CONFLICT (negocio_id, producto_id) DO UPDATE SET publicado = TRUE`, [negocioId, p.id]);
  }

  const reglas = {
    horarios: Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo']
      .map(d => [d, { abierto: true, apertura: '00:00', cierre: '23:59' }])),
    pedidos: {
      costo_envio: 40, pedido_minimo_entrega: 50, entrega_gratis_desde: 100000,
      zonas_entrega: [{ nombre: 'Centro', costo: 30 }],
      tiempo_preparacion_minutos: 20, tiempo_entrega_min_minutos: 30, tiempo_entrega_max_minutos: 45,
    },
  };
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'reglas_atencion',$2)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`,
    [negocioId, JSON.stringify(reglas)]);

  // Solo efectivo: el pedido nace en cocina y se puede llevar a 'entregado',
  // que es el evento que dispara la acumulación.
  await pool.query(`UPDATE metodos_pago SET habilitado = FALSE WHERE negocio_id = $1`, [negocioId]);
  await pool.query(
    `INSERT INTO metodos_pago (negocio_id, tipo, habilitado) VALUES ($1,'efectivo',TRUE)
     ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [negocioId]);
  // La allow-list de la tienda es PROPIA del canal (no la de metodos_pago) y
  // su omisión por defecto es ['enlace_pago']. Se fija explícitamente a
  // efectivo: así el pedido nace en cocina y puede llegar a 'entregado', que
  // es el evento que dispara la acumulación.
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'tienda_metodos_pago',$2)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`,
    [negocioId, JSON.stringify(['efectivo'])]);

  await pool.query(
    `INSERT INTO tienda_config (negocio_id, estado, slug_publico, titular, modalidades)
     VALUES ($1,'publicada',$2,$3,$4)
     ON CONFLICT (negocio_id) DO UPDATE SET estado='publicada', slug_publico=$2, titular=$3, modalidades=$4`,
    [negocioId, slug, `RW ${etiqueta}`, JSON.stringify(['recoger', 'domicilio'])]);
}

async function limpiarFixtures() {
  await pool.query(`DELETE FROM rewards_movements WHERE folio_venta LIKE 'RWT-%'`).catch(() => {});
  for (const neg of [NEG_A, NEG_B]) {
    const { rows } = await pool.query(
      `SELECT folio FROM pedidos_activos WHERE negocio_id=$1 AND datos->>'canal'='tienda_online'
         AND datos->'cliente'->>'telefono' = ANY($2)`, [neg, TELS]);
    for (const f of rows) {
      await pool.query(`DELETE FROM rewards_movements WHERE tenant_id=$1 AND folio_venta=$2`, [neg, f.folio]).catch(() => {});
    }
    await pool.query(`DELETE FROM pedidos WHERE negocio_id=$1 AND telefono = ANY($2)`, [neg, TELS]).catch(() => {});
    await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono' = ANY($2)`, [neg, TELS]).catch(() => {});
    await pool.query(`DELETE FROM tienda_pedidos WHERE negocio_id=$1`, [neg]).catch(() => {});
    await pool.query(`DELETE FROM rewards_movements WHERE tenant_id=$1 AND account_id IN
      (SELECT id FROM rewards_accounts WHERE tenant_id=$1 AND telefono = ANY($2))`, [neg, TELS]).catch(() => {});
    await pool.query(`DELETE FROM rewards_accounts WHERE tenant_id=$1 AND telefono = ANY($2)`, [neg, TELS]).catch(() => {});
    await pool.query(`DELETE FROM tienda_promocion_usos WHERE negocio_id=$1`, [neg]).catch(() => {});
    await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [neg]).catch(() => {});
    await pool.query(`DELETE FROM tienda_config WHERE negocio_id=$1`, [neg]).catch(() => {});
    await pool.query(`DELETE FROM menu_modificadores_opciones WHERE grupo_id IN
      (SELECT id FROM menu_modificadores_grupos WHERE negocio_id=$1 AND nombre='RW Tamaño')`, [neg]).catch(() => {});
    await pool.query(`DELETE FROM menu_modificadores_grupos WHERE negocio_id=$1 AND nombre='RW Tamaño'`, [neg]).catch(() => {});
    await pool.query(`DELETE FROM menu_productos WHERE categoria_id IN
      (SELECT id FROM menu_categorias WHERE negocio_id=$1 AND nombre LIKE 'RW %(test)')`, [neg]).catch(() => {});
    await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre LIKE 'RW %(test)'`, [neg]).catch(() => {});
  }
  await pool.query(`DELETE FROM clientes WHERE telefono = ANY($1)`, [TELS]).catch(() => {});
}

// Un checkout completo de la tienda, con los mismos cuerpos que manda el
// navegador real. Devuelve { status, body }.
const itemA = (cantidad = 1, prod = 'Pizza RW') => ({ productoId: PROD.A[prod], cantidad });

async function checkoutA({ telefono, nombre = 'Cliente RW', items = [itemA(1)],
  modalidad = 'recoger', zona = null, rewardsPuntos = 0, codigo = null, token = null, slug = SLUG_A }) {
  return post(`/api/tienda/${slug}/checkout`, {
    checkoutToken: token || tokenCk(), items, modalidad, zona, codigo,
    cliente: { nombre, telefono }, metodoPago: 'efectivo',
    direccion: modalidad === 'domicilio' ? 'Calle Falsa 123' : null,
    colonia: modalidad === 'domicilio' ? 'Centro' : null,
    rewardsPuntos,
  });
}

// La acumulación es fire-and-forget (nunca bloquea la entrega del pedido):
// se espera a que el movimiento aparezca en vez de asumir un timing.
async function esperarAcumulacion(negocioId, folio, ms = 6000) {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    const m = await movimientos(negocioId, folio, 'acumulacion');
    if (m.length) return m[0];
    await new Promise(r => setTimeout(r, 150));
  }
  return null;
}

async function entregar(folio) {
  return post(`/pedidos/${folio}/estado`, { estado: 'entregado' }, ADMIN_A, 'PATCH');
}

// ═══════════════════════════════════════════════════════════════════════════
let servidor;
try {
  await limpiarFixtures();
  await prepararNegocio(NEG_A, 'A', SLUG_A, [['Pizza RW', 200], ['Refresco RW', 30]]);
  await prepararNegocio(NEG_B, 'B', SLUG_B, [['Sushi RW', 150]]);
  await fijarRewards(NEG_A, { canalTienda: true });
  await fijarRewards(NEG_B, { canalTienda: false });  // negocio con el canal APAGADO

  servidor = await arrancarServidor(
    { PORT: PUERTO, XABOR_TIENDA_LIMITE_CHECKOUT: '500', XABOR_TIENDA_LIMITE_COTIZAR: '500',
      XABOR_TIENDA_LIMITE_LECTURA: '500' },
    { timeoutMs: 90000 });
  base = `http://localhost:${PUERTO}`;

  // ── R1: Rewards desactivado, la tienda funciona normalmente ──────────────
  await t('R1', 'con el canal apagado la tienda vende igual y no ofrece puntos', async () => {
    const { status, body } = await post(`/api/tienda/${SLUG_B}/cotizar`, {
      items: [{ productoId: PROD.B['Sushi RW'], cantidad: 2 }], modalidad: 'recoger', telefono: TEL_RICO });
    assert.strictEqual(status, 200, 'la cotización debe funcionar sin Rewards');
    assert.strictEqual(body.total, 300);
    assert.strictEqual(body.rewards, null, 'un negocio con el canal apagado no puede ofrecer puntos');
  });

  await t('R1', 'con el canal apagado el saldo público responde "inactivo", no un saldo', async () => {
    await sembrarSaldo(NEG_B, TEL_CRUZ, 500);
    const { status, body } = await get(`/api/tienda/${SLUG_B}/rewards?telefono=${TEL_CRUZ}&total=300`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.activo, false);
    assert.strictEqual(body.puntos, 0, 'se filtró el saldo de un canal apagado');
  });

  await t('R1', 'con el canal apagado un checkout que PIDE puntos no los gasta', async () => {
    const antes = await saldoDe(NEG_B, TEL_CRUZ);
    const { status, body } = await post(`/api/tienda/${SLUG_B}/checkout`, {
      checkoutToken: tokenCk(), items: [{ productoId: PROD.B['Sushi RW'], cantidad: 2 }],
      modalidad: 'recoger', cliente: { nombre: 'Cruz', telefono: TEL_CRUZ },
      metodoPago: 'efectivo', rewardsPuntos: 400 });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.total, 300, 'se aplicó un descuento con el canal apagado');
    assert.strictEqual(body.rewards, null);
    assert.strictEqual(await saldoDe(NEG_B, TEL_CRUZ), antes, 'se gastaron puntos con el canal apagado');
  });

  // ── R2: cliente identificado ve su saldo ────────────────────────────────
  await t('R2', 'un cliente con saldo lo ve en la tienda, con su tope para esta compra', async () => {
    await sembrarSaldo(NEG_A, TEL_RICO, 600);
    const { status, body } = await get(`/api/tienda/${SLUG_A}/rewards?telefono=${TEL_RICO}&total=200`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.activo, true);
    assert.strictEqual(body.puntos, 600);
    assert.strictEqual(body.canjeMinimo, 100);
    // $200 de venta / ($0.5 × 100 pts = $50 por bloque) = 4 bloques = 400 pts.
    assert.strictEqual(body.puntosAplicables, 400, 'el tope debe ser el total de la venta, no el saldo');
    assert.strictEqual(body.descuento, 200);
  });

  await t('R2', 'la respuesta pública no filtra NADA personal', async () => {
    const { body } = await get(`/api/tienda/${SLUG_A}/rewards?telefono=${TEL_RICO}&total=200`);
    const txt = JSON.stringify(body).toLowerCase();
    for (const fuga of ['nombre_cliente', 'ultima', 'cliente_prueba', 'account_id', 'telefono', 'negocio']) {
      assert.ok(!txt.includes(fuga), `la respuesta pública incluye "${fuga}"`);
    }
  });

  // ── R15/R17: cliente nuevo e invitado ───────────────────────────────────
  await t('R15', 'un cliente nuevo ve el programa pero con saldo cero', async () => {
    const { body } = await get(`/api/tienda/${SLUG_A}/rewards?telefono=${TEL_NUEVO}&total=200`);
    assert.strictEqual(body.activo, true);
    assert.strictEqual(body.puntos, 0);
    assert.strictEqual(body.puntosAplicables, 0);
    assert.ok(body.puntosQueGanaria > 0, 'debe poder decirle cuánto ganaría');
  });

  await t('R17', 'sin teléfono la respuesta es la misma forma con ceros (no revela nada)', async () => {
    const sinTel = await get(`/api/tienda/${SLUG_A}/rewards?total=200`);
    const inexistente = await get(`/api/tienda/${SLUG_A}/rewards?telefono=${TEL_NUEVO}&total=200`);
    assert.strictEqual(sinTel.body.puntos, 0);
    assert.deepStrictEqual(
      { ...sinTel.body, puntosQueGanaria: 0 }, { ...inexistente.body, puntosQueGanaria: 0 },
      'un teléfono sin cuenta debe ser indistinguible de no mandar teléfono');
  });

  // ── R3: la compra acredita, exactamente una vez ─────────────────────────
  let folioAcum = null;
  await t('R3', 'una compra de la tienda SÍ acredita puntos (el fallo original)', async () => {
    const { status, body } = await checkoutA({ telefono: TEL_NUEVO, items: [itemA(1)] });
    assert.strictEqual(status, 200, JSON.stringify(body));
    folioAcum = body.folio;
    assert.strictEqual(body.total, 200);

    await entregar(folioAcum);
    const mov = await esperarAcumulacion(NEG_A, folioAcum);
    assert.ok(mov, 'la venta de la tienda no acreditó NADA: el canal sigue sin estar en el mapa');
    // $200 elegibles / $10 por punto = 20 puntos.
    assert.strictEqual(mov.puntos, 20, `se esperaban 20 pts y llegaron ${mov.puntos}`);
    assert.strictEqual(await saldoDe(NEG_A, TEL_NUEVO), 20);
  });

  await t('R19', 'la acumulación deja un movimiento auditable completo', async () => {
    const [mov] = await movimientos(NEG_A, folioAcum, 'acumulacion');
    assert.strictEqual(mov.balance_anterior, 0);
    assert.strictEqual(mov.balance_posterior, 20);
    assert.strictEqual(mov.usuario, 'sistema');
    assert.ok(mov.motivo, 'el movimiento debe explicar por qué existe');
    const meta = typeof mov.metadata === 'string' ? JSON.parse(mov.metadata) : mov.metadata;
    assert.strictEqual(meta.canal, 'tienda_online', 'el movimiento debe decir de qué canal vino');
  });

  await t('R4', 'reintentar la acreditación del mismo folio no duplica puntos', async () => {
    const { acumularPuntos } = await import('../src/services/rewardsService.js');
    const pedido = await pool.query(`SELECT datos FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`,
      [folioAcum, NEG_A]);
    const datos = pedido.rows[0]?.datos
      || { total: 200, canal: 'tienda_online', cliente: { telefono: TEL_NUEVO } };
    const antes = await saldoDe(NEG_A, TEL_NUEVO);
    // Tres reintentos: el webhook repetido, el reconciliador y un clic humano.
    for (let i = 0; i < 3; i++) await acumularPuntos(folioAcum, datos, NEG_A);
    assert.strictEqual(await saldoDe(NEG_A, TEL_NUEVO), antes, 'el saldo se movió dos veces por una compra');
    const movs = await movimientos(NEG_A, folioAcum, 'acumulacion');
    assert.strictEqual(movs.length, 1, `quedaron ${movs.length} acumulaciones para la misma venta`);
  });

  await t('R4', 'tres acreditaciones SIMULTÁNEAS del mismo folio dejan una sola', async () => {
    const { acumularPuntos } = await import('../src/services/rewardsService.js');
    const folio = `RWT-${suf}-conc`;
    const venta = { total: 500, canal: 'tienda_online', cliente: { telefono: TEL_CONC, nombre: 'Conc' } };
    await Promise.allSettled([
      acumularPuntos(folio, venta, NEG_A), acumularPuntos(folio, venta, NEG_A),
      acumularPuntos(folio, venta, NEG_A),
    ]);
    const movs = await movimientos(NEG_A, folio, 'acumulacion');
    assert.strictEqual(movs.length, 1, `se acreditó ${movs.length} veces en paralelo`);
    assert.strictEqual(await saldoDe(NEG_A, TEL_CONC), 50);
  });

  // ── R5: sin dinero confirmado no hay puntos ─────────────────────────────
  await t('R5', 'un pedido que solo se creó (sin entregar) no acredita nada', async () => {
    const { body } = await checkoutA({ telefono: TEL_POBRE, items: [itemA(2)] });
    assert.ok(body.folio);
    await new Promise(r => setTimeout(r, 500));
    assert.strictEqual((await movimientos(NEG_A, body.folio, 'acumulacion')).length, 0,
      'se acreditaron puntos con el pedido todavía en cocina');
    assert.strictEqual(await saldoDe(NEG_A, TEL_POBRE), null,
      'ni siquiera debe existir cuenta: nadie ha comprado todavía');
  });

  await t('R5', 'un pedido de pago en línea NO PAGADO no puede llegar a entregado', async () => {
    // Se habilita enlace_pago SOLO para esta prueba (y se restaura en el
    // finally): el pedido nace pendiente_pago y el invariante de la tienda
    // debe impedir que avance a cocina -- y por tanto que acredite puntos.
    await pool.query(
      `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'tienda_metodos_pago',$2)
       ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`,
      [NEG_A, JSON.stringify(['enlace_pago'])]);
    const { guardarIntegracionPago, marcarProveedorPrincipal } = await import('../src/services/integracionesService.js');
    await guardarIntegracionPago(NEG_A, 'clip', { apiKey: 'test-api-key-no-real', apiSecret: 'test-secret-no-real' },
      { actualizadoPor: SEED.superadminUsuarioId });
    await marcarProveedorPrincipal(NEG_A, 'clip', SEED.superadminUsuarioId);
    try {
      const { body } = await post(`/api/tienda/${SLUG_A}/checkout`, {
        checkoutToken: tokenCk(), items: [itemA(1)], modalidad: 'recoger',
        cliente: { nombre: 'Sin pagar', telefono: TEL_NUEVO }, metodoPago: 'enlace_pago' });
      assert.ok(body.folio, JSON.stringify(body));
      const { rows } = await pool.query(`SELECT estado FROM pedidos_activos WHERE folio=$1`, [body.folio]);
      assert.strictEqual(rows[0].estado, 'pendiente_pago');
      const r = await entregar(body.folio);
      assert.ok(r.status >= 400, 'un pedido sin pagar se pudo marcar entregado');
      assert.strictEqual((await movimientos(NEG_A, body.folio, 'acumulacion')).length, 0,
        'un pago no confirmado generó puntos');
    } finally {
      await pool.query(
        `UPDATE configuracion SET valor = $2 WHERE negocio_id = $1 AND clave = 'tienda_metodos_pago'`,
        [NEG_A, JSON.stringify(['efectivo'])]);
    }
  });

  // ── R7: canje en la tienda ──────────────────────────────────────────────
  let folioCanje = null;
  await t('R7', 'un cliente con saldo canjea en el checkout y el total baja', async () => {
    const saldoAntes = await saldoDe(NEG_A, TEL_RICO);   // 600
    const { status, body } = await checkoutA({ telefono: TEL_RICO, items: [itemA(1)], rewardsPuntos: 200 });
    assert.strictEqual(status, 200, JSON.stringify(body));
    folioCanje = body.folio;
    // 200 pts × $0.5 = $100 de descuento sobre $200.
    assert.deepStrictEqual(body.rewards, { puntos: 200, monto: 100 });
    assert.strictEqual(body.total, 100, 'el total no refleja el canje');
    assert.strictEqual(await saldoDe(NEG_A, TEL_RICO), saldoAntes - 200);
  });

  await t('R7', 'el pedido durable guarda el total YA rebajado (no solo la respuesta)', async () => {
    const { rows } = await pool.query(`SELECT datos FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`,
      [folioCanje, NEG_A]);
    assert.strictEqual(Number(rows[0].datos.total), 100, 'la fila del pedido conserva el precio sin descuento');
    assert.deepStrictEqual(rows[0].datos.rewards_canje, { puntos: 200, monto: 100 });
  });

  await t('R19', 'el canje deja su propio movimiento auditable', async () => {
    const [mov] = await movimientos(NEG_A, folioCanje, 'canje');
    assert.ok(mov, 'no quedó movimiento de canje');
    assert.strictEqual(mov.puntos, -200, 'un canje debe ser negativo en el ledger');
    assert.strictEqual(mov.balance_anterior - mov.balance_posterior, 200);
    assert.strictEqual(mov.usuario, 'tienda', 'el movimiento debe decir que vino de la tienda');
  });

  await t('R3', 'una venta con canje acredita sobre el dinero, no sobre los puntos', async () => {
    // $200 de pedido, $100 pagados con 200 pts → quedan $100 de dinero real.
    // Eso son 10 pts ($10 por punto). Ni 20 (sería dar puntos sobre puntos)
    // ni 0 (sería descontar el canje dos veces: el total durable YA es 100).
    await entregar(folioCanje);
    const mov = await esperarAcumulacion(NEG_A, folioCanje);
    assert.ok(mov, 'la venta con canje no acreditó nada sobre la parte en efectivo');
    assert.strictEqual(mov.puntos, 10,
      `se esperaban 10 pts (sobre los $100 en efectivo) y llegaron ${mov.puntos}`);
  });

  // ── R8: no puede canjear más que su saldo ───────────────────────────────
  await t('R8', 'pedir más puntos de los que tiene recorta al máximo legítimo', async () => {
    const saldo = await saldoDe(NEG_A, TEL_RICO);
    // Pedido de $1000: por total caben 20 bloques, así que el límite que
    // manda aquí es el saldo — redondeado hacia abajo al bloque de 100.
    const esperado = Math.floor(saldo / 100) * 100;
    const { body } = await checkoutA({ telefono: TEL_RICO, items: [itemA(5)], rewardsPuntos: 999999 });
    assert.ok(body.rewards, 'debió aplicar al menos algo');
    assert.ok(body.rewards.puntos <= saldo, `canjeó ${body.rewards.puntos} con saldo ${saldo}`);
    assert.strictEqual(body.rewards.puntos, esperado,
      `con saldo ${saldo} y bloques de 100 debía usar ${esperado}`);
    assert.strictEqual(await saldoDe(NEG_A, TEL_RICO), saldo - esperado);
    assert.ok(await saldoDe(NEG_A, TEL_RICO) >= 0, 'el saldo quedó negativo');
  });

  await t('R8', 'el descuento nunca puede superar el total del pedido', async () => {
    await sembrarSaldo(NEG_A, TEL_ENVIO, 2000);
    // Pedido de $30 con 2000 pts ($1000 de poder de compra): solo puede
    // aplicarse lo que cabe en la venta.
    const { body } = await checkoutA({ telefono: TEL_ENVIO, items: [itemA(1, 'Refresco RW')], rewardsPuntos: 2000 });
    assert.ok(body.total >= 0, 'el total salió negativo');
    assert.ok((body.rewards?.monto || 0) <= 30, `descontó ${body.rewards?.monto} de un pedido de $30`);
  });

  await t('R8', 'con saldo por debajo del mínimo no se puede canjear nada', async () => {
    await sembrarSaldo(NEG_A, TEL_POBRE, 60);   // mínimo es 100
    const { body } = await checkoutA({ telefono: TEL_POBRE, items: [itemA(1)], rewardsPuntos: 60 });
    assert.strictEqual(body.rewards, null, 'canjeó por debajo del mínimo configurado');
    assert.strictEqual(body.total, 200);
    assert.strictEqual(await saldoDe(NEG_A, TEL_POBRE), 60);
  });

  // ── R9/R10: aislamiento de cliente y de negocio ─────────────────────────
  await t('R9', 'no se puede gastar el saldo de OTRO cliente', async () => {
    await sembrarSaldo(NEG_A, TEL_CONC, 0);
    const saldoAjeno = await saldoDe(NEG_A, TEL_ENVIO);
    // El checkout va a nombre de TEL_CONC (sin saldo utilizable tras la R4).
    const mio = await saldoDe(NEG_A, TEL_CONC);
    const { body } = await checkoutA({ telefono: TEL_CONC, items: [itemA(1)], rewardsPuntos: 400 });
    assert.ok((body.rewards?.puntos || 0) <= mio, 'gastó más de lo que ese teléfono tenía');
    assert.strictEqual(await saldoDe(NEG_A, TEL_ENVIO), saldoAjeno, 'se tocó el saldo de otro cliente');
  });

  await t('R10', 'el saldo del negocio B NO se puede gastar en la tienda del A', async () => {
    const enB = await saldoDe(NEG_B, TEL_CRUZ);
    assert.ok(enB >= 500, 'el fixture debe tener saldo en B');
    assert.strictEqual(await saldoDe(NEG_A, TEL_CRUZ), null, 'ese teléfono no debe tener cuenta en A');

    const { body } = await checkoutA({ telefono: TEL_CRUZ, items: [itemA(1)], rewardsPuntos: 400 });
    assert.strictEqual(body.rewards, null, 'se canjeó en A un saldo que vive en B');
    assert.strictEqual(body.total, 200);
    assert.strictEqual(await saldoDe(NEG_B, TEL_CRUZ), enB, 'se movió el saldo del otro negocio');
  });

  await t('R10', 'el saldo público de A no revela el saldo que ese teléfono tiene en B', async () => {
    const { body } = await get(`/api/tienda/${SLUG_A}/rewards?telefono=${TEL_CRUZ}&total=200`);
    assert.strictEqual(body.puntos, 0, 'la tienda de A mostró puntos de otro negocio');
  });

  await t('R10', 'comprar en A no mezcla el saldo que el mismo teléfono tiene en B', async () => {
    const enB = await saldoDe(NEG_B, TEL_CRUZ);
    const { body } = await checkoutA({ telefono: TEL_CRUZ, items: [itemA(1)] });
    await entregar(body.folio);
    await esperarAcumulacion(NEG_A, body.folio);
    assert.strictEqual(await saldoDe(NEG_A, TEL_CRUZ), 20, 'la cuenta de A debe nacer con sus propios puntos');
    assert.strictEqual(await saldoDe(NEG_B, TEL_CRUZ), enB, 'la compra en A alteró el saldo en B');
  });

  // ── R11: concurrencia ───────────────────────────────────────────────────
  await t('R11', 'dos checkouts simultáneos no gastan el saldo dos veces', async () => {
    const TEL = tel(9);
    TELS.push(TEL);
    await sembrarSaldo(NEG_A, TEL, 100);
    const [a, b] = await Promise.all([
      checkoutA({ telefono: TEL, items: [itemA(1)], rewardsPuntos: 100 }),
      checkoutA({ telefono: TEL, items: [itemA(1)], rewardsPuntos: 100 }),
    ]);
    const conCanje = [a, b].filter(r => r.body?.rewards?.puntos > 0);
    assert.strictEqual(conCanje.length, 1,
      `${conCanje.length} de 2 checkouts simultáneos aplicaron el mismo saldo`);
    assert.strictEqual(await saldoDe(NEG_A, TEL), 0, 'el saldo quedó mal tras la carrera');

    // El que perdió la carrera paga precio completo: nunca un descuento sin
    // movimiento que lo respalde.
    const perdedor = [a, b].find(r => !r.body?.rewards);
    assert.strictEqual(perdedor.body.total, 200, 'quedó un pedido rebajado sin puntos gastados');
    assert.strictEqual(perdedor.body.rewardsNoAplicado, true, 'no se avisó que el canje no se aplicó');

    // Y la suma de canjes del ledger nunca excede lo que el cliente tenía.
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(ABS(m.puntos)),0)::int AS gastado FROM rewards_movements m
        JOIN rewards_accounts a ON a.id = m.account_id
       WHERE m.tenant_id=$1 AND a.telefono=$2 AND m.tipo='canje'`, [NEG_A, TEL]);
    assert.strictEqual(rows[0].gastado, 100, `se gastaron ${rows[0].gastado} puntos de un saldo de 100`);
  });

  // ── R12/R13/R14: convivencia con promociones, envío y modificadores ─────
  await t('R12', 'promoción + Rewards: el canje se aplica DESPUÉS del descuento', async () => {
    const TEL = tel(10);
    TELS.push(TEL);
    await sembrarSaldo(NEG_A, TEL, 200);
    await pool.query(
      `INSERT INTO tienda_promociones (negocio_id, nombre, tipo, valor, codigo, activa, canales)
       VALUES ($1,'RW 10 off','porcentaje',10,'RW10',TRUE,$2)`,
      [NEG_A, JSON.stringify(['tienda_online'])]).catch(async () => {
        await pool.query(`INSERT INTO tienda_promociones (negocio_id, nombre, tipo, valor, codigo, activa)
          VALUES ($1,'RW 10 off','porcentaje',10,'RW10',TRUE)`, [NEG_A]);
      });
    const { body } = await checkoutA({ telefono: TEL, items: [itemA(1)], codigo: 'RW10', rewardsPuntos: 200 });
    // $200 − 10% = $180 ; 200 pts = $100 → $80.
    assert.strictEqual(body.rewards.monto, 100);
    assert.strictEqual(body.total, 80, `total ${body.total}: el orden promo→rewards no se respetó`);
  });

  await t('R13', 'Rewards + envío: el canje se calcula sobre el total CON envío', async () => {
    const TEL = tel(11);
    TELS.push(TEL);
    await sembrarSaldo(NEG_A, TEL, 200);
    const { body } = await checkoutA({ telefono: TEL, items: [itemA(1)], modalidad: 'domicilio',
      zona: 'Centro', rewardsPuntos: 200 });
    // $200 + $30 envío = $230 − $100 = $130.
    assert.strictEqual(body.total, 130, `total ${body.total}`);
    assert.strictEqual(body.rewards.monto, 100);
  });

  await t('R14', 'Rewards + modificadores: el precio extra cuenta para el total', async () => {
    const { rows: [g] } = await pool.query(
      `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
       VALUES ($1,$2,'RW Tamaño',FALSE,0,1,1) RETURNING id`, [NEG_A, PROD.A['Pizza RW']]);
    const { rows: [o] } = await pool.query(
      `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
       VALUES ($1,$2,'Grande',100,TRUE,1) RETURNING id`, [NEG_A, g.id]);
    const TEL = tel(12);
    TELS.push(TEL);
    await sembrarSaldo(NEG_A, TEL, 200);
    const { body } = await checkoutA({ telefono: TEL, rewardsPuntos: 200,
      items: [{ productoId: PROD.A['Pizza RW'], cantidad: 1, modificadores: [{ grupoId: g.id, opcionId: o.id }] }] });
    // $200 + $100 extra = $300 − $100 = $200.
    assert.strictEqual(body.total, 200, `total ${body.total}`);
  });

  // ── R16: cliente recurrente ─────────────────────────────────────────────
  await t('R16', 'un cliente recurrente suma sobre su saldo anterior', async () => {
    const antes = await saldoDe(NEG_A, TEL_NUEVO);
    const { body } = await checkoutA({ telefono: TEL_NUEVO, items: [itemA(2)] });
    await entregar(body.folio);
    const mov = await esperarAcumulacion(NEG_A, body.folio);
    assert.ok(mov, 'la segunda compra no acreditó');
    assert.strictEqual(mov.balance_anterior, antes, 'la acumulación no partió del saldo previo');
    assert.strictEqual(await saldoDe(NEG_A, TEL_NUEVO), antes + 40);
  });

  // ── R6: pedido cancelado ────────────────────────────────────────────────
  await t('R6', 'cancelar un pedido con canje devuelve los puntos', async () => {
    const TEL = tel(13);
    TELS.push(TEL);
    await sembrarSaldo(NEG_A, TEL, 200);
    const { body } = await checkoutA({ telefono: TEL, items: [itemA(1)], rewardsPuntos: 200 });
    assert.strictEqual(await saldoDe(NEG_A, TEL), 0);
    const r = await post(`/api/admin/pedido/${body.folio}/cancelar`, { motivo: 'prueba' }, ADMIN_A);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const hasta = Date.now() + 5000;
    while (Date.now() < hasta && (await saldoDe(NEG_A, TEL)) !== 200) await new Promise(x => setTimeout(x, 150));
    assert.strictEqual(await saldoDe(NEG_A, TEL), 200, 'cancelar no devolvió los puntos canjeados');
    const rev = await movimientos(NEG_A, body.folio, 'reverso');
    assert.strictEqual(rev.length, 1, 'el reverso debe quedar asentado, no ser un ajuste silencioso');
  });

  await t('R6', 'cancelar dos veces no devuelve los puntos dos veces', async () => {
    const TEL = tel(14);
    TELS.push(TEL);
    await sembrarSaldo(NEG_A, TEL, 200);
    const { body } = await checkoutA({ telefono: TEL, items: [itemA(1)], rewardsPuntos: 200 });
    const { revertirMovimientosFolio } = await import('../src/services/rewardsService.js');
    await revertirMovimientosFolio(body.folio, NEG_A);
    await revertirMovimientosFolio(body.folio, NEG_A);
    await revertirMovimientosFolio(body.folio, NEG_A);
    assert.strictEqual(await saldoDe(NEG_A, TEL), 200, 'el reverso se aplicó más de una vez');
  });

  await t('R6', 'un checkout abandonado (pedido cancelado por el expirador) devuelve los puntos', async () => {
    // El caso que el botón de cancelar NO cubre: un pago en línea que nadie
    // paga lo cancela el job de expiración, dentro de una transacción de
    // dinero donde Rewards no tiene nada que hacer. El barrido es quien
    // devuelve los puntos.
    const TEL = tel(17);
    TELS.push(TEL);
    await sembrarSaldo(NEG_A, TEL, 200);
    const { body } = await checkoutA({ telefono: TEL, items: [itemA(1)], rewardsPuntos: 200 });
    assert.strictEqual(await saldoDe(NEG_A, TEL), 0, 'el canje no se registró');

    // Se simula EXACTAMENTE lo que deja el expirador: pedido cancelado, sin
    // pasar por el endpoint de cancelación (que ya revierte por su cuenta).
    await pool.query(
      `UPDATE pedidos_activos SET estado='cancelado',
              datos = datos || '{"expirado_por_pago":true}'::jsonb, updated_at = NOW()
        WHERE folio=$1 AND negocio_id=$2`, [body.folio, NEG_A]);
    assert.strictEqual(await saldoDe(NEG_A, TEL), 0, 'el fixture debe arrancar con los puntos aún gastados');

    const { reconciliarCanjesDePedidosCancelados } = await import('../src/services/tiendaRewards.js');
    const devueltos = await reconciliarCanjesDePedidosCancelados();
    assert.ok(devueltos >= 1, 'el barrido no encontró el pedido cancelado');
    assert.strictEqual(await saldoDe(NEG_A, TEL), 200, 'el checkout abandonado se comió los puntos');

    // Y correrlo otra vez no los devuelve dos veces.
    await reconciliarCanjesDePedidosCancelados();
    await reconciliarCanjesDePedidosCancelados();
    assert.strictEqual(await saldoDe(NEG_A, TEL), 200, 'el barrido devolvió los puntos más de una vez');
  });

  // ── R18: lo que se muestra es lo que el backend tiene ───────────────────
  await t('R18', 'el saldo que muestra la tienda coincide con el del backend', async () => {
    const { body } = await get(`/api/tienda/${SLUG_A}/rewards?telefono=${TEL_NUEVO}&total=100`);
    assert.strictEqual(body.puntos, await saldoDe(NEG_A, TEL_NUEVO));
  });

  await t('R18', 'reintentar el MISMO checkout devuelve el mismo canje, sin gastar de nuevo', async () => {
    const TEL = tel(15);
    TELS.push(TEL);
    await sembrarSaldo(NEG_A, TEL, 200);
    const tk = tokenCk();
    const a = await checkoutA({ telefono: TEL, items: [itemA(1)], rewardsPuntos: 200, token: tk });
    const b = await checkoutA({ telefono: TEL, items: [itemA(1)], rewardsPuntos: 200, token: tk });
    assert.strictEqual(b.body.folio, a.body.folio, 'el reintento creó otro pedido');
    assert.strictEqual(b.body.total, a.body.total, 'el reintento devolvió otro total');
    assert.deepStrictEqual(b.body.rewards, a.body.rewards, 'el reintento devolvió otro canje');
    assert.strictEqual(await saldoDe(NEG_A, TEL), 0, 'el reintento gastó puntos otra vez');
    assert.strictEqual((await movimientos(NEG_A, a.body.folio, 'canje')).length, 1);
  });

  // ── R20: sin regresiones en los otros canales ───────────────────────────
  await t('R20', 'el canal presencial sigue acumulando como antes', async () => {
    const { acumularPuntos } = await import('../src/services/rewardsService.js');
    const TEL = tel(16);
    TELS.push(TEL);
    const r = await acumularPuntos(`RWT-${suf}-pos`, { total: 500, canal: 'presencial',
      cliente: { telefono: TEL, nombre: 'POS' } }, NEG_A);
    assert.ok(r && r.puntos === 50, `el POS dejó de acumular: ${JSON.stringify(r)}`);
  });

  await t('R20', 'un canal apagado sigue sin acumular (rappi)', async () => {
    const { acumularPuntos } = await import('../src/services/rewardsService.js');
    const r = await acumularPuntos(`RWT-${suf}-rappi`, { total: 500, canal: 'rappi',
      cliente: { telefono: TEL_RICO, nombre: 'Rappi' } }, NEG_A);
    assert.strictEqual(r, null, 'un canal apagado acumuló');
  });

  await t('R20', 'un canal desconocido NO acumula (fallo cerrado)', async () => {
    const { acumularPuntos } = await import('../src/services/rewardsService.js');
    const r = await acumularPuntos(`RWT-${suf}-raro`, { total: 500, canal: 'canal_inventado',
      cliente: { telefono: TEL_RICO, nombre: 'X' } }, NEG_A);
    assert.strictEqual(r, null, 'un canal que nadie configuró acumuló puntos');
  });

  await t('R20', 'sin el módulo contratado la tienda no ofrece ni acumula', async () => {
    await fijarModulo(NEG_A, 'rewards', 'no_contratado');
    try {
      const s = await get(`/api/tienda/${SLUG_A}/rewards?telefono=${TEL_NUEVO}&total=200`);
      assert.strictEqual(s.body.activo, false, 'ofreció Rewards sin el módulo contratado');
      const { acumularPuntos } = await import('../src/services/rewardsService.js');
      const r = await acumularPuntos(`RWT-${suf}-nomod`, { total: 500, canal: 'tienda_online',
        cliente: { telefono: TEL_NUEVO, nombre: 'X' } }, NEG_A);
      assert.strictEqual(r, null, 'acumuló sin el módulo contratado');
    } finally { await fijarModulo(NEG_A, 'rewards', 'activo'); }
  });

  await t('R20', 'con el programa desactivado (activo=false) no hay canje ni acumulación', async () => {
    await fijarRewards(NEG_A, { activo: false, canalTienda: true });
    try {
      const s = await get(`/api/tienda/${SLUG_A}/rewards?telefono=${TEL_NUEVO}&total=200`);
      assert.strictEqual(s.body.activo, false);
      const { body } = await checkoutA({ telefono: TEL_NUEVO, items: [itemA(1)], rewardsPuntos: 100 });
      assert.strictEqual(body.rewards, null);
      assert.strictEqual(body.total, 200);
    } finally { await fijarRewards(NEG_A, { activo: true, canalTienda: true }); }
  });

} catch (e) {
  console.error('ERROR FATAL EN LA SUITE:', e);
  fallidas++; fallos.push(`fatal: ${e.message}`);
} finally {
  if (servidor) servidor.detener();
  await limpiarFixtures().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
