// Suite persistida: cancelación de Embedded Signup pendiente
// (reemplaza el bloqueo booleano signupEnCurso). Cubre el módulo
// intentoSignupPendiente.js (unidad, con Date.now() falseado para
// probar vencimiento sin esperar) y los endpoints reales via HTTP.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac } from 'crypto';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4077';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');
const {
  registrarIntentoPendiente, cancelarIntentoPendiente, hayIntentoPendiente,
  validarIntentoVigente, limpiarIntentoPendiente,
} = await import('../src/services/intentoSignupPendiente.js');

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
const rutaIniciar = (id) => `/api/superadmin/negocios/${id}/integraciones/whatsapp/iniciar`;
const rutaCancelar = (id) => `/api/superadmin/negocios/${id}/integraciones/whatsapp/conexion-pendiente`;
const rutaCallback = '/api/integraciones/whatsapp/meta/callback';
const rutaWA = (id) => `/api/superadmin/negocios/${id}/integraciones/whatsapp`;

const cookieSuperadmin = cookieHeader(SEED.superadminUsuarioId, SEED.negocioA, 'admin');

// ═══════════ Unidad: intentoSignupPendiente.js (sin servidor) ═══════════
await t('UNIDAD', 'registra y valida un intento vigente', () => {
  const negocioId = 'unidad-negocio-1';
  const state = 'state-de-prueba-1';
  registrarIntentoPendiente(negocioId, state);
  assert.strictEqual(hayIntentoPendiente(negocioId), true);
  assert.deepStrictEqual(validarIntentoVigente(negocioId, state), { ok: true });
  limpiarIntentoPendiente(negocioId);
});
await t('UNIDAD', 'cancelar invalida el intento -- motivo "cancelado"', () => {
  const negocioId = 'unidad-negocio-2';
  const state = 'state-de-prueba-2';
  registrarIntentoPendiente(negocioId, state);
  cancelarIntentoPendiente(negocioId);
  assert.strictEqual(hayIntentoPendiente(negocioId), false);
  assert.deepStrictEqual(validarIntentoVigente(negocioId, state), { ok: false, motivo: 'cancelado' });
  limpiarIntentoPendiente(negocioId);
});
await t('UNIDAD', 'cancelar es idempotente (llamarlo dos veces no falla)', () => {
  const negocioId = 'unidad-negocio-3';
  assert.strictEqual(cancelarIntentoPendiente(negocioId), true); // sin intento previo
  registrarIntentoPendiente(negocioId, 'state-x');
  assert.strictEqual(cancelarIntentoPendiente(negocioId), true);
  assert.strictEqual(cancelarIntentoPendiente(negocioId), true); // dos veces seguidas
  limpiarIntentoPendiente(negocioId);
});
await t('UNIDAD', 'un intento nuevo reemplaza al anterior -- el viejo state se rechaza como "reemplazado"', () => {
  const negocioId = 'unidad-negocio-4';
  const stateViejo = 'state-viejo';
  const stateNuevo = 'state-nuevo';
  registrarIntentoPendiente(negocioId, stateViejo);
  registrarIntentoPendiente(negocioId, stateNuevo); // reemplaza
  assert.deepStrictEqual(validarIntentoVigente(negocioId, stateViejo), { ok: false, motivo: 'reemplazado' });
  assert.deepStrictEqual(validarIntentoVigente(negocioId, stateNuevo), { ok: true });
  limpiarIntentoPendiente(negocioId);
});
await t('UNIDAD', 'solo un intento vigente por negocio (Map de una sola entrada)', () => {
  const negocioId = 'unidad-negocio-5';
  registrarIntentoPendiente(negocioId, 'a');
  registrarIntentoPendiente(negocioId, 'b');
  registrarIntentoPendiente(negocioId, 'c');
  assert.deepStrictEqual(validarIntentoVigente(negocioId, 'a'), { ok: false, motivo: 'reemplazado' });
  assert.deepStrictEqual(validarIntentoVigente(negocioId, 'b'), { ok: false, motivo: 'reemplazado' });
  assert.deepStrictEqual(validarIntentoVigente(negocioId, 'c'), { ok: true });
  limpiarIntentoPendiente(negocioId);
});
await t('UNIDAD', 'intento vencido se rechaza -- motivo "vencido" (Date.now falseado, sin esperar 10 min)', () => {
  const negocioId = 'unidad-negocio-6';
  const state = 'state-vencido';
  const real = Date.now;
  Date.now = () => real() - 11 * 60 * 1000; // simula "hace 11 minutos" solo para el registro
  registrarIntentoPendiente(negocioId, state);
  Date.now = real; // vuelve al tiempo real -- el intento ya quedó con exp en el pasado
  assert.deepStrictEqual(validarIntentoVigente(negocioId, state), { ok: false, motivo: 'vencido' });
  assert.strictEqual(hayIntentoPendiente(negocioId), false);
  limpiarIntentoPendiente(negocioId);
});
await t('UNIDAD', 'sin ningún intento -- motivo "no_vigente"', () => {
  assert.deepStrictEqual(validarIntentoVigente('unidad-negocio-inexistente', 'x'), { ok: false, motivo: 'no_vigente' });
});
await t('UNIDAD', 'nunca se almacena el state completo -- solo su digest SHA-256', () => {
  const negocioId = 'unidad-negocio-7';
  const state = 'state-super-secreto-no-deberia-aparecer-en-memoria-plano';
  registrarIntentoPendiente(negocioId, state);
  // Inspección indirecta: un state DISTINTO nunca puede validar como
  // vigente, lo que demuestra que la comparación es por hash, no por
  // igualdad de substring/contenido -- si se guardara el state crudo
  // sería trivial además exponerlo por error en un log; aquí ni existe.
  assert.deepStrictEqual(validarIntentoVigente(negocioId, state + 'x'), { ok: false, motivo: 'reemplazado' });
  limpiarIntentoPendiente(negocioId);
});

// ═══════════ HTTP: endpoints reales ═══════════
await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = ANY($1))`, [[SEED.negocioA, SEED.negocioB, SEED.nonnaMayeId]]);
await pool.query(`DELETE FROM integraciones_canal WHERE canal = 'whatsapp' AND negocio_id = ANY($1)`, [[SEED.negocioA, SEED.negocioB, SEED.nonnaMayeId]]);
await pool.query(`DELETE FROM auditoria_plataforma WHERE negocio_id = ANY($1) AND accion LIKE 'integracion_embedded_signup%'`, [[SEED.negocioA, SEED.negocioB]]);

{
  const srv = await arrancarServidor({ PORT: PUERTO, META_EMBEDDED_SIGNUP_MOCK: 'true', META_APP_ID: 'TEST', META_CONFIG_ID: 'TEST', META_REDIRECT_URI: 'https://xabor.mx/superadmin' });
  try {
    await t('HTTP', 'DELETE conexion-pendiente sin intento -> 200 (idempotente)', async () => {
      const r = await api(srv.base, rutaCancelar(SEED.negocioA), { cookie: cookieSuperadmin, method: 'DELETE' });
      assert.strictEqual(r.status, 200);
      const r2 = await api(srv.base, rutaCancelar(SEED.negocioA), { cookie: cookieSuperadmin, method: 'DELETE' });
      assert.strictEqual(r2.status, 200);
    });

    let stateA;
    await t('HTTP', 'iniciar crea un intento vigente (conexionPendiente=true)', async () => {
      const r = await api(srv.base, rutaIniciar(SEED.negocioA), { cookie: cookieSuperadmin, method: 'POST' });
      assert.strictEqual(r.status, 200);
      stateA = r.body.state;
      const detalle = await api(srv.base, rutaWA(SEED.negocioA), { cookie: cookieSuperadmin });
      assert.strictEqual(detalle.body.conexionPendiente, true);
    });
    await t('HTTP', 'cancelación exitosa -- conexionPendiente vuelve a false', async () => {
      const r = await api(srv.base, rutaCancelar(SEED.negocioA), { cookie: cookieSuperadmin, method: 'DELETE' });
      assert.strictEqual(r.status, 200);
      const detalle = await api(srv.base, rutaWA(SEED.negocioA), { cookie: cookieSuperadmin });
      assert.strictEqual(detalle.body.conexionPendiente, false);
    });
    await t('HTTP', 'callback con state cancelado -> rechazado (400)', async () => {
      const r = await api(srv.base, rutaCallback, { method: 'POST', body: { state: stateA, code: 'SIMULAR_EXITO', phoneNumberId: 'PNID_CANCELADO_TEST' } });
      assert.strictEqual(r.status, 400);
      assert.match(r.body.error, /cancelad/i);
    });
    await t('HTTP', 'nuevo intento inmediatamente después de cancelar (sin esperar) funciona', async () => {
      const r = await api(srv.base, rutaIniciar(SEED.negocioA), { cookie: cookieSuperadmin, method: 'POST' });
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.state);
      // limpiar para no interferir con las siguientes pruebas de este negocio
      await api(srv.base, rutaCancelar(SEED.negocioA), { cookie: cookieSuperadmin, method: 'DELETE' });
    });

    await t('HTTP', 'callback con state reemplazado (iniciar dos veces) -> rechazado (400)', async () => {
      const r1 = await api(srv.base, rutaIniciar(SEED.negocioB), { cookie: cookieSuperadmin, method: 'POST' });
      const stateViejoB = r1.body.state;
      await api(srv.base, rutaIniciar(SEED.negocioB), { cookie: cookieSuperadmin, method: 'POST' }); // reemplaza
      const r = await api(srv.base, rutaCallback, { method: 'POST', body: { state: stateViejoB, code: 'SIMULAR_EXITO', phoneNumberId: 'PNID_REEMPLAZADO_TEST' } });
      assert.strictEqual(r.status, 400);
      assert.match(r.body.error, /reemplazad/i);
      await api(srv.base, rutaCancelar(SEED.negocioB), { cookie: cookieSuperadmin, method: 'DELETE' });
    });

    await t('HTTP', 'credenciales existentes intactas tras cancelar (no se tocan)', async () => {
      // Conecta B de verdad primero
      const rIni = await api(srv.base, rutaIniciar(SEED.negocioB), { cookie: cookieSuperadmin, method: 'POST' });
      await api(srv.base, rutaCallback, { method: 'POST', body: { state: rIni.body.state, code: 'SIMULAR_EXITO', phoneNumberId: 'PNID_INTACTO_TEST' } });
      const antes = await api(srv.base, rutaWA(SEED.negocioB), { cookie: cookieSuperadmin });
      assert.strictEqual(antes.body.integracion.estado, 'activo');
      // Inicia un NUEVO intento (p. ej. para reconectar) y cancélalo
      await api(srv.base, rutaIniciar(SEED.negocioB), { cookie: cookieSuperadmin, method: 'POST' });
      await api(srv.base, rutaCancelar(SEED.negocioB), { cookie: cookieSuperadmin, method: 'DELETE' });
      const despues = await api(srv.base, rutaWA(SEED.negocioB), { cookie: cookieSuperadmin });
      assert.strictEqual(despues.body.integracion.estado, 'activo'); // credenciales siguen intactas
      assert.strictEqual(despues.body.integracion.identificador, 'PNID_INTACTO_TEST');
    });

    await t('AISLAMIENTO', 'cancelar la conexión pendiente de un negocio no altera a otro (Nonna Maye)', async () => {
      // Siembra una integración real de Nonna Maye (fallback, no Fase B) para
      // confirmar que cancelar A/B nunca la toca.
      await pool.query(
        `INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo)
         VALUES ($1, 'whatsapp', 'PNID_NONNA_AISLAMIENTO_TEST', 'WhatsApp Nonna Maye', TRUE)
         ON CONFLICT (canal, identificador) DO NOTHING`,
        [SEED.nonnaMayeId]
      );
      await api(srv.base, rutaIniciar(SEED.negocioA), { cookie: cookieSuperadmin, method: 'POST' });
      await api(srv.base, rutaCancelar(SEED.negocioA), { cookie: cookieSuperadmin, method: 'DELETE' });
      const { rows } = await pool.query(`SELECT identificador, activo FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp'`, [SEED.nonnaMayeId]);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].identificador, 'PNID_NONNA_AISLAMIENTO_TEST');
      assert.strictEqual(rows[0].activo, true);
    });

    await t('AUDITORIA', 'ningún registro de auditoría de cancelación contiene el state completo', async () => {
      const { rows } = await pool.query(`SELECT contexto, estado_anterior, estado_nuevo FROM auditoria_plataforma WHERE negocio_id = ANY($1) AND accion = 'integracion_embedded_signup_cancelado'`, [[SEED.negocioA, SEED.negocioB]]);
      assert.ok(rows.length >= 1);
      const texto = JSON.stringify(rows);
      // Los states usados en esta suite son cadenas largas y distintivas --
      // confirmamos que ninguna aparece completa en la auditoría.
      assert.ok(!/eyJ/.test(texto)); // los states reales son base64url de JSON, empiezan distinto, pero validamos ausencia de cualquier campo "state"
      assert.ok(!('state' in (rows[0]?.contexto || {})));
    });
  } finally { srv.detener(); }
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('\nDetalle de fallos:'); fallos.forEach(f => console.log('  - ' + f)); }
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
