// Utilidades ESC/POS y de texto.
//
// Los códigos vienen del `print-agent.js` que ya imprime en Mapolato: son
// los mismos bytes que ya funcionaron contra hardware real, no una versión
// nueva inventada esta noche. Lo que cambia es que ahora el ancho es un
// parámetro por impresora (42 columnas ≈ 80 mm, 32 ≈ 58 mm) en vez de una
// variable global del proceso.
//
// Nada aquí es específico de una marca: solo el subconjunto ESC/POS que
// entienden prácticamente todas las térmicas. Si un modelo concreto necesita
// algo especial, va en `impresoras.config`, no aquí.
const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

const b = (...bytes) => Buffer.from(bytes);

// ESC @ deja la impresora en su tabla de caracteres de fábrica, y la de la
// EC Line de Mapolato es PC437 (EE. UU.), no latin1. Mandábamos latin1, así
// que cada acento caía en otro símbolo: «Proteína» salía «Proteφna»,
// «Clásico» «Clßsico», «JAMÓN» «JAM╙N» (comanda del 20-oct-2026). ESC t 16
// elige WPC1252, que en acentos, ñ, ¿, ¡ y · coincide byte por byte con
// latin1: los mismos bytes que ya se mandan. Va después de ESC @, que la
// reinicia. Una térmica que no conozca la tabla 16 la ignora y se queda como
// estaba; la prueba de impresora imprime un renglón de acentos para verlo.
export const TABLA_WPC1252 = b(ESC, 0x74, 16);
export const INIT = Buffer.concat([b(ESC, 0x40), TABLA_WPC1252]);
export const ALIGN_CENTER = b(ESC, 0x61, 1);
export const ALIGN_LEFT = b(ESC, 0x61, 0);
export const ALIGN_RIGHT = b(ESC, 0x61, 2);
export const BOLD_ON = b(ESC, 0x45, 1);
export const BOLD_OFF = b(ESC, 0x45, 0);
export const SIZE_NORMAL = b(GS, 0x21, 0x00);
export const SIZE_2H = b(GS, 0x21, 0x01);
export const SIZE_2X = b(GS, 0x21, 0x11);
export const CUT = b(GS, 0x56, 0x41, 0x03);

export const lf = (n = 1) => Buffer.alloc(n, LF);

export function linea(char = '-', ancho = 42) {
  return Buffer.from(char.repeat(ancho) + '\n', 'latin1');
}

// Todo texto pasa por aquí antes de convertirse en bytes. `Buffer.from(s,
// 'latin1')` no descarta lo que no es latin1: se queda con el byte bajo de
// cada carácter. Así, la raya de «Orden 1 — Ana» (U+2014) llegaba a la
// impresora como 0x14 (DC4), las comillas tipográficas “ ” como 0x1C/0x1D
// (FS/GS, que la térmica toma como inicio de un comando) y un emoji como dos
// bytes sueltos. El nombre de la persona y las notas los teclea el mesero:
// puede llegar cualquier cosa.
//
// Es la misma regla que `textoTermico` de src/services/precuentaDivision.js
// (el Edge se instala solo y no puede importar de src/), con dos diferencias:
// no recorta ni junta espacios, porque aquí llegan renglones ya alineados por
// `columnas`, y recompone los acentos que algunos teclados mandan
// descompuestos («e» + acento) para no perderlos.
export function textoTermico(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c-\u201f]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[\t\n\v\f\r]/g, ' ')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '');
}

export function texto(s) {
  // latin1 porque INIT elige la tabla WPC1252, que coincide con latin1 en
  // todo lo que se imprime en español.
  return Buffer.from(`${textoTermico(s)}\n`, 'latin1');
}

export function columnas(izq, der, ancho = 42) {
  // Saneado ANTES de medir: si no, un emoji contaría dos columnas y unos
  // puntos suspensivos una, y el importe dejaría de caer en el borde.
  const i = textoTermico(izq);
  const d = textoTermico(der);
  const espacios = Math.max(1, ancho - i.length - d.length);
  return Buffer.from(`${i}${' '.repeat(espacios)}${d}\n`, 'latin1');
}

// Corta las palabras solo cuando una sola palabra no cabe. Un nombre de
// platillo partido a la mitad es ilegible en cocina.
export function envolver(str, ancho = 42, sangria = '') {
  const palabras = String(str ?? '').split(/\s+/).filter(Boolean);
  const lineas = [];
  let actual = sangria;
  for (const palabra of palabras) {
    if (actual.trim() === '' && palabra.length > ancho) {
      // Palabra sola más larga que el papel: se parte, no hay alternativa.
      let resto = palabra;
      while (resto.length > ancho) { lineas.push(resto.slice(0, ancho)); resto = resto.slice(ancho); }
      actual = sangria + resto;
      continue;
    }
    const candidata = actual.trim() === '' ? sangria + palabra : `${actual} ${palabra}`;
    if (candidata.length > ancho) { lineas.push(actual); actual = sangria + palabra; }
    else actual = candidata;
  }
  if (actual.trim()) lineas.push(actual);
  return lineas;
}

export function bloque(str, ancho = 42, sangria = '') {
  // Se sanea antes de envolver, por la misma razón que en `columnas`.
  return Buffer.concat(envolver(textoTermico(str), ancho, sangria).map(l => texto(l)));
}

// Encabezado común: título en grande y centrado, y una línea doble debajo.
export function encabezado(titulo, ancho) {
  return Buffer.concat([
    ALIGN_CENTER, SIZE_2H, BOLD_ON, texto(titulo), BOLD_OFF, SIZE_NORMAL,
    ALIGN_LEFT, linea('=', ancho),
  ]);
}

export function pie(ancho) {
  return Buffer.concat([linea('=', ancho), lf(3), CUT]);
}

// Convierte una matriz QR en una imagen monocroma ESC/POS. Se usa raster y
// no el comando nativo de QR: funciona también en térmicas antiguas que no
// implementan GS ( k. La matriz viene del servidor y nunca se consulta una
// URL externa desde el Edge.
export function imagenQr(qr, { modulo = 4, margen = 4 } = {}) {
  const size = Number(qr?.size);
  const data = qr?.data;
  if (!Number.isInteger(size) || size < 21 || size > 177 || !Array.isArray(data) || data.length !== size * size) return null;
  const moduleSize = Math.max(1, Math.min(8, Number(modulo) || 4));
  const quiet = Math.max(2, Math.min(8, Number(margen) || 4));
  const total = (size + quiet * 2) * moduleSize;
  const bytesPorFila = Math.ceil(total / 8);
  const pixeles = Buffer.alloc(bytesPorFila * total);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[y * size + x] !== 1) continue;
      for (let dy = 0; dy < moduleSize; dy++) {
        const fila = (quiet + y) * moduleSize + dy;
        for (let dx = 0; dx < moduleSize; dx++) {
          const col = (quiet + x) * moduleSize + dx;
          pixeles[fila * bytesPorFila + Math.floor(col / 8)] |= 0x80 >> (col % 8);
        }
      }
    }
  }
  const header = Buffer.from([GS, 0x76, 0x30, 0x00,
    bytesPorFila & 0xff, (bytesPorFila >> 8) & 0xff,
    total & 0xff, (total >> 8) & 0xff]);
  return Buffer.concat([header, pixeles, lf(1)]);
}

export function horaLocal(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
