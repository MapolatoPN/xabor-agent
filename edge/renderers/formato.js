// ─── Intérprete del documento de impresión v1 ───────────────────────────────
//
// Desde esta versión del Edge, el servidor arma el papel completo (ver
// src/printing/formato/) y aquí solo se traduce a ESC/POS. Este archivo NO
// decide nada del diseño: tamaños, negritas, sangrías y textos llegan hechos.
// Por eso un cambio de diseño (o lo que un negocio configure en el panel) ya
// no exige actualizar la PC del restaurante.
//
// Lo que SÍ es responsabilidad de este lado, porque es del hardware:
//   * la tabla de caracteres (INIT elige WPC1252) y el saneado del texto:
//     nada de lo que llegue puede convertirse en un comando de la impresora;
//   * la última defensa del ancho: si un renglón no cupiera en ESTA
//     impresora (tamaño y aire incluidos), se vuelve a envolver aquí;
//   * dejar la impresora en estado normal después de cada renglón.
import {
  INIT, ALIGN_LEFT, ALIGN_CENTER, ALIGN_RIGHT, BOLD_ON, BOLD_OFF, SIZE_NORMAL, CUT,
  lf, linea, textoTermico, envolver, espacioLetras, imagenQr, PUNTOS_POR_COLUMNA,
} from './escpos.js';

const ESC = 0x1b;
const GS = 0x1d;
const b = (...bytes) => Buffer.from(bytes);

export const VERSION_FORMATO = 1;
const MAX_RENGLONES = 1500;
const TAMANOS = { normal: [0x00, 1], alto: [0x01, 1], ancho: [0x10, 2], doble: [0x11, 2] };
const ALINEAR = { izq: ALIGN_LEFT, centro: ALIGN_CENTER, der: ALIGN_RIGHT };
const INVERTIDO = (si) => b(GS, 0x42, si ? 1 : 0);
const SUBRAYADO = (si) => b(ESC, 0x2d, si ? 1 : 0);
const NORMAL = Buffer.concat([ALIGN_LEFT, SIZE_NORMAL, BOLD_OFF, INVERTIDO(false), SUBRAYADO(false), espacioLetras(0)]);

export function esFormatoValido(f) {
  return !!f && typeof f === 'object' && f.v === VERSION_FORMATO
    && Array.isArray(f.renglones) && f.renglones.length > 0 && f.renglones.length <= MAX_RENGLONES;
}

const entero = (v, min, max, porOmision) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : porOmision;
};

function texto(r, ancho) {
  const [codigo, factor] = TAMANOS[r.tam] || TAMANOS.normal;
  const aire = entero(r.aire, 0, 4, 0);
  const cols = Math.max(1, Math.floor((ancho * PUNTOS_POR_COLUMNA) / (factor * (PUNTOS_POR_COLUMNA + aire))));
  const limpio = textoTermico(r.texto);
  const lineas = limpio.length <= cols ? [limpio] : envolver(limpio, cols);
  return Buffer.concat([
    ALINEAR[r.alinear] || ALIGN_LEFT, b(GS, 0x21, codigo), r.negrita ? BOLD_ON : BOLD_OFF,
    INVERTIDO(r.invertido === true), SUBRAYADO(r.subrayado === true), espacioLetras(aire),
    ...lineas.map(l => Buffer.from(`${l}\n`, 'latin1')),
    NORMAL,
  ]);
}

export function interpretarFormato(f, { ancho = 42 } = {}) {
  const cols = entero(ancho, 20, 96, 42);
  const partes = [INIT];
  for (const r of f.renglones) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.texto === 'string') partes.push(texto(r, cols));
    else if (r.linea) partes.push(NORMAL, linea(r.linea === '-' ? '-' : '=', cols));
    else if (r.espacio) partes.push(lf(entero(r.espacio, 1, 10, 1)));
    else if (r.qr) {
      const img = imagenQr(r.qr, { modulo: cols <= 32 ? 3 : 4, margen: 4 });
      if (img) partes.push(ALIGN_CENTER, img, ALIGN_LEFT);
    } else if (r.corte) partes.push(CUT);
  }
  return Buffer.concat(partes);
}
