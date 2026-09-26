// ─── EL EJECUTOR: donde Xabor decide, no el modelo ────────────────────────
//
// Recibe una llamada a herramienta ya validada contra su esquema y la ejecuta
// contra el estado REAL. Cuatro reglas, y ninguna es negociable:
//
//   1. Nada se aplica sin pasar por `reconciliar`. El reconciliador es el
//      único juez de qué entra al pedido, y sigue exigiendo evidencia en lo
//      que DIJO el cliente. Un `agregar_producto` con un id perfecto y sin
//      respaldo en el mensaje se rechaza igual.
//   2. Ningún producto ni opción existe si no está en la carta. Los ids se
//      vuelven a resolver aquí; que vinieran de `buscar_producto` no se da
//      por bueno.
//   3. Después de mutar se RELEE el pedido. Lo que vuelve al modelo es el
//      estado leído, no el prometido.
//   4. El resultado nunca miente sobre el éxito. `aplicado:false` con su
//      motivo es un desenlace normal, no una excepción.
//
// ── Lo que este archivo NO hace ──────────────────────────────────────────
//
// No habla con el modelo, no manda WhatsApp, no imprime y no cobra. Los
// efectos irreversibles —confirmar y escalar— entran por `efectos`, que quien
// llama inyecta: en producción son los de verdad, en sombra y en replay son
// grabadoras. Por eso el mismo código corre en los tres modos sin una bandera
// que decida si esta vez sí se cobra.
import { aplicarPropuestas, propuesta } from '../mesero-whatsapp/motorTransaccional.js';
import { carritoVacio } from '../orders/carritoDelPedido.js';
import { buscarProductos, indiceDeLaCarta, productosVendibles, fichaDeProducto } from '../mesero-whatsapp/consultasDelMenu.js';
import { anclarLinea } from '../mesero-whatsapp/anclajeAlCatalogo.js';
import { transicionLegal, esTerminal } from './maquinaDeEstados.js';
import {
  vistaDelPedido, fichaPorId, fichaPorNombre, opcionesDeLinea,
  opcionPendienteSigueVigente,
} from './vistaDelPedido.js';
import { tieneEfecto } from './contratoDeHerramientas.js';
import { politicaDelTurno, validarAlcanceOpciones, separarOpcionesAmbiguas, esContinuacionDeLinea } from './politicaDelTurno.js';
import { accionesParaOpcionesPendientes } from './continuidadDeterminista.js';
import { varianteDelPedido } from './varianteDelPedido.js';
import { cardinalidadDeGrupo } from '../services/modificadores.js';
import { autorizaConfirmacion, autorizaCancelacion } from './contratoConversacional.js';
import { mismaPalabraFlexible } from '../agent/mencionesComerciales.js';
import { evaluarFormaPago, etiquetaTipoPago } from './politicaDePagos.js';
import { validarProgramado } from './programadoDelAgente.js';
import { aHoraLocal, fechaHoyEn, TZ_DEFAULT } from '../services/zonaHoraria.js';
import { evaluarModalidad, etiquetaTipoModalidad } from '../orders/modalidadesDelPedido.js';
import {
  fusionarFechaHoraCatering, partesFechaHoraCatering,
} from '../agent/comercialMarkers.js';
import { esSolicitudCatering } from '../agent/catering.js';
import { solicitaAtencionHumana } from '../utils/solicitudPersona.js';
import {
  analizarReferenciasTemporalesDePedido, autorizaProgramarParaDesdeMensaje,
  fechasExactasDePedido, fusionarReferenciaProgramacion,
  horasExactasDePedido, referenciaProgramacionSegura, referenciasTemporalesDePedido,
} from './seguridadConversacional.js';
import {
  eventoCateringPublico, eventoCateringVerificado, filtrarDatosEventoCatering,
  retirarCamposEventoCatering, sellarEventoCatering,
} from '../agent/evidenciaCatering.js';

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

const ok = (datos) => ({ aplicado: true, estado: 'ok', ...datos });
const noAplicado = (motivo, datos = {}) => ({ aplicado: false, estado: 'rechazada', motivo, ...datos });
const invalido = (motivo, datos = {}) => ({ aplicado: false, estado: 'ilegal', motivo, ...datos });

/**
 * EL ESTADO DE UNA CONVERSACIÓN, tal como lo ve el ejecutor.
 *
 * Es un objeto plano y serializable a propósito: se guarda entre turnos, se
 * compara en el replay y se puede imprimir en un log sin que nada se pierda.
 */
export function estadoNuevo({ negocioId, conversacionId }) {
  return {
    negocioId,
    conversacionId,
    carrito: carritoVacio(),
    hechos: { confirmado: false, escalado: false, cancelado: false, fallido: false },
    folio: null,
    motivoEscalado: null,
    motivoCancelado: null,
    pagoOfrecido: null,
    // Elecciones mencionadas por el cliente que todavía empatan en catálogo.
    // Son pendientes durables aunque el grupo ya cumpla su mínimo.
    opcionesPendientes: [],
    // Hecho durable, fijado por el adaptador a partir de las palabras del
    // cliente. Si el modelo olvida llamar `programar_para`, la confirmacion no
    // puede degradar silenciosamente el pedido de mañana a uno para hoy.
    programacionRequerida: false,
    // Solo fragmentos temporales de una lista cerrada. Nunca guarda el texto
    // completo del cliente ni valores tomados de argumentos del modelo.
    referenciaProgramacion: null,
    turno: 0,
    // Lo que el bot puso delante del cliente en el turno ANTERIOR y que un
    // «sí» puede aceptar. Ver `evidenciaAceptada`, abajo.
    ofrecidos: [],
    ofrecidosDelTurno: [],
    // Oferta estructurada que Xabor puso delante del cliente. No es un
    // booleano: al aceptar, el siguiente turno necesita saber qué promoción,
    // qué productos participan y cuántas unidades exige. El modelo nunca
    // decide esos datos leyendo el texto de una respuesta anterior.
    ofertaPromocionPendiente: null,
    // Compatibilidad de lectura para estados escritos por el build anterior.
    // Las filas viejas no tienen una oferta recuperable; se ignoran de forma
    // explícita y no se convierten en una autorización inventada.
    promocionInformativaPendiente: false,
    // Los datos de un evento se juntan a trozos entre turnos. Vive aqui y
    // no en el carrito porque un evento NO es un pedido: no tiene renglones,
    // ni precio, ni modalidad, y meterlo en el carrito lo haria pasar por
    // el reconciliador, que no tiene nada que decidir sobre el.
    evento: null,
  };
}

export const estadoSerializable = (e) => JSON.parse(JSON.stringify(e ?? null));

/**
 * Crea el ejecutor de UN turno.
 *
 *   `estado`      el de la conversación; se MUTA (carrito, hechos, folio)
 *   `catalogo`    la carta real del negocio, ya leída
 *   `mensaje`     lo que el cliente escribió ESTE turno — la evidencia
 *   `textoCiclo`  lo que lleva dicho en el ciclo de pedido en curso
 *   `efectos`     `{ confirmar, escalar }`; en sombra y replay, grabadoras
 */
export function crearEjecutor({
  estado, catalogo = [], precios = null, requierePago = true,
  mensaje = '', textoCiclo = '', terminos = [], datoOperativoPendiente = false,
  efectos = null, registrarOfrecido = true, metodosPago = null, modalidades = null,
  reglas = null, configTienda = null, promocionesActivas = [], opcionesAceptadas = [],
  zonaDelNegocio = undefined,
} = {}) {
  const opcionesAlIniciarTurno = new Map((estado.carrito?.items || [])
    .map((i) => [i.lid, opcionesDeLinea(i).map((o) => ({ ...o }))]));
  const referenciasDelMensaje = referenciasTemporalesDePedido(mensaje);
  const referenciaAlCrearEjecutor = referenciaProgramacionSegura(estado.referenciaProgramacion);
  // Foto del inicio del turno. No se relee después de una herramienta: una
  // segunda llamada del modelo no puede confundir la fecha que la primera
  // acaba de guardar con una programación previa del cliente.
  const programadoAlIniciarTurno = estado.carrito?.datos?.programado_para || null;
  const habiaProgramacion = estado.programacionRequerida === true
    || !!programadoAlIniciarTurno
    || !!referenciaProgramacionSegura(estado.referenciaProgramacion);
  // El adaptador ya decidió, con el contexto del turno anterior, que un
  // «el 2» desnudo era la fecha que faltaba. El ejecutor recibe el estado
  // después de esa fusión, así que reconstruye únicamente ese caso exacto;
  // las señales de menú siguen ganando dentro del detector compartido.
  const fechaNumericaContextual = estado.programacionRequerida === true
    && !programadoAlIniciarTurno
    && !referenciaAlCrearEjecutor?.fechaValidada
    && !referenciaAlCrearEjecutor?.isoValidado
    && /^el\s+(?:[1-9]|[12]\d|3[01])$/.test(referenciaAlCrearEjecutor?.fechaCliente || '')
    && referenciasDelMensaje.fecha === referenciaAlCrearEjecutor.fechaCliente;
  const analisisTemporalDelMensaje = analizarReferenciasTemporalesDePedido(mensaje);
  const intencionTemporalDelMensaje = autorizaProgramarParaDesdeMensaje(mensaje, {
    hayPedidoEnCurso: (estado.carrito?.items || []).length > 0 || habiaProgramacion,
    hayProgramacionPrevia: habiaProgramacion,
    esperaFechaProgramacion: fechaNumericaContextual,
    mencionaProducto: buscarProductos(catalogo, mensaje, { limite: 1 }).length > 0,
  }) || (estado.programacionRequerida === true
    && analisisTemporalDelMensaje.tieneReferenciaTemporal === true
    && (analisisTemporalDelMensaje.ambiguaFecha || analisisTemporalDelMensaje.ambiguaHora));
  let fechaAnclaActual = null;
  try {
    fechaAnclaActual = fechaHoyEn(zonaDelNegocio || TZ_DEFAULT);
  } catch {
    // Sin una zona legible no se conserva una fecha relativa sin contexto.
  }
  const completarReferenciaDesdeIso = (valor) => {
    const referencia = referenciaProgramacionSegura(valor);
    if (!referencia?.isoValidado) return referencia;
    const hayCorreccion = !!(referencia.fechaCliente || referencia.horaCliente);
    try {
      const local = aHoraLocal(new Date(referencia.isoValidado), zonaDelNegocio || TZ_DEFAULT);
      const [fechaLocal, horaLocal] = local.split('T');
      const completa = {
        ...referencia,
        fechaValidada: referencia.fechaCliente
          ? referencia.fechaValidada : (referencia.fechaValidada || fechaLocal),
        horaValidada: referencia.horaCliente
          ? referencia.horaValidada : (referencia.horaValidada || horaLocal),
        // Si hay una corrección, ese instante completo dejó de ser vigente;
        // solo sus componentes locales no corregidos sobreviven como hechos.
        isoValidado: hayCorreccion ? null : referencia.isoValidado,
      };
      return referenciaProgramacionSegura(completa);
    } catch {
      // Una zona ilegible no autoriza a copiar el día/hora UTC. Sin el ISO
      // como comodín, la guarda de evidencia exigirá de nuevo el componente.
      return referenciaProgramacionSegura({
        ...referencia,
        isoValidado: hayCorreccion ? null : referencia.isoValidado,
      });
    }
  };
  const referenciaEfectiva = () => completarReferenciaDesdeIso(
    intencionTemporalDelMensaje
      ? fusionarReferenciaProgramacion(
        estado.referenciaProgramacion,
        referenciasDelMensaje,
        {
          isoAnterior: programadoAlIniciarTurno,
          // El adaptador ya ancló esta referencia antes de llamar al modelo.
          // No la vuelvas a fechar con un segundo reloj: si el turno cruza la
          // medianoche, «mañana» sigue significando lo que significaba cuando
          // el cliente lo escribió.
          fechaAncla: referenciaAlCrearEjecutor?.fechaCliente === referenciasDelMensaje.fecha
            && referenciaAlCrearEjecutor?.fechaAncla
            ? referenciaAlCrearEjecutor.fechaAncla : fechaAnclaActual,
        },
      )
      : referenciaProgramacionSegura(estado.referenciaProgramacion),
  );

  const programacionPendiente = () => {
    if (estado.programacionRequerida !== true || estado.carrito?.datos?.programado_para) return null;
    const referencia = completarReferenciaDesdeIso(estado.referenciaProgramacion);
    if (!referencia) return {
      fecha: null, hora: null, fuente_fecha: null, fuente_hora: null,
      fecha_ancla: null, franja_horaria: null, iso_validado_anterior: null,
    };
    const horasCliente = horasExactasDePedido(referencia.horaCliente);
    const horaClienteExacta = horasCliente.length ? referencia.horaCliente : null;
    return {
      fecha: referencia.fechaCliente || referencia.fechaValidada || null,
      hora: horaClienteExacta || referencia.horaValidada || null,
      fuente_fecha: referencia.fechaCliente
        ? 'cliente' : (referencia.fechaValidada ? 'validada_anterior' : null),
      fuente_hora: horaClienteExacta
        ? 'cliente' : (referencia.horaValidada ? 'validada_anterior' : null),
      fecha_ancla: referencia.fechaCliente ? referencia.fechaAncla || null : null,
      franja_horaria: referencia.horaCliente && !horaClienteExacta
        ? referencia.horaCliente : null,
      iso_validado_anterior: referencia.isoValidado || null,
    };
  };

  const vista = () => {
    const pedido = vistaDelPedido({
      carrito: estado.carrito, catalogo, precios, requierePago, hechos: estado.hechos,
      reglas, promocionesActivas,
      opcionesPendientes: estado.opcionesPendientes || [],
    });
    if (estado.programacionRequerida && !pedido.programado_para) {
      pedido.falta.push('programacion');
      pedido.resumen.completo = false;
      if (pedido.estado === 'listo') pedido.estado = 'armando';
    }
    const conContinuidad = (estado.ofrecidos || []).length
      ? { ...pedido, ofrecidos: estado.ofrecidos.slice() }
      : pedido;
    const ofertaPublica = estado.ofertaPromocionPendiente
      ? {
        nombre: estado.ofertaPromocionPendiente.nombre || null,
        participantes: (estado.ofertaPromocionPendiente.participantes || []).slice(),
        cantidadRequerida: Number(estado.ofertaPromocionPendiente.cantidadRequerida) || 1,
        condiciones: (estado.ofertaPromocionPendiente.condiciones || []).map((c) => ({
          grupo: c?.grupo || null,
          permitidas: Array.isArray(c?.permitidas) ? c.permitidas.slice() : undefined,
        })),
      }
      : null;
    const conOfertaPromocion = ofertaPublica
      ? { ...conContinuidad, oferta_promocion_pendiente: ofertaPublica }
      : conContinuidad;
    const conPago = estado.pagoOfrecido
      ? { ...conOfertaPromocion, pago_ofrecido: etiquetaTipoPago(estado.pagoOfrecido) }
      : conOfertaPromocion;
    const pendiente = programacionPendiente();
    const conProgramacion = pendiente
      ? { ...conPago, programacion_pendiente: pendiente }
      : conPago;
    return estado.evento
      ? { ...conProgramacion, evento: eventoCateringPublico(estado.evento) }
      : conProgramacion;
  };

  // ── LO QUE AUTORIZA UN «SÍ» ────────────────────────────────────────────
  //
  // Cuando el bot enseña UN producto y el cliente contesta «ese» o «sí», el
  // nombre del producto no aparece en ninguna frase suya y el reconciliador
  // —con razón— no lo deja entrar. `evidenciaAceptada` es el canal que ya
  // existe para eso, y aquí se alimenta de un hecho, no de un recuerdo: de lo
  // que `buscar_producto` devolvió en el turno ANTERIOR, y solo cuando devolvió
  // EXACTAMENTE UNO.
  //
  // Las dos restricciones importan. Si se alimentara de lo que el modelo cree
  // haber ofrecido, sería el modelo autorizando; si valiera con varios
  // candidatos, un «sí» ambiguo metería el primero de una lista. Y caduca al
  // turno siguiente: un producto que se enseñó hace cinco turnos no lo
  // autoriza un «sí» de ahora.
  const evidenciaAceptada = () => (estado.ofrecidos || []).slice();

  const anotarOfrecido = (nombre) => {
    if (!registrarOfrecido || !nombre) return;
    if (!estado.ofrecidosDelTurno.includes(nombre)) estado.ofrecidosDelTurno.push(nombre);
  };

  const opcionesDeReconciliacion = () => ({
    mensaje,
    textoCiclo: textoCiclo || mensaje,
    terminos,
    datoOperativoPendiente,
    evidenciaAceptada: evidenciaAceptada(),
    evidenciaOpcionesAceptadas: opcionesAceptadas,
    cantidadesAutorizadas: new Map(
      estado.ofertaPromocionPendiente?.participantes?.length === 1
        ? [[norm(estado.ofertaPromocionPendiente.participantes[0]),
          Number(estado.ofertaPromocionPendiente.cantidadRequerida) || 1]]
        : [],
    ),
  });

  /** Aplica propuestas y RELEE. Devuelve `{ aplicado, decisiones, cambios, pedido }`. */
  const aplicar = (propuestas) => {
    const limpias = propuestas.filter(Boolean);
    if (!limpias.length) return { aplicado: false, motivo: 'propuesta_vacia', decisiones: [], pedido: vista() };
    const lidsPrevios = new Set(estado.carrito.items.map(i => i.lid));
    const r = aplicarPropuestas(estado.carrito, limpias, opcionesDeReconciliacion());
    estado.carrito = r.carrito;
    estado.opcionesPendientes = (estado.opcionesPendientes || []).filter((p) => {
      const item = estado.carrito.items.find((i) => i.lid === p.lid);
      const linea = item ? {
        linea_id: item.lid,
        producto: item.nombre,
        opciones: opcionesDeLinea(item),
      } : null;
      return opcionPendienteSigueVigente({ pendiente: p, linea, catalogo });
    });
    // Las menciones pendientes se calculan también DESPUÉS de una mutación:
    // el primer mensaje puede crear el producto y mencionar más opciones que
    // el modelo guardó. Cumplir el mínimo del grupo no resuelve esas menciones.
    const lineas = estado.carrito.items.map((i) => ({
      linea_id: i.lid,
      producto: i.nombre,
      opciones: opcionesDeLinea(i),
    }));
    const aclaraciones = estado.carrito.items.filter(i => !lidsPrevios.has(i.lid)
      || limpias.some(p => p.lid === i.lid)).flatMap((i) =>
      (fichaPorNombre(catalogo, i.nombre)?.grupos || []).map((g) => ({
        lid: i.lid, grupo: g.nombre, producto: i.nombre, maximo: g.maximo,
        candidatos: g.opciones.map((o) => o.nombre), tipo: 'grupo_requerido',
      })));
    const detectadas = accionesParaOpcionesPendientes({
      estado, pedido: { lineas, aclaraciones }, catalogo, mensaje,
    }).ambiguas;
    for (const p of detectadas) {
      const linea = lineas.find((l) => l.linea_id === p.lid);
      if (!opcionPendienteSigueVigente({ pendiente: p, linea, catalogo })) continue;
      if (!estado.opcionesPendientes.some((a) => a.lid === p.lid && a.grupo === p.grupo
        && JSON.stringify(a.candidatos) === JSON.stringify(p.candidatos))) estado.opcionesPendientes.push(p);
    }
    const aceptadas = r.decisiones.filter((d) => d.decision === 'aceptada');
    return {
      aplicado: aceptadas.length > 0,
      decisiones: r.decisiones,
      cambios: r.cambios,
      // LA RELECTURA. Todo lo que el modelo va a leer sale de aquí.
      pedido: vista(),
    };
  };

  /** El motivo de un rechazo, en palabras que el modelo pueda accionar. */
  const porQueNo = (decisiones) => {
    const mala = decisiones.find((d) => d.decision === 'rechazada');
    const m = mala?.motivo || 'sin_respaldo_del_reconciliador';
    if (m === 'sin_respaldo_del_reconciliador') {
      return 'el_cliente_no_lo_dijo: el pedido NO cambió. Xabor solo aplica lo que el cliente '
        + 'escribió en este turno. Si crees que lo pidió, pregúntaselo con sus palabras en vez de darlo por hecho.';
    }
    if (m === 'renglon_inexistente') return 'renglon_inexistente: ese linea_id ya no está en el pedido. Llama a ver_pedido.';
    return m;
  };

  // ── LAS HERRAMIENTAS ───────────────────────────────────────────────────

  const impl = {
    ver_pedido() {
      return ok({ pedido: vista() });
    },

    buscar_producto({ texto, categoria }) {
      const t = String(texto || '').trim();
      if (!t) {
        return ok({ categorias: indiceDeLaCarta(catalogo) });
      }

      // XAB-0481: «y papas a la mexicana» era una guarnición de los
      // chilaquiles ya agregados. La búsqueda por palabras encontró tacos y
      // convirtió una opción real en otro producto. Las opciones exactas de
      // los renglones actuales se detectan antes de buscar productos.
      const dicho = norm(t);
      const opcionesDelPedido = [];
      for (const item of (estado.carrito?.items || [])) {
        const fichaItem = fichaPorNombre(catalogo, item?.nombre);
        if (!fichaItem) continue;
        const actuales = opcionesDeLinea(item);
        for (const grupo of (fichaItem.grupos || [])) {
          for (const opcion of (grupo.opciones || [])) {
            const nombreOpcion = norm(opcion.nombre);
            if (!nombreOpcion || !(` ${dicho} `.includes(` ${nombreOpcion} `))) continue;
            opcionesDelPedido.push({
              linea_id: item.lid,
              producto: item.nombre,
              grupo: grupo.nombre,
              opcion: opcion.nombre,
              maximo: grupo.maximo,
              opciones_actuales: actuales
                .filter((o) => norm(o.grupo) === norm(grupo.nombre))
                .map((o) => o.opcion),
            });
          }
        }
      }
      const palabrasProducto = s => norm(s).split(' ').filter(w => !['de','del','con','en','la','el','los','las'].includes(w));
      const buscadas = palabrasProducto(dicho);
      const productoExacto = productosVendibles(catalogo).some(p => {
        const propias = palabrasProducto(p.nombre);
        return propias.length === buscadas.length
          && propias.every((w, i) => mismaPalabraFlexible(w, buscadas[i]));
      });
      if (opcionesDelPedido.length && !productoExacto) {
        return ok({
          encontrados: [],
          existe: true,
          es_opcion_del_pedido: true,
          coincidencias_opcion: opcionesDelPedido,
          nota: 'Esto coincide con una OPCIÓN de un producto que ya está en el pedido, no con un producto nuevo. '
            + 'Usa modificar_linea. Si el cliente no dijo a cuál renglón se aplica, pregúntale; conserva las opciones_actuales del grupo.',
        });
      }
      let fichas = buscarProductos(catalogo, t, { limite: 8 });
      if (categoria) {
        const c = norm(categoria);
        fichas = fichas.filter((f) => norm(f.categoria) === c);
      }

      // La coincidencia por palabras encuentra la FAMILIA, pero una opción
      // que el cliente ya nombró también puede resolver la variante. Ejemplo
      // real: «chilaquiles suizos» comparte el mismo nombre base con cuatro
      // productos, pero la carta declara cuál es la variante base y que
      // «Suiza» pertenece al grupo Salsa. El resolvedor canónico ya sabe hacer
      // esa lectura sin inventar; la herramienta del agente no lo consultaba.
      //
      // Una mención totalmente genérica sigue devolviendo varios candidatos:
      // solo se acota cuando el cliente nombró una variante o cuando al menos
      // una opción de la carta quedó identificada de forma inequívoca.
      const evidencia = String(textoCiclo || mensaje || t);
      const anclada = anclarLinea({
        catalogo, nombrePropuesto: t, evidencia,
        dichoDelCliente: String(mensaje || evidencia),
      });
      const elecciones = (anclada?.grupos || [])
        .map((g) => ({ grupo: g.grupo, opciones: (g.elegidas || []).slice() }))
        .filter((g) => g.opciones.length);
      const varianteNombrada = anclada?.motivo === 'variante_nombrada';
      if (anclada?.estado === 'resuelto' && (varianteNombrada || elecciones.length)) {
        const resuelta = fichas.find((f) => String(f.id) === String(anclada.producto?.id));
        if (resuelta) fichas = [resuelta];
      }
      // La búsqueda por palabras también devuelve hermanos (por ejemplo,
      // «Licuado de fresa» junto a «Licuado de plátano»). Si el texto coincide
      // con UN nombre exacto de la carta, ese producto ya está elegido.
      const exactas = fichas.filter((f) => norm(f.nombre) === norm(t));
      if (exactas.length === 1) fichas = exactas;
      if (!fichas.length) {
        // NO EXISTE. Se dice así, con la carta a mano, y no se sustituye por
        // el más parecido: sustituir es cómo un cliente recibe una torta de
        // otra cosa dada por confirmada.
        return ok({
          encontrados: [],
          existe: false,
          nota: 'Ese producto NO está en la carta de este negocio. Díselo al cliente; no lo cambies por otro.',
          categorias: indiceDeLaCarta(catalogo),
        });
      }
      const encontrados = fichas.map((f) => ({
        producto_id: String(f.id),
        nombre: f.nombre,
        categoria: f.categoria,
        precio: f.precio,
        descripcion: f.descripcion,
        opciones_obligatorias: (f.grupos || []).filter((g) => g.requerido || (Number(g.minimo) || 0) > 0)
          .map((g) => g.nombre),
        ...(String(f.id) === String(anclada?.producto?.id) && elecciones.length
          ? { opciones_mencionadas: elecciones }
          : {}),
      }));
      // Un solo candidato es lo que un «sí» puede aceptar después. Con varios,
      // el cliente todavía no ha dicho cuál, y decidirlo por él es el error
      // que esta arquitectura existe para impedir.
      if (encontrados.length === 1) anotarOfrecido(encontrados[0].nombre);
      return ok({
        encontrados,
        existe: true,
        ...(encontrados.length > 1
          ? { nota: 'Hay varios. El cliente NO ha dicho cuál: pregúntaselo antes de agregar nada.' }
          : {}),
      });
    },

    ver_opciones_producto({ producto_id }) {
      const f = fichaPorId(catalogo, producto_id);
      if (!f) return invalido(`producto_id_inexistente: ${producto_id}. Usa buscar_producto para obtener uno válido.`);
      anotarOfrecido(f.nombre);
      return ok({
        producto_id: String(f.id),
        nombre: f.nombre,
        precio: f.precio,
        grupos: (f.grupos || []).map((g) => ({
          grupo: g.nombre,
          obligatorio: !!g.requerido || (Number(g.minimo) || 0) > 0,
          minimo: Number(g.minimo) || 0,
          maximo: g.maximo,
          opciones: (g.opciones || []).map((o) => ({ opcion: o.nombre, precio_extra: o.precio_extra })),
        })),
      });
    },

    agregar_producto({ producto_id, cantidad = 1, opciones = [], nota }) {
      const f = fichaPorId(catalogo, producto_id);
      if (!f) return invalido(`producto_id_inexistente: ${producto_id}. Usa buscar_producto para obtener uno válido.`);
      if (esContinuacionDeLinea({ estado, mensaje, ficha: f })) {
        return invalido('El cliente está completando el producto existente. Usa modificar_linea con la línea de la última pregunta; no agregues otra unidad.', { pedido: vista() });
      }
      const val = validarOpciones(f, opciones);
      if (!val.ok) return invalido(val.motivo, { grupos: val.grupos });
      const { seguras, ambiguas } = separarOpcionesAmbiguas({ estado, mensaje, ficha: f, opciones });
      const alcance = validarAlcanceOpciones({ estado, mensaje, ficha: f, opciones: seguras });
      if (alcance) return invalido(alcance, { pedido: vista() });
      const seleccion = validarOpciones(f, seguras);

      const r = aplicar([propuesta({
        accion: 'agregar',
        valorNuevo: {
          id: f.id,
          nombre: f.nombre,
          cantidad,
          modificadores: seleccion.modificadores,
          notas: nota || '',
        },
        evidencia: mensaje,
      })]);
      if (!r.aplicado) return noAplicado(porQueNo(r.decisiones), { pedido: r.pedido });
      return ok({ pedido: r.pedido, ...(ambiguas.length ? {
        parcial: true, opciones_no_aplicadas: ambiguas,
        motivo: 'Se guardó el producto y las opciones inequívocas. Pregunta por las opciones pendientes; no agregues otra unidad.',
      } : {}) });
    },

    modificar_linea({ linea_id, cantidad, opciones, sin_opciones, nota, reclasificar }) {
      if (reclasificar) {
        if (cantidad !== undefined || opciones !== undefined || sin_opciones !== undefined || nota !== undefined) {
          return invalido('Reclasifica primero y aplica las elecciones con una llamada posterior.');
        }
        const cambio = varianteDelPedido({ estado, catalogo, mensaje, lineaId: linea_id });
        if (!cambio) return invalido('No hay una variante inequívoca autorizada por este mensaje.');
        const anterior = cambio.item.nombre;
        cambio.item.id = cambio.producto.id;
        cambio.item.nombre = cambio.producto.nombre;
        estado.opcionesPendientes = (estado.opcionesPendientes || []).map(p => p.lid !== linea_id ? p : {
          ...p, producto: cambio.producto.nombre,
          maximo: cambio.producto.grupos.find(g => norm(g.nombre) === norm(p.grupo))?.maximo || p.maximo,
        });
        return ok({ pedido: vista(), reclasificado: { de: anterior, a: cambio.producto.nombre } });
      }
      const item = (estado.carrito.items || []).find((i) => i.lid === linea_id);
      if (!item) return invalido(`linea_inexistente: ${linea_id}. Llama a ver_pedido para ver los linea_id vigentes.`);
      const ficha = fichaPorNombre(catalogo, item.nombre);
      if ((opciones !== undefined || sin_opciones !== undefined) && !ficha) {
        return invalido(`renglon_fuera_de_carta: "${item.nombre}" ya no está en la carta.`);
      }

      const props = [];
      const alcance = validarAlcanceOpciones({ estado, mensaje, ficha, lineaId: linea_id,
        opciones, actuales: opcionesDeLinea(item), iniciales: opcionesAlIniciarTurno.get(linea_id) || [] });
      if (alcance) return invalido(alcance, { pedido: vista() });
      if (cantidad !== undefined) {
        props.push(propuesta({ accion: 'cambiar_cantidad', lid: linea_id, valorNuevo: cantidad, evidencia: mensaje }));
      }
      if (opciones !== undefined) {
        const val = validarOpciones(ficha, opciones);
        if (!val.ok) return invalido(val.motivo, { grupos: val.grupos });
        for (const g of val.modificadores) {
          props.push(propuesta({ accion: 'cambiar_modificador', lid: linea_id,
            campo: g.grupo, valorNuevo: g.opciones, evidencia: mensaje }));
        }
      }
      // ── QUITAR UNA OPCIÓN NO ES SUSTITUIRLA ─────────────────────────────
      //
      // «sin huevo», «sin fruta». Se expresa como un grupo con la lista vacía,
      // que es como `conGrupo` lo borra. El grupo tiene que EXISTIR en el
      // producto: quitar de un grupo que no tiene es la misma clase de invento
      // que agregarle una opción que no ofrece.
      const quitarGrupos = [];
      for (const nombreGrupo of (sin_opciones || [])) {
        const g = (ficha.grupos || []).find((x) => norm(x.nombre) === norm(nombreGrupo));
        if (!g) {
          return invalido(`grupo_inexistente: "${nombreGrupo}" no es un grupo de "${item.nombre}". `
            + `Los grupos reales son: ${(ficha.grupos || []).map((x) => x.nombre).join(', ') || '(ninguno)'}.`);
        }
        quitarGrupos.push(g.nombre);
        props.push(propuesta({ accion: 'cambiar_modificador', lid: linea_id,
          campo: g.nombre, valorNuevo: [], evidencia: mensaje }));
      }

      if (nota !== undefined) {
        props.push(propuesta({ accion: 'agregar_nota', lid: linea_id, valorNuevo: nota, evidencia: mensaje }));
      }
      if (!props.length) return invalido('nada_que_cambiar: manda al menos cantidad, opciones, sin_opciones o nota.');

      const r = aplicar(props);

      // ── EL RESULTADO SE LEE DEL PEDIDO, NO DE LAS DECISIONES ───────────
      //
      // Para quitar un grupo hay que proponer la lista vacía, y la contabilidad
      // de `aplicarPropuestas` da por no aplicada toda propuesta de modificador
      // cuyo valor esperado esté vacío — mide «¿quedaron puestas las que pedí?»
      // y no hay ninguna que comprobar. Antes que tocar esa contabilidad, que
      // es compartida con el mesero, se comprueba aquí contra la RELECTURA, que
      // además es la fuente de verdad de todas formas.
      const despues = (r.pedido.lineas || []).find((l) => l.linea_id === linea_id);
      const quitados = quitarGrupos.filter((g) => !(despues?.opciones || [])
        .some((o) => norm(o.grupo) === norm(g)));
      const seQuito = quitarGrupos.length > 0 && quitados.length === quitarGrupos.length;

      if (!r.aplicado && !seQuito) return noAplicado(porQueNo(r.decisiones), { pedido: r.pedido });
      return ok({ pedido: r.pedido,
        parcial: r.decisiones.some((d) => d.decision === 'rechazada') && !seQuito ? true : undefined });
    },

    quitar_linea({ linea_id }) {
      const item = (estado.carrito.items || []).find((i) => i.lid === linea_id);
      if (!item) return invalido(`linea_inexistente: ${linea_id}. Llama a ver_pedido para ver los linea_id vigentes.`);
      const r = aplicar([propuesta({ accion: 'quitar', lid: linea_id, evidencia: mensaje })]);
      if (!r.aplicado) return noAplicado(porQueNo(r.decisiones), { pedido: r.pedido });
      return ok({ pedido: r.pedido });
    },

    definir_entrega({ modalidad, direccion, referencias, zona_entrega }) {
      const props = [];
      let rechazoModalidad = null;
      let modalidadEvaluada = null;
      let costoPorModalidad = null;
      if (modalidad) {
        const evaluacion = evaluarModalidad({ modalidad, modalidades, mensaje });
        if (!evaluacion.ok) {
          rechazoModalidad = {
            motivo: evaluacion.motivo,
            codigo: evaluacion.codigo,
            modalidad_solicitada: evaluacion.tipo,
            modalidades_disponibles: evaluacion.disponibles.map((m) => etiquetaTipoModalidad(m.tipo)),
          };
        } else {
          modalidadEvaluada = evaluacion;
          props.push(propuesta({
            accion: 'definir_modalidad', valorNuevo: evaluacion.valor, evidencia: mensaje,
          }));
          // Cambiar de modalidad invalida cualquier tarifa anterior. En
          // domicilio se recupera la base; recoger/sitio guardan cero, que al
          // volver a domicilio tampoco puede confundirse con una zona.
          const costoBase = Number(reglas?.pedidos?.costo_envio) || 0;
          costoPorModalidad = evaluacion.tipo === 'domicilio' ? costoBase : 0;
        }
      }
      if (direccion || referencias) {
        props.push(propuesta({ accion: 'definir_cliente',
          valorNuevo: { ...(direccion ? { direccion } : {}), ...(referencias ? { referencias } : {}) },
          evidencia: mensaje }));
      }

      let zonaAplicada = null;
      let rechazoZona = null;
      if (zona_entrega) {
        const zonas = Array.isArray(reglas?.pedidos?.zonas_entrega) ? reglas.pedidos.zonas_entrega : [];
        const zona = zonas.find((z) => norm(z?.nombre) === norm(zona_entrega)
          && Number.isFinite(Number(z?.costo)));
        if (!zona) {
          rechazoZona = {
            codigo: 'zona_no_configurada', zona_solicitada: String(zona_entrega),
            zonas_disponibles: zonas.map((z) => z?.nombre).filter(Boolean),
            motivo: `zona_no_configurada: "${zona_entrega}". Zonas disponibles: `
              + `${zonas.map((z) => z?.nombre).filter(Boolean).join(', ') || 'ninguna'}.`,
          };
        } else if (!norm(mensaje).includes(norm(zona.nombre))) {
          rechazoZona = {
            codigo: 'zona_sin_respaldo', zona_solicitada: String(zona.nombre),
            motivo: `zona_sin_respaldo: el cliente no mencionó "${zona.nombre}" en este mensaje.`,
          };
        } else {
          const modalidadFinal = rechazoModalidad ? null : (modalidadEvaluada?.tipo
            || evaluarModalidad({ modalidad: estado.carrito?.datos?.modalidad,
              modalidades, mensaje, exigirEvidencia: false }).tipo);
          if (modalidadFinal !== 'domicilio') {
            rechazoZona = {
              codigo: 'zona_sin_domicilio', zona_solicitada: String(zona.nombre),
              motivo: `zona_sin_domicilio: ${zona.nombre} solo aplica a entrega a domicilio.`,
            };
          } else {
            zonaAplicada = { nombre: String(zona.nombre), costo: Number(zona.costo) };
            costoPorModalidad = zonaAplicada.costo;
          }
        }
      }
      if (costoPorModalidad !== null) props.push(propuesta({ accion: 'definir_costo_envio',
        valorNuevo: costoPorModalidad, evidencia: mensaje }));
      const r = aplicar(props);
      if (rechazoModalidad && r.aplicado) {
        return ok({ ...rechazoModalidad, pedido: r.pedido, parcial: true });
      }
      if (rechazoModalidad) {
        return noAplicado(rechazoModalidad.motivo, { ...rechazoModalidad, pedido: r.pedido });
      }
      if (rechazoZona && r.aplicado) {
        return ok({ ...rechazoZona, pedido: r.pedido, parcial: true });
      }
      if (rechazoZona) {
        return noAplicado(rechazoZona.motivo, { ...rechazoZona, pedido: r.pedido });
      }
      if (!r.aplicado) return noAplicado(porQueNo(r.decisiones), { pedido: r.pedido });
      return ok({ pedido: r.pedido, ...(zonaAplicada ? { zona_entrega: zonaAplicada } : {}) });
    },

    definir_pago({ forma_pago, paga_con }) {
      const evaluacion = evaluarFormaPago({
        formaPago: forma_pago, metodosPago, mensaje, ofrecido: estado.pagoOfrecido,
      });
      if (!evaluacion.ok) {
        if (evaluacion.alternativa) estado.pagoOfrecido = evaluacion.alternativa;
        return noAplicado(evaluacion.motivo, {
          codigo: evaluacion.codigo,
          metodo_solicitado: evaluacion.tipo,
          metodos_disponibles: evaluacion.disponibles.map(etiquetaTipoPago),
          alternativa: evaluacion.alternativa ? etiquetaTipoPago(evaluacion.alternativa) : null,
          pedido: vista(),
        });
      }
      const props = [propuesta({ accion: 'definir_pago', valorNuevo: evaluacion.tipo, evidencia: mensaje })];
      if (paga_con !== undefined) {
        props.push(propuesta({ accion: 'definir_cliente', valorNuevo: { paga_con }, evidencia: mensaje }));
      }
      const r = aplicar(props);
      if (!r.aplicado) return noAplicado(porQueNo(r.decisiones), { pedido: r.pedido });
      estado.pagoOfrecido = null;
      return ok({ metodo: evaluacion.tipo, pedido: vista() });
    },

    definir_cliente({ nombre }) {
      const r = aplicar([propuesta({ accion: 'definir_cliente', valorNuevo: { nombre }, evidencia: mensaje })]);
      if (!r.aplicado) return noAplicado(porQueNo(r.decisiones), { pedido: r.pedido });
      return ok({ pedido: r.pedido });
    },

    cancelar_pedido({ motivo }) {
      if (!autorizaCancelacion(mensaje)) return invalido('cancelacion_sin_autorizacion: el cliente no pidió cancelar todo el pedido. Conserva el borrador.');
      estado.carrito = carritoVacio();
      estado.programacionRequerida = false;
      estado.referenciaProgramacion = null;
      estado.hechos.cancelado = true;
      estado.terminadoEn = new Date().toISOString();
      estado.motivoCancelado = String(motivo || '').slice(0, 200);
      return ok({ pedido: vista(), cancelado: true });
    },

    async confirmar_pedido({ huella_resumen }) {
      const antes = vista();
      // ── LA COMPROBACIÓN QUE HACE QUE LA CONFIRMACIÓN NO SEA TEATRO ─────
      //
      // La huella es la del resumen que el cliente LEYÓ. Si el pedido cambió
      // entre aquel resumen y este «sí», el sí no vale para lo que hay ahora.
      // No se confirma y se devuelve el resumen fresco para que se vuelva a
      // mostrar. Es la única forma de que «confirmado» signifique siempre lo
      // mismo que el cliente aceptó.
      if (String(huella_resumen) !== String(antes.huella)) {
        return invalido('resumen_caducado: el pedido cambió desde el resumen que le mostraste al cliente. '
          + 'Vuelve a mostrarle el pedido de abajo y pídele que lo confirme otra vez.',
        { pedido: antes });
      }
      if (!autorizaConfirmacion({ estado, mensaje, huella: antes.huella })) {
        return invalido('confirmacion_sin_autorizacion: muestra el resumen vigente y espera su aceptación antes de registrar.', { pedido: antes });
      }
      // Defensa local, además de la puerta irreversible de `confirmarYEmitir`:
      // un replay o un adaptador de pruebas sin efectos reales tampoco puede
      // representar como confirmado HOY un pedido que aún exige fecha/hora.
      if (estado.programacionRequerida === true
          && !estado.carrito?.datos?.programado_para) {
        return invalido('falta_programar: el cliente pidió el pedido para otro día y no hay fecha fijada. '
          + 'Llama a programar_para con la fecha y la hora antes de confirmar.', { pedido: antes });
      }
      if (antes.falta.length || antes.aclaraciones.length) {
        // No debería llegar aquí: la máquina de estados ya lo filtró. Se
        // comprueba igual porque es la invariante que más caro cuesta romper.
        return invalido(`pedido_incompleto: falta ${antes.falta.join(', ') || 'una aclaración'}.`, { pedido: antes });
      }
      const r = efectos?.confirmar
        ? await efectos.confirmar({ estado, pedido: antes, catalogo, precios })
        : { ok: true, folio: null, simulado: true };
      if (!r?.ok) return noAplicado(`no_se_pudo_registrar: ${r?.motivo || 'desconocido'}`, {
        pedido: antes,
        ...(r?.resumen_canonico ? { resumen_canonico: r.resumen_canonico } : {}),
      });

      estado.hechos.confirmado = true;
      estado.terminadoEn = new Date().toISOString();
      estado.folio = r.folio ?? null;
      return ok({
        pedido: vista(), folio: r.folio ?? null, simulado: !!r.simulado,
        ...(r.total !== undefined ? { total: r.total } : {}),
        ...(r.subtotal !== undefined ? { subtotal: r.subtotal } : {}),
        ...(r.costo_envio !== undefined ? { costo_envio: r.costo_envio } : {}),
        ...(r.programado_para ? { programado_para: r.programado_para } : {}),
        ...(r.enlacePago?.url ? { enlace_pago: r.enlacePago.url } : {}),
        ...(r.enlacePagoError ? { enlace_pago_error: r.enlacePagoError } : {}),
      });
    },

    async pedir_humano({ motivo }) {
      const r = efectos?.escalar
        ? await efectos.escalar({ estado, motivo, pedido: vista() })
        : { ok: true, simulado: true };
      if (!r?.ok) return noAplicado(`no_se_pudo_escalar: ${r?.motivo || 'desconocido'}`, { pedido: vista() });
      estado.hechos.escalado = true;
      estado.motivoEscalado = String(motivo || '').slice(0, 200);
      return ok({ pedido: vista(), escalado: true, simulado: !!r?.simulado });
    },

    // ── EL MENÚ LO MANDA XABOR, Y DICE SI SALIÓ ────────────────────────
    //
    // El envío real lo hace `enviarMenuAutomatico`, que ya manda todas las
    // páginas en orden, reintenta una vez y redacta su propio aviso honesto
    // si algo falla. Por eso el resultado insiste en que el modelo NO diga
    // «aquí está tu menú»: esa frase ya la escribió quien sabe si de verdad
    // llegó, y duplicarla es —en el peor caso— afirmar un envío que falló.
    //
    // Va por el libro de operaciones como cualquier herramienta con efecto,
    // y su esquema no tiene argumentos: dos llamadas en el mismo turno dan la
    // misma clave, así que el cliente no recibe el menú dos veces.
    async enviar_menu() {
      if (!efectos?.enviarMenu) {
        return noAplicado('sin_canal_para_el_menu: este entorno no puede mandar imágenes. '
          + 'Descríbele la carta con palabras usando buscar_producto.', { pedido: vista() });
      }
      const r = await efectos.enviarMenu({ estado });
      if (!r?.ok) {
        return noAplicado(`no_se_pudo_enviar_el_menu: ${r?.motivo || 'desconocido'}. `
          + 'Díselo y ofrécele contarle la carta con palabras.', { pedido: vista() });
      }
      return ok({ pedido: vista(), paginas: r.paginas ?? null, simulado: !!r.simulado,
        nota: 'El menú ya se envió, con su texto. NO repitas que se lo mandaste: pregunta qué se le antoja.' });
    },

    // ── PROGRAMAR PARA OTRO DÍA ────────────────────────────────────────
    //
    // Se guarda en los datos del carrito y NO pasa por `reconciliar`: el
    // reconciliador decide qué ARTÍCULOS entran al pedido contra lo que dijo
    // el cliente, y una fecha no es un artículo. Lo que la autoriza es la
    // validación contra el horario del negocio, que es dato duro y no
    // interpretación.
    //
    // Quien lo convierte en reserva durable es `confirmar_pedido`, llamando a
    // `convertirPedidoAProgramado` después de registrar. Hasta entonces esto
    // es una intención, no una promesa.
    programar_para({ fecha, hora }) {
      // Una fecha/hora mencionada dentro de una consulta («¿abren mañana a
      // las 10?») no autoriza ningún cambio. La intención la decide el
      // detector determinista sobre las palabras del cliente, no la llamada
      // que el modelo haya querido fabricar.
      if (!intencionTemporalDelMensaje) {
        return invalido('programacion_sin_evidencia_cliente: programacion_sin_intencion_cliente; '
          + 'este mensaje no pide ni corrige '
          + 'una programación. No uses programar_para.', { pedido: vista() });
      }
      // Los argumentos son una interpretación del modelo, no evidencia de lo
      // que pidió el cliente. Para llegar al validador deben existir AMBOS
      // componentes en fragmentos whitelist del mensaje/estado, o en una
      // reserva validada anterior cuyo componente opuesto se está corrigiendo.
      const referencia = referenciaEfectiva();
      const fechasDelCliente = fechasExactasDePedido(referencia?.fechaCliente, {
        fechaAncla: referencia?.fechaAncla,
      });
      const horasDelCliente = horasExactasDePedido(referencia?.horaCliente);
      const hayFecha = !!(fechasDelCliente.length || referencia?.fechaValidada
        || referencia?.isoValidado);
      const hayHora = !!(horasDelCliente.length || referencia?.horaValidada
        || referencia?.isoValidado);
      if (!hayFecha || !hayHora) {
        return invalido('programacion_sin_evidencia_cliente: falta que el cliente indique '
          + `${!hayFecha && !hayHora ? 'fecha y hora' : (!hayFecha ? 'la fecha' : 'la hora')}. `
          + (referencia?.fechaCliente && !fechasDelCliente.length
            ? `«${referencia.fechaCliente}» no identifica un día exacto. ` : '')
          + (referencia?.horaCliente && !horasDelCliente.length
            ? `«${referencia.horaCliente}» es una franja, no una hora exacta. ` : '')
          + 'Pregúntale el dato exacto; no lo completes desde los argumentos de la herramienta.',
        { pedido: vista() });
      }
      // El primer par que interpreta la evidencia queda ligado a ella incluso
      // si la política lo rechaza. Esta guarda va antes de las comparaciones
      // literales para que una segunda propuesta distinta conserve un único
      // desenlace estable: necesita palabras nuevas del cliente.
      if ((referencia.fechaIntentada && String(fecha) !== referencia.fechaIntentada)
          || (referencia.horaIntentada && String(hora) !== referencia.horaIntentada)) {
        return invalido('programacion_alternativa_sin_cliente: Xabor ya evaluó '
          + `${referencia.fechaIntentada || 'esa fecha'} ${referencia.horaIntentada || 'esa hora'} `
          + 'para esas palabras. '
          + 'Pregunta otra fecha u hora y espera un mensaje nuevo del cliente.', { pedido: vista() });
      }
      if (fechasDelCliente.length && !fechasDelCliente.includes(String(fecha))) {
        return invalido('fecha_no_coincide_con_cliente: la fecha propuesta no corresponde a '
          + `«${referencia.fechaCliente}» dicha con fecha local ${referencia.fechaAncla || 'desconocida'}. `
          + `La fecha permitida es ${fechasDelCliente.join(' o ')}.`, { pedido: vista() });
      }
      if (horasDelCliente.length && !horasDelCliente.includes(String(hora))) {
        return invalido('hora_no_coincide_con_cliente: la hora propuesta no corresponde a '
          + `«${referencia.horaCliente}». Las lecturas literales permitidas son `
          + `${horasDelCliente.join(' o ')}.`, { pedido: vista() });
      }

      // Una hora sin AM/PM puede tener dos lecturas literales. Xabor solo la
      // desambigua cuando la política dura vuelve imposible una de ellas. Si
      // ambas caben en el horario, elegir mañana/noche sería inventar por el
      // cliente y se le pide que lo aclare.
      if (horasDelCliente.length > 1) {
        const interpretacionesPosibles = horasDelCliente.filter((horaCandidata) => validarProgramado({
          fecha: String(fecha), hora: horaCandidata, reglas, configTienda, zona: zonaDelNegocio,
          minutosPreparacion: reglas?.pedidos?.tiempo_preparacion_minutos ?? null,
        }).ok);
        if (interpretacionesPosibles.length > 1) {
          return invalido('hora_ambigua_cliente: la hora tiene más de una lectura válida '
            + `(${interpretacionesPosibles.join(' o ')}). Pregunta AM/PM o mañana/tarde y espera su respuesta.`,
          { pedido: vista() });
        }
        if (interpretacionesPosibles.length === 1
            && String(hora) !== interpretacionesPosibles[0]) {
          return invalido('hora_no_coincide_con_contexto: con el horario de ese día, '
            + `«${referencia.horaCliente}» solo puede ser ${interpretacionesPosibles[0]}.`,
          { pedido: vista() });
        }
      }
      // Si el cliente corrigió solo un componente, el otro ya es un hecho
      // exacto de Xabor. El modelo debe copiarlo, no reinterpretarlo.
      if (!fechasDelCliente.length && referencia.fechaValidada
          && String(fecha) !== referencia.fechaValidada) {
        return invalido('fecha_no_coincide_con_programacion_validada: conserva la fecha '
          + `${referencia.fechaValidada}; el cliente solo cambió la hora.`, { pedido: vista() });
      }
      if (!horasDelCliente.length && referencia.horaValidada
          && String(hora) !== referencia.horaValidada) {
        return invalido('hora_no_coincide_con_programacion_validada: conserva la hora '
          + `${referencia.horaValidada}; el cliente solo cambió la fecha.`, { pedido: vista() });
      }

      estado.referenciaProgramacion = referenciaProgramacionSegura({
        ...referencia,
        fechaIntentada: String(fecha),
        horaIntentada: String(hora),
      });
      estado.programacionRequerida = true;
      // En producción el adaptador ya invalidó A antes de llamar al modelo.
      // Esta rama conserva el mismo fail-safe para callers directos, pero solo
      // sobre lo que existía AL INICIAR el turno: jamás borra el éxito de una
      // primera llamada porque el modelo haya hecho una segunda.
      if (programadoAlIniciarTurno && (referenciasDelMensaje.fecha || referenciasDelMensaje.hora)) {
        delete estado.carrito.datos.programado_para;
      }

      const r = validarProgramado({
        fecha, hora, reglas, configTienda, zona: zonaDelNegocio,
        minutosPreparacion: reglas?.pedidos?.tiempo_preparacion_minutos ?? null,
      });
      if (!r.ok) return invalido(`${r.motivo}: ${r.mensaje}`, { pedido: vista() });

      estado.programacionRequerida = true;
      estado.carrito.datos = { ...(estado.carrito.datos || {}), programado_para: r.iso };
      // Solo después de validar se promueven los argumentos interpretados a
      // hechos de Xabor. Los fragmentos del cliente ya no hacen falta.
      estado.referenciaProgramacion = {
        fechaCliente: null,
        horaCliente: null,
        fechaValidada: r.fecha,
        horaValidada: r.hora,
        isoValidado: r.iso,
        fechaIntentada: r.fecha,
        horaIntentada: r.hora,
      };
      return ok({ pedido: vista(), programado_para: r.iso, dia: r.dia, hora: r.hora,
        anticipacion_minutos: r.anticipacionMinutos,
        nota: `Queda para el ${r.dia} a las ${r.hora}. Díselo con esas palabras y sigue con el pedido. `
          + 'La comanda sale en cocina una hora antes, no ahora.' });
    },

    // ── UN EVENTO SE ANOTA, NO SE COTIZA ───────────────────────────────
    //
    // Decisión del dueño: el agente toma cuatro mínimos y avisa de que alguien
    // del equipo se comunica. No propone menús, no da precios, no promete
    // disponibilidad. Un evento se cotiza mirando personal, agenda y margen,
    // y nada de eso está en la carta.
    //
    // Los datos se ACUMULAN entre llamadas porque una persona los da a
    // trozos. Mientras falte alguno, la herramienta contesta qué falta y no
    // escala: escalar a medias le daría a quien conteste un aviso sin datos.
    async registrar_solicitud_evento(datos) {
      // El modelo no convierte un pedido grande en evento. La primera llamada
      // necesita una señal explícita en las palabras del cliente; después el
      // estado durable permite continuar con respuestas sueltas (nombre,
      // lugar, asistentes, fecha/hora).
      if (!estado.evento && !esSolicitudCatering(mensaje)) {
        return invalido('solicitud_evento_sin_senal_explicita: trátalo como pedido normal; '
          + 'la cantidad de artículos o personas no convierte un pedido en catering.');
      }
      // Estados escritos antes de la barrera de procedencia no son hechos:
      // se conservan únicamente los valores cuya firma coincide. El nombre
      // confiable del canal ya llega firmado al inicializar la ficha.
      let previo = eventoCateringVerificado(estado.evento || {});
      const evidencia = filtrarDatosEventoCatering(datos, {
        mensaje,
        eventoPrevio: previo,
      });
      previo = retirarCamposEventoCatering(previo, evidencia.invalidados);
      const eventoSinSello = {
        nombre: evidencia.aceptados.nombre ?? previo.nombre ?? null,
        lugar: evidencia.aceptados.lugar ?? previo.lugar ?? null,
        fecha_hora: evidencia.aceptados.fecha_hora !== undefined
          ? fusionarFechaHoraCatering(previo.fecha_hora, evidencia.aceptados.fecha_hora)
          : (previo.fecha_hora ?? null),
        tipo_servicio: evidencia.aceptados.tipo_servicio ?? previo.tipo_servicio ?? null,
        personas: evidencia.aceptados.personas ?? previo.personas ?? null,
      };
      const evento = sellarEventoCatering(
        { ...previo, ...eventoSinSello }, Object.keys(evidencia.aceptados));
      estado.evento = evento;
      const eventoPublico = eventoCateringPublico(evento);

      // Mínimos deterministas: nombre + fecha/hora + lugar + asistentes. El
      // teléfono ya viene del canal. `tipo_servicio` se conserva si lo dijo,
      // pero no se le obliga a elegir una categoría ni bloquea el handoff.
      const faltan = ['nombre', 'personas', 'lugar'].filter((k) => !eventoPublico[k]);
      const fechaHora = partesFechaHoraCatering({ fecha_evento: eventoPublico.fecha_hora });
      if (!fechaHora.tieneFecha || !fechaHora.tieneHora) faltan.push('fecha_hora');
      if (faltan.length) {
        return ok({ registrado: false, evento: eventoPublico, faltan,
          ...(evidencia.rechazados.length ? { sin_evidencia: evidencia.rechazados } : {}),
          nota: `Anotado lo que hay. Todavía falta: ${faltan.join(', ')}. Pregúntaselo, de uno en uno.` });
      }

      const r = efectos?.registrarEvento
        ? await efectos.registrarEvento({ estado, evento: eventoPublico })
        : { ok: true, simulado: true };
      if (!r?.ok) {
        return noAplicado(`no_se_pudo_registrar_el_evento: ${r?.motivo || 'desconocido'}`, { pedido: vista() });
      }

      // Queda escalado: a partir de aquí contesta una persona. Es el mismo
      // desenlace que `pedir_humano` y por eso reutiliza su estado, en vez de
      // inventar un sexto hecho irreversible que habría que mantener aparte.
      estado.hechos.escalado = true;
      estado.motivoEscalado = `solicitud de evento${eventoPublico.tipo_servicio ? `: ${eventoPublico.tipo_servicio}` : ''}`;
      return ok({ registrado: true, evento: eventoPublico, pedido: vista(), escalado: true, simulado: !!r.simulado,
        nota: 'Ya quedó anotado. Dile que alguien del equipo se comunica con él para los detalles. '
          + 'No le des precios ni propongas menú.' });
    },
  };

  /**
   * EJECUTA UNA LLAMADA. Único punto de entrada.
   *
   * El orden importa y es el mismo siempre: legalidad de la transición ->
   * implementación -> relectura. Una herramienta ilegal ni siquiera llega a
   * tocar el carrito.
   */
  return {
    vista,
    async ejecutar(nombre, argumentos) {
      if (politicaDelTurno(mensaje).soloLectura && tieneEfecto(nombre) && nombre !== 'pedir_humano') {
        return invalido('Este mensaje es una consulta. Contesta usando las herramientas de lectura sin cambiar el pedido.', { pedido: vista() });
      }
      // Una ficha de evento es un flujo separado, sin carrito, precios, pago,
      // menú ni confirmación. El prompt orienta; esta barrera impide efectos
      // aunque el modelo ignore por completo esas instrucciones.
      if (estado.evento && !['registrar_solicitud_evento', 'pedir_humano'].includes(nombre)) {
        return invalido(`flujo_catering_activo: ${nombre} no está permitido mientras se recopilan datos de evento`, {
          pedido: vista(),
        });
      }
      if (estado.evento && nombre === 'pedir_humano' && !solicitaAtencionHumana(mensaje)) {
        const evento = eventoCateringPublico(eventoCateringVerificado(estado.evento));
        const fecha = partesFechaHoraCatering({ fecha_evento: evento.fecha_hora });
        const incompleta = !evento.nombre || !evento.personas || !evento.lugar
          || !fecha.tieneFecha || !fecha.tieneHora;
        if (incompleta) {
          return invalido('catering_datos_incompletos: recopila los cuatro datos antes de entregar el caso', {
            pedido: vista(),
          });
        }
      }
      const pedidoAhora = vista();
      const t = transicionLegal(nombre, pedidoAhora.estado);
      if (!t.legal) return invalido(t.motivo, { pedido: pedidoAhora });

      const fn = impl[nombre];
      if (!fn) return invalido(`herramienta_desconocida: ${nombre}`);
      const r = await fn(argumentos || {});
      return r;
    },
    /** Al cerrar el turno: lo ofrecido AHORA es lo que un «sí» podrá aceptar DESPUÉS. */
    cerrarTurno() {
      estado.ofrecidos = estado.ofrecidosDelTurno.slice();
      estado.ofrecidosDelTurno = [];
      estado.turno += 1;
    },
  };
}

/**
 * ¿EXISTEN ESTAS OPCIONES EN ESTE PRODUCTO?
 *
 * Contra los grupos REALES del producto real. Un grupo que no tiene, o una
 * opción que ese grupo no ofrece, es un `ilegal` con la lista de lo que sí
 * hay — para que el modelo pueda corregir en el mismo turno en vez de
 * inventar por segunda vez.
 *
 * Se compara normalizado (acentos, mayúsculas) porque el modelo copia los
 * nombres a mano y una tilde no debería costar un turno; pero se GUARDA el
 * nombre canónico de la carta, nunca el que escribió el modelo.
 */
export function validarOpciones(ficha, opciones = []) {
  const grupos = (ficha?.grupos || []);
  const elegidas = Array.isArray(opciones) ? opciones : [];
  const porGrupo = new Map();

  for (const e of elegidas) {
    const g = grupos.find((x) => norm(x.nombre) === norm(e.grupo));
    if (!g) {
      return { ok: false,
        motivo: `grupo_inexistente: "${e.grupo}" no es un grupo de "${ficha?.nombre}". `
          + `Los grupos reales son: ${grupos.map((x) => x.nombre).join(', ') || '(ninguno)'}.`,
        grupos: grupos.map((x) => ({ grupo: x.nombre, opciones: (x.opciones || []).map((o) => o.nombre) })) };
    }
    const o = (g.opciones || []).find((x) => norm(x.nombre) === norm(e.opcion));
    if (!o) {
      return { ok: false,
        motivo: `opcion_inexistente: "${e.opcion}" no existe en el grupo "${g.nombre}" de "${ficha?.nombre}". `
          + `Las opciones reales son: ${(g.opciones || []).map((x) => x.nombre).join(', ') || '(ninguna)'}.`,
        grupos: [{ grupo: g.nombre, opciones: (g.opciones || []).map((x) => x.nombre) }] };
    }
    const lista = porGrupo.get(g.nombre) || [];
    if (!lista.includes(o.nombre)) lista.push(o.nombre);
    porGrupo.set(g.nombre, lista);
  }

  // La cardinalidad la declara el negocio y aquí se respeta: pedir dos salsas
  // de un grupo que admite una no es una preferencia del cliente que haya que
  // acomodar, es una elección imposible en esa carta.
  for (const [nombre, lista] of porGrupo) {
    const g = grupos.find((x) => x.nombre === nombre);
    const { maximo: max } = cardinalidadDeGrupo(g);
    if (lista.length > max) {
      return { ok: false,
        motivo: `demasiadas_opciones: "${nombre}" admite como máximo ${max} y mandaste ${lista.length}. `
          + 'Pregúntale al cliente cuál quiere.',
        grupos: [{ grupo: nombre, opciones: (g.opciones || []).map((x) => x.nombre), maximo: max }] };
    }
  }

  return { ok: true, motivo: null,
    modificadores: [...porGrupo.entries()].map(([grupo, ops]) => ({ grupo, opciones: ops })) };
}

export { tieneEfecto, esTerminal, productosVendibles, fichaDeProducto };
