// El autoservicio de WhatsApp de punta a punta, con el ACTOR real.
//
// Esta suite existe porque df95af1 pasó todas las pruebas anteriores y aun
// así el autoservicio siguió roto en producción. Las suites previas cubrían
// el state, el estado y las llamadas de auditoría del callback por separado;
// ninguna recorría la cadena COMPLETA con un actor de tipo negocio:
//
//   admin del negocio -> state -> callback -> guardarCredencialesCifradas
//   -> subscribed_apps -> /register -> completarActivacionWhatsapp -> activo
//
// Y ahí abajo, en los servicios, seguía viva la suposición de que el único
// actor posible era Superadmin (`superadminId: actualizadoPor`, con
// actualizadoPor = null para un negocio) -> la auditoría lanzaba DENTRO de la
// transacción -> rollback de credenciales válidas -> 502 (Mapolato Acuña,
// 10 de agosto de 2026, 16:39:48 UTC).
//
// Y encima el propio `auditar` del callback se llamaba a sí mismo, así que
// ninguna auditoría del callback llegó nunca a escribirse.
//
// A propósito NO se mockea registrarAuditoriaPlataforma: mockearla es
// exactamente lo que dejó pasar el fallo dos veces.
//
// Uso: DATABASE_URL=... INTEGRATIONS_ENCRYPTION_KEY=... PANEL_SECRET=...
//      SESSION_SECRET=... ADMIN_PASSWORD=... node test/fase-whatsapp-autoservicio-e2e.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4079';   // propio: 4077 ya lo usa fase-c-signup-pendiente

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, normalizarActor, registrarAuditoriaSecundaria, registrarAuditoriaPlataforma } =
  await import('../src/services/database.js');
const { guardarCredencialesCifradas } = await import('../src/services/integracionesService.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const cookie = (usuarioId, negocioId, rol) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;

async function api(base, path, { cookie: ck, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (ck) headers['Cookie'] = ck;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* respuesta sin JSON */ }
  return { status: r.status, body: json };
}

const RUTA_CALLBACK = '/api/integraciones/whatsapp/meta/callback';
const RUTA_INICIAR_NEGOCIO = '/api/integraciones/whatsapp/iniciar';
const rutaIniciarSuperadmin = (id) => `/api/superadmin/negocios/${id}/integraciones/whatsapp/iniciar`;

// Cada caso usa su propio negocio para que un fallo no contamine al siguiente.
const NEG_NEGOCIO = SEED.negocioA;   // onboarding hecho por el admin del negocio
const NEG_SUPER   = SEED.negocioB;   // onboarding hecho por Superadmin
const ADMIN = SEED.adminNegocioAUsuarioId;
const SUPER = SEED.superadminUsuarioId;

async function limpiarIntegracion(negocioId) {
  await pool.query(
    `DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN
       (SELECT id FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp')`, [negocioId]);
  await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp'`, [negocioId]);
  await pool.query(`DELETE FROM auditoria_plataforma WHERE negocio_id = $1`, [negocioId]);
}

const servidor = await arrancarServidor({
  PORT: PUERTO,
  META_EMBEDDED_SIGNUP_MOCK: 'true',
  META_APP_ID: 'APP_ID_TEST',
  META_CONFIG_ID: 'CONFIG_ID_TEST',
});
const BASE = servidor.base;

try {

// ─── TEST CRÍTICO 1 — admin del negocio, cadena completa ────────────────────

let resNegocio = null;
await t('E2E-NEGOCIO', '1. el callback del admin del negocio responde 200', async () => {
  await limpiarIntegracion(NEG_NEGOCIO);
  const ck = cookie(ADMIN, NEG_NEGOCIO, 'admin');

  const iniciado = await api(BASE, RUTA_INICIAR_NEGOCIO, { cookie: ck, method: 'POST' });
  assert.strictEqual(iniciado.status, 200, `iniciar devolvió ${iniciado.status}: ${JSON.stringify(iniciado.body)}`);
  assert.ok(iniciado.body?.state, 'el autoservicio tiene que devolver un state firmado');

  resNegocio = await api(BASE, RUTA_CALLBACK, {
    method: 'POST',
    body: {
      state: iniciado.body.state,
      code: 'SIMULAR_EXITO',
      phoneNumberId: 'PNID_AUTOSERVICIO_NEGOCIO',
      wabaId: 'WABA_AUTOSERVICIO_NEGOCIO',
      businessId: 'BIZ_AUTOSERVICIO_NEGOCIO',
    },
  });
  assert.strictEqual(resNegocio.status, 200,
    `este es EL caso que devolvía 502 en producción -- devolvió ${resNegocio.status}: ${JSON.stringify(resNegocio.body)}`);
});

await t('E2E-NEGOCIO', '2. la transacción hizo COMMIT: las credenciales quedaron', async () => {
  const { rows } = await pool.query(
    `SELECT c.integracion_id FROM integraciones_canal_credenciales c
       JOIN integraciones_canal i ON i.id = c.integracion_id
      WHERE i.negocio_id = $1 AND i.canal = 'whatsapp'`, [NEG_NEGOCIO]);
  assert.strictEqual(rows.length, 1, 'con el rollback de producción aquí no quedaba ninguna fila');
});

await t('E2E-NEGOCIO', '3. estado activo, número registrado y app suscrita', async () => {
  const { rows } = await pool.query(
    `SELECT estado, activo, numero_registrado_cloud_api, app_suscrita_waba, waba_id, identificador, actualizado_por
       FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp'`, [NEG_NEGOCIO]);
  const i = rows[0];
  assert.ok(i, 'la integración tiene que existir');
  assert.strictEqual(i.estado, 'activo');
  assert.strictEqual(i.activo, true);
  assert.strictEqual(i.numero_registrado_cloud_api, true, 'faltó /register');
  assert.strictEqual(i.app_suscrita_waba, true, 'faltó /subscribed_apps');
  assert.strictEqual(i.identificador, 'PNID_AUTOSERVICIO_NEGOCIO');
  assert.strictEqual(i.actualizado_por, ADMIN,
    'actualizado_por es "quién tocó esto", y aquí lo tocó el admin del negocio');
});

// ─── TEST CRÍTICO 5 — la fila de auditoría con actor de negocio ─────────────

await t('E2E-NEGOCIO', '4. hay auditoría con actor_usuario_id = admin y superadmin_id NULL', async () => {
  // Esto no ha ocurrido NUNCA en producción: 229 filas de auditoría y 0 con
  // actor_usuario_id. Si esta prueba pasa, el autoservicio deja rastro propio.
  const { rows } = await pool.query(
    `SELECT accion, superadmin_id, actor_usuario_id FROM auditoria_plataforma
      WHERE negocio_id = $1 ORDER BY created_at`, [NEG_NEGOCIO]);
  assert.ok(rows.length > 0, 'el onboarding del negocio no dejó ni una sola fila de auditoría');
  for (const r of rows) {
    assert.strictEqual(r.superadmin_id, null, `"${r.accion}" se atribuyó a un superadmin que no actuó`);
    assert.strictEqual(r.actor_usuario_id, ADMIN, `"${r.accion}" no registró al admin del negocio como actor`);
  }
});

// ─── TEST CRÍTICO 4 — la recursión de auditar() ─────────────────────────────

await t('RECURSION', '5. integracion_embedded_signup_completado SÍ crea fila real', async () => {
  // En df95af1 esta fila nunca se escribía: `auditar` se llamaba a sí misma
  // y todo terminaba en RangeError absorbido por su propio catch.
  const { rows } = await pool.query(
    `SELECT actor_usuario_id, superadmin_id FROM auditoria_plataforma
      WHERE negocio_id = $1 AND accion = 'integracion_embedded_signup_completado'`, [NEG_NEGOCIO]);
  assert.strictEqual(rows.length, 1, 'la auditoría propia del callback sigue muda');
  assert.strictEqual(rows[0].actor_usuario_id, ADMIN);
  assert.strictEqual(rows[0].superadmin_id, null);
});

await t('RECURSION', '6. auditar() no se invoca a sí misma (lectura del código)', () => {
  // Prueba estructural, además de la de comportamiento: si alguien vuelve a
  // reescribir el bloque con un sed y lo rompe igual, esto falla al instante.
  const fuente = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const ini = fuente.indexOf('const auditar = async (datos) => {');
  assert.ok(ini > 0, 'no se encontró la definición de auditar');
  const cuerpo = fuente.slice(ini, fuente.indexOf('\n  };', ini));
  assert.ok(!/\bauditar\(/.test(cuerpo.slice('const auditar = async (datos) => {'.length)),
    'auditar() vuelve a llamarse a sí misma: recursión infinita');
  assert.ok(cuerpo.includes('registrarAuditoriaPlataforma('),
    'auditar() tiene que llamar directamente a registrarAuditoriaPlataforma');
});

await t('RECURSION', '7. el servidor no emitió RangeError ni rechazos sin manejar', () => {
  const salida = servidor.obtenerSalida();
  assert.ok(!salida.includes('RangeError'), 'RangeError en el log del servidor');
  assert.ok(!salida.includes('Maximum call stack'), 'desbordamiento de pila en el log del servidor');
  assert.ok(!salida.includes('PromiseRejectCallback'), 'rechazo de promesa sin manejar en el log');
  assert.ok(!salida.includes('hace falta superadminId'),
    'el flujo del negocio volvió a exigir un superadmin');
});

// ─── TEST CRÍTICO 2 — Superadmin, sin regresión ─────────────────────────────

await t('E2E-SUPERADMIN', '8. el callback de Superadmin sigue respondiendo 200', async () => {
  await limpiarIntegracion(NEG_SUPER);
  const ck = cookie(SUPER, NEG_SUPER, 'admin');
  const iniciado = await api(BASE, rutaIniciarSuperadmin(NEG_SUPER), { cookie: ck, method: 'POST' });
  assert.strictEqual(iniciado.status, 200, `iniciar (superadmin) devolvió ${iniciado.status}`);

  const res = await api(BASE, RUTA_CALLBACK, {
    method: 'POST',
    body: {
      state: iniciado.body.state,
      code: 'SIMULAR_EXITO',
      phoneNumberId: 'PNID_AUTOSERVICIO_SUPER',
      wabaId: 'WABA_AUTOSERVICIO_SUPER',
      businessId: 'BIZ_AUTOSERVICIO_SUPER',
    },
  });
  assert.strictEqual(res.status, 200, `devolvió ${res.status}: ${JSON.stringify(res.body)}`);
});

await t('E2E-SUPERADMIN', '9. su auditoría va a superadmin_id, no a actor_usuario_id', async () => {
  const { rows } = await pool.query(
    `SELECT accion, superadmin_id, actor_usuario_id FROM auditoria_plataforma
      WHERE negocio_id = $1`, [NEG_SUPER]);
  assert.ok(rows.length > 0, 'Superadmin dejó de auditar: eso sí sería una regresión');
  for (const r of rows) {
    assert.strictEqual(r.superadmin_id, SUPER, `"${r.accion}" perdió al superadmin`);
    assert.strictEqual(r.actor_usuario_id, null, `"${r.accion}" duplicó el actor`);
  }
});

await t('E2E-SUPERADMIN', '10. y su integración también quedó activa', async () => {
  const { rows } = await pool.query(
    `SELECT estado, numero_registrado_cloud_api, app_suscrita_waba
       FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp'`, [NEG_SUPER]);
  assert.strictEqual(rows[0]?.estado, 'activo');
  assert.strictEqual(rows[0]?.numero_registrado_cloud_api, true);
  assert.strictEqual(rows[0]?.app_suscrita_waba, true);
});

// ─── TEST CRÍTICO 3 — la auditoría falla DESPUÉS de lo crítico ──────────────

await t('AUDITORIA-CAE', '11. si la auditoría falla, las credenciales igual se guardan', async () => {
  // Fallo real, no simulado con un mock: se esconde la tabla de auditoría y se
  // ejecuta la operación crítica. Sin el SAVEPOINT, el INSERT fallido aborta
  // la transacción entera en Postgres y el COMMIT también falla -- un try/catch
  // en JavaScript no bastaría.
  await limpiarIntegracion(SEED.negocioC);
  await pool.query(`ALTER TABLE auditoria_plataforma RENAME TO auditoria_oculta_e2e`);
  try {
    const r = await guardarCredencialesCifradas(
      SEED.negocioC, 'whatsapp', 'meta',
      { phoneNumberId: 'PNID_SIN_BITACORA', wabaId: 'WABA_SIN_BITACORA', accessToken: 'TOKEN_SIN_BITACORA' },
      { actorUsuarioId: ADMIN });
    assert.ok(r?.id, 'la operación crítica tenía que completarse igual');
  } finally {
    await pool.query(`ALTER TABLE auditoria_oculta_e2e RENAME TO auditoria_plataforma`);
  }
  const { rows } = await pool.query(
    `SELECT estado FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp'`, [SEED.negocioC]);
  assert.strictEqual(rows[0]?.estado, 'pendiente_activacion',
    'una bitácora caída no puede llevarse por delante credenciales válidas');
});

await t('AUDITORIA-CAE', '12. y cuando la tabla vuelve, la auditoría se escribe otra vez', async () => {
  const fila = await registrarAuditoriaSecundaria({
    actorUsuarioId: ADMIN, accion: 'tras_recuperar_e2e', negocioId: SEED.negocioC });
  assert.ok(fila?.id, 'el fallo era temporal, no permanente');
});

await t('AUDITORIA-CAE', '13. un fallo de auditoría no deja la transacción envenenada', async () => {
  // El caso que hace obligatorio el SAVEPOINT: auditoría rota a mitad de una
  // transacción y COMMIT posterior que debe funcionar.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE prueba_savepoint (n int)`);
    await client.query(`INSERT INTO prueba_savepoint VALUES (1)`);
    await registrarAuditoriaSecundaria({ accion: 'sin_actor_a_proposito', negocioId: SEED.negocioC }, client);
    await client.query(`INSERT INTO prueba_savepoint VALUES (2)`);
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM prueba_savepoint`);
    await client.query('COMMIT');
    assert.strictEqual(rows[0].n, 2, 'la transacción siguió viva tras el fallo de bitácora');
  } finally {
    client.release();
  }
});

// ─── Contrato de actor ──────────────────────────────────────────────────────

await t('ACTOR', '14. normalizarActor: un string sigue significando Superadmin', () => {
  assert.deepStrictEqual(normalizarActor(SUPER),
    { superadminId: SUPER, actorUsuarioId: null, actualizadoPorId: SUPER });
});

await t('ACTOR', '15. normalizarActor: el negocio va a su propia columna', () => {
  assert.deepStrictEqual(normalizarActor({ actorUsuarioId: ADMIN }),
    { superadminId: null, actorUsuarioId: ADMIN, actualizadoPorId: ADMIN });
});

await t('ACTOR', '16. normalizarActor: dos actores es un error, no una preferencia', () => {
  assert.throws(() => normalizarActor({ superadminId: SUPER, actorUsuarioId: ADMIN }), /dos actores/);
});

await t('ACTOR', '17. ningún servicio de la cadena WhatsApp asume ya superadmin', () => {
  const fuente = readFileSync(join(__dirname, '..', 'src', 'services', 'integracionesService.js'), 'utf8');
  const ini = fuente.indexOf('export async function guardarCredencialesCifradas');
  const fin = fuente.indexOf('export async function guardarCredencialesClip');
  const bloque = fuente.slice(ini, fin);
  assert.ok(!bloque.includes('superadminId: actualizadoPor'),
    'sigue habiendo un servicio que solo entiende superadmin');
  assert.ok(!/\bactualizadoPor\b(?!Id)/.test(bloque),
    'queda un actualizadoPor suelto: ese parámetro significaba "superadmin" y ya no vale');
});

await t('ACTOR', '18. el actor sale del state, nunca del cuerpo de la petición', async () => {
  // Un cuerpo que intenta imponer su propio actor no debe conseguir nada: el
  // state ya viene consumido y es el único que decide negocio y actor.
  const ck = cookie(ADMIN, NEG_NEGOCIO, 'admin');
  const iniciado = await api(BASE, RUTA_INICIAR_NEGOCIO, { cookie: ck, method: 'POST' });
  const res = await api(BASE, RUTA_CALLBACK, {
    method: 'POST',
    body: {
      state: iniciado.body.state, code: 'SIMULAR_EXITO',
      phoneNumberId: 'PNID_AUTOSERVICIO_NEGOCIO',
      wabaId: 'WABA_AUTOSERVICIO_NEGOCIO',
      superadminId: SUPER, actorUsuarioId: SUPER, negocioId: NEG_SUPER,   // intento de suplantación
    },
  });
  assert.strictEqual(res.status, 200);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM auditoria_plataforma
      WHERE negocio_id = $1 AND superadmin_id IS NOT NULL`, [NEG_NEGOCIO]);
  assert.strictEqual(rows[0].n, 0, 'el cuerpo de la petición consiguió cambiar el actor');
});

await t('ACTOR', '19. el interruptor del bot distingue quién lo movió', async () => {
  const { actualizarBotWhatsappActivoNegocio } = await import('../src/services/database.js');
  await pool.query(`DELETE FROM auditoria_plataforma WHERE negocio_id = $1 AND accion = 'cambiar_bot_whatsapp_activo_negocio'`, [NEG_NEGOCIO]);
  await actualizarBotWhatsappActivoNegocio(NEG_NEGOCIO, true, { actorUsuarioId: ADMIN });
  await actualizarBotWhatsappActivoNegocio(NEG_NEGOCIO, false, { superadminId: SUPER });
  const { rows } = await pool.query(
    `SELECT superadmin_id, actor_usuario_id FROM auditoria_plataforma
      WHERE negocio_id = $1 AND accion = 'cambiar_bot_whatsapp_activo_negocio' ORDER BY created_at`, [NEG_NEGOCIO]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].actor_usuario_id, ADMIN, 'el admin del negocio se guardaba como superadmin');
  assert.strictEqual(rows[0].superadmin_id, null);
  assert.strictEqual(rows[1].superadmin_id, SUPER);
  assert.strictEqual(rows[1].actor_usuario_id, null);
});

await t('CIERRE', '20. el log del servidor sigue limpio al terminar', () => {
  const salida = servidor.obtenerSalida();
  const rangeError = (salida.match(/RangeError/g) || []).length;
  const rechazos = (salida.match(/PromiseRejectCallback/g) || []).length;
  const faltaActor = (salida.match(/hace falta superadminId/g) || []).length;
  assert.strictEqual(rangeError, 0, `${rangeError} RangeError`);
  assert.strictEqual(rechazos, 0, `${rechazos} rechazos sin manejar`);
  assert.strictEqual(faltaActor, 0, `${faltaActor} operaciones que aún exigían superadmin`);
});

} finally {
  // Esperar a que el hijo muera de verdad antes de seguir: matarlo y salir
  // de inmediato deja el puerto y los handles a medio cerrar, y la siguiente
  // suite de la regresión arranca encima.
  servidor.detener();
  await new Promise((r) => { servidor.proc.once('exit', r); setTimeout(r, 3000); });
  // Esta suite conecta WhatsApp de verdad en los negocios de prueba. Si deja
  // esa conexión puesta, la siguiente suite de la regresión encuentra un
  // negocio "ya conectado" que no esperaba. Se devuelve todo como estaba.
  for (const n of [NEG_NEGOCIO, NEG_SUPER, SEED.negocioC]) {
    await limpiarIntegracion(n).catch(() => {});
  }
  await pool.query(`UPDATE negocios SET bot_whatsapp_activo = false WHERE id = $1`, [NEG_NEGOCIO]).catch(() => {});
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
await pool.end();
process.exit(fallidas ? 1 : 0);
