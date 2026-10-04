// Modo formulario / recepcionista (src/mesero-agente/recepcionista.js): las
// garantías que no pueden romperse sin que el despliegue se entere. Puro: sin
// base de datos, Meta, red ni modelo. Corre en el predeploy
// (predeploy-check-incidentes.mjs) y termina con error si algo falla.
//
// Cada sección tiene su MORDIDA interna: un caso construido con el defecto que
// el validador debe rechazar. Si alguien afloja un validador, su mordida falla.
//
//   1. Las claves del modo se leen solo en recepcionista.js y activacionModoIA.js.
//   2. modoIA: igualdad estricta, alcance, precondiciones (falla cerrada).
//   3. Textos de persona en la lista cerrada del recibo; motivos con P3 y etiquetas.
//   4. Ninguna frase invita a escribir el pedido ni afirma un cambio.
//   5. El selector solo elige: enum por turno, herramienta forzada, nunca texto del modelo.
//   6. C1: el candado del ejecutor.
//   7. Con `recepcion`, el turno nunca llama al modelo.
//   8. La activación se niega sin cada precondición que bloquea (y con faqs sin aprobar).
//   9. Ciclos de importación: cada punto de entrada carga solo, en un proceso limpio.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { modoIA, precondicionesDeTurno, CLAVES_IA, FRASES, TEXTOS_PERSONA, MOTIVOS_RECEPCION, construirRecepcion, PIE_SIN_BOTONES, NO_RECONOCIDO_SIN_BOTONES,
  SALUDO_SIN_BOTONES } from '../src/mesero-agente/recepcionista.js';
import { ETIQUETAS_RECEPCION } from '../src/mesero-agente/frasesRecepcion.js';
import { TEXTOS_RECIBO_HANDOFF, textosDelRecibo } from '../src/mesero-agente/reciboHandoff.js';
import { MOTIVOS_PETICION, ETIQUETA_MOTIVO, grupoDelMotivo, motivoDeDineroOIncierto } from '../src/services/pausaVencePolitica.js';
import { etiquetaDeMotivo } from '../src/services/avisoRescateHumano.js';
import { respuestaAfirmaCambioSinAplicar } from '../src/mesero-agente/seguridadConversacional.js';
import { detectarSalidaInterna } from '../src/mesero-agente/salidaPublicable.js';
import { catalogoDeRespuestas } from '../src/mesero-agente/respuestasFijas.js';
import { crearEjecutor, estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { accionInteractiva } from '../src/mesero-agente/autoridadInteractiva.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { planActivacionModoIA } from '../src/mesero-agente/activacionModoIA.js';
import { payloadInteractivoValido } from '../src/mesero-agente/transporteInteractivo.js';
import { herramientaSelector, parametrosDelSelector, elegirRespuesta, DECISIONES_FIJAS } from '../src/mesero-agente/selectorRecepcionista.js';
import { construirAvisoFueraDeHorario } from '../src/mesero-agente/horarioDelAgente.js';
import { textoEstadoDePedido } from '../src/mesero-agente/estadoOperativoDelPedido.js';
import * as F from './fixture-tienda-plomeria.mjs';

const raiz = fileURLToPath(new URL('../', import.meta.url));
let pasadas = 0, fallidas = 0;
const t = async (nombre, fn) => { try { await fn(); pasadas++; } catch (e) { fallidas++; console.error(`FALLA check-modo-ia ${nombre}: ${e.message}`); } };

// Variables de proceso que las precondiciones leen; solo durante este chequeo.
const ENTORNO = { WHATSAPP_INTERACTIVOS: 'true', MESERO_AGENTE_MODE: 'true', WHATSAPP_FLOW_ENDPOINT: 'true',
  WHATSAPP_FLOW_PRIVATE_KEY: 'x', META_APP_SECRET: 'x' };
const previo = Object.fromEntries(Object.keys(ENTORNO).map((k) => [k, process.env[k]]));
Object.assign(process.env, ENTORNO);

/** Una configuración de Obispado con el modo encendido y todas sus precondiciones. */
export const cfgModo = (extra = {}) => ({ ...F.cfgTienda('true'), whatsapp_interactivos_v1: 'true',
  whatsapp_interactivos_elecciones_v1: 'true', whatsapp_rescate_humano_v1: 'true', whatsapp_beta_hibrido_v1: 'true',
  whatsapp_eventos_formulario_v1: 'true', whatsapp_flow_evento_id: '77777777777',
  [CLAVES_IA.MODO]: 'formulario', [CLAVES_IA.ALCANCE]: 'todos', ...extra });

try {
  // ── 1. Las claves solo se leen en dos archivos ─────────────────────────
  const PERMITIDOS = ['src/mesero-agente/recepcionista.js', 'src/mesero-agente/activacionModoIA.js'];
  const CADENAS = /whatsapp_ia_(?:modo|selector|silencio)/;
  const archivosDe = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? archivosDe(p) : /\.(?:m?js|cjs)$/.test(n) ? [p] : [];
  });
  const lectoresIndebidos = (archivos) => archivos.filter(([ruta, fuente]) => CADENAS.test(fuente)
    && !PERMITIDOS.includes(ruta.replaceAll('\\', '/')));
  await t('1 las claves whatsapp_ia_* aparecen en src/ solo en recepcionista.js y activacionModoIA.js', () => {
    const archivos = archivosDe(join(raiz, 'src')).map((p) => [relative(raiz, p), readFileSync(p, 'utf8')]);
    assert(archivos.some(([r]) => r.replaceAll('\\', '/') === PERMITIDOS[0]), 'no encontré recepcionista.js');
    assert.deepEqual(lectoresIndebidos(archivos).map(([r]) => r), []);
    // Mordida: un tercer archivo que lee la clave se detecta.
    assert.deepEqual(lectoresIndebidos([['src/mesero-agente/otro.js', "cfg.whatsapp_ia_modo_v1==='formulario'"]]).length, 1);
  });

  // ── 2. modoIA ──────────────────────────────────────────────────────────
  const T = F.TELEFONO;
  const problemasDeModo = (fn) => {
    const fallas = [];
    const nulos = { ausente: cfgModo({ [CLAVES_IA.MODO]: undefined }), vacio: cfgModo({ [CLAVES_IA.MODO]: '' }),
      true: cfgModo({ [CLAVES_IA.MODO]: 'true' }), mayusculas: cfgModo({ [CLAVES_IA.MODO]: 'FORMULARIO' }),
      espacio: cfgModo({ [CLAVES_IA.MODO]: ' formulario' }), sin_alcance: cfgModo({ [CLAVES_IA.ALCANCE]: undefined }),
      alcance_raro: cfgModo({ [CLAVES_IA.ALCANCE]: 'Todos' }),
      prueba_otro_telefono: cfgModo({ [CLAVES_IA.ALCANCE]: 'prueba', [CLAVES_IA.TELEFONOS]: F.OTRO_TELEFONO }),
      prueba_sin_lista: cfgModo({ [CLAVES_IA.ALCANCE]: 'prueba' }) };
    for (const [n, cfg] of Object.entries(nulos)) if (fn(cfg, T) !== null) fallas.push(`${n} no es null`);
    const ok = fn(cfgModo(), T);
    if (!ok?.completo || ok.modo !== 'formulario') fallas.push('la configuración completa no enciende');
    if (!fn(cfgModo({ [CLAVES_IA.ALCANCE]: 'prueba', [CLAVES_IA.TELEFONOS]: `${F.OTRO_TELEFONO},${T}` }), T)?.completo) fallas.push('prueba con el teléfono en la lista no enciende');
    if (fn(cfgModo({ [CLAVES_IA.MODO]: 'recepcionista' }), T)?.modo !== 'recepcionista') fallas.push('recepcionista no enciende');
    const caidas = { formularios: { whatsapp_flows_v1: 'false' }, elecciones: { whatsapp_interactivos_elecciones_v1: 'false' },
      rescate: { whatsapp_rescate_humano_v1: '' }, inicio_mapo: { whatsapp_inicio_mapo_v1: 'false' },
      beta_hibrida: { whatsapp_beta_hibrido_v1: 'false' }, eventos_formulario: { whatsapp_eventos_formulario_v1: 'false' },
      interactivos: { whatsapp_interactivos_v1: 'false' } };
    for (const [id, extra] of Object.entries(caidas)) {
      const m = fn(cfgModo(extra), T);
      if (!m || m.completo || !m.faltan.includes(id)) fallas.push(`sin ${id}: ${JSON.stringify(m)?.slice(0, 80)}`);
    }
    return fallas;
  };
  await t('2 modoIA: null salvo el valor exacto con alcance válido; sin una precondición, completo=false con su id', () => {
    assert.deepEqual(problemasDeModo(modoIA), []);
    assert.deepEqual(precondicionesDeTurno(cfgModo(), T), []);
    // Mordida: un modoIA que acepta 'true' (o ignora la lista de prueba) se detecta.
    const laxo = (cfg, tel) => modoIA({ ...cfg, [CLAVES_IA.MODO]: cfg[CLAVES_IA.MODO] === 'true' ? 'formulario' : cfg[CLAVES_IA.MODO] }, tel);
    assert(problemasDeModo(laxo).some((f) => f.startsWith('true ')));
    const sinLista = (cfg, tel) => modoIA({ ...cfg, ...(cfg[CLAVES_IA.ALCANCE] === 'prueba' ? { [CLAVES_IA.TELEFONOS]: tel } : {}) }, tel);
    assert(problemasDeModo(sinLista).some((f) => f.startsWith('prueba_otro_telefono')));
  });

  // ── 3. Textos de persona y motivos ─────────────────────────────────────
  const problemasDeMotivos = ({ recibo, peticion, etiquetasPausa, etiquetaAviso }) => {
    const fallas = [];
    for (const texto of TEXTOS_PERSONA) if (!recibo.includes(texto)) fallas.push(`texto fuera del recibo: ${texto.slice(0, 40)}`);
    for (const m of Object.values(MOTIVOS_RECEPCION)) {
      if (m === MOTIVOS_RECEPCION.QUEJA_PAGO) {
        if (peticion.has(m) || grupoDelMotivo(m) !== null || !motivoDeDineroOIncierto(m)) fallas.push(`${m} debe ser dinero y nunca vencer`);
      } else if (!peticion.has(m)) fallas.push(`${m} no vence como petición`);
      if (etiquetasPausa[m] !== ETIQUETAS_RECEPCION[m]?.pausa) fallas.push(`${m} sin etiqueta de pausa`);
      if (etiquetaAviso(m) !== ETIQUETAS_RECEPCION[m]?.aviso) fallas.push(`${m} sin etiqueta de aviso`);
    }
    return fallas;
  };
  const real = { recibo: textosDelRecibo(true), peticion: MOTIVOS_PETICION, etiquetasPausa: ETIQUETA_MOTIVO, etiquetaAviso: etiquetaDeMotivo };
  await t('3 textos de persona en el recibo del modo (y fuera del de siempre); motivos en MOTIVOS_PETICION (QUEJA_PAGO nunca vence) y con etiquetas', () => {
    assert.deepEqual(problemasDeMotivos(real), []);
    assert.deepEqual(TEXTOS_RECIBO_HANDOFF.slice(0, 2), ['Permíteme un momento, te paso con alguien del equipo para atenderte bien.',
      'Te paso con alguien del equipo para que te atienda mejor. Un momento, por favor.']);
    // Sin la bandera, la lista es la de fc1c803: tres textos, ninguno del modo.
    assert.equal(TEXTOS_RECIBO_HANDOFF.length, 3);
    assert.deepEqual(textosDelRecibo(false), TEXTOS_RECIBO_HANDOFF);
    assert(!TEXTOS_PERSONA.some((x) => TEXTOS_RECIBO_HANDOFF.includes(x)), 'un texto del modo entró a la lista de siempre');
    // Mordidas: sin un texto en el recibo, sin un motivo en P3 o sin una etiqueta.
    assert(problemasDeMotivos({ ...real, recibo: textosDelRecibo(true).filter((x) => x !== FRASES.PERSONA_PEDIDO) }).length);
    assert(problemasDeMotivos({ ...real, peticion: new Set([...MOTIVOS_PETICION].filter((m) => m !== 'RECEPCION_INSISTE')) }).length);
    assert(problemasDeMotivos({ ...real, peticion: new Set([...MOTIVOS_PETICION, 'RECEPCION_QUEJA_PAGO']) }).length);
    assert(problemasDeMotivos({ ...real, etiquetaAviso: () => 'otra' }).length);
  });

  // ── 4. Ninguna frase invita a escribir el pedido ───────────────────────
  // «te escribe» (el personal le escribirá) no es invitar al cliente a escribir.
  const INVITA = /\b((?<!\bte )(?<!\ble )escr[ií]be(me|nos)?|d[ií]me|cu[eé]ntame|me dices|qu[eé] (te gustar[ií]a|se te antoja|deseas) (pedir|ordenar|agregar)|te lo anoto|anoto)\b/i;
  const problemasDeFrase = (nombre, texto) => {
    const fallas = [];
    // Excepciones explícitas: «no abre» (el rescate) y «escribe «hablar con
    // alguien»» (el camino a una persona). Ninguna es escribir el pedido.
    const sinExcepcion = (nombre === 'PEDIDO_ESCRITO' ? texto.replace('«no abre»', '') : texto)
      .replace(/escribe «hablar con alguien»/g, '');
    if (INVITA.test(sinExcepcion)) fallas.push(`${nombre} invita a escribir`);
    if (respuestaAfirmaCambioSinAplicar({ texto, operaciones: [] })) fallas.push(`${nombre} afirma un cambio`);
    if (detectarSalidaInterna(texto)) fallas.push(`${nombre} parece salida interna`);
    if (texto.length > 1024) fallas.push(`${nombre} pasa de 1024`);
    return fallas;
  };
  await t('4 FRASES y textos derivados de una configuración de muestra: sin invitar a escribir el pedido ni afirmar un cambio', () => {
    const frases = Object.entries(FRASES).map(([k, v]) => [k, typeof v === 'function' ? v('https://xabor.mx/t/mapolato') : v]);
    const reglas = { ...F.reglas, horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
      .map((d) => [d, { abierto: d !== 'martes', apertura: '07:30', cierre: '15:00' }])),
    pedidos: { ...F.reglas.pedidos, tiempo_entrega_min_minutos: 45, tiempo_entrega_max_minutos: 45, tiempo_preparacion_minutos: 25,
      pago_instrucciones: 'Si pagas en efectivo, ten tu cambio listo.' },
    bot: { faqs: [{ pregunta: '¿Tienen mesas?', respuesta: 'Sí, tenemos mesas.' }, { pregunta: 'Cumpleaños', respuesta: 'Desayunas gratis.' }] } };
    const { entradas } = catalogoDeRespuestas({ reglas, cfg: { direccion: 'Libramiento 2416', ciudad: 'Piedras Negras' },
      metodosPago: [...F.metodosPago, { tipo: 'enlace_pago' }], modalidades: F.modalidades, estadoRestaurante: { abierto: true } });
    // PARTE 2: el acuse de cerrado (con y sin hora de apertura, con y sin tienda) y el estado de un pedido.
    const cerrados = [null, { estado: 'publicada', aceptaProgramados: true, slug: 'mapolato' }].flatMap((tienda) =>
      [reglas, { ...reglas, horarios: Object.fromEntries(Object.keys(reglas.horarios).map((d) => [d, { abierto: false }])) }].map((r, i) =>
        [`cerrado:${tienda ? 'tienda' : 'sin'}:${i}`, construirAvisoFueraDeHorario({ estadoRestaurante: { abierto: false, diaActual: 'lunes',
          fechaHoy: '2026-10-05' }, reglas: r, configTienda: tienda, recepcion: true })]));
    const estados = ['nuevo', 'en_preparacion', 'listo'].map((e) => [`estado:${e}`, textoEstadoDePedido({ folio: 'XAB-1', estado: e,
      modalidad: 'entrega a domicilio' }, reglas)]);
    const todos = [...frases, ...cerrados, ...estados, ['PIE_SIN_BOTONES', PIE_SIN_BOTONES], ['NO_RECONOCIDO_SIN_BOTONES', NO_RECONOCIDO_SIN_BOTONES],
      ['SALUDO_SIN_BOTONES', SALUDO_SIN_BOTONES], ...entradas.filter((e) => e.texto).map((e) => [`entrada:${e.id}`, e.texto])];
    assert(todos.length >= 30, `${todos.length} textos`);
    assert.deepEqual(todos.flatMap(([n, v]) => problemasDeFrase(n, v)), []);
    // Mordidas: una frase que invita a escribir el pedido o que afirma un cambio.
    assert(problemasDeFrase('X', 'Dime qué deseas pedir y te lo anoto.').length);
    assert(problemasDeFrase('X', 'Listo, ya agregué tus chilaquiles a tu pedido.').length);
  });
  await t('4b los botones y la lista de recepción pasan payloadInteractivoValido', () => {
    const cfg = cfgModo();
    for (const menu of ['botones', 'botones_hoy', 'informacion']) {
      const e = F.estado({ pendiente: { tipo: 'recepcion', menu } });
      e.dialogo.texto = FRASES.NO_RECONOCIDO;
      const p = construirRecepcion({ estado: e, pedido: { huella: null, total: null }, texto: FRASES.NO_RECONOCIDO, cfg, telefono: T,
        entradas: [{ id: 'horario', titulo: 'Horario', descripcion: 'Días y horas' }, { id: 'faq:12345678', titulo: 'Cumpleaños', descripcion: '' }] });
      assert(p, menu);
      assert(payloadInteractivoValido(p.carga, FRASES.NO_RECONOCIDO), `${menu} inválido`);
    }
  });

  // ── 5. El selector solo elige ──────────────────────────────────────────
  const ENTRADAS_MUESTRA = [{ id: 'horario', titulo: 'Horario', texto: '*Horario*\nLunes a domingo', origen: 'config' },
    { id: 'promociones', titulo: 'Promociones', texto: null, origen: 'dinamica' }, { id: 'faq:12345678', titulo: 'Cumpleaños', texto: 'Desayunas gratis.', origen: 'faq' }];
  const SECRETO = 'TEXTO_DEL_MODELO_que_no_debe_salir';
  const muestra = (input, texto = SECRETO) => async () => ({ stop_reason: 'tool_use',
    content: [{ type: 'text', text: texto }, { type: 'tool_use', id: 't1', name: 'elegir', input }] });
  const problemasDelSelector = async ({ herramienta, parametros, elegir }) => {
    const fallas = [];
    const h = herramienta(ENTRADAS_MUESTRA);
    if (JSON.stringify(h.input_schema?.properties?.decision?.enum) !== JSON.stringify([...ENTRADAS_MUESTRA.map((e) => e.id), ...DECISIONES_FIJAS])) {
      fallas.push('el enum no es «ids vigentes + fijas»');
    }
    if (h.input_schema?.additionalProperties !== false || h.strict !== true) fallas.push('esquema no estricto');
    const p = parametros({ mensaje: 'hola', entradas: ENTRADAS_MUESTRA, nombreNegocio: 'X' });
    if (JSON.stringify(p.tool_choice) !== JSON.stringify({ type: 'tool', name: 'elegir' })) fallas.push('la herramienta no va forzada');
    if ('temperature' in p) fallas.push('lleva temperature (400 en los modelos 5)');
    if (p.messages?.length !== 1) fallas.push('lleva historial');
    const r = await elegir({ mensaje: '¿a qué hora abren?', entradas: ENTRADAS_MUESTRA, llamarModelo: muestra({ decision: 'horario', confianza: 'alta' }) });
    if (JSON.stringify(Object.keys(r || {}).sort()) !== JSON.stringify(['confianza', 'decision', 'error', 'ms'])) fallas.push(`devuelve ${Object.keys(r || {})}`);
    if (JSON.stringify(r).includes(SECRETO)) fallas.push('devuelve texto del modelo');
    if (r?.decision !== 'horario') fallas.push(`no eligió: ${r?.decision}`);
    const ajeno = await elegir({ mensaje: 'x', entradas: ENTRADAS_MUESTRA, llamarModelo: muestra({ decision: 'faq:deadbeef', confianza: 'alta' }) });
    if (ajeno?.decision !== 'ninguna') fallas.push('aceptó un id que no es de este turno');
    const lanza = await elegir({ mensaje: 'x', entradas: ENTRADAS_MUESTRA, llamarModelo: async () => { throw new Error('caída'); } }).catch(() => null);
    if (lanza?.decision !== 'ninguna') fallas.push('una caída del proveedor no es «ninguna»');
    return fallas;
  };
  const selectorReal = { herramienta: herramientaSelector, parametros: parametrosDelSelector, elegir: elegirRespuesta };
  await t('5 selector: enum por turno, herramienta forzada, sin temperature; devuelve solo la decisión, nunca texto del modelo', async () => {
    assert.deepEqual(await problemasDelSelector(selectorReal), []);
    // Mordidas: un selector que devuelve el texto, un enum fijo, una herramienta no forzada.
    const conTexto = { ...selectorReal, elegir: async (a) => ({ ...(await elegirRespuesta(a)), texto: SECRETO }) };
    assert((await problemasDelSelector(conTexto)).some((f) => /texto del modelo|devuelve/.test(f)));
    const enumFijo = { ...selectorReal, herramienta: (e) => { const h = herramientaSelector(e); h.input_schema.properties.decision.enum.push('faq:inexistente'); return h; } };
    assert((await problemasDelSelector(enumFijo)).some((f) => /enum/.test(f)));
    const libre = { ...selectorReal, parametros: (a) => ({ ...parametrosDelSelector(a), tool_choice: { type: 'auto' }, temperature: 0 }) };
    assert.equal((await problemasDelSelector(libre)).length, 2);
  });

  // ── 6. C1, el candado del ejecutor ─────────────────────────────────────
  const carta = F.carta();
  const ejecutorDe = (recepcion, mensaje = 'quiero un café americano') => {
    const estado = F.estado();
    return { estado, ej: crearEjecutor({ estado, catalogo: carta, mensaje, textoCiclo: mensaje, recepcion,
      modalidades: F.modalidades, metodosPago: F.metodosPago }) };
  };
  const esC1 = (r) => r?.aplicado === false && /recepcion_solo_formulario/.test(String(r?.motivo || ''));
  await t('6 C1: con recepcion, agregar_producto sin elección validada se rechaza; con accionInteractiva se aplica; confirmar, persona y cancelar con D1 pasan', async () => {
    const a = ejecutorDe(true);
    assert(esC1(await a.ej.ejecutar('agregar_producto', { producto_id: '3', cantidad: 1 })), 'C1 no rechazó');
    assert.equal(a.estado.carrito.items.length, 0);
    const accion = accionInteractiva('agregar_producto', { producto_id: '3', cantidad: 1 }, a.estado);
    const r = await a.ej.ejecutar(accion.herramienta, accion.argumentos, { autorizacion: accion.autorizacion });
    assert(!esC1(r) && r.aplicado === true, `con elección validada: ${JSON.stringify(r).slice(0, 120)}`);
    for (const [h, args, aut] of [['confirmar_pedido', { huella_resumen: 'x' }, null], ['pedir_humano', { motivo: 'x' }, null],
      ['cancelar_pedido', { motivo: 'x' }, { tipo: 'cancelacion_explicita' }]]) {
      assert(!esC1(await ejecutorDe(true, 'cancela mi pedido').ej.ejecutar(h, args, { autorizacion: aut })), `${h} lo frenó C1`);
    }
    for (const h of ['modificar_linea', 'quitar_linea', 'definir_entrega', 'definir_pago', 'definir_cliente', 'programar_para']) {
      const args = { linea_id: 'L1', modalidad: 'recoger en tienda', forma_pago: 'efectivo', nombre: 'Ana', fecha: '2026-10-05', hora: '10:00' };
      assert(esC1(await ejecutorDe(true).ej.ejecutar(h, args)), `${h} pasó C1`);
    }
    assert(esC1(await ejecutorDe(true, 'cancela mi pedido').ej.ejecutar('cancelar_pedido', { motivo: 'x' })), 'cancelar sin D1 pasó');
    // Mordida: sin recepcion, el mismo agregar_producto no lo frena C1 (la prueba distingue).
    assert(!esC1(await ejecutorDe(false).ej.ejecutar('agregar_producto', { producto_id: '3', cantidad: 1 })));
  });

  // ── 7. Con recepcion, nunca el modelo ──────────────────────────────────
  const turno = async (recepcion, mensaje, estado = F.estado({ items: 'dos' })) => {
    let llamadas = 0;
    const s = await atenderTurnoConHerramientas({ negocioId: 'n', conversacionId: estado.conversacionId, turnoId: `t-${mensaje}`,
      mensaje, catalogo: carta, modalidades: F.modalidades, metodosPago: F.metodosPago, reglas: F.reglas, estado, recepcion,
      llamarModelo: async () => { llamadas++; throw new Error('EL_MODELO_NO_SE_LLAMA'); } });
    return { s, llamadas };
  };
  const MENSAJES = ['quiero dos chilaquiles verdes con pollo', 'agrega otro café', 'sin cebolla', 'la segunda', 'a domicilio',
    'pago en efectivo', 'hola', 'qué trae el café', 'mejor quita el café', 'para mañana a las 10', 'asdf'];
  await t('7 atenderTurnoConHerramientas con recepcion y sin respuesta de sistema nunca llama al modelo ni muta el carrito', async () => {
    for (const m of MENSAJES) {
      const { s, llamadas } = await turno(true, m);
      assert.equal(llamadas, 0, `${m}: llamó al modelo`);
      assert(!s.operaciones.some((o) => o.resultado?.aplicado && !['ver_pedido', 'buscar_producto'].includes(o.herramienta)), `${m}: mutó`);
      assert.equal(s.estado.carrito.items.length, 2, `${m}: el carrito cambió`);
    }
    // Mordida: sin recepcion, el mismo turno sí llega al modelo.
    assert((await turno(false, 'quiero dos chilaquiles verdes con pollo')).llamadas > 0);
  });

  // ── 8. La activación ───────────────────────────────────────────────────
  const hechos = { carta, modalidades: F.modalidades, metodosPago: F.metodosPago, reglas: F.reglas,
    configTienda: { estado: 'publicada', aceptaProgramados: true, slug: 'mapolato' } };
  const cfgActivable = () => ({ ...cfgModo({ [CLAVES_IA.MODO]: undefined, [CLAVES_IA.ALCANCE]: undefined }),
    mesero_agente_v1: 'true', mesero_agente_porcentaje: '100', mesero_agente_telefonos: '', bot_whatsapp_solo_prueba: 'false' });
  await t('8 planActivacionModoIA se niega sin cada precondición que bloquea', () => {
    const ok = planActivacionModoIA(cfgActivable(), { modo: 'formulario', alcance: 'todos', hechos });
    assert(!ok.error, ok.error);
    const caidas = { mesero: { mesero_agente_v1: 'false' }, alcance_mesero: { mesero_agente_porcentaje: '50' },
      formularios: { whatsapp_flows_v1: 'false' }, interactivos_negocio: { whatsapp_interactivos_v1: 'false' },
      elecciones: { whatsapp_interactivos_elecciones_v1: 'false' }, rescate: { whatsapp_rescate_humano_v1: 'false' },
      inicio_mapo: { whatsapp_inicio_mapo_v1: 'false' }, beta_hibrida: { whatsapp_beta_hibrido_v1: 'false' },
      eventos_formulario: { whatsapp_flow_evento_id: '' } };
    for (const [id, extra] of Object.entries(caidas)) {
      const p = planActivacionModoIA({ ...cfgActivable(), ...extra }, { modo: 'formulario', alcance: 'todos', hechos });
      assert.match(String(p.error), new RegExp(`\\b${id}\\b`), `${id}: ${p.error}`);
    }
    assert.match(String(planActivacionModoIA(cfgActivable(), { modo: 'formulario', alcance: 'todos', hechos: { ...hechos, carta: [] } }).error), /formulario_pedido/);
    // El catering heredado (brain.js contesta con texto del modelo) bloquea.
    assert.match(String(planActivacionModoIA(cfgActivable(), { modo: 'formulario', alcance: 'todos', hechos: { ...hechos, comercialCatering: true } }).error),
      /catering_legado/);
    assert.match(String(planActivacionModoIA(cfgActivable(), { modo: 'formulario', alcance: 'todos', hechos, publicarSelector: true }).error), /solo va con --recepcionista/);
    // Un archivo de preguntas frecuentes con una marca [CONFIRMAR …] no se carga.
    const reglasMuestra = JSON.stringify({ ...F.reglas, horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'].map((d) => [d, { abierto: true, apertura: '07:30', cierre: '15:00' }])),
      cierres_especiales: [], promociones: [], politicas: [], pedidos: { ...F.reglas.pedidos, costo_envio: 60, pedido_minimo_entrega: 0 } });
    assert.match(String(planActivacionModoIA({ ...cfgActivable(), reglas_atencion: reglasMuestra }, { modo: 'recepcionista', alcance: 'todos', hechos,
      faqs: [{ pregunta: 'Rosas', respuesta: 'Cuestan [CONFIRMAR CON MARIO].' }] }).error), /CONFIRMAR/);
    assert(!planActivacionModoIA({ ...cfgActivable(), reglas_atencion: reglasMuestra }, { modo: 'recepcionista', alcance: 'todos', hechos,
      faqs: [{ pregunta: 'Cumpleaños', respuesta: 'Desayunas gratis.' }] }).error);
  });

  // ── 9. Ciclos de importación ───────────────────────────────────────────
  // recepcionista.js, inicioMapo.js, interactivos.js y reciboHandoff.js se
  // importan entre sí. Hoy ninguna constante de nivel superior usa un valor del
  // ciclo; si alguien agrega una, el arranque fallaría según qué módulo entre
  // primero. Cada punto de entrada se importa PRIMERO en un proceso limpio.
  const cargaSola = (url) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `try { await import(${JSON.stringify(url)}); process.exit(0); } catch (e) { console.error(String(e?.stack || e).split('\\n').slice(0, 3).join(' | ')); process.exit(3); }`],
    { encoding: 'utf8', timeout: 60000, env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || 'postgresql://nadie@127.0.0.1:1/ninguna' } });
    return r.status === 0 ? null : `${url.split('/').pop()}: ${(r.stderr || '').trim().slice(0, 200) || `salida ${r.status}`}`;
  };
  await t('9 cada punto de entrada del ciclo carga solo en un proceso limpio', () => {
    const entradas = ['src/mesero-agente/recepcionista.js', 'src/mesero-agente/inicioMapo.js', 'src/mesero-agente/interactivos.js',
      'src/mesero-agente/reciboHandoff.js', 'src/mesero-agente/respuestasFijas.js', 'src/mesero-agente/canalDelAgente.js',
      'src/orders/modoDelPedido.js'];
    assert.deepEqual(entradas.map((p) => cargaSola(pathToFileURL(join(raiz, p)).href)).filter(Boolean), []);
    // Mordida: un ciclo con una constante de nivel superior que usa un valor del otro módulo se detecta.
    const dir = mkdtempSync(join(tmpdir(), 'ciclo-ia-'));
    try {
      writeFileSync(join(dir, 'a.mjs'), "import { B } from './b.mjs';\nexport const A = 1;\nexport const DOBLE = B * 2;\n");
      writeFileSync(join(dir, 'b.mjs'), "import { A } from './a.mjs';\nexport const B = A + 1;\n");
      assert(cargaSola(pathToFileURL(join(dir, 'a.mjs')).href), 'el ciclo roto no se detectó');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
} finally {
  for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

console.log(`modo formulario / recepcionista: ${pasadas} pasadas, ${fallidas} fallidas`);
assert.equal(fallidas, 0);
