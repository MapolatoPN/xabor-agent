// ─── MODO FORMULARIO / RECEPCIONISTA: CON LA BANDERA SIN VALOR, NADA CAMBIA ─
//
// Compara, byte a byte, lo que arma el código de la base (el src/ de fc1c803,
// o BASE_IA) con lo que arma este checkout, para cada forma de «sin valor» de
// la bandera (ausente, 'false', 'true', 'FORMULARIO', modo sin alcance, alcance
// raro, prueba con otro teléfono):
//
//   · el turno del Mesero (atenderTurnoConHerramientas) sobre los guiones del
//     replay y un corpus de 40 textos y 12 toques: texto, pendiente,
//     operaciones (herramienta, argumentos, aplicado), carrito, fase y
//     recuperación;
//   · inicio Mapo (lista, entrada, opción, vigencia), cerrado, programados,
//     respuestaDesdePedido, estado operativo, aplicarRespuestaDeEntrega, el
//     rescate (respuesta, salida, decisión), grupoDelMotivo, el ejecutor (todas
//     las herramientas) y el esquema de los pendientes de la base;
//   · TEXTOS_RECIBO_HANDOFF es exactamente la de hoy y permiteReciboHandoff no
//     deja pasar un texto del modo; modoDelPedido decide igual y no alerta.
//
// Pura (sin base, Meta ni red), pero necesita git: corre en el host, no en la
// imagen productiva (como fase-tienda-bandera-apagada.mjs).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as F from '../scripts/fixture-tienda-plomeria.mjs';
import { NEGOCIOS, preciosDe } from './replay/cartas.mjs';

Object.assign(process.env, { WHATSAPP_INTERACTIVOS: 'true', MESERO_AGENTE_MODE: 'true', WHATSAPP_FLOW_ENDPOINT: 'true',
  WHATSAPP_FLOW_PRIVATE_KEY: 'x', META_APP_SECRET: 'x' });

const raiz = fileURLToPath(new URL('../', import.meta.url));
const BASE = process.env.BASE_IA || 'fc1c803';
// El repositorio del que se lee la base (una copia para mordidas no es un repositorio).
const GIT = process.env.BASE_IA_GIT || raiz;
let pasadas = 0, fallidas = 0;
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
const t = async (nombre, fn) => {
  if (SOLO.length && !SOLO.some((p) => nombre.startsWith(p))) return;
  try { await fn(); pasadas++; console.log(`  ok  ${nombre}`); } catch (e) {
    fallidas++;
    // Dónde empiezan a diferir (el mensaje de assert trunca).
    const [a, b] = [String(e.actual ?? ''), String(e.expected ?? '')];
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    const donde = e.actual !== undefined ? ` · difiere en ${i}: nuevo «${a.slice(Math.max(0, i - 80), i + 120)}» base «${b.slice(Math.max(0, i - 80), i + 120)}»` : '';
    console.log(`FALLA ${nombre}: ${String(e.message).split('\n')[0]}${donde}`);
  }
};
// Lo aleatorio sale igual en las dos corridas solo si se nombra por orden de aparición:
// los uuid (diálogo, pregunta) y los lid de renglón (it + reloj en base 36).
const estable = (s) => { const m = new Map();
  return String(s).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\bit[0-9a-z]{9,13}\b/g,
    (x) => { if (!m.has(x)) m.set(x, `ID${m.size}`); return m.get(x); }); };
const json = (v) => estable(JSON.stringify(v)).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, 'FECHA');
const sinTokens = (v) => JSON.parse(JSON.stringify(v ?? null).replace(/xb1:[A-Za-z0-9_-]{22}/g, 'TOKEN')
  .replace(/"preguntaId":"[0-9a-f-]{36}"/g, '"preguntaId":"ID"'));

// El src/ (y edge/, que importa la impresión) de la base, dentro del checkout
// para resolver el mismo node_modules. Una sola llamada a git.
const destino = mkdtempSync(join(raiz, '.base-ia-'));
try {
  const archivos = execFileSync('git', ['ls-tree', '-r', '--name-only', BASE, 'src', 'edge'], { cwd: GIT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const salida = spawnSync('git', ['cat-file', '--batch'], { cwd: GIT, input: archivos.map((a) => `${BASE}:${a}`).join('\n') + '\n', maxBuffer: 1 << 30 });
  assert.equal(salida.status, 0, String(salida.stderr));
  let pos = 0;
  for (const archivo of archivos) {
    const fin = salida.stdout.indexOf(10, pos), cabecera = salida.stdout.subarray(pos, fin).toString('utf8');
    const m = /^[0-9a-f]{40} blob (\d+)$/.exec(cabecera);
    assert(m, `git cat-file: ${cabecera}`);
    const tam = Number(m[1]);
    mkdirSync(dirname(join(destino, archivo)), { recursive: true });
    writeFileSync(join(destino, archivo), salida.stdout.subarray(fin + 1, fin + 1 + tam));
    pos = fin + 1 + tam + 1;
  }
  const viejo = async (r) => import(pathToFileURL(join(destino, r)).href);
  const nuevo = async (r) => import(pathToFileURL(join(raiz, r)).href);
  const par = async (r) => [await viejo(r), await nuevo(r)];
  const [Va, Na] = await par('src/mesero-agente/agenteDelMesero.js');
  const [Ve, Ne] = await par('src/mesero-agente/ejecutorDeHerramientas.js');
  const [Vm, Nm] = await par('src/mesero-agente/inicioMapo.js');
  const [Vh, Nh] = await par('src/mesero-agente/horarioDelAgente.js');
  const [Vr, Nr] = await par('src/mesero-agente/recuperacionDelTurno.js');
  const [Vo, No] = await par('src/mesero-agente/estadoOperativoDelPedido.js');
  const [Vc, Nc] = await par('src/mesero-agente/canalDelAgente.js');
  const [Vx, Nx] = await par('src/mesero-agente/rescateHumano.js');
  const [Vp, Np] = await par('src/services/pausaVencePolitica.js');
  const [Vk, Nk] = await par('src/mesero-agente/estadoCanonico.js');
  const [, Nrh] = await par('src/mesero-agente/reciboHandoff.js');
  const [Vci, Nci] = await par('src/mesero-agente/cicloDelAgente.js');
  const R = await nuevo('src/mesero-agente/recepcionista.js');
  const [Vl, Nl] = await par('src/mesero-agente/libroDeOperaciones.js');
  const [Vd, Nd] = await par('src/mesero-agente/contratoConversacional.js');

  // Las formas de «sin valor»: con todas las precondiciones encendidas, para
  // que la única diferencia posible sea la bandera.
  const cfgBase = { ...F.cfgTienda('true'), whatsapp_interactivos_v1: 'true', whatsapp_interactivos_elecciones_v1: 'true',
    whatsapp_rescate_humano_v1: 'true', whatsapp_beta_hibrido_v1: 'true', whatsapp_eventos_formulario_v1: 'true',
    whatsapp_flow_evento_id: '77777777777' };
  const APAGADAS = [['ausente', {}], ['false', { whatsapp_ia_modo_v1: 'false', whatsapp_ia_modo_alcance: 'todos' }],
    ['true', { whatsapp_ia_modo_v1: 'true', whatsapp_ia_modo_alcance: 'todos' }],
    ['FORMULARIO', { whatsapp_ia_modo_v1: 'FORMULARIO', whatsapp_ia_modo_alcance: 'todos' }],
    ['sin alcance', { whatsapp_ia_modo_v1: 'formulario' }], ['alcance raro', { whatsapp_ia_modo_v1: 'formulario', whatsapp_ia_modo_alcance: 'Todos' }],
    ['prueba otro teléfono', { whatsapp_ia_modo_v1: 'recepcionista', whatsapp_ia_modo_alcance: 'prueba', whatsapp_ia_modo_telefonos: F.OTRO_TELEFONO }]];
  const COMBOS = APAGADAS.map(([n, extra]) => [n, { ...cfgBase, ...extra }]);
  const T = F.TELEFONO;

  await t('P0 cada combinación deja el modo apagado (modoIA null) y sin botones de recepción', () => {
    for (const [n, cfg] of COMBOS) {
      assert.equal(R.modoIA(cfg, T), null, n);
      const e = F.estado({ pendiente: { tipo: 'recepcion', menu: 'botones' } }); e.dialogo.texto = 'x';
      assert.equal(R.construirRecepcion({ estado: e, pedido: { huella: 'h', total: 0 }, texto: 'x', cfg, telefono: T, entradas: [] }), null, n);
      assert.equal(R.valorDeRecepcionVigente('informacion', { cfg, telefono: T }), false, n);
    }
  });

  // ── El turno del Mesero ────────────────────────────────────────────────
  const huellaDeTurno = (s) => ({ texto: s.texto, pendiente: s.pendiente ?? null, motivoCierre: s.motivoCierre,
    operaciones: (s.operaciones || []).map((o) => [o.herramienta, o.argumentos, !!o.resultado?.aplicado, o.resultado?.motivo ?? null]),
    carrito: s.estado?.carrito, fase: s.estado?.fase, recuperacion: s.recuperacion ?? null, escalado: !!s.escalado,
    respuestaDeSistema: s.respuestaDeSistema ?? null, folio: s.folio ?? null });
  const modeloDeGuion = (pasos) => { let i = 0; return async () => { const p = pasos[i++];
    if (!p) return { stop_reason: 'end_turn', content: [{ type: 'text', text: '(guion agotado)' }] };
    if (p.texto !== undefined) return { stop_reason: 'end_turn', content: [{ type: 'text', text: p.texto }] };
    return { stop_reason: 'tool_use', content: (p.tools || []).map((x, n) => ({ type: 'tool_use', id: `tu_${i}_${n}`, name: x.name, input: x.input })) }; }; };
  const resolver = (v, catalogo, vivo) => {
    if (typeof v === 'string') {
      const id = /^\$id:(.+)$/.exec(v); if (id) { for (const c of catalogo) for (const p of c.productos || []) if (p.nombre === id[1]) return String(p.id); }
      if (v === '$huella') return vivo().huella;
      const l = /^\$linea:(\d+)$/.exec(v); if (l) return vivo().lineas[Number(l[1])]?.linea_id;
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => resolver(x, catalogo, vivo));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolver(x, catalogo, vivo)]));
    return v;
  };
  async function correr(M, E, L, D, fixture, cfg) {
    const negocio = NEGOCIOS[fixture.negocio]; const catalogo = negocio.catalogo; const precios = preciosDe(catalogo);
    const estado = { ...E.estadoNuevo({ negocioId: negocio.id, conversacionId: `p-${fixture.id}` }), ...(fixture.estado_inicial || {}) };
    const libro = L.libroDeOperaciones(L.almacenEnMemoria());
    const vivo = () => E.crearEjecutor({ estado, catalogo, precios, mensaje: '' }).vista();
    const efectos = { confirmar: async () => ({ ok: true, folio: 'XAB-P1' }), escalar: async () => ({ ok: true }) };
    const salidas = []; let n = 0;
    for (const turno of fixture.turnos || []) {
      n++;
      const guion = (turno.guion || []).map((p) => (p.tools ? { tools: p.tools.map((x) => ({ ...x, input: resolver(x.input || {}, catalogo, vivo) })) } : p));
      const s = await M.atenderTurnoConHerramientas({ negocioId: negocio.id, conversacionId: estado.conversacionId, turnoId: `t${n}`,
        mensaje: turno.cliente, catalogo, precios, estado, libro, llamarModelo: modeloDeGuion(guion), efectos, modo: 'replay',
        contexto: { nombreNegocio: negocio.nombre, textoCiclo: turno.cliente }, topeIteraciones: 8,
        ...(cfg ? { recepcion: !!R.modoIA(cfg, T) } : {}) });
      if (s.dialogoId) D.acusarDialogo(estado, s.dialogoId, s.texto);
      salidas.push(huellaDeTurno(s));
      if (estado.hechos.escalado || estado.hechos.cancelado || estado.hechos.fallido) break;
    }
    return salidas;
  }
  const fixtures = readdirSync(join(raiz, 'test/replay/fixtures')).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(raiz, 'test/replay/fixtures', f), 'utf8')));
  await t('P1 guiones del replay: el turno es idéntico a la base con cada forma de «sin valor»', async () => {
    let n = 0;
    for (const fx of fixtures) {
      const v = await correr(Va, Ve, Vl, Vd, fx, null);
      for (const [nombre, cfg] of COMBOS) {
        assert.equal(json(await correr(Na, Ne, Nl, Nd, fx, cfg)), json(v), `${fx.id} · ${nombre}`); n++;
      }
    }
    assert(n >= fixtures.length * COMBOS.length && fixtures.length >= 20, `${fixtures.length} guiones`);
  });

  // 40 textos sobre cinco estados, con un modelo que siempre contesta texto.
  const CARTA = F.carta(), PRECIOS = Nc.preciosDelCatalogo(CARTA);
  const TEXTOS = ['hola', 'buenas tardes', 'quiero hacer un pedido', 'unos chilaquiles verdes con pollo', 'quiero 2 cafés',
    'agrega otro', 'agrega otro café', 'quita el café', 'mejor sin cebolla', 'cancela mi pedido', 'sí', 'si', 'no', 'no gracias',
    'ok', 'gracias', 'muchas gracias', 'la segunda', 'esa', 'dos', 'roja', 'verde', 'chipotle', 'a domicilio', 'para recoger',
    'pago en efectivo', 'con tarjeta', '¿qué trae el café?', '¿tienen chilaquiles?', '¿cuánto cuesta el jugo?', '¿a qué hora cierran?',
    '¿dónde están?', 'para mañana a las 10', 'seguir mi pedido', 'el de pastor', 'un taco', 'quiero hablar con una persona', 'asdf',
    'Hidalgo 405, centro', '¿qué es el enlace de pago?'];
  const ESTADOS = {
    vacio: () => F.estado({ pendiente: null }),
    carrito: () => F.estado({ pendiente: null, items: 'dos' }),
    opcion: () => F.estado({ pendiente: { tipo: 'elegir_opcion', linea_id: 'L1', grupo: 'Salsa', producto: 'Chilaquiles', candidatos: ['Roja', 'Verde', 'Chipotle'] }, items: 'dos' }),
    modalidad: () => F.estado({ pendiente: { tipo: 'modalidad', opciones: F.modalidades }, items: 'dos' }),
    elegir: () => F.estado({ pendiente: { tipo: 'elegir_producto', ciclo: 'c', solicitud: 'un taco', nombre: 'taco', cantidad: 1,
      candidatos: [{ id: '5', nombre: 'Taco de Barbacoa' }, { id: '6', nombre: 'Taco de Pastor' }] } }),
    confirmado: () => { const e = F.estado({ pendiente: null, items: 'dos' }); e.folio = 'XAB-1'; e.hechos.confirmado = true; return e; },
  };
  const turnoTexto = async (M, mensaje, estado, extra = {}) => {
    const s = await M.atenderTurnoConHerramientas({ negocioId: 'n', conversacionId: estado.conversacionId, turnoId: 't1', mensaje,
      catalogo: CARTA, precios: PRECIOS, modalidades: F.modalidades, metodosPago: F.metodosPago, reglas: F.reglas, estado,
      llamarModelo: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Con gusto te ayudo.' }] }), ...extra });
    return huellaDeTurno(s);
  };
  await t('P2 40 textos × 6 estados: el turno es idéntico a la base (recepcion = modoIA(cfg) con la bandera sin valor)', async () => {
    assert.equal(TEXTOS.length, 40);
    for (const [ne, mk] of Object.entries(ESTADOS)) {
      for (const m of TEXTOS) {
        const v = await turnoTexto(Va, m, mk());
        for (const [nombre, cfg] of COMBOS) {
          assert.equal(json(await turnoTexto(Na, m, mk(), { recepcion: !!R.modoIA(cfg, T) })), json(v), `${ne} · ${m} · ${nombre}`);
        }
      }
    }
  });
  const TOQUES = [
    { tipo: 'flow_aplicado', desdePedido: true, sinSaludo: true, acciones: [] },
    { tipo: 'boton_desactualizado', desdePedido: true, sinSaludo: true, texto: 'Ese botón ya no está vigente.\n', acciones: [] },
    { tipo: 'mapo_ordenar', sinSaludo: true, acciones: [], pendiente: { tipo: 'agregar_otro' }, texto: 'Elige y personaliza tus platillos.' },
    { tipo: 'inicio_mapo', sinSaludo: true, acciones: [], pendiente: { tipo: 'inicio_mapo' }, texto: '¡Hola!' },
    { tipo: 'boton_cambiar', sinSaludo: true, texto: 'Elige qué deseas cambiar.', acciones: [], pendiente: { tipo: 'editar_pedido' } },
    { tipo: 'boton_agregar', sinSaludo: true, texto: '¿Qué te gustaría agregar?', acciones: [], pendiente: { tipo: 'agregar_otro' } },
    { tipo: 'servicio_recibido', texto: 'Recibimos tus datos.', acciones: [], sinSaludo: true, pendiente: null },
    { tipo: 'rescate_humano', motivo: 'FORMULARIO_NO_CARGA', texto: 'Disculpa', acciones: [], sinSaludo: true, pendiente: null },
    { tipo: 'consulta_promociones', texto: 'Hoy 2x1.', acciones: [], sinSaludo: true },
    { tipo: 'fuera_horario', texto: 'Cerrado.', acciones: [], sinSaludo: true },
    { tipo: 'catalogo_nativo_aplicado', desdePedido: true, sinSaludo: true, acciones: [] },
    { tipo: 'texto_grupo_abierto', desdePedido: true, sinSaludo: true, texto: 'Este grupo admite de 1 a 1.\n', acciones: [] },
  ];
  await t('P3 12 respuestas de sistema (toques y atajos) × 6 estados: idénticas a la base', async () => {
    for (const [ne, mk] of Object.entries(ESTADOS)) {
      for (const r of TOQUES) {
        const v = await turnoTexto(Va, '', mk(), { respuestaDeSistema: structuredClone(r) });
        for (const [nombre, cfg] of COMBOS) {
          assert.equal(json(await turnoTexto(Na, '', mk(), { respuestaDeSistema: structuredClone(r), recepcion: !!R.modoIA(cfg, T) })), json(v), `${ne} · ${r.tipo} · ${nombre}`);
        }
      }
    }
  });

  // ── Funciones del canal y del inicio ───────────────────────────────────
  await t('P4 inicio Mapo: lista, entrada, opción y vigencia de los botones iguales a la base', () => {
    for (const [nombre, cfg] of COMBOS) {
      for (const pendiente of [{ tipo: 'inicio_mapo' }, { tipo: 'formulario_servicio', servicio: 'evento' }, null, { tipo: 'agregar_otro' }]) {
        const mk = () => { const e = F.estado({ pendiente }); e.dialogo.texto = 'Hola'; return e; };
        const v = Vm.construirInicioMapo({ estado: mk(), pedido: { huella: 'h', total: 0 }, texto: 'Hola', cfg });
        const n = Nm.construirInicioMapo({ estado: mk(), pedido: { huella: 'h', total: 0 }, texto: 'Hola', cfg, telefono: T });
        assert.equal(json(sinTokens(n)), json(sinTokens(v)), `${nombre} ${pendiente?.tipo}`);
      }
      for (const m of ['hola', 'Hola, buenas tardes', 'inicio', 'quiero ordenar', '¿tienen mesas?']) {
        const e = F.estado({ pendiente: null });
        const ahora = new Date('2026-10-05T15:00:00Z');
        assert.equal(json(Nm.entradaMapo({ cfg, estado: e, mensaje: m, ahora })), json(Vm.entradaMapo({ cfg, estado: e, mensaje: m, ahora })), m);
      }
      for (const valor of ['ordenar', 'facturacion', 'evento', 'humano', 'informacion', 'info:horario', 'mas_preguntas', 'x']) {
        const q = { accion: 'menu_mapo', datos: { valor } };
        assert.equal(json(Nm.respuestaOpcionMapo(q)), json(Vm.respuestaOpcionMapo(q)), valor);
        for (const e of [F.estado({ pendiente: null }), ESTADOS.confirmado()]) {
          assert.equal(Nm.asociacionMapoVigente(q, { estado: e, cfg, telefono: T }), Vm.asociacionMapoVigente(q, { estado: e, cfg }), `${nombre} ${valor}`);
        }
      }
    }
  });
  await t('P5 cerrado, programados, respuestaDesdePedido y estado operativo: los mismos textos', () => {
    const reglas = { ...F.reglas, horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
      .map((d) => [d, { abierto: d !== 'martes', apertura: '07:30', cierre: '15:00' }])), cierres_especiales: [] };
    for (const tienda of [null, { estado: 'publicada', aceptaProgramados: true, slug: 'm' }, { estado: 'borrador', aceptaProgramados: true, slug: 'm' }]) {
      for (const er of [{ abierto: false, diaActual: 'lunes', fechaHoy: '2026-10-05' }, { abierto: false, diaActual: 'lunes', fechaHoy: '2026-10-05', preApertura: true }, { abierto: true }]) {
        assert.equal(Nh.construirAvisoFueraDeHorario({ estadoRestaurante: er, reglas, configTienda: tienda }), Vh.construirAvisoFueraDeHorario({ estadoRestaurante: er, reglas, configTienda: tienda }));
        assert.equal(Nh.construirAvisoFueraDeHorario({ estadoRestaurante: er, reglas, configTienda: tienda, recepcion: false }), Vh.construirAvisoFueraDeHorario({ estadoRestaurante: er, reglas, configTienda: tienda }));
      }
      assert.equal(json(Nh.respuestaAPedidoProgramado({ configTienda: tienda })), json(Vh.respuestaAPedidoProgramado({ configTienda: tienda })));
    }
    for (const [ne, mk] of Object.entries(ESTADOS)) {
      const e1 = mk(), e2 = mk();
      const vista = Ne.crearEjecutor({ estado: e1, catalogo: CARTA, precios: PRECIOS, modalidades: F.modalidades, metodosPago: F.metodosPago }).vista();
      assert.equal(Nr.respuestaDesdePedido({ estado: e1, pedido: vista, modalidades: F.modalidades, metodosPago: F.metodosPago, requierePago: true }),
        Vr.respuestaDesdePedido({ estado: e2, pedido: vista, modalidades: F.modalidades, metodosPago: F.metodosPago, requierePago: true }), ne);
      // respuestaOperativaVerificada ahora arma su texto con textoEstadoDePedido: mismos bytes en cada estado.
      for (const actual of [null, ...['nuevo', 'en_preparacion', 'listo', 'en_camino', 'en_reparto', 'entregado', 'cancelado', 'pendiente_pago', 'raro']
        .flatMap((estado) => ['entrega a domicilio', 'recoger en tienda', null].map((modalidad) => ({ folio: 'XAB-1', estado, modalidad }))),
      { folio: 'XAB-2', estado: 'nuevo', modalidad: 'recoger en tienda' }]) {
        // Con tiempos configurados (la frase del tiempo es justo lo que C-1 toca) y sin ellos.
        for (const r of [F.reglas, { ...F.reglas, pedidos: { ...F.reglas.pedidos, tiempo_entrega_min_minutos: 45,
          tiempo_entrega_max_minutos: 55, tiempo_preparacion_minutos: 25 } }]) {
          assert.equal(No.respuestaOperativaVerificada(mk(), actual, r), Vo.respuestaOperativaVerificada(mk(), actual, r), ne);
        }
      }
    }
    const vacia = { lineas: [], falta: [], aclaraciones: [], total: 0 };
    assert.equal(Nr.respuestaDesdePedido({ estado: ESTADOS.vacio(), pedido: vacia }), Vr.respuestaDesdePedido({ estado: ESTADOS.vacio(), pedido: vacia }));
  });
  await t('P6 aplicarRespuestaDeEntrega y el rescate (respuesta, salida, decisión): iguales a la base', () => {
    const op = (codigo, extra = {}) => ({ herramienta: 'definir_entrega', resultado: { aplicado: false, codigo, ...extra } });
    for (const [modalidadDescartada, operaciones] of [[null, []], ['consumo_sitio', []], ['domicilio', []], [null, [op('modalidad_no_disponible', { modalidad_solicitada: 'consumo_sitio' })]]]) {
      for (const reglas of [F.reglas, { ...F.reglas, bot: { faqs: [{ pregunta: '¿Tienen mesas?', respuesta: 'Sí.' }] } }]) {
        const s = () => ({ texto: 'X', operaciones: structuredClone(operaciones) });
        assert.equal(json(Nc.aplicarRespuestaDeEntrega({ salida: s(), modalidadDescartada, modalidades: F.modalidades, reglas })),
          json(Vc.aplicarRespuestaDeEntrega({ salida: s(), modalidadDescartada, modalidades: F.modalidades, reglas })));
      }
    }
    for (const m of Object.values(Vx.MOTIVOS_RESCATE)) assert.equal(json(Nx.respuestaDeRescate(m)), json(Vx.respuestaDeRescate(m)));
    for (const entregado of [true, false]) {
      const [a, b] = [ESTADOS.vacio(), ESTADOS.vacio()]; a.rescate = { fallos: [1] }; b.rescate = { fallos: [1] };
      const [sa, sb] = [{ texto: 'x' }, { texto: 'x' }];
      Nx.aplicarSalidaDeRescate(sa, { motivo: 'FORMULARIO_NO_CARGA', entregado, estado: a, cierre: 'escalado' });
      Vx.aplicarSalidaDeRescate(sb, { motivo: 'FORMULARIO_NO_CARGA', entregado, estado: b, cierre: 'escalado' });
      assert.equal(json([sa, a]), json([sb, b]));
    }
    const ahora = Date.now();
    for (const salida of [{ respuestaDeSistema: 'rescate_humano' }, { recuperacion: 'fallo_proveedor_sin_efectos' }, { texto: 'x' }]) {
      const e = () => Object.assign(ESTADOS.vacio(), { rescate: { fallos: [ahora - 1000, ahora - 500] } });
      assert.equal(json(Nx.decidirRescate({ cfg: cfgBase, estado: e(), salida, ahora })), json(Vx.decidirRescate({ cfg: cfgBase, estado: e(), salida, ahora })));
    }
  });
  await t('P7 grupoDelMotivo de todos los motivos de la base y TEXTOS_RECIBO_HANDOFF es EXACTAMENTE la de hoy (revisión 3)', async () => {
    const todos = [...Vp.MOTIVOS_PETICION, ...Vp.MOTIVOS_DE_SOLTAR, ...Vp.MOTIVOS_DE_SISTEMA, ...Vp.MOTIVOS_QUE_NUNCA_VENCEN, 'OTRO', '', null];
    for (const m of todos) assert.equal(Np.grupoDelMotivo(m), Vp.grupoDelMotivo(m), m);
    const viejos = ['Permíteme un momento, te paso con alguien del equipo para atenderte bien.',
      'Te paso con alguien del equipo para que te atienda mejor. Un momento, por favor.', Vx.TEXTO_RESCATE];
    assert.deepEqual(Nrh.TEXTOS_RECIBO_HANDOFF, viejos);
    assert.deepEqual(Nrh.textosDelRecibo(false), viejos);
    // permiteReciboHandoff con cada forma de «sin valor»: un texto del modo
    // (que el modelo escribiera tal cual) no salta la pausa, como en la base.
    const fila = (texto) => ({ id: 1, negocio_id: 'n', carga: { telefono: T, texto, recibo_handoff: { motivo: 'X' } } });
    for (const [nombre, cfg] of COMBOS) {
      const db = { query: async () => ({ rows: [{ bot_whatsapp_activo: true, canal: true, modulo: true, tomado: false, humano: false, ventana: true,
        cfg: { ...cfg, mesero_agente_v1: 'true', mesero_agente_porcentaje: '100' } }] }) };
      for (const texto of [...viejos, ...R.TEXTOS_PERSONA, 'Con gusto te ayudo.']) {
        assert.equal(await Nrh.permiteReciboHandoff({ db, fila: fila(texto) }), viejos.includes(texto), `${nombre} · ${texto.slice(0, 30)}`);
      }
    }
  });
  await t('P10 modoDelPedido: la misma decisión que la base y ninguna alerta del modo con cada forma de «sin valor»', async () => {
    const [Vmp, Nmp] = await par('src/orders/modoDelPedido.js');
    const errores = []; const original = console.error;
    console.error = (...a) => { errores.push(a.join(' ')); };
    try {
      for (const [nombre, cfg] of COMBOS) {
        for (const mesero of [{ mesero_agente_v1: 'true', mesero_agente_porcentaje: '100' }, { mesero_agente_v1: 'false' }, {}]) {
          // T: el cliente para el que cada combinación deja el modo sin valor (en
          // «prueba otro teléfono» la lista es OTRO_TELEFONO, que sí estaría en el modo).
          for (const telefono of [T, null]) {
            const leerConfiguracion = async () => ({ ...cfg, ...mesero });
            assert.equal(json(await Nmp.modoDelPedido(`n-${nombre}`, { telefono, leerConfiguracion })),
              json(await Vmp.modoDelPedido(`n-${nombre}`, { telefono, leerConfiguracion })), `${nombre} ${JSON.stringify(mesero)} ${telefono}`);
          }
        }
      }
    } finally { console.error = original; }
    assert.deepEqual(errores.filter((e) => /RECEPCION/.test(e)), []);
  });
  await t('P8 el ejecutor (sin recepcion): todas las herramientas dan el mismo resultado y el mismo estado que la base', async () => {
    const casos = [['ver_pedido', {}], ['buscar_producto', { texto: 'café' }], ['ver_opciones_producto', { producto_id: '1' }],
      ['agregar_producto', { producto_id: '3', cantidad: 1 }], ['modificar_linea', { linea_id: 'L1', opciones: [{ grupo: 'Salsa', opcion: 'Roja' }] }],
      ['quitar_linea', { linea_id: 'L2' }], ['definir_entrega', { modalidad: 'recoger en tienda' }], ['definir_pago', { forma_pago: 'efectivo' }],
      ['definir_cliente', { nombre: 'Ana' }], ['cancelar_pedido', { motivo: 'x' }], ['confirmar_pedido', { huella_resumen: 'h' }],
      ['pedir_humano', { motivo: 'x' }], ['enviar_menu', {}], ['programar_para', { fecha: '2026-10-06', hora: '10:00' }],
      ['registrar_solicitud_evento', { tipo_servicio: 'catering' }], ['ofrecer_promocion', { promocion_id: '1' }]];
    for (const mensaje of ['un café americano para recoger en efectivo, soy Ana', 'cancela mi pedido', 'quita el café']) {
      for (const [h, args] of casos) {
        for (const [ne, mk] of Object.entries(ESTADOS)) {
          const correrUno = async (E) => { const e = mk();
            const ej = E.crearEjecutor({ estado: e, catalogo: CARTA, precios: PRECIOS, mensaje, textoCiclo: mensaje, modalidades: F.modalidades, metodosPago: F.metodosPago,
              efectos: { confirmar: async () => ({ ok: true, folio: 'F' }), escalar: async () => ({ ok: true }) } });
            const r = await ej.ejecutar(h, structuredClone(args)); return json([r, E.estadoSerializable(e)]); };
          assert.equal(await correrUno(Ne), await correrUno(Ve), `${h} · ${ne} · ${mensaje}`);
        }
      }
    }
  });
  await t('P9 los pendientes de la base pasan el esquema igual; el ciclo caduca los mismos flujos', () => {
    const pendientes = [{ tipo: 'inicio_mapo' }, { tipo: 'formulario_servicio', servicio: 'facturacion' }, { tipo: 'agregar_otro' },
      { tipo: 'configurar_pedido' }, { tipo: 'editar_pedido' }, { tipo: 'modalidad', opciones: ['a'] }, { tipo: 'direccion' },
      { tipo: 'pago', opciones: ['efectivo'] }, { tipo: 'fecha_hora' }, { tipo: 'confirmar_resumen', huella: 'h' },
      { tipo: 'aceptar_producto', producto_id: '1', producto: 'X' }, { tipo: 'aceptar_pago_ofrecido', forma_pago: 'enlace_pago' },
      { tipo: 'datos_evento', faltan: ['fecha'] }, { tipo: 'elegir_opcion', linea_id: 'L1', grupo: 'Salsa' },
      { tipo: 'desconocido' }, { tipo: 'agregar_otro', extra: 1 }];
    for (const p of pendientes) {
      const r = (K) => { try { const e = ESTADOS.vacio(); K.fijarPendiente(e, p); return json(e.pendiente); } catch (err) { return `error:${/pendiente_invalido/.test(err.message)}`; } };
      assert.equal(r(Nk), r(Vk), p.tipo);
    }
    for (const tipo of ['inicio_mapo', 'formulario_servicio', 'datos_evento', 'agregar_otro', 'confirmar_resumen']) {
      const e = () => Object.assign(ESTADOS.vacio(), { pendiente: { tipo, servicio: 'evento', huella: 'h' },
        _actualizadoAt: new Date(Date.now() - 3600e3).toISOString(), _inactividadMs: 3600e3 });
      assert.equal(Nci.flujoAbiertoVencido(e()), Vci.flujoAbiertoVencido(e()), tipo);
    }
  });
} finally {
  rmSync(destino, { recursive: true, force: true });
  console.log(`\nmodo formulario con la bandera sin valor contra ${BASE}: ${pasadas} pasadas, ${fallidas} fallidas`);
  if (fallidas) process.exitCode = 1;
}
