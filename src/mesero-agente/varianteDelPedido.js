import { anclarLinea } from '../mesero-whatsapp/anclajeAlCatalogo.js';
import { fichaPorNombre, opcionesDeLinea } from './vistaDelPedido.js';
import { politicaDelTurno, normalizarEleccion as norm } from './politicaDelTurno.js';
import { distingueLaEleccion } from '../orders/evidenciaDeEleccion.js';

// Reutiliza la resolución de familias del catálogo. Cambia identidad, nunca
// cantidades, notas ni elecciones: estas siguen pasando por el reconciliador.
export function varianteDelPedido({ estado, catalogo, mensaje, lineaId } = {}) {
  if (politicaDelTurno(mensaje).soloLectura || /[?¿]|\b(?:otro|otra|otros|otras|agrega|agregame|no|o)\b/i.test(mensaje)) return null;
  const items = estado?.carrito?.items || [];
  const foco = estado?.foco?.linea_id;
  const item = items.find(i => i.lid === (lineaId || foco || (items.length === 1 ? items[0].lid : null)));
  if (!item || (items.length > 1 && item.lid !== foco)) return null;
  const actual = fichaPorNombre(catalogo, item.nombre);
  if (!actual) return null;
  const guardadas = opcionesDeLinea(item);
  const a = anclarLinea({ catalogo, nombrePropuesto: item.nombre,
    evidencia: `${mensaje} ${guardadas.map(o => o.opcion).join(' ')}`,
    dichoDelCliente: mensaje, ampliarFamilia: true });
  if (a.estado !== 'resuelto' || String(a.producto.id) === String(item.id)) return null;
  const nombrada = (a.producto.variante?.discriminadores || []).some(d =>
    ` ${norm(mensaje)} `.includes(` ${norm(d)} `));
  const excede = (a.grupos || []).some(g => {
    const original = actual.grupos.find(x => norm(x.nombre) === norm(g.grupo));
    const nombres = original?.opciones.map(o => o.nombre) || [];
    const dichasAhora = nombres.filter(o => distingueLaEleccion(o, nombres, mensaje).distingue);
    return original && dichasAhora.length > original.maximo;
  });
  if (!nombrada && !excede) return null;
  // No se pierde ninguna elección al cambiar de presentación.
  for (const g of item.modificadores || []) {
    const destino = a.producto.grupos.find(x => norm(x.nombre) === norm(g.grupo));
    if (!destino || g.opciones.length > destino.maximo
      || g.opciones.some(o => !destino.opciones.some(x => norm(x.nombre) === norm(o)))) return null;
  }
  return { item, producto: a.producto };
}
