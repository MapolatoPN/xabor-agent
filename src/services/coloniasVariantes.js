// Reportes → Ventas: las formas de escribir UNA colonia (20-nov-2026).
//
// El cliente (o quien captura) escribe la colonia a mano y se equivoca de
// letra: «Bista Serena», «Vistaserena», «Valle Ondo», «Sta. Rosalía Nte».
// limpiarColonia (reporteVentas.js) ya juntaba mayúsculas, acentos y «Col.»;
// cualquier otra diferencia salía como otra colonia y repartía sus envíos.
//
// Dos niveles, porque una letra distinta a veces es un error y a veces es
// otra colonia («Las Fuentes» y «Las Puentes» pueden existir las dos):
//
//   1. SEGURAS, se unen solas: lo que se escribe distinto pero se lee igual
//      en español (b/v, s/z/c, y/ll, la h muda, letras repetidas, palabras
//      pegadas), abreviaturas (Sta., Nte., Ampl.), el sector como número
//      («Primer Sector» = «1er Sector», y nunca con el 2do), «Los/Las» al
//      principio, dos letras vecinas volteadas y singular/plural de una
//      palabra larga. La fila dice «También escrita: …» y cada una se puede
//      separar.
//   2. SUGERIDAS: una o dos letras distintas. No se unen; el administrador
//      decide «Unir» o «Son distintas», y la decisión se guarda por negocio
//      (configuracion.reporte_colonias_decisiones).
//
// Nada de esto toca los pedidos: solo cambia cómo se agrupa el reporte. Las
// decisiones se guardan por la clave de limpiarColonia (la forma exacta, sin
// acentos ni mayúsculas), así «separar» una forma no arrastra a otra.
import { pool } from './database.js';

export const CLAVE_DECISIONES = 'reporte_colonias_decisiones';
export const MAX_DECISIONES = 500;
export const MAX_SUGERENCIAS = 20;
const LARGO_CLAVE = 120;
const LARGO_NOMBRE = 120;

const sinAcentos = (t) => t.normalize('NFD').replace(/\p{M}+/gu, '');

const ORDINAL = {
  '1er': '1', '1ro': '1', '1o': '1', '1ra': '1', '1a': '1',
  '2do': '2', '2o': '2', '2da': '2', '2a': '2',
  '3er': '3', '3ro': '3', '3o': '3', '3ra': '3', '3a': '3',
  '4to': '4', '4o': '4', '4ta': '4', '4a': '4',
  '5to': '5', '5o': '5', '5ta': '5', '5a': '5',
};
// Solo junto a «sector», «etapa»…: «Quinta» o «Primavera» son nombres.
const ORDINAL_PALABRA = {
  primer: '1', primero: '1', primera: '1', segundo: '2', segunda: '2',
  tercer: '3', tercero: '3', tercera: '3', cuarto: '4', cuarta: '4',
  i: '1', ii: '2', iii: '3', iv: '4', v: '5',
};
const JUNTO_A_ORDINAL = new Set(['sector', 'etapa', 'seccion', 'ampliacion']);
const ABREVIATURA = {
  sta: 'santa', sto: 'santo', sn: 'san', ampl: 'ampliacion', amp: 'ampliacion',
  res: 'residencial', resid: 'residencial', secc: 'seccion', sec: 'sector', sect: 'sector',
  infon: 'infonavit', fco: 'francisco', gral: 'general', lic: 'licenciado',
  nte: 'norte', pte: 'poniente', ote: 'oriente',
};
const SOBRA = new Set(['colonia', 'col', 'fraccionamiento', 'fracc', 'frac']);
const ARTICULO = new Set(['la', 'las', 'el', 'los']);

/** Una palabra como suena: b/v, s/z/ce/ci, y/ll, h muda, k/c/qu, g/j, letras repetidas. */
function comoSuena(p) {
  if (/^\d+$/.test(p)) return p;
  return p
    .replace(/ch/g, '\u0001').replace(/h/g, '').replace(/\u0001/g, 'ch')
    .replace(/ll/g, 'y').replace(/v/g, 'b').replace(/z/g, 's').replace(/c(?=[ei])/g, 's')
    .replace(/qu(?=[ei])/g, 'k').replace(/gu(?=[ei])/g, 'g').replace(/g(?=[ei])/g, 'j')
    .replace(/c/g, 'k').replace(/w/g, 'u')
    .replace(/(.)\1+/g, '$1');
}

/** Las palabras de una colonia tal como suenan, separadas por espacio. */
export function palabrasDeColonia(texto) {
  if (typeof texto !== 'string') return '';
  const base = sinAcentos(texto).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!base) return '';
  let ps = base.split(' ').map(p => ABREVIATURA[p] || p).filter(p => !SOBRA.has(p));
  ps = ps.map((p, i) => ORDINAL[p]
    || (ORDINAL_PALABRA[p] && (JUNTO_A_ORDINAL.has(ps[i - 1]) || JUNTO_A_ORDINAL.has(ps[i + 1])) ? ORDINAL_PALABRA[p] : p));
  if (ps.length > 1 && ARTICULO.has(ps[0])) ps = ps.slice(1);
  return ps.map(comoSuena).filter(Boolean).join(' ');
}

/** La llave de una colonia: cómo suena, sin espacios. Dos formas con la misma llave son la misma colonia. */
export function llaveDeColonia(texto) {
  const p = palabrasDeColonia(texto).replace(/ /g, '');
  if (p) return p;
  return typeof texto === 'string' ? sinAcentos(texto).toLowerCase().replace(/[^a-z0-9]+/g, '') : '';
}

function forma(clave) {
  const palabras = palabrasDeColonia(clave);
  return { palabras, llave: palabras.replace(/ /g, '') || llaveDeColonia(clave) };
}

const digitos = (llave) => (llave.match(/\d+/g) || []).join(',');

/** Distancia de Damerau-Levenshtein (con dos letras vecinas volteadas = 1). */
export function distancia(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * ¿Son la misma colonia sin preguntar? x, y: { llave, palabras }.
 * Misma llave; o, en nombres de 6 letras o más y con los mismos números,
 * dos letras vecinas volteadas o una palabra larga en singular y en plural.
 */
export function mismaColoniaSegura(x, y) {
  if (!x?.llave || !y?.llave) return false;
  if (x.llave === y.llave) return true;
  const a = x.llave, b = y.llave;
  if (digitos(a) !== digitos(b) || Math.min(a.length, b.length) < 6) return false;
  if (a.length === b.length) {
    const dif = [];
    for (let i = 0; i < a.length && dif.length <= 2; i++) if (a[i] !== b[i]) dif.push(i);
    if (dif.length === 2 && dif[1] === dif[0] + 1 && a[dif[0]] === b[dif[1]] && a[dif[1]] === b[dif[0]]) return true;
  }
  const pa = x.palabras.split(' '), pb = y.palabras.split(' ');
  if (pa.length !== pb.length) return false;
  let plurales = 0;
  for (let i = 0; i < pa.length; i++) {
    if (pa[i] === pb[i]) continue;
    const [corta, larga] = pa[i].length < pb[i].length ? [pa[i], pb[i]] : [pb[i], pa[i]];
    if (corta.length >= 6 && (larga === `${corta}s` || larga === `${corta}es`)) plurales++;
    else return false;
  }
  return plurales > 0;
}

/** ¿Vale la pena preguntar? Una letra distinta (dos en nombres largos), mismos números. */
export function pareceMismaColonia(llaveA, llaveB) {
  if (typeof llaveA !== 'string' || typeof llaveB !== 'string' || llaveA === llaveB) return false;
  if (digitos(llaveA) !== digitos(llaveB)) return false;
  const n = Math.min(llaveA.length, llaveB.length);
  if (n < 5 || Math.abs(llaveA.length - llaveB.length) > 2) return false;
  return distancia(llaveA, llaveB) <= (n >= 11 ? 2 : 1);
}

// ─── Decisiones del administrador ────────────────────────────────────────────

const par = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Una clave de limpiarColonia válida (minúsculas, números y espacios sencillos), o null. */
export function claveValida(v) {
  if (typeof v !== 'string' || v.length > LARGO_CLAVE) return null;
  return /^[a-z0-9]+(?: [a-z0-9]+)*$/.test(v) ? v : null;
}

const nombreValido = (v) => (typeof v === 'string'
  ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LARGO_NOMBRE)
  : '');

const fechaValida = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

/**
 * Las decisiones guardadas, limpias: [{ tipo: 'unir'|'distintas', de, a,
 * de_nombre, a_nombre, en }]. Una por par de colonias (la primera que se lee:
 * aplicarDecision deja siempre la más reciente al principio). Lo que no se
 * entiende se ignora: una fila dañada nunca tumba el reporte.
 */
export function normalizarDecisiones(valor) {
  let v = valor;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  const lista = Array.isArray(v?.decisiones) ? v.decisiones : [];
  const vistos = new Set();
  const out = [];
  for (const d of lista) {
    if (out.length >= MAX_DECISIONES) break;
    const tipo = d?.tipo === 'unir' || d?.tipo === 'distintas' ? d.tipo : null;
    const de = claveValida(d?.de), a = claveValida(d?.a);
    if (!tipo || !de || !a || de === a || vistos.has(par(de, a))) continue;
    vistos.add(par(de, a));
    out.push({
      tipo, de, a,
      de_nombre: nombreValido(d.de_nombre) || de,
      a_nombre: nombreValido(d.a_nombre) || a,
      en: fechaValida(d.en),
    });
  }
  return out;
}

/**
 * Aplica una acción del administrador a la lista. Función pura.
 * cuerpo: { accion: 'unir'|'distintas'|'deshacer', de, a, de_nombre?, a_nombre? }
 * Devuelve { decisiones } o { error, code }. «Unir» y «Son distintas» sobre el
 * mismo par se reemplazan: vale la última. «Deshacer» quita la del par.
 */
export function aplicarDecision(decisiones, cuerpo, { ahora = new Date() } = {}) {
  const accion = cuerpo?.accion;
  if (!['unir', 'distintas', 'deshacer'].includes(accion)) return { error: 'Acción no válida', code: 'ACCION_INVALIDA' };
  const de = claveValida(cuerpo?.de), a = claveValida(cuerpo?.a);
  if (!de || !a) return { error: 'Colonia no válida', code: 'COLONIA_INVALIDA' };
  if (de === a) return { error: 'Es la misma colonia', code: 'MISMA_COLONIA' };
  const k = par(de, a);
  const resto = (Array.isArray(decisiones) ? decisiones : []).filter(d => par(d.de, d.a) !== k);
  if (accion === 'deshacer') return { decisiones: resto };
  if (resto.length >= MAX_DECISIONES) return { error: `Ya hay ${MAX_DECISIONES} decisiones guardadas`, code: 'DEMASIADAS_DECISIONES' };
  const nueva = {
    tipo: accion, de, a,
    de_nombre: nombreValido(cuerpo.de_nombre) || de,
    a_nombre: nombreValido(cuerpo.a_nombre) || a,
    en: ahora.toISOString(),
  };
  return { decisiones: [nueva, ...resto] };
}

/** Las decisiones del negocio, o [] si no hay o no se pudieron leer. */
export async function leerDecisionesColonias(negocioId) {
  try {
    const { rows } = await pool.query(
      'SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2', [negocioId, CLAVE_DECISIONES]);
    return normalizarDecisiones(rows[0]?.valor);
  } catch (e) {
    console.warn('[Reportes] no se pudieron leer las decisiones de colonias:', e.message);
    return [];
  }
}

/**
 * Guarda una decisión del administrador, con la fila bloqueada: dos clics a la
 * vez desde dos pantallas se forman y ninguno pisa al otro.
 */
export async function guardarDecisionColonias(negocioId, cuerpo, { ahora = new Date() } = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e;
  }
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query(
      `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, $2, '{}')
       ON CONFLICT (negocio_id, clave) DO NOTHING`, [negocioId, CLAVE_DECISIONES]);
    const { rows } = await cliente.query(
      'SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2 FOR UPDATE', [negocioId, CLAVE_DECISIONES]);
    const r = aplicarDecision(normalizarDecisiones(rows[0]?.valor), cuerpo, { ahora });
    if (r.error) { await cliente.query('ROLLBACK'); return r; }
    await cliente.query(
      'UPDATE configuracion SET valor = $3 WHERE negocio_id = $1 AND clave = $2',
      [negocioId, CLAVE_DECISIONES, JSON.stringify({ version: 1, decisiones: r.decisiones })]);
    await cliente.query('COMMIT');
    return r;
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

/**
 * Las claves que las decisiones «Unir» juntan, aunque en un periodo aparezca
 * solo una de ellas: clave → representante de su conjunto (o undefined si
 * ninguna decisión la toca). Sirve para comparar periodos.
 */
export function conjuntosUnidos(decisiones = []) {
  const padre = new Map();
  const raiz = (x) => {
    if (!padre.has(x)) padre.set(x, x);
    const p = padre.get(x);
    if (p === x) return x;
    const r = raiz(p);
    padre.set(x, r);
    return r;
  };
  for (const d of decisiones || []) {
    if (d?.tipo !== 'unir') continue;
    const ra = raiz(d.de), rb = raiz(d.a);
    if (ra !== rb) padre.set(ra, rb);
  }
  return (clave) => (padre.has(clave) ? raiz(clave) : undefined);
}

// ─── Agrupar ─────────────────────────────────────────────────────────────────

/**
 * Agrupa las claves de colonia de un periodo. Función pura.
 * entradas: [{ clave, pedidos, venta }] — una por clave de limpiarColonia.
 * decisiones: las de normalizarDecisiones.
 * Devuelve:
 *   grupos: [{ cabeza, miembros: [{ clave, a_mano, separar_de }] }], la cabeza
 *     es la clave con más envíos; a_mano = unida por una decisión «Unir»;
 *     separar_de = con qué clave se unió sola (para «Separar»), null si a mano;
 *   grupoDe: Map clave → índice en grupos;
 *   sugerencias: [{ de, a }] cabezas de grupos que se parecen (de: la de menos
 *     envíos), sin las marcadas «Son distintas», hasta MAX_SUGERENCIAS.
 */
export function agruparColonias(entradas = [], decisiones = []) {
  const distintas = new Set();
  const unir = [];
  for (const d of decisiones || []) {
    if (d?.tipo === 'distintas') distintas.add(par(d.de, d.a));
    else if (d?.tipo === 'unir') unir.push([d.de, d.a]);
  }
  const orden = [...entradas].sort((x, y) => (y.pedidos - x.pedidos) || (y.venta - x.venta)
    || (x.clave < y.clave ? -1 : x.clave > y.clave ? 1 : 0));
  // 1. Las seguras, cada forma contra la cabeza de cada grupo (no contra
  //    cualquier miembro: así no se encadenan parecidos de parecidos).
  const auto = [];
  const autoDe = new Map();
  for (const e of orden) {
    const x = { ...e, ...forma(e.clave) };
    let idx = auto.findIndex(g => mismaColoniaSegura(g.cabeza, x)
      && !g.miembros.some(m => distintas.has(par(m.clave, x.clave))));
    if (idx < 0) { auto.push({ cabeza: x, miembros: [] }); idx = auto.length - 1; }
    auto[idx].miembros.push(x);
    autoDe.set(e.clave, idx);
  }
  // 2. Las que el administrador unió a mano.
  const padre = auto.map((_, i) => i);
  const raiz = (i) => (padre[i] === i ? i : (padre[i] = raiz(padre[i])));
  for (const [de, a] of unir) {
    const gi = autoDe.get(de), gj = autoDe.get(a);
    if (gi === undefined || gj === undefined) continue;
    const ri = raiz(gi), rj = raiz(gj);
    if (ri !== rj) padre[ri] = rj;
  }
  const porRaiz = new Map();
  auto.forEach((_, i) => {
    const r = raiz(i);
    if (!porRaiz.has(r)) porRaiz.set(r, []);
    porRaiz.get(r).push(i);
  });
  const grupos = [];
  const grupoDe = new Map();
  for (const idxs of porRaiz.values()) {
    // El orden de `auto` ya va de más a menos envíos: la primera cabeza es la mayor.
    const principal = Math.min(...idxs);
    const cabeza = auto[principal].cabeza;
    const miembros = idxs.flatMap(i => auto[i].miembros).map(m => ({
      clave: m.clave,
      a_mano: autoDe.get(m.clave) !== principal,
      separar_de: autoDe.get(m.clave) === principal && m.clave !== cabeza.clave ? cabeza.clave : null,
    }));
    for (const m of miembros) grupoDe.set(m.clave, grupos.length);
    grupos.push({ cabeza: cabeza.clave, miembros, _llave: cabeza.llave, _pedidos: idxs.reduce((s, i) => s + auto[i].miembros.reduce((t, m) => t + m.pedidos, 0), 0) });
  }
  // 3. Las que se parecen: solo se sugieren.
  const sugerencias = [];
  for (let i = 0; i < grupos.length; i++) {
    for (let j = i + 1; j < grupos.length; j++) {
      const gi = grupos[i], gj = grupos[j];
      if (!pareceMismaColonia(gi._llave, gj._llave)) continue;
      if (gi.miembros.some(m => gj.miembros.some(n => distintas.has(par(m.clave, n.clave))))) continue;
      const [mayor, menor] = gi._pedidos >= gj._pedidos ? [gi, gj] : [gj, gi];
      sugerencias.push({ de: menor.cabeza, a: mayor.cabeza, _orden: [mayor._pedidos, menor._pedidos] });
    }
  }
  sugerencias.sort((x, y) => (y._orden[0] - x._orden[0]) || (y._orden[1] - x._orden[1]));
  return {
    grupos: grupos.map(({ cabeza, miembros }) => ({ cabeza, miembros })),
    grupoDe,
    sugerencias: sugerencias.slice(0, MAX_SUGERENCIAS).map(({ de, a }) => ({ de, a })),
  };
}
