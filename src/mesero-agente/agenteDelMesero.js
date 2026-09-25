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
//     intentarlo y dicho después de que el reconciliador lo aceptara. La
//     divergencia entre lo que el bot dice y lo que el pedido tiene nace justo
//     ahí, y aquí no puede nacer.
//
//   Ninguna llamada se ejecuta sin validar su esquema.
//     Un esquema roto no tira el turno: vuelve como `tool_result` de error y
//     el modelo corrige. Un modelo que se equivoca no es un pedido estropeado.
//
//   Una mutación se aplica como mucho una vez.
//     El libro de operaciones, por clave de operación. Y hay un tope de
//     mutaciones por turno: un bucle del modelo no puede vaciar una carta
//     dentro del pedido de nadie.
//
//   El turno SIEMPRE termina con algo que decirle al cliente.
//     Si se agotan las iteraciones con avance comprobado de borrador, se
//     muestra ese avance sin dar por terminada la solicitud. Los errores y
//     efectos inciertos conservan el escalado a una persona.
import { definicionesParaElModelo, validarArgumentos, tieneEfecto } from './contratoDeHerramientas.js';
import { crearEjecutor } from './ejecutorDeHerramientas.js';
import { hashDeArgumentos } from './libroDeOperaciones.js';
import { construirInstrucciones } from './instrucciones.js';
import { respuestaProhibidaEncontrada } from './reglasDelAsistente.js';
import {
  accionParaOfertaAceptada, accionesParaOpcionesPendientes,
  siguientePreguntaDelPedido, grupoExplicitoNoAplicable,
} from './continuidadDeterminista.js';
import { claveEvidenciaOpcion } from '../orders/carritoDelPedido.js';
import { exigirRespuestaCompleta, diagnosticarRespuestaTruncada } from '../agent/respuestaTruncada.js';
import { detectarSalidaInterna } from './salidaPublicable.js';
import { respuestaAfirmaCambioSinAplicar } from './seguridadConversacional.js';
import { esSaludoSolo, puedeRecuperarSinEfectos, respuestaDesdePedido, saludoDelNegocio,
  puedeCerrarConAvance, respuestaDeAvance } from './recuperacionDelTurno.js';
import { politicaDelTurno, respuestaDeConsulta } from './politicaDelTurno.js';
import { varianteDelPedido } from './varianteDelPedido.js';

export const MODELO_POR_OMISION = 'claude-sonnet-5';

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

/**
 * ATIENDE UN TURNO.
 *
 * `llamarModelo` se inyecta siempre: en producción es el SDK de Anthropic, en
 * el replay es un guion, en la sombra es el mismo de producción. Que el bucle
 * no sepa cuál es lo hace probable sin red y sin coste.
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
} = {}) {
  if (typeof llamarModelo !== 'function') throw new Error('atenderTurnoConHerramientas necesita llamarModelo');
  if (!estado) throw new Error('atenderTurnoConHerramientas necesita el estado de la conversación');

  const t0 = Date.now();
  const operaciones = [];
  let mutaciones = 0;
  const ocurrencias = new Map();
  let iteraciones = 0;
  let llamadasAlModelo = 0;
  const opcionesAceptadas = [];
  const politica = politicaDelTurno(mensaje);
  let recuperacionesModelo = 0;

  const ejecutor = crearEjecutor({
    estado, catalogo, precios, requierePago, metodosPago, modalidades,
    reglas, configTienda, promocionesActivas, zonaDelNegocio,
    mensaje,
    textoCiclo: contexto.textoCiclo ?? mensaje,
    terminos: contexto.terminos ?? [],
    datoOperativoPendiente: contexto.datoOperativoPendiente ?? false,
    opcionesAceptadas,
    efectos,
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

  /**
   * Una salida de emergencia que SIEMPRE deja al cliente atendido.
   *
   * ── Y QUE COMPRUEBA LO QUE PROMETE ────────────────────────────────────
   *
   * El texto que sale de aquí dice «te paso con alguien del equipo». Si el
   * handoff no se aplicó, ese texto es una mentira, y la peor posible: el
   * cliente deja de insistir justo cuando nadie ha sido avisado. Pasó de
   * verdad —`pedir_humano` era ilegal desde FALLIDO, así que el `catch` de
   * abajo escalaba al vacío—, de modo que ya no se da por hecho: se mira si
   * el efecto ocurrió, se grita en el log si no, y se devuelve
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
    { handoffPendiente: !entregado });
  };

  const cerrar = (motivoCierre, texto, extra = null) => {
    ejecutor.cerrarTurno();
    const pedido = ejecutor.vista();
    // El foco se deriva del estado canónico. Permite interpretar una respuesta
    // binaria corta en el turno siguiente sin depender del historial del LLM.
    const pendiente = (pedido.aclaraciones || [])[0];
    if (pendiente) {
      estado.foco = { tipo: 'opcion', linea_id: pendiente.lid, grupo: pendiente.grupo };
    } else if (estado.foco?.tipo === 'opcion') {
      estado.foco = null;
    }
    return {
      texto: String(texto || '').trim(),
      motivoCierre,
      pedido,
      estado,
      operaciones,
      iteraciones,
      llamadasAlModelo,
      tipoTurno: politica.tipo,
      recuperacionesModelo,
      mutaciones,
      duracionMs: Date.now() - t0,
      confirmado: !!estado.hechos.confirmado,
      escalado: !!estado.hechos.escalado,
      folio: estado.folio ?? null,
      // Por omisión el turno no debe nada: solo `escalarYSalir` lo levanta.
      handoffPendiente: false,
      ...(extra || {}),
    };
  };

  try {
    // Saludar no modifica un pedido ni necesita una interpretación generativa.
    // Se conserva el borrador y se pide el dato real que sigue pendiente.
    if (esSaludoSolo(mensaje) && puedeRecuperarSinEfectos(estado)) {
      const pedido = ejecutor.vista();
      const inicio = !pedido.lineas.length && !estado.programacionRequerida;
      const saludo = saludoDelNegocio({ reglas, zonaDelNegocio, inicio });
      return cerrar(CIERRE.RESPONDIO, inicio ? saludo : `${saludo} ${respuestaDesdePedido({
        estado, pedido: ejecutor.vista(), modalidades, metodosPago, requierePago, zonaDelNegocio,
      })}`, { recuperacion: 'saludo_desde_estado' });
    }
    // ── CONTINUIDAD DETERMINISTA ENTRE MENSAJES ─────────────────────────
    //
    // Las respuestas cortas a una pregunta cerrada no requieren que el
    // modelo recuerde el turno anterior. Se traducen a llamadas normales y
    // pasan por las mismas validaciones, reconciliador y libro de operaciones.
    let ordinalDeterminista = 0;
    let huboCambioDeterminista = false;
    const ejecutarDeterminista = async (accion) => {
      ordinalDeterminista += 1;
      const llamada = {
        id: `det-${turnoId || estado.turno}-${ordinalDeterminista}`,
        name: accion.herramienta,
        input: accion.argumentos,
      };
      const r = await ejecutarLlamada({
        llamada, ejecutor, libro, estado, negocioId, conversacionId, turnoId, modo,
        permitirMutacion: () => mutaciones < topeMutaciones,
        ocurrenciaDe: (herramienta, hash) => {
          const clave = `${herramienta}|${hash}`;
          const n = (ocurrencias.get(clave) || 0) + 1;
          ocurrencias.set(clave, n);
          return n;
        },
      });
      if (r.conto) mutaciones += 1;
      operaciones.push({
        herramienta: llamada.name, argumentos: llamada.input,
        tool_call_id: llamada.id, resultado: r.resultado, repetida: r.repetida,
        determinista: true, motivo: accion.motivo,
      });
      anotar({ tipo: 'herramienta_determinista', herramienta: llamada.name,
        aplicado: !!r.resultado?.aplicado, motivo: accion.motivo });
      return r.resultado;
    };

    const oferta = accionParaOfertaAceptada({ estado, catalogo, mensaje });
    if (oferta) {
      const r = await ejecutarDeterminista(oferta);
      if (oferta.consumeOfertaPromocion && r?.aplicado) {
        // La aceptación ya se convirtió en una mutación real del carrito.
        // Consumir la oferta aquí impide que un segundo «sí» vuelva a agregar
        // unidades y mantiene la idempotencia en el libro del turno.
        estado.ofertaPromocionPendiente = null;
        estado.promocionInformativaPendiente = false;
      }
      huboCambioDeterminista = huboCambioDeterminista || !!r?.aplicado;
    }

    const variante = varianteDelPedido({ estado, catalogo, mensaje });
    if (variante) {
      const r = await ejecutarDeterminista({ herramienta: 'modificar_linea',
        argumentos: { linea_id: variante.item.lid, reclasificar: true }, motivo: 'variante_del_catalogo' });
      huboCambioDeterminista ||= !!r?.aplicado;
    }
    const resolucion = accionesParaOpcionesPendientes({
      estado, pedido: ejecutor.vista(), mensaje,
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

    const pedidoDespues = ejecutor.vista();
    const pregunta = siguientePreguntaDelPedido({
      pedido: pedidoDespues, modalidades, metodosPago, requierePago,
    });

    if (resolucion.ambiguas.length && pregunta && !resolucion.requiereInterpretacion) {
      estado.foco = pregunta.foco;
      return cerrar(CIERRE.RESPONDIO, pregunta.texto,
        { continuidadDeterminista: true, opcionAmbigua: true });
    }

    if (huboCambioDeterminista && pregunta && !resolucion.requiereInterpretacion) {
      estado.foco = pregunta.foco;
      return cerrar(CIERRE.RESPONDIO, pregunta.texto, { continuidadDeterminista: true });
    }

    const grupoAjeno = grupoExplicitoNoAplicable({ pedido: pedidoDespues, catalogo, mensaje });
    if (grupoAjeno && pregunta) {
      estado.foco = pregunta.foco;
      return cerrar(CIERRE.RESPONDIO,
        `${grupoAjeno.producto} no tiene ${grupoAjeno.grupo} como elección. ${pregunta.texto}`,
        { continuidadDeterminista: true });
    }

    // Si una acción determinista completó todas las opciones, el modelo sigue
    // con modalidad, pago o resumen. Su prompt debe leer la vista actualizada.
    instrucciones = instruccionesDelTurno();

    while (iteraciones < topeIteraciones) {
      if (Date.now() - t0 > topeMs) return await escalarYSalir(CIERRE.TIEMPO, 'el turno tardó demasiado');
      iteraciones += 1;

      const t1 = Date.now();
      const respuesta = await llamarModelo({
        model: modelo,
        max_tokens: recuperacionesModelo ? Math.min(maxTokens * 2, 4096) : maxTokens,
        system: instrucciones,
        tools: herramientas,
        messages: mensajes,
      });
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
          // Ni herramientas ni texto. No hay nada que mandarle al cliente y
          // reintentar sería girar en el vacío.
          return await escalarYSalir(CIERRE.ERROR, 'el modelo no produjo respuesta');
        }
        const interna = detectarSalidaInterna(texto);
        if (interna) {
          anotar({ tipo: 'salida_interna', clase: interna.clase, token: interna.token });
          return await escalarYSalir(
            CIERRE.ERROR, `salida_interna:${interna.clase}:${interna.token}`);
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
          return cerrar(CIERRE.RESPONDIO, politica.soloLectura ? respuestaDeConsulta(operaciones) : respuestaDesdePedido({
            estado, pedido: ejecutor.vista(), modalidades, metodosPago, requierePago, zonaDelNegocio,
          }), { recuperacion: 'afirmacion_sin_efectos' });
        }
        return cerrar(CIERRE.RESPONDIO, texto);
      }

      // El texto que venga junto a las llamadas NO se usa: está escrito antes
      // de saber qué pasó. Ver la cabecera del archivo.
      mensajes.push({ role: 'assistant', content: respuesta.content });

      const resultados = [];
      for (const llamada of llamadas) {
        const r = await ejecutarLlamada({
          llamada, ejecutor, libro, estado, negocioId, conversacionId, turnoId, modo,
          permitirMutacion: () => mutaciones < topeMutaciones,
          // El ordinal de ESTA acción dentro del turno. Ver la cabecera del
          // libro de operaciones: es lo que separa «el cliente pidió dos» de
          // «esto es un reintento del mismo turno».
          ocurrenciaDe: (herramienta, hash) => {
            const clave = `${herramienta}|${hash}`;
            const n = (ocurrencias.get(clave) || 0) + 1;
            ocurrencias.set(clave, n);
            return n;
          },
        });
        if (r.conto) mutaciones += 1;
        operaciones.push({
          herramienta: llamada.name, argumentos: llamada.input,
          tool_call_id: llamada.id, resultado: r.resultado, repetida: r.repetida,
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
      // En particular, tras programar_para la fecha/hora ya validada debe
      // aparecer en el system prompt; conservar el prompt anterior permitiría
      // que el modelo respondiera como si el pedido siguiera sin programar.
      instrucciones = instruccionesDelTurno();

      // Escalar o cancelar cierra el turno: cualquier iteración más hablaría
      // de un pedido que ya no está en manos del bot.
      if (estado.hechos.escalado) {
        const texto = contexto.textoDeEscalado
          || 'Te paso con alguien del equipo para que te atienda mejor. Un momento, por favor.';
        return cerrar(CIERRE.ESCALADO, texto);
      }
      if (mutaciones >= topeMutaciones) {
        return await escalarYSalir(CIERRE.TOPE_MUTACIONES, 'demasiados cambios en un solo turno');
      }
    }

    if (!politica.soloLectura && puedeCerrarConAvance(estado, operaciones)) {
      const texto = respuestaDeAvance({ estado, pedido: ejecutor.vista(), modalidades, metodosPago, requierePago });
      if (!detectarSalidaInterna(texto) && !respuestaProhibidaEncontrada(texto, reglas)) {
        anotar({ tipo: 'redaccion_recuperada', motivo: 'presupuesto_con_avance_verificado' });
        return cerrar(CIERRE.RESPONDIO, texto, { recuperacion: 'presupuesto_con_avance_verificado' });
      }
    }
    return await escalarYSalir(CIERRE.SIN_ITERACIONES, 'el turno no llegó a una respuesta');
  } catch (e) {
    anotar({ tipo: 'error', mensaje: String(e?.message || e) });
    estado.hechos.fallido = true;
    estado.terminadoEn = new Date().toISOString();
    // Marcado FALLIDO, ninguna mutación es legal ya: lo que quede del pedido
    // se queda como está y lo recoge una persona.
    const salida = await escalarYSalir(CIERRE.ERROR, `excepción: ${String(e?.message || e).slice(0, 200)}`);
    return { ...salida, error: String(e?.message || e) };
  }
}

/**
 * Una llamada: validar -> (libro si muta) -> ejecutar.
 *
 * El libro envuelve SOLO las herramientas con efecto. Las de lectura no se
 * deduplican a propósito: `ver_pedido` tiene que poder contestar dos veces en
 * el mismo turno y contestar distinto si algo cambió en medio — que es
 * exactamente lo que hace falta después de una mutación.
 */
async function ejecutarLlamada({ llamada, ejecutor, libro, estado, negocioId, conversacionId, turnoId, modo,
  permitirMutacion, ocurrenciaDe }) {
  const v = validarArgumentos(llamada.name, llamada.input);
  if (!v.ok) {
    return { resultado: { aplicado: false, estado: 'ilegal', motivo: v.error }, repetida: false, conto: false };
  }

  if (!tieneEfecto(llamada.name)) {
    return { resultado: await ejecutor.ejecutar(llamada.name, v.valor), repetida: false, conto: false };
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
    return { resultado: await ejecutor.ejecutar(llamada.name, v.valor), repetida: false, conto: true };
  }

  const r = await libro.ejecutarUnaVez({
    negocioId, conversacionId, turnoId, toolCallId: llamada.id,
    herramienta: llamada.name, argumentos: v.valor, modo,
    ocurrencia: ocurrenciaDe ? ocurrenciaDe(llamada.name, hashDeArgumentos(v.valor)) : 1,
  }, async () => {
    const resultado = await ejecutor.ejecutar(llamada.name, v.valor);
    return { aplicada: !!resultado.aplicado, estado: resultado.estado, resultado };
  });

  if (r.repetida) {
    if (llamada.name === 'confirmar_pedido' && r.aplicada && r.resultado?.folio) {
      // El pedido durable sobrevivió pero guardarEstado pudo haber fallado.
      estado.hechos.confirmado = true;
      estado.terminadoEn = new Date().toISOString();
      estado.folio = r.resultado.folio;
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
