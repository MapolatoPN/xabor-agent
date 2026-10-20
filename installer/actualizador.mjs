// ─── Verificador de actualizaciones de Xabor Edge ───────────────────────────
//
// Este archivo NO se actualiza solo: lo instala el instalador junto con la
// clave pública (clave-publica-actualizaciones.pem) y solo cambia con otro
// instalador. Es la frontera de confianza de la actualización automática.
//
// La regla original del Edge es «nunca se recibe nada ejecutable desde la
// nube» (docs/xabor-edge-arquitectura.md). La actualización automática es
// recibir código, así que la confianza NO está en la nube: está en la firma.
// La nube solo avisa que existe una versión; aquí se acepta únicamente un
// paquete firmado con la clave privada del dueño, que nunca está en el
// servidor ni en el repositorio. Un servidor comprometido puede, como mucho,
// avisar de algo que aquí se rechaza.
//
// Lo que se verifica, en este orden:
//   1. el manifiesto: forma, versión, tamaño y FIRMA Ed25519;
//   2. el paquete: tamaño y SHA-256 exactos del manifiesto, la misma versión,
//      y cada ruta dentro de edge/ (nada de «..», rutas absolutas ni otras
//      extensiones);
//   3. que la versión sea MAYOR que la instalada y que no se haya rechazado
//      antes por fallar al arrancar (sin bajar de versión a escondidas).
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AQUI = dirname(fileURLToPath(import.meta.url));
export const ARCHIVO_CLAVE = 'clave-publica-actualizaciones.pem';
export const MAX_PAQUETE = 5 * 1024 * 1024;
export const MAX_ARCHIVOS = 400;
const VERSION_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;
const RUTA_RE = /^[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-.]+)*\.(js|mjs|json|md)$/;

export function compararVersiones(a, b) {
  const pa = VERSION_RE.exec(String(a)), pb = VERSION_RE.exec(String(b));
  if (!pa || !pb) return NaN;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  return 0;
}

// Lo que se firma. El prefijo evita que una firma hecha para otra cosa sirva
// aquí.
export function textoFirmado({ version, sha256, tamano }) {
  return `xabor-edge-actualizacion\n${version}\n${sha256}\n${tamano}`;
}

export function leerClavePublica(dir = AQUI) {
  const ruta = join(dir, ARCHIVO_CLAVE);
  if (!existsSync(ruta)) return null;
  try { return createPublicKey(readFileSync(ruta, 'utf8')); } catch { return null; }
}

export function verificarManifiesto(m, clave) {
  if (!clave) throw new Error('sin clave pública: la actualización automática está apagada');
  if (!m || typeof m !== 'object') throw new Error('manifiesto inválido');
  if (!VERSION_RE.test(String(m.version))) throw new Error('versión inválida');
  if (!/^[0-9a-f]{64}$/.test(String(m.sha256))) throw new Error('sha256 inválido');
  if (!Number.isInteger(m.tamano) || m.tamano <= 0 || m.tamano > MAX_PAQUETE) throw new Error('tamaño inválido');
  if (typeof m.firma !== 'string' || !m.firma) throw new Error('sin firma');
  const ok = verify(null, Buffer.from(textoFirmado(m), 'utf8'), clave, Buffer.from(m.firma, 'base64'));
  if (!ok) throw new Error('la firma no corresponde a la clave del dueño');
  return { version: m.version, sha256: m.sha256, tamano: m.tamano };
}

export function verificarPaquete(bytes, manifiesto) {
  if (!Buffer.isBuffer(bytes)) throw new Error('paquete inválido');
  if (bytes.length !== manifiesto.tamano) throw new Error('el tamaño del paquete no es el del manifiesto');
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== manifiesto.sha256) throw new Error('el paquete no es el que se firmó');
  let p;
  try { p = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('paquete ilegible'); }
  if (!p || p.version !== manifiesto.version || !p.archivos || typeof p.archivos !== 'object') throw new Error('paquete sin la versión firmada');
  const rutas = Object.keys(p.archivos);
  if (!rutas.length || rutas.length > MAX_ARCHIVOS) throw new Error('cantidad de archivos inválida');
  if (!rutas.includes('index.js')) throw new Error('el paquete no trae index.js');
  for (const r of rutas) {
    if (!RUTA_RE.test(r) || r.split('/').some(s => s === '..' || s === '.')) throw new Error(`ruta no permitida: ${r.slice(0, 60)}`);
    if (typeof p.archivos[r] !== 'string') throw new Error(`contenido inválido: ${r}`);
  }
  return p;
}

// ─── Estado de la actualización (lo comparte con el lanzador) ──────────────
//
//   { pendiente, probando, intentos, desde, rechazadas[] }
//   pendiente: versión ya verificada y escrita en edge.nueva, por aplicar
//   probando:  versión recién aplicada que todavía no se confirmó
export function rutaEstado(raiz) { return join(raiz, 'actualizacion.json'); }
export function leerEstado(raiz) {
  try { return { rechazadas: [], ...JSON.parse(readFileSync(rutaEstado(raiz), 'utf8')) }; }
  catch { return { pendiente: null, probando: null, intentos: 0, desde: null, rechazadas: [] }; }
}
export function escribirEstado(raiz, estado) {
  const tmp = rutaEstado(raiz) + '.tmp';
  writeFileSync(tmp, JSON.stringify(estado, null, 2));
  renameSync(tmp, rutaEstado(raiz));
}

// Deja la versión verificada en edge.nueva. La aplica el lanzador al
// arrancar, nunca este proceso con el Edge corriendo.
export function prepararActualizacion(raiz, paquete, { versionActual } = {}) {
  const estado = leerEstado(raiz);
  if (!(compararVersiones(paquete.version, versionActual) > 0)) throw new Error(`la versión ${paquete.version} no es mayor que la instalada (${versionActual})`);
  if (estado.rechazadas.includes(paquete.version)) throw new Error(`la versión ${paquete.version} ya falló antes en este equipo`);
  const destino = join(raiz, 'edge.nueva');
  rmSync(destino, { recursive: true, force: true });
  const base = resolve(destino) + sep;
  for (const [ruta, b64] of Object.entries(paquete.archivos)) {
    const final = resolve(destino, ruta);
    if (!final.startsWith(base)) throw new Error(`ruta fuera del paquete: ${ruta}`);
    mkdirSync(dirname(final), { recursive: true });
    writeFileSync(final, Buffer.from(b64, 'base64'));
  }
  writeFileSync(join(destino, '.version'), paquete.version);
  escribirEstado(raiz, { ...estado, pendiente: paquete.version });
  return destino;
}

// La versión nueva avisa que arrancó Y se conectó a la nube: hasta entonces
// el lanzador la tiene a prueba.
export function confirmarVersion(raiz, version) {
  const estado = leerEstado(raiz);
  if (estado.probando === version) escribirEstado(raiz, { ...estado, probando: null, intentos: 0, desde: null });
}
