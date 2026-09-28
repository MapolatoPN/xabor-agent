// Una solicitud todavía sin renglón pertenece a Xabor, no al historial del
// modelo. Se guarda como el único pendiente, ligada al ciclo, y se vuelve a
// resolver contra la carta vigente al recibir las preferencias. Ningún texto
// del asistente ni argumento de buscar_producto crea esta autorización.
import { buscarProductos } from '../mesero-whatsapp/consultasDelMenu.js';
import { anclarLinea } from '../mesero-whatsapp/anclajeAlCatalogo.js';
import { mismaPalabraFlexible } from '../agent/mencionesComerciales.js';
import { soloElecciones } from './contratoConversacional.js';
import { normalizarEleccion as norm, politicaDelTurno } from './politicaDelTurno.js';
import { PENDIENTES } from './estadoCanonico.js';

const numeros = ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez'];
const enCurso = estado => !Object.values(estado?.hechos || {}).some(Boolean)
  && !estado?.evento && !estado?.folio && !estado?.confirmacionIncierta;
const palabras = texto => norm(texto).split(' ').filter(w => !['de', 'del', 'en', 'con', 'la', 'el', 'los', 'las'].includes(w));

export function iniciarSeleccion({ estado, catalogo, mensaje }) {
  if (!enCurso(estado) || String(mensaje).length > 2000 || /[?¿]/.test(mensaje) || politicaDelTurno(mensaje).soloLectura) return null;
  const t = norm(mensaje).replace(/^(?:hola|buenos dias|buenas tardes|buenas noches)\s+/, '');
  const m = /^(?:(?:quiero|quisiera)(?:\s+(?:ordenar|pedir|agregar))?|dame|deme|agrega|agregame|pido)\s+(.+)$/.exec(t);
  // Una familia literal también abre una aclaración, nunca una mutación.
  // Con carrito, solo una intención aditiva o la continuación ya guardada.
  if (estado.carrito?.items?.length && !/\b(?:agrega|agregame|agregar)\b/.test(t)
    && !['agregar_otro','elegir_producto'].includes(estado.pendiente?.tipo)) return null;
  let nombre = (m?.[1] || t).replace(/\s+(?:por favor|porfa|gracias)$/, '');
  let cantidad = 1;
  const prefijo = /^(un|una|unos|unas|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d+)\s+(.+)$/.exec(nombre);
  if (prefijo) {
    cantidad = numeros.includes(prefijo[1]) ? numeros.indexOf(prefijo[1]) + 1
      : /^\d+$/.test(prefijo[1]) ? Number(prefijo[1]) : 1;
    nombre = prefijo[2];
  }
  if (cantidad < 1 || cantidad > 20 || !palabras(nombre).length) return null;
  // Solo una mención de producto/familia. Preferencias, direcciones, dos
  // productos, negaciones y condiciones siguen por el intérprete habitual.
  if (/\b(?:no|sin|si|o|y|para|con)\b/.test(nombre)) return null;
  const hallados = buscarProductos(catalogo, nombre, { limite: 100 });
  const candidatos = hallados.filter(f => palabras(nombre).every(w =>
    palabras(f.nombre).some(v => mismaPalabraFlexible(w, v))));
  if (candidatos.length < 2 || candidatos.length > 20) return null;
  if (candidatos.some(f => norm(f.nombre) === nombre)) return null;
  return { tipo: PENDIENTES.ELEGIR_PRODUCTO, ciclo: estado.conversacionId,
    solicitud: String(mensaje), nombre, cantidad,
    candidatos: candidatos.map(f => ({ id: String(f.id), nombre: f.nombre })) };
}

export function pideAgregarOtro(estado, mensaje) {
  return enCurso(estado) && !!estado.carrito?.items?.length
    && /^(?:(?:quiero|quisiera)\s+)?(?:agregar|agrega|agregame|anadir|anade|anademe)\s+(?:otro|otra|algo mas|otro producto|otra cosa)(?:\s+por favor)?$/.test(norm(mensaje));
}

export function resolverSeleccion({ estado, catalogo, mensaje }) {
  const p = estado?.pendiente;
  if (!enCurso(estado) || p?.tipo !== PENDIENTES.ELEGIR_PRODUCTO
    || p.ciclo !== estado.conversacionId || /[?¿]/.test(mensaje)
    || politicaDelTurno(mensaje).soloLectura
    || /\b(?:no|sin|si|o|cancela|cambiar|cambia|otro|otros)\b/.test(norm(mensaje))) return null;
  // No confiar ni siquiera en una identidad vieja: reconstruir la solicitud
  // literal del cliente, intersectar IDs Y nombres, y usar solo esa subcarta.
  const vigente = iniciarSeleccion({ estado, catalogo, mensaje: p.solicitud });
  if (!vigente || vigente.nombre !== p.nombre || vigente.cantidad !== p.cantidad) return null;
  const ids = new Set(vigente.candidatos.filter(c => p.candidatos.some(v => v.id === c.id && v.nombre === c.nombre)).map(c => c.id));
  if (!ids.size) return null;
  const acotado = catalogo.map(c => ({ ...c, productos: c.productos.filter(f => ids.has(String(f.id))) }));
  const r = anclarLinea({ catalogo: acotado, nombrePropuesto: p.nombre,
    evidencia: `${p.nombre}\n${mensaje}`, dichoDelCliente: mensaje });
  if (r.estado !== 'resuelto') return null;
  const opciones = r.grupos.flatMap(g => g.elegidas.map(opcion => ({ grupo: g.grupo, opcion })));
  const vocabulario = [...r.grupos.flatMap(g => g.ambiguas || []), ...vigente.candidatos.map(c => c.nombre)];
  if (!soloElecciones(mensaje, [{ argumentos: { opciones } }], vocabulario)) return null;
  if (!opciones.length && !vigente.candidatos.some(c => norm(c.nombre) === norm(mensaje))) return null;
  return { producto_id: String(r.producto.id), producto: r.producto.nombre,
    cantidad: p.cantidad, opciones };
}

export function preguntaDeSeleccion(pendiente, catalogo) {
  const fichas = buscarProductos(catalogo, pendiente.nombre, { limite: 100 })
    .filter(f => pendiente.candidatos.some(c => c.id === String(f.id)));
  const comun = fichas[0]?.grupos.find(g => g.requerido && g.opciones.length
    && fichas.every(f => f.grupos.some(h => h.nombre === g.nombre
      && g.opciones.every(o => h.opciones.some(v => v.nombre === o.nombre)))));
  return comun
    ? `Para ${pendiente.nombre}, ¿qué ${comun.nombre} prefieres? Opciones: ${comun.opciones.map(o => o.nombre).join(', ')}.`
    : `¿Cuál prefieres: ${fichas.map(f => f.nombre).join(', ')}?`;
}
