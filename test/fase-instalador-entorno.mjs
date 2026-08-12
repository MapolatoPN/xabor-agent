// El instalador ante una configuración de OTRO entorno.
//
// Defecto real (Acuña, 2026-08-11): una instalación de prueba dejó en
// ProgramData una config apuntando a ws://localhost:4300. El Setup de
// PRODUCCIÓN encontró el archivo, dio el equipo por vinculado, se saltó el
// emparejamiento y terminó "correctamente" -- con un servicio conectándose a
// localhost para siempre. "Hay una config" no es "hay una config de ESTE
// Xabor".
//
// Aquí se prueba la pieza que decide: canjear.mjs, con XABOR_EDGE_PROGRAMDATA
// apuntando a un temporal y un Xabor de mentira en localhost para los casos
// que sí canjean. Ningún pairing real, ninguna URL real.
//
// Uso: node test/fase-instalador-entorno.mjs
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANJEAR = join(__dirname, '..', 'installer', 'canjear.mjs');
const ISS = readFileSync(join(__dirname, '..', 'installer', 'XaborEdge.iss'), 'utf8');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ─── Un Xabor de mentira que acepta cualquier canje ─────────────────────────
let canjes = 0;
const servidor = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/edge/emparejar') {
    canjes++;
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ terminalId: `T-NUEVA-${canjes}`, token: `TOK-NUEVO-${canjes}` }));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
const PUERTO = servidor.address().port;
const URL_PROD_SIMULADA = `http://127.0.0.1:${PUERTO}`;   // hace de "producción"
const URL_CAIDA = 'http://127.0.0.1:1';                    // nadie escucha ahí

function base() {
  const b = mkdtempSync(join(tmpdir(), 'xabor-entorno-'));
  mkdirSync(join(b, 'config'), { recursive: true });
  return b;
}
function plantarConfig(b, urlNube, extra = {}) {
  writeFileSync(join(b, 'config', 'config.json'), JSON.stringify({
    terminalId: 'T-PREVIA', terminalToken: 'TOK-PREVIO', urlNube,
    nombreEquipo: 'Caja previa', ...extra,
  }, null, 2));
}
function leerConfig(b) {
  const ruta = join(b, 'config', 'config.json');
  try {
    return JSON.parse(readFileSync(ruta, 'utf8'));
  } catch (e) {
    if ((e.code === 'EACCES' || e.code === 'EPERM') && process.platform === 'win32') {
      // Un canje exitoso deja la ACL real (solo SYSTEM y Administradores):
      // esta prueba corre sin elevar y no puede leer lo que quiere verificar.
      // El dueño del archivo -- este mismo usuario, via el hijo -- si puede
      // re-otorgarse acceso (WRITE_DAC es del owner). S-1-5-11 = usuarios
      // autenticados, en cualquier idioma de Windows.
      execFileSync('icacls.exe', [ruta, '/grant', '*S-1-5-11:(F)'], { stdio: 'ignore' });
      return JSON.parse(readFileSync(ruta, 'utf8'));
    }
    throw e;
  }
}
// spawn asíncrono y no execFileSync, a propósito: el Xabor de mentira vive en
// ESTE mismo proceso, y una espera síncrona bloquearía el event loop justo
// cuando el hijo intenta canjear contra él -- el fetch se quedaría colgado
// hasta su timeout y todos los casos de canje "fallarían de red" en falso.
function correr(b, { codigo = 'ABC123', url = URL_PROD_SIMULADA } = {}) {
  const args = [CANJEAR, '--url', url];
  if (codigo !== null) args.push('--codigo', codigo);
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, args,
      { env: { ...process.env, XABOR_EDGE_PROGRAMDATA: b }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', (code) => resolve({ code, out, err }));
  });
}

const temporales = [];
try {

await t('1. config de produccion + setup de produccion => se reutiliza sin canjear', async () => {
  const b = base(); temporales.push(b);
  plantarConfig(b, URL_PROD_SIMULADA.replace(/^http/, 'ws') + '/ws/print-agent');
  const antes = canjes;
  const r = await correr(b);
  assert.strictEqual(r.code, 0, `exit ${r.code}: ${r.out}`);
  assert.match(r.out, /ya estaba conectado/i);
  assert.strictEqual(canjes, antes, 'no debe llamar a Xabor: el codigo es de un solo uso y no hay nada que canjear');
  assert.strictEqual(leerConfig(b).terminalId, 'T-PREVIA', 'las credenciales se conservan tal cual');
});

await t('2. config de localhost + setup de produccion => exige re-emparejar (canjea)', async () => {
  const b = base(); temporales.push(b);
  plantarConfig(b, 'ws://localhost:4300/ws/print-agent');
  const antes = canjes;
  const r = await correr(b);
  assert.strictEqual(r.code, 0, `exit ${r.code}: ${r.out}`);
  assert.strictEqual(canjes, antes + 1, 'con la config de OTRO entorno tiene que canjear de verdad');
  const cfg = leerConfig(b);
  assert.notStrictEqual(cfg.terminalId, 'T-PREVIA', 'las credenciales viejas no valen aqui: se reemplazan');
  assert.ok(cfg.urlNube.startsWith(URL_PROD_SIMULADA.replace(/^http/, 'ws')),
    `urlNube debe apuntar al entorno nuevo, quedo: ${cfg.urlNube}`);
});

await t('3. config de localhost + setup de produccion SIN codigo => falla, nunca "exito" silencioso', async () => {
  const b = base(); temporales.push(b);
  plantarConfig(b, 'ws://localhost:4300/ws/print-agent');
  const r = await correr(b, { codigo: null });
  assert.notStrictEqual(r.code, 0, 'sin codigo y con config ajena, terminar bien seria repetir el defecto original');
  assert.strictEqual(r.code, 5, `se esperaba exit 5 (falta codigo) y llego ${r.code}`);
  assert.strictEqual(leerConfig(b).terminalId, 'T-PREVIA', 'la config existente no se toca al fallar');
});

await t('4. config de staging/test + setup de produccion => no se reutiliza', async () => {
  const b = base(); temporales.push(b);
  plantarConfig(b, 'wss://staging.xabor.mx/ws/print-agent');
  const antes = canjes;
  const r = await correr(b);
  assert.strictEqual(r.code, 0, `exit ${r.code}: ${r.out}`);
  assert.strictEqual(canjes, antes + 1, 'staging no es produccion: tiene que canjear');
  assert.notStrictEqual(leerConfig(b).terminalId, 'T-PREVIA');
});

await t('5. config corrupta => no se considera valida, se canjea', async () => {
  const b = base(); temporales.push(b);
  writeFileSync(join(b, 'config', 'config.json'), '{ esto no es json');
  const antes = canjes;
  const r = await correr(b);
  assert.strictEqual(r.code, 0, `exit ${r.code}: ${r.out}`);
  assert.strictEqual(canjes, antes + 1);
  assert.ok(leerConfig(b).terminalId, 'la config queda rehecha y legible');
});

await t('6. config sin urlNube (formato viejo/incompleto) => no se asume el entorno, se canjea', async () => {
  // origenDe(undefined) es null y null nunca "coincide": una config que no
  // dice a donde apunta jamas debe reutilizarse por accidente.
  const b = base(); temporales.push(b);
  plantarConfig(b, undefined);
  const antes = canjes;
  const r = await correr(b);
  assert.strictEqual(r.code, 0, `exit ${r.code}: ${r.out}`);
  assert.strictEqual(canjes, antes + 1);
});

await t('7. fallo de red NO destruye una config existente valida', async () => {
  const b = base(); temporales.push(b);
  plantarConfig(b, 'ws://localhost:4300/ws/print-agent');
  const r = await correr(b, { url: URL_CAIDA });
  assert.strictEqual(r.code, 3, `se esperaba exit 3 (sin conexion) y llego ${r.code}: ${r.out}`);
  const cfg = leerConfig(b);
  assert.strictEqual(cfg.terminalId, 'T-PREVIA', 'un canje fallido jamas borra la config que habia');
  assert.strictEqual(cfg.urlNube, 'ws://localhost:4300/ws/print-agent');
});

await t('8. ws:// y http:// del mismo host cuentan como el MISMO entorno', async () => {
  // La config guarda ws://; el instalador pasa http://. Ambos nombran al
  // mismo Xabor y una reparacion no debe pedir codigo por esa diferencia.
  const b = base(); temporales.push(b);
  plantarConfig(b, URL_PROD_SIMULADA.replace(/^http/, 'ws') + '/ws/print-agent');
  const antes = canjes;
  const r = await correr(b, { codigo: null });   // reparacion: sin codigo
  assert.strictEqual(r.code, 0, `exit ${r.code}: ${r.out} -- una reparacion del mismo entorno no necesita codigo`);
  assert.strictEqual(canjes, antes);
});

// ─── Contrato sobre el .iss: el atajo inseguro no puede volver ──────────────

await t('9. el .iss ya no salta el canje por la mera existencia de config.json', async () => {
  assert.ok(!/if\s+YaVinculado\s+then\s+Exit/i.test(ISS),
    'el atajo "si existe config.json, no canjear" fue exactamente el agujero del defecto: no puede volver');
  assert.ok(!/function\s+YaVinculado/i.test(ISS),
    'YaVinculado (existencia a secas) no debe existir: la comprobacion correcta es por entorno');
});

await t('10. la pagina del codigo solo se salta si la config es DEL MISMO entorno', async () => {
  assert.ok(/function\s+ConfigDelMismoEntorno/i.test(ISS));
  const skip = ISS.slice(ISS.indexOf('function ShouldSkipPage'));
  assert.ok(/ConfigDelMismoEntorno/.test(skip.slice(0, 300)),
    'ShouldSkipPage tiene que decidir por entorno, no por existencia');
  assert.ok(/UrlNubeEsperada/.test(ISS), 'la comparacion usa la URL con la que se compilo el Setup');
});

} finally {
  servidor.close();
  for (const b of temporales) { try { rmSync(b, { recursive: true, force: true }); } catch { /* lo limpia el sistema */ } }
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach((f) => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
