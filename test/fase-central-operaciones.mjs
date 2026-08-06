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
  // negocioA: su admin del seed tiene password -> derivado = configuracion_en_proceso
  const fichaA = await obtenerFichaNegocio(SEED.negocioA);
  assert.strictEqual(fichaA.implementacion.onboarding_estado, 'configuracion_en_proceso');
  // negocioB quedó manualmente en 'pruebas' (posterior) -- el derivado no lo baja
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

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(` - ${f}`)); }
await srv.detener();
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
