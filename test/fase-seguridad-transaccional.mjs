// P0 — SEGURIDAD TRANSACCIONAL DEL AGENTE: el LLM propone, Xabor autoriza.
//
// Demuestra las invariantes del P0 con el criterio de aceptación literal:
// "aunque el LLM intente hacerlo, Xabor no se lo permite". El "LLM" aquí es
// el mock de Anthropic al que se le ENCOLAN respuestas maliciosas/erróneas
// (productos inventados, precios falsos, confirmaciones verbales) y se
// verifica que el backend no las convierta jamás en pedidos, comandas ni
// confirmaciones al cliente.
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, etc.).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4193';

const { pool, actualizarConfiguracion } = await import('../src/services/database.js');
const { validarOrdenPropuesta, RECHAZOS } = await import('../src/orders/validadorOrden.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperarHasta(fn, { timeoutMs = 12000, intervaloMs = 300 } = {}) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const r = await fn();
    if (r) return r;
    await esperar(intervaloMs);
  }
  return null;
}

const NEG_A = SEED.negocioA; // restaurante transaccional
const NEG_B = SEED.negocioB; // "florería" modo solicitud (fixture Alora)
const PNID_A = 'PNID_P0_TXN_A';
const PNID_B = 'PNID_P0_TXN_B';

// ─── Setup: catálogos reales, integraciones y configuración ─────────────────
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}
async function crearCatalogo(negocioId, nombreCat, productos) {
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,999) RETURNING id`,
    [negocioId, nombreCat]);
  const ids = {};
  for (const p of productos) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
       VALUES ($1,$2,$3,$4,$5,$6,0) RETURNING id`,
      [negocioId, cat.id, p.nombre, p.precio, p.disponible !== false, p.agotado === true]);
    ids[p.nombre] = row.id;
  }
  return { categoriaId: cat.id, ids };
}

// Limpieza defensiva (re-ejecutable, corridas previas interrumpidas)
await pool.query(`DELETE FROM mensajes WHERE negocio_id = ANY($1) AND telefono LIKE '52188007%'`, [[NEG_A, NEG_B]]);
await pool.query(`DELETE FROM perfiles_clientes WHERE telefono LIKE '52188007%'`);
await pool.query(`DELETE FROM pedidos WHERE telefono LIKE '52188007%'`);
await pool.query(`DELETE FROM clientes WHERE telefono LIKE '52188007%'`);
await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = ANY($1) AND datos->>'canal' = 'whatsapp' AND datos->'cliente'->>'telefono' LIKE '52188007%'`, [[NEG_A, NEG_B]]).catch(() => {});
await pool.query(`DELETE FROM menu_productos WHERE negocio_id = ANY($1) AND nombre LIKE 'P0 %'`, [[NEG_A, NEG_B]]);
await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = ANY($1) AND nombre LIKE 'P0 %'`, [[NEG_A, NEG_B]]);
await pool.query(`DELETE FROM integraciones_canal WHERE canal='whatsapp' AND identificador = ANY($1)`, [[PNID_A, PNID_B]]);

const catA = await crearCatalogo(NEG_A, 'P0 Paninis', [
  { nombre: 'P0 Panini Prueba', precio: 180 },
  { nombre: 'P0 Panini Agotado', precio: 200, agotado: true },
  { nombre: 'P0 Panini Oculto', precio: 150, disponible: false },
]);
await crearCatalogo(NEG_B, 'P0 Ramos', [
  { nombre: 'P0 Ramo Luz', precio: 200 },
  { nombre: 'P0 Producto Secreto B', precio: 999 },
]);

for (const [neg, pnid, tokenFake] of [[NEG_A, PNID_A, 'fake-token-p0-a'], [NEG_B, PNID_B, 'fake-token-p0-b']]) {
  await fijarModulo(neg, 'whatsapp', 'activo');
  await fijarModulo(neg, 'pos', 'activo');
  // Higiene entre suites: si una suite comercial anterior dejó el
  // asistente de cotizaciones ACTIVO en los negocios seed, cada mensaje
  // consumiría una respuesta extra del mock de Anthropic (el clasificador
  // de intención) y desalinearía la cola de esta suite. Aquí se apaga
  // siempre: esta suite no prueba ese módulo.
  await fijarModulo(neg, 'asistente_comercial_cotizaciones', 'no_configurado');
  await actualizarConfiguracion({ int_wa_phone_id: pnid, int_wa_token: tokenFake }, neg);
  await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo)
    VALUES ($1,'whatsapp',$2,'P0 TXN',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [neg, pnid]);
  await pool.query(`UPDATE negocios SET bot_whatsapp_activo = TRUE WHERE id = $1`, [neg]);
  for (const [tipo, orden] of [['efectivo', 0], ['terminal', 1]]) {
    await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,$2,TRUE,$3)
      ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [neg, tipo, orden]);
  }
}
// A: transaccional sin anticipo (arranque); B: florería en modo solicitud
await actualizarConfiguracion({ modo_pedidos: 'transaccional', pedido_requiere_anticipo: 'false' }, NEG_A);
await actualizarConfiguracion({ modo_pedidos: 'solicitud', pedido_requiere_anticipo: 'true' }, NEG_B);

const metaMock = await arrancarMetaMock();
const anthropicMock = await arrancarAnthropicMock();
const srv = await arrancarServidor({
  PORT: PUERTO,
  META_GRAPH_BASE_URL: metaMock.baseUrl,
  ANTHROPIC_BASE_URL: anthropicMock.baseUrl,
  ANTHROPIC_API_KEY: 'sk-ant-test-mock',
}, { timeoutMs: 30000 });
const base = srv.base;

let wamidSeq = 0;
async function mensajeEntrante(pnid, telefono, texto) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: pnid },
      messages: [{ type: 'text', from: telefono, id: `wamid.P0-${Date.now()}-${wamidSeq++}`, text: { body: texto } }],
      contacts: [{ profile: { name: 'Cliente P0' } }],
    } }] }],
  };
  await fetch(base + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}
function salientesA(telefono, desde = 0) {
  return metaMock.obtenerMensajesEnviados().slice(desde)
    .filter(m => m.text?.body && String(m.to) === telefono)
    .map(m => m.text.body);
}
async function respuestaDelBot(telefono, desde) {
  const r = await esperarHasta(() => {
    const msgs = salientesA(telefono, desde);
    return msgs.length ? msgs : null;
  });
  return r || [];
}
const ordenJSON = (obj) => `Perfecto, confirmo tu pedido.\n<ORDEN_CONFIRMADA>\n${JSON.stringify(obj)}\n</ORDEN_CONFIRMADA>`;
const ordenBase = (items, extras = {}) => ({
  cliente: { nombre: 'Cliente P0', telefono: null, calle: null, colonia: null, entre_calles: null },
  modalidad: 'recoger en tienda',
  items,
  subtotal: extras.subtotal ?? 0, costo_envio: extras.costo_envio ?? 0, descuento: extras.descuento ?? 0,
  total: extras.total ?? 0, forma_pago: extras.forma_pago ?? 'efectivo', canal: 'test', programado_para: null,
});
async function pedidosDeTel(negocioId, telLike) {
  const { rows } = await pool.query(
    `SELECT folio, estado, datos FROM pedidos_activos WHERE negocio_id = $1 AND datos->'cliente'->>'telefono' LIKE $2 ORDER BY created_at`,
    [negocioId, telLike]);
  return rows;
}

try {

// ═══════════ UNIDAD: el validador es la autoridad (T1-T6, T10, T15) ═════════
await t('T1', 'producto válido se resuelve a producto_id + precio real', async () => {
  const v = await validarOrdenPropuesta(ordenBase([{ nombre: 'p0 panini prueba', cantidad: 2, precio_unitario: 180 }]), NEG_A);
  assert.strictEqual(v.ok, true, JSON.stringify(v.rechazos));
  assert.strictEqual(v.orden.items[0].producto_id, catA.ids['P0 Panini Prueba']);
  assert.strictEqual(v.orden.items[0].nombre, 'P0 Panini Prueba', 'el nombre canónico es el del catálogo, no el del LLM');
  assert.strictEqual(v.orden.items[0].precio_unitario, 180);
  assert.strictEqual(v.orden.total, 360);
});

await t('T2', 'producto inexistente (box lunch) → rechazado, jamás item libre', async () => {
  const v = await validarOrdenPropuesta(ordenBase([{ nombre: 'box lunch con pollo', cantidad: 12, precio_unitario: 120 }]), NEG_A);
  assert.strictEqual(v.ok, false);
  assert.ok(v.rechazos.some(r => r.codigo === RECHAZOS.PRODUCTO_NO_EXISTE));
});

await t('T3', 'producto desactivado → rechazado', async () => {
  const v = await validarOrdenPropuesta(ordenBase([{ nombre: 'P0 Panini Oculto', cantidad: 1, precio_unitario: 150 }]), NEG_A);
  assert.strictEqual(v.ok, false);
  assert.ok(v.rechazos.some(r => r.codigo === RECHAZOS.PRODUCTO_NO_DISPONIBLE));
});

await t('T4', 'producto agotado → rechazado', async () => {
  const v = await validarOrdenPropuesta(ordenBase([{ nombre: 'P0 Panini Agotado', cantidad: 1, precio_unitario: 200 }]), NEG_A);
  assert.strictEqual(v.ok, false);
  assert.ok(v.rechazos.some(r => r.codigo === RECHAZOS.PRODUCTO_AGOTADO));
});

await t('T5', 'precio inventado por el LLM → prevalece el precio real del backend', async () => {
  const v = await validarOrdenPropuesta(ordenBase([{ nombre: 'P0 Panini Prueba', cantidad: 1, precio_unitario: 1 }]), NEG_A);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.orden.items[0].precio_unitario, 180, 'el precio del modelo no es autoridad');
  assert.ok(v.ajustes.some(a => a.tipo === 'precio_mismatch'));
});

await t('T6', 'total manipulado → backend recalcula (y descuento del LLM se ignora)', async () => {
  const v = await validarOrdenPropuesta(ordenBase(
    [{ nombre: 'P0 Panini Prueba', cantidad: 3, precio_unitario: 180 }],
    { total: 10, descuento: 500 }), NEG_A);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.orden.total, 540);
  assert.strictEqual(v.orden.descuento, 0);
  assert.ok(v.ajustes.some(a => a.tipo === 'total_mismatch'));
});

await t('T10', 'forma de pago no habilitada → rechazada (fail closed)', async () => {
  const v = await validarOrdenPropuesta(ordenBase(
    [{ nombre: 'P0 Panini Prueba', cantidad: 1, precio_unitario: 180 }], { forma_pago: 'criptomonedas' }), NEG_A);
  assert.strictEqual(v.ok, false);
  assert.ok(v.rechazos.some(r => r.codigo === RECHAZOS.FORMA_PAGO_INVALIDA));
});

await t('T15', 'producto de OTRO tenant → indistinguible de inexistente (aislamiento)', async () => {
  const v = await validarOrdenPropuesta(ordenBase([{ nombre: 'P0 Producto Secreto B', cantidad: 1, precio_unitario: 999 }]), NEG_A);
  assert.strictEqual(v.ok, false);
  assert.ok(v.rechazos.some(r => r.codigo === RECHAZOS.PRODUCTO_NO_EXISTE),
    'el catálogo de B jamás existe para A');
});

// ═══════════ INTEGRACIÓN: webhook → LLM malicioso → backend (T7-T9, T11-T14) ═══
await t('T2b', 'integración: LLM emite orden con producto inventado → cero pedido, respuesta honesta', async () => {
  const tel = '5218800711001';
  anthropicMock.encolarRespuesta(ordenJSON(ordenBase([{ nombre: 'box lunch con pollo', cantidad: 10, precio_unitario: 120 }], { total: 1200 })));
  const antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(PNID_A, tel, 'Quiero 10 box lunch para hoy');
  const respuestas = await respuestaDelBot(tel, antes);
  assert.ok(respuestas.length, 'el bot debía responder');
  const txt = respuestas.join(' | ');
  assert.ok(/no manejamos|no pude registrar/i.test(txt), 'respuesta honesta de rechazo: ' + txt.slice(0, 160));
  assert.ok(!/pedido .{0,12}(registrado|confirmado)/i.test(txt), 'jamás afirma confirmación');
  const peds = await pedidosDeTel(NEG_A, '52188007110%');
  assert.strictEqual(peds.length, 0, 'cero pedidos creados');
});

await t('T7', 'anticipo obligatorio sin pago → pedido pendiente_pago, SIN comanda, mensaje honesto', async () => {
  await actualizarConfiguracion({ pedido_requiere_anticipo: 'true' }, NEG_A);
  const tel = '5218800712001';
  anthropicMock.encolarRespuesta(ordenJSON(ordenBase(
    [{ nombre: 'P0 Panini Prueba', cantidad: 2, precio_unitario: 180 }], { total: 360 })));
  const antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(PNID_A, tel, 'Sí, confirma mi pedido de 2 paninis');
  const respuestas = await respuestaDelBot(tel, antes);
  const peds = await esperarHasta(async () => {
    const r = await pedidosDeTel(NEG_A, '52188007120%');
    return r.length ? r : null;
  });
  assert.ok(peds?.length === 1, 'el pedido existe (pre-registrado)');
  assert.strictEqual(peds[0].estado, 'pendiente_pago', 'nace pendiente de pago, nunca confirmado');
  const txt = respuestas.join(' | ');
  assert.ok(/pre-registrado|pendiente/i.test(txt), 'el cliente sabe que NO está confirmado: ' + txt.slice(0, 160));
  // La comanda quedó bloqueada: el gate lo registra en la salida del server
  assert.ok(srv.obtenerSalida().includes('comanda_bloqueada_pendiente_pago'), 'gate de comanda activo');
});

await t('T8', 'anticipo validado por backend (webhook de pago) → transición pendiente_pago→confirmado', async () => {
  const peds = await pedidosDeTel(NEG_A, '52188007120%');
  const folio = peds[0].folio;
  // El pago se valida por el ÚNICO camino autorizado: el webhook de la
  // pasarela que el servidor ya procesa (camino legacy: referencia = folio,
  // el pedido vive en la memoria del server). Ni el LLM ni el cliente
  // pueden producir esta transición.
  const r = await fetch(base + '/webhook/clip', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resource_status: 'COMPLETED', resource: 'CHECKOUT', me_reference_id: folio }),
  });
  assert.strictEqual(r.status, 200);
  const filaOk = await esperarHasta(async () => {
    const { rows: [f] } = await pool.query(`SELECT estado FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, NEG_A]);
    return f?.estado === 'nuevo' ? f : null;
  });
  assert.ok(filaOk, 'tras el pago validado, el pedido queda confirmado (estado nuevo)');
  assert.ok(srv.obtenerSalida().includes('transicion_pendiente_pago_confirmado'), 'evento de transición registrado');
  // Idempotencia: un webhook repetido no re-emite nada ni cambia el estado.
  await fetch(base + '/webhook/clip', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resource_status: 'COMPLETED', resource: 'CHECKOUT', me_reference_id: folio }),
  });
  await esperar(600);
  const { rows: [f2] } = await pool.query(`SELECT estado FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, NEG_A]);
  assert.strictEqual(f2.estado, 'nuevo');
});

await t('T9', 'negocio SIN anticipo conserva el flujo actual (pedido nace nuevo, total del backend)', async () => {
  await actualizarConfiguracion({ pedido_requiere_anticipo: 'false' }, NEG_A);
  const tel = '5218800713001';
  anthropicMock.encolarRespuesta(ordenJSON(ordenBase(
    [{ nombre: 'P0 Panini Prueba', cantidad: 1, precio_unitario: 9999 }], { total: 9999 })));
  const antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(PNID_A, tel, 'Sí, confirmo');
  const respuestas = await respuestaDelBot(tel, antes);
  const peds = await esperarHasta(async () => {
    const r = await pedidosDeTel(NEG_A, '52188007130%');
    return r.length ? r : null;
  });
  assert.ok(peds?.length === 1);
  assert.strictEqual(peds[0].estado, 'nuevo');
  assert.strictEqual(Number(peds[0].datos.total), 180, 'el total es el del backend, no los $9999 del LLM');
  assert.ok(respuestas.join(' ').includes('$180'), 'el cliente recibe el total REAL');
});

await t('T11', 'confirmación verbal SIN orden → detectada, alertada y aclarada al cliente', async () => {
  const tel = '5218800714001';
  anthropicMock.encolarRespuesta('¡Excelente! Tu pedido está registrado y se procesará muy pronto.');
  const antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(PNID_A, tel, 'entonces ya quedó?');
  const respuestas = await respuestaDelBot(tel, antes);
  const txt = respuestas.join(' | ');
  assert.ok(/aún no queda registrado/i.test(txt), 'el cliente recibe la aclaración honesta: ' + txt.slice(0, 200));
  assert.ok(srv.obtenerSalida().includes('confirmacion_verbal_sin_orden'), 'evento estructurado registrado');
  const peds = await pedidosDeTel(NEG_A, '52188007140%');
  assert.strictEqual(peds.length, 0);
});

await t('T12', 'modo solicitud (fixture Alora): orden del LLM con producto inventado → solicitud, jamás pedido', async () => {
  const tel = '5218800715001';
  anthropicMock.encolarRespuesta(ordenJSON(ordenBase(
    [{ nombre: 'box lunch con pollo', cantidad: 10, precio_unitario: 120 }], { total: 1200 })));
  const antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(PNID_B, tel, 'Necesito 10 box lunch para hoy');
  const respuestas = await respuestaDelBot(tel, antes);
  const txt = respuestas.join(' | ');
  assert.ok(/solicitud/i.test(txt), 'se anota como solicitud: ' + txt.slice(0, 160));
  assert.ok(!/pedido .{0,12}(registrado|confirmado)/i.test(txt), 'sin confirmación transaccional');
  assert.ok(!/\$\d/.test(txt.replace(/\$\{/g, '')), 'sin precios inventados en la respuesta');
  const peds = await pedidosDeTel(NEG_B, '52188007150%');
  assert.strictEqual(peds.length, 0, 'cero pedidos en modo solicitud');
});

await t('T13', 'el cliente insiste ("sí, confírmame 12") → EXACTAMENTE las mismas garantías', async () => {
  const tel = '5218800715001';
  anthropicMock.encolarRespuesta(ordenJSON(ordenBase(
    [{ nombre: 'box lunch con pollo', cantidad: 9, precio_unitario: 120 }, { nombre: 'box lunch con carne', cantidad: 3, precio_unitario: 130 }],
    { total: 1470 })));
  const antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(PNID_B, tel, 'Sí, confírmame 12, 9 de pollo y 3 de carne');
  const respuestas = await respuestaDelBot(tel, antes);
  const txt = respuestas.join(' | ');
  assert.ok(!/pedido .{0,12}(registrado|confirmado)/i.test(txt));
  const peds = await pedidosDeTel(NEG_B, '52188007150%');
  assert.strictEqual(peds.length, 0, 'insistir no altera las reglas');
});

await t('T13b', 'insistencia en negocio TRANSACCIONAL con producto inexistente → sigue rechazado', async () => {
  const tel = '5218800716001';
  anthropicMock.encolarRespuesta(ordenJSON(ordenBase([{ nombre: 'box lunch', cantidad: 12, precio_unitario: 120 }], { total: 1440 })));
  const antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(PNID_A, tel, 'Sí, confírmame los 12 box lunch, es urgente');
  const respuestas = await respuestaDelBot(tel, antes);
  assert.ok(/no manejamos|no pude registrar/i.test(respuestas.join(' ')));
  assert.strictEqual((await pedidosDeTel(NEG_A, '52188007160%')).length, 0);
});

await t('T14', 'JSON inválido del LLM → fail closed, cero pedido, sin crash', async () => {
  const tel = '5218800717001';
  anthropicMock.encolarRespuesta('Claro, va tu pedido.\n<ORDEN_CONFIRMADA>\n{esto no es json válido,,,\n</ORDEN_CONFIRMADA>');
  const antes = metaMock.obtenerMensajesEnviados().length;
  await mensajeEntrante(PNID_A, tel, 'ok');
  const respuestas = await respuestaDelBot(tel, antes);
  assert.ok(respuestas.length, 'el servidor sigue vivo y responde');
  assert.strictEqual((await pedidosDeTel(NEG_A, '52188007170%')).length, 0, 'cero pedidos con JSON inválido');
});

await t('MENU-VACIO', 'negocio sin menú: TODA orden transaccional se rechaza (caso raíz Alora)', async () => {
  // NEG_B en modo transaccional temporal pero con catálogo eliminado no es
  // necesario: se valida por unidad contra un negocio sintético sin menú.
  const { rows: [negTmp] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ('P0 Sin Menú', 'p0-sin-menu-mock')
     ON CONFLICT (slug) DO UPDATE SET nombre = 'P0 Sin Menú' RETURNING id`);
  const v = await validarOrdenPropuesta(ordenBase([{ nombre: 'lo que sea', cantidad: 1, precio_unitario: 10 }]), negTmp.id);
  assert.strictEqual(v.ok, false);
  assert.ok(v.rechazos.some(r => r.codigo === RECHAZOS.MENU_VACIO));
});

} finally {
  srv.detener();
  await new Promise((r) => { srv.proc.once('exit', r); setTimeout(r, 3000); });
  await metaMock.detener();
  await anthropicMock.detener();
  // Higiene entre suites: nada de este archivo sobrevive a la corrida.
  await pool.query(`DELETE FROM configuracion WHERE negocio_id = ANY($1) AND clave IN ('int_wa_phone_id','int_wa_token','modo_pedidos','pedido_requiere_anticipo')`, [[NEG_A, NEG_B]]).catch(() => {});
  await pool.query(`DELETE FROM integraciones_canal WHERE canal='whatsapp' AND identificador = ANY($1)`, [[PNID_A, PNID_B]]).catch(() => {});
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id = ANY($1) AND nombre LIKE 'P0 %'`, [[NEG_A, NEG_B]]).catch(() => {});
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = ANY($1) AND nombre LIKE 'P0 %'`, [[NEG_A, NEG_B]]).catch(() => {});
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = ANY($1) AND datos->'cliente'->>'telefono' LIKE '52188007%'`, [[NEG_A, NEG_B]]).catch(() => {});
  await pool.query(`DELETE FROM mensajes WHERE negocio_id = ANY($1) AND telefono LIKE '52188007%'`, [[NEG_A, NEG_B]]).catch(() => {});
  await pool.query(`DELETE FROM perfiles_clientes WHERE telefono LIKE '52188007%'`).catch(() => {});
  await pool.query(`DELETE FROM pedidos WHERE telefono LIKE '52188007%'`).catch(() => {});
  await pool.query(`DELETE FROM clientes WHERE telefono LIKE '52188007%'`).catch(() => {});
  await pool.query(`UPDATE negocios SET bot_whatsapp_activo = FALSE WHERE id = ANY($1)`, [[NEG_A, NEG_B]]).catch(() => {});
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
await pool.end();
process.exit(fallidas ? 1 : 0);
