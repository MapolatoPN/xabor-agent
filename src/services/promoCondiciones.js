// Condiciones de modificadores de una promoción — módulo PURO.
//
// Sin imports: ni base de datos, ni servidor, ni otros servicios. Existe para
// que el motor (tiendaPromociones.js) y la capa explicativa
// (promoDiagnostico.js) compartan estas primitivas SIN importarse mutuamente
// —antes había un ciclo entre ambos, que funcionaba por hoisting pero es una
// dependencia frágil que no conviene desplegar.
//
// `cumpleCondicionesModificadores` es la ÚNICA decisión de elegibilidad del
// sistema: el motor la usa para calcular y el diagnóstico para explicar. No
// existe ni debe existir una segunda implementación.

// ¿La selección de modificadores de UNA unidad cumple las condiciones?
// Devuelve { eligible, failedConditions } — fail-closed ante un operador
// desconocido o un grupo inválido.
export function cumpleCondicionesModificadores(item, condiciones) {
  const mods = Array.isArray(item?.modificadores) ? item.modificadores : [];
  const failedConditions = [];
  for (const c of (Array.isArray(condiciones) ? condiciones : [])) {
    const grupoId = Number(c?.grupo_id);
    if (!Number.isInteger(grupoId)) { failedConditions.push({ ...c, motivo: 'grupo_invalido' }); continue; }
    const seleccion = mods.filter(m => Number(m.grupo_id) === grupoId).map(m => Number(m.opcion_id));
    const permitidas = Array.isArray(c.option_ids) ? c.option_ids.map(Number) : [];
    let ok;
    switch (c.operador) {
      case 'una_de':
        ok = seleccion.length > 0 && seleccion.every(id => permitidas.includes(id));
        break;
      case 'incluye':
        ok = permitidas.length > 0 && permitidas.every(id => seleccion.includes(id));
        break;
      case 'cantidad': {
        const min = c.min != null ? Number(c.min) : 0;
        const max = c.max != null ? Number(c.max) : Infinity;
        ok = seleccion.length >= min && seleccion.length <= max;
        break;
      }
      default:
        ok = false; // fail-closed
    }
    if (!ok) failedConditions.push({ grupo_id: grupoId, operador: c.operador });
  }
  return { eligible: failedConditions.length === 0, failedConditions };
}

// Une nombres en lenguaje natural.
export function listaO(arr) {
  const a = (arr || []).filter(Boolean);
  if (!a.length) return '';
  if (a.length === 1) return String(a[0]);
  return `${a.slice(0, -1).join(', ')} o ${a[a.length - 1]}`;
}
export function listaY(arr) {
  const a = (arr || []).filter(Boolean);
  if (!a.length) return '';
  if (a.length === 1) return String(a[0]);
  return `${a.slice(0, -1).join(', ')} y ${a[a.length - 1]}`;
}

/**
 * Condiciones de una promoción en forma ESTRUCTURADA por grupo, con nombres
 * reales (nunca IDs). Es lo que se le entrega al agente para que pueda guiar
 * el pedido ("para la promo, la salsa puede ser Roja o Verde") en vez de
 * deducirlo de una frase en prosa.
 *
 * Devuelve: [{ producto_id, grupo_id, grupo, operador, permitidas:[nombre],
 *              min, max, exacto }]
 */
export function condicionesEstructuradas(promo, gruposPorProd) {
  const cond = Array.isArray(promo?.condiciones_modificadores) ? promo.condiciones_modificadores : [];
  const mapa = gruposPorProd instanceof Map ? gruposPorProd : new Map();
  const out = [];
  for (const c of cond) {
    const grupos = mapa.get(Number(c?.producto_id)) || [];
    const grupo = grupos.find((g) => Number(g.id) === Number(c?.grupo_id));
    if (!grupo) continue; // grupo borrado del menú: no se inventa nombre
    const nombreOp = (id) => (grupo.opciones || []).find((o) => Number(o.id) === Number(id))?.nombre;
    const permitidas = (Array.isArray(c.option_ids) ? c.option_ids : []).map(nombreOp).filter(Boolean);
    const min = c.min != null ? Number(c.min) : null;
    const max = c.max != null ? Number(c.max) : null;
    out.push({
      producto_id: c.producto_id != null ? Number(c.producto_id) : null,
      grupo_id: Number(c.grupo_id), grupo: grupo.nombre,
      operador: c.operador, permitidas, min, max,
      exacto: (min != null && max != null && min === max) ? min : null,
    });
  }
  return out;
}

// Frase de UNA condición estructurada, para guiar o explicar.
// "salsa: Roja o Verde" · "guarniciones: exactamente 2"
export function fraseCondicionEstructurada(c) {
  const g = String(c?.grupo || '').toLowerCase();
  if (c?.operador === 'una_de' && c.permitidas?.length) return `${g}: ${listaO(c.permitidas)}`;
  if (c?.operador === 'incluye' && c.permitidas?.length) return `${g}: debe incluir ${listaY(c.permitidas)}`;
  if (c?.operador === 'cantidad') {
    if (c.exacto != null) return `${g}: exactamente ${c.exacto}`;
    if (c.min != null && c.max != null) return `${g}: entre ${c.min} y ${c.max}`;
    if (c.min != null) return `${g}: al menos ${c.min}`;
    if (c.max != null) return `${g}: hasta ${c.max}`;
  }
  return '';
}
