// P0 "Tomar conversación" / "Devolver al bot": el estado de atención (bot
// pausado) es POR (negocio_id, telefono), no por la fila global de clientes.
// Un mismo teléfono conversa con varios negocios y cada uno controla SU bot.
//
// Uso: DATABASE_URL=... PANEL_SECRET=... SESSION_SECRET=... ADMIN_PASSWORD=...
//      node test/fase-tomar-conversacion.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac } from 'crypto';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4299';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, setBotPausado, getBotPausado, upsertControlConversacion, registrarAuditoriaPlataforma } = await import('../src/services/database.js');
const { crearSesionSoporte } = await import('../src/services/centralOperaciones.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const A = SEED.negocioA, B = SEED.negocioB;
const SUPER = SEED.superadminUsuarioId, ADMIN_A = SEED.adminNegocioAUsuarioId;
const T = '5219999000111';   // mismo teléfono en A y B
const T_AJENA = '5219999000222'; // solo mensajes en B (ajena para A)
const T_INEXISTENTE = '5219999000333';

// ── Fixture ──────────────────────────────────────────────────────────────
await pool.query(`DELETE FROM conversaciones_control WHERE telefono = ANY($1)`, [[T, T_AJENA, T_INEXISTENTE]]);
await pool.query(`DELETE FROM mensajes WHERE telefono = ANY($1)`, [[T, T_AJENA, T_INEXISTENTE]]);
await pool.query(`DELETE FROM clientes WHERE telefono = ANY($1)`, [[T, T_AJENA, T_INEXISTENTE]]);
// La fila global de clientes pertenece a A (el caso que rompía B)
await pool.query(`INSERT INTO clientes (telefono, negocio_id, bot_pausado) VALUES ($1,$2,false)`, [T, A]);
// T tiene mensajes en AMBOS negocios
await pool.query(`INSERT INTO mensajes (telefono, direccion, texto, negocio_id) VALUES ($1,'entrante','hola A',$2),($1,'entrante','hola B',$3)`, [T, A, B]);
// T_AJENA solo tiene mensajes en B
await pool.query(`INSERT INTO mensajes (telefono, direccion, texto, negocio_id) VALUES ($1,'entrante','solo B',$2)`, [T_AJENA, B]);
// slugs para el path legado
const slugs = Object.fromEntries((await pool.query(`SELECT id, slug FROM negocios WHERE id = ANY($1)`, [[A, B]])).rows.map(r => [r.id, r.slug]));
// superadmin real en la tabla de plataforma (para sesión de soporte)
await pool.query(`INSERT INTO administradores_plataforma (usuario_id, activo) VALUES ($1,true) ON CONFLICT (usuario_id) DO UPDATE SET activo=true`, [SUPER]);

const srv = await arrancarServidor({ PORT: PUERTO, OPENAI_API_KEY: '' }, { timeoutMs: 30000 });
const BASE = srv.base;

const cookieAdminA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: ADMIN_A, negocioId: A, rol: 'admin' }))}`;
// sesión de SOPORTE del superadmin operando el negocio B (audita como superadmin)
const soporteB = await crearSesionSoporte(SUPER, B);
const cookieSoporteB = `xabor_sesion=${encodeURIComponent(soporteB.token)}`;

const post = (path, cookie) => fetch(BASE + path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' } });
const get = (path, cookie) => fetch(BASE + path, { headers: { Cookie: cookie } });
const controlRows = async (negocioId, tel) => (await pool.query(`SELECT bot_pausado FROM conversaciones_control WHERE negocio_id=$1 AND telefono=$2`, [negocioId, tel])).rows;

// ═══ SERVICIO: independencia por negocio (rojo original) ════════════════════
await t('1. mismo teléfono: A puede pausar aunque la fila clientes sea suya', async () => {
  await pool.query(`DELETE FROM conversaciones_control WHERE telefono=$1`, [T]);
  assert.strictEqual(await setBotPausado(T, true, A), true);
});
await t('2/3. A pausado, B sigue con bot activo (independencia)', async () => {
  assert.strictEqual(await getBotPausado(T, A), true);
  assert.strictEqual(await getBotPausado(T, B), false, 'B no se ve afectado por la pausa de A');
});
await t('4. B toma la conversación (antes fallaba con 403)', async () => {
  assert.strictEqual(await setBotPausado(T, true, B), true, 'B ahora SÍ puede pausar');
  assert.strictEqual(await getBotPausado(T, B), true);
});
await t('5. A devuelve al bot → B sigue pausado', async () => {
  await setBotPausado(T, false, A);
  assert.strictEqual(await getBotPausado(T, A), false);
  assert.strictEqual(await getBotPausado(T, B), true, 'devolver A no toca B');
});
await t('6. B devuelve al bot → B activo', async () => {
  await setBotPausado(T, false, B);
  assert.strictEqual(await getBotPausado(T, B), false);
});
await t('14/15. idempotente: pausar 2x y reactivar 2x no duplican fila', async () => {
  await setBotPausado(T, true, A); await setBotPausado(T, true, A);
  await setBotPausado(T, false, A); await setBotPausado(T, false, A);
  assert.strictEqual((await controlRows(A, T)).length, 1, 'una sola fila por (negocio, teléfono)');
});
await t('18. aislamiento: getBotPausado(A) no lee el estado de B', async () => {
  await pool.query(`DELETE FROM conversaciones_control WHERE telefono=$1`, [T]);
  await setBotPausado(T, true, B);   // solo B pausado
  assert.strictEqual(await getBotPausado(T, A), false, 'A no ve la pausa de B');
  assert.strictEqual(await getBotPausado(T, B), true);
  await pool.query(`DELETE FROM conversaciones_control WHERE telefono=$1`, [T]);
});

// ═══ HTTP: el caso real del panel (paso 15) ═════════════════════════════════
await t('15. panel: pausar → 200 {ok,pausado:true}; estado-bot; reactivar → 200', async () => {
  const p = await post(`/api/conversacion/${T}/pausar`, cookieAdminA);
  assert.strictEqual(p.status, 200);
  assert.deepStrictEqual(await p.json(), { ok: true, pausado: true });
  const e = await get(`/api/conversacion/${T}/estado-bot`, cookieAdminA);
  assert.strictEqual((await e.json()).pausado, true);
  const r = await post(`/api/conversacion/${T}/reactivar`, cookieAdminA);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).pausado, false);
});

// ═══ HTTP: permisos y pertenencia ═══════════════════════════════════════════
await t('7. conversación inexistente → 404, no crea fila', async () => {
  const r = await post(`/api/conversacion/${T_INEXISTENTE}/pausar`, cookieAdminA);
  assert.strictEqual(r.status, 404);
  assert.strictEqual((await controlRows(A, T_INEXISTENTE)).length, 0, 'no escribió estado');
});
await t('8. conversación ajena (solo en B) desde A → 403, no escribe', async () => {
  const r = await post(`/api/conversacion/${T_AJENA}/pausar`, cookieAdminA);
  assert.strictEqual(r.status, 403);
  assert.strictEqual((await controlRows(A, T_AJENA)).length, 0);
});
await t('11. path legado (Bearer admin + slug, sin cookie) → 401, no muta', async () => {
  const TOKEN_ADMIN = createHmac('sha256', process.env.PANEL_SECRET).update(process.env.ADMIN_PASSWORD).digest('hex');
  await pool.query(`DELETE FROM conversaciones_control WHERE telefono=$1`, [T]);
  const r = await fetch(BASE + `/api/conversacion/${T}/pausar`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN_ADMIN, 'X-Negocio-Slug': slugs[A], 'Content-Type': 'application/json' } });
  assert.ok([401, 403].includes(r.status), `esperaba 401/403, fue ${r.status}`);
  assert.strictEqual((await controlRows(A, T)).length, 0, 'legado sin actor NO muta el estado (antes: 500 con estado parcial)');
});

// ═══ HTTP: actor de auditoría correcto ══════════════════════════════════════
await t('9. admin del negocio → auditoría como actorUsuarioId (no superadmin)', async () => {
  await pool.query(`DELETE FROM auditoria_plataforma WHERE negocio_id=$1 AND accion='tomar_conversacion'`, [A]);
  await post(`/api/conversacion/${T}/pausar`, cookieAdminA);
  const { rows } = await pool.query(`SELECT superadmin_id, actor_usuario_id FROM auditoria_plataforma WHERE negocio_id=$1 AND accion='tomar_conversacion' ORDER BY created_at DESC LIMIT 1`, [A]);
  assert.ok(rows.length, 'se registró auditoría');
  assert.strictEqual(rows[0].actor_usuario_id, ADMIN_A, 'actor = admin del negocio');
  assert.strictEqual(rows[0].superadmin_id, null, 'NO se marca como superadmin');
  await post(`/api/conversacion/${T}/reactivar`, cookieAdminA);
});
await t('10. superadmin en soporte → auditoría como superadminId', async () => {
  await pool.query(`DELETE FROM auditoria_plataforma WHERE negocio_id=$1 AND accion='tomar_conversacion'`, [B]);
  const p = await post(`/api/conversacion/${T}/pausar`, cookieSoporteB);
  assert.strictEqual(p.status, 200, 'soporte puede tomar la conversación de B');
  const { rows } = await pool.query(`SELECT superadmin_id, actor_usuario_id FROM auditoria_plataforma WHERE negocio_id=$1 AND accion='tomar_conversacion' ORDER BY created_at DESC LIMIT 1`, [B]);
  assert.strictEqual(rows[0].superadmin_id, SUPER, 'actor = superadmin real');
  assert.strictEqual(rows[0].actor_usuario_id, null);
  await post(`/api/conversacion/${T}/reactivar`, cookieSoporteB);
});
await t('16/17. estadoAnterior/estadoNuevo de la auditoría son correctos', async () => {
  await pool.query(`DELETE FROM conversaciones_control WHERE telefono=$1`, [T]);
  await pool.query(`DELETE FROM auditoria_plataforma WHERE negocio_id=$1 AND accion='tomar_conversacion'`, [A]);
  await post(`/api/conversacion/${T}/pausar`, cookieAdminA);
  const { rows } = await pool.query(`SELECT estado_anterior, estado_nuevo FROM auditoria_plataforma WHERE negocio_id=$1 AND accion='tomar_conversacion' ORDER BY created_at DESC LIMIT 1`, [A]);
  assert.strictEqual(rows[0].estado_anterior.bot_pausado, false);
  assert.strictEqual(rows[0].estado_nuevo.bot_pausado, true);
  await post(`/api/conversacion/${T}/reactivar`, cookieAdminA);
});

// ═══ ATOMICIDAD: estado + auditoría en una transacción ══════════════════════
await t('12. auditoría falla → ROLLBACK del estado (nada parcial)', async () => {
  await pool.query(`DELETE FROM conversaciones_control WHERE telefono=$1`, [T]);
  const client = await pool.connect();
  let lanzo = false;
  try {
    await client.query('BEGIN');
    await upsertControlConversacion(T, true, A, ADMIN_A, client);   // estado escrito en la tx
    // auditoría con negocio inexistente → viola FK → lanza
    await registrarAuditoriaPlataforma({ actorUsuarioId: ADMIN_A, accion: 'tomar_conversacion',
      negocioId: '00000000-0000-4000-8000-000000000000', estadoNuevo: {} }, client);
    await client.query('COMMIT');
  } catch { lanzo = true; try { await client.query('ROLLBACK'); } catch {} }
  finally { client.release(); }
  assert.ok(lanzo, 'la auditoría con negocio inválido debe fallar');
  assert.strictEqual((await controlRows(A, T)).length, 0, 'el estado NO quedó escrito (rollback atómico)');
});
await t('13. contrato: broadcast SOLO después del COMMIT', () => {
  const SRC = readFileSync(join(RAIZ, 'src', 'server.js'), 'utf8');
  const fn = SRC.slice(SRC.indexOf('async function cambiarAtencionConversacion'), SRC.indexOf('async function cambiarAtencionConversacion') + 1800);
  const posCommit = fn.indexOf("client.query('COMMIT')");
  const posBroadcast = fn.indexOf('broadcastNegocio');
  assert.ok(posCommit > -1 && posBroadcast > posCommit, 'broadcastNegocio va después del COMMIT');
});
await t('ADV. actor correcto por contrato: soporte→superadminId, normal→actorUsuarioId', () => {
  const SRC = readFileSync(join(RAIZ, 'src', 'server.js'), 'utf8');
  assert.ok(/req\.esSoporte \? \{ superadminId: req\.usuarioId \} : \{ actorUsuarioId: req\.usuarioId \}/.test(SRC));
  assert.ok(/if \(!req\.usuarioId\)/.test(SRC), 'rechaza sesión sin actor');
});

srv.detener();
await pool.query(`DELETE FROM conversaciones_control WHERE telefono = ANY($1)`, [[T, T_AJENA, T_INEXISTENTE]]);
await pool.query(`DELETE FROM mensajes WHERE telefono = ANY($1)`, [[T, T_AJENA, T_INEXISTENTE]]);
await pool.query(`DELETE FROM clientes WHERE telefono = ANY($1)`, [[T, T_AJENA, T_INEXISTENTE]]);
await pool.end();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
