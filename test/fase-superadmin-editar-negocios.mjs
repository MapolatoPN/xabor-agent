// Edición de negocios desde Superadmin (caso Carnitas Moreno): un negocio
// dado de alta con el correo mal capturado no podía corregirse -- el
// "reenviar invitación" reenviaba al mismo correo equivocado y no existía
// PATCH de datos del negocio ni del admin invitado. Esta suite cubre, con
// un fixture que replica el caso real (correo mal → corregir → nueva
// invitación) y SIN enviar correos reales (sin proveedor configurado, el
// backend devuelve el enlace una sola vez en la respuesta):
//   - carga/edición parcial de negocio (nombre, slug, contacto en
//     configuracion) con validaciones y auditoría campo a campo
//   - corrección de correo/nombre del admin (UNIQUE, formato, sin duplicar)
//   - historial de invitaciones con estados derivados y SIN tokens
//   - reenviar / nueva invitación (revoca pendientes; 409 si ya aceptada)
//   - desactivar/reactivar sin borrar nada (sonda de acceso operativo)
//   - sesión de soporte (administrar negocio) reutilizada con auditoría
//   - seguridad: admin normal y acceso cruzado bloqueados (multi-tenant)
// Requiere aplicar-migraciones.mjs y seed-datos-prueba.mjs ya corridos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4935';

const { pool, crearNegocioCompleto, crearUsuarioConPassword } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
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

// ═══════════ Fixture: réplica sanitizada del caso Carnitas Moreno ═══════════
// Alta por el flujo REAL (crearNegocioCompleto) con el correo mal capturado.
for (const q of [
  `DELETE FROM auditoria_plataforma WHERE negocio_id IN (SELECT id FROM negocios WHERE slug LIKE 'carnitas-prueba%')`,
  `DELETE FROM sesiones_soporte WHERE negocio_id IN (SELECT id FROM negocios WHERE slug LIKE 'carnitas-prueba%')`,
  `DELETE FROM invitaciones_usuario WHERE negocio_id IN (SELECT id FROM negocios WHERE slug LIKE 'carnitas-prueba%')`,
  `DELETE FROM push_subscriptions WHERE negocio_id IN (SELECT id FROM negocios WHERE slug LIKE 'carnitas-prueba%')`,
  `DELETE FROM usuario_negocios WHERE negocio_id IN (SELECT id FROM negocios WHERE slug LIKE 'carnitas-prueba%')`,
  `DELETE FROM negocio_modulos WHERE negocio_id IN (SELECT id FROM negocios WHERE slug LIKE 'carnitas-prueba%')`,
  `DELETE FROM configuracion WHERE negocio_id IN (SELECT id FROM negocios WHERE slug LIKE 'carnitas-prueba%')`,
  `DELETE FROM metodos_pago WHERE negocio_id IN (SELECT id FROM negocios WHERE slug LIKE 'carnitas-prueba%')`,
  `DELETE FROM sucursales WHERE negocio_id IN (SELECT id FROM negocios WHERE slug LIKE 'carnitas-prueba%')`,
  `DELETE FROM usuarios WHERE email IN ('xiomar.mal@test.local','xiomar.bien@test.local','staff-carnitas@test.local')`,
  `DELETE FROM negocios WHERE slug LIKE 'carnitas-prueba%'`,
]) await pool.query(q);
const alta = await crearNegocioCompleto({
  nombre: 'Carnitas Moreno Prueba', slugDeseado: 'carnitas-prueba',
  nombrePropietario: 'Xiomar Prueba', emailAdmin: 'xiomar.mal@test.local',
  telefono: '8780000901', nombreSucursal: 'Matriz', ciudad: 'Acuña',
  plan: 'basico', estadoInicial: 'pendiente', superadminId: SEED.superadminUsuarioId,
});
const FIX = alta.negocio.id;

// ═══════════ 1) Cargar negocio ═══════════
await t('CARGA', 'GET /api/superadmin/negocios/:id devuelve el detalle del fixture', async () => {
  const r = await api(`/api/superadmin/negocios/${FIX}`, { cookie: cookieSuperadmin });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.slug, 'carnitas-prueba');
  assert.ok(Array.isArray(r.body.usuarios) && r.body.usuarios.length >= 1, 'el detalle incluye a los usuarios del negocio');
});

// ═══════════ 2-5) Edición parcial de datos ═══════════
await t('EDICION', 'editar nombre + teléfono + dirección + ciudad (parcial) actualiza y audita campo a campo', async () => {
  const r = await api(`/api/superadmin/negocios/${FIX}`, {
    cookie: cookieSuperadmin, method: 'PATCH',
    body: { nombre: 'Carnitas Moreno MX', contacto: { telefono: '8780000999', direccion: 'Av. Prueba 100', ciudad: 'Cd. Acuña' } },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.nombre, 'Carnitas Moreno MX');
  assert.strictEqual(r.body.cambiosAplicados, 4);

  const { rows: cfg } = await pool.query(`SELECT clave, valor FROM configuracion WHERE negocio_id = $1 AND clave IN ('telefono','direccion','ciudad') ORDER BY clave`, [FIX]);
  assert.deepStrictEqual(cfg.map(c => `${c.clave}=${c.valor}`), ['ciudad=Cd. Acuña', 'direccion=Av. Prueba 100', 'telefono=8780000999']);

  const { rows: [aud] } = await pool.query(
    `SELECT contexto FROM auditoria_plataforma WHERE negocio_id = $1 AND accion = 'editar_negocio' ORDER BY created_at DESC LIMIT 1`, [FIX]);
  assert.ok(aud, 'debe existir la fila de auditoría editar_negocio');
  const cambios = aud.contexto.cambios;
  const campoNombre = cambios.find(c => c.campo === 'nombre');
  assert.strictEqual(campoNombre.antes, 'Carnitas Moreno Prueba');
  assert.strictEqual(campoNombre.despues, 'Carnitas Moreno MX');
});
await t('EDICION', 'los campos NO enviados no se sobreescriben (PATCH parcial de solo slug)', async () => {
  const r = await api(`/api/superadmin/negocios/${FIX}`, {
    cookie: cookieSuperadmin, method: 'PATCH', body: { slug: 'carnitas-prueba-mx' },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.slug, 'carnitas-prueba-mx');
  assert.strictEqual(r.body.nombre, 'Carnitas Moreno MX', 'el nombre no debe cambiar al editar solo el slug');
  const { rows: [cfg] } = await pool.query(`SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'telefono'`, [FIX]);
  assert.strictEqual(cfg.valor, '8780000999', 'el contacto no debe tocarse');
});

// ═══════════ 6) Slug: duplicado / inválido / reservado ═══════════
await t('SLUG', 'slug duplicado → 409; inválido → 400; reservado → 400; el slug no cambia', async () => {
  const dup = await api(`/api/superadmin/negocios/${FIX}`, { cookie: cookieSuperadmin, method: 'PATCH', body: { slug: 'faseb-negocio-a' } });
  assert.strictEqual(dup.status, 409); assert.strictEqual(dup.body.codigo, 'SLUG_DUPLICADO');
  const inv = await api(`/api/superadmin/negocios/${FIX}`, { cookie: cookieSuperadmin, method: 'PATCH', body: { slug: '-Mal Slug-' } });
  assert.strictEqual(inv.status, 400); assert.strictEqual(inv.body.codigo, 'SLUG_INVALIDO');
  const resv = await api(`/api/superadmin/negocios/${FIX}`, { cookie: cookieSuperadmin, method: 'PATCH', body: { slug: 'superadmin' } });
  assert.strictEqual(resv.status, 400); assert.strictEqual(resv.body.codigo, 'SLUG_RESERVADO');
  const { rows: [n] } = await pool.query(`SELECT slug FROM negocios WHERE id = $1`, [FIX]);
  assert.strictEqual(n.slug, 'carnitas-prueba-mx');
});

// ═══════════ 7) Negocio inexistente ═══════════
await t('INEXISTENTE', 'PATCH a un negocio inexistente → 404', async () => {
  const r = await api(`/api/superadmin/negocios/00000000-0000-4000-8000-000000000000`, {
    cookie: cookieSuperadmin, method: 'PATCH', body: { nombre: 'X' },
  });
  assert.strictEqual(r.status, 404);
});

// ═══════════ 8) Invitación pendiente visible sin tokens ═══════════
await t('INVITACION', 'historial: la invitación del alta aparece pendiente, con correo destino y SIN token alguno', async () => {
  const r = await api(`/api/superadmin/negocios/${FIX}/invitaciones`, { cookie: cookieSuperadmin });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.invitaciones.length, 1);
  const i = r.body.invitaciones[0];
  assert.strictEqual(i.estado, 'pendiente');
  assert.strictEqual(i.correo_destino, 'xiomar.mal@test.local');
  assert.ok(i.creada_por, 'debe decir quién la generó');
  const crudo = JSON.stringify(r.body);
  assert.ok(!/token/i.test(crudo), 'la respuesta jamás incluye tokens ni hashes');
});

// ═══════════ 3+10) Correo mal → corregir → nueva invitación al correo bueno ═══════════
await t('CORREO', 'corregir el correo del admin (auditado) y generar nueva invitación al correo corregido; la anterior queda cancelada', async () => {
  const mal = await api(`/api/superadmin/negocios/${FIX}/admin`, {
    cookie: cookieSuperadmin, method: 'PATCH', body: { email: 'esto-no-es-un-correo' },
  });
  assert.strictEqual(mal.status, 400); assert.strictEqual(mal.body.codigo, 'EMAIL_INVALIDO');

  const r = await api(`/api/superadmin/negocios/${FIX}/admin`, {
    cookie: cookieSuperadmin, method: 'PATCH', body: { email: 'xiomar.bien@test.local', nombre: 'Xiomar Moreno' },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.email, 'xiomar.bien@test.local');
  assert.strictEqual(r.body.yaAcepto, false);

  const { rows: [aud] } = await pool.query(
    `SELECT contexto FROM auditoria_plataforma WHERE negocio_id = $1 AND accion = 'editar_admin_negocio' ORDER BY created_at DESC LIMIT 1`, [FIX]);
  assert.ok(aud.contexto.cambios.some(c => c.campo === 'admin.email' && c.antes === 'xiomar.mal@test.local' && c.despues === 'xiomar.bien@test.local'));

  const nueva = await api(`/api/superadmin/negocios/${FIX}/invitaciones/nueva`, { cookie: cookieSuperadmin, method: 'POST' });
  assert.strictEqual(nueva.status, 200, JSON.stringify(nueva.body));
  assert.strictEqual(nueva.body.correoDestino, 'xiomar.bien@test.local', 'la nueva invitación va al correo CORREGIDO');
  assert.ok(nueva.body.enlaceInvitacion, 'sin proveedor de correo, el enlace se devuelve una sola vez (no se envió correo real)');

  const hist = await api(`/api/superadmin/negocios/${FIX}/invitaciones`, { cookie: cookieSuperadmin });
  assert.strictEqual(hist.body.invitaciones.length, 2);
  assert.strictEqual(hist.body.invitaciones[0].estado, 'pendiente');
  assert.strictEqual(hist.body.invitaciones[1].estado, 'cancelada', 'la invitación anterior queda revocada, no duplicada');
});

// ═══════════ 9) Invitación expirada ═══════════
await t('INVITACION', 'una invitación vencida se muestra como expirada', async () => {
  await pool.query(`UPDATE invitaciones_usuario SET expires_at = NOW() - INTERVAL '1 hour'
                    WHERE negocio_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [FIX]);
  const r = await api(`/api/superadmin/negocios/${FIX}/invitaciones`, { cookie: cookieSuperadmin });
  assert.strictEqual(r.body.invitaciones[0].estado, 'expirada');
});

// ═══════════ 11) Reenviar ═══════════
await t('REENVIO', 'reenviar genera invitación nueva al correo actual y revoca la expirada pendiente', async () => {
  const r = await api(`/api/superadmin/negocios/${FIX}/reenviar-invitacion`, { cookie: cookieSuperadmin, method: 'POST' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const hist = await api(`/api/superadmin/negocios/${FIX}/invitaciones`, { cookie: cookieSuperadmin });
  assert.strictEqual(hist.body.invitaciones.length, 3);
  assert.strictEqual(hist.body.invitaciones[0].estado, 'pendiente');
  assert.strictEqual(hist.body.invitaciones[0].correo_destino, 'xiomar.bien@test.local');
});

// ═══════════ 12) Invitación aceptada no se duplica ═══════════
await t('ACEPTADA', 'con contraseña ya creada: reenviar → 409 y nueva → 409 (jamás se pisa una cuenta activa)', async () => {
  await pool.query(`UPDATE usuarios SET password_hash = 'hash-simulado-aceptacion' WHERE email = 'xiomar.bien@test.local'`);
  const re = await api(`/api/superadmin/negocios/${FIX}/reenviar-invitacion`, { cookie: cookieSuperadmin, method: 'POST' });
  assert.strictEqual(re.status, 409); assert.strictEqual(re.body.codigo, 'INVITACION_ACEPTADA');
  const nu = await api(`/api/superadmin/negocios/${FIX}/invitaciones/nueva`, { cookie: cookieSuperadmin, method: 'POST' });
  assert.strictEqual(nu.status, 409); assert.strictEqual(nu.body.codigo, 'INVITACION_ACEPTADA');
  // El correo sigue siendo editable incluso aceptada (queda auditado).
  const mail = await api(`/api/superadmin/negocios/${FIX}/admin`, {
    cookie: cookieSuperadmin, method: 'PATCH', body: { email: 'xiomar.bien@test.local' },
  });
  assert.strictEqual(mail.status, 200);
  assert.strictEqual(mail.body.cambiosAplicados, 0, 'mismo correo = sin cambios, sin error');
  await pool.query(`UPDATE usuarios SET password_hash = NULL WHERE email = 'xiomar.bien@test.local'`);
});

// ═══════════ Email en uso (usuario ya existente) ═══════════
await t('CORREO', 'correo ya usado por otro usuario → 409 EMAIL_EN_USO', async () => {
  const { rows: [otro] } = await pool.query(`SELECT email FROM usuarios WHERE id = $1`, [SEED.adminNegocioAUsuarioId]);
  const r = await api(`/api/superadmin/negocios/${FIX}/admin`, {
    cookie: cookieSuperadmin, method: 'PATCH', body: { email: otro.email },
  });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.codigo, 'EMAIL_EN_USO');
});

// ═══════════ 13-14) Desactivar / Reactivar sin borrar ═══════════
await t('ESTADO', 'desactivar bloquea el acceso operativo y conserva todos los datos; reactivar lo restaura', async () => {
  const staff = await crearUsuarioConPassword({
    negocioId: FIX, nombre: 'Staff Carnitas', email: 'staff-carnitas@test.local',
    password: 'ClaveStaffPrueba123!', rol: 'admin',
  });
  const cookieStaff = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: staff.id, negocioId: FIX, rol: 'admin' }))}`;
  const sonda = () => api('/api/push/subscribe', {
    cookie: cookieStaff, method: 'POST',
    body: { endpoint: 'https://push.test/x', keys: { auth: 'a', p256dh: 'b' } },
  });

  const antes = await pool.query(`SELECT
    (SELECT COUNT(*) FROM usuarios u JOIN usuario_negocios un ON un.usuario_id=u.id WHERE un.negocio_id=$1) AS usuarios,
    (SELECT COUNT(*) FROM invitaciones_usuario WHERE negocio_id=$1) AS invitaciones,
    (SELECT COUNT(*) FROM configuracion WHERE negocio_id=$1) AS config,
    (SELECT COUNT(*) FROM sucursales WHERE negocio_id=$1) AS sucursales`, [FIX]);

  const des = await api(`/api/superadmin/negocios/${FIX}/estado`, {
    cookie: cookieSuperadmin, method: 'PATCH', body: { estado: 'suspendido' },
  });
  assert.strictEqual(des.status, 200);
  assert.strictEqual(des.body.activo, false);
  const bloqueado = await sonda();
  assert.ok([401, 403].includes(bloqueado.status), `suspendido debe bloquear el acceso operativo, dio ${bloqueado.status}`);

  const re = await api(`/api/superadmin/negocios/${FIX}/estado`, {
    cookie: cookieSuperadmin, method: 'PATCH', body: { estado: 'activo' },
  });
  assert.strictEqual(re.status, 200);
  assert.strictEqual(re.body.activo, true);
  const desbloqueado = await sonda();
  assert.strictEqual(desbloqueado.status, 200, 'reactivado debe recuperar el acceso');

  const despues = await pool.query(`SELECT
    (SELECT COUNT(*) FROM usuarios u JOIN usuario_negocios un ON un.usuario_id=u.id WHERE un.negocio_id=$1) AS usuarios,
    (SELECT COUNT(*) FROM invitaciones_usuario WHERE negocio_id=$1) AS invitaciones,
    (SELECT COUNT(*) FROM configuracion WHERE negocio_id=$1) AS config,
    (SELECT COUNT(*) FROM sucursales WHERE negocio_id=$1) AS sucursales`, [FIX]);
  assert.deepStrictEqual(despues.rows[0], antes.rows[0], 'desactivar/reactivar no borra ni altera ningún dato');
});

// ═══════════ 15) Superadmin administra el negocio (sesión soporte) ═══════════
await t('ADMINISTRAR', 'sesión de soporte: entra auditado, opera el panel del negocio y sale auditado', async () => {
  const r = await api(`/api/superadmin/negocios/${FIX}/sesion-soporte`, {
    cookie: cookieSuperadmin, method: 'POST', body: { motivo: 'configurar onboarding (prueba)' },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const setCookie = r.headers.get('set-cookie');
  assert.ok(setCookie && setCookie.includes('xabor_sesion='), 'la sesión de soporte reemplaza la cookie');
  const cookieSoporte = setCookie.split(';')[0];

  const me = await api('/api/auth/me', { cookie: cookieSoporte });
  assert.strictEqual(me.status, 200);
  assert.ok(me.body.soporte?.activo, 'la sesión debe marcarse como soporte (barra visible en el panel)');

  const { rows: [audIn] } = await pool.query(
    `SELECT 1 FROM auditoria_plataforma WHERE negocio_id = $1 AND accion = 'sesion_soporte_iniciada'`, [FIX]);
  assert.ok(audIn, 'entrada auditada');

  const salir = await api('/api/auth/soporte/salir', { cookie: cookieSoporte, method: 'POST' });
  assert.strictEqual(salir.status, 200);
  const { rows: [audOut] } = await pool.query(
    `SELECT 1 FROM auditoria_plataforma WHERE negocio_id = $1 AND accion = 'sesion_soporte_cerrada'`, [FIX]);
  assert.ok(audOut, 'salida auditada');
});

// ═══════════ 16-17) Seguridad y multi-tenant ═══════════
await t('SEGURIDAD', 'un admin normal NO puede editar negocios, reenviar invitaciones ni cambiar estados (ni de otro tenant)', async () => {
  for (const [method, path, body] of [
    ['PATCH', `/api/superadmin/negocios/${FIX}`, { nombre: 'Hackeado' }],
    ['PATCH', `/api/superadmin/negocios/${FIX}/admin`, { email: 'x@y.zz' }],
    ['POST', `/api/superadmin/negocios/${FIX}/reenviar-invitacion`, undefined],
    ['POST', `/api/superadmin/negocios/${FIX}/invitaciones/nueva`, undefined],
    ['GET', `/api/superadmin/negocios/${FIX}/invitaciones`, undefined],
    ['PATCH', `/api/superadmin/negocios/${FIX}/estado`, { estado: 'suspendido' }],
    ['PATCH', `/api/superadmin/negocios/${SEED.negocioB}`, { nombre: 'Cruce' }],
  ]) {
    const r = await api(path, { cookie: cookieAdminA, method, body });
    assert.ok([401, 403].includes(r.status), `${method} ${path} con admin normal debe rechazarse, dio ${r.status}`);
  }
  const { rows: [n] } = await pool.query(`SELECT nombre FROM negocios WHERE id = $1`, [FIX]);
  assert.strictEqual(n.nombre, 'Carnitas Moreno MX', 'nada debe haber cambiado');
});
await t('SEGURIDAD', 'sin sesión → 401 en todas las rutas nuevas', async () => {
  for (const [method, path] of [
    ['PATCH', `/api/superadmin/negocios/${FIX}`],
    ['GET', `/api/superadmin/negocios/${FIX}/invitaciones`],
    ['POST', `/api/superadmin/negocios/${FIX}/invitaciones/nueva`],
  ]) {
    const r = await api(path, { method, body: method === 'GET' ? undefined : {} });
    assert.ok([401, 403].includes(r.status), `${method} ${path} sin sesión debe rechazarse, dio ${r.status}`);
  }
});

// ═══════════ 19) Sin secretos en auditoría ═══════════
await t('AUDITORIA', 'la auditoría de esta fase nunca contiene tokens, hashes ni contraseñas', async () => {
  const { rows } = await pool.query(
    `SELECT contexto FROM auditoria_plataforma WHERE negocio_id = $1 AND accion IN ('editar_negocio','editar_admin_negocio','reenviar_invitacion','cambiar_estado_negocio')`, [FIX]);
  assert.ok(rows.length >= 3, 'debe haber auditoría acumulada de la fase');
  const crudo = JSON.stringify(rows);
  assert.ok(!/token|hash|password|secret/i.test(crudo.replace(/password_hash/g, '')), 'sin secretos en contexto de auditoría');
});

// ═══════════ Limpieza del fixture (los negocios seed quedan intactos) ═══════════
await pool.query(`DELETE FROM auditoria_plataforma WHERE negocio_id = $1`, [FIX]);
await pool.query(`DELETE FROM sesiones_soporte WHERE negocio_id = $1`, [FIX]);
await pool.query(`DELETE FROM invitaciones_usuario WHERE negocio_id = $1`, [FIX]);
await pool.query(`DELETE FROM push_subscriptions WHERE negocio_id = $1`, [FIX]);
await pool.query(`DELETE FROM usuario_negocios WHERE negocio_id = $1`, [FIX]);
await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id = $1`, [FIX]);
await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1`, [FIX]);
await pool.query(`DELETE FROM metodos_pago WHERE negocio_id = $1`, [FIX]);
await pool.query(`DELETE FROM sucursales WHERE negocio_id = $1`, [FIX]);
await pool.query(`DELETE FROM usuarios WHERE email IN ('xiomar.mal@test.local','xiomar.bien@test.local','staff-carnitas@test.local')`);
await pool.query(`DELETE FROM negocios WHERE id = $1`, [FIX]);

// ═══════════ Resumen ═══════════
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
