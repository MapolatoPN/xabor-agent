// ─── RESCATE HUMANO: cuando el bot no puede, una persona, a tiempo ─────────
//
// Incidente 2-oct-2026 (Mapolato Obispado): el cliente escribió su pedido, el
// proveedor del modelo falló, recibió el formulario; volvió a escribir, volvió
// a fallar y volvió a recibir el mismo formulario. Contestó «No carga» y se
// fue. Nadie del equipo se enteró. Hoy la conversación solo pasa a una persona
// al TERCER fallo del proveedor, y ese contador lo reinicia un corte por
// tiempo del turno (agenteDelMesero.js, `cerrar` pone fallosProveedor=0), así
// que alternando timeouts y cortes el tercero puede no llegar nunca.
//
// Este módulo DECIDE; no tiene efectos. Dos disparadores, un solo predicado:
//
//   (a) AGENTE_FALLO_REPETIDO: el segundo fallo del proveedor en la misma
//       conversación dentro de la ventana (10 min). Se cuenta aquí, en
//       `estado.rescate.fallos`, con marcas de tiempo propias: el contador del
//       bucle no sirve (lo reinicia el corte por tiempo y no tiene ventana).
//   (b) FORMULARIO_NO_CARGA: el cliente dice que el formulario no le abre, no
//       carga o no le deja, Y hay contexto que lo respalda (le llegó un
//       formulario hace poco, o el bot ya le falló en la ventana). Se contesta
//       ANTES del modelo: «No carga» no espera otros 30 s para volver a fallar.
//
// Las dos salidas usan el mismo texto y el canal escala SIEMPRE que (i) haya
// contestado: nunca sale «te paso con alguien» sin pasar por `avisarAHumano`.
//
// Todo detrás de `whatsapp_rescate_humano_v1` (tabla configuracion, por
// negocio, apagada por omisión). Apagada, nada aquí escribe en el estado.

export const BANDERA_RESCATE = 'whatsapp_rescate_humano_v1';
export const CLAVE_VENTANA_MIN = 'whatsapp_rescate_ventana_min';
export const VENTANA_POR_OMISION_MIN = 10;
// Un formulario entregado hace más de esto ya no explica un «no carga».
export const VIGENCIA_FORMULARIO_MIN = 30;
// Un mensaje largo es un pedido escrito, no una queja de que algo no abre.
const LARGO_MAXIMO = 160;

export const MOTIVOS_RESCATE = Object.freeze({
  FALLO_REPETIDO: 'AGENTE_FALLO_REPETIDO',
  FORMULARIO_NO_CARGA: 'FORMULARIO_NO_CARGA',
});

// Honesto en los dos casos: reconoce que algo falló y promete una persona,
// promesa que el canal solo deja salir si la pausa quedó confirmada (va en
// TEXTOS_RECIBO_HANDOFF, reciboHandoff.js). No dice «para tomar tu pedido»:
// el formulario que no abre puede ser el de factura o el de un evento.
export const TEXTO_RESCATE = 'Disculpa, tuve un problema para atenderte por aquí. '
  + 'Te paso con alguien del equipo; un momento, por favor.';

export const rescateActivo = (cfg) => String(cfg?.[BANDERA_RESCATE] ?? '') === 'true';

export function ventanaMs(cfg) {
  const min = Number(cfg?.[CLAVE_VENTANA_MIN]);
  // Entre 1 y 60 minutos; cualquier otra cosa es un error de captura.
  const valido = Number.isFinite(min) && min >= 1 && min <= 60 ? min : VENTANA_POR_OMISION_MIN;
  return valido * 60 * 1000;
}

// ── «NO CARGA», «NO ABRE», «NO ME DEJA» ──────────────────────────────────
//
// Casi todo tiene dos lecturas. «No abre» también es una pregunta de horario
// («¿hoy no abre?», «¿todavía no abre?»); «no puedo pedir», una duda del
// pedido («¿no puedo pedir a domicilio?»); «no carga», dinero («no me carga
// comisión», «no cargo efectivo»); «no funciona», una nota de entrega («no
// funciona el timbre»). Leerlas mal pausa al bot y deja al cliente esperando a
// una persona por una pregunta que el modelo contestaba solo, y una pausa por
// FORMULARIO_NO_CARGA no se libera sola. Tres niveles:
//
//  · SIEMPRE: una pantalla trabada o un error («se queda cargando», «me sale
//    un error»). No admiten otra lectura.
//  · CON OBJETO: el mensaje nombra lo que no abre (formulario, botón, liga,
//    menú, página…). Si además habla de horario, solo vale un objeto de
//    PANTALLA: «¿hoy no sale el menú del día?» es una pregunta de la carta.
//  · A SECAS (revisión del 3-oct): el mensaje ENTERO tiene que ser la queja.
//    Antes, a lo más un vocativo («oiga») o lo que el cliente intentó («ya le
//    piqué y»); después, solo relleno («nada», «otra vez», «ayuda», «¿qué
//    hago?»). Cualquier complemento —a domicilio, sin cebolla, efectivo,
//    comisión, el timbre, el portón, otro, 2— devuelve el mensaje al modelo.
//    «No abre» sin pronombre es lo más ambiguo: solo vale solo o tras lo que
//    el cliente intentó («oiga, ¿no abre?» es de horario).
const normalizar = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

const OBJETO = '(?:formulario|formularios|form|forms|boton|botones|link|links|liga|ligas|enlace|lista|menu'
  + '|pagina|ventana|app|aplicacion|opcion|opciones|catalogo|carrito|pantalla)';
// Los objetos que solo pueden ser una pantalla (no la carta ni el pedido).
const OBJETO_DE_PANTALLA = /\b(?:formularios?|forms?|boton|botones|links?|ligas?|enlace|pagina|ventana|app|aplicacion|pantalla|carrito)\b/;
const CLITICOS = '(?:(?:me|le|nos|se|lo|la|te)\\s+)*';
// Lo que «no hace» algo que debería abrir. Con objeto explícito vale todo.
const FALLA_CON_OBJETO = '(?:carga|cargan|cargo|cargaba|abre|abren|abrio|abria|funciona|funcionan|funciono'
  + '|sirve|sirven|aparece|aparecen|aparecio|jala|jalan|deja|dejan|dejo|sale|salen|salio|muestra|muestran)';
const ACCION_BLOQUEADA = '(?:elegir|escoger|seleccionar|abrir|abrirlo|abrirla|cargar|pedir|ordenar|agregar|anadir'
  + '|continuar|seguir|avanzar|enviar|mandar|terminar|entrar|picar|darle|dar|guardar|confirmar|marcar|ver)';
const PALABRAS = '(?:\\s+[a-z0-9]+){0,3}?';
// Horario, fechas o el local como sujeto: ahí «no abre» habla del restaurante.
// Ampliado el 3-oct con lo que se coló en la revisión (todavía/ya no abre,
// noche, tarde, ahorita, fin de semana, feriados, «hasta las», la cocina).
// «tarde» y «noche» van en singular: «buenas tardes, no me carga» es queja.
const HORARIO = /\b(?:hoy|manana|lunes|martes|miercoles|jueves|viernes|sabados?|domingos?|horarios?|horas?|abiertos?|cerrados?|cierran|cierra|temprano|festivos?|feriados?|navidad|vacaciones|puente|noche|tarde|ahorita|semana|cocina|restaurante|local|sucursal|negocio|ustedes|tienda|(?:hasta|a)\s+las|ano\s+nuevo|(?:ya|todavia|aun)\s+no\s+abren?)\b/;
/** ¿El mensaje habla de horario o del local? (exportado para sus pruebas) */
export const hablaDeHorario = (mensaje) => HORARIO.test(normalizar(mensaje));

const CON_OBJETO = [
  new RegExp(`\\b${OBJETO}\\b${PALABRAS}\\s+no\\s+${CLITICOS}${FALLA_CON_OBJETO}\\b`),
  new RegExp(`\\bno\\s+${CLITICOS}${FALLA_CON_OBJETO}\\b${PALABRAS}\\s+${OBJETO}\\b`),
  new RegExp(`\\bno\\s+(?:puedo|podemos|pude|pudimos|${CLITICOS}(?:deja|dejan|dejo))\\s+${ACCION_BLOQUEADA}\\b${PALABRAS}\\s+${OBJETO}\\b`),
  new RegExp(`\\b${OBJETO}\\b${PALABRAS}\\s+se\\s+(?:me\\s+)?(?:cierra|cerro|sale|salio|traba|trabo|congela|congelo)\\b`),
  new RegExp(`\\bse\\s+(?:me\\s+)?(?:cierra|cerro|sale|salio)\\b${PALABRAS}\\s+${OBJETO}\\b`),
];
// A SECAS: el mensaje entero, de principio a fin (ver arriba).
// Antes de la queja: a quién se dirige o un saludo…
const VOCATIVO = '(?:hola|oiga|oigan|oigame|oye|disculpa|disculpe|perdon|joven|senorita|amigo|amiga|pues|es\\s+que'
  + '|pero|y|ahora|ya|todavia|aun|buenas\\s+(?:tardes|noches)|buenos\\s+dias|buen\\s+dia|buenas)';
// …o lo que el cliente ya intentó: «ya le piqué y», «lo intenté dos veces pero».
// Sin «ya», «y» ni «pero» propios (esos son del vocativo): con dos maneras de
// leer la misma palabra, la expresión se vuelve exponencial con la repetición.
const INTENTO = '(?:(?:le|lo|la|los|las)\\s+)?(?:pique|picamos|pico|di|doy|dimos|aprete|aprieto|presione'
  + '|presiono|intente|intento|intentamos|quise|abri|abro|toque|toco)'
  + '(?:\\s+(?:pedir|ordenar|elegir|abrir|abrirlo|abrirla|entrar))?'
  + '(?:\\s+(?:(?:varias|muchas|dos|tres|[0-9]+)\\s+veces|otra\\s+vez|de\\s+nuevo))?';
const ENLACE = '(?:ya|y|pero)';
// Después: relleno que no cambia de qué se queja.
const RELLENO = '(?:nada|nadita|ya|todavia|aun|bien|nunca|tampoco|otra\\s+vez|de\\s+nuevo|para\\s+nada|hacer\\s+nada'
  + '|ni\\s+modo|ayuda|ayudame|auxilio|por\\s+favor|porfa|porfavor|plis|pls|please|que\\s+hago|que\\s+paso|que\\s+pasa'
  + '|que\\s+onda|que\\s+sucede|como\\s+le\\s+hago|como\\s+hago|ok|okey|jaja|jeje|x2|aqui|ahi'
  + '|(?:en|desde)\\s+mi\\s+(?:cel|celular|telefono|movil)'
  // «no puedo elegir los platillos»: lo que se muestra en el formulario, en
  // plural genérico; «otra salsa» u «otro» ya son una pregunta del pedido.
  + '|(?:los|mis)\\s+(?:platillos|productos)|las\\s+(?:cosas|opciones))';
// La queja: «no» + lo que no hace. «abre» solo con pronombre («no me abre»,
// «no se abre»); sin él va aparte, más estricto.
const VERBO_A_SECAS = '(?:carga|cargo|funciona|funciono|aparece|aparecio|jala|responde|sirve)';
const QUEJA = `no\\s+(?:(?:(?:me|le|nos|se|lo|la|te)\\s+)+(?:${VERBO_A_SECAS}|abre|abrio)|${VERBO_A_SECAS}`
  + `|(?:puedo|podemos|pude|pudimos)\\s+${ACCION_BLOQUEADA}|(?:me|le|nos)\\s+(?:deja|dejan|dejo)(?:\\s+${ACCION_BLOQUEADA})?)`;
const A_SECAS = [
  new RegExp(`^(?:(?:${VOCATIVO}|${INTENTO})\\s+)*${QUEJA}(?:\\s+(?:${RELLENO}|(?:(?:y|ni|pero)\\s+)?${QUEJA}))*$`),
  // «No abre» sin pronombre: solo, o tras lo que el cliente intentó («ya le
  // piqué y no abre»); «ya», «y» o «pero» sin un intento no bastan.
  new RegExp(`^(?:(?:${ENLACE}\\s+)*(?:${INTENTO}\\s+(?:${ENLACE}\\s+)*)+)?no\\s+(?:abre|abrio)(?:\\s+${RELLENO})*$`),
];
// Señales de una pantalla trabada o de un error: no admiten otra lectura.
const SIEMPRE = [
  /\bse\s+(?:me\s+)?(?:queda|quedo)\s+(?:cargando|pensando|trabad[oa]|congelad[oa]|en\s+blanco)\b/,
  /\bse\s+(?:me\s+)?(?:traba|trabo|congela|congelo)\b/,
  /\b(?:esta|sigue)\s+(?:trabad[oa]|congelad[oa]|cargando)\b/,
  /\b(?:sale|salio|aparece|aparecio|marca|marco|da|dio|manda|mando)\s+(?:un\s+|el\s+)?error\b/,
  /\bno\s+(?:me\s+|le\s+)?(?:termina|acaba)\s+de\s+cargar\b/,
  /\bsigue\s+sin\s+cargar\b/,
];

export function formularioNoCarga(mensaje) {
  const t = normalizar(mensaje);
  if (!t || t.length > LARGO_MAXIMO) return false;
  if (SIEMPRE.some((r) => r.test(t))) return true;
  const horario = HORARIO.test(t);
  if (CON_OBJETO.some((r) => r.test(t))) return !horario || OBJETO_DE_PANTALLA.test(t);
  // Segunda capa: con el ancla de A_SECAS ninguna palabra de horario cabe hoy
  // en una queja a secas; queda por si alguien amplía el vocativo o el relleno.
  if (horario) return false;
  return A_SECAS.some((r) => r.test(t));
}

// ── EL PREDICADO ÚNICO ───────────────────────────────────────────────────
//
// Cuándo una conversación PUEDE pasar a una persona por rescate. Lo usan los
// dos pasos: el previo al modelo y el posterior al turno. Un toque puro no
// (el botón tiene su propio camino), ni un pedido con folio, un evento, una
// confirmación incierta o un turno que ya terminó en algún hecho.
export function rescatePosible({ cfg, estado, interaccion = null } = {}) {
  return rescateActivo(cfg) && !(interaccion && !interaccion.mixto)
    && !!estado && !estado.folio && !estado.evento && !estado.confirmacionIncierta
    && !Object.values(estado.hechos || {}).some(Boolean);
}

const fallosVigentes = (estado, ahora, ventana) => (Array.isArray(estado?.rescate?.fallos)
  ? estado.rescate.fallos : []).map(Number).filter((t) => Number.isFinite(t) && t <= ahora && ahora - t <= ventana);

/** La respuesta de sistema del rescate: sin modelo, sin pregunta pendiente. */
export function respuestaDeRescate(motivo) {
  return { tipo: 'rescate_humano', motivo, texto: TEXTO_RESCATE, acciones: [], sinSaludo: true, pendiente: null };
}

/**
 * PASO (i), ANTES DEL MODELO. Devuelve la respuesta de sistema o null.
 * `formularioReciente` se consulta al final (es una lectura de la base) y solo
 * si el mensaje ya es un «no carga»: el camino de siempre no paga esa lectura.
 */
export async function rescateAntesDelModelo({
  cfg, estado, mensaje, interaccion = null, ahora = Date.now(), formularioReciente = async () => false,
} = {}) {
  if (!rescatePosible({ cfg, estado, interaccion }) || !formularioNoCarga(mensaje)) return null;
  const falloReciente = fallosVigentes(estado, ahora, ventanaMs(cfg)).length > 0;
  const conFormulario = falloReciente
    || await Promise.resolve().then(formularioReciente).then((v) => v === true, () => false);
  return conFormulario ? respuestaDeRescate(MOTIVOS_RESCATE.FORMULARIO_NO_CARGA) : null;
}

/**
 * Anota el fallo del proveedor de ESTE turno. `fallo_proveedor_sin_efectos`
 * cubre la llamada que lanza (timeout, conexión, 5xx), la respuesta truncada o
 * vacía y el corte por `tiempo_del_turno`: los tres los cierra
 * `retomarInterpretacion`. Con la bandera apagada no toca el estado.
 */
export function registrarFalloDelTurno({ cfg, estado, salida, ahora = Date.now() } = {}) {
  if (!rescateActivo(cfg) || !estado) return false;
  const fallo = salida?.recuperacion === 'fallo_proveedor_sin_efectos';
  const fallos = [...fallosVigentes(estado, ahora, ventanaMs(cfg)), ...(fallo ? [ahora] : [])].slice(-5);
  if (fallos.length || estado.rescate) estado.rescate = { ...(estado.rescate || {}), fallos };
  return fallo;
}

/**
 * PASO (ii), DESPUÉS DEL TURNO. ¿Escalar por rescate? Devuelve { motivo } o null.
 *
 * Si el paso (i) contestó, se escala SIEMPRE, sin volver a evaluar nada: el
 * texto que promete una persona ya está en la salida. Si no, solo el segundo
 * fallo dentro de la ventana, y solo en el turno que acaba de fallar.
 */
export function decidirRescate({ cfg, estado, salida, interaccion = null, previo = null, ahora = Date.now() } = {}) {
  if (salida?.respuestaDeSistema === 'rescate_humano') {
    return { motivo: previo?.motivo || MOTIVOS_RESCATE.FORMULARIO_NO_CARGA };
  }
  if (!rescatePosible({ cfg, estado, interaccion })) return null;
  if (!salida || salida.escalado || salida.handoffPendiente || salida.respuestaDeSistema) return null;
  if (salida.recuperacion !== 'fallo_proveedor_sin_efectos') return null;
  return fallosVigentes(estado, ahora, ventanaMs(cfg)).length >= 2
    ? { motivo: MOTIVOS_RESCATE.FALLO_REPETIDO } : null;
}

/**
 * La salida de un rescate: el texto honesto, ninguna pregunta pendiente y la
 * marca `rescate` que el commit respeta (no arma formulario, botones ni
 * «No pude armar tu pedido» encima, ni siquiera si el handoff falló).
 */
export function aplicarSalidaDeRescate(salida, { motivo, entregado, estado, cierre = null }) {
  salida.rescate = { motivo };
  salida.texto = TEXTO_RESCATE;
  salida.pendienteFinal = null;
  salida.motivoHandoff = motivo;
  if (cierre) salida.motivoCierre = cierre;
  if (entregado) {
    estado.hechos.escalado = true;
    estado.motivoEscalado = motivo;
    salida.escalado = true;
    salida.handoffPendiente = false;
  } else {
    salida.handoffPendiente = true;
  }
  // Una persona ya la tiene (o la tendrá): las marcas viejas no deben volver a
  // disparar otro rescate cuando el equipo devuelva la conversación al bot.
  if (estado.rescate) estado.rescate = { ...estado.rescate, fallos: [] };
  return salida;
}

/**
 * ¿Le llegó a este cliente un formulario de verdad hace poco? Se lee del
 * outbox: entregado como Flow (no como texto de respaldo: `texto_enviado`
 * solo existe cuando salió el respaldo) dentro de la vigencia. Un error de
 * lectura cuenta como «no»: sin evidencia no hay rescate por esta vía.
 */
export async function formularioEntregadoReciente(db, { negocioId, telefono, minutos = VIGENCIA_FORMULARIO_MIN } = {}) {
  if (!db || !negocioId || !telefono) return false;
  try {
    const { rows: [r] } = await db.query(
      `SELECT EXISTS(SELECT 1 FROM agente_outbox
          WHERE negocio_id = $1 AND tipo = 'respuesta_cliente' AND estado = 'entregado'
            AND carga->>'telefono' = $2 AND carga->'interactivo'->>'type' = 'flow'
            AND NOT (carga ? 'texto_enviado')
            AND created_at > now() - make_interval(mins => $3::int + 5)
            AND entregado_at > now() - make_interval(mins => $3::int)) AS reciente`,
      [negocioId, String(telefono), Number(minutos) || VIGENCIA_FORMULARIO_MIN]);
    return r?.reciente === true;
  } catch (e) {
    console.error(`[RESCATE] no se pudo leer el último formulario negocio=${negocioId}: ${e?.message}`);
    return false;
  }
}
