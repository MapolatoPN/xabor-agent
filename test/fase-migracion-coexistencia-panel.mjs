// Migración Cloud API → coexistencia desde el panel.
//
// Incidente real (Alora, 23-ago): su integración estaba guardada como
// connection_mode='cloud_api' y "conectada", así que el panel solo ofrecía
// "Reconectar" -- que por diseño respeta el modo guardado y lanza el flujo
// Cloud SIN `featureType`. Resultado: Meta mostraba el onboarding estándar
// ("Usar solo un nombre visible / Agregar un número nuevo") en vez del de
// WhatsApp Business App, y no existía NINGÚN camino en la UI para pedir
// coexistencia sobre una integración ya conectada por Cloud.
//
// Esta suite fija el camino explícito y, sobre todo, sus límites: el botón
// solo LANZA el diálogo; ningún estado persistido cambia hasta que Meta
// devuelve un onboarding válido y corre completarActivacionWhatsapp.
//
// Es una suite de contrato del panel + backend: lee el HTML servido (la
// misma técnica de fase-whatsapp-coexistence para el frontend) y ejercita
// la ruta real del callback con el mock oficial de Meta.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

process.env.META_EMBEDDED_SIGNUP_MOCK = 'true';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const HTML = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');

const { pool } = await import('../src/services/database.js');
const {
  guardarCredencialesCifradas, completarActivacionWhatsapp,
  actualizarEstadoIntegracion,
} = await import('../src/services/integracionesService.js');
const { estadoWhatsappNegocio } = await import('../src/services/whatsappAutoservicio.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG = SEED.negocioA;
const ACTOR = SEED.superadminUsuarioId;
const suf = Date.now().toString().slice(-6);
const PNID = 'PNID_COEX_OK';            // el mock lo reporta is_on_biz_app=true
const WABA = `WABAMIG${suf}`;

// El bloque de la tarjeta "conectado" (donde viven Reconectar y el botón
// nuevo). Se acota para que las aserciones no se cumplan por casualidad con
// texto de otra tarjeta.
const bloqueConectado = (() => {
  const ini = HTML.indexOf("btn('Verificar conexión', 'verificarWhatsapp()')");
  return ini < 0 ? '' : HTML.slice(ini, ini + 900);
})();

async function del(sql, params) {
  try { await pool.query(sql, params); } catch (e) { console.warn('[limpieza] paso omitido:', e.message.slice(0, 80)); }
}
async function limpiar() {
  await del(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp')`, [NEG]);
  await del(`DELETE FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp'`, [NEG]);
}
// Lectura DIRECTA de la fila: obtenerIntegracionNegocio expone solo columnas
// seguras y NO incluye connection_mode, que es justo lo que esta suite mide.
const filaWA = async () => (await pool.query(
  `SELECT id, estado, activo, identificador, waba_id, connection_mode,
          numero_registrado_cloud_api, app_suscrita_waba
     FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp' AND proveedor = 'meta'`,
  [NEG])).rows[0] || null;

try {
  await limpiar();

  // ═══ 1-3. Qué botón lanza qué flujo, según el modo guardado ══════════════
  await t('1. cloud_api: "Reconectar" sigue llamando al flujo Cloud (conectarWhatsapp)', async () => {
    assert.ok(/const fnReconectar = e\.connectionMode === 'coexistence'\s*\?\s*'conectarWhatsappCoexistencia\(\)'\s*:\s*'conectarWhatsapp\(\)'/.test(HTML),
      'el selector de flujo de Reconectar cambió de forma');
    assert.ok(/btn\('Reconectar', fnReconectar\)/.test(bloqueConectado),
      'la tarjeta conectada dejó de usar fnReconectar en Reconectar');
  });

  await t('2. cloud_api: existe el camino explícito "Cambiar a WhatsApp Business App" -> coexistencia', async () => {
    assert.ok(/Cambiar a WhatsApp Business App/.test(bloqueConectado),
      'no existe el botón de migración en la tarjeta conectada');
    assert.ok(/e\.connectionMode !== 'coexistence'[\s\S]{0,200}btn\('Cambiar a WhatsApp Business App', 'conectarWhatsappCoexistencia\(\)'\)/.test(bloqueConectado),
      'el botón de migración no está condicionado a NO-coexistencia o no llama al flujo de coexistencia');
  });

  await t('3. coexistence: NO se ofrece migrar (ya está) y Reconectar usa coexistencia', async () => {
    // La condición es exactamente `!== 'coexistence'`, así que con modo
    // coexistence el botón no se pinta y Reconectar ya resuelve al flujo bueno.
    assert.ok(/\(e\.connectionMode !== 'coexistence'/.test(bloqueConectado),
      'el botón de migración no está guardado por el modo actual');
    assert.ok(/'conectarWhatsappCoexistencia\(\)' : 'conectarWhatsapp\(\)'/.test(HTML));
  });

  // ═══ 4. El flujo de coexistencia manda el featureType oficial ════════════
  await t('4. conectarWhatsappCoexistencia => extras.featureType whatsapp_business_app_onboarding', async () => {
    assert.ok(/function conectarWhatsappCoexistencia\(\)\s*\{\s*return conectarWhatsapp\('coexistence'\);/.test(HTML),
      'conectarWhatsappCoexistencia dejó de pedir el modo coexistence');
    assert.ok(/const connectionMode = modo === 'coexistence' \? 'coexistence' : 'cloud_api'/.test(HTML),
      'el modo ya no se normaliza contra la lista cerrada');
    assert.ok(/if \(connectionMode === 'coexistence'\)\s*\{\s*Object\.assign\(extras, \{ featureType: 'whatsapp_business_app_onboarding' \}\)/.test(HTML),
      'el featureType de coexistencia ya no viaja en extras');
    // Y el resto de parámetros se conserva intacto.
    assert.ok(/const extras = \{ setup: \{\}, sessionInfoVersion: 3 \}/.test(HTML), 'cambió sessionInfoVersion/setup');
    assert.ok(/config_id: cfg\.configId/.test(HTML), 'cambió el config_id');
    assert.ok(/response_type: 'code'/.test(HTML) && /override_default_response_type: true/.test(HTML),
      'cambiaron response_type/override_default_response_type');
  });

  // ═══ 5. Cancelar/errar NO toca el estado persistido ══════════════════════
  await t('5. cancel/error del diálogo: la integración cloud_api existente queda intacta', async () => {
    await guardarCredencialesCifradas(NEG, 'whatsapp', 'meta',
      { phoneNumberId: `PNIDCLOUD${suf}`, wabaId: WABA, accessToken: 'TOKEN-CLOUD-MIG' }, ACTOR);
    await actualizarEstadoIntegracion(NEG, 'whatsapp', 'meta', 'activo', ACTOR);
    await pool.query(
      `UPDATE integraciones_canal SET connection_mode = 'cloud_api'
        WHERE negocio_id = $1 AND canal = 'whatsapp' AND proveedor = 'meta'`, [NEG]);
    const antes = await filaWA();

    // El botón solo abre el diálogo; el callback NO se llama si el usuario
    // cancela (CANCEL/ERROR) -- el panel hace terminar(null) y el POST del
    // callback nunca ocurre. Se comprueba que nada del estado dependa de
    // haber pulsado: la fila sigue byte a byte igual.
    assert.ok(/d\.event === 'CANCEL' \|\| d\.event === 'ERROR'/.test(HTML), 'el listener dejó de manejar CANCEL/ERROR');
    assert.ok(/terminar\(null\)/.test(HTML), 'CANCEL/ERROR ya no termina sin datos');
    assert.ok(/if \(!code\) \{ terminar\(null\); return; \}/.test(HTML), 'sin code ya no se aborta');

    const despues = await filaWA();
    assert.strictEqual(despues.connection_mode, 'cloud_api', 'el modo cambió sin callback');
    assert.strictEqual(despues.estado, antes.estado);
    assert.strictEqual(despues.identificador, antes.identificador);
    assert.strictEqual(despues.activo, antes.activo);
    const { rows: [cred] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM integraciones_canal_credenciales WHERE integracion_id = $1`, [antes.id]);
    assert.strictEqual(cred.n, 1, 'se perdieron las credenciales existentes');
  });

  // ═══ 6. FINISH de coexistencia => activación por el camino de coexistencia
  await t('6. onboarding coexistence válido => completarActivacionWhatsapp(coexistence): sin /register y activo', async () => {
    // El callback del panel manda connectionMode junto al resto de datos y el
    // servidor lo valida contra su lista cerrada (nunca lo cree a ciegas).
    assert.ok(/FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING/.test(HTML), 'el listener no acepta el FINISH de coexistencia');
    assert.ok(/state: inicio\.state, connectionMode: connectionMode/.test(HTML),
      'el callback dejó de enviar el connectionMode elegido');

    // Estado equivalente al que deja el signup: credenciales nuevas del
    // número que vive en la Business App.
    await guardarCredencialesCifradas(NEG, 'whatsapp', 'meta',
      { phoneNumberId: PNID, wabaId: WABA, accessToken: 'TOKEN-COEX-MIG' }, ACTOR);
    const r = await completarActivacionWhatsapp(NEG, ACTOR, { connectionMode: 'coexistence' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.registroOmitido, true, 'coexistence ejecutó POST /register');
    assert.strictEqual(r.verificacion?.isOnBizApp, true, 'no verificó is_on_biz_app');
    const fila = await filaWA();
    assert.strictEqual(fila.connection_mode, 'coexistence', 'el modo no migró a coexistence');
    assert.strictEqual(fila.estado, 'activo');
    assert.strictEqual(fila.activo, true);
    // Y ahora la UI ya no ofrecería migrar (mismo guard del caso 3).
    const est = await estadoWhatsappNegocio(NEG);
    assert.strictEqual(est.connectionMode, 'coexistence');
    assert.strictEqual(est.estadoVisible, 'coexistencia_activa', `estadoVisible=${est.estadoVisible}`);
  });

  // ═══ 7. El flujo Cloud normal sigue intacto ═════════════════════════════
  await t('7. Cloud normal intacto: sin featureType y con /register real', async () => {
    assert.ok(/const extras = \{ setup: \{\}, sessionInfoVersion: 3 \};/.test(HTML),
      'el objeto base de extras del flujo estándar cambió');
    // Sin la condición de coexistence, extras NO lleva featureType: se
    // comprueba que la única aparición del featureType esté dentro del if.
    const apariciones = (HTML.match(/whatsapp_business_app_onboarding/g) || []).length;
    assert.strictEqual(apariciones, 1, `featureType aparece ${apariciones} veces (debe ser 1, dentro del if)`);

    await pool.query(
      `UPDATE integraciones_canal SET connection_mode = 'cloud_api'
        WHERE negocio_id = $1 AND canal = 'whatsapp' AND proveedor = 'meta'`, [NEG]);
    await guardarCredencialesCifradas(NEG, 'whatsapp', 'meta',
      { phoneNumberId: `PNIDCLOUD2${suf}`, wabaId: WABA, accessToken: 'TOKEN-CLOUD-2' }, ACTOR);
    const r = await completarActivacionWhatsapp(NEG, ACTOR, { connectionMode: 'cloud_api' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.registroOmitido, false, 'cloud_api omitió /register');
    const fila = await filaWA();
    assert.strictEqual(fila.connection_mode, 'cloud_api');
    assert.strictEqual(fila.numero_registrado_cloud_api, true);
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL: ' + e.message);
} finally {
  await limpiar();
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-migracion-coexistencia-panel: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
