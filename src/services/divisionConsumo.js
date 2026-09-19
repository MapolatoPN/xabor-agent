// ─── División de cuenta por consumo: la aritmética, sin base de datos ───────
//
// Todo lo que decide dinero aquí va en ENTEROS de centavos y fracciones
// exactas (numerador/denominador). Nunca aritmética de punto flotante sobre
// importes: 0.1 + 0.2 no es 0.3, pero 10 + 20 sí es 30.
//
//   · Una PORCIÓN es la fracción del renglón completo que cubre un cobro:
//     2 de 3 tacos = 2/3; media pizza compartida = 1/2. Lo pendiente de un
//     renglón es 1 - (suma de sus porciones vigentes), como fracción exacta.
//   · El DESCUENTO de la cuenta se reparte entre los renglones a prorrata de
//     su importe bruto, y los centavos sobrantes del reparto se asignan por
//     MAYORES RESIDUOS (largest remainder): suma de netos = subtotal -
//     descuento, exacto al centavo.
//   · El importe de una porción es floor(neto × fracción); la porción que
//     COMPLETA el renglón se lleva exactamente lo que falta, así el renglón
//     cierra al centavo sin importar en cuántas partes se pagó.
//
// Es un módulo puro a propósito: se prueba con números difíciles sin
// Postgres ni servidor.

export const TOPE_DENOMINADOR = 1000;
export const UNO = Object.freeze({ num: 1, den: 1 });
export const CERO = Object.freeze({ num: 0, den: 1 });

function esEntero(n) { return Number.isInteger(n); }

export function mcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { const t = a % b; a = b; b = t; }
  return a || 1;
}

// Fracción validada y reducida. Acepta num = 0 (nada) y exige 0 < den ≤ tope.
export function fraccion(num, den) {
  const n = Number(num), d = Number(den);
  if (!esEntero(n) || !esEntero(d) || n < 0 || d <= 0 || d > TOPE_DENOMINADOR) {
    const e = new Error(`Fracción inválida: ${num}/${den}`);
    e.code = 'FRACCION_INVALIDA';
    throw e;
  }
  if (n === 0) return { num: 0, den: 1 };
  const g = mcd(n, d);
  return { num: n / g, den: d / g };
}

export function sumar(a, b) {
  const num = a.num * b.den + b.num * a.den;
  const den = a.den * b.den;
  const g = mcd(num, den);
  return { num: num / g, den: den / g };
}

export function restar(a, b) {
  const num = a.num * b.den - b.num * a.den;
  const den = a.den * b.den;
  if (num === 0) return { num: 0, den: 1 };
  const g = mcd(num, den);
  return { num: num / g, den: den / g };
}

// -1, 0 o 1 sin dividir: se comparan los productos cruzados.
export function comparar(a, b) {
  const izq = a.num * b.den, der = b.num * a.den;
  return izq < der ? -1 : (izq > der ? 1 : 0);
}

export const esCero = (f) => f.num === 0;
export const textoFraccion = (f) => (f.den === 1 ? String(f.num) : `${f.num}/${f.den}`);

// Pesos (número o texto) a centavos enteros. Redondea a medio centavo hacia
// arriba solo para absorber el ruido de punto flotante de la entrada.
export function aCentavos(pesos) {
  const n = Number(pesos);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}
export const aPesos = (centavos) => Math.round(centavos) / 100;

// Reparte `descuentoCentavos` entre los renglones a prorrata del importe
// bruto. Mayores residuos: primero la parte entera de cada uno, y los
// centavos que faltan para completar el descuento van a los renglones con
// mayor residuo (empates: el que aparece primero). Todo en enteros: el
// residuo se compara como numerador exacto (D·bruto_i mod total), nunca
// como decimal.
export function prorratearDescuento(renglones, descuentoCentavos) {
  const total = renglones.reduce((s, r) => s + r.brutoCentavos, 0);
  const D = Math.max(0, Math.min(Math.round(descuentoCentavos) || 0, total));
  const reparto = new Map(renglones.map(r => [r.id, 0]));
  if (D === 0 || total === 0) return reparto;
  let asignado = 0;
  const residuos = [];
  renglones.forEach((r, i) => {
    const producto = D * r.brutoCentavos;           // entero seguro (< 2^53 con importes reales)
    const base = Math.floor(producto / total);
    reparto.set(r.id, base);
    asignado += base;
    residuos.push({ id: r.id, i, residuo: producto - base * total });
  });
  let faltan = D - asignado;
  residuos.sort((a, b) => (b.residuo - a.residuo) || (a.i - b.i));
  for (const r of residuos) {
    if (faltan <= 0) break;
    reparto.set(r.id, reparto.get(r.id) + 1);
    faltan--;
  }
  return reparto;
}

// Netos por renglón: bruto - descuento prorrateado. Devuelve los renglones
// en el mismo orden con brutoCentavos, descuentoCentavos y netoCentavos.
export function netosDeRenglones(renglones, descuentoCentavos) {
  const reparto = prorratearDescuento(renglones, descuentoCentavos);
  return renglones.map(r => {
    const descuento = reparto.get(r.id) || 0;
    return { ...r, descuentoCentavos: descuento, netoCentavos: r.brutoCentavos - descuento };
  });
}

// Importe de una porción. Si la fracción pedida es exactamente lo que queda
// pendiente, se lleva lo que falta del neto (el renglón cierra al centavo);
// si no, la parte entera de neto × fracción.
export function importeDePorcion({ netoCentavos, cobradoCentavos, pendiente, fraccion: f }) {
  if (comparar(f, pendiente) === 0) return Math.max(0, netoCentavos - cobradoCentavos);
  return Math.floor(netoCentavos * f.num / f.den);
}

// Partes iguales en centavos: base para todas y un centavo extra a las
// primeras hasta agotar el sobrante. Suma exacta.
export function partesIgualesCentavos(saldoCentavos, partes) {
  const n = Number(partes);
  if (!esEntero(n) || n < 1 || n > 100) {
    const e = new Error('Número de partes inválido');
    e.code = 'PARTES_INVALIDAS';
    throw e;
  }
  const saldo = Math.max(0, Math.round(saldoCentavos) || 0);
  const base = Math.floor(saldo / n);
  const sobrante = saldo - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < sobrante ? 1 : 0));
}
