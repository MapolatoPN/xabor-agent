// Incidencia real (piloto de notificaciones a repartidores, Nonna Maye,
// 2026-08-04): un teléfono registrado como repartidor quedaba
// permanentemente interceptado por el flujo de repartidor en
// whatsapp-meta.js -- la sola existencia de la fila en `repartidores`
// (sin importar `activo`, intención del mensaje, o sesión) mandaba
// SIEMPRE el link de repartidor.html, salvo la frase exacta "entregué".
// "Quiero hacer un pedido" nunca llegaba al bot de cliente.
//
// Esta suite cubre el fix: enrutarMensajeRepartidor (whatsapp-meta.js) +
// modo_actual (migración 034) -- máquina de estados con prioridades
// explícitas (acción de reparto activo > comando de repartidor >
// intención de cliente > modo_actual persistido), nunca exclusivo por rol.
//
// Uso: mismas env vars que el resto de la batería. Requiere
// aplicar-migraciones.mjs y seed-datos-prueba.mjs ya corridos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4187';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, crearUsuarioConPassword, asignarRepartidor } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════ Setup ═══════════
const PNID_A = 'PNID_ENRUTAMIENTO_A';
const PNID_B = 'PNID_ENRUTAMIENTO_B';
await pool.query(`UPDATE negocios SET bot_whatsapp_activo = TRUE WHERE id = ANY($1)`, [[SEED.negocioA, SEED.negocioB]]);
await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE identificador = ANY($1))`, [[PNID_A, PNID_B]]);
await pool.query(`DELETE FROM integraciones_canal WHERE identificador = ANY($1)`, [[PNID_A, PNID_B]]);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,'Enrutamiento A', TRUE)`, [SEED.negocioA, PNID_A]);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,'Enrutamiento B', TRUE)`, [SEED.negocioB, PNID_B]);
await pool.query(
  `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'pos','activo')
   ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`,
  [SEED.negocioA]
);
const cookieAdminA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: SEED.negocioA, rol: 'admin' }))}`;

const metaMock = await arrancarMetaMock();
const anthropicMock = await arrancarAnthropicMock();
const srv = await arrancarServidor({ PORT: PUERTO, META_GRAPH_BASE_URL: metaMock.baseUrl, ANTHROPIC_BASE_URL: anthropicMock.baseUrl }, { timeoutMs: 30000 });

async function simularWebhook(phoneNumberId, telefono, texto, wamid, nombreMeta = 'Cliente Prueba Enrutamiento') {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: phoneNumberId },
      messages: [{ type: 'text', from: telefono, id: wamid || ('wamid.ENRUTAMIENTO-' + Date.now() + Math.random()), text: { body: texto } }],
      contacts: [{ profile: { name: nombreMeta } }],
    } }] }],
  };
  await fetch(srv.base + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  await esperar(400); // margen para el procesamiento inmediato (guardar, marcar leído, enrutar)
}

async function ultimoSaliente(telefono) {
  const { rows } = await pool.query(
    `SELECT texto FROM mensajes WHERE telefono = $1 AND direccion = 'saliente' ORDER BY id DESC LIMIT 1`,
    [telefono]
  );
  return rows[0]?.texto || null;
}

async function crearRepartidorPrueba(nombre, telefono, negocioId, { modo = 'sin_modo' } = {}) {
  await pool.query(`DELETE FROM repartidores WHERE telefono = $1`, [telefono]);
  const { rows: [rep] } = await pool.query(
    `INSERT INTO repartidores (nombre, telefono, token, activo, negocio_id, modo_actual)
     VALUES ($1,$2,$3,TRUE,$4,$5) RETURNING *`,
    [nombre, telefono, 'tok-enrutamiento-' + telefono, negocioId, modo]
  );
  return rep;
}

async function modoActualDe(repartidorId) {
  const { rows } = await pool.query(`SELECT modo_actual FROM repartidores WHERE id = $1`, [repartidorId]);
  return rows[0]?.modo_actual;
}

// Crea un pedido REAL (vía /test/pedido -- registrarPedido/emitirPedido,
// puebla memoria Y base) y lo asigna a `repartidor` con la asignación
// atómica ya existente. Necesario para cualquier caso que dependa de
// actualizarEstadoPedido (opera sobre el arreglo en memoria de
// orderManager.js, no solo la tabla pedidos_activos) -- un INSERT directo
// a la tabla no es suficiente, como sí lo es para lecturas puras
// (obtenerPedidosAsignadosARepartidor consulta la tabla directamente).
async function crearPedidoActivoAsignado(repartidor) {
  const r = await fetch(srv.base + '/test/pedido', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Cookie': cookieAdminA } });
  const { pedido } = await r.json();
  // registrarPedido/emitirPedido son fire-and-forget -- dar margen a que la
  // fila exista en pedidos_activos antes de asignar (mismo patrón que
  // fase-repartidores-notificaciones.mjs).
  await esperar(1500);
  const ok = await asignarRepartidor(pedido.id, repartidor.id, repartidor.nombre, SEED.negocioA);
  if (!ok) throw new Error(`asignarRepartidor falló para ${pedido.id}`);
  return pedido.id;
}

// Espera a que el mock de Anthropic reciba una llamada (confirma que el
// mensaje SÍ llegó al bot de cliente vía encolarMensaje/procesarConClaude,
// que debounce 6s antes de disparar).
async function esperarLlamadaAnthropic(pendientesAntes, { timeoutMs = 9000 } = {}) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    if (anthropicMock.pendientes() < pendientesAntes) return true;
    await esperar(300);
  }
  return false;
}

// Admin de negocioB (para el caso "administrador que también compra" no se
// necesita sesión -- WhatsApp no usa sesión de panel -- pero se reutiliza
// el patrón de otras suites por si se necesita más adelante).
await crearUsuarioConPassword({
  negocioId: SEED.negocioB, nombre: 'Admin Enrutamiento B', email: 'admin-b-enrutamiento@test.local',
  password: 'ClaveAdminBPrueba123!', rol: 'admin',
}).catch(() => {}); // idempotente si ya existe de otra suite

// ═══════════ 1. NUMERO-SOLO-CLIENTE ═══════════
await t('NUMERO-SOLO-CLIENTE', 'un teléfono nunca registrado como repartidor llega al bot de cliente con normalidad', async () => {
  const tel = '878101001';
  anthropicMock.encolarRespuesta('¡Hola! Claro, ¿qué te gustaría ordenar?');
  const pendientesAntes = anthropicMock.pendientes() + 1; // se acaba de encolar una
  await simularWebhook(PNID_A, tel, 'hola quiero un pedido');
  const llego = await esperarLlamadaAnthropic(pendientesAntes);
  assert.ok(llego, 'un cliente normal (nunca repartidor) debía llegar al bot de IA');
});

// ═══════════ 2. NUMERO-SOLO-REPARTIDOR ═══════════
await t('NUMERO-SOLO-REPARTIDOR', '"disponible" desde un repartidor que nunca ha actuado como cliente entra a modo repartidor (nunca llega a IA)', async () => {
  const rep = await crearRepartidorPrueba('Repartidor Solo', '878102001', SEED.negocioA);
  await simularWebhook(PNID_A, rep.telefono, 'disponible');
  const saliente = await ultimoSaliente(rep.telefono);
  assert.ok(saliente?.includes('repartidor.html'), 'debía recibir el link de repartidor.html');
  assert.strictEqual(await modoActualDe(rep.id), 'repartidor');
});

// ═══════════ 3. MISMO-NUMERO-CLIENTE-Y-REPARTIDOR ═══════════
await t('MISMO-NUMERO-AMBOS', 'el mismo teléfono que acaba de usar "disponible" puede luego pedir como cliente sin re-registrarse', async () => {
  const tel = '878102001'; // mismo de la prueba anterior, ya en modo_actual='repartidor'
  anthropicMock.encolarRespuesta('Perfecto, ¿qué te gustaría pedir?');
  const pendientesAntes = anthropicMock.pendientes() + 1;
  await simularWebhook(PNID_A, tel, 'quiero hacer un pedido');
  const llego = await esperarLlamadaAnthropic(pendientesAntes);
  assert.ok(llego, 'la intención de cliente debía ganar aunque el modo previo fuera repartidor');
  const { rows } = await pool.query(`SELECT id FROM repartidores WHERE telefono = $1`, [tel]);
  assert.strictEqual(await modoActualDe(rows[0].id), 'cliente', 'modo_actual debía quedar en cliente tras la intención explícita');
});

// ═══════════ 4. INTENCION-CLIENTE-GANA-CON-REPARTO-ACTIVO ═══════════
await t('INTENCION-CLIENTE-GANA', '"quiero hacer un pedido" llega a IA aunque el repartidor tenga un servicio activo asignado', async () => {
  const rep = await crearRepartidorPrueba('Repartidor Con Activo', '878104001', SEED.negocioA);
  await crearPedidoActivoAsignado(rep);
  anthropicMock.encolarRespuesta('Claro, dime qué te gustaría ordenar.');
  const pendientesAntes = anthropicMock.pendientes() + 1;
  await simularWebhook(PNID_A, rep.telefono, 'quiero hacer un pedido');
  const llego = await esperarLlamadaAnthropic(pendientesAntes);
  assert.ok(llego, 'la intención de cliente debía ganar incluso con un reparto activo asignado');
});

// ═══════════ 5. MODO-REPARTIDOR-CAMBIA-CONTEXTO ═══════════
await t('MODO-REPARTIDOR-CAMBIA-CONTEXTO', '"Modo repartidor" (con mayúscula) fija modo_actual=repartidor y el siguiente mensaje neutro ya no llega a IA', async () => {
  const rep = await crearRepartidorPrueba('Repartidor Modo', '878105001', SEED.negocioA, { modo: 'cliente' });
  await simularWebhook(PNID_A, rep.telefono, 'Modo repartidor');
  assert.strictEqual(await modoActualDe(rep.id), 'repartidor');
  const saliente1 = await ultimoSaliente(rep.telefono);
  assert.ok(saliente1?.includes('repartidor.html'), 'debía confirmar la entrada a modo repartidor con el link');

  await simularWebhook(PNID_A, rep.telefono, 'hola');
  const saliente2 = await ultimoSaliente(rep.telefono);
  assert.ok(saliente2?.includes('repartidor.html'), 'un mensaje neutro en modo repartidor debía seguir dando el link, no llegar a IA');
});

// ═══════════ 6. SALIR-MODO-REPARTIDOR-RESTAURA-CLIENTE ═══════════
await t('SALIR-MODO-REPARTIDOR', '"salir de modo repartidor" restaura el flujo de cliente para mensajes neutros posteriores', async () => {
  const rep = await crearRepartidorPrueba('Repartidor Sale', '878106001', SEED.negocioA, { modo: 'repartidor' });
  await simularWebhook(PNID_A, rep.telefono, 'salir de modo repartidor');
  assert.strictEqual(await modoActualDe(rep.id), 'cliente');
  const saliente1 = await ultimoSaliente(rep.telefono);
  assert.ok(saliente1?.toLowerCase().includes('saliste del modo repartidor'), 'debía confirmar la salida del modo repartidor');

  anthropicMock.encolarRespuesta('¡Hola! ¿En qué te puedo ayudar?');
  const pendientesAntes = anthropicMock.pendientes() + 1;
  await simularWebhook(PNID_A, rep.telefono, 'hola');
  const llego = await esperarLlamadaAnthropic(pendientesAntes);
  assert.ok(llego, 'tras salir de modo repartidor, un mensaje neutro debía llegar a IA');
});

// ═══════════ 7. REPARTIDOR-SERVICIO-ACTIVO-ENTREGA (regresión) ═══════════
await t('SERVICIO-ACTIVO-ENTREGA', '"ya entregué" con un pedido activo asignado lo marca entregado -- sin tocar el flujo de asignación', async () => {
  const rep = await crearRepartidorPrueba('Repartidor Entrega', '878107001', SEED.negocioA);
  const folio = await crearPedidoActivoAsignado(rep);
  await simularWebhook(PNID_A, rep.telefono, 'ya entregué');
  const { rows: [pedidoDB] } = await pool.query(`SELECT estado FROM pedidos_activos WHERE folio = $1`, [folio]);
  assert.strictEqual(pedidoDB.estado, 'entregado');
  const saliente = await ultimoSaliente(rep.telefono);
  assert.ok(saliente?.includes('marcado como entregado'), 'debía confirmar la entrega por WhatsApp');
});

// ═══════════ 8. MENSAJE-AMBIGUO ═══════════
await t('MENSAJE-AMBIGUO', 'un mensaje neutro con reparto activo y sin modo fijado pregunta en vez de asumir', async () => {
  const rep = await crearRepartidorPrueba('Repartidor Ambiguo', '878108001', SEED.negocioA); // sin_modo
  await crearPedidoActivoAsignado(rep);
  await simularWebhook(PNID_A, rep.telefono, 'hola');
  const saliente = await ultimoSaliente(rep.telefono);
  assert.strictEqual(saliente, '¿Quieres continuar como repartidor o realizar un pedido?');
  assert.strictEqual(await modoActualDe(rep.id), 'sin_modo', 'un mensaje ambiguo no debe fijar ningún modo');
});

// ═══════════ 9. MISMO-TELEFONO-DOS-NEGOCIOS ═══════════
await t('DOS-NEGOCIOS', 'un teléfono repartidor de negocioA se trata como cliente normal al escribirle a negocioB', async () => {
  const tel = '878109001';
  await crearRepartidorPrueba('Repartidor Solo De A', tel, SEED.negocioA);
  anthropicMock.encolarRespuesta('¡Hola! Con gusto, ¿qué te gustaría ordenar?');
  const pendientesAntes = anthropicMock.pendientes() + 1;
  await simularWebhook(PNID_B, tel, 'hola quiero un pedido'); // negocioB, no negocioA
  const llego = await esperarLlamadaAnthropic(pendientesAntes);
  assert.ok(llego, 'un repartidor de negocioA nunca debe ser tratado como repartidor al escribirle a negocioB');
});

// ═══════════ 10. WEBHOOK-DUPLICADO ═══════════
await t('WEBHOOK-DUPLICADO', 'reenviar el mismo wamid de un comando de repartidor no duplica el mensaje guardado', async () => {
  const rep = await crearRepartidorPrueba('Repartidor Dedup', '878110001', SEED.negocioA);
  const wamid = 'wamid.ENRUT-DEDUP-' + Date.now();
  await simularWebhook(PNID_A, rep.telefono, 'disponible', wamid);
  await simularWebhook(PNID_A, rep.telefono, 'disponible', wamid); // mismo wamid
  const { rows } = await pool.query(`SELECT id FROM mensajes WHERE message_id_externo = $1`, [wamid]);
  assert.strictEqual(rows.length, 1, 'el mismo wamid reenviado no debe duplicar la fila en mensajes');
});

// ═══════════ 11. AISLAMIENTO-MODO-ENTRE-REPARTIDORES ═══════════
await t('AISLAMIENTO-MODO', 'cambiar el modo de un repartidor no afecta el modo de otro', async () => {
  const rep1 = await crearRepartidorPrueba('Repartidor Aislado 1', '878111001', SEED.negocioA, { modo: 'sin_modo' });
  const rep2 = await crearRepartidorPrueba('Repartidor Aislado 2', '878111002', SEED.negocioA, { modo: 'sin_modo' });
  await simularWebhook(PNID_A, rep1.telefono, 'modo repartidor');
  assert.strictEqual(await modoActualDe(rep1.id), 'repartidor');
  assert.strictEqual(await modoActualDe(rep2.id), 'sin_modo', 'el modo de rep2 no debía cambiar por una acción de rep1');
});

// ═══════════ 12. ADMIN-TAMBIEN-COMPRA (regresión) ═══════════
await t('ADMIN-TAMBIEN-COMPRA', 'un número que nunca se registró como repartidor (aunque sea admin del panel) compra con normalidad', async () => {
  const tel = '878112001'; // número de teléfono distinto al de sesión de panel -- WhatsApp nunca usa esa sesión
  anthropicMock.encolarRespuesta('¡Hola! ¿Qué te gustaría ordenar hoy?');
  const pendientesAntes = anthropicMock.pendientes() + 1;
  await simularWebhook(PNID_B, tel, 'quiero hacer un pedido');
  const llego = await esperarLlamadaAnthropic(pendientesAntes);
  assert.ok(llego, 'un administrador que escribe por WhatsApp (sin fila en repartidores) debe recibir el flujo de cliente normal');
});

// ═══════════ 13. MIS-ENTREGAS (comando adicional del contrato de enrutamiento) ═══════════
await t('MIS-ENTREGAS', '"mis entregas" lista los pedidos activos asignados sin llegar a IA', async () => {
  const rep = await crearRepartidorPrueba('Repartidor Mis Entregas', '878113001', SEED.negocioA);
  const folio = await crearPedidoActivoAsignado(rep);
  await simularWebhook(PNID_A, rep.telefono, 'mis entregas');
  const saliente = await ultimoSaliente(rep.telefono);
  assert.ok(saliente?.includes(folio), 'debía listar el folio del pedido activo asignado');
});

// ═══════════ Resumen ═══════════
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await metaMock.detener();
await anthropicMock.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
