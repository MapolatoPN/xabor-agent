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
//     Si se agotan las iteraciones, si el modelo no redacta, si algo revienta:
//     se escala a una persona y se dice. Callarse es la única salida que no
//     está permitida.
import { definicionesParaElModelo, validarArgumentos, tieneEfecto } from './contratoDeHerramientas.js';
import { crearEjecutor } from './ejecutorDeHerramientas.js';
import { hashDeArgumentos } from './libroDeOperaciones.js';
import { construirInstrucciones } from './instrucciones.js';

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
  reglas = null, promocionesActivas = [],
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

  const ejecutor = crearEjecutor({
    estado, catalogo, precios, requierePago, metodosPago, modalidades,
    reglas, promocionesActivas,
    mensaje,
    textoCiclo: contexto.textoCiclo ?? mensaje,
    terminos: contexto.terminos ?? [],
    datoOperativoPendiente: contexto.datoOperativoPendiente ?? false,
    efectos,
  });

  const herramientas = definicionesParaElModelo();
  const instrucciones = construirInstrucciones({ ...contexto, pedido: ejecutor.vista() });

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
    return {
      texto: String(texto || '').trim(),
      motivoCierre,
      pedido,
      estado,
      operaciones,
      iteraciones,
      llamadasAlModelo,
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
    while (iteraciones < topeIteraciones) {
      if (Date.now() - t0 > topeMs) return await escalarYSalir(CIERRE.TIEMPO, 'el turno tardó demasiado');
      iteraciones += 1;

      const t1 = Date.now();
      const respuesta = await llamarModelo({
        model: modelo,
        max_tokens: maxTokens,
        system: instrucciones,
        tools: herramientas,
        messages: mensajes,
      });
      llamadasAlModelo += 1;
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
          content: JSON.stringify(r.resultado),
        });
      }
      mensajes.push({ role: 'user', content: resultados });

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

    return await escalarYSalir(CIERRE.SIN_ITERACIONES, 'el turno no llegó a una respuesta');
  } catch (e) {
    anotar({ tipo: 'error', mensaje: String(e?.message || e) });
    estado.hechos.fallido = true;
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
