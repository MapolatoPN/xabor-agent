// Suite de UNIDAD del programa Tech Provider (META_INTEGRATION.md).
// Sin servidor y sin red: Meta se simula con un fetch inyectado.
// La base no se consulta (los módulos solo importan el pool).
// Uso: DATABASE_URL=... node test/fase-meta-tech-provider-unidad.mjs
import assert from 'assert';

process.env.META_APP_ID = process.env.META_APP_ID || '111111111111';
process.env.META_APP_SECRET = process.env.META_APP_SECRET || 'secreto-de-prueba-unidad';
delete process.env.META_GRAPH_VERSION;
delete process.env.META_VERIFICAR_ACTIVOS;

const G = await import('../src/services/metaGraph.js');
const A = await import('../src/services/metaActivos.js');
const V = await import('../src/services/metaVerificacionCallback.js');
const P = await import('../src/services/metaPanelPlataforma.js');
const F = await import('../src/services/metaFormularios.js');
const D = await import('../src/services/metaDesconexion.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// ── Meta simulado ────────────────────────────────────────────────────────
const APP = process.env.META_APP_ID;
const WABA = '200000000000001', WABA2 = '200000000000002';
const PNID = '300000000000001', PNID2 = '300000000000002';
const TOKEN = 'EAAPRUEBAtokenNegocioMuyLargo1234567890';

function respuesta(status, cuerpo) {
  return { ok: status >= 200 && status < 300, status, json: async () => cuerpo };
}
/** fetch falso: `rutas` mapea "METODO ruta-sin-version" → (url, opts) => [status, cuerpo]. */
function fetchFalso(rutas) {
  const llamadas = [];
  const f = async (url, opts = {}) => {
    const u = new URL(url);
    const ruta = u.pathname.replace(/^\/v\d+\.0\//, '');
    const clave = `${opts.method || 'GET'} ${ruta}`;
    llamadas.push({ clave, url: u, headers: opts.headers || {} });
    const h = rutas[clave];
    if (!h) return respuesta(404, { error: { code: 803, message: `sin ruta ${clave}` } });
    const [status, cuerpo] = h(u, opts);
    return respuesta(status, cuerpo);
  };
  f.llamadas = llamadas;
  return f;
}
const concesion = ({ app = APP, valida = true, scopes = A.PERMISOS_WHATSAPP, wabas = [WABA], expira = 1893456000, extraGranular = [] } = {}) =>
  () => [200, { data: {
    is_valid: valida, app_id: app, type: 'SYSTEM_USER', expires_at: expira, scopes,
    granular_scopes: [
      { scope: 'whatsapp_business_management', target_ids: wabas },
      { scope: 'whatsapp_business_messaging', target_ids: wabas },
      ...extraGranular,
    ],
  } }];
const numeros = (lista) => () => [200, { data: lista }];
const numero = (id, extra = {}) => ({ id, display_phone_number: '+52 1 878 555 0101', verified_name: 'Restaurante Uno', name_status: 'APPROVED', platform_type: 'CLOUD_API', ...extra });

// ── metaGraph ────────────────────────────────────────────────────────────
await t('GRAPH', 'versión por omisión vigente (v25.0) y META_GRAPH_VERSION solo con forma vNN.0', () => {
  assert.strictEqual(G.versionGraph(), 'v25.0');
  process.env.META_GRAPH_VERSION = 'v27.0'; assert.strictEqual(G.versionGraph(), 'v27.0');
  for (const malo of ['v27', '27.0', 'v27.0/../x', 'v1.0']) { process.env.META_GRAPH_VERSION = malo; assert.strictEqual(G.versionGraph(), 'v25.0', malo); }
  delete process.env.META_GRAPH_VERSION;
});
await t('GRAPH', 'en producción solo habla con graph.facebook.com aunque haya META_GRAPH_BASE_URL', () => {
  const antes = process.env.NODE_ENV;
  process.env.META_GRAPH_BASE_URL = 'http://atacante.test';
  process.env.NODE_ENV = 'production';
  try { assert.strictEqual(G.baseGraph(), 'https://graph.facebook.com'); }
  finally { process.env.NODE_ENV = antes; if (antes === undefined) delete process.env.NODE_ENV; delete process.env.META_GRAPH_BASE_URL; }
});
await t('GRAPH', 'una ruta con .., ?, #, espacios o barra inicial se rechaza antes de salir', async () => {
  for (const ruta of ['../me', '123/../me', '123?fields=x', '123#a', '123 /x', '/123', '']) {
    await assert.rejects(() => G.llamarGraph({ ruta, fetchImpl: fetchFalso({}) }), /ruta inválida/, ruta);
  }
  await assert.rejects(() => G.llamarGraph({ metodo: 'PUT', ruta: '123', fetchImpl: fetchFalso({}) }), /método inválido/);
});
await t('GRAPH', 'el token viaja como Bearer, nunca en la URL', async () => {
  const f = fetchFalso({ [`GET ${WABA}/phone_numbers`]: numeros([]) });
  await G.llamarGraph({ ruta: `${WABA}/phone_numbers`, token: TOKEN, fetchImpl: f });
  assert.strictEqual(f.llamadas[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!f.llamadas[0].url.toString().includes(TOKEN));
});
await t('GRAPH', 'un rechazo de Meta no lanza: devuelve código y mensaje redactado', async () => {
  const f = fetchFalso({ 'GET 123/x': () => [400, { error: { code: 190, error_subcode: 463, type: 'OAuthException', message: `Token ${TOKEN} vencido, tel 5218785550101` } }] });
  const r = await G.llamarGraph({ ruta: '123/x', fetchImpl: f });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.codigo, 190);
  assert.strictEqual(r.error.subcodigo, 463);
  assert.ok(!r.error.mensaje.includes(TOKEN), 'el token no debe quedar en el mensaje');
  assert.ok(!r.error.mensaje.includes('5218785550101'), 'el teléfono completo no debe quedar');
  assert.ok(r.error.mensaje.includes('0101'));
});
await t('GRAPH', 'sin red: ok=false tipo red, sin lanzar', async () => {
  const r = await G.llamarGraph({ ruta: '123', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.tipo, 'red');
});
await t('GRAPH', 'listarGraph sigue la paginación y respeta el tope', async () => {
  let n = 0;
  const f = fetchFalso({ 'GET 9999999/flows': () => { n++; return [200, { data: [{ id: String(n) }], paging: { cursors: { after: `c${n}` }, next: 'https://x' } }]; } });
  const r = await G.listarGraph({ ruta: '9999999/flows', maxPaginas: 3, fetchImpl: f });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.elementos.length, 3);
  assert.strictEqual(f.llamadas[1].url.searchParams.get('after'), 'c1');
});
await t('GRAPH', 'esIdGraph solo acepta dígitos', () => {
  assert.ok(G.esIdGraph('123456789012345'));
  for (const v of ['123/../me', 'abc', '12', null, 123456789]) assert.ok(!G.esIdGraph(v), String(v));
});

// ── Interruptor (lo más estricto gana) ───────────────────────────────────
await t('MODO', 'por omisión: apagado', () => {
  assert.strictEqual(A.resolverModoVerificacion(undefined, undefined), 'apagado');
  assert.strictEqual(A.resolverModoVerificacion('cualquiera', ''), 'apagado');
});
await t('MODO', 'el negocio puede ENDURECER el modo de la plataforma', () => {
  assert.strictEqual(A.resolverModoVerificacion('observar', 'apagado'), 'observar');
  assert.strictEqual(A.resolverModoVerificacion('EXIGIR', undefined), 'exigir');
});
await t('MODO', 'el negocio NO puede relajar el modo de la plataforma', () => {
  assert.strictEqual(A.resolverModoVerificacion('apagado', 'exigir'), 'exigir');
  assert.strictEqual(A.resolverModoVerificacion('observar', 'exigir'), 'exigir');
  assert.strictEqual(A.resolverModoVerificacion('apagado', 'observar'), 'observar');
});

// ── Concesión y activos ──────────────────────────────────────────────────
await t('ACTIVOS', 'sin credencial de app no se verifica nada', async () => {
  const id = process.env.META_APP_ID; delete process.env.META_APP_ID;
  try {
    const r = await A.leerConcesion({ accessToken: TOKEN, fetchImpl: fetchFalso({}) });
    assert.strictEqual(r.motivo, A.MOTIVOS.SIN_CREDENCIAL_APP);
  } finally { process.env.META_APP_ID = id; }
});
await t('ACTIVOS', 'token de otra app: rechazado', async () => {
  const r = await A.verificarActivosConcedidos({ accessToken: TOKEN, phoneNumberId: PNID, wabaId: WABA,
    fetchImpl: fetchFalso({ 'GET debug_token': concesion({ app: '999999999' }) }) });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.motivo, A.MOTIVOS.TOKEN_DE_OTRA_APP);
});
await t('ACTIVOS', 'token inválido / sin permisos de WhatsApp: rechazado', async () => {
  let r = await A.verificarActivosConcedidos({ accessToken: TOKEN, fetchImpl: fetchFalso({ 'GET debug_token': concesion({ valida: false }) }) });
  assert.strictEqual(r.motivo, A.MOTIVOS.TOKEN_INVALIDO);
  r = await A.verificarActivosConcedidos({ accessToken: TOKEN, fetchImpl: fetchFalso({ 'GET debug_token': concesion({ scopes: ['whatsapp_business_messaging'] }) }) });
  assert.strictEqual(r.motivo, A.MOTIVOS.SIN_PERMISO_WHATSAPP);
});
await t('ACTIVOS', 'las cuentas concedidas salen solo del permiso de administración', async () => {
  const f = fetchFalso({ 'GET debug_token': () => [200, { data: { is_valid: true, app_id: APP, expires_at: 0, scopes: A.PERMISOS_WHATSAPP,
    granular_scopes: [
      { scope: 'whatsapp_business_management', target_ids: [WABA] },
      { scope: 'whatsapp_business_messaging', target_ids: [WABA, '400000000000009'] },
      { scope: 'business_management', target_ids: ['500000000000009'] },
    ] } }] });
  const c = await A.leerConcesion({ accessToken: TOKEN, fetchImpl: f });
  assert.deepStrictEqual(c.wabasConcedidas, [WABA]);
  assert.strictEqual(c.nunca, true);
  assert.strictEqual(c.venceAt, null);
});
await t('ACTIVOS', 'el debug_token usa la credencial de la APP y el token del negocio como input_token', async () => {
  const f = fetchFalso({ 'GET debug_token': concesion(), [`GET ${WABA}/phone_numbers`]: numeros([numero(PNID)]) });
  await A.verificarActivosConcedidos({ accessToken: TOKEN, phoneNumberId: PNID, wabaId: WABA, fetchImpl: f });
  const u = f.llamadas[0].url;
  assert.strictEqual(u.searchParams.get('input_token'), TOKEN);
  assert.strictEqual(u.searchParams.get('access_token'), `${APP}|${process.env.META_APP_SECRET}`);
  assert.strictEqual(f.llamadas[1].headers.Authorization, `Bearer ${TOKEN}`);
});
await t('ACTIVOS', 'WABA que no se concedió: rechazada', async () => {
  const r = await A.verificarActivosConcedidos({ accessToken: TOKEN, phoneNumberId: PNID, wabaId: WABA2,
    fetchImpl: fetchFalso({ 'GET debug_token': concesion() }) });
  assert.strictEqual(r.motivo, A.MOTIVOS.WABA_NO_CONCEDIDA);
});
await t('ACTIVOS', 'número que no está en la WABA: rechazado', async () => {
  const r = await A.verificarActivosConcedidos({ accessToken: TOKEN, phoneNumberId: PNID2, wabaId: WABA,
    fetchImpl: fetchFalso({ 'GET debug_token': concesion(), [`GET ${WABA}/phone_numbers`]: numeros([numero(PNID)]) }) });
  assert.strictEqual(r.motivo, A.MOTIVOS.NUMERO_NO_PERTENECE);
});
await t('ACTIVOS', 'sin ids del navegador: se descubren si no hay ambigüedad', async () => {
  const r = await A.verificarActivosConcedidos({ accessToken: TOKEN,
    fetchImpl: fetchFalso({ 'GET debug_token': concesion(), [`GET ${WABA}/phone_numbers`]: numeros([numero(PNID)]) }) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.wabaId, WABA); assert.strictEqual(r.phoneNumberId, PNID);
  assert.strictEqual(r.descubierto, true);
  assert.strictEqual(r.estadoNombre, 'APPROVED');
  assert.strictEqual(r.venceAt, new Date(1893456000 * 1000).toISOString());
});
await t('ACTIVOS', 'varias cuentas concedidas sin elección: la primera de target_ids (la más reciente, según Meta)', async () => {
  const f = fetchFalso({ 'GET debug_token': concesion({ wabas: [WABA2, WABA] }), [`GET ${WABA2}/phone_numbers`]: numeros([numero(PNID2)]) });
  const r = await A.verificarActivosConcedidos({ accessToken: TOKEN, fetchImpl: f });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.wabaId, WABA2);
  assert.strictEqual(r.phoneNumberId, PNID2);
  assert.strictEqual(r.wabasConcedidas, 2);
});
await t('ACTIVOS', 'sin cuentas en target_ids: no concedida', async () => {
  const r = await A.verificarActivosConcedidos({ accessToken: TOKEN, fetchImpl: fetchFalso({ 'GET debug_token': concesion({ wabas: [] }) }) });
  assert.strictEqual(r.motivo, A.MOTIVOS.WABA_NO_CONCEDIDA);
});
await t('ACTIVOS', 'dos números sin elección: ambiguo, no se adivina', async () => {
  const r = await A.verificarActivosConcedidos({ accessToken: TOKEN, wabaId: WABA,
    fetchImpl: fetchFalso({ 'GET debug_token': concesion(), [`GET ${WABA}/phone_numbers`]: numeros([numero(PNID), numero(PNID2)]) }) });
  assert.strictEqual(r.motivo, A.MOTIVOS.NUMERO_AMBIGUO);
});
await t('ACTIVOS', 'ids del navegador con forma rara: rechazados sin llamar a Meta', async () => {
  const f = fetchFalso({});
  const r = await A.verificarActivosConcedidos({ accessToken: TOKEN, phoneNumberId: '123/../me', fetchImpl: f });
  assert.strictEqual(r.motivo, A.MOTIVOS.ID_MALFORMADO);
  assert.strictEqual(f.llamadas.length, 0);
});
await t('ACTIVOS', 'nombre y número de Meta se guardan sin marcado', () => {
  assert.strictEqual(A.limpiarNombreVisible('<img src=x onerror=alert(1)>Tacos "Uno"'), 'img src=x onerror=alert(1)Tacos Uno');
  assert.strictEqual(A.limpiarNumeroVisible('+52 (878) 555-0101<script>'), '+52 (878) 555-0101');
  assert.strictEqual(A.limpiarNombreVisible(''), null);
});
await t('ACTIVOS', 'cada motivo tiene su mensaje para el cliente', () => {
  for (const m of Object.values(A.MOTIVOS)) assert.ok(A.MENSAJE_CLIENTE[m], m);
});

// ── Verificación aplicada al callback ────────────────────────────────────
const metaFeliz = () => fetchFalso({ 'GET debug_token': concesion(), [`GET ${WABA}/phone_numbers`]: numeros([numero(PNID)]) });
await t('CALLBACK', 'apagado: no llama a Meta y deja los ids exactamente como llegaron', async () => {
  const f = metaFeliz();
  const r = await V.aplicarVerificacion({ modo: 'apagado', accessToken: TOKEN, phoneNumberId: ` ${PNID} `, wabaId: WABA, fetchImpl: f });
  assert.strictEqual(f.llamadas.length, 0);
  assert.deepStrictEqual(r, { rechazo: null, ids: { phoneNumberId: ` ${PNID} `, wabaId: WABA }, extras: {}, auditoria: null });
});
await t('CALLBACK', 'observar: aunque la verificación falle, NUNCA rechaza ni cambia ids', async () => {
  const r = await V.aplicarVerificacion({ modo: 'observar', accessToken: TOKEN, phoneNumberId: PNID2, wabaId: WABA, fetchImpl: metaFeliz() });
  assert.strictEqual(r.rechazo, null);
  assert.deepStrictEqual(r.ids, { phoneNumberId: PNID2, wabaId: WABA });
  assert.deepStrictEqual(r.extras, {});
  assert.strictEqual(r.auditoria.ok, false);
  assert.strictEqual(r.auditoria.motivo, A.MOTIVOS.NUMERO_NO_PERTENECE);
});
await t('CALLBACK', 'observar: con el MISMO número confirmado, aporta número visible, nombre y vencimiento', async () => {
  const r = await V.aplicarVerificacion({ modo: 'observar', accessToken: TOKEN, phoneNumberId: PNID, wabaId: WABA, fetchImpl: metaFeliz() });
  assert.strictEqual(r.rechazo, null);
  assert.strictEqual(r.extras.verifiedName, 'Restaurante Uno');
  assert.strictEqual(r.extras.estadoNombre, 'APPROVED');
  assert.ok(r.extras.tokenExpiraAt);
});
await t('CALLBACK', 'observar: si el navegador no mandó número, no se toma el descubierto', async () => {
  const r = await V.aplicarVerificacion({ modo: 'observar', accessToken: TOKEN, phoneNumberId: null, wabaId: null, fetchImpl: metaFeliz() });
  assert.strictEqual(r.auditoria.ok, true);
  assert.deepStrictEqual(r.extras, {});
});
await t('CALLBACK', 'exigir: rechaza con el mensaje del cliente y estado HTTP coherente', async () => {
  let r = await V.aplicarVerificacion({ modo: 'exigir', accessToken: TOKEN, phoneNumberId: PNID2, wabaId: WABA, fetchImpl: metaFeliz() });
  assert.strictEqual(r.rechazo.status, 400);
  assert.strictEqual(r.rechazo.error, A.MENSAJE_CLIENTE[A.MOTIVOS.NUMERO_NO_PERTENECE]);
  r = await V.aplicarVerificacion({ modo: 'exigir', accessToken: TOKEN, phoneNumberId: PNID, wabaId: WABA, fetchImpl: async () => { throw new TypeError('x'); } });
  assert.strictEqual(r.rechazo.status, 502);
});
await t('CALLBACK', 'exigir: sin ids del navegador guarda los que confirmó Meta', async () => {
  const r = await V.aplicarVerificacion({ modo: 'exigir', accessToken: TOKEN, fetchImpl: metaFeliz() });
  assert.strictEqual(r.rechazo, null);
  assert.deepStrictEqual(r.ids, { phoneNumberId: PNID, wabaId: WABA });
});
await t('CALLBACK', 'la auditoría nunca lleva el token', async () => {
  for (const modo of ['observar', 'exigir']) {
    const r = await V.aplicarVerificacion({ modo, accessToken: TOKEN, phoneNumberId: PNID, wabaId: WABA, fetchImpl: metaFeliz() });
    assert.ok(!JSON.stringify(r).includes(TOKEN), modo);
  }
});

// ── Alertas del tablero ──────────────────────────────────────────────────
const ahora = new Date('2026-11-27T12:00:00Z');
const dias = (n) => new Date(ahora.getTime() + n * 86400000).toISOString();
const claves = (f) => P.alertasDeIntegracion(f, ahora).map(a => `${a.clave}:${a.nivel}`);
await t('ALERTAS', 'vencida, por vencer (crítico a 3 días o menos) y desconocida', () => {
  assert.deepStrictEqual(claves({ estado: 'activo', app_suscrita_waba: true, tiene_credencial: true, token_expira_at: dias(-1) }), ['credencial_vencida:critico']);
  assert.deepStrictEqual(claves({ estado: 'activo', app_suscrita_waba: true, tiene_credencial: true, token_expira_at: dias(10) }), ['credencial_por_vencer:aviso']);
  assert.deepStrictEqual(claves({ estado: 'activo', app_suscrita_waba: true, tiene_credencial: true, token_expira_at: dias(2) }), ['credencial_por_vencer:critico']);
  assert.deepStrictEqual(claves({ estado: 'activo', app_suscrita_waba: true, tiene_credencial: true, token_expira_at: null }), ['vencimiento_desconocido:aviso']);
  assert.deepStrictEqual(claves({ estado: 'activo', app_suscrita_waba: true, tiene_credencial: true, token_expira_at: dias(60) }), []);
});
await t('ALERTAS', 'rechazada, sin suscripción, pendiente, error, desconectado, nombre rechazado', () => {
  assert.ok(claves({ estado: 'activo', ultimo_error_codigo: 'credencial:190', app_suscrita_waba: true }).includes('credencial_rechazada:critico'));
  assert.ok(claves({ estado: 'activo', app_suscrita_waba: false }).includes('sin_suscripcion:critico'));
  assert.deepStrictEqual(claves({ estado: 'pendiente_activacion' }), ['activacion_pendiente:aviso']);
  assert.deepStrictEqual(claves({ estado: 'error' }), ['estado_error:critico']);
  assert.deepStrictEqual(claves({ estado: 'desconectado' }), ['desconectado:aviso']);
  assert.ok(claves({ estado: 'activo', app_suscrita_waba: true, estado_nombre: 'REJECTED' }).includes('nombre_rechazado:aviso'));
});
await t('ALERTAS', 'enmascarar deja solo los últimos 4', () => {
  assert.strictEqual(P.enmascarar(PNID), '…0001');
  assert.strictEqual(P.enmascarar(null), null);
});

// ── Formularios ──────────────────────────────────────────────────────────
await t('FORMULARIOS', 'diagnóstico de un formulario configurado', () => {
  assert.match(F.problemaDeFormulario({ flowId: 'abc' }, null), /forma de id/);
  assert.match(F.problemaDeFormulario({ flowId: '1234567' }, null), /no lo tiene/);
  assert.match(F.problemaDeFormulario({ flowId: '1234567' }, { estado: 'PUBLISHED', erroresValidacion: 2 }), /2 error/);
  assert.match(F.problemaDeFormulario({ flowId: '1234567' }, { estado: 'DRAFT', erroresValidacion: 0 }), /borrador/);
  assert.match(F.problemaDeFormulario({ flowId: '1234567' }, { estado: 'DEPRECATED', erroresValidacion: 0 }), /retirado/);
  assert.strictEqual(F.problemaDeFormulario({ flowId: '1234567' }, { estado: 'PUBLISHED', erroresValidacion: 0 }), null);
});

// ── Retiro de la suscripción ─────────────────────────────────────────────
await t('DESCONEXION', 'sin WABA o sin credencial: no se llama a Meta', async () => {
  const f = fetchFalso({});
  assert.strictEqual((await D.retirarSuscripcionWaba({ wabaId: null, accessToken: TOKEN, fetchImpl: f })).omitido, true);
  assert.strictEqual((await D.retirarSuscripcionWaba({ wabaId: WABA, accessToken: null, fetchImpl: f })).omitido, true);
  assert.strictEqual(f.llamadas.length, 0);
});
await t('DESCONEXION', 'DELETE /{waba}/subscribed_apps con Bearer; un rechazo no lanza', async () => {
  let f = fetchFalso({ [`DELETE ${WABA}/subscribed_apps`]: () => [200, { success: true }] });
  assert.strictEqual((await D.retirarSuscripcionWaba({ wabaId: WABA, accessToken: TOKEN, fetchImpl: f })).ok, true);
  assert.strictEqual(f.llamadas[0].headers.Authorization, `Bearer ${TOKEN}`);
  f = fetchFalso({ [`DELETE ${WABA}/subscribed_apps`]: () => [400, { error: { code: 200, message: 'Permisos' } }] });
  const r = await D.retirarSuscripcionWaba({ wabaId: WABA, accessToken: TOKEN, fetchImpl: f });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.codigo, 200);
});
await t('DESCONEXION', 'sin respuesta de éxito explícita no se da por retirada', async () => {
  const f = fetchFalso({ [`DELETE ${WABA}/subscribed_apps`]: () => [200, {}] });
  assert.strictEqual((await D.retirarSuscripcionWaba({ wabaId: WABA, accessToken: TOKEN, fetchImpl: f })).ok, false);
});

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log(fallos.join('\n')); process.exitCode = 1; }
const { pool } = await import('../src/services/database.js');
await pool.end().catch(() => {});
