import { anclarLinea, resolverVariante } from '../mesero-whatsapp/anclajeAlCatalogo.js';
import { buscarProductos, fichaDeProducto } from '../mesero-whatsapp/consultasDelMenu.js';
import { fichaPorNombre, opcionesDeLinea } from './vistaDelPedido.js';
import { politicaDelTurno, normalizarEleccion as norm, opcionNegativaExplicita } from './politicaDelTurno.js';
import { distingueLaEleccion } from '../orders/evidenciaDeEleccion.js';
import { elClientePidioQuitarLaOpcion } from '../orders/carritoDelPedido.js';
import { cardinalidadDeGrupo } from '../services/modificadores.js';

const pideAdicion = mensaje => /\b(?:otro|otra|otros|otras|adicional|agrega|agregame|anade|anademe|uno mas|una mas)\b/.test(norm(mensaje));

// Una mención explícita identifica la línea aun si la última pregunta era de
// otro producto. Dos líneas indistinguibles exigen aclarar, no elegir el foco.
function lineaDelMensaje(estado, mensaje) {
  const items = estado?.carrito?.items || [];
  const encontradas = buscarProductos([{ productos: items }], mensaje, { limite: Infinity });
  if (encontradas.length) {
    const fuerza = Math.max(...encontradas.map(p => p.fuerza));
    const nombres = encontradas.filter(p => p.fuerza === fuerza).map(p => norm(p.nombre));
    const lineas = items.filter(i => nombres.includes(norm(i.nombre)));
    return lineas.length === 1 ? lineas[0] : null;
  }
  return items.find(i => i.lid === estado?.foco?.linea_id)
    || (items.length === 1 ? items[0] : null);
}

// No permitir implementar una corrección como quitar+agregar: quitar puede
// rechazarse y agregar persistir. Una adición explícita sigue siendo válida.
export function esCorreccionDeVariante({ estado, catalogo, mensaje, ficha }) {
  if (pideAdicion(mensaje)) return false;
  const nombrados = buscarProductos(catalogo, mensaje, { limite: Infinity });
  if (!nombrados.some(p => String(p.id) === String(ficha.id))) return false;
  return (estado?.carrito?.items || []).some(item =>
    buscarProductos(catalogo, item.nombre, { limite: Infinity }).some(p => String(p.id) === String(ficha.id)));
}

// La selección ya guardada es ESTRUCTURA: nunca volver a inferirla desde una
// frase que mezcle sus palabras con las del turno. Solo se interpreta lo nuevo.
export function varianteDelPedido({ estado, catalogo, mensaje, lineaId } = {}) {
  if (politicaDelTurno(mensaje).soloLectura || pideAdicion(mensaje)
    || /[?¿]|\b(?:no|o)\b/i.test(mensaje)) return null;
  const item = lineaDelMensaje(estado, mensaje);
  if (!item || (lineaId && item.lid !== lineaId)) return null;
  const actual = fichaPorNombre(catalogo, item.nombre);
  if (!actual) return null;
  const guardadas = opcionesDeLinea(item);
  const familia = new Set(buscarProductos(catalogo, item.nombre, { limite: Infinity }).map(p => String(p.id)));
  const conservaElecciones = producto => (item.modificadores || []).every(g => {
    const destino = producto.grupos.find(x => norm(x.nombre) === norm(g.grupo));
    return destino && g.opciones.length <= cardinalidadDeGrupo(destino).maximo
      && g.opciones.every(o => destino.opciones.some(x => norm(x.nombre) === norm(o)));
  });
  const compatibles = catalogo.map(c => ({ ...c,
    productos: (c.productos || []).filter(p => familia.has(String(p.id)) && conservaElecciones(fichaDeProducto(p))),
  }));
  const a = anclarLinea({ catalogo: compatibles, nombrePropuesto: item.nombre,
    evidencia: mensaje,
    dichoDelCliente: mensaje, ampliarFamilia: true });
  if (a.estado !== 'resuelto' || String(a.producto.id) === String(item.id)) return null;
  const nombrada = resolverVariante([actual, a.producto], mensaje);
  const destinoNombrado = nombrada.motivo === 'variante_nombrada'
    && nombrada.elegidas[0]?.id === a.producto.id;
  const excede = (a.grupos || []).some(g => {
    const original = actual.grupos.find(x => norm(x.nombre) === norm(g.grupo));
    const nombres = original?.opciones.map(o => o.nombre) || [];
    const dichasAhora = nombres.filter(o => distingueLaEleccion(o, nombres, mensaje).distingue);
    return original && dichasAhora.length > cardinalidadDeGrupo(original).maximo;
  });
  if (!destinoNombrado && !excede) return null;
  const opciones = (a.grupos || []).flatMap(g => g.elegidas.map(opcion => ({ grupo: g.grupo, opcion })));
  // Una exclusión requiere su propia modificación: esta operación conserva
  // elecciones y no puede afirmar haber atendido «sin X» dejando X intacta.
  if ([...guardadas, ...opciones].some(o => !opcionNegativaExplicita(o.opcion, mensaje)
    && elClientePidioQuitarLaOpcion(o.opcion, mensaje))) return null;
  // La reclasificación conserva lo anterior; no elimina elecciones por omisión.
  for (const opcion of guardadas) {
    if (opciones.some(o => norm(o.grupo) === norm(opcion.grupo))
      && !opciones.some(o => norm(o.grupo) === norm(opcion.grupo) && norm(o.opcion) === norm(opcion.opcion))) {
      opciones.push(opcion);
    }
  }
  return { item, producto: a.producto, opciones };
}
