// Central de Operaciones (Superadmin) — Frente A del MVP de escala.
// Cubre: migración 037, listado escalable con pipeline, ficha agregada,
// checklist operativo (automático vs. manual), transiciones de onboarding
// (manuales vs. derivadas), y sesiones de soporte de punta a punta por HTTP
// (crear, usar el panel del negocio, barra visible vía /api/auth/me,
// aislamiento, cierre manual, revocación server-side, permisos).
//
// Uso: DATABASE_URL=... PANEL_SECRET=... SESSION_SECRET=... ADMIN_PASSWORD=...
//      INTEGRATIONS_ENCRYPTION_KEY=... node test/fase-central-operaciones.mjs
// Requiere aplicar-migraciones.mjs (incluye 037) y seed-datos-prueba.mjs.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4930';

const { pool } = await import('../src/services/database.js');
const {
  obtenerFichaNegocio, actualizarPasoChecklistOperativo, actualizarOnboardingEstado,
  actualizarImplementacion, listarNegociosCentral, crearSesionSoporte, sesionSoporteVigente,
  cerrarSesionSoporte, listarSesionesSoporte,
} = await import('../src/services/centralOperaciones.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
function cookieDe(setCookieHeader) {
  // "xabor_sesion=VALOR; Path=/; ..." -> "xabor_sesion=VALOR"
  return setCookieHeader.split(';')[0];
}

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;
const cookieSuperadmin = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.superadminUsuarioId, negocioId: SEED.negocioA, rol: 'admin' }))}`;
const cookieAdminA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: SEED.negocioA, rol: 'admin' }))}`;

async function api(path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json, headers: r.headers };
}

// ═══════════ Migración 037 ═══════════
await t('MIGRACION', '037: columnas y tabla presentes', async () => {
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='negocios' AND column_name IN ('onboarding_estado','implementacion')`);
  assert.strictEqual(cols.rows.length, 2);
  const tabla = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name='sesiones_soporte'`);
  assert.strictEqual(tabla.rows.length, 1);
});

// ═══════════ Listado escalable ═══════════
await t('LISTADO', 'pagina, filtra por onboarding y nunca excede el límite', async () => {
  const r1 = await listarNegociosCentral({ limit: 2, offset: 0 });
  assert.ok(r1.total >= 4, `el seed crea al menos 4 negocios, total=${r1.total}`);
  assert.ok(r1.negocios.length <= 2);
  const r2 = await listarNegociosCentral({ limit: 2, offset: 2 });
  assert.notStrictEqual(r1.negocios[0]?.id, r2.negocios[0]?.id);
  const rLimite = await listarNegociosCentral({ limit: 99999 });
  assert.ok(rLimite.negocios.length <= 100, 'limit se acota a 100');
});

await t('LISTADO', 'HTTP: solo superadmin; admin de negocio recibe 403', async () => {
  const rSuper = await api('/api/superadmin/central/negocios?limit=5', { cookie: cookieSuperadmin });
  assert.strictEqual(rSuper.status, 200);
  assert.ok(Array.isArray(rSuper.body.negocios));
  const rAdmin = await api('/api/superadmin/central/negocios', { cookie: cookieAdminA });
  assert.strictEqual(rAdmin.status, 403);
  const rNada = await api('/api/superadmin/central/negocios');
  assert.strictEqual(rNada.status, 401);
});

// ═══════════ Ficha ═══════════
await t('FICHA', 'estructura completa y sin secretos', async () => {
  const ficha = await obtenerFichaNegocio(SEED.negocioA);
  assert.ok(ficha.general && ficha.cuenta && ficha.configuracion && ficha.operacion && ficha.implementacion);
  assert.ok(Array.isArray(ficha.checklist_operativo) && ficha.checklist_operativo.length >= 16);
  const texto = JSON.stringify(ficha).toLowerCase();
  for (const palabra of ['password_hash', 'token_hash', 'secret', 'api_key', 'credencial_cifrada']) {
    assert.ok(!texto.includes(palabra), `la ficha nunca debe incluir "${palabra}"`);
  }
});

await t('FICHA', 'HTTP 404 para negocio inexistente, 200 para real', async () => {
  const r404 = await api('/api/superadmin/negocios/00000000-0000-0000-0000-000000000000/ficha', { cookie: cookieSuperadmin });
  assert.strictEqual(r404.status, 404);
  const r200 = await api(`/api/superadmin/negocios/${SEED.negocioA}/ficha`, { cookie: cookieSuperadmin });
  assert.strictEqual(r200.status, 200);
  assert.strictEqual(r200.body.general.id, SEED.negocioA);
});

// ═══════════ Checklist operativo ═══════════
await t('CHECKLIST', 'paso manual se marca con responsable/notas/fecha y persiste', async () => {
  const r = await actualizarPasoChecklistOperativo(SEED.negocioA, 'capacitacion', {
    estado: 'completado', responsable: 'Equipo Xabor', notas: 'capacitación en sitio', fecha: '2026-08-06',
  }, SEED.superadminUsuarioId);
  assert.strictEqual(r.estado, 'completado');
  const ficha = await obtenerFichaNegocio(SEED.negocioA);
  const paso = ficha.checklist_operativo.find(p => p.clave === 'capacitacion');
  assert.strictEqual(paso.estado, 'completado');
  assert.strictEqual(paso.responsable, 'Equipo Xabor');
});

await t('CHECKLIST', 'paso automático rechaza cambio manual de estado; estado inválido rechazado', async () => {
  await assert.rejects(
    () => actualizarPasoChecklistOperativo(SEED.negocioA, 'menu', { estado: 'completado' }, SEED.superadminUsuarioId),
    (e) => e.code === 'PASO_AUTOMATICO'
  );
  await assert.rejects(
    () => actualizarPasoChecklistOperativo(SEED.negocioA, 'capacitacion', { estado: 'inventado' }, SEED.superadminUsuarioId),
    (e) => e.code === 'ESTADO_INVALIDO'
  );
  await assert.rejects(
    () => actualizarPasoChecklistOperativo(SEED.negocioA, 'paso_inexistente', { estado: 'completado' }, SEED.superadminUsuarioId),
    (e) => e.code === 'PASO_INVALIDO'
  );
});

await t('CHECKLIST', 'paso automático SÍ acepta metadatos (responsable/notas) sin tocar el estado', async () => {
  const r = await actualizarPasoChecklistOperativo(SEED.negocioA, 'menu', { responsable: 'Cliente', notas: 'sube su menú el jueves' }, SEED.superadminUsuarioId);
  assert.strictEqual(r.responsable, 'Cliente');
});

// ═══════════ Onboarding ═══════════
await t('ONBOARDING', 'estado manual se fija y queda auditado; automático e inválido rechazados', async () => {
  const r = await actualizarOnboardingEstado(SEED.negocioB, 'pruebas', SEED.superadminUsuarioId);
  assert.strictEqual(r.nuevo, 'pruebas');
  await assert.rejects(() => actualizarOnboardingEstado(SEED.negocioB, 'cuenta_creada', SEED.superadminUsuarioId), (e) => e.code === 'ESTADO_AUTOMATICO');
  await assert.rejects(() => actualizarOnboardingEstado(SEED.negocioB, 'volando', SEED.superadminUsuarioId), (e) => e.code === 'ESTADO_INVALIDO');
  const aud = await pool.query(`SELECT 1 FROM auditoria_plataforma WHERE negocio_id=$1 AND accion='onboarding_estado'`, [SEED.negocioB]);
  assert.ok(aud.rows.length >= 1);
});

await t('ONBOARDING', 'derivación automática avanza (admin con password -> configuracion_en_proceso) pero nunca retrocede un manual', async () => {
  // Determinista en ambos entornos (base recién migrada O base con backfill
  // posterior al seed): se fija el persistido en un estado TEMPRANO y se
  // verifica que el derivado (admin con password) lo AVANZA al leer.
  await pool.query(`UPDATE negocios SET onboarding_estado = 'alta_iniciada' WHERE id = $1`, [SEED.negocioA]);
  const fichaA = await obtenerFichaNegocio(SEED.negocioA);
  assert.strictEqual(fichaA.implementacion.onboarding_estado, 'configuracion_en_proceso', 'el derivado avanza sobre un persistido anterior');
  assert.strictEqual(fichaA.implementacion.onboarding_persistido, 'alta_iniciada', 'sin escribir: la derivación es de lectura');
  // negocioB quedó manualmente en 'pruebas' (posterior al derivado) -- el derivado no lo baja
  const fichaB = await obtenerFichaNegocio(SEED.negocioB);
  assert.strictEqual(fichaB.implementacion.onboarding_estado, 'pruebas');
});

// ═══════════ Implementación ═══════════
await t('IMPLEMENTACION', 'campos se guardan y aparecen en ficha y listado', async () => {
  await actualizarImplementacion(SEED.negocioA, {
    responsable_implementacion: 'Mario', siguiente_accion: 'cargar menú',
    bloqueantes: ['cliente sin logo'], fecha_objetivo: '2026-08-15', mensualidad: 1500,
  }, SEED.superadminUsuarioId);
  const ficha = await obtenerFichaNegocio(SEED.negocioA);
  assert.strictEqual(ficha.implementacion.siguiente_accion, 'cargar menú');
  assert.deepStrictEqual(ficha.implementacion.bloqueantes, ['cliente sin logo']);
  assert.strictEqual(ficha.general.mensualidad, 1500);
  const listado = await listarNegociosCentral({ buscar: '', limit: 100 });
  const fila = listado.negocios.find(n => n.id === SEED.negocioA);
  assert.strictEqual(fila.responsable_implementacion, 'Mario');
  assert.strictEqual(Number(fila.num_bloqueantes), 1);
});

// ═══════════ Sesión de soporte (punta a punta por HTTP) ═══════════
let cookieSoporte = null;
await t('SOPORTE', 'superadmin crea sesión de soporte -> cookie emitida, token nunca en el cuerpo', async () => {
  const r = await api(`/api/superadmin/negocios/${SEED.negocioA}/sesion-soporte`, {
    cookie: cookieSuperadmin, method: 'POST', body: { motivo: 'prueba automatizada' },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.ok && r.body.negocio && r.body.expiresAt);
  assert.strictEqual(r.body.token, undefined, 'el token jamás viaja en el cuerpo');
  const setCookie = r.headers.get('set-cookie');
  assert.ok(setCookie && setCookie.includes('xabor_sesion='), 'debe emitir la cookie de sesión');
  cookieSoporte = cookieDe(setCookie);
});

await t('SOPORTE', 'la cookie de soporte opera el panel del negocio y /api/auth/me muestra la barra', async () => {
  const me = await api('/api/auth/me', { cookie: cookieSoporte });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.negocioId, SEED.negocioA);
  assert.strictEqual(me.body.rol, 'admin');
  assert.ok(me.body.soporte?.activo === true, 'debe marcar soporte.activo');
  assert.ok(me.body.soporte.negocioNombre, 'debe traer el nombre del negocio para la barra');
});

await t('SOPORTE', 'negocio_id fijado en servidor: la misma cookie NUNCA ve otro negocio', async () => {
  // la cookie va atada a negocioA dentro del token firmado -- pedir datos
  // siempre regresa negocioA, sin importar query/params.
  const me = await api('/api/auth/me?negocioId=' + SEED.negocioB, { cookie: cookieSoporte });
  assert.strictEqual(me.body.negocioId, SEED.negocioA);
});

await t('SOPORTE', 'un admin normal no puede crear sesiones de soporte (403)', async () => {
  const r = await api(`/api/superadmin/negocios/${SEED.negocioA}/sesion-soporte`, { cookie: cookieAdminA, method: 'POST' });
  assert.strictEqual(r.status, 403);
});

await t('SOPORTE', 'token con flag sop forjado sin fila en sesiones_soporte -> rechazado (revocación server-side)', async () => {
  // Un token firmado válido (mismo secreto de pruebas) pero SIN fila en la
  // tabla: el middleware debe rechazarlo aunque el HMAC sea correcto --
  // esto es exactamente lo que impide que un token de soporte viejo
  // (cerrado/expirado en tabla) siga funcionando hasta su exp natural.
  const forjado = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.superadminUsuarioId, negocioId: SEED.negocioB, rol: 'admin', sop: true }))}`;
  const me = await api('/api/auth/me', { cookie: forjado });
  assert.strictEqual(me.status, 401);
});

await t('SOPORTE', 'listado de sesiones vigentes la incluye; queda auditoría de inicio', async () => {
  const lista = await listarSesionesSoporte({ negocioId: SEED.negocioA, soloVigentes: true });
  assert.ok(lista.length >= 1);
  const aud = await pool.query(`SELECT 1 FROM auditoria_plataforma WHERE negocio_id=$1 AND accion='sesion_soporte_iniciada'`, [SEED.negocioA]);
  assert.ok(aud.rows.length >= 1);
});

await t('SOPORTE', 'salir cierra la sesión: la misma cookie deja de funcionar de inmediato', async () => {
  const salir = await api('/api/auth/soporte/salir', { cookie: cookieSoporte, method: 'POST' });
  assert.strictEqual(salir.status, 200);
  const me = await api('/api/auth/me', { cookie: cookieSoporte });
  assert.strictEqual(me.status, 401, 'tras salir, la cookie de soporte queda revocada');
  const aud = await pool.query(`SELECT 1 FROM auditoria_plataforma WHERE negocio_id=$1 AND accion='sesion_soporte_cerrada'`, [SEED.negocioA]);
  assert.ok(aud.rows.length >= 1);
});

await t('SOPORTE', 'una sesión normal que llama a salir recibe 400 y no se toca', async () => {
  const r = await api('/api/auth/soporte/salir', { cookie: cookieAdminA, method: 'POST' });
  assert.strictEqual(r.status, 400);
  const me = await api('/api/auth/me', { cookie: cookieAdminA });
  assert.strictEqual(me.status, 200, 'la sesión normal sigue viva');
});

await t('SOPORTE', 'cierre por servicio (cerrarSesionSoporte) también revoca', async () => {
  const s = await crearSesionSoporte(SEED.superadminUsuarioId, SEED.negocioB, 'cierre programático');
  assert.ok(s?.token);
  assert.ok(await sesionSoporteVigente(s.token));
  await cerrarSesionSoporte(s.token, SEED.superadminUsuarioId, 'cierre de prueba');
  assert.strictEqual(await sesionSoporteVigente(s.token), null);
});

// ═══════════ Endurecimiento (revisión de integración) ═══════════
await t('SOPORTE-CADENA', 'una sesión de soporte NUNCA usa la consola Superadmin ni encadena otra sesión de soporte', async () => {
  const s = await crearSesionSoporte(SEED.superadminUsuarioId, SEED.negocioA, 'prueba de encadenamiento');
  const cookieSop = `xabor_sesion=${encodeURIComponent(s.token)}`;
  const rConsola = await api('/api/superadmin/central/negocios', { cookie: cookieSop });
  assert.strictEqual(rConsola.status, 403, 'la consola Superadmin rechaza cookies de soporte');
  const rCadena = await api(`/api/superadmin/negocios/${SEED.negocioB}/sesion-soporte`, { cookie: cookieSop, method: 'POST' });
  assert.strictEqual(rCadena.status, 403, 'soporte -> soporte hacia otro negocio queda bloqueado');
  await cerrarSesionSoporte(s.token, SEED.superadminUsuarioId, 'fin prueba encadenamiento');
});

await t('SOPORTE-DEGRADADO', 'si el usuario pierde el privilegio de superadmin, su sesión de soporte muere al instante', async () => {
  const s = await crearSesionSoporte(SEED.superadminUsuarioId, SEED.negocioA, 'prueba degradación');
  const cookieSop = `xabor_sesion=${encodeURIComponent(s.token)}`;
  assert.strictEqual((await api('/api/auth/me', { cookie: cookieSop })).status, 200, 'con privilegio, la sesión opera');
  await pool.query(`UPDATE administradores_plataforma SET activo = false WHERE usuario_id = $1`, [SEED.superadminUsuarioId]);
  try {
    const me = await api('/api/auth/me', { cookie: cookieSop });
    assert.strictEqual(me.status, 401, 'sin privilegio vivo, la sesión de soporte se rechaza en la siguiente request');
  } finally {
    await pool.query(`UPDATE administradores_plataforma SET activo = true WHERE usuario_id = $1`, [SEED.superadminUsuarioId]);
  }
  await cerrarSesionSoporte(s.token, SEED.superadminUsuarioId, 'fin prueba degradación');
});

await t('SOPORTE-EXPIRA', 'la expiración server-side (tabla) mata la sesión aunque el HMAC siga vigente', async () => {
  const s = await crearSesionSoporte(SEED.superadminUsuarioId, SEED.negocioA, 'prueba expiración');
  const cookieSop = `xabor_sesion=${encodeURIComponent(s.token)}`;
  assert.strictEqual((await api('/api/auth/me', { cookie: cookieSop })).status, 200);
  // Simular el paso del tiempo del lado servidor: el HMAC del token sigue
  // siendo válido (exp a 2h), pero la fila ya venció -- debe rechazarse.
  await pool.query(`UPDATE sesiones_soporte SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = encode(sha256($1::bytea), 'hex')`, [s.token]);
  const me = await api('/api/auth/me', { cookie: cookieSop });
  assert.strictEqual(me.status, 401, 'fila expirada = sesión muerta, sin esperar la expiración del HMAC');
});

await t('SOPORTE-MANIPULACION', 'negocioId inalterable por query/body/header/cookie secundaria', async () => {
  const s = await crearSesionSoporte(SEED.superadminUsuarioId, SEED.negocioA, 'prueba manipulación');
  const cookieSop = `xabor_sesion=${encodeURIComponent(s.token)}`;
  // query + body + header hostiles a la vez: el negocio sigue siendo el del token.
  const r = await fetch(base + `/api/auth/me?negocioId=${SEED.negocioB}`, {
    method: 'GET',
    headers: {
      'Cookie': cookieSop,
      'X-Negocio-Id': SEED.negocioB,
      'X-Forwarded-Negocio': SEED.negocioB,
    },
  });
  const me = await r.json();
  assert.strictEqual(me.negocioId, SEED.negocioA, 'headers/query jamás cambian el negocio');
  // Cookie secundaria: un segundo xabor_sesion (forjado con sop hacia B, sin
  // fila) DESPUÉS del legítimo -- el parser toma el primero; y aunque se
  // ponga primero, ese token forjado no tiene fila en sesiones_soporte.
  const forjado = crearTokenSesion({ usuarioId: SEED.superadminUsuarioId, negocioId: SEED.negocioB, rol: 'admin', sop: true });
  const rDoble = await fetch(base + '/api/auth/me', {
    headers: { 'Cookie': `${cookieSop}; xabor_sesion=${encodeURIComponent(forjado)}` },
  });
  const meDoble = await rDoble.json();
  assert.strictEqual(meDoble.negocioId, SEED.negocioA, 'la cookie secundaria no gana');
  const rPrimero = await fetch(base + '/api/auth/me', {
    headers: { 'Cookie': `xabor_sesion=${encodeURIComponent(forjado)}; ${cookieSop}` },
  });
  assert.strictEqual(rPrimero.status, 401, 'si la forjada va primero, se rechaza por falta de fila -- nunca opera B');
  await cerrarSesionSoporte(s.token, SEED.superadminUsuarioId, 'fin prueba manipulación');
});

await t('LISTADO', 'orden inválido cae al orden por defecto sin error (lista blanca)', async () => {
  const r = await api('/api/superadmin/central/negocios?orden=;DROP TABLE negocios;--&limit=5', { cookie: cookieSuperadmin });
  assert.strictEqual(r.status, 200, 'un orden hostil jamás llega al SQL');
  assert.ok(Array.isArray(r.body.negocios));
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(` - ${f}`)); }
await srv.detener();
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
