import { anclarLinea, resolverVariante, mencionesEnProducto } from '../mesero-whatsapp/anclajeAlCatalogo.js';
import { buscarProductos, fichaDeProducto } from '../mesero-whatsapp/consultasDelMenu.js';
import { fichaPorNombre, opcionesDeLinea } from './vistaDelPedido.js';
import { politicaDelTurno, normalizarEleccion as norm, opcionNegativaExplicita } from './politicaDelTurno.js';
import { distingueLaEleccion } from '../orders/evidenciaDeEleccion.js';
import { elClientePidioQuitarLaOpcion } from '../orders/carritoDelPedido.js';
import { cardinalidadDeGrupo } from '../services/modificadores.js';
import { soloElecciones } from './contratoConversacional.js';

const pideAdicion = mensaje => /\b(?:otro|otra|otros|otras|adicional|agrega(?:r|s|me|le|les)?|anade(?:me|le|les)?|anadir|uno mas|una mas)\b/.test(norm(mensaje));
const PETICION_ADITIVA = /^(?:(?:me|le|les)\s+)?(?:(?:puedes|podrias|pueden|podrian)\s+)?(?:agregar(?:me|le|les)?|anadir(?:me|le|les)?|agrega(?:s|me|le|les)?|anade(?:s|me|le|les)?)\s+/;
const sinMuletillas = mensaje => mensaje.replace(/\b(?:son|las dos|los dos|ambas|ambos)\b/gi, ' ');

// Buscar por palabras sirve para descubrir candidatos, no para autorizar una
// sustitución. «Marca Waffle» y «Marca Café» se encuentran mutuamente por
// «Marca», pero eso NO prueba que sean presentaciones del mismo platillo.
// La reclasificación automática de opciones exige además grupos compatibles
// con opciones compartidas. Sin esa estructura se conserva el producto;
// cualquier sustitución deberá pasar por el flujo explícito del cliente.
function familiaDeOpciones(catalogo, item) {
  const actual = fichaPorNombre(catalogo,item.nombre);
  if (!actual) return [];
  return buscarProductos(catalogo,item.nombre,{limite:Infinity}).filter(f => String(f.id) === String(actual.id)
    || (actual.grupos.length > 0 && actual.grupos.every(g => f.grupos.some(h => norm(h.nombre) === norm(g.nombre)
      && g.opciones.some(o => h.opciones.some(p => norm(p.nombre) === norm(o.nombre)))))));
}

function mencionesAditivas(ficha, resto) {
  // El grupo explícito delimita el objeto: «salsa verde» no pide proteínas
  // cuyo nombre contiene «en salsa». El resto aún debe quedar cubierto entero.
  const explicitos = ficha.grupos.filter(g => resto.startsWith(`${norm(g.nombre)} `));
  return mencionesEnProducto(explicitos.length === 1 ? { ...ficha, grupos: explicitos } : ficha, resto);
}

// Una petición cortés («¿me puedes agregar…?») no es una consulta de carta.
// Se admite únicamente si el resto completo son elecciones del catálogo.
// No interpreta texto del modelo, no adivina un plato por el foco y no vuelve
// a convertir las elecciones guardadas en prosa para inferirlas otra vez.
function adicionDeOpciones({ estado, catalogo, mensaje, resto, lineaId }) {
  // Compartir «verde» con un jugo o «salsa» con otro plato no significa que
  // el cliente haya pedido ese producto. Un nombre completo sí exige aclarar.
  if (buscarProductos(catalogo, resto, { limite: Infinity })
    .some(p => ` ${resto} `.includes(` ${norm(p.nombre)} `))) return null;
  const objetivos = (estado?.carrito?.items || []).filter(item => {
    const ficha = fichaPorNombre(catalogo, item.nombre);
    return ficha && mencionesAditivas(ficha, resto).some(g => g.elegidas.length || g.ambiguas.length);
  });
  if (objetivos.length !== 1) return null;
  const item = objetivos[0];
  if (lineaId && item.lid !== lineaId) return null;
  const guardadas = opcionesDeLinea(item);
  const familia = familiaDeOpciones(catalogo,item);
  const selecciones = new Map();
  for (const ficha of familia) {
    if (ficha.variante?.requiereMencion && String(ficha.id) !== String(item.id)) continue;
    const mencionadas = mencionesAditivas(ficha, resto);
    if (mencionadas.some(g => g.ambiguas.length)) continue;
    const nuevas = mencionadas.flatMap(g => g.elegidas.map(opcion => ({ grupo: g.grupo, opcion })));
    if (!nuevas.length || !soloElecciones(sinMuletillas(resto), [{ argumentos: { opciones: nuevas } }])) continue;
    const todas = [...guardadas];
    for (const nueva of nuevas) if (!todas.some(o => norm(o.grupo) === norm(nueva.grupo)
      && norm(o.opcion) === norm(nueva.opcion))) todas.push(nueva);
    if (todas.some(o => !opcionNegativaExplicita(o.opcion, mensaje)
      && elClientePidioQuitarLaOpcion(o.opcion, mensaje))) continue;
    const grupos = new Set(todas.map(o => norm(o.grupo)));
    if (![...grupos].every(nombre => {
      const grupo = ficha.grupos.find(g => norm(g.nombre) === nombre);
      const elegidas = todas.filter(o => norm(o.grupo) === nombre);
      return grupo && elegidas.length <= cardinalidadDeGrupo(grupo).maximo
        && elegidas.every(o => grupo.opciones.some(x => norm(x.nombre) === norm(o.opcion)));
    })) continue;
    selecciones.set(String(ficha.id), { ficha, opciones: todas });
  }
  // Si el plato actual admite la unión, conservarlo: añadir no autoriza bajar
  // de presentación. Si no cabe, las restricciones y la carta eligen variante.
  const elegibles = selecciones.has(String(item.id)) ? [selecciones.get(String(item.id)).ficha]
    : [...selecciones.values()].map(x => x.ficha);
  const decision = resolverVariante(elegibles, mensaje);
  if (decision.elegidas.length !== 1) return null;
  const { ficha: producto, opciones } = selecciones.get(String(decision.elegidas[0].id));
  const sinCambios = String(producto.id) === String(item.id) && opciones.length === guardadas.length;
  return { item, producto, opciones, soloOpciones: true, sinCambios };
}

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
    familiaDeOpciones(catalogo,item).some(p => String(p.id) === String(ficha.id)));
}

// La selección ya guardada es ESTRUCTURA: nunca volver a inferirla desde una
// frase que mezcle sus palabras con las del turno. Solo se interpreta lo nuevo.
export function varianteDelPedido({ estado, catalogo, mensaje, lineaId } = {}) {
  const texto = norm(mensaje);
  if (/\b(?:no|o|cambia|cambiar|reemplaza|reemplazar|sustituye|sustituir)\b/.test(texto)) return null;
  const peticion = PETICION_ADITIVA.exec(texto);
  if (peticion) return adicionDeOpciones({ estado, catalogo, mensaje,
    resto: texto.slice(peticion[0].length), lineaId });
  if (politicaDelTurno(mensaje).soloLectura || pideAdicion(mensaje)
    || /[?¿]|\b(?:no|o)\b/i.test(mensaje)) return null;
  const item = lineaDelMensaje(estado, mensaje);
  if (!item || (lineaId && item.lid !== lineaId)) return null;
  const actual = fichaPorNombre(catalogo, item.nombre);
  if (!actual) return null;
  const guardadas = opcionesDeLinea(item);
  const familia = new Set(familiaDeOpciones(catalogo,item).map(p => String(p.id)));
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
