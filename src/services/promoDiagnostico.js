// Diagnóstico de promociones — capa EXPLICATIVA, nunca económica.
//
// Existe por el caso XAB-0229: el motor calculó bien ($510 sin descuento
// porque el pedido no cumplía las condiciones), pero la capa conversacional no
// tenía forma de saber POR QUÉ no aplicó, así que el modelo lo inventó
// ("el sistema ajustará el total después"). Aquí se produce esa explicación.
//
// LÍMITE DURO: este módulo NO decide precios, NO aplica descuentos y NO
// participa en el cálculo. El veredicto de cada condición lo sigue emitiendo
// `cumpleCondicionesModificadores` (el motor); aquí solo se le pregunta
// condición por condición para poder nombrar la que falló. Si algún día el
// motor cambia su criterio, esta capa cambia con él automáticamente — no hay
// una segunda implementación que se pueda desincronizar.
// Dependencias UNIDIRECCIONALES: este módulo consume promoCondiciones (puro) y
// tiendaPromociones (datos); ninguno de los dos importa de vuelta desde aquí.
import { cumpleCondicionesModificadores, condicionesEstructuradas,
         fraseCondicionEstructurada, listaO, listaY } from './promoCondiciones.js';
import { promocionesVigentesCrudas } from './tiendaPromociones.js';
import { cargarGruposDeProductos } from './modificadores.js';

// Re-export por compatibilidad: los consumidores que ya pedían estas piezas al
// diagnóstico siguen funcionando, y su implementación es la del módulo puro.
export { condicionesEstructuradas, fraseCondicionEstructurada };

// Condiciones que aplican a un producto (producto_id null = cualquier
// participante). Espeja `condicionesDeProducto` del motor, que es privada.
function condicionesDe(promo, productoId) {
  const todas = Array.isArray(promo?.condiciones_modificadores) ? promo.condiciones_modificadores : [];
  return todas.filter((c) => c.producto_id == null || Number(c.producto_id) === Number(productoId));
}

/**
 * ¿Esta LÍNEA cumple las condiciones de modificadores de la promo? Y si no,
 * ¿por qué? El veredicto sale del motor (`cumpleCondicionesModificadores`),
 * consultado condición por condición para poder nombrar la que falló.
 *
 * Devuelve: { elegible, razones: [{ tipo, grupo, seleccion:[nombre],
 *             permitidas:[nombre], min, max, exacto }] }
 *   tipo: 'opcion_no_permitida' | 'opcion_faltante' | 'cantidad_incorrecta'
 */
export function evaluarElegibilidadLinea({ promo, item, gruposPorProd }) {
  const cond = condicionesDe(promo, item?.producto_id);
  if (!cond.length) return { elegible: true, razones: [] };
  const estructuradas = condicionesEstructuradas(promo, gruposPorProd);
  const mods = Array.isArray(item?.modificadores) ? item.modificadores : [];
  const razones = [];

  for (const c of cond) {
    // VEREDICTO DEL MOTOR — nunca se reimplementa aquí.
    const { eligible } = cumpleCondicionesModificadores(item, [c]);
    if (eligible) continue;
    const est = estructuradas.find(
      (e) => e.grupo_id === Number(c.grupo_id) &&
             (e.producto_id == null || e.producto_id === Number(c.producto_id)));
    // Lo que el cliente eligió EN ESE GRUPO, con nombre legible.
    const seleccion = mods
      .filter((m) => Number(m.grupo_id) === Number(c.grupo_id))
      .map((m) => m.opcion || m.nombre)
      .filter(Boolean);
    const base = {
      grupo: est?.grupo || null,
      seleccion,
      permitidas: est?.permitidas || [],
      min: est?.min ?? null, max: est?.max ?? null, exacto: est?.exacto ?? null,
    };
    if (c.operador === 'cantidad') razones.push({ tipo: 'cantidad_incorrecta', ...base });
    else if (c.operador === 'incluye') razones.push({ tipo: 'opcion_faltante', ...base });
    else razones.push({ tipo: 'opcion_no_permitida', ...base });
  }
  return { elegible: razones.length === 0, razones };
}

/**
 * ¿Una OPCIÓN concreta que el cliente quiere elegir invalida la promo?
 * Sirve para advertir en el momento ("la salsa Suiza no participa"), antes de
 * que el pedido exista. Solo mira las condiciones de tipo elección.
 * Devuelve null si la opción no está restringida por la promo.
 */
export function opcionInvalidaPromo({ promo, productoId, grupoId, opcionNombre, gruposPorProd }) {
  const est = condicionesEstructuradas(promo, gruposPorProd).filter(
    (e) => (e.producto_id == null || e.producto_id === Number(productoId)) && e.grupo_id === Number(grupoId));
  for (const c of est) {
    if (c.operador !== 'una_de' || !c.permitidas.length) continue;
    const norm = (s) => String(s || '').trim().toLowerCase();
    if (!c.permitidas.some((p) => norm(p) === norm(opcionNombre))) {
      return { grupo: c.grupo, seleccion: opcionNombre, permitidas: c.permitidas };
    }
  }
  return null;
}

/**
 * Explicación HUMANA de por qué una promoción no aplicó, redactada por CÓDIGO
 * a partir de razones estructuradas. Nunca la escribe el modelo.
 */
export function explicarInelegibilidad(nombrePromo, razones) {
  const rs = Array.isArray(razones) ? razones : [];
  if (!rs.length) return '';
  const causas = [], requisitos = [];
  for (const r of rs) {
    const g = String(r.grupo || '').toLowerCase();
    if (r.tipo === 'cantidad_incorrecta') {
      const n = r.seleccion?.length ?? 0;
      if (r.exacto != null) {
        causas.push(`elegiste ${n} ${g} y se necesitan exactamente ${r.exacto}`);
        requisitos.push(`exactamente ${r.exacto} ${g}`);
      } else {
        const lim = r.min != null && r.max != null ? `entre ${r.min} y ${r.max}`
          : r.min != null ? `al menos ${r.min}` : `hasta ${r.max}`;
        causas.push(`elegiste ${n} ${g} y se necesitan ${lim}`);
        requisitos.push(`${lim} ${g}`);
      }
    } else if (r.tipo === 'opcion_faltante') {
      causas.push(`falta ${listaY(r.permitidas)} en ${g}`);
      requisitos.push(`${g} con ${listaY(r.permitidas)}`);
    } else {
      const eleg = r.seleccion?.length ? listaY(r.seleccion) : 'esa opción';
      causas.push(`elegiste ${eleg} en ${g}`);
      if (r.permitidas.length) requisitos.push(`${g} ${listaO(r.permitidas)}`);
    }
  }
  let txt = `La promoción "${nombrePromo}" no se aplicó porque ${listaY(causas)}.`;
  if (requisitos.length) txt += ` Para aprovecharla necesitas ${listaY(requisitos)}.`;
  return txt;
}

/**
 * ¿Alguna promoción vigente NO se aplicó a este pedido pudiendo haberse
 * aplicado (el producto participa, pero los modificadores no cumplen)? Devuelve
 * la explicación oficial para adjuntar al resumen del cliente, o '' si no
 * aplica el caso.
 *
 * Es la respuesta a "¿y la promo?" del caso XAB-0229: la redacta el BACKEND a
 * partir de la configuración real, nunca el modelo. NO recalcula el pedido:
 * recibe la orden ya validada y solo la inspecciona.
 *
 * `promosAplicadas` son los nombres que el motor SÍ aplicó (preview.promociones):
 * una promo que ya aplicó jamás se explica como fallida.
 */
export async function explicarPromosNoAplicadas(negocioId, ordenValidada, {
  canal = 'whatsapp', ahora = new Date(), timezone = 'America/Matamoros', promosAplicadas = [],
} = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return '';
  const items = Array.isArray(ordenValidada?.items) ? ordenValidada.items : [];
  if (!items.length) return '';
  let minutos = null;
  try {
    const { partesEnZona } = await import('./tiendaOnline.js');
    minutos = partesEnZona(ahora, timezone).minutos;
  } catch { minutos = null; }

  let vigentes = [];
  try { vigentes = await promocionesVigentesCrudas(negocioId, { canal, ahora, timezone, minutos }); }
  catch { return ''; }

  const yaAplicada = new Set((promosAplicadas || []).map((p) => String(p?.nombre ?? p).trim().toLowerCase()));
  const explicaciones = [];
  for (const promo of vigentes) {
    if (yaAplicada.has(String(promo.nombre || '').trim().toLowerCase())) continue;
    const cond = Array.isArray(promo.condiciones_modificadores) ? promo.condiciones_modificadores : [];
    if (!cond.length) continue; // sin condiciones, su no-aplicación tiene otra causa (cantidad, monto…)
    // Solo líneas cuyo PRODUCTO participa: si el cliente pidió otra cosa, la
    // promo no venía al caso y no hay nada que explicar.
    const prods = Array.isArray(promo.productos) ? promo.productos.map(Number) : [];
    const cats = Array.isArray(promo.categorias) ? promo.categorias.map(Number) : [];
    const participa = (it) => (!prods.length && !cats.length)
      || prods.includes(Number(it.producto_id)) || cats.includes(Number(it.categoria_id));
    const candidatas = items.filter(participa);
    if (!candidatas.length) continue;

    const prodIds = [...new Set(cond.map((c) => Number(c?.producto_id)).filter(Number.isInteger))];
    let gruposPorProd = new Map();
    try { gruposPorProd = await cargarGruposDeProductos(negocioId, prodIds); } catch { continue; }

    // La primera línea que falla basta para explicar (mismo producto ⇒ mismas
    // razones); no se abruma al cliente repitiendo por unidad.
    for (const item of candidatas) {
      const { elegible, razones } = evaluarElegibilidadLinea({ promo, item, gruposPorProd });
      if (elegible || !razones.length) continue;
      const txt = explicarInelegibilidad(promo.nombre, razones);
      if (txt) explicaciones.push(txt);
      break;
    }
  }
  return explicaciones.join('\n');
}
