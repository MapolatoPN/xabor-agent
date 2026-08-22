// XAB-0175 — FALTANTE != INVÁLIDA en la forma de pago del bot.
//
// El caso real: el cliente llegó a resumen/confirmación SIN elegir forma de
// pago; el backend bloqueó bien la orden pero la trató como "forma de pago
// inválida" -> mensaje falso ("esa forma de pago no está disponible") y un
// regreso torpe al menú que tiraba el pedido armado.
//
// Esta suite fija: FORMA_PAGO_FALTANTE separado de FORMA_PAGO_INVALIDA,
// recuperación determinística (el pedido se conserva; se pregunta cómo
// pagar con los métodos REALES del negocio), cero registro sin forma de
// pago, cero default a efectivo, aislamiento multi-tenant y el dedupe de
// canal que garantiza una sola orden ante retries.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const FUENTE_WA = readFileSync(join(__dirname, '..', 'src', 'channels', 'whatsapp-meta.js'), 'utf8');
const FUENTE_PROMPTS = readFileSync(join(__dirname, '..', 'src', 'agent', 'prompts.js'), 'utf8');

const { pool, existeMensajeConIdExterno } = await import('../src/services/database.js');
const { validarOrdenPropuesta, mensajeRechazoParaCliente, RECHAZOS } = await import('../src/orders/validadorOrden.js');
const { registrarPedido } = await import('../src/orders/orderManager.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const suf = Date.now().toString().slice(-6);
const TEL = `8997400${suf.slice(-3)}`;

// ── Snapshot/restauración de metodos_pago y modo_pedidos (higiene) ──────────
let snapshotMetodos = [];
let snapshotModo = [];
async function snapshot() {
  snapshotMetodos = (await pool.query(
    `SELECT * FROM metodos_pago WHERE negocio_id = ANY($1)`, [[NEG_A, NEG_B]])).rows;
  snapshotModo = (await pool.query(
    `SELECT negocio_id, valor FROM configuracion WHERE clave = 'modo_pedidos' AND negocio_id = ANY($1)`,
    [[NEG_A, NEG_B]])).rows;
}
async function restaurar() {
  await pool.query(`DELETE FROM metodos_pago WHERE negocio_id = ANY($1)`, [[NEG_A, NEG_B]]);
  for (const m of snapshotMetodos) {
    await pool.query(
      `INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden, disponible_para_bot, disponible_para_operador, instrucciones, integracion_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (negocio_id, tipo) DO UPDATE SET
         habilitado = $3, orden = $4, disponible_para_bot = $5, disponible_para_operador = $6, instrucciones = $7, integracion_id = $8`,
      [m.negocio_id, m.tipo, m.habilitado, m.orden, m.disponible_para_bot, m.disponible_para_operador, m.instrucciones, m.integracion_id]);
  }
  await pool.query(`DELETE FROM configuracion WHERE clave = 'modo_pedidos' AND negocio_id = ANY($1)`, [[NEG_A, NEG_B]]);
  for (const c of snapshotModo) {
    await pool.query(
      `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'modo_pedidos',$2)`,
      [c.negocio_id, c.valor]);
  }
}
async function metodos(negocioId, tipos) {
  await pool.query(`DELETE FROM metodos_pago WHERE negocio_id = $1`, [negocioId]);
  let orden = 1;
  for (const tipo of tipos) {
    await pool.query(
      `INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden, disponible_para_bot)
       VALUES ($1,$2,TRUE,$3,TRUE)`, [negocioId, tipo, orden++]);
  }
}

const ordenBase = (extras = {}) => ({
  cliente: { nombre: 'Cliente FP', telefono: TEL, calle: null, colonia: null, entre_calles: null },
  modalidad: 'recoger en tienda',
  items: [{ nombre: `FP Focaccia Prueba ${suf}`, cantidad: 1, precio_unitario: 100 }],
  subtotal: 100, costo_envio: 0, descuento: 0, total: 100,
  canal: 'test', programado_para: null,
  negocioId: NEG_A,
  ...extras,
});
async function pedidosDeTel(negocioId) {
  const { rows } = await pool.query(
    `SELECT folio FROM pedidos_activos WHERE negocio_id = $1 AND datos->'cliente'->>'telefono' = $2`,
    [negocioId, TEL]);
  return rows;
}

async function limpiarFixture() {
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = ANY($1) AND datos->'cliente'->>'telefono' = $2`, [[NEG_A, NEG_B], TEL]);
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id = ANY($1) AND nombre LIKE 'FP %'`, [[NEG_A, NEG_B]]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = ANY($1) AND nombre LIKE 'FP %'`, [[NEG_A, NEG_B]]);
  await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id = ANY($1) AND canal = 'pagos' AND identificador LIKE 'FPTEST%'`, [[NEG_A, NEG_B]]);
  await pool.query(`DELETE FROM mensajes WHERE message_id_externo LIKE 'wamid.fp-%'`);
}

try {
  await snapshot();
  await limpiarFixture();
  for (const [neg, nombre, precio] of [[NEG_A, `FP Focaccia Prueba ${suf}`, 100], [NEG_B, `FP Torta Prueba ${suf}`, 80]]) {
    const { rows: [cat] } = await pool.query(
      `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'FP Cat (test)',TRUE,990) RETURNING id`, [neg]);
    await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
       VALUES ($1,$2,$3,$4,TRUE,FALSE,1)`, [neg, cat.id, nombre, precio]);
  }
  for (const neg of [NEG_A, NEG_B]) {
    await pool.query(
      `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'modo_pedidos','transaccional')
       ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = 'transaccional'`, [neg]);
  }
  await metodos(NEG_A, ['efectivo', 'terminal']);
  await metodos(NEG_B, ['terminal']);

  // ═══ 1. Pago ausente → NO registra ════════════════════════════════════════
  await t('1. orden sin forma_pago: registrarPedido rechaza con FORMA_PAGO_FALTANTE y CERO pedidos', async () => {
    let error = null;
    try { await registrarPedido(ordenBase(), 'whatsapp'); } catch (e) { error = e; }
    assert.ok(error, 'el pedido sin forma de pago se registro');
    assert.strictEqual(error.codigo, 'ORDEN_INVALIDA');
    assert.ok(error.rechazos.some(r => r.codigo === RECHAZOS.FORMA_PAGO_FALTANTE), JSON.stringify(error.rechazos));
    assert.ok(!error.rechazos.some(r => r.codigo === RECHAZOS.FORMA_PAGO_INVALIDA), 'faltante se reporto como INVALIDA');
    assert.strictEqual((await pedidosDeTel(NEG_A)).length, 0);
  });

  // ═══ 2. "Sí" temprano sin pago → no registra + recuperación cableada ══════
  await t('2. un "si" anterior a elegir pago no registra nada y el canal exige NUEVA confirmacion', async () => {
    // El "sí" temprano produce exactamente una ORDEN_CONFIRMADA sin
    // forma_pago: el caso 1 ya probó que NO registra. Aquí se fija la
    // recuperación del canal: la instrucción de sesión conserva el pedido,
    // prohíbe el menú y exige repetir resumen + confirmación nueva.
    assert.ok(FUENTE_WA.includes('FORMA_PAGO_FALTANTE'), 'el canal no distingue faltante');
    assert.ok(FUENTE_WA.includes('sigue VIGENTE'), 'el canal no conserva el pedido');
    assert.ok(FUENTE_WA.includes('NO regreses al menú'), 'el canal permite regresar al menu');
    assert.ok(FUENTE_WA.includes('NO sirve como autorización'), 'el canal reutiliza el si anterior');
    assert.ok(FUENTE_WA.includes('Nunca asumas efectivo'), 'el canal permite asumir efectivo');
  });

  // ═══ 3. FALTANTE != INVÁLIDA ══════════════════════════════════════════════
  await t('3. faltante y invalida son rechazos distintos', async () => {
    const vF = await validarOrdenPropuesta(ordenBase(), NEG_A);
    assert.strictEqual(vF.ok, false);
    assert.deepStrictEqual(vF.rechazos.map(r => r.codigo), [RECHAZOS.FORMA_PAGO_FALTANTE]);
    const vI = await validarOrdenPropuesta(ordenBase({ forma_pago: 'bitcoin' }), NEG_A);
    assert.strictEqual(vI.ok, false);
    assert.deepStrictEqual(vI.rechazos.map(r => r.codigo), [RECHAZOS.FORMA_PAGO_INVALIDA]);
  });

  // ═══ 4. Faltante pregunta con los métodos REALES ══════════════════════════
  await t('4. faltante pregunta "¿Como deseas pagar?" con los metodos reales del negocio', async () => {
    const v = await validarOrdenPropuesta(ordenBase(), NEG_A);
    const msg = mensajeRechazoParaCliente(v.rechazos);
    assert.ok(msg.includes('¿Cómo deseas pagar?'), msg);
    assert.ok(/efectivo/i.test(msg), 'no ofrece efectivo (habilitado)');
    assert.ok(/terminal/i.test(msg), 'no ofrece terminal (habilitado)');
    assert.ok(!/men[uú]/i.test(msg), 'regresa al menu');
    assert.ok(!/no pude registrar/i.test(msg), 'suena a rechazo total');
  });

  // ═══ 5. Inválida ofrece SOLO métodos válidos ══════════════════════════════
  await t('5. invalida dice "no esta disponible" y ofrece solo los metodos validos, sin tirar el pedido', async () => {
    const v = await validarOrdenPropuesta(ordenBase({ forma_pago: 'transferencia' }), NEG_A);
    const msg = mensajeRechazoParaCliente(v.rechazos);
    assert.ok(/no está disponible/.test(msg), msg);
    assert.ok(/efectivo/i.test(msg) && /terminal/i.test(msg), 'no lista los metodos reales');
    assert.ok(!/transferencia/i.test(msg.split('Puedes pagar con')[1] || ''), 'ofrece el metodo invalido');
    assert.ok(/sigue tal como lo armamos/.test(msg), 'no conserva el pedido');
  });

  // ═══ 6. El pedido conserva su contexto ════════════════════════════════════
  await t('6. el rechazo por pago no muta la orden propuesta (items/datos intactos)', async () => {
    const orden = ordenBase();
    const copia = JSON.parse(JSON.stringify(orden));
    await validarOrdenPropuesta(orden, NEG_A);
    assert.deepStrictEqual(orden, copia, 'la validacion muto la orden del cliente');
  });

  // ═══ 7. Efectivo posterior funciona ═══════════════════════════════════════
  await t('7. la misma orden con efectivo (habilitado) se registra', async () => {
    const pedido = await registrarPedido(ordenBase({ forma_pago: 'efectivo' }), 'whatsapp');
    assert.ok(pedido?.id, 'sin folio');
    assert.strictEqual(pedido.forma_pago_tipo, 'efectivo');
  });

  // ═══ 8. Confirmación correcta exigida por el prompt ═══════════════════════
  await t('8. el prompt exige forma de pago en el resumen y invalida el "si" anterior', async () => {
    assert.ok(FUENTE_PROMPTS.includes('La forma de pago es OBLIGATORIA'), 'prompt sin regla de obligatoriedad');
    assert.ok(FUENTE_PROMPTS.includes('deja de valer'), 'prompt no invalida el si anterior');
    assert.ok(FUENTE_PROMPTS.includes('SIEMPRE incluye la forma de pago'), 'el resumen no exige forma de pago');
    assert.ok(FUENTE_PROMPTS.includes('ni "efectivo" por defecto'), 'el prompt permite asumir efectivo');
  });

  // ═══ 9. Exactamente una orden ═════════════════════════════════════════════
  await t('9. tras todo el flujo hay EXACTAMENTE un pedido registrado', async () => {
    assert.strictEqual((await pedidosDeTel(NEG_A)).length, 1);
  });

  // ═══ 10. enlace_pago solo si está habilitado de verdad ════════════════════
  await t('10. enlace_pago sin proveedor activo => INVALIDA; con proveedor principal activo => valida', async () => {
    await metodos(NEG_A, ['efectivo', 'enlace_pago']);
    // Sin integración principal activa el catálogo lo filtra: elegirlo es INVALIDA.
    const v1 = await validarOrdenPropuesta(ordenBase({ forma_pago: 'enlace de pago' }), NEG_A);
    assert.strictEqual(v1.ok, false);
    assert.ok(v1.rechazos.some(r => r.codigo === RECHAZOS.FORMA_PAGO_INVALIDA));
    // Con proveedor real activo y principal, el mismo método pasa.
    const { rows: [ic] } = await pool.query(
      `INSERT INTO integraciones_canal (negocio_id, canal, proveedor, identificador, estado, activo, principal)
       VALUES ($1,'pagos','clip',$2,'activo',TRUE,TRUE) RETURNING id`, [NEG_A, `FPTEST${suf}`]);
    await pool.query(`UPDATE metodos_pago SET integracion_id = $2 WHERE negocio_id = $1 AND tipo = 'enlace_pago'`, [NEG_A, ic.id]);
    const v2 = await validarOrdenPropuesta(ordenBase({ forma_pago: 'enlace de pago' }), NEG_A);
    assert.strictEqual(v2.ok, true, JSON.stringify(v2.rechazos));
    assert.strictEqual(v2.orden.forma_pago_tipo, 'enlace_pago');
  });

  // ═══ 11. Dos tenants, métodos distintos, cero cruce ═══════════════════════
  await t('11. metodos de un tenant jamas se ofrecen ni validan en el otro', async () => {
    await metodos(NEG_A, ['efectivo']);
    const vA = await validarOrdenPropuesta(ordenBase({ forma_pago: 'terminal' }), NEG_A);
    assert.strictEqual(vA.ok, false, 'A acepto un metodo que no tiene');
    const dispA = vA.rechazos[0].disponibles.join(', ');
    assert.ok(/efectivo/i.test(dispA) && !/terminal/i.test(dispA), `disponibles de A contaminados: ${dispA}`);

    const ordenB = ordenBase({ negocioId: NEG_B, items: [{ nombre: `FP Torta Prueba ${suf}`, cantidad: 1, precio_unitario: 80 }], subtotal: 80, total: 80 });
    const vB1 = await validarOrdenPropuesta({ ...ordenB, forma_pago: 'efectivo' }, NEG_B);
    assert.strictEqual(vB1.ok, false, 'B acepto efectivo sin tenerlo');
    const dispB = vB1.rechazos[0].disponibles.join(', ');
    assert.ok(/terminal/i.test(dispB) && !/efectivo/i.test(dispB), `disponibles de B contaminados: ${dispB}`);
    const vB2 = await validarOrdenPropuesta({ ...ordenB, forma_pago: 'terminal' }, NEG_B);
    assert.strictEqual(vB2.ok, true, JSON.stringify(vB2.rechazos));
  });

  // ═══ 12. Retry/duplicado => una sola orden ════════════════════════════════
  await t('12. el canal descarta reprocesos por wamid: un webhook reintentado no puede duplicar la orden', async () => {
    // El gate vive en el webhook (whatsapp-meta): antes de procesar un
    // mensaje se consulta existeMensajeConIdExterno(wamid) y un reproceso
    // se descarta -- la orden solo puede nacer del primer procesamiento.
    assert.ok(/existeMensajeConIdExterno\(wamid\)/.test(FUENTE_WA), 'el webhook no deduplica por wamid');
    const WAMID = `wamid.fp-${suf}`;
    await pool.query(
      `INSERT INTO mensajes (negocio_id, telefono, direccion, texto, origen, message_id_externo)
       VALUES ($1,$2,'entrante','pedido de prueba','cliente',$3)`, [NEG_A, TEL, WAMID]);
    assert.strictEqual(await existeMensajeConIdExterno(WAMID), true, 'el dedupe no reconoce el wamid guardado');
    assert.strictEqual(await existeMensajeConIdExterno(`wamid.fp-otro-${suf}`), false);
    // Y la base sigue con exactamente un pedido del flujo completo.
    assert.strictEqual((await pedidosDeTel(NEG_A)).length, 1);
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL: ' + e.message);
} finally {
  await limpiarFixture().catch(() => {});
  await restaurar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-bot-forma-pago: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
