// Asistente del restaurante, Fase 3: qué se le manda a la IA y la revisión de
// lo que devuelve. Funciones PURAS (sin base, sin reloj, sin red).
//
// Reglas del dueño (5.3 y 5.4 del pedido), que aquí se COMPRUEBAN:
//   · La IA no calcula ni inventa cifras: cada número de su texto tiene que
//     estar en los datos de ESE aviso (o del resumen), tal cual.
//   · Sin lenguaje de causa y efecto (la misma lista de la Fase 1).
//   · Nada que parezca teléfono, correo o tarjeta.
//   · Textos cortos, sin saltos de línea.
//   · Solo elige entre los avisos que las reglas ya dejaron pasar, nunca más
//     que el máximo del día, y los de control que hoy entrarían siguen
//     entrando («Control primero», decisión del dueño del 26-nov).
// Si algo no cumple, se usa el texto de las reglas: la IA nunca es necesaria.
import { FRASES_CAUSALES, PARECE_DATO_PERSONAL, TIPOS_CONTROL, TIPOS_INFORMATIVOS, tieneDatoConcreto } from './reglas.js';
import { grupoV2, NOMBRES_GRUPO_V2 } from './recomendaciones.js';
//
// Mejora 2 (28-nov-2026), con `v2` (la bandera de la sucursal):
//   · la sugerencia de la IA tiene que nombrar algo concreto de SU aviso (una
//     cifra o uno de sus `concretos`); si no, queda el texto de las reglas;
//   · si las reglas no dieron recomendación (no hubo datos), la IA tampoco;
//   · los obligatorios son los elegidos que piden decisión (control, caídas,
//     clientes perdidos): la IA no los cambia por buenas noticias.

export const LARGOS = Object.freeze({ titulo: 120, explicacion: 300, sugerencia: 220, variable: 200 });

// ─── Números ───────────────────────────────────────────────────────────────
// «$2,328», «54 %», «1.5», «-12.3» → su valor. Los folios no son cifras.
const NUMERO = /-?\d[\d,]*(?:\.\d+)?/g;
const sinFolios = (s) => String(s).replace(/\b[A-Z]{2,5}-[0-9A-Z-]{1,24}\b/g, '');
const canon = (n) => String(Math.round(Math.abs(Number(n)) * 10) / 10);

/** Los números que aparecen en un texto, como valores. */
export function numerosEn(texto) {
  const out = [];
  for (const m of sinFolios(texto).matchAll(NUMERO)) {
    const limpio = m[0].replace(/,/g, '');
    const n = Number(limpio);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** El conjunto de cifras permitidas: las de los textos y los valores dados. */
export function cifrasPermitidas(textos = [], valores = []) {
  const s = new Set();
  const agregar = (n) => {
    if (!Number.isFinite(Number(n))) return;
    s.add(canon(n));
    s.add(canon(Math.round(Number(n))));
  };
  for (const t of textos) if (typeof t === 'string') for (const n of numerosEn(t)) agregar(n);
  for (const v of valores) agregar(v);
  return s;
}

/**
 * ¿Sirve este texto de la IA? Devuelve la lista de faltas (vacía = sirve).
 * `permitidas`: de cifrasPermitidas.
 */
export function faltasDeTexto(texto, permitidas, max) {
  const faltas = [];
  if (typeof texto !== 'string' || !texto.trim()) return ['vacío'];
  if (texto.length > max) faltas.push(`más de ${max} letras`);
  if (/[\r\n\t]/.test(texto)) faltas.push('salto de línea');
  if (FRASES_CAUSALES.test(texto)) faltas.push('lenguaje causal');
  if (PARECE_DATO_PERSONAL.test(sinFolios(texto))) faltas.push('parece dato personal');
  for (const n of numerosEn(texto)) {
    if (!permitidas.has(canon(n))) { faltas.push(`cifra que no está en los datos: ${n}`); break; }
  }
  return faltas;
}

// ─── Los avisos de la mañana ───────────────────────────────────────────────
const formatear = (valor, formato) => {
  if (valor === null || valor === undefined || valor === '') return '—';
  if (formato === 'texto') return String(valor);
  const n = Number(valor);
  if (!Number.isFinite(n)) return String(valor);
  if (formato === 'dinero') return `$${Math.round(n).toLocaleString('es-MX')}`;
  if (formato === 'pct') return `${(Math.round(n * 10) / 10).toLocaleString('es-MX')} %`;
  if (formato === 'decimal') return (Math.round(n * 100) / 100).toLocaleString('es-MX');
  // Mejora 2: un cambio en pesos, con su signo («+$1,200», «−$800»).
  if (formato === 'cambio') return `${n < 0 ? '−' : '+'}$${Math.abs(Math.round(n)).toLocaleString('es-MX')}`;
  return Math.round(n).toLocaleString('es-MX');
};
const grupo = (tipo) => (TIPOS_CONTROL.includes(tipo) ? 'control' : TIPOS_INFORMATIVOS.includes(tipo) ? 'informativo' : 'ventas');
// Mejora 2: los elegidos que la IA no puede dejar fuera.
const esObligatorio = (h, v2) => h.elegido && (v2 ? grupoV2(h.tipo) === 0 : TIPOS_CONTROL.includes(h.tipo));

/** Los textos y los valores de un hallazgo (lo que se le muestra a la IA). */
function partesDe(h) {
  const d = h.detalle || {};
  const numeros = (d.numeros || []).map((n) => ({ etiqueta: String(n.etiqueta || ''), valor: formatear(n.valor, n.formato) }));
  const t = d.tabla && Array.isArray(d.tabla.columnas) && Array.isArray(d.tabla.filas) ? d.tabla : null;
  const formatos = Array.isArray(t?.formatos) ? t.formatos : [];
  const tabla = t ? {
    columnas: t.columnas.map(String),
    filas: t.filas.slice(0, 10).filter(Array.isArray).map((f) => f.map((x, i) => formatear(x, formatos[i] || (typeof x === 'number' ? 'entero' : 'texto')))),
  } : null;
  const revisar = h.revisar ? { numero: String(h.revisar.numero || ''), valor: formatear(h.revisar.valor, h.revisar.formato), el: h.revisar.el || null } : null;
  return { numeros, tabla, nota: typeof d.nota === 'string' ? d.nota : null, revisar };
}

/** Las cifras que el texto de la IA puede usar para ESTE hallazgo. */
export function cifrasDeHallazgo(h, { hoy } = {}) {
  const p = partesDe(h);
  const textos = [h.titulo, h.sugerencia, p.nota, p.revisar?.numero, p.revisar?.valor,
    ...p.numeros.flatMap((n) => [n.etiqueta, n.valor]),
    ...(p.tabla ? [...p.tabla.columnas, ...p.tabla.filas.flat()] : [])];
  const valores = [h.impacto, h.revisar?.valor, ...(h.detalle?.numeros || []).map((n) => n.valor)];
  for (const f of h.detalle?.tabla?.filas || []) if (Array.isArray(f)) for (const x of f) if (typeof x === 'number') valores.push(x);
  // Las fechas que se pueden nombrar: la de la revisión y la del aviso.
  for (const f of [h.revisar?.el, hoy]) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(f || ''));
    if (m) valores.push(Number(m[3]), Number(m[1]));
  }
  return cifrasPermitidas(textos, valores);
}

/** Los avisos que puede elegir la IA (los que las reglas dejaron pasar). */
export function poolDe(todos = []) {
  return todos.filter((h) => h.motivo === 'elegido' || String(h.motivo || '').startsWith('no cupo'));
}

/** Lo que se le manda a la IA para los avisos de la mañana. Sin datos personales. */
export function entradaAvisos({ negocio, hoy, todos, maximo, v2 = false }) {
  const pool = poolDe(todos);
  const obligatorios = pool.filter((h) => esObligatorio(h, v2));
  return {
    pool,
    obligatorios,
    datos: {
      sucursal: String(negocio?.nombre || ''),
      fecha: hoy,
      maximo,
      obligatorios: obligatorios.map((h) => `a${todos.indexOf(h)}`),
      avisos: pool.map((h) => ({
        id: `a${todos.indexOf(h)}`,
        tipo: h.tipo,
        grupo: v2 ? NOMBRES_GRUPO_V2[grupoV2(h.tipo)] : grupo(h.tipo),
        pesos_en_juego: Math.round(Number(h.impacto) || 0),
        titulo: h.titulo,
        sugerencia: h.sugerencia,
        ...(v2 ? { concretos: (Array.isArray(h.concretos) ? h.concretos : []).map(String).slice(0, 8) } : {}),
        ...partesDe(h),
      })),
    },
  };
}

export const SISTEMA_AVISOS = [
  'Eres el analista de un restaurante en México. Recibes avisos YA CALCULADOS por el sistema del restaurante, con sus cifras.',
  'Tu trabajo: elegir cuáles mostrarle hoy al dueño y redactarlos claro y corto, en español de México, hablándole de tú.',
  'Reglas que no se rompen:',
  '1. Elige solo ids de la lista «avisos», como máximo «maximo», sin repetir. Todos los ids de «obligatorios» van siempre.',
  '2. No calcules ni inventes cifras: usa solo números que aparecen escritos en los datos de ESE aviso, tal cual (no sumes, no restes, no saques porcentajes nuevos).',
  '3. Di qué cambió, nunca por qué: prohibido «porque», «debido a», «a causa de», «gracias a», «provocó», «hizo que», «se debe a».',
  '4. Nada de teléfonos, correos ni datos de pago.',
  '5. titulo: una línea de hasta 110 letras. explicacion: qué pasó, hasta 280 letras. sugerencia: UNA acción concreta, hasta 200 letras. Sin saltos de línea.',
  '6. Si un aviso no vale la pena hoy, no lo elijas. Ordena del más importante al menos importante.',
].join('\n');

// Mejora 2: las mismas reglas y dos más (la sugerencia concreta y el orden).
export const SISTEMA_AVISOS_V2 = [
  SISTEMA_AVISOS,
  '7. La sugerencia nombra al menos un dato concreto de ESE aviso: un producto, un día, un horario, un canal, cuántos clientes o una cantidad (están en «concretos» y en sus cifras). Nada genérico como «asegura el inventario».',
  '8. Si el aviso trae «sugerencia» vacía, deja la tuya vacía: no hay datos para recomendar algo concreto.',
  '9. Primero los del grupo «pide_decision», luego «buena_noticia» y al final «informativo».',
].join('\n');

export const ESQUEMA_AVISOS = Object.freeze({
  type: 'object',
  properties: {
    avisos: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, titulo: { type: 'string' }, explicacion: { type: 'string' }, sugerencia: { type: 'string' } },
        required: ['id', 'titulo', 'explicacion', 'sugerencia'],
        additionalProperties: false,
      },
    },
  },
  required: ['avisos'],
  additionalProperties: false,
});

/**
 * Aplica la respuesta de la IA a los candidatos de la corrida.
 * Devuelve { todos, estado, faltas }:
 *   estado 'ok'       — eligió bien y todos sus textos sirven;
 *          'parcial'  — algún texto no sirvió (ese aviso queda con el de las reglas);
 *          'invalida' — la elección no cumple: quedan los elegidos de las reglas
 *                       (con los textos de la IA que sí sirvan).
 * Nunca cambia el texto de las reglas: el de la IA va aparte, en `ia`.
 */
export function aplicarRespuestaAvisos({ todos, maximo, hoy, respuesta, v2 = false }) {
  const pool = poolDe(todos);
  const porId = new Map(todos.map((h, i) => [`a${i}`, h]));
  const enPool = new Set(pool);
  const obligatorios = pool.filter((h) => esObligatorio(h, v2));
  const lista = Array.isArray(respuesta?.avisos) ? respuesta.avisos : null;
  const faltas = [];
  let eleccionValida = !!lista;
  const elegidosIA = [];
  if (lista) {
    for (const a of lista) {
      const h = porId.get(String(a?.id));
      if (!h || !enPool.has(h)) { faltas.push(`id desconocido: ${String(a?.id).slice(0, 20)}`); eleccionValida = false; continue; }
      if (elegidosIA.includes(h)) { faltas.push('id repetido'); eleccionValida = false; continue; }
      elegidosIA.push(h);
    }
    if (elegidosIA.length > maximo) { faltas.push(`más de ${maximo} avisos`); eleccionValida = false; }
    if (!elegidosIA.length && pool.length) { faltas.push('no eligió ninguno'); eleccionValida = false; }
    for (const h of obligatorios) if (!elegidosIA.includes(h)) { faltas.push(v2 ? 'dejó fuera un aviso que pide decisión' : 'dejó fuera un aviso de control'); eleccionValida = false; break; }
  } else faltas.push('sin lista de avisos');

  const textos = new Map();
  for (const a of lista || []) {
    const h = porId.get(String(a?.id));
    if (!h || !enPool.has(h) || textos.has(h)) continue;
    const permitidas = cifrasDeHallazgo(h, { hoy });
    // Mejora 2: sin recomendación de las reglas, la IA tampoco pone una.
    const sinRecomendacion = v2 && !String(h.sugerencia || '').trim();
    const f = [
      ...faltasDeTexto(a.titulo, permitidas, LARGOS.titulo).map((x) => `título: ${x}`),
      ...faltasDeTexto(a.explicacion, permitidas, LARGOS.explicacion).map((x) => `explicación: ${x}`),
      ...(sinRecomendacion ? [] : faltasDeTexto(a.sugerencia, permitidas, LARGOS.sugerencia).map((x) => `sugerencia: ${x}`)),
    ];
    if (v2 && !sinRecomendacion && !f.length && !tieneDatoConcreto(a.sugerencia, h)) f.push('sugerencia: sin dato concreto');
    if (f.length) faltas.push(...f.slice(0, 2));
    else textos.set(h, { titulo: a.titulo.trim(), explicacion: a.explicacion.trim(), sugerencia: sinRecomendacion ? '' : a.sugerencia.trim() });
  }

  const elegidos = new Set(eleccionValida ? elegidosIA : pool.filter((h) => h.elegido));
  let sinTexto = 0;
  const nuevos = todos.map((h) => {
    if (!enPool.has(h)) return { ...h };
    const queda = elegidos.has(h);
    let motivo = h.motivo;
    if (queda && !h.elegido) motivo = 'elegido por la IA';
    else if (!queda && h.elegido) motivo = 'la IA eligió otro';
    const texto = queda ? textos.get(h) || null : null;
    // El orden que eligió la IA (la lista lo usa después de los de control).
    const ia = texto && eleccionValida ? { ...texto, orden: elegidosIA.indexOf(h) } : texto;
    if (queda && !ia) sinTexto++;
    return { ...h, elegido: queda, motivo, ia };
  });
  const estado = !eleccionValida ? 'invalida' : sinTexto ? 'parcial' : 'ok';
  return { todos: nuevos, estado, faltas };
}
