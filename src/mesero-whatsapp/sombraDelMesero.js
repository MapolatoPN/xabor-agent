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
import {
  redactarDireccion, redactarContacto, palabrasDeLaCarta, pareceDomicilioSinTapar,
  DICE_DOMICILIO, DICE_RECOGER,
} from './redaccionPII.js';

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

/**
 * Desaloja la conversación más vieja QUE NO ESTÉ OCUPADA.
 *
 * Un `Map` de JavaScript conserva el orden de inserción, así que la primera
 * clave es la más vieja. Lo que no se puede hacer es desalojar a ciegas: si la
 * elegida tiene un turno dentro, su candado desaparece del mapa sin que el
 * turno en vuelo se entere, y el siguiente mensaje de esa misma conversación
 * crea una entrada nueva —con la cola vacía— que corre EN PARALELO con él.
 *
 * Devuelve si consiguió hacer sitio. `false` significa que las 500 están
 * ocupadas a la vez, y entonces se prefiere no observar: crecer sin límite
 * tira el proceso, y desalojar una ocupada corrompe justo lo que se protege.
 */
function hacerSitio() {
  for (const [clave, estado] of estadoMeseroSombra) {
    if ((estado?.ocupada || 0) > 0) continue;
    estadoMeseroSombra.delete(clave);
    return true;
  }
  return false;
}

/** Solo para pruebas: mirar el estado sombra de una conversación. */
export const verEstadoSombra = (negocioId, sessionId) =>
  estadoMeseroSombra.get(`${negocioId}::${sessionId}`) || null;

const hash = (s) => createHash('sha256').update(String(s || '')).digest('hex').slice(0, 10);

/**
 * El texto del cliente tal como puede ir a un log.
 *
 * Tres capas, y las tres hacen falta, en este orden:
 *
 *   1. correo, COORDENADAS y enlaces, que no dependen de ningún contexto —y
 *      que tienen que irse antes de la máscara de dígitos, porque unas
 *      coordenadas convertidas en `##.####` siguen siendo coordenadas;
 *   2. la DIRECCIÓN, tapada por marco (`redaccionPII`), que es la única capa
 *      que sabe distinguir «Calle Naranja 900» de «jugo de naranja»;
 *   3. las rachas de dígitos, que siguen cayendo al final — un teléfono suelto
 *      no lleva marco de dirección y no lo taparía la capa de arriba.
 *
 * Lo que NO se toca es la semántica gastronómica. Un log en el que todo dice
 * `[REDACTADO]` no responde ninguna de las preguntas por las que se observa.
 */
export const textoSeguro = (s, opciones = {}) => {
  const { texto } = redactarDireccion(redactarContacto(s), opciones);
  return texto
    .replace(/\d{3,}/g, '###')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXTO);
};

/**
 * ¿Esta conversación es a domicilio?
 *
 * Misma precedencia que `brain.js`: recoger se evalúa PRIMERO y se queda con la
 * frase, porque «para llevar» en México es que el cliente pasa por su pedido.
 * Es pegajoso: una vez que la conversación es a domicilio, sigue siéndolo
 * mientras el cliente no diga lo contrario.
 */
export function esEntregaADomicilio(anterior, mensaje, modalidad = null) {
  const t = String(mensaje || '');
  if (DICE_RECOGER.test(t)) return false;
  if (DICE_DOMICILIO.test(t)) return true;
  if (modalidad && DICE_DOMICILIO.test(String(modalidad))) return true;
  return !!anterior;
}

function conLimite(promesa, ms) {
  return new Promise((resolve) => {
    const reloj = setTimeout(() => resolve({ ok: false, motivo: 'tiempo' }), ms);
    Promise.resolve(promesa).then(
      (v) => { clearTimeout(reloj); resolve({ ok: true, valor: v }); },
      (e) => { clearTimeout(reloj); resolve({ ok: false, motivo: e?.message || 'error' }); },
    );
  });
}

/**
 * Los artículos, en la forma mínima que hace falta para entender la decisión.
 *
 * El nombre y los modificadores salen del CATÁLOGO del negocio: están en su
 * carta pública y se escriben tal cual. La NOTA no: la escribe el cliente con
 * sus palabras, y ahí cabe cualquier cosa —«dejarlo con el portero de Nogal
 * 900», un teléfono de contacto—. Pasa por las mismas capas que el mensaje, o
 * el registro tendría una puerta trasera por la que se cuela justo lo que las
 * otras tres tapan.
 */
const resumirItems = (carrito, opciones = {}) => (carrito?.items || []).map((i) => ({
  n: i.nombre,
  c: i.cantidad,
  m: (i.modificadores || []).map((g) => `${g?.grupo ?? ''}:${(g?.opciones || []).join('/')}`),
  ...(i.notas ? { nota: textoSeguro(i.notas, opciones) } : {}),
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
      if (estadoMeseroSombra.size >= TOPE_CONVERSACIONES && !hacerSitio()) {
        // Todas ocupadas. Antes de desalojar una conversación que tiene un
        // turno dentro, se prefiere no observar esta: desalojarla soltaría su
        // candado sin que nadie lo sepa, y el siguiente mensaje de la
        // desalojada arrancaría de cero EN PARALELO con el turno en vuelo —
        // que es exactamente la carrera que este módulo existe para evitar.
        return { ok: false, motivo: 'sin_sitio', ms: medir() };
      }
      estadoMeseroSombra.set(clave, { contexto: null, carrito: null, turnos: 0, mensajes: [],
        cola: Promise.resolve(), entrega: false, ocupada: 0 });
    }
    const guardado = estadoMeseroSombra.get(clave);
    // Rechazo barato, para no encolar lo que ya no cabe. La comprobación que
    // MANDA es la de dentro del candado: sin ella, una ráfaga de mensajes pasa
    // entera por aquí antes de que ninguno haya llegado a incrementar.
    if (guardado.turnos >= TOPE_TURNOS) return { ok: false, motivo: 'tope_de_turnos' };

    // ── UNA OBSERVACIÓN A LA VEZ POR CONVERSACIÓN ──────────────────────
    //
    // El canal agrupa seis segundos, pero llama a la observación UNA VEZ POR
    // MENSAJE y sin esperarla. Con dos mensajes seguidos —que es como escribe
    // la gente— las dos observaciones leían el mismo estado guardado, tardaban
    // ~800 ms en el modelo, y la segunda en terminar pisaba a la primera.
    //
    // Pasó en el primer tráfico real: el cliente escribió «Quiero unos
    // Chilaquiles…» y «Frijolitos y papas…» con 750 ms de diferencia; el
    // renglón de chilaquiles y su texto desaparecieron del contexto sombra, y
    // a partir de ahí el modelo lo re-proponía cada turno sin evidencia. La
    // «aclaración pegada» que se vio en el log era eso: no una pregunta que se
    // quedara guardada, sino la MISMA pregunta regenerada cada turno por un
    // producto que había perdido su respaldo.
    //
    // Se encadenan por conversación. Es una cola de uno: la segunda espera a
    // la primera y arranca del estado que aquella dejó. Sigue sin bloquear al
    // canal —nadie espera este `await`— y el tope de tiempo sigue aplicando a
    // cada paso.
    //
    // `ocupada` es lo que impide que el desalojo por tope de conversaciones
    // suelte un candado por la espalda. Se sube ANTES del primer `await`.
    const miTurno = guardado.cola.then(() => {}, () => {});
    let liberar;
    guardado.cola = new Promise((r) => { liberar = r; });
    guardado.ocupada = (guardado.ocupada || 0) + 1;
    await miTurno;
    try {
      return await observarEnSerie({
        guardado, clave, sessionId, negocioId, mensaje, carritoProductivo,
        cargarCatalogo, cargarConfiguracion, proponer, tope, ahora, medir,
      });
    } finally {
      guardado.ocupada -= 1;
      liberar();
    }
  } catch (e) {
    // Contenido. Un fallo de la observación no puede tocar el turno real.
    return { ok: false, motivo: e?.message || 'error', ms: medir() };
  }
}

/** El cuerpo de la observación, ya con la conversación en exclusiva. */
async function observarEnSerie({
  guardado, sessionId, negocioId, mensaje, carritoProductivo,
  cargarCatalogo, cargarConfiguracion, proponer, tope, ahora, medir,
}) {
  try {
    // EL TOPE DE TURNOS, OTRA VEZ Y AHORA SÍ.
    //
    // La comprobación de fuera corre antes del candado, así que una ráfaga de
    // mensajes la pasa entera antes de que ninguno haya incrementado el
    // contador. Esta corre con la conversación en exclusiva, que es donde el
    // número significa algo.
    if (guardado.turnos >= TOPE_TURNOS) return { ok: false, motivo: 'tope_de_turnos', ms: medir() };

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

    // ── LO QUE CUESTA UN TURNO, MEDIDO EN TRES PARTES ──────────────────
    //
    // El extractor llama a un proveedor por red. Todo lo demás —intenciones,
    // referencias, catálogo, reconciliación, contexto, log— corre en memoria.
    // Mezclarlos en un solo número no dice nada útil: uno se mide en
    // milisegundos y el otro en cientos.
    //
    //   ms_modelo   la llamada al proveedor, de principio a fin
    //   ms_local    el resto del turno
    //   ms          los dos juntos, más la lectura del catálogo
    //
    // Se cuenta también CUÁNTAS llamadas hay. Hoy es una por turno SIEMPRE,
    // incluso en un «hola» o en una pregunta por la carta: el extractor se
    // invoca antes de saber si tenía algo que extraer. Eso es coste real en
    // sombra y sale en el log para que se vea, no para suponerlo.
    let llamadasAlModelo = 0;
    let msModelo = 0;
    const proponerContado = proponer
      ? async (...args) => {
        llamadasAlModelo += 1;
        const t0 = Date.now();
        try { return await proponer(guardado.mensajes.slice(), ...args); }
        finally { msModelo += Date.now() - t0; }
      }
      : null;

    // ── LO QUE HACE FALTA PARA TAPAR UNA DIRECCIÓN Y NADA MÁS ──────────
    //
    // Se calcula ANTES de correr el turno y con el mensaje CRUDO: «mándamelo a
    // casa, Nogal 900 col. Álamos» trae la señal y el dato en la misma línea, y
    // leer la señal después de haber partido el mensaje llegaría tarde.
    //
    // El vocabulario sale del catálogo REAL del negocio. No hay lista de
    // platillos en el código, igual que en el resto del mesero.
    guardado.entrega = esEntregaADomicilio(guardado.entrega, mensaje, guardado.contexto?.modalidad);
    const vocabulario = palabrasDeLaCarta(catalogo);

    const conRedaccion = { entrega: guardado.entrega, vocabulario };
    const antes = {
      contexto: resumenDelContexto(guardado.contexto),
      items: resumirItems(partida, conRedaccion),
    };

    const corrida = await conLimite(atenderTurno({
      negocioId,
      conversacionId: `sombra-${hash(sessionId)}`,
      mensaje,
      contextoGuardado: guardado.contexto,
      carrito: partida,
      catalogo,
      complementos,
      proponer: proponerContado,
      // La copia no se detiene en un handoff: lo anota y sigue mirando. Es la
      // única diferencia de comportamiento entre observar y atender.
      observando: true,
    }), tope);

    if (!corrida.ok) return { ok: false, motivo: corrida.motivo, ms: medir() };
    const r = corrida.valor;

    // Se guarda una COPIA serializada, no la referencia que devolvió el turno:
    // así el estado sombra tampoco comparte objetos con nada de lo que pase
    // después con ese resultado.
    guardado.contexto = JSON.parse(JSON.stringify(r.contexto));
    guardado.carrito = JSON.parse(JSON.stringify(r.carrito));
    guardado.turnos += 1;

    const total = medir();
    const registro = registroDelTurno({
      negocioId, sessionId, mensaje, r, antes, ahora,
      ms: total, msModelo, msLocal: Math.max(0, total - msModelo), llamadasAlModelo,
      entrega: guardado.entrega, vocabulario,
    });
    // `eventos` viaja aparte de la línea JSON: son las métricas con el prefijo
    // `[MESERO]` que ya usa el resto del sistema, y sin devolverlas se
    // construían cada turno para tirarlas a la basura.
    return {
      ok: true, registro, linea: lineaDeSombra(registro), resumen: registro,
      eventos: r?.eventos || [],
    };
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
export function registroDelTurno({ negocioId, sessionId, mensaje, r, antes, ms, msModelo = 0,
  msLocal = null, llamadasAlModelo, ahora, entrega = false, vocabulario = null }) {
  const c = r?.cambios || {};
  const sinContacto = redactarContacto(mensaje);
  const redaccion = redactarDireccion(sinContacto, { entrega, vocabulario });
  return {
    ts: (ahora || new Date()).toISOString(),
    conv: hash(sessionId),
    negocio: negocioId,
    ms,
    ms_modelo: msModelo,
    ms_local: msLocal === null ? Math.max(0, ms - msModelo) : msLocal,
    llamadas_modelo: llamadasAlModelo,

    dijo: textoSeguro(mensaje, { entrega, vocabulario }),
    // Que la redacción ocurrió se dice, aunque lo redactado no se diga. Sin
    // esto no hay forma de saber si la capa está funcionando o está muerta.
    direccion_redactada: redaccion.redactado,
    // Correo, coordenadas, enlaces… o un teléfono, que cae en la máscara de
    // dígitos y no en `redactarContacto`. Si el campo solo mirase lo primero,
    // diría «no se redactó nada» en el caso más común de todos.
    contacto_redactado: sinContacto !== String(mensaje || '') || /\d{3,}/.test(sinContacto),

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

    // ── LO QUE HABRÍA PASADO, SEPARADO DE LO QUE SE SIGUIÓ MIRANDO ──────
    //
    // `habria_escalado` dice que en producción esta conversación habría pasado
    // a una persona. `post_handoff_shadow` dice que ESTE turno es posterior a
    // ese punto y por tanto contrafactual: el bot no habría estado aquí, así
    // que su `pedido_hipotetico` no se puede leer como «lo que habría pedido».
    habria_escalado: r?.handoff?.habriaEscalado ? r.handoff.motivo : null,
    turno_del_escalado: r?.handoff?.turnoDelEscalado ?? null,
    post_handoff_shadow: !!r?.postHandoff,

    // El ciclo de vida de las preguntas abiertas, no su redacción.
    pendientes: (r?.contexto?.pendientes || []).map((p) => ({
      clave: p.clave, tipo: p.tipo, intentos: p.intentos || 0,
      desde: p.turnoCreacion, preguntado: p.turnoUltimaPregunta ?? null,
    })),
    // Y el movimiento de ESTE turno, que es lo que permite sumar
    // «% pendientes resueltos» y «aclaraciones por pedido» con un jq.
    ciclo_pendientes: r?.cicloPendientes
      || { creados: 0, resueltos: 0, cancelados: 0, obsoletos: 0, vivos: 0 },
    aclaraciones_repetidas: (r?.aclaracionesRepetidas || []).length,

    despues: resumenDelContexto(r?.contexto),
    pedido_hipotetico: resumirItems(r?.carrito, { entrega, vocabulario }),
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
  if (/\d{7,}/.test(texto) || /[\w.+-]+@[\w-]+\.\w+/.test(texto)) return true;
  // Un marco de dirección que sobrevivió a la redacción. Se mira en el registro
  // entero y no solo en `dijo`: una dirección que se colara por otro campo
  // seguiría siendo una dirección publicada.
  return pareceDomicilioSinTapar(texto);
}
