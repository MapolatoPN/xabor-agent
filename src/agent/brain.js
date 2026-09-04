import Anthropic from '@anthropic-ai/sdk';
import { getIntegracion, broadcastNegocio } from '../server.js';
import { construirSystemPrompt, construirBloqueModoComercial, BLOQUE_REGLAS_CONTEXTO_VISUAL, hayContextoVisual } from './prompts.js';
import { agregarMensaje, getSession, guardarPreviewPedido, consumirPreviewPedido, marcarPreviewNoConfirmable,
         verPreviewPedido, verPreviewConfirmable, restaurarPreviewPedido, invalidarPreviewPedido,
         reemplazarUltimoMensajeAsistente, turnosUsuarioDelCiclo, iniciarCicloPedido } from './session.js';
import { INSTRUCCION_MENCIONES, parsearMenciones, depurarMenciones } from './mencionesComerciales.js';
import { clasificarTurnoPostPreview } from './confirmacionVerbal.js';
import { obtenerPerfilCliente, construirContextoCliente, registrarEvento, actualizarOportunidad, EVENTOS } from '../services/memory.js';
import { obtenerEstadoModulo, pool } from '../services/database.js';
import { detectarIntencionComercial, activaModoComercial } from './intentDetector.js';
import { obtenerSesionActiva, obtenerOCrearSesionActiva, actualizarCamposSesion, marcarSesionComoErrorRecuperable } from '../services/sesionComercial.js';
import { extraerCamposComerciales, tieneBorradorListo, limpiarBloqueComercial, fusionarCamposCapturados } from './comercialMarkers.js';
import { generarBorradorDesdeSesion } from '../services/draftBuilder.js';
import { notificarBorradorAlAdmin } from '../services/notificacionBorradorAdmin.js';
import { normalizarFormatoWhatsApp } from '../utils/formatoWhatsapp.js';
import { previsualizarPedido, resumenPedidoOficial } from '../orders/orderManager.js';
import { mensajeRechazoParaCliente, validarBorradorPedido, mensajeBorradorParaCliente } from '../orders/validadorOrden.js';
import { decidirConfirmacion, huellaOrden } from './confirmacionPolicy.js';
import { responderConsultaPromos } from '../services/tiendaPromociones.js';
import { explicarPromosNoAplicadas } from '../services/promoDiagnostico.js';

// Cliente lazy — se crea en runtime para respetar config desde panel
let _anthropic = null;
function getAnthropic() {
  const key = getIntegracion('anthropic_api_key') || process.env.ANTHROPIC_API_KEY;
  if (!_anthropic || _anthropic.apiKey !== key) _anthropic = new Anthropic({ apiKey: key });
  return _anthropic;
}

// Modelo: haiku es rápido y barato, ideal para conversaciones
const MODELO = 'claude-haiku-4-5-20251001';

// El proveedor devuelve 529 (overloaded) en picos de carga: es transitorio y le
// costaba al cliente un turno completo ("Disculpa, tuve un problema...").
// Reintento ACOTADO con backoff exponencial + jitter — nunca un bucle: como
// mucho dos reintentos, y si sigue fallando el error sube tal cual para que el
// canal responda con honestidad. No duplica ejecuciones: solo se reintenta la
// llamada al modelo, que no tiene efectos colaterales.
const REINTENTOS_LLM = 2;
const esSobrecarga = (e) => e?.status === 529 || e?.status === 429 ||
  /overloaded|rate.?limit/i.test(String(e?.message || ''));

async function llamarModeloConReintento(params, { etiqueta = 'brain' } = {}) {
  let ultimo;
  for (let intento = 0; intento <= REINTENTOS_LLM; intento++) {
    const t0 = Date.now();
    try {
      return await getAnthropic().messages.create(params);
    } catch (e) {
      ultimo = e;
      const latencia = Date.now() - t0;
      if (!esSobrecarga(e) || intento === REINTENTOS_LLM) {
        if (esSobrecarga(e)) {
          console.error(`[LLM] provider=anthropic status=${e?.status || '529'} intento=${intento + 1}/${REINTENTOS_LLM + 1} latencia=${latencia}ms — agotados los reintentos`);
        }
        throw e;
      }
      // 400ms, 800ms (+ jitter de hasta 250ms) — corto: hay un cliente esperando.
      const espera = 400 * Math.pow(2, intento) + Math.floor(Math.random() * 250);
      console.warn(`[LLM] provider=anthropic status=${e?.status || '529'} intento=${intento + 1} latencia=${latencia}ms — reintentando en ${espera}ms (${etiqueta})`);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
  throw ultimo;
}

// ─── Versión normal (WhatsApp, Rappi, panel) ─────────────────────────────────
// negocioId: pasado tal cual por el llamador (ya resuelto de forma segura --
// integraciones_canal para WhatsApp, sesión autenticada para el panel).
// Nunca se resuelve aquí, nunca cae a un negocio por defecto -- ver
// construirSystemPrompt para el detalle de fail-closed en Rewards.
//
// telefonoExplicito (P1, hotfix): el número real del remitente, pasado
// SIEMPRE que el llamador lo tenga disponible -- independiente de
// clienteCtx, que solo existe cuando el cliente YA tenía un registro
// previo (clienteCtx null es la señal intencional de "cliente nuevo" para
// el bloque "cliente recurrente" de construirSystemPrompt, y eso NO
// cambia aquí). Antes, tanto la memoria de cliente como el Asistente
// Comercial derivaban `telefono` únicamente de `clienteCtx?.telefono`, así
// que el primer mensaje de un cliente genuinamente nuevo (clienteCtx aún
// null en ese instante) nunca podía activar ninguna de las dos, sin
// importar lo que dijera -- ver whatsapp-meta.js, que ahora sí pasa el
// teléfono real del webhook en todos los casos.
/**
 * Registra el pedido a partir del snapshot canónico del último preview.
 *
 * SIEMPRE revalida con el pipeline oficial antes de escribir: el snapshot no
 * salta validaciones, solo evita que el modelo tenga que recordar el pedido.
 *  - total igual        → consume el snapshot y devuelve la orden canónica
 *                         (el canal la registra y redacta el cierre real).
 *  - total distinto     → NO registra: muestra el nuevo resumen y pide
 *                         confirmar otra vez (política two-phase intacta).
 *  - ya no es válida    → invalida el snapshot y explica con honestidad.
 * Devuelve null si no pudo tomar el snapshot (otro turno lo consumió antes).
 */
async function confirmarDesdeSnapshot(sessionId, negocioId, canal) {
  // Solo un snapshot CONFIRMABLE autoriza. Si un turno anterior quedó
  // indeterminado, aquí no se registra: se devuelve null y el flujo normal
  // resuelve la conversación (y, si procede, produce un preview nuevo).
  const snap = verPreviewConfirmable(sessionId);
  if (!snap) return null;
  let v;
  try {
    v = await previsualizarPedido(snap.ordenCanonica, negocioId, { canal });
  } catch (e) {
    console.error('[brain] revalidación de snapshot:', e.message);
    return null; // sigue el flujo normal; nunca se registra a ciegas
  }
  if (!v.ok) {
    invalidarPreviewPedido(sessionId);
    console.error(`[TXN] evento=snapshot_invalido negocio=${negocioId}`);
    return { texto: mensajeRechazoParaCliente(v.rechazos || []), orden: null, sessionId };
  }
  if (Number(v.preview.total) !== Number(snap.total)) {
    // El precio cambió entre el resumen y el "sí": no se registra en silencio.
    const nuevo = guardarPreviewPedido(sessionId, snapshotDePreview(v));
    console.error(`[TXN] evento=total_cambio_en_confirmacion negocio=${negocioId} previo=${snap.total} nuevo=${nuevo.total}`);
    const texto = `Hubo un cambio en el total de tu pedido.\n\n${resumenPedidoOficial(v.preview)}`;
    reemplazarUltimoMensajeAsistente(sessionId, texto);
    agregarMensaje(sessionId, 'assistant', texto);
    return { texto, orden: null, sessionId };
  }
  // Consumo ATÓMICO: si dos turnos concurrentes llegan aquí, solo uno obtiene
  // el snapshot; el otro recibe null y no registra nada (un único folio).
  const tomado = consumirPreviewPedido(sessionId);
  if (!tomado) {
    console.warn(`[TXN] evento=confirmacion_duplicada_ignorada negocio=${negocioId}`);
    return { texto: '', orden: null, sessionId, duplicada: true };
  }
  console.log(`[TXN] evento=confirmacion_desde_snapshot negocio=${negocioId} total=${tomado.total}`);
  // El carrito deja de estar en construcción: lo dicho hasta aquí pertenece a
  // ESTE pedido y no puede respaldar selecciones del siguiente.
  iniciarCicloPedido(sessionId);
  // El texto lo redacta el canal tras la escritura real (folio + total). Aquí
  // no se afirma nada: el pedido todavía no existe.
  return { texto: '', orden: tomado.ordenCanonica, sessionId, desdeSnapshot: true, snapshot: tomado };
}

// ¿La respuesta ya la redactó el backend (no el modelo)? Esos turnos no
// necesitan validación de borrador: no hay nada que el modelo haya afirmado.
function esRespuestaDeSistema(texto) {
  return /<ORDEN_PREVIEW>|<ORDEN_CONFIRMADA>|<CONSULTA_PROMOS>/.test(String(texto || ''));
}

/**
 * ¿El mensaje del cliente menciona algún producto del catálogo REAL?
 *
 * Es la señal que decide si un turno sin borrador merece exigirlo. Se compara
 * contra los nombres del menú del negocio —nunca contra una lista escrita a
 * mano—, así que sirve igual para cualquier tenant. Basta con una palabra
 * significativa del nombre para no depender de que el cliente escriba el
 * nombre completo ("licuado" basta para "Licuado de la casa").
 */
async function mencionaProductoDelMenu(mensaje, negocioId) {
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const texto = ` ${norm(mensaje)} `;
  if (!texto.trim()) return false;
  try {
    const { rows } = await pool.query(
      `SELECT p.nombre FROM menu_productos p JOIN menu_categorias c ON c.id = p.categoria_id
        WHERE p.negocio_id = $1 AND p.disponible IS NOT FALSE AND c.activa`, [negocioId]);
    for (const r of rows) {
      const palabras = norm(r.nombre).split(' ').filter((w) => w.length >= 4);
      if (palabras.some((w) => texto.includes(` ${w} `) || texto.includes(` ${w}s `))) return true;
    }
  } catch (e) { console.error('[brain] mencionaProductoDelMenu:', e.message); }
  return false;
}

/**
 * Segunda llamada ACOTADA que extrae el pedido en curso cuando el modelo no
 * emitió su borrador. Es lo que convierte la validación en obligatoria en vez
 * de depender de que el modelo se acuerde: si el turno tocaba un producto, el
 * borrador se obtiene igual.
 *
 * Deliberadamente barata: solo el historial reciente, sin menú ni reglas, con
 * un techo bajo de tokens. Devuelve null si el turno era una consulta.
 */
async function extraerBorradorForzado(session, negocioId) {
  const historial = (session.mensajes || []).slice(-6);
  if (!historial.length) return null;
  const r = await llamarModeloConReintento({
    model: MODELO,
    max_tokens: 400,
    system: 'Extrae el pedido que el cliente está armando en esta conversación, TAL CUAL lo pidió, '
      + 'incluso si algo parece no existir en el menú (no lo corrijas ni lo sustituyas). '
      + 'Responde SOLO con JSON: {"items":[{"nombre":"...","cantidad":1,'
      + '"modificadores":[{"grupo":"...","opciones":["..."]}],"notas":"..."}]}. '
      + 'Usa el nombre del grupo que corresponda a cada opción (sabor, tamaño, leche, etc.). '
      + 'Si el cliente solo pregunta algo y NO está armando un pedido, responde {"items":[]}.',
    messages: historial,
  }, { etiqueta: 'borrador' });
  const txt = r?.content?.[0]?.text || '';
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const draft = JSON.parse(m[0]);
    return Array.isArray(draft?.items) && draft.items.length ? draft : null;
  } catch { return null; }
}

/**
 * Extracción INDEPENDIENTE de lo que el cliente dijo en su último turno.
 *
 * Corre aunque el modelo haya emitido un borrador impecable, porque el borrador
 * no es autoridad sobre el mensaje del cliente: es la interpretación de un
 * modelo que ya demostró omitir y sustituir atributos. Esta llamada solo ve el
 * texto del cliente —ni menú, ni reglas, ni la respuesta del primer modelo—,
 * así que no puede contagiarse de esa interpretación.
 *
 * Su salida NO se cree: `depurarMenciones` comprueba que cada span exista
 * literalmente en el mensaje y esté en posición de atributo. Un extractor que
 * alucine "fresa" sobre un mensaje que dice "mango" no pasa esa comprobación.
 */
async function extraerMencionesComerciales(mensajeUsuario) {
  const texto = String(mensajeUsuario || '').trim();
  if (!texto) return { menciones: [], respuestas: [] };
  const r = await llamarModeloConReintento({
    model: MODELO,
    max_tokens: 300,
    system: INSTRUCCION_MENCIONES,
    messages: [{ role: 'user', content: texto }],
  }, { etiqueta: 'menciones' });
  const depuradas = depurarMenciones(parsearMenciones(r?.content?.[0]?.text || ''), texto);
  if (depuradas.descartadas.length) {
    console.warn(`[TXN] evento=mencion_descartada detalle=${JSON.stringify(depuradas.descartadas.slice(0, 5))}`);
  }
  return { menciones: depuradas.atributos, respuestas: depuradas.respuestas };
}

// Snapshot canónico de un preview válido: lo que el backend YA validó.
function snapshotDePreview(v) {
  return {
    ordenCanonica: v.orden,
    total: v.preview.total,
    promociones: v.preview.promociones || [],
    ts: Date.now(),
    fingerprint: huellaOrden(v.orden),
  };
}

export async function procesarMensaje(sessionId, mensajeUsuario, clienteCtx = null, canal = null, negocioId = null, telefonoExplicito = null) {
  agregarMensaje(sessionId, 'user', mensajeUsuario);
  const session = getSession(sessionId);

  // ── CONFIRMACIÓN DETERMINISTA SOBRE EL PREVIEW OFICIAL ──────────────────
  // Una vez que Xabor mostró un resumen oficial, el "sí" del cliente confirma
  // ESE pedido canónico: se registra desde el snapshot, sin pedirle al modelo
  // que lo reconstruya. Antes dependía de que volviera a emitir
  // <ORDEN_CONFIRMADA>; cuando no lo hacía, el bot decía "pedido confirmado" y
  // no existía ningún folio (caso real Mapolato, preview de $255).
  // Va ANTES de cualquier llamada al modelo: es determinista, no cuesta
  // latencia y no puede caerse por un 529 del proveedor.
  if (verPreviewPedido(sessionId) && typeof negocioId === 'string' && negocioId.trim()) {
    // Cuatro estados. El cuarto es el que hace seguro al sistema: si NO sabemos
    // si el mensaje cambia el pedido, no se borra el snapshot (el flujo normal
    // puede resolverlo y producir un preview nuevo) pero deja de ser
    // confirmable — nunca se registra un pedido que quizá ya no es el que el
    // cliente quiere. Frases como "los quiero rojos" o "quiero pollo en el
    // segundo" caen aquí: son mutaciones que ningún detector léxico razonable
    // reconocería, y tratarlas como consulta sería fail-open.
    const clase = clasificarTurnoPostPreview(mensajeUsuario);
    if (clase === 'mutacion') {
      invalidarPreviewPedido(sessionId);
      console.log(`[TXN] evento=preview_invalidado_por_cambio negocio=${negocioId}`);
    } else if (clase === 'confirmacion') {
      const resuelto = await confirmarDesdeSnapshot(sessionId, negocioId, canal);
      if (resuelto) return resuelto;
    } else if (clase === 'indeterminado') {
      marcarPreviewNoConfirmable(sessionId);
      console.log(`[TXN] evento=preview_no_confirmable_turno_indeterminado negocio=${negocioId}`);
    }
    // 'consulta_segura': el snapshot se conserva confirmable y el flujo normal
    // responde la pregunta.
  }

  // Enriquecer contexto con memoria del cliente (no bloquea si falla)
  const telefono = telefonoExplicito || clienteCtx?.telefono;
  let memoriaCtx = '';
  let nombreConocido = clienteCtx?.nombre || null;
  if (telefono && telefono !== '—' && typeof negocioId === 'string' && negocioId.trim()) {
    const perfil = await obtenerPerfilCliente(telefono, negocioId);
    memoriaCtx = construirContextoCliente(perfil);
    nombreConocido = nombreConocido || perfil?.nombre || null;
  }

  // ── DATOS QUE XABOR YA TIENE ────────────────────────────────────────────
  // WhatsApp entrega el número en el webhook y aun así el bot lo pedía: el
  // contexto de cliente (memory.js) devuelve cadena VACÍA cuando no hay perfil
  // con nombre, así que un cliente nuevo llegaba al prompt sin ningún dato y el
  // modelo, obedeciendo su guion, preguntaba nombre y teléfono. Eso, sumado a
  // repreguntar la modalidad, fue el interrogatorio que hizo abandonar a una
  // clienta real ("Tanto para hacer un pedido!?").
  //
  // Esto NO sustituye ninguna validación: el pedido se sigue armando y
  // validando igual. Solo evita preguntar lo que ya se sabe.
  const datosConocidos = [];
  if (telefono && telefono !== '—') datosConocidos.push(`Teléfono: ${telefono}`);
  if (nombreConocido) datosConocidos.push(`Nombre: ${nombreConocido}`);
  const bloqueDatosConocidos = datosConocidos.length
    ? `\n\n## DATOS QUE YA TIENES DE ESTE CLIENTE (no los preguntes)\n${datosConocidos.join('\n')}\n`
      + `Úsalos tal cual al armar el pedido. Pregunta ÚNICAMENTE lo que no esté en esta lista.\n`
      + `Si ya te dio la modalidad, la dirección o la forma de pago en esta conversación, tampoco vuelvas a pedirlas.\n`
    : '';

  // Asistente Comercial de Cotizaciones (Fase 1-2): IntentDetector decide
  // si este mensaje activa/continúa el modo comercial. Nunca se activa
  // sin negocioId+telefono válidos, ni si el negocio no tiene el módulo
  // dedicado 'asistente_comercial_cotizaciones' habilitado (migración 028
  // -- separado de 'generador_cotizaciones', que solo gatea el generador
  // MANUAL del panel; el asistente por WhatsApp es una capacidad
  // independiente, activable/desactivable por negocio sin afectar al
  // generador manual). Ante cualquier error de clasificación, la
  // categoría cae a 'ambiguo' y nunca se activa -- fail-closed, el flujo
  // normal de pedidos nunca se ve interrumpido por esta pieza.
  let sesionComercial = null;
  let bloqueComercial = '';
  if (telefono && telefono !== '—' && typeof negocioId === 'string' && negocioId.trim()) {
    try {
      const moduloHabilitado = (await obtenerEstadoModulo(negocioId, 'asistente_comercial_cotizaciones')) === 'activo';
      const sesionExistente = await obtenerSesionActiva(negocioId, telefono);
      const categoria = await detectarIntencionComercial({
        mensaje: mensajeUsuario,
        moduloHabilitado,
        estadoComercialActual: sesionExistente?.estado || null,
        apiKey: getIntegracion('anthropic_api_key'),
      });
      if (activaModoComercial(categoria)) {
        sesionComercial = sesionExistente || await obtenerOCrearSesionActiva(negocioId, telefono);
        bloqueComercial = construirBloqueModoComercial(sesionComercial.campos_capturados);
      }
    } catch (e) {
      console.error('[brain] Error evaluando modo comercial (se continúa sin activarlo):', e.message);
    }
  }

  // Registrar evento (asíncrono, no bloquea respuesta)
  if (telefono) {
    registrarEvento({
      tipo: EVENTOS.MENSAJE_RECIBIDO,
      entidad_tipo: 'cliente',
      entidad_id: telefono,
      payload: { texto: mensajeUsuario.slice(0, 200) },
      canal: canal || 'whatsapp',
      sesion_id: sessionId
    });
  }

  // Causa OFICIAL de que una promoción no se haya aplicado al último preview.
  // Se calculó en el turno del preview y se conserva para que, si el cliente
  // pregunta después "¿y la promo?", el modelo tenga el motivo real en vez de
  // inventar uno o prometer un ajuste futuro (caso XAB-0229).
  const bloquePromoNoAplicada = session.promoNoAplicada
    ? `\n\n## POR QUÉ NO APLICÓ LA PROMOCIÓN (dato oficial de Xabor)\n${session.promoNoAplicada}\n`
      + `Si el cliente pregunta por la promoción o por el descuento, explícale ESTO con tus palabras y ofrécele cambiar las opciones para que aplique o continuar con el total ya mostrado. NUNCA digas que se aplicará después ni que el sistema lo ajustará.\n`
    : '';

  try {
    const respuesta = await llamarModeloConReintento({
      model: MODELO,
      max_tokens: 1024,
      // Las reglas del contexto visual solo se pagan cuando la sesión trae
      // una foto analizada (Vision V2); el resto de turnos no cambia.
      system: await construirSystemPrompt(clienteCtx, canal, negocioId) + memoriaCtx + bloqueDatosConocidos + bloqueComercial
        + bloquePromoNoAplicada
        + (hayContextoVisual(session.mensajes) ? BLOQUE_REGLAS_CONTEXTO_VISUAL : ''),
      messages: session.mensajes
    });

    const textoRespuesta = respuesta.content[0].text;
    agregarMensaje(sessionId, 'assistant', textoRespuesta);

    const orden = extraerOrden(textoRespuesta);

    // ── VALIDACIÓN CONVERSACIONAL DE CATÁLOGO (antes de que el cliente lea nada) ──
    // Proteger el preview y el registro no bastaba: el agente podía REAFIRMAR
    // una opción inexistente durante la charla ("un licuado de mango grande"),
    // mucho antes de que hubiera una orden que validar. El backend impedía
    // venderlo, pero no impedía prometerlo.
    //
    // Por eso esto NO es opcional para el modelo. Si el turno toca un producto
    // y no emitió su borrador, se le pide EXPLÍCITAMENTE en una segunda llamada
    // acotada (`extraerBorradorForzado`): la validación ocurre igual. Y cuando
    // el backend encuentra algo que no existe, su respuesta REEMPLAZA al texto
    // del modelo — la verdad del catálogo no se negocia con la redacción.
    let textoCatalogo = null;
    // `!sesionComercial`: un turno del Asistente Comercial NO está armando un
    // pedido del menú — está capturando los campos de una COTIZACIÓN. Contrastar
    // su texto contra el catálogo no protege nada (ese flujo no vende productos
    // del menú ni llega a preview) y sí cuesta una llamada extra al modelo por
    // turno. El guard es deliberadamente estrecho: solo apaga esta validación
    // CONVERSACIONAL. Todo lo transaccional —<ORDEN_PREVIEW>, validarOrdenPropuesta,
    // modificadores, cardinalidad, confirmación determinista y registro— sigue
    // corriendo igual, tenga o no sesión comercial.
    if (typeof negocioId === 'string' && negocioId.trim() && !orden && !sesionComercial
        && !esRespuestaDeSistema(textoRespuesta)) {
      try {
        let borrador = extraerBloque(textoRespuesta, 'PEDIDO_BORRADOR');
        // Un borrador VACÍO no es evidencia de nada. Antes bastaba con que el
        // modelo emitiera `{"items":[]}` —JSON válido, marcador presente— para
        // apagar por completo la extracción independiente: el marcador
        // obligatorio se había vuelto la llave que desactivaba la única defensa
        // que no dependía del modelo. Lo que decide ahora es si HAY ítems.
        const conItems = (b) => Array.isArray(b?.items) && b.items.length > 0;
        if (!conItems(borrador) && await mencionaProductoDelMenu(mensajeUsuario, negocioId)) {
          borrador = await extraerBorradorForzado(session, negocioId);
        }
        if (conItems(borrador)) {
          // La extracción independiente corre SIEMPRE que se esté armando un
          // pedido, aunque el borrador exista y parezca correcto: es la única
          // forma de detectar que omitió (F1) o sustituyó (F2) lo que el
          // cliente dijo. El respaldo se busca en todos los turnos del CICLO
          // activo; las menciones, solo en el turno actual (lo que el cliente
          // sostiene ahora, para que "mejor de fresa" reemplace al "mango"
          // anterior sin quedar atrapado en él).
          const { menciones, respuestas } = await extraerMencionesComerciales(mensajeUsuario);
          const rc = await validarBorradorPedido(borrador, negocioId, {
            textoCiclo: turnosUsuarioDelCiclo(sessionId).join(' \n '),
            menciones, respuestas,
          });
          // El código viaja en la propia estructura (lo pone el validador), así
          // que el log lo IMPRIME desde ahí: si algún día cambia, no hay dos
          // fuentes que puedan desincronizarse.
          const sinRespaldo = rc.productos.flatMap((p) => p.sinRespaldo || []);
          if (sinRespaldo.length) {
            console.warn(`[TXN] evento=seleccion_sin_respaldo codigo=${sinRespaldo[0].codigo} negocio=${negocioId}`
              + ` descartadas=${JSON.stringify(sinRespaldo.slice(0, 5).map((s) => `${s.grupo}:${s.opcion}`))}`);
          }
          if (!rc.ok) {
            const msg = mensajeBorradorParaCliente(rc);
            if (msg) {
              textoCatalogo = msg;
              // Las menciones no resueltas viven en la RAÍZ: son del turno, no de
              // un artículo (ver validadorOrden.js, reconciliación global).
              const noResueltas = rc.mencionesNoResueltas || [];
              const detalle = [
                ...rc.productos.flatMap((p) => (p.invalidos || []).map((i) => `${i.grupo}:${i.solicitado}`)),
                ...noResueltas.map((m) => `mencion:${m.texto}`),
              ];
              const codigos = [...new Set(noResueltas.map((m) => m.codigo).filter(Boolean))];
              if (detalle.length) {
                console.warn(`[TXN] evento=catalogo_conversacional_bloqueado negocio=${negocioId}`
                  + `${codigos.length ? ` codigos=${JSON.stringify(codigos)}` : ''}`
                  + ` invalidos=${JSON.stringify(detalle.slice(0, 5))}`);
              }
            }
          }
        }
      } catch (e) {
        // Nunca tumba el turno: ante un fallo aquí el flujo sigue como antes.
        console.error('[brain] validación conversacional de catálogo:', e.message);
      }
    }

    // ── PRICING OFICIAL (preconfirmación con el backend) ──
    // El LLM propone; XABOR calcula. El cliente NUNCA confirma un total escrito
    // por el modelo. <ORDEN_PREVIEW> pide el resumen oficial ANTES de confirmar;
    // <ORDEN_CONFIRMADA> confirma. Ambos pasan por el MISMO pipeline
    // (previsualizarPedido → validarOrdenPropuesta), así que el total mostrado y
    // el registrado coinciden salvo cambio de catálogo/promoción — que aquí se
    // detecta comparando contra el último preview y obliga a reconfirmar.
    const propuestaPreview = extraerBloque(textoRespuesta, 'ORDEN_PREVIEW');
    let ordenParaRegistrar = orden;
    let textoOficialPricing = null;
    // Resumen oficial + (si aplica) la razón REAL por la que una promoción
    // vigente no se aplicó. La explicación la redacta el backend desde la
    // configuración de la promo — nunca el modelo, que antes la inventaba
    // ("el sistema ajustará el total después", caso XAB-0229). También queda
    // en la sesión para que el turno siguiente ("¿y la promo?") tenga la
    // causa autoritativa a la mano.
    const resumenConExplicacion = async (v) => {
      let explicacion = '';
      try {
        explicacion = await explicarPromosNoAplicadas(negocioId, v.orden, {
          canal, promosAplicadas: v.preview?.promociones || [],
        });
      } catch (e) { console.error('[brain] explicar promo no aplicada:', e.message); }
      session.promoNoAplicada = explicacion || null;
      return explicacion
        ? `${resumenPedidoOficial(v.preview)}\n\n${explicacion}`
        : resumenPedidoOficial(v.preview);
    };
    if (typeof negocioId === 'string' && negocioId.trim()) {
      try {
        if (orden) {
          const v = await previsualizarPedido(orden, negocioId, { canal });
          if (v.ok) {
            // SOLO un snapshot CONFIRMABLE puede autorizar una escritura. Antes
            // se leía `session.pedidoPreview?.total` directamente, así que un
            // snapshot marcado no-confirmable (turno indeterminado) seguía
            // autorizando una <ORDEN_CONFIRMADA> del mismo total: bypass del
            // fail-closed. Y la huella entra en la decisión porque dos pedidos
            // distintos pueden costar lo mismo (cambiar Verde por Roja no mueve
            // el total): la igualdad de precio no prueba que sea el pedido que
            // el cliente aprobó.
            const snapConfirmable = verPreviewConfirmable(sessionId);
            const d = decidirConfirmacion({
              canal,
              prevTotal: snapConfirmable?.total,
              nuevoTotal: v.preview.total,
              prevFingerprint: snapConfirmable?.fingerprint,
              nuevoFingerprint: huellaOrden(v.orden),
            });
            if (d.accion === 'registrar') {
              // Coincide con el último preview oficial, o es confirmación directa
              // en un canal con compatibilidad (voz/test/api). El total registrado
              // es SIEMPRE el oficial del backend (mismo pipeline).
              invalidarPreviewPedido(sessionId);
              iniciarCicloPedido(sessionId);   // cierra el ciclo: ver session.js
            } else if (d.accion === 'reconfirmar_cambio') {
              // Había un preview oficial y el total CAMBIÓ (catálogo/promo): NO
              // registrar en silencio; mostrar el nuevo total y pedir confirmar.
              guardarPreviewPedido(sessionId, snapshotDePreview(v));
              ordenParaRegistrar = null;
              textoOficialPricing = `Hubo un cambio en el total de tu pedido.\n\n${await resumenConExplicacion(v)}`;
            } else { // 'preview_requerido'
              // WhatsApp SIN preview oficial previo (o perdido por reinicio del
              // proceso): jamás se registra sobre un total que el cliente no vio
              // de Xabor. Se genera el preview oficial y se pide confirmar ESE.
              guardarPreviewPedido(sessionId, snapshotDePreview(v));
              ordenParaRegistrar = null;
              textoOficialPricing = await resumenConExplicacion(v);
            }
          }
          // Si !v.ok se deja pasar: registrarPedido revalida con el mismo
          // pipeline y el canal redacta el rechazo honesto.
        } else if (propuestaPreview) {
          const v = await previsualizarPedido(propuestaPreview, negocioId, { canal });
          if (v.ok) {
            guardarPreviewPedido(sessionId, snapshotDePreview(v));
            textoOficialPricing = await resumenConExplicacion(v);
          } else {
            invalidarPreviewPedido(sessionId);
            textoOficialPricing = mensajeRechazoParaCliente(v.rechazos || []);
          }
        }
      } catch (e) {
        console.error('[brain] preview pricing oficial:', e.message);
      }
    }

    // ── CONSULTA de promociones por FECHA (hoy/mañana/día/semana) ──
    // El agente emite <CONSULTA_PROMOS>{"cuando":"..."}</CONSULTA_PROMOS> cuando
    // el cliente pregunta por promociones de un día distinto a "ahora". El
    // backend resuelve la fecha en la TZ del negocio y responde con lo REALMENTE
    // guardado en el módulo estructurado — nunca memoria del modelo.
    let textoConsultaPromos = null;
    const consultaPromos = extraerBloque(textoRespuesta, 'CONSULTA_PROMOS');
    if (consultaPromos && typeof negocioId === 'string' && negocioId.trim()) {
      try {
        // Si el marcador viene sin día, la pregunta era "¿qué promos hay?": es
        // HOY. Devolver "¿para qué día?" a quien preguntó por hoy es un rodeo.
        const cuando = String(consultaPromos.cuando ?? consultaPromos.fecha ?? consultaPromos.dia ?? '').trim() || 'hoy';
        const resp = await responderConsultaPromos(negocioId, cuando, { canal });
        textoConsultaPromos = resp || '¿Para qué día te gustaría conocer las promociones? (por ejemplo: hoy, mañana, el miércoles o esta semana).';
      } catch (e) { console.error('[brain] consulta promos por fecha:', e.message); }
    }

    // Registrar intents y actualizar oportunidad (background, no bloquea)
    registrarIntents(telefono, sessionId, canal || 'whatsapp', mensajeUsuario, textoRespuesta, orden)
      .catch(e => console.error('[brain] registrarIntents:', e.message));

    // Extracción de campos comerciales + disparo del borrador. Fase 3
    // (DraftBuilder) es quien valida que haya información suficiente antes
    // de crear la cotización -- <BORRADOR_LISTO> es solo una señal del
    // modelo, nunca una autorización de escritura por sí sola.
    //
    // ESTO SE ESPERA (await), a propósito -- ya NO es fire-and-forget.
    // Antes, la respuesta al cliente (que el propio modelo ya redactaba
    // como "Listo, ya preparé tu cotización...") se enviaba ANTES de que
    // esto siquiera empezara a correr, así que un fallo de guardado dejaba
    // al cliente con una promesa falsa y a la sesión atorada en silencio.
    // Ahora la confirmación real (éxito o aviso honesto de error) la
    // agrega este código DESPUÉS de confirmar qué pasó de verdad, nunca el
    // modelo por su cuenta (ver prompts.js).
    let textoFinal = limpiarBloqueComercial(limpiarTexto(textoRespuesta));
    if (sesionComercial) {
      try {
        const resultadoComercial = await procesarCapturaComercial(sesionComercial, negocioId, textoRespuesta);
        if (resultadoComercial?.mensajeCliente) {
          textoFinal = `${textoFinal}\n\n${resultadoComercial.mensajeCliente}`.trim();
        }
      } catch (e) {
        console.error('[brain] Error inesperado procesando captura comercial:', e.message);
      }
    }

    // El pricing OFICIAL del backend REEMPLAZA cualquier cifra que el modelo
    // hubiera escrito: el cliente solo ve/confirma números de Xabor.
    // La verdad del CATÁLOGO no se negocia con la redacción del modelo: si el
    // backend detectó que algo de lo pedido no existe, su respuesta sustituye
    // a la del modelo (que podía estar reafirmando lo imposible).
    if (textoCatalogo) textoFinal = textoCatalogo;
    if (textoOficialPricing) textoFinal = textoOficialPricing;
    // La consulta de promociones por fecha la responde el backend (fuente
    // estructurada), no la memoria del modelo.
    if (textoConsultaPromos) textoFinal = textoConsultaPromos;

    // ── El historial debe contener lo que el cliente REALMENTE leyó ──
    // Cuando el backend sustituye la redacción del modelo (resumen oficial,
    // consulta de promos), el historial se quedaba con el texto descartado: el
    // modelo creía haber dicho una cifra que el cliente nunca vio y, al recibir
    // un "sí", no sabía a qué resumen respondía. Aquí se alinean.
    // Incluye la corrección de catálogo: si el backend le dijo al cliente "no
    // tenemos eso", el historial no puede seguir guardando la frase del modelo
    // que sí lo prometía — en el turno siguiente la daría por acordada.
    if (textoOficialPricing || textoConsultaPromos || textoCatalogo) {
      reemplazarUltimoMensajeAsistente(sessionId, textoFinal);
    }

    return {
      texto: textoFinal,
      orden: ordenParaRegistrar,
      factura: extraerFactura(textoRespuesta),
      escalar: textoRespuesta.includes('<ESCALAR_A_HUMANO>'),
      enviarMenu: textoRespuesta.includes('<ENVIAR_MENU>'),
      sessionId
    };

  } catch (error) {
    console.error('[brain] Error al llamar a Claude:', error.message);
    throw error;
  }
}

// ─── Simulador del bot (Fase 4 -- centro de entrenamiento) ───────────────────
// Usa EXACTAMENTE la misma construcción de prompt que procesarMensaje (mismo
// menú, mismas reglas_atencion, mismo entrenamiento configurado) para que la
// respuesta simulada sea representativa de lo que el bot real diría -- pero
// deliberadamente NUNCA llama a registrarPedido/enviarMensaje/memoria/
// facturación/Rewards ni persiste nada en `mensajes`. Cualquier marcador que
// el modelo emita (<ORDEN_CONFIRMADA>, <ESCALAR_A_HUMANO>, etc.) se detecta
// solo para mostrarlo como aviso informativo en el simulador -- nunca se
// actúa sobre él. sessionId vive en el mismo Map en memoria de session.js
// pero bajo el prefijo 'sim-' (nunca colisiona con sesiones reales de
// WhatsApp/voz, que usan teléfono o 'call-').
export async function simularMensaje(sessionId, mensajeUsuario, negocioId) {
  if (!sessionId || !sessionId.startsWith('sim-')) throw new Error('sessionId de simulador inválido');
  agregarMensaje(sessionId, 'user', mensajeUsuario);
  const session = getSession(sessionId);
  try {
    const respuesta = await llamarModeloConReintento({
      model: MODELO,
      max_tokens: 1024,
      system: await construirSystemPrompt(null, 'simulador', negocioId),
      messages: session.mensajes,
    });
    const textoRespuesta = respuesta.content[0].text;
    agregarMensaje(sessionId, 'assistant', textoRespuesta);
    return {
      texto: limpiarTexto(textoRespuesta),
      ordenDetectada: !!extraerOrden(textoRespuesta),
      escalar: textoRespuesta.includes('<ESCALAR_A_HUMANO>'),
      sessionId,
    };
  } catch (error) {
    console.error('[brain] Error en simulador:', error.message);
    throw error;
  }
}

// ─── Versión streaming (voz) ──────────────────────────────────────────────────
// onFrase(texto) se llama por cada oración completa mientras Claude genera.
// signal: AbortSignal — cuando se aborta, el stream se cancela limpiamente.
// Retorna null si fue abortado antes de terminar; de lo contrario el mismo objeto
// que procesarMensaje.
export async function procesarMensajeStream(sessionId, mensajeUsuario, clienteCtx = null, canal = null, negocioId = null, onFrase, signal = null) {
  agregarMensaje(sessionId, 'user', mensajeUsuario);
  const session = getSession(sessionId);

  // Enriquecer contexto con memoria del cliente
  const telefono = clienteCtx?.telefono;
  let memoriaCtx = '';
  if (telefono && telefono !== '—' && typeof negocioId === 'string' && negocioId.trim()) {
    const perfil = await obtenerPerfilCliente(telefono, negocioId);
    memoriaCtx = construirContextoCliente(perfil);
  }

  let textoCompleto = '';
  let buffer        = '';
  let bloqueado     = false;

  const stream = getAnthropic().messages.stream({
    model: MODELO,
    max_tokens: 1024,
    system: await construirSystemPrompt(clienteCtx, canal, negocioId) + memoriaCtx,
    messages: session.mensajes
  }, { signal });

  try {
    for await (const event of stream) {
      // Turno cancelado — salir inmediatamente sin procesar más tokens
      if (signal?.aborted) break;

      if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') continue;

      const token = event.delta.text;
      textoCompleto += token;

      if (bloqueado) continue;

      // Detectar inicio de bloque especial — flush buffer y bloquear
      if (textoCompleto.includes('<ORDEN_CONFIRMADA>') ||
          textoCompleto.includes('<ESCALAR_A_HUMANO>') ||
          textoCompleto.includes('<ENVIAR_MENU>') ||
          textoCompleto.includes('<SOLICITAR_FACTURA>') ||
          textoCompleto.includes('<CONSULTA_PENDIENTE')) {
        bloqueado = true;
        if (buffer.trim()) { onFrase(buffer.trim()); buffer = ''; }
        continue;
      }

      // Si el token contiene '<' o '{', dejar de acumular para TTS
      if (token.includes('<') || token.includes('{')) {
        bloqueado = true;
        const antes = buffer.split(/[<{]/)[0];
        if (antes.trim()) onFrase(antes.trim());
        buffer = '';
        continue;
      }

      buffer += token;

      // Enviar frases completas al llegar a límite de oración
      const match = buffer.match(/^(.*?[.!?,])\s+/s);
      if (match) {
        const frase = match[1].trim();
        if (frase) onFrase(frase);
        buffer = buffer.slice(match[0].length);
      }
    }
  } catch (e) {
    if (e.name === 'AbortError' || signal?.aborted) {
      console.log('[brain] Stream abortado — turno cancelado');
      return null;
    }
    throw e;
  }

  // Si fue abortado en el loop (break), no guardar respuesta parcial
  if (signal?.aborted) {
    console.log('[brain] Stream abortado (mid-loop) — descartando respuesta parcial');
    return null;
  }

  // Flush del buffer restante
  if (buffer.trim() && !bloqueado) onFrase(buffer.trim());

  agregarMensaje(sessionId, 'assistant', textoCompleto);

  return {
    texto: limpiarTexto(textoCompleto),
    orden: extraerOrden(textoCompleto),
    factura: extraerFactura(textoCompleto),
    escalar: textoCompleto.includes('<ESCALAR_A_HUMANO>'),
    enviarMenu: textoCompleto.includes('<ENVIAR_MENU>'),
    sessionId
  };
}

// ─── Detección de intents + oportunidades ────────────────────────────────────

/**
 * Detecta señales comerciales en el mensaje del usuario y la respuesta del bot.
 * Retorna array de EVENTOS detectados para registrar.
 */
function detectarIntents(mensajeUsuario, textoRespuesta) {
  const intents = [];
  const msg = mensajeUsuario.toLowerCase();

  if (/men[uú]|carta|qu[eé] (tienen|hay|venden|ofrecen)/i.test(msg))
    intents.push(EVENTOS.MENU_SOLICITADO);

  if (/cu[aá]nto|precio|costo|valor|\$[0-9]/i.test(msg))
    intents.push(EVENTOS.PRECIO_CONSULTADO);

  if (/quiero|me das|me pones|me mandas|me llevas|pedir|ordenar|hacer un pedido/i.test(msg))
    intents.push(EVENTOS.PEDIDO_INICIADO);

  if (textoRespuesta.includes('<ORDEN_CONFIRMADA>'))
    intents.push(EVENTOS.PEDIDO_CONFIRMADO);

  return intents;
}

/**
 * Registrar intents detectados y actualizar oportunidad en background.
 * Nunca lanza excepción.
 */
async function registrarIntents(telefono, sessionId, canal, mensajeUsuario, textoRespuesta, orden) {
  if (!telefono) return;
  const intents = detectarIntents(mensajeUsuario, textoRespuesta);

  for (const tipo of intents) {
    registrarEvento({ tipo, entidad_tipo: 'cliente', entidad_id: telefono, canal, sesion_id: sessionId });
  }

  if (intents.length > 0) {
    const intent = intents[intents.length - 1]; // el más relevante
    const esCierre = intents.includes(EVENTOS.PEDIDO_CONFIRMADO);
    await actualizarOportunidad(telefono, sessionId, {
      estado: esCierre ? 'cerrada_con_venta' : 'activa',
      intent,
      valor_estimado: orden?.total || null,
      folio_pedido: orden?.folio || null
    });
  }
}

// Mensajes de cara al cliente controlados por CÓDIGO, nunca por el modelo
// (ver prompts.js -- el modelo tiene prohibido afirmar esto por su
// cuenta). El de éxito es el texto exacto exigido por el encargo; el de
// error nunca promete un PDF ni miente sobre el estado, y dirige al
// cliente a esperar seguimiento humano en vez de reintentar él mismo.
const MENSAJE_BORRADOR_LISTO = 'Listo, ya preparé tu cotización y la envié a revisión. En cuanto sea aprobada, recibirás el PDF aquí mismo.';
const MENSAJE_BORRADOR_ERROR = 'Tuvimos un problema para terminar de preparar tu cotización en este momento, pero ya guardamos la información que nos diste. En breve alguien de nuestro equipo la revisa contigo -- no hace falta que la repitas.';

/**
 * Fase 2-3 del Asistente Comercial: aplica los campos capturados en este
 * turno a la sesión (nunca pierde los de turnos anteriores -- ver
 * fusionarCamposCapturados) y, si el modelo emitió <BORRADOR_LISTO>,
 * intenta crear el borrador. generarBorradorDesdeSesion (Fase 3) es quien
 * valida "información suficiente" (incluida una fecha ya normalizada, ver
 * comercialMarkers.js/normalizarFecha.js) antes de escribir nada --
 * <BORRADOR_LISTO> es solo una señal, no una autorización.
 *
 * Devuelve `null` si no hubo intento de borrador este turno (conversación
 * sigue normal), o `{ ok, mensajeCliente, cotizacion? }` cuando SÍ hubo
 * intento -- `mensajeCliente` es el único texto autorizado a confirmar (o
 * desmentir) la creación del borrador, y brain.js lo agrega a la
 * respuesta SOLO después de que esta función ya terminó (nunca antes).
 *
 * Nunca lanza fuera de esta función: cualquier error real (fallo de DB,
 * catálogo, etc.) se captura aquí mismo y transiciona la sesión a
 * 'error_recuperable' (ver sesionComercial.js) en vez de dejarla atorada
 * en 'construyendo_borrador' sin salida.
 */
async function procesarCapturaComercial(sesionComercial, negocioId, textoRespuesta) {
  const capturas = extraerCamposComerciales(textoRespuesta);
  let camposActualizados = sesionComercial.campos_capturados;

  if (capturas.length > 0) {
    // Se persiste el objeto fusionado completo (no solo los campos nuevos
    // de este turno) -- fusionarCamposCapturados ya deriva fecha_evento_iso
    // a partir de fecha_evento, y ese campo derivado solo llega a la BD si
    // viaja dentro del objeto completo, nunca reconstruyendo un delta a
    // mano campo por campo (ese delta manual era exactamente el bug que
    // hacía que fecha_evento_iso nunca se guardara).
    const fusionados = fusionarCamposCapturados(sesionComercial.campos_capturados, capturas);
    await actualizarCamposSesion(sesionComercial.id, negocioId, fusionados);
    camposActualizados = fusionados;
  }

  if (!tieneBorradorListo(textoRespuesta)) return null; // sin intento de borrador este turno

  try {
    const resultado = await generarBorradorDesdeSesion(sesionComercial.id, negocioId, camposActualizados);
    if (!resultado) {
      // Información aún insuficiente (p.ej. la fecha no se pudo
      // interpretar con confianza) -- NO es un error: la conversación
      // sigue con naturalidad, el modelo verá en el siguiente turno que
      // ese campo sigue faltando (camposParaPrompt) y volverá a
      // preguntarlo. Ningún mensaje de "listo" ni de error aquí.
      return null;
    }

    // Solo se notifica (panel + admin) cuando el borrador es NUEVO -- si
    // ya existía (llamada idempotente de un reintento, ver
    // draftBuilder.js) no se repite en cada turno subsecuente.
    if (!resultado.yaExistia) {
      broadcastNegocio(negocioId, { tipo: 'cotizacion_borrador_ia', cotizacion: resultado });
      // El PDF/aviso al administrador SÍ se espera aquí (a diferencia de
      // antes) para que el orden "crear -> avisar admin -> confirmar al
      // cliente" sea real y no solo aparente -- pero que Meta/WhatsApp
      // fallen en avisarle al admin NUNCA hace que le neguemos al cliente
      // la confirmación: el borrador ya existe de verdad en la base y
      // siempre es revisable/aprobable desde el panel aunque esta
      // notificación puntual no llegue.
      const notif = await notificarBorradorAlAdmin({ cotizacion: resultado, negocioId, camposCapturados: camposActualizados })
        .catch((e) => ({ ok: false, motivo: e.message }));
      if (!notif?.ok) {
        console.warn(`[brain] Borrador ${resultado.folio} creado OK pero no se pudo confirmar el aviso al admin (motivo=${notif?.motivo || 'desconocido'}) -- sigue siendo revisable desde el panel.`);
      }
    }

    return { ok: true, cotizacion: resultado, mensajeCliente: MENSAJE_BORRADOR_LISTO };
  } catch (e) {
    await marcarSesionComoErrorRecuperable(sesionComercial.id, negocioId, e)
      .catch((err) => console.error('[brain] Error marcando sesión como error_recuperable:', err.message));
    console.error(`[brain] Error creando borrador para sesión ${sesionComercial.id}:`, e.message);
    return { ok: false, motivo: e.message, mensajeCliente: MENSAJE_BORRADOR_ERROR };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Extrae y parsea un bloque JSON <TAG>...</TAG> (p. ej. ORDEN_PREVIEW). Igual
// que extraerOrden pero genérico. Devuelve null si no existe o no parsea.
function extraerBloque(texto, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const match = texto.match(re);
  if (!match) return null;
  try { return JSON.parse(match[1].trim()); }
  catch (e) { console.error(`[brain] ⚠️ ${tag} presente pero JSON inválido:`, e.message); return null; }
}

function extraerOrden(texto) {
  const match = texto.match(/<ORDEN_CONFIRMADA>([\s\S]*?)<\/ORDEN_CONFIRMADA>/);
  if (!match) return null;
  try {
    const orden = JSON.parse(match[1].trim());
    console.log(`[brain] Orden extraída OK — total: $${orden.total} | programado_para: ${orden.programado_para || 'inmediato'}`);
    return orden;
  } catch (e) {
    // Error crítico: el bloque JSON existe pero no es parseable.
    // Loguear el contenido completo para diagnóstico.
    console.error('[brain] ⚠️ ORDEN_CONFIRMADA presente pero JSON inválido:', e.message);
    console.error('[brain] Contenido del bloque:', match[1].trim().slice(0, 500));
    return null;
  }
}

function extraerFactura(texto) {
  const match = texto.match(/<SOLICITAR_FACTURA>([\s\S]*?)<\/SOLICITAR_FACTURA>/);
  if (!match) return null;
  try { return JSON.parse(match[1].trim()); } catch { return null; }
}

function limpiarTexto(texto) {
  const sinTags = texto
    .replace(/<ORDEN_CONFIRMADA>[\s\S]*?<\/ORDEN_CONFIRMADA>/g, '')
    .replace(/<ORDEN_PREVIEW>[\s\S]*?<\/ORDEN_PREVIEW>/g, '')
    .replace(/<CONSULTA_PROMOS>[\s\S]*?<\/CONSULTA_PROMOS>/g, '')
    .replace(/<PEDIDO_BORRADOR>[\s\S]*?<\/PEDIDO_BORRADOR>/g, '')
    .replace(/<SOLICITAR_FACTURA>[\s\S]*?<\/SOLICITAR_FACTURA>/g, '')
    .replace(/<ESCALAR_A_HUMANO>/g, '')
    .replace(/<CONSULTA_PENDIENTE:[^>]*>/g, '')
    .replace(/<ENVIAR_MENU>/g, '')
    .trim();
  // Última capa antes de guardar/enviar: WhatsApp no entiende Markdown.
  // Convierte **negrita**→*negrita* y des-escapa \* para que el cliente y el
  // panel no vean los símbolos literales. Ver src/utils/formatoWhatsapp.js.
  return normalizarFormatoWhatsApp(sinTags);
}
