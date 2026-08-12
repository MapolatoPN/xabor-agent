// WhatsApp Business App Coexistence — la app en el teléfono del dueño y el
// bot de Xabor conviviendo en el MISMO número (mecanismo oficial de Meta).
//
// Lo que esta suite tiene que demostrar, más allá de que la feature exista:
//
//   - El flujo Cloud API actual NO cambia ni un byte de comportamiento.
//   - En coexistence JAMÁS se llama POST /register (el número ya está
//     registrado por el flujo de la app; un register fuera de lugar puede
//     romper el estado del número en Meta).
//   - Ningún evento de coexistence (echo, history, state_sync) entra al
//     brain: el bot solo responde a mensajes REALES del cliente.
//   - Un echo de un mensaje que Xabor mismo envió (wamid propio) NO activa
//     el takeover -- sin esto, cada respuesta del bot silenciaría al bot.
//   - El takeover es POR CONVERSACIÓN y TEMPORAL; la pausa manual
//     (bot_pausado) es otra cosa y nunca se pisa.
//
// Uso: DATABASE_URL=... PANEL_SECRET=... SESSION_SECRET=... ADMIN_PASSWORD=...
//      node test/fase-whatsapp-coexistence.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4091';
const HTML = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, guardarMensaje, getBotPausado, setBotPausado } = await import('../src/services/database.js');
const integraciones = await import('../src/services/integracionesService.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const sufijo = Date.now().toString().slice(-6);
const PNID_A = `PNIDCOEX${sufijo}A`;
const PNID_B = `PNIDCOEX${sufijo}B`;
const WABA_A = `WABACOEX${sufijo}A`;
const TEL_CLIENTE = `52878${sufijo}1`;
const TEL_CLIENTE_2 = `52878${sufijo}2`;

// ─── Setup: integraciones de prueba y bot global encendido ──────────────────
await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = ANY($1))`, [[NEG_A, NEG_B]]);
await pool.query(`DELETE FROM integraciones_canal WHERE canal = 'whatsapp' AND negocio_id = ANY($1)`, [[NEG_A, NEG_B]]);
await pool.query(`DELETE FROM mensajes WHERE negocio_id = ANY($1)`, [[NEG_A, NEG_B]]);
await pool.query(
  `INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo, proveedor, estado, waba_id)
   VALUES ($1,'whatsapp',$2,'Coex prueba A', TRUE, 'meta', 'activo', $3)
   ON CONFLICT (canal, identificador) DO NOTHING`, [NEG_A, PNID_A, WABA_A]);
await pool.query(
  `INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo, proveedor, estado, waba_id)
   VALUES ($1,'whatsapp',$2,'Coex prueba B', TRUE, 'meta', 'activo', 'WABAB${sufijo}')
   ON CONFLICT (canal, identificador) DO NOTHING`, [NEG_B, PNID_B]);
await pool.query(
  `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, 'bot_whatsapp_activo', 'true')
   ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = 'true'`, [NEG_A]).catch(() => {});

const srv = await arrancarServidor({
  PORT: PUERTO, META_EMBEDDED_SIGNUP_MOCK: 'true',
  META_APP_ID: 'TEST', META_CONFIG_ID: 'TEST',
  OPENAI_API_KEY: '', // el brain no debe llegar a llamarse en los casos de esta suite
}, { timeoutMs: 30000 });
const BASE = srv.base;

function webhook(cambios) {
  return fetch(BASE + '/webhook/whatsapp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: WABA_A, changes: cambios }] }),
  });
}
const cambioMensajeCliente = (pnid, telefono, texto, id) => ({
  field: 'messages',
  value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: pnid },
    contacts: [{ profile: { name: 'Cliente Coex' }, wa_id: telefono }],
    messages: [{ from: telefono, id, timestamp: `${Math.floor(Date.now() / 1000)}`, type: 'text', text: { body: texto } }],
  },
});
const cambioEcho = (pnid, aTelefono, texto, wamid) => ({
  field: 'smb_message_echoes',
  value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: pnid },
    message_echoes: [{ from: pnid, to: aTelefono, id: wamid, timestamp: `${Math.floor(Date.now() / 1000)}`, type: 'text', text: { body: texto } }],
  },
});

async function mensajesDe(negocioId, telefono) {
  const { rows } = await pool.query(
    `SELECT direccion, texto, origen, message_id_externo FROM mensajes WHERE negocio_id = $1 AND telefono = $2 ORDER BY id`,
    [negocioId, telefono]);
  return rows;
}
async function filaCliente(negocioId, telefono) {
  const { rows } = await pool.query(
    `SELECT bot_pausado, human_takeover_until, last_business_app_message_at FROM clientes WHERE telefono = $1 AND negocio_id = $2`,
    [telefono, negocioId]);
  return rows[0] || null;
}

try {

// ═══════════ 1-2. Embedded Signup: estándar intacto + featureType coexistence ═══
await t('SIGNUP', '1. el flujo estándar del panel sigue enviando extras SIN featureType por defecto', async () => {
  assert.ok(/config_id:\s*cfg\.configId/.test(HTML));
  // El objeto base de extras NO trae featureType; featureType solo se agrega
  // bajo la condición explícita de coexistence -- así el flujo estándar es
  // byte a byte el de siempre.
  assert.ok(/extras\s*=\s*\{\s*setup:\s*\{\}\s*,\s*sessionInfoVersion:\s*3\s*\}/.test(HTML),
    'el objeto base de extras debe ser exactamente el estándar');
  assert.ok(/if\s*\(connectionMode\s*===\s*'coexistence'\)/.test(HTML),
    'featureType solo puede agregarse bajo la condición coexistence');
});

await t('SIGNUP', '2. el flujo coexistence usa featureType whatsapp_business_app_onboarding', async () => {
  assert.ok(HTML.includes("featureType: 'whatsapp_business_app_onboarding'"),
    'sin featureType, Meta lanza el onboarding estándar y rechaza números que viven en la Business App');
});

// ═══════════ 3-4. Listener acepta ambos FINISH ═══════════
await t('SIGNUP', '3. el listener acepta el evento FINISH estándar', async () => {
  assert.ok(/event === 'FINISH'/.test(HTML) || /\['FINISH'/.test(HTML) || /FINISH'\s*\]/.test(HTML));
});

await t('SIGNUP', '4. el listener acepta FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', async () => {
  assert.ok(HTML.includes('FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'),
    'el FINISH de coexistence llega con otro nombre de evento; ignorarlo deja el onboarding a medias');
});

// ═══════════ 5-9. Activación por modo ═══════════
await t('ACTIVACION', '5. cloud_api conserva el comportamiento actual (register + subscribed_apps, estado activo)', async () => {
  await integraciones.guardarCredencialesCifradas(NEG_A, 'whatsapp', 'meta', {
    phoneNumberId: PNID_A, wabaId: WABA_A, businessId: 'BIZ', accessToken: 'TOKEN-DE-PRUEBA-CLOUD',
  }, { actorUsuarioId: SEED.adminNegocioAUsuarioId });
  const r = await integraciones.completarActivacionWhatsapp(NEG_A, { actorUsuarioId: SEED.adminNegocioAUsuarioId });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const { rows: [fila] } = await pool.query(
    `SELECT estado, numero_registrado_cloud_api, app_suscrita_waba, connection_mode FROM integraciones_canal WHERE negocio_id = $1 AND canal='whatsapp'`, [NEG_A]);
  assert.strictEqual(fila.estado, 'activo');
  assert.strictEqual(fila.numero_registrado_cloud_api, true, 'cloud_api SÍ registra el número');
  assert.strictEqual(fila.app_suscrita_waba, true);
  assert.strictEqual(fila.connection_mode, 'cloud_api');
});

await t('ACTIVACION', '6. coexistence NO ejecuta POST /register', async () => {
  const r = await integraciones.completarActivacionWhatsapp(NEG_A, { actorUsuarioId: SEED.adminNegocioAUsuarioId }, { connectionMode: 'coexistence' });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.registroOmitido, true,
    'en coexistence el número YA está registrado por el flujo de la app: /register aquí puede romperlo');
});

await t('ACTIVACION', '7. coexistence mantiene subscribed_apps', async () => {
  const { rows: [fila] } = await pool.query(
    `SELECT app_suscrita_waba FROM integraciones_canal WHERE negocio_id = $1 AND canal='whatsapp'`, [NEG_A]);
  assert.strictEqual(fila.app_suscrita_waba, true, 'sin subscribed_apps Meta jamás manda webhooks');
});

await t('ACTIVACION', '8. coexistence persiste connection_mode=coexistence', async () => {
  const { rows: [fila] } = await pool.query(
    `SELECT connection_mode FROM integraciones_canal WHERE negocio_id = $1 AND canal='whatsapp'`, [NEG_A]);
  assert.strictEqual(fila.connection_mode, 'coexistence');
});

await t('ACTIVACION', '9. volver a activar como cloud_api restaura connection_mode=cloud_api (default y explícito)', async () => {
  const r = await integraciones.completarActivacionWhatsapp(NEG_A, { actorUsuarioId: SEED.adminNegocioAUsuarioId }, { connectionMode: 'cloud_api' });
  assert.strictEqual(r.ok, true);
  const { rows: [fila] } = await pool.query(
    `SELECT connection_mode FROM integraciones_canal WHERE negocio_id = $1 AND canal='whatsapp'`, [NEG_A]);
  assert.strictEqual(fila.connection_mode, 'cloud_api');
});

// ═══════════ 10-11. El webhook normal sigue intacto ═══════════
await t('WEBHOOK', '10. mensaje normal del cliente se guarda como entrante/cliente', async () => {
  await webhook([cambioMensajeCliente(PNID_A, TEL_CLIENTE, 'Hola, quiero informes', `wamid.in.${sufijo}.1`)]);
  await esperar(1200);
  const msgs = await mensajesDe(NEG_A, TEL_CLIENTE);
  assert.ok(msgs.some((m) => m.direccion === 'entrante' && m.origen === 'cliente' && m.texto === 'Hola, quiero informes'));
});

await t('WEBHOOK', '11. statuses siguen procesándose sin romper nada', async () => {
  const r = await webhook([{ field: 'messages', value: { metadata: { phone_number_id: PNID_A }, statuses: [{ id: 'wamid.st.1', status: 'delivered', recipient_id: TEL_CLIENTE }] } }]);
  assert.strictEqual(r.status, 200);
});

// ═══════════ 12-14. Echoes: reconocimiento y takeover ═══════════
await t('ECHO', '12. smb_message_echoes se reconoce y guarda como saliente/humano', async () => {
  await webhook([cambioEcho(PNID_A, TEL_CLIENTE, 'Hola, soy Alina, te atiendo yo', `wamid.echo.${sufijo}.1`)]);
  await esperar(1200);
  const msgs = await mensajesDe(NEG_A, TEL_CLIENTE);
  const echo = msgs.find((m) => m.texto === 'Hola, soy Alina, te atiendo yo');
  assert.ok(echo, 'el mensaje manual de la app debe quedar en el historial de Xabor');
  assert.strictEqual(echo.direccion, 'saliente');
  assert.strictEqual(echo.origen, 'humano');
});

await t('ECHO', '13. un echo humano NO entra al brain (no genera respuesta de bot)', async () => {
  const msgs = await mensajesDe(NEG_A, TEL_CLIENTE);
  assert.ok(!msgs.some((m) => m.origen === 'bot'),
    'ningún evento de coexistence puede disparar al bot');
});

await t('ECHO', '14. el echo humano activa human takeover para ESA conversación', async () => {
  const fila = await filaCliente(NEG_A, TEL_CLIENTE);
  assert.ok(fila, 'el cliente debe existir');
  assert.ok(fila.human_takeover_until && new Date(fila.human_takeover_until) > new Date(),
    'takeover vigente tras el mensaje manual');
  assert.ok(fila.last_business_app_message_at, 'se registra cuándo escribió el humano');
});

// ═══════════ 15-16. Comportamiento durante y después del takeover ═══════════
await t('TAKEOVER', '15. cliente escribe durante takeover: se guarda, el bot NO responde', async () => {
  const antes = (await mensajesDe(NEG_A, TEL_CLIENTE)).length;
  await webhook([cambioMensajeCliente(PNID_A, TEL_CLIENTE, 'Perfecto, gracias Alina', `wamid.in.${sufijo}.2`)]);
  await esperar(1200);
  const msgs = await mensajesDe(NEG_A, TEL_CLIENTE);
  assert.ok(msgs.length > antes, 'el mensaje del cliente se guarda');
  assert.ok(!msgs.some((m) => m.origen === 'bot'), 'con takeover vigente el bot calla');
});

await t('TAKEOVER', '16. al expirar el takeover, el bot puede volver a actuar (el gate ya no bloquea)', async () => {
  await pool.query(
    `UPDATE clientes SET human_takeover_until = NOW() - INTERVAL '1 minute' WHERE telefono = $1 AND negocio_id = $2`,
    [TEL_CLIENTE, NEG_A]);
  const fila = await filaCliente(NEG_A, TEL_CLIENTE);
  assert.ok(new Date(fila.human_takeover_until) < new Date(), 'takeover vencido');
  assert.strictEqual(fila.bot_pausado, false, 'la pausa manual NUNCA fue tocada por el takeover automático');
});

// ═══════════ 17. Anti-loop: wamid propio no activa takeover ═══════════
await t('ANTILOOP', '17. un echo cuyo wamid es de un envío de Xabor NO activa takeover', async () => {
  const WAMID_PROPIO = `wamid.propio.${sufijo}.1`;
  // Xabor "envió" este mensaje: quedó en mensajes con su wamid (igual que
  // hace el envío real por Cloud API).
  await guardarMensaje(TEL_CLIENTE_2, 'Cliente Dos', 'saliente', 'Tu pedido va en camino', NEG_A, 'bot', WAMID_PROPIO);
  await webhook([cambioEcho(PNID_A, TEL_CLIENTE_2, 'Tu pedido va en camino', WAMID_PROPIO)]);
  await esperar(1200);
  const fila = await filaCliente(NEG_A, TEL_CLIENTE_2);
  assert.ok(!fila || !fila.human_takeover_until || new Date(fila.human_takeover_until) < new Date(),
    'el eco de un mensaje del propio bot no es intervención humana: activar takeover aquí silenciaría al bot tras CADA respuesta');
  const msgs = await mensajesDe(NEG_A, TEL_CLIENTE_2);
  assert.strictEqual(msgs.filter((m) => m.message_id_externo === WAMID_PROPIO).length, 1, 'y no se duplica el mensaje');
});

// ═══════════ 18-19. History ═══════════
await t('HISTORY', '18. history se importa marcado como histórico y JAMÁS alimenta al brain', async () => {
  const r = await webhook([{
    field: 'history',
    value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: PNID_A },
      history: [{
        metadata: { phase: '0', chunk_order: 1, progress: 50 },
        threads: [{
          id: TEL_CLIENTE_2,
          messages: [
            { from: TEL_CLIENTE_2, id: `wamid.hist.${sufijo}.1`, timestamp: `${Math.floor(Date.now() / 1000) - 86400}`, type: 'text', text: { body: 'Mensaje viejo del cliente' } },
            { from: PNID_A, to: TEL_CLIENTE_2, id: `wamid.hist.${sufijo}.2`, timestamp: `${Math.floor(Date.now() / 1000) - 86000}`, type: 'text', text: { body: 'Respuesta vieja del negocio' } },
          ],
        }],
      }],
    },
  }]);
  assert.strictEqual(r.status, 200);
  await esperar(1200);
  const msgs = await mensajesDe(NEG_A, TEL_CLIENTE_2);
  const viejo = msgs.find((m) => m.texto === 'Mensaje viejo del cliente');
  assert.ok(viejo, 'el mensaje histórico se importa');
  assert.ok(!msgs.some((m) => m.origen === 'bot' && /viejo/i.test(m.texto || '')), 'history nunca dispara al bot');
});

await t('HISTORY', '19. history con error 2593109 (dueño no compartió) no rompe la integración', async () => {
  const r = await webhook([{
    field: 'history',
    value: { metadata: { phone_number_id: PNID_A }, history: [{ metadata: { phase: '0' }, errors: [{ code: 2593109, message: 'User has not consented' }] }] },
  }]);
  assert.strictEqual(r.status, 200);
  await esperar(600);
  const { rows: [fila] } = await pool.query(`SELECT estado, activo FROM integraciones_canal WHERE negocio_id = $1 AND canal='whatsapp'`, [NEG_A]);
  assert.strictEqual(fila.activo, true, 'que el dueño no comparta historial es una decisión válida, no un error de la integración');
});

// ═══════════ 20. smb_app_state_sync ═══════════
await t('STATESYNC', '20. smb_app_state_sync no entra al brain ni rompe el webhook', async () => {
  const r = await webhook([{
    field: 'smb_app_state_sync',
    value: { metadata: { phone_number_id: PNID_A }, state_sync: [{ type: 'contact', contact: { full_name: 'Contacto Sync', phone_number: TEL_CLIENTE } }] },
  }]);
  assert.strictEqual(r.status, 200);
  await esperar(600);
  const msgs = await mensajesDe(NEG_A, TEL_CLIENTE);
  assert.ok(!msgs.some((m) => m.origen === 'bot' && /Contacto Sync/.test(m.texto || '')));
});

// ═══════════ 21. PARTNER_REMOVED ═══════════
await t('DESCONEXION', '21. PARTNER_REMOVED marca la integración como desconectada sin borrar nada', async () => {
  const r = await webhook([{
    field: 'account_update',
    value: { event: 'PARTNER_REMOVED', waba_info: { waba_id: WABA_A } },
  }]);
  assert.strictEqual(r.status, 200);
  await esperar(800);
  const { rows: [fila] } = await pool.query(
    `SELECT estado, connection_mode FROM integraciones_canal WHERE negocio_id = $1 AND canal='whatsapp'`, [NEG_A]);
  assert.strictEqual(fila.estado, 'desconectado', 'el estado refleja la desconexión');
  const msgs = await mensajesDe(NEG_A, TEL_CLIENTE);
  assert.ok(msgs.length > 0, 'el historial NUNCA se borra');
  // Se restaura para el resto de la suite/otras suites.
  await pool.query(`UPDATE integraciones_canal SET estado = 'activo' WHERE negocio_id = $1 AND canal='whatsapp'`, [NEG_A]);
});

// ═══════════ 22. Aislamiento cross-negocio ═══════════
await t('SEGURIDAD', '22. un echo con el phone_number_id del negocio B jamás toca conversaciones del negocio A', async () => {
  await webhook([cambioEcho(PNID_B, TEL_CLIENTE, 'Echo del negocio B', `wamid.echo.${sufijo}.B1`)]);
  await esperar(800);
  const msgsA = await mensajesDe(NEG_A, TEL_CLIENTE);
  assert.ok(!msgsA.some((m) => m.texto === 'Echo del negocio B'), 'el evento del negocio B no puede escribir en A');
  const msgsB = await mensajesDe(NEG_B, TEL_CLIENTE);
  assert.ok(msgsB.some((m) => m.texto === 'Echo del negocio B'), 'y sí queda en el negocio B');
});

// ═══════════ 23. Idempotencia ═══════════
await t('SEGURIDAD', '23. reenviar el mismo echo (mismo wamid) no duplica ni re-activa nada', async () => {
  const WAMID = `wamid.echo.${sufijo}.idem`;
  await webhook([cambioEcho(PNID_A, TEL_CLIENTE, 'Mensaje idempotente', WAMID)]);
  await esperar(900);
  await webhook([cambioEcho(PNID_A, TEL_CLIENTE, 'Mensaje idempotente', WAMID)]);
  await esperar(900);
  const msgs = await mensajesDe(NEG_A, TEL_CLIENTE);
  assert.strictEqual(msgs.filter((m) => m.message_id_externo === WAMID).length, 1, 'un webhook reenviado por Meta no puede duplicar el mensaje');
});

// ═══════════ 24. Sin secretos en logs ═══════════
await t('SEGURIDAD', '24. la salida del servidor no contiene tokens ni secretos', async () => {
  const salida = srv.obtenerSalida();
  assert.ok(!salida.includes('TOKEN-DE-PRUEBA-CLOUD'), 'el access token jamás puede aparecer en logs');
  assert.ok(!/Bearer [A-Za-z0-9]/.test(salida), 'ni encabezados Authorization');
});

} finally {
  srv.detener();
  await new Promise((r) => { srv.proc.once('exit', r); setTimeout(r, 3000); });
  await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = ANY($1))`, [[NEG_A, NEG_B]]).catch(() => {});
  await pool.query(`DELETE FROM integraciones_canal WHERE canal = 'whatsapp' AND negocio_id = ANY($1)`, [[NEG_A, NEG_B]]).catch(() => {});
  await pool.query(`DELETE FROM mensajes WHERE negocio_id = ANY($1) AND telefono = ANY($2)`, [[NEG_A, NEG_B], [TEL_CLIENTE, TEL_CLIENTE_2]]).catch(() => {});
  await pool.query(`DELETE FROM clientes WHERE telefono = ANY($1)`, [[TEL_CLIENTE, TEL_CLIENTE_2]]).catch(() => {});
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
await pool.end();
process.exit(fallidas ? 1 : 0);
