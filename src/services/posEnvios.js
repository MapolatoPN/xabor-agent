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
import { cargarGruposDeProductos, resolverSeleccion, ModificadoresError } from './modificadores.js';

export class POSValidacionError extends Error {
  constructor(mensaje, codigo) { super(mensaje); this.name = 'POSValidacionError'; this.codigo = codigo; }
}

const MODALIDAD_POR_TIPO = {
  recoger: 'recoger en tienda',
  domicilio: 'entrega a domicilio',
};

// Recalcula SIEMPRE desde el catalogo del propio negocio. Nunca confia en el
// precio que mande el frontend. Para tienda_online, el precio autoritativo es
// tienda_productos.precio_tienda cuando existe y el producto debe continuar
// publicado; para POS sigue siendo menu_productos.precio.
export async function recalcularItemsDesdeMenu(negocioId, itemsCrudos, { canal = 'pos' } = {}) {
  if (!Array.isArray(itemsCrudos) || itemsCrudos.length === 0) {
    throw new POSValidacionError('El pedido no tiene productos', 'SIN_ITEMS');
  }
  const ids = itemsCrudos.map(i => String(i.producto_id ?? i.id ?? '')).filter(Boolean);
  if (ids.length !== itemsCrudos.length) {
    throw new POSValidacionError('Cada producto debe traer producto_id', 'ITEM_SIN_ID');
  }
  const esTiendaOnline = canal === 'tienda_online';
  // Solo productos del negocio de la sesion: el WHERE negocio_id es la
  // frontera de tenant; un id ajeno no aparece. En tienda, ademas, el JOIN
  // impide comprar por HTTP un producto que ya no esta publicado.
  const { rows } = await pool.query(
    `SELECT p.id, p.nombre, p.precio, p.disponible, p.agotado, p.categoria_id,
            CASE WHEN $3::text = 'tienda_online' THEN tp.precio_tienda ELSE NULL END AS precio_tienda
       FROM menu_productos p
       LEFT JOIN tienda_productos tp
         ON tp.negocio_id = p.negocio_id AND tp.producto_id = p.id
      WHERE p.negocio_id = $1 AND p.id = ANY($2::int[])
        AND ($3::text <> 'tienda_online' OR tp.publicado = TRUE)`,
    [negocioId, ids.map(Number), esTiendaOnline ? 'tienda_online' : 'pos']
  );
  const porId = new Map(rows.map(r => [String(r.id), r]));
  // Grupos y opciones reales de estos productos (una sola consulta): el
  // precio de cada modificador SIEMPRE sale de aqui, nunca del frontend.
  const gruposPorProducto = await cargarGruposDeProductos(negocioId, rows.map(r => r.id));

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
    // Modificadores: el frontend manda SOLO ids de opcion. Nombres, precios
    // extra, pertenencia al producto, minimos/maximos y disponibilidad salen
    // de la base (resolverSeleccion, modificadores.js). Antes se aceptaba un
    // arreglo "extras" con el precio que mandara el cliente HTTP -- se podia
    // cobrar "Bistec en Salsa" con precio_extra 0. Ese camino ya no existe.
    const grupos = gruposPorProducto.get(prod.id) || [];
    const { modificadores, precioExtras, texto } = resolverSeleccion(prod, grupos, crudo.modificadores);

    const precioLista = Number(prod.precio);
    const tienePrecioTienda = esTiendaOnline && prod.precio_tienda !== null && prod.precio_tienda !== undefined;
    const precioBase = tienePrecioTienda ? Number(prod.precio_tienda) : precioLista;
    const precioUnitario = Math.round((precioBase + precioExtras) * 100) / 100;
    subtotal += precioUnitario * cantidad;
    const notasLibres = String(crudo.notas || '').slice(0, 300);
    return {
      producto_id: Number(pid),
      categoria_id: prod.categoria_id ?? null,
      nombre: prod.nombre,
      cantidad,
      precio_unitario: precioUnitario,
      precio_base: precioBase,
      // Los dos valores quedan congelados. El corte puede auditar un precio
      // especial sin consultar el catalogo actual ni inventar el ahorro.
      precio_lista: precioLista,
      precio_canal: precioBase,
      ...(tienePrecioTienda ? { precio_especial: precioBase } : {}),
      // Snapshot: el pedido conserva lo elegido aunque el menu cambie manana.
      modificadores,
      extras: modificadores.map(m => ({ nombre: m.opcion, precio_extra: m.precio_extra })),
      notas: [texto, notasLibres].filter(Boolean).join(' · ').slice(0, 400),
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

// Hotfix P0 folio: la reserva de la clave ocurre AHORA antes del primer
// await (misma idea que la reserva de folio en registrarPedido). El flujo
// anterior era buscar → crear (dos awaits) → recordar: dos clics realmente
// simultáneos pasaban los dos por ese hueco. El bug de folio lo disimulaba
// (ambos obtenían el MISMO folio porque el contador se incrementaba después
// del await, y el segundo INSERT se perdía en silencio, así que la respuesta
// parecía idempotente); corregido el folio, ese mismo hueco crearía DOS
// pedidos reales. Con la reserva, el segundo request espera el resultado del
// primero y responde con su folio.
//   { reservado: true,  confirmar(folio), liberar(error) } → este request crea.
//   { reservado: false, folio, enCurso }                   → ya hay otro; si
//     enCurso no es null, la creación sigue en vuelo y hay que esperarla.
export function reservarIdempotencia(negocioId, key) {
  if (!key) return { reservado: true, confirmar: () => {}, liberar: () => {} };
  const k = `${negocioId}:${key}`;
  const v = _idempotencia.get(k);
  if (v && Date.now() <= v.expira) return { reservado: false, folio: v.folio, enCurso: v.enCurso };
  let resolver, rechazar;
  const enCurso = new Promise((res, rej) => { resolver = res; rechazar = rej; });
  enCurso.catch(() => {}); // nadie más puede estar esperándola todavía
  const entrada = { folio: null, enCurso, expira: Date.now() + IDEMPOTENCIA_TTL_MS };
  _idempotencia.set(k, entrada);
  return {
    reservado: true,
    confirmar(folio) {
      entrada.folio = folio;
      entrada.enCurso = null;
      entrada.expira = Date.now() + IDEMPOTENCIA_TTL_MS;
      resolver(folio);
    },
    liberar(e) {
      _idempotencia.delete(k); // el pedido no existió: un reintento debe poder crearlo
      rechazar(e instanceof Error ? e : new Error('POS_CREACION_FALLIDA'));
    },
  };
}

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
