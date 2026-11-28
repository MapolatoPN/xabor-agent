// Asistente del restaurante, Fase 4: lo que pinta la pestaña «Asistente» de
// Reportes (panel/asistente-pantalla.js).
//
// Pedido del dueño del 27-nov-2026: ver las recomendaciones en una pantalla
// del panel, «no cuadros grandes de texto, sino algo más estético», y dentro
// de Reportes, «ya que la información viene de ahí».
//
// Dos partes, las dos de UNA sucursal:
//   · «Cómo va el día»: la venta de hoy hasta esta hora contra el mismo día de
//     la semana pasada hasta la misma hora (la misma cuenta del resumen de la
//     Fase 3: resumen.calcularResumen), sin pedidos grandes, y la venta por
//     hora de los dos días.
//   · Las tarjetas: lo que eligió la revisión más reciente (de los últimos 7
//     días), cada una con su título corto, su cifra grande y su gráfica
//     (tarjetaDe, pura). El texto largo va detrás de «Ver números».
//
// Solo LEE. Las ventas se leen en una transacción de solo lectura
// (datos.leerVentasDeResumen). El umbral de pedido grande (90 días de ventas)
// se guarda en memoria por sucursal y día: abrir la pestaña no relee tres
// meses cada vez. No toca pedidos, cobros, impresión, Rappi, WhatsApp, Clip
// ni Facturapi.
import { TIPOS_CONTROL, UMBRALES_ASISTENTE, umbralPedidoGrande, sumarDias, dinero } from './reglas.js';
import { NOMBRES_TIPOS, leerConfiguracion, paraLaRevision } from './configuracion.js';
import { leerVentasDeResumen } from './datos.js';
import { calcularResumen, diaDeLaSemana } from './resumen.js';
import { negocioDe, horaHM } from './envioResumen.js';
import { gastoDelMes } from './ia.js';
import { fechaOperativaDe } from '../services/cortesCaja.js';

export const DIAS_REVISION = 7;     // la revisión más vieja que todavía se enseña
export const MAXIMO_TARJETAS = 10;

const esUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const exigirNegocio = (nid) => { if (!esUuid(nid)) { const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e; } };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const texto = (v, max = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');
const entero = (n) => Math.round(Number(n) || 0).toLocaleString('es-MX');
const decimal1 = (n) => (Math.round((Number(n) || 0) * 10) / 10).toLocaleString('es-MX');
const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pctDe = (a, b) => (a !== null && b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null);
const cambioTexto = (p) => `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toLocaleString('es-MX')} %`;
const conSigno = (d) => `${d < 0 ? '−' : '+'}${dinero(Math.abs(d))}`;

// ─── Las tarjetas ─────────────────────────────────────────────────────────
const CLIENTES = ['clientes_dejaron', 'nuevos_regresan_menos', 'clientes_cambiaron'];
const MENU = ['combinaciones', 'poca_venta'];
export const ETIQUETAS_GRUPO = Object.freeze({ control: 'Control', ventas: 'Ventas', clientes: 'Clientes', menu: 'Menú' });

/** El grupo de la tarjeta (su color y su etiqueta). */
export function grupoDe(tipo) {
  if (TIPOS_CONTROL.includes(tipo)) return 'control';
  if (CLIENTES.includes(tipo)) return 'clientes';
  if (MENU.includes(tipo)) return 'menu';
  return 'ventas';
}

/** Las iniciales de un nombre para la gráfica de clientes («?» si no tiene). */
export function inicialesDe(nombre) {
  const s = String(nombre || '').trim();
  if (!s || /^cliente sin nombre/i.test(s)) return '?';
  const palabras = s.split(/\s+/).map((p) => p.replace(/[^\p{L}]/gu, '')).filter(Boolean);
  return palabras.slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
}

function antesAhora(antes, ahora, formato, etiquetas) {
  if (antes === null || ahora === null) return null;
  return { tipo: 'antesAhora', antes: redondear(antes), ahora: redondear(ahora), formato, etiquetas };
}

function iniciales(tabla, total) {
  const filas = Array.isArray(tabla?.filas) ? tabla.filas : [];
  const lista = filas.slice(0, 5).map((f) => inicialesDe(Array.isArray(f) ? f[0] : ''));
  if (!lista.length) return null;
  return { tipo: 'iniciales', iniciales: lista, mas: Math.max(0, (Number(total) || 0) - lista.length) };
}

/** La cifra grande, su línea de abajo, su tono y su gráfica, según el tipo. */
function cifrasDe(tipo, det, pantalla) {
  const n = Array.isArray(det.numeros) ? det.numeros : [];
  const v = (i) => num(n[i]?.valor);
  switch (tipo) {
    case 'descuentos_altos': case 'cancelaciones_altas': case 'cortesias_altas': {
      const serie = Array.isArray(pantalla.serie) && pantalla.serie.length >= 2 && pantalla.serie.length <= 12
        && pantalla.serie.every((x) => num(x) !== null) ? pantalla.serie.map((x) => redondear(x)) : null;
      return {
        cifra: v(0) === null ? null : dinero(v(0)), sub: v(1) === null ? '' : `lo normal ${dinero(v(1))}`, tono: 'alerta',
        grafica: serie ? { tipo: 'serie', valores: serie, formato: 'dinero', etiqueta: 'Últimas 9 semanas' }
          : antesAhora(v(1), v(0), 'dinero', ['Lo normal', 'Esta semana']),
      };
    }
    case 'ventas_sin_forma_pago': case 'ventas_fuera_horario': case 'ventas_incompletas':
      return {
        cifra: v(1) === null ? null : dinero(v(1)),
        sub: v(0) === null ? '' : `${v(0) === 1 ? '1 venta' : `${entero(v(0))} ventas`} de la semana`, tono: 'alerta', grafica: null,
      };
    case 'producto_baja': case 'producto_sube': case 'categoria_baja': case 'categoria_sube':
    case 'canal_baja': case 'canal_sube': {
      const p = pctDe(v(0), v(1));
      return {
        cifra: p === null ? (v(0) === null ? null : dinero(v(0))) : cambioTexto(p),
        sub: v(0) === null || v(1) === null ? '' : `${conSigno(v(0) - v(1))} en 4 semanas`,
        tono: tipo.endsWith('_baja') ? 'baja' : 'sube',
        grafica: antesAhora(v(1), v(0), 'dinero', ['4 semanas antes', 'Últimas 4']),
      };
    }
    case 'dia_flojo': case 'franja_floja': {
      const p = pctDe(v(0), v(1));
      return {
        cifra: p === null ? null : cambioTexto(p),
        sub: v(4) === null ? '' : `−${dinero(Math.abs(v(4)))} en 4 semanas`, tono: 'baja',
        grafica: antesAhora(v(1), v(0), 'dinero', ['Antes, por día', 'Ahora, por día']),
      };
    }
    case 'clientes_dejaron':
      return {
        cifra: v(0) === null ? null : entero(v(0)), sub: v(1) === null ? '' : `dejaban ~${dinero(v(1))} al mes`, tono: 'baja',
        grafica: iniciales(det.tabla, v(0)),
      };
    case 'nuevos_regresan_menos': {
      const ahora = v(0) > 0 && v(1) !== null ? (v(1) / v(0)) * 100 : null;
      const antes = v(2) > 0 && v(3) !== null ? (v(3) / v(2)) * 100 : null;
      return {
        cifra: ahora === null ? null : `${decimal1(ahora)} %`, sub: antes === null ? '' : `el grupo anterior: ${decimal1(antes)} %`, tono: 'baja',
        grafica: antesAhora(antes, ahora, 'pct', ['Grupo anterior', 'Grupo reciente']),
      };
    }
    case 'clientes_cambiaron':
      return { cifra: v(0) === null ? null : entero(v(0)), sub: 'clientes frecuentes', tono: null, grafica: iniciales(det.tabla, v(0)) };
    case 'pedidos_grandes':
      return {
        cifra: v(1) === null ? null : dinero(v(1)),
        sub: v(0) === null ? '' : `${v(0) === 1 ? '1 pedido' : `${entero(v(0))} pedidos`}${v(2) === null ? '' : ` · grande desde ${dinero(v(2))}`}`,
        tono: null, grafica: null,
      };
    case 'combinaciones':
      return {
        cifra: v(0) === null ? null : entero(v(0)), sub: `tickets con las dos${v(1) === null ? '' : ` · ${decimal1(v(1))} % del total`}`,
        tono: null, grafica: null,
      };
    case 'poca_venta':
      return { cifra: v(1) === null ? null : entero(v(1)), sub: 'con menos de 6 piezas en 90 días', tono: null, grafica: null };
    default: {
      const f = n[0]?.formato;
      const c = v(0) === null ? null : f === 'entero' ? entero(v(0)) : f === 'pct' ? `${decimal1(v(0))} %` : dinero(v(0));
      return { cifra: c, sub: texto(n[0]?.etiqueta, 80), tono: null, grafica: null };
    }
  }
}

/**
 * Un hallazgo guardado → la tarjeta. PURA. Los hallazgos de antes de la Fase 4
 * no traen `pantalla`: su título corto es el nombre del tipo y su cifra sale
 * de los números del detalle, igual que en los nuevos.
 */
export function tarjetaDe(fila) {
  const c = fila?.contenido && typeof fila.contenido === 'object' && !Array.isArray(fila.contenido) ? fila.contenido : {};
  const ia = c.ia && typeof c.ia === 'object' ? c.ia : null;
  const det = c.detalle && typeof c.detalle === 'object' ? c.detalle : {};
  const pantalla = c.pantalla && typeof c.pantalla === 'object' ? c.pantalla : {};
  const grupo = grupoDe(fila?.tipo);
  const { cifra, sub, tono, grafica } = cifrasDe(fila?.tipo, det, pantalla);
  const numeros = Array.isArray(det.numeros) ? det.numeros : [];
  return {
    id: String(fila.id),
    tipo: fila.tipo,
    grupo,
    etiqueta: ETIQUETAS_GRUPO[grupo],
    encabezado: texto(pantalla.encabezado, 80) || NOMBRES_TIPOS[fila.tipo] || texto(fila.titulo, 80) || 'Aviso del asistente',
    cifra, sub, tono, grafica,
    // El texto largo (detrás de «Ver números»). Si la IA lo redactó, su texto
    // ya pasó la revisión de redaccion.js; los números siempre son las reglas.
    titulo: (ia && texto(ia.titulo)) || String(fila.titulo || ''),
    sugerencia: (ia && texto(ia.sugerencia)) || String(c.sugerencia || ''),
    explicacion: ia ? texto(ia.explicacion, 600) : '',
    redactadoConIA: !!ia,
    detalle: numeros.length || det.tabla || det.nota
      ? { numeros, tabla: det.tabla && typeof det.tabla === 'object' ? det.tabla : null, nota: texto(det.nota, 600) || null }
      : null,
    revisar: c.revisar && typeof c.revisar === 'object' ? c.revisar : null,
    opinion: fila.opinion || null,
  };
}

// ─── «Cómo va el día» ─────────────────────────────────────────────────────
const cacheUmbral = new Map();
const MAXIMO_CACHE = 200;

/** Para las pruebas: olvidar los umbrales guardados. */
export function olvidarUmbrales() { cacheUmbral.clear(); }

/** El umbral de pedido grande de hoy (90 días hasta ayer), una vez por sucursal y día. */
async function umbralDeHoy(cliente, { negocio, hoy, U }) {
  const llave = `${negocio.id}|${hoy}|${U.pedidoGrandeFactor}|${U.pedidoGrandePiso}`;
  if (cacheUmbral.has(llave)) return cacheUmbral.get(llave);
  const ayer = sumarDias(hoy, -1);
  const ventas = await leerVentasDeResumen(cliente, { negocio, desde: sumarDias(ayer, -89), hasta: ayer });
  const umbral = umbralPedidoGrande(ventas, ayer, U);
  if (cacheUmbral.size >= MAXIMO_CACHE) cacheUmbral.clear();
  cacheUmbral.set(llave, umbral);
  return umbral;
}

/**
 * La venta por hora de hoy (hasta `horaCorte`) y del mismo día de la semana
 * pasada (completo, para ver lo que falta). Sin pedidos grandes. PURA.
 */
export function ventaPorHora(ventas, { hoy, horaCorte, umbralGrande }) {
  const pasada = sumarDias(hoy, -7);
  const deHoy = new Array(24).fill(0);
  const deAntes = new Array(24).fill(0);
  let min = 24; let max = -1;
  for (const v of ventas) {
    if (v.clase !== 'venta' || !(v.neta <= umbralGrande) || typeof v.hora !== 'string' || !/^\d{2}:\d{2}$/.test(v.hora)) continue;
    const h = Number(v.hora.slice(0, 2));
    if (v.fecha === hoy && v.hora <= horaCorte) deHoy[h] += v.neta;
    else if (v.fecha === pasada) deAntes[h] += v.neta;
    else continue;
    min = Math.min(min, h); max = Math.max(max, h);
  }
  if (max < 0) return [];
  const ahora = Number(String(horaCorte).slice(0, 2));
  const salida = [];
  for (let h = min; h <= max; h++) salida.push({ hora: h, hoy: h <= ahora ? redondear(deHoy[h]) : null, antes: redondear(deAntes[h]) });
  return salida;
}

/** «Cómo va el día» de UNA sucursal a esta hora. */
export async function comoVaElDia(db, { negocio, ahora = new Date(), umbrales = {} }) {
  const U = { ...UMBRALES_ASISTENTE, ...umbrales };
  const hoy = fechaOperativaDe(ahora, negocio.tz);
  const horaCorte = horaHM(ahora, negocio.tz);
  const cliente = await db.connect();
  let ventas; let umbralGrande;
  try {
    umbralGrande = await umbralDeHoy(cliente, { negocio, hoy, U });
    ventas = await leerVentasDeResumen(cliente, { negocio, desde: sumarDias(hoy, -7), hasta: hoy });
  } finally {
    cliente.release();
  }
  const r = calcularResumen({ tipo: 'diario', negocio, ventas, hoy, horaCorte, umbralGrande, elegidos: [] });
  const promedio = (x) => (x.tickets ? redondear(x.venta / x.tickets) : 0);
  return {
    hoy, dia: diaDeLaSemana(hoy), horaCorte, comparadoCon: diaDeLaSemana(sumarDias(hoy, -7)),
    actual: { ...r.actual, promedio: promedio(r.actual) },
    antes: { ...r.antes, promedio: promedio(r.antes) },
    cambioPct: r.cambioPct,
    umbralGrande,
    porHora: ventaPorHora(ventas, { hoy, horaCorte, umbralGrande }),
  };
}

// ─── La pestaña completa ──────────────────────────────────────────────────
async function revisionReciente(db, negocioId, hoy) {
  const { rows: [c] } = await db.query(`
    SELECT id::text AS id, fecha::text AS fecha, terminada_en, candidatos, elegidos, ia
      FROM asistente_restaurante_corridas
     WHERE negocio_id = $1 AND estado = 'lista' AND fecha >= $2::date AND fecha <= $3::date
     ORDER BY fecha DESC LIMIT 1`, [negocioId, sumarDias(hoy, -(DIAS_REVISION - 1)), hoy]);
  return c || null;
}

async function tarjetasDe(db, negocioId, corridaId, usuarioId) {
  const { rows } = await db.query(`
    SELECT h.id, h.tipo, h.titulo, h.contenido, o.opinion
      FROM asistente_restaurante_hallazgos h
      LEFT JOIN asistente_restaurante_opiniones o ON o.hallazgo_id = h.id AND o.usuario_id = $3
     WHERE h.negocio_id = $1 AND h.corrida_id = $2 AND h.elegido
       AND NOT EXISTS (SELECT 1 FROM asistente_restaurante_silenciados s WHERE s.negocio_id = h.negocio_id AND s.firma = h.firma)
     ORDER BY (h.tipo = ANY($4::text[])) DESC,
              CASE WHEN h.contenido->'ia'->>'orden' ~ '^[0-9]{1,2}$' THEN (h.contenido->'ia'->>'orden')::int END ASC NULLS LAST,
              h.impacto DESC, h.id DESC
     LIMIT $5`, [negocioId, corridaId, usuarioId, [...TIPOS_CONTROL], MAXIMO_TARJETAS]);
  return rows.map(tarjetaDe);
}

/**
 * Todo lo que pinta la pestaña, para ESTE usuario en ESTA sucursal. Quien
 * llama ya comprobó que puede verla (avisos.puedeVer). Cada parte falla sola:
 * si «Cómo va el día» no se pudo leer, las tarjetas salen igual.
 */
export async function leerPantalla(db, { negocioId, usuarioId, ahora = new Date() }) {
  exigirNegocio(negocioId);
  const negocio = await negocioDe(db, negocioId);
  if (!negocio) return null;
  const ajustes = paraLaRevision(await leerConfiguracion(db, negocioId));
  const hoy = fechaOperativaDe(ahora, negocio.tz);

  let comoVa = null;
  try {
    comoVa = await comoVaElDia(db, { negocio, ahora, umbrales: ajustes.umbrales });
  } catch (e) {
    console.error(`[Asistente] Cómo va el día de ${negocioId}:`, e.message);
  }

  const corrida = await revisionReciente(db, negocioId, hoy);
  const tarjetas = corrida ? await tarjetasDe(db, negocioId, corrida.id, usuarioId) : [];

  let gastoMesUsd = null;
  try { gastoMesUsd = Math.round((await gastoDelMes(db, negocioId, negocio.tz, ahora)) * 100) / 100; } catch { gastoMesUsd = null; }

  return {
    activo: true,
    sucursal: negocio.nombre,
    comoVa,
    revision: corrida ? {
      fecha: corrida.fecha, esHoy: corrida.fecha === hoy,
      hora: corrida.terminada_en ? horaHM(new Date(corrida.terminada_en), negocio.tz) : null,
      candidatos: Number(corrida.candidatos) || 0, elegidos: Number(corrida.elegidos) || 0,
    } : null,
    tarjetas,
    ia: {
      encendida: ajustes.ia, topeUsd: ajustes.topeUsd, gastoMesUsd,
      alTope: ajustes.ia && ((corrida && corrida.ia === 'tope') || (gastoMesUsd !== null && gastoMesUsd >= ajustes.topeUsd)),
    },
  };
}
