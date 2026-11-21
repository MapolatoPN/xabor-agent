// Contención de acceso (19-nov-2026). Tres garantías:
//
//  1. ACCESO CON CONTRASEÑA GLOBAL apagado en producción: POST /api/auth/login
//     responde 410 y los tokens que emitía no valen en ninguna ruta (ni con
//     X-Negocio-Slug, ni para fabricar sesiones, ni en las rutas Rappi). La
//     sesión por correo sigue funcionando. Fuera de producción sigue
//     encendido, y XABOR_ACCESO_LEGADO=permitir lo regresa (reversa).
//  2. PORTAL DEL REPARTIDOR solo para un negocio activo con el módulo
//     «repartidores»: alta, login y cada ruta con token. Apagar el módulo
//     cierra también los tokens ya emitidos. Las ofertas no cambian.
//  3. SECRETOS: producción no arranca (ni pasa el predeploy) sin
//     SESSION_SECRET propio, y /internal/analizar-semana no acepta el valor de
//     respaldo del código.
//
// Uso: mismas variables que la batería (DATABASE_URL, PANEL_SECRET,
// SESSION_SECRET, ADMIN_PASSWORD, PANEL_PASSWORD); requiere migraciones + seed.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import { createHmac } from 'crypto';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

for (const v of ['DATABASE_URL', 'PANEL_SECRET', 'SESSION_SECRET', 'ADMIN_PASSWORD', 'PANEL_PASSWORD']) {
  if (!process.env[v]) { console.error(`Falta ${v}`); process.exit(2); }
}
if (/railway|rlwy/i.test(process.env.DATABASE_URL)) { console.error('Esta suite no corre contra Railway'); process.exit(2); }

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { accesoLegadoPermitido } = await import('../src/services/accesoLegado.js');
const { esEntornoProductivo } = await import('../src/services/entornoProductivo.js');
const { revisarSecretos, secretosListosParaArrancar, SESSION_SECRET_DE_RESPALDO } = await import('../src/services/guardaSecretos.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

const TOKEN_ADMIN = createHmac('sha256', process.env.PANEL_SECRET).update(process.env.ADMIN_PASSWORD).digest('hex');
const TOKEN_STAFF = createHmac('sha256', process.env.PANEL_SECRET).update(process.env.PANEL_PASSWORD).digest('hex');
const SECRETO_LARGO = 'prueba-secreto-de-sesion-suficientemente-largo-0123456789';
// Desde el bloque 1.3 producción también exige META_APP_SECRET. Los arranques
// en modo producción de esta suite llevan este valor de prueba.
const META_PRUEBA = 'prueba-meta-app-secret-local';
// Lo que ningún mensaje ni log puede contener.
const VALORES_PRIVADOS = [process.env.SESSION_SECRET, process.env.ADMIN_PASSWORD, process.env.PANEL_PASSWORD, process.env.PANEL_SECRET, SECRETO_LARGO, META_PRUEBA];
const sinSecretos = (texto, donde) => {
  for (const v of VALORES_PRIVADOS) assert.ok(!String(texto).includes(v), `${donde} contiene el valor de un secreto`);
};
const LIMPIAR_ENTORNO = ['NODE_ENV', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_PROJECT_ID', 'XABOR_ACCESO_LEGADO', 'INTERNAL_SECRET'];

// Arranca src/server.js y espera: o responde /health, o el proceso termina.
function arrancar(envExtra, { omitir = [], timeoutMs = 40000 } = {}) {
  const env = { META_APP_SECRET: META_PRUEBA, ...process.env };
  for (const k of [...LIMPIAR_ENTORNO, ...omitir]) delete env[k];
  Object.assign(env, envExtra);
  for (const k of omitir) delete env[k];
  const proc = spawn(process.execPath, [join(RAIZ, 'src', 'server.js')], { cwd: RAIZ, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let salida = '';
  proc.stdout.on('data', d => { salida += d; });
  proc.stderr.on('data', d => { salida += d; });
  const base = `http://localhost:${envExtra.PORT}`;
  return new Promise((resolve) => {
    let listo = false;
    const fin = setTimeout(() => { proc.kill(); resolve({ timeout: true, salida: () => salida }); }, timeoutMs);
    proc.on('exit', (code) => { if (!listo) { clearTimeout(fin); resolve({ salio: true, code, salida: () => salida }); } });
    (async function sondear() {
      while (!listo && proc.exitCode === null) {
        try {
          const r = await fetch(base + '/health');
          if (r.ok) {
            listo = true; clearTimeout(fin);
            return resolve({ listo: true, base, salida: () => salida, detener: () => new Promise(ok => { proc.once('exit', ok); proc.kill(); }) });
          }
        } catch { /* aún no levanta */ }
        await new Promise(r => setTimeout(r, 300));
      }
    })();
  });
}

async function pedir(base, ruta, { metodo = 'GET', bearer, cookie, cuerpo, cabeceras = {} } = {}) {
  const headers = { 'Content-Type': 'application/json', ...cabeceras };
  if (bearer) headers.Authorization = 'Bearer ' + bearer;
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(base + ruta, { method: metodo, headers, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch {}
  return { status: r.status, body: json, texto };
}

const puertoBase = Number(process.env.TEST_PORT_CONTENCION || 4781);
const { rows: [negA] } = await pool.query('SELECT slug FROM negocios WHERE id = $1', [SEED.negocioA]);
const SLUG_A = negA.slug;
const cookieAdminA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: SEED.negocioA, rol: 'admin' }))}`;

// ═════════════ 1. Reglas puras (sin servidor) ═════════════
await t('REGLA', 'esEntornoProductivo: NODE_ENV=production o cualquier variable RAILWAY_* de Railway', async () => {
  assert.strictEqual(esEntornoProductivo({}), false);
  assert.strictEqual(esEntornoProductivo({ NODE_ENV: 'development' }), false);
  assert.strictEqual(esEntornoProductivo({ NODE_ENV: 'production' }), true);
  assert.strictEqual(esEntornoProductivo({ RAILWAY_ENVIRONMENT_ID: 'x' }), true);
  assert.strictEqual(esEntornoProductivo({ RAILWAY_PROJECT_ID: 'x' }), true);
});

await t('REGLA', 'accesoLegadoPermitido: apagado en producción; «permitir» lo regresa; «bloquear» lo apaga en local; otro valor no abre', async () => {
  assert.strictEqual(accesoLegadoPermitido({}), true, 'local: encendido');
  assert.strictEqual(accesoLegadoPermitido({ NODE_ENV: 'production' }), false);
  assert.strictEqual(accesoLegadoPermitido({ RAILWAY_ENVIRONMENT_ID: 'x' }), false);
  assert.strictEqual(accesoLegadoPermitido({ NODE_ENV: 'production', XABOR_ACCESO_LEGADO: 'permitir' }), true);
  assert.strictEqual(accesoLegadoPermitido({ NODE_ENV: 'production', XABOR_ACCESO_LEGADO: ' PERMITIR ' }), true);
  assert.strictEqual(accesoLegadoPermitido({ XABOR_ACCESO_LEGADO: 'bloquear' }), false);
  assert.strictEqual(accesoLegadoPermitido({ NODE_ENV: 'production', XABOR_ACCESO_LEGADO: 'si' }), false);
  assert.strictEqual(accesoLegadoPermitido({ NODE_ENV: 'production', XABOR_ACCESO_LEGADO: 'true' }), false);
});

await t('REGLA', 'revisarSecretos: en producción bloquea sin SESSION_SECRET o con el de respaldo; fuera no exige nada', async () => {
  assert.deepStrictEqual(revisarSecretos({}).bloqueantes, [], 'local sin variables: arranca');
  const M = { META_APP_SECRET: META_PRUEBA };
  assert.strictEqual(revisarSecretos({ NODE_ENV: 'production', ...M }).bloqueantes.length, 1);
  assert.strictEqual(revisarSecretos({ NODE_ENV: 'production', SESSION_SECRET: '   ', ...M }).bloqueantes.length, 1, 'solo espacios = vacía');
  assert.strictEqual(revisarSecretos({ RAILWAY_ENVIRONMENT_ID: 'x', SESSION_SECRET: SESSION_SECRET_DE_RESPALDO, ...M }).bloqueantes.length, 1);
  const bien = revisarSecretos({ NODE_ENV: 'production', SESSION_SECRET: SECRETO_LARGO, ADMIN_PASSWORD: 'x', INTERNAL_SECRET: 'y',
    RAPPI_WEBHOOK_FIRMA: 'exigir', RAPPI_WEBHOOK_SECRET: 'z', ...M });
  assert.deepStrictEqual(bien.bloqueantes, []);
  assert.deepStrictEqual(bien.avisos, []);
  const corto = revisarSecretos({ NODE_ENV: 'production', SESSION_SECRET: 'corto-pero-propio', ...M });
  assert.deepStrictEqual(corto.bloqueantes, [], 'corto avisa, no bloquea');
  assert.ok(corto.avisos.some(a => a.includes('SESSION_SECRET')));
  assert.ok(corto.avisos.some(a => a.includes('ADMIN_PASSWORD')));
  assert.ok(corto.avisos.some(a => a.includes('INTERNAL_SECRET')));
});

await t('REGLA', 'los mensajes nombran variables y jamás incluyen su valor', async () => {
  const r = revisarSecretos({ NODE_ENV: 'production', SESSION_SECRET: SESSION_SECRET_DE_RESPALDO });
  for (const m of [...r.bloqueantes, ...r.avisos]) assert.ok(!m.includes(SESSION_SECRET_DE_RESPALDO), 'el mensaje repite el valor');
  const lineas = [];
  const sigue = secretosListosParaArrancar({ NODE_ENV: 'production', SESSION_SECRET: SECRETO_LARGO.slice(0, 20), META_APP_SECRET: META_PRUEBA }, { log: l => lineas.push(l), logError: l => lineas.push(l) });
  assert.strictEqual(sigue, true);
  sinSecretos(lineas.join('\n'), 'el aviso');
  assert.strictEqual(secretosListosParaArrancar({ NODE_ENV: 'production' }, { log: () => {}, logError: () => {} }), false);
});

// ═════════════ 2. Producción simulada (NODE_ENV=production) ═════════════
const prod = await arrancar({ PORT: String(puertoBase), NODE_ENV: 'production' });
if (!prod.listo) {
  console.log(`FALLO [PROD] el servidor en modo producción no arrancó:\n${prod.salida().slice(-2500)}`);
  process.exit(1);
}

await t('LEGADO', 'POST /api/auth/login con la contraseña global -> 410 ACCESO_LEGADO_DESACTIVADO, sin token', async () => {
  for (const password of [process.env.ADMIN_PASSWORD, process.env.PANEL_PASSWORD]) {
    const r = await pedir(prod.base, '/api/auth/login', { metodo: 'POST', cuerpo: { password } });
    assert.strictEqual(r.status, 410);
    assert.strictEqual(r.body.code, 'ACCESO_LEGADO_DESACTIVADO');
    assert.ok(!r.body.token, 'no entrega token');
    assert.ok(!r.texto.includes(TOKEN_ADMIN) && !r.texto.includes(TOKEN_STAFF));
  }
});

await t('LEGADO', 'token legado + X-Negocio-Slug ya no abre /api/config (401); la sesión por correo sí (200)', async () => {
  const legado = await pedir(prod.base, '/api/config', { bearer: TOKEN_ADMIN, cabeceras: { 'X-Negocio-Slug': SLUG_A } });
  assert.strictEqual(legado.status, 401, `token legado dio ${legado.status}`);
  const sinSlug = await pedir(prod.base, '/api/config', { bearer: TOKEN_ADMIN });
  assert.strictEqual(sinSlug.status, 401);
  const sesion = await pedir(prod.base, '/api/config', { cookie: cookieAdminA });
  assert.strictEqual(sesion.status, 200, `la sesión por correo dio ${sesion.status}`);
});

await t('LEGADO', 'POST /api/auth/sesion con el token legado ya no fabrica sesiones (ni de superadmin)', async () => {
  for (const usuarioId of [SEED.superadminUsuarioId, SEED.adminNegocioAUsuarioId]) {
    const r = await pedir(prod.base, '/api/auth/sesion', { metodo: 'POST', bearer: TOKEN_ADMIN, cuerpo: { usuarioId } });
    assert.strictEqual(r.status, 401, `dio ${r.status}`);
    assert.strictEqual(r.body.code, 'ACCESO_LEGADO_DESACTIVADO');
    assert.ok(!r.body.token, 'no entrega sesión');
  }
});

await t('LEGADO', '/api/auth/verify y las rutas Rappi legadas rechazan el token (401)', async () => {
  assert.strictEqual((await pedir(prod.base, '/api/auth/verify', { bearer: TOKEN_STAFF })).status, 401);
  assert.strictEqual((await pedir(prod.base, '/api/auth/verify', { bearer: TOKEN_ADMIN })).status, 401);
  for (const [metodo, ruta] of [['PUT', '/api/rappi/stockout'], ['POST', '/api/rappi/setup-webhooks'], ['PUT', '/api/rappi/estado-tienda']]) {
    const r = await pedir(prod.base, ruta, { metodo, bearer: TOKEN_ADMIN, cuerpo: {} });
    assert.strictEqual(r.status, 401, `${ruta} dio ${r.status}`);
  }
});

await t('LEGADO', 'el arranque lo declara apagado y avisa de INTERNAL_SECRET; el log no trae ningún secreto', async () => {
  const s = prod.salida();
  assert.ok(s.includes('[Auth] Acceso con contraseña global: apagado'), 'falta la línea de arranque');
  assert.ok(s.includes('[Secretos] AVISO: INTERNAL_SECRET'), 'falta el aviso de INTERNAL_SECRET');
  sinSecretos(s, 'el log de arranque');
});

await t('SECRETOS', '/internal/analizar-semana sin INTERNAL_SECRET en producción no acepta el valor de respaldo del código', async () => {
  const r = await pedir(prod.base, '/internal/analizar-semana', { metodo: 'POST', cabeceras: { 'x-internal-secret': 'xabor-internal' } });
  assert.strictEqual(r.status, 403, `dio ${r.status}`);
  const vacio = await pedir(prod.base, '/internal/analizar-semana', { metodo: 'POST', cabeceras: { 'x-internal-secret': '' } });
  assert.strictEqual(vacio.status, 403);
});

// ── Portal del repartidor ────────────────────────────────────────────────
const { rows: [negC] } = await pool.query('SELECT slug, activo FROM negocios WHERE id = $1', [SEED.negocioC]);
const { rows: [negB] } = await pool.query('SELECT slug FROM negocios WHERE id = $1', [SEED.negocioB]);
const NEGOCIOS_PORTAL = [SEED.negocioA, SEED.negocioB, SEED.negocioC];
const modulosAntes = (await pool.query(
  `SELECT negocio_id::text AS negocio, estado FROM negocio_modulos WHERE modulo = 'repartidores' AND negocio_id = ANY($1::uuid[])`, [NEGOCIOS_PORTAL])).rows;
async function portal(negocioId, estado) {
  if (estado === null) return pool.query(`DELETE FROM negocio_modulos WHERE negocio_id = $1 AND modulo = 'repartidores'`, [negocioId]);
  return pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'repartidores',$2)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $2`, [negocioId, estado]);
}
const TEL = (n) => `52187819900${String(n).padStart(2, '0')}`;
const filasTel = async (n) => (await pool.query(`SELECT nombre, negocio_id::text AS negocio_id, token FROM repartidores WHERE telefono LIKE $1`, [`%${TEL(n).slice(-10)}`])).rows;
await pool.query(`DELETE FROM notificaciones_repartidor WHERE repartidor_id IN (SELECT id FROM repartidores WHERE telefono LIKE '%87819900%')`).catch(() => {});
await pool.query(`DELETE FROM repartidores WHERE telefono LIKE '%87819900%'`);
const rep = (ruta, opciones = {}) => pedir(prod.base, ruta, { ...opciones, cabeceras: { ...(opciones.token ? { 'x-rep-token': opciones.token } : {}) } });

let tokenA = null;
try {
  await t('PORTAL', 'módulo «repartidores» apagado: el alta responde 403 PORTAL_REPARTIDOR_CERRADO y no escribe nada', async () => {
    await portal(SEED.negocioA, null);
    const r = await rep('/api/repartidor/registro', { metodo: 'POST', cuerpo: { nombre: 'Rep Cerrado', telefono: TEL(1), negocioSlug: SLUG_A } });
    assert.strictEqual(r.status, 403, `dio ${r.status}`);
    assert.strictEqual(r.body.code, 'PORTAL_REPARTIDOR_CERRADO');
    assert.ok(!r.body.token);
    assert.strictEqual((await filasTel(1)).length, 0, 'no debe crear la fila');
    await portal(SEED.negocioA, 'suspendido');
    const s = await rep('/api/repartidor/registro', { metodo: 'POST', cuerpo: { nombre: 'Rep Cerrado', telefono: TEL(1), negocioSlug: SLUG_A } });
    assert.strictEqual(s.status, 403, `suspendido dio ${s.status}`);
  });

  await t('PORTAL', 'módulo encendido: alta, login y /me funcionan como antes', async () => {
    await portal(SEED.negocioA, 'activo');
    const r = await rep('/api/repartidor/registro', { metodo: 'POST', cuerpo: { nombre: 'Rep Abierto', telefono: TEL(2), negocioSlug: SLUG_A } });
    assert.strictEqual(r.status, 200, `alta dio ${r.status}`);
    tokenA = r.body.token;
    assert.ok(tokenA);
    const login = await rep('/api/repartidor/login', { metodo: 'POST', cuerpo: { telefono: TEL(2) } });
    assert.strictEqual(login.status, 200);
    const me = await rep('/api/repartidor/me', { token: tokenA });
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.nombre, 'Rep Abierto');
  });

  await t('PORTAL', 'apagar el módulo cierra el token ya emitido (/me, pedido-actual, entregas) y el login no entrega token', async () => {
    await portal(SEED.negocioA, null);
    for (const ruta of ['/api/repartidor/me', '/api/repartidor/pedido-actual', '/api/repartidor/pedidos', '/api/repartidor/entregas?rango=hoy&estado=todos&pagina=1']) {
      const r = await rep(ruta, { token: tokenA });
      assert.strictEqual(r.status, 403, `${ruta} dio ${r.status}`);
      assert.strictEqual(r.body.code, 'PORTAL_REPARTIDOR_CERRADO');
    }
    const login = await rep('/api/repartidor/login', { metodo: 'POST', cuerpo: { telefono: TEL(2) } });
    assert.strictEqual(login.status, 403, `login dio ${login.status}`);
    assert.ok(!login.body.token, 'el login no entrega token');
    assert.ok(!login.texto.includes(tokenA));
  });

  await t('PORTAL', 'un negocio INACTIVO no abre el portal aunque tenga el módulo', async () => {
    await portal(SEED.negocioC, 'activo');
    await pool.query('UPDATE negocios SET activo = false WHERE id = $1', [SEED.negocioC]);
    const r = await rep('/api/repartidor/registro', { metodo: 'POST', cuerpo: { nombre: 'Rep Inactivo', telefono: TEL(3), negocioSlug: negC.slug } });
    assert.strictEqual(r.status, 403, `dio ${r.status}`);
    assert.strictEqual((await filasTel(3)).length, 0);
  });

  await t('PORTAL', 'el alta en un negocio abierto no reescribe ni entrega al repartidor de un negocio cerrado', async () => {
    await portal(SEED.negocioA, null);
    await portal(SEED.negocioB, 'activo');
    // TEL(2) es del negocio A (portal cerrado ahora).
    const r = await rep('/api/repartidor/registro', { metodo: 'POST', cuerpo: { nombre: 'Intruso', telefono: TEL(2), negocioSlug: negB.slug } });
    assert.strictEqual(r.status, 403, `dio ${r.status}`);
    assert.ok(!r.body.token);
    const [fila] = await filasTel(2);
    assert.strictEqual(fila.nombre, 'Rep Abierto', 'el nombre no cambió');
    assert.strictEqual(fila.negocio_id, SEED.negocioA);
  });

  await t('PORTAL', 'las ofertas de la red de repartidores no pasan por la compuerta del portal', async () => {
    const r = await rep('/api/repartidor/oferta/token-que-no-existe');
    assert.notStrictEqual(r.body?.code, 'PORTAL_REPARTIDOR_CERRADO');
    assert.notStrictEqual(r.status, 403);
  });
} finally {
  await pool.query('UPDATE negocios SET activo = $2 WHERE id = $1', [SEED.negocioC, negC.activo]);
  for (const n of NEGOCIOS_PORTAL) {
    const previo = modulosAntes.find(x => x.negocio === n);
    if (previo) await portal(n, previo.estado); else await portal(n, null);
  }
  await pool.query(`DELETE FROM repartidores WHERE telefono LIKE '%87819900%'`).catch(() => {});
}
await prod.detener();

// ═════════════ 3. Railway sin NODE_ENV cuenta como producción ═════════════
await t('LEGADO', 'solo con RAILWAY_ENVIRONMENT_ID (sin NODE_ENV) el login legado también queda apagado', async () => {
  const s = await arrancar({ PORT: String(puertoBase + 1), RAILWAY_ENVIRONMENT_ID: 'prueba-local' }, { omitir: [] });
  assert.ok(s.listo, `no arrancó:\n${s.salida().slice(-1500)}`);
  try {
    const r = await pedir(s.base, '/api/auth/login', { metodo: 'POST', cuerpo: { password: process.env.ADMIN_PASSWORD } });
    assert.strictEqual(r.status, 410);
  } finally { await s.detener(); }
});

// ═════════════ 4. Reversa y desarrollo local ═════════════
await t('REVERSA', 'XABOR_ACCESO_LEGADO=permitir en producción regresa el acceso anterior (sin tocar código)', async () => {
  const s = await arrancar({ PORT: String(puertoBase + 2), NODE_ENV: 'production', XABOR_ACCESO_LEGADO: 'permitir', INTERNAL_SECRET: 'prueba-interna' });
  assert.ok(s.listo, `no arrancó:\n${s.salida().slice(-1500)}`);
  try {
    const login = await pedir(s.base, '/api/auth/login', { metodo: 'POST', cuerpo: { password: process.env.ADMIN_PASSWORD } });
    assert.strictEqual(login.status, 200);
    assert.strictEqual(login.body.token, TOKEN_ADMIN);
    const cfg = await pedir(s.base, '/api/config', { bearer: TOKEN_ADMIN, cabeceras: { 'X-Negocio-Slug': SLUG_A } });
    assert.strictEqual(cfg.status, 200);
    assert.ok(s.salida().includes('[Auth] Acceso con contraseña global: ENCENDIDO'));
  } finally { await s.detener(); }
});

await t('LOCAL', 'fuera de producción nada cambia: login legado 200 y token + slug 200', async () => {
  const s = await arrancar({ PORT: String(puertoBase + 3) });
  assert.ok(s.listo, `no arrancó:\n${s.salida().slice(-1500)}`);
  try {
    const login = await pedir(s.base, '/api/auth/login', { metodo: 'POST', cuerpo: { password: process.env.PANEL_PASSWORD } });
    assert.strictEqual(login.status, 200);
    assert.strictEqual(login.body.role, 'staff');
    const cfg = await pedir(s.base, '/api/config', { bearer: TOKEN_ADMIN, cabeceras: { 'X-Negocio-Slug': SLUG_A } });
    assert.strictEqual(cfg.status, 200);
  } finally { await s.detener(); }
});

// ═════════════ 5. Arranque sin secretos ═════════════
await t('ARRANQUE', 'producción sin SESSION_SECRET: sale con código 1 antes de tocar la base y sin abrir el puerto', async () => {
  const s = await arrancar({ PORT: String(puertoBase + 4), NODE_ENV: 'production' }, { omitir: ['SESSION_SECRET'] });
  assert.ok(s.salio, s.listo ? 'ARRANCÓ sin SESSION_SECRET' : 'no terminó a tiempo');
  assert.strictEqual(s.code, 1);
  assert.ok(s.salida().includes('[Secretos] FALLO: SESSION_SECRET no está definida'), 'falta el motivo');
  assert.ok(!s.salida().includes('[Startup] Inicializando base'), 'no debió tocar la base');
});

await t('ARRANQUE', 'producción con el SESSION_SECRET de respaldo del código: tampoco arranca', async () => {
  const s = await arrancar({ PORT: String(puertoBase + 5), NODE_ENV: 'production', SESSION_SECRET: SESSION_SECRET_DE_RESPALDO });
  assert.ok(s.salio, s.listo ? 'ARRANCÓ con el secreto de respaldo' : 'no terminó a tiempo');
  assert.strictEqual(s.code, 1);
  assert.ok(s.salida().includes('[Secretos] FALLO: SESSION_SECRET tiene el valor de respaldo'));
  assert.ok(!s.salida().includes(SESSION_SECRET_DE_RESPALDO), 'el log repite el valor');
});

await t('ARRANQUE', 'Railway sin NODE_ENV y sin SESSION_SECRET: tampoco arranca', async () => {
  const s = await arrancar({ PORT: String(puertoBase + 6), RAILWAY_PROJECT_ID: 'prueba-local' }, { omitir: ['SESSION_SECRET'] });
  assert.ok(s.salio, s.listo ? 'ARRANCÓ sin SESSION_SECRET' : 'no terminó a tiempo');
  assert.strictEqual(s.code, 1);
});

// ═════════════ 6. Predeploy ═════════════
const correrCheck = (env) => {
  const e = { ...process.env };
  for (const k of [...LIMPIAR_ENTORNO, 'SESSION_SECRET', 'META_APP_SECRET']) delete e[k];
  Object.assign(e, env);
  return spawnSync(process.execPath, [join(RAIZ, 'scripts', 'predeploy-check-secretos.mjs')], { env: e, encoding: 'utf8', timeout: 30000 });
};
await t('PREDEPLOY', 'predeploy-check-secretos: falla sin SESSION_SECRET o con el de respaldo; pasa con uno propio y fuera de producción', async () => {
  const sin = correrCheck({ NODE_ENV: 'production' });
  assert.strictEqual(sin.status, 1, 'sin secreto debe fallar');
  assert.ok((sin.stderr + sin.stdout).includes('FALLO: SESSION_SECRET no está definida'));
  const respaldo = correrCheck({ NODE_ENV: 'production', SESSION_SECRET: SESSION_SECRET_DE_RESPALDO });
  assert.strictEqual(respaldo.status, 1);
  assert.ok(!(respaldo.stderr + respaldo.stdout).includes(SESSION_SECRET_DE_RESPALDO));
  const bien = correrCheck({ NODE_ENV: 'production', SESSION_SECRET: SECRETO_LARGO, META_APP_SECRET: META_PRUEBA });
  assert.strictEqual(bien.status, 0, (bien.stderr || '') + bien.stdout);
  sinSecretos(bien.stderr + bien.stdout, 'la salida del predeploy');
  assert.strictEqual(correrCheck({}).status, 0, 'local sin variables: pasa');
});

await t('PREDEPLOY', 'el runner de Railway corre el chequeo de secretos PRIMERO, antes de cualquier migración', async () => {
  const fuente = readFileSync(join(RAIZ, 'scripts', 'predeploy-run-032-033.mjs'), 'utf8');
  const bloque = fuente.slice(fuente.indexOf('const CHECKS = ['), fuente.indexOf('];', fuente.indexOf('const CHECKS = [')));
  const nombres = [...bloque.matchAll(/^\s*'([^']+\.mjs)'/gm)].map(m => m[1]);
  assert.strictEqual(nombres[0], 'predeploy-check-secretos.mjs', `primer chequeo: ${nombres[0]}`);
  assert.ok(fuente.indexOf('for (const nombre of CHECKS)') < fuente.indexOf('for (const nombre of SCRIPTS)'), 'los chequeos corren antes que las migraciones');
});

await t('FRONTEND', 'la página de login anterior muestra el aviso del servidor en vez de «Contraseña incorrecta»', async () => {
  const html = readFileSync(join(RAIZ, 'panel', 'login.html'), 'utf8');
  assert.ok(/data\.code === 'ACCESO_LEGADO_DESACTIVADO' \? '❌ ' \+ data\.error/.test(html), 'login.html no distingue el acceso apagado');
});

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(` - ${f}`)); }
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
