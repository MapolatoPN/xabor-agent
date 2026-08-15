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
import { pool, poolDeClaims } from './database.js';
import { recalcularItemsDesdeMenu, construirOrdenPOS, POSValidacionError } from './posEnvios.js';
import {
  TiendaError, MODALIDAD_A_PEDIDO, reglasDelNegocio, estadoApertura,
  partesEnZona, metodosPagoTienda,
} from './tiendaOnline.js';
import {
  calcularPromociones, registrarUsosPromociones,
  reservarUsosPromociones, liberarUsosPromociones,
} from './tiendaPromociones.js';

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

// ── Traducción del carrito público al formato del validador ───────────────
// La tienda habla camelCase hacia la calle; el motor de pedidos del POS usa
// producto_id. Esta es la ÚNICA frontera donde se traduce, y se traduce solo
// la forma: ni precios ni nombres pasan de aquí, porque recalcularItemsDesde-
// Menu los vuelve a leer de la base.
function itemsParaValidador(items) {
  if (!Array.isArray(items)) return [];
  return items.map(i => ({
    producto_id: i?.producto_id ?? i?.productoId ?? i?.id,
    cantidad: i?.cantidad,
    modificadores: i?.modificadores,
    notas: i?.notas,
  }));
}

// Los errores del validador (producto ajeno, opción inválida, grupo
// obligatorio sin elegir) son culpa del carrito, no del servidor: se
// convierten en 400 con el mensaje real en vez de un 500 opaco que dejaría
// al cliente sin saber qué corregir.
async function validarCarrito(negocioId, items) {
  // Primero los límites de carga: la tienda es pública y no se le va a pedir
  // a Postgres que resuelva un carrito de diez mil renglones.
  if (!Array.isArray(items) || !items.length) throw new TiendaError('Tu carrito está vacío', 'CARRITO_VACIO');
  if (items.length > MAX_ITEMS) throw new TiendaError('Demasiados productos en el carrito', 'CARRITO_EXCEDIDO');
  for (const it of items) {
    const c = parseInt(it?.cantidad, 10) || 1;
    if (c > MAX_CANTIDAD) throw new TiendaError(`Máximo ${MAX_CANTIDAD} unidades por producto`, 'CANTIDAD_EXCEDIDA');
    if (c < 1) throw new TiendaError('Cantidad inválida', 'CANTIDAD_INVALIDA');
  }
  try {
    return await recalcularItemsDesdeMenu(negocioId, itemsParaValidador(items));
  } catch (e) {
    if (e instanceof POSValidacionError || e?.name === 'ModificadoresError') {
      throw new TiendaError(e.message, e.codigo || 'CARRITO_INVALIDO', 400);
    }
    throw e;
  }
}

// ── Dirección ─────────────────────────────────────────────────────────────
// A un cliente con el teléfono en la mano no se le piden seis campos: la
// tienda le pide UNA dirección escrita como la diría en voz alta. El POS, en
// cambio, guarda una dirección estructurada. Aquí se acepta cualquiera de las
// dos formas y se entrega siempre la estructurada.
//
// Cuando llega texto libre va completo a `calle`: partirlo con expresiones
// regulares adivinaría mal y el repartidor prefiere leer lo que el cliente
// escribió, tal cual, a leer una separación inventada.
function direccionParaPedido(direccion, zonaNombre, colonia = null) {
  // La colonia es obligatoria para el POS (la necesita el repartidor). Puede
  // venir de dos lados: de la ZONA elegida, cuando el negocio definió zonas de
  // reparto, o de un campo propio cuando cobra tarifa plana y no tiene zonas.
  // Un negocio sin zonas es una configuración legítima -- no puede quedarse
  // sin poder recibir pedidos a domicilio.
  const coloniaFinal = limpiarTexto(colonia, 120) || zonaNombre || null;
  const texto = typeof direccion === 'string' ? limpiarTexto(direccion, 240) : '';
  if (texto) {
    return {
      calle: texto,
      numero_exterior: null, numero_interior: null,
      colonia: coloniaFinal, entre_calles: null, referencia: null,
    };
  }
  return {
    calle: limpiarTexto(direccion?.calle, 120),
    numero_exterior: limpiarTexto(direccion?.numeroExterior, 20) || null,
    numero_interior: limpiarTexto(direccion?.numeroInterior, 20) || null,
    colonia: limpiarTexto(direccion?.colonia, 120) || coloniaFinal,
    entre_calles: limpiarTexto(direccion?.entreCalles, 160) || null,
    referencia: limpiarTexto(direccion?.referencia, 200) || null,
  };
}

// ── Cotización del carrito (sin crear pedido) ─────────────────────────────
// La usa la tienda para mostrar totales y promociones en vivo. Calcula
// exactamente igual que el checkout, así que lo que ve el cliente es lo que
// se cobra.
export async function cotizarCarrito({ tienda, items, modalidad, zona, codigo, telefono }) {
  const reglas = await reglasDelNegocio(tienda.negocioId);
  const modo = normalizarModalidad(tienda, modalidad);
  const { items: itemsValidados, subtotal } = await validarCarrito(tienda.negocioId, items);

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

  // Pedido mínimo: se evalúa sobre el valor de los productos ANTES de
  // descuentos y sin contar el envío. Es lo correcto para el negocio: el
  // cupón es su propia promoción, y no tendría sentido que aplicarlo dejara
  // al cliente por debajo del mínimo que el negocio necesita para salir.
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

// ── Inyección de fallos (solo pruebas) ────────────────────────────────────
// La recuperación ante crash no se puede probar esperando a que el proceso se
// caiga solo: hay que provocarlo en el punto exacto. Se activa con una
// variable de entorno y NUNCA en producción — si NODE_ENV es 'production',
// esta función no hace nada aunque la variable esté puesta.
function fallaInyectada(punto) {
  if (process.env.NODE_ENV === 'production') return;
  if (process.env.XABOR_TIENDA_FALLA_EN !== punto) return;
  const e = new Error(`Fallo inyectado en '${punto}' (prueba de recuperación)`);
  e.inyectado = true;
  throw e;
}

// Hermano del anterior, con el mismo candado de producción: alarga un punto del
// flujo para poder provocar de forma DETERMINISTA la carrera entre dos
// finalizadores. Sin esto, "A todavía tiene el lock cuando llega B" dependería
// de la suerte del planificador.
async function retardoInyectado(punto) {
  if (process.env.NODE_ENV === 'production') return;
  if (process.env.XABOR_TIENDA_RETARDO_EN !== punto) return;
  const ms = Number(process.env.XABOR_TIENDA_RETARDO_MS) || 0;
  if (ms > 0) await new Promise(r => setTimeout(r, ms));
}

// ── Recuperación tras crash ───────────────────────────────────────────────
// Busca el pedido que un checkout YA creó, aunque el vínculo en tienda_pedidos
// no se haya alcanzado a escribir. La fuente de verdad es el propio pedido:
// lleva el checkout_token estampado desde antes de existir.
async function buscarPedidoDeCheckout(negocioId, token) {
  const { rows } = await pool.query(
    `SELECT folio, datos FROM pedidos_activos
      WHERE negocio_id = $1 AND datos->'tienda'->>'checkout_token' = $2
      LIMIT 1`,
    [negocioId, token]
  );
  return rows[0] || null;
}

// Deja el checkout completo, corra las veces que corra.
//
// No basta con repetir los pasos: volver a llamar a emitirPedido imprimiría
// papel otra vez en los negocios que aún usan el camino legacy (Edge sí es
// idempotente por clave, y la oferta a repartidores está deduplicada por
// (folio, repartidor), pero la impresión vieja no) y el panel volvería a
// anunciar el pedido como nuevo.
//
// Por eso cada derivación deja marca PERSISTENTE en tienda_pedidos.derivaciones.
// Un reintento retoma solo lo que falta; cinco reintentos seguidos no hacen
// nada la segunda vez.
//
// La marca se escribe DESPUÉS de que la derivación tuvo éxito. Un crash entre
// "emitirPedido terminó" y "se escribió la marca" hace que un reintento la
// repita, y por eso la marca NO es la única defensa: los tres efectos que
// dejarían rastro visible tienen idempotencia propia y persistente -- comanda
// Edge por clave (negocio, pedido, impresora), oferta a repartidores por
// (folio, repartidor), impresión legacy por impresion_legacy_emitida. Al revés
// -- marcar antes de hacer -- el riesgo sería peor: un pedido sin comanda que
// nadie vuelve a intentar.
// Corre `fn` solo si esa derivación no está marcada, y la marca al terminar.
//
// El claim es ATÓMICO, no un SELECT seguido de un UPDATE. Consultar "¿está
// pendiente?" y marcar después deja un hueco: dos finalizadores concurrentes
// leen "pendiente" a la vez y los dos ejecutan la misma derivación antes de
// que ninguno alcance a marcar. Para `emision` eso significaba dos comandas
// por el camino legacy y dos avisos al panel.
//
// El lock de Postgres es lo único que los dos procesos ven, y va en la MISMA
// transacción que la marca: cuando el lock se suelta (COMMIT), la marca ya es
// visible. No queda ningún instante en el que otro proceso pueda entrar y
// encontrar "pendiente" una derivación que en realidad ya terminó.
//
// try_ y no la versión que espera: si otro proceso ya está corriendo ESTA
// derivación, no hay nada que hacer más que dejarlo trabajar. Esperar solo
// retendría una conexión del pool -- y con diez reintentos simultáneos eso
// vacía el pool que el dueño necesita para terminar.
//
// Un lock resuelve la concurrencia y NADA MÁS. El crash después del efecto y
// antes de la marca lo resuelve la idempotencia real de cada efecto: Edge por
// clave de impresión, repartidores por (folio, repartidor), impresión legacy
// por la tabla impresion_legacy_emitida. Los dos mecanismos hacen falta;
// ninguno sustituye al otro.
const DERIVACION = { HECHA: 'hecha', YA_ESTABA: 'ya_estaba', OCUPADA: 'ocupada' };

// ¿Falta esta derivación? Consulta suelta: pide una conexión y la devuelve.
// Nunca se llama con una conexión retenida.
async function derivacionPendiente(negocioId, token, nombre) {
  const { rows: [r] } = await pool.query(
    // jsonb_exists en vez del operador ?: con un parametro, Postgres no puede
    // inferir el tipo de $3 para ? y falla con "could not determine data type".
    `SELECT jsonb_exists(derivaciones, $3::text) AS hecha FROM tienda_pedidos
      WHERE negocio_id = $1 AND checkout_token = $2`,
    [negocioId, token, nombre]);
  return !r?.hecha;
}

async function derivacion(negocioId, token, nombre, fn) {
  // Pool APARTE (ver poolDeClaims en database.js): esta conexión queda ocupada
  // mientras corre `fn`, y `fn` necesita conexiones para trabajar. Con un solo
  // pool, N checkouts simultáneos se bloquearían entre sí para siempre.
  const cliente = await poolDeClaims().connect();
  try {
    await cliente.query('BEGIN');

    const { rows: [lock] } = await cliente.query(
      `SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS obtenido`,
      [`tienda_derivacion:${negocioId}:${token}`, nombre]);
    if (!lock?.obtenido) {
      await cliente.query('ROLLBACK');
      return DERIVACION.OCUPADA;
    }

    const { rows: [r] } = await cliente.query(
      `SELECT jsonb_exists(derivaciones, $3::text) AS hecha FROM tienda_pedidos
        WHERE negocio_id = $1 AND checkout_token = $2`,
      [negocioId, token, nombre]);
    if (r?.hecha) {
      await cliente.query('ROLLBACK');
      return DERIVACION.YA_ESTABA;
    }

    await retardoInyectado(`dentro_de_${nombre}`);
    await fn();

    await cliente.query(
      `UPDATE tienda_pedidos
          SET derivaciones = derivaciones || jsonb_build_object($3::text, NOW()::text),
              updated_at = NOW()
        WHERE negocio_id = $1 AND checkout_token = $2`,
      [negocioId, token, nombre]);
    await cliente.query('COMMIT');
    return DERIVACION.HECHA;
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

// Espera del lado del SERVIDOR a que la marca aparezca. No retiene ninguna
// conexión mientras espera: cada sondeo pide una y la devuelve.
const ESPERA_MARCA_MS = Number(process.env.XABOR_TIENDA_ESPERA_MARCA_MS) || 250;
const SONDEOS_MARCA = Number(process.env.XABOR_TIENDA_SONDEOS_MARCA) || 12;

async function esperarMarca(negocioId, token, nombre) {
  for (let i = 0; i < SONDEOS_MARCA; i++) {
    await new Promise(r => setTimeout(r, ESPERA_MARCA_MS));
    if (!(await derivacionPendiente(negocioId, token, nombre))) return true;
  }
  return false;
}

// Derivación de la que DEPENDE poder decirle al cliente "tu pedido está hecho".
//
// Perder el lock no es lo mismo que haber terminado. Si otro proceso la está
// ejecutando, este NO puede responder 200 apostando a que al otro le salga
// bien: si el ganador se cae, el cliente se quedaría con un "pedido recibido"
// y la cocina sin papel -- justo el fallo que se corrigió antes, por otra
// puerta.
//
// Así que se espera a que la marca APAREZCA, que es la única prueba de que
// terminó de verdad. Si no aparece dentro de la ventana, se responde 409 y el
// cliente reintenta: el reintento encontrará el lock libre (el ganador murió) y
// retomará el trabajo. Nunca se resuelve con reintentos a ciegas del navegador.
async function derivacionCritica(negocioId, token, nombre, fn) {
  const estado = await derivacion(negocioId, token, nombre, fn);
  if (estado !== DERIVACION.OCUPADA) return estado;
  if (await esperarMarca(negocioId, token, nombre)) return DERIVACION.YA_ESTABA;
  throw new TiendaError(
    'Tu pedido se está procesando, espera un momento', 'CHECKOUT_EN_CURSO', 409);
}

export async function finalizarCheckout({ negocioId, token, pedido, datosPedido, promoAplicadas = null }) {
  const datos = datosPedido || pedido?.datos || pedido || {};
  const telefono = datos?.cliente?.telefono || null;

  // 1) Vínculo checkout → pedido. Naturalmente idempotente (UPDATE por token),
  //    y tiene que ir SIEMPRE primero: es lo que permite recuperar el resto.
  await pool.query(
    `UPDATE tienda_pedidos SET pedido_folio = $3, estado = 'creado', updated_at = NOW()
      WHERE negocio_id = $1 AND checkout_token = $2 AND pedido_folio IS DISTINCT FROM $3`,
    [negocioId, token, pedido.id]
  );
  fallaInyectada('despues_de_vincular');

  // 2) Cliente e historial. NO es crítica: si otro proceso la tiene tomada, o
  //    si falla, el pedido sigue siendo válido y el siguiente intento la
  //    repone. Es la única de las tres que no condiciona el 200.
  await derivacion(negocioId, token, 'historial', async () => {
    try {
      const { upsertCliente, guardarPedido } = await import('./database.js');
      if (telefono) {
        await upsertCliente(telefono, datos?.cliente?.nombre || null, negocioId);
        await guardarPedido(telefono, pedido, negocioId);
      }
    } catch (e) {
      // El historial no puede tumbar un pedido que ya existe. Se registra y
      // NO se marca como hecha, para que el siguiente intento lo reponga.
      console.error('[Tienda] Error persistiendo pedido en historial:', e.message);
      throw e;
    }
  }).catch(() => {});

  fallaInyectada('antes_de_emitir');

  // 3) Emisión: comanda por Edge, tablero y oferta a repartidores. Se espera
  //    de verdad -- "finalizado" no puede significar "disparé una promesa y
  //    ojalá sobreviva al proceso".
  //    CRÍTICA: sin esto no hay comanda. Responder 200 sin confirmarla sería
  //    decirle al cliente que su pedido está hecho apostando a que a otro
  //    proceso le salga bien.
  await derivacionCritica(negocioId, token, 'emision', async () => {
    const { emitirPedido } = await import('../orders/orderManager.js');
    await emitirPedido(pedido);
    // El punto más incómodo del flujo: el efecto externo YA ocurrió (el papel
    // salió, el panel se enteró) pero la marca todavía no está escrita. Un
    // crash aquí es lo que obliga a que cada efecto tenga idempotencia propia
    // y no solo el ledger. Se inyecta para poder probarlo de verdad.
    fallaInyectada('emitido_sin_marcar');
  });

  fallaInyectada('despues_de_emitir');

  // 4) Atribución de promociones. Idempotente por UNIQUE (negocio, promo,
  //    folio), pero la marca evita hasta la consulta de más.
  const aplicadas = promoAplicadas || (datos?.tienda?.promociones || []).map(p => ({
    id: p.id, campaniaId: p.campania_id || null, nombre: p.nombre,
    codigo: p.codigo, tipo: p.tipo, descuento: p.descuento, envioGratis: p.envio_gratis,
  }));
  //    También CRÍTICA cuando hay promociones: el descuento ya se le dio al
  //    cliente, así que el cupo tiene que quedar amarrado al folio antes de
  //    dar el checkout por bueno.
  if (aplicadas.length) {
    await derivacionCritica(negocioId, token, 'atribucion', async () => {
      const esNuevo = !(await clienteTienePedidosPrevios(negocioId, telefono, pedido.id));
      await registrarUsosPromociones({
        negocioId, folio: pedido.id, aplicadas, telefono,
        montoVenta: Number(datos?.total) || 0, clienteNuevo: esNuevo, checkoutToken: token,
      });
    });
  }
}

// Recupera el pedido durable de un checkout y termina lo que le falte. Es el
// punto de entrada de CUALQUIER reintento: da igual si el vínculo ya existía o
// no, porque tener folio no significa que las derivaciones se completaran.
async function recuperarYFinalizar(negocioId, token) {
  const fila = await buscarPedidoDeCheckout(negocioId, token);
  if (!fila) return null;
  await finalizarCheckout({
    negocioId, token,
    pedido: { ...fila.datos, id: fila.folio }, datosPedido: fila.datos,
  });
  return fila;
}

// Reconstruye la respuesta de un checkout ya creado, para devolverle al
// cliente EXACTAMENTE el mismo folio y tracking que la primera vez.
async function respuestaDeCheckoutExistente(negocioId, token, fila) {
  const { rows: [tp] } = await pool.query(
    `SELECT tracking_token FROM tienda_pedidos WHERE negocio_id = $1 AND checkout_token = $2`,
    [negocioId, token]);
  const datos = fila.datos || {};
  return {
    yaExistia: true,
    folio: fila.folio,
    trackingToken: tp?.tracking_token || datos?.tienda?.tracking_token || null,
    total: Number(datos.total) || 0,
    ahorro: Number(datos?.tienda?.ahorro) || 0,
    programadoPara: datos.programado_para || null,
  };
}

// ── Checkout ──────────────────────────────────────────────────────────────
// Idempotencia real y persistente: el mismo checkout_token SIEMPRE devuelve
// el mismo pedido. Un doble click, un refresh, un retry por timeout o el
// navegador repitiendo la petición no crean un segundo pedido — y como la
// reserva se hace con un INSERT único en la base, funciona aunque haya
// varias instancias del proceso.
export async function crearPedidoTienda({
  tienda, checkoutToken, items, modalidad, cliente = {}, direccion = null, zona = null,
  colonia = null, codigo = null, metodoPago = null, programadoPara = null, notas = null,
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
    // Otra petición con el mismo token ya pasó por aquí. Se espera a que
    // termine de vincular el folio.
    const existente = await esperarPedidoDeToken(tienda.negocioId, token);

    // Que exista pedido_folio NO significa que el pedido esté terminado: el
    // vínculo se escribe ANTES de emitir la comanda y de atribuir las
    // promociones. Devolver 200 aquí sin más dejaría al cliente creyendo que
    // todo quedó listo mientras la cocina nunca vio el papel. Por eso se
    // finaliza -- idempotentemente -- antes de responder.
    const fila = await recuperarYFinalizar(tienda.negocioId, token);
    if (fila) return await respuestaDeCheckoutExistente(tienda.negocioId, token, fila);

    // Hay folio pero el pedido ya no está en pedidos_activos (archivado):
    // no hay nada que finalizar, solo que devolver lo que existe.
    if (existente?.pedido_folio) {
      return { yaExistia: true, folio: existente.pedido_folio, trackingToken: existente.tracking_token };
    }
    throw new TiendaError('Tu pedido se está procesando, espera un momento', 'CHECKOUT_EN_CURSO', 409);
  }

  // Reserva fresca. Aun así puede existir ya un pedido con este token: si un
  // intento anterior murió y su fila de tienda_pedidos se borró, el INSERT de
  // arriba no encuentra conflicto. Crear otro pedido aquí sería el duplicado
  // que se quiere evitar.
  const previo = await recuperarYFinalizar(tienda.negocioId, token);
  if (previo) {
    console.warn('[Tienda] El checkout ya tenia pedido ' + previo.folio + ': se recupera');
    return await respuestaDeCheckoutExistente(tienda.negocioId, token, previo);
  }

  // Cupos de promoción tomados en esta petición: si algo falla después, hay
  // que devolverlos o quedarían quemados sin pedido que los justifique.
  let cuposTomados = [];
  // Si el pedido llego a crearse, el catch NO puede tratar el fallo como si
  // nada hubiera pasado: el cliente ya tiene un pedido en la cocina.
  let pedidoCreado = null;
  try {
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
    const { items: itemsValidados, subtotal } = await validarCarrito(tienda.negocioId, items);

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

    // 5b) Reserva del cupo de cada promoción ANTES de crear nada. Es la única
    //     forma de que un cupón de N usos no se entregue N+1 veces cuando
    //     llegan dos compras al mismo tiempo: gana quien la base deja ganar.
    if (promo.aplicadas.length) {
      const { reservadas, agotadas } = await reservarUsosPromociones(
        tienda.negocioId, promo.aplicadas, { telefono, checkoutToken: token });
      if (agotadas.length) {
        // Se acabó justo ahora (o este cliente ya la usó): se devuelve lo que
        // sí se alcanzó a reservar y se le dice la verdad al cliente en vez de
        // cobrarle un total distinto al que vio.
        await liberarUsosPromociones(tienda.negocioId, reservadas, { checkoutToken: token });
        throw new TiendaError(
          `La promoción "${agotadas[0].nombre}" ya no está disponible para ti. Vuelve a intentar sin ella.`,
          'PROMOCION_AGOTADA', 409);
      }
      cuposTomados = reservadas;
    }

    // 6) Método de pago: solo los que el negocio tiene habilitados.
    const metodos = await metodosPagoTienda(tienda.negocioId, modo);
    if (!metodos.length) throw new TiendaError('Esta tienda aún no tiene métodos de pago configurados', 'SIN_METODOS_PAGO');
    // Si el cliente mandó un método, tiene que ser uno realmente habilitado:
    // caer de vuelta al primero convertiría "quise pagar en línea" en "pago
    // al recibir" sin que nadie se entere.
    const elegido = metodoPago ? metodos.find(m => m.id === metodoPago) : metodos[0];
    if (!elegido) throw new TiendaError('Esa forma de pago no está disponible', 'METODO_PAGO_INVALIDO');

    // 7) Orden con la MISMA forma que usa el POS.
    const orden = construirOrdenPOS({
      negocioId: tienda.negocioId,
      tipo: modo,
      items: itemsValidados,
      subtotal: promo.subtotal,
      costoEnvio: promo.envio,
      descuento: promo.descuento,
      cliente: { nombre: limpiarTexto(cliente?.nombre, 80), telefono },
      direccion: modo === 'domicilio' ? direccionParaPedido(direccion, zonaNombre, colonia) : null,
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
      // El token del checkout viaja DENTRO del pedido durable. Es lo que
      // permite recuperarlo si el proceso muere antes de vincularlo, y lo que
      // el índice único de pedidos_activos usa para impedir un segundo pedido.
      checkout_token: token,
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

    // 8) Alta del pedido por el camino de siempre. A partir de esta linea el
    //    pedido es DURABLE: cualquier fallo posterior ya no se puede resolver
    //    borrando la reserva, porque el pedido ya existe.
    const { registrarPedido } = await import('../orders/orderManager.js');
    const pedido = await registrarPedido(orden, 'tienda_online');
    pedidoCreado = pedido;
    fallaInyectada('despues_de_registrar');

    // 9) Derivaciones: vinculo, historial, tablero, comanda y atribucion.
    //    Todas idempotentes, todas repetibles por un reintento.
    await finalizarCheckout({
      negocioId: tienda.negocioId, token, pedido,
      datosPedido: orden, promoAplicadas: promo.aplicadas,
    });

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
    // Alcanzo a crearse el pedido? No se le pregunta a la memoria del proceso
    // (que en un crash real ya no existe): se le pregunta a la base, que es la
    // unica que sabe. Si el pedido existe, borrar la reserva y devolver el
    // cupon dejaria un pedido CON descuento y un cupon como si nadie lo
    // hubiera usado -- exactamente lo que no puede pasar.
    const yaHayPedido = pedidoCreado
      || await buscarPedidoDeCheckout(tienda.negocioId, token).catch(() => null);

    if (!yaHayPedido) {
      // No hubo pedido: se suelta todo para que el cliente corrija y reintente
      // con el mismo token sin quedar bloqueado.
      await pool.query(
        `DELETE FROM tienda_pedidos WHERE negocio_id = $1 AND checkout_token = $2 AND pedido_folio IS NULL`,
        [tienda.negocioId, token]
      ).catch(() => {});
      if (cuposTomados.length) {
        await liberarUsosPromociones(tienda.negocioId, cuposTomados, { checkoutToken: token });
      }
    } else {
      // El pedido existe. Se deja constancia y NO se suelta nada: el siguiente
      // intento con el mismo token lo encuentra y termina de finalizarlo.
      console.error(
        '[Tienda] El checkout fallo DESPUES de crear el pedido ' +
        (pedidoCreado?.id || yaHayPedido.folio) + ': ' + e.message +
        '. No se libera nada; un reintento con el mismo token lo recupera.');
      await pool.query(
        `UPDATE tienda_pedidos SET estado = 'incompleto', updated_at = NOW()
          WHERE negocio_id = $1 AND checkout_token = $2 AND pedido_folio IS NULL`,
        [tienda.negocioId, token]
      ).catch(() => {});
    }
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
