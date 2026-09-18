// ─── EL PEDIDO QUE SE INTENTARÍA CREAR, SIN CREARLO ───────────────────────
//
// Módulo PURO. Responde a una sola pregunta:
//
//   «Si este pedido se autorizara ahora, ¿qué estructura exacta intentaría
//    crear Xabor?»
//
// No persiste, no llama a `orderManager`, no consume folio, no imprime, no
// cobra, no consulta la base y no habla con ningún modelo. Lo prueba el grafo
// de imports, no esta frase.
//
// ── LO QUE ESTE ARTEFACTO ES, Y LO QUE NO ────────────────────────────────
//
// Hay TRES capas y confundir dos cuesta un incidente:
//
//   A  ESTADO CONVERSACIONAL   carrito, resumen, cliente, modalidad, pago
//   B  ARTEFACTO HIPOTÉTICO    lo que se le entregaría al borde  ← esto
//   C  PEDIDO PERSISTIDO       con id, folio, totales y sellos de la base
//
// La tentación era construir C. Sería un error, y el código dice por qué:
// `registrarPedido` NO recibe un pedido, recibe una PROPUESTA, y dentro llama
// a `validarOrdenPropuesta`, que la valida contra el catálogo real y la
// REEMPLAZA por su forma canónica —«los nombres, precios y totales son los del
// backend, no los del modelo»—. Un artefacto que produjera C estaría
// duplicando al validador, que es precisamente la barrera que impide que el
// modelo invente precios.
//
// Así que esto es B: la propuesta, y sólo lo que una propuesta puede afirmar.
//
// ── POR QUÉ NO LLEVA DINERO ──────────────────────────────────────────────
//
// Medido en `validadorOrden.js:1026-1045`: el precio que trae el llamador se
// lee (`Number(it?.precio_unitario)`) y, si difiere, se anota un ajuste y se
// sigue. Si NO viene, `Number(undefined)` es NaN y ni siquiera se anota nada.
// El canónico es siempre `precioReal` del catálogo. Lo mismo con `subtotal`
// (se recalcula), `descuento` (se ignora y lo pone el motor de promociones) y
// `total` (se deriva).
//
// La única excepción es `costo_envio`, que sobrevive si cae en una allow-list
// de valores permitidos del negocio — y esos valores viven en la configuración,
// que es DB. Fuera del alcance de una función pura.
//
// Conclusión: el artefacto no afirma importes porque el contrato real no los
// acepta de quien llama. No hace falta inventar un `pricing_status`: no hay
// nada que marcar como incompleto, hay algo que no es del Mesero.
//
// ── POR QUÉ NO LLEVA id, folio NI timestamp ──────────────────────────────
//
// Los pone la infraestructura al persistir. Inventarlos aquí sería afirmar un
// folio que nadie reservó, y el ledger de folios es la única huella que queda
// cuando un pedido desaparece.

/** El texto tal como lo compara el resto del sistema. */
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Los nueve campos de cliente que el sistema maneja de verdad, contados en
 * producción. La lista es CERRADA: lo que el estado autorizado no traiga, no
 * se completa ni se infiere, y lo que traiga de más no viaja.
 */
const CAMPOS_DEL_CLIENTE = ['nombre', 'telefono', 'calle', 'numero_exterior',
  'numero_interior', 'colonia', 'entre_calles', 'referencia', 'direccion'];

/** El índice nombre → producto del catálogo que ya está en memoria. */
function indiceDelCatalogo(catalogo) {
  const porNombre = new Map();
  const porId = new Map();
  for (const cat of (Array.isArray(catalogo) ? catalogo : [])) {
    for (const p of (cat?.productos || [])) {
      const ficha = { id: p?.id ?? null, nombre: String(p?.nombre || ''), categoria_id: cat?.id ?? null };
      if (!ficha.nombre) continue;
      porNombre.set(norm(ficha.nombre), ficha);
      if (ficha.id !== null && ficha.id !== undefined) porId.set(String(ficha.id), ficha);
    }
  }
  return { porNombre, porId };
}

/** Las opciones de un renglón, por grupo, en orden estable. */
function modificadoresDe(item) {
  const grupos = [];
  for (const m of (Array.isArray(item?.modificadores) ? item.modificadores : [])) {
    if (typeof m === 'string') { grupos.push({ grupo: '', opciones: [m] }); continue; }
    const grupo = String(m?.grupo ?? '');
    const opciones = Array.isArray(m?.opciones)
      ? m.opciones.map((o) => String(typeof o === 'string' ? o : o?.nombre || '')).filter(Boolean)
      : [String(m?.opcion || m?.nombre || '')].filter(Boolean);
    if (opciones.length) grupos.push({ grupo, opciones });
  }
  return grupos;
}

/**
 * ¿Qué pedido se intentaría crear con este estado autorizado?
 *
 * Todo lo que entra tiene que venir YA autorizado: el carrito lo produce el
 * reconciliador con sus reglas de evidencia, y la identidad —negocio, canal,
 * teléfono de la conversación— la sella el canal, nunca el modelo. Esta
 * función no autoriza nada: traduce.
 *
 *   carrito                el del turno, con sus `datos` operativos
 *   catalogo               el mismo que ya recibió el Mesero, para los ids
 *   negocioId · canal      los sella el canal (whatsapp-meta.js:1188,1197)
 *   telefonoConversacion   el remitente del webhook, no lo que se dictó
 *   aclaraciones · falta   lo que sigue abierto, para decidir si está listo
 *   confirmacionVigente    si el resumen que el cliente leyó sigue vigente
 *
 * Devuelve `{ listo, bloqueos, propuesta }`. La propuesta se construye SIEMPRE
 * que haya identidad y renglones —se puede mirar aunque no esté lista, que es
 * media gracia de observar en sombra—; `listo` dice si se podría entregar.
 */
export function construirPedidoHipotetico({
  carrito = null, catalogo = [], negocioId = null, canal = null,
  telefonoConversacion = null, aclaraciones = [], falta = [],
  confirmacionVigente = false, requierePago = true,
} = {}) {
  const bloqueos = [];

  // ── LA IDENTIDAD NO SE DEDUCE ──────────────────────────────────────────
  //
  // Si falta, no hay artefacto. No se inventa un negocio por defecto: ese
  // respaldo existió, mandó un pedido de Alora a la cocina de Nonna Maye, y
  // por eso `registrarPedido` ahora lanza en vez de rellenar.
  if (!negocioId || typeof negocioId !== 'string' || !negocioId.trim()) bloqueos.push('sin_negocio');
  if (!canal || typeof canal !== 'string' || !canal.trim()) bloqueos.push('sin_canal');

  const items = [];
  const { porNombre, porId } = indiceDelCatalogo(catalogo);
  for (const it of (carrito?.items || [])) {
    // EL id SALE DEL CATÁLOGO, NUNCA DEL NOMBRE QUE ESCRIBIÓ EL MODELO. El
    // anclaje ya dejó el `id` canónico en el renglón; el nombre sólo sirve
    // para encontrarlo si el anclaje no llegó a ponerlo.
    const ficha = (it?.id !== undefined && it?.id !== null && porId.get(String(it.id)))
      || porNombre.get(norm(it?.nombre)) || null;
    if (!ficha) { bloqueos.push(`producto_sin_id:${String(it?.nombre || '')}`); continue; }
    const cantidad = Number.isFinite(Number(it?.cantidad)) && Number(it.cantidad) > 0
      ? Number(it.cantidad) : 1;
    items.push({
      producto_id: ficha.id,
      categoria_id: ficha.categoria_id,
      nombre: ficha.nombre,
      cantidad,
      modificadores: modificadoresDe(it),
      ...(String(it?.notas || '').trim() ? { notas: String(it.notas).trim() } : {}),
      // Trazabilidad del observador, NO parte del pedido real: en los 33 items
      // reales medidos no aparece ni una vez. Viaja aparte para que nadie lo
      // confunda con contrato.
      _lid: it?.lid ?? null,
    });
  }
  if (!items.length) bloqueos.push('sin_items');

  // ── EL CLIENTE, SÓLO LO AUTORIZADO ─────────────────────────────────────
  //
  // `cliente` va SIEMPRE, aunque esté vacío: el canal hace
  // `resultado.orden.cliente.telefono = ...` sin optional chaining
  // (whatsapp-meta.js:1189), así que una propuesta sin `cliente` reventaría
  // ahí. Vacío es honesto; ausente es una excepción en el borde.
  const cliente = {};
  const autorizado = carrito?.datos?.cliente || {};
  for (const campo of CAMPOS_DEL_CLIENTE) {
    const v = autorizado[campo];
    if (v !== undefined && v !== null && String(v).trim() !== '') cliente[campo] = v;
  }

  const datos = carrito?.datos || {};
  if (!datos.modalidad) bloqueos.push('sin_modalidad');
  if (requierePago && !datos.forma_pago) bloqueos.push('sin_pago');
  if ((aclaraciones || []).length) bloqueos.push('aclaraciones_abiertas');
  for (const f of (falta || [])) bloqueos.push(`falta:${f}`);
  if (!confirmacionVigente) bloqueos.push('resumen_no_vigente');

  const propuesta = (negocioId && canal && items.length) ? {
    negocioId,
    canal,
    ...(telefonoConversacion ? { telefono_conversacion: String(telefonoConversacion) } : {}),
    items,
    cliente,
    ...(datos.modalidad !== undefined ? { modalidad: datos.modalidad } : {}),
    ...(datos.forma_pago !== undefined ? { forma_pago: datos.forma_pago } : {}),
  } : null;

  return { listo: bloqueos.length === 0, bloqueos, propuesta };
}

/**
 * Lo que el borde transaccional pondría por su cuenta, para que nadie lo
 * busque aquí. Se declara en código y no en un comentario porque así una
 * prueba puede exigir que el artefacto NO los traiga.
 */
export const LOS_PONE_EL_BORDE = Object.freeze([
  // Infraestructura, al persistir.
  'id', 'folio', 'timestamp', 'estado', 'created_at',
  // Dinero: el validador los recalcula y descarta lo propuesto.
  'subtotal', 'total', 'descuento', 'costo_envio',
  'promociones', 'promo_oportunidades', 'ajustesValidacion',
  // Forma canónica del pago: la resuelve el validador contra `metodos_pago`.
  'forma_pago_tipo',
]);
