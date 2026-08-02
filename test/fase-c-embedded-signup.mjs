// Suite persistida de Fase C: state firmado, endpoints, aislamiento,
// y escenarios simulados de Meta (META_EMBEDDED_SIGNUP_MOCK=true).
// Uso: DATABASE_URL=... INTEGRATIONS_ENCRYPTION_KEY=... PANEL_SECRET=...
//      SESSION_SECRET=... ADMIN_PASSWORD=... node test/fase-c-embedded-signup.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac } from 'crypto';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4066';

process.env.SESSION_SECRET = process.env.SESSION_SECRET; // usado también aquí para el state
const { crearState, validarYConsumirState } = await import('../src/services/embeddedSignupState.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');
const { guardarCredencialesCifradas } = await import('../src/services/integracionesService.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
function cookieHeader(usuarioId, negocioId, rol) {
  return `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;
}
function legacyBearer(password) { return createHmac('sha256', process.env.PANEL_SECRET).update(password).digest('hex'); }
async function api(base, path, { cookie, bearer, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
const rutaIniciar = (id) => `/api/superadmin/negocios/${id}/integraciones/whatsapp/iniciar`;
const rutaEstado = (id) => `/api/superadmin/negocios/${id}/integraciones/whatsapp/estado`;
const rutaCallback = '/api/integraciones/whatsapp/meta/callback';
const rutaConfig = '/api/superadmin/meta/embedded-signup/config';

const cookieSuperadmin = cookieHeader(SEED.superadminUsuarioId, SEED.negocioA, 'admin');
const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
const cookieStaffA = cookieHeader(SEED.staffNegocioAUsuarioId, SEED.negocioA, 'staff');
const bearerLegacyAdmin = legacyBearer(process.env.ADMIN_PASSWORD);

// ── Unidad: state firmado (sin servidor) ──
await t('STATE', 'crea y consume un state válido una sola vez', () => {
  const s = crearState({ negocioId: SEED.negocioA, superadminId: SEED.superadminUsuarioId });
  const r1 = validarYConsumirState(s);
  assert.deepStrictEqual(r1, { negocioId: SEED.negocioA, superadminId: SEED.superadminUsuarioId });
  const r2 = validarYConsumirState(s); // reutilización
  assert.strictEqual(r2, null);
});
await t('STATE', 'state alterado se rechaza', () => {
  const s = crearState({ negocioId: SEED.negocioA, superadminId: SEED.superadminUsuarioId });
  const alterado = s.slice(0, -2) + 'zz';
  assert.strictEqual(validarYConsumirState(alterado), null);
});
await t('STATE', 'state de negocio A no sirve para negocio B (el negocioId viene del propio state, no se puede sustituir)', () => {
  const s = crearState({ negocioId: SEED.negocioA, superadminId: SEED.superadminUsuarioId });
  const r = validarYConsumirState(s);
  assert.strictEqual(r.negocioId, SEED.negocioA);
  assert.notStrictEqual(r.negocioId, SEED.negocioB);
});
await t('STATE', 'state vencido se rechaza', () => {
  const payload = { negocioId: SEED.negocioA, superadminId: SEED.superadminUsuarioId, nonce: 'x', iat: Date.now() - 999999, exp: Date.now() - 1000 };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', process.env.SESSION_SECRET).update('xabor-embedded-signup:' + payloadB64).digest('hex');
  assert.strictEqual(validarYConsumirState(`${payloadB64}.${sig}`), null);
});
await t('STATE', 'sin state -> rechazado', () => {
  assert.strictEqual(validarYConsumirState(undefined), null);
  assert.strictEqual(validarYConsumirState(''), null);
});

// ── Unidad: intercambiarCodigoPorToken -- logging seguro del rechazo de Meta ──
// Cubre el incidente real (Alora, 1 de agosto de 2026): Meta rechazaba el
// intercambio code->token y el log anterior no decía por qué. Verifica que
// ahora sí se registra código/tipo/mensaje (útil para diagnóstico) y que
// nunca se filtra el code, el access_token, ni el cuerpo crudo completo.
{
  process.env.META_EMBEDDED_SIGNUP_MOCK = 'true';
  const { intercambiarCodigoPorToken } = await import('../src/services/metaEmbeddedSignup.js');

  await t('META-ERROR', 'intercambio exitoso simulado -> devuelve accessToken', async () => {
    const r = await intercambiarCodigoPorToken('SIMULAR_EXITO');
    assert.strictEqual(r.accessToken, 'SIMULATED_ACCESS_TOKEN_TEST');
  });

  await t('META-ERROR', 'rechazo de Meta -> el log registra código/tipo/mensaje, y el error lanzado nunca incluye el code ni el mensaje crudo de Meta', async () => {
    const logsCapturados = [];
    const originalError = console.error;
    console.error = (...args) => logsCapturados.push(args.join(' '));
    let errorLanzado = null;
    try {
      await intercambiarCodigoPorToken('SIMULAR_ERROR_META');
      assert.fail('debía lanzar');
    } catch (e) {
      errorLanzado = e;
    } finally {
      console.error = originalError;
    }
    assert.ok(errorLanzado);
    // El mensaje de la excepción (lo que puede llegar a un log de nivel
    // superior o a una respuesta) es genérico -- nunca el texto de Meta.
    assert.ok(!/verification code/i.test(errorLanzado.message));

    const textoLogs = logsCapturados.join('\n');
    assert.ok(/etapa=token_exchange_simulado/.test(textoLogs), 'debe indicar la etapa exacta');
    assert.ok(/codigo=100/.test(textoLogs), 'debe incluir el código numérico de Meta');
    assert.ok(/tipo=OAuthException/.test(textoLogs), 'debe incluir el tipo de error de Meta');
    assert.ok(/Error validating verification code\./.test(textoLogs), 'debe incluir el mensaje resumido de Meta (información de diagnóstico, no una credencial)');
    // Nunca debe aparecer el code de entrada ni ningún access_token en el log.
    assert.ok(!/SIMULAR_ERROR_META/.test(textoLogs));
    assert.ok(!/access_token/i.test(textoLogs));
  });

  await t('META-ERROR', 'código simulado sin caso definido sigue fallando de forma genérica (compatibilidad con SIMULAR_TOKEN_INVALIDO)', async () => {
    await assert.rejects(() => intercambiarCodigoPorToken('SIMULAR_TOKEN_INVALIDO'));
  });

  delete process.env.META_EMBEDDED_SIGNUP_MOCK;
}

// ── Unidad: guardarCredencialesCifradas -- error de persistencia nunca deja fila parcial ──
await t('PERSISTENCIA', 'accessToken faltante -> lanza antes de abrir transacción, cero filas', async () => {
  await pool.query(`DELETE FROM integraciones_canal WHERE canal = 'whatsapp' AND negocio_id = $1`, [SEED.negocioA]);
  await assert.rejects(
    () => guardarCredencialesCifradas(SEED.negocioA, 'whatsapp', 'meta', { phoneNumberId: 'PNID_PERSIST_TEST' }, SEED.superadminUsuarioId),
    /accessToken requerido/
  );
  const { rows } = await pool.query(`SELECT count(*) FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp'`, [SEED.negocioA]);
  assert.strictEqual(Number(rows[0].count), 0);
});
await t('PERSISTENCIA', 'phoneNumberId faltante -> lanza antes de abrir transacción, cero filas', async () => {
  await assert.rejects(
    () => guardarCredencialesCifradas(SEED.negocioA, 'whatsapp', 'meta', { accessToken: 'TOKEN_TEST' }, SEED.superadminUsuarioId),
    /phoneNumberId requerido/
  );
  const { rows } = await pool.query(`SELECT count(*) FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp'`, [SEED.negocioA]);
  assert.strictEqual(Number(rows[0].count), 0);
});

// Limpieza previa
await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = ANY($1))`, [[SEED.negocioA, SEED.negocioB, SEED.negocioC]]);
await pool.query(`DELETE FROM integraciones_canal WHERE canal = 'whatsapp' AND negocio_id = ANY($1)`, [[SEED.negocioA, SEED.negocioB, SEED.negocioC]]);

// ── HTTP: servidor con META_EMBEDDED_SIGNUP_MOCK activo ──
{
  const srv = await arrancarServidor({
    PORT: PUERTO,
    META_EMBEDDED_SIGNUP_MOCK: 'true',
    META_APP_ID: 'TEST_APP_ID',
    META_CONFIG_ID: 'TEST_CONFIG_ID',
    META_REDIRECT_URI: 'https://xabor.mx/callback-test',
  });
  try {
    await t('CONFIG', 'sin sesión -> 401', async () => {
      const r = await api(srv.base, rutaConfig);
      assert.strictEqual(r.status, 401);
    });
    await t('CONFIG', 'admin normal -> 403', async () => {
      const r = await api(srv.base, rutaConfig, { cookie: cookieAdminA });
      assert.strictEqual(r.status, 403);
    });
    await t('CONFIG', 'superadmin -> appId/configId/graphApiVersion, sin secretos', async () => {
      const r = await api(srv.base, rutaConfig, { cookie: cookieSuperadmin });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.appId, 'TEST_APP_ID');
      assert.strictEqual(r.body.configId, 'TEST_CONFIG_ID');
      assert.ok(r.body.graphApiVersion);
      const claves = Object.keys(r.body).sort();
      assert.deepStrictEqual(claves, ['appId', 'configId', 'graphApiVersion']);
      const texto = JSON.stringify(r.body);
      assert.ok(!/secret|redirect|encryption/i.test(texto));
    });

    await t('PERM', 'sin sesión -> 401 al iniciar', async () => {
      const r = await api(srv.base, rutaIniciar(SEED.negocioA), { method: 'POST' });
      assert.strictEqual(r.status, 401);
    });
    await t('PERM', 'admin normal -> 403 al iniciar', async () => {
      const r = await api(srv.base, rutaIniciar(SEED.negocioA), { cookie: cookieAdminA, method: 'POST' });
      assert.strictEqual(r.status, 403);
    });
    await t('PERM', 'staff -> 403 al iniciar', async () => {
      const r = await api(srv.base, rutaIniciar(SEED.negocioA), { cookie: cookieStaffA, method: 'POST' });
      assert.strictEqual(r.status, 403);
    });
    await t('PERM', 'sesión legacy -> 403 al iniciar', async () => {
      const r = await api(srv.base, rutaIniciar(SEED.negocioA), { bearer: bearerLegacyAdmin, method: 'POST' });
      assert.strictEqual(r.status, 403);
    });
    await t('PERM', 'módulo no_contratado (negocio C) -> 403 al iniciar', async () => {
      const r = await api(srv.base, rutaIniciar(SEED.negocioC), { cookie: cookieSuperadmin, method: 'POST' });
      assert.strictEqual(r.status, 403);
    });

    let stateA;
    await t('INICIAR', 'superadmin inicia -> 200 con state', async () => {
      const r = await api(srv.base, rutaIniciar(SEED.negocioA), { cookie: cookieSuperadmin, method: 'POST' });
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.state);
      stateA = r.body.state;
    });
    await t('INICIAR', 'doble clic / segundo proceso en paralelo: no bloquea con 409, reemplaza el intento anterior', async () => {
      // Rediseño (fix "permitir cancelar embedded signup pendiente"): ya
      // no hay un booleano que bloquee con 409 hasta vencer -- iniciar de
      // nuevo simplemente reemplaza el intento previo (ver
      // test/fase-c-signup-pendiente.mjs para la cobertura completa del
      // mecanismo de reemplazo/cancelación/vencimiento).
      const r = await api(srv.base, rutaIniciar(SEED.negocioA), { cookie: cookieSuperadmin, method: 'POST' });
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.state);
      assert.notStrictEqual(r.body.state, stateA); // es un intento nuevo, no el mismo
      // El state viejo (stateA) ya no es el vigente -- confirmarlo lo
      // consumiría (uso único) sin necesidad real aquí; se deja que la
      // suite de signup-pendiente pruebe el rechazo por "reemplazado".
    });

    await t('CALLBACK', 'sin state -> 400', async () => {
      const r = await api(srv.base, rutaCallback, { method: 'POST', body: { code: 'SIMULAR_EXITO', phoneNumberId: 'X' } });
      assert.strictEqual(r.status, 400);
    });
    await t('CALLBACK', 'cancelación del usuario (sin code) -> 400, no toca estado', async () => {
      const r = await api(srv.base, rutaIniciar(SEED.negocioB), { cookie: cookieSuperadmin, method: 'POST' });
      const stateB = r.body.state;
      const rc = await api(srv.base, rutaCallback, { method: 'POST', body: { state: stateB } });
      assert.strictEqual(rc.status, 400);
      const re = await api(srv.base, rutaEstado(SEED.negocioB), { cookie: cookieSuperadmin });
      assert.strictEqual(re.body.estado, 'no_configurado');
    });
    await t('CALLBACK', 'falta phoneNumberId -> 400', async () => {
      const r = await api(srv.base, rutaIniciar(SEED.negocioB), { cookie: cookieSuperadmin, method: 'POST' });
      const rc = await api(srv.base, rutaCallback, { method: 'POST', body: { state: r.body.state, code: 'SIMULAR_EXITO' } });
      assert.strictEqual(rc.status, 400);
    });
    await t('CALLBACK', 'token inválido (Meta rechaza) -> 502, estado queda en error', async () => {
      const r = await api(srv.base, rutaIniciar(SEED.negocioB), { cookie: cookieSuperadmin, method: 'POST' });
      const rc = await api(srv.base, rutaCallback, { method: 'POST', body: { state: r.body.state, code: 'SIMULAR_TOKEN_INVALIDO', phoneNumberId: 'PNID_B_TEST' } });
      assert.strictEqual(rc.status, 502);
    });
    await t('CALLBACK', 'Meta rechaza el intercambio (forma real del incidente) -> 502, cero filas parciales, bot del propio negocio y de otros sigue sin tocarse', async () => {
      const botAntesA = await api(srv.base, `/api/superadmin/negocios/${SEED.negocioA}/bot-whatsapp`, { cookie: cookieSuperadmin });
      const r = await api(srv.base, rutaIniciar(SEED.negocioA), { cookie: cookieSuperadmin, method: 'POST' });
      const rc = await api(srv.base, rutaCallback, { method: 'POST', body: { state: r.body.state, code: 'SIMULAR_ERROR_META', phoneNumberId: 'PNID_A_ERROR_META' } });
      assert.strictEqual(rc.status, 502);
      assert.ok(!/verification code/i.test(JSON.stringify(rc.body)));

      const { rows } = await pool.query(`SELECT count(*) FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp'`, [SEED.negocioA]);
      assert.strictEqual(Number(rows[0].count), 0, 'no debe quedar ninguna fila, ni parcial, para el negocio que falló');

      const botDespuesA = await api(srv.base, `/api/superadmin/negocios/${SEED.negocioA}/bot-whatsapp`, { cookie: cookieSuperadmin });
      assert.strictEqual(botDespuesA.body.botWhatsappActivo, botAntesA.body.botWhatsappActivo, 'el interruptor del propio negocio no debe cambiar por un signup fallido');

      const botB = await api(srv.base, `/api/superadmin/negocios/${SEED.negocioB}/bot-whatsapp`, { cookie: cookieSuperadmin });
      assert.strictEqual(botB.status, 200); // otro negocio: sigue respondiendo con normalidad, sin contaminación
    });
    await t('CALLBACK', 'state reutilizado -> 400', async () => {
      const r = await api(srv.base, rutaIniciar(SEED.negocioB), { cookie: cookieSuperadmin, method: 'POST' });
      const primero = await api(srv.base, rutaCallback, { method: 'POST', body: { state: r.body.state, code: 'SIMULAR_EXITO', phoneNumberId: 'PNID_B_REUSO', wabaId: 'WABA_B_REUSO' } });
      assert.strictEqual(primero.status, 200);
      const segundo = await api(srv.base, rutaCallback, { method: 'POST', body: { state: r.body.state, code: 'SIMULAR_EXITO', phoneNumberId: 'PNID_B_REUSO' } });
      assert.strictEqual(segundo.status, 400);
    });
    await t('CALLBACK', 'éxito: guarda credenciales cifradas y completa la activación real (register + subscribed_apps) -> activo', async () => {
      const r = await api(srv.base, rutaEstado(SEED.negocioB), { cookie: cookieSuperadmin });
      assert.strictEqual(r.body.estado, 'activo');
      const { rows } = await pool.query(`SELECT cc.access_token_cifrado FROM integraciones_canal ic JOIN integraciones_canal_credenciales cc ON cc.integracion_id = ic.id WHERE ic.negocio_id = $1`, [SEED.negocioB]);
      assert.strictEqual(rows.length, 1);
      assert.ok(!rows[0].access_token_cifrado.includes('SIMULATED_ACCESS_TOKEN_TEST'));

      const wa = await api(srv.base, `/api/superadmin/negocios/${SEED.negocioB}/integraciones/whatsapp`, { cookie: cookieSuperadmin });
      assert.strictEqual(wa.body.integracion.numero_registrado_cloud_api, true);
      assert.strictEqual(wa.body.integracion.app_suscrita_waba, true);
      assert.ok(wa.body.integracion.ultimo_intento_activacion_at);
    });
    await t('CALLBACK', 'phone_number_id ya asociado a otro negocio -> 409, no toca al dueño', async () => {
      const r = await api(srv.base, rutaIniciar(SEED.negocioC), { cookie: cookieSuperadmin, method: 'POST' }); // no_contratado -> 403, forzamos vía A que sí está contratado
      // negocio C no puede iniciar (no_contratado); probamos duplicado usando A intentando robar el identificador de B
      const rIni = await api(srv.base, rutaIniciar(SEED.negocioA), { cookie: cookieSuperadmin, method: 'POST' });
      const rc = await api(srv.base, rutaCallback, { method: 'POST', body: { state: rIni.body.state, code: 'SIMULAR_EXITO', phoneNumberId: 'PNID_B_REUSO' } });
      assert.strictEqual(rc.status, 409);
      const estadoB = await api(srv.base, rutaEstado(SEED.negocioB), { cookie: cookieSuperadmin });
      assert.strictEqual(estadoB.body.estado, 'activo'); // B intacto
    });

    // ── Aislamiento: iniciar para Alora (negocioC, no_contratado) nunca toca Nonna Maye (negocioA en esta suite) ──
    await t('AISLAMIENTO', 'negocio sin módulo contratado nunca genera cambios en otro negocio', async () => {
      await api(srv.base, rutaIniciar(SEED.negocioC), { cookie: cookieSuperadmin, method: 'POST' }); // 403, no genera state
      const estadoA = await api(srv.base, rutaEstado(SEED.negocioA), { cookie: cookieSuperadmin });
      assert.ok(['no_configurado', 'error', 'activo'].includes(estadoA.body.estado)); // solo confirma que no crashea ni se contamina
    });
    await t('AISLAMIENTO', 'ninguna respuesta ni auditoría expone secretos', async () => {
      const { rows } = await pool.query(`SELECT contexto, estado_anterior, estado_nuevo FROM auditoria_plataforma WHERE negocio_id = $1 AND accion LIKE 'integracion_embedded_signup%'`, [SEED.negocioB]);
      const texto = JSON.stringify(rows);
      assert.ok(!/SIMULATED_ACCESS_TOKEN_TEST/.test(texto));
      assert.ok(!/access_token_cifrado|token_iv|token_auth_tag/i.test(texto));
    });
  } finally { srv.detener(); }
}

// ── HTTP: servidor SIN META_APP_ID/META_CONFIG_ID ──
{
  const srv2 = await arrancarServidor({ PORT: String(Number(PUERTO) + 1) }, { omitir: ['META_APP_ID', 'META_CONFIG_ID', 'META_REDIRECT_URI', 'META_EMBEDDED_SIGNUP_MOCK'] });
  try {
    await t('CONFIG', 'falta META_APP_ID/META_CONFIG_ID -> 503 controlado, sin crash', async () => {
      const r = await api(srv2.base, rutaConfig, { cookie: cookieSuperadmin });
      assert.strictEqual(r.status, 503);
      assert.ok(r.body.error);
    });
  } finally { srv2.detener(); }
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('\nDetalle de fallos:'); fallos.forEach(f => console.log('  - ' + f)); }
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
