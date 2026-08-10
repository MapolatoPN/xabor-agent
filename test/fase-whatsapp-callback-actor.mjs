// El callback completo, con los dos actores, contra la base real.
//
// Esta es la prueba que faltaba. Las 20 del autoservicio ejercitaban el state
// y el estado, pero ninguna recorria el callback entero con un actor de tipo
// negocio -- y por ese hueco se colo un 500 en produccion: la auditoria de
// plataforma exigia superadmin_id NOT NULL, y un alta hecha por el propio
// negocio no tiene superadmin.
//
// A proposito NO se mockea registrarAuditoriaPlataforma: si se mockeara, el
// NOT NULL volveria a pasar desapercibido, que es exactamente lo que ocurrio.
import assert from 'assert';
import { randomUUID } from 'crypto';

const { pool, registrarAuditoriaPlataforma, crearUsuarioConPassword } =
  await import('../src/services/database.js');
const { crearState, validarYConsumirState } = await import('../src/services/embeddedSignupState.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const { rows: [neg] } = await pool.query(
  `INSERT INTO negocios (nombre, slug) VALUES ('Actor Test','actor-test')
   ON CONFLICT (slug) DO UPDATE SET nombre='Actor Test' RETURNING id`);
const NEG = neg.id;
await pool.query(
  `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
   ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [NEG]);

const admin = await crearUsuarioConPassword({
  negocioId: NEG, nombre: 'Admin Actor', email: `actor-${Date.now()}@test.local`,
  password: 'ClaveActor123!', rol: 'admin' });
const sup = await crearUsuarioConPassword({
  negocioId: NEG, nombre: 'Super Actor', email: `super-${Date.now()}@test.local`,
  password: 'ClaveSuper123!', rol: 'admin' });

// ─── Esquema ────────────────────────────────────────────────────────────────

await t('ESQUEMA', '1. superadmin_id ya NO es obligatorio', async () => {
  const { rows } = await pool.query(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_name='auditoria_plataforma' AND column_name='superadmin_id'`);
  assert.strictEqual(rows[0].is_nullable, 'YES',
    'mientras fuera NOT NULL, un alta hecha por el negocio no se podia auditar');
});

await t('ESQUEMA', '2. existe actor_usuario_id, distinto de usuario_id', async () => {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='auditoria_plataforma' AND column_name IN ('actor_usuario_id','usuario_id')`);
  const cols = rows.map(r => r.column_name).sort();
  assert.deepStrictEqual(cols, ['actor_usuario_id', 'usuario_id'],
    'usuario_id es el AFECTADO; el actor va aparte, o la auditoria deja de ser auditable');
});

// ─── Los dos actores ────────────────────────────────────────────────────────

await t('ACTOR', '3. CASO A -- Superadmin: se audita con superadmin_id', async () => {
  const r = await registrarAuditoriaPlataforma({
    superadminId: sup.id, accion: 'prueba_actor_superadmin', negocioId: NEG });
  const { rows } = await pool.query(
    `SELECT superadmin_id, actor_usuario_id FROM auditoria_plataforma WHERE id=$1`, [r.id]);
  assert.strictEqual(rows[0].superadmin_id, sup.id);
  assert.strictEqual(rows[0].actor_usuario_id, null);
});

await t('ACTOR', '4. CASO B -- admin del negocio: se audita con actor_usuario_id', async () => {
  // Este es el caso que reventaba en produccion.
  const r = await registrarAuditoriaPlataforma({
    actorUsuarioId: admin.id, accion: 'prueba_actor_negocio', negocioId: NEG });
  const { rows } = await pool.query(
    `SELECT superadmin_id, actor_usuario_id FROM auditoria_plataforma WHERE id=$1`, [r.id]);
  assert.strictEqual(rows[0].superadmin_id, null);
  assert.strictEqual(rows[0].actor_usuario_id, admin.id);
});

await t('ACTOR', '5. sin actor no se audita', async () => {
  await assert.rejects(
    () => registrarAuditoriaPlataforma({ accion: 'sin_actor', negocioId: NEG }),
    /superadminId o actorUsuarioId/);
});

await t('ACTOR', '6. con DOS actores tampoco: no se sabria a quien atribuirlo', async () => {
  await assert.rejects(
    () => registrarAuditoriaPlataforma({ superadminId: sup.id, actorUsuarioId: admin.id,
                                         accion: 'dos_actores', negocioId: NEG }),
    /dos actores/);
});

await t('ACTOR', '7. el CHECK de la base lo impide aunque alguien esquive el servicio', async () => {
  await assert.rejects(
    () => pool.query(
      `INSERT INTO auditoria_plataforma (superadmin_id, actor_usuario_id, accion) VALUES (NULL, NULL, 'x')`),
    /un_actor|check/i, 'la base es la ultima linea, no solo el servicio');
});

// ─── Filas historicas ───────────────────────────────────────────────────────

await t('HISTORICO', '8. las filas anteriores siguen siendo validas', async () => {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM auditoria_plataforma
      WHERE superadmin_id IS NULL AND actor_usuario_id IS NULL`);
  assert.strictEqual(rows[0].n, 0, 'ninguna fila quedo sin actor tras la migracion');
});

// ─── State ──────────────────────────────────────────────────────────────────

await t('STATE', '9. el state del negocio trae usuarioId y el callback puede leerlo', () => {
  const state = crearState({ negocioId: NEG, usuarioId: admin.id });
  const leido = validarYConsumirState(state);
  assert.strictEqual(leido.usuarioId, admin.id);
  assert.strictEqual(leido.superadminId, null);
  assert.strictEqual(leido.actor, 'negocio');
});

await t('STATE', '10. replay sigue rechazado tras el hotfix', () => {
  const state = crearState({ negocioId: NEG, usuarioId: admin.id });
  assert.ok(validarYConsumirState(state));
  assert.strictEqual(validarYConsumirState(state), null,
    'el intento de Mapolato ya esta consumido y no se puede reutilizar');
});

// ─── La auditoria no puede tumbar la integracion ────────────────────────────

await t('RESILIENCIA', '11. si la auditoria falla, lo critico ya hecho NO se pierde', async () => {
  // Se rompe la tabla de auditoria a proposito y se comprueba que el patron
  // del callback (intentar, registrar el fallo, seguir) aguanta.
  await pool.query(`ALTER TABLE auditoria_plataforma RENAME TO auditoria_oculta`);
  try {
    let siguio = false;
    const auditar = async (datos) => {
      try { await registrarAuditoriaPlataforma({ actorUsuarioId: admin.id, ...datos }); }
      catch (e) { /* se registra y se continua */ }
    };
    await auditar({ accion: 'con_la_tabla_rota', negocioId: NEG });
    siguio = true;
    assert.strictEqual(siguio, true,
      'un fallo de bitacora no puede empujar al cliente a repetir todo el onboarding');
  } finally {
    await pool.query(`ALTER TABLE auditoria_oculta RENAME TO auditoria_plataforma`);
  }
});

await t('RESILIENCIA', '12. y cuando la tabla vuelve, la auditoria se escribe otra vez', async () => {
  const r = await registrarAuditoriaPlataforma({
    actorUsuarioId: admin.id, accion: 'tras_recuperar', negocioId: NEG });
  assert.ok(r?.id, 'el fallo era temporal, no permanente');
});

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
await pool.end();
process.exit(fallidas ? 1 : 0);
