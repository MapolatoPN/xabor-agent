// ─── Ver qué haría el Mesero, sin que haga nada ───────────────────────────
//
// Observación en copia. Corre el turno completo del mesero contra un contexto y
// un carrito que viven FUERA de la sesión productiva, y escribe una línea.
//
// ── Por qué se copia la disciplina de `registroSombra` y no su código ────
//
// Aquel observa al reconciliador; este observa al mesero entero, que es otro
// experimento con otro código y otro riesgo. Compartir el estado haría que
// encender uno moviera al otro, y compartir el interruptor haría imposible
// apagar solo el que estorba. Lo que sí se copia —porque es lo que lo hace
// seguro— es la disciplina:
//
//   estado propio          `estadoMeseroSombra`, un Map suyo, acotado, que no
//                          toca `session` ni el carrito productivo
//   nunca lanza            todo dentro de un try/catch que devuelve {ok:false}
//   nunca espera           tope de tiempo, y quien llama no aguarda el
//                          resultado; un observador lento no puede retener un
//                          turno hasta que el vigilante lo dé por no verificado
//   sin efectos            este archivo no importa el canal, ni la base, ni el
//                          registro de pedidos. No hay forma de que responda:
//                          no tiene con qué (lo comprueba una prueba sobre el
//                          grafo de imports, no sobre las buenas intenciones)
//   sin datos personales   la conversación es un hash, los números se tapan
//
// ── Fail closed quiere decir NO OBSERVAR ─────────────────────────────────
//
// Si el catálogo no se puede leer, la observación se abandona. La tentación era
// seguir con una carta vacía —«al fin y al cabo no afecta a nadie»— y eso
// produciría datos de comparación falsos: sin carta, TODO sale «no
// identificado» y el día que se miren los números parecerá que el mesero no
// entiende nada. Un observador que miente es peor que uno que calla.
import { createHash } from 'node:crypto';
import { atenderTurno } from './meseroDigital.js';
import { resumenDelContexto } from './contextoMesa.js';

/** Cuántas conversaciones se recuerdan a la vez. */
export const TOPE_CONVERSACIONES = 500;

/** Cuántos turnos de cada una. */
export const TOPE_TURNOS = 12;

/** Cuánto se le da a cada paso antes de abandonarlo. */
export const TOPE_MS = 8000;

/** Cuánto texto del cliente se guarda en el log, ya tapado. */
export const MAX_TEXTO = 160;

// ── EL ESTADO DE LA SOMBRA, QUE ES SOLO SUYO ─────────────────────────────
//
// Un Map de este módulo. No es `session`, no es `session.carrito`, no es el
// snapshot durable y no se le pasa a nadie. Lo único que entra de fuera es una
// COPIA del carrito productivo, y solo la primera vez.
const estadoMeseroSombra = new Map();

/** Para las pruebas: dejar la memoria como estaba. */
export const reiniciarSombraMesero = () => estadoMeseroSombra.clear();

/** Cuántas conversaciones se están observando. */
export const conversacionesObservadas = () => estadoMeseroSombra.size;

/** Solo para pruebas: mirar el estado sombra de una conversación. */
export const verEstadoSombra = (negocioId, sessionId) =>
  estadoMeseroSombra.get(`${negocioId}::${sessionId}`) || null;

const hash = (s) => createHash('sha256').update(String(s || '')).digest('hex').slice(0, 10);

/** Rachas de dígitos fuera: un teléfono o una dirección no aportan nada al log. */
export const textoSeguro = (s) => String(s || '')
  .replace(/\d{3,}/g, '###')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, MAX_TEXTO);

function conLimite(promesa, ms) {
  return new Promise((resolve) => {
    const reloj = setTimeout(() => resolve({ ok: false, motivo: 'tiempo' }), ms);
    Promise.resolve(promesa).then(
      (v) => { clearTimeout(reloj); resolve({ ok: true, valor: v }); },
      (e) => { clearTimeout(reloj); resolve({ ok: false, motivo: e?.message || 'error' }); },
    );
  });
}

/** Los artículos, en la forma mínima que hace falta para entender la decisión. */
const resumirItems = (carrito) => (carrito?.items || []).map((i) => ({
  n: i.nombre,
  c: i.cantidad,
  m: (i.modificadores || []).map((g) => `${g?.grupo ?? ''}:${(g?.opciones || []).join('/')}`),
  ...(i.notas ? { nota: i.notas } : {}),
}));

/**
 * Observa un turno con el mesero. No responde, no guarda pedido, no cobra.
 *
 * Devuelve siempre un objeto; nunca lanza. `{ ok: false }` significa que la
 * observación no pudo hacerse, y eso NO es un problema del turno real.
 *
 * `cargarCatalogo(negocioId)` y `proponer(mensajes)` los inyecta quien llama.
 * Inyectarlos en vez de importarlos es lo que mantiene este módulo sin
 * dependencia de la base ni del cerebro, y lo que permite que una prueba le dé
 * una carta fija o le haga explotar el modelo sin tocar nada real.
 */
export async function observarTurnoDelMesero({
  sessionId, negocioId, mensaje, carritoProductivo = null,
  cargarCatalogo = null, cargarConfiguracion = null, proponer = null,
  tope = TOPE_MS, ahora = null,
} = {}) {
  const arranque = Date.now();
  const medir = () => Date.now() - arranque;
  try {
    const clave = `${negocioId}::${sessionId}`;
    if (!estadoMeseroSombra.has(clave)) {
      if (estadoMeseroSombra.size >= TOPE_CONVERSACIONES) {
        // La más vieja se va. Un observador que crece sin límite acaba tirando
        // el proceso que observa, que es la peor forma de fallar.
        estadoMeseroSombra.delete(estadoMeseroSombra.keys().next().value);
      }
      estadoMeseroSombra.set(clave, { contexto: null, carrito: null, turnos: 0, mensajes: [] });
    }
    const guardado = estadoMeseroSombra.get(clave);
    if (guardado.turnos >= TOPE_TURNOS) return { ok: false, motivo: 'tope_de_turnos' };

    // ── EL CATÁLOGO REAL, Y SI NO, NADA ────────────────────────────────
    let catalogo = [];
    if (typeof cargarCatalogo === 'function') {
      const leido = await conLimite(cargarCatalogo(negocioId), tope);
      if (!leido.ok || !Array.isArray(leido.valor) || !leido.valor.length) {
        return { ok: false, motivo: `catalogo:${leido.ok ? 'vacio' : leido.motivo}`, ms: medir() };
      }
      catalogo = leido.valor;
    }

    // La configuración del negocio es opcional: sin ella el mesero recomienda
    // menos, que es una degradación honesta y no un dato falso.
    let complementos = {};
    if (typeof cargarConfiguracion === 'function') {
      const cfg = await conLimite(cargarConfiguracion(negocioId), tope);
      if (cfg.ok && cfg.valor && typeof cfg.valor === 'object') {
        try {
          const crudo = cfg.valor.mesero_complementos;
          if (crudo) complementos = typeof crudo === 'string' ? JSON.parse(crudo) : crudo;
        } catch { complementos = {}; }
      }
    }

    // El carrito productivo se CLONA. Es la línea que impide que observar
    // cambie lo observado, y solo se usa como punto de partida del primer
    // turno: de ahí en adelante la sombra vive de su propia copia.
    const partida = guardado.carrito
      ?? (carritoProductivo ? JSON.parse(JSON.stringify(carritoProductivo)) : null);

    guardado.mensajes.push({ role: 'user', content: String(mensaje || '') });
    if (guardado.mensajes.length > TOPE_TURNOS * 2) {
      guardado.mensajes.splice(0, guardado.mensajes.length - TOPE_TURNOS * 2);
    }

    // Cuántas veces se llama al modelo en un turno. Es UNA: las consultas de
    // menú, las referencias y las aclaraciones se resuelven sin modelo. Se
    // cuenta en vez de afirmarse.
    let llamadasAlModelo = 0;
    const proponerContado = proponer
      ? async () => { llamadasAlModelo += 1; return proponer(guardado.mensajes.slice()); }
      : null;

    const antes = { contexto: resumenDelContexto(guardado.contexto), items: resumirItems(partida) };

    const corrida = await conLimite(atenderTurno({
      negocioId,
      conversacionId: `sombra-${hash(sessionId)}`,
      mensaje,
      contextoGuardado: guardado.contexto,
      carrito: partida,
      catalogo,
      complementos,
      proponer: proponerContado,
    }), tope);

    if (!corrida.ok) return { ok: false, motivo: corrida.motivo, ms: medir() };
    const r = corrida.valor;

    // Se guarda una COPIA serializada, no la referencia que devolvió el turno:
    // así el estado sombra tampoco comparte objetos con nada de lo que pase
    // después con ese resultado.
    guardado.contexto = JSON.parse(JSON.stringify(r.contexto));
    guardado.carrito = JSON.parse(JSON.stringify(r.carrito));
    guardado.turnos += 1;

    const registro = registroDelTurno({
      negocioId, sessionId, mensaje, r, antes, ms: medir(), llamadasAlModelo, ahora,
    });
    return { ok: true, registro, linea: lineaDeSombra(registro), resumen: registro };
  } catch (e) {
    // Contenido. Un fallo de la observación no puede tocar el turno real.
    return { ok: false, motivo: e?.message || 'error', ms: medir() };
  }
}

/**
 * TODO lo que hace falta para comparar después, en un objeto.
 *
 * Se emite como una sola línea de JSON porque dentro de dos semanas alguien va
 * a querer contar cuántas veces el mesero acertó la intención, y eso se hace
 * con un `jq`, no leyendo. Lo que no está aquí no se podrá medir.
 *
 * PII: la conversación es un hash, el texto va tapado y recortado, y no entra
 * ni el teléfono ni el nombre. Los nombres de PRODUCTO sí: son del negocio,
 * están en su carta pública, y sin ellos «modificación bloqueada» no se puede
 * accionar.
 */
export function registroDelTurno({ negocioId, sessionId, mensaje, r, antes, ms, llamadasAlModelo, ahora }) {
  const c = r?.cambios || {};
  return {
    ts: (ahora || new Date()).toISOString(),
    conv: hash(sessionId),
    negocio: negocioId,
    ms,
    llamadas_modelo: llamadasAlModelo,

    dijo: textoSeguro(mensaje),

    antes: antes?.contexto || null,
    antes_items: antes?.items || [],

    intenciones: r?.intenciones || [],
    foco: r?.contexto?.foco || null,
    referencia: r?.referencia?.tipo
      ? {
        tipo: r.referencia.tipo,
        resuelta: !!r.referencia.resuelta,
        lids: r.referencia.lids || [],
        motivo: r.referencia.motivo || null,
        candidatos: (r.referencia.candidatos || []).map((x) => x.nombre),
      }
      : null,

    propuestas: (r?.decisiones || []).map((d) => ({
      accion: d.propuesta?.accion,
      lid: d.propuesta?.lid || null,
      campo: d.propuesta?.campo || null,
      decision: d.decision,
      motivo: d.motivo || null,
    })),

    autorizado: (c.autorizados || []).map((a) => `${a.nombre}|${a.campo}|${a.via}`),
    bloqueado: [
      ...(c.congelados || []).map((x) => `${x.nombre}|${x.campo}|no_lo_dijo_el_cliente`),
      ...(c.sinRespaldo || []).map((x) => `${x.nombre}|${x.campo}|sin_respaldo`),
    ],
    invenciones_bloqueadas: (c.sinRespaldo || []).filter((x) => x.campo === 'articulo').map((x) => x.nombre),
    conservado: (c.conservados || []).slice(0, 8),
    quitado: (c.quitados || []).slice(0, 8),

    ambiguedades: (r?.aclaraciones || []).map((a) => ({
      tipo: a.tipo, candidatos: (a.candidatos || []).map((x) => (typeof x === 'string' ? x : x.nombre)),
    })),
    // La pregunta que HABRÍA hecho. En sombra no se envía: solo se anota.
    aclaracion_que_haria: (r?.aclaraciones || []).map((a) => a.pregunta).filter(Boolean).slice(0, 2),

    consulta: r?.consulta?.tipo || null,
    recomendaciones: (r?.recomendaciones || []).map((x) => x.nombre),
    handoff: r?.handoff?.escalar ? r.handoff.motivo : null,

    despues: resumenDelContexto(r?.contexto),
    pedido_hipotetico: resumirItems(r?.carrito),
    falta: r?.falta || [],
    fase: r?.fase || null,
    listo_para_confirmar: !!r?.listoParaConfirmar,
  };
}

/** Una línea por turno, parseable. */
export const lineaDeSombra = (registro) => '[SOMBRA-MESERO] ' + JSON.stringify(registro);

/** ¿Se coló algo que no debería? Para poder afirmarlo con una prueba. */
export function pareceSensibleElRegistro(registro) {
  const texto = typeof registro === 'string' ? registro : JSON.stringify(registro);
  return /\d{7,}/.test(texto) || /[\w.+-]+@[\w-]+\.\w+/.test(texto);
}
