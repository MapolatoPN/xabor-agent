// Actualización automática de Xabor Edge: lo que hace la nube.
//
// La nube no firma nada ni tiene la clave privada. Solo publica lo que el
// dueño ya firmó en su computadora (scripts/edge/firmar-actualizacion.mjs) y
// llegó al repositorio en edge-actualizaciones/:
//
//   vigente.json                 { version, terminales? }
//   edge-<v>.manifiesto.json     { version, sha256, tamano, firma }
//   edge-<v>.json                el paquete: { version, archivos: { ruta: base64 } }
//
// Al autenticarse, cada Edge dice su versión. Si es menor que la vigente, se
// le manda el manifiesto; el Edge comprueba la firma con la clave pública que
// trae su instalador y baja el paquete de GET /edge/actualizaciones/edge-<v>.json.
// Un Edge que no dice su versión (los de la 1.1.0) no recibe nada.
//
// `terminales` es opcional: con una lista, solo esas terminales reciben la
// versión. Sirve para probarla primero en una sola PC.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';

const AQUI = dirname(fileURLToPath(import.meta.url));
const VERSION_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;
const PAQUETE_RE = /^edge-\d{1,4}\.\d{1,4}\.\d{1,4}\.json$/;

export function dirActualizaciones() {
  return resolve(process.env.XABOR_EDGE_ACTUALIZACIONES_DIR || join(AQUI, '../../edge-actualizaciones'));
}

export function compararVersiones(a, b) {
  const pa = VERSION_RE.exec(String(a)), pb = VERSION_RE.exec(String(b));
  if (!pa || !pb) return NaN;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  return 0;
}

// Lo que el Edge dice de sí mismo va a los logs: solo una versión X.Y.Z, y
// el texto libre sin saltos de línea ni caracteres de control.
export function versionDeEdge(v) {
  return typeof v === 'string' && VERSION_RE.test(v) ? v : null;
}
const textoDeLog = (t, max) => String(t).slice(0, max).replace(/[\u0000-\u001f\u007f]/g, ' ');

function leerJson(ruta) {
  try { return JSON.parse(readFileSync(ruta, 'utf8')); } catch { return null; }
}

// El manifiesto que le toca a ese Edge, o null. Se lee del disco en cada
// autenticación (son pocas): lo que llega con un despliegue vale al instante.
export function ofertaParaEdge({ versionEdge, terminalId }, dir = dirActualizaciones()) {
  if (!VERSION_RE.test(String(versionEdge ?? ''))) return null;
  const vigente = leerJson(join(dir, 'vigente.json'));
  if (!vigente || !VERSION_RE.test(String(vigente.version))) return null;
  if (Array.isArray(vigente.terminales) && !vigente.terminales.includes(terminalId)) return null;
  if (!(compararVersiones(vigente.version, versionEdge) > 0)) return null;
  const m = leerJson(join(dir, `edge-${vigente.version}.manifiesto.json`));
  if (!m || m.version !== vigente.version || typeof m.firma !== 'string') return null;
  if (!existsSync(join(dir, `edge-${vigente.version}.json`))) return null;
  return { version: m.version, sha256: m.sha256, tamano: m.tamano, firma: m.firma };
}

// Nunca lanza: ofrecer una actualización no puede estorbar la autenticación
// ni la entrega de comandas.
export function ofrecerActualizacion(ws) {
  try {
    const manifiesto = ofertaParaEdge({ versionEdge: ws.versionEdge, terminalId: ws.terminalId });
    if (!manifiesto || ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ tipo: 'actualizacion_disponible', manifiesto }));
    console.log(`[Edge] actualización ofrecida terminal=${ws.terminalId} de=${ws.versionEdge} a=${manifiesto.version}`);
    return true;
  } catch (e) {
    console.warn(`[Edge] no se pudo ofrecer la actualización a terminal=${ws.terminalId}: ${e.message}`);
    return false;
  }
}

const ESTADOS = new Set(['preparada', 'reiniciando', 'confirmada', 'rechazada', 'error']);

// Lo que el Edge cuenta de su actualización. Solo se registra.
export function registrarEstadoDeActualizacion(ws, msg) {
  const estado = ESTADOS.has(msg.estado) ? msg.estado : 'desconocido';
  const version = versionDeEdge(msg.version) ?? '-';
  const motivo = typeof msg.motivo === 'string' ? ` motivo=${textoDeLog(msg.motivo, 200)}` : '';
  const linea = `[Edge] actualización terminal=${ws.terminalId} version=${version} estado=${estado}${motivo}`;
  if (estado === 'rechazada' || estado === 'error') console.warn(linea); else console.log(linea);
}

// El paquete es el código de edge/, que ya es público: se sirve sin sesión.
// Solo nombres exactos edge-<v>.json; nada de rutas.
export const rutasActualizacionesEdge = Router();
rutasActualizacionesEdge.get('/:archivo', (req, res) => {
  const archivo = req.params.archivo;
  if (!PAQUETE_RE.test(archivo)) return res.status(404).end();
  const ruta = join(dirActualizaciones(), archivo);
  if (!existsSync(ruta)) return res.status(404).end();
  res.set('Cache-Control', 'no-store');
  res.type('application/json');
  res.sendFile(ruta);
});
