// ─── Checkout de la Tienda Online ─────────────────────────────────────────
//
// Convierte un carrito público en un PEDIDO REAL de Xabor. No inventa un
// segundo sistema de pedidos: reutiliza el mismo camino que el POS.
//
//   recalcularItemsDesdeMenu  → precios y modificadores validados en servidor
//   construirOrdenPOS         → forma de la orden (cliente, dirección, total)
//   registrarPedido           → folio, persistencia y estado inicial
//   emitirPedido              → tablero en tiempo real + comanda por Edge
//
// Lo único propio de este archivo es lo que no existía: idempotencia del
// checkout público, cálculo de promociones, validación de programación y
// zonas, y el token opaco de seguimiento.
//
// El navegador NO es autoridad de: precio, descuento, envío, total,
// disponibilidad, negocio ni producto. Todo eso se recalcula aquí.
import { randomBytes, createHash } from 'crypto';
import { pool } from './database.js';
import { recalcularItemsDesdeMenu, construirOrdenPOS, POSValidacionError } from './posEnvios.js';
import {
  TiendaError, MODALIDAD_A_PEDIDO, reglasDelNegocio, estadoApertura,
  partesEnZona, metodosPagoTienda,
} from './tiendaOnline.js';
import { calcularPromociones, registrarUsosPromociones } from './tiendaPromociones.js';

const dinero = (n) => Math.round((Number(n) || 0) * 100) / 100;
const tokenOpaco = () => randomBytes(24).toString('hex'); // 192 bits: no enumerable

// Límites duros de payload: la tienda es pública, así que nada de cuerpos
// gigantes ni carritos absurdos.
const MAX_ITEMS = 40;
const MAX_CANTIDAD = 30;
const MAX_TEXTO = 300;

// Saneado de todo texto libre que llega de la calle: fuera caracteres de
// control (inyeccion en cabeceras y en la comanda impresa), colapso de
// espacios y recorte duro de longitud. El escape de HTML lo hace la vista.
// Se construyen con new RegExp para que este archivo no contenga
// caracteres de control literales (un editor podria comerselos).
const CONTROLES = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
const ESPACIOS = new RegExp('\\s+', 'g');
const limpiarTexto = (v, max = MAX_TEXTO) =>
  String(v == null ? '' : v).replace(CONTROLES, ' ').replace(ESPACIOS, ' ').trim().slice(0, max);

// ── Costo de envío por zona ───────────────────────────────────────────────
// Si el negocio definió zonas, la zona manda (y una zona desconocida se
// rechaza). Si no hay zonas, aplica el costo base del negocio.
export function resolverEnvio(reglas, zonaNombre) {
  const zonas = reglas.zonas || [];
  if (!zonas.length) return { costo: dinero(reglas.costoEnvioBase), zona: null };
  const z = zonas.find(x => String(x.nombre || '').toLowerCase() === String(zonaNombre || '').toLowerCase());
  if (!z) {
    throw new TiendaError('Selecciona una zona de entrega válida', 'ZONA_INVALIDA');
  }
  return { costo: dinero(z.costo ?? reglas.costoEnvioBase), zona: z.nombre };
}

// ── Programación ──────────────────────────────────────────────────────────
// El navegador puede mandar cualquier fecha: aquí se valida contra el
// horario real del negocio, la anticipación mínima y la ventana permitida.
export function validarProgramacion({ tienda, reglas, programadoPara, ahora = new Date() }) {
  if (!programadoPara) return { programado: false, para: null };
  if (!tienda.aceptaProgramados) {
    throw new TiendaError('Esta tienda no acepta pedidos programados', 'PROGRAMADOS_NO_DISPONIBLES');
  }
  const fecha = new Date(programadoPara);
  if (Number.isNaN(fecha.getTime())) throw new TiendaError('Fecha inválida', 'FECHA_INVALIDA');

  const minMs = (tienda.anticipacionMinutos || 30) * 60000;
  if (fecha.getTime() - ahora.getTime() < minMs) {
    throw new TiendaError(
      `Los pedidos programados requieren al menos ${tienda.anticipacionMinutos} minutos de anticipación`,
      'ANTICIPACION_INSUFICIENTE');
  }
  const LIMITE_DIAS = 14;
  if (fecha.getTime() - ahora.getTime() > LIMITE_DIAS * 86400000) {
    throw new TiendaError(`Solo se puede programar con ${LIMITE_DIAS} días de anticipación`, 'FECHA_LEJANA');
  }
  // ¿El negocio abre ese día a esa hora?
  const { diaNombre, minutos } = partesEnZona(fecha, reglas.timezone);
  const h = reglas.horarios?.[diaNombre];
  const aMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? +m[1] * 60 + +m[2] : null; };
  if (!h?.abierto) throw new TiendaError('El negocio no abre ese día', 'DIA_CERRADO');
  const ini = aMin(h.apertura), fin = aMin(h.cierre);
  if (ini === null || fin === null || minutos < ini || minutos >= fin) {
    throw new TiendaError(`Ese día atendemos de ${h.apertura} a ${h.cierre}`, 'FUERA_DE_HORARIO');
  }
  return { programado: true, para: fecha.toISOString() };
}

// ── Cotización del carrito (sin crear pedido) ─────────────────────────────
// La usa la tienda para mostrar totales y promociones en vivo. Calcula
// exactamente igual que el checkout, así que lo que ve el cliente es lo que
// se cobra.
export async function cotizarCarrito({ tienda, items, modalidad, zona, codigo, telefono }) {
  const reglas = await reglasDelNegocio(tienda.negocioId);
  const modo = normalizarModalidad(tienda, modalidad);
  const { items: itemsValidados, subtotal } = await recalcularItemsDesdeMenu(tienda.negocioId, items);

  let envioBase = 0, zonaNombre = null;
  if (modo === 'domicilio') {
    const e = resolverEnvio(reglas, zona);
    envioBase = e.costo; zonaNombre = e.zona;
  }

  const promo = await calcularPromociones({
    negocioId: tienda.negocioId, subtotal, items: itemsValidados,
    costoEnvio: envioBase, modalidad: modo, codigo,
    telefono: telefono || null, timezone: reglas.timezone,
  });

  // Pedido mínimo: se evalúa sobre el subtotal REAL, después de descuentos de
  // producto pero antes del envío (criterio del negocio, mismo que POS).
  const minimo = modo === 'domicilio' ? dinero(reglas.pedidoMinimo) : 0;
  const cumpleMinimo = minimo <= 0 || promo.subtotal >= minimo;

  return {
    modalidad: modo,
    zona: zonaNombre,
    ...promo,
    pedidoMinimo: minimo,
    cumpleMinimo,
    faltaParaMinimo: cumpleMinimo ? 0 : dinero(minimo - promo.subtotal),
    tiempoEstimado: modo === 'domicilio'
      ? `${reglas.entregaMin}-${reglas.entregaMax} min`
      : `${reglas.preparacionMinutos} min`,
  };
}

function normalizarModalidad(tienda, modalidad) {
  const modo = String(modalidad || '').toLowerCase();
  if (!MODALIDAD_A_PEDIDO[modo]) throw new TiendaError('Elige cómo quieres recibir tu pedido', 'MODALIDAD_INVALIDA');
  if (!tienda.modalidades.includes(modo)) {
    throw new TiendaError(
      modo === 'domicilio' ? 'Esta tienda no ofrece entrega a domicilio' : 'Esta tienda no ofrece recoger en tienda',
      'MODALIDAD_NO_DISPONIBLE');
  }
  return modo;
}

function validarCarrito(items) {
  if (!Array.isArray(items) || !items.length) throw new TiendaError('Tu carrito está vacío', 'CARRITO_VACIO');
  if (items.length > MAX_ITEMS) throw new TiendaError('Demasiados productos en el carrito', 'CARRITO_EXCEDIDO');
  for (const it of items) {
    const c = parseInt(it?.cantidad, 10) || 1;
    if (c > MAX_CANTIDAD) throw new TiendaError(`Máximo ${MAX_CANTIDAD} unidades por producto`, 'CANTIDAD_EXCEDIDA');
  }
}

// ── Checkout ──────────────────────────────────────────────────────────────
// Idempotencia real y persistente: el mismo checkout_token SIEMPRE devuelve
// el mismo pedido. Un doble click, un refresh, un retry por timeout o el
// navegador repitiendo la petición no crean un segundo pedido — y como la
// reserva se hace con un INSERT único en la base, funciona aunque haya
// varias instancias del proceso.
export async function crearPedidoTienda({
  tienda, checkoutToken, items, modalidad, cliente = {}, direccion = null, zona = null,
  codigo = null, metodoPago = null, programadoPara = null, notas = null,
}) {
  const token = limpiarTexto(checkoutToken, 80);
  if (!token || token.length < 16) throw new TiendaError('Sesión de compra inválida', 'CHECKOUT_TOKEN_INVALIDO');

  // 1) Reserva idempotente ANTES de cualquier trabajo: si el token ya existe,
  //    se devuelve lo que produjo la primera petición.
  const trackingToken = tokenOpaco();
  const { rows: reserva } = await pool.query(
    `INSERT INTO tienda_pedidos (negocio_id, checkout_token, tracking_token, estado)
     VALUES ($1, $2, $3, 'creando')
     ON CONFLICT (negocio_id, checkout_token) DO NOTHING
     RETURNING id, tracking_token`,
    [tienda.negocioId, token, trackingToken]
  );

  if (!reserva.length) {
    // Otra petición con el mismo token ya pasó por aquí.
    const existente = await esperarPedidoDeToken(tienda.negocioId, token);
    if (existente?.pedido_folio) {
      return {
        yaExistia: true,
        folio: existente.pedido_folio,
        trackingToken: existente.tracking_token,
      };
    }
    throw new TiendaError('Tu pedido se está procesando, espera un momento', 'CHECKOUT_EN_CURSO', 409);
  }

  try {
    validarCarrito(items);
    const reglas = await reglasDelNegocio(tienda.negocioId);
    const modo = normalizarModalidad(tienda, modalidad);

    // 2) Apertura: si está cerrado solo se acepta con programación válida.
    const apertura = estadoApertura(reglas);
    const prog = validarProgramacion({ tienda, reglas, programadoPara });
    if (!apertura.abierto && !prog.programado) {
      throw new TiendaError(
        apertura.abreA ? `Ahora estamos cerrados. Abrimos ${apertura.cuando || ''} a las ${apertura.abreA}`
                       : 'Ahora estamos cerrados',
        'CERRADO', 409);
    }

    // 3) Precios y modificadores: recalculados contra el catálogo del negocio.
    const { items: itemsValidados, subtotal } = await recalcularItemsDesdeMenu(tienda.negocioId, items);

    // 4) Envío por zona y pedido mínimo.
    let envioBase = 0, zonaNombre = null;
    if (modo === 'domicilio') {
      const e = resolverEnvio(reglas, zona);
      envioBase = e.costo; zonaNombre = e.zona;
      if (reglas.pedidoMinimo > 0 && subtotal < reglas.pedidoMinimo) {
        throw new TiendaError(`El pedido mínimo a domicilio es $${dinero(reglas.pedidoMinimo)}`, 'PEDIDO_MINIMO');
      }
    }

    // 5) Promociones: el servidor decide el descuento final.
    const telefono = limpiarTexto(cliente?.telefono, 20);
    const promo = await calcularPromociones({
      negocioId: tienda.negocioId, subtotal, items: itemsValidados,
      costoEnvio: envioBase, modalidad: modo, codigo, telefono, timezone: reglas.timezone,
    });
    if (codigo && promo.rechazos.length && !promo.aplicadas.some(a => a.codigo)) {
      throw new TiendaError(promo.rechazos[0].motivo, 'CUPON_NO_APLICABLE');
    }

    // 6) Método de pago: solo los que el negocio tiene habilitados.
    const metodos = await metodosPagoTienda(tienda.negocioId, modo);
    const elegido = metodos.find(m => m.id === metodoPago) || metodos[0];
    if (!elegido) throw new TiendaError('Esta tienda aún no tiene métodos de pago configurados', 'SIN_METODOS_PAGO');

    // 7) Orden con la MISMA forma que usa el POS.
    const orden = construirOrdenPOS({
      negocioId: tienda.negocioId,
      tipo: modo,
      items: itemsValidados,
      subtotal: promo.subtotal,
      costoEnvio: promo.envio,
      descuento: promo.descuento,
      cliente: { nombre: limpiarTexto(cliente?.nombre, 80), telefono },
      direccion: modo === 'domicilio' ? {
        calle: limpiarTexto(direccion?.calle, 120),
        numero_exterior: limpiarTexto(direccion?.numeroExterior, 20),
        numero_interior: limpiarTexto(direccion?.numeroInterior, 20),
        colonia: limpiarTexto(direccion?.colonia, 120),
        entre_calles: limpiarTexto(direccion?.entreCalles, 160),
        referencia: limpiarTexto(direccion?.referencia, 200),
      } : null,
      formaPago: elegido.pagaDespues ? `${elegido.id} (al ${modo === 'domicilio' ? 'recibir' : 'recoger'})` : elegido.id,
      notas: limpiarTexto(notas, 500),
    });

    // Marca de canal y contexto de tienda. El tablero, el corte y los
    // reportes leen estos campos como los de cualquier otro pedido.
    orden.canal = 'tienda_online';
    orden.origen = 'tienda_online';
    orden.tienda = {
      zona: zonaNombre,
      metodo_pago: elegido.id,
      paga_despues: elegido.pagaDespues,
      tracking_token: reserva[0].tracking_token,
      promociones: promo.aplicadas.map(a => ({
        id: a.id, nombre: a.nombre, codigo: a.codigo, tipo: a.tipo,
        descuento: a.descuento, envio_gratis: a.envioGratis, campania_id: a.campaniaId,
      })),
      ahorro: promo.ahorro,
      envio_gratis: promo.envioGratis,
      envio_base: promo.envioBase,
    };
    if (prog.programado) {
      orden.programado_para = prog.para;
      orden.tienda.programado = true;
    }
    // Un pedido que se paga al entregar nace por cobrar, igual que el
    // mostrador: el cobro se cierra en el panel cuando el dinero llega.
    if (elegido.pagaDespues) orden.pago_confirmado = false;

    // 8) Alta del pedido por el camino de siempre.
    const { registrarPedido, emitirPedido } = await import('../orders/orderManager.js');
    const pedido = await registrarPedido(orden, 'tienda_online');

    // 9) Persistencia del vínculo ANTES de emitir: si el cliente reintenta en
    //    ese instante, ya encuentra su folio.
    await pool.query(
      `UPDATE tienda_pedidos SET pedido_folio = $3, estado = 'creado', updated_at = NOW()
        WHERE negocio_id = $1 AND checkout_token = $2`,
      [tienda.negocioId, token, pedido.id]
    );

    // Cliente e historial: mismo orden que el POS (FK pedidos.telefono).
    try {
      const { upsertCliente, guardarPedido } = await import('./database.js');
      await upsertCliente(telefono, orden.cliente.nombre, tienda.negocioId);
      await guardarPedido(telefono, pedido, tienda.negocioId);
    } catch (e) {
      console.error('[Tienda] Error persistiendo pedido en historial:', e.message);
    }

    // 10) Tablero en tiempo real + comanda por Edge (una sola vez: emitirPedido
    //     ya es el único punto de impresión de todo Xabor).
    emitirPedido(pedido);

    // 11) Atribución de promociones/campañas (idempotente por folio).
    if (promo.aplicadas.length) {
      const esNuevo = !(await clienteTienePedidosPrevios(tienda.negocioId, telefono, pedido.id));
      await registrarUsosPromociones({
        negocioId: tienda.negocioId, folio: pedido.id, aplicadas: promo.aplicadas,
        telefono, montoVenta: promo.total, clienteNuevo: esNuevo,
      });
    }

    return {
      yaExistia: false,
      folio: pedido.id,
      trackingToken: reserva[0].tracking_token,
      total: promo.total,
      ahorro: promo.ahorro,
      programadoPara: prog.para,
      metodoPago: elegido,
    };
  } catch (e) {
    // La reserva se libera para que el cliente pueda corregir y reintentar
    // con el mismo token sin quedar bloqueado.
    await pool.query(
      `DELETE FROM tienda_pedidos WHERE negocio_id = $1 AND checkout_token = $2 AND pedido_folio IS NULL`,
      [tienda.negocioId, token]
    ).catch(() => {});
    if (e instanceof POSValidacionError) throw new TiendaError(e.message, e.codigo || 'VALIDACION');
    throw e;
  }
}

async function esperarPedidoDeToken(negocioId, token, intentos = 10) {
  for (let i = 0; i < intentos; i++) {
    const { rows } = await pool.query(
      `SELECT pedido_folio, tracking_token FROM tienda_pedidos
        WHERE negocio_id = $1 AND checkout_token = $2`,
      [negocioId, token]
    );
    if (rows[0]?.pedido_folio) return rows[0];
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

async function clienteTienePedidosPrevios(negocioId, telefono, folioActual) {
  if (!telefono) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM pedidos_activos
      WHERE negocio_id = $1 AND datos->'cliente'->>'telefono' = $2 AND folio <> $3 LIMIT 1`,
    [negocioId, telefono, folioActual]
  );
  return rows.length > 0;
}

// ── Seguimiento público ───────────────────────────────────────────────────
// Token opaco de 192 bits: no se puede enumerar y no expone folios ni ids
// internos. Devuelve solo lo que el cliente necesita ver.
const ETAPAS_RECOGER = ['recibido', 'preparando', 'listo', 'entregado'];
const ETAPAS_DOMICILIO = ['recibido', 'preparando', 'listo', 'en_camino', 'entregado'];

export async function seguimientoPublico(trackingToken) {
  const token = String(trackingToken || '').trim();
  if (!/^[a-f0-9]{48}$/.test(token)) throw new TiendaError('Pedido no encontrado', 'TRACKING_INVALIDO', 404);

  const { rows } = await pool.query(
    `SELECT tp.pedido_folio, tp.negocio_id, pa.estado, pa.datos, n.nombre AS negocio,
            tc.titular, tc.logo_url, tc.color_primario
       FROM tienda_pedidos tp
       JOIN negocios n ON n.id = tp.negocio_id
       LEFT JOIN tienda_config tc ON tc.negocio_id = tp.negocio_id
       LEFT JOIN pedidos_activos pa ON pa.folio = tp.pedido_folio AND pa.negocio_id = tp.negocio_id
      WHERE tp.tracking_token = $1`,
    [token]
  );
  const r = rows[0];
  if (!r || !r.pedido_folio) throw new TiendaError('Pedido no encontrado', 'TRACKING_NO_EXISTE', 404);

  const datos = r.datos || {};
  const esDomicilio = String(datos.modalidad || '').includes('domicilio');
  const etapas = esDomicilio ? ETAPAS_DOMICILIO : ETAPAS_RECOGER;
  const mapa = { nuevo: 'recibido', en_preparacion: 'preparando', listo: 'listo', entregado: 'entregado' };
  const actual = r.estado === 'cancelado' ? 'cancelado' : (mapa[r.estado] || 'recibido');
  const repartidorAsignado = !!datos.repartidor_id;
  const etapaEfectiva = (esDomicilio && actual === 'listo' && repartidorAsignado) ? 'en_camino' : actual;

  return {
    // El folio corto sí se muestra: es lo que el cliente dice por teléfono.
    // No se expone ningún id interno, teléfono de otro, ni el negocio_id.
    folio: r.pedido_folio,
    negocio: r.titular || r.negocio,
    logo: r.logo_url || null,
    color: r.color_primario || null,
    cancelado: r.estado === 'cancelado',
    modalidad: esDomicilio ? 'domicilio' : 'recoger',
    etapaActual: etapaEfectiva,
    etapas: etapas.map(e => ({
      clave: e,
      etiqueta: ETIQUETAS_ETAPA[e],
      cumplida: etapas.indexOf(e) <= etapas.indexOf(etapaEfectiva),
      actual: e === etapaEfectiva,
    })),
    total: Number(datos.total) || 0,
    programadoPara: datos.programado_para || null,
    items: (datos.items || []).map(i => ({ nombre: i.nombre, cantidad: i.cantidad })),
  };
}

const ETIQUETAS_ETAPA = {
  recibido: 'Recibido',
  preparando: 'En preparación',
  listo: 'Listo',
  en_camino: 'En camino',
  entregado: 'Entregado',
};

// Hash del payload: útil para depurar reintentos con contenido distinto bajo
// el mismo token (no bloquea, pero deja rastro).
export function huellaPayload(obj) {
  return createHash('sha256').update(JSON.stringify(obj || {})).digest('hex').slice(0, 16);
}
