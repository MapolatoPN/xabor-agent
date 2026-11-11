// XECADOR · Cara — el motor de verdad (XECADOR_CARA_MOTOR=yunet-sface).
//
// YuNet encuentra las caras y sus 5 puntos; SFace resume cada cara en 128
// números. Son modelos abiertos de OpenCV Zoo (YuNet: MIT; SFace: Apache 2.0)
// y corren aquí, en el servidor, con onnxruntime-node: las fotos no salen a
// ningún servicio de fuera. Origen, licencias y huellas: modelos/cara/.
//
// Los modelos viven en modelos/cara/ (o en la carpeta de XECADOR_CARA_MODELOS)
// y se comprueban por su sha256 antes de usarse: con un archivo distinto no hay
// motor. Se cargan la primera vez que hacen falta, no al arrancar el servidor.
//
// Con cada foto hace lo mismo que OpenCV (FaceDetectorYN y FaceRecognizerSF):
//   1. La decodifica (JPEG o WebP), con la orientación que dice la cámara.
//   2. Si no cabe en 640×640 la reduce; rellena de negro abajo y a la derecha,
//      y YuNet busca caras (puntuación ≥ 0.9; de las que se enciman queda una).
//   3. A las dos caras más grandes (con eso basta para saber si hay «varias
//      caras») las endereza con sus 5 puntos a la plantilla de 112×112 de
//      SFace y les saca su vector.
// Lo demás (cuál es la cara, el giro, si coincide) lo decide caraGeometria.js,
// igual para este motor que para el de prueba.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizar } from './caraGeometria.js';

export const ID_MOTOR_REAL = 'yunet-2023mar-sface-2021dec';
export const MODELOS = {
  detector: { archivo: 'face_detection_yunet_2023mar.onnx', bytes: 232589,
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4' },
  comparador: { archivo: 'face_recognition_sface_2021dec.onnx', bytes: 38696353,
    sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79' },
};
/** SFace: dos caras con al menos esta similitud son de la misma persona (el umbral que publica OpenCV). */
export const UMBRALES_REAL = { coincide: 0.363, misma: 0.363, registro: 0.45 };

export const ENTRADA = 640;          // YuNet recibe 640×640
export const PUNTUACION_MIN = 0.9;   // el de OpenCV
export const ENCIMADAS_IOU = 0.3;    // el de OpenCV
const PASOS = [8, 16, 32];
const MAX_CARAS = 2;
const PIXELES_MAX = 4096 * 4096;
const A_LA_VEZ = 2;                  // fotos que se revisan al mismo tiempo
/** SFace: dónde quedan los 5 puntos en la cara enderezada de 112×112. */
export const PLANTILLA = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
export const LADO = 112;

const DIR_DEFECTO = fileURLToPath(new URL('../../modelos/cara/', import.meta.url));
export const carpetaModelos = () => process.env.XECADOR_CARA_MODELOS || DIR_DEFECTO;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const esElVerificado = (m, bytes) => bytes.length === m.bytes && sha256(bytes) === m.sha256;

// ── Lo que sale de YuNet ─────────────────────────────────────────────────────
/**
 * Las caras que vio YuNet, en coordenadas de su entrada, antes de quitar las
 * que se enciman. Igual que FaceDetectorYN::postProcess de OpenCV.
 *   salidas  { cls_8, obj_8, bbox_8, kps_8, …_16, …_32 }: los datos de cada salida
 * Devuelve [{ caja: [x, y, ancho, alto], puntos: [[x, y] × 5], puntuacion }].
 */
export function decodificarYunet(salidas, { lado = ENTRADA, umbral = PUNTUACION_MIN } = {}) {
  const caras = [];
  for (const paso of PASOS) {
    const cls = salidas[`cls_${paso}`], obj = salidas[`obj_${paso}`];
    const bbox = salidas[`bbox_${paso}`], kps = salidas[`kps_${paso}`];
    const columnas = Math.floor(lado / paso), filas = Math.floor(lado / paso);
    for (let r = 0; r < filas; r++) {
      for (let c = 0; c < columnas; c++) {
        const i = r * columnas + c;
        const puntuacion = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
        if (!(puntuacion >= umbral)) continue;
        const cx = (c + bbox[i * 4]) * paso, cy = (r + bbox[i * 4 + 1]) * paso;
        const w = Math.exp(bbox[i * 4 + 2]) * paso, h = Math.exp(bbox[i * 4 + 3]) * paso;
        const puntos = [];
        for (let n = 0; n < 5; n++) puntos.push([(kps[i * 10 + 2 * n] + c) * paso, (kps[i * 10 + 2 * n + 1] + r) * paso]);
        caras.push({ caja: [cx - w / 2, cy - h / 2, w, h], puntos, puntuacion });
      }
    }
  }
  return caras;
}

function traslape(a, b) {
  const [ax, ay, aw, ah] = a.caja, [bx, by, bw, bh] = b.caja;
  const ancho = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
  const alto = Math.min(ay + ah, by + bh) - Math.max(ay, by);
  const comun = Math.max(0, ancho) * Math.max(0, alto);
  const union = aw * ah + bw * bh - comun;
  return union > 0 ? comun / union : 0;
}

/** De las caras que se enciman (la misma cara vista varias veces) queda la de mejor puntuación. */
export function quitarEncimadas(caras, umbral = ENCIMADAS_IOU) {
  const quedan = [];
  for (const c of [...caras].sort((a, b) => b.puntuacion - a.puntuacion)) {
    if (quedan.every((q) => traslape(q, c) <= umbral)) quedan.push(c);
  }
  return quedan;
}

// ── Enderezar la cara para SFace ─────────────────────────────────────────────
/**
 * El giro + escala + traslado que lleva los 5 puntos a la plantilla, por
 * mínimos cuadrados: u = a·x − b·y + tx, v = b·x + a·y + ty. null si los
 * puntos no sirven (todos en el mismo lugar).
 */
export function aPlantilla(puntos, destino = PLANTILLA) {
  const n = destino.length;
  let zx = 0, zy = 0, wx = 0, wy = 0;
  for (let i = 0; i < n; i++) { zx += puntos[i][0]; zy += puntos[i][1]; wx += destino[i][0]; wy += destino[i][1]; }
  zx /= n; zy /= n; wx /= n; wy /= n;
  let re = 0, im = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const sx = puntos[i][0] - zx, sy = puntos[i][1] - zy, dx = destino[i][0] - wx, dy = destino[i][1] - wy;
    re += dx * sx + dy * sy; im += dy * sx - dx * sy; den += sx * sx + sy * sy;
  }
  if (!(den > 0)) return null;
  const a = re / den, b = im / den;
  return { a, b, tx: wx - (a * zx - b * zy), ty: wy - (b * zx + a * zy) };
}

/**
 * La cara enderezada de 112×112 que recibe SFace: RGB por planos, de 0 a 255,
 * con interpolación lineal y negro fuera de la foto (como warpAffine).
 *   rgb  la foto: ancho × alto × 3 bytes
 */
export function enderezar(rgb, ancho, alto, t) {
  const plano = LADO * LADO, out = new Float32Array(3 * plano);
  const m2 = t.a * t.a + t.b * t.b;
  const px = (x, y, k) => (x >= 0 && y >= 0 && x < ancho && y < alto ? rgb[(y * ancho + x) * 3 + k] : 0);
  for (let v = 0; v < LADO; v++) {
    for (let u = 0; u < LADO; u++) {
      const p = u - t.tx, q = v - t.ty;
      const x = (p * t.a + q * t.b) / m2, y = (q * t.a - p * t.b) / m2;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      for (let k = 0; k < 3; k++) {
        out[k * plano + v * LADO + u] = (1 - fy) * ((1 - fx) * px(x0, y0, k) + fx * px(x0 + 1, y0, k))
          + fy * ((1 - fx) * px(x0, y0 + 1, k) + fx * px(x0 + 1, y0 + 1, k));
      }
    }
  }
  return out;
}

/**
 * Las caras de la foto, en sus coordenadas: lo que vio YuNet en la foto
 * reducida (anchoChica × altoChica) llevado a la original (ancho × alto), sin
 * las encimadas y solo las MAX_CARAS más grandes, de mayor a menor.
 */
export function carasEnLaFoto(salidas, { ancho, alto, anchoChica, altoChica }) {
  const fx = anchoChica / ancho, fy = altoChica / alto;
  return quitarEncimadas(decodificarYunet(salidas))
    .map((c) => ({
      caja: [c.caja[0] / fx, c.caja[1] / fy, c.caja[2] / fx, c.caja[3] / fy],
      puntos: c.puntos.map(([x, y]) => [x / fx, y / fy]),
      puntuacion: c.puntuacion,
    }))
    .sort((a, b) => b.caja[2] * b.caja[3] - a.caja[2] * a.caja[3])
    .slice(0, MAX_CARAS);
}

/** La entrada de YuNet: la foto (ya reducida) arriba a la izquierda, BGR por planos, de 0 a 255; el resto negro. */
export function entradaDetector(rgb, ancho, alto) {
  const plano = ENTRADA * ENTRADA, x = new Float32Array(3 * plano);
  for (let y = 0; y < alto; y++) {
    for (let c = 0; c < ancho; c++) {
      const o = (y * ancho + c) * 3, p = y * ENTRADA + c;
      x[p] = rgb[o + 2]; x[plano + p] = rgb[o + 1]; x[2 * plano + p] = rgb[o];
    }
  }
  return x;
}

// ── Carga y turno ────────────────────────────────────────────────────────────
let carga = null;
function cargar() {
  if (!carga) {
    carga = (async () => {
      const ort = await import('onnxruntime-node');
      const { default: sharp } = await import('sharp');
      ort.env.logLevel = 'error';
      const opciones = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: 1, interOpNumThreads: 1, logSeverityLevel: 3 };
      const sesiones = {};
      for (const [nombre, m] of Object.entries(MODELOS)) {
        // Se carga desde los mismos bytes que se verifican.
        const bytes = await readFile(join(carpetaModelos(), m.archivo));
        if (!esElVerificado(m, bytes)) throw new Error(`el modelo ${m.archivo} no es el verificado`);
        sesiones[nombre] = await ort.InferenceSession.create(bytes, opciones);
      }
      return { ort, sharp, ...sesiones };
    })().catch((err) => { carga = null; throw err; });
  }
  return carga;
}

// A lo más A_LA_VEZ fotos en el motor; las demás esperan su turno (quien
// termina le pasa su lugar a la siguiente).
let enCurso = 0;
const fila = [];
export const enElMotor = () => enCurso;
async function turno(fn) {
  if (enCurso < A_LA_VEZ) enCurso += 1;
  else await new Promise((listo) => fila.push(listo));
  try { return await fn(); } finally {
    const siguiente = fila.shift();
    if (siguiente) siguiente(); else enCurso -= 1;
  }
}

async function analizar(bytes) {
  const m = await cargar();
  return turno(async () => {
    const { data: rgb, info } = await m.sharp(bytes, { limitInputPixels: PIXELES_MAX })
      .rotate().toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 3) throw new Error(`la foto trae ${info.channels} canales`);
    const W = info.width, H = info.height;
    const s = Math.min(1, ENTRADA / W, ENTRADA / H);
    const rw = Math.max(1, Math.round(W * s)), rh = Math.max(1, Math.round(H * s));
    const chica = s === 1 ? rgb
      : await m.sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).resize(rw, rh, { fit: 'fill' }).raw().toBuffer();
    const entrada = new m.ort.Tensor('float32', entradaDetector(chica, rw, rh), [1, 3, ENTRADA, ENTRADA]);
    const salidas = await m.detector.run({ [m.detector.inputNames[0]]: entrada });
    const caras = carasEnLaFoto(Object.fromEntries(Object.entries(salidas).map(([k, v]) => [k, v.data])),
      { ancho: W, alto: H, anchoChica: rw, altoChica: rh });
    for (const c of caras) {
      const t = aPlantilla(c.puntos);
      // Sin transformación posible, un vector que no se parece a nada (pero
      // la cara cuenta para «varias caras»).
      if (!t) { c.vector = new Float32Array(128); continue; }
      const x = new m.ort.Tensor('float32', enderezar(rgb, W, H, t), [1, 3, LADO, LADO]);
      const r = await m.comparador.run({ [m.comparador.inputNames[0]]: x });
      c.vector = normalizar(r[m.comparador.outputNames[0]].data);
    }
    return { caras };
  });
}

const motorReal = { id: ID_MOTOR_REAL, umbrales: UMBRALES_REAL, analizar };

/**
 * ¿Este servidor puede usar el motor real? Sin onnxruntime-node instalado,
 * sin los modelos o con un modelo distinto del verificado, no: { motivo }.
 * Lee y verifica los modelos (una vez por proceso, lo llama caraMotor.js).
 */
export function prepararMotorReal() {
  try { createRequire(import.meta.url).resolve('onnxruntime-node'); } catch { return { motor: null, motivo: 'sin_runtime' }; }
  for (const m of Object.values(MODELOS)) {
    let bytes;
    try { bytes = readFileSync(join(carpetaModelos(), m.archivo)); } catch { return { motor: null, motivo: 'sin_modelos' }; }
    if (!esElVerificado(m, bytes)) return { motor: null, motivo: 'modelo_no_verificado' };
  }
  return { motor: motorReal, motivo: null };
}
