// Reglas deterministas del perfil de catering. Se mantienen fuera de los dos
// prompts (legacy y agente de herramientas) para que ambos canales compartan
// exactamente la misma frontera y la misma barrera de salida.

import { partesFechaHoraCatering } from './comercialMarkers.js';

export const MARCA_SESION_CATERING = '__perfil_catering';
export const MENSAJE_CATERING_ENTREGADO =
  'Gracias, ya registré los datos del evento. Te paso con una persona del equipo para continuar.';
export const MENSAJE_CATERING_REVISION =
  'Te paso con una persona del equipo para continuar con tu solicitud.';

/**
 * Aplica la decisión estricta que el canal ya tomó antes de cualquier atajo de
 * pedido. La devolución booleana se usa como capacidad: `true` significa que
 * preview, registro, cobro y menú quedan fuera de este turno.
 *
 * `invalidarPreview` se inyecta para mantener este contrato puro y probar el
 * orden con un spy; brain.js le pasa el invalidator real de la sesión.
 */
export function aplicarPerfilForzado(control = {}, invalidarPreview = () => {}) {
  const perfil = String(control?.forzarPerfil || '').trim().toLowerCase();
  if (!perfil) return false;
  if (perfil !== 'catering') throw new Error(`PERFIL_FORZADO_NO_SOPORTADO:${perfil}`);
  invalidarPreview();
  return true;
}

/** Una discrepancia entre las dos lecturas de configuración siempre cierra. */
export function exigirCateringForzadoDisponible(cateringForzado, { moduloHabilitado, perfilComercial } = {}) {
  if (cateringForzado && (!moduloHabilitado || perfilComercial !== 'catering')) {
    throw new Error('PERFIL_CATERING_FORZADO_NO_DISPONIBLE');
  }
  return cateringForzado;
}

const comparable = (texto) => String(texto || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase();

const SERVICIO_EXPLICITO = /\b(?:catering|caterin|banquetes?|mesas?\s+de\s+postres?|coffee\s*breaks?|buff?ets?|taquizas?|servicio\s+de\s+alimentos)\b/g;
const NEGACION_SERVICIO = /\b(?:no\s+(?:quiero|necesito|busco|requiero|deseo|me\s+interesa|es|seria)|sin)\s+(?:(?:un|el)\s+)?(?:servicio\s+de\s+)?(?:catering|caterin|banquetes?|mesas?\s+de\s+postres?|coffee\s*breaks?|buff?ets?|taquizas?)\b/g;
const NEGACION_SERVICIO_POSTERIOR = /\b(?:catering|caterin|banquetes?|mesas?\s+de\s+postres?|coffee\s*breaks?|buff?ets?|taquizas?)\s+(?:no|tampoco)\b/g;
const NEGACION_COMIDA_GRUPO = /\b(?:no\s+(?:quiero|necesito|busco|requiero|deseo)|sin)\s+(?:comida|alimentos|desayuno|cena|almuerzo)\b/g;
const PALABRAS_EVENTO = /\b(?:eventos?|fiestas?|bodas?|cumpleanos|reunion(?:es)?|juntas?|congresos?|graduacion(?:es)?|posadas?|bautizos?|comunion(?:es)?|celebracion(?:es)?|corporativos?|empresariales?)\b/;
const COTIZACION = /\b(?:cotizacion|cotizar|presupuesto|presupuestar)\b/;
const NECESIDAD_EVENTO = /\b(?:servicio|paquete|comida|alimentos|desayuno|cena|almuerzo|menu)\b/;
const CONSULTA_EVENTOS = /\b(?:(?:pueden\s+)?(?:hacer|atender|organizar|realizar|ofrecer|dar)|hacen|manejan|atienden|organizan|realizan|ofrecen|dan|tienen|trabajan)\s+(?:(?:servicios?|paquetes?)\s+(?:de|para)\s+|con\s+)?(?:(?:mi|un|una|el|la|nuestro|nuestra)\s+)?(?:eventos?|banquetes?|fiestas?|bodas?|cumpleanos|reunion(?:es)?|juntas?|congresos?|graduacion(?:es)?|posadas?|bautizos?|comunion(?:es)?|celebracion(?:es)?)\b/;
const DESEO_ORGANIZAR_EVENTO = /\b(?:(?:quiero|necesito|quisiera)\s+(?:que\s+)?|busco\s+(?:(?:a\s+)?alguien\s+que\s+|quien\s+)?)(?:hacer|atender|organizar|realizar|ofrecer|festejar|celebrar|contratar|atiendan|organicen|realicen|ofrezcan|festejen|celebren|hagan|atienda|organice|realice|ofrezca|festeje|celebre|haga)\s+(?:(?:mi|un|una|el|la|nuestro|nuestra)\s+)?(?:evento|fiesta|boda|cumpleanos|reunion|junta|congreso|graduacion|posada|bautizo|comunion|celebracion)\b/;
const DESTINO_EVENTO = /\bpara\s+(?:(?:un|una|el|la|mi|nuestro|nuestra)\s+)?(?:eventos?|fiestas?|bodas?|cumpleanos|reunion(?:es)?|juntas?|congresos?|graduacion(?:es)?|posadas?|bautizos?|comunion(?:es)?|celebracion(?:es)?)\b/;

// Se usan también para decidir si «cancela X, mejor Y» abandona la ficha o
// solo cambia el tipo de servicio. El objeto va en forma no codiciosa para no
// tragarse Y cuando ambos servicios aparecen en la misma frase.
const NEGACION_DE_CANCELAR = /\b(?:no|nunca)\s+(?:(?:quiero|necesito|deseo|busco|quisiera|pienso|voy\s+a)\s+)?(?:cancelar|olvidar|descartar|canceles|olvides|descartes)\b/g;
const CANCELACION_DIRECTA = /\b(?:cancela|cancelar|olvida|olvidar|descarta|descartar)\b.{0,45}?\b(?:solicitudes?(?:\s+(?:de|del)\s+(?:catering|caterin|eventos?|banquetes?|mesas?\s+de\s+postres?|coffee\s*breaks?|buff?ets?|taquizas?|fiestas?|bodas?))?|servicios?(?:\s+(?:de|del)\s+(?:catering|caterin|eventos?|banquetes?|mesas?\s+de\s+postres?|coffee\s*breaks?|buff?ets?|taquizas?|fiestas?|bodas?))?|catering|caterin|eventos?|banquetes?|mesas?\s+de\s+postres?|coffee\s*breaks?|buff?ets?|taquizas?|fiestas?|bodas?)\b/g;

/**
 * Detecta solo el inicio de una solicitud de evento. Las continuaciones se
 * reconocen por la sesión comercial activa, así un "20 personas" posterior
 * nunca vuelve a entrar al flujo de pedidos.
 */
export function esSolicitudCatering(texto = '') {
  const t = comparable(texto).trim();
  if (!t) return false;

  // Una negación explícita no puede secuestrar un pedido normal. Se elimina
  // solo el servicio negado: «no quiero catering, prefiero mesa de postres»
  // conserva la segunda señal y sí entra.
  const afirmado = t
    .replace(NEGACION_SERVICIO, ' ')
    .replace(NEGACION_SERVICIO_POSTERIOR, ' ')
    .replace(NEGACION_COMIDA_GRUPO, ' ');
  SERVICIO_EXPLICITO.lastIndex = 0;
  if (SERVICIO_EXPLICITO.test(afirmado)) return true;

  const hablaDeEvento = PALABRAS_EVENTO.test(afirmado);
  if (CONSULTA_EVENTOS.test(afirmado)) return true;
  if (DESEO_ORGANIZAR_EVENTO.test(afirmado)) return true;
  if (hablaDeEvento && (COTIZACION.test(afirmado) || NECESIDAD_EVENTO.test(afirmado))) return true;
  if (/\b(?:servicio|paquete)\s+(?:para|de)\s+(?:un\s+|mi\s+)?evento\b/.test(afirmado)) return true;
  if (DESTINO_EVENTO.test(afirmado)) return true;

  // El volumen NUNCA decide el perfil. «30 desayunos para recoger» sigue
  // siendo un pedido normal: para desviar a catering hace falta que el cliente
  // diga catering/evento/banquete u otra señal explícita de servicio.
  return false;
}

/**
 * Salida explícita de una ficha de evento hacia un pedido normal. Una
 * negación sola no basta si en la misma frase el cliente elige otro servicio
 * de evento (p. ej. «no catering, mejor mesa de postres»).
 */
export function cancelaSolicitudCatering(texto = '') {
  const t = comparable(texto).trim();
  if (!t) return false;
  const sinNegacionesDeCancelar = t.replace(NEGACION_DE_CANCELAR, ' ');
  CANCELACION_DIRECTA.lastIndex = 0;
  const cancelacionDirecta = CANCELACION_DIRECTA.test(sinNegacionesDeCancelar);
  CANCELACION_DIRECTA.lastIndex = 0;
  if (cancelacionDirecta) {
    const resto = sinNegacionesDeCancelar.replace(CANCELACION_DIRECTA, ' ');
    // Cambiar catering por otro servicio de evento conserva la ficha. La
    // alternativa sí tiene una señal positiva propia después de retirar el
    // fragmento cancelado; no se confunde con el objeto que se acaba de negar.
    if (esSolicitudCatering(resto)) return false;
    return true;
  }
  if (esSolicitudCatering(texto)) return false;
  const niegaEvento = /\b(?:catering|caterin|evento|banquete|servicio)\s+(?:no|ya\s+no)\b/.test(t)
    || /\b(?:no|ya\s+no)\s+(?:quiero|necesito|busco|requiero|deseo|me\s+interesa)?\s*(?:el\s+|un\s+)?(?:catering|caterin|evento|banquete|servicio)\b/.test(t)
    || /\b(?:cancela|cancelar|olvida|olvidar|descarta|descartar)\b.{0,30}\b(?:catering|evento|solicitud)\b/.test(t);
  return niegaEvento;
}

/**
 * Las sesiones nuevas llevan una marca interna. Para no cortar una solicitud
 * legítima iniciada antes de este cambio, también reconocemos una sesión legacy
 * que ya tenga al menos un dato inequívocamente propio de evento. Una sesión
 * vacía o con solo nombre NO basta: esas fueron las que anclaron pedidos
 * normales al clasificador comercial.
 */
export function esSesionCatering(sesion) {
  const campos = sesion?.campos_capturados || sesion || {};
  return campos[MARCA_SESION_CATERING] === true
    || ['numero_personas', 'lugar', 'fecha_evento', 'fecha_evento_iso', 'tipo_evento', 'tipo_servicio']
      .some((campo) => campos[campo] !== null && campos[campo] !== undefined && String(campos[campo]).trim());
}

/** Campos internos/ya conocidos con los que nace o se adopta una sesión. */
export function marcarSesionCatering(campos = {}, { nombre = null } = {}) {
  return {
    ...campos,
    [MARCA_SESION_CATERING]: true,
    ...(!campos.nombre && nombre ? { nombre: String(nombre).trim() } : {}),
  };
}

/**
 * Segunda barrera: el prompt orienta al modelo; esta función decide qué texto
 * puede salir. Devuelve un código estable para traza/pruebas, o null.
 */
export function motivoRespuestaCateringProhibida(texto = '') {
  const bruto = String(texto || '');
  const t = comparable(bruto);
  if (!t.trim()) return 'respuesta_vacia';
  if (/<\/?(?:ORDEN|PEDIDO|BORRADOR)_[A-Z_]+>/i.test(bruto)) return 'marcador_transaccional';
  if (/[$€£]/.test(bruto)
      || /\b(?:mxn|pesos?|precios?|cuesta|costos?|costaria|tarifas?|vale|cotiz\w*|presupuest\w*)\b/.test(t)) return 'precio';
  if (/\b(?:agendad[oa]|reservad[oa]|apartad[oa]|confirmad[oa]|programad[oa])\b/.test(t)
      || /\b(?:agende|reserve|aparte|confirme|program[eé])\b.{0,45}\b(?:evento|servicio|fecha)\b/.test(t)) return 'agenda';
  if (/\b(?:disponibilidad|disponible)\b/.test(t)
      || /\b(?:te|le)\s+(?:ofrezco|ofrecemos|propongo|proponemos)\b/.test(t)) return 'promesa_comercial';
  return null;
}

/** La siguiente pregunta también la decide Xabor, nunca la improvisa el modelo. */
export function preguntaSiguienteCatering(campos = {}) {
  if (!String(campos.nombre || '').trim()) {
    return '¿A nombre de quién registramos los datos del evento?';
  }
  if (!Number.isFinite(Number(campos.numero_personas)) || Number(campos.numero_personas) <= 0) {
    return '¿Para cuántas personas sería el evento?';
  }
  if (!String(campos.lugar || '').trim()) {
    return '¿En qué lugar sería el evento?';
  }
  const { tieneFecha, tieneHora } = partesFechaHoraCatering(campos);
  if (!tieneFecha && !tieneHora) {
    return '¿Qué fecha concreta y a qué hora o franja sería el evento?';
  }
  if (!tieneFecha) return '¿Qué fecha concreta tienen contemplada para el evento?';
  if (!tieneHora) return '¿A qué hora o en qué franja sería el evento?';
  return null;
}

/**
 * Decide la frontera de salida del perfil sin ejecutar efectos. El canal usa
 * esta misma función que las pruebas: el texto del modelo nunca decide si se
 * cotizó, agendó o completó la ficha.
 */
export function decidirSalidaCatering(resultado = {}) {
  if (resultado?.orden || /<ORDEN_CONFIRMADA>/i.test(String(resultado?.texto || ''))) {
    return { accion: 'revision', motivo: 'orden_generada', texto: MENSAJE_CATERING_REVISION };
  }
  if (resultado?.marcadorTruncado) {
    return { accion: 'revision', motivo: 'respuesta_truncada', texto: MENSAJE_CATERING_REVISION };
  }
  if (resultado?.cateringCierrePrematuro) {
    return { accion: 'revision', motivo: 'cierre_sin_datos', texto: MENSAJE_CATERING_REVISION };
  }
  const violacion = resultado?.cateringViolacion
    || motivoRespuestaCateringProhibida(resultado?.texto);
  if (violacion && !resultado?.cateringListo) {
    return { accion: 'revision', motivo: `salida_prohibida:${violacion}`, texto: MENSAJE_CATERING_REVISION };
  }
  if (resultado?.cateringListo) {
    return { accion: 'entregar', motivo: 'datos_listos', texto: MENSAJE_CATERING_ENTREGADO };
  }
  if (!String(resultado?.texto || '').trim()) {
    return { accion: 'revision', motivo: 'respuesta_vacia', texto: MENSAJE_CATERING_REVISION };
  }
  const pregunta = resultado?.cateringCampos
    ? preguntaSiguienteCatering(resultado.cateringCampos)
    : null;
  if (pregunta) return { accion: 'responder', motivo: null, texto: pregunta };
  return { accion: 'responder', motivo: null, texto: String(resultado.texto).trim() };
}
