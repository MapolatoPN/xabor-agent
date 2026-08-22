// FASE 1 — Invariante WhatsApp: activo === (estado === 'activo') tras TODA
// transición, fila canónica meta como autoridad de estado/UI, retry de
// activación con el connection_mode de la BASE (jamás del frontend), gate
// estructural del fallback de entorno (solo negocios con fila legacy), y
// semántica coexistence honesta en los mensajes de verificación.
//
// Todo in-process contra la base de prueba, con el mock oficial de Meta
// (META_EMBEDDED_SIGNUP_MOCK): cero red, cero Meta real, cero servidor.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

process.env.META_EMBEDDED_SIGNUP_MOCK = 'true';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const HTML = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');

const { pool, obtenerIntegracionCanal, obtenerCredencialesWhatsappNegocio, marcarIntegracionDesconectadaPorWaba } = await import('../src/services/database.js');
const {
  guardarCredencialesCifradas, completarActivacionWhatsapp, actualizarEstadoIntegracion,
  suspenderIntegracion, guardarIntegracionPago, suspenderIntegracionPago,
  reactivarIntegracionPago, eliminarCredencialesPago,
} = await import('../src/services/integracionesService.js');
const { estadoWhatsappNegocio, accionesFaltantes } = await import('../src/services/whatsappAutoservicio.js');
const { activoParaEstadoWhatsapp, ESTADOS_WHATSAPP } = await import('../src/services/estadoIntegracionWhatsapp.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const ACTOR = SEED.superadminUsuarioId;
const suf = Date.now().toString().slice(-6);
const WABA_A = `WABAINV${suf}A`;
const PNID_ENV_B = `PNIDENVB${suf}`;
const PNID_LEGACY_A = `PNIDLEGA${suf}`;
const PNID_LEGACY_B = `PNIDLEGB${suf}`;

const ENV_ORIGINAL = {
  WHATSAPP_PHONE_ID: process.env.WHATSAPP_PHONE_ID,
  META_PHONE_NUMBER_ID: process.env.META_PHONE_NUMBER_ID,
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  META_WHATSAPP_TOKEN: process.env.META_WHATSAPP_TOKEN,
};
function restaurarEnv() {
  for (const [k, v] of Object.entries(ENV_ORIGINAL)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

async function filaMeta(negocioId) {
  const { rows: [r] } = await pool.query(
    `SELECT proveedor, identificador, waba_id, estado, activo, connection_mode,
            numero_registrado_cloud_api, app_suscrita_waba
     FROM integraciones_canal
     WHERE negocio_id = $1 AND canal = 'whatsapp' AND proveedor = 'meta'`, [negocioId]);
  return r || null;
}
function asertarInvariante(f, contexto) {
  assert.ok(f, `${contexto}: no hay fila`);
  assert.strictEqual(f.activo, f.estado === 'activo',
    `${contexto}: activo=${f.activo} pero estado='${f.estado}' — invariante rota`);
}

async function limpiar() {
  await pool.query(
    `DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN
       (SELECT id FROM integraciones_canal WHERE negocio_id = ANY($1) AND canal IN ('whatsapp','pagos'))`,
    [[NEG_A, NEG_B]]);
  await pool.query(
    `DELETE FROM integraciones_canal WHERE negocio_id = ANY($1) AND canal IN ('whatsapp','pagos')`,
    [[NEG_A, NEG_B]]);
}

try {
  await limpiar();

  // ═══ Helper puro ══════════════════════════════════════════════════════════
  await t('0. activoParaEstadoWhatsapp: solo \'activo\' produce true; la maquina incluye \'desconectado\'', async () => {
    for (const e of ESTADOS_WHATSAPP) {
      assert.strictEqual(activoParaEstadoWhatsapp(e), e === 'activo', `estado ${e}`);
    }
    assert.ok(ESTADOS_WHATSAPP.includes('desconectado'), 'la maquina no formaliza desconectado');
  });

  // ═══ A. guardar => pendiente_activacion + activo=false ════════════════════
  await t('A. guardar whatsapp/meta => pendiente_activacion + activo=false y SIN routing', async () => {
    const r = await guardarCredencialesCifradas(NEG_A, 'whatsapp', 'meta',
      { phoneNumberId: 'PNID_COEX_OK', wabaId: WABA_A, accessToken: 'TOKEN_A' }, ACTOR);
    assert.strictEqual(r.estado, 'pendiente_activacion');
    const f = await filaMeta(NEG_A);
    assert.strictEqual(f.estado, 'pendiente_activacion');
    assert.strictEqual(f.activo, false, 'una integracion sin activar reclamaba activo=TRUE');
    asertarInvariante(f, 'A');
    // La consecuencia real: el routing de webhooks NO la ve todavia.
    assert.strictEqual(await obtenerIntegracionCanal('whatsapp', 'PNID_COEX_OK'), null,
      'una pendiente_activacion reclamo el routing de webhooks');
  });

  // ═══ B. activacion cloud_api exitosa => activo + true ═════════════════════
  await t('B. activacion cloud_api exitosa => estado activo + activo=true (registro real, no omitido)', async () => {
    const r = await completarActivacionWhatsapp(NEG_A, ACTOR);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.connectionMode, 'cloud_api', 'el modo por defecto de la fila no es cloud_api');
    assert.strictEqual(r.registroOmitido, false, 'cloud_api omitio /register');
    const f = await filaMeta(NEG_A);
    assert.strictEqual(f.estado, 'activo');
    assert.strictEqual(f.activo, true);
    assert.strictEqual(f.numero_registrado_cloud_api, true);
    asertarInvariante(f, 'B');
    // Y ahora SI enruta.
    const owner = await obtenerIntegracionCanal('whatsapp', 'PNID_COEX_OK');
    assert.strictEqual(owner?.negocioId, NEG_A);
  });

  // ═══ C + H. coexistence: modo desde la BASE, jamas /register ══════════════
  await t('C/H. retry coexistence: connection_mode sale de la BASE (sin parametro), JAMAS /register, activa', async () => {
    await pool.query(
      `UPDATE integraciones_canal SET connection_mode = 'coexistence'
       WHERE negocio_id = $1 AND canal = 'whatsapp' AND proveedor = 'meta'`, [NEG_A]);
    // SIN pasar connectionMode: si el codigo obedeciera a un frontend (o a un
    // default cloud_api), dispararia /register y registroOmitido seria false.
    const r = await completarActivacionWhatsapp(NEG_A, ACTOR);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.connectionMode, 'coexistence', 'el retry no leyo el modo de la base');
    assert.strictEqual(r.registroOmitido, true, 'coexistence ejecuto /register');
    assert.strictEqual(r.verificacion?.isOnBizApp, true);
    const f = await filaMeta(NEG_A);
    assert.strictEqual(f.estado, 'activo');
    assert.strictEqual(f.activo, true);
    asertarInvariante(f, 'C');
  });

  // ═══ D. suscripcion falla => pendiente_activacion + false ═════════════════
  await t('D. subscribed_apps rechazado => pendiente_activacion + activo=false', async () => {
    await guardarCredencialesCifradas(NEG_B, 'whatsapp', 'meta',
      { phoneNumberId: `PNIDB${suf}`, wabaId: 'WABA_SUSCRIPCION_RECHAZADA', accessToken: 'TOKEN_B' }, ACTOR);
    const r = await completarActivacionWhatsapp(NEG_B, ACTOR);
    assert.strictEqual(r.ok, false);
    const f = await filaMeta(NEG_B);
    assert.strictEqual(f.estado, 'pendiente_activacion');
    assert.strictEqual(f.activo, false, 'una activacion fallida dejo activo=TRUE');
    asertarInvariante(f, 'D');
  });

  // ═══ E. is_on_biz_app=false => NO activa ══════════════════════════════════
  await t('E. coexistence con is_on_biz_app=false => pendiente_activacion + activo=false', async () => {
    await pool.query(
      `UPDATE integraciones_canal SET identificador = 'PNID_COEX_NO_BIZ_APP',
              waba_id = $2, connection_mode = 'coexistence'
       WHERE negocio_id = $1 AND canal = 'whatsapp' AND proveedor = 'meta'`, [NEG_B, `WABAB${suf}`]);
    const r = await completarActivacionWhatsapp(NEG_B, ACTOR);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.registroOmitido, true, 'coexistence ejecuto /register');
    const f = await filaMeta(NEG_B);
    assert.strictEqual(f.estado, 'pendiente_activacion');
    assert.strictEqual(f.activo, false);
    asertarInvariante(f, 'E');
  });

  // ═══ F. desconexion por WABA => desconectado + false + UI ═════════════════
  await t('F. desconexion de WABA => desconectado + activo=false, UI "Requiere reconexion"', async () => {
    const n = await marcarIntegracionDesconectadaPorWaba(WABA_A);
    assert.strictEqual(n, 1, `marco ${n} filas`);
    const f = await filaMeta(NEG_A);
    assert.strictEqual(f.estado, 'desconectado');
    assert.strictEqual(f.activo, false, 'desconectado sigue reclamando routing');
    asertarInvariante(f, 'F');
    const e = await estadoWhatsappNegocio(NEG_A);
    assert.strictEqual(e.estadoVisible, 'requiere_reconexion');
    assert.ok(HTML.includes('Requiere reconexi'), 'el panel no tiene la etiqueta visible');
    assert.ok(HTML.includes("estadoVisible === 'requiere_reconexion'"), 'el panel no mapea el estado interno');
  });

  // ═══ G. suspension / reactivacion / desconexion explicita ═════════════════
  await t('G. toda transicion mantiene activo === (estado===\'activo\')', async () => {
    const reactivar = await actualizarEstadoIntegracion(NEG_A, 'whatsapp', 'meta', 'activo', ACTOR);
    assert.strictEqual(reactivar.ok, true, JSON.stringify(reactivar));
    asertarInvariante(await filaMeta(NEG_A), 'G reactivacion');
    assert.strictEqual((await filaMeta(NEG_A)).activo, true);

    await suspenderIntegracion(NEG_A, 'whatsapp', 'meta', ACTOR);
    let f = await filaMeta(NEG_A);
    assert.strictEqual(f.estado, 'suspendido');
    assert.strictEqual(f.activo, false);
    asertarInvariante(f, 'G suspension');

    const desconectar = await actualizarEstadoIntegracion(NEG_A, 'whatsapp', 'meta', 'desconectado', ACTOR);
    assert.strictEqual(desconectar.ok, true, 'desconectado no es transicion valida de la maquina');
    f = await filaMeta(NEG_A);
    assert.strictEqual(f.activo, false);
    asertarInvariante(f, 'G desconectado');

    await actualizarEstadoIntegracion(NEG_A, 'whatsapp', 'meta', 'activo', ACTOR);
    f = await filaMeta(NEG_A);
    assert.strictEqual(f.activo, true);
    asertarInvariante(f, 'G reactivacion final');
  });

  // ═══ I. negocio moderno (sin legacy) => JAMAS env ═════════════════════════
  await t('I. negocio moderno sin fila legacy y sin credencial cifrada => NO consulta env, falla cerrado', async () => {
    // Fila meta ACTIVA duena del PNID del env, SIN credenciales cifradas:
    // exactamente el caso donde el codigo viejo devolvia el token global.
    await pool.query(
      `DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN
         (SELECT id FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp')`, [NEG_B]);
    await pool.query(
      `UPDATE integraciones_canal SET identificador = $2, estado = 'activo', activo = TRUE
       WHERE negocio_id = $1 AND canal = 'whatsapp' AND proveedor = 'meta'`, [NEG_B, PNID_ENV_B]);
    delete process.env.WHATSAPP_PHONE_ID; delete process.env.WHATSAPP_TOKEN;
    process.env.META_PHONE_NUMBER_ID = PNID_ENV_B;
    process.env.META_WHATSAPP_TOKEN = 'TOKEN_GLOBAL_LEGACY';
    const cred = await obtenerCredencialesWhatsappNegocio(NEG_B);
    assert.strictEqual(cred, null, 'un negocio SIN fila legacy uso el token global');
  });

  // ═══ J. legacy elegible => puente env permitido ═══════════════════════════
  await t('J. negocio con fila legacy => el puente env funciona cuando PNID/dueno coinciden', async () => {
    await pool.query(
      `INSERT INTO integraciones_canal (negocio_id, canal, proveedor, identificador, nombre, estado, activo)
       VALUES ($1,'whatsapp',NULL,$2,'Legacy B (test)','activo',TRUE)`, [NEG_B, PNID_LEGACY_B]);
    const cred = await obtenerCredencialesWhatsappNegocio(NEG_B);
    assert.ok(cred, 'el puente legacy no resolvio');
    assert.strictEqual(cred.phoneNumberId, PNID_ENV_B);
    assert.strictEqual(cred.accessToken, 'TOKEN_GLOBAL_LEGACY');
  });

  // ═══ K. env de otro tenant => jamas ═══════════════════════════════════════
  await t('K. el PNID del env pertenece a OTRO negocio => jamas se usa (aun con fila legacy propia)', async () => {
    await pool.query(
      `INSERT INTO integraciones_canal (negocio_id, canal, proveedor, identificador, nombre, estado, activo)
       VALUES ($1,'whatsapp',NULL,$2,'Legacy A (test)','activo',TRUE)`, [NEG_A, PNID_LEGACY_A]);
    // env PNID sigue siendo el de B; A tiene legacy pero NO es el dueno.
    const cred = await obtenerCredencialesWhatsappNegocio(NEG_A);
    // A tiene credenciales cifradas propias (fuente 1): debe resolver por
    // ellas, no por el env de B.
    assert.ok(cred, 'A perdio sus credenciales propias');
    assert.strictEqual(cred.phoneNumberId, 'PNID_COEX_OK', 'A no resolvio por su propia integracion');
    assert.notStrictEqual(cred.accessToken, 'TOKEN_GLOBAL_LEGACY', 'A uso el token global de otro tenant');
  });

  // ═══ L. autoridad de estado/UI = fila meta, no la mas nueva ═══════════════
  await t('L. estado/UI: la fila meta es la autoridad aunque la legacy sea mas nueva', async () => {
    // La legacy de A se creo DESPUES que la meta: con el ORDER BY viejo
    // (created_at DESC) ganaria la legacy (sin waba). Debe ganar la meta.
    const e = await estadoWhatsappNegocio(NEG_A);
    assert.strictEqual(e.wabaConfigurada, true, 'la UI describio la fila legacy (sin waba)');
    assert.strictEqual(e.connectionMode, 'coexistence');
    assert.strictEqual(e.estadoVisible, 'coexistencia_activa',
      `estadoVisible=${e.estadoVisible} (fila meta activa+coexistence+suscrita)`);
  });

  // ═══ M. coexistence: jamas "falta registrar el numero" ════════════════════
  await t('M. accionesFaltantes: en coexistence numero_registrado=false NO produce el texto de registro', async () => {
    const base = { wabaConfigurada: true, appSuscrita: true, numeroRegistrado: false };
    const coex = accionesFaltantes({ ...base, connectionMode: 'coexistence' });
    assert.deepStrictEqual(coex, [], `coexistence reporto faltantes: ${JSON.stringify(coex)}`);
    const cloud = accionesFaltantes({ ...base, connectionMode: 'cloud_api' });
    assert.ok(cloud.some(x => /registro del numero/.test(x)), 'cloud_api dejo de reportar el registro');
    assert.ok(HTML.length > 0);
  });

  // ═══ N. dos negocios: routing y credenciales sin cruce ════════════════════
  await t('N. dos negocios con PNID/token distintos: inbound y outbound al tenant correcto, cero cruce', async () => {
    const ownerA = await obtenerIntegracionCanal('whatsapp', 'PNID_COEX_OK');
    assert.strictEqual(ownerA?.negocioId, NEG_A);
    const ownerB = await obtenerIntegracionCanal('whatsapp', PNID_ENV_B);
    assert.strictEqual(ownerB?.negocioId, NEG_B);
    const credA = await obtenerCredencialesWhatsappNegocio(NEG_A);
    const credB = await obtenerCredencialesWhatsappNegocio(NEG_B);
    assert.ok(credA && credB, 'algun tenant quedo sin credenciales');
    assert.notStrictEqual(credA.phoneNumberId, credB.phoneNumberId);
    assert.notStrictEqual(credA.accessToken, credB.accessToken);
  });

  // ═══ O. pagos: semantica intacta ══════════════════════════════════════════
  await t('O. pagos conserva su semantica: suspender/reactivar NO tocan activo', async () => {
    await guardarIntegracionPago(NEG_A, 'clip', { apiKey: 'k_test_inv', apiSecret: 's_test_inv' }, { actualizadoPor: ACTOR });
    const leerPago = async () => (await pool.query(
      `SELECT estado, activo FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'pagos' AND proveedor = 'clip'`,
      [NEG_A])).rows[0];
    let p = await leerPago();
    assert.strictEqual(p.estado, 'activo');
    const activoInicial = p.activo;
    await suspenderIntegracionPago(NEG_A, 'clip', ACTOR);
    p = await leerPago();
    assert.strictEqual(p.estado, 'suspendido');
    assert.strictEqual(p.activo, activoInicial, 'la invariante de WhatsApp contamino pagos');
    await reactivarIntegracionPago(NEG_A, 'clip', ACTOR);
    p = await leerPago();
    assert.strictEqual(p.estado, 'activo');
    assert.strictEqual(p.activo, activoInicial);
    await eliminarCredencialesPago(NEG_A, 'clip', ACTOR);
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL: ' + e.message);
} finally {
  restaurarEnv();
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-whatsapp-invariante-activo: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
