// Suite de INTEGRACIÓN del programa Tech Provider (META_INTEGRATION.md):
// verificación de activos en el callback de Embedded Signup (por modo),
// desconexión y liberación del número, aislamiento entre negocios, tablero
// y diagnóstico de formularios de Superadmin, y que nada filtre secretos.
//
// Levanta src/server.js como hijo y un Graph de Meta FALSO en este proceso
// (META_GRAPH_BASE_URL): ningún dato sale a Meta. Crea sus propios negocios.
// Uso (con las variables de dev-local.env.cmd y una base de pruebas propia):
//   node test/fase-meta-tech-provider.mjs
// Puertos: TEST_PORT_META_TP (servidor, 4791) y TEST_PORT_META_FALSO (4792).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';
import { cookieSuperadminCon2fa } from './lib-superadmin-2fa.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_META_TP || '4791';
const PUERTO_META = process.env.TEST_PORT_META_FALSO || '4792';
const APP_ID = '123456789012345';
const APP_SECRET = 'secreto-app-de-prueba-integracion';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');
const { buscarFugas } = await import('../src/services/whatsappAutoservicio.js');
const { MENSAJE_CLIENTE, MOTIVOS } = await import('../src/services/metaActivos.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const cookieDe = (usuarioId, negocioId, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;
async function api(base, path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch {}
  return { status: r.status, body: json, texto };
}

// ── Ids únicos por corrida (UNIQUE(canal, identificador) en la base) ─────
const SUF = String(Date.now()).slice(-9);
const id = (prefijo, n) => `${prefijo}${SUF}${String(n).padStart(2, '0')}`;
const WABA_1 = id('71', 1), WABA_2 = id('71', 2), WABA_3 = id('71', 3);
const PN_1 = id('81', 1), PN_1B = id('81', 2), PN_2 = id('81', 3), PN_3 = id('81', 4), PN_A = id('81', 5), PN_A2 = id('81', 6);
const TOKEN_SIMULADO = 'SIMULATED_ACCESS_TOKEN_TEST'; // el que devuelve el intercambio simulado

// ── Graph de Meta falso ──────────────────────────────────────────────────
const meta = {
  app: APP_ID, valida: true, expira: 1893456000,
  scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
  concedidas: [WABA_1],
  numeros: { [WABA_1]: [PN_1], [WABA_2]: [PN_2], [WABA_3]: [PN_3] },
  flows: {}, cifrado: {}, retiroOk: true,
};
const llamadasMeta = [];
const servidorMeta = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const ruta = u.pathname.replace(/^\/v\d+\.0\//, '');
  llamadasMeta.push({ metodo: req.method, ruta, auth: req.headers.authorization || null, query: Object.fromEntries(u.searchParams) });
  const enviar = (status, cuerpo) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(cuerpo)); };
  if (req.method === 'GET' && ruta === 'debug_token') {
    if (u.searchParams.get('access_token') !== `${APP_ID}|${APP_SECRET}`) return enviar(400, { error: { code: 190, message: 'app token' } });
    return enviar(200, { data: { is_valid: meta.valida, app_id: meta.app, type: 'SYSTEM_USER', expires_at: meta.expira, scopes: meta.scopes,
      granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: meta.concedidas }, { scope: 'whatsapp_business_messaging', target_ids: meta.concedidas }] } });
  }
  let m = ruta.match(/^(\d+)\/phone_numbers$/);
  if (req.method === 'GET' && m) {
    return enviar(200, { data: (meta.numeros[m[1]] || []).map(n => ({ id: n, display_phone_number: `+52 878 555 ${n.slice(-4)}`,
      verified_name: `<b>Negocio ${n.slice(-2)}</b>`, name_status: 'APPROVED', platform_type: 'CLOUD_API' })) });
  }
  m = ruta.match(/^(\d+)\/subscribed_apps$/);
  if (req.method === 'DELETE' && m) return meta.retiroOk ? enviar(200, { success: true }) : enviar(400, { error: { code: 200, message: 'sin permiso' } });
  m = ruta.match(/^(\d+)\/flows$/);
  if (req.method === 'GET' && m) return enviar(200, { data: meta.flows[m[1]] || [] });
  m = ruta.match(/^(\d+)\/whatsapp_business_encryption$/);
  if (req.method === 'GET' && m) return enviar(200, { data: [meta.cifrado[m[1]] || {}] });
  return enviar(404, { error: { code: 803, message: 'ruta falsa desconocida' } });
});
await new Promise(r => servidorMeta.listen(Number(PUERTO_META), '127.0.0.1', r));
// Solo las rutas que usan los módulos nuevos: el servidor de prueba también
// corre sus trabajos de fondo (la sonda de credenciales consulta números de
// OTROS negocios de la base con META_GRAPH_BASE_URL) y esas no cuentan aquí.
const RUTAS_PROPIAS = /^debug_token$|\/(phone_numbers|subscribed_apps|flows|whatsapp_business_encryption|register|deregister)$/;
const llamadasDesde = (i) => llamadasMeta.slice(i).filter(l => RUTAS_PROPIAS.test(l.ruta));

// ── Datos propios ────────────────────────────────────────────────────────
async function crearNegocio(etiqueta) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1, $2) RETURNING id`,
    [`Meta TP ${etiqueta} ${SUF}`, `meta-tp-${etiqueta}-${SUF}`]);
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1, 'whatsapp', 'activo')`, [n.id]);
  return n.id;
}
const N1 = await crearNegocio('uno');
const N2 = await crearNegocio('dos');
const N3 = await crearNegocio('tres');
const NA = SEED.negocioA; // tiene administrador y staff en el seed

async function fijarModo(negocioId, modo) {
  if (modo === null) return pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'meta_verificar_activos'`, [negocioId]);
  return pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, 'meta_verificar_activos', $2)
    ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = EXCLUDED.valor`, [negocioId, modo]);
}
async function filaWa(negocioId) {
  const { rows } = await pool.query(
    `SELECT ic.id, ic.estado, ic.activo, ic.identificador, ic.waba_id, ic.display_phone_number, ic.verified_name,
            ic.estado_nombre, ic.app_suscrita_waba, ic.configuracion, cc.token_expira_at,
            (cc.integracion_id IS NOT NULL) AS tiene_credencial
       FROM integraciones_canal ic LEFT JOIN integraciones_canal_credenciales cc ON cc.integracion_id = ic.id
      WHERE ic.negocio_id = $1 AND ic.canal = 'whatsapp' AND ic.proveedor = 'meta'`, [negocioId]);
  return rows[0] || null;
}
async function auditoria(negocioId, accion) {
  const { rows } = await pool.query(
    `SELECT accion, contexto, superadmin_id, actor_usuario_id, estado_nuevo FROM auditoria_plataforma
      WHERE negocio_id = $1 AND accion = $2 ORDER BY created_at DESC`, [negocioId, accion]);
  return rows;
}

const srv = await arrancarServidor({
  PORT: PUERTO,
  META_EMBEDDED_SIGNUP_MOCK: 'true',
  META_APP_ID: APP_ID,
  META_APP_SECRET: APP_SECRET,
  META_GRAPH_BASE_URL: `http://127.0.0.1:${PUERTO_META}`,
  XABOR_WHATSAPP_DESCONEXION_AUTOSERVICIO: 'true',
  META_VERIFICAR_ACTIVOS: '',
});
const base = srv.base;
const cookieSA = await cookieSuperadminCon2fa({ usuarioId: SEED.superadminUsuarioId, negocioId: NA });
const cookieAdminA = cookieDe(SEED.adminNegocioAUsuarioId, NA, 'admin');
const cookieStaffA = cookieDe(SEED.staffNegocioAUsuarioId, NA, 'staff');
const respuestas = []; // todo lo que devolvió el servidor, para buscar fugas al final

async function conectar(negocioId, { pnid, waba, connectionMode } = {}) {
  const ini = await api(base, `/api/superadmin/negocios/${negocioId}/integraciones/whatsapp/iniciar`, { cookie: cookieSA, method: 'POST' });
  assert.strictEqual(ini.status, 200, `iniciar: ${ini.texto}`);
  const r = await api(base, '/api/integraciones/whatsapp/meta/callback', { method: 'POST',
    body: { state: ini.body.state, code: 'SIMULAR_EXITO', phoneNumberId: pnid, wabaId: waba, connectionMode } });
  respuestas.push(r.texto);
  return r;
}
const desconectarSA = async (negocioId, body) => {
  const r = await api(base, `/api/superadmin/negocios/${negocioId}/integraciones/whatsapp/desconectar`, { cookie: cookieSA, method: 'POST', body });
  respuestas.push(r.texto);
  return r;
};

try {
  // ── Callback: modo apagado = comportamiento de siempre ─────────────────
  await t('APAGADO', 'conecta con los ids del navegador y no consulta a Meta', async () => {
    const i = llamadasMeta.length;
    const r = await conectar(N1, { pnid: PN_1, waba: WABA_1 });
    assert.strictEqual(r.status, 200, r.texto);
    assert.strictEqual(r.body.estado, 'activo');
    assert.strictEqual(llamadasDesde(i).length, 0, 'apagado no debe llamar al Graph: ' + JSON.stringify(llamadasDesde(i).map(l => l.metodo + ' ' + l.ruta)));
    const f = await filaWa(N1);
    assert.strictEqual(f.identificador, PN_1);
    assert.strictEqual(f.verified_name, null);
    assert.strictEqual(f.token_expira_at, null);
    assert.strictEqual((await auditoria(N1, 'integracion_activos_verificados')).length, 0);
  });
  await t('APAGADO', 'sin phoneNumberId sigue respondiendo 400', async () => {
    const r = await conectar(N3, { pnid: '', waba: WABA_3 });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(await filaWa(N3), null);
  });

  // ── Callback: observar ─────────────────────────────────────────────────
  await t('OBSERVAR', 'mismo número confirmado: guarda número visible, nombre limpio y vencimiento', async () => {
    await fijarModo(N1, 'observar');
    meta.concedidas = [WABA_1];
    const r = await conectar(N1, { pnid: PN_1, waba: WABA_1 });
    assert.strictEqual(r.status, 200, r.texto);
    const f = await filaWa(N1);
    assert.strictEqual(f.identificador, PN_1);
    assert.strictEqual(f.verified_name, 'bNegocio 01/b', 'el nombre se guarda sin < >');
    assert.ok(f.display_phone_number.endsWith(PN_1.slice(-4)));
    assert.strictEqual(new Date(f.token_expira_at).toISOString(), new Date(meta.expira * 1000).toISOString());
    const [a] = await auditoria(N1, 'integracion_activos_verificados');
    assert.strictEqual(a.contexto.ok, true);
    assert.strictEqual(a.contexto.modo, 'observar');
  });
  await t('OBSERVAR', 'número que no pertenece: conecta igual (no cambia el resultado) y lo deja anotado', async () => {
    const r = await conectar(N1, { pnid: PN_1B, waba: WABA_1 });
    assert.strictEqual(r.status, 200, r.texto);
    const f = await filaWa(N1);
    assert.strictEqual(f.identificador, PN_1B);
    const [a] = await auditoria(N1, 'integracion_activos_verificados');
    assert.strictEqual(a.contexto.ok, false);
    assert.strictEqual(a.contexto.motivo, 'numero_no_pertenece');
  });

  // ── Callback: exigir ───────────────────────────────────────────────────
  await t('EXIGIR', 'número que no pertenece: 400 con el mensaje del cliente, sin tocar la integración vigente', async () => {
    await fijarModo(N1, 'exigir');
    const antes = await filaWa(N1);
    const r = await conectar(N1, { pnid: PN_2, waba: WABA_1 });
    assert.strictEqual(r.status, 400, r.texto);
    assert.strictEqual(r.body.error, MENSAJE_CLIENTE[MOTIVOS.NUMERO_NO_PERTENECE]);
    const f = await filaWa(N1);
    assert.strictEqual(f.identificador, antes.identificador);
    assert.strictEqual(f.estado, antes.estado, 'no se degrada a error');
  });
  await t('EXIGIR', 'sin ids del navegador (como Embedded Signup v5): descubre y guarda los de Meta', async () => {
    const r = await conectar(N1, {});
    assert.strictEqual(r.status, 200, r.texto);
    const f = await filaWa(N1);
    assert.strictEqual(f.identificador, PN_1);
    assert.strictEqual(f.waba_id, WABA_1);
  });
  await t('EXIGIR', 'token de otra app / sin permisos / dos cuentas: rechazado', async () => {
    meta.app = '999999999999999';
    let r = await conectar(N1, { pnid: PN_1, waba: WABA_1 });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, MENSAJE_CLIENTE[MOTIVOS.TOKEN_DE_OTRA_APP]);
    meta.app = APP_ID;
    meta.scopes = ['whatsapp_business_messaging'];
    r = await conectar(N1, { pnid: PN_1, waba: WABA_1 });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, MENSAJE_CLIENTE[MOTIVOS.SIN_PERMISO_WHATSAPP]);
    meta.scopes = ['whatsapp_business_management', 'whatsapp_business_messaging'];
    meta.numeros[WABA_1] = [PN_1, PN_1B];
    r = await conectar(N1, { waba: WABA_1 });
    meta.numeros[WABA_1] = [PN_1];
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, MENSAJE_CLIENTE[MOTIVOS.NUMERO_AMBIGUO]);
    assert.strictEqual((await filaWa(N1)).identificador, PN_1, 'los rechazos no tocaron la integración');
  });
  await t('EXIGIR', 'varias cuentas concedidas sin waba del navegador: toma la primera de Meta', async () => {
    meta.concedidas = [WABA_1, WABA_2];
    const r = await conectar(N1, {});
    meta.concedidas = [WABA_1];
    assert.strictEqual(r.status, 200, r.texto);
    const f = await filaWa(N1);
    assert.strictEqual(f.waba_id, WABA_1);
    assert.strictEqual(f.identificador, PN_1);
  });
  await t('AISLAMIENTO', 'el número que descubre Meta ya es de otro negocio: 409 y nada se guarda', async () => {
    const r2 = await conectar(N2, { pnid: PN_2, waba: WABA_2 }); // N2 en apagado
    assert.strictEqual(r2.status, 200, r2.texto);
    await fijarModo(N3, 'exigir');
    meta.concedidas = [WABA_2];
    const r = await conectar(N3, {});
    assert.strictEqual(r.status, 409, r.texto);
    assert.strictEqual(await filaWa(N3), null);
    assert.strictEqual((await filaWa(N2)).identificador, PN_2);
    meta.concedidas = [WABA_1];
  });
  await t('AISLAMIENTO', 'el negocio no puede relajar el modo de la plataforma (variable en exigir)', async () => {
    // Se comprueba en la unidad (resolverModoVerificacion); aquí, que la clave
    // del negocio en «apagado» no apaga nada cuando la plataforma endurece.
    const { resolverModoVerificacion } = await import('../src/services/metaActivos.js');
    assert.strictEqual(resolverModoVerificacion('apagado', 'exigir'), 'exigir');
  });

  // ── Desconexión (Superadmin) ───────────────────────────────────────────
  await t('DESCONECTAR', 'sin la palabra de confirmación: 400 y nada cambia', async () => {
    let r = await desconectarSA(N2, {});
    assert.strictEqual(r.status, 400);
    r = await desconectarSA(N2, { confirmar: 'desconectar' });
    assert.strictEqual(r.status, 400);
    r = await desconectarSA(N2, { confirmar: true });
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await filaWa(N2)).estado, 'activo');
  });
  await t('DESCONECTAR', 'retira la suscripción en Meta, borra la credencial y libera el número', async () => {
    const i = llamadasMeta.length;
    const r = await desconectarSA(N2, { confirmar: 'DESCONECTAR', motivo: 'prueba' });
    assert.strictEqual(r.status, 200, r.texto);
    assert.strictEqual(r.body.numeroLiberado, true);
    assert.strictEqual(r.body.suscripcionRetirada, true);
    const del = llamadasDesde(i).find(l => l.metodo === 'DELETE');
    assert.ok(del, 'debe llamar a DELETE subscribed_apps');
    assert.strictEqual(del.ruta, `${WABA_2}/subscribed_apps`);
    assert.strictEqual(del.auth, `Bearer ${TOKEN_SIMULADO}`);
    assert.ok(!llamadasDesde(i).some(l => /deregister/.test(l.ruta)), 'nunca /deregister');
    const f = await filaWa(N2);
    assert.strictEqual(f.estado, 'desconectado');
    assert.strictEqual(f.activo, false);
    assert.strictEqual(f.tiene_credencial, false);
    assert.strictEqual(f.identificador, `liberado:${f.id}`);
    assert.strictEqual(f.app_suscrita_waba, false);
    assert.strictEqual(f.configuracion.desconexion.identificador_anterior, PN_2);
    const [a] = await auditoria(N2, 'integracion_whatsapp_desconectada');
    assert.strictEqual(a.superadmin_id, SEED.superadminUsuarioId);
    assert.strictEqual(a.contexto.suscripcionRetirada, true);
  });
  await t('DESCONECTAR', 'el número desconectado ya no enruta ni envía', async () => {
    const { obtenerIntegracionCanal } = await import('../src/services/database.js');
    const { obtenerCredencialesDescifradas } = await import('../src/services/integracionesService.js');
    assert.strictEqual(await obtenerIntegracionCanal('whatsapp', PN_2), null);
    assert.strictEqual(await obtenerCredencialesDescifradas(N2, 'whatsapp', 'meta'), null);
  });
  await t('DESCONECTAR', 'idempotente: la segunda vez no vuelve a llamar a Meta', async () => {
    const i = llamadasMeta.length;
    const r = await desconectarSA(N2, { confirmar: 'DESCONECTAR' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.yaEstabaDesconectado, true);
    assert.strictEqual(llamadasDesde(i).length, 0);
  });
  await t('RECONEXION', 'el número liberado se puede conectar en otro negocio', async () => {
    await fijarModo(N3, null);
    const r = await conectar(N3, { pnid: PN_2, waba: WABA_2 });
    assert.strictEqual(r.status, 200, r.texto);
    assert.strictEqual((await filaWa(N3)).identificador, PN_2);
  });
  await t('RECONEXION', 'y el negocio anterior ya no puede reclamarlo (409)', async () => {
    const r = await conectar(N2, { pnid: PN_2, waba: WABA_2 });
    assert.strictEqual(r.status, 409, r.texto);
  });
  await t('RECONEXION', 'el negocio desconectado se reconecta con otro número', async () => {
    meta.numeros[WABA_3] = [PN_3];
    const r = await conectar(N2, { pnid: PN_3, waba: WABA_3 });
    assert.strictEqual(r.status, 200, r.texto);
    const f = await filaWa(N2);
    assert.strictEqual(f.estado, 'activo');
    assert.strictEqual(f.identificador, PN_3);
  });
  await t('DESCONECTAR', 'si Meta no confirma, Xabor desconecta igual y lo dice', async () => {
    meta.retiroOk = false;
    const r = await desconectarSA(N2, { confirmar: 'DESCONECTAR' });
    meta.retiroOk = true;
    assert.strictEqual(r.status, 200, r.texto);
    assert.strictEqual(r.body.suscripcionRetirada, false);
    assert.ok(r.body.avisoMeta);
    const f = await filaWa(N2);
    assert.strictEqual(f.estado, 'desconectado');
    assert.strictEqual(f.configuracion.desconexion.suscripcion_retirada, false);
  });

  // ── Desconexión desde el propio negocio ────────────────────────────────
  await t('AUTOSERVICIO', 'sin sesión 401; staff 403', async () => {
    let r = await api(base, '/api/integraciones/whatsapp/desconectar', { method: 'POST', body: { confirmar: 'DESCONECTAR' } });
    assert.strictEqual(r.status, 401);
    r = await api(base, '/api/integraciones/whatsapp/desconectar', { cookie: cookieStaffA, method: 'POST', body: { confirmar: 'DESCONECTAR' } });
    assert.strictEqual(r.status, 403);
  });
  await t('AUTOSERVICIO', 'el admin desconecta SU negocio (de la sesión, no del cuerpo) y retira la credencial en texto plano', async () => {
    const c = await conectar(NA, { pnid: PN_A, waba: WABA_1 });
    assert.strictEqual(c.status, 200, c.texto);
    await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, 'int_wa_phone_id', $2), ($1, 'int_wa_token', 'texto-plano-de-prueba')
      ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = EXCLUDED.valor`, [NA, PN_A]);
    const antesN3 = await filaWa(N3);
    const r = await api(base, '/api/integraciones/whatsapp/desconectar', { cookie: cookieAdminA, method: 'POST',
      body: { confirmar: 'DESCONECTAR', negocioId: N3, motivo: 'cambio de número' } });
    respuestas.push(r.texto);
    assert.strictEqual(r.status, 200, r.texto);
    assert.deepStrictEqual(buscarFugas(r.body), []);
    assert.strictEqual((await filaWa(NA)).estado, 'desconectado');
    assert.strictEqual((await filaWa(N3)).estado, antesN3.estado, 'el negocioId del cuerpo se ignora');
    const { rows } = await pool.query(`SELECT clave FROM configuracion WHERE negocio_id = $1 AND clave LIKE 'int_wa_%'`, [NA]);
    assert.deepStrictEqual(rows, []);
    assert.strictEqual((await filaWa(NA)).configuracion.desconexion.texto_plano_retirado, true);
    const [a] = await auditoria(NA, 'integracion_whatsapp_desconectada');
    assert.strictEqual(a.actor_usuario_id, SEED.adminNegocioAUsuarioId);
    assert.strictEqual(a.superadmin_id, null);
  });
  await t('AUDITORIA', 'la bitácora de Superadmin muestra las acciones del admin del negocio', async () => {
    const r = await api(base, `/api/superadmin/auditoria?negocioId=${NA}`, { cookie: cookieSA });
    assert.strictEqual(r.status, 200);
    const fila = r.body.find(a => a.accion === 'integracion_whatsapp_desconectada');
    assert.ok(fila, 'debe aparecer la desconexión hecha por el negocio');
    assert.strictEqual(fila.actor_tipo, 'negocio');
    assert.ok(fila.actor_nombre);
  });

  // ── Tablero y diagnóstico de Superadmin ────────────────────────────────
  await t('TABLERO', 'guardas: sin sesión 401, admin de negocio 403', async () => {
    for (const ruta of ['/api/superadmin/meta/resumen', `/api/superadmin/negocios/${N1}/meta/formularios`]) {
      assert.strictEqual((await api(base, ruta)).status, 401, ruta);
      assert.strictEqual((await api(base, ruta, { cookie: cookieAdminA })).status, 403, ruta);
    }
    assert.strictEqual((await api(base, `/api/superadmin/negocios/${N1}/integraciones/whatsapp/desconectar`, { cookie: cookieAdminA, method: 'POST', body: { confirmar: 'DESCONECTAR' } })).status, 403);
    assert.strictEqual((await filaWa(N1)).estado, 'activo');
  });
  await t('TABLERO', 'resumen: totales, ids enmascarados y alertas, sin tokens', async () => {
    const r = await api(base, '/api/superadmin/meta/resumen', { cookie: cookieSA });
    respuestas.push(r.texto);
    assert.strictEqual(r.status, 200, r.texto);
    const n1 = r.body.negocios.find(n => n.negocioId === N1);
    assert.strictEqual(n1.whatsapp.estado, 'activo');
    assert.strictEqual(n1.whatsapp.phoneNumberId, `…${PN_1.slice(-4)}`);
    assert.ok(!r.texto.includes(PN_1), 'el phone_number_id completo no sale');
    assert.ok(!r.texto.includes(WABA_1), 'el waba_id completo no sale');
    const n2 = r.body.negocios.find(n => n.negocioId === N2);
    assert.strictEqual(n2.whatsapp.phoneNumberId, null, 'un número liberado no se muestra');
    assert.ok(n2.alertas.some(a => a.clave === 'desconectado'));
    assert.ok(r.body.totales.conectados >= 2);
    assert.ok(r.body.totales.desconectados >= 2);
  });
  await t('FORMULARIOS', 'diagnóstico contra Meta: publicado, borrador, ausente y llave de cifrado', async () => {
    await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES
        ($1, 'whatsapp_flow_pedido_id', '9100000000001'), ($1, 'whatsapp_flow_carrito_id', '9100000000002'),
        ($1, 'whatsapp_flow_facturacion_id', '9100000000003')
      ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = EXCLUDED.valor`, [N1]);
    meta.flows[WABA_1] = [
      { id: '9100000000001', name: 'pedido', status: 'PUBLISHED', validation_errors: [] },
      { id: '9100000000002', name: 'carrito', status: 'DRAFT', validation_errors: [] },
      { id: '9100000000009', name: 'viejo', status: 'PUBLISHED', validation_errors: [] },
    ];
    meta.cifrado[PN_1] = { business_public_key: '-----BEGIN PUBLIC KEY-----x', business_public_key_signature_status: 'VALID' };
    const r = await api(base, `/api/superadmin/negocios/${N1}/meta/formularios`, { cookie: cookieSA });
    respuestas.push(r.texto);
    assert.strictEqual(r.status, 200, r.texto);
    assert.strictEqual(r.body.ok, true);
    const porClave = Object.fromEntries(r.body.configurados.map(c => [c.clave, c]));
    assert.strictEqual(porClave.whatsapp_flow_pedido_id.problema, null);
    assert.match(porClave.whatsapp_flow_carrito_id.problema, /borrador/);
    assert.match(porClave.whatsapp_flow_facturacion_id.problema, /no lo tiene/);
    assert.strictEqual(r.body.sinUsar, 1);
    assert.deepStrictEqual(r.body.llaveCifrado, { consultada: true, registrada: true, estadoFirma: 'VALID' });
    assert.strictEqual(r.body.resumen.conProblema, 2);
  });
  await t('FORMULARIOS', 'el diagnóstico no cambia ninguna clave', async () => {
    const { rows } = await pool.query(`SELECT clave, valor FROM configuracion WHERE negocio_id = $1 AND clave LIKE 'whatsapp\\_flow\\_%' ORDER BY clave`, [N1]);
    assert.deepStrictEqual(rows.map(r => r.valor), ['9100000000002', '9100000000003', '9100000000001']);
  });
  await t('FORMULARIOS', 'negocio sin WhatsApp: responde sin consultar a Meta', async () => {
    const i = llamadasMeta.length;
    const r = await api(base, `/api/superadmin/negocios/${N2}/meta/formularios`, { cookie: cookieSA });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, false);
    assert.strictEqual(r.body.motivo, 'sin_whatsapp');
    assert.strictEqual(llamadasDesde(i).length, 0);
  });

  // ── Fugas ──────────────────────────────────────────────────────────────
  await t('FUGAS', 'ninguna respuesta contiene el token, el secreto de la app ni el PIN', async () => {
    const todo = respuestas.join('\n');
    assert.ok(!todo.includes(TOKEN_SIMULADO), 'token');
    assert.ok(!todo.includes(APP_SECRET), 'secreto de la app');
    assert.ok(!/"pin"\s*:/i.test(todo), 'pin');
  });
  await t('FUGAS', 'la bitácora tampoco guarda el token', async () => {
    const { rows } = await pool.query(`SELECT count(*)::int n FROM auditoria_plataforma
       WHERE negocio_id = ANY($1) AND (contexto::text LIKE '%' || $2 || '%' OR estado_nuevo::text LIKE '%' || $2 || '%')`,
      [[N1, N2, N3, NA], TOKEN_SIMULADO]);
    assert.strictEqual(rows[0].n, 0);
  });
  await t('FUGAS', 'el servidor no escribió el token ni el secreto en su salida', async () => {
    const salida = srv.obtenerSalida();
    assert.ok(!salida.includes(TOKEN_SIMULADO), 'token en logs');
    assert.ok(!salida.includes(APP_SECRET), 'secreto en logs');
  });
} finally {
  srv.detener();
}

// ── Interruptor de la desconexión del negocio: apagado por omisión ───────
const srv2 = await arrancarServidor({ PORT: String(Number(PUERTO) + 10), META_EMBEDDED_SIGNUP_MOCK: 'true' },
  { omitir: ['XABOR_WHATSAPP_DESCONEXION_AUTOSERVICIO'] });
try {
  await t('AUTOSERVICIO', 'sin XABOR_WHATSAPP_DESCONEXION_AUTOSERVICIO=true la ruta del negocio responde 404', async () => {
    const r = await api(srv2.base, '/api/integraciones/whatsapp/desconectar', { cookie: cookieAdminA, method: 'POST', body: { confirmar: 'DESCONECTAR' } });
    assert.strictEqual(r.status, 404, r.texto);
  });
} finally {
  srv2.detener();
}

servidorMeta.close();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log(fallos.join('\n')); process.exitCode = 1; }
await pool.end().catch(() => {});
