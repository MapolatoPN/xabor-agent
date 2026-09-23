// Entorno local de autofactura: `npm run dev:autofactura` y
// `npm run smoke:autofactura` comparten scripts/local-env-autofactura.cjs.
//
// Se prueba con un dev-local.env.cmd TEMPORAL (nunca el real) que apunta a la
// misma base local de pruebas: la DB final queda en edged1_agrescate, la
// llave de cifrado del archivo se conserva, el diagnóstico encuentra el
// negocio de prueba y su módulo, el puerto ocupado aborta SIN matar el
// proceso que lo ocupa, NODE_ENV=production aborta, el smoke usa el mismo
// entorno y aborta antes de red si Facturapi no está lista, y ninguna salida
// contiene la contraseña de la base, la llave de cifrado ni una sk_test_.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL requerida');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname), 'solo base local');
assert.ok(process.env.INTEGRATIONS_ENCRYPTION_KEY, 'INTEGRATIONS_ENCRYPTION_KEY requerida');

const helper = (await import('../scripts/local-env-autofactura.cjs')).default;
const { construirEntorno, diagnosticar, pidEnPuerto, leerEnvCmd, NEGOCIO_TEST, DB_LOCAL } = helper;
const RAIZ = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DEV = join(RAIZ, 'scripts', 'dev-autofactura-local.cjs');
const SMOKE = join(RAIZ, 'scripts', 'smoke-autofactura-local.cjs');

let pasadas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallos.push(`${nombre}: ${e.message}`); }
}

// Archivo de entorno TEMPORAL con las credenciales reales de la base local
// (tomadas del entorno de esta prueba) pero apuntando a otra base, para
// comprobar que el helper la redirige a edged1_agrescate.
const urlReal = new URL(process.env.DATABASE_URL);
const PASSWORD = decodeURIComponent(urlReal.password);
const LLAVE = process.env.INTEGRATIONS_ENCRYPTION_KEY;
const urlOtra = new URL(process.env.DATABASE_URL); urlOtra.pathname = '/edged1';
const dir = mkdtempSync(join(tmpdir(), 'xabor-af-env-'));
const ARCHIVO = join(dir, 'dev-local.env.cmd');
function escribirEnv(extra = '') {
  writeFileSync(ARCHIVO, ['@echo off', 'REM archivo TEMPORAL de prueba',
    `set DATABASE_URL=${urlOtra.toString()}`, 'set PANEL_SECRET=panel-prueba', 'set SESSION_SECRET=sesion-prueba',
    `set INTEGRATIONS_ENCRYPTION_KEY=${LLAVE}`, 'set META_EMBEDDED_SIGNUP_MOCK=true', extra, ''].join('\r\n'));
}
escribirEnv();
const SECRETOS = [PASSWORD, LLAVE, 'sk_test_', 'sk_live_'];
function sinSecretos(texto, contexto) {
  for (const s of SECRETOS) assert.ok(!texto.includes(s), `${contexto}: la salida contiene un secreto (${s === PASSWORD ? 'password' : s === LLAVE ? 'encryption key' : s})`);
}
function correr(script, { archivo = ARCHIVO, envExtra = {} } = {}) {
  const env = { ...process.env, XABOR_DEV_ENV_CMD: archivo, ...envExtra };
  const r = spawnSync(process.execPath, [script, '--solo-diagnostico'], { cwd: RAIZ, env, encoding: 'utf8', timeout: 60000 });
  const salida = (r.stdout || '') + (r.stderr || '');
  sinSecretos(salida, script);
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', salida };
}
async function puertoLibre() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

try {

await t('1. DB final correcta: mismo host, puerto y credenciales, base edged1_agrescate', async () => {
  const { env, resumen } = construirEntorno({ archivo: ARCHIVO, base: {} });
  const u = new URL(env.DATABASE_URL);
  assert.equal(u.pathname, `/${DB_LOCAL}`);
  assert.equal(u.hostname, urlReal.hostname); assert.equal(u.port, urlReal.port);
  assert.equal(u.username, urlReal.username); assert.equal(decodeURIComponent(u.password), PASSWORD);
  assert.equal(resumen.db, `${urlReal.hostname}:${urlReal.port}/${DB_LOCAL}`);
  assert.equal(resumen.entorno, 'LOCAL');
  sinSecretos(JSON.stringify(resumen), 'resumen');
});

await t('2. la INTEGRATIONS_ENCRYPTION_KEY del archivo se conserva aunque la sesión tenga otra', async () => {
  const { env, resumen } = construirEntorno({ archivo: ARCHIVO, base: { INTEGRATIONS_ENCRYPTION_KEY: 'otra-llave-de-sesion', DATABASE_URL: 'postgresql://x:y@otro:1/z' } });
  assert.equal(env.INTEGRATIONS_ENCRYPTION_KEY, LLAVE);
  assert.equal(resumen.encryptionKey, 'CONFIGURADA');
  assert.equal(new URL(env.DATABASE_URL).hostname, urlReal.hostname, 'el archivo manda sobre la sesión');
  const vars = leerEnvCmd(ARCHIVO);
  assert.equal(vars.INTEGRATIONS_ENCRYPTION_KEY, LLAVE); assert.equal(vars.PANEL_SECRET, 'panel-prueba');
});

await t('3. NODE_ENV=production aborta (en la sesión o en el archivo)', async () => {
  assert.throws(() => construirEntorno({ archivo: ARCHIVO, base: { NODE_ENV: 'production' } }), /production/);
  escribirEnv('set NODE_ENV=production');
  assert.throws(() => construirEntorno({ archivo: ARCHIVO, base: {} }), /production/);
  const r = correr(DEV);
  assert.equal(r.code, 1); assert.match(r.salida, /production/);
  escribirEnv();
});

await t('4. sin DATABASE_URL o sin llave de cifrado no arranca nada', async () => {
  writeFileSync(ARCHIVO, `set INTEGRATIONS_ENCRYPTION_KEY=${LLAVE}\r\n`);
  assert.throws(() => construirEntorno({ archivo: ARCHIVO, base: {} }), /DATABASE_URL/);
  writeFileSync(ARCHIVO, `set DATABASE_URL=${urlOtra.toString()}\r\n`);
  assert.throws(() => construirEntorno({ archivo: ARCHIVO, base: {} }), /INTEGRATIONS_ENCRYPTION_KEY/);
  assert.throws(() => construirEntorno({ archivo: join(dir, 'no-existe.cmd'), base: {} }), /No existe/);
  escribirEnv();
});

let diag;
await t('5. diagnóstico: negocio de prueba encontrado y activo, módulo de facturación habilitado', async () => {
  const { env } = construirEntorno({ archivo: ARCHIVO, base: {} });
  diag = await diagnosticar(env);
  assert.equal(diag.negocioId, NEGOCIO_TEST);
  assert.equal(diag.negocio, 'OK'); assert.ok(diag.nombre);
  assert.equal(diag.modulo, 'OK'); assert.equal(diag.ok, true);
  assert.ok(['CONFIGURADA', 'CONFIGURADA (NO ES sk_test_)', 'NO CONFIGURADA', 'NO DESCIFRABLE'].includes(diag.facturapi), diag.facturapi);
  sinSecretos(JSON.stringify(diag), 'diagnóstico');
});

await t('6. puerto libre -> null; puerto ocupado -> PID del proceso que escucha', async () => {
  const libre = await puertoLibre();
  assert.equal(await pidEnPuerto(libre), null);
  const s = net.createServer(); await new Promise((r) => s.listen(libre, r));
  try {
    const pid = await pidEnPuerto(libre);
    assert.ok(pid, 'no detectó el puerto ocupado');
    if (typeof pid === 'number') assert.equal(pid, process.pid);
  } finally { await new Promise((r) => s.close(r)); }
  assert.equal(await pidEnPuerto(libre), null);
});

await t('7. dev:autofactura con el puerto ocupado aborta y NO mata al proceso que lo ocupa', async () => {
  const puerto = await puertoLibre();
  const s = net.createServer(); await new Promise((r) => s.listen(puerto, r));
  try {
    escribirEnv(`set PORT=${puerto}`);
    const r = correr(DEV);
    assert.equal(r.code, 2, r.salida);
    assert.match(r.salida, new RegExp(`Puerto ${puerto} ocupado por PID \\d+\\. Ciérralo antes de continuar\\.`));
    assert.ok(s.listening, 'el launcher mató el proceso que ocupaba el puerto');
    assert.equal(await pidEnPuerto(puerto), process.pid, 'el puerto sigue en manos de esta prueba');
  } finally { await new Promise((r) => s.close(r)); escribirEnv(); }
});

let salidaDev;
await t('8. dev:autofactura con el puerto libre imprime exactamente el resumen y el diagnóstico', async () => {
  const puerto = await puertoLibre();
  escribirEnv(`set PORT=${puerto}`);
  const r = correr(DEV);
  assert.equal(r.code, 0, r.salida);
  salidaDev = r.stdout;
  assert.match(r.stdout, new RegExp(`^DB: ${urlReal.hostname}:${urlReal.port}/${DB_LOCAL}$`, 'm'));
  assert.match(r.stdout, /^ENCRYPTION_KEY: CONFIGURADA$/m);
  assert.match(r.stdout, /^ENTORNO: LOCAL$/m);
  assert.match(r.stdout, /^NEGOCIO TEST: OK/m);
  assert.match(r.stdout, /^MODULO FACTURACION: OK$/m);
  assert.match(r.stdout, /^FACTURAPI TEST: (CONFIGURADA|NO CONFIGURADA|NO DESCIFRABLE|CONFIGURADA \(NO ES sk_test_\))$/m);
  assert.match(r.stdout, new RegExp(`^PUERTO ${puerto}: LIBRE$`, 'm'));
  if (!/FACTURAPI TEST: CONFIGURADA$/m.test(r.stdout)) assert.match(r.stdout, /Facturapi debe volver a vincularse UNA vez desde Configuración → Facturación\./);
  assert.ok(!r.stdout.includes('postgresql://'), 'la URL completa no se imprime');
  escribirEnv();
});

await t('9. smoke:autofactura usa el MISMO entorno y aborta antes de red si Facturapi no está lista', async () => {
  const r = correr(SMOKE);
  const dbDev = salidaDev.match(/^DB: .*$/m)[0];
  assert.equal(r.stdout.match(/^DB: .*$/m)?.[0], dbDev, 'el smoke no apunta a la misma base que dev');
  assert.match(r.stdout, /^ENCRYPTION_KEY: CONFIGURADA$/m);
  assert.match(r.stdout, /^NEGOCIO TEST: OK/m);
  if (diag.facturapi === 'CONFIGURADA') {
    assert.equal(r.code, 0, r.salida);
  } else {
    assert.equal(r.code, 3, r.salida);
    assert.match(r.salida, /SMOKE ABORTADO antes de red: Facturapi (NO DESCIFRABLE|NO CONFIGURADA|CONFIGURADA \(NO ES sk_test_\))\./);
  }
  const { env: envDev } = construirEntorno({ archivo: ARCHIVO, base: {} });
  const { env: envSmoke } = construirEntorno({ archivo: ARCHIVO, base: {} });
  assert.equal(envDev.DATABASE_URL, envSmoke.DATABASE_URL);
  assert.equal(envDev.INTEGRATIONS_ENCRYPTION_KEY, envSmoke.INTEGRATIONS_ENCRYPTION_KEY);
});

await t('10. ninguna salida contiene la contraseña de la base, la llave de cifrado ni sk_test_', async () => {
  const puerto = await puertoLibre();
  escribirEnv(`set PORT=${puerto}`);
  for (const script of [DEV, SMOKE]) { const r = correr(script); sinSecretos(r.salida, script); }
  escribirEnv();
});

} finally {
  try { unlinkSync(ARCHIVO); } catch { /* ya no existe */ }
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`PASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
