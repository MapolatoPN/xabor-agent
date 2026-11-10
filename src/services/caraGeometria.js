// XECADOR · Cara — lo que no depende del motor (sin base, sin red, sin modelos).
//
// Un motor (caraMotor.js) mira una foto y devuelve las caras que ve. Cada una
// trae su caja [x, y, ancho, alto], sus 5 puntos en la imagen (los dos ojos,
// la nariz y las dos comisuras de la boca, en ese orden) y su vector: unos
// números que resumen la cara. Dos fotos de la misma persona dan vectores
// parecidos (similitud coseno alta). Aquí se decide todo lo demás:
//
//   · Cuál es la cara de la foto: la más grande. Si hay otra casi del mismo
//     tamaño, la foto no sirve («varias caras»): no se sabe de quién es.
//   · Hacia dónde mira: el giro es cuánto se corre la nariz respecto al punto
//     medio de los ojos, medido sobre la línea de los ojos y en distancias
//     entre ojos. De frente es casi 0; con la cabeza un poco girada sube.
//   · Que la cabeza se movió: en una cara de verdad, al girar, la nariz se
//     corre. En una foto impresa que se inclina, no: la nariz y los ojos se
//     aprietan juntos y el giro no cambia. Por eso se piden fotos de frente y
//     con un pequeño giro.
//
// Los umbrales de similitud son del modelo (los trae el motor); los del giro
// son de la geometría de una cara y valen para cualquier motor.

/** De frente: el giro de la foto más de frente no pasa de esto (~15°). */
export const FRENTE_MAX = 0.10;
/** Lo que la cabeza debe girar entre la foto de frente y otra (~12°). */
export const GIRO_MIN = 0.08;
/** Una cara con los ojos a menos de esto (en pixeles) está muy lejos o es muy chica. */
export const OJOS_MIN_PX = 24;
/** Otra cara con al menos esta fracción del área de la principal: «varias caras». */
export const OTRA_CARA_FRACCION = 0.5;

export function normalizar(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  const out = new Float32Array(v.length);
  if (!(n > 0)) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** Similitud coseno entre dos vectores (de -1 a 1). Vectores de distinto largo: no se comparan. */
export function similitud(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return -1;
  let p = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { p += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!(na > 0) || !(nb > 0)) return -1;
  return Math.max(-1, Math.min(1, p / Math.sqrt(na * nb)));
}

/** La mejor similitud contra las fotos del registro. */
export function mejorSimilitud(vector, registro) {
  let mejor = -1;
  for (const r of registro || []) mejor = Math.max(mejor, similitud(vector, r));
  return mejor;
}

const punto = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

/** Distancia entre los ojos, en pixeles. */
export function distanciaOjos(puntos) {
  if (!Array.isArray(puntos) || puntos.length < 3 || !puntos.slice(0, 3).every(punto)) return 0;
  return Math.hypot(puntos[1][0] - puntos[0][0], puntos[1][1] - puntos[0][1]);
}

/** El giro horizontal de la cara (ver arriba), o null si los puntos no sirven. */
export function giro(puntos) {
  const d = distanciaOjos(puntos);
  if (!(d > 0)) return null;
  const [a, b, nariz] = puntos;
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  return ((nariz[0] - mx) * ex + (nariz[1] - my) * ey) / (d * d);
}

const area = (c) => (Array.isArray(c?.caja) && c.caja.length === 4 ? Math.max(0, c.caja[2]) * Math.max(0, c.caja[3]) : 0);

/**
 * La cara de una foto: { cara: { vector, giro, ojos } } o { error }.
 * error: 'sin_cara' (ninguna, o muy chica) o 'varias_caras'.
 */
export function elegirCara(caras) {
  const lista = (Array.isArray(caras) ? caras : []).filter((c) => c && c.vector && c.vector.length && area(c) > 0);
  if (!lista.length) return { error: 'sin_cara' };
  lista.sort((x, y) => area(y) - area(x));
  if (lista.length > 1 && area(lista[1]) >= OTRA_CARA_FRACCION * area(lista[0])) return { error: 'varias_caras' };
  const c = lista[0];
  const g = giro(c.puntos);
  const ojos = distanciaOjos(c.puntos);
  if (g === null || ojos < OJOS_MIN_PX) return { error: 'sin_cara' };
  return { cara: { vector: c.vector, giro: g, ojos } };
}

const redondear = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);

/**
 * Una checada: las fotos que tomó la tablet contra la cara registrada.
 *   analisis   lo que vio el motor en cada foto, en orden: [{ caras }]
 *   registro   los vectores de la cara registrada
 *   umbrales   { coincide, misma } del motor
 * Devuelve { cara, detalle, similitud, frente } — frente es el índice de la
 * foto de frente (la que se guarda con la checada), o null.
 */
export function evaluarChecada({ analisis, registro, umbrales }) {
  const fotos = Array.isArray(analisis) ? analisis : [];
  if (!fotos.length) return { cara: 'no_verificada', detalle: 'sin_camara', similitud: null, frente: null };
  const vistas = fotos.map((a, i) => ({ i, ...elegirCara(a?.caras) }));
  const buenas = vistas.filter((v) => v.cara);
  if (!buenas.length) {
    const detalle = vistas.some((v) => v.error === 'varias_caras') ? 'varias_caras' : 'sin_cara';
    return { cara: 'no_verificada', detalle, similitud: null, frente: null };
  }
  const frente = buenas.reduce((m, v) => (Math.abs(v.cara.giro) < Math.abs(m.cara.giro) ? v : m));
  const s = mejorSimilitud(frente.cara.vector, registro);
  const sim = redondear(s);
  if (Math.abs(frente.cara.giro) > FRENTE_MAX) return { cara: 'no_verificada', detalle: 'de_lado', similitud: sim, frente: frente.i };
  if (!(s >= umbrales.coincide)) return { cara: 'no_coincide', detalle: null, similitud: sim, frente: frente.i };
  // La cabeza se movió, y la que se movió es la misma persona de la foto de frente.
  const giroBueno = buenas.some((v) => v !== frente
    && Math.abs(v.cara.giro - frente.cara.giro) >= GIRO_MIN
    && similitud(v.cara.vector, frente.cara.vector) >= umbrales.misma);
  if (!giroBueno) return { cara: 'no_verificada', detalle: 'sin_giro', similitud: sim, frente: frente.i };
  return { cara: 'coincide', detalle: null, similitud: sim, frente: frente.i };
}

/**
 * El registro de una cara: varias fotos de frente de la misma persona.
 *   analisis  lo que vio el motor en cada foto, en orden: [{ caras }]
 *   minimo    cuántas fotos buenas hacen falta
 *   umbrales  { registro } del motor: lo mínimo que se parecen entre sí
 * Devuelve { vectores, referencia, muestras } o { error, conteo }.
 *   error: 'POCAS_FOTOS' (conteo dice qué pasó con las demás) o 'NO_SON_LA_MISMA'.
 */
export function evaluarRegistro({ analisis, minimo, umbrales }) {
  const conteo = { buenas: 0, sin_cara: 0, varias_caras: 0, de_lado: 0 };
  const buenas = [];
  (Array.isArray(analisis) ? analisis : []).forEach((a, i) => {
    const v = elegirCara(a?.caras);
    if (v.error) { conteo[v.error] += 1; return; }
    if (Math.abs(v.cara.giro) > FRENTE_MAX) { conteo.de_lado += 1; return; }
    buenas.push({ i, ...v.cara });
  });
  conteo.buenas = buenas.length;
  if (buenas.length < minimo) return { error: 'POCAS_FOTOS', conteo };
  for (let x = 0; x < buenas.length; x++) {
    for (let y = x + 1; y < buenas.length; y++) {
      if (!(similitud(buenas[x].vector, buenas[y].vector) >= umbrales.registro)) return { error: 'NO_SON_LA_MISMA', conteo };
    }
  }
  // La de referencia: la más de frente; a la par, la más cercana.
  const ref = buenas.reduce((m, v) => {
    const dm = Math.abs(m.giro), dv = Math.abs(v.giro);
    return dv < dm - 0.02 || (Math.abs(dv - dm) <= 0.02 && v.ojos > m.ojos) ? v : m;
  });
  return { vectores: buenas.map((v) => v.vector), referencia: ref.i, muestras: buenas.length };
}
