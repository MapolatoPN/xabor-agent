/**
 * pagosService.js — Generación segura de enlaces de pago (Fase 8/10/11).
 *
 * Reemplaza las llamadas directas a crearLinkDePago() (Clip-específico)
 * por un flujo agnóstico de proveedor: recalcula el total desde la base
 * de datos (nunca confía en el monto que traiga el llamador), resuelve
 * el proveedor PRINCIPAL del negocio (nunca asume Clip), y es idempotente
 * por (negocioId, pedidoId, versionPedido, tipo) -- un doble clic o un
 * reintento del agente devuelve el MISMO enlace en vez de crear uno
 * nuevo; si el pedido cambió de monto/modalidad desde el último intento,
 * el enlace anterior se invalida y se genera uno nuevo.
 */
import {
  obtenerPedidoParaPagoPorFolio, calcularVersionPedidoHash, obtenerPagoVigente,
  crearRegistroPago, actualizarPagoCreado, marcarPagoFallido, invalidarPagosVigentesDePedido,
  guardarLinkPago, obtenerPagoPorReferenciaInterna, reactivarRegistroPago,
  asegurarRoutingTokenIntegracion, registrarIdsDePago,
  obtenerIntentoDePago, marcarIntentosAmbiguos, conObligacionDePagoExclusiva,
  invalidarCheckoutSuperado, pagoRealDelPedido, registrarIntentoDeCreacion,
  marcarCreacionAmbigua, anotarMotivoAmbiguedad,
  finalizarCreacionPago, obtenerPagoPorId, tieneIdentidadExternaDurable,
  minutosDeEsperaDePago,
} from './database.js';
import { randomBytes } from 'crypto';

// URL pública canónica de Xabor. La notification_url es sensible -- decide a
// dónde llega el aviso de que un pago se completó -- así que NO se fabrica con
// el Host ni el X-Forwarded-Host de la petición: los pone el cliente. Se toma
// de la configuración del servidor y, si no está, no se manda ninguna: mejor
// sin webhook (y reconciliar por consulta) que un webhook apuntando a donde
// diga un tercero.
function urlPublicaXabor() {
  const base = process.env.XABOR_URL_PUBLICA || process.env.BASE_URL || '';
  return /^https?:\/\//.test(base) ? base.replace(/\/+$/, '') : null;
}

// Estados internos válidos de pagos.estado (CHECK de la migración 025). Un
// adaptador jamás debe poder colar el vocabulario crudo de su proveedor
// ('CHECKOUT' de Clip fue la causa raíz del incidente del enlace no
// enviado): cualquier valor fuera de esta lista se normaliza a 'pendiente'.
const ESTADOS_PAGO_VALIDOS = new Set(['creando', 'pendiente', 'pagado', 'fallido', 'vencido', 'cancelado', 'invalidado', 'reembolsado', 'requiere_revision']);
const normalizarEstadoPago = e => (ESTADOS_PAGO_VALIDOS.has(e) ? e : 'pendiente');
import { obtenerProveedorPrincipal, obtenerCredencialesPagoDescifradas, TenantContextRequiredError } from './integracionesService.js';
import { obtenerAdaptador } from './paymentProviders.js';

export { TenantContextRequiredError };

export class SinProveedorPrincipalError extends Error {
  constructor(negocioId) {
    super(`No hay proveedor de pago principal activo para el negocio ${negocioId}`);
    this.code = 'SIN_PROVEEDOR_PRINCIPAL';
  }
}
export class PedidoInvalidoError extends Error {
  constructor(msg) { super(msg); this.code = 'PEDIDO_INVALIDO'; }
}
/**
 * Un intento anterior mando el POST de creacion y no supo si el proveedor llego
 * a crear el checkout, y ESE proveedor no ofrece ni idempotencia ni busqueda
 * por referencia. Reintentar a ciegas crearia un segundo cobro real. La unica
 * salida honesta es parar y que alguien lo mire.
 */
export class CreacionAmbiguaError extends Error {
  constructor(pedidoId, proveedor) {
    super(`El intento de cobro del pedido ${pedidoId} en ${proveedor} quedó sin respuesta y ese proveedor no permite comprobar si el checkout existe: requiere revisión manual antes de volver a intentar`);
    this.code = 'CREACION_AMBIGUA';
  }
}

/**
 * Crea (o reutiliza, si ya hay uno vigente y sin cambios) un enlace de
 * pago para un pedido. Nunca acepta el total del llamador como fuente de
 * verdad -- siempre se recalcula desde pedidos_activos.
 */
export async function crearEnlacePago({ negocioId, pedidoId, actor = null, idempotencyKey = null, descripcion = null }) {
  // Mismo contrato que crearLinkDePago (clip-api.js, Incidente P0):
  // negocioId ausente/inválido es un bug del llamador, nunca un estado de
  // negocio -> TenantContextRequiredError, lanzada antes de tocar la BD.
  if (typeof negocioId !== 'string' || !negocioId.trim()) throw new TenantContextRequiredError('pagosService.crearEnlacePago');
  if (typeof pedidoId !== 'string' || !pedidoId.trim()) throw new Error('crearEnlacePago: pedidoId requerido');

  // ── SERIALIZACION POR LA OBLIGACION DE PAGO DEL PEDIDO ───────────────────
  //
  // La unidad cuya exclusividad de verdad queremos es el PEDIDO: un pedido
  // tiene una sola obligacion de cobro viva. Antes la clave llevaba version y
  // proveedor, y ambos se leian ANTES del lock -- dos agujeros: dos versiones
  // del mismo pedido tomaban locks distintos y podian crear dos checkouts a la
  // vez, y quien esperaba despertaba con un snapshot viejo, capaz de crear el
  // checkout de una version que ya no existe.
  //
  // Todo el estado autoritativo -- pedido, total, version, proveedor principal
  // -- se lee DENTRO del claim, en resolverIntentoDePago.
  //
  // Dos capas, porque los duplicados llegan por dos caminos distintos:
  //  · MISMO proceso (veinte toques al boton, o el bot y el panel a la vez) ->
  //    mapa in-flight: el primero corre, los demas esperan SU promesa. Cero
  //    conexiones y cero llamadas al proveedor de mas.
  //  · OTRA instancia -> claim en la base. El perdedor espera al ganador y, al
  //    entrar, relee y encuentra lo que el ganador dejo.
  //
  // El UNIQUE de la tabla sigue ahi, pero como barrera de ultimo recurso: si el
  // caller lo esta viendo (23505), es que hubo N intentos de crear N cobros.
  const claveObligacion = `${negocioId.trim()}:${pedidoId}`;
  const enVuelo = _intentosEnVuelo.get(claveObligacion);
  if (enVuelo) return enVuelo;

  const promesa = conObligacionDePagoExclusiva(negocioId, pedidoId,
    () => resolverIntentoDePago({ negocioId, pedidoId, descripcion, idempotencyKey, actor }))
    .finally(() => _intentosEnVuelo.delete(claveObligacion));
  _intentosEnVuelo.set(claveObligacion, promesa);
  return promesa;
}

// Peticiones del MISMO intento que ya estan corriendo en este proceso. La clave
// es la identidad semantica completa, asi que nunca comparten resultado dos
// pedidos, dos negocios ni dos proveedores distintos. Se limpia sola al
// terminar (exito o error): no es cache, es coalescencia.
const _intentosEnVuelo = new Map();

// El cuerpo real, ya con la obligacion del pedido en exclusiva.
async function resolverIntentoDePago({ negocioId, pedidoId, descripcion, idempotencyKey, actor }) {
  // Retardo inyectable: sirve para probar que quien despierta del claim NO
  // trabaja con el pedido que existia cuando pidio el turno. Mismo candado de
  // produccion que el resto de la inyeccion de fallos del proyecto.
  const retardo = Number(process.env.XABOR_PAGOS_RETARDO_INTENTO_MS) || 0;
  if (retardo > 0 && process.env.NODE_ENV !== 'production') {
    await new Promise(r => setTimeout(r, retardo));
  }

  // ESTADO AUTORITATIVO, leido aqui dentro. Incidente XAB-0114: el lookup
  // anterior (obtenerPedidoActivoPorFolio) excluia pedidos 'entregado' pero
  // ACEPTABA 'cancelado' -- exactamente al reves de lo que el dinero necesita:
  // un pedido entregado SIN pagar es el caso tipico que pide el enlace, y uno
  // cancelado jamas debe cobrarse.
  const pedido = await obtenerPedidoParaPagoPorFolio(pedidoId, negocioId);
  if (!pedido) throw new PedidoInvalidoError(`Pedido ${pedidoId} no encontrado para este negocio`);
  if (pedido.pago_confirmado === true || pedido.pago_confirmado === 'true') {
    throw new PedidoInvalidoError(`Pedido ${pedidoId} ya está pagado`);
  }
  const total = Number(pedido.total);
  if (!Number.isFinite(total) || total <= 0) throw new PedidoInvalidoError(`Pedido ${pedidoId} tiene un total inválido`);

  const versionHash = calcularVersionPedidoHash(pedido);

  // ── LA PROMOCION VIAJA CON LA VERSION ───────────────────────────────────
  //
  // Si el pedido cambio despues de que se aparto el cupon, la reserva vieja ya
  // no justifica el precio que este checkout va a cobrar. Se resincroniza
  // ANTES de crear nada: o queda reservada para la version que corre ahora, o
  // no hay checkout. Cobrar un total con un descuento que ya no aplica seria
  // regalar la diferencia sin que nadie se entere.
  const { resincronizarReservasPorVersion } = await import('./tiendaPromociones.js');
  const promoSync = await resincronizarReservasPorVersion({
    negocioId, folio: pedidoId, datosPedido: pedido, versionActual: versionHash,
  });
  if (!promoSync.ok) {
    throw new PedidoInvalidoError(
      `El pedido ${pedidoId} cambio y su promocion ya no aplica a la version actual (${promoSync.razon}): hay que recalcular el pedido antes de cobrarlo`);
  }

  // El proveedor PRINCIPAL determina el tipo de pago: Clip crea un enlace real
  // ('enlace_pago'), manual_transfer no crea nada, solo instrucciones a
  // conciliar a mano ('transferencia') -- sin esto, un negocio con
  // manual_transfer como principal quedaria registrado con el tipo equivocado y
  // chocaria contra el indice unico de "un pago vigente por pedido+tipo".
  const principal = await obtenerProveedorPrincipal(negocioId);
  if (!principal) throw new SinProveedorPrincipalError(negocioId);
  const adaptador = obtenerAdaptador(principal.proveedor);
  if (!adaptador) throw new SinProveedorPrincipalError(negocioId);
  const tipo = adaptador.getCapabilities().createLink ? 'enlace_pago' : 'transferencia';

  // IDENTIDAD DEL INTENTO: negocio + pedido + version + proveedor + tipo, leida
  // de columnas reales. `referencia_interna` dejo de servir para esto: su
  // formato cambio (ahora lleva el proveedor) y las filas historicas conservan
  // el viejo, asi que buscar por la cadena exacta no las encontraba y se
  // insertaba una SEGUNDA fila para el mismo intento. Ese fue el defecto que
  // destapo fase-bot-enlace-pago.
  //
  // Va PRIMERO, antes de cualquier reutilizacion: si hay dos cobros abiertos a
  // la vez, ninguna rama de aqui en adelante tiene derecho a elegir uno.
  const intento = await obtenerIntentoDePago(negocioId, pedidoId, versionHash, principal.proveedor, tipo);
  if (intento.ambiguo) {
    // Varias filas vivas donde deberia haber una: una regresion previa las dejo
    // asi. No se elige una al azar ni se crea una tercera -- se marcan todas
    // para revision y se falla cerrado.
    await marcarIntentosAmbiguos(negocioId, intento.candidatos);
    throw new PedidoInvalidoError(
      `El pedido ${pedidoId} tiene ${intento.candidatos.length} intentos de pago simultaneos para el mismo proveedor y version: requiere revision manual`);
  }

  // ¿YA ENTRÓ DINERO por este pedido para la versión que corre ahora? Se
  // pregunta al ledger, no a `pedidos_activos.pago_confirmado`: entre asentar
  // el dinero y marcar el pedido hay una ventana -- la deuda de derivación --
  // en la que el pedido todavía dice que no está pagado. Crear otro checkout
  // ahí sería cobrarle dos veces al cliente. Vale aunque el negocio haya
  // cambiado de proveedor en medio: el dinero ya entró por el anterior.
  const yaPagado = await pagoRealDelPedido(negocioId, pedidoId, versionHash);
  if (yaPagado) {
    return {
      pagoId: yaPagado.id, url: yaPagado.url, reutilizado: true,
      referenciaExterna: yaPagado.referencia_externa, estado: 'pagado',
      derivacionPendiente: yaPagado.derivacion_pendiente === true,
    };
  }

  // Idempotencia: si ya hay un pago vigente para este pedido (mismo tipo) y
  // coincide la versión, se reutiliza tal cual (mismo enlace) -- nunca se
  // genera uno nuevo por un doble clic o un reintento.
  const vigente = await obtenerPagoVigente(negocioId, pedidoId, tipo);

  // P1: el intento vigente pertenece a UN proveedor. Si el negocio cambió su
  // principal entre el primer intento y el reintento, devolver la URL vieja
  // etiquetada con el proveedor nuevo sería mentir sobre a qué cuenta va el
  // dinero. Decisión explícita: un pago pendiente NO queda fijado a su
  // proveedor original -- se invalida y se crea un intento nuevo con el
  // proveedor actual. Nunca se mezclan los dos.
  //
  // El dinero que sí entró por el enlace viejo se sigue honrando: su webhook
  // resuelve por referencia_interna y confirma igual, aunque el registro esté
  // invalidado. Invalidar no es repudiar un cobro, es dejar de ofrecerlo.
  if (vigente && vigente.proveedor && vigente.proveedor !== principal.proveedor) {
    await invalidarPagosVigentesDePedido(negocioId, pedidoId,
      `el negocio cambió de proveedor (${vigente.proveedor} → ${principal.proveedor}) antes de completar el pago`);
  } else if (vigente && vigente.version_pedido_hash === versionHash
             && ['pendiente', 'requiere_revision'].includes(vigente.estado)
             // Un enlace sin URL no se puede "reutilizar": no hay nada que
             // darle al cliente. Una transferencia manual sí: ahí el producto
             // son las instrucciones, no un checkout. Y si además quedó marcado
             // `creacion_ambigua`, devolverlo aquí saltaría la resolución de esa
             // ambigüedad, que es lo único que sabe si el checkout existe del
             // otro lado.
             && (vigente.tipo !== 'enlace_pago' || vigente.url)
             && vigente.metadata_sanitizada?.anomalia !== 'creacion_ambigua') {
    return { pagoId: vigente.id, url: vigente.url, reutilizado: true, referenciaExterna: vigente.referencia_externa, estado: vigente.estado };
  }
  if (vigente && vigente.proveedor === principal.proveedor && vigente.version_pedido_hash !== versionHash) {
    // El pedido cambió desde el último intento (ejemplo del encargo:
    // domicilio $560 -> recoger $500) -- el enlace anterior ya no es
    // válido, se invalida explícitamente y nunca se reenvía.
    await invalidarPagosVigentesDePedido(negocioId, pedidoId, 'pedido modificado antes de completar el pago anterior');
  }

  // El intento ya se resolvio arriba (identidad por columnas).
  const previo = intento.fila;
  let registro;
  if (previo && previo.estado === 'pagado') {
    // Jamas se crea un cobro nuevo si el dinero ya entro por este intento.
    return { pagoId: previo.id, url: previo.url, reutilizado: true, referenciaExterna: previo.referencia_externa, estado: 'pagado' };
  }
  // UNA FILA = UN CHECKOUT EXTERNO. Reactivar solo es legitimo cuando la fila
  // nunca llego a tener checkout: reactivarRegistroPago exige que
  // referencia_externa, preference_id, payment_id y url esten vacios, porque
  // reutilizar una fila que SI los tiene obligaria a sobrescribirlos, y con eso
  // se destruiria la identidad del checkout anterior -- justo la que un webhook
  // tardio todavia puede nombrar.
  let reactivada = false;
  if (previo && ['fallido', 'vencido'].includes(previo.estado)) {
    // Conserva su referencia_interna original: esa cadena pudo haber viajado ya
    // al proveedor, y reescribirla dejaria huerfano un cobro real.
    reactivada = await reactivarRegistroPago(previo.id);
    if (reactivada) registro = previo;
  } else if (previo && !['pagado', 'invalidado', 'cancelado', 'reembolsado'].includes(previo.estado)) {
    // 'creando' / 'pendiente' / 'requiere_revision': se reutiliza tal cual, con
    // su mismo checkout. No se crea ninguno nuevo.
    registro = previo;
  }

  if (!registro) {
    // OTRO intento, con referencia interna propia. El sufijo aleatorio es lo que
    // permite que convivan el checkout A -- ya invalidado pero todavia pagable
    // -- y el B: sin el, la identidad (negocio, pedido, version, proveedor)
    // chocaria contra el UNIQUE de referencia_interna y habria que sobrescribir
    // la de A. Las referencias historicas, en cualquiera de sus formatos
    // anteriores, siguen intactas y se resuelven igual: la busqueda del intento
    // es por columnas, no por esta cadena.
    if (previo) {
      await invalidarCheckoutSuperado(previo.id, negocioId,
        `se genero otro intento de cobro para el pedido ${pedidoId}`);
    }
    registro = await crearRegistroPago({
      negocioId, pedidoFolio: pedidoId, clienteTelefono: pedido.cliente?.telefono || null,
      proveedor: principal.proveedor, integracionId: principal.id,
      referenciaInterna: `${negocioId.trim()}:${pedidoId}:${versionHash}:${principal.proveedor}:${randomBytes(4).toString('hex')}`,
      tipo, moneda: 'MXN', monto: total, versionPedidoHash: versionHash,
      idempotencyKey, createdBy: actor,
    });
  }

  // La referencia que viaja al proveedor es SIEMPRE la de la fila, nunca una
  // recalculada: para una fila historica es la vieja, y asi el webhook que la
  // devuelva sigue resolviendo.
  const referenciaInterna = registro.referencia_interna;
  const capacidades = adaptador.getCapabilities();

  // ── RESULTADO AMBIGUO DE UN INTENTO ANTERIOR ─────────────────────────────
  //
  // Una fila marcada `creacion_ambigua` significa: el POST salió y no supimos
  // si nació un checkout. "No hay ids guardados" NO demuestra que el proveedor
  // no creó nada -- una respuesta perdida deja exactamente el mismo rastro que
  // una petición que nunca salió.
  //
  // Qué se puede hacer depende del proveedor, y no son iguales:
  //  · Mercado Pago no documenta idempotencia al crear la preferencia, pero SÍ
  //    permite buscarla por external_reference: se pregunta y se adopta la que
  //    exista. Si no existe ninguna, entonces sí es seguro crear.
  //  · Clip no documenta ni idempotencia ni búsqueda por referencia. Ahí no hay
  //    forma de saberlo por API, así que no se manda otro POST: queda en
  //    revisión.
  // La entrada al resolver la decide la BARRERA, no el motivo. Con la condicion
  // anterior (`anomalia === 'creacion_ambigua'`), escribir un motivo nuevo --
  // duplicadas, ajena, sin resolver -- hacia que la fila dejara de "parecer"
  // ambigua y el siguiente reintento volviera al camino normal de POST.
  // Se acepta tambien la marca vieja para filas escritas antes de esta version.
  const ambiguaAbierta = registro.metadata_sanitizada?.creacion_ambigua_abierta === true
    || registro.metadata_sanitizada?.anomalia === 'creacion_ambigua';
  if (ambiguaAbierta && !registro.referencia_externa) {
    if (capacidades.recuperaCreacionPorReferencia && adaptador.buscarCheckoutPorReferencia) {
      const credenciales = await obtenerCredencialesPagoDescifradas(negocioId, principal.proveedor);
      // La documentacion de Mercado Pago no garantiza read-after-write en el
      // search. Una busqueda vacia INMEDIATAMENTE despues de una respuesta
      // perdida no demuestra que la preferencia no exista: puede no estar
      // indexada todavia. Se reintenta con espera acotada y, si sigue sin
      // aparecer, NO se crea otra: en dinero, incertidumbre es fail closed.
      const intentos = Number(process.env.XABOR_PAGOS_BUSQUEDA_INTENTOS) || 3;
      const esperaMs = Number(process.env.XABOR_PAGOS_BUSQUEDA_ESPERA_MS) || 1500;
      let encontrado = null;
      for (let i = 0; i < intentos && !encontrado; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, esperaMs));
        encontrado = await adaptador.buscarCheckoutPorReferencia(referenciaInterna, credenciales);
      }

      // Los tres desenlaces que NO resuelven la identidad dejan la barrera
      // ABIERTA a proposito: anotarMotivoAmbiguedad escribe el motivo y
      // reafirma `creacion_ambigua_abierta`. Cero POST en los tres.
      if (encontrado?.ambiguo) {
        await anotarMotivoAmbiguedad(registro.id, negocioId, 'preferencias_duplicadas',
          `el proveedor tiene ${encontrado.ids.length} checkouts con la misma referencia`);
        throw new CreacionAmbiguaError(pedidoId, principal.proveedor);
      }
      if (encontrado?.sinUrl) {
        await anotarMotivoAmbiguedad(registro.id, negocioId, 'preferencia_sin_url',
          `la preferencia ${encontrado.preferenciaId} existe y la referencia cuadra, pero no trae init_point utilizable`);
        throw new CreacionAmbiguaError(pedidoId, principal.proveedor);
      }
      if (encontrado?.ajena) {
        await anotarMotivoAmbiguedad(registro.id, negocioId, 'preferencia_ajena',
          `la preferencia ${encontrado.preferenciaId} lleva la referencia ${encontrado.referenciaRecibida}`);
        throw new CreacionAmbiguaError(pedidoId, principal.proveedor);
      }
      if (!encontrado) {
        await anotarMotivoAmbiguedad(registro.id, negocioId, 'creacion_ambigua_sin_resolver',
          `${intentos} busquedas por referencia no encontraron el checkout: puede existir sin estar indexado`);
        throw new CreacionAmbiguaError(pedidoId, principal.proveedor);
      }
      if (encontrado) {
        // Existía: se adopta, no se crea nada. Una sola transacción: identidad,
        // URL, preference_id y cierre de la barrera, o nada.
        const fin = await finalizarCreacionPago({
          pagoId: registro.id, negocioId,
          referenciaExterna: encontrado.referenciaExterna, url: encontrado.url,
          preferenceId: encontrado.preferenciaId || null, estado: 'pendiente',
          comoSeResolvio: 'recuperado_por_referencia',
          esperaMinutos: await minutosDeEsperaDePago(negocioId),
        });
        if (!fin.ok) {
          await anotarMotivoAmbiguedad(registro.id, negocioId, `finalizacion_${fin.razon}`,
            'no se pudo cerrar la creación con la preferencia recuperada');
          throw new CreacionAmbiguaError(pedidoId, principal.proveedor);
        }
        return {
          pagoId: registro.id, url: encontrado.url, reutilizado: true,
          referenciaExterna: encontrado.referenciaExterna, estado: 'pendiente',
          recuperadoTrasAmbiguedad: true,
        };
      }
    } else {
      throw new CreacionAmbiguaError(pedidoId, principal.proveedor);
    }
  }

  // Identidad durable de creación ANTES del POST. Determinista y propia de la
  // fila, para que el reintento mande exactamente la misma.
  // ── BARRERA EXPLICITA ANTES DEL POST ─────────────────────────────────────
  //
  // Si esta fila ya tiene CUALQUIER identidad externa -- referencia, preference,
  // payment o incluso solo la URL --, el proveedor ya creo algo por ella y no
  // puede recibir otro POST. Nunca. Ni siquiera si ademas arrastra metadata de
  // anomalia por un COMMIT ambiguo: esa combinacion (identidad + anomalia) es
  // justamente la que un early-return por `vigente` no atrapa, porque la fila
  // puede estar en 'creando' y sin pasar por esa rama.
  if (tieneIdentidadExternaDurable(registro)) {
    return {
      pagoId: registro.id, url: registro.url, reutilizado: true,
      referenciaExterna: registro.referencia_externa,
      estado: registro.estado === 'creando' ? 'pendiente' : registro.estado,
      identidadPreexistente: true,
    };
  }

  const claveIdempotencia = `xabor:pago:${registro.id}`;
  await registrarIntentoDeCreacion(registro.id, negocioId, claveIdempotencia);

  try {
    const credenciales = await obtenerCredencialesPagoDescifradas(negocioId, principal.proveedor);

    // notification_url con el token de ruteo: es lo que permitirá al webhook
    // resolver ESTA integración sin creerle nada al cuerpo del mensaje. Sólo
    // para proveedores que firman sus webhooks; Clip no los ofrece y se
    // reconcilia por consulta activa.
    let notificationUrl = null;
    if (capacidades.webhookSignature) {
      const raiz = urlPublicaXabor();
      const routing = await asegurarRoutingTokenIntegracion(negocioId, principal.proveedor);
      if (raiz && routing) {
        notificationUrl = `${raiz}/webhook/pagos/${principal.proveedor}/${routing}`;
      } else {
        console.warn(`[Pagos] Sin notification_url para ${principal.proveedor} (raiz=${!!raiz} routing=${!!routing}) — se dependerá de la reconciliación`);
      }
    }

    const resultado = await adaptador.createPaymentLink({
      negocioId, pedidoId, total, descripcion: descripcion || `Pedido Xabor #${pedidoId}`,
      cliente: pedido.cliente || {}, referencia: referenciaInterna, credenciales,
      notificationUrl,
      // Solo se manda a quien la documente. Inventar un header de idempotencia
      // que el proveedor ignora es peor que no mandarlo: haría creer que la
      // creación está protegida cuando no lo está.
      idempotencyKey: capacidades.idempotenciaCreacion ? claveIdempotencia : null,
    });
    // FINALIZACION ATOMICA. Antes eran cuatro escrituras sueltas y un fallo
    // intermedio dejaba media identidad local -- con el catch marcando la
    // creación como ambigua aunque la identidad ya existiera.
    const fin = await finalizarCreacionPago({
      pagoId: registro.id, negocioId,
      referenciaExterna: resultado.referenciaExterna, url: resultado.url || null,
      preferenceId: resultado.preferenceId || null,
      estado: normalizarEstadoPago(resultado.estado || 'pendiente'),
      comoSeResolvio: 'creado',
      // El plazo de espera es politica del negocio, no una constante global.
      esperaMinutos: await minutosDeEsperaDePago(negocioId),
      // `datos.clip_link_id` es un campo LEGACY de Clip: la reconciliación
      // vieja lee de ahí. Va en la MISMA transacción para que su fallo no deje
      // la creación a medias; y solo para Clip, porque un preference_id de MP
      // ahí sería basura consultada contra la API equivocada.
      folioClipLegacy: principal.proveedor === 'clip' ? pedidoId : null,
    });
    if (!fin.ok) {
      await anotarMotivoAmbiguedad(registro.id, negocioId, `finalizacion_${fin.razon}`,
        'el proveedor creó el checkout pero no se pudo cerrar la creación localmente');
      throw new CreacionAmbiguaError(pedidoId, principal.proveedor);
    }
    return { pagoId: registro.id, url: resultado.url, reutilizado: false, referenciaExterna: resultado.referenciaExterna, estado: normalizarEstadoPago(resultado.estado || 'pendiente'), instrucciones: resultado.instrucciones || null };
  } catch (e) {
    // Un fallo DESPUÉS de mandar el POST es ambiguo, no fallido: el proveedor
    // pudo haber creado el checkout y perderse la respuesta. Marcarlo 'fallido'
    // invitaría a un reintento que crearía un segundo cobro real.
    //
    // Solo los errores que ocurren ANTES de salir a la red -- credenciales
    // ausentes, configuración inválida -- son fallos limpios.
    const antesDeSalir = e.code === 'TENANT_CONTEXT_REQUIRED'
      || e.code === 'CLIP_NO_CONFIGURADO' || e.code === 'SIN_PROVEEDOR_PRINCIPAL';
    if (e.code === 'CREACION_AMBIGUA') throw e;      // el motivo ya quedo anotado
    if (antesDeSalir) {
      await marcarPagoFallido(registro.id, e.code || e.message);
      throw e;
    }

    // NO se usa ninguna bandera de memoria para decidir si la identidad quedo
    // durable. La bandera anterior se encendia ANTES del COMMIT: si la
    // transaccion hacia rollback, el proceso creia haber persistido algo que no
    // existia, no marcaba la creacion como ambigua, y el siguiente reintento
    // mandaba un segundo POST. La unica fuente de verdad sobre durabilidad es
    // la base: se relee.
    const fresca = await obtenerPagoPorId(registro.id, negocioId).catch(() => null);
    if (tieneIdentidadExternaDurable(fresca)) {
      // El COMMIT si ocurrio (o el proveedor dejo rastro): la creacion esta
      // capturada. No se marca ambigua -- eso reabriria el POST -- y el
      // reintento reutilizara por la barrera de arriba.
      console.warn(`[Pagos] Fallo tras persistir la identidad de ${registro.id}: se conserva y se reutiliza`);
      throw e;
    }
    // Sin identidad durable: el POST al proveedor ya ocurrio y no sabemos si
    // creo. Ambigua, y que la resuelva la capacidad de cada proveedor.
    await marcarCreacionAmbigua(registro.id, negocioId, e.code || e.message);
    throw e;
  }
}
