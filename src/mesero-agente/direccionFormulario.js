// La dirección de entrega DENTRO del formulario (fase 1, decisión de Mario del
// 1-oct-2026): calle y número, colonia, referencias y la zona de envío elegida
// de una lista. Nada de esto se adivina de un texto libre: cada campo llega de
// su lugar y se valida aquí, en el endpoint y otra vez al aplicar el recibo.
//
// Solo con el contrato `direccion_v1`, que se activa por formulario con sus
// claves propias (whatsapp_flow_categorias_dir_id / whatsapp_flow_carrito_dir_id).
// Sin ellas la foto, el Flow y el comportamiento son los de siempre.
import { createHash } from 'node:crypto';
import { normalizarTipoModalidad } from '../orders/modalidadesDelPedido.js';
import { zonasDelNegocio, zonasEnDireccion } from './zonasDeEntrega.js';

export const CONTRATO_DIRECCION = 'direccion_v1';
export const LIMITES_DIRECCION = Object.freeze({ calle: 120, colonia: 80, referencias: 200 });
export const SIN_ZONA = 'zn';

// Controles C0/C1, marcas bidi y de ancho cero: no deben llegar a la comanda,
// al panel ni al resumen (una U+202E reordena visualmente la dirección).
const INVISIBLES = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]', 'g');
// Ignorables que se ven vacíos pero cuentan como letra (U+3164 HANGUL FILLER,
// el truco para dejar «en blanco» un nombre en WhatsApp; U+00AD, selectores de
// variante): se quitan sin dejar espacio. Y una pila de marcas combinantes
// («zalgo») se encima en el panel y en el papel: más de dos seguidas, fuera.
const IGNORABLES = /[\p{Default_Ignorable_Code_Point}⠀]/gu;
const MARCAS_DE_MAS = /(\p{M}{2})\p{M}+/gu;

/** Texto de un campo, saneado. `null` si no es texto o pasa del límite. */
export function limpiarCampo(valor, maximo) {
  if (valor === undefined || valor === null) return '';
  if (typeof valor !== 'string') return null;
  // NFC otra vez después de quitar los ignorables: uno entre una letra y su
  // acento impedía componerla, y la segunda limpieza (al aplicar el recibo)
  // daba otro texto y otra firma de aviso. Tiene que ser idempotente.
  const limpio = valor.normalize('NFC').replace(INVISIBLES, ' ').replace(IGNORABLES, '').normalize('NFC')
    .replace(MARCAS_DE_MAS, '$1').replace(/\s+/g, ' ').trim();
  return limpio.length > maximo ? null : limpio;
}

/** El flowId que corresponde a una foto: el del contrato nuevo o el de siempre. */
export function flowIdEsperado(cfg, datos) {
  if (datos?.version === 'carrito_v1') {
    return datos.contrato === CONTRATO_DIRECCION ? cfg?.whatsapp_flow_carrito_dir_id : cfg?.whatsapp_flow_carrito_id;
  }
  if (datos?.version === 'repetible_v1') {
    return datos.contrato === CONTRATO_DIRECCION ? cfg?.whatsapp_flow_categorias_dir_id
      : (cfg?.whatsapp_flow_categorias_id || cfg?.whatsapp_flow_repetible_id);
  }
  return null;
}

/** Todos los flowId con endpoint que el transporte puede mandar con data_exchange. */
export const flowIdsConEndpoint = (cfg) => [cfg?.whatsapp_flow_categorias_id || cfg?.whatsapp_flow_repetible_id,
  cfg?.whatsapp_flow_carrito_id, cfg?.whatsapp_flow_categorias_dir_id, cfg?.whatsapp_flow_carrito_dir_id]
  .filter((id) => /^\d{5,30}$/.test(id || ''));

const valido = (id) => /^\d{5,30}$/.test(id || '');
/** La clave nueva solo vale si la de siempre también está configurada. */
export const contratoCategorias = (cfg) => valido(cfg?.whatsapp_flow_categorias_dir_id) && valido(cfg?.whatsapp_flow_categorias_id);
export const contratoCarrito = (cfg) => valido(cfg?.whatsapp_flow_carrito_dir_id) && valido(cfg?.whatsapp_flow_carrito_id);

export const esDomicilio = (valorModalidad) => normalizarTipoModalidad(valorModalidad) === 'domicilio';

/** «Hidalgo 405, Centro, UTNC»: lo que guarda el pedido y ve el repartidor. */
export function componerDireccion({ calle = '', colonia = '', zona = '' } = {}) {
  const partes = [calle, colonia].filter(Boolean);
  // El nombre de la zona va en la dirección para el repartidor, salvo que ya
  // esté escrito (no duplicar «UTNC edificio 3, UTNC»).
  if (zona && !zonasEnDireccion({ pedidos: { zonas_entrega: [{ nombre: zona, costo: 0 }] } }, partes.join(' ')).length) partes.push(zona);
  return partes.join(', ');
}

/**
 * Lo que la foto lleva para la pantalla de dirección: las zonas (instantánea
 * con la misma regla que el ejecutor), el envío base y los valores con que
 * empieza. Precarga solo desde las partes que guardó este mismo formulario y
 * únicamente si siguen siendo la dirección del pedido.
 */
export function fotoDireccion({ estado, reglas }) {
  const zonas = zonasDelNegocio(reglas);
  const cliente = estado?.carrito?.datos?.cliente || {};
  const partes = cliente.direccion_partes;
  const vigentes = partes && typeof partes === 'object'
    && typeof cliente.direccion === 'string' && componerDireccion(partes) === cliente.direccion;
  const zona = vigentes && partes.zona ? zonas.findIndex((z) => z.nombre === partes.zona) : -1;
  const texto = (v, max) => (typeof v === 'string' && v.length <= max ? v : '');
  return {
    contrato: CONTRATO_DIRECCION,
    zonas,
    costo_envio: Number(reglas?.pedidos?.costo_envio) || 0,
    direccion_inicial: {
      calle: vigentes ? texto(partes.calle, LIMITES_DIRECCION.calle) : '',
      colonia: vigentes ? texto(partes.colonia, LIMITES_DIRECCION.colonia) : '',
      // Las referencias se muestran siempre, también las dichas por chat: dejar
      // el campo vacío las borra, y nadie borra lo que no ve.
      referencias: texto(cliente.referencias, LIMITES_DIRECCION.referencias),
      // «En la ciudad» solo si eso eligió. Una zona guardada que ya no está en la
      // lista (renombrada o retirada) deja la lista sin elegir: que la escoja.
      zona: zona >= 0 ? `z${zona}` : (vigentes && partes.zona === '' ? SIN_ZONA : ''),
    },
  };
}

const firma = (p) => createHash('sha256').update(JSON.stringify([p.calle, p.colonia, p.zona])).digest('hex').slice(0, 16);

/**
 * Valida lo que el cliente mandó en la pantalla de dirección contra la foto.
 *   { ok: true, partes: {calle, colonia, referencias, zona, zonaNombre, confirmada} }
 *   { ok: false, error, aviso? }   aviso: firma que, reenviada igual, confirma
 * Si eligió «En la ciudad» pero la dirección nombra una zona (o eligió una zona
 * y nombra otra con distinta tarifa), se le pregunta una vez; si vuelve a
 * mandar lo mismo, se respeta lo que eligió.
 */
export function validarDireccion(foto, d, { confirmada = null } = {}) {
  const calle = limpiarCampo(d?.calle, LIMITES_DIRECCION.calle);
  const colonia = limpiarCampo(d?.colonia, LIMITES_DIRECCION.colonia);
  const referencias = limpiarCampo(d?.referencias, LIMITES_DIRECCION.referencias);
  if (calle === null || colonia === null || referencias === null) {
    return { ok: false, error: 'Revisa la dirección: calle hasta 120 letras, colonia hasta 80 y referencias hasta 200.' };
  }
  if (calle.length < 3 || !/[\p{L}\p{N}]/u.test(calle)) {
    return { ok: false, error: 'Escribe la calle y el número (o el edificio o la puerta).' };
  }
  const zonas = Array.isArray(foto?.zonas) ? foto.zonas : [];
  let zona = d?.zona;
  if (!zonas.length && (zona === undefined || zona === null || zona === '')) zona = SIN_ZONA;
  const indice = typeof zona === 'string' && /^z(0|[1-9]\d*)$/.test(zona) ? Number(zona.slice(1)) : -1;
  if (zona !== SIN_ZONA && !zonas[indice]) return { ok: false, error: 'Elige la zona de entrega.' };
  const elegida = zona === SIN_ZONA ? null : zonas[indice];
  const partes = { calle, colonia, referencias, zona, zonaNombre: elegida?.nombre || '' };
  const nombradas = zonasEnDireccion({ pedidos: { zonas_entrega: zonas } }, `${calle} ${colonia}`);
  const choca = elegida
    ? nombradas.find((z) => z.nombre !== elegida.nombre && Number(z.costo) !== Number(elegida.costo))
    : nombradas[0];
  if (choca) {
    const f = firma(partes);
    if (confirmada !== f) {
      return { ok: false, aviso: f, error: elegida
        ? `Tu dirección menciona ${choca.nombre} pero elegiste ${elegida.nombre}. Corrige la zona o vuelve a tocar «Revisar pedido» para dejarla así.`
        : `Tu dirección menciona ${choca.nombre}. Si es ahí, elígela en «Zona de entrega»; si no, vuelve a tocar «Revisar pedido».` };
    }
    partes.confirmada = f;
  }
  return { ok: true, partes };
}

/**
 * Los argumentos de definir_entrega que salen del formulario, o `null` si no
 * cuadran. Se recalculan desde la foto: el recibo trae solo partes ya
 * validadas en el endpoint, y aquí se validan otra vez.
 */
export function argumentosDeEntrega(foto, modalidad, direccion) {
  if (!direccion || typeof direccion !== 'object' || Array.isArray(direccion)
    || Object.keys(direccion).some((k) => !['calle', 'colonia', 'referencias', 'zona', 'confirmada'].includes(k))) return null;
  const v = validarDireccion(foto, direccion, { confirmada: direccion.confirmada ?? null });
  if (!v.ok) return null;
  const { calle, colonia, referencias, zonaNombre } = v.partes;
  return {
    modalidad,
    direccion: componerDireccion({ calle, colonia, zona: zonaNombre }),
    referencias,
    // '' = «En la ciudad»: tarifa base, sin deducir una zona del texto.
    zona_entrega: zonaNombre,
    direccion_partes: { calle, colonia, zona: zonaNombre },
  };
}

/**
 * El cierre del formulario (definir_entrega + definir_pago) con la dirección.
 * Con contrato: domicilio exige dirección y una dirección exige domicilio. Sin
 * contrato el recibo no puede traer dirección.
 */
export function cierreConDireccion(foto, cierre, direccion) {
  if (!cierre) return null;
  if (foto?.contrato !== CONTRATO_DIRECCION) return direccion === undefined ? cierre : null;
  const i = cierre.findIndex((c) => c.herramienta === 'definir_entrega');
  const modalidad = cierre[i]?.argumentos?.modalidad;
  if (!esDomicilio(modalidad)) return direccion === undefined ? cierre : null;
  const argumentos = argumentosDeEntrega(foto, modalidad, direccion);
  if (!argumentos) return null;
  return cierre.map((c, j) => (j === i ? { ...c, argumentos } : c));
}

/**
 * Datos de la pantalla DIRECCION (ambos formularios). `aviso` es la firma del
 * aviso de zona pendiente en el borrador: mientras siga ahí, la pantalla lo
 * vuelve a decir (un reintento idéntico o un regreso por «Atrás» no lo pierden,
 * y el siguiente toque confirma algo que el cliente sí leyó).
 */
export function datosPantallaDireccion(foto, { revision, resumen, error = '', guardada = null, intento = null, aviso = null } = {}) {
  // Mientras la pantalla muestre lo guardado (no un intento nuevo), el aviso
  // pendiente se dice, aunque haya otro error (una revisión vieja): el
  // siguiente toque con eso mismo lo confirma.
  if (aviso && guardada && !intento) {
    const v = validarDireccion(foto, guardada);
    if (v.aviso === aviso && !error.includes(v.error)) error = error ? `${error} ${v.error}` : v.error;
  }
  const zonas = Array.isArray(foto?.zonas) ? foto.zonas : [];
  const envio = (costo) => `Envío $${Number(costo)}`;
  const base = guardada || foto?.direccion_inicial || {};
  const texto = (v, max) => (typeof v === 'string' && v.length <= max ? v : '');
  const elegible = (z) => z === SIN_ZONA || (typeof z === 'string' && /^z(0|[1-9]\d*)$/.test(z) && !!zonas[Number(z.slice(1))]);
  const zona = elegible(intento?.zona) ? intento.zona : elegible(base.zona) ? base.zona : (zonas.length ? '' : SIN_ZONA);
  return {
    revision: String(revision), resumen, error, error_visible: !!error,
    hay_zonas: zonas.length > 0,
    zonas: [{ id: SIN_ZONA, title: 'En la ciudad', description: 'Ninguna de las zonas de la lista', metadata: envio(foto?.costo_envio || 0) },
      ...zonas.map((z, i) => ({ id: `z${i}`, title: z.nombre.slice(0, 30),
        description: z.nombre.length > 30 ? z.nombre.slice(0, 300) : '', metadata: envio(z.costo) }))],
    zona_inicial: zona,
    calle_inicial: texto(intento?.calle ?? base.calle, LIMITES_DIRECCION.calle),
    colonia_inicial: texto(intento?.colonia ?? base.colonia, LIMITES_DIRECCION.colonia),
    referencias_inicial: texto(intento?.referencias ?? base.referencias, LIMITES_DIRECCION.referencias),
  };
}

/**
 * La foto sin el contrato: para validar platillos, entrega y pago en los pasos
 * intermedios, antes de que exista la dirección (solo el recibo final la exige).
 */
export function sinContratoDireccion(foto) {
  const { contrato, zonas, costo_envio, direccion_inicial, abrir, ...resto } = foto || {};
  return resto;
}

/**
 * La foto para compararla con otra (vigencia y retomar un borrador): sin lo
 * que solo elige la primera pantalla (`abrir`) ni la precarga de la dirección.
 * Unas referencias dichas por chat a medio formulario cambian la precarga, no
 * el pedido, y no deben tirar los platillos ya elegidos. Sin contrato, ninguna
 * de las dos claves existe: la comparación es la de siempre. La precarga de la
 * nota del pedido (contrato nota_v1, notaDelPedido.js) tampoco cuenta: es lo
 * que el pedido ya dice, no lo que el formulario pide. Ni `sin_tienda`, la marca
 * de un formulario de hoy que salió en lugar de la tienda (tienda_v1): solo le
 * sirve a la barrera del endpoint; si la tienda se revierte con uno abierto,
 * su recibo (el mismo pedido) sigue valiendo. Sin la tienda no existe.
 */
export function fotoComparable(foto) {
  if (!foto || typeof foto !== 'object' || Array.isArray(foto)) return foto;
  const { abrir, direccion_inicial, nota_inicial, sin_tienda, ...resto } = foto;
  return resto;
}

/** Claves que la pantalla de dirección puede mandar. */
export const CAMPOS_PANTALLA_DIRECCION = ['revision', 'operacion', 'zona', 'calle', 'colonia', 'referencias'];
