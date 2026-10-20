// Firma una versión nueva de Xabor Edge para la actualización automática.
//
//   node scripts/edge/firmar-actualizacion.mjs --version 1.2.1
//        [--desde <commit>]            (por omisión HEAD)
//        [--clave <ruta privada>]      (por omisión %USERPROFILE%\.xabor\clave-privada-actualizaciones-edge.pem)
//        [--terminales <id>,<id>]      (solo esas terminales la reciben: para probar en una PC)
//
// Toma edge/ TAL COMO ESTÁ EN EL COMMIT (no la carpeta de trabajo: nada sin
// commitear se cuela), lo empaqueta, lo firma con la clave privada del dueño
// y escribe en edge-actualizaciones/:
//
//   edge-<v>.json              el paquete
//   edge-<v>.manifiesto.json   versión, SHA-256, tamaño y firma
//   vigente.json               la versión que la nube ofrece
//
// Antes de escribir, comprueba el resultado con el MISMO verificador y la
// MISMA clave pública que lleva el instalador: si un Edge lo rechazaría,
// aquí no se escribe nada.
//
// Para publicarlo: commit de edge-actualizaciones/ y despliegue del servidor.
import { createPrivateKey, createHash, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { textoFirmado, leerClavePublica, verificarManifiesto, verificarPaquete, compararVersiones } from '../../installer/actualizador.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SALIDA = join(REPO, 'edge-actualizaciones');

const args = process.argv.slice(2);
const opcion = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const version = opcion('--version');
const desde = opcion('--desde', 'HEAD');
const rutaClave = resolve(opcion('--clave', join(homedir(), '.xabor', 'clave-privada-actualizaciones-edge.pem')));
const terminales = opcion('--terminales') ? opcion('--terminales').split(',').map(s => s.trim()).filter(Boolean) : null;

const morir = (m) => { console.error(`NO: ${m}`); process.exit(2); };
if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version || '')) morir('falta --version X.Y.Z');
if (!existsSync(rutaClave)) morir(`no está la clave privada en ${rutaClave}`);

const git = (...a) => execFileSync('git', a, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
const commit = git('rev-parse', '--verify', `${desde}^{commit}`).toString().trim();

const versionJs = git('show', `${commit}:edge/version.js`).toString();
const enCodigo = /VERSION_EDGE\s*=\s*'([^']+)'/.exec(versionJs)?.[1];
if (enCodigo !== version) morir(`edge/version.js del commit dice ${enCodigo}, no ${version}: el Edge nunca confirmaría esa versión`);

const vigenteAntes = (() => { try { return JSON.parse(readFileSync(join(SALIDA, 'vigente.json'), 'utf8')).version; } catch { return null; } })();
if (vigenteAntes && !(compararVersiones(version, vigenteAntes) > 0)) morir(`la vigente ya es ${vigenteAntes}: la nueva tiene que ser mayor`);

const archivos = {};
const rutas = git('ls-tree', '-r', '--name-only', commit, 'edge/').toString().split('\n').filter(Boolean);
for (const r of rutas) archivos[r.slice('edge/'.length)] = git('show', `${commit}:${r}`).toString('base64');

const bytes = Buffer.from(JSON.stringify({ version, commit, archivos }), 'utf8');
const manifiesto = {
  version,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  tamano: bytes.length,
};
manifiesto.firma = sign(null, Buffer.from(textoFirmado(manifiesto), 'utf8'), createPrivateKey(readFileSync(rutaClave, 'utf8'))).toString('base64');

// La prueba de verdad: lo que haría un Edge instalado.
const publica = leerClavePublica(join(REPO, 'installer'));
if (!publica) morir('no está installer/clave-publica-actualizaciones.pem');
try {
  verificarPaquete(bytes, verificarManifiesto(manifiesto, publica));
} catch (e) {
  morir(`un Edge lo rechazaría: ${e.message}`);
}

mkdirSync(SALIDA, { recursive: true });
writeFileSync(join(SALIDA, `edge-${version}.json`), bytes);
writeFileSync(join(SALIDA, `edge-${version}.manifiesto.json`), JSON.stringify(manifiesto, null, 2) + '\n');
writeFileSync(join(SALIDA, 'vigente.json'), JSON.stringify(terminales ? { version, terminales } : { version }, null, 2) + '\n');

console.log(`Edge ${version} firmado desde ${commit.slice(0, 7)}: ${rutas.length} archivos, ${bytes.length} bytes.`);
console.log(terminales ? `Solo para: ${terminales.join(', ')}` : 'Para todas las terminales.');
console.log('Falta: commit de edge-actualizaciones/ y desplegar el servidor.');
