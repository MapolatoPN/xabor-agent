// ═══════════════════════════════════════════════════════════════════════════
// VALIDADOR TRANSACCIONAL DE ÓRDENES PROPUESTAS POR EL LLM (P0)
//
// Principio: EL LLM CONVERSA Y PROPONE. XABOR VALIDA Y AUTORIZA.
//
// El JSON de <ORDEN_CONFIRMADA> es una PROPUESTA, nunca una autorización.
// Esta es la única autoridad que decide si los items existen, cuánto
// cuestan, cuánto suma el pedido y qué forma de pago es válida. Todo lo
// que el modelo haya escrito (nombres, precios, subtotales, totales,
// descuentos) se considera NO CONFIABLE y se reemplaza por la
// representación canónica derivada del catálogo real del negocio
// (menu_productos, por id) y de sus reglas configuradas.
//
// Fail closed en todo: producto inexistente/desactivado/agotado, forma de
// pago no habilitada o menú vacío ⇒ la orden completa se rechaza con
// motivos estructurados; jamás se crea un item libre ni se acepta un
// precio "porque el modelo lo dijo". El aislamiento multi-tenant es
// estructural: el catálogo se consulta SIEMPRE filtrado por negocio_id,
// así que un producto de otro negocio es indistinguible de uno inexistente.
// ═══════════════════════════════════════════════════════════════════════════
import { pool, obtenerMetodosPagoDisponibles, obtenerConfiguracion } from '../services/database.js';
import { cargarReglas, obtenerEstadoRestaurante, obtenerPagoAceptadoReal } from '../agent/prompts.js';
import { calcularPromociones } from '../services/tiendaPromociones.js';
import { cargarGruposDeProductos, resolverModificadoresLLM } from '../services/modificadores.js';

const CANTIDAD_MAXIMA_POR_ITEM = 200; // tope sanitario, no comercial
const NOTAS_MAX = 300;

// Códigos de rechazo estructurados -- el canal los traduce a lenguaje
// honesto para el cliente ("ese producto no aparece en nuestro menú").
export const RECHAZOS = {
  PRODUCTO_NO_EXISTE: 'PRODUCTO_NO_EXISTE',
  PRODUCTO_NO_DISPONIBLE: 'PRODUCTO_NO_DISPONIBLE',
  PRODUCTO_AGOTADO: 'PRODUCTO_AGOTADO',
  CANTIDAD_INVALIDA: 'CANTIDAD_INVALIDA',
  // XAB-0175: FALTANTE != INVÁLIDA. Faltante = la orden llegó al resumen
  // sin que el cliente ELIGIERA forma de pago (orden incompleta, se
  // pregunta conservando el pedido). Inválida = el cliente sí eligió algo
  // pero ese método no está habilitado para este negocio. Confundirlas
  // producía el mensaje falso "esa forma de pago no está disponible" y un
  // regreso al menú que tiraba el pedido armado.
  FORMA_PAGO_FALTANTE: 'FORMA_PAGO_FALTANTE',
  FORMA_PAGO_INVALIDA: 'FORMA_PAGO_INVALIDA',
  MENU_VACIO: 'MENU_VACIO',
  ORDEN_SIN_ITEMS: 'ORDEN_SIN_ITEMS',
  // XAB-0230: el nombre de la opción existe en más de un grupo del producto
  // (p. ej. "Bistec en Salsa" como Proteína y como Guarnición). No se adivina:
  // el canal pregunta a cuál se refiere el cliente.
  MODIFICADOR_AMBIGUO: 'MODIFICADOR_AMBIGUO',
  // XAB-0234: el cliente pidió un atributo CONCRETO de un grupo real que no
  // existe en el catálogo ("Sabor: Mango" cuando solo hay Plátano/Melón/
  // Papaya/Fresa). Antes se descartaba en silencio y el pedido seguía sin
  // sabor — se vendió algo que la cocina no podía preparar. Ahora detiene la
  // orden y el canal ofrece las opciones REALES del grupo.
  MODIFICADOR_NO_DISPONIBLE: 'MODIFICADOR_NO_DISPONIBLE',
};

// Mismo mapeo tipo→texto que usa el prompt al OFRECER métodos
// (prompts.js). La orden solo puede usar lo que el negocio tiene
// habilitado de verdad -- el texto del modelo se normaliza antes de
// comparar.
const FORMA_PAGO_ALIAS = {
  'efectivo': 'efectivo',
  'terminal': 'terminal',
  'terminal (tarjeta presente)': 'terminal',
  'tarjeta': 'terminal',
  'enlace de pago': 'enlace_pago',
  'enlace_pago': 'enlace_pago',
  'link de pago': 'enlace_pago',
  'transferencia': 'transferencia',
  'transferencia bancaria': 'transferencia',
  'pago en sucursal': 'pago_en_sucursal',
  'contra entrega': 'efectivo',
};

export function normalizarNombreProducto(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // sin acentos
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Log estructurado de observabilidad transaccional. Nunca datos del
// cliente, nunca secretos: solo negocio, evento y detalle técnico.
export function eventoTxn(evento, negocioId, detalle = {}) {
  console.warn(`[TXN] evento=${evento} negocio=${negocioId} ${Object.entries(detalle).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`);
}

async function cargarCatalogo(negocioId) {
  // SIEMPRE filtrado por negocio_id (Invariante 6): el catálogo de otro
  // tenant simplemente no existe desde aquí.
  const { rows } = await pool.query(
    `SELECT p.id, p.nombre, p.precio, p.disponible, p.agotado, p.opciones, p.categoria_id, c.activa AS categoria_activa
     FROM menu_productos p JOIN menu_categorias c ON c.id = p.categoria_id
     WHERE p.negocio_id = $1`,
    [negocioId]);
  return rows;
}

/**
 * Identificación ESTRUCTURAL de un producto legacy de envío (P0 XAB-0176:
 * Clip cobró $370 por un pedido de $310 porque "Envío" existía como
 * producto del menú Y como costo_envio canónico, y el total sumó ambos).
 *
 * La marca vive en el catálogo: `menu_productos.opciones.tipo_item = 'envio'`.
 * DELIBERADAMENTE no se reconoce por nombre/categoría ("Envío", "Delivery",
 * etc.): una heurística de texto no es aceptable como autoridad de un
 * cálculo financiero. Un producto sin la marca es mercancía, punto -- si un
 * negocio arrastra un producto-envío sin marcar, se marca en el catálogo,
 * no se adivina aquí.
 */
export function esProductoEnvio(producto) {
  return producto?.opciones?.tipo_item === 'envio';
}

function resolverProducto(nombreLLM, catalogo) {
  const buscado = normalizarNombreProducto(nombreLLM);
  if (!buscado) return { estado: 'no_existe' };
  const porNombre = catalogo.map((p) => ({ p, norm: normalizarNombreProducto(p.nombre) }));
  // 1) igualdad exacta normalizada; 2) contención NO ambigua (una sola
  // coincidencia) en cualquier dirección -- compatibilidad con notas tipo
  // "Focaccia Bar grande". Ambiguo = no resuelto (fail closed).
  let candidatos = porNombre.filter((x) => x.norm === buscado);
  if (candidatos.length === 0) {
    candidatos = porNombre.filter((x) => x.norm.includes(buscado) || buscado.includes(x.norm));
  }
  if (candidatos.length !== 1) return { estado: 'no_existe' };
  const prod = candidatos[0].p;
  if (!prod.categoria_activa || prod.disponible === false) return { estado: 'no_disponible', producto: prod };
  if (prod.agotado === true) return { estado: 'agotado', producto: prod };
  return { estado: 'ok', producto: prod };
}

/**
 * Valida y canoniza una orden propuesta por el LLM.
 *
 * Devuelve SIEMPRE (no lanza por contenido inválido):
 *   ok: boolean
 *   rechazos: [{ codigo, nombre? , detalle? }]   (vacío si ok)
 *   orden: la orden CANÓNICA (solo si ok) -- items con producto_id,
 *          nombre real del catálogo, precio real, y totales recalculados.
 *   ajustes: [{ tipo, ... }] observabilidad de mismatches corregidos.
 */
export async function validarOrdenPropuesta(orden, negocioId, opts = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw new Error('validarOrdenPropuesta: negocioId obligatorio');
  }
  // Canal para el motor de promociones (una promo puede restringirse a canales).
  // Se toma del llamador (registrarPedido) o de la propia orden; default whatsapp.
  const canalPromo = String(opts.canal || orden?.canal || 'whatsapp').toLowerCase().trim() || 'whatsapp';
  const rechazos = [];
  const ajustes = [];

  const itemsLLM = Array.isArray(orden?.items) ? orden.items : [];
  if (!itemsLLM.length) {
    rechazos.push({ codigo: RECHAZOS.ORDEN_SIN_ITEMS });
    eventoTxn('orden_sin_items', negocioId, {});
    return { ok: false, rechazos, ajustes };
  }

  const catalogo = await cargarCatalogo(negocioId);
  if (!catalogo.length) {
    // Negocio sin menú configurado: NINGÚN pedido transaccional es
    // validable. Se rechaza todo (este era exactamente el terreno del
    // incidente Alora: cero productos ⇒ todo lo "aceptado" era inventado).
    rechazos.push({ codigo: RECHAZOS.MENU_VACIO });
    for (const it of itemsLLM) rechazos.push({ codigo: RECHAZOS.PRODUCTO_NO_EXISTE, nombre: String(it?.nombre || '').slice(0, 80) });
    eventoTxn('menu_vacio', negocioId, { items: itemsLLM.length });
    return { ok: false, rechazos, ajustes };
  }

  // Las promociones (incl. 2x1) las calcula el MOTOR determinístico al final
  // (calcularPromociones), NUNCA el modelo. Aquí cada item se canoniza a su
  // precio REAL de catálogo; ya no se acepta ningún "precio 0" propuesto por
  // el LLM. El descuento lo decide el backend sobre los items canónicos.
  const itemsCanonicos = [];

  for (const it of itemsLLM) {
    const cantidad = Number(it?.cantidad);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > CANTIDAD_MAXIMA_POR_ITEM) {
      rechazos.push({ codigo: RECHAZOS.CANTIDAD_INVALIDA, nombre: String(it?.nombre || '').slice(0, 80) });
      eventoTxn('cantidad_invalida', negocioId, { cantidad: it?.cantidad });
      continue;
    }
    const r = resolverProducto(it?.nombre, catalogo);
    if (r.estado === 'no_existe') {
      rechazos.push({ codigo: RECHAZOS.PRODUCTO_NO_EXISTE, nombre: String(it?.nombre || '').slice(0, 80) });
      eventoTxn('producto_no_encontrado', negocioId, { nombre: String(it?.nombre || '').slice(0, 60) });
      continue;
    }
    // UNA SOLA fuente de verdad para el envío: el costo canónico de las
    // reglas (más abajo). Un item que resuelve a un producto MARCADO como
    // envío jamás se cobra como mercancía -- ni en domicilio (duplicaría el
    // costo canónico: el bug real de XAB-0176) ni en recoger (donde no
    // existe envío que cobrar). Su precio de catálogo tampoco es autoridad
    // de zona/gratis. Se ignora con observabilidad estructurada; aplica
    // aunque el producto esté no_disponible/agotado (se ignora igual, sin
    // tumbar la orden por un cargo que de todos modos no es mercancía).
    if (r.producto && esProductoEnvio(r.producto)) {
      ajustes.push({
        tipo: 'item_envio_legacy_ignorado',
        producto: r.producto.nombre,
        producto_id: r.producto.id,
        llm: Number.isFinite(Number(it?.precio_unitario)) ? Number(it?.precio_unitario) : null,
      });
      eventoTxn('item_envio_legacy_ignorado', negocioId, { producto_id: r.producto.id });
      continue;
    }
    if (r.estado === 'no_disponible') {
      rechazos.push({ codigo: RECHAZOS.PRODUCTO_NO_DISPONIBLE, nombre: r.producto.nombre });
      eventoTxn('producto_rechazado', negocioId, { motivo: 'no_disponible', producto_id: r.producto.id });
      continue;
    }
    if (r.estado === 'agotado') {
      rechazos.push({ codigo: RECHAZOS.PRODUCTO_AGOTADO, nombre: r.producto.nombre });
      eventoTxn('producto_rechazado', negocioId, { motivo: 'agotado', producto_id: r.producto.id });
      continue;
    }

    const precioReal = Number(r.producto.precio);
    const precioLLM = Number(it?.precio_unitario);
    // El precio SIEMPRE es el real del catálogo. Un "0" del modelo ya no se
    // acepta: el 2x1/descuento lo aplica el motor de promociones, no el LLM.
    if (Number.isFinite(precioLLM) && precioLLM !== precioReal) {
      ajustes.push({ tipo: 'precio_mismatch', producto: r.producto.nombre, llm: precioLLM, real: precioReal });
      eventoTxn('precio_mismatch', negocioId, { producto_id: r.producto.id, llm: precioLLM, real: precioReal });
    }

    // Representación CANÓNICA: el nombre del LLM deja de ser autoridad --
    // queda el id y el nombre reales del catálogo; lo dictado se conserva
    // solo como nota informativa acotada. `categoria_id` y `precio_base`
    // alimentan al motor de promociones (elegibilidad y beneficio por unidad).
    itemsCanonicos.push({
      producto_id: r.producto.id,
      categoria_id: r.producto.categoria_id ?? null,
      nombre: r.producto.nombre,
      cantidad,
      precio_unitario: precioReal,   // BASE por ahora; los modificadores se
      precio_base: precioReal,       // suman abajo (extras canónicos).
      notas: String(it?.notas || '').slice(0, NOTAS_MAX) || undefined,
      // Modificadores CRUDOS del LLM (nombres); se resuelven contra catálogo
      // más abajo. El LLM nunca fija el importe.
      _modsLLM: Array.isArray(it?.modificadores) ? it.modificadores : [],
    });
  }

  // Si tras excluir cargos de envío no queda NINGUNA mercancía, la orden
  // no es una orden (un pedido de "solo envío" no existe): fail-closed.
  if (!itemsCanonicos.length && !rechazos.length) {
    rechazos.push({ codigo: RECHAZOS.ORDEN_SIN_ITEMS });
    eventoTxn('orden_sin_items', negocioId, { motivo: 'solo_items_de_envio' });
    return { ok: false, rechazos, ajustes };
  }

  // Forma de pago: solo métodos habilitados de verdad para este negocio.
  // FALTANTE != INVÁLIDA (XAB-0175): sin elección del cliente la orden
  // está INCOMPLETA (jamás se asume efectivo ni ningún default); con una
  // elección que el negocio no acepta, es INVÁLIDA. En ambos casos el
  // rechazo lleva los métodos REALES (obtenerPagoAceptadoReal ->
  // obtenerMetodosPagoDisponibles(negocioId, {paraBot:true}), la misma
  // fuente única que alimenta el prompt) para que el canal pueda
  // ofrecerlos sin inventar nada.
  const formaLLM = String(orden?.forma_pago || '').toLowerCase().trim();
  const tipoNormalizado = FORMA_PAGO_ALIAS[formaLLM];
  let habilitados = [];
  try {
    habilitados = (await obtenerMetodosPagoDisponibles(negocioId, { paraBot: true })).map((m) => m.tipo);
  } catch { habilitados = ['efectivo']; }
  if (!habilitados.length) habilitados = ['efectivo'];
  if (!formaLLM) {
    const disponibles = await obtenerPagoAceptadoReal(negocioId);
    rechazos.push({ codigo: RECHAZOS.FORMA_PAGO_FALTANTE, disponibles });
    eventoTxn('forma_pago_faltante', negocioId, {});
  } else if (!tipoNormalizado || !habilitados.includes(tipoNormalizado)) {
    const disponibles = await obtenerPagoAceptadoReal(negocioId);
    rechazos.push({ codigo: RECHAZOS.FORMA_PAGO_INVALIDA, nombre: formaLLM.slice(0, 40), disponibles });
    eventoTxn('forma_pago_invalida', negocioId, { forma: formaLLM.slice(0, 40) });
  }

  if (rechazos.length) return { ok: false, rechazos, ajustes };

  // ── MODIFICADORES: precio CANÓNICO del catálogo (nunca del LLM) ──
  // El LLM emite NOMBRES de opciones; aquí se resuelven contra las opciones
  // reales del producto y se suma su precio_extra al precio_unitario. El
  // precio_base queda INTACTO (solo la base): así el 2x1/descuentos aplican
  // sobre la base y los extras se siguen cobrando. Un nombre inventado o no
  // disponible NO se cobra (se reporta en ajustes) y nunca tumba la orden.
  try {
    const gruposPorProd = await cargarGruposDeProductos(negocioId, itemsCanonicos.map((i) => i.producto_id));
    for (const item of itemsCanonicos) {
      const { modificadores, precioExtras, texto, noReconocidos, ambiguos, noDisponibles } =
        resolverModificadoresLLM(gruposPorProd.get(item.producto_id) || [], item._modsLLM);
      if (modificadores.length) {
        item.modificadores = modificadores;                     // ticket / cocina / historial
        item.precio_unitario = item.precio_base + precioExtras; // base + extras canónicos
        if (texto) item.modificadores_texto = texto;
      }
      // Texto que no casó con ninguna opción y que venía SIN grupo: puede ser
      // una nota de preparación ("sin cebolla"), no una selección de menú. Se
      // sigue tratando con lenidad — no se cobra y se reporta.
      if (noReconocidos.length) {
        ajustes.push({ tipo: 'modificador_no_reconocido', producto: item.nombre, ignorados: noReconocidos });
        eventoTxn('modificador_no_reconocido', negocioId, { producto_id: item.producto_id, ignorados: noReconocidos.slice(0, 5) });
      }
      // FAIL-CLOSED (XAB-0234): una selección ESTRUCTURADA que no existe detiene
      // la orden. El cliente pidió algo concreto de un grupo real; venderle otra
      // cosa (o el producto sin ese atributo) sería venderle lo que el negocio
      // no puede preparar.
      if (noDisponibles.length) {
        for (const nd of noDisponibles) {
          rechazos.push({
            codigo: RECHAZOS.MODIFICADOR_NO_DISPONIBLE,
            producto: item.nombre, grupo: nd.grupo,
            nombre: nd.solicitado, alternativas: nd.alternativas,
          });
        }
        eventoTxn('modificador_no_disponible', negocioId, {
          producto_id: item.producto_id,
          solicitados: noDisponibles.map((n) => `${n.grupo}:${n.solicitado}`).slice(0, 5),
        });
      }
      // FAIL-CLOSED (XAB-0230): una opción cuyo nombre existe en VARIOS grupos
      // del producto no se adivina. Antes se tomaba el primer grupo y la cocina
      // recibía datos falsos; ahora la orden se detiene y el canal pregunta a
      // qué grupo se refiere. Es un rechazo, no un ajuste: cobrar o cocinar algo
      // que no sabemos qué es sería peor que preguntar.
      if (ambiguos.length) {
        for (const a of ambiguos) {
          rechazos.push({
            codigo: RECHAZOS.MODIFICADOR_AMBIGUO,
            producto: item.nombre, nombre: a.nombre, grupos: a.grupos,
          });
        }
        eventoTxn('modificador_ambiguo', negocioId, {
          producto_id: item.producto_id,
          ambiguos: ambiguos.map((a) => `${a.nombre}:[${a.grupos.join('|')}]`).slice(0, 5),
        });
      }
      delete item._modsLLM;
    }
  } catch (e) {
    // Fail-safe: ante cualquier error se cobran solo las bases (nunca se regala
    // ni se inventa un extra). Se limpia el rastro temporal.
    eventoTxn('modificadores_error', negocioId, { error: String(e?.message || e).slice(0, 120) });
    for (const item of itemsCanonicos) delete item._modsLLM;
  }

  // Un modificador ambiguo detiene la orden aquí (el corte anterior ya pasó).
  if (rechazos.length) return { ok: false, rechazos, ajustes };

  // ── Totales: SIEMPRE recalculados ──
  const reglas = await cargarReglas(negocioId).catch(() => null);
  const subtotal = itemsCanonicos.reduce((s, i) => s + i.precio_unitario * i.cantidad, 0);

  const esDomicilio = String(orden?.modalidad || '').toLowerCase().includes('domicilio');
  let costoEnvio = 0;
  if (esDomicilio) {
    const base = Number(reglas?.pedidos?.costo_envio) || 0;
    const zonas = Array.isArray(reglas?.pedidos?.zonas_entrega) ? reglas.pedidos.zonas_entrega.map((z) => Number(z.costo)) : [];
    const umbralGratis = Number(reglas?.pedidos?.entrega_gratis_desde) || 0;
    const permitidos = new Set([base, ...zonas]);
    if (umbralGratis > 0 && subtotal >= umbralGratis) permitidos.add(0);
    try {
      const estado = obtenerEstadoRestaurante(reglas);
      if (estado.promocionesActivas?.some((p) => p.condicion === 'min_3_focaccias')) permitidos.add(0);
    } catch { /* sin promo */ }
    const envioLLM = Number(orden?.costo_envio);
    if (Number.isFinite(envioLLM) && permitidos.has(envioLLM)) {
      costoEnvio = envioLLM;
    } else {
      costoEnvio = base;
      if (Number.isFinite(envioLLM) && envioLLM !== base) {
        ajustes.push({ tipo: 'envio_mismatch', llm: envioLLM, real: base });
        eventoTxn('envio_mismatch', negocioId, { llm: envioLLM, real: base });
      }
    }
  }

  // ── DESCUENTOS: los calcula el MOTOR DE PROMOCIONES, jamás el modelo ──
  // Fuente única de verdad para todos los canales (calcularPromociones sobre
  // tienda_promociones). Cualquier "descuento" que el modelo escribiera se
  // ignora. Fail-safe: si el motor falla, el pedido sale SIN descuento —
  // nunca se regala por un error.
  const descuentoLLM = Number(orden?.descuento) || 0;
  if (descuentoLLM !== 0) {
    ajustes.push({ tipo: 'descuento_ignorado', llm: descuentoLLM });
    eventoTxn('descuento_ignorado', negocioId, { llm: descuentoLLM });
  }

  let descuento = 0, promocionesAplicadas = [], oportunidadesPromo = [];
  try {
    const promo = await calcularPromociones({
      negocioId, subtotal,
      items: itemsCanonicos.map((i) => ({
        producto_id: i.producto_id, categoria_id: i.categoria_id,
        cantidad: i.cantidad, precio_unitario: i.precio_unitario, precio_base: i.precio_base,
        // Los modificadores CANÓNICOS viajan al motor: las promociones
        // condicionadas por modificadores (salsa/proteína/guarniciones) evalúan
        // elegibilidad por unidad sobre ellos.
        modificadores: i.modificadores || [],
      })),
      costoEnvio, modalidad: esDomicilio ? 'domicilio' : 'recoger',
      canal: canalPromo, telefono: orden?.cliente?.telefono || null,
      timezone: reglas?.timezone || 'America/Matamoros',
    });
    // El motor puede otorgar envío gratis, pero el envío ya lo resuelve la
    // lógica de reglas de arriba; aquí SOLO se toma el descuento de producto.
    descuento = Math.max(0, Math.min(Number(promo.descuento) || 0, subtotal));
    promocionesAplicadas = (promo.aplicadas || []).filter((a) => !a.envioGratis).map((a) => ({
      id: a.id, nombre: a.nombre, tipo: a.tipo, descuento: a.descuento,
      unidades: a.unidadesBeneficiadas || 0, codigo: a.codigo || null,
    }));
    oportunidadesPromo = promo.oportunidades || [];
    if (descuento > 0) eventoTxn('promo_aplicada', negocioId, { descuento, tipos: promocionesAplicadas.map((p) => p.tipo) });
  } catch (e) {
    eventoTxn('promo_engine_error', negocioId, { error: String(e?.message || e).slice(0, 120) });
  }

  const total = Math.max(0, subtotal - descuento + costoEnvio);
  const totalLLM = Number(orden?.total);
  if (Number.isFinite(totalLLM) && totalLLM !== total) {
    ajustes.push({ tipo: 'total_mismatch', llm: totalLLM, real: total });
    eventoTxn('total_mismatch', negocioId, { llm: totalLLM, real: total });
  }

  const ordenCanonica = {
    ...orden,
    items: itemsCanonicos,
    subtotal,
    costo_envio: costoEnvio,
    descuento,
    total,
    promociones: promocionesAplicadas,       // snapshot para ticket / historial
    promo_oportunidades: oportunidadesPromo,  // pista que el agente solo VERBALIZA
    forma_pago_tipo: tipoNormalizado,         // canónico (tipo de metodos_pago)
  };

  return { ok: true, orden: ordenCanonica, rechazos: [], ajustes };
}

// Texto honesto para el cliente cuando la orden se rechaza -- lo redacta
// CÓDIGO, nunca el modelo. Sin jerga ni códigos internos.
export function mensajeRechazoParaCliente(rechazos) {
  const listaDisponibles = () => {
    const conLista = rechazos.find((r) => Array.isArray(r.disponibles) && r.disponibles.length);
    return conLista ? conLista.disponibles.join(', ') : 'efectivo';
  };

  // XAB-0175: si lo ÚNICO que falla es la forma de pago, el pedido NO se
  // tira ni se manda al cliente de vuelta al menú -- se conserva tal cual
  // (items, cantidades, modalidad, datos) y solo se pregunta cómo pagar,
  // con los métodos reales del negocio.
  const soloFormaPago = rechazos.length > 0 && rechazos.every((r) =>
    r.codigo === RECHAZOS.FORMA_PAGO_FALTANTE || r.codigo === RECHAZOS.FORMA_PAGO_INVALIDA);
  if (soloFormaPago) {
    const faltante = rechazos.some((r) => r.codigo === RECHAZOS.FORMA_PAGO_FALTANTE);
    return faltante
      ? `¡Tu pedido está casi listo! Solo falta la forma de pago. ¿Cómo deseas pagar? Puedes pagar con: ${listaDisponibles()}.`
      : `Esa forma de pago no está disponible. Puedes pagar con: ${listaDisponibles()}. ¿Cuál prefieres? Tu pedido sigue tal como lo armamos.`;
  }

  // Opción inexistente en un grupo real: se dice la verdad y se ofrecen las
  // opciones REALES del catálogo (nunca una lista escrita en el prompt). El
  // pedido se conserva; solo falta elegir un valor que sí exista.
  const noDisp = rechazos.filter((r) => r.codigo === RECHAZOS.MODIFICADOR_NO_DISPONIBLE);
  if (noDisp.length && noDisp.length === rechazos.length) {
    const partes = noDisp.map((r) => {
      const alts = Array.isArray(r.alternativas) ? r.alternativas.filter(Boolean) : [];
      const lista = alts.length > 1
        ? `${alts.slice(0, -1).join(', ')} y ${alts[alts.length - 1]}`
        : (alts[0] || '');
      const grupo = String(r.grupo || '').toLowerCase();
      return alts.length
        ? `no tenemos ${r.nombre}${grupo ? ` en ${grupo}` : ''}. Las opciones disponibles son ${lista}`
        : `no tenemos ${r.nombre}${grupo ? ` en ${grupo}` : ''}`;
    });
    return `Una disculpa: ${partes.join('; ')}. ¿Cuál prefieres?`;
  }

  // Ambigüedad de modificador: NO es un error del cliente ni tira el pedido —
  // solo falta saber a qué grupo se refería. Se pregunta con las opciones reales.
  const ambiguos = rechazos.filter((r) => r.codigo === RECHAZOS.MODIFICADOR_AMBIGUO);
  if (ambiguos.length && ambiguos.length === rechazos.length) {
    const a = ambiguos[0];
    const grupos = Array.isArray(a.grupos) ? a.grupos : [];
    const enumerado = grupos.length > 1
      ? `${grupos.slice(0, -1).join(', ')} o ${grupos[grupos.length - 1]}`
      : (grupos[0] || 'una de las opciones');
    return `Una aclaración para no equivocarme: "${a.nombre}" aparece en ${enumerado}. ¿En cuál lo quieres?`;
  }

  const noExisten = rechazos.filter((r) => r.codigo === RECHAZOS.PRODUCTO_NO_EXISTE && r.nombre).map((r) => r.nombre);
  const agotados = rechazos.filter((r) => r.codigo === RECHAZOS.PRODUCTO_AGOTADO).map((r) => r.nombre);
  const noDisponibles = rechazos.filter((r) => r.codigo === RECHAZOS.PRODUCTO_NO_DISPONIBLE).map((r) => r.nombre);
  const formaPagoInvalida = rechazos.some((r) => r.codigo === RECHAZOS.FORMA_PAGO_INVALIDA);
  const formaPagoFaltante = rechazos.some((r) => r.codigo === RECHAZOS.FORMA_PAGO_FALTANTE);
  const partes = [];
  if (noExisten.length) partes.push(`no manejamos ${noExisten.join(', ')} en nuestro menú actual`);
  if (agotados.length) partes.push(`${agotados.join(', ')} está agotado por hoy`);
  if (noDisponibles.length) partes.push(`${noDisponibles.join(', ')} no está disponible en este momento`);
  if (formaPagoInvalida) partes.push(`esa forma de pago no está disponible (puedes pagar con: ${listaDisponibles()})`);
  if (formaPagoFaltante) partes.push(`falta elegir la forma de pago (puedes pagar con: ${listaDisponibles()})`);
  const motivo = partes.length ? partes.join('; ') : 'algunos datos del pedido no pudieron validarse';
  return `Una disculpa: no pude registrar tu pedido porque ${motivo}. ¿Te gustaría elegir algo de nuestro menú? Con gusto te lo comparto.`;
}
