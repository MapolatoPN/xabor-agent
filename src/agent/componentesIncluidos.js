import { normalizar } from './mencionesComerciales.js';

// Evidencia textual conservadora, no un catálogo nuevo ni autorización de
// extras. Solo declaraciones afirmativas explícitas del producto solicitado.
// No selecciona modificadores, no cambia precios ni agrega notas a la orden.
export function componenteIncluido(producto, mencion) {
  const pedido = normalizar(mencion);
  if (!pedido || pedido.length > 120 || /\b(sin|no|extra|extras|doble|triple|adicional|mas|quitar|cambiar)\b/.test(pedido)) return null;
  const componente = pedido.replace(/^con (?:el |la |los |las )?/, '');
  if (!componente) return null;
  const contiene = s => ` ${s} `.includes(` ${componente} `);
  const condicional = /\b(no|sin|opcional\w*|adicional\w*|extra\w*|costo|coste|cobra\w*|aparte|elige|elegir|eleccion|escoge|escoger|puede\w*|podra\w*|segun|disponibilidad|algun|alguna|algunos|algunas|gusto)\b/;
  const afirmacion = /\b(?:incluye[n]?|contiene[n]?|acompanad[oa]s? (?:de|con)|servid[oa]s? con)\b/;
  let respaldado = false;
  for (const frase of String(producto?.descripcion || '').slice(0, 4000).split(/[.;!?\n]+/)) {
    const normal = normalizar(frase);
    if (!contiene(normal)) continue;
    // Una alternativa nunca acredita que ese componente ya venga incluido.
    if (/\b(o|costo|coste|cobra\w*|aparte|elegir|eleccion|excepto|salvo)\b/.test(normal)) return null;
    const declaracion = normal.match(afirmacion);
    // "No incluye pan y fruta": el NO también alcanza el segundo miembro.
    // No basta revisar el fragmento posterior a la conjunción.
    if (declaracion && (condicional.test(normal.slice(0, declaracion.index))
      || /\b(si|cuando|previa|solicitud)\b/.test(normal.slice(0, declaracion.index)))) return null;
    for (const parte of normal.split(/\by\b/)) {
      if (!contiene(parte)) continue;
      if (condicional.test(parte)) return null;
      // El predicado debe anteceder al ingrediente. Una mención publicitaria
      // anterior a "incluye" no es una declaración de composición.
      const pos = (` ${normal} `).indexOf(` ${componente} `);
      if (declaracion && declaracion.index < pos) respaldado = true;
    }
  }
  return respaldado ? componente : null;
}
