// Decisiones puras de scripts/activar-modo-ia.mjs (modo formulario /
// recepcionista, recepcionista.js): qué precondiciones exige, qué escribe al
// activar y qué al revertir. Aparte para que las pruebas y el chequeo previo
// al despliegue las cubran sin base ni Meta. Misma regla que
// activacionTienda.js: respaldo, reversa que acepta lo ya quitado a mano y
// nunca pisa un cambio ajeno.
//
// Se activa en dos tiempos sobre el mismo respaldo:
//   1. --prueba con los teléfonos de prueba (whatsapp_ia_modo_telefonos);
//   2. --todos. Cambiar el alcance (o de formulario a recepcionista) conserva
//      el «antes» original: revertir siempre deja la configuración de antes
//      del paso 1.
//
// --publicar-selector (solo --recepcionista): sin él, el selector corre en
// sombra (decide y se registra; al cliente le sale lo del modo formulario).
// --faqs archivo.json: reemplaza reglas_atencion.bot.faqs por las preguntas
// frecuentes APROBADAS (validarArchivoFaqs) y guarda en el respaldo las de
// antes y el sha1 de las nuevas; revertir las restaura solo si nadie las
// editó desde entonces en el panel. El resto de reglas_atencion no se toca.
import { createHash } from 'node:crypto';
import { CLAVES_IA, MODOS_IA, ALCANCES_IA, precondicionesDeTurno } from './recepcionista.js';
import { catalogoDeRespuestas, validarFaqs, temaDeConfigDe, idDeFaq } from './respuestasFijas.js';
import { normalizarEleccion } from './politicaDelTurno.js';
import { validarEstructuraReglas } from '../agent/prompts.js';
import { planReversa } from './activacionDireccion.js';
import { telefonosDePrueba } from './activacionTienda.js';
import { enElCanario, esVerdadero } from '../orders/modoDelPedido.js';
import { alcanceDePruebaPermite } from './alcanceDePrueba.js';
import { formularioDePedidoPosible } from './formularioAgrupado.js';
import { enlaceDeTienda } from './horarioDelAgente.js';
import { estadoNuevo } from './ejecutorDeHerramientas.js';
import { horasDeVencimiento, CLAVE_HORAS } from '../services/pausaVencePolitica.js';

export const CLAVE_RESPALDO_MODO_IA = CLAVES_IA.RESPALDO;
// Las claves que escribe una activación (y restaura una reversa).
export const CLAVES_ACTIVACION = Object.freeze([CLAVES_IA.MODO, CLAVES_IA.ALCANCE, CLAVES_IA.TELEFONOS, CLAVES_IA.PUBLICAR_SELECTOR]);
// Un teléfono que no está en ninguna lista: con --todos, las precondiciones de
// turno tienen que valer para él (para cualquier cliente).
export const TELEFONO_CUALQUIERA = '520000000000';
export const AVISO_PROCESO = 'Verifica en Railway: MESERO_AGENTE_MODE=true y WHATSAPP_INTERACTIVOS=true (variables de proceso, invisibles para este script).';

/**
 * Las precondiciones de activación: [{ id, ok, bloquea, detalle }].
 * `hechos` (lecturas de la base, solo lectura): { carta, menuAutomaticoActivo,
 * configTienda, comercialCatering, modalidades, metodosPago, reglas }.
 */
export function precondicionesDeActivacion(cfg = {}, { alcance, telefonos = [], hechos = {} } = {}) {
  const lista = alcance === 'prueba' ? telefonos : [TELEFONO_CUALQUIERA];
  const filas = [];
  const fila = (id, ok, bloquea, detalle = '') => filas.push({ id, ok: !!ok, bloquea, detalle });

  fila('mesero', cfg.mesero_agente_v1 === 'true', true, 'mesero_agente_v1 debe ser true');
  if (alcance === 'todos') {
    const telefonosMesero = String(cfg.mesero_agente_telefonos ?? '').split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean);
    fila('alcance_mesero', String(cfg.bot_whatsapp_solo_prueba) === 'false' && !telefonosMesero.length
      && String(cfg.mesero_agente_porcentaje ?? '').trim() === '100', true,
    'con --todos: bot_whatsapp_solo_prueba=false, mesero_agente_telefonos vacío y mesero_agente_porcentaje=100 (si no, hay clientes que atiende brain.js, que arma pedidos por texto)');
  } else {
    const fuera = lista.filter((t) => !enElCanario(t, { lista: cfg.mesero_agente_telefonos, porcentaje: cfg.mesero_agente_porcentaje }).dentro
      || !alcanceDePruebaPermite(cfg, t));
    fila('alcance_mesero', lista.length && !fuera.length, true, fuera.length ? `fuera del alcance del Mesero: ${fuera.join(', ')}` : '');
  }

  // Las de cada turno, para cada teléfono del alcance; «interactivos» con la
  // clave del negocio (la variable de proceso no la ve el script).
  const porId = new Map();
  for (const t of lista) {
    for (const id of precondicionesDeTurno({ ...cfg }, t)) {
      if (id === 'interactivos') continue;
      porId.set(id, [...(porId.get(id) || []), t]);
    }
  }
  const nombres = { formularios: 'formularios', elecciones: 'elecciones', rescate: 'rescate', inicio_mapo: 'inicio_mapo',
    beta_hibrida: 'beta_hibrida', eventos_formulario: 'eventos_formulario' };
  fila('interactivos_negocio', esVerdadero(cfg.whatsapp_interactivos_v1), true, 'whatsapp_interactivos_v1 debe ser true');
  for (const id of Object.keys(nombres)) {
    const fallan = porId.get(id) || [];
    fila(id, !fallan.length, true, fallan.length ? `falla para ${alcance === 'todos' ? 'cualquier cliente' : fallan.join(', ')}` : '');
  }

  const modalidades = Array.isArray(hechos.modalidades) && hechos.modalidades.length
    ? hechos.modalidades : ['recoger en tienda', 'entrega a domicilio'];
  const estado = estadoNuevo({ negocioId: 'activacion', conversacionId: 'activacion' });
  const formulario = Array.isArray(hechos.carta) && hechos.carta.length > 0
    && formularioDePedidoPosible({ estado, cfg, telefono: lista[0], catalogo: hechos.carta, modalidades,
      metodosPago: hechos.metodosPago || [], reglas: hechos.reglas || {} });
  fila('formulario_pedido', formulario, true, formulario ? '' : 'con un carrito vacío no saldría el formulario de pedido (carta publicada, Flow de categorías o tienda, endpoint)');

  fila('pausa_vence', !!horasDeVencimiento(cfg[CLAVE_HORAS]), false,
    'sin whatsapp_pausa_vence_horas los traspasos nuevos quedan en pausa hasta que alguien los atienda');
  fila('menu_imagen', !hechos.menuAutomaticoActivo, false,
    'el menú automático en imagen está activo: «la carta» la contesta whatsapp-meta.js con la imagen antes del modo (D5 no aplica)');
  // Bloquea: con cotizacion_perfil=catering y el módulo comercial activo,
  // whatsapp-meta.js manda el turno a brain.js antes del Mesero y el cliente
  // recibiría texto del modelo en los dos modos.
  fila('catering_legado', !hechos.comercialCatering, true,
    'cotizacion_perfil=catering con el módulo comercial activo: los eventos los toma el bot heredado (brain.js, texto del modelo) antes del modo');
  // Aviso: el texto libre del FORMULARIO (la «Nota del pedido», contrato
  // nota_v1, y la nota para cocina de la tienda) llega a cocina tal cual. En
  // c69889eec unos extras escritos ahí se prepararon sin cobrarse ($30).
  fila('nota_libre', cfg.whatsapp_flow_nota_v1 !== 'true' && !['true', 'prueba'].includes(cfg.whatsapp_flow_tienda_v1), false,
    'el formulario lleva texto libre que cocina lee (nota del pedido o nota para cocina de la tienda): un extra escrito ahí se prepara sin cobrarse (c69889eec). Acuérdalo con el personal antes de activar');
  fila('tienda_programados', !!enlaceDeTienda(hechos.configTienda), false,
    'sin tienda en línea publicada que acepte programados, un pedido para otro día pasa a una persona');
  fila('proceso', false, false, AVISO_PROCESO);
  return filas;
}

// ── PREGUNTAS FRECUENTES APROBADAS (--faqs) ─────────────────────────────────

export const MAX_FAQS = 30;
// La lista «Información»: 9 filas + «Más preguntas» y una segunda de hasta 10.
export const MAX_ENTRADAS_INFORMACION = 19;
const MARCA = /\[CONFIRMAR/i;

/** El sha1 de una lista de preguntas frecuentes (lo que el respaldo compara al revertir). */
export const shaDeFaqs = (faqs) => createHash('sha1').update(JSON.stringify(faqs ?? null)).digest('hex');

const leerReglas = (cfg) => {
  try {
    const r = JSON.parse(cfg?.reglas_atencion || 'null');
    return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
  } catch { return null; }
};
const conFaqs = (reglas, faqs) => {
  const bot = { ...(reglas.bot || {}) };
  if (faqs == null) delete bot.faqs; else bot.faqs = faqs;
  return { ...reglas, bot };
};

/**
 * El archivo de preguntas frecuentes que se va a cargar: { faqs } o { errores }.
 * Arreglo de { pregunta, respuesta } (nada más), 1–30, pregunta 2–120 y
 * respuesta 2–1000 caracteres, sin «[CONFIRMAR», sin preguntas repetidas,
 * válidas para salir literales (validarFaqs: tarifa de envío, frase
 * prohibida, texto interno, cambio afirmado), sin duplicar un tema que sale de
 * la configuración (horario, tiempos, envío, pagos: se corrigen allá) y que
 * quepan en la lista «Información». `contexto` (cfg, metodosPago, modalidades)
 * arma el catálogo real para comprobar que cada una entra.
 */
export function validarArchivoFaqs(json, reglas = {}, { cfg = {}, metodosPago = [], modalidades = null } = {}) {
  const errores = [];
  if (!Array.isArray(json)) return { errores: ['el archivo debe ser un arreglo de { pregunta, respuesta }'] };
  if (json.length < 1 || json.length > MAX_FAQS) errores.push(`debe tener de 1 a ${MAX_FAQS} preguntas (tiene ${json.length})`);
  const vistas = new Map();
  json.forEach((f, i) => {
    const n = `${i + 1}`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) { errores.push(`${n}: no es un objeto`); return; }
    const sobran = Object.keys(f).filter((k) => !['pregunta', 'respuesta'].includes(k));
    if (sobran.length) errores.push(`${n}: campos de más (${sobran.join(', ')})`);
    if (typeof f.pregunta !== 'string' || typeof f.respuesta !== 'string') { errores.push(`${n}: pregunta y respuesta deben ser texto`); return; }
    const p = f.pregunta.trim(), r = f.respuesta.trim();
    if (p.length < 2 || p.length > 120) errores.push(`${n} «${p.slice(0, 30)}»: la pregunta debe medir de 2 a 120 caracteres`);
    if (r.length < 2 || r.length > 1000) errores.push(`${n} «${p.slice(0, 30)}»: la respuesta debe medir de 2 a 1000 caracteres`);
    if (MARCA.test(p) || MARCA.test(r)) errores.push(`${n} «${p.slice(0, 30)}»: conserva una marca [CONFIRMAR …]`);
    const clave = normalizarEleccion(p);
    if (vistas.has(clave)) errores.push(`${n} «${p.slice(0, 30)}»: repite la pregunta ${vistas.get(clave)}`);
    else vistas.set(clave, n);
    const tema = temaDeConfigDe(p);
    if (tema) errores.push(`${n} «${p.slice(0, 30)}»: duplica el tema «${tema}», que sale de la configuración (corrígelo allá)`);
  });
  if (errores.length) return { errores };
  const faqs = json.map((f) => ({ pregunta: f.pregunta.trim(), respuesta: f.respuesta.trim() }));
  const v = validarFaqs(faqs, reglas);
  if (!v.ok) return { errores: v.errores };
  const nuevas = conFaqs(reglas, faqs);
  if (!validarEstructuraReglas(nuevas)) return { errores: ['reglas_atencion dejaría de pasar validarEstructuraReglas'] };
  const { entradas, omitidas } = catalogoDeRespuestas({ reglas: nuevas, cfg, metodosPago, modalidades, estadoRestaurante: { abierto: true } });
  for (const f of faqs) {
    const id = idDeFaq(f.pregunta);
    const omitida = omitidas.find((o) => o.id === id);
    if (omitida && !/es la de mesas/.test(omitida.motivo)) errores.push(`«${f.pregunta.slice(0, 30)}»: no entraría a la lista (${omitida.motivo})`);
  }
  if (entradas.length > MAX_ENTRADAS_INFORMACION) {
    errores.push(`la lista «Información» tendría ${entradas.length} temas; caben ${MAX_ENTRADAS_INFORMACION} (9 + «Más preguntas» con 10)`);
  }
  return errores.length ? { errores } : { faqs };
}

// ── ACTIVAR Y REVERTIR ──────────────────────────────────────────────────────

/**
 * Los cambios de una activación, o un error con el motivo. El modo, el
 * alcance, los teléfonos (en prueba) y la publicación del selector se escriben
 * JUNTOS; con `faqs` (ya leídas del archivo), también reglas_atencion con las
 * preguntas frecuentes nuevas y lo demás intacto.
 */
export function planActivacionModoIA(cfg = {}, { modo, alcance, telefonos = '', hechos = {}, publicarSelector = false, faqs = null } = {}) {
  if (!MODOS_IA.includes(modo)) return { error: 'Indica el modo: --formulario o --recepcionista' };
  if (!ALCANCES_IA.includes(alcance)) return { error: 'Indica el alcance: --prueba <teléfonos> o --todos' };
  if (publicarSelector && modo !== 'recepcionista') return { error: '--publicar-selector solo va con --recepcionista' };
  const lista = alcance === 'prueba' ? telefonosDePrueba(telefonos) : null;
  if (alcance === 'prueba' && !lista) return { error: 'Con --prueba indica uno o más teléfonos (10 a 15 dígitos, separados por coma)' };
  const precondiciones = precondicionesDeActivacion(cfg, { alcance, telefonos: lista || [], hechos });
  const bloquean = precondiciones.filter((p) => p.bloquea && !p.ok);
  if (bloquean.length) {
    return { error: `Faltan precondiciones: ${bloquean.map((p) => `${p.id}${p.detalle ? ` (${p.detalle})` : ''}`).join('; ')}`, precondiciones };
  }
  const avisos = precondiciones.filter((p) => !p.bloquea && !p.ok).map((p) => `${p.id}: ${p.detalle}`);
  const cambios = { [CLAVES_IA.MODO]: modo, [CLAVES_IA.ALCANCE]: alcance,
    [CLAVES_IA.TELEFONOS]: lista ? lista.join(',') : null, [CLAVES_IA.PUBLICAR_SELECTOR]: publicarSelector ? 'true' : null };
  if (modo === 'recepcionista' && !publicarSelector) avisos.push('selector: corre en SOMBRA (decide y se registra; al cliente le sale lo del modo formulario)');

  // Las preguntas frecuentes, si vienen: validadas contra las reglas de hoy.
  let reglasNuevas = null, faqsDelRespaldo = {};
  const respaldo = cfg[CLAVE_RESPALDO_MODO_IA] ? JSON.parse(cfg[CLAVE_RESPALDO_MODO_IA]) : null;
  if (faqs != null) {
    const reglas = leerReglas(cfg);
    if (!reglas || !validarEstructuraReglas(reglas)) return { error: 'reglas_atencion no es válido: no se cargan preguntas frecuentes', precondiciones };
    const v = validarArchivoFaqs(faqs, reglas, { cfg, metodosPago: hechos.metodosPago || [], modalidades: hechos.modalidades || null });
    if (v.errores) return { error: `Preguntas frecuentes rechazadas: ${v.errores.join('; ')}`, precondiciones };
    const actuales = reglas.bot?.faqs ?? null;
    if (respaldo?.faqs_despues_sha && shaDeFaqs(actuales) !== respaldo.faqs_despues_sha) {
      return { error: 'Las preguntas frecuentes cambiaron después de la última activación (bot.faqs): no sobrescribir', precondiciones };
    }
    reglasNuevas = conFaqs(reglas, v.faqs);
    // El «antes» de las preguntas es el de la PRIMERA carga.
    faqsDelRespaldo = { faqs_antes: respaldo?.faqs_despues_sha ? respaldo.faqs_antes ?? null : actuales,
      faqs_despues_sha: shaDeFaqs(v.faqs) };
  } else if (respaldo?.faqs_despues_sha) {
    faqsDelRespaldo = { faqs_antes: respaldo.faqs_antes ?? null, faqs_despues_sha: respaldo.faqs_despues_sha };
  }
  const extra = reglasNuevas ? { reglas_atencion: JSON.stringify(reglasNuevas) } : {};

  if (respaldo) {
    // Cambiar el alcance, el modo o la publicación sobre la misma activación.
    const ajenas = Object.entries(respaldo.despues || {}).filter(([k, v]) => (cfg[k] ?? null) !== v).map(([k]) => k);
    if (ajenas.length) return { error: `La configuración cambió después de activar (${ajenas.join(', ')}): no sobrescribir`, precondiciones };
    return { cambios, avisos, precondiciones, extra, faqs: reglasNuevas?.bot?.faqs ?? null,
      respaldo: { antes: respaldo.antes, despues: cambios, ...faqsDelRespaldo }, reemplazaRespaldo: true };
  }
  // Claves puestas a mano sin respaldo: revertir no las apagaría.
  const aMano = CLAVES_ACTIVACION.filter((k) => cfg[k] != null && cfg[k] !== '');
  if (aMano.length) return { error: `Hay claves del modo puestas a mano (${aMano.join(', ')}): quítalas antes de activar`, precondiciones };
  return { cambios, avisos, precondiciones, extra, faqs: reglasNuevas?.bot?.faqs ?? null,
    respaldo: { antes: Object.fromEntries(CLAVES_ACTIVACION.map((k) => [k, cfg[k] ?? null])), despues: cambios, ...faqsDelRespaldo } };
}

/**
 * Lo que restaura la reversa del modo: las claves (misma regla que la
 * dirección y la tienda) y, si la activación cargó preguntas frecuentes, las
 * de antes. Las faqs solo se restauran si su sha1 sigue siendo el que se
 * cargó (si alguien las editó en el panel: error, no se pisan); si ya son las
 * de antes, no hay nada que restaurar.
 */
export function planReversaModoIA(cfg) {
  const base = planReversa(cfg, CLAVE_RESPALDO_MODO_IA);
  if (base.error) return base;
  const respaldo = JSON.parse(cfg[CLAVE_RESPALDO_MODO_IA]);
  if (!respaldo.faqs_despues_sha) return base;
  const reglas = leerReglas(cfg);
  if (!reglas) return { error: 'reglas_atencion ilegible: no se restauran las preguntas frecuentes' };
  const actual = shaDeFaqs(reglas.bot?.faqs ?? null);
  if (actual === shaDeFaqs(respaldo.faqs_antes ?? null)) return base;
  if (actual !== respaldo.faqs_despues_sha) {
    return { error: 'Las preguntas frecuentes cambiaron después de activar (bot.faqs): no se sobrescriben' };
  }
  return { aplicar: base.aplicar, extra: { reglas_atencion: JSON.stringify(conFaqs(reglas, respaldo.faqs_antes ?? null)) } };
}
