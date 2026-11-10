// XECADOR · Cara — el motor que mira las fotos.
//
// Un motor es { id, umbrales, analizar(bytes) }:
//   id         con qué se calcularon los vectores (se guarda con la cara: los
//              de otro motor no se comparan).
//   umbrales   { coincide, misma, registro }: similitud mínima para decir que
//              la checada es de la persona registrada, que dos fotos de la
//              misma checada son de la misma persona y que las fotos de un
//              registro son de la misma persona.
//   analizar   foto (JPEG o WebP) → Promise<{ caras: [{ caja, puntos, vector }]}>
//              (ver caraGeometria.js). Puede lanzar: quien lo llama nunca deja
//              que eso tumbe una checada.
//
// XECADOR_CARA_MOTOR elige el motor. Sin él no hay motor, y la cara no se
// puede encender en ningún negocio (el panel lo dice). Hoy existe:
//
//   'prueba'   SOLO para las suites. No mira la foto: lee lo que la suite
//              escribió en ella (un comentario JPEG «XCARA {…}»). Fuera de
//              las suites no sirve, y en producción (NODE_ENV=production) se
//              niega a arrancar aunque la variable lo pida.
//
// El motor de verdad (YuNet + SFace, modelos abiertos de OpenCV Zoo) llega
// aparte, con sus modelos verificados por su sha256.
import { createHash } from 'node:crypto';
import { normalizar } from './caraGeometria.js';

const DIMENSION_PRUEBA = 128;

// ── Motor de prueba ──────────────────────────────────────────────────────────
// La foto trae un segmento COM («XCARA » + JSON) antes de los datos de imagen:
//   p   persona (de quién es la cara)       g   giro (0 = de frente)
//   o   distancia entre ojos, en pixeles    n   cuántas caras (0, 1 o 2)
//   r   ruido: fotos distintas de la misma persona
//   mezcla [persona, peso]: una cara que se parece a otra
//   falla  el motor lanza (para probar que la checada no se pierde)
// Una foto sin ese segmento no tiene cara.
export const MARCA_PRUEBA = 'XCARA ';

export function leerMarcaPrueba(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const tipo = b[i + 1];
    if (tipo === 0xda || tipo === 0xd9) break;          // empiezan los datos de imagen
    const largo = b.readUInt16BE(i + 2);
    if (largo < 2 || i + 2 + largo > b.length) break;
    if (tipo === 0xfe) {
      const texto = b.subarray(i + 4, i + 2 + largo).toString('utf8');
      if (texto.startsWith(MARCA_PRUEBA)) {
        try { return JSON.parse(texto.slice(MARCA_PRUEBA.length)); } catch { return null; }
      }
    }
    i += 2 + largo;
  }
  return null;
}

/** Un vector fijo por nombre: el de dos nombres distintos casi no se parece. */
function vectorDe(nombre) {
  const out = new Float32Array(DIMENSION_PRUEBA);
  let bloque = Buffer.alloc(0), contador = 0;
  for (let i = 0; i < DIMENSION_PRUEBA; i++) {
    if (bloque.length < 4) bloque = createHash('sha256').update(`${nombre}|${contador++}`).digest();
    out[i] = bloque.readUInt16LE(0) / 65535 + bloque.readUInt16LE(2) / 65535 - 1;
    bloque = bloque.subarray(4);
  }
  return normalizar(out);
}

function caraDePrueba(m, desplazamiento) {
  const o = Number.isFinite(m.o) ? m.o : 60;
  const g = Number.isFinite(m.g) ? m.g : 0;
  const cx = 160 + desplazamiento, cy = 110;
  const v = new Float32Array(DIMENSION_PRUEBA);
  const base = vectorDe(`persona|${m.p ?? 'nadie'}`);
  const [otra, peso] = Array.isArray(m.mezcla) ? m.mezcla : [null, 0];
  const mezcla = otra ? vectorDe(`persona|${otra}`) : null;
  const ruido = vectorDe(`ruido|${m.r ?? 0}`);
  for (let i = 0; i < v.length; i++) v[i] = base[i] * (1 - peso) + (mezcla ? mezcla[i] * peso : 0) + 0.12 * ruido[i];
  return {
    caja: [cx - o, cy - o, 2 * o, 2.4 * o],
    puntos: [[cx - o / 2, cy], [cx + o / 2, cy], [cx + g * o, cy + 0.4 * o],
      [cx - 0.4 * o + 0.5 * g * o, cy + 0.75 * o], [cx + 0.4 * o + 0.5 * g * o, cy + 0.75 * o]],
    vector: normalizar(v),
  };
}

const motorPrueba = {
  id: 'prueba-1',
  umbrales: { coincide: 0.363, misma: 0.30, registro: 0.45 },
  async analizar(bytes) {
    const m = leerMarcaPrueba(bytes);
    if (!m) return { caras: [] };
    if (m.falla) throw new Error('falla simulada del motor de prueba');
    const n = Number.isInteger(m.n) ? m.n : 1;
    const caras = [];
    for (let k = 0; k < n; k++) caras.push(caraDePrueba(k === 0 ? m : { ...m, p: `${m.p}|otra` }, k * 200));
    return { caras };
  },
};

// ── Cuál motor ───────────────────────────────────────────────────────────────
let elegido;   // undefined = aún no se decide

function decidir() {
  const pedido = String(process.env.XECADOR_CARA_MOTOR || '').trim().toLowerCase();
  if (!pedido) return { motor: null, motivo: 'sin_motor' };
  if (pedido === 'prueba') {
    if (process.env.NODE_ENV === 'production') {
      console.error('[Cara] XECADOR_CARA_MOTOR=prueba se ignora en producción: la cara queda sin motor.');
      return { motor: null, motivo: 'prueba_en_produccion' };
    }
    return { motor: motorPrueba, motivo: null };
  }
  console.error(`[Cara] XECADOR_CARA_MOTOR=${pedido} no existe: la cara queda sin motor.`);
  return { motor: null, motivo: 'motor_desconocido' };
}

/** El motor, o null si este servidor no tiene. */
export function obtenerMotor() {
  if (elegido === undefined) elegido = decidir();
  return elegido.motor;
}

/** Para el panel: si hay motor, cuál, y si no, por qué. */
export function estadoMotor() {
  if (elegido === undefined) elegido = decidir();
  return { disponible: !!elegido.motor, modelo: elegido.motor?.id ?? null, motivo: elegido.motivo };
}
