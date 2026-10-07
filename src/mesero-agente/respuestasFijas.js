// ─── LAS RESPUESTAS APROBADAS DEL MODO FORMULARIO / RECEPCIONISTA ──────────
//
// Decisión del dueño (3-oct-2026): la IA queda como recepcionista para dudas y
// las dudas se contestan con texto APROBADO, literal. Este módulo arma ese
// catálogo con dos fuentes y nada más:
//
//   · la configuración del Asistente (reglas_atencion y configuracion):
//     horario, ubicación, tiempos, envío, formas de pago, mesas, cómo pedir y
//     las promociones oficiales (dinámicas: las lee el canal al contestar);
//   · las preguntas frecuentes del Asistente (reglas.bot.faqs), tal cual.
//
// Si falta un dato, la entrada se OMITE (queda en `omitidas` con su motivo):
// nunca se rellena con algo que el negocio no escribió. `informacion_importante`
// NO entra: en Obispado es prosa de instrucciones al modelo, no texto para un
// cliente.
//
// Puro: sin base de datos, red ni modelo. Ninguna constante de nivel superior
// usa un valor importado (hay ciclos de importación por recepcionista.js): los
// temas son funciones.
import { createHash } from 'node:crypto';
import { horaParaCliente } from './horarioDelAgente.js';
import { rangoEnMinutos } from './tiempoEstimado.js';
import { tiposDePagoDisponibles, etiquetaTipoPago, descripcionTipoPago } from './politicaDePagos.js';
import { respuestaSobreMesas, respuestaProhibidaEncontrada } from './reglasDelAsistente.js';
import { contextoSinTarifasLibres } from './contextoEnvio.js';
import { normalizarEleccion } from './politicaDelTurno.js';
import { PREGUNTA_DE_PAGO, PETICION_DE_EXPLICACION } from './experienciaHibrida.js';
import { esConsultaDePromociones } from './consultaDePromociones.js';
import { mismaPalabraFlexible } from '../agent/mencionesComerciales.js';
import { modalidadesDisponibles } from '../orders/modalidadesDelPedido.js';
import { respuestaAfirmaCambioSinAplicar } from './seguridadConversacional.js';
import { detectarSalidaInterna } from './salidaPublicable.js';
import { FRASES } from './frasesRecepcion.js';

export const MAX_TEXTO = 1024;
export const MAX_TITULO = 24;
export const MAX_DESCRIPCION = 72;
// Orden de la lista «Información» (las preguntas frecuentes van después).
export const ORDEN_CONFIG = Object.freeze(['horario', 'ubicacion', 'tiempos', 'envio', 'pagos', 'promociones', 'mesas', 'como_pedir']);
// Los temas que salen de la configuración: una pregunta frecuente con uno de
// estos temas se corrige en la configuración, no se duplica.
export const TEMAS_DE_CONFIG = Object.freeze(['horario', 'tiempos', 'envio', 'pagos']);

const texto = (v) => String(v ?? '').trim();
const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const NOMBRE_DIA = { lunes: 'Lunes', martes: 'Martes', miercoles: 'Miércoles', jueves: 'Jueves', viernes: 'Viernes', sabado: 'Sábado', domingo: 'Domingo' };
const HORA = /^(?:[01]?\d|2[0-3]):[0-5]\d$/;
const HORA_CIERRE = /^(?:(?:[01]?\d|2[0-3]):[0-5]\d|24:00)$/;
const hora12 = (v) => (String(v).trim() === '24:00' ? '12:00 a. m.' : horaParaCliente(v));
const capital = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const sinPunto = (s) => texto(s).replace(/[.\s]+$/, '');

// ── HORARIO ────────────────────────────────────────────────────────────

/** Mismo criterio que consultaMixta.js: cada día cerrado, o abierto con horas válidas. */
export function horarioCompleto(horarios) {
  return DIAS.every((d) => horarios?.[d]?.abierto === false
    || (horarios?.[d]?.abierto === true && HORA.test(String(horarios[d].apertura || ''))
      && HORA_CIERRE.test(String(horarios[d].cierre || ''))));
}

function lineasDeHorario(horarios) {
  const grupos = [];
  for (const d of DIAS) {
    const h = horarios[d];
    const clave = h.abierto ? `${h.apertura}-${h.cierre}` : 'cerrado';
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.clave === clave) ultimo.dias.push(d);
    else grupos.push({ clave, dias: [d], h });
  }
  return grupos.map((g) => {
    const primero = NOMBRE_DIA[g.dias[0]], ultimo = NOMBRE_DIA[g.dias[g.dias.length - 1]].toLowerCase();
    const dias = g.dias.length === 1 ? primero : g.dias.length === 2 ? `${primero} y ${ultimo}` : `${primero} a ${ultimo}`;
    if (g.clave === 'cerrado') return `${dias}: cerrado`;
    if (/^0?0:00$/.test(g.h.apertura) && g.h.cierre === '24:00') return `${dias}: abierto las 24 horas`;
    return `${dias}: ${hora12(g.h.apertura)} a ${hora12(g.h.cierre)}`;
  });
}

function entradaHorario(reglas, estadoRestaurante) {
  if (!horarioCompleto(reglas?.horarios)) return { omitida: 'horario incompleto o con horas inválidas' };
  let t = `*Horario*\n${lineasDeHorario(reglas.horarios).join('\n')}`;
  const especial = estadoRestaurante?.cierreEspecial;
  if (especial) {
    const h = String(especial.hora_cierre || '').trim();
    // «1:30 p. m.» ya termina en punto.
    t += HORA.test(h) ? `\nHoy cerramos a las ${hora12(h)}` : '\nHoy no abrimos.';
  }
  return { texto: t };
}

// ── UBICACIÓN, TIEMPOS, ENVÍO, PAGOS ───────────────────────────────────

function entradaUbicacion(cfg) {
  const direccion = sinPunto(cfg?.direccion);
  if (!direccion || direccion.length > 300) return { omitida: 'sin dirección del local (configuración «direccion»)' };
  const ciudad = sinPunto(cfg?.ciudad);
  const mapa = texto(cfg?.ubicacion);
  return { texto: `*Ubicación*\n${direccion}${ciudad && ciudad.length <= 80 ? `, ${ciudad}` : ''}.`
    + (/^https:\/\/\S+$/.test(mapa) && mapa.length <= 300 ? `\n${mapa}` : '') };
}

const tiposDeModalidad = (modalidades) => new Set((modalidadesDisponibles(modalidades) || []).map((m) => m.tipo));

function entradaTiempos(reglas, modalidades) {
  const p = reglas?.pedidos || {};
  const tipos = tiposDeModalidad(modalidades);
  const lineas = [];
  const entrega = tipos.has('domicilio') ? rangoEnMinutos(p.tiempo_entrega_min_minutos, p.tiempo_entrega_max_minutos) : null;
  if (entrega) lineas.push(`A domicilio: ${entrega}.`);
  const recoger = tipos.has('recoger') ? rangoEnMinutos(p.tiempo_preparacion_minutos, p.tiempo_preparacion_minutos) : null;
  if (recoger) lineas.push(`Para recoger: ${recoger}.`);
  if (!lineas.length) return { omitida: 'sin tiempos de entrega ni de preparación configurados' };
  return { texto: `*Tiempo estimado*\n${lineas.join('\n')}\nEs un estimado, no una hora garantizada.` };
}

function entradaEnvio(reglas, modalidades) {
  const p = reglas?.pedidos || {};
  if (!tiposDeModalidad(modalidades).has('domicilio')) {
    return { texto: '*Envío*\nPor ahora solo tenemos pedidos para recoger en tienda.' };
  }
  const lineas = ['*Envío a domicilio*'];
  const base = Number(p.costo_envio);
  if (p.costo_envio !== null && p.costo_envio !== '' && Number.isFinite(base) && base > 0) lineas.push(`Costo base: $${base}.`);
  const zonas = (Array.isArray(p.zonas_entrega) ? p.zonas_entrega : [])
    .filter((z) => texto(z?.nombre) && z?.costo !== null && z?.costo !== '' && Number.isFinite(Number(z?.costo)))
    .map((z) => `${texto(z.nombre)} $${Number(z.costo)}`);
  if (zonas.length) lineas.push(`Zonas con otro costo: ${zonas.join(' · ')}`);
  lineas.push('El costo final lo ves en el resumen, antes de confirmar.');
  return { texto: lineas.join('\n') };
}

/** Un texto del negocio que puede salir literal: corto, sin protocolo, sin afirmar un cambio ni frase prohibida. */
export function validarTextoFijo(valor, reglas, { maximo = 400 } = {}) {
  const t = texto(valor);
  return !!t && t.length <= maximo && !detectarSalidaInterna(t)
    && !respuestaAfirmaCambioSinAplicar({ texto: t, operaciones: [] })
    && !respuestaProhibidaEncontrada(t, reglas);
}

function entradaPagos(reglas, metodosPago) {
  const tipos = tiposDePagoDisponibles(metodosPago) || [];
  if (!tipos.length) return { omitida: 'sin formas de pago habilitadas para el bot' };
  const lineas = ['*Formas de pago*', ...tipos.map((t) => {
    const d = descripcionTipoPago(t);
    return `• ${capital(etiquetaTipoPago(t))}${d ? `: ${d.charAt(0).toLowerCase()}${d.slice(1)}` : ''}`;
  })];
  if (!tipos.includes('transferencia')) lineas.push('No manejamos transferencia ni depósito.');
  const instrucciones = reglas?.pedidos?.pago_instrucciones;
  if (validarTextoFijo(instrucciones, reglas)) lineas.push(texto(instrucciones));
  return { texto: lineas.join('\n') };
}

// ── PREGUNTAS FRECUENTES ───────────────────────────────────────────────

export function idDeFaq(pregunta) {
  return `faq:${createHash('sha1').update(normalizarEleccion(pregunta)).digest('hex').slice(0, 8)}`;
}

const PARTIR_FRASES = /\r?\n|(?<=[.!?;])\s+/;
/** ¿La regla de tarifas libres (contextoEnvio.js) le quitaría alguna frase? Entonces cotiza un envío. */
export function faqConTarifaDeEnvio({ pregunta, respuesta }, reglas) {
  const original = texto(respuesta);
  const partes = original.split(PARTIR_FRASES).map(texto).filter(Boolean);
  // Se parte igual que el original: sin zonas de entrega la regla devuelve el
  // texto entero (sin partir) y contar renglones marcaba como tarifa toda
  // respuesta de más de una frase (Acuña no tiene zonas).
  const quedan = contextoSinTarifasLibres(original, reglas?.pedidos || {}, pregunta).split(PARTIR_FRASES).map(texto).filter(Boolean);
  return quedan.length < partes.length;
}

const esFaqDeMesas = (f) => /\bmesas?\b|comer en el (?:local|restaurante)|reservaci/i.test(texto(f?.pregunta));

/** Una pregunta frecuente que no puede salir literal: el motivo, o null. */
export function motivoFaqInvalida(f, reglas) {
  if (!f || typeof f !== 'object') return 'no es un objeto';
  if (!texto(f.pregunta) || !texto(f.respuesta)) return 'pregunta o respuesta vacía';
  if (texto(f.respuesta).length > MAX_TEXTO) return 'respuesta de más de 1024 caracteres';
  if (faqConTarifaDeEnvio(f, reglas)) return 'menciona una tarifa de envío (la regla de tarifas la recortaría)';
  if (respuestaProhibidaEncontrada(f.respuesta, reglas)) return 'contiene una frase prohibida del negocio';
  if (detectarSalidaInterna(texto(f.respuesta))) return 'parece texto interno';
  if (respuestaAfirmaCambioSinAplicar({ texto: texto(f.respuesta), operaciones: [] })) return 'afirma un cambio al pedido';
  return null;
}

/** Valida una lista de preguntas frecuentes (el script de activación y el chequeo la usan). */
export function validarFaqs(faqs, reglas) {
  const errores = [];
  if (!Array.isArray(faqs)) return { ok: false, errores: ['no es una lista'] };
  faqs.forEach((f, i) => {
    const m = motivoFaqInvalida(f, reglas);
    if (m) errores.push(`${i + 1} «${texto(f?.pregunta).slice(0, 40)}»: ${m}`);
  });
  return { ok: !errores.length, errores };
}

/** Título de fila (≤ 24) y descripción (≤ 72) a partir de la pregunta. */
export function tituloDeFaq(pregunta) {
  const limpio = texto(pregunta).replace(/^[¿¡\s]+/, '').replace(/[?!\s]+$/, '').replace(/\s+/g, ' ');
  if (limpio.length <= MAX_TITULO) return { titulo: limpio, descripcion: '' };
  const palabras = limpio.split(' ');
  let titulo = '';
  for (const p of palabras) {
    const siguiente = titulo ? `${titulo} ${p}` : p;
    if (siguiente.length > MAX_TITULO - 1) break;
    titulo = siguiente;
  }
  let resto;
  if (!titulo) { titulo = limpio.slice(0, MAX_TITULO - 3); resto = limpio.slice(MAX_TITULO - 3); }
  else resto = limpio.slice(titulo.length).trim();
  const descripcion = resto.length <= MAX_DESCRIPCION ? resto : `${resto.slice(0, MAX_DESCRIPCION - 1)}…`;
  return { titulo: `${titulo}…`, descripcion };
}

// ── EL CATÁLOGO ────────────────────────────────────────────────────────

/**
 * Entrada = { id, titulo, descripcion, texto, origen: 'config'|'faq'|'dinamica', orden }.
 * La de promociones es dinámica (`texto: null`): la contesta el canal con la
 * fuente oficial al momento.
 */
export function catalogoDeRespuestas({ reglas = {}, cfg = {}, metodosPago = [], modalidades = null, estadoRestaurante = {} } = {}) {
  const entradas = [];
  const omitidas = [];
  const disponibles = modalidades ?? reglas?.pedidos?.modalidades ?? [];
  const derivadas = {
    horario: ['Horario', 'Días y horas de servicio', () => entradaHorario(reglas, estadoRestaurante)],
    ubicacion: ['Ubicación', 'Dirección y mapa', () => entradaUbicacion(cfg)],
    tiempos: ['Tiempo de entrega', 'A domicilio y para recoger', () => entradaTiempos(reglas, disponibles)],
    envio: ['Envío a domicilio', 'Costo y zonas', () => entradaEnvio(reglas, disponibles)],
    pagos: ['Formas de pago', 'Efectivo, tarjeta, enlace…', () => entradaPagos(reglas, metodosPago)],
    promociones: ['Promociones', 'Las de hoy', () => ({ texto: null, origen: 'dinamica' })],
    mesas: ['Mesas y reservaciones', '', () => {
      const r = respuestaSobreMesas(reglas);
      return r ? { texto: r } : { omitida: 'sin la pregunta frecuente de mesas' };
    }],
    como_pedir: ['Cómo pedir', 'Pasos para hacer tu pedido', () => ({ texto: FRASES.COMO_PEDIR })],
  };
  for (const id of ORDEN_CONFIG) {
    const [titulo, descripcionBase, armar] = derivadas[id];
    const r = armar();
    if (r.omitida) { omitidas.push({ id, motivo: r.omitida }); continue; }
    if (r.texto && r.texto.length > MAX_TEXTO) { omitidas.push({ id, motivo: 'texto de más de 1024 caracteres' }); continue; }
    // El texto de pagos lista las reales: la descripción también.
    const descripcion = id === 'pagos'
      ? (tiposDePagoDisponibles(metodosPago) || []).map((t) => capital(etiquetaTipoPago(t))).join(', ').slice(0, MAX_DESCRIPCION)
      : descripcionBase;
    entradas.push({ id, titulo, descripcion, texto: r.texto, origen: r.origen || 'config', orden: entradas.length });
  }
  const faqs = Array.isArray(reglas?.bot?.faqs) ? reglas.bot.faqs : [];
  const titulos = new Set(entradas.map((e) => e.titulo));
  const ids = new Set();
  for (const f of faqs) {
    const pregunta = texto(f?.pregunta);
    if (!pregunta) continue;
    const id = idDeFaq(pregunta);
    if (esFaqDeMesas(f)) { omitidas.push({ id, motivo: 'es la de mesas (entra como «mesas»)' }); continue; }
    const m = motivoFaqInvalida(f, reglas);
    if (m) { omitidas.push({ id, motivo: m }); continue; }
    if (ids.has(id)) { omitidas.push({ id, motivo: 'pregunta repetida' }); continue; }
    ids.add(id);
    let { titulo, descripcion } = tituloDeFaq(pregunta);
    // Meta exige títulos únicos en una lista.
    for (let n = 2; titulos.has(titulo); n++) titulo = `${n}. ${tituloDeFaq(pregunta).titulo}`.slice(0, MAX_TITULO);
    titulos.add(titulo);
    entradas.push({ id, titulo, descripcion, texto: texto(f.respuesta), origen: 'faq', orden: entradas.length, pregunta });
  }
  return { entradas, omitidas };
}

// ── LA COINCIDENCIA DETERMINISTA ───────────────────────────────────────

const RE = {
  horario: /\b(horarios?|a que hora (abren|cierran|abre|cierra)|hasta que hora|estan abiertos|abren (hoy|manana|el domingo|los domingos)|cierran (hoy|temprano)|que dias abren)\b/,
  ubicacion: /\b(donde (estan|se encuentran|queda|quedan|los encuentro)|cual es (su|la) (direccion|ubicacion)|(me (pasas|das|compartes|comparten|mandas)|pasame|mandame) (la )?(direccion|ubicacion)|ubicacion|como llego)\b/,
  ubicacionPropia: /\bmi (direccion|domicilio|casa)\b/,
  // «¿Cuál es la dirección en Acuña?» (c1876f06b) no la contesta la de este
  // local: otra sucursal u otro lugar no se adivina.
  ubicacionOtra: /\bsucursal(es)?\b|\b(direccion|ubicacion|ubicados?|estan|quedan?|se encuentran)\b.*\b(en|de) (?!(aqui|ahi|alla|ustedes|piedras negras|su (local|restaurante|negocio))\b)[a-zñ]{3,}/,
  tiempos: /\b(cuanto (tarda|tardan|demora|se tardan?)|tiempo (de|para) (entrega|preparacion)|en cuanto tiempo|cuanto tiempo)\b/,
  // Como lo escriben los clientes (7 días de Obispado): «Tiene servicio a
  // domicilio?» (cda850980), «cuentan con servicio a domicilio?» (c3f7254a9),
  // «cuentas con envío?» (c98cd8d95), «el envio es de cuanto?» (cde7d3a3e),
  // «cuánto cobra el servicio a domicilio?» (cbc7c109e), «tiene el día de hoy
  // para entregar a domicilio?» (cf3f29860).
  envio: /\b((costo|precio|cuanto (cuesta|cuestan|cobran|cobra|sale|es)) (del |de |el )?(envio|domicilio|servicio (a|de) domicilio)|(el )?envio (es )?de cuanto|me cobran? (el )?envio|hacen (envios?|entregas)|(tienen|tiene|tienes|cuentan con|cuenta con|cuentas con|manejan|maneja|ofrecen|dan) (el |un )?(servicio (a|de) domicilio|envios?|entregas? a domicilio|reparto|domicilio)|(entregar|entregan|llevar|llevan|mandar|mandan|enviar|envian) a domicilio|llevan a|entregan (en|a)|envian a|zonas? de entrega)\b/,
  // «trasferencia» (sin n) también: ced4cc7b4.
  pagos: /\b(tran?sferencias?|tran?sferir(le)?|deposito|aceptan tarjeta|que es (el|la) (enlace|link|liga))\b/,
  // «disculpa hoy tienes alguna promoción» (c98cd8d95): esConsultaDePromociones
  // (la del canal, que no se toca) pide «?» o empezar por que/cual/hay/tienen.
  promociones: /\b(?:tiene|tienes|tienen|hay|habra|manejan|maneja) (?:alguna |algun |una |un |la |las |de )?(?:promo|promos|promocion|promociones)\b/,
  promoQueCambia: /\b(?:usar|aplicar|aplicame|agrega|anade|ponme)\b|\b(?:pedido|orden)\b/,
  mesas: /\b(mesas?|comer (ahi|alli|en el (local|restaurante))|reservaci\w*|reservar|consumo en (el )?local)\b/,
  comoPedir: /\bcomo (hago|le hago|hacer|puedo hacer) (mi |un |el )?pedido\b|\bcomo funciona\b/,
  // «¿Me podrían explicar?» a secas sí es «cómo pedir»; «¿me podrían ayudar
  // con la factura?» no (c33c16f63): con un tema propio no se adivina.
  plegaria: /^(?:(?:mm+|oye|oiga|disculpe?|perdon|hola|buenas|buen dia|buenos dias|una pregunta|una duda|si|ok) )*(?:(?:me|nos) (?:podrian|podrias|podria|pueden|puedes|puede) (?:explicar|ayudar|apoyar|orientar|informar|aclarar)(?: (?:con )?(?:la |esa |esta )?(?:info|informacion|duda|eso|esto))?|explicame|expliqueme|explicanme|no (?:le )?entiendo|no entendi)(?: (?:por favor|porfa|porfavor|xfa|xfis|plis|nada|bien))?$/,
  informacion: /^(info(rmacion)?|informes|tengo (una )?(duda|pregunta)|dudas?|una pregunta)$/,
};

/** Los temas que salen de la configuración, como predicados sobre el mensaje normalizado. */
export const TEMAS = Object.freeze({
  horario: (t) => RE.horario.test(t),
  ubicacion: (t) => RE.ubicacion.test(t) && !RE.ubicacionPropia.test(t) && !RE.ubicacionOtra.test(t),
  tiempos: (t) => RE.tiempos.test(t),
  envio: (t) => RE.envio.test(t),
  pagos: (t) => PREGUNTA_DE_PAGO.test(t) || RE.pagos.test(t),
  mesas: (t) => RE.mesas.test(t),
  promociones: (t, mensaje) => esConsultaDePromociones(mensaje) || (RE.promociones.test(t) && !RE.promoQueCambia.test(t)),
  como_pedir: (t) => (PETICION_DE_EXPLICACION.test(t) && RE.plegaria.test(t)) || RE.comoPedir.test(t),
});
const ORDEN_TEMAS = ['horario', 'ubicacion', 'tiempos', 'envio', 'pagos', 'mesas', 'promociones', 'como_pedir'];

// Palabras que no distinguen una pregunta frecuente de otra.
export const VACIAS = Object.freeze(new Set(['tienen', 'hacen', 'puedo', 'como', 'donde', 'cuando', 'cuanto', 'para',
  'este', 'esta', 'ustedes', 'quiero', 'saber', 'tiene', 'hay', 'algun', 'alguna']));
export const palabrasDeContenido = (s) => [...new Set(normalizarEleccion(s).split(' ')
  .filter((w) => w.length >= 4 && /^[a-zñ]+$/.test(w) && !VACIAS.has(w)))];

/** ¿Todas las palabras de contenido de la pregunta aparecen en el mensaje? */
export function faqCoincide(pregunta, mensaje) {
  const claves = palabrasDeContenido(pregunta);
  if (!claves.length) return false;
  const delMensaje = normalizarEleccion(mensaje).split(' ').filter(Boolean);
  return claves.every((c) => delMensaje.some((w) => w === c || mismaPalabraFlexible(w, c)));
}

/**
 * El id de la respuesta aprobada que contesta el mensaje, 'informacion' (la
 * lista) o null. Determinista y conservadora: lo que no coincide de forma
 * única no se adivina. Un tema reconocido sin su entrada (dato faltante)
 * tampoco cae a otro tema.
 */
export function buscarRespuestaFija(mensaje, entradas = []) {
  const t = normalizarEleccion(mensaje);
  if (!t) return null;
  const hay = (id) => entradas.some((e) => e.id === id);
  for (const tema of ORDEN_TEMAS) {
    if (!TEMAS[tema](t, mensaje)) continue;
    if (hay(tema)) return tema;
    if (tema === 'mesas') continue; // sin la pregunta de mesas, «mesa» no es un tema
    return null;
  }
  if (RE.informacion.test(t)) return 'informacion';
  const faqs = entradas.filter((e) => e.origen === 'faq' && faqCoincide(e.pregunta || e.titulo, mensaje));
  return faqs.length === 1 ? faqs[0].id : null;
}

/** El tema de configuración que una pregunta frecuente duplicaría, o null (validación del archivo). */
export function temaDeConfigDe(pregunta) {
  const t = normalizarEleccion(pregunta);
  return TEMAS_DE_CONFIG.find((tema) => TEMAS[tema](t, pregunta)) || null;
}
