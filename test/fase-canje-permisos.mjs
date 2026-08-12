// El canje ante una configuración que existe pero no se puede leer.
//
// La ACL que protege el token deja config.json ilegible para quien no está
// elevado. Si el canje tratara ese caso como "no hay configuración" haría lo
// peor posible: pedir un código nuevo a Xabor, consumirlo -- son de un solo
// uso -- e intentar sobrescribir una vinculación que estaba perfectamente
// bien, todo por un problema de permisos.
//
// Se comprueba con una ACL de verdad, no simulando el error.
//
// En sistemas que no son Windows la suite se salta sola.
//
// Uso: node test/fase-canje-permisos.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANJEAR = join(__dirname, '..', 'installer', 'canjear.mjs');
const TOKEN = 'TOKEN-QUE-NO-DEBE-SALIR-NUNCA';

let pasadas = 0, fallidas = 0;
const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

function correr(base, args = []) {
  try {
    const out = execFileSync(process.execPath, [CANJEAR, '--codigo', 'ABC123',
      '--url', 'http://127.0.0.1:45998', ...args],
      { env: { ...process.env, XABOR_EDGE_PROGRAMDATA: base }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: e.stdout || '', err: e.stderr || '' };
  }
}

if (process.platform !== 'win32') {
  console.log('  --  la ACL solo existe en Windows: se omite en ' + process.platform);
} else {
  const base = mkdtempSync(join(tmpdir(), 'xabor-acl-'));
  const cfg = join(base, 'config', 'config.json');
  mkdirSync(join(base, 'config'), { recursive: true });
  writeFileSync(cfg, JSON.stringify({ terminalId: 'T-1', terminalToken: TOKEN, urlNube: 'ws://x/y' }));

  try {
    // La misma ACL que aplica el canje: solo SYSTEM. Quien corre esta prueba
    // deja de poder leer el archivo, igual que le pasaría a un usuario sin
    // elevar en el equipo del restaurante.
    execFileSync('icacls.exe', [cfg, '/inheritance:r', '/grant:r', '*S-1-5-18:(F)'], { stdio: 'ignore' });

    const r = correr(base);

    t('1. config protegida NO se confunde con config ausente', () => {
      assert.strictEqual(r.code, 6,
        `se esperaba el codigo 6 (protegida) y llego ${r.code}: confundirlo con "no existe" gasta un codigo de emparejamiento`);
    });

    t('2. el mensaje dice qué hacer, en castellano', () => {
      assert.match(r.out, /protegida/i);
      assert.match(r.out, /administrador/i);
    });

    t('3. no se intentó canjear nada', () => {
      // Si hubiera intentado el canje contra un servidor caído, el código
      // habría sido 3. Que sea 6 demuestra que ni lo intentó.
      assert.notStrictEqual(r.code, 3, 'no debe llamar a Xabor si ya hay una vinculación que no puede leer');
    });

    t('4. el token no aparece por ningún lado', () => {
      assert.ok(!(r.out || '').includes(TOKEN), 'el token no puede salir por stdout');
      assert.ok(!(r.err || '').includes(TOKEN), 'ni por stderr');
    });
  } finally {
    // Se devuelve el acceso para poder borrar el temporal.
    try { execFileSync('icacls.exe', [cfg, '/grant', '*S-1-5-32-544:(F)'], { stdio: 'ignore' }); } catch { /* da igual */ }
    try { rmSync(base, { recursive: true, force: true }); } catch { /* lo limpia el sistema */ }
  }
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach((f) => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
