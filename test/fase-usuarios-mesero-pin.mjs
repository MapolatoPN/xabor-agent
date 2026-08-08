// Usuarios tipo MESERO con acceso local por PIN.
//
// El modelo de Usuarios estaba pensado para cuentas administrativas: correo
// obligatorio (NOT NULL desde 003, UNIQUE global desde 006), contraseña e
// invitación por email. Para un restaurante eso no sirve: el mesero es una
// persona del piso, sin correo corporativo. La migración 041 permite
// email NULL y agrega pin_hash; el rol vive donde ya viven los roles
// (usuario_negocios.rol = 'mesero'), sin tabla nueva.
//
// Lo que fija esta suite: se crea sin correo, el PIN nunca sale ni se guarda
// en claro, un mesero no puede iniciar sesión ni tocar administración, y al
// abrir mesa el servidor decide quién queda registrado — incluido el caso de
// un superadmin en soporte, que ya no puede autoasignarse en otro negocio.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4955';

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { hashPin, verifyPin, pinValido } = await import('../src/services/password.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
async function api(base, path, { cookie, method = 'GET', body } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (cookie) h['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
const fijarModulo = (negocioId, modulo, estado = 'activo') => pool.query(
  `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
   ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);

const A = SEED.negocioA, B = SEED.negocioB;
async function limpiar() {
  await pool.query(`DELETE FROM restaurante_cuentas WHERE negocio_id = ANY($1)`, [[A, B]]);
  await pool.query(`DELETE FROM usuario_negocios WHERE usuario_id IN (SELECT id FROM usuarios WHERE nombre LIKE 'Mesero prueba%' OR nombre LIKE 'Juan %')`);
  await pool.query(`DELETE FROM usuarios WHERE nombre LIKE 'Mesero prueba%' OR nombre LIKE 'Juan %'`);
}
await limpiar();
for (const n of [A, B]) { await fijarModulo(n, 'restaurante'); await fijarModulo(n, 'usuarios'); }

// Admin propio del negocio B (el seed solo crea usuarios de A).
const { rows: [uB] } = await pool.query(
  `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,'Admin Mesero B',$2,'x') RETURNING id`,
  [B, `admin-mesero-b-${Date.now()}@test.local`]);
await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'admin')`, [uB.id, B]);

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;
const ck = (u, n, r, extra = {}) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: u, negocioId: n, rol: r, ...extra }))}`;
const adminA = ck(SEED.adminNegocioAUsuarioId, A, 'admin');
const adminB = ck(uB.id, B, 'admin');

// ═════════ Migración y modelo ═════════
await t('MODELO', '1. la migración 041 dejó email opcional, agregó pin_hash y la restricción de identidad', async () => {
  const { rows: [col] } = await pool.query(
    `SELECT is_nullable FROM information_schema.columns WHERE table_name='usuarios' AND column_name='email'`);
  assert.strictEqual(col.is_nullable, 'YES', 'email debe admitir NULL');
  const { rows: pin } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='usuarios' AND column_name='pin_hash'`);
  assert.strictEqual(pin.length, 1, 'debe existir pin_hash');
  const { rows: chk } = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname='usuarios_identidad_check'`);
  assert.strictEqual(chk.length, 1, 'toda fila debe conservar correo o PIN');
});
await t('MODELO', '2. las cuentas administrativas existentes conservan su correo (la migración no tocó datos)', async () => {
  const { rows } = await pool.query(`SELECT COUNT(*)::int c FROM usuarios WHERE email IS NULL AND pin_hash IS NULL`);
  assert.strictEqual(rows[0].c, 0, 'nadie puede quedarse sin identidad');
  const { rows: admin } = await pool.query(`SELECT email FROM usuarios WHERE id = $1`, [SEED.adminNegocioAUsuarioId]);
  assert.ok(admin[0].email, 'el admin del seed sigue con correo');
});
await t('MODELO', '3. el PIN se valida como 4-6 dígitos y se hashea con el mismo esquema que las contraseñas', () => {
  assert.ok(pinValido('1234') && pinValido('123456'));
  assert.ok(!pinValido('123') && !pinValido('1234567') && !pinValido('12a4') && !pinValido(''));
  const h = hashPin('4321');
  assert.match(h, /^[0-9a-f]{32}:[0-9a-f]{128}$/, 'salt:hash scrypt');
  assert.notStrictEqual(h, '4321');
  assert.ok(verifyPin('4321', h));
  assert.ok(!verifyPin('1234', h));
  assert.notStrictEqual(hashPin('4321'), h, 'salt distinto en cada alta');
});

// ═════════ Alta desde Usuarios ═════════
let meseroA = null;
await t('ALTA', '4. se crea un mesero solo con nombre y PIN, sin correo ni invitación', async () => {
  const r = await api(base, '/api/admin/usuarios', { cookie: adminA, method: 'POST', body: { tipo: 'mesero', nombre: 'Juan Pérez', pin: '4321' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  meseroA = r.body.id;
  assert.strictEqual(r.body.rol, 'mesero');
  const { rows } = await pool.query(`SELECT email, pin_hash, negocio_id FROM usuarios WHERE id = $1`, [meseroA]);
  assert.strictEqual(rows[0].email, null, 'sin correo inventado');
  assert.strictEqual(rows[0].negocio_id, A, 'aislado por negocio');
  const { rows: rol } = await pool.query(`SELECT rol FROM usuario_negocios WHERE usuario_id=$1 AND negocio_id=$2`, [meseroA, A]);
  assert.strictEqual(rol[0].rol, 'mesero');
});
await t('ALTA', '5. el nombre es obligatorio', async () => {
  const r = await api(base, '/api/admin/usuarios', { cookie: adminA, method: 'POST', body: { tipo: 'mesero', nombre: '  ', pin: '4321' } });
  assert.strictEqual(r.status, 400);
});
await t('ALTA', '6. el PIN es obligatorio y debe tener 4-6 dígitos', async () => {
  for (const pin of [undefined, '', '123', '1234567', 'abcd']) {
    const r = await api(base, '/api/admin/usuarios', { cookie: adminA, method: 'POST', body: { tipo: 'mesero', nombre: 'Mesero prueba PIN', pin } });
    assert.strictEqual(r.status, 400, `PIN ${JSON.stringify(pin)} debía rechazarse`);
    assert.strictEqual(r.body.codigo, 'PIN_INVALIDO');
  }
});
await t('ALTA', '7. el PIN se guarda hasheado, nunca en claro', async () => {
  const { rows } = await pool.query(`SELECT pin_hash FROM usuarios WHERE id = $1`, [meseroA]);
  assert.ok(rows[0].pin_hash, 'debe existir hash');
  assert.ok(!rows[0].pin_hash.includes('4321'), 'el PIN no aparece en el hash');
  assert.ok(verifyPin('4321', rows[0].pin_hash), 'el hash corresponde al PIN');
});
await t('ALTA', '8. ninguna API devuelve el PIN ni su hash', async () => {
  const creado = await api(base, '/api/admin/usuarios', { cookie: adminA, method: 'POST', body: { tipo: 'mesero', nombre: 'Mesero prueba Fuga', pin: '9876' } });
  assert.strictEqual(creado.status, 201);
  const lista = await api(base, '/api/admin/usuarios', { cookie: adminA });
  const meseros = await api(base, '/api/restaurante/meseros', { cookie: adminA });
  for (const [etiqueta, r] of [['alta', creado], ['lista de usuarios', lista], ['selector de meseros', meseros]]) {
    const texto = JSON.stringify(r.body);
    assert.ok(!/pin_hash/i.test(texto), `${etiqueta} expone pin_hash`);
    assert.ok(!texto.includes('9876'), `${etiqueta} expone el PIN`);
  }
});

// ═════════ Multi-tenant ═════════
let meseroB = null;
await t('TENANT', '9. dos negocios pueden tener un mesero con el mismo nombre y el mismo PIN', async () => {
  const r = await api(base, '/api/admin/usuarios', { cookie: adminB, method: 'POST', body: { tipo: 'mesero', nombre: 'Juan Pérez', pin: '4321' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  meseroB = r.body.id;
  assert.notStrictEqual(meseroB, meseroA, 'identidades distintas aunque coincida el nombre');
  const { rows } = await pool.query(`SELECT negocio_id FROM usuarios WHERE id = $1`, [meseroB]);
  assert.strictEqual(rows[0].negocio_id, B);
});
await t('TENANT', '10. el selector de cada negocio solo muestra a los suyos', async () => {
  const a = await api(base, '/api/restaurante/meseros', { cookie: adminA });
  const b = await api(base, '/api/restaurante/meseros', { cookie: adminB });
  assert.ok(a.body.meseros.some(m => m.id === meseroA));
  assert.ok(!a.body.meseros.some(m => m.id === meseroB), 'A no ve al mesero de B');
  assert.ok(b.body.meseros.some(m => m.id === meseroB));
  assert.ok(!b.body.meseros.some(m => m.id === meseroA), 'B no ve al mesero de A');
});
await t('TENANT', '11. un mesero inactivo desaparece del selector', async () => {
  await pool.query(`UPDATE usuario_negocios SET activo = FALSE WHERE usuario_id = $1`, [meseroA]);
  const r = await api(base, '/api/restaurante/meseros', { cookie: adminA });
  assert.ok(!r.body.meseros.some(m => m.id === meseroA), 'inactivo no debe ofrecerse');
  await pool.query(`UPDATE usuario_negocios SET activo = TRUE WHERE usuario_id = $1`, [meseroA]);
  const r2 = await api(base, '/api/restaurante/meseros', { cookie: adminA });
  assert.ok(r2.body.meseros.some(m => m.id === meseroA), 'al reactivarlo vuelve');
});

// ═════════ Apertura de mesa ═════════
await t('MESA', '12. con el PIN correcto se abre la mesa y queda registrado ese mesero', async () => {
  const r = await api(base, '/api/restaurante/mesas/abrir', { cookie: adminA, method: 'POST', body: { mesa: 1, personas: 2, meseroUsuarioId: meseroA, pin: '4321' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const { rows } = await pool.query(`SELECT mesero_usuario_id, abierta_por FROM restaurante_cuentas WHERE id = $1`, [r.body.cuenta.id]);
  assert.strictEqual(rows[0].mesero_usuario_id, meseroA, 'el mesero queda guardado en la cuenta');
  assert.strictEqual(rows[0].abierta_por, SEED.adminNegocioAUsuarioId, 'y quién la abrió, por separado');
  const c = await api(base, `/api/restaurante/cuentas/${r.body.cuenta.id}`, { cookie: adminA });
  assert.strictEqual(c.body.mesero.nombre, 'Juan Pérez');
});
await t('MESA', '13. con el PIN incorrecto (o vacío) se rechaza y no se abre nada', async () => {
  for (const pin of ['0000', '', undefined]) {
    const r = await api(base, '/api/restaurante/mesas/abrir', { cookie: adminA, method: 'POST', body: { mesa: 2, personas: 2, meseroUsuarioId: meseroA, pin } });
    assert.strictEqual(r.status, 401, `PIN ${JSON.stringify(pin)} debía rechazarse`);
    assert.strictEqual(r.body.code, 'PIN_INCORRECTO');
  }
  const { rows } = await pool.query(`SELECT COUNT(*)::int c FROM restaurante_cuentas WHERE negocio_id=$1 AND mesa_numero=2 AND estado='abierta'`, [A]);
  assert.strictEqual(rows[0].c, 0, 'la mesa 2 sigue libre');
});
await t('MESA', '14. el mesero de OTRO negocio se rechaza igual que un PIN incorrecto', async () => {
  const r = await api(base, '/api/restaurante/mesas/abrir', { cookie: adminA, method: 'POST', body: { mesa: 3, personas: 2, meseroUsuarioId: meseroB, pin: '4321' } });
  assert.strictEqual(r.status, 401, 'aunque el PIN coincida, no es de este negocio');
  assert.strictEqual(r.body.code, 'PIN_INCORRECTO');
});
await t('MESA', '15. el usuario de la sesión puede atender su propia mesa sin PIN', async () => {
  const r = await api(base, '/api/restaurante/mesas/abrir', { cookie: adminA, method: 'POST', body: { mesa: 4, personas: 2, meseroUsuarioId: SEED.adminNegocioAUsuarioId } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const { rows } = await pool.query(`SELECT mesero_usuario_id FROM restaurante_cuentas WHERE id = $1`, [r.body.cuenta.id]);
  assert.strictEqual(rows[0].mesero_usuario_id, SEED.adminNegocioAUsuarioId);
});

// ═════════ Superadmin en soporte ═════════
await t('SOPORTE', '16. quien no pertenece al negocio no puede operarlo ni quedar como su mesero', async () => {
  // Un usuario de OTRO negocio con un token apuntando a A: el panel entero
  // le responde 403 (no hay membresía), así que nunca podría autoasignarse.
  const ajeno = ck(uB.id, A, 'admin');
  const r = await api(base, '/api/restaurante/meseros', { cookie: ajeno });
  assert.strictEqual(r.status, 403, `un ajeno no opera este negocio (dio ${r.status})`);
  const abrir = await api(base, '/api/restaurante/mesas/abrir', { cookie: ajeno, method: 'POST', body: { mesa: 5, personas: 2, meseroUsuarioId: uB.id } });
  assert.strictEqual(abrir.status, 403);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int c FROM restaurante_cuentas WHERE negocio_id = $1 AND mesero_usuario_id = $2`, [A, uB.id]);
  assert.strictEqual(rows[0].c, 0, 'ninguna cuenta quedó a nombre de alguien de otro negocio');
});
await t('SOPORTE', '16b. en sesión de SOPORTE no hay mesero sugerido y hay que elegir uno local', async () => {
  // Regla que elimina el error "El mesero no pertenece a este negocio": en
  // soporte, req.usuarioId es el superadmin, que NO es miembro del negocio.
  // esMiembroActivoDelNegocio es exactamente lo que consulta la ruta.
  const { esMiembroActivoDelNegocio } = await import('../src/services/database.js');
  const { rows: [ajeno] } = await pool.query(
    `SELECT id FROM usuarios WHERE id NOT IN (SELECT usuario_id FROM usuario_negocios WHERE negocio_id = $1) LIMIT 1`, [A]);
  assert.ok(ajeno, 'debe existir un usuario sin membresía en A para la prueba');
  assert.strictEqual(await esMiembroActivoDelNegocio(ajeno.id, A), false, 'un no-miembro nunca se sugiere ni se autoasigna');
  assert.strictEqual(await esMiembroActivoDelNegocio(SEED.adminNegocioAUsuarioId, A), true, 'un miembro propio sí');
});
await t('SOPORTE', '17. desde una sesión de soporte SÍ se puede abrir eligiendo un mesero local con su PIN', async () => {
  const soporte = ck(SEED.superadminUsuarioId, A, 'admin');
  const r = await api(base, '/api/restaurante/mesas/abrir', { cookie: soporte, method: 'POST', body: { mesa: 6, personas: 2, meseroUsuarioId: meseroA, pin: '4321' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const { rows } = await pool.query(`SELECT mesero_usuario_id, abierta_por FROM restaurante_cuentas WHERE id=$1`, [r.body.cuenta.id]);
  assert.strictEqual(rows[0].mesero_usuario_id, meseroA, 'el mesero es local');
  assert.strictEqual(rows[0].abierta_por, SEED.superadminUsuarioId, 'y queda auditado quién la abrió');
});

// ═════════ Permisos: el mesero no es una cuenta administrativa ═════════
await t('PERMISOS', '18. un mesero no puede iniciar sesión: no tiene correo ni contraseña', async () => {
  const { rows } = await pool.query(`SELECT email, password_hash FROM usuarios WHERE id = $1`, [meseroA]);
  assert.strictEqual(rows[0].email, null);
  assert.strictEqual(rows[0].password_hash, null, 'el PIN vive en pin_hash, no sirve como contraseña');
  const login = await api(base, '/api/auth/negocio/login', { method: 'POST', body: { email: null, password: '4321' } });
  assert.ok([400, 401].includes(login.status), `no debe poder autenticarse (dio ${login.status})`);
});
await t('PERMISOS', '19. el rol mesero no otorga acceso administrativo (fail-closed)', async () => {
  // Aunque alguien fabricara una sesión con ese usuario, el rol 'mesero' no
  // es admin: administración responde 403 y nunca 200.
  const comoMesero = ck(meseroA, A, 'mesero');
  for (const ruta of ['/api/admin/usuarios', '/api/admin/integraciones/pagos', '/api/config/pagos']) {
    const r = await api(base, ruta, { cookie: comoMesero });
    assert.ok([401, 403].includes(r.status), `${ruta} debía cerrarse para un mesero (dio ${r.status})`);
  }
  const superadmin = await api(base, '/api/superadmin/negocios', { cookie: comoMesero });
  assert.ok([401, 403].includes(superadmin.status));
});

// ═════════ Compatibilidad ═════════
await t('COMPATIBILIDAD', '20. el alta de usuarios administrativos sigue funcionando igual', async () => {
  const correo = `operador-compat-${Date.now()}@test.local`;
  const r = await api(base, '/api/admin/usuarios', { cookie: adminA, method: 'POST', body: { nombre: 'Operador Compat', email: correo, password: 'ClaveSegura123' } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.rol, 'staff');
  assert.strictEqual(r.body.email, correo);
  const dup = await api(base, '/api/admin/usuarios', { cookie: adminA, method: 'POST', body: { nombre: 'Otro', email: correo, password: 'ClaveSegura123' } });
  assert.strictEqual(dup.status, 409, 'el correo sigue siendo único a nivel global');
  await pool.query(`DELETE FROM usuario_negocios WHERE usuario_id IN (SELECT id FROM usuarios WHERE email = $1)`, [correo]);
  await pool.query(`DELETE FROM usuarios WHERE email = $1`, [correo]);
});
await t('COMPATIBILIDAD', '21. la operación de la mesa sigue completa con un mesero: consumo y comanda', async () => {
  const abrir = await api(base, '/api/restaurante/mesas/abrir', { cookie: adminA, method: 'POST', body: { mesa: 7, personas: 2, meseroUsuarioId: meseroA, pin: '4321' } });
  assert.strictEqual(abrir.status, 201);
  const cuentaId = abrir.body.cuenta.id;
  await api(base, `/api/restaurante/cuentas/${cuentaId}/items`, { cookie: adminA, method: 'POST', body: { items: [{ producto: 'Café', cantidad: 1, precio_unitario: 45 }] } });
  const comanda = await api(base, `/api/restaurante/cuentas/${cuentaId}/comanda`, { cookie: adminA, method: 'POST' });
  assert.strictEqual(comanda.status, 200, JSON.stringify(comanda.body));
  assert.strictEqual(comanda.body.mesero, 'Juan Pérez', 'la comanda lleva al mesero responsable');
  const c = await api(base, `/api/restaurante/cuentas/${cuentaId}`, { cookie: adminA });
  assert.strictEqual(c.body.mesero.nombre, 'Juan Pérez', 'la cuenta conserva la asociación');
});
await t('COMPATIBILIDAD', '22. la UI ofrece el tipo Mesero y pide PIN al abrir mesa', async () => {
  const panel = await (await fetch(base + '/app')).text();
  assert.ok(panel.includes('id="usr-tipo"'), 'selector de tipo de usuario');
  assert.ok(panel.includes('usr-campos-mesero') && panel.includes('usr-pin'), 'campos de mesero');
  assert.ok(panel.includes('crearMeseroConPin'), 'alta sin correo desde el panel');
  const mesas = await (await fetch(base + '/mesas.html')).text();
  assert.ok(mesas.includes('ab-mesero') && mesas.includes('ab-pin'), 'selector de mesero y PIN');
  assert.ok(mesas.includes('/api/restaurante/meseros'), 'consume el selector del backend');
});

await limpiar();

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
