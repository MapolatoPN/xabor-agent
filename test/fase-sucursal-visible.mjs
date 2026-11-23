// ─── EL BOT DICE DE QUÉ SUCURSAL ES (XAB-3915), SIN BASE ─────────────────
//
// 23-nov-2026: un cliente de Acuña escribió al WhatsApp de Obispado, llenó el
// formulario y confirmó un pedido «para recoger» sin que ningún mensaje dijera
// de qué sucursal era. Obispado lo preparó en vano. Cubre:
//
//   · whatsapp_sucursal_visible_v1: el saludo, «Revisa tu pedido» y la
//     confirmación nombran sucursal y ciudad; APAGADA, el texto es idéntico;
//   · whatsapp_sucursales_hermanas: quien busca la otra sucursal recibe su
//     WhatsApp y su tienda (frases reales de Obispado), sin falsos positivos
//     con la calle «Manuel Acuña» ni con el apellido;
//   · el saludo avisa a quien solo ha pedido en la hermana (lectura con doble).
//
// Filtrar casos para las mordidas: CASOS=S3,H2 node test/fase-sucursal-visible.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../src/mesero-agente/sucursalVisible.js';
import * as R from '../src/mesero-agente/recepcionista.js';
import * as RF from '../src/mesero-agente/respuestasFijas.js';
import * as F from '../scripts/fixture-tienda-plomeria.mjs';
import { CLAVES_IA } from '../src/mesero-agente/recepcionista.js';
import { entradaMapo } from '../src/mesero-agente/inicioMapo.js';
import { respuestaDesdePedido } from '../src/mesero-agente/recuperacionDelTurno.js';
import { aplicarRespuestaDeConfirmacion, aplicarRespuestaDePago } from '../src/mesero-agente/canalDelAgente.js';

// Lo mismo que fase-ia-recepcion.mjs: sin esto el modo formulario no está completo.
Object.assign(process.env, { WHATSAPP_INTERACTIVOS: 'true', MESERO_AGENTE_MODE: 'true', WHATSAPP_FLOW_ENDPOINT: 'true',
  WHATSAPP_FLOW_PRIVATE_KEY: 'x', META_APP_SECRET: 'x' });

const OB = '5de544d8-9a0a-4972-9c92-fd48ff22de66';
const AC = 'bb27290a-3359-4348-ba60-03d89f97127f';
const HERMANAS_OB = JSON.stringify([{ nombre: 'Mapolato Acuña', ciudad: 'Acuña', whatsapp: '528771077571',
  tienda: 'https://xabor.mx/t/mapolato-acuna', negocio_id: AC }]);
const HERMANAS_AC = JSON.stringify([{ nombre: 'Mapolato Obispado', ciudad: 'Piedras Negras', whatsapp: '528781042714',
  tienda: 'https://xabor.mx/t/mapolato-obispado', negocio_id: OB, alias: ['obispado'] }]);
const OBISPADO = { nombre: 'Mapolato Obispado', ciudad: 'Piedras Negras',
  direccion: 'Libramiento Manuel Pérez Treviño 2416, Colonia Tecnológico' };
const ACUNA = { nombre: 'Mapolato Acuña', ciudad: 'Acuña', direccion: 'Aquiles Serdán 735, Colonia Benito Juárez' };
const VISIBLE = { [S.CLAVE_SUCURSAL_VISIBLE]: 'true' };

const filtro = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
let pasadas = 0; let fallidas = 0;
async function caso(nombre, fn) {
  if (filtro.length && !filtro.some((f) => nombre.startsWith(f + ' '))) return;
  try { await fn(); pasadas++; console.log(`  ok  ${nombre}`); }
  catch (e) { fallidas++; console.log(`  FALLA ${nombre}\n        ${String(e?.message || e).split('\n').join('\n        ')}`); }
}

// El pedido de XAB-3915, tal como lo vio el cliente (recoger, terminal).
const PEDIDO_3915 = {
  lineas: [
    { cantidad: 1, producto: 'Bowl de Chilaquiles', precio_unitario: 175, opciones: [], gruposEnOrden: [] },
    { cantidad: 1, producto: 'Cuernito Bacon Cheese', precio_unitario: 189, opciones: [], gruposEnOrden: [] },
  ],
  modalidad: 'recoger en tienda', forma_pago: 'terminal', cliente: { nombre: 'Cliente' }, subtotal: 364, total: 364,
  falta: [], aclaraciones: [],
};
const resumen = (sucursal, pedido = PEDIDO_3915) => respuestaDesdePedido({ estado: F.estado({ pendiente: null, items: 'dos' }),
  pedido, modalidades: F.modalidades, metodosPago: F.metodosPago, requierePago: false, sucursal });
const REGLAS_TIEMPO = { pedidos: { tiempo_preparacion_minutos: 25, tiempo_entrega_min_minutos: 45, tiempo_entrega_max_minutos: 45 } };
const confirmacion = ({ sucursal = null, modalidad = 'recoger en tienda', forma_pago = 'terminal', enlace = null } = {}) => {
  const salida = { texto: 'x', operaciones: [{ herramienta: 'confirmar_pedido',
    resultado: { aplicado: true, folio: 'XAB-3915', total: 849, costo_envio: 0, ...(enlace ? { enlace_pago: enlace } : {}) } }] };
  const estado = { carrito: { datos: { modalidad, forma_pago, cliente: {} }, items: [{ cantidad: 5 }] } };
  aplicarRespuestaDeConfirmacion({ salida, estado, reglas: REGLAS_TIEMPO, sucursal });
  aplicarRespuestaDePago({ salida, estado, reglas: REGLAS_TIEMPO, sucursal });
  return salida.texto;
};

// Las 15 frases de clientes en el WhatsApp de Obispado que buscaban Acuña
// (5-oct → 23-nov-2026), más dos de septiembre.
const BUSCAN_ACUNA = [
  'Disculpe el pedido es en acuña',
  'Ohhh ya vi que hay otro para Acuña 😭 discúlpeme',
  'Tienen en Acuña',
  'Hola! Buen dia, queria saber si los platillos de Pavo tambien estaran disponibles en Sucursal Acuña o solo en PN?',
  'Está abierto en cd Acuña?',
  'Buenas tardes qué precio tendrá el platillo de pavo en ciudad Acuña? Gracias',
  'De la sucursal de Acuña',
  'Es en Acuña verdad?',
  'Si tienen la promoción de combitos? El segundo a mitad de precio en acuña',
  'Hola buenos días, me pueden pasar el menú de acuña?',
  'este chat igual es para acuna?',
  'Buenos dias! Disculpe, sabrá si la sucursal de Ciudad acuña tiene un número al que me pueda comunicar?',
  'Disculpe ,cual es la direccion en acuña?',
  'Aquie. En acuña',
  'Acuña',
];
const NO_BUSCAN = [
  'Calle Manuel Acuña 302 col centro',
  'mi dirección es manuel acuna 302',
  'en manuel acuña esquina con zaragoza',
  'Soy Juan Acuña, quiero chilaquiles',
  'Hernández Acuña',
  'Buen dia',
  'Para hacer un pedido',
  'Hablar con alguien',
  'quiero unos chilaquiles en Piedras Negras',
  '',
];

try {
  // ── S: la sucursal visible ─────────────────────────────────────────────
  await caso('S1 apagada por omisión: sin la bandera no hay sucursal', () => {
    assert.equal(S.sucursalVisible(OBISPADO), null);
    assert.equal(S.sucursalVisible({ ...OBISPADO, [S.CLAVE_SUCURSAL_VISIBLE]: 'TRUE' }), null);
    assert.equal(S.sucursalVisible({ ...OBISPADO, [S.CLAVE_SUCURSAL_VISIBLE]: ' true' }), null);
    assert.equal(S.sucursalVisible({ ciudad: 'Piedras Negras', ...VISIBLE }), null, 'sin nombre no hay qué decir');
  });
  await caso('S2 encendida: nombre y ciudad; la ciudad no se repite si el nombre ya la trae', () => {
    assert.equal(S.sucursalVisible({ ...OBISPADO, ...VISIBLE }).etiqueta, 'Mapolato Obispado · Piedras Negras');
    assert.equal(S.sucursalVisible({ ...ACUNA, ...VISIBLE }).etiqueta, 'Mapolato Acuña');
    assert.equal(S.sucursalVisible({ nombre: 'Mapolato  Obispado ', ...VISIBLE }).etiqueta, 'Mapolato Obispado');
  });
  await caso('S3 saludo: apagada, idéntico al de hoy; encendida, «de *Mapolato Obispado* (Piedras Negras)»', () => {
    const base = { whatsapp_inicio_mapo_v1: 'true', ...OBISPADO };
    const ahora = new Date('2026-11-23T15:20:33Z');
    const hoy = entradaMapo({ cfg: base, estado: F.estado({ pendiente: null }), mensaje: 'Buen dia', ahora });
    assert.equal(hoy.texto, '¡Hola, buenos días! Soy *Mapo Bot*. Nuestro personal se encuentra algo ocupado, pero estoy aquí para servirte.\n\n¿Cómo puedo ayudarte?');
    const nuevo = entradaMapo({ cfg: { ...base, ...VISIBLE }, estado: F.estado({ pendiente: null }), mensaje: 'Buen dia', ahora });
    assert.equal(nuevo.texto, '¡Hola, buenos días! Soy *Mapo Bot* de *Mapolato Obispado* (Piedras Negras). Nuestro personal se encuentra algo ocupado, pero estoy aquí para servirte.\n\n¿Cómo puedo ayudarte?');
    const acuna = entradaMapo({ cfg: { whatsapp_inicio_mapo_v1: 'true', ...ACUNA, ...VISIBLE }, estado: F.estado({ pendiente: null }), mensaje: 'hola', ahora });
    assert.match(acuna.texto, /Soy \*Mapo Bot\* de \*Mapolato Acuña\*\. Nuestro/);
  });
  await caso('S4 «Revisa tu pedido»: renglón «Sucursal:» después de «Modalidad:»; sin sucursal, idéntico', () => {
    const sin = resumen(null);
    const con = resumen(S.sucursalVisible({ ...OBISPADO, ...VISIBLE }));
    assert.equal(con, sin.replace('Modalidad: Recoger en tienda\n', 'Modalidad: Recoger en tienda\nSucursal: *Mapolato Obispado · Piedras Negras*\n'));
    assert.ok(!sin.includes('Sucursal'), 'sin la bandera el resumen no cambia');
    assert.match(con, /Sucursal: \*Mapolato Obispado · Piedras Negras\*[\s\S]*¿Confirmas este pedido\?$/);
  });
  await caso('S5 confirmación de XAB-3915: dice dónde se recoge, con dirección y ciudad', () => {
    const hoy = confirmacion();
    assert.equal(hoy, 'Tu pedido XAB-3915 quedó registrado por $849 MXN. Pago con tarjeta en terminal. Estará listo para recoger en unos 25 minutos.');
    assert.equal(confirmacion({ sucursal: S.sucursalVisible({ ...OBISPADO, ...VISIBLE }) }),
      `${hoy} Recoges en Mapolato Obispado: Libramiento Manuel Pérez Treviño 2416, Colonia Tecnológico, Piedras Negras.`);
  });
  await caso('S6 a domicilio dice quién lo prepara; sin dirección configurada, solo sucursal y ciudad', () => {
    const s = S.sucursalVisible({ ...OBISPADO, ...VISIBLE });
    assert.match(confirmacion({ sucursal: s, modalidad: 'entrega a domicilio', forma_pago: 'efectivo' }),
      /Pago en efectivo\. Tiempo estimado de entrega: unos 45 minutos\. Lo prepara Mapolato Obispado · Piedras Negras\.$/);
    assert.equal(S.fraseDeConfirmacion(S.sucursalVisible({ nombre: 'Mapolato Obispado', ciudad: 'Piedras Negras', ...VISIBLE }),
      'recoger en tienda'), 'Recoges en Mapolato Obispado · Piedras Negras.');
  });
  await caso('S7 con enlace de pago, la sucursal va antes de la liga', () => {
    const t = confirmacion({ sucursal: S.sucursalVisible({ ...OBISPADO, ...VISIBLE }), forma_pago: 'enlace_pago', enlace: 'https://pago.clip.mx/v3/abc' });
    assert.match(t, /Recoges en Mapolato Obispado: Libramiento Manuel Pérez Treviño 2416, Colonia Tecnológico, Piedras Negras\.\n\nPaga aquí con el enlace seguro:\nhttps:\/\/pago\.clip\.mx\/v3\/abc$/);
    assert.ok(!confirmacion({ forma_pago: 'enlace_pago', enlace: 'https://pago.clip.mx/v3/abc' }).includes('Recoges'));
  });
  await caso('S8 cableado: todos los resúmenes del agente pasan por la sucursal, y el turno la recibe', () => {
    const agente = readFileSync(new URL('../src/mesero-agente/agenteDelMesero.js', import.meta.url), 'utf8');
    const directas = agente.split('\n').filter((l) => /respuestaDesdePedido\(\{/.test(l) && !/=> respuestaDesdePedido\(\{ \.\.\.o, sucursal \}\)/.test(l));
    assert.deepEqual(directas, [], 'un resumen nuevo debe usar resumenDesdePedido para llevar la sucursal');
    const canal = readFileSync(new URL('../src/mesero-agente/canalDelAgente.js', import.meta.url), 'utf8');
    assert.match(canal, /sucursal: sucursalVisible\(cfg\),\n\s+configTienda,/, 'baseDelTurno lleva la sucursal');
    assert.match(canal, /aplicarRespuestaDeConfirmacion\(\{ salida, estado, zonaDelNegocio: reglas\?\.timezone, reglas, sucursal: sucursalDelTurno \}\)/);
  });

  // ── H: sucursales hermanas ─────────────────────────────────────────────
  await caso('H1 configuración: lo inválido se descarta; la ciudad propia no cuenta como hermana', () => {
    assert.deepEqual(S.sucursalesHermanas({}), []);
    assert.deepEqual(S.sucursalesHermanas({ [S.CLAVE_HERMANAS]: '{no es json' }), []);
    assert.deepEqual(S.sucursalesHermanas({ [S.CLAVE_HERMANAS]: '{"nombre":"x"}' }), []);
    const h = S.sucursalesHermanas({ ...OBISPADO, [S.CLAVE_HERMANAS]: HERMANAS_OB });
    assert.equal(h.length, 1); assert.equal(h[0].whatsapp, '528771077571'); assert.equal(h[0].negocioId, AC);
    assert.deepEqual(S.sucursalesHermanas({ ...OBISPADO, [S.CLAVE_HERMANAS]: JSON.stringify([
      { nombre: 'Otra', ciudad: 'Piedras Negras', whatsapp: '528781111111' },
      { nombre: 'Sin destino', ciudad: 'Saltillo' },
      { nombre: 'Liga http', ciudad: 'Saltillo', tienda: 'http://x.mx' },
      { ciudad: 'Saltillo', whatsapp: '528441111111' },
    ]) }), []);
  });
  await caso('H2 las frases reales que buscaban Acuña se reconocen', () => {
    const cfg = { ...OBISPADO, [S.CLAVE_HERMANAS]: HERMANAS_OB };
    const fallan = BUSCAN_ACUNA.filter((m) => S.hermanaMencionada(m, cfg)?.nombre !== 'Mapolato Acuña');
    assert.deepEqual(fallan, []);
  });
  await caso('H3 sin falsos positivos: calle Manuel Acuña, apellido, la ciudad propia', () => {
    const cfg = { ...OBISPADO, [S.CLAVE_HERMANAS]: HERMANAS_OB };
    const disparan = NO_BUSCAN.filter((m) => S.hermanaMencionada(m, cfg));
    assert.deepEqual(disparan, []);
    assert.equal(S.hermanaMencionada('Disculpe el pedido es en acuña', OBISPADO), null, 'sin hermanas configuradas no hay nada');
  });
  await caso('H4 desde Acuña también: «en Piedras Negras», «sucursal Obispado» (alias)', () => {
    const cfg = { ...ACUNA, [S.CLAVE_HERMANAS]: HERMANAS_AC };
    for (const m of ['es en piedras negras?', 'pedí en la sucursal de Obispado', 'Para Piedras Negras porfa', 'obispado']) {
      assert.equal(S.hermanaMencionada(m, cfg)?.nombre, 'Mapolato Obispado', m);
    }
    for (const m of ['vivo por la calle piedras', 'tienen negras?', 'en acuña']) assert.equal(S.hermanaMencionada(m, cfg), null, m);
  });
  await caso('H5 el texto lleva las dos ligas; con pedido confirmado, cómo cancelarlo', () => {
    const cfg = { ...OBISPADO, [S.CLAVE_HERMANAS]: HERMANAS_OB };
    const [h] = S.sucursalesHermanas(cfg);
    const antes = S.textoParaHermana({ cfg, hermana: h });
    assert.equal(antes, 'Este WhatsApp es de *Mapolato Obispado*, en Piedras Negras.\n\n'
      + 'Para *Mapolato Acuña* escríbeles a su WhatsApp:\nhttps://wa.me/528771077571\n'
      + 'O pide en línea:\nhttps://xabor.mx/t/mapolato-acuna\n\n'
      + 'Si tu mensaje es para Piedras Negras, aquí te atendemos.');
    const despues = S.textoParaHermana({ cfg, hermana: h, folio: 'XAB-3915' });
    assert.match(despues, /Tu pedido XAB-3915 quedó registrado aquí, en Piedras Negras\. Si era para Acuña, escribe «hablar con alguien» y el equipo lo cancela\.$/);
    assert.match(S.textoParaHermana({ cfg, hermana: h, cerrado: true }), /aquí te atendemos en cuanto abramos\.$/);
    assert.ok(antes.length <= 1024 && despues.length <= 1024);
    // Desde Acuña el nombre ya trae la ciudad: no se repite arriba, pero abajo sí hace falta.
    const ac = { ...ACUNA, [S.CLAVE_HERMANAS]: HERMANAS_AC };
    const [o] = S.sucursalesHermanas(ac);
    assert.match(S.textoParaHermana({ cfg: ac, hermana: o }), /^Este WhatsApp es de \*Mapolato Acuña\*\.\n[\s\S]*\n\nSi tu mensaje es para Acuña, aquí te atendemos\.$/);
    assert.match(S.textoParaHermana({ cfg: ac, hermana: o, folio: 'XAB-1' }), /quedó registrado aquí, en Acuña\. Si era para Piedras Negras,/);
  });

  // ── R: el router del modo formulario ───────────────────────────────────
  const cfgModo = (extra = {}) => ({ ...F.cfgTienda('true'), whatsapp_interactivos_v1: 'true',
    whatsapp_interactivos_elecciones_v1: 'true', whatsapp_rescate_humano_v1: 'true', whatsapp_beta_hibrido_v1: 'true',
    whatsapp_eventos_formulario_v1: 'true', whatsapp_flow_evento_id: '77777777777', ...OBISPADO,
    [CLAVES_IA.MODO]: 'formulario', [CLAVES_IA.ALCANCE]: 'todos', ...extra });
  const decidir = async (mensaje, { cfg = cfgModo({ [S.CLAVE_HERMANAS]: HERMANAS_OB }), estado = F.estado({ pendiente: null }), abierto = true } = {}) => {
    const ia = R.modoIA(cfg, F.TELEFONO);
    assert(ia?.completo, `el modo no está completo: ${ia?.faltan}`);
    const estadoRestaurante = { abierto, diaActual: 'lunes', fechaHoy: '2026-11-23', preApertura: false };
    const { entradas } = RF.catalogoDeRespuestas({ reglas: F.reglas, cfg, metodosPago: F.metodosPago, modalidades: F.modalidades, estadoRestaurante });
    const nada = async () => null;
    return R.decidirRecepcion({ ia, cfg, reglas: F.reglas, estado, mensaje, catalogo: [], metodosPago: F.metodosPago,
      modalidades: F.modalidades, estadoRestaurante, negocioId: OB, telefono: F.TELEFONO, entradas,
      lectores: { ultimoSaliente: nada, pedidosActivos: async () => [], formularioReciente: async () => false,
        formularioRescate: async () => false, estadoOperativo: nada, promocionesOficiales: nada } });
  };
  const confirmadoEn = (folio) => { const e = F.estado({ pendiente: null, items: 'dos' }); e.folio = folio; e.hechos.confirmado = true; return e; };

  await caso('R1 XAB-3915: «el pedido es en acuña» tras confirmar → ligas de Acuña y cómo cancelar (antes: «no te entendí»)', async () => {
    const d = await decidir('Disculpe el pedido es en acuña', { estado: confirmadoEn('XAB-3915') });
    assert.equal(d.ruta, 'respuesta'); assert.equal(d.recepcion?.paso, 'R5'); assert.equal(d.recepcion?.tipo, 'otra_sucursal');
    assert.equal(d.respuesta?.tipo, 'recepcion_otra_sucursal');
    assert.match(d.respuesta.texto, /https:\/\/wa\.me\/528771077571/);
    assert.match(d.respuesta.texto, /Tu pedido XAB-3915 quedó registrado aquí/);
    assert.deepEqual(d.respuesta.acciones, []); assert.equal(d.persona, null, 'no pausa: la pausa descartaría el texto');
    const sin = await decidir('Disculpe el pedido es en acuña', { estado: confirmadoEn('XAB-3915'), cfg: cfgModo() });
    assert.notEqual(sin.recepcion?.tipo, 'otra_sucursal', 'sin hermanas configuradas, como hoy');
  });
  await caso('R2 antes de pedir: «¿Es en Acuña verdad?» → ligas, sin folio; cerrado, igual', async () => {
    const d = await decidir('Es en Acuña verdad?');
    assert.equal(d.recepcion?.tipo, 'otra_sucursal');
    assert.match(d.respuesta.texto, /Si tu mensaje es para Piedras Negras, aquí te atendemos\.$/);
    const c = await decidir('Está abierto en cd Acuña?', { abierto: false });
    assert.equal(c.recepcion?.tipo, 'otra_sucursal');
    assert.match(c.respuesta.texto, /en cuanto abramos\.$/);
  });
  await caso('R3 «hablar con alguien» después sigue pasando al equipo', async () => {
    const d = await decidir('Hablar con alguien', { estado: confirmadoEn('XAB-3915') });
    assert.equal(d.ruta, 'persona'); assert.equal(d.persona?.motivo, R.MOTIVOS_RECEPCION.PIDE_PERSONA);
  });

  // ── A: aviso en el saludo a quien solo ha pedido en la hermana ─────────
  const dbDoble = (filas, { falla = false } = {}) => { const llamadas = [];
    return { llamadas, query: async (q) => { llamadas.push(q); if (falla) throw new Error('caída'); return { rows: filas }; } }; };
  const CFG_A = { ...OBISPADO, [S.CLAVE_HERMANAS]: HERMANAS_OB };

  await caso('A1 pidió solo en Acuña → la hermana; también pidió aquí → null', async () => {
    const solo = dbDoble([{ negocio_id: AC }]);
    assert.equal((await S.hermanaDelCliente(solo, { cfg: CFG_A, negocioId: OB, telefono: '5218771094362' }))?.nombre, 'Mapolato Acuña');
    assert.deepEqual(solo.llamadas[0].values, [[OB, AC], '8771094362']);
    assert.match(solo.llamadas[0].text, /right\(regexp_replace\(datos->'cliente'->>'telefono', '\\D', '', 'g'\), 10\) = \$2/,
      'la misma expresión del índice idx_pedidos_activos_negocio_tel10');
    assert.equal(await S.hermanaDelCliente(dbDoble([{ negocio_id: AC }, { negocio_id: OB }]), { cfg: CFG_A, negocioId: OB, telefono: '5218771094362' }), null);
    assert.equal(await S.hermanaDelCliente(dbDoble([]), { cfg: CFG_A, negocioId: OB, telefono: '5218771094362' }), null);
  });
  await caso('A2 falla cerrado: sin hermanas, sin negocio_id, teléfono raro o base caída → null y sin consulta de más', async () => {
    const d = dbDoble([{ negocio_id: AC }]);
    assert.equal(await S.hermanaDelCliente(d, { cfg: OBISPADO, negocioId: OB, telefono: '5218771094362' }), null);
    const sinId = { ...OBISPADO, [S.CLAVE_HERMANAS]: JSON.stringify([{ nombre: 'Mapolato Acuña', ciudad: 'Acuña', whatsapp: '528771077571' }]) };
    assert.equal(await S.hermanaDelCliente(d, { cfg: sinId, negocioId: OB, telefono: '5218771094362' }), null);
    assert.equal(await S.hermanaDelCliente(d, { cfg: CFG_A, negocioId: OB, telefono: 'pos-c4004d5fd8dd' }), null);
    assert.equal(d.llamadas.length, 0);
    assert.equal(await S.hermanaDelCliente(dbDoble([], { falla: true }), { cfg: CFG_A, negocioId: OB, telefono: '5218771094362' }), null);
  });
  await caso('A3 el aviso entra antes de «¿Cómo puedo ayudarte?», que sigue al final junto a los botones', () => {
    const [h] = S.sucursalesHermanas(CFG_A);
    const saludo = '¡Hola, buenos días! Soy *Mapo Bot* de *Mapolato Obispado* (Piedras Negras). Nuestro personal se encuentra algo ocupado, pero estoy aquí para servirte.\n\n¿Cómo puedo ayudarte?';
    const t = S.insertarAntesDeLaPregunta(saludo, S.avisoClienteDeHermana({ cfg: CFG_A, hermana: h }));
    assert.equal(t, '¡Hola, buenos días! Soy *Mapo Bot* de *Mapolato Obispado* (Piedras Negras). Nuestro personal se encuentra algo ocupado, pero estoy aquí para servirte.\n\n'
      + '📍 Tus pedidos anteriores fueron en *Mapolato Acuña*. Este WhatsApp es de Piedras Negras; si tu pedido es para Acuña, escríbeles aquí:\nhttps://wa.me/528771077571\n\n'
      + '¿Cómo puedo ayudarte?');
    assert.equal(S.insertarAntesDeLaPregunta(saludo, ''), saludo);
    assert.ok(t.length <= 1024);
  });
  await caso('A4 cableado: el canal pide el historial SOLO cuando sale el saludo', () => {
    const canal = readFileSync(new URL('../src/mesero-agente/canalDelAgente.js', import.meta.url), 'utf8');
    assert.match(canal, /if \(abrirMapo\) \{\n\s+const aviso = avisoClienteDeHermana\(\{ cfg, hermana: await hermanaDelCliente\(db, \{ cfg, negocioId, telefono \}\) \}\);/);
    assert.equal(canal.split('hermanaDelCliente(').length - 1, 1);
  });
} finally {
  console.log(`\nsucursal visible: ${pasadas} pasadas, ${fallidas} fallidas`);
  if (fallidas) process.exitCode = 1;
}
