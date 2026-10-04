// Formulario «tienda» (contrato tienda_v1): chequeo estático de la definición
// y de la maqueta contra los límites de Meta. Puro: sin base de datos, Meta ni
// pedidos. Termina con exit ≠ 0 si algo falla.
//
//   node scripts/check-flow-tienda.mjs [carta.json [carpeta-fotos [indice.json]]]
//   (o CARTA_TIENDA, FOTOS_TIENDA e INDICE_FOTOS_TIENDA)
//
// Con la carta (la de Obispado, carta-obispado.json) además revisa las
// maquetas con la carta real y exige que el INIT equivalente (la respuesta del
// servidor) quepa en 600 KB de JSON; con la carpeta de fotos, también las
// maquetas con las fotos reales pasadas por la receta del servidor. Toda
// maqueta cabe en el tope de maqueta (1.5 MB: Meta validó una de 1.40 MB).
// Sin carta usa una carta sintética de estrés con la forma de Obispado.
//
// Cada garantía tiene su MORDIDA: un caso que construye un Flow con el defecto
// y exige que el validador lo rechace. Si alguien apaga una barrera de
// validarFlowTienda, su mordida falla y este chequeo también.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { definicionFlowTienda, validarFlowTienda, armarTienda, datosRanuras, datosPlatillo, huellaFlow, nombreFlowTienda, huellaEstable,
  bytesJson, dentroDelPresupuesto, cabeComoMaqueta, recortar, bloque, precioCorto, precioCentavos, erroresDeEsquema, noConforma,
  LIMITES_TIENDA, RANURAS, MAX_RADIO, CARRITO_SERVIDOR, TIPOS_ESQUEMA, NOMBRE_UPDATE_DATA, GRUPOS_CHILAQUILES_SENCILLOS } from './definicion-flow-tienda.mjs';
import { definicionFlowCategorias } from './definicion-flow-categorias.mjs';
import { pantallaDireccion } from './definicion-pantalla-direccion.mjs';
import { construirMaqueta, imagenesSolidas, imagenesRuido, initEquivalente, normalizarCarta, fotosDeCarpeta, hacerInteractiva,
  leerOpciones, VARIANTE_DE } from './maqueta-flow-tienda.mjs';
import { leerMaqueta, nombreMaqueta } from './subir-maqueta-flow-tienda.mjs';
import { VARIANTES } from '../src/services/miniaturasMenu.js';
import { OPERACIONES_TIENDA } from '../src/mesero-agente/flowTienda.js';
import { POR_OMISION_TIENDA, VERSION_TIENDA, BANDERA_TIENDA, FLOW_TIENDA_ID, TELEFONOS_TIENDA } from '../src/mesero-agente/contratoTienda.js';

let pasadas = 0, fallidas = 0, mordidas = 0;
const t = async (nombre, fn) => { try { await fn(); pasadas++; } catch (e) { fallidas++; console.error(`${nombre}: ${e.message}`); } };
const pantalla = (f, id) => f.screens.find((s) => s.id === id);
const formDe = (f, id) => pantalla(f, id).layout.children[0];
const componente = (f, id, nombre) => formDe(f, id).children.find((c) => c.name === nombre);
const PRESUPUESTO = LIMITES_TIENDA.presupuestoJson;
const principal = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const arg = (i) => (principal ? process.argv[i] : undefined);
const rutaCarta = process.env.CARTA_TIENDA || arg(2);
const rutaFotos = process.env.FOTOS_TIENDA || arg(3);
const rutaIndice = process.env.INDICE_FOTOS_TIENDA || arg(4);
const temporal = mkdtempSync(join(tmpdir(), 'check-flow-tienda-'));

// ── Cartas ───────────────────────────────────────────────────────────────
const opcionesDe = (n, nombre, precio = 0) => Array.from({ length: n }, (_, i) => ({ nombre: nombre(i), precio: typeof precio === 'function' ? precio(i) : precio }));
// Seis grupos que tocan cada variante: Radio (≤ 8), Dropdown (9), Checkbox 1–2,
// Checkbox de 20 con nombres largos y precio con centavos, Radio opcional y uno más.
const GRUPOS_ESTRES = [
  { nombre: 'Salsa', minimo: 1, maximo: 1, opciones: opcionesDe(5, (i) => `Salsa ${i}`) },
  { nombre: 'Proteína a elegir para tu platillo', minimo: 1, maximo: 1, opciones: opcionesDe(9, (i) => `Proteína ${i}`, (i) => (i > 5 ? 30 : 0)) },
  { nombre: 'Guarniciones', minimo: 1, maximo: 2, opciones: opcionesDe(8, (i) => `Guarnición ${i}`) },
  { nombre: 'Extras', minimo: 0, maximo: 20, opciones: opcionesDe(20, (i) => `Extra número ${i} con un nombre que no cabe`, 15.5) },
  { nombre: 'Bebida', minimo: 0, maximo: 1, opciones: opcionesDe(2, (i) => `Bebida ${i}`) },
  { nombre: 'Postre', minimo: 1, maximo: 1, opciones: opcionesDe(3, (i) => `Postre ${i}`) },
];
// Forma de Obispado (3-oct): mismas categorías y platillos por categoría,
// todo con foto, nombres de 40, descripciones de 120, precios de 5 cifras.
const FORMA_OBISPADO = [6, 3, 3, 4, 4, 5, 12, 3, 1, 12, 3, 20];
const cartaEstres = () => FORMA_OBISPADO.map((n, ci) => ({ nombre: ci === 9 ? 'TACOS' : `Categoría ${ci} con un nombre largo para cortar`,
  platillos: Array.from({ length: n }, (_, i) => ({ nombre: `Platillo ${ci}.${i} con un nombre de cuarenta`.padEnd(40, '·'),
    precio: 9999.5 + i, descripcion: `Descripción ${ci}.${i}. `.padEnd(120, 'x'), foto: true, grupos: ci === 1 && i === 0 ? GRUPOS_ESTRES : [] })) }));

const solidas = await imagenesSolidas(20), ruido = await imagenesRuido();
const estres = normalizarCarta(cartaEstres());
const def = definicionFlowTienda();
const defA = definicionFlowTienda({ carrito: 'A', maqueta: true });
const maqEstres = { A: construirMaqueta(estres, { carrito: 'A', imagen: solidas }), B: construirMaqueta(estres, { carrito: 'B', imagen: solidas }) };
const esquemasDe = (f) => f.screens.flatMap((s) => Object.entries(s.data || {}).map(([k, e]) => [`${s.id}.data.${k}`, e]));
// Rutas de los nodos de esquema que llevan `const` (con la notación de erroresDeEsquema).
const constsDe = (f) => {
  const rutas = [];
  const juntar = (e, r) => {
    if (!e || typeof e !== 'object') return;
    if ('const' in e) rutas.push(r);
    for (const [k, x] of Object.entries(e.properties || {})) juntar(x, `${r}.${k}`);
    if (e.items) juntar(e.items, `${r}[]`);
  };
  for (const [ruta, e] of esquemasDe(f)) juntar(e, ruta);
  return rutas;
};
const CANTIDADES_TACOS = Array.from({ length: 12 }, (_, i) => `TACOS.data.t${i}_cantidades[].on-select-action.name`);

// ── Definición ───────────────────────────────────────────────────────────
await t('definición: el carrito del servidor es B; A solo existe con maqueta:true; las dos cumplen todos los límites', () => {
  assert.equal(CARRITO_SERVIDOR, 'B');
  for (const f of [def, defA]) { assert.equal(f.version, '7.3'); assert.equal(f.data_api_version, '3.0'); assert.deepEqual(validarFlowTienda(f), []); }
  assert.throws(() => definicionFlowTienda({ carrito: 'A' }), /solo existe en la maqueta/);
  assert.throws(() => definicionFlowTienda({ carrito: 'AB', maqueta: true }), /A o B/);
  assert.equal(huellaFlow(definicionFlowTienda({ carrito: 'B', maqueta: true })), huellaFlow(def), 'maqueta:true no cambia la definición B');
});
await t('rutas: las de la propuesta más la barra de CATEGORIA y «personalizar» de TACOS; sin ciclos', () => {
  assert.deepEqual(def.routing_model, { MENU: ['CATEGORIA', 'CARRITO'], CATEGORIA: ['PERSONALIZAR', 'TACOS', 'CARRITO'],
    PERSONALIZAR: [], TACOS: ['PERSONALIZAR'], CARRITO: ['EDITAR', 'ENTREGA'], EDITAR: [], ENTREGA: ['DIRECCION'], DIRECCION: [] });
  assert.deepEqual(defA.routing_model, def.routing_model);
  assert.deepEqual(def.screens.map((s) => s.id), ['MENU', 'CATEGORIA', 'PERSONALIZAR', 'TACOS', 'CARRITO', 'EDITAR', 'ENTREGA', 'DIRECCION']);
});
await t('refresh_on_back y terminales como en la tabla de pantallas', () => {
  // MENU y CATEGORIA en true desde el 4-oct: el servidor regresa a ellas (REGRESAN_POR_EL_SERVIDOR).
  const esperado = { MENU: true, CATEGORIA: true, PERSONALIZAR: false, TACOS: false, CARRITO: true, EDITAR: false, ENTREGA: true, DIRECCION: true };
  assert.deepEqual(Object.fromEntries(def.screens.map((s) => [s.id, s.refresh_on_back])), esperado);
  assert.deepEqual(def.screens.filter((s) => s.terminal).map((s) => s.id), ['ENTREGA', 'DIRECCION']);
});
await t('MENU y CATEGORIA (y el CARRITO A de la maqueta): solo dos NavigationList; explorar es navigate, ver y el carrito van al servidor', () => {
  for (const [f, id] of [[def, 'MENU'], [def, 'CATEGORIA'], [defA, 'CARRITO']]) {
    assert.deepEqual(pantalla(f, id).layout.children.map((c) => c.type), ['NavigationList', 'NavigationList'], id);
  }
  const menu = pantalla(def, 'MENU').data;
  assert(menu.categorias.__example__.every((c) => c['on-click-action'].name === 'navigate' && c['on-click-action'].next.name === 'CATEGORIA'));
  assert.deepEqual(menu.barra.__example__[0]['on-click-action'], { name: 'data_exchange', payload: { operacion: 'ver_carrito' } });
  const platillos = pantalla(def, 'CATEGORIA').data.platillos.__example__;
  assert.deepEqual(platillos.map((p) => p['on-click-action'].payload.operacion), ['ver', 'ver']);
  const tacos = menu.categorias.__example__.find((c) => c['main-content'].title === 'TACOS')['on-click-action'].payload.platillos[0];
  assert.deepEqual(tacos['on-click-action'].payload, { operacion: 'ver_tacos', categoria: 'c2' }, '«Varios tacos a la vez» primero');
});
await t('CARRITO (B, el del servidor): Footer real «Continuar · $X», «Editar o quitar» abre EDITAR por el servidor, «Seguir pidiendo» y «Deshacer» solo si hay qué', () => {
  const s = pantalla(def, 'CARRITO'), hijos = formDe(def, 'CARRITO').children;
  assert.equal(s.layout.children.length, 1); assert.equal(formDe(def, 'CARRITO').type, 'Form');
  assert.equal(JSON.stringify(s).includes('NavigationList'), false, 'B no lleva listas tocables');
  const pie = hijos.filter((c) => c.type === 'Footer');
  assert.equal(pie.length, 1); assert.equal(pie[0].label, '${data.boton}');
  assert.deepEqual(pie[0]['on-click-action'], { name: 'data_exchange', payload: { operacion: 'continuar', revision: '${data.revision}' } });
  assert.match(s.data.boton.__example__, /^Continuar · \$[\d,]+(\.\d\d)?$/);
  const editar = hijos.find((c) => c.type === 'Dropdown' && c.name === 'fila');
  assert.equal(editar.label, 'Editar o quitar'); assert.equal(editar.required, false);
  assert.deepEqual(editar['on-select-action'], { name: 'data_exchange', payload: { operacion: 'editar', fila: '${form.fila}' } });
  assert.deepEqual(def.routing_model.CARRITO, ['EDITAR', 'ENTREGA'], 'la respuesta de «editar» puede abrir EDITAR');
  const enlaces = hijos.filter((c) => c.type === 'EmbeddedLink');
  assert.deepEqual(enlaces.map((c) => [c.text, c['on-click-action'].payload.operacion, c.visible ?? true]),
    [['Seguir pidiendo', 'seguir', true], ['Deshacer último cambio', 'deshacer', '${data.puede_deshacer}']]);
  assert.equal(enlaces[1]['on-click-action'].payload.revision, '${data.revision}', 'deshacer exige revisión');
  assert.equal(s.data.puede_deshacer.type, 'boolean');
});
await t('PERSONALIZAR y EDITAR salen del mismo generador: 6 ranuras × (Radio, Dropdown, Checkbox) por bandera', () => {
  const esqueleto = (id) => formDe(def, id).children.filter((c) => !['Footer', 'EmbeddedLink'].includes(c.type)).map((c) => `${c.type}:${c.name ?? JSON.stringify(c.text ?? c.condition)}`);
  assert.deepEqual(esqueleto('EDITAR'), esqueleto('PERSONALIZAR'));
  for (const id of ['PERSONALIZAR', 'EDITAR']) for (let g = 0; g < RANURAS; g++) {
    const [r, s, m] = ['r', 's', 'm'].map((v) => componente(def, id, `g${g}_${v}`));
    assert.deepEqual([r.type, s.type, m.type], ['RadioButtonsGroup', 'Dropdown', 'CheckboxGroup']);
    assert.deepEqual([r.visible, s.visible, m.visible], [`\${data.g${g}_radio}`, `\${data.g${g}_simple}`, `\${data.g${g}_multiple}`]);
    for (const c of [r, s, m]) assert.equal(c.required, `\${data.g${g}_requerido}`, 'lo obligatorio no dice «Opcional»');
    assert.equal(s.label, `\${data.g${g}_label_corto}`, 'Dropdown: label de 20');
    assert.equal(m['max-selected-items'], `\${data.g${g}_max}`);
  }
  assert.equal(RANURAS, 6);
});
await t('ficha sin foto: con_foto=false y la Image solo existe dentro del If de con_foto (nada de imagen genérica a la vista)', () => {
  for (const id of ['PERSONALIZAR', 'EDITAR']) {
    const hijos = formDe(def, id).children;
    assert.equal(hijos.filter((c) => c.type === 'Image').length, 0, `${id}: Image fuera del If`);
    const si = hijos.filter((c) => c.type === 'If');
    assert.equal(si.length, 1); assert.equal(si[0].condition, '${data.con_foto}');
    assert.deepEqual(si[0].then.map((c) => c.type), ['Image']); assert.equal(si[0].else, undefined);
  }
  const sin = datosPlatillo({ nombre: 'Bowl', precio: 140, descripcion: '', grupos: [] });
  assert.equal(sin.con_foto, false);
  const con = datosPlatillo({ nombre: 'Bowl', precio: 140, descripcion: '', grupos: [] }, { foto: '/9j/' });
  assert.deepEqual([con.con_foto, con.foto], [true, '/9j/']);
  // El botón de la ficha: «Agregar · $X» o «Agregar · desde $X» (sin precio en vivo en v1).
  const { instancias } = armarTienda([{ nombre: 'C', platillos: [{ nombre: 'Sencillo', precio: 140, foto: false, grupos: [] },
    { nombre: 'Con extras', precio: 195, foto: false, grupos: GRUPOS_CHILAQUILES_SENCILLOS }] }], { modo: 'maqueta', imagen: () => null });
  assert.deepEqual(instancias.get('PERSONALIZAR').map((d) => [d.boton, d.con_foto]), [['Agregar · $140', false], ['Agregar · desde $195', false]]);
});
await t('ranuras: una sola variante visible por grupo; Radio hasta 8 opciones, Dropdown desde 9, Checkbox con min/max', () => {
  const d = datosRanuras(GRUPOS_CHILAQUILES_SENCILLOS, { 0: [1], 2: [0, 3] });
  const variante = (g) => ['radio', 'simple', 'multiple'].filter((v) => d[`g${g}_${v}`]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(variante), [['radio'], ['radio'], ['multiple'], [], [], []]);
  assert.equal(d.g0_inicial_r, 'o1'); assert.deepEqual(d.g2_inicial_m, ['o0', 'o3']);
  assert.deepEqual([d.g2_min, d.g2_max, d.g2_ayuda, d.g0_ayuda], [1, 2, 'Elige 1 a 2', 'Elige 1']);
  assert.equal(d.g1_opciones[4].metadata, '+$30');
  const e = datosRanuras(GRUPOS_ESTRES);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((g) => ['radio', 'simple', 'multiple'].filter((v) => e[`g${g}_${v}`])),
    [['radio'], ['simple'], ['multiple'], ['multiple'], ['radio'], ['radio']]);
  assert.equal(GRUPOS_ESTRES[1].opciones.length, MAX_RADIO + 1);
  assert.equal(e.g1_label_corto.length, 20); assert.equal(e.g1_label.length, 30);
  assert.equal(e.g3_opciones[0].metadata, '+$15.50'); assert(e.g3_opciones[0].description.length > 30, 'el nombre largo va completo en description');
  assert.deepEqual([e.g3_ayuda, e.g4_ayuda, e.g4_requerido], ['Opcional · hasta 20', 'Opcional', false]);
  assert.deepEqual([d.g3_opciones, d.g3_requerido, d.g3_ayuda], [[{ id: 'oculto', title: 'No aplica', description: '', metadata: '' }], false, 'Opcional']);
});
await t('payloads: agregar con apertura, producto y los 18 campos; aplicar y quitar con revisión y fila', () => {
  const ranuras = Array.from({ length: RANURAS }, (_, g) => ['r', 's', 'm'].map((v) => `g${g}_${v}`)).flat();
  const pie = (id) => formDe(def, id).children.find((c) => c.type === 'Footer');
  const agregar = pie('PERSONALIZAR')['on-click-action'];
  assert.equal(agregar.name, 'data_exchange'); assert.equal(pie('PERSONALIZAR').label, '${data.boton}');
  assert.deepEqual(Object.keys(agregar.payload).sort(), ['apertura', 'cantidad', 'observaciones', 'operacion', 'producto', ...ranuras].sort());
  assert.equal(agregar.payload.operacion, 'agregar'); assert.equal('revision' in agregar.payload, false, 'agregar no exige revisión');
  const aplicar = pie('EDITAR')['on-click-action'].payload;
  assert.deepEqual(Object.keys(aplicar).sort(), ['cantidad', 'fila', 'observaciones', 'operacion', 'revision', ...ranuras].sort());
  assert.equal(pie('EDITAR').label, 'Guardar cambios');
  const quitar = formDe(def, 'EDITAR').children.find((c) => c.type === 'EmbeddedLink');
  assert.equal(quitar.text, 'Quitar del pedido');
  assert.deepEqual(quitar['on-click-action'].payload, { operacion: 'quitar', revision: '${data.revision}', fila: '${data.fila}' });
  assert.equal(pantalla(def, 'CARRITO').data.boton.__example__, 'Continuar · $614');
});
await t('TACOS, ENTREGA y DIRECCION se reutilizan: TACOS solo cambia su Footer («Agregar»), quita «Guardar y ver categorías» y refresh_on_back; su data va idéntica', () => {
  const base = definicionFlowCategorias({ direccion: true, nota: true });
  const tacos = structuredClone(pantalla(def, 'TACOS')), original = structuredClone(pantalla(base, 'TACOS'));
  const hijos = (p) => p.layout.children[0].children;
  assert.equal(hijos(tacos).find((c) => c.type === 'Footer').label, 'Agregar');
  hijos(tacos).find((c) => c.type === 'Footer').label = 'ORDEN COMPLETA'; tacos.refresh_on_back = true;
  // «Guardar y ver categorías» hace lo mismo que «Agregar» (agrega y vuelve al MENU): solo en categorias_v1.
  const enlaces = (p) => hijos(p).filter((c) => c.type === 'EmbeddedLink').map((c) => c.text);
  assert.deepEqual(enlaces(tacos), ['Agregar más']);
  assert.deepEqual(enlaces(original), ['Agregar más', 'Guardar y ver categorías'], 'categorias_v1 (publicado) no se toca');
  original.layout.children[0].children = hijos(original).filter((c) => c.text !== 'Guardar y ver categorías');
  // Lo que la pantalla manda es exactamente lo que el servidor acepta en TACOS.
  const operaciones = new Set();
  JSON.stringify(pantalla(def, 'TACOS'), (k, v) => { if (k === 'operacion' && typeof v === 'string') operaciones.add(v); return v; });
  assert.deepEqual([...operaciones].sort(), [...OPERACIONES_TIENDA.TACOS].sort());
  // [M] Meta exige el name de update_data como {const:'update_data'} (validación
  // del Flow real, 3-oct): la data va sin retocar, como la publicada.
  assert.deepEqual(tacos.data, original.data, 'la data de TACOS es la de categorias_v1, sin retocar');
  const cantidades = Object.keys(tacos.data).filter((k) => /^t\d+_cantidades$/.test(k));
  assert.equal(cantidades.length, 12);
  for (const k of cantidades) assert.deepEqual(tacos.data[k].items.properties['on-select-action'].properties.name, NOMBRE_UPDATE_DATA, k);
  assert.deepEqual(tacos, original);
  assert.deepEqual(pantalla(def, 'ENTREGA'), pantalla(base, 'ENTREGA'));
  assert(JSON.stringify(pantalla(def, 'ENTREGA')).includes('"name":"nota"'), 'ENTREGA con la nota del pedido');
  assert.deepEqual(pantalla(def, 'DIRECCION'), pantallaDireccion());
});
await t('esquemas: todo nodo lleva type de los admitidos; el único const es el name de update_data de las 12 cantidades de TACOS (maquetas e interactivas, ninguno)', () => {
  for (const f of [def, defA]) {
    for (const [ruta, e] of esquemasDe(f)) assert.deepEqual(erroresDeEsquema(e, ruta), [], ruta);
    assert.deepEqual(constsDe(f), CANTIDADES_TACOS);
    assert.equal(JSON.stringify(f).match(/"const"/g).length, CANTIDADES_TACOS.length, 'ningún const fuera de esos esquemas');
  }
  for (const f of [maqEstres.A, maqEstres.B, hacerInteractiva(structuredClone(maqEstres.B))]) {
    assert.equal(JSON.stringify(f).includes('"const"'), false);
    for (const [ruta, e] of esquemasDe(f)) assert.deepEqual(erroresDeEsquema(e, ruta), [], ruta);
  }
  const nodos = [];
  const juntar = (e) => { if ('const' in e) return; nodos.push(e.type); for (const x of Object.values(e.properties || {})) juntar(x); if (e.items) juntar(e.items); };
  for (const [, e] of esquemasDe(def)) juntar(e);
  assert(nodos.length > 500 && nodos.every((x) => TIPOS_ESQUEMA.includes(x)));
  assert.equal(pantalla(def, 'MENU').data.barra.items.properties['on-click-action'].properties.name.type, 'string', 'el name de un on-click-action es string [M]');
  // La regla [M], en un esquema mínimo: {const:'update_data'} SOLO en el name de
  // on-select-action / on-unselect-action, y ahí ninguna otra forma.
  const lista = (accion, name) => ({ type: 'array', items: { type: 'object', properties: { id: { type: 'string' },
    [accion]: { type: 'object', properties: { name, payload: { type: 'object', properties: { x: { type: 'boolean' } } } } } } } });
  for (const accion of ['on-select-action', 'on-unselect-action']) {
    assert.deepEqual(erroresDeEsquema(lista(accion, { const: 'update_data' }), 'd'), [], accion);
    for (const name of [{ type: 'string' }, { type: 'string', const: 'update_data' }, { const: 'data_exchange' }, { const: 'navigate' }]) {
      assert.deepEqual(erroresDeEsquema(lista(accion, name), 'd'),
        [`d[].${accion}.name: el name de ${accion} va exactamente como {"const":"update_data"} (${JSON.stringify(name)})`], `${accion} ${JSON.stringify(name)}`);
    }
  }
  assert.deepEqual(erroresDeEsquema(lista('on-click-action', { type: 'string' }), 'd'), []);
  const constSuelto = (r) => [`${r}: esquema sin type válido (const sin type)`, `${r}: clave «const» no admitida en el esquema`];
  for (const c of ['navigate', 'data_exchange', 'update_data']) {
    assert.deepEqual(erroresDeEsquema(lista('on-click-action', { const: c }), 'd'), constSuelto('d[].on-click-action.name'), c);
  }
  assert.deepEqual(erroresDeEsquema({ type: 'object', properties: { name: { const: 'update_data' } } }, 'd'), constSuelto('d.name'),
    'un name suelto no es el de una acción de selección');
  assert.equal(noConforma({ a: [1, 2] }, { type: 'object', properties: { a: { type: 'array', items: { type: 'number' } } } }), null);
  assert.match(noConforma({ a: ['1'] }, { type: 'object', properties: { a: { type: 'array', items: { type: 'number' } } } }), /a\[0\]: string donde va number/);
  const accionUpdate = { type: 'object', properties: { name: NOMBRE_UPDATE_DATA } };
  assert.equal(noConforma({ name: 'update_data' }, accionUpdate), null);
  assert.equal(noConforma({ name: 'data_exchange' }, accionUpdate, 'a'), 'a.name: "data_exchange" donde va la constante "update_data"');
});
await t('textos: se cortan con «…» sin pasar el límite ni partir un emoji; precios', () => {
  assert.equal(recortar('Taco de Chicharrón Cuerito en Salsa', 30), 'Taco de Chicharrón Cuerito en…');
  assert.equal(recortar('Taco de Chicharrón Cuerito en Salsa', 30).length, 30);
  assert.equal(recortar('  Hotcakes \n de   avena ', 30), 'Hotcakes de avena');
  assert.equal(recortar('Ab😀😀😀', 5), 'Ab😀…'); assert.equal(recortar('Abc😀😀', 5), 'Abc…', 'no parte el par sustituto');
  for (const n of [1, 10, 29, 30, 31, 80]) assert(recortar('ñ'.repeat(100), n).length <= n);
  assert.equal(bloque('Uno.\n\n\n\nDos   tres', 4096), 'Uno.\n\nDos tres');
  assert.deepEqual([145, 7.5, 1234, 9999.5, 10000.5, 125000].map(precioCorto), ['$145', '$7.50', '$1,234', '$9,999.50', '$10,001', '$125,000']);
  assert.equal(precioCentavos(1450), '$1,450.00');
  for (const n of [0.01, 99999.99, 999999]) assert(precioCorto(n).length <= LIMITES_TIENDA.elementoLista.end, String(n));
});
await t('valores por omisión sin respuesta del dueño (3-oct): reemplaza los dos formularios, conserva «Varios tacos a la vez», 30 min; claves apagadas por nombre', () => {
  assert.deepEqual(POR_OMISION_TIENDA, { reemplazaArmaTuPedido: true, reemplazaTuCarrito: true, variosTacos: true, vigenciaMinutos: 30 });
  assert(Object.isFrozen(POR_OMISION_TIENDA));
  assert.deepEqual([VERSION_TIENDA, BANDERA_TIENDA, FLOW_TIENDA_ID, TELEFONOS_TIENDA],
    ['tienda_v1', 'whatsapp_flow_tienda_v1', 'whatsapp_flow_tienda_id', 'whatsapp_flow_tienda_telefonos']);
  const carta = [{ nombre: 'Tacos', platillos: [{ nombre: 'Taco de Barbacoa', precio: 30, foto: false, grupos: [] }] }];
  const primero = (o) => armarTienda(carta, o).menu.categorias[0]['on-click-action'].payload.platillos.map((p) => p.id);
  assert.deepEqual(primero({}), ['tacos', 'p0'], 'por omisión, «Varios tacos a la vez» primero');
  assert.deepEqual(primero({ variosTacos: false }), ['p0'], 'apagado, la categoría de tacos es una categoría más');
});
await t('categorías: más de 20 elementos se parten en páginas «(1/3)» (el renglón de tacos cuenta); más de 20 categorías no', () => {
  const grande = [{ nombre: 'Bebidas frías y calientes de la casa', platillos: Array.from({ length: 41 }, (_, i) => ({ nombre: `Bebida ${i}`, precio: 30, descripcion: '', foto: false, grupos: [] })) }];
  const { menu } = armarTienda(grande);
  // El sufijo de página no se corta: se corta el nombre.
  assert.deepEqual(menu.categorias.map((c) => c['main-content'].title), [1, 2, 3].map((k) => `Bebidas frías y calient… (${k}/3)`));
  assert.deepEqual(menu.categorias.map((c) => c['on-click-action'].payload.platillos.length), [20, 20, 1]);
  assert.equal(menu.categorias[2]['on-click-action'].payload.categoria_titulo, 'Bebidas frías y calientes de la casa (3/3)');
  const tacos = armarTienda([{ nombre: 'Tacos', platillos: grande[0].platillos.slice(0, 20) }]).menu.categorias;
  assert.deepEqual(tacos.map((c) => c['on-click-action'].payload.platillos.length), [20, 1]);
  assert.equal(tacos[0]['on-click-action'].payload.platillos[0].id, 'tacos');
  assert.throws(() => armarTienda(Array.from({ length: 21 }, (_, i) => ({ nombre: `C${i}`, platillos: grande[0].platillos.slice(0, 1) }))), /hasta 20 categorías/);
});

// ── Huella ───────────────────────────────────────────────────────────────
await t('huella: estable entre construcciones y entre procesos; nombre xabor_tienda_agrupado_<12 hex>, distinto por variante', () => {
  assert(huellaEstable(() => definicionFlowTienda()));
  assert.equal(huellaFlow(definicionFlowTienda()), huellaFlow(def));
  const ruta = pathToFileURL(fileURLToPath(new URL('./definicion-flow-tienda.mjs', import.meta.url))).href;
  const hijo = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { definicionFlowTienda, huellaFlow } from ${JSON.stringify(ruta)}; process.stdout.write(huellaFlow(definicionFlowTienda()));`], { encoding: 'utf8' });
  assert.equal(hijo.status, 0, hijo.stderr);
  assert.equal(hijo.stdout, huellaFlow(def), 'otro proceso calcula la misma huella');
  const nombres = [def, defA].map(nombreFlowTienda);
  for (const n of nombres) assert.match(n, /^xabor_tienda_agrupado_[0-9a-f]{12}$/);
  assert.equal(new Set(nombres).size, 2);
});

// ── Maqueta y presupuesto ────────────────────────────────────────────────
const reporte = [];
const revisarMaqueta = async (nombre, carta, imagen) => {
  for (const [carrito, interactiva] of [['A', false], ['B', false], ['A', true], ['B', true]]) {
    const v = `${carrito}${interactiva ? '·int' : ''}`;
    await t(`maqueta ${nombre} ${v}: solo navigate, esquemas tipados, cada cadena en su límite, dentro del tope de maqueta`, () => {
      const f = carta === estres && !interactiva ? maqEstres[carrito] : construirMaqueta(carta, { carrito, imagen, interactiva });
      assert.deepEqual(validarFlowTienda(f, { endpoint: false }), []);
      assert.equal('routing_model' in f || 'data_api_version' in f, false);
      assert.doesNotMatch(JSON.stringify(f), /"data_exchange"|"const"/);
      assert.equal(pantalla(f, 'CARRITO').layout.children[0].type, carrito === 'A' ? 'NavigationList' : 'Form');
      assert.equal(!!pantalla(f, 'EDITAR'), carrito === 'A', 'EDITAR solo es alcanzable en la maqueta A');
      if (interactiva) {
        assert.equal(f.screens[0].id, 'MENU'); assert.equal('data' in f.screens[0], false, 'MENU arranca sin data');
        assert.doesNotMatch(JSON.stringify(f.screens[0]), /\$\{data\./);
      }
      const bytes = bytesJson(f);
      assert(cabeComoMaqueta(f), `${bytes} bytes > ${LIMITES_TIENDA.maquetaJson}`);
      reporte.push(`${nombre} ${v} ${(bytes / 1024).toFixed(0)} KB`);
    });
  }
  await t(`INIT equivalente ${nombre}: dentro de 600 KB, también con miniaturas de ruido (peor caso)`, () => {
    const [b, peor] = [imagen, ruido].map((im) => bytesJson(initEquivalente(carta, im)));
    assert(b <= PRESUPUESTO && peor <= PRESUPUESTO, `${b} / ${peor}`);
    reporte.push(`INIT ${nombre} ${(b / 1024).toFixed(0)}/${(peor / 1024).toFixed(0)} KB`);
  });
};
await revisarMaqueta('sintética', estres, solidas);
await t('maqueta: los nombres largos llegan cortados con «…» y los platillos sin foto van sin start.image', () => {
  const sin = normalizarCarta([{ nombre: 'TACOS', platillos: [{ nombre: 'Taco de Chicharrón Cuerito en Salsa', precio: 25, descripcion: '', foto: false }] }]);
  const f = construirMaqueta(sin, { carrito: 'A', imagen: solidas });
  const item = pantalla(f, 'MENU').data.categorias.__example__[0]['on-click-action'].payload.platillos[1];
  assert.equal(item['main-content'].title, 'Taco de Chicharrón Cuerito en…'); assert.equal('start' in item, false);
  assert.equal('metadata' in item['main-content'], false, 'sin descripción no se manda metadata vacía');
  assert.deepEqual(validarFlowTienda(f, { endpoint: false }), []);
});
await t('maqueta interactiva: las listas literales de MENU son las de su data y la sube leerMaqueta; un Flow con data_exchange o const no', () => {
  const normal = construirMaqueta(estres, { carrito: 'B', imagen: solidas }), inter = construirMaqueta(estres, { carrito: 'B', imagen: solidas, interactiva: true });
  const listas = (f) => pantalla(f, 'MENU').layout.children.map((c) => c['list-items']);
  assert.deepEqual(listas(inter), [pantalla(normal, 'MENU').data.barra.__example__, pantalla(normal, 'MENU').data.categorias.__example__]);
  assert.equal(pantalla(inter, 'MENU').layout.children[1].label, 'Menú');
  assert.deepEqual(inter.screens.slice(1), normal.screens.slice(1), 'solo cambia MENU');
  const escribir = (nombre, f) => { const r = join(temporal, nombre); writeFileSync(r, JSON.stringify(f)); return r; };
  assert.equal(JSON.parse(leerMaqueta(escribir('int.json', inter))).screens[0].id, 'MENU');
  const conConst = structuredClone(inter); pantalla(conConst, 'CATEGORIA').data.barra.items.properties['on-click-action'].properties.name = { const: 'navigate' };
  assert.throws(() => leerMaqueta(escribir('const.json', conConst)), /no pasa el validador.*esquema sin type/);
  const conServidor = structuredClone(inter); pantalla(conServidor, 'MENU').layout.children[0]['list-items'][0]['on-click-action'] = { name: 'data_exchange', payload: {} };
  assert.throws(() => leerMaqueta(escribir('dx.json', conServidor)), /data_exchange/);
  assert.equal(nombreMaqueta('B'), 'xabor_tienda_maqueta_B');
  assert.deepEqual(leerOpciones(['c.json', 'sal', '--carrito', 'B', '--interactiva', '--fotos', 'f', '--indice', 'i.json', '--gz']),
    { rutaCarta: 'c.json', salida: 'sal', carritos: ['B'], interactiva: true, fotos: 'f', indice: 'i.json', gz: true });
  assert.throws(() => leerOpciones(['c', 's', '--indice', 'i.json']), /--indice va con --fotos/);
});
await t('fotos desde una carpeta: WebP y PNG con transparencia salen JPEG con la receta del servidor; ninguna foto se pierde en silencio', async () => {
  const carpeta = join(temporal, 'fotos'), { mkdirSync } = await import('node:fs');
  mkdirSync(carpeta);
  await sharp({ create: { width: 600, height: 400, channels: 3, background: '#d35400' } }).webp().toFile(join(carpeta, 'Hotcakes de Sarten.webp'));
  await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(join(carpeta, 'Waffles.png'));
  const carta = normalizarCarta([{ nombre: 'DESAYUNOS', platillos: [{ nombre: 'Hotcakes de Sartén', precio: 179, descripcion: 'Dos piezas', foto: true },
    { nombre: 'Waffles', precio: 149, descripcion: '', foto: true }, { nombre: 'Avena', precio: 90, descripcion: '', foto: false }] }]);
  const { imagen, reporte: r } = await fotosDeCarpeta(carpeta, carta);
  assert.deepEqual(r.map((x) => x.nombre), ['Hotcakes de Sartén', 'Waffles'], 'el nombre se compara sin acentos');
  for (const [tipo, variante] of Object.entries(VARIANTE_DE)) {
    const b = Buffer.from(imagen(tipo, 0, carta[0].platillos[1]), 'base64'), m = await sharp(b).metadata();
    assert.deepEqual([m.format, m.width, m.height], ['jpeg', VARIANTES[variante].ancho, VARIANTES[variante].alto], tipo);
    const [px] = await sharp(b).raw().toBuffer().then((x) => [x.subarray(0, 3)]);
    assert(px.every((c) => c > 245), `${tipo}: la transparencia sale blanca (${[...px]})`);
  }
  assert.equal(imagen('lista', 0, carta[0].platillos[2]), null, 'sin foto, sin imagen');
  const f = construirMaqueta(carta, { carrito: 'B', imagen, interactiva: true });
  assert.deepEqual(validarFlowTienda(f, { endpoint: false }), []);
  const cat = pantalla(f, 'MENU').layout.children[1]['list-items'][0];
  assert.equal(cat.start.image, imagen('categoria', 0, carta[0].platillos[0]), 'la categoría lleva la foto de su primer platillo con foto');
  const platillos = cat['on-click-action'].payload.platillos;
  assert.deepEqual(platillos.map((p) => !!p.start), [true, true, false]);
  // Con índice: <id>.<ext>
  const conIndice = join(temporal, 'conIndice'); mkdirSync(conIndice);
  await sharp({ create: { width: 200, height: 200, channels: 3, background: '#2980b9' } }).jpeg().toFile(join(conIndice, '81.img'));
  await sharp({ create: { width: 200, height: 200, channels: 3, background: '#27ae60' } }).jpeg().toFile(join(conIndice, '79.img'));
  assert.equal((await fotosDeCarpeta(conIndice, carta, { indice: [{ id: 79, nombre: 'Hotcakes de Sarten' }, { id: 81, nombre: 'Waffles' }] })).reporte.length, 2);
  // Ninguna foto se pierde en silencio.
  await assert.rejects(fotosDeCarpeta(conIndice, carta, { indice: [{ id: 79, nombre: 'Hotcakes de Sarten' }] }), /81\.img no está en el índice/);
  const sobra = normalizarCarta([{ nombre: 'D', platillos: [{ nombre: 'Waffles', precio: 1, foto: true }, { nombre: 'Hotcakes de Sarten', precio: 1, foto: false }] }]);
  await assert.rejects(fotosDeCarpeta(carpeta, sobra), /hotcakes de sarten» no es de ningún platillo con foto/);
  const falta = normalizarCarta([{ nombre: 'D', platillos: [{ nombre: 'Waffles', precio: 1, foto: true }, { nombre: 'Hotcakes de Sarten', precio: 1, foto: true },
    { nombre: 'Molletes', precio: 1, foto: true }] }]);
  await assert.rejects(fotosDeCarpeta(carpeta, falta), /«Molletes» tiene foto en la carta y no en la carpeta/);
});
let cartaReal = null, fotosReales = null;
if (rutaCarta) {
  cartaReal = normalizarCarta(JSON.parse(readFileSync(rutaCarta, 'utf8')));
  await revisarMaqueta('real', cartaReal, solidas);
}
if (rutaCarta && rutaFotos) {
  await t('fotos reales: cada platillo con foto de la carta tiene su archivo y sus miniaturas caben en el tope', async () => {
    fotosReales = await fotosDeCarpeta(rutaFotos, cartaReal, { indice: rutaIndice ? JSON.parse(readFileSync(rutaIndice, 'utf8')) : null });
    assert.equal(fotosReales.reporte.length, cartaReal.flatMap((c) => c.platillos).filter((p) => p.foto).length);
    for (const r of fotosReales.reporte) assert(r.lista <= 60_000 && r.categoria <= 60_000 && r.ficha <= 60_000, r.nombre);
    reporte.push(`fotos ${fotosReales.reporte.length}: ficha ${Math.min(...fotosReales.reporte.map((r) => r.ficha))}–${Math.max(...fotosReales.reporte.map((r) => r.ficha))} B`);
  });
  if (fotosReales) await revisarMaqueta('real+fotos', cartaReal, fotosReales.imagen);
}

// ── Mordidas: cada garantía rechaza su defecto ───────────────────────────
const IMG = (bytes) => Buffer.from(bytes).toString('base64');
const mordida = (nombre, base, mutar, patron) => t(`mordida: ${nombre}`, () => {
  const f = structuredClone(base); mutar(f);
  const e = validarFlowTienda(f, { endpoint: 'data_api_version' in f });
  assert(e.some((x) => patron.test(x)), `el validador no lo rechazó: ${e.slice(0, 5).join(' | ') || '(sin violaciones)'}`);
  mordidas++;
});
const ej = (f, id, k) => pantalla(f, id).data[k].__example__;
const platillo0 = (f) => ej(f, 'CATEGORIA', 'platillos')[0];
const terminalMinima = (id) => ({ id, title: 'X', terminal: true, data: {}, layout: { type: 'SingleColumnLayout', children: [
  { type: 'Footer', label: 'Listo', 'on-click-action': { name: 'complete', payload: {} } }] } });
const maq = maqEstres.A;
const inter = construirMaqueta(estres, { carrito: 'B', imagen: solidas, interactiva: true });
// Rutas
await mordida('ciclo en el routing_model', def, (f) => { f.routing_model.PERSONALIZAR = ['MENU']; }, /ciclo en las rutas: MENU → CATEGORIA → PERSONALIZAR → MENU/);
await mordida('11 salidas en una pantalla', def, (f) => {
  for (let i = 0; i < 11; i++) { f.screens.push(terminalMinima(`X${i}`)); f.routing_model[`X${i}`] = []; f.routing_model.EDITAR.push(`X${i}`); }
}, /EDITAR: 11 salidas \(máximo 10\)/);
await mordida('ciclo por navigate en la maqueta (EDITAR → CARRITO)', maq, (f) => {
  const carrito = ej(f, 'MENU', 'barra')[0]['on-click-action'].payload;
  formDe(f, 'EDITAR').children.find((c) => c.type === 'Footer')['on-click-action'] = { name: 'navigate', next: { type: 'screen', name: 'CARRITO' }, payload: carrito };
}, /ciclo en las rutas: CARRITO → EDITAR → CARRITO/);
await mordida('navigate fuera del routing_model', def, (f) => { f.routing_model.MENU = ['CARRITO']; }, /navigate MENU → CATEGORIA fuera del routing_model/);
await mordida('routing_model a una pantalla inexistente', def, (f) => { f.routing_model.MENU.push('NADA'); }, /pantalla inexistente NADA/);
await mordida('pantalla sin routing_model', def, (f) => { delete f.routing_model.EDITAR; }, /falta la pantalla EDITAR/);
// Lo que publicamos el 4-oct: MENU sin refresh_on_back y el teléfono rechazaba «Agregar».
await mordida('MENU sin refresh_on_back (el error de «Agregar» del 4-oct)', def, (f) => { pantalla(f, 'MENU').refresh_on_back = false; },
  /MENU: el servidor regresa a ella y no lleva refresh_on_back/);
await mordida('CATEGORIA sin refresh_on_back', def, (f) => { delete pantalla(f, 'CATEGORIA').refresh_on_back; },
  /CATEGORIA: el servidor regresa a ella y no lleva refresh_on_back/);
// Componentes por pantalla
await mordida('Footer de más', def, (f) => { formDe(f, 'PERSONALIZAR').children.push({ type: 'Footer', label: 'Otro', 'on-click-action': { name: 'data_exchange', payload: {} } }); }, /PERSONALIZAR: 2 Footer/);
await mordida('51 componentes', def, (f) => { for (let i = 0; i < 23; i++) formDe(f, 'PERSONALIZAR').children.splice(1, 0, { type: 'TextCaption', text: `Relleno ${i}` }); }, /PERSONALIZAR: 51 componentes/);
await mordida('4 Image', def, (f) => { for (let i = 0; i < 3; i++) formDe(f, 'PERSONALIZAR').children.unshift({ type: 'Image', src: '${data.foto}' }); }, /PERSONALIZAR: 4 Image/);
await mordida('3 EmbeddedLink', def, (f) => { for (let i = 0; i < 2; i++) formDe(f, 'EDITAR').children.splice(-1, 0, { type: 'EmbeddedLink', text: `Otro ${i}`, 'on-click-action': { name: 'data_exchange', payload: {} } }); }, /EDITAR: 3 EmbeddedLink/);
await mordida('3 EmbeddedLink en el carrito B', def, (f) => { formDe(f, 'CARRITO').children.splice(-1, 0, { type: 'EmbeddedLink', text: 'Otro', 'on-click-action': { name: 'data_exchange', payload: {} } }); }, /CARRITO: 3 EmbeddedLink/);
// NavigationList
await mordida('NavigationList junto a un TextBody', def, (f) => { pantalla(f, 'MENU').layout.children.push({ type: 'TextBody', text: 'Hola' }); }, /MENU: NavigationList con otros componentes/);
await mordida('3 NavigationList', def, (f) => { pantalla(f, 'MENU').layout.children.push({ type: 'NavigationList', name: 'otra', 'list-items': '${data.barra}' }); }, /MENU: 3 NavigationList/);
await mordida('NavigationList en pantalla terminal', def, (f) => { pantalla(f, 'CATEGORIA').terminal = true; }, /CATEGORIA: NavigationList en una pantalla terminal/);
await mordida('NavigationList dentro de un Form', def, (f) => {
  formDe(f, 'PERSONALIZAR').children.push({ type: 'NavigationList', name: 'x', 'list-items': [{ id: 'a', 'main-content': { title: 'A' }, 'on-click-action': { name: 'data_exchange', payload: {} } }] });
}, /PERSONALIZAR: NavigationList dentro de otro componente/);
await mordida('21 elementos', def, (f) => { const c = ej(f, 'MENU', 'categorias'); while (c.length < 21) c.push({ ...structuredClone(c[0]), id: `z${c.length}` }); }, /categorias\): 21 elementos \(1–20\)/);
await mordida('lista vacía', def, (f) => { pantalla(f, 'MENU').data.categorias.__example__ = []; }, /categorias\): 0 elementos/);
await mordida('title de 31', def, (f) => { platillo0(f)['main-content'].title = 'x'.repeat(31); }, /main-content\.title: 31 > 30/);
await mordida('description de 21', def, (f) => { ej(f, 'MENU', 'categorias')[0]['main-content'].description = 'x'.repeat(21); }, /main-content\.description: 21 > 20/);
await mordida('metadata de 81', def, (f) => { platillo0(f)['main-content'].metadata = 'x'.repeat(81); }, /main-content\.metadata: 81 > 80/);
await mordida('end.title de 11', def, (f) => { platillo0(f).end.title = '$1,000,000.0'; }, /end\.title: 12 > 10/);
await mordida('dos badges en una lista', def, (f) => { for (const p of ej(f, 'CATEGORIA', 'platillos')) p.badge = 'Nuevo'; }, /2 badges \(máximo 1 por lista\)/);
await mordida('acción en el componente y en el elemento', def, (f) => {
  pantalla(f, 'CATEGORIA').layout.children[0]['on-click-action'] = { name: 'data_exchange', payload: { operacion: 'ver' } };
}, /on-click-action en el componente y en el elemento/);
await mordida('elemento sin acción', def, (f) => { delete platillo0(f)['on-click-action']; }, /sin on-click-action/);
await mordida('acciones de distinto tipo en la misma lista', def, (f) => {
  const ficha = Object.fromEntries(Object.entries(pantalla(f, 'PERSONALIZAR').data).map(([k, e]) => [k, structuredClone(e.__example__)]));
  ej(f, 'CATEGORIA', 'platillos')[1]['on-click-action'] = { name: 'navigate', next: { type: 'screen', name: 'PERSONALIZAR' }, payload: ficha };
}, /platillos\): acciones de distinto tipo en la misma lista \(data_exchange, navigate\)/);
await mordida('imagen de más de 100 KB', def, (f) => { platillo0(f).start.image = IMG(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100_001)])); }, /start\.image: 100005 bytes > 100000/);
await mordida('imagen WebP', def, (f) => { platillo0(f).start.image = IMG(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')); }, /start\.image: solo JPEG o PNG/);
await mordida('Image de la ficha que no es base64', def, (f) => { pantalla(f, 'PERSONALIZAR').data.foto.__example__ = 'no es base64!'; }, /Image\.src: no es base64 válido/);
// Esquema de datos [M]
await mordida('esquema con const sin type (lo que Meta rechazó el 3-oct)', def, (f) => {
  pantalla(f, 'MENU').data.barra.items.properties['on-click-action'].properties.name = { const: 'data_exchange' };
}, /MENU\.data\.barra\[\]\.on-click-action\.name: esquema sin type válido \(const sin type\)/);
await mordida('const junto a type', def, (f) => { pantalla(f, 'CARRITO').data.boton.const = 'Continuar'; }, /CARRITO\.data\.boton: clave «const» no admitida/);
await mordida('esquema sin type', def, (f) => { delete pantalla(f, 'PERSONALIZAR').data.con_foto.type; }, /PERSONALIZAR\.data\.con_foto: esquema sin type válido/);
await mordida('type que Meta no admite', def, (f) => { pantalla(f, 'CARRITO').data.filas.items.properties.id.type = 'integer'; }, /CARRITO\.data\.filas\[\]\.id: esquema sin type válido \("integer"\)/);
await mordida('array sin items', def, (f) => { delete pantalla(f, 'MENU').data.categorias.items; }, /MENU\.data\.categorias: array sin items/);
await mordida('object sin properties', def, (f) => { delete pantalla(f, 'MENU').data.barra.items.properties['main-content'].properties; }, /barra\[\]\.main-content: object sin properties/);
await mordida('__example__ anidado', def, (f) => { pantalla(f, 'MENU').data.barra.items.__example__ = []; }, /barra\[\]: clave «__example__» no admitida/);
// [M] El name de un on-select-action / on-unselect-action de update_data: exactamente {const:'update_data'}.
await t('mordida: la data de TACOS tipada con {type:"string"} (el tiparEsquema de eaaaef3) da los 12 rechazos que dio Meta el 3-oct', () => {
  const f = structuredClone(def), tacos = pantalla(f, 'TACOS');
  for (const [k, e] of Object.entries(tacos.data)) tacos.data[k] = JSON.parse(JSON.stringify(e).replaceAll('{"const":"update_data"}', '{"type":"string"}'));
  const e = validarFlowTienda(f);
  assert.deepEqual(e, CANTIDADES_TACOS.map((r) => `${r}: el name de on-select-action va exactamente como {"const":"update_data"} ({"type":"string"})`));
  mordidas++;
});
await mordida('name de on-select-action con type y const', def, (f) => {
  pantalla(f, 'TACOS').data.t3_cantidades.items.properties['on-select-action'].properties.name = { type: 'string', const: 'update_data' };
}, /TACOS\.data\.t3_cantidades\[\]\.on-select-action\.name: el name de on-select-action va exactamente como \{"const":"update_data"\}/);
await mordida('name de on-select-action con otra constante', def, (f) => {
  pantalla(f, 'TACOS').data.t0_cantidades.items.properties['on-select-action'].properties.name = { const: 'data_exchange' };
}, /TACOS\.data\.t0_cantidades\[\]\.on-select-action\.name: el name de on-select-action va exactamente como \{"const":"update_data"\} \(\{"const":"data_exchange"\}\)/);
await mordida('name de on-unselect-action tipado como string', def, (f) => {
  pantalla(f, 'TACOS').data.t0_cantidades.items.properties['on-unselect-action'] = { type: 'object',
    properties: { name: { type: 'string' }, payload: { type: 'object', properties: { t0_activo: { type: 'boolean' } } } } };
}, /TACOS\.data\.t0_cantidades\[\]\.on-unselect-action\.name: el name de on-unselect-action va exactamente como \{"const":"update_data"\} \(\{"type":"string"\}\)/);
await mordida('{const:"update_data"} fuera de on-select-action (en el name de un on-click-action)', def, (f) => {
  pantalla(f, 'MENU').data.barra.items.properties['on-click-action'].properties.name = { const: 'update_data' };
}, /MENU\.data\.barra\[\]\.on-click-action\.name: esquema sin type válido \(const sin type\)/);
await mordida('{const:"navigate"} en el name de un navigate (lo que Meta rechazó en la maqueta)', def, (f) => {
  pantalla(f, 'MENU').data.categorias.items.properties['on-click-action'].properties.name = { const: 'navigate' };
}, /MENU\.data\.categorias\[\]\.on-click-action\.name: esquema sin type válido \(const sin type\)/);
await mordida('ejemplo de TACOS cuyo on-select-action no es update_data', def, (f) => {
  ej(f, 'TACOS', 't0_cantidades')[0]['on-select-action'].name = 'data_exchange';
}, /TACOS\.__example__: dato fuera de su esquema \(t0_cantidades\[0\]\.on-select-action\.name: "data_exchange" donde va la constante "update_data"\)/);
await mordida('dato de ejemplo fuera de su esquema', def, (f) => { pantalla(f, 'PERSONALIZAR').data.con_foto.__example__ = 'true'; }, /PERSONALIZAR\.__example__: dato fuera de su esquema \(con_foto: string donde va boolean\)/);
await mordida('clave sin declarar en el ejemplo', def, (f) => { platillo0(f).extra = 'x'; }, /dato fuera de su esquema \(platillos\[0\]\.extra: clave sin declarar\)/);
await mordida('payload de navigate fuera del esquema (maqueta)', maq, (f) => {
  ej(f, 'MENU', 'categorias')[0]['on-click-action'].payload.platillos[0]['on-click-action'].payload.con_foto = 'sí';
}, /→ PERSONALIZAR: dato fuera de su esquema \(con_foto: string donde va boolean\)/);
// La lista literal de la maqueta interactiva se recorre como los datos
await mordida('lista literal que navega a una pantalla inexistente', inter, (f) => {
  pantalla(f, 'MENU').layout.children[1]['list-items'][0]['on-click-action'].next.name = 'NADA';
}, /MENU\.NavigationList\(categorias\)\[0\]\.on-click-action: navigate a una pantalla inexistente \(NADA\)/);
await mordida('lista literal con payload incompleto', inter, (f) => {
  delete pantalla(f, 'MENU').layout.children[1]['list-items'][0]['on-click-action'].payload.barra;
}, /payload de navigate a CATEGORIA no coincide con su data/);
await mordida('lista literal con un título de 31 dentro de su categoría', inter, (f) => {
  pantalla(f, 'MENU').layout.children[1]['list-items'][0]['on-click-action'].payload.platillos[0]['main-content'].title = 'x'.repeat(31);
}, /→ CATEGORIA NavigationList\(platillos\)\[0\] main-content\.title: 31 > 30/);
// Cadenas fijas y de datos
await mordida('Footer de 36', def, (f) => { formDe(f, 'EDITAR').children.find((c) => c.type === 'Footer').label = 'x'.repeat(36); }, /Footer\.label: 36 > 35/);
await mordida('Footer dinámico de 36', def, (f) => { pantalla(f, 'PERSONALIZAR').data.boton.__example__ = `Agregar · ${'x'.repeat(26)}`; }, /Footer\.label: 36 > 35/);
await mordida('label de Dropdown de 21', def, (f) => { componente(f, 'PERSONALIZAR', 'cantidad').label = 'x'.repeat(21); }, /Dropdown\(cantidad\)\.label: 21 > 20/);
await mordida('label de grupo de 31 en un Radio', def, (f) => { pantalla(f, 'PERSONALIZAR').data.g0_label.__example__ = 'x'.repeat(31); }, /RadioButtonsGroup\(g0_r\)\.label: 31 > 30/);
await mordida('metadata de opción de 21', def, (f) => { pantalla(f, 'PERSONALIZAR').data.g1_opciones.__example__[4].metadata = `+$${'9'.repeat(19)}`; }, /\[4\]\.metadata: 21 > 20/);
await mordida('21 opciones en un Radio', def, (f) => { const o = pantalla(f, 'PERSONALIZAR').data.g0_opciones.__example__; while (o.length < 21) o.push({ ...o[0], id: `o${o.length}` }); }, /RadioButtonsGroup\(g0_r\): 21 opciones \(1–20\)/);
await mordida('EmbeddedLink de 26', def, (f) => { formDe(f, 'EDITAR').children.find((c) => c.type === 'EmbeddedLink').text = 'x'.repeat(26); }, /EmbeddedLink\.text: 26 > 25/);
await mordida('título de pantalla de 31', def, (f) => { pantalla(f, 'PERSONALIZAR').title = 'x'.repeat(31); }, /PERSONALIZAR\.title: 31 > 30/);
await mordida('cadena fija vacía', def, (f) => { componente(f, 'PERSONALIZAR', 'observaciones').label = ''; }, /TextArea\(observaciones\)\.label: cadena vacía/);
await mordida('descripción de lista vacía', def, (f) => { pantalla(f, 'MENU').data.menu_aviso.__example__ = ''; }, /NavigationList\(categorias\)\.description: cadena vacía/);
await mordida('botón «Continuar» de 36 en el carrito B', def, (f) => { pantalla(f, 'CARRITO').data.boton.__example__ = `Continuar · $${'9'.repeat(23)}`; }, /CARRITO.*Footer\.label: 36 > 35/);
// Enlaces de datos, acciones y payload
await mordida('${data.x} sin declarar', def, (f) => { delete pantalla(f, 'PERSONALIZAR').data.boton; }, /PERSONALIZAR: \$\{data\.boton\} sin declarar/);
await mordida('${form.x} sin componente', def, (f) => { formDe(f, 'PERSONALIZAR').children.find((c) => c.type === 'Footer')['on-click-action'].payload.cantidad = '${form.cuantos}'; }, /\$\{form\.cuantos\} sin componente/);
await mordida('payload de navigate incompleto', def, (f) => { delete ej(f, 'MENU', 'categorias')[0]['on-click-action'].payload.barra; }, /payload de navigate a CATEGORIA no coincide con su data/);
await mordida('complete fuera de una pantalla terminal', def, (f) => { formDe(f, 'PERSONALIZAR').children.find((c) => c.type === 'Footer')['on-click-action'].name = 'complete'; }, /complete fuera de una pantalla terminal/);
await mordida('navigate en el Footer de una pantalla terminal', maq, (f) => {
  formDe(f, 'ENTREGA').children.find((c) => c.type === 'Footer')['on-click-action'] = { name: 'navigate', next: { type: 'screen', name: 'FIN_MAQUETA' }, payload: { explicacion: 'x' } };
}, /navigate en el Footer de una pantalla terminal/);
// Lo propio de un Flow sin endpoint (la maqueta)
await mordida('data_exchange en la maqueta', maq, (f) => { platillo0(f)['on-click-action'] = { name: 'data_exchange', payload: { operacion: 'ver', producto: 'p0' } }; }, /data_exchange en un Flow sin endpoint/);
await mordida('refresh_on_back en la maqueta', maq, (f) => { pantalla(f, 'CARRITO').refresh_on_back = true; }, /CARRITO: refresh_on_back en un Flow sin endpoint/);
await mordida('routing_model en la maqueta', inter, (f) => { f.routing_model = { MENU: ['CATEGORIA'] }; }, /routing_model en un Flow sin endpoint/);
await mordida('cadena de la carta sin cortar en la maqueta', maq, (f) => {
  ej(f, 'MENU', 'categorias')[11]['on-click-action'].payload.platillos[19]['main-content'].title = 'Platillo 11.19 con un nombre de cuarenta';
}, /main-content\.title: 40 > 30/);
// Presupuesto y huella: sus propias funciones
await t('mordida: un Flow de más de 600 KB queda fuera del presupuesto', () => {
  const chica = maqEstres.B;
  assert(dentroDelPresupuesto(chica));
  const grande = structuredClone(chica); pantalla(grande, 'FIN_MAQUETA').data.explicacion.__example__ = 'x'.repeat(PRESUPUESTO);
  assert.equal(dentroDelPresupuesto(grande), false); mordidas++;
});
await t('mordida: una maqueta de más de 1.5 MB no cabe como maqueta (ni la sube leerMaqueta)', () => {
  // Válida en todo lo demás: una pantalla terminal con un dato enorme que no se dibuja.
  const grande = structuredClone(maqEstres.B), relleno = terminalMinima('RELLENO');
  relleno.data = { relleno: { type: 'string', __example__: 'x'.repeat(LIMITES_TIENDA.maquetaJson) } };
  grande.screens.push(relleno);
  assert.deepEqual(validarFlowTienda(grande, { endpoint: false }), []);
  assert(cabeComoMaqueta(maqEstres.B)); assert.equal(cabeComoMaqueta(grande), false);
  const ruta = join(temporal, 'grande.json'); writeFileSync(ruta, JSON.stringify(grande));
  assert.throws(() => leerMaqueta(ruta), /tope de maqueta/); mordidas++;
});
await t('mordida: una definición que cambia en cada construcción no tiene huella estable', () => {
  assert.equal(huellaEstable(() => ({ ...definicionFlowTienda(), nonce: Math.random() })), false); mordidas++;
});

rmSync(temporal, { recursive: true, force: true });
console.log(`flow tienda: ${pasadas}/${pasadas + fallidas} casos (${mordidas} mordidas); ${reporte.join(' · ')}${rutaCarta ? '' : ' · sin carta real (pasa la ruta para medirla)'}`
  + `${rutaCarta && !rutaFotos ? ' · sin fotos reales (pasa la carpeta)' : ''}`);
assert.equal(fallidas, 0);
