// ─── Maquetador: texto + estilo → renglones que caben en el papel ───────────
//
// El servidor arma el papel completo y el Edge solo lo traduce a bytes (ver
// edge/renderers/formato.js). Así, cambiar el diseño de una comanda o de un
// ticket es un despliegue del servidor o un ajuste en el panel, nunca una
// visita a la PC del restaurante.
//
// Un renglón del documento v1 es uno de estos objetos:
//
//   { texto, tam, negrita, alinear, invertido, subrayado, aire }
//        texto ya envuelto: NUNCA se pasa del papel con su tamaño y su aire
//   { linea: '=' }        separador de ancho completo
//   { espacio: n }        n renglones en blanco
//   { qr: { size, data } } QR como matriz (la misma forma que autofacturaQr)
//   { corte: true }       corte de papel
//
// Las medidas son las de la fuente A de una térmica: 12 puntos por letra.
// `tam`: normal (1×1), alto (1×2), ancho (2×1), doble (2×2). `aire`: puntos
// extra a la derecha de cada letra (ESC SP), que en letra ancha se duplican.
// Solo se escriben las propiedades que no son las de por omisión, para que el
// trabajo pese poco en la cola.
import { textoTermico } from '../../../edge/renderers/escpos.js';

export const PUNTOS_POR_COLUMNA = 12;
export const TAMANOS = {
  normal: { ancho: 1, alto: 1 },
  alto: { ancho: 1, alto: 2 },
  ancho: { ancho: 2, alto: 1 },
  doble: { ancho: 2, alto: 2 },
};
export const ALINEACIONES = ['izq', 'centro', 'der'];
export const AIRE_MAXIMO = 4;

// Letras que caben en un renglón con ese tamaño y ese aire.
export function columnasDisponibles(ancho, { tam = 'normal', aire = 0 } = {}) {
  const t = TAMANOS[tam] || TAMANOS.normal;
  const a = Math.max(0, Math.min(AIRE_MAXIMO, Number(aire) || 0));
  return Math.max(1, Math.floor((Number(ancho) * PUNTOS_POR_COLUMNA) / (t.ancho * (PUNTOS_POR_COLUMNA + a))));
}

// Puntos que ocupa un renglón ya armado. Lo usan las pruebas y el Edge como
// última defensa: ningún renglón puede pasar de ancho × 12.
export function puntosDeRenglon(r) {
  const t = TAMANOS[r.tam] || TAMANOS.normal;
  return String(r.texto ?? '').length * t.ancho * (PUNTOS_POR_COLUMNA + (Number(r.aire) || 0));
}

// Corta por palabras; una palabra más larga que el renglón se parte (no hay
// otra forma de que quepa). Junta los espacios repetidos.
export function envolver(str, columnas, sangria = '') {
  const cols = Math.max(1, columnas);
  const palabras = String(str ?? '').split(/\s+/).filter(Boolean);
  const lineas = [];
  let actual = '';
  for (const palabra of palabras) {
    const base = actual ? `${actual} ` : sangria;
    if ((base + palabra).length <= cols) { actual = base + palabra; continue; }
    if (actual) lineas.push(actual);
    let resto = palabra;
    const espacio = Math.max(1, cols - sangria.length);
    while (resto.length > espacio) { lineas.push(sangria + resto.slice(0, espacio)); resto = resto.slice(espacio); }
    actual = sangria + resto;
  }
  if (actual.trim()) lineas.push(actual);
  return lineas;
}

// El estilo, limpio: lo desconocido cae al valor seguro.
export function estiloLimpio(estilo = {}) {
  const e = {};
  if (TAMANOS[estilo.tam] && estilo.tam !== 'normal') e.tam = estilo.tam;
  if (estilo.negrita === true) e.negrita = true;
  if (ALINEACIONES.includes(estilo.alinear) && estilo.alinear !== 'izq') e.alinear = estilo.alinear;
  if (estilo.invertido === true) e.invertido = true;
  if (estilo.subrayado === true) e.subrayado = true;
  const aire = Math.max(0, Math.min(AIRE_MAXIMO, Math.round(Number(estilo.aire) || 0)));
  if (aire) e.aire = aire;
  return e;
}

// Un párrafo: uno o varios renglones con el mismo estilo, cada uno dentro del
// papel. El texto se sanea ANTES de medir, igual que en el Edge.
export function parrafo(texto, estilo, ancho, { sangria = '' } = {}) {
  const e = estiloLimpio(estilo);
  const cols = columnasDisponibles(ancho, e);
  return envolver(textoTermico(texto), cols, sangria).map(t => ({ texto: t, ...e }));
}

// Dos textos en un renglón, el segundo pegado a la derecha (precio, total).
// Si no caben juntos, el de la izquierda se recorta: el importe nunca.
export function filaColumnas(izq, der, estilo, ancho) {
  const e = estiloLimpio(estilo);
  const cols = columnasDisponibles(ancho, e);
  const d = textoTermico(der).slice(0, cols);
  const i = textoTermico(izq).slice(0, Math.max(0, cols - d.length - 1));
  return { texto: i + ' '.repeat(Math.max(1, cols - i.length - d.length)) + d, ...e };
}

export const linea = (car = '=') => ({ linea: car === '-' ? '-' : '=' });
export const espacio = (n = 1) => ({ espacio: Math.max(1, Math.min(10, Math.round(n) || 1)) });
export const corte = () => ({ corte: true });
