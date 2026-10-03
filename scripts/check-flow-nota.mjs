// La NOTA DEL PEDIDO en «Entrega y pago» (contrato nota_v1): dedicatoria o
// indicaciones que se guardan en el pedido, salen en «Revisa tu pedido» y se
// imprimen en la comanda. Puro: sin base de datos, Meta ni pedidos reales.
// Corre en el predeploy (predeploy-check-incidentes.mjs).
//
// Lo que más importa aquí es lo que NO cambia: sin la bandera, los Flows
// publicados, las claves que viajan y la huella del resumen son los de hoy.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { definicionFlowCarrito } from './definicion-flow-carrito.mjs';
import { definicionFlowCategorias } from './definicion-flow-categorias.mjs';
import { CONTRATO_DIRECCION, flowIdEsperado, flowIdsConEndpoint, fotoComparable } from '../src/mesero-agente/direccionFormulario.js';
import { CONTRATO_NOTA, LIMITE_NOTA_PEDIDO, ERROR_NOTA_PEDIDO, BANDERA_NOTA, notaCategorias, notaCarrito, leerNotaPedido,
  fotoNota, cierreConNota, flowIdEsperadoConNota, flowIdsConEndpointConNota, sinNotaVieja } from '../src/mesero-agente/notaDelPedido.js';
import { cambiarCategorias, respuestaCategorias } from '../src/mesero-agente/flowCategorias.js';
import { borradorCarrito, cambiarCarrito, respuestaCarrito, comandosCarrito } from '../src/mesero-agente/flowCarrito.js';
import { comandosFormulario, construirFormulario, fotoFormulario, formularioVigente } from '../src/mesero-agente/formularioAgrupado.js';
import { resolverFinalFlow } from '../src/mesero-agente/flowRepetibleSql.js';
import { borradorCompatible } from '../src/mesero-agente/recuperarBorradorFlow.js';
import { CLAVE_RESPALDO_NOTA, planActivacionNota, planReversaNota } from '../src/mesero-agente/activacionNota.js';
import { planActivacion } from '../src/mesero-agente/activacionDireccion.js';
import { aplicarComandosInternos } from '../src/mesero-agente/comandosInternosAtomicos.js';
import { crearEjecutor, estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { validarArgumentos, definicionesParaElModelo } from '../src/mesero-agente/contratoDeHerramientas.js';
import { resumenDelPedido, huellaDelResumen } from '../src/mesero-whatsapp/resumenDelPedido.js';
import { respuestaDesdePedido } from '../src/mesero-agente/recuperacionDelTurno.js';
import { vistaDelPedido } from '../src/mesero-agente/vistaDelPedido.js';
import { ordenDesdeElCarrito, resumenConPromociones } from '../src/mesero-agente/canalDelAgente.js';
import { textoAfirmaCambioGuardado } from '../src/mesero-agente/seguridadConversacional.js';
import { conNotaDelPedido, PREFIJO_NOTA_DEL_PEDIDO, textoParaImpresora } from '../src/printing/notaDelPedidoComanda.js';
import { renderComanda } from '../edge/renderers/index.js';

let pasadas = 0, fallidas = 0;
const t = async (nombre, fn) => { try { await fn(); pasadas++; } catch (e) { fallidas++; console.error(`${nombre}: ${e.message}`); } };
const sha = (d) => createHash('sha256').update(JSON.stringify(d)).digest('hex').slice(0, 12);
const entregaDe = (def) => def.screens.find((s) => s.id === 'ENTREGA');
const formDe = (pantalla) => pantalla.layout.children[0];
const DEDICATORIA = 'Feliz cumpleaños, Ana. Velita en el pastel.';

// ── Definiciones ─────────────────────────────────────────────────────────
await t('sin la opción, ningún Flow publicado cambia (huellas fijadas, también las de dirección)', () => {
  assert.equal(sha(definicionFlowCarrito()), '0cf5cf31a300');
  assert.equal(sha(definicionFlowCarrito({ duplicar: true })), 'b06e99ff4556');
  assert.equal(sha(definicionFlowCategorias()), '4aa4f8fe429e');
  // Los de dirección ya están publicados en Obispado: la nota no los toca.
  assert.equal(sha(definicionFlowCategorias({ direccion: true })), '47fe3fe734c1');
  assert.equal(sha(definicionFlowCarrito({ direccion: true })), '39860f389b14');
  assert.equal(sha(definicionFlowCarrito({ duplicar: true, direccion: true })), '30f9ffdde864');
  assert.deepEqual(definicionFlowCategorias({ direccion: true, nota: false }), definicionFlowCategorias({ direccion: true }));
  assert.deepEqual(definicionFlowCarrito({ direccion: true, nota: false }), definicionFlowCarrito({ direccion: true }));
});
await t('con la nota: tres Flows nuevos, uno por formulario (sus nombres xabor_*_agrupado_<huella>)', () => {
  // Cambiar estas huellas es publicar Flows nuevos en Meta y volver a activar:
  // activar-flows-nota.mjs compara el nombre del Flow con la definición del build.
  assert.equal(sha(definicionFlowCategorias({ direccion: true, nota: true })), 'df47bcf2300b');
  assert.equal(sha(definicionFlowCarrito({ direccion: true, nota: true })), '18befbd9fe4d');
  assert.equal(sha(definicionFlowCarrito({ duplicar: true, direccion: true, nota: true })), '66f99bbff7e8');
});
await t('la nota solo existe con la dirección (la pantalla «Entrega y pago» propia)', () => {
  assert.throws(() => definicionFlowCategorias({ nota: true }), /requiere \{direccion:true\}/);
  assert.throws(() => definicionFlowCarrito({ nota: true }), /requiere \{direccion:true\}/);
  assert.throws(() => definicionFlowCarrito({ duplicar: true, nota: true }), /requiere \{direccion:true\}/);
});
for (const [nombre, conNota, sinNota] of [
  ['categorías', definicionFlowCategorias({ direccion: true, nota: true }), definicionFlowCategorias({ direccion: true })],
  ['carrito', definicionFlowCarrito({ direccion: true, nota: true }), definicionFlowCarrito({ direccion: true })],
  ['carrito con duplicar', definicionFlowCarrito({ duplicar: true, direccion: true, nota: true }),
    definicionFlowCarrito({ duplicar: true, direccion: true })]]) {
  await t(`${nombre}: «Nota del pedido» opcional en ENTREGA, dentro de los límites de Meta, y nada más cambia`, () => {
    const p = entregaDe(conNota), form = formDe(p);
    const nota = form.children.find((c) => c.name === 'nota');
    assert.equal(nota.type, 'TextArea'); assert.equal(nota.required, false);
    assert.equal(nota['max-length'], LIMITE_NOTA_PEDIDO); assert.equal(LIMITE_NOTA_PEDIDO, 200);
    assert.equal(nota['max-chars'], undefined, 'TextArea usa max-length');
    assert(nota.label.length <= 20, nota.label); assert(nota['helper-text'].length <= 80);
    assert.equal(form['init-values'].nota, '${data.nota_inicial}');
    assert.deepEqual(p.data.nota_inicial, { type: 'string', __example__: '' });
    const pie = form.children.find((c) => c.type === 'Footer');
    assert.equal(pie['on-click-action'].payload.nota, '${form.nota}');
    assert.deepEqual(Object.keys(pie['on-click-action'].payload).sort(), ['modalidad', 'nota', 'operacion', 'pago', 'revision']);
    // Va después de entrega y pago y antes del aviso «No confirma ni cobra».
    const orden = form.children.map((c) => c.name || c.type);
    assert(orden.indexOf('pago') < orden.indexOf('nota') && orden.indexOf('nota') < orden.indexOf('TextCaption'), orden.join(','));
    // Todo enlace ${data.x} declarado y todo ${form.x} con su componente, en cada pantalla.
    for (const s of conNota.screens) {
      const texto = JSON.stringify(s.layout), campos = new Set();
      const recorrer = (n) => { if (Array.isArray(n)) n.forEach(recorrer); else if (n && typeof n === 'object') {
        if (n.name) campos.add(n.name); Object.values(n).forEach(recorrer); } };
      recorrer(s.layout);
      for (const [, k] of texto.matchAll(/\$\{data\.([a-z0-9_]+)\}/g)) assert(k in s.data, `${s.id}: data.${k}`);
      for (const [, k] of texto.matchAll(/\$\{form\.([a-z0-9_]+)\}/g)) assert(campos.has(k), `${s.id}: form.${k}`);
    }
    // Quitando la nota, la definición es la de dirección ya publicada.
    const sinLaNota = structuredClone(conNota), e = entregaDe(sinLaNota), f = formDe(e);
    delete e.data.nota_inicial; delete f['init-values'].nota;
    f.children = f.children.filter((c) => c.name !== 'nota');
    delete f.children.find((c) => c.type === 'Footer')['on-click-action'].payload.nota;
    assert.deepEqual(sinLaNota, sinNota);
    assert.doesNotMatch(JSON.stringify(sinNota), /nota_inicial|"name":"nota"/, 'sin la opción no hay rastro de la nota');
  });
}

// ── Fotos ────────────────────────────────────────────────────────────────
const ZONAS = [{ nombre: 'UTNC', costo: 150 }];
const fotoDir = { contrato: CONTRATO_DIRECCION, zonas: ZONAS, costo_envio: 60,
  direccion_inicial: { calle: '', colonia: '', referencias: '', zona: '' } };
const fotoCategorias = ({ nota = true, nota_inicial = '' } = {}) => ({ tipo: 'flow_productos', version: 'repetible_v1',
  presentacion: 'categorias_v1',
  productos: [{ id: '1', nombre: 'Café americano', precio: 45, grupos: [], categoria: 'Bebidas', categoriaId: 'c1' }],
  modalidades: [{ valor: 'recoger en tienda', titulo: 'recoger' }, { valor: 'entrega a domicilio', titulo: 'domicilio' }],
  pagos: [{ valor: 'efectivo', titulo: 'Efectivo' }], modalidad: '', pago: '', ...fotoDir,
  ...(nota ? { contrato_nota: CONTRATO_NOTA, nota_inicial } : {}) });
const fotoCarrito = (opciones = {}, extra = {}) => ({ ...fotoCategorias(opciones), tipo: 'flow_configurar', version: 'carrito_v1',
  lineas: [{ linea_id: 'l1', cantidad: 1, ficha: { id: '1', nombre: 'Café americano', precio: 45, grupos: [] }, seleccion: [], nota: '' }],
  ...extra });
const enEntrega = () => ({ revision: 4, etapa: 'ENTREGA', items: [{ producto0: 'p0', cantidad: '1' }], categoria: 'c1', navegacion: ['MENU', 'PLATILLO'] });
const paso = (foto, b, screen, data) => cambiarCategorias(foto, b, { action: 'data_exchange', screen, data: { revision: String(b.revision), ...data } });
const cx = (foto, b, screen, data) => cambiarCarrito(foto, b, { action: 'data_exchange', screen, data: { revision: String(b.revision), ...data } });
const aEntrega = (foto) => cx(foto, borradorCarrito(foto), 'CARRITO', { operacion: 'guardar' }).borrador;
const dir = { operacion: 'direccion', zona: 'zn', calle: 'Hidalgo 405', colonia: 'Centro', referencias: '' };

// ── Endpoint: claves exactas por pantalla ────────────────────────────────
await t('categorías: ENTREGA manda exactamente las claves de su Flow, con la nota y sin ella', () => {
  for (const conNota of [false, true]) {
    const foto = fotoCategorias({ nota: conNota });
    const declaradas = Object.keys(entregaDe(definicionFlowCategorias({ direccion: true, nota: conNota })).data).sort();
    const b = enEntrega();
    const vistas = [respuestaCategorias(foto, b, 'tk'),
      respuestaCategorias(foto, b, 'tk', 'Elige entrega y forma de pago para revisar tu pedido.', { revision: '4', modalidad: 'm9' })];
    const d = paso(foto, b, 'ENTREGA', { operacion: 'revisar', modalidad: 'm1', pago: 'p0', ...(conNota ? { nota: 'x' } : {}) }).borrador;
    vistas.push(respuestaCategorias(foto, cambiarCategorias(foto, d, { action: 'BACK', screen: 'DIRECCION' }).borrador, 'tk'));
    for (const v of vistas) {
      assert.equal(v.screen, 'ENTREGA');
      assert.deepEqual(Object.keys(v.data).sort(), declaradas, `nota=${conNota}`);
    }
    assert.equal('nota_inicial' in vistas[0].data, conNota, 'sin contrato no viaja nota_inicial');
  }
});
await t('carrito: cada pantalla manda exactamente las claves de su Flow, con la nota y sin ella', () => {
  for (const duplicar of [false, true]) for (const conNota of [false, true]) {
    const def = definicionFlowCarrito({ duplicar, direccion: true, nota: conNota });
    const declaradas = (id) => Object.keys(def.screens.find((s) => s.id === id).data).sort();
    const foto = fotoCarrito({ nota: conNota }, duplicar ? { duplicar: true } : {});
    const b0 = borradorCarrito(foto), g = aEntrega(foto);
    const vistas = [respuestaCarrito(foto, b0, 'tk'), respuestaCarrito(foto, g, 'tk'),
      respuestaCarrito(foto, g, 'tk', 'Elige la entrega y la forma de pago.', { revision: String(g.revision), modalidad: 'm1', nota: 'x' })];
    const e = cx(foto, g, 'ENTREGA', { operacion: 'revisar', modalidad: 'm1', pago: 'p0', ...(conNota ? { nota: 'x' } : {}) }).borrador;
    vistas.push(respuestaCarrito(foto, e, 'tk'), respuestaCarrito(foto, cambiarCarrito(foto, e, { action: 'BACK', screen: 'DIRECCION' }).borrador, 'tk'));
    for (const v of vistas) assert.deepEqual(Object.keys(v.data).sort(), declaradas(v.screen), `${v.screen} duplicar=${duplicar} nota=${conNota}`);
  }
});
await t('sin el contrato, una clave «nota» en ENTREGA se rechaza como hoy', () => {
  const sin = fotoCarrito({ nota: false });
  assert.equal(cx(sin, aEntrega(sin), 'ENTREGA', { operacion: 'revisar', modalidad: 'm0', pago: 'p0', nota: 'x' }).error, 'Selección no disponible.');
  const cat = fotoCategorias({ nota: false });
  assert(paso(cat, enEntrega(), 'ENTREGA', { operacion: 'revisar', modalidad: 'm0', pago: 'p0', nota: 'x' }).error);
  // Con el contrato se acepta, y sigue rechazando cualquier otra clave.
  const con = fotoCarrito();
  assert.equal(cx(con, aEntrega(con), 'ENTREGA', { operacion: 'revisar', modalidad: 'm0', pago: 'p0', nota: 'x' }).error, undefined);
  assert.equal(cx(con, aEntrega(con), 'ENTREGA', { operacion: 'revisar', modalidad: 'm0', pago: 'p0', nota: 'x', otra: '1' }).error,
    'Selección no disponible.');
  assert(paso(fotoCategorias(), enEntrega(), 'ENTREGA', { operacion: 'revisar', modalidad: 'm0', pago: 'p0', nota: 'x', otra: '1' }).error);
});

// ── Limpieza y longitud ──────────────────────────────────────────────────
await t('saneado: la de la dirección (controles, bidi, ancho cero), idempotente; más de 200 se rechaza', () => {
  assert.equal(leerNotaPedido('  Feliz‮ cumple​\u0085 Ana  '), 'Feliz cumple Ana');
  assert.equal(leerNotaPedido(leerNotaPedido('Feliz\u0000\ncumple')), 'Feliz cumple');
  assert.equal(leerNotaPedido(undefined), ''); assert.equal(leerNotaPedido(''), '');
  assert.equal(leerNotaPedido('x'.repeat(200)), 'x'.repeat(200));
  assert.equal(leerNotaPedido('x'.repeat(201)), null); assert.equal(leerNotaPedido(5), null);
});
await t('endpoint: la nota se guarda saneada; una de más se rechaza sin tocar el borrador', () => {
  const foto = fotoCarrito(), g = aEntrega(foto);
  const larga = cx(foto, g, 'ENTREGA', { operacion: 'revisar', modalidad: 'm0', pago: 'p0', nota: 'x'.repeat(201) });
  assert.equal(larga.error, ERROR_NOTA_PEDIDO); assert.deepEqual(larga.borrador, g);
  assert.equal(cx(foto, g, 'ENTREGA', { operacion: 'revisar', modalidad: 'm0', pago: 'p0', nota: 7 }).error, ERROR_NOTA_PEDIDO);
  const ok = cx(foto, g, 'ENTREGA', { operacion: 'revisar', modalidad: 'm0', pago: 'p0', nota: ` ${DEDICATORIA}​ ` }).borrador;
  assert.equal(ok.nota, DEDICATORIA); assert.equal(ok.etapa, 'FINAL');
  const cat = paso(fotoCategorias(), enEntrega(), 'ENTREGA', { operacion: 'revisar', modalidad: 'm0', pago: 'p0', nota: 'x'.repeat(201) });
  assert.equal(cat.error, ERROR_NOTA_PEDIDO); assert.deepEqual(cat.borrador, enEntrega());
  assert.equal(paso(fotoCategorias(), enEntrega(), 'ENTREGA', { operacion: 'revisar', modalidad: 'm0', pago: 'p0', nota: DEDICATORIA })
    .borrador.nota, DEDICATORIA);
});
await t('un intento rechazado conserva la nota escrita; una revisión vieja no la restaura', () => {
  const foto = fotoCarrito(), g = aEntrega(foto);
  const sinPago = cx(foto, g, 'ENTREGA', { operacion: 'revisar', modalidad: 'm1', nota: DEDICATORIA });
  assert(sinPago.error);
  const r = respuestaCarrito(foto, sinPago.borrador, 'tk', sinPago.error, { revision: String(g.revision), modalidad: 'm1', nota: DEDICATORIA });
  assert.equal(r.data.nota_inicial, DEDICATORIA);
  assert.equal(respuestaCarrito(foto, g, 'tk', 'x', { revision: '99', nota: DEDICATORIA }).data.nota_inicial, '');
  const cat = respuestaCategorias(fotoCategorias(), enEntrega(), 'tk', 'x', { revision: '4', nota: DEDICATORIA });
  assert.equal(cat.data.nota_inicial, DEDICATORIA);
});

// ── Atrás, precarga y retomar ────────────────────────────────────────────
await t('Atrás desde la dirección conserva la nota (carrito y categorías), también ida y vuelta al carrito', () => {
  const foto = fotoCarrito(), g = aEntrega(foto);
  const e = cx(foto, g, 'ENTREGA', { operacion: 'revisar', modalidad: 'm1', pago: 'p0', nota: DEDICATORIA }).borrador;
  assert.equal(e.etapa, 'DIRECCION');
  const atras = cambiarCarrito(foto, e, { action: 'BACK', screen: 'DIRECCION' }).borrador;
  assert.equal(respuestaCarrito(foto, atras, 'tk').data.nota_inicial, DEDICATORIA);
  const alCarrito = cambiarCarrito(foto, atras, { action: 'BACK', screen: 'ENTREGA' }).borrador;
  const otraVez = cx(foto, alCarrito, 'CARRITO', { operacion: 'guardar' }).borrador;
  assert.equal(respuestaCarrito(foto, otraVez, 'tk').data.nota_inicial, DEDICATORIA);
  const cat = fotoCategorias();
  const d = paso(cat, enEntrega(), 'ENTREGA', { operacion: 'revisar', modalidad: 'm1', pago: 'p0', nota: DEDICATORIA }).borrador;
  const back = cambiarCategorias(cat, d, { action: 'BACK', screen: 'DIRECCION' }).borrador;
  assert.equal(respuestaCategorias(cat, back, 'tk').data.nota_inicial, DEDICATORIA);
  // Retomado en la dirección: abre en «Entrega y pago» con la nota.
  const ini = cambiarCategorias(cat, d, { action: 'INIT' }).borrador;
  assert.equal(respuestaCategorias(cat, ini, 'tk').data.nota_inicial, DEDICATORIA);
});
await t('precarga: «Entrega y pago» abre con la nota que ya tiene el pedido (vaciarla es borrarla)', () => {
  const foto = fotoCarrito({ nota_inicial: DEDICATORIA });
  assert.equal(respuestaCarrito(foto, aEntrega(foto), 'tk').data.nota_inicial, DEDICATORIA);
  assert.equal(respuestaCategorias(fotoCategorias({ nota_inicial: DEDICATORIA }), enEntrega(), 'tk').data.nota_inicial, DEDICATORIA);
  const estado = estadoNuevo({ negocioId: 'n', conversacionId: 'c' });
  assert.deepEqual(fotoNota({ estado }), { contrato_nota: CONTRATO_NOTA, nota_inicial: '' });
  estado.carrito.datos.notas = DEDICATORIA;
  assert.equal(fotoNota({ estado }).nota_inicial, DEDICATORIA);
});
await t('retomar y vigencia: la precarga de la nota no cuenta; el contrato sí', async () => {
  const foto = { ...fotoCarrito(), flowId: '12121212121' };
  assert.deepEqual(fotoComparable({ ...foto, nota_inicial: DEDICATORIA }), fotoComparable(foto));
  assert.notDeepEqual(fotoComparable(fotoCarrito({ nota: false })), fotoComparable(fotoCarrito()), 'con y sin nota no son el mismo formulario');
  const db = { query: async () => ({ rows: [{ datos: foto, contenido: { etapa: 'ENTREGA', revision: 3, nota: 'x' } }] }) };
  const preparado = { botones: [{ accion: 'flow_configurar', datos: { ...foto, nota_inicial: DEDICATORIA } }], ciclo: 'c', preguntaId: 'q2', huella: 'h' };
  assert(await borradorCompatible(db, { preparado, negocioId: 'n', sessionId: 's' }), 'el borrador se retoma');
});

// ── Recibo final y comandos ──────────────────────────────────────────────
const txCon = (contenido) => ({ query: async () => ({ rows: [{ contenido }] }) });
const final = (foto, b) => resolverFinalFlow(txCon(b), { id: 'q', datos: foto }, { flow_token: 'tk', revision: String(b.revision) });
await t('recibo final: la nota sale del borrador, solo con el contrato y con platillos', async () => {
  const b = { revision: 7, etapa: 'FINAL', items: [{ producto0: 'p0', cantidad: '1' }], modalidad: 'm0', pago: 'p0', nota: DEDICATORIA };
  assert.equal((await final(fotoCategorias(), b)).nota, DEDICATORIA);
  assert.equal((await final(fotoCategorias(), { ...b, nota: '' })).nota, '', 'vaciada viaja vacía: borra la del pedido');
  assert.equal('nota' in (await final(fotoCategorias({ nota: false }), b)), false, 'sin contrato no viaja');
  assert.equal('nota' in (await final(fotoCategorias(), { ...b, nota: undefined })), false, 'sin pasar por Entrega no viaja');
  const carrito = fotoCarrito();
  const vacio = await final(carrito, { ...b, items: undefined, filas: [] });
  assert.equal('nota' in vacio, false, 'un carrito vaciado no lleva nota');
  assert.deepEqual(comandosCarrito(carrito, vacio), [{ herramienta: 'quitar_linea', argumentos: { linea_id: 'l1' } }]);
  assert.equal(comandosCarrito(carrito, { ...vacio, nota: DEDICATORIA }), null, 'sin platillos la nota no se acepta');
});
await t('comandos: la nota viaja en definir_entrega como nota_pedido; sin contrato o de más, el recibo se rechaza', () => {
  const recibo = { flow_token: 'tk', items: [{ producto0: 'p0', cantidad: '1' }], modalidad: 'm0', pago: 'p0', nota: DEDICATORIA };
  const entrega = comandosFormulario(fotoCategorias(), recibo).find((c) => c.herramienta === 'definir_entrega');
  assert.deepEqual(entrega.argumentos, { modalidad: 'recoger en tienda', nota_pedido: DEDICATORIA });
  assert.equal(comandosFormulario(fotoCategorias({ nota: false }), recibo), null);
  assert.equal(comandosFormulario(fotoCategorias(), { ...recibo, nota: 'x'.repeat(201) }), null);
  const sinNota = comandosFormulario(fotoCategorias(), { ...recibo, nota: undefined }).find((c) => c.herramienta === 'definir_entrega');
  assert.deepEqual(sinNota.argumentos, { modalidad: 'recoger en tienda' }, 'sin nota, el pedido conserva la suya');
  const carrito = fotoCarrito();
  const filas = [{ key: 'e0', item: { producto0: 'p0', cantidad: '1', observaciones: '' } }];
  const c = comandosCarrito(carrito, { flow_token: 'tk', filas, modalidad: 'm0', pago: 'p0', nota: '' });
  assert.equal(c.find((x) => x.herramienta === 'definir_entrega').argumentos.nota_pedido, '');
  assert.equal(comandosCarrito(fotoCarrito({ nota: false }), { flow_token: 'tk', filas, modalidad: 'm0', pago: 'p0', nota: '' }), null);
  // Con domicilio la nota va junto con la dirección, en la misma llamada.
  const domicilio = comandosCarrito(carrito, { flow_token: 'tk', filas, modalidad: 'm1', pago: 'p0', nota: DEDICATORIA,
    direccion: { calle: 'Hidalgo 405', colonia: 'Centro', referencias: '', zona: 'zn' } }).find((x) => x.herramienta === 'definir_entrega');
  assert.equal(domicilio.argumentos.direccion, 'Hidalgo 405, Centro'); assert.equal(domicilio.argumentos.nota_pedido, DEDICATORIA);
  const cierre = [{ herramienta: 'definir_entrega', argumentos: { modalidad: 'recoger en tienda' } }];
  assert.equal(cierreConNota({}, cierre, 'x'), null, 'sin contrato no se acepta nota');
  assert.equal(cierreConNota({}, cierre, undefined), cierre);
});
await t('endpoint completo: Entrega con nota y domicilio → dirección → recibo con dirección y nota', async () => {
  const foto = fotoCarrito();
  const e = cx(foto, aEntrega(foto), 'ENTREGA', { operacion: 'revisar', modalidad: 'm1', pago: 'p0', nota: DEDICATORIA }).borrador;
  const fin = cx(foto, e, 'DIRECCION', dir).borrador;
  assert.equal(fin.etapa, 'FINAL');
  const recibo = await final(foto, fin);
  assert.equal(recibo.nota, DEDICATORIA); assert(recibo.direccion);
  assert.equal(comandosCarrito(foto, recibo).find((c) => c.herramienta === 'definir_entrega').argumentos.nota_pedido, DEDICATORIA);
});

// ── Ejecutor: solo el formulario escribe la nota ─────────────────────────
const reglas = { pedidos: { costo_envio: 60, zonas_entrega: ZONAS } };
const modalidades = ['recoger en tienda', 'entrega a domicilio'];
const conCafe = () => {
  const estado = estadoNuevo({ negocioId: 'n', conversacionId: 'c' });
  estado.carrito.items = [{ lid: 'l1', id: '1', nombre: 'Café americano', cantidad: 1, modificadores: [] }];
  estado.carrito.datos = { modalidad: 'recoger en tienda', forma_pago: 'efectivo', cliente: { nombre: 'Cliente local' } };
  return estado;
};
const aplicarEntrega = (estado, argumentos) => aplicarComandosInternos([{ herramienta: 'definir_entrega', argumentos }],
  { estado, reglas, modalidades, catalogo: [] });
await t('ejecutor: el formulario guarda la nota en datos.notas y la vacía con «»', async () => {
  const estado = conCafe();
  assert.equal((await aplicarEntrega(estado, { modalidad: 'recoger en tienda', nota_pedido: DEDICATORIA })).ok, true);
  assert.equal(estado.carrito.datos.notas, DEDICATORIA);
  assert.equal((await aplicarEntrega(estado, { modalidad: 'recoger en tienda' })).ok, true);
  assert.equal(estado.carrito.datos.notas, DEDICATORIA, 'un recibo sin nota no la borra');
  assert.equal((await aplicarEntrega(estado, { modalidad: 'recoger en tienda', nota_pedido: '' })).ok, true);
  assert.equal('notas' in estado.carrito.datos, false);
  // Fuera de límites ni con la capacidad: todo el recibo se cae.
  const otro = conCafe();
  assert.equal((await aplicarEntrega(otro, { modalidad: 'recoger en tienda', nota_pedido: 'x'.repeat(201) })).ok, false);
  assert.equal((await aplicarEntrega(otro, { modalidad: 'recoger en tienda', nota_pedido: 'a\u0007b' })).ok, false);
  assert.equal('notas' in otro.carrito.datos, false);
});
await t('ejecutor: el modelo no puede mandar nota_pedido (ni por su esquema ni por el ejecutor)', async () => {
  assert.equal(validarArgumentos('definir_entrega', { modalidad: 'recoger en tienda', nota_pedido: 'x' }).ok, false);
  assert.equal(validarArgumentos('definir_entrega', { modalidad: 'recoger en tienda' }).ok, true);
  assert.doesNotMatch(JSON.stringify(definicionesParaElModelo()), /nota_pedido/);
  const estado = conCafe();
  const ej = crearEjecutor({ estado, reglas, modalidades, mensaje: 'para recoger, ponle feliz cumpleaños' });
  const r = await ej.ejecutar('definir_entrega', { modalidad: 'recoger en tienda', nota_pedido: 'feliz cumpleaños' });
  assert.equal(r.aplicado, false); assert.equal('notas' in estado.carrito.datos, false);
});

// ── Resumen, vista, huella y orden ───────────────────────────────────────
const carritoBase = () => ({ items: [{ nombre: 'Café americano', cantidad: 2, modificadores: [{ grupo: 'Leche', opciones: ['Entera'] }],
  notas: 'bien caliente' }], datos: { modalidad: 'recoger en tienda', forma_pago: 'efectivo',
  cliente: { nombre: 'Cliente local', referencias: 'Portón negro' } } });
await t('huella: sin nota, byte a byte la de hoy (los resúmenes abiertos al desplegar siguen confirmando)', () => {
  const r = resumenDelPedido(carritoBase(), { precios: { 'Café americano': 45 } });
  assert.equal('nota_pedido' in r, false);
  assert.equal(huellaDelResumen(r), '{"items":[["Café americano",2,["Leche:Entera"],"bien caliente",45]],"modalidad":"recoger en tienda",'
    + '"pago":"efectivo","programado_para":null,"cliente":["cliente local","","","","","","","",""],"subtotal":90,"costo_envio":0,"total":90}');
  const vacia = carritoBase(); vacia.datos.notas = '   ';
  assert.equal(huellaDelResumen(resumenDelPedido(vacia, { precios: { 'Café americano': 45 } })), huellaDelResumen(r));
  // Con nota, la huella cambia, y cambiarla después del resumen deja sin valor ese «sí».
  const con = carritoBase(); con.datos.notas = DEDICATORIA;
  const h1 = huellaDelResumen(resumenDelPedido(con, { precios: { 'Café americano': 45 } }));
  con.datos.notas = 'Otra dedicatoria';
  const h2 = huellaDelResumen(resumenDelPedido(con, { precios: { 'Café americano': 45 } }));
  assert.notEqual(h1, huellaDelResumen(r)); assert.notEqual(h1, h2);
});
await t('vista: la nota del pedido solo cuando existe', () => {
  const catalogo = [{ id: 'c1', nombre: 'Bebidas', productos: [{ id: '1', nombre: 'Café americano', precio: 45, disponible: true, grupos: [] }] }];
  const carrito = { items: [{ lid: 'l1', id: '1', nombre: 'Café americano', cantidad: 1, modificadores: [] }],
    datos: { modalidad: 'recoger en tienda', forma_pago: 'efectivo' } };
  const sin = vistaDelPedido({ carrito, catalogo });
  assert.equal('nota_pedido' in sin, false); assert.equal('nota_pedido' in sin.resumen, false);
  const con = vistaDelPedido({ carrito: { ...carrito, datos: { ...carrito.datos, notas: DEDICATORIA } }, catalogo });
  assert.equal(con.nota_pedido, DEDICATORIA); assert.notEqual(con.huella, sin.huella);
});
const pedidoResumen = { lineas: [{ producto: 'Café americano', precio_unitario: 45, cantidad: 2, opciones: [{ opcion: 'Entera' }], nota: 'bien caliente' }],
  falta: [], aclaraciones: [], subtotal: 90, costo_envio: 0, total: 90, modalidad: 'recoger en tienda', forma_pago: 'efectivo',
  cliente: { nombre: 'Cliente local' } };
const render = (p) => respuestaDesdePedido({ estado: {}, pedido: p, modalidades: ['recoger en tienda'], metodosPago: [], requierePago: true });
await t('«Revisa tu pedido»: la nota antes del total; sin nota, el texto de hoy', () => {
  assert.equal(render(pedidoResumen), '*Revisa tu pedido*\n\n*2 × Café americano · $90*\n$45 c/u\nEntera\nNota: bien caliente\n\n'
    + 'Modalidad: Recoger en tienda\nForma de pago: Efectivo\nNombre: Cliente local\n\n*Total: $90*\n¿Confirmas este pedido?');
  const con = render({ ...pedidoResumen, nota_pedido: `*${DEDICATORIA}*` });
  assert.match(con, new RegExp(`Nombre: Cliente local\\nNota del pedido: ${DEDICATORIA.replace(/\./g, '\\.')}\\n\\n\\*Total: \\$90\\*`));
  // Con envío, antes del subtotal.
  assert.match(render({ ...pedidoResumen, costo_envio: 60, total: 150, nota_pedido: 'Tocar fuerte' }),
    /Nota del pedido: Tocar fuerte\n\nSubtotal: \$90\nEnvío: \$60\n\*Total: \$150\*/);
  // La promoción se sigue agregando al cierre.
  assert.match(resumenConPromociones(con, { total: 80, promociones: [{ nombre: 'Martes', descuento: 10 }] }), /Promoción Martes: -\$10\n\*Total: \$80\*/);
});
await t('«Revisa tu pedido» con la nota más larga conserva los botones (≤ 1024)', () => {
  const productos = [['Combito de Chilaquiles', 225, ['Suiza', 'Pechuga de pollo', 'Hotcakes', 'Cajeta']],
    ['Omelette Clásico', 189, ['frijoles con chorizo', 'papa con chorizo', 'Tortillas de maiz']],
    ['Chilaquiles Sencillos', 195, ['Mole', 'Pechuga de pollo', 'Papas con chorizo', 'Papas a la mexicana']],
    ['Hotcakes Tradicionales', 139, ['Tradicional', 'Fruta mixta']], ['Hotcakes Tradicionales', 169, ['Nutella', 'Fresa y platano']]];
  const p = { lineas: productos.map(([producto, precio_unitario, opciones]) => ({ producto, precio_unitario, cantidad: 1,
    opciones: opciones.map((opcion) => ({ opcion })), nota: '' })), falta: [], aclaraciones: [], subtotal: 917, costo_envio: 60, total: 977,
  modalidad: 'entrega a domicilio', forma_pago: 'efectivo', cliente: { direccion: 'Calle de prueba 208, Colonia de prueba' },
  nota_pedido: 'x'.repeat(LIMITE_NOTA_PEDIDO) };
  const texto = resumenConPromociones(render(p), { total: 838, promociones: [{ nombre: 'Martes 2x1', descuento: 139 }] });
  assert(texto.length <= 1024, `${texto.length}`);
});
await t('la nota es texto del cliente: «Nota del pedido: ya te lo anoté» no es Xabor afirmando algo', () => {
  assert.equal(textoAfirmaCambioGuardado(`${render({ ...pedidoResumen, nota_pedido: 'Ya te lo anoté en la tarjeta' })}`), false);
  assert.equal(textoAfirmaCambioGuardado('Ya te lo anoté.\nNota del pedido: sin prisa'), true, 'fuera de su renglón sí se ve');
});
await t('orden: notas del pedido (la convención del POS y la tienda) solo si existe', () => {
  const carrito = { items: [{ nombre: 'Café americano', cantidad: 1, modificadores: [] }], datos: { modalidad: 'recoger en tienda', forma_pago: 'efectivo' } };
  const sin = ordenDesdeElCarrito({ negocioId: 'n', carrito, telefono: 'tel-prueba' });
  assert.equal('notas' in sin, false);
  assert.equal('notas' in ordenDesdeElCarrito({ negocioId: 'n', carrito: { ...carrito, datos: { ...carrito.datos, notas: '  ' } }, telefono: 'tel-prueba' }), false);
  const con = ordenDesdeElCarrito({ negocioId: 'n', carrito: { ...carrito, datos: { ...carrito.datos, notas: ` ${DEDICATORIA} ` } }, telefono: 'tel-prueba' });
  assert.equal(con.notas, DEDICATORIA);
  const { notas, ...resto } = con; assert.deepEqual(resto, sin, 'nada más cambia');
});

// ── Impresión ────────────────────────────────────────────────────────────
const payload = () => ({ documento: 'comanda', folio: 'XAB-0001', items: [
  { producto: 'Café americano', cantidad: 1, modificadores: [{ grupo: 'Leche', opcion: 'Entera' }], notas: 'bien caliente' },
  { producto: 'Pastel', cantidad: 1, modificadores: [], notas: null }] });
const MESERO = { conversacion_id: 'agente:prueba' };
await t('comanda: la nota del pedido al inicio de la nota del PRIMER artículo, solo canal whatsapp, sin duplicarse', () => {
  const p = conNotaDelPedido(payload(), { canal: 'whatsapp', origen_agente: MESERO, notas: `${DEDICATORIA}\n` });
  assert.equal(p.items[0].notas, `${PREFIJO_NOTA_DEL_PEDIDO}${DEDICATORIA} · bien caliente`);
  assert.equal(p.items[1].notas, null, 'solo el primero');
  assert.deepEqual(conNotaDelPedido(structuredClone(p), { canal: 'whatsapp', origen_agente: MESERO, notas: DEDICATORIA }), p, 'no se duplica');
  const sinNotaPropia = payload(); sinNotaPropia.items[0].notas = '';
  assert.equal(conNotaDelPedido(sinNotaPropia, { canal: 'whatsapp', origen_agente: MESERO, notas: DEDICATORIA }).items[0].notas, `NOTA DEL PEDIDO: ${DEDICATORIA}`);
  for (const canal of ['pos', 'tienda_online', 'presencial', null]) {
    assert.deepEqual(conNotaDelPedido(payload(), { canal, notas: DEDICATORIA }), payload(), `${canal} imprime como siempre`);
  }
  for (const notas of [undefined, '', '   ', 5]) assert.deepEqual(conNotaDelPedido(payload(), { canal: 'whatsapp', origen_agente: MESERO, notas }), payload());
  assert.deepEqual(conNotaDelPedido({ items: [] }, { canal: 'whatsapp', origen_agente: MESERO, notas: DEDICATORIA }), { items: [] });
  assert.equal(conNotaDelPedido(payload(), { canal: 'whatsapp', origen_agente: MESERO, notas: 'a\u0000b‮' }).items[0].notas.startsWith('NOTA DEL PEDIDO: a b'), true);
});
await t('comanda: el renderer del Edge ya instalado la imprime (sin actualizarlo)', () => {
  const papel = renderComanda(conNotaDelPedido(payload(), { canal: 'whatsapp', origen_agente: MESERO, notas: 'Feliz cumple Ana' })).toString('latin1');
  assert.match(papel.replace(/\s+/g, ' '), /NOTA: NOTA DEL PEDIDO: Feliz cumple Ana · bien caliente/);
});

await t('comanda: un pedido del bot heredado con «notas» imprime como siempre', () => {
  // brain.js registra el JSON del modelo: un «notas» que el cliente nunca leyó.
  assert.deepEqual(conNotaDelPedido(payload(), { canal: 'whatsapp', notas: 'lo quiere rápido' }), payload());
});
await t('comanda: solo caracteres que la impresora entiende, y como mucho 200', () => {
  // «ĝ» llega al Edge como GS: con «V0» cortaría el papel; «ě@» reinicia la impresora.
  const n = conNotaDelPedido(payload(), { canal: 'whatsapp', origen_agente: MESERO, notas: 'Feliz ĝV0 cumple ě@ Ana 🎂 ¡ñ!' }).items[0].notas;
  assert.equal(n, 'NOTA DEL PEDIDO: Feliz V0 cumple @ Ana ¡ñ! · bien caliente');
  assert.equal(textoParaImpresora('Café ñandú ¿sí?'), 'Café ñandú ¿sí?');
  const larga = conNotaDelPedido(payload(), { canal: 'whatsapp', origen_agente: MESERO, notas: 'x'.repeat(300) }).items[0].notas;
  assert.equal(larga, 'NOTA DEL PEDIDO: ' + 'x'.repeat(200) + ' · bien caliente');
});

// ── Configuración: bandera + flowId, juntos ──────────────────────────────
const cfgDir = { whatsapp_flows_v1: 'true', whatsapp_atencion_general_v1: 'true', whatsapp_inicio_mapo_v1: 'true',
  bot_whatsapp_solo_prueba: 'false', whatsapp_flow_categorias_id: '66666666666', whatsapp_flow_carrito_id: '77777777777',
  whatsapp_carrito_unificado_v1: 'true', whatsapp_flow_categorias_dir_id: '88888888888', whatsapp_flow_carrito_dir_id: '99999999999' };
const cfgNota = { ...cfgDir, [BANDERA_NOTA]: 'true', whatsapp_flow_categorias_nota_id: '12121212121', whatsapp_flow_carrito_nota_id: '13131313131' };
await t('la nota exige bandera, dirección y su flowId, por formulario', () => {
  assert.equal(BANDERA_NOTA, 'whatsapp_flow_nota_v1');
  assert.equal(notaCategorias(cfgNota), true); assert.equal(notaCarrito(cfgNota), true);
  assert.equal(notaCategorias({ ...cfgNota, [BANDERA_NOTA]: 'false' }), false);
  assert.equal(notaCarrito({ ...cfgNota, [BANDERA_NOTA]: undefined }), false);
  assert.equal(notaCategorias({ ...cfgNota, whatsapp_flow_categorias_dir_id: undefined }), false, 'sin dirección no hay nota');
  assert.equal(notaCarrito({ ...cfgNota, whatsapp_flow_carrito_nota_id: 'x' }), false);
  assert.equal(notaCategorias({ ...cfgNota, whatsapp_flow_carrito_nota_id: undefined }), true, 'cada formulario por su lado');
});
await t('flowId esperado y endpoint: sin la nota, los de hoy; con la bandera apagada, el formulario con nota se corta', () => {
  for (const datos of [{ version: 'carrito_v1' }, { version: 'carrito_v1', contrato: CONTRATO_DIRECCION },
    { version: 'repetible_v1', presentacion: 'categorias_v1' }, { version: 'repetible_v1', presentacion: 'categorias_v1', contrato: CONTRATO_DIRECCION }]) {
    assert.equal(flowIdEsperadoConNota(cfgDir, datos), flowIdEsperado(cfgDir, datos));
    assert.equal(flowIdEsperadoConNota(cfgNota, datos), flowIdEsperado(cfgNota, datos), 'sin contrato_nota, la regla de hoy');
  }
  const carrito = { version: 'carrito_v1', contrato: CONTRATO_DIRECCION, contrato_nota: CONTRATO_NOTA };
  const cat = { version: 'repetible_v1', presentacion: 'categorias_v1', contrato: CONTRATO_DIRECCION, contrato_nota: CONTRATO_NOTA };
  assert.equal(flowIdEsperadoConNota(cfgNota, carrito), '13131313131');
  assert.equal(flowIdEsperadoConNota(cfgNota, cat), '12121212121');
  assert.equal(flowIdEsperadoConNota({ ...cfgNota, [BANDERA_NOTA]: 'false' }, carrito), null, 'bandera apagada a mano: se corta');
  assert.equal(flowIdEsperadoConNota({ ...cfgNota, [BANDERA_NOTA]: 'false' }, cat), null);
  assert.deepEqual(flowIdsConEndpointConNota(cfgDir), flowIdsConEndpoint(cfgDir));
  assert.deepEqual(flowIdsConEndpointConNota(cfgNota), [...flowIdsConEndpoint(cfgNota), '12121212121', '13131313131']);
});
await t('endpoint: un formulario con dirección y sin nota abierto antes de activar la nota se corta', () => {
  const carrito = { version: 'carrito_v1', contrato: CONTRATO_DIRECCION };
  const cat = { version: 'repetible_v1', presentacion: 'categorias_v1', contrato: CONTRATO_DIRECCION };
  assert.equal(sinNotaVieja(cfgDir, carrito), false, 'sin la nota, como hoy'); assert.equal(sinNotaVieja(cfgDir, cat), false);
  assert.equal(sinNotaVieja(cfgNota, carrito), true); assert.equal(sinNotaVieja(cfgNota, cat), true);
  assert.equal(sinNotaVieja(cfgNota, { ...carrito, contrato_nota: CONTRATO_NOTA }), false);
  assert.equal(sinNotaVieja(cfgNota, { version: 'carrito_v1' }), false, 'el de sin dirección lo corta su propia regla');
});
// El transporte de Flows exige estas variables: solo durante los casos que lo
// usan, y se restauran (mismo cuidado que check-flow-direccion.mjs).
const ENTORNO_FLOWS = { WHATSAPP_FLOW_ENDPOINT: 'true', WHATSAPP_FLOW_PRIVATE_KEY: 'x', META_APP_SECRET: 'x' };
const conEntornoFlows = async (fn) => {
  const previo = Object.fromEntries(Object.keys(ENTORNO_FLOWS).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENTORNO_FLOWS);
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};
const catalogo = [{ id: 'c1', nombre: 'Bebidas', orden: 0, productos: [{ id: 1, nombre: 'Café americano', precio: 45, disponible: true, grupos: [] }] }];
const base = { catalogo, modalidades, metodosPago: [{ tipo: 'efectivo', disponible_para_bot: true, habilitado: true }], reglas };
const estadoCon = (pendiente, notas) => { const e = conCafe(); e.pendiente = pendiente; if (notas !== undefined) e.carrito.datos.notas = notas; return e; };
await conEntornoFlows(() => t('foto: sin la bandera (o sin flowId) idéntica a la de dirección; con ella, contrato y flowId propios', () => {
  for (const [accion, pendiente] of [['flow_productos', { tipo: 'agregar_otro' }], ['flow_configurar', { tipo: 'editar_pedido' }]]) {
    const dirFoto = fotoFormulario({ ...base, estado: estadoCon(pendiente, DEDICATORIA), cfg: cfgDir }, accion);
    assert.equal(dirFoto.contrato, CONTRATO_DIRECCION, accion);
    for (const cfg of [{ ...cfgNota, [BANDERA_NOTA]: 'false' }, { ...cfgDir, [BANDERA_NOTA]: 'true' },
      { ...cfgNota, whatsapp_flow_categorias_nota_id: undefined, whatsapp_flow_carrito_nota_id: undefined }]) {
      assert.deepEqual(fotoFormulario({ ...base, estado: estadoCon(pendiente, DEDICATORIA), cfg }, accion), dirFoto, accion);
    }
    const con = fotoFormulario({ ...base, estado: estadoCon(pendiente, DEDICATORIA), cfg: cfgNota }, accion);
    assert.equal(con.contrato_nota, CONTRATO_NOTA); assert.equal(con.nota_inicial, DEDICATORIA);
    assert.equal(con.flowId, accion === 'flow_productos' ? '12121212121' : '13131313131');
    const { contrato_nota, nota_inicial, flowId, ...resto } = con, { flowId: _f, ...restoDir } = dirFoto;
    assert.deepEqual(resto, restoDir, 'la nota solo agrega su contrato y su precarga');
  }
  // El carrito no hereda la nota de «Arma tu pedido»: sin su flowId, la foto es la de dirección.
  const soloCat = { ...cfgNota, whatsapp_flow_carrito_nota_id: undefined };
  const carrito = fotoFormulario({ ...base, estado: estadoCon({ tipo: 'editar_pedido' }), cfg: soloCat }, 'flow_configurar');
  assert.equal(carrito.contrato_nota, undefined); assert.equal(carrito.flowId, '99999999999');
  // Apagar la bandera deja vencido el formulario con nota (su recibo no se aplica).
  const enviada = fotoFormulario({ ...base, estado: estadoCon({ tipo: 'editar_pedido' }), cfg: cfgNota }, 'flow_configurar');
  assert.equal(formularioVigente({ accion: 'flow_configurar', datos: enviada }, { ...base, estado: estadoCon({ tipo: 'editar_pedido' }), cfg: cfgNota }), true);
  assert.equal(formularioVigente({ accion: 'flow_configurar', datos: enviada },
    { ...base, estado: estadoCon({ tipo: 'editar_pedido' }), cfg: { ...cfgNota, [BANDERA_NOTA]: 'false' } }), false);
  // Cambiar la nota por chat cambia la precarga, no el formulario abierto.
  assert.equal(formularioVigente({ accion: 'flow_configurar', datos: enviada },
    { ...base, estado: estadoCon({ tipo: 'editar_pedido' }, 'otra'), cfg: cfgNota }), true);
}));
await conEntornoFlows(() => t('el mensaje del formulario dice dónde va la dedicatoria, solo con la nota', () => {
  const texto = '¿Algo más?';
  const armar = (cfg) => {
    const estado = estadoCon({ tipo: 'agregar_otro' });
    estado.dialogo = { ciclo: estado.conversacionId, texto, id: 'd1' };
    return construirFormulario({ estado, pedido: { huella: 'h', total: 45 }, texto, cfg, telefono: 'tel-prueba', ...base });
  };
  const con = armar(cfgNota), sin = armar(cfgDir);
  assert.equal(con.carga.action.parameters.flow_id, '13131313131'); assert.equal(sin.carga.action.parameters.flow_id, '99999999999');
  assert.match(con.texto, /«Nota del pedido» en «Entrega y pago»/); assert.doesNotMatch(sin.texto, /Nota del pedido/);
  assert.equal(con.texto.replace('\nPara una dedicatoria o indicaciones, usa «Nota del pedido» en «Entrega y pago».', ''), sin.texto);
}));

// ── Activación y reversa ─────────────────────────────────────────────────
await t('activación: bandera y dos flowId nuevos JUNTOS, con respaldo; exige la dirección activa', () => {
  assert.match(planActivacionNota(cfgDir, '12121', '12121').error, /mismo flowId/);
  assert.match(planActivacionNota(cfgDir, '1212', '13131').error, /dos flowId/);
  assert.match(planActivacionNota(cfgDir, '88888888888', '13131').error, /otro formulario/);
  assert.match(planActivacionNota(cfgDir, '12121', '77777777777').error, /otro formulario/);
  assert.match(planActivacionNota({ ...cfgDir, whatsapp_flow_carrito_dir_id: undefined }, '12121', '13131').error, /dirección activa/);
  const p = planActivacionNota(cfgDir, '12121', '13131');
  assert.deepEqual(p.cambios, { whatsapp_flow_categorias_nota_id: '12121', whatsapp_flow_carrito_nota_id: '13131', whatsapp_flow_nota_v1: 'true' });
  assert.deepEqual(p.flows, [['12121', 'categorias'], ['13131', 'carrito']]);
  assert.deepEqual(p.respaldo.antes, { whatsapp_flow_categorias_nota_id: null, whatsapp_flow_carrito_nota_id: null, whatsapp_flow_nota_v1: null });
  const activa = { ...cfgDir, ...p.cambios, [CLAVE_RESPALDO_NOTA]: JSON.stringify(p.respaldo) };
  assert.equal(notaCategorias(activa) && notaCarrito(activa), true);
  assert.match(planActivacionNota(activa, '14141', '15151').error, /Ya existe respaldo/);
  assert.equal(planActivacionNota(activa, '12121', '13131').respaldo, null, 'reactivar lo mismo no pisa el respaldo');
  // Claves puestas a mano sin respaldo (también la bandera sola): revertir no las apagaría.
  assert.match(planActivacionNota({ ...cfgDir, [BANDERA_NOTA]: 'true' }, '12121', '13131').error, /a mano/);
  assert.match(planActivacionNota({ ...cfgDir, whatsapp_flow_carrito_nota_id: '13131' }, '12121', '13131').error, /a mano/);
  assert.equal(CLAVE_RESPALDO_NOTA, 'whatsapp_flows_nota_respaldo');
});
await t('reversa: deja la configuración de dirección; acepta lo quitado a mano y no pisa un cambio ajeno', () => {
  const p = planActivacionNota(cfgDir, '12121', '13131');
  const activa = { ...cfgDir, ...p.cambios, [CLAVE_RESPALDO_NOTA]: JSON.stringify(p.respaldo) };
  const r = planReversaNota(activa);
  assert.deepEqual(r.aplicar, { whatsapp_flow_categorias_nota_id: null, whatsapp_flow_carrito_nota_id: null, whatsapp_flow_nota_v1: null });
  const despues = { ...activa }; for (const [k, v] of Object.entries(r.aplicar)) if (v === null) delete despues[k];
  delete despues[CLAVE_RESPALDO_NOTA];
  assert.deepEqual(despues, cfgDir, 'vuelve exactamente a la de dirección');
  const aMano = { ...activa }; delete aMano[BANDERA_NOTA];
  assert.deepEqual(planReversaNota(aMano).aplicar, { whatsapp_flow_categorias_nota_id: null, whatsapp_flow_carrito_nota_id: null });
  assert.match(planReversaNota({ ...activa, whatsapp_flow_carrito_nota_id: '16161' }).error, /cambió/);
  assert.match(planReversaNota(cfgDir).error, /Sin respaldo/);
  // El respaldo de la dirección no es el de la nota (y al revés).
  assert.match(planReversaNota({ ...activa, [CLAVE_RESPALDO_NOTA]: undefined, whatsapp_flows_direccion_respaldo: '{"despues":{}}' }).error, /Sin respaldo/);
});
await t('dirección revertida con la nota puesta: la nota se apaga sola y activar otra dirección exige revertir la nota', () => {
  const p = planActivacionNota(cfgDir, '12121', '13131');
  const activa = { ...cfgDir, ...p.cambios, [CLAVE_RESPALDO_NOTA]: JSON.stringify(p.respaldo) };
  const sinDireccion = { ...activa }; delete sinDireccion.whatsapp_flow_categorias_dir_id; delete sinDireccion.whatsapp_flow_carrito_dir_id;
  assert.equal(notaCategorias(sinDireccion) || notaCarrito(sinDireccion), false);
  const base = { whatsapp_flow_categorias_id: '66666666666', whatsapp_flow_carrito_id: '77777777777' };
  assert.match(planActivacion({ ...base, [BANDERA_NOTA]: 'true' }, '88888888888', '99999999999').error, /revierte la nota/);
  assert.match(planActivacion({ ...base, whatsapp_flow_carrito_nota_id: '13131' }, '88888888888', '99999999999').error, /revierte la nota/);
  assert.equal(planActivacion(base, '88888888888', '99999999999').error, undefined, 'sin la nota, la regla de siempre');
  assert.equal(planActivacion({ ...base, [BANDERA_NOTA]: '' }, '88888888888', '99999999999').error, undefined);
  // La reversa de la nota funciona aunque la dirección ya no esté.
  assert.deepEqual(planReversaNota(sinDireccion).aplicar,
    { whatsapp_flow_categorias_nota_id: null, whatsapp_flow_carrito_nota_id: null, whatsapp_flow_nota_v1: null });
});

console.log(`nota del pedido: ${pasadas} OK, ${fallidas} fallos`);
assert.equal(fallidas, 0);
