// Repartidores/notificaciones WhatsApp: diagnóstico de producción (Nonna
// Maye) encontró que Xabor registraba "Notificación enviada" con solo que
// Meta aceptara la petición HTTP -- sin plantilla (mensajes de negocio
// fuera de la ventana de 24h de servicio al cliente quedan sujetos a
// rechazo) y sin procesar los webhooks de estado que Meta manda después
// (sent/delivered/read/failed). Esta suite cubre, con el flag de piloto
// (repartidor_notif_plantilla_activo) activado solo para negocioA:
//   - la plantilla se envía y se registra en notificaciones_repartidor
//   - un fallo de Meta al enviar se registra como error_envio
//   - el webhook de status actualiza el estado real (incluye guard contra
//     reordenamiento fuera de orden y el caso 'failed')
//   - negocioB (flag apagado) conserva el comportamiento anterior EXACTO:
//     cero filas nuevas en notificaciones_repartidor
//   - regresión: asignación atómica y visibilidad del repartidor en
//     comandas (código ya existente, no tocado por este cambio)
//   - aislamiento multiempresa de notificaciones_repartidor
//
// Uso: mismas env vars que el resto de la batería (ver fase-hotfix-*.mjs).
// Requiere aplicar-migraciones.mjs y seed-datos-prueba.mjs ya corridos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4185';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, actualizarConfiguracion, asignarRepartidor, obtenerNotificacionesPedido, crearUsuarioConPassword } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
function cookieHeader(usuarioId, negocioId, rol) { return `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`; }
async function api(base, path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(
    `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
     ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`,
    [negocioId, modulo, estado]
  );
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Reintenta una función hasta que devuelva un valor truthy o se agote el
// tiempo -- necesario porque registrarPedido/emitirPedido corren en
// segundo plano (fire-and-forget, ver migración 032) y no hay forma
// síncrona de saber cuándo terminaron.
async function esperarHasta(fn, { timeoutMs = 8000, intervaloMs = 200 } = {}) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const r = await fn();
    if (r) return r;
    await esperar(intervaloMs);
  }
  return null;
}

// ═══════════ Setup ═══════════
await fijarModulo(SEED.negocioA, 'pos', 'activo');
await fijarModulo(SEED.negocioB, 'pos', 'activo');
await actualizarConfiguracion({ int_wa_phone_id: 'PNID_REPART_A', int_wa_token: 'fake-token-repart-a' }, SEED.negocioA);
await actualizarConfiguracion({ int_wa_phone_id: 'PNID_REPART_B', int_wa_token: 'fake-token-repart-b' }, SEED.negocioB);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,'Repart A',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [SEED.negocioA, 'PNID_REPART_A']);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,'Repart B',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [SEED.negocioB, 'PNID_REPART_B']);

// Piloto: SOLO negocioA activa el envío por plantilla.
await actualizarConfiguracion({ repartidor_notif_plantilla_activo: 'true' }, SEED.negocioA);
// Lista blanca del piloto: por defecto, en este archivo, el único teléfono
// autorizado es el repartidor de prueba A -- así todas las pruebas que ya
// existían (PLANTILLA-ENVIO, ACEPTAR-TOKEN, etc.) siguen notificando
// exactamente a quien siempre notificaron, ahora bajo el nuevo requisito
// de lista blanca. El bloque PILOTO-WHITELIST más abajo ejercita el filtro
// en sí y reconfigura esta clave según cada caso.
await actualizarConfiguracion({ repartidor_notif_piloto_telefonos: '5210000900001' }, SEED.negocioA);

// Repartidores de prueba (telefono es único global en la tabla). Se borra
// primero notificaciones_repartidor de una corrida anterior (FK RESTRICT)
// para que esta suite sea re-ejecutable sin recrear la base a mano.
await pool.query(`DELETE FROM notificaciones_repartidor WHERE repartidor_id IN (SELECT id FROM repartidores WHERE telefono IN ('5210000900001','5210000900002','5210000900003'))`);
await pool.query(`DELETE FROM repartidores WHERE telefono IN ('5210000900001','5210000900002','5210000900003')`);
const { rows: [repA] } = await pool.query(
  `INSERT INTO repartidores (nombre, telefono, token, activo, negocio_id) VALUES ('Repartidor Prueba A','5210000900001','tok-repart-a',TRUE,$1) RETURNING *`,
  [SEED.negocioA]
);
const { rows: [repB] } = await pool.query(
  `INSERT INTO repartidores (nombre, telefono, token, activo, negocio_id) VALUES ('Repartidor Prueba B','5210000900002','tok-repart-b',TRUE,$1) RETURNING *`,
  [SEED.negocioB]
);

const metaMock = await arrancarMetaMock();
const srv = await arrancarServidor({ PORT: PUERTO, META_GRAPH_BASE_URL: metaMock.baseUrl }, { timeoutMs: 30000 });
const base = srv.base;

// Negocio B no tiene usuario propio en el seed compartido -- se crea uno
// dedicado aquí (mismo patrón que fase-chat-manual.mjs) porque este test
// SÍ necesita crear un pedido real como negocioB, no solo verificar 403.
// Idempotente (igual criterio que la limpieza de repartidores de prueba
// más abajo) para que la suite se pueda re-ejecutar sin recrear la base.
const { rows: [adminBExistente] } = await pool.query(`SELECT id FROM usuarios WHERE email = 'admin-b-repartidores@test.local'`);
const adminNegocioB = adminBExistente || await crearUsuarioConPassword({
  negocioId: SEED.negocioB, nombre: 'Admin Negocio B (repartidores)', email: 'admin-b-repartidores@test.local',
  password: 'ClaveAdminBPrueba123!', rol: 'admin',
});
const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
const cookieAdminB = cookieHeader(adminNegocioB.id, SEED.negocioB, 'admin');

async function crearPedidoPrueba(cookie) {
  const r = await api(base, '/test/pedido', { cookie, method: 'POST' });
  assert.strictEqual(r.status, 200, `/test/pedido debe responder 200, dio ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.pedido.id; // folio, p.ej. XAB-0001
}

function webhookStatus(pnid, wamid, status, errores = null) {
  const s = { id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '5210000900001' };
  if (errores) s.errors = errores;
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: pnid },
      statuses: [s],
    } }] }],
  };
}
async function enviarWebhookStatus(pnid, wamid, status, errores = null) {
  return fetch(base + '/webhook/whatsapp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(webhookStatus(pnid, wamid, status, errores)),
  });
}
async function notifsDe(folio, negocioId = SEED.negocioA) {
  return obtenerNotificacionesPedido(folio, negocioId);
}

// ═══════════ PLANTILLA-ENVIO: negocioA (piloto) registra el intento ═══════════
await t('PLANTILLA-ENVIO', 'crear pedido de domicilio con el flag activo registra notificaciones_repartidor con estado aceptado_meta y wamid', async () => {
  const folio = await crearPedidoPrueba(cookieAdminA);
  const filas = await esperarHasta(async () => {
    const r = await notifsDe(folio);
    return r.length ? r : null;
  });
  assert.ok(filas, `debía aparecer al menos una fila en notificaciones_repartidor para ${folio}`);
  const fila = filas.find(f => f.repartidor_id === repA.id);
  assert.ok(fila, 'debe existir una fila para el repartidor de prueba A');
  assert.strictEqual(fila.canal, 'plantilla');
  assert.strictEqual(fila.estado, 'aceptado_meta');
  assert.ok(fila.wamid, 'debe traer el wamid devuelto por Meta');
  assert.ok(fila.token_aceptacion, 'debe generar un token de aceptación de un solo uso');
  assert.ok(fila.token_expira_at, 'el token debe traer una expiración');
  assert.strictEqual(fila.token_usado_at, null, 'el token recién generado no debe estar usado');
});

// ═══════════ SENSIBLE-NO-EN-OFERTA: la plantilla de oferta nunca lleva datos del cliente ═══════════
await t('SENSIBLE-NO-EN-OFERTA', 'la plantilla xabor_nuevo_servicio_reparto nunca incluye nombre/teléfono/dirección del cliente', async () => {
  const folio = await crearPedidoPrueba(cookieAdminA);
  await esperarHasta(async () => {
    const r = await notifsDe(folio);
    return r.length ? r : null;
  });
  const enviados = metaMock.obtenerMensajesEnviados().filter(m => m.template?.name === 'xabor_nuevo_servicio_reparto');
  assert.ok(enviados.length > 0, 'debía haberse enviado al menos una plantilla xabor_nuevo_servicio_reparto');
  const textoCompleto = JSON.stringify(enviados);
  assert.ok(!textoCompleto.includes('Cliente Prueba'), 'el nombre del cliente nunca debe viajar en la plantilla de oferta');
  assert.ok(!textoCompleto.includes('8781234567'), 'el teléfono del cliente nunca debe viajar en la plantilla de oferta');
  assert.ok(!textoCompleto.includes('Tecnológico'), 'la dirección del cliente nunca debe viajar en la plantilla de oferta');
  const params = enviados[enviados.length - 1].template.components[0].parameters.map(p => p.text);
  assert.strictEqual(params.length, 3, 'la plantilla de oferta debe traer exactamente 3 variables: negocio, pago, enlace');
  assert.ok(params[2].includes('/repartidor/aceptar/'), 'la tercera variable debe ser el enlace de aceptación de un solo uso');
});

// ═══════════ ACEPTAR-TOKEN: aceptar por el enlace asigna y envía la plantilla de detalle ═══════════
await t('ACEPTAR-TOKEN', 'abrir el enlace de aceptación asigna el pedido y envía xabor_detalle_servicio_reparto con los datos completos', async () => {
  const folio = await crearPedidoPrueba(cookieAdminA);
  const fila = await esperarHasta(async () => {
    const r = await notifsDe(folio);
    return r.find(f => f.repartidor_id === repA.id && f.token_aceptacion) || null;
  });
  assert.ok(fila, 'debía existir el token antes de aceptar');

  const r = await fetch(`${base}/repartidor/aceptar/${fila.token_aceptacion}`);
  assert.strictEqual(r.status, 200, 'aceptar con un token válido debe responder 200');

  const { rows: [pedidoDB] } = await pool.query(`SELECT datos->>'repartidor_nombre' AS nombre FROM pedidos_activos WHERE folio = $1`, [folio]);
  assert.strictEqual(pedidoDB.nombre, repA.nombre, 'aceptar por el enlace debe asignar el pedido (misma asignarRepartidor de siempre)');

  const detalle = metaMock.obtenerMensajesEnviados().filter(m => m.template?.name === 'xabor_detalle_servicio_reparto');
  assert.ok(detalle.length > 0, 'debía enviarse la plantilla de detalle tras aceptar');
  const paramsDetalle = detalle[detalle.length - 1].template.components[0].parameters.map(p => p.text);
  assert.strictEqual(paramsDetalle[0], folio, 'el primer parámetro de la plantilla de detalle debe ser el folio');
  assert.strictEqual(paramsDetalle[1], 'Cliente Prueba', 'la plantilla de detalle SÍ debe incluir el nombre del cliente (solo después de aceptar)');
});

// ═══════════ TOKEN-REUSO: el mismo enlace no puede aceptarse dos veces ═══════════
await t('TOKEN-REUSO', 'reutilizar el mismo token (mensaje reenviado o doble clic) la segunda vez es rechazado', async () => {
  const folio = await crearPedidoPrueba(cookieAdminA);
  const fila = await esperarHasta(async () => {
    const r = await notifsDe(folio);
    return r.find(f => f.repartidor_id === repA.id && f.token_aceptacion) || null;
  });
  assert.ok(fila, 'debía existir el token antes de aceptar');

  const r1 = await fetch(`${base}/repartidor/aceptar/${fila.token_aceptacion}`);
  assert.strictEqual(r1.status, 200, 'el primer uso del token debe aceptarse');

  const r2 = await fetch(`${base}/repartidor/aceptar/${fila.token_aceptacion}`);
  assert.strictEqual(r2.status, 409, 'un segundo uso del mismo token debe rechazarse');
});

// ═══════════ TOKEN-EXPIRADO / TOKEN-INVALIDO ═══════════
await t('TOKEN-EXPIRADO', 'un token vencido se rechaza aunque nunca se haya usado', async () => {
  const folio = await crearPedidoPrueba(cookieAdminA);
  const fila = await esperarHasta(async () => {
    const r = await notifsDe(folio);
    return r.find(f => f.repartidor_id === repA.id && f.token_aceptacion) || null;
  });
  assert.ok(fila, 'debía existir el token antes de vencerlo');
  await pool.query(`UPDATE notificaciones_repartidor SET token_expira_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [fila.id]);

  const r = await fetch(`${base}/repartidor/aceptar/${fila.token_aceptacion}`);
  assert.strictEqual(r.status, 409, 'un token vencido debe rechazarse aunque nunca se haya consumido');
});

await t('TOKEN-INVALIDO', 'un token que nunca existió se rechaza sin lanzar', async () => {
  const r = await fetch(`${base}/repartidor/aceptar/esto-nunca-fue-un-token-real`);
  assert.strictEqual(r.status, 409, 'un token inexistente debe rechazarse con 409, nunca 500');
});

// ═══════════ PEDIDO-VENCIDO: el pedido ya no está disponible cuando se usa el token ═══════════
await t('PEDIDO-VENCIDO', 'si el pedido ya fue entregado/cancelado antes de usar el token, la asignación falla sin corromper nada', async () => {
  const folio = await crearPedidoPrueba(cookieAdminA);
  const fila = await esperarHasta(async () => {
    const r = await notifsDe(folio);
    return r.find(f => f.repartidor_id === repA.id && f.token_aceptacion) || null;
  });
  assert.ok(fila, 'debía existir el token antes de vencer el pedido');

  // El pedido se entrega/cancela por otra vía ANTES de que se use el enlace
  // (p. ej. el negocio lo entregó por mostrador, o se canceló).
  await pool.query(`UPDATE pedidos_activos SET estado = 'cancelado' WHERE folio = $1`, [folio]);

  const r = await fetch(`${base}/repartidor/aceptar/${fila.token_aceptacion}`);
  assert.strictEqual(r.status, 409, 'un pedido ya no disponible debe rechazar la aceptación (409), nunca asignarlo');

  const { rows: [pedidoDB] } = await pool.query(`SELECT datos->>'repartidor_id' AS rid, estado FROM pedidos_activos WHERE folio = $1`, [folio]);
  assert.strictEqual(pedidoDB.rid, null, 'el pedido cancelado nunca debe quedar asignado a un repartidor');
  assert.strictEqual(pedidoDB.estado, 'cancelado', 'el estado del pedido no debe alterarse por el intento de aceptación');

  const { rows: [notifRow] } = await pool.query(`SELECT token_usado_at FROM notificaciones_repartidor WHERE id = $1`, [fila.id]);
  assert.ok(notifRow.token_usado_at, 'el token se consume (un solo uso) aunque la asignación falle -- no debe quedar reutilizable');
});

// ═══════════ REGISTRO-FALLO: Meta rechaza el envío ═══════════
await t('REGISTRO-FALLO', 'si Meta rechaza el envío de la plantilla, se registra error_envio (nunca se pierde el intento)', async () => {
  metaMock.forzarErrorSiguienteEnvio();
  const folio = await crearPedidoPrueba(cookieAdminA);
  const fila = await esperarHasta(async () => {
    const r = await notifsDe(folio);
    const f = r.find(x => x.repartidor_id === repA.id);
    return f && f.estado !== 'pendiente' ? f : null;
  });
  assert.ok(fila, 'debía registrarse un intento aunque Meta lo rechace');
  assert.strictEqual(fila.estado, 'error_envio');
  assert.ok(fila.error_detalle, 'debe guardar el detalle del error de Meta');
});

// ═══════════ WEBHOOK-STATUS: sent -> delivered -> read, y guard de orden ═══════════
await t('WEBHOOK-STATUS', 'el webhook de status actualiza delivered y luego read, e ignora un delivered atrasado tras read', async () => {
  const folio = await crearPedidoPrueba(cookieAdminA);
  const filaInicial = await esperarHasta(async () => {
    const r = await notifsDe(folio);
    const f = r.find(x => x.repartidor_id === repA.id && x.estado === 'aceptado_meta');
    return f || null;
  });
  assert.ok(filaInicial, 'debía existir la fila aceptado_meta antes de simular el status');
  const wamid = filaInicial.wamid;

  await enviarWebhookStatus('PNID_REPART_A', wamid, 'delivered');
  const entregado = await esperarHasta(async () => {
    const r = await notifsDe(folio);
    const f = r.find(x => x.wamid === wamid);
    return f?.estado === 'entregado' ? f : null;
  });
  assert.ok(entregado, 'el estado debía pasar a entregado tras el webhook delivered');

  await enviarWebhookStatus('PNID_REPART_A', wamid, 'read');
  const leido = await esperarHasta(async () => {
    const r = await notifsDe(folio);
    const f = r.find(x => x.wamid === wamid);
    return f?.estado === 'leido' ? f : null;
  });
  assert.ok(leido, 'el estado debía pasar a leido tras el webhook read');

  // Reordenamiento de red: llega un 'delivered' viejo DESPUÉS del 'read'.
  await enviarWebhookStatus('PNID_REPART_A', wamid, 'delivered');
  await esperar(1500);
  const { rows } = await pool.query(`SELECT estado FROM notificaciones_repartidor WHERE wamid = $1`, [wamid]);
  assert.strictEqual(rows[0].estado, 'leido', 'un delivered fuera de orden tras read no debe retroceder el estado');
});

// ═══════════ WEBHOOK-STATUS-FAILED: Meta reporta falla asíncrona ═══════════
await t('WEBHOOK-STATUS-FAILED', 'el webhook de status failed marca fallido con código/detalle, y nunca retrocede después', async () => {
  const folio = await crearPedidoPrueba(cookieAdminA);
  const filaInicial = await esperarHasta(async () => {
    const r = await notifsDe(folio);
    const f = r.find(x => x.repartidor_id === repA.id && x.estado === 'aceptado_meta');
    return f || null;
  });
  assert.ok(filaInicial, 'debía existir la fila aceptado_meta antes de simular la falla');
  const wamid = filaInicial.wamid;

  await enviarWebhookStatus('PNID_REPART_A', wamid, 'failed', [{ code: 131047, title: 'Re-engagement message' }]);
  const fallido = await esperarHasta(async () => {
    const r = await notifsDe(folio);
    const f = r.find(x => x.wamid === wamid);
    return f?.estado === 'fallido' ? f : null;
  });
  assert.ok(fallido, 'el estado debía pasar a fallido tras el webhook failed');
  assert.strictEqual(fallido.error_codigo, '131047');
  assert.ok(fallido.error_detalle, 'debe guardar el título/detalle del error de Meta');

  // Un 'delivered' tardío después de failed no debe pisar el fallo real.
  await enviarWebhookStatus('PNID_REPART_A', wamid, 'delivered');
  await esperar(1500);
  const { rows } = await pool.query(`SELECT estado FROM notificaciones_repartidor WHERE wamid = $1`, [wamid]);
  assert.strictEqual(rows[0].estado, 'fallido', 'un delivered tardío nunca debe pisar un fallo ya registrado');
});

// ═══════════ FLAG-OFF: negocioB conserva el comportamiento anterior EXACTO ═══════════
await t('FLAG-OFF', 'negocioB (sin el flag de piloto) no genera ninguna fila en notificaciones_repartidor', async () => {
  const folio = await crearPedidoPrueba(cookieAdminB);
  await esperar(2000); // margen para que el fire-and-forget corra, si fuera a correr
  const filas = await notifsDe(folio, SEED.negocioB);
  assert.strictEqual(filas.length, 0, 'sin el flag activo, el envío debe seguir siendo texto libre sin registro (comportamiento previo intacto)');
});

// ═══════════ AISLAMIENTO: notificaciones_repartidor nunca se ve entre negocios ═══════════
await t('AISLAMIENTO', 'las notificaciones de negocioA son invisibles al consultarlas con negocioB', async () => {
  const folio = await crearPedidoPrueba(cookieAdminA);
  await esperarHasta(async () => {
    const r = await notifsDe(folio, SEED.negocioA);
    return r.length ? r : null;
  });
  const comoB = await notifsDe(folio, SEED.negocioB);
  assert.strictEqual(comoB.length, 0, 'notificaciones de otro negocio nunca deben ser visibles');
});

// ═══════════ ASIGNACION-ATOMICA (regresión — lógica ya existente, no tocada) ═══════════
await t('ASIGNACION-ATOMICA', 'dos repartidores intentando tomar el mismo pedido a la vez: solo uno gana', async () => {
  const folio = await crearPedidoPrueba(cookieAdminA);
  await esperar(1500); // dar tiempo a que guardarPedidoActivo persista antes de la asignación

  const { rows: [otroRep] } = await pool.query(
    `INSERT INTO repartidores (nombre, telefono, token, activo, negocio_id) VALUES ('Repartidor Prueba A2','5210000900003','tok-repart-a2',TRUE,$1)
     ON CONFLICT (telefono) DO UPDATE SET activo = TRUE RETURNING *`,
    [SEED.negocioA]
  );

  const [r1, r2] = await Promise.all([
    asignarRepartidor(folio, repA.id, repA.nombre, SEED.negocioA),
    asignarRepartidor(folio, otroRep.id, otroRep.nombre, SEED.negocioA),
  ]);
  const ganadores = [r1, r2].filter(Boolean);
  assert.strictEqual(ganadores.length, 1, 'exactamente uno de los dos intentos concurrentes debe ganar la asignación');

  const { rows: [pedidoDB] } = await pool.query(`SELECT datos->>'repartidor_id' AS rid FROM pedidos_activos WHERE folio = $1`, [folio]);
  assert.ok(pedidoDB.rid === String(repA.id) || pedidoDB.rid === String(otroRep.id), 'el pedido debe quedar asignado a exactamente uno de los dos');
});

// ═══════════ VISIBILIDAD-COMANDAS (regresión — ya existente, no tocada) ═══════════
await t('VISIBILIDAD-COMANDAS', 'tras asignar, el pedido expone repartidor_nombre para que el panel lo muestre en la comanda', async () => {
  const folio = await crearPedidoPrueba(cookieAdminA);
  await esperar(1500);
  const ok = await asignarRepartidor(folio, repA.id, repA.nombre, SEED.negocioA);
  assert.ok(ok, 'la asignación debía tener éxito (pedido recién creado, sin repartidor previo)');
  const { rows: [pedidoDB] } = await pool.query(`SELECT datos->>'repartidor_nombre' AS nombre FROM pedidos_activos WHERE folio = $1`, [folio]);
  assert.strictEqual(pedidoDB.nombre, repA.nombre, 'datos.repartidor_nombre debe reflejar quién tomó el pedido (lo que el panel ya renderiza en la comanda)');
});

// ═══════════ PILOTO-WHITELIST: filtro de lista blanca de teléfonos ═══════════
// Repartidores adicionales exclusivos de este bloque, para ejercitar el
// filtro en sí (además de repA, ya usado en el resto de la suite bajo la
// whitelist por defecto configurada en el Setup). telefono es único global
// en la tabla -- se limpia primero para que el archivo sea re-ejecutable.
const TELS_WHITELIST_BLOQUE = ['5210000900010', '5210000900011', '5210000900012', '9000900013', '5219000900013', '5210000900014'];
await pool.query(`DELETE FROM notificaciones_repartidor WHERE repartidor_id IN (SELECT id FROM repartidores WHERE telefono = ANY($1))`, [TELS_WHITELIST_BLOQUE]);
await pool.query(`DELETE FROM repartidores WHERE telefono = ANY($1)`, [TELS_WHITELIST_BLOQUE]);

async function crearRepartidorPrueba(nombre, telefono, token, activo = true) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO repartidores (nombre, telefono, token, activo, negocio_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [nombre, telefono, token, activo, SEED.negocioA]
  );
  return r;
}
const repFuera1 = await crearRepartidorPrueba('Repartidor Fuera Whitelist 1', '5210000900010', 'tok-fuera-1');
const repFuera2 = await crearRepartidorPrueba('Repartidor Fuera Whitelist 2', '5210000900011', 'tok-fuera-2');
const repEnWhitelist2 = await crearRepartidorPrueba('Repartidor En Whitelist 2', '5210000900012', 'tok-en-wl-2');
// Mismo teléfono real, dos formatos distintos (10 dígitos vs con prefijo
// 521) -- normalizarTelefonoMX debe verlos como el mismo destinatario.
const repDup1 = await crearRepartidorPrueba('Repartidor Duplicado 1', '9000900013', 'tok-dup-1');
const repDup2 = await crearRepartidorPrueba('Repartidor Duplicado 2', '5219000900013', 'tok-dup-2');
const repInactivo = await crearRepartidorPrueba('Repartidor Inactivo En Whitelist', '5210000900014', 'tok-inactivo', false);

async function fijarWhitelist(valor) {
  await actualizarConfiguracion({ repartidor_notif_piloto_telefonos: valor }, SEED.negocioA);
}

await t('PILOTO-WHITELIST', '30 registrados, solo 2 en whitelist → solo esos 2 reciben la plantilla', async () => {
  await fijarWhitelist('5210000900001,5210000900012'); // repA + repEnWhitelist2
  const folio = await crearPedidoPrueba(cookieAdminA);
  const filas = await esperarHasta(async () => {
    const r = await notifsDe(folio);
    return r.length ? r : null;
  });
  assert.ok(filas, 'debía notificarse al menos a los repartidores en whitelist');
  const idsNotificados = new Set(filas.map(f => f.repartidor_id));
  assert.strictEqual(filas.length, 2, `esperaba exactamente 2 intentos, hubo ${filas.length}`);
  assert.ok(idsNotificados.has(repA.id), 'repA (en whitelist) debía recibir la plantilla');
  assert.ok(idsNotificados.has(repEnWhitelist2.id), 'repEnWhitelist2 (en whitelist) debía recibir la plantilla');
  assert.ok(!idsNotificados.has(repFuera1.id), 'repFuera1 (fuera de whitelist) NO debía recibir nada');
  assert.ok(!idsNotificados.has(repFuera2.id), 'repFuera2 (fuera de whitelist) NO debía recibir nada');
});

await t('PILOTO-WHITELIST', 'lista vacía → 0 envíos (fail closed, nunca "a todos")', async () => {
  await fijarWhitelist('');
  const folio = await crearPedidoPrueba(cookieAdminA);
  await esperar(2000); // no hay nada que esperar a que aparezca -- se espera 0
  const filas = await notifsDe(folio);
  assert.strictEqual(filas.length, 0, 'con la lista vacía, nadie debe ser notificado (nunca fallback a todos)');
});

await t('PILOTO-WHITELIST', 'lista ilegible/mal formada → 0 envíos (fail closed)', async () => {
  await fijarWhitelist('esto no es una lista de telefonos valida');
  const folio = await crearPedidoPrueba(cookieAdminA);
  await esperar(2000);
  const filas = await notifsDe(folio);
  assert.strictEqual(filas.length, 0, 'con una lista ilegible, nadie debe ser notificado (fail closed, nunca a todos)');
});

await t('PILOTO-WHITELIST', 'el mismo teléfono en dos filas (formatos distintos) recibe un solo envío', async () => {
  await fijarWhitelist('9000900013');
  const folio = await crearPedidoPrueba(cookieAdminA);
  const filas = await esperarHasta(async () => {
    const r = await notifsDe(folio);
    return r.length ? r : null;
  });
  assert.ok(filas, 'debía notificarse al teléfono duplicado al menos una vez');
  const deLosDuplicados = filas.filter(f => f.repartidor_id === repDup1.id || f.repartidor_id === repDup2.id);
  assert.strictEqual(deLosDuplicados.length, 1, `un mismo teléfono en dos filas debe recibir un solo envío, hubo ${deLosDuplicados.length}`);
});

await t('PILOTO-WHITELIST', 'repartidor inactivo aunque esté en whitelist → no recibe', async () => {
  await fijarWhitelist('5210000900014'); // teléfono de repInactivo, único en esta lista
  const folio = await crearPedidoPrueba(cookieAdminA);
  await esperar(2000);
  const filas = await notifsDe(folio);
  assert.strictEqual(filas.length, 0, 'un repartidor inactivo nunca debe recibir la plantilla aunque su teléfono esté en la whitelist');
});

await t('PILOTO-WHITELIST', 'otro negocio con el mismo teléfono en la whitelist de este negocio → no recibe', async () => {
  // repB pertenece a negocioB. Que su teléfono termine (por error de captura)
  // en la whitelist de negocioA nunca debe hacer que reciba nada -- no
  // pertenece al roster de repartidores de negocioA (obtenerRepartidores ya
  // aísla por negocio_id antes de que el filtro de whitelist siquiera corra).
  await fijarWhitelist('5210000900001,5210000900002'); // repA (negocioA) + repB (negocioB)
  const folio = await crearPedidoPrueba(cookieAdminA);
  const filas = await esperarHasta(async () => {
    const r = await notifsDe(folio);
    return r.length ? r : null;
  });
  assert.ok(filas, 'repA debía recibir la plantilla');
  assert.ok(!filas.some(f => f.repartidor_id === repB.id), 'repB (de otro negocio) nunca debe aparecer notificado desde un pedido de negocioA');
});

await t('PILOTO-WHITELIST', 'retirar la lista (con el flag aún activo) no habilita el envío a todos', async () => {
  await fijarWhitelist(''); // "retirar el piloto" -- el flag sigue en true
  const folio = await crearPedidoPrueba(cookieAdminA);
  await esperar(2000);
  const filas = await notifsDe(folio);
  assert.strictEqual(filas.length, 0, 'sin lista, incluso con el flag activo, nadie debe recibir nada -- el rollout completo requiere una configuración explícita aparte, no implementada todavía');
});

// Deja la whitelist en el estado que el resto del archivo espera, por si se
// re-ejecuta este archivo o se agregan pruebas después.
await fijarWhitelist('5210000900001');

// ═══════════ Resumen ═══════════
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await metaMock.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
