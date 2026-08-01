// Suite persistida de Fase B: permisos, aislamiento, cifrado, estados,
// auditoría sin secretos, compatibilidad, y la bandera
// ALLOW_MANUAL_INTEGRATION_CREDENTIALS del PUT manual.
//
// Uso: DATABASE_URL=... INTEGRATIONS_ENCRYPTION_KEY=... PANEL_SECRET=...
//      SESSION_SECRET=... ADMIN_PASSWORD=... PANEL_PASSWORD=...
//      node test/fase-b-integraciones.mjs
// Requiere aplicar-migraciones.mjs y seed-datos-prueba.mjs ya corridos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac } from 'crypto';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4055';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');
const { obtenerCredencialesDescifradas } = await import('../src/services/integracionesService.js');
const { descifrarSecretoIntegracion } = await import('../src/services/cifradoIntegraciones.js');
const { obtenerCredencialesWhatsappNegocio } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(categoria, nombre, fn) {
  try { await fn(); console.log(`  OK  [${categoria}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${categoria}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${categoria}] ${nombre}: ${e.message}`); }
}

function cookieHeader(usuarioId, negocioId, rol) {
  const token = crearTokenSesion({ usuarioId, negocioId, rol });
  return `xabor_sesion=${encodeURIComponent(token)}`;
}
function legacyBearer(password) {
  return createHmac('sha256', process.env.PANEL_SECRET).update(password).digest('hex');
}
async function api(base, path, { cookie, bearer, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* sin cuerpo JSON */ }
  return { status: r.status, body: json };
}
const rutaWA = (negocioId) => `/api/superadmin/negocios/${negocioId}/integraciones/whatsapp`;
const rutaWAEstado = (negocioId) => `/api/superadmin/negocios/${negocioId}/integraciones/whatsapp/estado`;
const rutaWACredenciales = (negocioId) => `/api/superadmin/negocios/${negocioId}/integraciones/whatsapp/credenciales`;
const rutaLista = (negocioId) => `/api/superadmin/negocios/${negocioId}/integraciones`;

const cookieSuperadmin = cookieHeader(SEED.superadminUsuarioId, SEED.negocioA, 'admin');
const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
const cookieStaffA = cookieHeader(SEED.staffNegocioAUsuarioId, SEED.negocioA, 'staff');
const bearerLegacyAdmin = legacyBearer(process.env.ADMIN_PASSWORD);
const TOKEN_A = 'EAAG_token_negocio_A_' + 'x'.repeat(40);
const TOKEN_B = 'EAAG_token_negocio_B_' + 'y'.repeat(40);

// Limpieza previa -- deja los negocios sembrados sin integración de
// WhatsApp de corridas anteriores, para que la suite sea reproducible.
await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = ANY($1))`, [[SEED.negocioA, SEED.negocioB, SEED.negocioC, SEED.negocioD]]);
await pool.query(`DELETE FROM auditoria_plataforma WHERE negocio_id = ANY($1)`, [[SEED.negocioA, SEED.negocioB, SEED.negocioC, SEED.negocioD]]);
await pool.query(`DELETE FROM integraciones_canal WHERE canal = 'whatsapp' AND negocio_id = ANY($1)`, [[SEED.negocioA, SEED.negocioB, SEED.negocioC, SEED.negocioD]]);
// Aislamiento entre suites persistidas: borra cualquier configuracion.int_wa_*
// legada que fase-a-regresion.mjs pueda haber dejado en estos mismos
// negocios sembrados -- si no, la prueba de compatibilidad F encontraría
// el fallback de nivel 2 (legado) en vez de null tras eliminar Fase B.
await pool.query(`DELETE FROM configuracion WHERE negocio_id = ANY($1) AND clave IN ('int_wa_phone_id','int_wa_token')`, [[SEED.negocioA, SEED.negocioB, SEED.negocioC, SEED.negocioD]]);

// ═══════════ Fase 1: servidor SIN la bandera (ausente) ═══════════
{
  const srv = await arrancarServidor({ PORT: PUERTO }, { omitir: ['ALLOW_MANUAL_INTEGRATION_CREDENTIALS'] });
  try {
    await t('A', 'sin sesión -> 401', async () => {
      const r = await api(srv.base, rutaWA(SEED.negocioA));
      assert.strictEqual(r.status, 401);
    });
    await t('A', 'admin de negocio (no superadmin) -> 403', async () => {
      const r = await api(srv.base, rutaWA(SEED.negocioA), { cookie: cookieAdminA });
      assert.strictEqual(r.status, 403);
    });
    await t('A', 'staff (no superadmin) -> 403', async () => {
      const r = await api(srv.base, rutaWA(SEED.negocioA), { cookie: cookieStaffA });
      assert.strictEqual(r.status, 403);
    });
    await t('A', 'sesión legacy (bearer) -> 403 explícito', async () => {
      const r = await api(srv.base, rutaWA(SEED.negocioA), { bearer: bearerLegacyAdmin });
      assert.strictEqual(r.status, 403);
      assert.match(r.body.error, /sesión de superadmin/);
    });
    await t('A', 'superadmin -> permitido (200) en GET', async () => {
      const r = await api(srv.base, rutaWA(SEED.negocioA), { cookie: cookieSuperadmin });
      assert.strictEqual(r.status, 200);
    });
    await t('A', 'superadmin -> permitido (200) en GET lista', async () => {
      const r = await api(srv.base, rutaLista(SEED.negocioA), { cookie: cookieSuperadmin });
      assert.strictEqual(r.status, 200);
      assert.ok(Array.isArray(r.body.integraciones));
    });
    await t('A', 'negocio inexistente -> 404 incluso para superadmin', async () => {
      const r = await api(srv.base, rutaWA('00000000-0000-0000-0000-000000000000'), { cookie: cookieSuperadmin });
      assert.strictEqual(r.status, 404);
    });
    await t('D', 'módulo no_contratado (negocio C) bloquea PATCH activo -> 403', async () => {
      const r = await api(srv.base, rutaWAEstado(SEED.negocioC), { cookie: cookieSuperadmin, method: 'PATCH', body: { estado: 'activo' } });
      assert.strictEqual(r.status, 403);
    });
    await t('FLAG', 'bandera ausente -> PUT 403 incluso para superadmin', async () => {
      const r = await api(srv.base, rutaWA(SEED.negocioA), {
        cookie: cookieSuperadmin, method: 'PUT', body: { phoneNumberId: 'X', accessToken: TOKEN_A },
      });
      assert.strictEqual(r.status, 403);
    });
  } finally { srv.detener(); }
}

// ═══════════ Fase 2: servidor con la bandera explícitamente 'false' ═══════════
{
  const srv = await arrancarServidor({ PORT: PUERTO, ALLOW_MANUAL_INTEGRATION_CREDENTIALS: 'false' });
  try {
    await t('FLAG', "bandera 'false' -> PUT 403 incluso para superadmin", async () => {
      const r = await api(srv.base, rutaWA(SEED.negocioA), {
        cookie: cookieSuperadmin, method: 'PUT', body: { phoneNumberId: 'X', accessToken: TOKEN_A },
      });
      assert.strictEqual(r.status, 403);
    });
  } finally { srv.detener(); }
}

// ═══════════ Fase 3: servidor con la bandera 'true' -- resto de la suite ═══════════
{
  const srv = await arrancarServidor({ PORT: PUERTO, ALLOW_MANUAL_INTEGRATION_CREDENTIALS: 'true' });
  try {
    await t('FLAG', "bandera 'true' + admin normal (no superadmin) -> 403", async () => {
      const r = await api(srv.base, rutaWA(SEED.negocioA), {
        cookie: cookieAdminA, method: 'PUT', body: { phoneNumberId: 'X', accessToken: TOKEN_A },
      });
      assert.strictEqual(r.status, 403);
    });

    await t('D', 'módulo suspendido (negocio D) bloquea PUT -> 403', async () => {
      const r = await api(srv.base, rutaWA(SEED.negocioD), {
        cookie: cookieSuperadmin, method: 'PUT', body: { phoneNumberId: '2222222', accessToken: TOKEN_A },
      });
      assert.strictEqual(r.status, 403);
    });
    await t('D', 'reactivar integración inexistente (negocio A, módulo contratado pero sin config) -> 400', async () => {
      const r = await api(srv.base, rutaWAEstado(SEED.negocioA), { cookie: cookieSuperadmin, method: 'PATCH', body: { estado: 'activo' } });
      assert.strictEqual(r.status, 400);
    });

    let putA;
    await t('FLAG', "bandera 'true' + superadmin -> PUT permitido (200)", async () => {
      const r = await api(srv.base, rutaWA(SEED.negocioA), {
        cookie: cookieSuperadmin, method: 'PUT',
        body: { phoneNumberId: 'PNID_A_123', wabaId: 'WABA_A', accessToken: TOKEN_A, displayPhoneNumber: '+52 878 000 0001' },
      });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.estado, 'activo');
      putA = r.body;
    });
    await t('D', 'PUT en negocio B (módulo activo) -> 200, estado activo', async () => {
      const r = await api(srv.base, rutaWA(SEED.negocioB), {
        cookie: cookieSuperadmin, method: 'PUT',
        body: { phoneNumberId: 'PNID_B_456', wabaId: 'WABA_B', accessToken: TOKEN_B, displayPhoneNumber: '+52 878 000 0002' },
      });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.estado, 'activo');
    });
    await t('A', 'respuesta del PUT nunca incluye el token ni campos cifrados', async () => {
      const texto = JSON.stringify(putA);
      assert.ok(!texto.includes(TOKEN_A));
      assert.ok(!/cifrado|token_iv|auth_tag|accessToken/i.test(texto));
    });

    // ── B. Aislamiento ──
    await t('B', 'GET whatsapp de B no expone datos de A', async () => {
      const rA = await api(srv.base, rutaWA(SEED.negocioA), { cookie: cookieSuperadmin });
      const rB = await api(srv.base, rutaWA(SEED.negocioB), { cookie: cookieSuperadmin });
      assert.strictEqual(rA.body.integracion.identificador, 'PNID_A_123');
      assert.strictEqual(rB.body.integracion.identificador, 'PNID_B_456');
      assert.notStrictEqual(rA.body.integracion.id, rB.body.integracion.id);
    });
    await t('B', 'actualizar estado de B no toca A', async () => {
      const antes = await api(srv.base, rutaWA(SEED.negocioA), { cookie: cookieSuperadmin });
      await api(srv.base, rutaWAEstado(SEED.negocioB), { cookie: cookieSuperadmin, method: 'PATCH', body: { estado: 'suspendido' } });
      const despues = await api(srv.base, rutaWA(SEED.negocioA), { cookie: cookieSuperadmin });
      assert.strictEqual(despues.body.integracion.estado, antes.body.integracion.estado);
      assert.strictEqual(despues.body.integracion.estado, 'activo');
      await api(srv.base, rutaWAEstado(SEED.negocioB), { cookie: cookieSuperadmin, method: 'PATCH', body: { estado: 'activo' } });
    });
    await t('B', 'mismo canal/proveedor en dos negocios queda separado (filas distintas)', async () => {
      const { rows } = await pool.query(
        `SELECT negocio_id, identificador FROM integraciones_canal WHERE canal='whatsapp' AND proveedor='meta' AND negocio_id = ANY($1)`,
        [[SEED.negocioA, SEED.negocioB]]
      );
      assert.strictEqual(rows.length, 2);
      const porNegocio = Object.fromEntries(rows.map(r => [r.negocio_id, r.identificador]));
      assert.strictEqual(porNegocio[SEED.negocioA], 'PNID_A_123');
      assert.strictEqual(porNegocio[SEED.negocioB], 'PNID_B_456');
    });

    // ── C. Cifrado ──
    await t('C', 'el token nunca queda en texto plano en BD', async () => {
      const { rows } = await pool.query(
        `SELECT cc.access_token_cifrado FROM integraciones_canal ic
         JOIN integraciones_canal_credenciales cc ON cc.integracion_id = ic.id WHERE ic.negocio_id = $1`, [SEED.negocioA]
      );
      assert.strictEqual(rows.length, 1);
      assert.ok(!rows[0].access_token_cifrado.includes(TOKEN_A));
    });
    await t('C', 'dos cifrados del mismo valor producen ciphertext/IV distintos', async () => {
      await api(srv.base, rutaWA(SEED.negocioA), { cookie: cookieSuperadmin, method: 'PUT', body: { phoneNumberId: 'PNID_A_123', accessToken: TOKEN_B } });
      const { rows } = await pool.query(
        `SELECT ic.negocio_id, cc.access_token_cifrado, cc.token_iv FROM integraciones_canal ic
         JOIN integraciones_canal_credenciales cc ON cc.integracion_id = ic.id WHERE ic.negocio_id = ANY($1)`, [[SEED.negocioA, SEED.negocioB]]
      );
      const [fa] = rows.filter(r => r.negocio_id === SEED.negocioA);
      const [fb] = rows.filter(r => r.negocio_id === SEED.negocioB);
      assert.notStrictEqual(fa.token_iv, fb.token_iv);
      assert.notStrictEqual(fa.access_token_cifrado, fb.access_token_cifrado);
      await api(srv.base, rutaWA(SEED.negocioA), { cookie: cookieSuperadmin, method: 'PUT', body: { phoneNumberId: 'PNID_A_123', accessToken: TOKEN_A } });
    });
    await t('C', 'descifrado interno recupera el valor exacto', async () => {
      const cred = await obtenerCredencialesDescifradas(SEED.negocioA, 'whatsapp', 'meta');
      assert.ok(cred);
      assert.strictEqual(cred.accessToken, TOKEN_A);
    });
    await t('C', 'auth tag alterado en BD falla cerrado', async () => {
      const { rows: [fila] } = await pool.query(
        `SELECT ic.id AS integracion_id, cc.token_auth_tag FROM integraciones_canal ic
         JOIN integraciones_canal_credenciales cc ON cc.integracion_id = ic.id WHERE ic.negocio_id = $1`, [SEED.negocioA]
      );
      const original = fila.token_auth_tag;
      const alterado = Buffer.from(original, 'base64'); alterado[0] ^= 0xff;
      await pool.query(`UPDATE integraciones_canal_credenciales SET token_auth_tag = $1 WHERE integracion_id = $2`, [alterado.toString('base64'), fila.integracion_id]);
      assert.strictEqual(await obtenerCredencialesDescifradas(SEED.negocioA, 'whatsapp', 'meta'), null);
      await pool.query(`UPDATE integraciones_canal_credenciales SET token_auth_tag = $1 WHERE integracion_id = $2`, [original, fila.integracion_id]);
    });
    await t('C', 'clave incorrecta falla cerrado', async () => {
      const { rows: [fila] } = await pool.query(
        `SELECT cc.access_token_cifrado, cc.token_iv, cc.token_auth_tag, cc.token_formato_version
         FROM integraciones_canal ic JOIN integraciones_canal_credenciales cc ON cc.integracion_id = ic.id WHERE ic.negocio_id = $1`, [SEED.negocioA]
      );
      const crypto = await import('crypto');
      const claveOriginal = process.env.INTEGRATIONS_ENCRYPTION_KEY;
      process.env.INTEGRATIONS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
      assert.throws(() => descifrarSecretoIntegracion({ cifrado: fila.access_token_cifrado, iv: fila.token_iv, authTag: fila.token_auth_tag, version: fila.token_formato_version }));
      process.env.INTEGRATIONS_ENCRYPTION_KEY = claveOriginal;
    });
    await t('C', 'ninguna respuesta HTTP devuelve secretos', async () => {
      const rGet = await api(srv.base, rutaWA(SEED.negocioA), { cookie: cookieSuperadmin });
      const rLista = await api(srv.base, rutaLista(SEED.negocioA), { cookie: cookieSuperadmin });
      const texto = JSON.stringify(rGet.body) + JSON.stringify(rLista.body);
      assert.ok(!texto.includes(TOKEN_A));
      assert.ok(!/access_token_cifrado|token_iv|token_auth_tag/i.test(texto));
    });

    // ── D. Estados (resto) ──
    await t('D', 'suspender A conserva credenciales pero bloquea uso', async () => {
      const r = await api(srv.base, rutaWAEstado(SEED.negocioA), { cookie: cookieSuperadmin, method: 'PATCH', body: { estado: 'suspendido' } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(await obtenerCredencialesDescifradas(SEED.negocioA, 'whatsapp', 'meta'), null);
      const { rows } = await pool.query(`SELECT count(*) FROM integraciones_canal ic JOIN integraciones_canal_credenciales cc ON cc.integracion_id = ic.id WHERE ic.negocio_id = $1`, [SEED.negocioA]);
      assert.strictEqual(Number(rows[0].count), 1);
    });
    await t('D', 'reactivar A (con config completa) -> activo, vuelve a ser usable', async () => {
      const r = await api(srv.base, rutaWAEstado(SEED.negocioA), { cookie: cookieSuperadmin, method: 'PATCH', body: { estado: 'activo' } });
      assert.strictEqual(r.status, 200);
      const cred = await obtenerCredencialesDescifradas(SEED.negocioA, 'whatsapp', 'meta');
      assert.ok(cred);
      assert.strictEqual(cred.accessToken, TOKEN_A);
    });
    await t('D', 'marcar B como error bloquea uso', async () => {
      const r = await api(srv.base, rutaWAEstado(SEED.negocioB), { cookie: cookieSuperadmin, method: 'PATCH', body: { estado: 'error' } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(await obtenerCredencialesDescifradas(SEED.negocioB, 'whatsapp', 'meta'), null);
      await api(srv.base, rutaWAEstado(SEED.negocioB), { cookie: cookieSuperadmin, method: 'PATCH', body: { estado: 'activo' } });
    });
    await t('D', 'marcar A pendiente_configuracion bloquea uso sin borrar credenciales', async () => {
      const r = await api(srv.base, rutaWAEstado(SEED.negocioA), { cookie: cookieSuperadmin, method: 'PATCH', body: { estado: 'pendiente_configuracion' } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(await obtenerCredencialesDescifradas(SEED.negocioA, 'whatsapp', 'meta'), null);
      const r2 = await api(srv.base, rutaWAEstado(SEED.negocioA), { cookie: cookieSuperadmin, method: 'PATCH', body: { estado: 'activo' } });
      assert.strictEqual(r2.status, 200);
    });
    await t('D', 'DELETE credenciales sin confirmar -> 400', async () => {
      const r = await api(srv.base, rutaWACredenciales(SEED.negocioB), { cookie: cookieSuperadmin, method: 'DELETE', body: {} });
      assert.strictEqual(r.status, 400);
    });
    await t('D', 'DELETE credenciales de B (confirmado) -> elimina solo B, A intacto', async () => {
      const r = await api(srv.base, rutaWACredenciales(SEED.negocioB), { cookie: cookieSuperadmin, method: 'DELETE', body: { confirmar: true } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(await obtenerCredencialesDescifradas(SEED.negocioB, 'whatsapp', 'meta'), null);
      assert.ok(await obtenerCredencialesDescifradas(SEED.negocioA, 'whatsapp', 'meta'));
      const { rows } = await pool.query(`SELECT estado FROM integraciones_canal WHERE negocio_id = $1`, [SEED.negocioB]);
      assert.strictEqual(rows[0].estado, 'no_configurado');
    });

    // ── E. Auditoría sin secretos ──
    await t('E', 'auditoría registra acciones de A sin ningún secreto', async () => {
      const { rows } = await pool.query(`SELECT accion, estado_anterior, estado_nuevo, contexto FROM auditoria_plataforma WHERE negocio_id = $1 ORDER BY created_at`, [SEED.negocioA]);
      assert.ok(rows.length >= 3);
      const acciones = rows.map(r => r.accion);
      assert.ok(acciones.includes('integracion_credenciales_creadas') || acciones.includes('integracion_credenciales_actualizadas'));
      assert.ok(acciones.includes('integracion_estado_actualizado'));
      const texto = JSON.stringify(rows);
      assert.ok(!texto.includes(TOKEN_A) && !texto.includes(TOKEN_B));
      assert.ok(!/token_iv|token_auth_tag|access_token_cifrado/i.test(texto));
    });
    await t('E', 'auditoría de eliminación de credenciales (B) no contiene secretos', async () => {
      const { rows } = await pool.query(`SELECT contexto, estado_anterior, estado_nuevo FROM auditoria_plataforma WHERE negocio_id = $1 AND accion = 'integracion_credenciales_eliminadas'`, [SEED.negocioB]);
      assert.strictEqual(rows.length, 1);
      assert.ok(!JSON.stringify(rows[0]).includes(TOKEN_B));
    });

    // ── F. Compatibilidad ──
    await t('F', 'Nonna Maye sin fila Fase B: fallback pre-existente intacto', async () => {
      assert.strictEqual(await obtenerCredencialesWhatsappNegocio(SEED.nonnaMayeId), null);
    });
    await t('F', 'negocio A: obtenerCredencialesWhatsappNegocio usa la ruta cifrada de punta a punta', async () => {
      const cred = await obtenerCredencialesWhatsappNegocio(SEED.negocioA);
      assert.ok(cred);
      assert.strictEqual(cred.accessToken, TOKEN_A);
    });
    await t('F', 'negocio B tras eliminar credenciales: null, fail-closed', async () => {
      assert.strictEqual(await obtenerCredencialesWhatsappNegocio(SEED.negocioB), null);
    });
    await t('F', 'negocio C (sin integración nunca configurada): null, fail-closed', async () => {
      assert.strictEqual(await obtenerCredencialesWhatsappNegocio(SEED.negocioC), null);
    });
  } finally { srv.detener(); }
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('\nDetalle de fallos:'); fallos.forEach(f => console.log('  - ' + f)); }
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
