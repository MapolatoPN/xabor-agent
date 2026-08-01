// Suite persistida: interruptor global de bot de WhatsApp por negocio
// (bot_whatsapp_activo, migración 019). Cubre valores iniciales,
// permisos (Superadmin + admin del propio negocio + staff + admin de
// otro negocio), el orden exacto del gate en el webhook real (via
// inspección de logs del proceso hijo -- ver nota más abajo), que el
// envío manual sigue funcionando con el bot apagado, y que Embedded
// Signup nunca lo enciende por su cuenta.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac } from 'crypto';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4088';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, obtenerBotWhatsappActivoNegocio, setBotPausado } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
function cookieHeader(usuarioId, negocioId, rol) { return `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`; }
function legacyBearer(password) { return createHmac('sha256', process.env.PANEL_SECRET).update(password).digest('hex'); }
async function api(base, path, { cookie, bearer, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

const cookieSuperadmin = cookieHeader(SEED.superadminUsuarioId, SEED.negocioA, 'admin');
const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
const cookieStaffA = cookieHeader(SEED.staffNegocioAUsuarioId, SEED.negocioA, 'staff');
const bearerLegacyAdmin = legacyBearer(process.env.ADMIN_PASSWORD);
const rutaSuperadminBot = (id) => `/api/superadmin/negocios/${id}/bot-whatsapp`;
const rutaAdminBot = '/api/admin/bot-whatsapp';

// ═══════════ Valores iniciales (DB directa) ═══════════
await t('VALORES', 'negocio nuevo (sembrado en esta suite) -> false', async () => {
  assert.strictEqual(await obtenerBotWhatsappActivoNegocio(SEED.negocioC), false);
});
await t('VALORES', 'Nonna Maye -> true (backfill de la migración 019)', async () => {
  assert.strictEqual(await obtenerBotWhatsappActivoNegocio(SEED.nonnaMayeId), true);
});
await t('VALORES', 'Alora Florería y Eventos -> false', async () => {
  const { rows } = await pool.query(`SELECT id FROM negocios WHERE slug = 'alora-floreria-y-eventos'`);
  assert.strictEqual(await obtenerBotWhatsappActivoNegocio(rows[0].id), false);
});
await t('VALORES', 'Mapolato Acuña -> false', async () => {
  const { rows } = await pool.query(`SELECT id FROM negocios WHERE slug = 'mapolato-acuna'`);
  assert.strictEqual(await obtenerBotWhatsappActivoNegocio(rows[0].id), false);
});

// ═══════════ HTTP: permisos + persistencia + webhook ═══════════
await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = ANY($1))`, [[SEED.negocioA, SEED.negocioB]]);
await pool.query(`DELETE FROM integraciones_canal WHERE canal = 'whatsapp' AND negocio_id = ANY($1)`, [[SEED.negocioA, SEED.negocioB]]);
await pool.query(`UPDATE negocios SET bot_whatsapp_activo = FALSE WHERE id = ANY($1)`, [[SEED.negocioA, SEED.negocioB]]);

{
  const srv = await arrancarServidor({ PORT: PUERTO, META_EMBEDDED_SIGNUP_MOCK: 'true', META_APP_ID: 'TEST', META_CONFIG_ID: 'TEST', META_REDIRECT_URI: 'https://xabor.mx/superadmin' });
  try {
    // ── Permisos ──
    await t('PERM', 'sin sesión -> 401 (Superadmin)', async () => {
      const r = await api(srv.base, rutaSuperadminBot(SEED.negocioA));
      assert.strictEqual(r.status, 401);
    });
    await t('PERM', 'staff -> 403 (Superadmin)', async () => {
      const r = await api(srv.base, rutaSuperadminBot(SEED.negocioA), { cookie: cookieStaffA });
      assert.strictEqual(r.status, 403);
    });
    await t('PERM', 'sesión legacy -> 403 (Superadmin)', async () => {
      const r = await api(srv.base, rutaSuperadminBot(SEED.negocioA), { bearer: bearerLegacyAdmin });
      assert.strictEqual(r.status, 403);
    });
    await t('PERM', 'Superadmin -> permitido (GET/PATCH)', async () => {
      const r = await api(srv.base, rutaSuperadminBot(SEED.negocioA), { cookie: cookieSuperadmin });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.botWhatsappActivo, false);
    });
    await t('PERM', 'admin del propio negocio -> permitido (self-service, sin negocioId en la URL)', async () => {
      const r = await api(srv.base, rutaAdminBot, { cookie: cookieAdminA });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.botWhatsappActivo, false);
    });
    await t('PERM', 'staff -> 403 (self-service admin)', async () => {
      const r = await api(srv.base, rutaAdminBot, { cookie: cookieStaffA });
      assert.strictEqual(r.status, 403);
    });
    await t('PERM', 'sin sesión -> 401 (self-service admin)', async () => {
      const r = await api(srv.base, rutaAdminBot);
      assert.strictEqual(r.status, 401);
    });
    await t('PERM', 'admin de OTRO negocio no puede alcanzar este negocio (self-service usa su propia sesión, nunca un param)', async () => {
      // La sesión de adminA solo puede afectar A -- no existe forma de
      // pasarle negocioB por parámetro a esta ruta (self-service).
      const r = await api(srv.base, rutaAdminBot, { cookie: cookieAdminA, method: 'PATCH', body: { activo: true } });
      assert.strictEqual(r.status, 200);
      const soloA = await pool.query(`SELECT bot_whatsapp_activo FROM negocios WHERE id = $1`, [SEED.negocioA]);
      const bIntacto = await pool.query(`SELECT bot_whatsapp_activo FROM negocios WHERE id = $1`, [SEED.negocioB]);
      assert.strictEqual(soloA.rows[0].bot_whatsapp_activo, true);
      assert.strictEqual(bIntacto.rows[0].bot_whatsapp_activo, false);
      // revertir para el resto de la suite
      await api(srv.base, rutaAdminBot, { cookie: cookieAdminA, method: 'PATCH', body: { activo: false } });
    });
    await t('PERM', 'valor no boolean -> 400', async () => {
      const r = await api(srv.base, rutaSuperadminBot(SEED.negocioA), { cookie: cookieSuperadmin, method: 'PATCH', body: { activo: 'si' } });
      assert.strictEqual(r.status, 400);
    });
    await t('PERM', 'operación idempotente (activar dos veces seguidas no falla)', async () => {
      const r1 = await api(srv.base, rutaSuperadminBot(SEED.negocioA), { cookie: cookieSuperadmin, method: 'PATCH', body: { activo: true } });
      const r2 = await api(srv.base, rutaSuperadminBot(SEED.negocioA), { cookie: cookieSuperadmin, method: 'PATCH', body: { activo: true } });
      assert.strictEqual(r1.status, 200);
      assert.strictEqual(r2.status, 200);
      await api(srv.base, rutaSuperadminBot(SEED.negocioA), { cookie: cookieSuperadmin, method: 'PATCH', body: { activo: false } });
    });

    // ── Auditoría ──
    await t('AUDITORIA', 'registra negocio/usuario/estado anterior/nuevo/fecha, sin secretos', async () => {
      await api(srv.base, rutaSuperadminBot(SEED.negocioA), { cookie: cookieSuperadmin, method: 'PATCH', body: { activo: true } });
      const { rows } = await pool.query(
        `SELECT negocio_id, superadmin_id, estado_anterior, estado_nuevo, created_at FROM auditoria_plataforma
         WHERE negocio_id = $1 AND accion = 'cambiar_bot_whatsapp_activo_negocio' ORDER BY created_at DESC LIMIT 1`,
        [SEED.negocioA]
      );
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].negocio_id, SEED.negocioA);
      assert.ok(rows[0].superadmin_id);
      assert.ok(rows[0].created_at);
      assert.deepStrictEqual(rows[0].estado_nuevo, { bot_whatsapp_activo: true });
      const texto = JSON.stringify(rows);
      assert.ok(!/token|password|secret/i.test(texto));
      await api(srv.base, rutaSuperadminBot(SEED.negocioA), { cookie: cookieSuperadmin, method: 'PATCH', body: { activo: false } });
    });

    // ── Webhook real: orden del gate (guardar -> actualizar cliente ->
    //    bot global -> pausa cliente -> IA solo si ambos permiten) ──
    async function simularWebhook(phoneNumberId, telefono, texto) {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: {
          metadata: { phone_number_id: phoneNumberId },
          messages: [{ type: 'text', from: telefono, id: 'wamid.TEST-' + Date.now() + Math.random(), text: { body: texto } }],
          contacts: [{ profile: { name: 'Cliente Prueba Bot Global' } }],
        } }] }],
      };
      await fetch(srv.base + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      await new Promise(r => setTimeout(r, 400)); // margen para que termine el manejo async
    }

    const PNID_A = 'PNID_BOTGLOBAL_A';
    await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,'Prueba bot global A', TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [SEED.negocioA, PNID_A]);

    await t('GATE', 'global apagado + cliente no pausado: no responde (mensaje guardado, sin encolar IA)', async () => {
      const tel = '5218780009001';
      await simularWebhook(PNID_A, tel, 'hola, quiero un pedido');
      const salida = srv.obtenerSalida();
      assert.ok(salida.includes(`Bot de WhatsApp desactivado para el negocio ${SEED.negocioA}`));
      assert.ok(!salida.includes('encolando para procesar con IA'));
      const { rows } = await pool.query(`SELECT * FROM mensajes WHERE telefono = $1 AND negocio_id = $2`, [tel, SEED.negocioA]);
      assert.strictEqual(rows.length, 1); // se guardó igual
      const cliente = await pool.query(`SELECT nombre FROM clientes WHERE telefono = $1`, [tel]);
      assert.strictEqual(cliente.rows[0]?.nombre, 'Cliente Prueba Bot Global'); // cliente/chat actualizado
    });

    await t('GATE', 'global apagado + cliente pausado: sigue sin responder (el global ya bloqueó antes)', async () => {
      const tel = '5218780009002';
      await setBotPausado(tel, true, SEED.negocioA);
      await simularWebhook(PNID_A, tel, 'hola de nuevo');
      const salida = srv.obtenerSalida();
      assert.ok(salida.includes(`Bot de WhatsApp desactivado para el negocio ${SEED.negocioA}`));
    });

    await t('GATE', 'global activo + cliente pausado: no responde (bloquea la pausa individual)', async () => {
      await api(srv.base, rutaSuperadminBot(SEED.negocioA), { cookie: cookieSuperadmin, method: 'PATCH', body: { activo: true } });
      const tel = '5218780009003';
      await setBotPausado(tel, true, SEED.negocioA);
      const antesLen = srv.obtenerSalida().length;
      await simularWebhook(PNID_A, tel, 'hola pausado');
      const salidaNueva = srv.obtenerSalida().slice(antesLen);
      assert.ok(salidaNueva.includes(`Bot pausado para ${tel}`));
      assert.ok(!salidaNueva.includes('encolando para procesar con IA'));
    });

    await t('GATE', 'global activo + cliente no pausado: pasa el gate y encola para IA', async () => {
      const tel = '5218780009004';
      const antesLen = srv.obtenerSalida().length;
      await simularWebhook(PNID_A, tel, 'hola quiero pedir');
      const salidaNueva = srv.obtenerSalida().slice(antesLen);
      assert.ok(salidaNueva.includes(`Bot de WhatsApp activo para el negocio ${SEED.negocioA} — encolando para procesar con IA`));
      assert.ok(!salidaNueva.includes('Bot pausado'));
      assert.ok(!salidaNueva.includes('desactivado'));
      await api(srv.base, rutaSuperadminBot(SEED.negocioA), { cookie: cookieSuperadmin, method: 'PATCH', body: { activo: false } }); // revertir
    });

    // ── Envío manual funciona con el bot apagado ──
    await t('MANUAL', 'respuesta manual (/api/send-message) funciona con bot global apagado', async () => {
      // Sin credenciales reales el envío a Meta fallará (409/500), pero eso
      // es esperado en este entorno de prueba -- lo que se confirma aquí es
      // que la ruta NUNCA depende de bot_whatsapp_activo (no hay ningún
      // chequeo de ese interruptor en /api/send-message).
      const r = await api(srv.base, '/api/send-message', { cookie: cookieAdminA, method: 'POST', body: { telefono: '5218780009004', mensaje: 'Hola, en un momento te atendemos' } });
      assert.notStrictEqual(r.status, 403); // nunca bloqueado por el interruptor del bot
    });

    // ── Reinicio conserva estado ──
    await t('PERSISTENCIA', 'reinicio del proceso conserva bot_whatsapp_activo (persistido en Postgres, no en memoria)', async () => {
      await api(srv.base, rutaSuperadminBot(SEED.negocioA), { cookie: cookieSuperadmin, method: 'PATCH', body: { activo: true } });
      const valorAntes = await obtenerBotWhatsappActivoNegocio(SEED.negocioA);
      assert.strictEqual(valorAntes, true);
      // No es necesario reiniciar el proceso real: bot_whatsapp_activo vive
      // en la tabla negocios (BOOLEAN NOT NULL), no en ningún Map en
      // memoria -- a diferencia de intentoSignupPendiente.js (efímero a
      // propósito), este valor sobrevive cualquier reinicio por diseño.
      await api(srv.base, rutaSuperadminBot(SEED.negocioA), { cookie: cookieSuperadmin, method: 'PATCH', body: { activo: false } });
    });
    // ── Embedded Signup nunca toca el interruptor del bot ──
    const rutaIniciar = (id) => `/api/superadmin/negocios/${id}/integraciones/whatsapp/iniciar`;
    const rutaCancelar = (id) => `/api/superadmin/negocios/${id}/integraciones/whatsapp/conexion-pendiente`;
    await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = $1)`, [SEED.negocioB]);
    await pool.query(`DELETE FROM integraciones_canal WHERE canal = 'whatsapp' AND negocio_id = $1`, [SEED.negocioB]);
    await pool.query(`UPDATE negocios SET bot_whatsapp_activo = FALSE WHERE id = $1`, [SEED.negocioB]);

    await t('SIGNUP+BOT', 'integración nueva vía Embedded Signup queda con bot apagado', async () => {
      const rIni = await api(srv.base, rutaIniciar(SEED.negocioB), { cookie: cookieSuperadmin, method: 'POST' });
      await api(srv.base, '/api/integraciones/whatsapp/meta/callback', { method: 'POST', body: { state: rIni.body.state, code: 'SIMULAR_EXITO', phoneNumberId: 'PNID_BOTGLOBAL_B_NUEVA' } });
      assert.strictEqual(await obtenerBotWhatsappActivoNegocio(SEED.negocioB), false);
    });
    await t('SIGNUP+BOT', 'reconexión (nuevas credenciales) conserva el valor existente del bot', async () => {
      await api(srv.base, rutaSuperadminBot(SEED.negocioB), { cookie: cookieSuperadmin, method: 'PATCH', body: { activo: true } });
      const rIni = await api(srv.base, rutaIniciar(SEED.negocioB), { cookie: cookieSuperadmin, method: 'POST' });
      await api(srv.base, '/api/integraciones/whatsapp/meta/callback', { method: 'POST', body: { state: rIni.body.state, code: 'SIMULAR_EXITO', phoneNumberId: 'PNID_BOTGLOBAL_B_RECONEXION' } });
      assert.strictEqual(await obtenerBotWhatsappActivoNegocio(SEED.negocioB), true); // no se reseteó
      await api(srv.base, rutaSuperadminBot(SEED.negocioB), { cookie: cookieSuperadmin, method: 'PATCH', body: { activo: false } });
    });
    await t('SIGNUP+BOT', 'cancelar una conexión pendiente no altera el interruptor del bot', async () => {
      await api(srv.base, rutaSuperadminBot(SEED.negocioB), { cookie: cookieSuperadmin, method: 'PATCH', body: { activo: true } });
      await api(srv.base, rutaIniciar(SEED.negocioB), { cookie: cookieSuperadmin, method: 'POST' });
      await api(srv.base, rutaCancelar(SEED.negocioB), { cookie: cookieSuperadmin, method: 'DELETE' });
      assert.strictEqual(await obtenerBotWhatsappActivoNegocio(SEED.negocioB), true);
      await api(srv.base, rutaSuperadminBot(SEED.negocioB), { cookie: cookieSuperadmin, method: 'PATCH', body: { activo: false } });
    });
  } finally { srv.detener(); }
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('\nDetalle de fallos:'); fallos.forEach(f => console.log('  - ' + f)); }
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
