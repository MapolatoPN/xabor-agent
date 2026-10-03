// Formulario «tienda» (contrato tienda_v1, Fase 0): chequeo estático de la
// definición y de la maqueta contra los límites de Meta. Puro: sin base de
// datos, Meta ni pedidos. Termina con exit ≠ 0 si algo falla.
//
//   node scripts/check-flow-tienda.mjs [carta.json]     (o CARTA_TIENDA=<carta.json>)
//
// Con la carta (la de Obispado, carta-obispado.json) además exige que las dos
// maquetas con la carta real quepan en 600 KB de JSON. Sin ella usa una carta
// sintética de estrés con la forma de Obispado.
//
// Cada garantía tiene su MORDIDA: un caso que construye un Flow con el defecto
// y exige que el validador lo rechace. Si alguien apaga una barrera de
// validarFlowTienda, su mordida falla y este chequeo también.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { definicionFlowTienda, validarFlowTienda, armarTienda, datosRanuras, huellaFlow, nombreFlowTienda, huellaEstable,
  bytesJson, dentroDelPresupuesto, recortar, bloque, precioCorto, precioCentavos, LIMITES_TIENDA, RANURAS, MAX_RADIO,
  GRUPOS_CHILAQUILES_SENCILLOS, CARTA_EJEMPLO } from './definicion-flow-tienda.mjs';
import { definicionFlowCategorias } from './definicion-flow-categorias.mjs';
import { pantallaDireccion } from './definicion-pantalla-direccion.mjs';
import { construirMaqueta, imagenesSolidas, imagenesRuido, initEquivalente, normalizarCarta } from './maqueta-flow-tienda.mjs';

let pasadas = 0, fallidas = 0, mordidas = 0;
const t = async (nombre, fn) => { try { await fn(); pasadas++; } catch (e) { fallidas++; console.error(`${nombre}: ${e.message}`); } };
const pantalla = (f, id) => f.screens.find((s) => s.id === id);
const formDe = (f, id) => pantalla(f, id).layout.children[0];
const componente = (f, id, nombre) => formDe(f, id).children.find((c) => c.name === nombre);
const PRESUPUESTO = LIMITES_TIENDA.presupuestoJson;
const principal = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const rutaCarta = process.env.CARTA_TIENDA || (principal ? process.argv[2] : undefined);

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
const maqEstres = { A: construirMaqueta(estres, { carrito: 'A', imagen: solidas }), B: construirMaqueta(estres, { carrito: 'B', imagen: solidas }) };

// ── Definición ───────────────────────────────────────────────────────────
await t('definición: las variantes AB, A y B cumplen todos los límites (estructura, rutas y datos de ejemplo)', () => {
  for (const carrito of ['AB', 'A', 'B']) {
    const f = definicionFlowTienda({ carrito });
    assert.equal(f.version, '7.3'); assert.equal(f.data_api_version, '3.0');
    assert.deepEqual(validarFlowTienda(f), [], carrito);
  }
});
await t('rutas: las de la propuesta más la barra de CATEGORIA y «personalizar» de TACOS; sin ciclos', () => {
  assert.deepEqual(def.routing_model, { MENU: ['CATEGORIA', 'CARRITO', 'CARRITO_B'], CATEGORIA: ['PERSONALIZAR', 'TACOS', 'CARRITO', 'CARRITO_B'],
    PERSONALIZAR: [], TACOS: ['PERSONALIZAR'], CARRITO: ['EDITAR', 'ENTREGA'], CARRITO_B: ['EDITAR', 'ENTREGA'], EDITAR: [], ENTREGA: ['DIRECCION'], DIRECCION: [] });
  assert.deepEqual(definicionFlowTienda({ carrito: 'A' }).routing_model.MENU, ['CATEGORIA', 'CARRITO']);
  assert.equal(def.screens[0].id, 'MENU', 'el INIT abre en el menú');
});
await t('refresh_on_back y terminales como en la tabla de pantallas', () => {
  const esperado = { MENU: false, CATEGORIA: false, PERSONALIZAR: false, TACOS: false, CARRITO: true, CARRITO_B: true, EDITAR: false, ENTREGA: true, DIRECCION: true };
  assert.deepEqual(Object.fromEntries(def.screens.map((s) => [s.id, s.refresh_on_back])), esperado);
  assert.deepEqual(def.screens.filter((s) => s.terminal).map((s) => s.id), ['ENTREGA', 'DIRECCION']);
});
await t('MENU, CATEGORIA y CARRITO (A): solo dos NavigationList; explorar es navigate, ver y el carrito van al servidor', () => {
  for (const id of ['MENU', 'CATEGORIA', 'CARRITO']) {
    const hijos = pantalla(def, id).layout.children;
    assert.deepEqual(hijos.map((c) => c.type), ['NavigationList', 'NavigationList'], id);
  }
  const menu = pantalla(def, 'MENU').data;
  assert(menu.categorias.__example__.every((c) => c['on-click-action'].name === 'navigate' && c['on-click-action'].next.name === 'CATEGORIA'));
  assert.deepEqual(menu.barra.__example__[0]['on-click-action'], { name: 'data_exchange', payload: { operacion: 'ver_carrito' } });
  const platillos = pantalla(def, 'CATEGORIA').data.platillos.__example__;
  assert.deepEqual(platillos.map((p) => p['on-click-action'].payload.operacion), ['ver', 'ver']);
  const tacos = menu.categorias.__example__.find((c) => c['main-content'].title === 'TACOS')['on-click-action'].payload.platillos[0];
  assert.deepEqual(tacos['on-click-action'].payload, { operacion: 'ver_tacos', categoria: 'c2' }, '«Varios tacos a la vez» primero');
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
  const b = formDe(def, 'CARRITO_B').children;
  assert.deepEqual(b.find((c) => c.type === 'Footer')['on-click-action'].payload, { operacion: 'continuar', revision: '${data.revision}' });
  assert.equal(b.find((c) => c.type === 'Footer').label, '${data.boton}');
  assert.equal(pantalla(def, 'CARRITO_B').data.boton.__example__, 'Continuar · $614');
});
await t('TACOS, ENTREGA y DIRECCION se reutilizan: solo cambia el Footer de TACOS («Agregar») y su refresh_on_back', () => {
  const base = definicionFlowCategorias({ direccion: true, nota: true });
  const tacos = structuredClone(pantalla(def, 'TACOS'));
  assert.equal(tacos.layout.children[0].children.find((c) => c.type === 'Footer').label, 'Agregar');
  tacos.layout.children[0].children.find((c) => c.type === 'Footer').label = 'ORDEN COMPLETA'; tacos.refresh_on_back = true;
  assert.deepEqual(tacos, pantalla(base, 'TACOS'));
  assert.deepEqual(pantalla(def, 'ENTREGA'), pantalla(base, 'ENTREGA'));
  assert(JSON.stringify(pantalla(def, 'ENTREGA')).includes('"name":"nota"'), 'ENTREGA con la nota del pedido');
  assert.deepEqual(pantalla(def, 'DIRECCION'), pantallaDireccion());
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
  const nombres = ['AB', 'A', 'B'].map((carrito) => nombreFlowTienda(definicionFlowTienda({ carrito })));
  for (const n of nombres) assert.match(n, /^xabor_tienda_agrupado_[0-9a-f]{12}$/);
  assert.equal(new Set(nombres).size, 3);
});

// ── Maqueta y presupuesto ────────────────────────────────────────────────
const reporte = [];
const revisarMaqueta = async (nombre, carta, exigirBytes) => {
  for (const carrito of ['A', 'B']) await t(`maqueta ${nombre} ${carrito}: solo navigate, cada cadena en su límite${exigirBytes ? ', dentro de 600 KB' : ''}`, () => {
    const f = carta === estres ? maqEstres[carrito] : construirMaqueta(carta, { carrito, imagen: solidas });
    assert.deepEqual(validarFlowTienda(f, { endpoint: false }), []);
    assert.equal('routing_model' in f || 'data_api_version' in f, false);
    assert.doesNotMatch(JSON.stringify(f), /"data_exchange"/);
    const bytes = bytesJson(f);
    if (exigirBytes) assert(bytes <= PRESUPUESTO, `${bytes} bytes > ${PRESUPUESTO}`);
    reporte.push(`${nombre} ${carrito} ${(bytes / 1024).toFixed(0)} KB`);
  });
  await t(`INIT equivalente ${nombre}: dentro de 600 KB, también con miniaturas de ruido (peor caso)`, () => {
    const [b, peor] = [solidas, ruido].map((imagen) => bytesJson(initEquivalente(carta, imagen)));
    assert(b <= PRESUPUESTO && peor <= PRESUPUESTO, `${b} / ${peor}`);
    reporte.push(`INIT ${nombre} ${(b / 1024).toFixed(0)}/${(peor / 1024).toFixed(0)} KB`);
  });
};
// La maqueta sintética (todo con foto y textos largos) no se mide contra el tope:
// el tope es de la maqueta con la carta real. Su INIT, el de producción, sí.
await revisarMaqueta('sintética', estres, false);
await t('maqueta: los nombres largos llegan cortados con «…» y los platillos sin foto van sin start.image', () => {
  const sin = normalizarCarta([{ nombre: 'TACOS', platillos: [{ nombre: 'Taco de Chicharrón Cuerito en Salsa', precio: 25, descripcion: '', foto: false }] }]);
  const f = construirMaqueta(sin, { carrito: 'A', imagen: solidas });
  const item = pantalla(f, 'MENU').data.categorias.__example__[0]['on-click-action'].payload.platillos[1];
  assert.equal(item['main-content'].title, 'Taco de Chicharrón Cuerito en…'); assert.equal('start' in item, false);
  assert.equal('metadata' in item['main-content'], false, 'sin descripción no se manda metadata vacía');
  assert.deepEqual(validarFlowTienda(f, { endpoint: false }), []);
});
if (rutaCarta) await revisarMaqueta('real', normalizarCarta(JSON.parse(readFileSync(rutaCarta, 'utf8'))), true);

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
// Rutas
await mordida('ciclo en el routing_model', def, (f) => { f.routing_model.PERSONALIZAR = ['MENU']; }, /ciclo en las rutas: MENU → CATEGORIA → PERSONALIZAR → MENU/);
await mordida('11 salidas en una pantalla', def, (f) => {
  for (let i = 0; i < 11; i++) { f.screens.push(terminalMinima(`X${i}`)); f.routing_model[`X${i}`] = []; f.routing_model.EDITAR.push(`X${i}`); }
}, /EDITAR: 11 salidas \(máximo 10\)/);
await mordida('ciclo por navigate en la maqueta (EDITAR → CARRITO)', maq, (f) => {
  const carrito = ej(f, 'MENU', 'barra')[0]['on-click-action'].payload;
  formDe(f, 'EDITAR').children.find((c) => c.type === 'Footer')['on-click-action'] = { name: 'navigate', next: { type: 'screen', name: 'CARRITO' }, payload: carrito };
}, /ciclo en las rutas: CARRITO → EDITAR → CARRITO/);
await mordida('navigate fuera del routing_model', def, (f) => { f.routing_model.MENU = ['CARRITO', 'CARRITO_B']; }, /navigate MENU → CATEGORIA fuera del routing_model/);
await mordida('routing_model a una pantalla inexistente', def, (f) => { f.routing_model.MENU.push('NADA'); }, /pantalla inexistente NADA/);
await mordida('pantalla sin routing_model', def, (f) => { delete f.routing_model.EDITAR; }, /falta la pantalla EDITAR/);
// Componentes por pantalla
await mordida('Footer de más', def, (f) => { formDe(f, 'PERSONALIZAR').children.push({ type: 'Footer', label: 'Otro', 'on-click-action': { name: 'data_exchange', payload: {} } }); }, /PERSONALIZAR: 2 Footer/);
await mordida('51 componentes', def, (f) => { for (let i = 0; i < 23; i++) formDe(f, 'PERSONALIZAR').children.splice(1, 0, { type: 'TextCaption', text: `Relleno ${i}` }); }, /PERSONALIZAR: 51 componentes/);
await mordida('4 Image', def, (f) => { for (let i = 0; i < 3; i++) formDe(f, 'PERSONALIZAR').children.unshift({ type: 'Image', src: '${data.foto}' }); }, /PERSONALIZAR: 4 Image/);
await mordida('3 EmbeddedLink', def, (f) => { for (let i = 0; i < 2; i++) formDe(f, 'EDITAR').children.splice(-1, 0, { type: 'EmbeddedLink', text: `Otro ${i}`, 'on-click-action': { name: 'data_exchange', payload: {} } }); }, /EDITAR: 3 EmbeddedLink/);
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
await mordida('imagen de más de 100 KB', def, (f) => { platillo0(f).start.image = IMG(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100_001)])); }, /start\.image: 100005 bytes > 100000/);
await mordida('imagen WebP', def, (f) => { platillo0(f).start.image = IMG(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')); }, /start\.image: solo JPEG o PNG/);
await mordida('Image de la ficha que no es base64', def, (f) => { pantalla(f, 'PERSONALIZAR').data.foto.__example__ = 'no es base64!'; }, /Image\.src: no es base64 válido/);
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
await t('mordida: una definición que cambia en cada construcción no tiene huella estable', () => {
  assert.equal(huellaEstable(() => ({ ...definicionFlowTienda(), nonce: Math.random() })), false); mordidas++;
});

console.log(`flow tienda: ${pasadas}/${pasadas + fallidas} casos (${mordidas} mordidas); ${reporte.join(' · ')}${rutaCarta ? '' : ' · sin carta real (pasa la ruta para medirla)'}`);
assert.equal(fallidas, 0);
