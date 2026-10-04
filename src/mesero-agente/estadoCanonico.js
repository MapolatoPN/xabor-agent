// ─── EL ESTADO CANÓNICO DEL PEDIDO ────────────────────────────────────────
//
// Una sola representación, persistida en `conversacion_estado` y validada en
// cada commit, de dónde va el pedido y QUÉ SE LE PREGUNTÓ al cliente.
//
// ── Por qué hacía falta ──────────────────────────────────────────────────
//
// El estado anterior guardaba lo pendiente en siete marcas que competían por
// el mismo «sí»: `foco`, `dialogo`, `ofrecidos`, `ofertaPromocionPendiente`,
// `promocionInformativaPendiente` (un booleano), `pagoOfrecido` y
// `opcionesPendientes`. La precedencia la decidía el orden del código, y cada
// incidente («sí» que duplica un café, promo aceptada que se pierde, respuesta
// corta aplicada al grupo equivocado) agregaba otra marca.
//
// Ahora hay UNA: `pendiente`, la pregunta que la última respuesta enviada le
// hizo al cliente, con su tipo y sus datos. Una respuesta corta («sí», «no»,
// «esa», «dos», «sin eso») se interpreta SOLO contra ella
// (`respuestaCorta.js`). La escribe un solo sitio (`fijarPendiente`), y `foco`
// queda como su proyección para los módulos de opciones que ya lo leían.
//
// ── La fase: explícita, persistida y comprobada ──────────────────────────
//
// La máquina de estados sigue CALCULANDO la legalidad desde el carrito real
// (eso evita que un estado guardado mienta sobre lo que hay). Lo que se agrega
// es la FASE del flujo, que se persiste en cada commit y se valida: si la fase
// guardada no coincide con la que se deduce del carrito, el commit se rechaza.
// Explícita para leer y auditar; imposible de desincronizar.
//
// ── Filas del build anterior ─────────────────────────────────────────────
//
// `normalizarEstado` convierte las marcas viejas en `pendiente` cuando la
// conversión es un HECHO del backend (resumen enviado, foco de una pregunta
// canónica, pago ofrecido por Xabor). Las que venían de inferencias poco
// fiables (`ofrecidos` por una búsqueda del modelo, ofertas de promoción sin
// fecha ni cantidad por tipo) se DESCARTAN: el cliente vuelve a elegir y nada
// se autoriza con un dato que Xabor no puede volver a demostrar.
import { z } from 'zod';

export const ESQUEMA_ESTADO = 2;

export const FASES = Object.freeze({
  SELECCIONANDO_PRODUCTOS: 'seleccionando_productos',
  COMPLETANDO_OPCIONES: 'completando_opciones',
  DEFINIENDO_ENTREGA: 'definiendo_entrega',
  DEFINIENDO_PAGO: 'definiendo_pago',
  ESPERANDO_CONFIRMACION: 'esperando_confirmacion',
  CONFIRMADO: 'confirmado',
  CANCELADO: 'cancelado',
  REQUIERE_HUMANO: 'requiere_humano',
  // Catering es un flujo SEPARADO: se recopilan datos del evento y se entrega
  // a una persona. No tiene carrito, precio, pago ni confirmación.
  CAPTURANDO_EVENTO: 'capturando_evento',
});
export const LISTA_FASES = Object.freeze(Object.values(FASES));

export const PENDIENTES = Object.freeze({
  ELEGIR_PRODUCTO: 'elegir_producto',
  AGREGAR_OTRO: 'agregar_otro',
  CONFIGURAR_PEDIDO: 'configurar_pedido',
  EDITAR_PEDIDO: 'editar_pedido',
  ELEGIR_OPCION: 'elegir_opcion',
  MODALIDAD: 'modalidad',
  DIRECCION: 'direccion',
  PAGO: 'pago',
  FECHA_HORA: 'fecha_hora',
  CONFIRMAR_RESUMEN: 'confirmar_resumen',
  ACEPTAR_PRODUCTO: 'aceptar_producto',
  ACEPTAR_PROMOCION: 'aceptar_promocion',
  ACEPTAR_PAGO_OFRECIDO: 'aceptar_pago_ofrecido',
  DATOS_EVENTO: 'datos_evento',
});

/** Veces que se puede repetir la MISMA pregunta sin avance antes de pasar a una persona. */
export const LIMITE_REPREGUNTAS = 3;

// ── ESQUEMA ─────────────────────────────────────────────────────────────

const comunes = {
  dialogo_id: z.string().nullable().optional(),
  intentos: z.number().int().min(1).optional(),
  turno: z.number().int().nonnegative().optional(),
};

const EsquemaPendiente = z.discriminatedUnion('tipo', [
  z.object({ tipo:z.literal('inicio_mapo'), ...comunes }).strict(),
  z.object({ tipo:z.literal('formulario_servicio'), servicio:z.enum(['facturacion','evento']), ...comunes }).strict(),
  // Modo formulario (recepcionista.js): los botones «Hacer pedido ·
  // Información · Hablar con alguien» o la lista de temas que se mostró.
  z.object({ tipo:z.literal('recepcion'), menu:z.enum(['botones','botones_hoy','informacion','informacion_2']), ...comunes }).strict(),
  z.object({ tipo: z.literal('agregar_otro'), ...comunes }).strict(),
  z.object({ tipo: z.literal('configurar_pedido'), ...comunes }).strict(),
  z.object({ tipo: z.literal('editar_pedido'), ...comunes }).strict(),
  z.object({ tipo: z.literal('elegir_producto'), ciclo: z.string().min(1),
    solicitud: z.string().min(1).max(2000), nombre: z.string().min(1),
    cantidad: z.number().int().min(1).max(20),
    candidatos: z.array(z.object({ id: z.string().min(1), nombre: z.string().min(1) }).strict()).min(2).max(20),
    ...comunes }).strict(),
  z.object({ tipo: z.literal('elegir_opcion'), linea_id: z.string().min(1), grupo: z.string().min(1),
    producto: z.string().nullable().optional(), candidatos: z.array(z.string()).default([]),
    minimo: z.number().nullable().optional(), maximo: z.number().nullable().optional(), ...comunes }).strict(),
  z.object({ tipo: z.literal('modalidad'), opciones: z.array(z.string()).default([]), ...comunes }).strict(),
  z.object({ tipo: z.literal('direccion'), ...comunes }).strict(),
  z.object({ tipo: z.literal('pago'), opciones: z.array(z.string()).default([]), ...comunes }).strict(),
  z.object({ tipo: z.literal('fecha_hora'), ...comunes }).strict(),
  z.object({ tipo: z.literal('confirmar_resumen'), huella: z.string().min(1), ...comunes }).strict(),
  z.object({ tipo: z.literal('aceptar_producto'), producto_id: z.string().min(1),
    producto: z.string().min(1), ...comunes }).strict(),
  z.object({ tipo: z.literal('aceptar_promocion'), promocion_id: z.string().min(1),
    promocion: z.string().min(1), producto_id: z.string().min(1), producto: z.string().min(1),
    cantidad: z.number().int().min(1).max(20), ...comunes }).strict(),
  z.object({ tipo: z.literal('aceptar_pago_ofrecido'), forma_pago: z.string().min(1), ...comunes }).strict(),
  z.object({ tipo: z.literal('datos_evento'), faltan: z.array(z.string()).default([]), ...comunes }).strict(),
]);

const EsquemaItem = z.object({
  lid: z.string().min(1),
  nombre: z.string().min(1),
  id: z.union([z.string(), z.number()]).optional(),
  cantidad: z.number().int().min(1).max(99),
  modificadores: z.array(z.any()).default([]),
  notas: z.string().optional(),
}).passthrough();

const EsquemaEstado = z.object({
  esquema: z.literal(ESQUEMA_ESTADO),
  conversacionId: z.string().min(1),
  version: z.number().int().nonnegative(),
  fase: z.enum(LISTA_FASES),
  ultimoWamid: z.string().nullable(),
  turnosAplicados: z.array(z.string()).max(40),
  carrito: z.object({ items: z.array(EsquemaItem), datos: z.object({}).passthrough() }).passthrough(),
  hechos: z.object({
    confirmado: z.boolean(), escalado: z.boolean(), cancelado: z.boolean(), fallido: z.boolean(),
  }).passthrough(),
  folio: z.string().nullable(),
  pendiente: EsquemaPendiente.nullable(),
  eleccionInteractiva: z.object({ciclo:z.string().min(1),linea_id:z.string().min(1),
    producto_id:z.string().min(1),grupo:z.string().min(1),
    id:z.string().min(1).optional(),editando:z.boolean().optional()}).strict().optional(),
}).passthrough();

// ── FASE ────────────────────────────────────────────────────────────────

/**
 * La fase del flujo, deducida del estado y de la vista del pedido real.
 * `pedido` es lo que devuelve `vistaDelPedido` (con la programación ya puesta
 * en `falta` por el ejecutor).
 */
export function derivarFase(estado, pedido) {
  const h = estado?.hechos || {};
  if (h.confirmado) return FASES.CONFIRMADO;
  if (h.cancelado) return FASES.CANCELADO;
  if (h.escalado || h.fallido || estado?.confirmacionIncierta) return FASES.REQUIERE_HUMANO;
  if (estado?.evento) return FASES.CAPTURANDO_EVENTO;
  if (!(pedido?.lineas || []).length) return FASES.SELECCIONANDO_PRODUCTOS;
  const falta = pedido?.falta || [];
  if ((pedido?.aclaraciones || []).length
    || falta.some((f) => String(f).startsWith('grupo:') || String(f).startsWith('producto:'))) {
    return FASES.COMPLETANDO_OPCIONES;
  }
  if (falta.some((f) => ['modalidad', 'direccion', 'programacion'].includes(f))) return FASES.DEFINIENDO_ENTREGA;
  if (falta.includes('pago')) return FASES.DEFINIENDO_PAGO;
  return FASES.ESPERANDO_CONFIRMACION;
}

// ── PENDIENTE ───────────────────────────────────────────────────────────

const claveDePendiente = (p) => {
  if (!p) return null;
  switch (p.tipo) {
    case PENDIENTES.ELEGIR_PRODUCTO: return `${p.tipo}|${p.ciclo}|${p.nombre}|${p.cantidad}`;
    case PENDIENTES.ELEGIR_OPCION: return `${p.tipo}|${p.linea_id}|${String(p.grupo).toLowerCase()}`;
    case PENDIENTES.CONFIRMAR_RESUMEN: return `${p.tipo}|${p.huella}`;
    case PENDIENTES.ACEPTAR_PRODUCTO: return `${p.tipo}|${p.producto_id}`;
    case PENDIENTES.ACEPTAR_PROMOCION: return `${p.tipo}|${p.promocion_id}|${p.producto_id}`;
    case PENDIENTES.ACEPTAR_PAGO_OFRECIDO: return `${p.tipo}|${p.forma_pago}`;
    default: return p.tipo;
  }
};

/** ¿Es la misma pregunta? Sirve para contar repreguntas sin avance. */
export const mismaPregunta = (a, b) => !!a && !!b && claveDePendiente(a) === claveDePendiente(b);

/** La proyección que leen los módulos de opciones (`continuidadDeterminista`, `politicaDelTurno`). */
export function focoDePendiente(pendiente) {
  if (!pendiente) return null;
  if (pendiente.tipo === PENDIENTES.ELEGIR_OPCION) {
    return { tipo: 'opcion', linea_id: pendiente.linea_id, grupo: pendiente.grupo };
  }
  if ([PENDIENTES.MODALIDAD, PENDIENTES.DIRECCION, PENDIENTES.PAGO].includes(pendiente.tipo)) {
    return { tipo: pendiente.tipo };
  }
  return null;
}

/**
 * EL ÚNICO ESCRITOR de `pendiente` (y de su proyección `foco`).
 *
 * `avance` dice si el turno aplicó alguna mutación: repetir la misma pregunta
 * con avance no es ambigüedad (el cliente contestó otra cosa y se guardó); sin
 * avance sí, y `intentos` lo cuenta.
 */
export function fijarPendiente(estado, pendiente, { avance = false, dialogoId = null } = {}) {
  if (!estado) return null;
  const previo = estado.pendiente || null;
  let nuevo = null;
  if (pendiente) {
    const parsed = EsquemaPendiente.safeParse({ ...pendiente, intentos: undefined });
    if (!parsed.success) {
      throw new Error(`pendiente_invalido: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    nuevo = {
      ...parsed.data,
      intentos: !avance && mismaPregunta(previo, parsed.data) ? (Number(previo.intentos) || 1) + 1 : 1,
      turno: Number(estado.turno) || 0,
      ...(dialogoId ? { dialogo_id: dialogoId } : {}),
    };
  }
  estado.pendiente = nuevo;
  estado.foco = focoDePendiente(nuevo);
  return nuevo;
}

/**
 * Traduce el `foco` que dejó el constructor de preguntas del backend en el
 * pendiente completo, con los datos que la pregunta ofreció.
 */
export function pendienteDesdeFoco(foco, pedido, { opcionesModalidad = [], opcionesPago = [] } = {}) {
  if (!foco) return null;
  if (foco.tipo === 'opcion') {
    const a = (pedido?.aclaraciones || []).find((x) => String(x.lid) === String(foco.linea_id)
      && String(x.grupo).toLowerCase() === String(foco.grupo).toLowerCase());
    return {
      tipo: PENDIENTES.ELEGIR_OPCION, linea_id: String(foco.linea_id), grupo: String(foco.grupo),
      producto: a?.producto ?? null, candidatos: (a?.candidatos || []).map(String),
      minimo: Number.isFinite(Number(a?.minimo)) ? Number(a.minimo) : null,
      maximo: Number.isFinite(Number(a?.maximo)) ? Number(a.maximo) : null,
    };
  }
  if (foco.tipo === 'modalidad') return { tipo: PENDIENTES.MODALIDAD, opciones: opcionesModalidad.map(String) };
  if (foco.tipo === 'direccion') return { tipo: PENDIENTES.DIRECCION };
  if (foco.tipo === 'pago') return { tipo: PENDIENTES.PAGO, opciones: opcionesPago.map(String) };
  return null;
}

// ── ACTUALIZACIÓN DE FILAS ANTERIORES ───────────────────────────────────

const CAMPOS_RETIRADOS = ['ofrecidos', 'ofrecidosDelTurno', 'ofertaPromocionPendiente',
  'promocionInformativaPendiente', 'pagoOfrecido'];

/**
 * Lleva un estado leído (de cualquier versión) al esquema canónico, SIN
 * inventar autorizaciones. Idempotente: normalizar dos veces no cambia nada.
 */
export function normalizarEstado(estado) {
  if (!estado || typeof estado !== 'object') return estado;
  if (!estado.carrito || typeof estado.carrito !== 'object') estado.carrito = { items: [], datos: {} };
  if (!Array.isArray(estado.carrito.items)) estado.carrito.items = [];
  if (!estado.carrito.datos || typeof estado.carrito.datos !== 'object') estado.carrito.datos = {};
  estado.hechos = { confirmado: false, escalado: false, cancelado: false, fallido: false, ...(estado.hechos || {}) };
  if (estado.folio === undefined) estado.folio = null;
  if (!Number.isFinite(Number(estado.version))) estado.version = 0;
  if (estado.ultimoWamid === undefined) estado.ultimoWamid = null;
  if (!Array.isArray(estado.turnosAplicados)) estado.turnosAplicados = [];
  if (!Array.isArray(estado.opcionesPendientes)) estado.opcionesPendientes = [];

  if (estado.esquema !== ESQUEMA_ESTADO) {
    let pendiente = null;
    const d = estado.dialogo;
    if (d?.tipo === 'resumen' && d.huella) {
      pendiente = { tipo: PENDIENTES.CONFIRMAR_RESUMEN, huella: String(d.huella) };
    } else if (estado.pagoOfrecido) {
      pendiente = { tipo: PENDIENTES.ACEPTAR_PAGO_OFRECIDO, forma_pago: String(estado.pagoOfrecido) };
    } else if (estado.foco) {
      pendiente = pendienteDesdeFoco(estado.foco, null);
    }
    // `ofrecidos` y `ofertaPromocionPendiente` NO se convierten: eran
    // inferencias (una búsqueda del modelo; una oferta sin fecha ni cantidad
    // por tipo). Se descartan de forma explícita.
    estado.pendiente = null;
    try { fijarPendiente(estado, pendiente); } catch { fijarPendiente(estado, null); }
    if (pendiente && estado.pendiente) estado.pendiente.dialogo_id = d?.id ?? null;
    estado.esquema = ESQUEMA_ESTADO;
  } else if (estado.pendiente === undefined) {
    estado.pendiente = null;
  }
  for (const campo of CAMPOS_RETIRADOS) delete estado[campo];
  return estado;
}

// ── VALIDACIÓN ──────────────────────────────────────────────────────────

/**
 * Comprueba el estado ANTES de persistirlo. Devuelve la lista de violaciones;
 * vacía = válido. `modo` productivo exige además que un pedido confirmado
 * tenga folio: una confirmación sin pedido persistido es la invariante más
 * cara de romper.
 */
export function violacionesDelEstado(estado, pedido, { modo = 'productivo' } = {}) {
  const fallas = [];
  const r = EsquemaEstado.safeParse(estado);
  if (!r.success) {
    for (const i of r.error.issues) fallas.push(`esquema:${i.path.join('.') || '(raíz)'}:${i.message}`);
    return fallas;
  }
  const esperada = derivarFase(estado, pedido);
  if (estado.fase !== esperada) fallas.push(`fase:${estado.fase}!=${esperada}`);
  const h = estado.hechos;
  if (estado.eleccionInteractiva && estado.eleccionInteractiva.ciclo !== estado.conversacionId)
    fallas.push('grupo_interactivo_fuera_de_ciclo');
  if (h.confirmado && h.cancelado) fallas.push('hechos:confirmado_y_cancelado');
  if (modo === 'productivo' && h.confirmado && !estado.folio) fallas.push('confirmado_sin_folio');
  const p = estado.pendiente;
  if (p) {
    if (p.tipo === PENDIENTES.ELEGIR_PRODUCTO
      && p.ciclo !== estado.conversacionId) {
      fallas.push('seleccion_de_producto_fuera_de_ciclo');
    }
    if ([FASES.CONFIRMADO, FASES.CANCELADO, FASES.REQUIERE_HUMANO].includes(estado.fase)) {
      fallas.push(`pendiente_en_terminal:${p.tipo}`);
    }
    if (p.tipo === PENDIENTES.CONFIRMAR_RESUMEN
      && (estado.fase !== FASES.ESPERANDO_CONFIRMACION || p.huella !== pedido?.huella)) {
      fallas.push('resumen_pendiente_no_vigente');
    }
    if (p.tipo === PENDIENTES.ELEGIR_OPCION
      && !(estado.carrito.items || []).some((i) => String(i.lid) === String(p.linea_id))) {
      fallas.push('opcion_pendiente_sin_renglon');
    }
  }
  return fallas;
}

export class EstadoInvalidoError extends Error {
  constructor(fallas) {
    super(`estado_invalido: ${fallas.join(', ')}`);
    this.name = 'EstadoInvalidoError';
    this.codigo = 'ESTADO_INVALIDO';
    this.fallas = fallas;
  }
}

/** Sella la fase deducida y valida. Lanza `EstadoInvalidoError` si algo no cuadra. */
export function sellarEstado(estado, pedido, opciones = {}) {
  normalizarEstado(estado);
  if (estado.pendiente && [FASES.CONFIRMADO, FASES.CANCELADO, FASES.REQUIERE_HUMANO]
    .includes(derivarFase(estado, pedido))) {
    // Un terminal no deja preguntas abiertas: lo que se preguntó antes ya no
    // puede contestarse con un «sí».
    fijarPendiente(estado, null);
  }
  estado.fase = derivarFase(estado, pedido);
  const fallas = violacionesDelEstado(estado, pedido, opciones);
  if (fallas.length) throw new EstadoInvalidoError(fallas);
  return estado;
}
