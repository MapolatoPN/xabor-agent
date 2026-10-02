// Fase 1: la dirección de entrega dentro de los formularios (contrato
// direccion_v1). Puro: sin base de datos, Meta ni pedidos reales.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { definicionFlowCarrito } from './definicion-flow-carrito.mjs';
import { definicionFlowCategorias } from './definicion-flow-categorias.mjs';
import { CONTRATO_DIRECCION, limpiarCampo, flowIdEsperado, flowIdsConEndpoint, contratoCategorias, contratoCarrito,
  componerDireccion, fotoDireccion, validarDireccion, argumentosDeEntrega, cierreConDireccion, datosPantallaDireccion, fotoComparable }
  from '../src/mesero-agente/direccionFormulario.js';
import { borradorCompatible } from '../src/mesero-agente/recuperarBorradorFlow.js';
import { cambiarCategorias, respuestaCategorias } from '../src/mesero-agente/flowCategorias.js';
import { borradorCarrito, cambiarCarrito, respuestaCarrito, comandosCarrito } from '../src/mesero-agente/flowCarrito.js';
import { comandosFormulario, construirFormulario, fotoFormulario, formularioVigente } from '../src/mesero-agente/formularioAgrupado.js';
import { resolverFinalFlow, sinDireccionVieja } from '../src/mesero-agente/flowRepetibleSql.js';
import { CLAVE_RESPALDO_DIRECCION, planActivacion, planReversa } from '../src/mesero-agente/activacionDireccion.js';
import { zonasDelNegocio } from '../src/mesero-agente/zonasDeEntrega.js';
import { aplicarComandosInternos } from '../src/mesero-agente/comandosInternosAtomicos.js';
import { crearEjecutor, estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { huellaDelResumen } from '../src/mesero-whatsapp/resumenDelPedido.js';

let pasadas = 0, fallidas = 0;
const t = async (nombre, fn) => { try { await fn(); pasadas++; } catch (e) { fallidas++; console.error(`${nombre}: ${e.message}`); } };
const sha = (d) => createHash('sha256').update(JSON.stringify(d)).digest('hex').slice(0, 12);
const reglas = { pedidos: { costo_envio: 60, zonas_entrega: [{ nombre: 'UTNC', costo: 150 }, { nombre: 'Cervecera', costo: 150 },
  { nombre: 'Cartonera', costo: 120 }, { nombre: 'COMISION FEDERAL / CARBON 2', costo: 200 }, { nombre: 'Sin costo', costo: '' }] } };
const modalidades = ['recoger en tienda', 'entrega a domicilio'];
const ZONAS = [{ nombre: 'UTNC', costo: 150 }, { nombre: 'Cervecera', costo: 150 }, { nombre: 'Cartonera', costo: 120 },
  { nombre: 'COMISION FEDERAL / CARBON 2', costo: 200 }];
const fotoDir = (extra = {}) => ({ contrato: CONTRATO_DIRECCION, zonas: ZONAS, costo_envio: 60,
  direccion_inicial: { calle: '', colonia: '', referencias: '', zona: '' }, ...extra });

// ── Definiciones ─────────────────────────────────────────────────────────
await t('sin la opción, los formularios publicados no cambian (huellas fijadas)', () => {
  assert.equal(sha(definicionFlowCarrito()), '0cf5cf31a300');
  assert.equal(sha(definicionFlowCarrito({ duplicar: true })), 'b06e99ff4556');
  assert.equal(sha(definicionFlowCategorias()), '4aa4f8fe429e');
});
for (const [nombre, def, desde] of [['categorías', definicionFlowCategorias({ direccion: true }), 'ENTREGA'],
  ['carrito', definicionFlowCarrito({ direccion: true }), 'CARRITO'], ['carrito con duplicar', definicionFlowCarrito({ duplicar: true, direccion: true }), 'CARRITO']]) {
  await t(`${nombre}: pantalla DIRECCION terminal, alcanzable y dentro de los límites de Meta`, () => {
    assert(def.routing_model[desde].includes('DIRECCION'));
    assert.deepEqual(def.routing_model.DIRECCION, []);
    const p = def.screens.find((s) => s.id === 'DIRECCION');
    assert.equal(p.terminal, true); assert.equal(p.refresh_on_back, true);
    const form = p.layout.children[0];
    const campos = Object.fromEntries(form.children.filter((c) => c.name).map((c) => [c.name, c]));
    assert.deepEqual(Object.keys(campos).sort(), ['calle', 'colonia', 'referencias', 'zona']);
    for (const c of form.children) if (c.label) assert(c.label.length <= 20, c.label);
    for (const c of form.children) if (c['helper-text']) assert(c['helper-text'].length <= 80);
    assert.equal(campos.calle.type, 'TextInput'); assert.equal(campos.calle['max-chars'], 120); assert.equal(campos.calle.required, true);
    assert.equal(campos.colonia['max-chars'], 80); assert.equal(campos.referencias.type, 'TextArea');
    assert.equal(campos.referencias['max-length'], 200); assert.equal(campos.referencias['max-chars'], undefined);
    assert.equal(campos.zona.required, '${data.hay_zonas}'); assert.equal(campos.zona.visible, '${data.hay_zonas}');
    const pie = form.children.find((c) => c.type === 'Footer');
    const payload = pie['on-click-action'].payload;
    assert.equal(payload.operacion, 'direccion');
    for (const k of ['zona', 'calle', 'colonia', 'referencias']) assert.equal(payload[k], '${form.' + k + '}');
    for (const k of Object.keys(form['init-values'])) assert(campos[k], k);
    assert.deepEqual(Object.keys(p.data.zonas.items.properties).sort(), ['description', 'id', 'metadata', 'title']);
  });
}

// ── Saneado, validación y composición ────────────────────────────────────
await t('saneado: fuera controles C0/C1, bidi y ancho cero; límite por campo', () => {
  assert.equal(limpiarCampo('  Hidalgo‮ 405​\u0085 ', 120), 'Hidalgo 405');
  assert.equal(limpiarCampo('x'.repeat(121), 120), null);
  assert.equal(limpiarCampo(5, 120), null);
  assert.equal(limpiarCampo(undefined, 120), '');
  // Rellenos que se ven vacíos (U+3164 y compañía) y pilas de marcas combinantes.
  assert.equal(limpiarCampo('ㅤㅤㅤ', 120), '');
  assert.equal(validarDireccion(fotoDir(), { calle: 'ㅤᅟﾠ', zona: 'zn' }).ok, false);
  assert.equal(limpiarCampo('Hidal­go 405', 120), 'Hidalgo 405');
  assert.equal(/\p{M}{3}/u.test(limpiarCampo('a' + '́'.repeat(60) + ' 405', 120)), false);
});
await t('validación: calle, zona elegida y límites', () => {
  assert.equal(validarDireccion(fotoDir(), { calle: 'ab', zona: 'zn' }).ok, false);
  assert.equal(validarDireccion(fotoDir(), { calle: '###', zona: 'zn' }).ok, false);
  assert.equal(validarDireccion(fotoDir(), { calle: 'Hidalgo 405', zona: '' }).ok, false, 'con zonas hay que elegir');
  assert.equal(validarDireccion(fotoDir(), { calle: 'Hidalgo 405', zona: 'z9' }).ok, false);
  assert.equal(validarDireccion(fotoDir({ zonas: [] }), { calle: 'Hidalgo 405' }).partes.zona, 'zn', 'sin zonas, en la ciudad');
  const v = validarDireccion(fotoDir(), { calle: ' Hidalgo 405 ', colonia: 'Centro', referencias: 'Portón negro', zona: 'zn' });
  assert.deepEqual(v.partes, { calle: 'Hidalgo 405', colonia: 'Centro', referencias: 'Portón negro', zona: 'zn', zonaNombre: '' });
});
await t('«En la ciudad» con una zona escrita: avisa una vez y se respeta si lo reenvía igual', () => {
  const d = { calle: 'Calle Cervecera 210', colonia: 'Centro', zona: 'zn' };
  const primera = validarDireccion(fotoDir(), d);
  assert.equal(primera.ok, false); assert.match(primera.error, /menciona Cervecera/); assert(primera.aviso);
  assert.equal(validarDireccion(fotoDir(), { ...d, calle: 'Calle Cervecera 211' }, { confirmada: primera.aviso }).ok, false,
    'otro texto vuelve a preguntar');
  const segunda = validarDireccion(fotoDir(), d, { confirmada: primera.aviso });
  assert.equal(segunda.ok, true); assert.equal(segunda.partes.confirmada, primera.aviso);
  assert.equal(validarDireccion(fotoDir(), { calle: 'Hidalgo 405', referencias: 'cerca de la Cervecera', zona: 'zn' }).ok, true,
    'las referencias no cuentan');
});
await t('zona elegida y otra zona escrita con distinta tarifa: avisa; con la misma tarifa, no', () => {
  assert.equal(validarDireccion(fotoDir(), { calle: 'Edificio 3 frente a la Cartonera', zona: 'z0' }).ok, false);
  assert.equal(validarDireccion(fotoDir(), { calle: 'Edificio 3 frente a la Cervecera', zona: 'z0' }).ok, true);
  assert.equal(validarDireccion(fotoDir(), { calle: 'UTNC edificio 3', zona: 'z0' }).ok, true);
});
await t('composición: la zona va en la dirección sin duplicarse', () => {
  assert.equal(componerDireccion({ calle: 'Edificio 3', colonia: '', zona: 'UTNC' }), 'Edificio 3, UTNC');
  assert.equal(componerDireccion({ calle: 'UTNC edificio 3', zona: 'UTNC' }), 'UTNC edificio 3');
  assert.equal(componerDireccion({ calle: 'Hidalgo 405', colonia: 'Centro', zona: '' }), 'Hidalgo 405, Centro');
});
await t('foto: zonas usables y precarga solo de las partes que siguen siendo la dirección', () => {
  const estado = estadoNuevo({ negocioId: 'n', conversacionId: 'c' });
  estado.carrito.datos.cliente = { direccion: 'Edificio 3, UTNC', referencias: 'Caseta', direccion_partes: { calle: 'Edificio 3', colonia: '', zona: 'UTNC' } };
  const f = fotoDireccion({ estado, reglas });
  assert.deepEqual(f.zonas, ZONAS, 'la zona sin costo no se ofrece');
  assert.deepEqual(f.direccion_inicial, { calle: 'Edificio 3', colonia: '', referencias: 'Caseta', zona: 'z0' });
  estado.carrito.datos.cliente.direccion = 'Otra dirección escrita por chat';
  // Las referencias se ven siempre (también las del chat): vaciar el campo las borra.
  assert.deepEqual(fotoDireccion({ estado, reglas }).direccion_inicial, { calle: '', colonia: '', referencias: 'Caseta', zona: '' });
});
await t('foto: zona guardada que ya no está en la lista queda sin elegir; «En la ciudad» solo si eso eligió', () => {
  const estado = estadoNuevo({ negocioId: 'n', conversacionId: 'c' });
  estado.carrito.datos.cliente = { direccion: 'Edificio 3, UTNC', direccion_partes: { calle: 'Edificio 3', colonia: '', zona: 'UTNC' } };
  const renombrada = { pedidos: { ...reglas.pedidos, zonas_entrega: [{ nombre: 'UTNC Campus', costo: 150 }, ...ZONAS.slice(1)] } };
  assert.equal(fotoDireccion({ estado, reglas: renombrada }).direccion_inicial.zona, '');
  estado.carrito.datos.cliente = { direccion: 'Hidalgo 405, Centro', direccion_partes: { calle: 'Hidalgo 405', colonia: 'Centro', zona: '' } };
  assert.equal(fotoDireccion({ estado, reglas }).direccion_inicial.zona, 'zn');
});
await t('zonas: un nombre repetido se ofrece una vez, la misma que cobra el ejecutor', () => {
  const r = { pedidos: { zonas_entrega: [{ nombre: 'UTNC', costo: 150 }, { nombre: 'utnc', costo: 180 },
    { nombre: 'Sin', costo: '' }, { nombre: 'Sin', costo: 90 }] } };
  assert.deepEqual(zonasDelNegocio(r), [{ nombre: 'UTNC', costo: 150 }, { nombre: 'Sin', costo: 90 }]);
});
await t('pantalla: opción «En la ciudad» primero, títulos ≤ 30 y tarifa en metadata', () => {
  const d = datosPantallaDireccion(fotoDir(), { revision: 3, resumen: 'x' });
  assert.equal(d.zonas[0].id, 'zn'); assert.equal(d.zonas[0].metadata, 'Envío $60');
  assert(d.zonas.every((o) => o.title.length <= 30 && o.metadata.length <= 20));
  assert.equal(d.zonas[4].metadata, 'Envío $200'); assert.equal(d.zona_inicial, ''); assert.equal(d.hay_zonas, true);
  assert.equal(datosPantallaDireccion(fotoDir(), { revision: 3, resumen: 'x', intento: { zona: 'z2', calle: 'Pino 4' } }).calle_inicial, 'Pino 4');
});
await t('flowId: la clave nueva solo con la de siempre configurada', () => {
  const cfg = { whatsapp_flow_categorias_id: '11111', whatsapp_flow_carrito_id: '22222' };
  assert.equal(contratoCategorias(cfg), false); assert.equal(contratoCarrito({ ...cfg, whatsapp_flow_carrito_dir_id: '44444' }), true);
  assert.equal(contratoCarrito({ whatsapp_flow_carrito_dir_id: '44444' }), false);
  assert.equal(flowIdEsperado(cfg, { version: 'carrito_v1' }), '22222');
  assert.equal(flowIdEsperado({ ...cfg, whatsapp_flow_carrito_dir_id: '44444' }, { version: 'carrito_v1', contrato: CONTRATO_DIRECCION }), '44444');
  assert.equal(flowIdEsperado({ ...cfg, whatsapp_flow_categorias_dir_id: '33333' }, { version: 'repetible_v1', contrato: CONTRATO_DIRECCION }), '33333');
  assert.deepEqual(flowIdsConEndpoint({ ...cfg, whatsapp_flow_categorias_dir_id: '33333' }), ['11111', '22222', '33333']);
});
await t('cierre: domicilio exige dirección y una dirección exige domicilio y contrato', () => {
  const foto = fotoDir({ modalidades: [{ valor: 'recoger en tienda' }, { valor: 'entrega a domicilio' }] });
  const cierre = (m) => [{ herramienta: 'definir_entrega', argumentos: { modalidad: m } }, { herramienta: 'definir_pago', argumentos: { forma_pago: 'efectivo' } }];
  const dir = { calle: 'Hidalgo 405', colonia: 'Centro', referencias: '', zona: 'zn' };
  assert.equal(cierreConDireccion(foto, cierre('entrega a domicilio'), undefined), null);
  assert.equal(cierreConDireccion(foto, cierre('recoger en tienda'), dir), null);
  assert.deepEqual(cierreConDireccion(foto, cierre('recoger en tienda'), undefined), cierre('recoger en tienda'));
  assert.equal(cierreConDireccion({ ...foto, contrato: undefined }, cierre('entrega a domicilio'), dir), null);
  const c = cierreConDireccion(foto, cierre('entrega a domicilio'), dir);
  assert.deepEqual(c[0].argumentos, { modalidad: 'entrega a domicilio', direccion: 'Hidalgo 405, Centro', referencias: '',
    zona_entrega: '', direccion_partes: { calle: 'Hidalgo 405', colonia: 'Centro', zona: '' } });
  assert.equal(argumentosDeEntrega(foto, 'entrega a domicilio', { ...dir, extra: 1 }), null, 'campos desconocidos');
  assert.equal(argumentosDeEntrega(foto, 'entrega a domicilio', { ...dir, calle: 'Calle Cervecera 210' }), null, 'sin confirmar');
});

// ── Endpoint: categorías ─────────────────────────────────────────────────
const fotoCategorias = (contrato = true) => ({ tipo: 'flow_productos', version: 'repetible_v1', presentacion: 'categorias_v1',
  productos: [{ id: '1', nombre: 'Café americano', precio: 45, grupos: [], categoria: 'Bebidas', categoriaId: 'c1' }],
  modalidades: [{ valor: 'recoger en tienda', titulo: 'recoger' }, { valor: 'entrega a domicilio', titulo: 'domicilio' }],
  pagos: [{ valor: 'efectivo', titulo: 'Efectivo' }], modalidad: '', pago: '', ...(contrato ? fotoDir() : {}) });
const enEntrega = () => ({ revision: 4, etapa: 'ENTREGA', items: [{ producto0: 'p0', cantidad: '1' }], categoria: 'c1', navegacion: ['MENU', 'PLATILLO'] });
const paso = (foto, b, screen, data) => cambiarCategorias(foto, b, { action: 'data_exchange', screen, data: { revision: String(b.revision), ...data } });
await t('categorías: domicilio pasa a DIRECCION; recoger o sin contrato, al final como hoy', () => {
  const r = paso(fotoCategorias(), enEntrega(), 'ENTREGA', { operacion: 'revisar', modalidad: 'm1', pago: 'p0' });
  assert.equal(r.error, undefined); assert.equal(r.borrador.etapa, 'DIRECCION'); assert.equal(r.borrador.modalidad, 'm1');
  assert.equal(respuestaCategorias(fotoCategorias(), r.borrador, 'tk').screen, 'DIRECCION');
  assert.equal(paso(fotoCategorias(), enEntrega(), 'ENTREGA', { operacion: 'revisar', modalidad: 'm0', pago: 'p0' }).borrador.etapa, 'FINAL');
  assert.equal(paso(fotoCategorias(false), enEntrega(), 'ENTREGA', { operacion: 'revisar', modalidad: 'm1', pago: 'p0' }).borrador.etapa, 'FINAL');
});
await t('categorías: Atrás desde DIRECCION vuelve a ENTREGA con lo elegido', () => {
  const b = paso(fotoCategorias(), enEntrega(), 'ENTREGA', { operacion: 'revisar', modalidad: 'm1', pago: 'p0' }).borrador;
  const atras = cambiarCategorias(fotoCategorias(), b, { action: 'BACK', screen: 'DIRECCION' }).borrador;
  assert.equal(atras.etapa, 'ENTREGA'); assert.equal(atras.revision, b.revision + 1);
  const r = respuestaCategorias(fotoCategorias(), atras, 'tk');
  assert.equal(r.screen, 'ENTREGA'); assert.equal(r.data.modalidad_inicial, 'm1'); assert.equal(r.data.pago_inicial, 'p0');
});
await t('categorías: dirección válida termina; inválida conserva lo escrito; aviso se confirma reenviando', () => {
  const b = paso(fotoCategorias(), enEntrega(), 'ENTREGA', { operacion: 'revisar', modalidad: 'm1', pago: 'p0' }).borrador;
  const mala = paso(fotoCategorias(), b, 'DIRECCION', { operacion: 'direccion', zona: 'zn', calle: 'ab', colonia: '', referencias: '' });
  assert(mala.error); assert.equal(mala.borrador.revision, b.revision);
  const vista = respuestaCategorias(fotoCategorias(), mala.borrador, 'tk', mala.error, { revision: String(b.revision), calle: 'ab', zona: 'zn' });
  assert.equal(vista.screen, 'DIRECCION'); assert.equal(vista.data.calle_inicial, 'ab'); assert.equal(vista.data.error_visible, true);
  const d = { operacion: 'direccion', zona: 'zn', calle: 'Calle Cervecera 210', colonia: 'Centro', referencias: 'Portón negro' };
  const aviso = paso(fotoCategorias(), b, 'DIRECCION', d);
  assert(aviso.error); assert.equal(aviso.borrador.revision, b.revision + 1); assert(aviso.borrador.aviso_direccion);
  assert.equal(respuestaCategorias(fotoCategorias(), aviso.borrador, 'tk', aviso.error).data.calle_inicial, 'Calle Cervecera 210');
  const ok = paso(fotoCategorias(), aviso.borrador, 'DIRECCION', d);
  assert.equal(ok.error, undefined); assert.equal(ok.borrador.etapa, 'FINAL');
  assert.equal(ok.borrador.direccion.confirmada, aviso.borrador.aviso_direccion);
  assert(paso(fotoCategorias(), b, 'DIRECCION', { ...d, intruso: 'x' }).error, 'campos desconocidos');
});
await t('categorías: el recibo con dirección produce la entrega con zona, y sin contrato se rechaza', () => {
  const foto = fotoCategorias();
  const recibo = { flow_token: 'tk', items: [{ producto0: 'p0', cantidad: '1' }], modalidad: 'm1', pago: 'p0',
    direccion: { calle: 'Edificio 3', colonia: '', referencias: 'Caseta norte', zona: 'z0' } };
  const cmds = comandosFormulario(foto, recibo);
  const entrega = cmds.find((c) => c.herramienta === 'definir_entrega');
  assert.deepEqual(entrega.argumentos, { modalidad: 'entrega a domicilio', direccion: 'Edificio 3, UTNC', referencias: 'Caseta norte',
    zona_entrega: 'UTNC', direccion_partes: { calle: 'Edificio 3', colonia: '', zona: 'UTNC' } });
  assert.equal(comandosFormulario(fotoCategorias(false), recibo), null);
  assert.equal(comandosFormulario(foto, { ...recibo, direccion: undefined }), null, 'domicilio sin dirección');
});

// ── Endpoint: carrito ────────────────────────────────────────────────────
const fotoCarrito = (extra = {}) => ({ ...fotoCategorias(), tipo: 'flow_configurar', version: 'carrito_v1',
  lineas: [{ linea_id: 'l1', cantidad: 1, ficha: { id: '1', nombre: 'Café americano', precio: 45, grupos: [] }, seleccion: [], nota: '' }],
  ...extra });
await t('carrito: Guardar con domicilio lleva a DIRECCION; Atrás regresa al carrito; la dirección termina', () => {
  const foto = fotoCarrito();
  let b = borradorCarrito(foto);
  const g = cambiarCarrito(foto, b, { action: 'data_exchange', screen: 'CARRITO', data: { revision: '0', operacion: 'guardar', modalidad: 'm1', pago: 'p0' } });
  assert.equal(g.error, undefined); assert.equal(g.borrador.etapa, 'DIRECCION');
  assert.equal(respuestaCarrito(foto, g.borrador, 'tk').screen, 'DIRECCION');
  const atras = cambiarCarrito(foto, g.borrador, { action: 'BACK', screen: 'DIRECCION' }).borrador;
  assert.equal(atras.etapa, 'CARRITO');
  const r = respuestaCarrito(foto, atras, 'tk'); assert.equal(r.data.modalidad_inicial, 'm1');
  const fin = cambiarCarrito(foto, g.borrador, { action: 'data_exchange', screen: 'DIRECCION', data: { revision: String(g.borrador.revision),
    operacion: 'direccion', zona: 'zn', calle: 'Hidalgo 405', colonia: 'Centro', referencias: '' } });
  assert.equal(fin.error, undefined); assert.equal(fin.borrador.etapa, 'FINAL');
  const cmds = comandosCarrito(foto, { flow_token: 'tk', filas: fin.borrador.filas, modalidad: fin.borrador.modalidad, pago: fin.borrador.pago,
    direccion: fin.borrador.direccion });
  assert.equal(cmds.find((c) => c.herramienta === 'definir_entrega').argumentos.direccion, 'Hidalgo 405, Centro');
  b = borradorCarrito(foto);
  assert.equal(cambiarCarrito(foto, b, { action: 'data_exchange', screen: 'CARRITO', data: { revision: '0', operacion: 'guardar', modalidad: 'm0', pago: 'p0' } })
    .borrador.etapa, 'FINAL', 'recoger termina como hoy');
  const sin = fotoCarrito(); delete sin.contrato;
  assert.equal(cambiarCarrito(sin, borradorCarrito(sin), { action: 'data_exchange', screen: 'CARRITO',
    data: { revision: '0', operacion: 'guardar', modalidad: 'm1', pago: 'p0' } }).borrador.etapa, 'FINAL', 'sin contrato, como hoy');
});
await t('carrito: «Escribir dirección» abre directo en DIRECCION solo con domicilio y pago', () => {
  const abrir = fotoCarrito({ abrir: 'DIRECCION', modalidad: 'entrega a domicilio', pago: 'efectivo' });
  assert.equal(borradorCarrito(abrir).etapa, 'DIRECCION');
  assert.equal(borradorCarrito({ ...abrir, pago: '' }).etapa, 'CARRITO');
  assert.equal(borradorCarrito({ ...abrir, modalidad: 'recoger en tienda' }).etapa, 'CARRITO');
  const b = borradorCarrito(abrir);
  const fin = cambiarCarrito(abrir, b, { action: 'data_exchange', screen: 'DIRECCION', data: { revision: '0', operacion: 'direccion',
    zona: 'z0', calle: 'Edificio 3', colonia: '', referencias: '' } });
  assert.equal(fin.borrador.etapa, 'FINAL'); assert.equal(fin.borrador.modalidad, 'm1'); assert.equal(fin.borrador.pago, 'p0');
});

// ── Ejecutor: la dirección del formulario ────────────────────────────────
const conCafe = () => {
  const estado = estadoNuevo({ negocioId: 'n', conversacionId: 'c' });
  estado.carrito.items = [{ lid: 'l1', id: '1', nombre: 'Café americano', cantidad: 1, modificadores: [] }];
  estado.carrito.datos = { modalidad: 'recoger en tienda', forma_pago: 'efectivo', cliente: { referencias: 'vieja' } };
  return estado;
};
const ctx = (estado) => ({ estado, reglas, modalidades, catalogo: [] });
const aplicarEntrega = async (estado, argumentos) => aplicarComandosInternos([{ herramienta: 'definir_entrega', argumentos }], ctx(estado));
await t('ejecutor: zona elegida cobra su tarifa y guarda las partes', async () => {
  const estado = conCafe();
  const r = await aplicarEntrega(estado, { modalidad: 'entrega a domicilio', direccion: 'Edificio 3, UTNC', referencias: 'Caseta norte',
    zona_entrega: 'UTNC', direccion_partes: { calle: 'Edificio 3', colonia: '', zona: 'UTNC' } });
  assert.equal(r.ok, true);
  assert.equal(estado.carrito.datos.costo_envio, 150);
  assert.equal(estado.carrito.datos.cliente.direccion, 'Edificio 3, UTNC');
  assert.equal(estado.carrito.datos.cliente.referencias, 'Caseta norte');
  assert.deepEqual(estado.carrito.datos.cliente.direccion_partes, { calle: 'Edificio 3', colonia: '', zona: 'UTNC' });
});
await t('ejecutor: «En la ciudad» cobra la base aunque el texto nombre una zona; referencias vacías se borran', async () => {
  const estado = conCafe();
  const r = await aplicarEntrega(estado, { modalidad: 'entrega a domicilio', direccion: 'Calle Cervecera 210, Centro', referencias: '',
    zona_entrega: '', direccion_partes: { calle: 'Calle Cervecera 210', colonia: 'Centro', zona: '' } });
  assert.equal(r.ok, true);
  assert.equal(estado.carrito.datos.costo_envio, 60);
  assert.equal(estado.carrito.datos.cliente.referencias, undefined);
});
await t('ejecutor: sin la capacidad del formulario, la dirección sigue necesitando respaldo y las partes se rechazan', async () => {
  const estado = conCafe();
  const ej = crearEjecutor({ estado, reglas, modalidades, mensaje: 'a domicilio' });
  const r1 = await ej.ejecutar('definir_entrega', { modalidad: 'entrega a domicilio', direccion: 'Edificio 3, UTNC', zona_entrega: 'UTNC' });
  assert.equal(r1.aplicado, false); assert.equal(r1.codigo, 'direccion_sin_respaldo');
  const r2 = await ej.ejecutar('definir_entrega', { direccion: 'a domicilio', direccion_partes: { calle: 'x' } });
  assert.equal(r2.aplicado, false);
  const r3 = await ej.ejecutar('definir_entrega', { modalidad: 'entrega a domicilio', zona_entrega: '' });
  assert.equal(estado.carrito.datos.costo_envio ?? 60, 60, 'la cadena vacía no es «en la ciudad» para el modelo');
  assert.notEqual(r3.estado, 'ilegal');
});

// ── Foto: sin las claves nuevas, idéntica a la de hoy ────────────────────
const cfgBase = { whatsapp_flows_v1: 'true', whatsapp_atencion_general_v1: 'true', whatsapp_inicio_mapo_v1: 'true',
  bot_whatsapp_solo_prueba: 'false', whatsapp_flow_categorias_id: '66666666666', whatsapp_flow_carrito_id: '77777777777',
  whatsapp_carrito_unificado_v1: 'true' };
const catalogo = [{ id: 'c1', nombre: 'Bebidas', orden: 0, productos: [{ id: 1, nombre: 'Café americano', precio: 45, disponible: true, grupos: [] }] }];
const estadoCarrito = (pendiente) => {
  const e = conCafe(); e.carrito.datos.modalidad = 'entrega a domicilio'; e.pendiente = pendiente; return e;
};
// El transporte de Flows exige estas variables. Se ponen solo durante los casos
// que lo usan y se restauran una por una: este chequeo corre dentro de
// predeploy-check-incidentes y no debe dejarle un entorno falso a lo que sigue.
// (Otros chequeos del predeploy hacen lo mismo y, con await de nivel superior,
// pueden correr intercalados: por eso la prueba de la restauración usa un
// entorno propio y no lee process.env.)
const ENTORNO_FLOWS = { WHATSAPP_FLOW_ENDPOINT: 'true', WHATSAPP_FLOW_PRIVATE_KEY: 'x', META_APP_SECRET: 'x' };
const conEntornoFlows = async (fn, entorno = process.env) => {
  const previo = Object.fromEntries(Object.keys(ENTORNO_FLOWS).map((k) => [k, entorno[k]]));
  Object.assign(entorno, ENTORNO_FLOWS);
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete entorno[k]; else entorno[k] = v; }
  }
};
await conEntornoFlows(() => t('foto: sin claves nuevas no hay contrato; con la de categorías, el carrito no lo hereda', () => {
  const base = { catalogo, modalidades, metodosPago: [{ tipo: 'efectivo', disponible_para_bot: true, habilitado: true }], reglas };
  const sin = fotoFormulario({ ...base, estado: estadoCarrito({ tipo: 'agregar_otro' }), cfg: cfgBase }, 'flow_productos');
  for (const k of ['contrato', 'zonas', 'costo_envio', 'direccion_inicial', 'abrir']) assert(!(k in sin), k);
  assert.equal(sin.flowId, '66666666666');
  const conCat = { ...cfgBase, whatsapp_flow_categorias_dir_id: '88888888888' };
  const cat = fotoFormulario({ ...base, estado: estadoCarrito({ tipo: 'agregar_otro' }), cfg: conCat }, 'flow_productos');
  assert.equal(cat.contrato, CONTRATO_DIRECCION); assert.equal(cat.flowId, '88888888888'); assert.deepEqual(cat.zonas, ZONAS);
  const carrito = fotoFormulario({ ...base, estado: estadoCarrito({ tipo: 'editar_pedido' }), cfg: conCat }, 'flow_configurar');
  for (const k of ['contrato', 'zonas', 'costo_envio', 'direccion_inicial', 'abrir']) assert(!(k in carrito), `carrito ${k}`);
  assert.equal(carrito.flowId, '77777777777');
  const conCarrito = { ...conCat, whatsapp_flow_carrito_dir_id: '99999999999' };
  const dir = fotoFormulario({ ...base, estado: estadoCarrito({ tipo: 'direccion' }), cfg: conCarrito }, 'flow_configurar');
  assert.equal(dir.contrato, CONTRATO_DIRECCION); assert.equal(dir.flowId, '99999999999'); assert.equal(dir.abrir, 'DIRECCION');
  const editar = fotoFormulario({ ...base, estado: estadoCarrito({ tipo: 'editar_pedido' }), cfg: conCarrito }, 'flow_configurar');
  assert.equal(editar.abrir, undefined, 'solo la pregunta de dirección abre en la dirección');
  // La foto guardada con «abrir» sigue vigente aunque la pregunta pendiente ya cambió al enviarla.
  assert.equal(formularioVigente({ accion: 'flow_configurar', datos: dir },
    { ...base, estado: estadoCarrito({ tipo: 'editar_pedido' }), cfg: conCarrito }), true);
}));

await t('huella del resumen: la de producción; las referencias (que el resumen no muestra) no la cambian', () => {
  // El modelo ya guarda referencias en producción: si entraran a la huella, cada
  // resumen abierto al desplegar dejaría de confirmarse.
  const base = { items: [], modalidad: 'entrega a domicilio', pago: 'efectivo', cliente: { direccion: 'Hidalgo 405' } };
  const sin = huellaDelResumen(base);
  assert.equal(huellaDelResumen({ ...base, cliente: { ...base.cliente, referencias: 'Portón negro' } }), sin);
});

// ── Revisión adversarial de la fase 1a ───────────────────────────────────
const txCon = (contenido) => ({ query: async () => ({ rows: [{ contenido }] }) });
const final = (foto, b) => resolverFinalFlow(txCon(b), { id: 'q', datos: foto }, { flow_token: 'tk', revision: String(b.revision) });
const dCervecera = { operacion: 'direccion', zona: 'zn', calle: 'Calle Cervecera 210', colonia: 'Centro', referencias: '' };
await t('aviso, Atrás y recoger: el recibo final se acepta sin dirección (categorías)', async () => {
  const foto = fotoCategorias();
  const b = paso(foto, enEntrega(), 'ENTREGA', { operacion: 'revisar', modalidad: 'm1', pago: 'p0' }).borrador;
  const aviso = paso(foto, b, 'DIRECCION', dCervecera).borrador;
  assert(aviso.direccion && aviso.aviso_direccion);
  const atras = cambiarCategorias(foto, aviso, { action: 'BACK', screen: 'DIRECCION' }).borrador;
  assert.equal(atras.direccion.calle, 'Calle Cervecera 210', 'Atrás conserva lo escrito');
  const fin = paso(foto, atras, 'ENTREGA', { operacion: 'revisar', modalidad: 'm0', pago: 'p0' }).borrador;
  assert.equal(fin.etapa, 'FINAL'); assert.equal(fin.direccion, undefined); assert.equal(fin.aviso_direccion, undefined);
  const recibo = await final(foto, fin);
  assert.equal(recibo.direccion, undefined); assert(comandosFormulario(foto, recibo), 'recibo aceptado');
});
await t('aviso, Atrás y recoger o vaciar: el recibo final se acepta sin dirección (carrito)', async () => {
  const foto = fotoCarrito();
  const g = cambiarCarrito(foto, borradorCarrito(foto), { action: 'data_exchange', screen: 'CARRITO',
    data: { revision: '0', operacion: 'guardar', modalidad: 'm1', pago: 'p0' } }).borrador;
  const av = cambiarCarrito(foto, g, { action: 'data_exchange', screen: 'DIRECCION', data: { revision: String(g.revision), ...dCervecera } }).borrador;
  assert(av.aviso_direccion);
  const at = cambiarCarrito(foto, av, { action: 'BACK', screen: 'DIRECCION' }).borrador;
  for (const data of [{ modalidad: 'm0', pago: 'p0' }, { modalidad: 'm1', pago: 'p0', q0: '0' }]) {
    const fin = cambiarCarrito(foto, at, { action: 'data_exchange', screen: 'CARRITO',
      data: { revision: String(at.revision), operacion: 'guardar', ...data } }).borrador;
    assert.equal(fin.etapa, 'FINAL'); assert.equal(fin.direccion, undefined);
    assert(comandosCarrito(foto, await final(foto, fin)), `recibo aceptado: ${JSON.stringify(data)}`);
  }
});
await t('recibo final: la dirección solo viaja con domicilio y platillos', async () => {
  const foto = fotoCategorias();
  const dir = { calle: 'Hidalgo 405', colonia: 'Centro', referencias: '', zona: 'zn' };
  const b = { revision: 7, etapa: 'FINAL', items: [{ producto0: 'p0', cantidad: '1' }], modalidad: 'm0', pago: 'p0', direccion: dir };
  assert.equal((await final(foto, b)).direccion, undefined, 'recoger');
  assert.deepEqual((await final(foto, { ...b, modalidad: 'm1' })).direccion, dir, 'domicilio');
  const carrito = fotoCarrito();
  assert.equal((await final(carrito, { ...b, items: undefined, filas: [], modalidad: 'm1' })).direccion, undefined, 'carrito vacío');
});
await t('aviso pendiente: la pantalla lo vuelve a decir (reintento idéntico o regreso)', () => {
  const foto = fotoCategorias();
  const b = paso(foto, enEntrega(), 'ENTREGA', { operacion: 'revisar', modalidad: 'm1', pago: 'p0' }).borrador;
  const aviso = paso(foto, b, 'DIRECCION', dCervecera).borrador;
  const r = respuestaCategorias(foto, aviso, 'tk');
  assert.match(r.data.error, /menciona Cervecera/); assert.equal(r.data.error_visible, true);
  assert.match(respuestaCarrito(fotoCarrito(), { ...aviso, filas: [] }, 'tk').data.error, /menciona Cervecera/);
  assert.equal(respuestaCategorias(foto, b, 'tk').data.error, '', 'sin aviso, sin error');
});
await t('retomado con el borrador en la dirección: abre en Entrega o en el carrito; «Escribir dirección» sí abre ahí', () => {
  const foto = fotoCategorias();
  const enDir = paso(foto, enEntrega(), 'ENTREGA', { operacion: 'revisar', modalidad: 'm1', pago: 'p0' }).borrador;
  const ini = cambiarCategorias(foto, enDir, { action: 'INIT' }).borrador;
  assert.equal(ini.etapa, 'ENTREGA'); assert.equal(ini.revision, enDir.revision + 1);
  const carrito = fotoCarrito();
  const g = cambiarCarrito(carrito, borradorCarrito(carrito), { action: 'data_exchange', screen: 'CARRITO',
    data: { revision: '0', operacion: 'guardar', modalidad: 'm1', pago: 'p0' } }).borrador;
  assert.equal(cambiarCarrito(carrito, g, { action: 'INIT' }).borrador.etapa, 'CARRITO');
  const abrir = fotoCarrito({ abrir: 'DIRECCION', modalidad: 'entrega a domicilio', pago: 'efectivo' });
  assert.equal(cambiarCarrito(abrir, borradorCarrito(abrir), { action: 'INIT' }).borrador.etapa, 'DIRECCION');
});
await t('ejecutor: la zona elegida en el formulario sigue mandando con un definir_entrega que solo trae la modalidad', async () => {
  const ciudad = conCafe();
  await aplicarEntrega(ciudad, { modalidad: 'entrega a domicilio', direccion: 'Calle Cervecera 210, Centro', referencias: '',
    zona_entrega: '', direccion_partes: { calle: 'Calle Cervecera 210', colonia: 'Centro', zona: '' } });
  await crearEjecutor({ estado: ciudad, reglas, modalidades, mensaje: 'a domicilio' }).ejecutar('definir_entrega', { modalidad: 'entrega a domicilio' });
  assert.equal(ciudad.carrito.datos.costo_envio, 60, '«En la ciudad» sigue en la base');
  const utnc = conCafe();
  await aplicarEntrega(utnc, { modalidad: 'entrega a domicilio', direccion: 'Edificio 3 frente a la Cartonera, UTNC', referencias: '',
    zona_entrega: 'UTNC', direccion_partes: { calle: 'Edificio 3 frente a la Cartonera', colonia: '', zona: 'UTNC' } });
  assert.equal(utnc.carrito.datos.costo_envio, 150);
  const r = await crearEjecutor({ estado: utnc, reglas, modalidades, mensaje: 'a domicilio' })
    .ejecutar('definir_entrega', { modalidad: 'entrega a domicilio' });
  assert.notEqual(r.codigo, 'zona_ambigua'); assert.equal(utnc.carrito.datos.costo_envio, 150);
  // Si la dirección ya no es la del formulario, se deduce del texto como hoy.
  utnc.carrito.datos.cliente.direccion = 'Hidalgo 405, Cartonera';
  await crearEjecutor({ estado: utnc, reglas, modalidades, mensaje: 'a domicilio' }).ejecutar('definir_entrega', { modalidad: 'entrega a domicilio' });
  assert.equal(utnc.carrito.datos.costo_envio, 120);
});
await t('ejecutor: el camino del modelo conserva su regla de zonas (zona sin costo)', async () => {
  const e = conCafe(); e.carrito.datos.modalidad = 'entrega a domicilio';
  const r = await crearEjecutor({ estado: e, reglas, modalidades, mensaje: 'Sin costo' }).ejecutar('definir_entrega', { zona_entrega: 'Sin costo' });
  assert.equal(r.codigo, 'zona_sin_respaldo');
});
await conEntornoFlows(() => t('pregunta de dirección: solo cambia a formulario si este captura la dirección', () => {
  const base = { catalogo, modalidades, metodosPago: [{ tipo: 'efectivo', disponible_para_bot: true, habilitado: true }], reglas };
  const conCarrito = { ...cfgBase, whatsapp_flow_carrito_dir_id: '99999999999' };
  const texto = '¿Cuál es la dirección completa para la entrega?';
  const armar = (cfg, sinPago = false) => {
    const estado = estadoCarrito({ tipo: 'direccion' });
    if (sinPago) delete estado.carrito.datos.forma_pago;
    estado.dialogo = { ciclo: estado.conversacionId, texto, id: 'd1' };
    return construirFormulario({ estado, pedido: { huella: 'h', total: 45 }, texto, cfg, telefono: 'tel-prueba', ...base });
  };
  const con = armar(conCarrito);
  assert.equal(con.botones[0].datos.abrir, 'DIRECCION'); assert.equal(con.carga.action.parameters.flow_cta, 'Escribir dirección');
  assert.equal(armar({ ...conCarrito, whatsapp_carrito_unificado_v1: 'false', whatsapp_flow_configurar_id: '55555555555' }), null,
    'sin carrito unificado, la pregunta sigue en texto');
  assert.equal(armar({ ...cfgBase, whatsapp_flow_configurar_id: '55555555555' }), null, 'sin la clave, como hoy');
  // Domicilio sin pago todavía: no puede abrir en la dirección; dice qué hacer.
  const sinPago = armar(conCarrito, true);
  assert.equal(sinPago.botones[0].datos.abrir, undefined);
  assert.match(sinPago.texto, /^\*Dirección de entrega\*\nEn el formulario elige la forma de pago/);
  assert.doesNotMatch(sinPago.texto, /Si es a domicilio/);
}));
await t('el entorno de Flows se restaura después de cada caso', async () => {
  // Lo que había (un valor real, como en Railway) vuelve; lo que no había, se quita.
  const entorno = { WHATSAPP_FLOW_ENDPOINT: 'real', OTRA: 'intacta' };
  let dentro = null;
  await conEntornoFlows(() => { dentro = { ...entorno }; }, entorno);
  assert.equal(dentro.META_APP_SECRET, 'x');
  assert.deepEqual(entorno, { WHATSAPP_FLOW_ENDPOINT: 'real', OTRA: 'intacta' });
  await assert.rejects(conEntornoFlows(() => { throw Error('falla'); }, entorno));
  assert.deepEqual(entorno, { WHATSAPP_FLOW_ENDPOINT: 'real', OTRA: 'intacta' }, 'también si el caso falla');
  process.env.XABOR_PRUEBA_ENTORNO = true;
  assert.equal(typeof process.env.XABOR_PRUEBA_ENTORNO, 'string', 'process.env sigue siendo el del proceso');
  delete process.env.XABOR_PRUEBA_ENTORNO;
});
await t('zona corregida por chat después del formulario: deja de mandar la del formulario', async () => {
  const e = conCafe();
  await aplicarEntrega(e, { modalidad: 'entrega a domicilio', direccion: 'Calle Cervecera 210, Centro', referencias: '',
    zona_entrega: '', direccion_partes: { calle: 'Calle Cervecera 210', colonia: 'Centro', zona: '' } });
  assert.equal(e.carrito.datos.costo_envio, 60);
  await crearEjecutor({ estado: e, reglas, modalidades, mensaje: 'perdón, sí es en la Cervecera' })
    .ejecutar('definir_entrega', { zona_entrega: 'Cervecera' });
  assert.equal(e.carrito.datos.costo_envio, 150);
  assert.equal(e.carrito.datos.cliente.direccion_partes, undefined, 'las partes del formulario ya no mandan');
  await crearEjecutor({ estado: e, reglas, modalidades, mensaje: 'a domicilio' }).ejecutar('definir_entrega', { modalidad: 'entrega a domicilio' });
  assert.equal(e.carrito.datos.costo_envio, 150, 'la modalidad sola deduce del texto, como siempre');
});
await t('aviso pendiente con una revisión vieja: se muestra junto al otro error, sin repetirse', () => {
  const foto = fotoCategorias();
  const b = paso(foto, enEntrega(), 'ENTREGA', { operacion: 'revisar', modalidad: 'm1', pago: 'p0' }).borrador;
  const aviso = paso(foto, b, 'DIRECCION', dCervecera);
  const primera = respuestaCategorias(foto, aviso.borrador, 'tk', aviso.error, { revision: String(b.revision), ...dCervecera });
  assert.equal(primera.data.error.match(/menciona Cervecera/g).length, 1, 'el aviso una sola vez');
  const vieja = paso(foto, aviso.borrador, 'DIRECCION', { ...dCervecera, referencias: 'Portón', revision: String(b.revision) });
  assert(vieja.error);
  const r = respuestaCategorias(foto, vieja.borrador, 'tk', vieja.error, { revision: String(b.revision), ...dCervecera, referencias: 'Portón' });
  assert.match(r.data.error, /La ventana cambió/); assert.match(r.data.error, /menciona Cervecera/);
  // Un intento nuevo con otro error muestra lo que escribió y solo su error.
  const otro = paso(foto, aviso.borrador, 'DIRECCION', { ...dCervecera, calle: 'ab' });
  assert(otro.error);
  const rn = respuestaCategorias(foto, otro.borrador, 'tk', otro.error,
    { revision: String(aviso.borrador.revision), ...dCervecera, calle: 'ab' });
  assert.doesNotMatch(rn.data.error, /menciona/); assert.equal(rn.data.calle_inicial, 'ab');
});
await t('saneado idempotente: limpiar dos veces da lo mismo y un aviso confirmado se acepta en el recibo', () => {
  const raros = ['­', '͏', '️', 'ㅤ', '​', '́', '̈', '̃', 'e', 'n', ' ', 'U', '‮', '⠀', '#'];
  let semilla = 7;
  const azar = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla; };
  for (let i = 0; i < 3000; i++) {
    const s = Array.from({ length: 1 + (azar() % 12) }, () => raros[azar() % raros.length]).join('');
    const una = limpiarCampo(s, 120);
    assert.equal(limpiarCampo(una, 120), una, JSON.stringify(s));
  }
  const d = { calle: 'Calle Cervecera 210 Jose­́', colonia: 'Centro', referencias: '', zona: 'zn' };
  const aviso = validarDireccion(fotoDir(), d);
  const ok = validarDireccion(fotoDir(), d, { confirmada: aviso.aviso });
  assert.equal(ok.ok, true);
  // El recibo vuelve a limpiar lo guardado: tiene que dar la misma firma.
  const { calle, colonia, referencias, zona, confirmada } = ok.partes;
  assert.notEqual(argumentosDeEntrega(fotoDir(), 'entrega a domicilio', { calle, colonia, referencias, zona, confirmada }), null,
    'el recibo se acepta');
});
await t('retomar y vigencia: la precarga de la dirección no cuenta', async () => {
  const foto = { ...fotoCarrito(), flowId: '99999999999' };
  const conRef = { ...foto, direccion_inicial: { ...foto.direccion_inicial, referencias: 'Portón negro' } };
  assert.deepEqual(fotoComparable(conRef), fotoComparable(foto));
  assert.deepEqual(fotoComparable({ ...foto, abrir: 'DIRECCION' }), fotoComparable(foto));
  assert.notDeepEqual(fotoComparable({ ...foto, zonas: [] }), fotoComparable(foto), 'las zonas sí cuentan');
  const db = { query: async () => ({ rows: [{ datos: foto, contenido: { etapa: 'CARRITO', revision: 3 } }] }) };
  const preparado = { botones: [{ accion: 'flow_configurar', datos: conRef }], ciclo: 'c', preguntaId: 'q2', huella: 'h' };
  assert(await borradorCompatible(db, { preparado, negocioId: 'n', sessionId: 's' }), 'el borrador se retoma');
});
await t('endpoint: un formulario sin dirección abierto antes de activar el contrato se corta', () => {
  const conCat = { ...cfgBase, whatsapp_flow_categorias_dir_id: '88888888888' };
  const conCarrito = { ...cfgBase, whatsapp_flow_carrito_dir_id: '99999999999' };
  assert.equal(sinDireccionVieja(cfgBase, { version: 'carrito_v1' }), false, 'sin claves, como hoy');
  assert.equal(sinDireccionVieja(cfgBase, { version: 'repetible_v1', presentacion: 'categorias_v1' }), false);
  assert.equal(sinDireccionVieja(conCarrito, { version: 'carrito_v1' }), true);
  assert.equal(sinDireccionVieja(conCarrito, { version: 'carrito_v1', contrato: CONTRATO_DIRECCION }), false);
  assert.equal(sinDireccionVieja(conCat, { version: 'repetible_v1', presentacion: 'categorias_v1' }), true);
  assert.equal(sinDireccionVieja(conCat, { version: 'repetible_v1' }), false, 'el repetible sin categorías no tiene contrato');
});
await t('activación: un flowId por formulario nuevo y reversa aunque se haya borrado a mano', () => {
  const cfg = { whatsapp_flow_categorias_id: '11111', whatsapp_flow_carrito_id: '22222' };
  assert.match(planActivacion(cfg, '33333', '33333').error, /mismo flowId/);
  assert.match(planActivacion(cfg, '22222', '44444').error, /de siempre/);
  assert.match(planActivacion({ whatsapp_flow_carrito_id: '22222' }, '33333', '44444').error, /claves base/);
  const p = planActivacion(cfg, '33333', '44444');
  assert.deepEqual(p.flows, [['33333', 'categorias'], ['44444', 'carrito']]);
  const activa = { ...cfg, ...p.cambios, [CLAVE_RESPALDO_DIRECCION]: JSON.stringify(p.respaldo) };
  assert.match(planActivacion(activa, '55555', '66666').error, /Ya existe respaldo/);
  assert.equal(planActivacion(activa, '33333', '44444').respaldo, null, 'reactivar lo mismo no pisa el respaldo');
  assert.deepEqual(planReversa(activa).aplicar, { whatsapp_flow_categorias_dir_id: null, whatsapp_flow_carrito_dir_id: null });
  const aMano = { ...cfg, [CLAVE_RESPALDO_DIRECCION]: JSON.stringify(p.respaldo) };
  assert.deepEqual(planReversa(aMano).aplicar, {}, 'ya quitadas a mano: solo se borra el respaldo');
  assert.deepEqual(planReversa({ ...aMano, whatsapp_flow_carrito_dir_id: '44444' }).aplicar, { whatsapp_flow_carrito_dir_id: null });
  assert.match(planReversa({ ...activa, whatsapp_flow_carrito_dir_id: '77777' }).error, /cambió/);
  assert.match(planReversa(cfg).error, /Sin respaldo/);
  // Claves puestas a mano sin respaldo: revertir no las apagaría.
  assert.match(planActivacion({ ...cfg, whatsapp_flow_carrito_dir_id: '44444' }, '33333', '44444').error, /a mano/);
});

console.log(`dirección en el formulario: ${pasadas} OK, ${fallidas} fallos`);
assert.equal(fallidas, 0);
