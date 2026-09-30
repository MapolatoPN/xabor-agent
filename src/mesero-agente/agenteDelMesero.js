// ─── EL BUCLE DEL AGENTE ──────────────────────────────────────────────────
//
// Un turno completo: mensaje del cliente -> el modelo pide herramientas ->
// Xabor las ejecuta contra el estado real -> el modelo lee los resultados ->
// redacta la respuesta. No hay ningún otro camino a un cambio en el pedido.
//
// ── Lo que este bucle garantiza, y cómo ──────────────────────────────────
//
//   El texto que ve el cliente se redacta DESPUÉS de todas las herramientas.
//     Un mensaje del modelo puede traer texto y llamadas a la vez; ese texto
//     se DESCARTA. Es la diferencia entre «ya te lo agregué» dicho antes de
//     intentarlo y dicho después de que el reconciliador lo aceptara.
//
//   Ninguna llamada se ejecuta sin validar su esquema.
//     Un esquema roto no tira el turno: vuelve como `tool_result` de error y
//     el modelo corrige. Un modelo que se equivoca no es un pedido estropeado.
//
//   Una respuesta corta se lee contra la pregunta que se hizo.
//     «Sí», «no», «esa», «dos», «sin eso», «la segunda» se interpretan SOLO
//     contra `estado.pendiente` (respuestaCorta.js) y se ejecutan por el mismo
//     circuito que las herramientas del modelo. El modelo no interviene.
//
//   Una mutación se aplica como mucho una vez.
//     El libro de operaciones, por clave de operación; el commit del turno,
//     por identidad del lote de wamids (canalDelAgente). Y hay un tope de
//     mutaciones por turno: un bucle del modelo no puede vaciar una carta
//     dentro del pedido de nadie.
//
//   Lo que sale al cliente se deriva del estado autorizado.
//     Con pedido en curso, la respuesta la construye el backend. Cuando se
//     publica prosa del modelo, pasa antes por `revisarRedaccion`: protocolo
//     interno, productos no publicados, precios no verificados o una
//     confirmación inexistente la descartan y se sustituye por texto del
//     estado. Un fallo del proveedor (timeout, 5xx, respuesta cortada o vacía)
//     tampoco corrompe nada: el carrito se conserva y se responde desde él.
//
//   El turno SIEMPRE termina con algo que decirle al cliente, y con UNA
//   pregunta pendiente estructurada (o ninguna), fijada en `cerrar`.
import {
  definicionesParaElModelo, validarArgumentos, tieneEfecto, esAccionDeSistema, esEfectoExterno,
} from './contratoDeHerramientas.js';
import { crearEjecutor } from './ejecutorDeHerramientas.js';
import { hashDeArgumentos } from './libroDeOperaciones.js';
import { construirInstrucciones } from './instrucciones.js';
import { respuestaProhibidaEncontrada } from './reglasDelAsistente.js';
import {
  accionesParaOpcionesPendientes, siguientePreguntaDelPedido, grupoExplicitoNoAplicable,
  preguntaPorOpcionesCompartidas,
} from './continuidadDeterminista.js';
import { claveEvidenciaOpcion } from '../orders/carritoDelPedido.js';
import { exigirRespuestaCompleta, diagnosticarRespuestaTruncada } from '../agent/respuestaTruncada.js';
import { respuestaAfirmaCambioSinAplicar } from './seguridadConversacional.js';
import { esSaludoSolo, puedeRecuperarSinEfectos, respuestaDesdePedido, saludoDelNegocio,
  puedeCerrarConAvance, respuestaDeAvance } from './recuperacionDelTurno.js';
import { politicaDelTurno, respuestaDeConsulta } from './politicaDelTurno.js';
import { varianteDelPedido } from './varianteDelPedido.js';
import { iniciarSeleccion, resolverSeleccion, preguntaDeSeleccion, pideAgregarOtro } from './seleccionDeProducto.js';
import { guardarDialogo, respuestaCanonica, soloElecciones, escritoAntesDelAcuse, autorizaCancelacion } from './contratoConversacional.js';
import { cerrarEleccionTrasTexto } from './eleccionesInteractivas.js';
import { preguntaDePedidoMultiple } from './preguntaDePedidoMultiple.js';
import { interpretarRespuestaCorta } from './respuestaCorta.js';
import {
  fijarPendiente, pendienteDesdeFoco, normalizarEstado, derivarFase, PENDIENTES, LIMITE_REPREGUNTAS,
} from './estadoCanonico.js';
import { revisarRedaccion } from './emisionSegura.js';
import { cortesiaPostPedido } from './cortesiaPostPedido.js';
import { respuestaOperativaVerificada } from './estadoOperativoDelPedido.js';
import { modalidadesDisponibles } from '../orders/modalidadesDelPedido.js';
import { tiposDePagoDisponibles } from './politicaDePagos.js';

export const MODELO_POR_OMISION = 'claude-sonnet-5';

/** Fallos seguidos del proveedor antes de pasar la conversación a una persona. */
export const LIMITE_FALLOS_PROVEEDOR = 3;

/** Relleno neutro de una captura de evento; el canal lo sustituye por la pregunta que falta. */
const TEXTO_CAPTURA_DE_EVENTO = 'Con gusto te ayudo con tu evento. Permíteme tomar tus datos para que alguien del equipo te contacte.';

export const CIERRE = Object.freeze({
  RESPONDIO: 'respondio',
  ESCALADO: 'escalado',
  SIN_ITERACIONES: 'sin_iteraciones',
  TOPE_MUTACIONES: 'tope_mutaciones',
  ERROR: 'error',
  TIEMPO: 'tiempo',
});

const textoDe = (respuesta) => (respuesta?.content || [])
  .filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

const llamadasDe = (respuesta) => (respuesta?.content || []).filter((b) => b.type === 'tool_use');

const normalizarTexto = (s) => ` ${String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;

const MENSAJE_RESULTADO_TECNICO = 'La acción no se aplicó. No muestres detalles técnicos ni afirmes que se completó; '
  + 'usa el estado actual para pedir el dato faltante o solicita ayuda humana.';
// Estos códigos y prefijos envuelven fallos de DB, red o efectos externos. El
// detalle crudo se conserva en `operaciones`/traza, pero jamás se vuelve
// contexto del modelo que redacta para el cliente. Los motivos con estado
// `ilegal` son distintos: los redacta Xabor para que el modelo pueda resolver
// lo que falta (por ejemplo, devolver las opciones válidas). Solo se permite
// ese texto después de pasar por el mismo filtro técnico.
const DETALLE_TECNICO_EN_RESULTADO = [
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/,
  /\bno_se_pudo_[a-z0-9_]*\b/i,
  /\b(?:registrarPedido|negocioId|tool_use_id|stack|sqlstate)\b/,
  /\b[A-Za-z0-9]*Error\b/,
  /\bcanal\s*=\s*[a-z]/i,
];

const textoDeResultadoParaModelo = (valor, { motivoIlegal = false, motivoRechazada = false } = {}) => {
  const texto = String(valor ?? '');
  if (motivoRechazada) return MENSAJE_RESULTADO_TECNICO;
  if (DETALLE_TECNICO_EN_RESULTADO.some((patron) => patron.test(texto))) {
    return MENSAJE_RESULTADO_TECNICO;
  }
  // Solo los motivos de `invalido()` pueden conservar snake_case: son códigos
  // de negocio acompañados de instrucciones útiles para el modelo, no trazas.
  // Los resultados `rechazada` siguen cayendo en el mensaje genérico.
  if (!motivoIlegal && /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/i.test(texto)) {
    return MENSAJE_RESULTADO_TECNICO;
  }
  return texto;
};

const resultadoParaModelo = (valor, clave = '', estadoResultado = null) => {
  if (Array.isArray(valor)) return valor.map((v) => resultadoParaModelo(v, clave, estadoResultado));
  if (!valor || typeof valor !== 'object') {
    if (typeof valor !== 'string') return valor;
    if (/^(?:codigo|error|error_detalle)$/i.test(clave)) return MENSAJE_RESULTADO_TECNICO;
    return /^(?:motivo|detalle)$/i.test(clave)
      ? textoDeResultadoParaModelo(valor, {
        motivoIlegal: estadoResultado === 'ilegal',
        motivoRechazada: estadoResultado === 'rechazada',
      }) : valor;
  }
  const estadoLocal = clave === '' && typeof valor.estado === 'string'
    ? valor.estado : estadoResultado;
  const entradas = Object.entries(valor)
    .filter(([k]) => !(clave === '' && /^(?:aplicado|estado)$/i.test(k)))
    .map(([k, v]) => [k, resultadoParaModelo(v, k, estadoLocal)]);
  const seguro = Object.fromEntries(entradas);
  if (clave === '' && Object.hasOwn(valor, 'aplicado')) {
    seguro.resultado = valor.aplicado === true
      ? 'La acción se completó.'
      : 'La acción no se aplicó.';
  }
  return seguro;
};

/** La oferta de una forma de pago alternativa, redactada por Xabor. */
export function textoOfertaDePago(resultadoRechazo) {
  const solicitada = resultadoRechazo?.metodo_solicitado;
  const alternativa = resultadoRechazo?.alternativa_tipo;
  if (solicitada === 'transferencia' && alternativa === 'enlace_pago') {
    return 'No contamos con pagos por transferencia, pero podemos ofrecerte un enlace de pago; '
      + 'es muy similar a pagar con transferencia. ¿Te funciona?';
  }
  return `No contamos con esa forma de pago, pero podemos ofrecerte ${resultadoRechazo?.alternativa || 'otra opción'}. ¿Te funciona?`;
}

const TEXTO_RECHAZO = Object.freeze({
  producto: 'Entendido, no lo agrego.',
  promocion: 'Entendido, dejamos la promoción.',
  pago: 'Entendido.',
});

/**
 * ATIENDE UN TURNO.
 *
 * `llamarModelo` se inyecta siempre: en producción es el SDK de Anthropic, en
 * el replay es un guion, en la sombra es el mismo de producción. Que el bucle
 * no sepa cuál es lo hace probable sin red y sin coste.
 *
 * `respuestaDeSistema` ({ texto, acciones }) es un turno que Xabor contesta con
 * sus propios datos (por ejemplo, la consulta oficial de promociones): sus
 * acciones pasan por el mismo circuito y el cierre fija el pendiente que dejen.
 */
export async function atenderTurnoConHerramientas({
  negocioId, conversacionId, turnoId,
  mensaje = '', historial = [],
  catalogo = [], precios = null, requierePago = true, metodosPago = null, modalidades = null,
  reglas = null, configTienda = null, promocionesActivas = [], zonaDelNegocio = undefined,
  estado, libro = null, llamarModelo,
  efectos = null, contexto = {}, modo = 'productivo',
  modelo = MODELO_POR_OMISION, maxTokens = 1024,
  topeIteraciones = 6, topeMutaciones = 12, topeMs = 30000,
  traza = null,
  promocionesVerificadas = [], promocionesVigentesIds = null, nombreDelCanal = null,
  nombresOcultos = [], respuestaDeSistema = null, consultaInformativa = false,
} = {}) {
  if (typeof llamarModelo !== 'function') throw new Error('atenderTurnoConHerramientas necesita llamarModelo');
  if (!estado) throw new Error('atenderTurnoConHerramientas necesita el estado de la conversación');

  // Cualquier estado —nuevo, de una fila vieja o armado por una prueba— se
  // lleva al esquema canónico antes de leer lo pendiente.
  normalizarEstado(estado);

  const t0 = Date.now();
  const esPrimerTurno = (estado.turno || 0) === 0;
  const operaciones = [];
  let mutaciones = 0;
  const ocurrencias = new Map();
  let iteraciones = 0;
  let llamadasAlModelo = 0;
  let modeloMs=0,herramientasMs=0,modeloIntentos=0;
  const medirHerramienta=async fn=>{const inicio=Date.now();try{return await fn();}finally{herramientasMs+=Date.now()-inicio;}};
  const opcionesAceptadas = [];
  const politica = consultaInformativa ? {tipo:'consulta',soloLectura:true} : politicaDelTurno(mensaje);
  if (!historial.length) historial = estado.historialDialogo || [];
  let recuperacionesModelo = 0;
  let esperandoModelo = false;
  const erroresProveedor = [];

  const ejecutor = crearEjecutor({
    estado, catalogo, precios, requierePago, metodosPago, modalidades,
    reglas, configTienda, promocionesActivas, zonaDelNegocio,
    mensaje, soloConsulta:politica.soloLectura,
    textoCiclo: contexto.textoCiclo ?? mensaje,
    terminos: contexto.terminos ?? [],
    datoOperativoPendiente: contexto.datoOperativoPendiente ?? false,
    opcionesAceptadas,
    efectos,
    promocionesVerificadas, promocionesVigentesIds, nombreDelCanal,
  });

  const herramientas = definicionesParaElModelo().filter((h) => !politica.soloLectura
    || !tieneEfecto(h.name) || h.name === 'pedir_humano');
  const instruccionesDelTurno = () => construirInstrucciones({ ...contexto, pedido: ejecutor.vista() })
    + (estado.foco?.tipo === 'opcion' ? `\nLa pregunta pendiente se refiere a linea_id=${estado.foco.linea_id}, grupo=${estado.foco.grupo}. Las preferencias de ese artículo se guardan con modificar_linea; no crees otro renglón para completarlas.` : '')
    + (politica.soloLectura ? '\nEste turno es una CONSULTA. Responde a la pregunta actual con los datos consultados. Conserva el pedido; no pidas confirmarlo como sustituto de la respuesta.' : '')
    + '\nUna respuesta corta a una opción corresponde solo a la última pregunta. Si distintos grupos comparten opciones, interpreta su función en la frase; si no es inequívoca, pregunta por UN grupo sin reutilizar la misma mención en varios.';
  let instrucciones = instruccionesDelTurno();

  const mensajes = [
    ...historial.map((m) => ({ role: m.rol === 'assistant' ? 'assistant' : 'user', content: String(m.texto || '') }))
      .filter((m) => m.content),
    { role: 'user', content: mensaje },
  ];

  const anotar = (evento) => { try { traza?.(evento); } catch { /* la traza nunca tumba un turno */ } };
  const huboAvance = () => operaciones.some((o) => tieneEfecto(o.herramienta) && o.resultado?.aplicado);
  const opcionesDeLaPregunta = () => ({
    opcionesModalidad: (modalidadesDisponibles(modalidades) || []).map((m) => m.valor),
    opcionesPago: tiposDePagoDisponibles(metodosPago) || [],
  });

  /**
   * LA PREGUNTA QUE DEJA ESTA RESPUESTA. Se decide con datos, en este orden:
   *   1. la que fija explícitamente quien cierra (acciones de sistema, rechazos);
   *   2. el resumen canónico → confirmar ESA huella;
   *   3. una pregunta construida por el backend desde el estado (`derivado`);
   *   4. prosa del modelo que nombra UN producto que las herramientas le
   *      presentaron en este turno y que no está en el pedido → aceptarlo;
   *   5. ninguna: un «sí» suelto al turno siguiente lo interpreta el modelo y
   *      no autoriza nada por sí mismo.
   */
  const ofertaDeProductoDelModelo = (texto) => {
    const presentados = ejecutor.productosPresentados()
      .filter((p) => !(estado.carrito?.items || []).some((i) => String(i.id) === String(p.producto_id)));
    const nombrados = presentados.filter((p) => normalizarTexto(texto).includes(normalizarTexto(p.nombre)));
    return presentados.length === 1 && nombrados.length === 1
      ? { tipo: PENDIENTES.ACEPTAR_PRODUCTO, producto_id: nombrados[0].producto_id, producto: nombrados[0].nombre }
      : null;
  };
  const pendienteDelCierre = ({ texto, tipo, huella, pedido, extra }) => {
    if (extra && Object.hasOwn(extra, 'pendiente')) return extra.pendiente;
    if (tipo === 'resumen' && huella) return { tipo: PENDIENTES.CONFIRMAR_RESUMEN, huella };
    if (extra?.derivado) {
      if (estado.programacionRequerida && !pedido.programado_para && !estado.foco) {
        return { tipo: PENDIENTES.FECHA_HORA };
      }
      return pendienteDesdeFoco(estado.foco, pedido, opcionesDeLaPregunta());
    }
    if (extra?.redaccionModelo) {
      return ofertaDeProductoDelModelo(texto);
    }
    return null;
  };

  /**
   * Una salida de emergencia que SIEMPRE deja al cliente atendido.
   *
   * ── Y QUE COMPRUEBA LO QUE PROMETE ────────────────────────────────────
   *
   * El texto que sale de aquí dice «te paso con alguien del equipo». Si el
   * handoff no se aplicó, ese texto es una mentira, y la peor posible: el
   * cliente deja de insistir justo cuando nadie ha sido avisado. Por eso se
   * mira si el efecto ocurrió, se grita en el log si no, y se devuelve
   * `handoffPendiente` para que el adaptador, que es quien sabe a quién
   * avisar, tenga un último intento.
   */
  const escalarYSalir = async (motivoCierre, motivo) => {
    let r = null;
    try { r = await ejecutor.ejecutar('pedir_humano', { motivo }); }
    catch (e) { r = { aplicado: false, estado: 'error', motivo: String(e?.message || e) }; }
    operaciones.push({ herramienta: 'pedir_humano', argumentos: { motivo }, resultado: r, forzada: true });

    const entregado = !!r?.aplicado && !!estado.hechos.escalado;
    if (!entregado) {
      console.error(`[AGENTE] ALERTA handoff_no_entregado cierre=${motivoCierre} `
        + `estado=${ejecutor.vista().estado} porque=${String(r?.motivo || 'desconocido').slice(0, 120)}`);
    }
    anotar({ tipo: 'escalado_forzado', motivo, motivoCierre, entregado });
    return cerrar(motivoCierre, contexto.textoDeEscalado
      || 'Permíteme un momento, te paso con alguien del equipo para atenderte bien.',
    { handoffPendiente: !entregado, pendiente: null, escalando: true, motivoHandoff: motivo });
  };

  const cerrar = (motivoCierre, texto, extra = null) => {
    if (!respuestaDeSistema) cerrarEleccionTrasTexto({estado,catalogo,operaciones});
    let pedido = ejecutor.vista();
    let tipo = 'informacion';
    let huella = null;
    const enCurso = !Object.values(estado.hechos || {}).some(Boolean) && !estado.evento;
    // Solo una oferta de producto NUEVO puede interrumpir la pregunta del
    // carrito. Buscar un artículo ya agregado (incluso si su re-adición fue
    // rechazada) no permite publicar otra pregunta y borrar la pendiente.
    const ofertaNuevaSinCambio = operaciones.some((o) => o.herramienta === 'buscar_producto')
      && !operaciones.some((o) => tieneEfecto(o.herramienta))
      && ofertaDeProductoDelModelo(texto);
    let extraCierre = extra;
    if (extra?.redaccionModelo && !politica.soloLectura && pedido.lineas.length && enCurso && !ofertaNuevaSinCambio) {
      // Pedido en curso: la prosa del modelo NO sale. Sale el estado.
      const canonica = respuestaCanonica({ estado, pedido, modalidades, metodosPago, requierePago, zonaDelNegocio });
      texto = canonica.texto; tipo = canonica.tipo; huella = canonica.huella;
      if (tipo !== 'resumen' && !preguntaDePedidoMultiple(pedido)
        && operaciones.some((o) => tieneEfecto(o.herramienta) && o.resultado?.aplicado)) {
        texto = `En tu borrador: ${pedido.lineas.map((l) => `${l.cantidad} × ${l.producto}`).join(', ')}.\n${texto}`;
      }
      extraCierre = { ...(extra || {}), redaccionModelo: false, derivado: true };
    } else if (enCurso && String(texto).endsWith('¿Confirmas este pedido?')
      && !(extra && Object.hasOwn(extra, 'pendiente'))) {
      tipo = 'resumen'; huella = pedido.huella;
    }

    const candidato = enCurso ? pendienteDelCierre({ texto, tipo, huella, pedido, extra: extraCierre }) : null;
    const previo = estado.pendiente;
    // Una respuesta que da Xabor con sus datos (consulta de promociones,
    // horario, cancelación de catering) NO es el bot sin entender al cliente:
    // el cliente preguntó y se le contestó. No cuenta como repregunta. Si
    // contara, a la tercera consulta saldría «te paso con alguien» desde un
    // atajo que no tiene a quién avisar: una persona prometida que nadie recibe.
    const deSistema = !!extra?.respuestaDeSistema;
    fijarPendiente(estado, candidato, { avance: huboAvance() || deSistema });
    // ── AMBIGÜEDAD PERSISTENTE ──────────────────────────────────────────
    // La MISMA pregunta repetida sin ningún avance es un cliente al que el
    // bot no está entendiendo. A la tercera, una persona: sin improvisar más.
    if (!extra?.escalando && !deSistema && estado.pendiente
      && Number(estado.pendiente.intentos) >= LIMITE_REPREGUNTAS) {
      const tipoPendiente = estado.pendiente.tipo;
      estado.pendiente = previo;
      return { escalarPorAmbiguedad: true, tipoPendiente };
    }
    if (esPrimerTurno && enCurso && !extra?.sinSaludo
      && !/\b(?:hola|bienvenid[oa]s?|buen(?:os)? d[ií]as?|buenas tardes|buenas noches)\b/i.test(texto)) {
      texto = `${saludoDelNegocio({ reglas, zonaDelNegocio, inicio: false })} ${texto}`;
    }
    ejecutor.cerrarTurno();
    pedido = ejecutor.vista();
    estado.fase = derivarFase(estado, pedido);
    if (!erroresProveedor.length && llamadasAlModelo > 0) estado.fallosProveedor = 0;
    const dialogoId = guardarDialogo(estado, { mensaje, texto: String(texto || '').trim(), tipo, huella });
    return {
      texto: String(texto || '').trim(),
      dialogoId,
      motivoCierre,
      pedido,
      estado,
      operaciones,
      iteraciones,
      llamadasAlModelo,
      modeloMs,herramientasMs,modeloIntentos,
      tipoTurno: politica.tipo,
      recuperacionesModelo,
      mutaciones,
      erroresProveedor,
      duracionMs: Date.now() - t0,
      confirmado: !!estado.hechos.confirmado,
      escalado: !!estado.hechos.escalado,
      folio: estado.folio ?? null,
      // Por omisión el turno no debe nada: solo `escalarYSalir` lo levanta.
      handoffPendiente: false,
      ...(extra || {}),
      pendiente: estado.pendiente,
    };
  };

  const puedeRetomarInterpretacion = () => !estado.confirmacionIncierta && !estado.folio && !estado.evento
    && !Object.values(estado.hechos || {}).some(Boolean)
    && !operaciones.some((o) => ['confirmar_pedido', 'cancelar_pedido', 'pedir_humano',
      'enviar_menu', 'registrar_solicitud_evento'].includes(o.herramienta));
  const retomarInterpretacion = (motivo = 'timeout_interpretacion') => {
    estado.turnoPendiente = { mensaje, motivo };
    const pedido = ejecutor.vista();
    if (!pedido.lineas.length) {
      return cerrar(CIERRE.RESPONDIO, 'Disculpa la demora. No pude completar tu último mensaje. '
        + 'Por favor, vuelve a decirme qué deseas pedir.', { recuperacion: 'fallo_proveedor_sin_efectos', pendiente: null });
    }
    const avance = respuestaDeAvance({ estado, pedido, modalidades, metodosPago, requierePago });
    return cerrar(CIERRE.RESPONDIO, `Disculpa la demora. No pude completar tu último mensaje. ${avance}`,
      { recuperacion: 'fallo_proveedor_sin_efectos', derivado: true });
  };
  // Un fallo del proveedor no es un pedido estropeado: se responde desde el
  // estado. Solo si se repite, una persona.
  const recuperarDeFalloDelProveedor = async (motivo) => {
    estado.fallosProveedor = (Number(estado.fallosProveedor) || 0) + 1;
    erroresProveedor.push({ motivo: String(motivo).slice(0, 120) });
    if (estado.fallosProveedor >= LIMITE_FALLOS_PROVEEDOR) {
      estado.fallosProveedor = 0;
      return await escalarYSalir(CIERRE.ERROR, `fallo_proveedor_persistente: ${String(motivo).slice(0, 80)}`);
    }
    return retomarInterpretacion(motivo);
  };

  // ¿Se puede sustituir una redacción insegura por texto del estado? No si el
  // turno ya está en manos de una persona o si un efecto externo del turno
  // falló: ahí el cierre honesto es el escalado.
  const puedeSustituirRedaccion = () => !estado.confirmacionIncierta && !estado.hechos.fallido
    && !estado.hechos.escalado && !estado.evento
    && !operaciones.some((o) => esEfectoExterno(o.herramienta) && o.resultado?.aplicado !== true);
  const respuestaSegura = () => (politica.soloLectura
    ? { texto: respuestaDeConsulta(operaciones), extra: { pendiente: null } }
    : { texto: respuestaDesdePedido({
      estado, pedido: ejecutor.vista(), modalidades, metodosPago, requierePago, zonaDelNegocio,
    }), extra: { derivado: true } });

  const cuerpo = async () => {
    // ── RESPUESTA DE SISTEMA ──────────────────────────────────────────────
    // Xabor contesta con sus propios datos. Sus acciones pasan por el mismo
    // circuito (esquema, legalidad, ejecutor, traza) y el pendiente que dejen
    // lo fija el cierre, como cualquier otro.
    if (respuestaDeSistema) {
      let pendienteSistema = respuestaDeSistema.pendiente || null;
      for (const accion of (respuestaDeSistema.acciones || [])) {
        const r = await ejecutarDeterminista(accion);
        if (r?.aplicado && r.pendiente) pendienteSistema = r.pendiente;
      }
      if (respuestaDeSistema.cerrarGrupo || respuestaDeSistema.edicionGrupo) {
        const c = respuestaDeSistema.cerrarGrupo || respuestaDeSistema.edicionGrupo;
        const reales = ejecutor.vista().lineas.find(l => l.linea_id === c.linea_id)?.opciones
          .filter(o => o.grupo === c.grupo).map(o => o.opcion).sort();
        if (JSON.stringify(reales) === JSON.stringify([...c.valores].sort())) {
          if (respuestaDeSistema.cerrarGrupo) delete estado.eleccionInteractiva;
          else estado.eleccionInteractiva = {...estado.eleccionInteractiva,id:c.id,editando:false};
        }
      }
      const textoSistema = respuestaDeSistema.desdePedido
        ? `${respuestaDeSistema.texto || ''}${respuestaDesdePedido({ estado, pedido: ejecutor.vista(), modalidades, metodosPago, requierePago, zonaDelNegocio })}`
        : respuestaDeSistema.texto;
      return cerrar(CIERRE.RESPONDIO, textoSistema,
        { respuestaDeSistema: respuestaDeSistema.tipo || true,
          ...(['texto_grupo_abierto','boton_eleccion'].includes(respuestaDeSistema.tipo)
            && respuestaDeSistema.texto ? { avisoEleccion: respuestaDeSistema.texto } : {}),
          ...(respuestaDeSistema.desdePedido ? { derivado: true } : { pendiente: pendienteSistema }),
          sinSaludo: respuestaDeSistema.sinSaludo === true });
    }

    const cortesia=cortesiaPostPedido({estado,mensaje});
    if(cortesia)return cerrar(CIERRE.RESPONDIO,cortesia,
      {pendiente:null,sinSaludo:true,continuidadDeterminista:true,recuperacion:'cortesia_sin_hechos_operativos'});

    // Cancelar el borrador completo tiene autorización textual verificable.
    // No depende del modelo; conserva el ejecutor, la legalidad y la auditoría.
    if (!estado.folio && !estado.evento && puedeRecuperarSinEfectos(estado) && autorizaCancelacion(mensaje)) {
      const r = await ejecutarDeterminista({herramienta:'cancelar_pedido',
        argumentos:{motivo:'El cliente pidió cancelar el borrador completo'},motivo:'cancelacion_total_explicita'});
      if (r?.aplicado && estado.hechos.cancelado) return cerrar(CIERRE.RESPONDIO,
        'Tu borrador fue cancelado. Con gusto te ayudamos si deseas hacer un nuevo pedido.',
        {pendiente:null,continuidadDeterminista:true,sinSaludo:true});
    }

    // Saludar no modifica un pedido ni necesita una interpretación generativa.
    // Se conserva el borrador y se pide el dato real que sigue pendiente.
    if (esSaludoSolo(mensaje) && puedeRecuperarSinEfectos(estado)) {
      const pedido = ejecutor.vista();
      const inicio = !pedido.lineas.length && !estado.programacionRequerida;
      const saludo = saludoDelNegocio({ reglas, zonaDelNegocio, inicio });
      if (inicio) return cerrar(CIERRE.RESPONDIO, saludo, { recuperacion: 'saludo_desde_estado', pendiente: null });
      return cerrar(CIERRE.RESPONDIO, `${saludo} ${respuestaDesdePedido({
        estado, pedido: ejecutor.vista(), modalidades, metodosPago, requierePago, zonaDelNegocio,
      })}`, { recuperacion: 'saludo_desde_estado', derivado: true });
    }

    if (pideAgregarOtro(estado, mensaje)) {
      return cerrar(CIERRE.RESPONDIO, '¿Qué te gustaría agregar? Conservo lo que ya elegiste.',
        { pendiente: { tipo: PENDIENTES.AGREGAR_OTRO }, continuidadDeterminista: true });
    }

    // Preferencias explícitas continúan una solicitud del cliente incluso si
    // llegaron antes del acuse. No son un «sí» que acepte una oferta no vista.
    const seleccion = resolverSeleccion({ estado, catalogo, mensaje });
    if (seleccion) {
      const { producto, ...argumentos } = seleccion;
      const r = await ejecutarDeterminista({ herramienta: 'agregar_producto', argumentos,
        autorizacion: { tipo: 'seleccion_de_producto' }, motivo: 'seleccion_de_producto_persistida' });
      return cerrar(CIERRE.RESPONDIO, respuestaDesdePedido({
        estado, pedido: ejecutor.vista(), modalidades, metodosPago, requierePago, zonaDelNegocio,
      }), { continuidadDeterminista: true, derivado: true,
        ...(r?.aplicado ? {} : { pendiente: null }) });
    }
    const nuevaSeleccion = iniciarSeleccion({ estado, catalogo, mensaje });
    if (nuevaSeleccion) {
      return cerrar(CIERRE.RESPONDIO, preguntaDeSeleccion(nuevaSeleccion, catalogo),
        { continuidadDeterminista: true, pendiente: nuevaSeleccion });
    }
    // Una intención distinta o no resuelta no hereda permisos de una solicitud
    // abandonada. El historial sigue siendo contexto, nunca autorización.
    if (estado.pendiente?.tipo === PENDIENTES.ELEGIR_PRODUCTO) fijarPendiente(estado, null);

    // ── LA RESPUESTA CORTA A LA PREGUNTA PENDIENTE ──────────────────────
    //
    // Se lee contra `estado.pendiente` y nada más. Confirmar un resumen
    // enviado, aceptar el producto o la promoción que se ofreció, aceptar el
    // pago ofrecido, elegir modalidad o pago de la lista, o una opción por su
    // posición: todo sale del estado, sin el modelo, por el mismo ejecutor.
    const corta = interpretarRespuestaCorta({ estado, mensaje, modalidades, metodosPago });
    // Una respuesta corta escrita ANTES de que le llegara la pregunta
    // pendiente (el resumen, una oferta) no la contesta: el cliente aún no la
    // veía. No confirma ni acepta nada; se le muestra lo vigente para que lo
    // lea y conteste ahora.
    if (corta?.accion && escritoAntesDelAcuse(estado)) {
      anotar({ tipo: 'respuesta_anterior_al_acuse', herramienta: corta.accion.herramienta });
      // Volver a preguntar no es el cliente sin entender: no cuenta como
      // repregunta (no escala a una persona por esto).
      const vigente = estado.pendiente;
      if (vigente && vigente.tipo !== PENDIENTES.CONFIRMAR_RESUMEN && estado.dialogo?.texto) {
        // Una oferta o una pregunta de datos: se repite TAL CUAL, con la misma
        // pregunta pendiente, para que la conteste ahora que ya la ve.
        const { dialogo_id: _d, intentos: _i, turno: _t, ...pendienteVigente } = vigente;
        return cerrar(CIERRE.RESPONDIO, estado.dialogo.texto, { continuidadDeterminista: true,
          respuestaAnteriorAlAcuse: true, respuestaDeSistema: 'anterior_al_acuse', sinSaludo: true,
          pendiente: pendienteVigente });
      }
      // El resumen se vuelve a armar desde el estado (misma huella si nada cambió).
      return cerrar(CIERRE.RESPONDIO, respuestaDesdePedido({
        estado, pedido: ejecutor.vista(), modalidades, metodosPago, requierePago, zonaDelNegocio,
      }), { continuidadDeterminista: true, respuestaAnteriorAlAcuse: true, derivado: true,
        respuestaDeSistema: 'anterior_al_acuse', sinSaludo: true });
    }
    if (corta?.accion) {
      const accion = corta.accion;
      let clave = null;
      if (accion.opcionAceptada) {
        clave = claveEvidenciaOpcion(accion.opcionAceptada);
        opcionesAceptadas.push(clave);
      }
      const r = await ejecutarDeterminista(accion);
      if (!r?.aplicado && clave) {
        const i = opcionesAceptadas.lastIndexOf(clave);
        if (i >= 0) opcionesAceptadas.splice(i, 1);
      }
      if (accion.herramienta === 'confirmar_pedido') {
        if (r?.aplicado) {
          const folio = r.folio ?? estado.folio ?? null;
          return cerrar(CIERRE.RESPONDIO,
            folio ? `Tu pedido ${folio} quedó registrado.` : 'Tu pedido quedó registrado.',
            { continuidadDeterminista: true, confirmacionDeterminista: true, pendiente: null });
        }
        if (r?.estado === 'incierta' || estado.confirmacionIncierta) {
          return cerrar(CIERRE.RESPONDIO,
            'Estoy revisando tu pedido con el equipo para evitar registrarlo dos veces. Te responderemos en breve.',
            { continuidadDeterminista: true, pendiente: null });
        }
        // Rechazada (el pedido cambió, el total canónico cambió, falta un
        // dato): se vuelve a mostrar lo que hay, con su huella nueva.
        return cerrar(CIERRE.RESPONDIO, respuestaDesdePedido({
          estado, pedido: ejecutor.vista(), modalidades, metodosPago, requierePago, zonaDelNegocio,
        }), { continuidadDeterminista: true, confirmacionRechazada: true, derivado: true });
      }
      if (r?.aplicado) {
        return cerrar(CIERRE.RESPONDIO, respuestaDesdePedido({
          estado, pedido: ejecutor.vista(), modalidades, metodosPago, requierePago, zonaDelNegocio,
        }), { continuidadDeterminista: true, derivado: true });
      }
      // La aceptación no se pudo aplicar (por ejemplo, ya no hay existencia).
      // Se dice y se sigue con el estado real, sin inventar nada.
      const producto = accion.autorizacion?.producto;
      return cerrar(CIERRE.RESPONDIO, `${producto ? `No pude agregar ${producto}. ` : ''}${respuestaDesdePedido({
        estado, pedido: ejecutor.vista(), modalidades, metodosPago, requierePago, zonaDelNegocio,
      })}`, { continuidadDeterminista: true, derivado: true });
    }
    if (corta?.rechazo) {
      if (corta.rechazo === 'resumen') {
        return cerrar(CIERRE.RESPONDIO, '¿Qué te gustaría cambiar de tu pedido?',
          { continuidadDeterminista: true, pendiente: null });
      }
      return cerrar(CIERRE.RESPONDIO, `${TEXTO_RECHAZO[corta.rechazo] || 'Entendido.'} ${respuestaDesdePedido({
        estado, pedido: ejecutor.vista(), modalidades, metodosPago, requierePago, zonaDelNegocio,
      })}`, { continuidadDeterminista: true, derivado: true });
    }

    // ── CONTINUIDAD DETERMINISTA DE OPCIONES ────────────────────────────
    //
    // Las respuestas cortas a una pregunta de opción no requieren que el
    // modelo recuerde el turno anterior. Se traducen a llamadas normales y
    // pasan por las mismas validaciones, reconciliador y libro de operaciones.
    let huboCambioDeterminista = false;
    let varianteAplicada = false;
    const variante = varianteDelPedido({ estado, catalogo, mensaje });
    if (variante) {
      const r = await ejecutarDeterminista({ herramienta: 'modificar_linea',
        argumentos: { linea_id: variante.item.lid, reclasificar: true }, motivo: 'variante_del_catalogo' });
      huboCambioDeterminista ||= !!r?.aplicado;
      varianteAplicada = !!r?.aplicado;
    }
    // Las elecciones previas a «y agrega…» pueden completar el foco; las
    // preferencias del producto nuevo las interpreta el modelo junto a él.
    const inicioAdicion = String(mensaje).search(/\b(?:agrega|agregame|agreguen|a[ñn]ade|a[ñn]ademe)\b/i);
    const mensajeContinuacion = inicioAdicion < 0 ? mensaje : String(mensaje).slice(0, inicioAdicion);
    const resolucion = accionesParaOpcionesPendientes({
      estado, pedido: ejecutor.vista(), catalogo, mensaje: mensajeContinuacion,
    });
    const mismaAclaracion = (a, b) => a.lid === b.lid && a.grupo === b.grupo
      && a.candidatos.slice().sort().join('|') === b.candidatos.slice().sort().join('|');
    estado.opcionesPendientes = (estado.opcionesPendientes || []).filter((p) =>
      !resolucion.descartadas.some((d) => mismaAclaracion(p, d)));
    huboCambioDeterminista ||= resolucion.descartadas.length > 0;
    for (const pendiente of resolucion.ambiguas) {
      estado.opcionesPendientes = (estado.opcionesPendientes || []).filter((p) =>
        !mismaAclaracion(p, pendiente));
      estado.opcionesPendientes.push({ ...pendiente, tipo: 'eleccion_ambigua' });
    }
    for (const accion of resolucion.acciones) {
      let clave = null;
      if (accion.opcionAceptada) {
        clave = claveEvidenciaOpcion(accion.opcionAceptada);
        opcionesAceptadas.push(clave);
      }
      const r = await ejecutarDeterminista(accion);
      if (!r?.aplicado && clave) {
        const i = opcionesAceptadas.lastIndexOf(clave);
        if (i >= 0) opcionesAceptadas.splice(i, 1);
      }
      huboCambioDeterminista = huboCambioDeterminista || !!r?.aplicado;
    }

    cerrarEleccionTrasTexto({estado,catalogo,operaciones});
    const pedidoDespues = ejecutor.vista();
    const pregunta = siguientePreguntaDelPedido({
      pedido: pedidoDespues, modalidades, metodosPago, requierePago,
    });
    const vocabularioElegido = [...[...pedidoDespues.aclaraciones, ...resolucion.descartadas]
      .flatMap((a) => a.candidatos || []), ...(variante ? [variante.producto.nombre] : [])];

    // Una lista de elecciones que sirve para varios grupos no necesita prosa
    // del modelo para explicar la ambigüedad. No se asignan opciones ni extras
    // por orden de mención: se pregunta por un grupo real y se persiste ese foco.
    const compartida = resolucion.requiereInterpretacion
      && soloElecciones(mensaje, resolucion.acciones, vocabularioElegido)
      && preguntaPorOpcionesCompartidas({ estado, pedido: pedidoDespues, mensaje });
    if (compartida) {
      estado.foco = compartida.foco;
      return cerrar(CIERRE.RESPONDIO, compartida.texto,
        { continuidadDeterminista: true, opcionAmbigua: true, derivado: true });
    }

    if (varianteAplicada && (variante.soloOpciones || soloElecciones(
      String(mensaje).replace(/\b(?:son|las dos|los dos|ambas|ambos)\b/gi, ' '),
      [{ argumentos: { opciones: variante.opciones } }], vocabularioElegido))) {
      const siguiente = respuestaDesdePedido({
        estado, pedido: pedidoDespues, modalidades, metodosPago, requierePago, zonaDelNegocio,
      });
      const linea = pedidoDespues.lineas.find(l => l.linea_id === variante.item.lid);
      const detalle = linea.opciones.map(o => o.opcion).join(', ');
      const precio = Number.isFinite(linea.precio_unitario) ? `: $${linea.precio_unitario} c/u` : '';
      const texto = pregunta
        ? `Actualicé tu pedido: ${linea.cantidad} × ${linea.producto}${detalle ? ` (${detalle})` : ''}${precio}.\n${siguiente}`
        : siguiente;
      return cerrar(CIERRE.RESPONDIO, texto, { continuidadDeterminista: true, derivado: true });
    }

    if (resolucion.ambiguas.length && pregunta && !resolucion.requiereInterpretacion
      && soloElecciones(mensaje, resolucion.acciones, vocabularioElegido)) {
      estado.foco = pregunta.foco;
      return cerrar(CIERRE.RESPONDIO, pregunta.texto,
        { continuidadDeterminista: true, opcionAmbigua: true, derivado: true });
    }

    if (huboCambioDeterminista && !resolucion.requiereInterpretacion
      && soloElecciones(mensaje, resolucion.acciones, vocabularioElegido)) {
      // La última elección tampoco necesita otra llamada al proveedor para
      // redactar un resumen que Xabor ya puede construir íntegramente.
      return cerrar(CIERRE.RESPONDIO, respuestaDesdePedido({
        estado,pedido:pedidoDespues,modalidades,metodosPago,requierePago,zonaDelNegocio,
      }), { continuidadDeterminista: true, derivado: true });
    }

    const grupoAjeno = grupoExplicitoNoAplicable({ pedido: pedidoDespues, catalogo, mensaje });
    if (grupoAjeno && pregunta) {
      estado.foco = pregunta.foco;
      return cerrar(CIERRE.RESPONDIO,
        `${grupoAjeno.producto} no tiene ${grupoAjeno.grupo} como elección. ${pregunta.texto}`,
        { continuidadDeterminista: true, derivado: true });
    }

    // Si una acción determinista completó todas las opciones, el modelo sigue
    // con modalidad, pago o resumen. Su prompt debe leer la vista actualizada.
    instrucciones = instruccionesDelTurno();

    while (iteraciones < topeIteraciones) {
      if (Date.now() - t0 > topeMs) {
        return puedeRetomarInterpretacion()
          ? retomarInterpretacion('tiempo_del_turno') : await escalarYSalir(CIERRE.TIEMPO, 'el turno tardó demasiado');
      }
      iteraciones += 1;

      const t1 = Date.now();
      esperandoModelo = true;
      modeloIntentos+=1;
      let respuesta;
      try {respuesta = await llamarModelo({
        model: modelo,
        max_tokens: recuperacionesModelo ? Math.min(maxTokens * 2, 4096) : maxTokens,
        system: instrucciones,
        tools: herramientas,
        messages: mensajes,
      });} finally {modeloMs+=Date.now()-t1;}
      esperandoModelo = false;
      // Un `tool_use` cortado por límite de tokens no es una instrucción. La
      // metadata del proveedor se comprueba antes incluso de enumerar llamadas:
      // así ninguna herramienta —en especial confirmar_pedido— puede ejecutar
      // efectos a partir de una respuesta parcial.
      llamadasAlModelo += 1;
      if (diagnosticarRespuestaTruncada(respuesta, textoDe(respuesta)).truncada
        && respuesta?.stop_reason === 'max_tokens' && recuperacionesModelo === 0
        && !estado.confirmacionIncierta && !Object.values(estado.hechos || {}).some(Boolean)
        && iteraciones < topeIteraciones && Date.now() - t0 < topeMs) {
        // Ninguna llamada de este paquete se ha ejecutado. Se repite SOLO
        // esta solicitud, conservando los resultados anteriores y el libro.
        recuperacionesModelo += 1;
        anotar({ tipo: 'respuesta_reintentada', motivo: 'max_tokens_sin_ejecucion' });
        continue;
      }
      exigirRespuestaCompleta(respuesta, textoDe(respuesta));
      anotar({ tipo: 'modelo', iteracion: iteraciones, ms: Date.now() - t1,
        stop_reason: respuesta?.stop_reason, uso: respuesta?.usage ?? null });

      const llamadas = llamadasDe(respuesta);

      if (!llamadas.length) {
        const texto = textoDe(respuesta);
        if (!texto) {
          // Ni herramientas ni texto: es un fallo del proveedor, no del
          // pedido. Se responde desde el estado.
          if (puedeRetomarInterpretacion()) return await recuperarDeFalloDelProveedor('respuesta_vacia');
          return await escalarYSalir(CIERRE.ERROR, 'el modelo no produjo respuesta');
        }
        // Tras confirmar, el modelo tampoco es fuente de estados operativos.
        // Primero se ejecutaron sus herramientas: los cambios/handoff siguen
        // sus barreras. Las consultas de catálogo usan resultados, no prosa.
        if(estado.hechos.confirmado && estado.folio && !estado.confirmacionIncierta
          && !estado.hechos.escalado && !estado.hechos.cancelado && !estado.hechos.fallido) {
          const consultaProducto=operaciones.some(o=>o.herramienta==='buscar_producto' && o.resultado?.aplicado);
          const actual=consultaProducto?null:await contexto.resolverEstadoOperativo?.(estado.folio);
          return cerrar(CIERRE.RESPONDIO,consultaProducto?respuestaDeConsulta(operaciones)
            :respuestaOperativaVerificada(estado,actual),
          {pendiente:null,sinSaludo:true,recuperacion:'estado_operativo_verificado'});
        }
        // ── EMISIÓN SEGURA ─────────────────────────────────────────────
        const revision = revisarRedaccion({
          texto, estado, pedido: ejecutor.vista(), catalogo, nombresOcultos, reglas,
          promociones: contexto.promocionesInformativas || [],
        });
        if (!revision.ok) {
          anotar({ tipo: 'redaccion_sustituida', motivo: revision.motivo });
          if (puedeSustituirRedaccion()) {
            const segura = respuestaSegura();
            return cerrar(CIERRE.RESPONDIO, segura.texto,
              { ...segura.extra, recuperacion: `redaccion_sustituida:${revision.motivo}` });
          }
          // Captura de un evento: la prosa del modelo nunca sale —el canal la
          // sustituye por la siguiente pregunta de captura
          // (`aplicarSalidaSeguraDeCatering`)—. Aquí solo se retira el texto
          // inseguro; escalar cortaría una captura que puede seguir.
          if (estado.evento && !estado.hechos.escalado && !estado.confirmacionIncierta) {
            return cerrar(CIERRE.RESPONDIO, TEXTO_CAPTURA_DE_EVENTO,
              { pendiente: null, recuperacion: `redaccion_sustituida:${revision.motivo}` });
          }
          return await escalarYSalir(CIERRE.ERROR, `redaccion_insegura:${revision.motivo}`);
        }
        const prohibida = respuestaProhibidaEncontrada(texto, reglas);
        if (prohibida) {
          anotar({ tipo: 'respuesta_prohibida', frase: prohibida });
          return await escalarYSalir(CIERRE.ESCALADO,
            `la respuesta del modelo contiene una frase prohibida por el negocio: ${prohibida}`);
        }
        if (respuestaAfirmaCambioSinAplicar({ texto, operaciones })
          && puedeRecuperarSinEfectos(estado, operaciones)) {
          anotar({ tipo: 'redaccion_recuperada', motivo: 'afirmacion_sin_efectos' });
          const segura = respuestaSegura();
          return cerrar(CIERRE.RESPONDIO, segura.texto, { ...segura.extra, recuperacion: 'afirmacion_sin_efectos' });
        }
        // ── LA OFERTA DE UNA FORMA DE PAGO LA HACE XABOR ────────────────
        // Si Xabor rechazó la forma de pago y calculó una alternativa (por
        // ejemplo, enlace en lugar de transferencia), la oferta se dice con
        // texto del backend y queda como pregunta pendiente estructurada: un
        // «sí» la acepta sin depender de cómo la haya redactado el modelo.
        const rechazoConAlternativa = [...operaciones].reverse().find((o) => o.herramienta === 'definir_pago'
          && o.resultado?.aplicado === false && o.resultado?.alternativa_tipo);
        if (rechazoConAlternativa && !estado.carrito?.datos?.forma_pago) {
          return cerrar(CIERRE.RESPONDIO, textoOfertaDePago(rechazoConAlternativa.resultado), {
            ofertaDePago: true,
            pendiente: { tipo: PENDIENTES.ACEPTAR_PAGO_OFRECIDO, forma_pago: rechazoConAlternativa.resultado.alternativa_tipo },
          });
        }
        return cerrar(CIERRE.RESPONDIO, texto, { redaccionModelo: true });
      }

      // El texto que venga junto a las llamadas NO se usa: está escrito antes
      // de saber qué pasó. Ver la cabecera del archivo.
      mensajes.push({ role: 'assistant', content: respuesta.content });

      const resultados = [];
      for (const llamada of llamadas) {
        // Las acciones de SISTEMA existen solo para Xabor: un `tool_use` con
        // uno de esos nombres es una herramienta desconocida para el modelo.
        const r = esAccionDeSistema(llamada.name)
          ? { resultado: { aplicado: false, estado: 'ilegal', motivo: `herramienta_desconocida: ${llamada.name}` },
            repetida: false, conto: false }
          : await medirHerramienta(()=>ejecutarLlamada({
            llamada, ejecutor, libro, estado, negocioId, conversacionId, turnoId, modo,
            permitirMutacion: () => mutaciones < topeMutaciones,
            // El ordinal de ESTA acción dentro del turno. Ver la cabecera del
            // libro de operaciones: es lo que separa «el cliente pidió dos» de
            // «esto es un reintento del mismo turno».
            ocurrenciaDe,
          }));
        if (r.conto) mutaciones += 1;
        operaciones.push({
          herramienta: llamada.name, argumentos: llamada.input,
          tool_call_id: llamada.id, resultado: r.resultado, repetida: r.repetida, origen: 'modelo',
        });
        anotar({ tipo: 'herramienta', herramienta: llamada.name, argumentos: llamada.input,
          aplicado: !!r.resultado?.aplicado, motivo: r.resultado?.motivo ?? null, repetida: !!r.repetida });
        resultados.push({
          type: 'tool_result',
          tool_use_id: llamada.id,
          is_error: r.resultado?.aplicado === false && r.resultado?.estado === 'ilegal',
          // La operación y la traza conservan el resultado real arriba. Solo
          // el contexto que puede acabar redactado pasa por esta copia segura.
          content: JSON.stringify(resultadoParaModelo(r.resultado)),
        });
      }
      mensajes.push({ role: 'user', content: resultados });

      // La siguiente vuelta debe ver el estado que dejaron las herramientas.
      instrucciones = instruccionesDelTurno();

      // Escalar o cancelar cierra el turno: cualquier iteración más hablaría
      // de un pedido que ya no está en manos del bot.
      if (estado.hechos.escalado) {
        const texto = contexto.textoDeEscalado
          || 'Te paso con alguien del equipo para que te atienda mejor. Un momento, por favor.';
        return cerrar(CIERRE.ESCALADO, texto, { pendiente: null, motivoHandoff: estado.motivoEscalado || null });
      }
      if (estado.hechos.cancelado) {
        return cerrar(CIERRE.RESPONDIO, 'Tu borrador fue cancelado. Con gusto te ayudamos si deseas hacer un nuevo pedido.',
          { pendiente: null });
      }
      // Una opción sin evidencia no se adivina ni se reintenta seis veces.
      // Conserva las elecciones verificadas y pide completar lo que falta.
      if (!politica.soloLectura && puedeSustituirRedaccion() && !estado.hechos.confirmado
        && ejecutor.vista().aclaraciones?.length
        && operaciones.some(o=>o.herramienta==='modificar_linea'
          && o.resultado?.aplicado===false && /^el_cliente_no_lo_dijo:/.test(o.resultado.motivo || ''))) {
        const segura=respuestaSegura();
        return cerrar(CIERRE.RESPONDIO,segura.texto,
          {...segura.extra,recuperacion:'eleccion_sin_evidencia_pedir_aclaracion'});
      }
      if (mutaciones >= topeMutaciones) {
        return await escalarYSalir(CIERRE.TOPE_MUTACIONES, 'demasiados cambios en un solo turno');
      }
    }

    if (!politica.soloLectura && puedeCerrarConAvance(estado, operaciones)) {
      const texto = respuestaDeAvance({ estado, pedido: ejecutor.vista(), modalidades, metodosPago, requierePago });
      if (revisarRedaccion({ texto, estado, pedido: ejecutor.vista(), catalogo }).ok
        && !respuestaProhibidaEncontrada(texto, reglas)) {
        anotar({ tipo: 'redaccion_recuperada', motivo: 'presupuesto_con_avance_verificado' });
        return cerrar(CIERRE.RESPONDIO, texto, { recuperacion: 'presupuesto_con_avance_verificado', derivado: true });
      }
    }
    return await escalarYSalir(CIERRE.SIN_ITERACIONES, 'el turno no llegó a una respuesta');
  };

  // Ocurrencias por contenido, compartidas entre acciones deterministas y del
  // modelo: dos «agregar el mismo bowl» del MISMO turno son dos operaciones.
  function ocurrenciaDe(herramienta, hash) {
    const clave = `${herramienta}|${hash}`;
    const n = (ocurrencias.get(clave) || 0) + 1;
    ocurrencias.set(clave, n);
    return n;
  }

  let ordinalDeterminista = 0;
  async function ejecutarDeterminista(accion) {
    ordinalDeterminista += 1;
    const llamada = {
      id: `det-${turnoId || estado.turno}-${ordinalDeterminista}`,
      name: accion.herramienta,
      input: accion.argumentos,
    };
    const r = await medirHerramienta(()=>ejecutarLlamada({
      llamada, ejecutor, libro, estado, negocioId, conversacionId, turnoId, modo,
      permitirMutacion: () => mutaciones < topeMutaciones,
      ocurrenciaDe,
      autorizacion: accion.autorizacion || null,
    }));
    if (r.conto) mutaciones += 1;
    operaciones.push({
      herramienta: llamada.name, argumentos: llamada.input,
      tool_call_id: llamada.id, resultado: r.resultado, repetida: r.repetida,
      determinista: true, motivo: accion.motivo,
      origen: esAccionDeSistema(llamada.name) ? 'sistema' : 'determinista',
    });
    anotar({ tipo: 'herramienta_determinista', herramienta: llamada.name,
      aplicado: !!r.resultado?.aplicado, motivo: accion.motivo });
    return r.resultado;
  }

  let salida;
  try {
    salida = await cuerpo();
    if (salida?.escalarPorAmbiguedad) {
      salida = await escalarYSalir(CIERRE.ESCALADO, `ambiguedad_persistente:${salida.tipoPendiente}`);
    }
    return salida;
  } catch (e) {
    anotar({ tipo: 'error', mensaje: String(e?.message || e) });
    // Un fallo del PROVEEDOR —el que ocurre DURANTE la llamada al modelo
    // (timeout, 5xx, saturación, red) o una respuesta truncada— no marca el
    // pedido como fallido: se responde desde el estado y, si se repite, pasa a
    // una persona. Un error de Xabor o de una herramienta (la base al
    // registrar, por ejemplo) sí marca FALLIDO: ahí puede haber efectos.
    const delProveedor = esperandoModelo || e?.codigo === 'RESPUESTA_MODELO_TRUNCADA';
    if (delProveedor && puedeRetomarInterpretacion()) {
      const r = await recuperarDeFalloDelProveedor(`${e?.codigo || e?.status || e?.name || 'proveedor'}`);
      return r?.escalarPorAmbiguedad ? await escalarYSalir(CIERRE.ESCALADO, 'ambiguedad_persistente') : r;
    }
    estado.hechos.fallido = true;
    estado.terminadoEn = new Date().toISOString();
    // Marcado FALLIDO, ninguna mutación es legal ya: lo que quede del pedido
    // se queda como está y lo recoge una persona.
    const r = await escalarYSalir(CIERRE.ERROR, `excepción: ${String(e?.message || e).slice(0, 200)}`);
    return { ...r, error: String(e?.message || e) };
  }
}

/**
 * Una llamada: validar -> (libro si muta) -> ejecutar.
 *
 * El libro envuelve SOLO las herramientas con efecto. Las de lectura no se
 * deduplican a propósito: `ver_pedido` tiene que poder contestar dos veces en
 * el mismo turno y contestar distinto si algo cambió en medio — que es
 * exactamente lo que hace falta después de una mutación.
 *
 * `autorizacion` es la evidencia estructurada de una respuesta corta (ver
 * `respuestaCorta.js`). Solo la pasan las acciones deterministas.
 */
async function ejecutarLlamada({ llamada, ejecutor, libro, estado, negocioId, conversacionId, turnoId, modo,
  permitirMutacion, ocurrenciaDe, autorizacion = null }) {
  const v = validarArgumentos(llamada.name, llamada.input);
  if (!v.ok) {
    return { resultado: { aplicado: false, estado: 'ilegal', motivo: v.error }, repetida: false, conto: false };
  }

  if (!tieneEfecto(llamada.name)) {
    return { resultado: await ejecutor.ejecutar(llamada.name, v.valor, { autorizacion }), repetida: false, conto: false };
  }

  if (!permitirMutacion()) {
    return { resultado: { aplicado: false, estado: 'ilegal',
      motivo: 'tope_de_cambios: demasiados cambios en este turno. Resume lo que hay y pregúntale al cliente.' },
    repetida: false, conto: false };
  }

  if (!libro) {
    // Sin libro no hay idempotencia. Se permite solo porque las pruebas puras y
    // el replay no tienen base; en producción el llamador SIEMPRE inyecta uno,
    // y la sombra también, para poder medir repeticiones.
    return { resultado: await ejecutor.ejecutar(llamada.name, v.valor, { autorizacion }), repetida: false, conto: true };
  }

  const r = await libro.ejecutarUnaVez({
    negocioId, conversacionId, turnoId, toolCallId: llamada.id,
    herramienta: llamada.name, argumentos: v.valor, modo,
    ocurrencia: ocurrenciaDe ? ocurrenciaDe(llamada.name, hashDeArgumentos(v.valor)) : 1,
  }, async () => {
    const resultado = await ejecutor.ejecutar(llamada.name, v.valor, { autorizacion });
    return { aplicada: !!resultado.aplicado, estado: resultado.estado, resultado };
  });

  if (r.repetida) {
    if (llamada.name === 'confirmar_pedido' && r.aplicada && r.resultado?.folio) {
      // El pedido durable sobrevivió pero el estado pudo no guardarse.
      estado.hechos.confirmado = true;
      estado.terminadoEn = new Date().toISOString();
      estado.folio = r.resultado.folio;
    }
    // ── UNA CONFIRMACIÓN ANTERIOR SIN DESENLACE: conciliar, no suponer ─────
    // El libro dice que esta conversación ya intentó confirmar y no se sabe
    // cómo terminó. Antes de congelarla, se busca el pedido por la identidad
    // de la conversación: si existe, ese es el folio (uno solo) y la fila del
    // libro se cierra con él. Si no existe, sigue incierta y va a una persona.
    if (llamada.name === 'confirmar_pedido' && r.estado === 'incierta'
      && typeof ejecutor.conciliarConfirmacion === 'function') {
      const conciliada = await ejecutor.conciliarConfirmacion().catch(() => null);
      if (conciliada?.ok && conciliada.folio) {
        estado.hechos.confirmado = true;
        estado.terminadoEn = new Date().toISOString();
        estado.folio = conciliada.folio;
        estado.confirmacionIncierta = false;
        const resultado = { aplicado: true, estado: 'ok', folio: conciliada.folio, conciliado: true,
          ...(conciliada.total != null ? { total: conciliada.total } : {}) };
        await libro?.almacen?.cerrar?.(r.clave, { estado: 'ok', aplicada: true, resultado, error: null })
          .catch(() => {});
        return { resultado: { ...resultado, repetida: true }, repetida: true, conto: false };
      }
    }
    return {
      resultado: { ...(r.resultado || { aplicado: r.aplicada, estado: r.estado }),
        repetida: true,
        nota: 'Esta acción ya se había hecho en este turno. El pedido NO cambió de nuevo: '
          + 'no se lo anuncies al cliente dos veces.' },
      repetida: true, conto: false,
    };
  }
  return { resultado: r.resultado, repetida: false, conto: true };
}
