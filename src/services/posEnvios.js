// POS — Envíos / Pedidos a domicilio.
//
// Regla de oro de la fase: NO hay motor paralelo. Este módulo solo prepara
// y VALIDA la orden (precios reales del menú del propio negocio, teléfono
// normalizado, dirección estructurada) para entregarla al motor existente
// (orderManager.registrarPedido/emitirPedido). Los pagos (pagosService), la
// red de repartidores (notificarRepartidoresPorWA) y las comandas/impresión
// (emitirPedido) se reutilizan tal cual desde el servidor.
//
// Multi-tenant (crítico, tras el hallazgo de Carnitas Moreno): el negocioId
// SIEMPRE llega desde la sesión autenticada del llamador; aquí nunca se lee
// de un body/query. Además, cada producto se revalida contra el menú del
// negocio: un producto de otro tenant se rechaza (no solo se ignora su
// precio).
import { pool } from './database.js';
import { normalizarTelefonoMX } from '../utils/telefono.js';

export class POSValidacionError extends Error {
  constructor(mensaje, codigo) { super(mensaje); this.name = 'POSValidacionError'; this.codigo = codigo; }
}

const MODALIDAD_POR_TIPO = {
  recoger: 'recoger en tienda',
  domicilio: 'entrega a domicilio',
};

// Recalcula SIEMPRE desde menu_productos del propio negocio. Nunca confía en
// el precio que mande el frontend. Rechaza productos que no existen, están
// no disponibles, o pertenecen a otro negocio (defensa multi-tenant).
export async function recalcularItemsDesdeMenu(negocioId, itemsCrudos) {
  if (!Array.isArray(itemsCrudos) || itemsCrudos.length === 0) {
    throw new POSValidacionError('El pedido no tiene productos', 'SIN_ITEMS');
  }
  const ids = itemsCrudos.map(i => String(i.producto_id ?? i.id ?? '')).filter(Boolean);
  if (ids.length !== itemsCrudos.length) {
    throw new POSValidacionError('Cada producto debe traer producto_id', 'ITEM_SIN_ID');
  }
  // Solo productos del negocio de la sesión: el WHERE negocio_id es la
  // frontera de tenant; un id de otro negocio simplemente no aparece aquí.
  const { rows } = await pool.query(
    `SELECT id, nombre, precio, disponible, agotado FROM menu_productos
     WHERE negocio_id = $1 AND id = ANY($2::int[])`,
    [negocioId, ids.map(Number)]
  );
  const porId = new Map(rows.map(r => [String(r.id), r]));

  let subtotal = 0;
  const items = itemsCrudos.map((crudo) => {
    const pid = String(crudo.producto_id ?? crudo.id);
    const prod = porId.get(pid);
    if (!prod) {
      throw new POSValidacionError(`Producto ${pid} no pertenece a este negocio o no existe`, 'PRODUCTO_AJENO');
    }
    if (prod.disponible === false || prod.agotado === true) {
      throw new POSValidacionError(`El producto "${prod.nombre}" no está disponible`, 'PRODUCTO_NO_DISPONIBLE');
    }
    const cantidad = Math.max(1, Math.min(99, parseInt(crudo.cantidad, 10) || 1));
    // Extras: solo se suman los que traen precio_extra numérico; el nombre
    // se conserva para la comanda pero el precio SIEMPRE es el enviado por
    // el operador validado a número (no hay tabla de extras con precio fijo
    // por id en este MVP — documentado como mejora futura).
    const extras = Array.isArray(crudo.extras) ? crudo.extras.map(e => ({
      nombre: String(e.nombre || '').slice(0, 80),
      precio_extra: Number.isFinite(Number(e.precio_extra)) ? Number(e.precio_extra) : 0,
    })) : [];
    const precioBase = Number(prod.precio);
    const precioExtras = extras.reduce((s, e) => s + e.precio_extra, 0);
    const precioUnitario = precioBase + precioExtras;
    subtotal += precioUnitario * cantidad;
    return {
      producto_id: Number(pid),
      nombre: prod.nombre,
      cantidad,
      precio_unitario: precioUnitario,
      precio_base: precioBase,
      extras,
      notas: String(crudo.notas || '').slice(0, 300),
    };
  });

  return { items, subtotal: Math.round(subtotal * 100) / 100 };
}

// Construye el objeto `orden` que consume registrarPedido. El total lo
// calcula el backend (subtotal recalculado + envío − descuento), nunca el
// cliente HTTP.
export function construirOrdenPOS({
  negocioId, tipo, items, subtotal, costoEnvio = 0, descuento = 0,
  cliente, direccion = null, formaPago = 'efectivo', notas = null, sucursalId = null,
}) {
  if (!MODALIDAD_POR_TIPO[tipo]) {
    throw new POSValidacionError('Tipo de pedido inválido (recoger | domicilio)', 'TIPO_INVALIDO');
  }
  const nombre = String(cliente?.nombre || '').trim();
  if (!nombre) throw new POSValidacionError('El nombre del cliente es obligatorio', 'NOMBRE_REQUERIDO');

  const telNorm = normalizarTelefonoMX(cliente?.telefono || '');
  if (!telNorm) throw new POSValidacionError('El teléfono del cliente es inválido', 'TELEFONO_INVALIDO');

  const envio = tipo === 'domicilio' ? (Number.isFinite(Number(costoEnvio)) ? Number(costoEnvio) : 0) : 0;
  if (envio < 0) throw new POSValidacionError('El costo de envío no puede ser negativo', 'ENVIO_INVALIDO');
  const desc = Number.isFinite(Number(descuento)) ? Math.max(0, Number(descuento)) : 0;

  let clienteObj = { nombre, telefono: telNorm };
  if (tipo === 'domicilio') {
    const calle = String(direccion?.calle || '').trim();
    const colonia = String(direccion?.colonia || '').trim();
    if (!calle) throw new POSValidacionError('La calle es obligatoria para domicilio', 'CALLE_REQUERIDA');
    if (!colonia) throw new POSValidacionError('La colonia es obligatoria para domicilio', 'COLONIA_REQUERIDA');
    // Campos independientes (no un único string) — disponibles para comanda,
    // repartidor, portal, ruta e historial.
    clienteObj = {
      nombre, telefono: telNorm,
      calle,
      numero_exterior: String(direccion?.numero_exterior || '').trim() || null,
      numero_interior: String(direccion?.numero_interior || '').trim() || null,
      colonia,
      entre_calles: String(direccion?.entre_calles || '').trim() || null,
      referencia: String(direccion?.referencia || '').trim() || null,
    };
  }

  const total = Math.round((subtotal + envio - desc) * 100) / 100;
  if (total < 0) throw new POSValidacionError('El total no puede ser negativo', 'TOTAL_INVALIDO');

  return {
    items,
    subtotal,
    descuento: desc,
    costo_envio: envio,
    total,
    modalidad: MODALIDAD_POR_TIPO[tipo],
    canal: 'pos',
    origen: 'manual',
    forma_pago: formaPago || 'efectivo',
    cliente: clienteObj,
    notas: notas ? String(notas).slice(0, 500) : null,
    sucursal_id: sucursalId || null,
    negocioId,
  };
}

// Idempotencia de creación: dedupe en memoria por (negocio, key) durante una
// ventana corta, para que un doble clic / reintento de red no cree dos
// pedidos. No sustituye la persistencia; es la primera barrera antes de
// tocar el motor. TTL corto porque solo cubre el reintento inmediato.
const _idempotencia = new Map(); // `${negocioId}:${key}` -> { folio, expira }
const IDEMPOTENCIA_TTL_MS = 60 * 1000;

export function recordarIdempotencia(negocioId, key, folio) {
  if (!key) return;
  _idempotencia.set(`${negocioId}:${key}`, { folio, expira: Date.now() + IDEMPOTENCIA_TTL_MS });
}
export function buscarIdempotencia(negocioId, key) {
  if (!key) return null;
  const k = `${negocioId}:${key}`;
  const v = _idempotencia.get(k);
  if (!v) return null;
  if (Date.now() > v.expira) { _idempotencia.delete(k); return null; }
  return v.folio;
}
