// Formulario «tienda» (tienda_v1), Fase 2 parte A: lo que el servidor dibuja
// (src/mesero-agente/catalogoFlowTienda.js). Pura: sin base de datos, sharp,
// Meta ni red; las miniaturas son JPEG falsos de tamaño exacto.
//
// Garantías que prueba:
//   textos      cada cadena se corta a su límite de Meta (un texto de más no
//               se dibuja); un precio que no cabe se omite, nunca se corta
//   ranuras     Radio con 8 opciones o menos, Dropdown con más, Checkbox
//   menú        categorías con portada (la del primer platillo con foto, una
//               sola pedida) y «Desde $X»; más de 20 platillos en páginas; el
//               renglón de tacos primero y cuenta; más de 20 entradas no abre
//   escalera    600 KB: miniaturas de 96 → de 80 → sin miniaturas desde la
//               última categoría → modo B → modo B sin portadas
//   fotos       sin foto no hay imagen (ni start.image ni Image); una
//               miniatura de más de 100 KB o que falla no se manda
//   carrito     B: vacío, renglones en markdown sin cortar uno a la mitad
//   forma       con una carta hostil, toda pantalla pasa el validador del Flow
import assert from 'node:assert/strict';
import { recortar, bloque, precioCorto, precioCentavos, precioQueCabe, datosRanuras, varianteDeGrupo, entradasMenu, categoriaDeTacos,
  motivoSinTienda, admiteTienda, barraPedido, datosMenu, datosCategoria, datosPersonalizar, datosEditar, datosCarrito, renglonesMarkdown,
  resumenDelPedido, bytesJson, botonAgregar, LIMITES_TIENDA, IMAGEN_VACIA, MAX_RADIO, MAX_RENGLONES_TIENDA, NIVELES_MENU, MINIATURA,
  MAX_NOMBRE_RENGLON, MAX_DETALLE_RENGLON } from '../src/mesero-agente/catalogoFlowTienda.js';
import { borradorTienda, cambiarTienda, respuestaTienda, pedidoDelBorrador } from '../src/mesero-agente/flowTienda.js';
import { fotoTienda, vitrinaFalsa, jpegFalso, exigirForma, dx, INIT, PRODUCTOS, G_SALSA, G_PROTEINA, G_GUARNICION, G_EXTRAS, G_TORTILLA } from './lib-fixtures-tienda.mjs';

let pasadas = 0, fallidas = 0;
const t = async (nombre, fn) => {
  try { await fn(); pasadas++; console.log(`  ok  ${nombre}`); } catch (e) { fallidas++; console.log(`FALLA ${nombre}: ${e.message}`); }
};
const E = LIMITES_TIENDA.elementoLista;
const PEDIDO_VACIO = { renglones: [], unidades: 0, subtotalCentavos: 0 };
const producto = (id, nombre, precio, categoria, grupos = []) => ({ id: String(id), nombre, precio, grupos, categoria, categoriaId: categoria });
/** `n` platillos por categoría, todos con foto. */
const cartaDe = (porCategoria, { nombre = (c, i) => `Platillo ${c}.${i}`, precio = (c, i) => 50 + i } = {}) =>
  porCategoria.flatMap((n, c) => Array.from({ length: n }, (_, i) => producto(`${c}${String(i).padStart(3, '0')}`, nombre(c, i), precio(c, i), `Categoría ${c}`)));
const listaDe = (data, k) => data.categorias[k]['on-click-action'];

// ── Textos y precios ─────────────────────────────────────────────────────
await t('textos: se cortan con «…» sin pasar el límite ni partir un emoji; una línea colapsa espacios; un bloque conserva párrafos', () => {
  assert.equal(recortar('Taco de Chicharrón Cuerito en Salsa', 30), 'Taco de Chicharrón Cuerito en…');
  for (const n of [1, 2, 10, 20, 30, 80]) for (const s of ['ñ'.repeat(200), '😀'.repeat(100), `a${'😀'.repeat(50)}`]) assert(recortar(s, n).length <= n, `${n}`);
  assert.equal(recortar('Ab😀😀😀', 5), 'Ab😀…'); assert.equal(recortar('Abc😀😀', 5), 'Abc…');
  assert.equal(recortar(' Hot\ncakes \t de  avena ', 30), 'Hot cakes de avena');
  assert.equal(recortar(null, 10), ''); assert.equal(recortar(145, 10), '145');
  assert.equal(recortar('é', 5), 'é', 'NFC: el acento combinado cuenta una letra');
  assert.equal(bloque('Uno.\n\n\n\nDos   tres \n cuatro', 4096), 'Uno.\n\nDos tres\ncuatro');
  assert(bloque('x'.repeat(5000), 4096).length === 4096);
});
await t('precios: «$145», «$7.50», «$1,234», sin centavos desde $10,000; el subtotal con centavos; lo que no cabe se omite (nunca se corta)', () => {
  assert.deepEqual([145, 7.5, 1234, 9999.5, 10000.5, 125000, 0, 0.01].map(precioCorto), ['$145', '$7.50', '$1,234', '$9,999.50', '$10,001', '$125,000', '$0', '$0.01']);
  assert.deepEqual([1450, 0, 1234567.891].map(precioCentavos), ['$1,450.00', '$0.00', '$1,234,567.89']);
  assert.equal(precioQueCabe(1234567, E.end), '$1,234,567');
  assert.equal(precioQueCabe(12345678, E.end), null, '$12,345,678 son 11 letras: no cabe en end.title');
  assert.equal(precioQueCabe(9999.99, E.end), '$9,999.99');
});

// ── Ranuras de la ficha ──────────────────────────────────────────────────
await t('ranuras: una sola variante por grupo (Radio ≤ 8, Dropdown desde 9, Checkbox si máximo > 1); labels de 30 y 20; ayuda; extras', () => {
  assert.equal(MAX_RADIO, 8);
  const ocho = { ...G_PROTEINA, opciones: G_PROTEINA.opciones.slice(0, 8) };
  assert.deepEqual([G_SALSA, ocho, G_PROTEINA, G_GUARNICION, G_EXTRAS].map(varianteDeGrupo), ['r', 'r', 's', 'm', 'm']);
  const largo = { nombre: 'Elige la proteína de tu platillo favorito', minimo: 1, maximo: 1, opciones: G_PROTEINA.opciones };
  const d = datosRanuras([G_SALSA, largo, G_GUARNICION, G_EXTRAS], { 0: [2], 1: [8], 2: [0, 3], 3: [1] });
  const variantes = [0, 1, 2, 3, 4, 5].map((g) => ['radio', 'simple', 'multiple'].filter((v) => d[`g${g}_${v}`]));
  assert.deepEqual(variantes, [['radio'], ['simple'], ['multiple'], ['multiple'], [], []]);
  assert.deepEqual([d.g0_inicial_r, d.g0_inicial_s, d.g1_inicial_s, d.g1_inicial_r, d.g2_inicial_m, d.g3_inicial_m], ['o2', '', 'o8', '', ['o0', 'o3'], ['o1']]);
  assert.deepEqual([d.g1_label.length, d.g1_label_corto.length], [30, 20]);
  assert.deepEqual([d.g0_ayuda, d.g2_ayuda, d.g3_ayuda, d.g4_ayuda], ['Elige 1', 'Elige 1 a 2', 'Opcional · hasta 3', 'Opcional']);
  assert.deepEqual([d.g2_min, d.g2_max, d.g3_min, d.g3_max, d.g0_requerido, d.g3_requerido, d.g4_requerido], [1, 2, 0, 3, true, false, false]);
  assert.deepEqual(d.g3_opciones[0], { id: 'o0', title: 'Aguacate', description: '', metadata: '+$15.50' });
  assert.deepEqual(d.g0_opciones[2].metadata, '+$10'); assert.equal(d.g0_opciones[0].metadata, '');
  assert.deepEqual(d.g5_opciones, [{ id: 'oculto', title: 'No aplica', description: '', metadata: '' }]);
  const nombreLargo = datosRanuras([{ nombre: 'X', minimo: 0, maximo: 1, opciones: [{ nombre: 'Una opción con un nombre de más de treinta letras', precio: 0 }] }]);
  assert.equal(nombreLargo.g0_opciones[0].title.length, 30);
  assert.equal(nombreLargo.g0_opciones[0].description, 'Una opción con un nombre de más de treinta letras', 'el nombre completo va en description');
});

// ── Menú: entradas, páginas y tacos ──────────────────────────────────────
await t('entradas: una por categoría en orden; más de 20 elementos se parten en páginas c0_1, c0_2 (el renglón de tacos cuenta)', () => {
  const foto = fotoTienda();
  assert.deepEqual(entradasMenu(foto).map((e) => [e.id, e.elementos]), [['c0', [0, 1]], ['c1', [2, 3]], ['c2', [null, 4, 5, 6]]]);
  assert.equal(categoriaDeTacos(foto).id, 'c2');
  assert.equal(categoriaDeTacos(foto, { variosTacos: false }), null);
  assert.deepEqual(entradasMenu(foto, { variosTacos: false }).at(-1).elementos, [4, 5, 6]);
  const grande = fotoTienda({ productos: cartaDe([41, 1]), lineas: [] });
  const e = entradasMenu(grande);
  assert.deepEqual(e.map((x) => [x.id, x.pagina, x.paginas, x.elementos.length]), [['c0_1', 0, 3, 20], ['c0_2', 1, 3, 20], ['c0_3', 2, 3, 1], ['c1', 0, 1, 1]]);
  // 20 tacos con lote: 21 elementos con el renglón «Varios tacos a la vez».
  const tacos = fotoTienda({ productos: Array.from({ length: 20 }, (_, i) => producto(`t${i}`, `Taco ${i}`, 30, 'Tacos', [G_TORTILLA])), lineas: [] });
  assert.deepEqual(entradasMenu(tacos).map((x) => [x.id, x.elementos.length, x.elementos[0]]), [['c0_1', 20, null], ['c0_2', 1, 19]]);
});
await t('categoría de 21+ platillos: el MENU muestra «(1/3)» sin cortar el sufijo y cada página llega completa; «categoria» acepta c0_2 y no c0', () => {
  const foto = fotoTienda({ productos: cartaDe([45], { nombre: (c, i) => `Bebida ${i}` }), lineas: [] });
  const { data } = datosMenu(foto, PEDIDO_VACIO, null);
  assert.deepEqual(data.categorias.map((c) => c['main-content'].title), ['Categoría 0 (1/3)', 'Categoría 0 (2/3)', 'Categoría 0 (3/3)']);
  assert.deepEqual(data.categorias.map((c) => listaDe(data, data.categorias.indexOf(c)).payload.platillos.length), [20, 20, 5]);
  assert.equal(listaDe(data, 2).payload.categoria_titulo, 'Categoría 0 (3/3)');
  assert.deepEqual(data.categorias.map((c) => c['main-content'].description), ['20 platillos', '20 platillos', '5 platillos']);
  const largo = fotoTienda({ productos: cartaDe([41], { nombre: () => 'x' }).map((p) => ({ ...p, categoria: 'Bebidas frías y calientes de la casa' })), lineas: [] });
  assert.deepEqual(datosMenu(largo, PEDIDO_VACIO, null).data.categorias.map((c) => c['main-content'].title),
    [1, 2, 3].map((k) => `Bebidas frías y calient… (${k}/3)`));
  exigirForma({ screen: 'MENU', data }, 'MENU 45');
  const b = borradorTienda(foto);
  assert.equal(cambiarTienda(foto, b, dx('MENU', { operacion: 'categoria', categoria: 'c0_2' })).borrador.vista.entrada, 'c0_2');
  assert.equal(cambiarTienda(foto, b, dx('MENU', { operacion: 'categoria', categoria: 'c0' })).error, 'Esa categoría ya no está en el menú.');
  const r = respuestaTienda(foto, { ...b, vista: { pantalla: 'CATEGORIA', entrada: 'c0_3' } }, 'tk');
  assert.deepEqual([r.screen, r.data.platillos.map((p) => p.id)], ['CATEGORIA', ['p40', 'p41', 'p42', 'p43', 'p44']]);
});
await t(`motivoSinTienda: más de ${MAX_RENGLONES_TIENDA} renglones o una cantidad de más de 20 → «Tu carrito» de hoy; producto fuera de la foto; más de 20 entradas`, () => {
  const foto = fotoTienda();
  assert.equal(motivoSinTienda(foto), null); assert(admiteTienda(foto));
  const linea = foto.lineas[1];
  assert.equal(motivoSinTienda({ ...foto, lineas: Array.from({ length: 20 }, (_, i) => ({ ...linea, linea_id: `L${i}` })) }), null, '20 sí');
  assert.equal(motivoSinTienda({ ...foto, lineas: Array.from({ length: 21 }, (_, i) => ({ ...linea, linea_id: `L${i}` })) }), 'renglones');
  assert.equal(motivoSinTienda({ ...foto, lineas: [{ ...linea, cantidad: 21 }] }), 'cantidad');
  assert.equal(motivoSinTienda({ ...foto, lineas: [{ ...linea, cantidad: 0 }] }), 'cantidad');
  assert.equal(motivoSinTienda({ ...foto, lineas: [{ ...linea, ficha: { ...linea.ficha, id: '999' } }] }), 'producto_fuera');
  assert.equal(motivoSinTienda({ ...foto, productos: [] }), 'sin_productos');
  assert.equal(motivoSinTienda(null), 'sin_productos');
  const veinte = fotoTienda({ productos: cartaDe(Array(20).fill(1)), lineas: [] });
  assert.equal(motivoSinTienda(veinte), null);
  assert.equal(motivoSinTienda(fotoTienda({ productos: cartaDe(Array(21).fill(1)), lineas: [] })), 'categorias');
  assert.equal(motivoSinTienda(fotoTienda({ productos: cartaDe([...Array(19).fill(1), 21]), lineas: [] })), 'categorias', '19 + 2 páginas');
  assert.equal(motivoSinTienda({ ...foto, lineas: [] }), null, 'sin renglones también se abre (Arma tu pedido)');
});

// ── MENU ─────────────────────────────────────────────────────────────────
await t('barra «Tu pedido»: vacía, con platillos (total en end) y con lo recién agregado; abre el carrito por el servidor', () => {
  assert.deepEqual(barraPedido(PEDIDO_VACIO)[0], { id: 'pedido', 'main-content': { title: 'Tu pedido', description: 'Vacío',
    metadata: 'Elige una categoría para empezar' }, 'on-click-action': { name: 'data_exchange', payload: { operacion: 'ver_carrito' } } });
  const pedido = { unidades: 1, subtotalCentavos: 1234567, renglones: [{ key: 'n0', nombre: 'Chilaquiles', cantidad: 1 }, { key: 'n1', nombre: 'Café', cantidad: 2 }] };
  assert.deepEqual(barraPedido(pedido)[0]['main-content'], { title: 'Tu pedido', description: '1 platillo', metadata: 'Toca para revisar o continuar' });
  assert.deepEqual(barraPedido(pedido)[0].end, { title: '$12,346' }, 'sin centavos desde $10,000');
  assert.deepEqual(barraPedido({ ...pedido, subtotalCentavos: 999999 })[0].end, { title: '$9,999.99' });
  assert.equal(barraPedido(pedido, { agregado: ['n1'] })[0]['main-content'].metadata, 'Agregaste: 2 × Café');
  assert.equal(barraPedido(pedido, { agregado: ['n0', 'n1'] })[0]['main-content'].metadata, 'Agregaste 2 platillos');
  assert.equal('end' in barraPedido({ ...pedido, subtotalCentavos: 1_234_567_800 })[0], false, 'un total que no cabe no se corta: se omite');
});
await t('MENU: portada de la categoría = cat128 del primer platillo CON foto de esa página (solo esa se pide); «N platillos»; «Desde $X»', () => {
  const foto = fotoTienda(), { vitrina, pedidas } = vitrinaFalsa({ sinFoto: ['10', '12'] });
  const { data, nivel } = datosMenu(foto, PEDIDO_VACIO, vitrina);
  assert.equal(nivel, 0);
  const [des, beb, tac] = data.categorias;
  assert.deepEqual([des.id, des['main-content'], des.start.image.length], ['c0', { title: 'Desayunos', description: '2 platillos', metadata: 'Desde $139' }, 5600]);
  assert.deepEqual(beb['main-content'], { title: 'Bebidas', description: '2 platillos', metadata: 'Desde $45' });
  assert.equal(datosMenu(fotoTienda({ productos: [producto(1, 'Jugo', 55.5, 'Bebidas')], lineas: [] }), PEDIDO_VACIO, null).data.categorias[0]['main-content'].metadata,
    'Desde $55.50');
  assert.equal(tac['main-content'].description, '3 platillos', 'el renglón de tacos no es un platillo');
  const portadas = pedidas.filter((p) => p.endsWith('|cat128'));
  assert.deepEqual(portadas, ['n/productos/11.jpg|cat128', 'n/productos/13.jpg|cat128', 'n/productos/14.jpg|cat128'], 'una por página: Hotcakes (Chilaquiles no tiene foto)');
  assert.deepEqual(new Set(pedidas.map((p) => p.split('|')[1])), new Set(['cat128', 'lista96']));
  // Sin foto en ninguna, sin portada; sin vitrina, ni portadas ni descripciones.
  const sinFotos = datosMenu(foto, PEDIDO_VACIO, vitrinaFalsa({ sinFoto: PRODUCTOS.map((p) => p.id) }).vitrina).data;
  assert(sinFotos.categorias.every((c) => !('start' in c)));
  const sinVitrina = datosMenu(foto, PEDIDO_VACIO, null).data;
  assert(sinVitrina.categorias.every((c) => !('start' in c) && listaDe(sinVitrina, 0).payload.platillos.every((p) => !('start' in p) && !('metadata' in p['main-content']))));
  for (const d of [data, sinFotos, sinVitrina]) exigirForma({ screen: 'MENU', data: d }, 'MENU');
  assert.deepEqual([data.menu_titulo, data.menu_aviso], ['Menú', 'Toca una categoría para ver sus platillos.']);
});
await t('CATEGORIA: platillos con miniatura de 96, metadata de una línea (80), precio en end; sin foto sin start; tacos primero; la barra después', () => {
  const foto = fotoTienda(), larga = `Primera línea.\n\nSegunda   línea ${'x'.repeat(200)}`;
  const { vitrina } = vitrinaFalsa({ sinFoto: ['16'], descripciones: { 14: larga, 15: '' } });
  const { data } = datosMenu(foto, PEDIDO_VACIO, vitrina);
  const tacos = listaDe(data, 2).payload;
  assert.deepEqual(tacos.platillos.map((p) => p.id), ['tacos', 'p4', 'p5', 'p6']);
  // Con `end` («desde» el taco más barato) como los platillos de su lista: el teléfono exige `end` en todos o ninguno (4-oct).
  assert.deepEqual(tacos.platillos[0], { id: 'tacos', 'main-content': { title: 'Varios tacos a la vez', metadata: 'Elige cuántos quieres de cada guiso' },
    end: { title: 'desde $28' }, 'on-click-action': { name: 'data_exchange', payload: { operacion: 'ver_tacos', categoria: 'c2' } } });
  assert(tacos.platillos.every((p) => p.end?.title), 'end en todos los elementos de la lista');
  const [, barbacoa, pastor, especial] = tacos.platillos;
  assert.equal(barbacoa['main-content'].metadata.length, 80); assert.doesNotMatch(barbacoa['main-content'].metadata, /\n/);
  assert(barbacoa['main-content'].metadata.startsWith('Primera línea. Segunda línea x'));
  assert.equal('metadata' in pastor['main-content'], false, 'sin descripción no se manda metadata vacía');
  assert.deepEqual([barbacoa.start.image.length, barbacoa.end.title, 'start' in especial], [3600, '$30', false]);
  assert.deepEqual(barbacoa['on-click-action'], { name: 'data_exchange', payload: { operacion: 'ver', producto: 'p4' } });
  assert.deepEqual([tacos.categoria_titulo, tacos.categoria_aviso, tacos.barra], ['Tacos', 'Toca un platillo para elegir sus opciones.', data.barra]);
  const sinLote = listaDe(datosMenu(foto, PEDIDO_VACIO, vitrina).data, 0);
  assert.equal(sinLote.payload.platillos[0].id, 'p0');
  // La misma CATEGORIA por data_exchange (modo B o «Otros tacos»): igual a la del navigate.
  assert.deepEqual(datosCategoria(foto, 'c2', PEDIDO_VACIO, vitrina), tacos);
  assert.equal(datosCategoria(foto, 'c9', PEDIDO_VACIO, vitrina), null);
});
await t('miniaturas: una de más de 100 KB, vacía o que no es texto no se manda; una caché que lanza no tumba la respuesta; cada una se pide una vez', () => {
  const foto = fotoTienda();
  for (const tamanos of [{ lista96: 100_004, cat128: 100_004 }, { lista96: 0, cat128: 0 }]) {
    const { data } = datosMenu(foto, PEDIDO_VACIO, vitrinaFalsa({ tamanos }).vitrina);
    assert(data.categorias.every((c) => !('start' in c)), JSON.stringify(tamanos));
    assert(data.categorias.every((c) => c['on-click-action'].payload.platillos.every((p) => !('start' in p))));
  }
  for (const valor of [{ base64: 'x' }, [jpegFalso(3600)], 12345, '']) {
    const raro = { ...vitrinaFalsa().vitrina, miniatura: () => valor };
    assert(datosMenu(foto, PEDIDO_VACIO, raro).data.categorias.every((c) => !('start' in c)), JSON.stringify(valor).slice(0, 20));
  }
  const { vitrina } = vitrinaFalsa({ lanza: true });
  const { data } = datosMenu(foto, PEDIDO_VACIO, vitrina);
  assert.equal(data.categorias.length, 3);
  assert.equal(datosPersonalizar(foto, 0, vitrina, { apertura: 'r0.p0' }).con_foto, false);
  // Memo por respuesta: aunque la escalera arme el MENU varias veces, cada llave|variante se pide una vez.
  const { vitrina: v2, pedidas } = vitrinaFalsa({ tamanos: { lista96: 90_000, lista80: 60_000, cat128: 5600 } });
  datosMenu(foto, PEDIDO_VACIO, v2, { presupuesto: 120_000 });
  assert.equal(pedidas.length, new Set(pedidas).size, pedidas.join(','));
});

// ── PERSONALIZAR y EDITAR ────────────────────────────────────────────────
await t('PERSONALIZAR: foto de 480×320 si existe; sin foto, con_foto=false y la imagen de relleno (que el If no dibuja); descripción de la vitrina', () => {
  const foto = fotoTienda(), { vitrina, pedidas } = vitrinaFalsa({ sinFoto: ['11'] });
  const con = datosPersonalizar(foto, 0, vitrina, { apertura: 'r3.p0' });
  assert.deepEqual([con.con_foto, con.foto.length, con.producto, con.apertura, con.boton, con.nombre], [true, 40000, 'p0', 'r3.p0', 'Agregar · desde $145', 'Chilaquiles']);
  assert.deepEqual([con.descripcion, con.con_descripcion, con.precio_texto], ['Descripción de Chilaquiles.', true, 'Precio base $145 · los extras se suman']);
  assert(pedidas.includes('n/productos/10.jpg|ficha480'));
  const sin = datosPersonalizar(foto, 1, vitrina, { apertura: 'r3.p1' });
  assert.deepEqual([sin.con_foto, sin.foto, sin.boton, sin.precio_texto], [false, IMAGEN_VACIA, 'Agregar · $139', '$139']);
  const sinVitrina = datosPersonalizar(foto, 1, null, { apertura: 'r0.p1' });
  assert.deepEqual([sinVitrina.con_foto, sinVitrina.descripcion, sinVitrina.con_descripcion], [false, '', false]);
  // Una ficha que con la foto no cabe en el presupuesto sale sin foto.
  const apretada = datosPersonalizar(foto, 0, vitrina, { apertura: 'r3.p0', presupuesto: 30_000 });
  assert.deepEqual([apretada.con_foto, apretada.foto], [false, IMAGEN_VACIA]);
  for (const d of [con, sin, sinVitrina]) exigirForma({ screen: 'PERSONALIZAR', data: d }, 'PERSONALIZAR');
  assert.equal(botonAgregar({ nombre: 'X', precio: 12345678, grupos: [G_EXTRAS] }), 'Agregar · desde $12,345,678');
});
await t('EDITAR: precargada con el renglón (ids oN de su ficha, cantidad y nota); ignora ids de otro platillo o grupo; con su revisión y fila', () => {
  const foto = fotoTienda(), { vitrina } = vitrinaFalsa();
  const fila = { key: 'n3', item: { producto0: 'p0', cantidad: '4', observaciones: 'sin crema', g0_s: 'p0g0o2', g1_s: 'p1g1o2', g2_m: ['p0g2o0', 'p0g2o9', 'p0g3o1'], g3_m: [] } };
  const d = datosEditar(foto, fila, vitrina, { revision: 8 });
  assert.deepEqual([d.revision, d.fila, d.cantidad_inicial, d.observaciones_inicial], ['8', 'n3', '4', 'sin crema']);
  assert.deepEqual([d.g0_inicial_r, d.g1_inicial_s, d.g2_inicial_m, d.g3_inicial_m], ['o2', '', ['o0'], []]);
  assert.equal(d.con_foto, true);
  exigirForma({ screen: 'EDITAR', data: d }, 'EDITAR');
  const rara = datosEditar(foto, { key: 'e0', item: { producto0: 'p1', cantidad: 'x', observaciones: 7 } }, null, { revision: 0 });
  assert.deepEqual([rara.cantidad_inicial, rara.observaciones_inicial], ['1', '']);
});

// ── CARRITO B ────────────────────────────────────────────────────────────
await t('CARRITO vacío: sin renglones que editar (lista oculta con un renglón de relleno), «Continuar» sin precio, sin deshacer', () => {
  const d = datosCarrito(PEDIDO_VACIO, { revision: 2 });
  assert.deepEqual([d.hay_items, d.filas, d.boton, d.resumen, d.puede_deshacer, d.revision, d.error_visible],
    [false, [{ id: 'ninguna', title: 'Sin platillos', description: '', metadata: '' }], 'Continuar', 'Tu pedido está vacío', false, '2', false]);
  assert.equal(d.renglones_md, 'Aún no tienes platillos. Toca «Seguir pidiendo» para ver el menú.');
  exigirForma({ screen: 'CARRITO', data: d }, 'CARRITO vacío');
  const r = respuestaTienda(fotoTienda({ lineas: [] }), { ...borradorTienda(fotoTienda({ lineas: [] })), vista: { pantalla: 'CARRITO' } }, 'tk');
  assert.deepEqual([r.screen, r.data.hay_items], ['CARRITO', false]);
});
await t('CARRITO: renglones en markdown sin marcas del cliente, «Editar o quitar» con su importe, faltantes, «Continuar · $X» y el aviso de que no es el total', () => {
  const foto = fotoTienda();
  foto.lineas[0].seleccion = [{ grupo: 'Proteína', opcion: 'Pollo' }];
  foto.lineas[0].nota = 'sin *cebolla* _ni_ [chile](http://x)';
  const p = pedidoDelBorrador(foto, borradorTienda(foto));
  const d = datosCarrito(p, { revision: 5, error: 'Algo pasó', puedeDeshacer: true });
  assert.equal(d.renglones_md, '**2 × Chilaquiles** · $290\nPollo · sin cebolla ni chile(http://x) · Falta elegir: Salsa, Guarniciones\n\n**1 × Café americano** · $45');
  assert.deepEqual(d.filas[0], { id: 'e0', title: '2 × Chilaquiles', description: 'Pollo · sin *cebolla* _ni_ [chile](http://x) · Falta elegir: Salsa, Guarniciones', metadata: '$290' });
  assert.deepEqual([d.boton, d.resumen, d.importe], ['Continuar · $335', 'Tu pedido: 3 platillos · $335',
    'Productos: $335.00. Envío y promociones se calculan al revisar; no es el total final.']);
  assert.deepEqual([d.error, d.error_visible, d.puede_deshacer, d.hay_items], ['Algo pasó', true, true, true]);
  exigirForma({ screen: 'CARRITO', data: d }, 'CARRITO');
});
await t('CARRITO: si los renglones no caben en el TextBody van los que caben enteros y «…y N renglones más»; nunca un ** abierto', () => {
  const renglon = (k) => ({ key: `n${k}`, nombre: `Platillo ${k} ${'n'.repeat(150)}`, cantidad: 1, detalle: 'd'.repeat(400), importeCentavos: 100, faltan: [] });
  const renglones = Array.from({ length: 20 }, (_, k) => renglon(k));
  const md = renglonesMarkdown(renglones);
  assert(md.length <= 4096, `${md.length}`);
  const bloques = md.split('\n\n'), cola = bloques.pop();
  assert.match(cola, /^…y \d+ renglones más: los ves en «Editar o quitar»\.$/);
  assert.equal(bloques.length + Number(cola.match(/\d+/)[0]), 20);
  for (const b of bloques) {
    assert.equal((b.match(/\*\*/g) || []).length, 2, 'cada renglón abre y cierra su negrita');
    const [titulo, detalle] = b.split('\n');
    assert(titulo.length <= MAX_NOMBRE_RENGLON + 4 + ' · $1'.length + 2, titulo.length); assert(detalle.length <= MAX_DETALLE_RENGLON);
  }
  // Un renglón mide ~430 letras: con 600 cabe uno y la cola por el otro; con 50, solo la cola.
  assert.equal(renglonesMarkdown(renglones.slice(0, 2), 600), `${renglonesMarkdown(renglones.slice(0, 1))}\n\n…y 1 renglón más: los ves en «Editar o quitar».`);
  assert.equal(renglonesMarkdown(renglones.slice(0, 1), 50), '…y 1 renglón más: los ves en «Editar o quitar».');
  assert.equal(renglonesMarkdown(renglones.slice(0, 2), 2000).split('\n\n').length, 2, 'si caben, van todos y sin cola');
  assert.equal(renglonesMarkdown([{ ...renglon(0), nombre: 'Café', detalle: '' }]), '**1 × Café** · $1');
});
await t('resumen: «Tu pedido: N platillos · $X» en 80 letras', () => {
  assert.equal(resumenDelPedido(PEDIDO_VACIO), 'Tu pedido está vacío');
  assert.equal(resumenDelPedido({ unidades: 1, subtotalCentavos: 14550, renglones: [] }), 'Tu pedido: 1 platillo · $145.50');
});

// ── Escalera de bytes ────────────────────────────────────────────────────
// 4 categorías × 6 platillos con foto: cada peldaño se distingue por el
// tamaño de las imágenes (lista96 3600, lista80 2700, cat128 5600 letras).
const ESCALERA = fotoTienda({ productos: cartaDe([6, 6, 6, 6]), lineas: [] });
const peldaño = (presupuesto, tamanos) => {
  const { vitrina, pedidas } = vitrinaFalsa({ productos: ESCALERA.productos, tamanos });
  return { ...datosMenu(ESCALERA, PEDIDO_VACIO, vitrina, { presupuesto }), pedidas };
};
const imagenesDe = (data) => data.categorias.map((c) => (c['on-click-action'].name === 'navigate'
  ? [...new Set(c['on-click-action'].payload.platillos.map((p) => p.start?.image.length ?? 0))] : 'B'));
await t(`escalera: ${NIVELES_MENU.join(' → ')}; cada peldaño es el primero que cabe y lo que responde cabe en el presupuesto`, () => {
  assert.deepEqual(NIVELES_MENU, ['miniaturas_96', 'miniaturas_80', 'sin_miniaturas_desde_el_final', 'modo_b', 'modo_b_sin_portadas']);
  assert.equal(LIMITES_TIENDA.presupuestoJson, 600_000);
  const tamanos = { lista96: 3600, lista80: 2700, cat128: 5600 };
  const libre = peldaño(Infinity, tamanos);
  assert.deepEqual([libre.nivel, libre.sinMiniaturas, imagenesDe(libre.data)], [0, 0, [[3600], [3600], [3600], [3600]]]);
  assert.equal(libre.bytes, bytesJson({ screen: 'MENU', data: libre.data }));
  // Bajando el presupuesto byte a byte en los umbrales: los peldaños en orden.
  const vistos = [];
  let presupuesto = libre.bytes, anterior = libre;
  for (let k = 0; k < 20 && anterior.nivel < 4; k++) {
    presupuesto = anterior.bytes - 1;
    const r = peldaño(presupuesto, tamanos);
    if (r.nivel < 4) assert(r.bytes <= presupuesto, `${r.nivel}: ${r.bytes} > ${presupuesto}`);
    assert(r.nivel > anterior.nivel || (r.nivel === 2 && r.sinMiniaturas > anterior.sinMiniaturas), `${anterior.nivel}/${anterior.sinMiniaturas} → ${r.nivel}/${r.sinMiniaturas}`);
    vistos.push([r.nivel, r.sinMiniaturas, imagenesDe(r.data)]);
    exigirForma({ screen: 'MENU', data: r.data }, `nivel ${r.nivel}`);
    anterior = r;
  }
  assert.deepEqual(vistos, [
    [1, 0, [[2700], [2700], [2700], [2700]]],
    [2, 1, [[2700], [2700], [2700], [0]]],
    [2, 2, [[2700], [2700], [0], [0]]],
    [2, 3, [[2700], [0], [0], [0]]],
    [2, 4, [[0], [0], [0], [0]]],
    [3, 0, ['B', 'B', 'B', 'B']],
    [4, 0, ['B', 'B', 'B', 'B']],
  ]);
});
await t('escalera: modo B pide cada categoría por data_exchange con su portada; el último peldaño ni portadas; es determinista', () => {
  const tamanos = { lista96: 3600, lista80: 2700, cat128: 5600 };
  // Justo debajo del MENU sin miniaturas de platillo (el último del peldaño 2): modo B.
  const sinMiniaturas = peldaño(Infinity, { lista96: 0, lista80: 0, cat128: 5600 }).bytes;
  const b = peldaño(sinMiniaturas - 1, tamanos);
  assert.equal(b.nivel, 3); assert(b.bytes < sinMiniaturas);
  assert(b.data.categorias.every((c, k) => c.start.image.length === 5600
    && JSON.stringify(c['on-click-action']) === JSON.stringify({ name: 'data_exchange', payload: { operacion: 'categoria', categoria: `c${k}` } })));
  const sin = peldaño(1000, tamanos);
  assert.equal(sin.nivel, 4); assert(sin.data.categorias.every((c) => !('start' in c)));
  assert.deepEqual(peldaño(sinMiniaturas - 1, tamanos).data, b.data, 'misma entrada, mismo MENU');
  // Los de 80 se piden solo al llegar a ese peldaño (no se precalientan).
  assert.equal(peldaño(Infinity, tamanos).pedidas.some((p) => p.endsWith('|lista80')), false);
  assert(peldaño(peldaño(Infinity, tamanos).bytes - 1, tamanos).pedidas.some((p) => p.endsWith(`|${MINIATURA.listaChica}`)));
  // En modo B la categoría llega por data_exchange con su propia escalera.
  const { vitrina } = vitrinaFalsa({ productos: ESCALERA.productos, tamanos });
  const completa = bytesJson({ screen: 'CATEGORIA', data: datosCategoria(ESCALERA, 'c0', PEDIDO_VACIO, vitrina) });
  const de80 = datosCategoria(ESCALERA, 'c0', PEDIDO_VACIO, vitrina, { presupuesto: completa - 1 });
  assert.deepEqual([...new Set(de80.platillos.map((p) => p.start?.image.length))], [2700]);
  const sinImagen = datosCategoria(ESCALERA, 'c0', PEDIDO_VACIO, vitrina, { presupuesto: 2000 });
  assert(sinImagen.platillos.every((p) => !('start' in p)));
});
await t('presupuesto real (600 KB) con la forma de Obispado (91 platillos, 12 categorías): ligeras caben enteras; pesadas bajan peldaños y caben', () => {
  const forma = [6, 3, 3, 4, 4, 5, 12, 3, 1, 12, 3, 20];
  const foto = fotoTienda({ productos: cartaDe(forma, { nombre: (c, i) => `Platillo ${c}.${i} con un nombre de cuarenta`.padEnd(40, '·'), precio: (c, i) => 9999.5 + i }), lineas: [] });
  const descripciones = Object.fromEntries(foto.productos.map((p) => [p.id, `Descripción ${p.id}. `.padEnd(120, 'x')]));
  const medir = (tamanos) => datosMenu(foto, PEDIDO_VACIO, vitrinaFalsa({ productos: foto.productos, tamanos, descripciones }).vitrina);
  const ligera = medir({ lista96: 3600, lista80: 2700, cat128: 5600 });
  assert.equal(ligera.nivel, 0); assert(ligera.bytes <= 600_000, `${ligera.bytes}`);
  const pesada = medir({ lista96: 9000, lista80: 6000, cat128: 9500 });
  assert(pesada.nivel >= 1 && pesada.nivel <= 2, `nivel ${pesada.nivel}`); assert(pesada.bytes <= 600_000, `${pesada.bytes}`);
  const enorme = medir({ lista96: 60_000, lista80: 60_000, cat128: 60_000 });
  assert(enorme.bytes <= 600_000 && enorme.nivel >= 2, `${enorme.nivel} ${enorme.bytes}`);
  for (const r of [ligera, pesada, enorme]) exigirForma({ screen: 'MENU', data: r.data }, `Obispado nivel ${r.nivel}`);
});

// ── Carta hostil: toda pantalla pasa el validador del Flow ────────────────
await t('carta hostil (nombres de 200 con emoji y markdown, precios de 8 cifras, 45 platillos en una categoría, notas de 300, 20 renglones): cada respuesta cabe en su Flow', () => {
  const nombre = (k) => `**${k}** Platillo _con_ ~nombre~ 😀 ${'muy largo '.repeat(20)}`;
  const grupos = [{ nombre: 'Un grupo con un nombre largo de cincuenta letras xx', minimo: 1, maximo: 1,
    opciones: Array.from({ length: 12 }, (_, i) => ({ nombre: `Opción ${i} con un nombre larguísimo de sesenta letras para cortar`, precio: 1234.5 })) },
  { nombre: 'Extras', minimo: 0, maximo: 20, opciones: Array.from({ length: 20 }, (_, i) => ({ nombre: `Extra ${i} 😀😀😀😀😀😀😀😀😀😀😀😀😀😀`, precio: 99999.99 })) },
  G_SALSA, G_GUARNICION, G_EXTRAS, { ...G_SALSA, nombre: 'Salsa extra' }];
  const productos = [
    ...Array.from({ length: 45 }, (_, i) => producto(`a${i}`, nombre(i), i % 2 ? 12345678 : 0.5, `Desayunos 😀 con un nombre larguísimo de la casa para cortar en la lista ${'x'.repeat(40)}`, i < 3 ? grupos : [])),
    ...Array.from({ length: 13 }, (_, i) => producto(`t${i}`, nombre(i), 30, 'TACOS', [G_TORTILLA])),
    producto('z', 'Café', 45, 'Bebidas'),
  ];
  const ficha = (p) => ({ id: p.id, nombre: p.nombre, precio: p.precio, grupos: p.grupos });
  const lineas = Array.from({ length: 20 }, (_, i) => ({ linea_id: `L${i}`, cantidad: 20, ficha: ficha(productos[i % 3]), nota: `${'n'.repeat(290)} *x*`,
    seleccion: [{ grupo: grupos[0].nombre, opcion: grupos[0].opciones[11].nombre }, ...grupos[1].opciones.map((o) => ({ grupo: 'Extras', opcion: o.nombre }))] }));
  const foto = fotoTienda({ productos, lineas });
  assert.equal(motivoSinTienda(foto), null);
  const descripciones = Object.fromEntries(productos.map((p) => [p.id, `# Título\n\n${'Descripción *muy* larga. '.repeat(300)}`]));
  const { vitrina } = vitrinaFalsa({ productos, descripciones, tamanos: { lista96: 3600, lista80: 2700, cat128: 5600, ficha480: 60_000 } });
  const error = 'Un error larguísimo. '.repeat(400);
  const b = borradorTienda(foto), r = (vista, err = error) => respuestaTienda(foto, { ...b, vista }, 'tk', err, null, vitrina);
  const pantallas = [r({ pantalla: 'MENU' }), r({ pantalla: 'MENU' }, ''), r({ pantalla: 'CARRITO' }), r({ pantalla: 'TACOS', categoria: 'c1' })];
  for (const e of entradasMenu(foto)) pantallas.push(r({ pantalla: 'CATEGORIA', entrada: e.id }));
  for (let i = 0; i < productos.length; i += 7) pantallas.push(r({ pantalla: 'PERSONALIZAR', producto: `p${i}`, apertura: `r0.p${i}` }));
  for (const f of b.filas.slice(0, 3)) pantallas.push(r({ pantalla: 'EDITAR', fila: f.key }));
  const entrega = { ...b, etapa: 'ENTREGA', vista: { pantalla: 'ENTREGA' } };
  pantallas.push(respuestaTienda(foto, entrega, 'tk', error, null, vitrina), respuestaTienda(foto, { ...entrega, etapa: 'DIRECCION', vista: { pantalla: 'DIRECCION' } }, 'tk', error, null, vitrina));
  assert.deepEqual([...new Set(pantallas.map((x) => x.screen))].sort(), ['CARRITO', 'CATEGORIA', 'DIRECCION', 'EDITAR', 'ENTREGA', 'MENU', 'PERSONALIZAR', 'TACOS']);
  for (const p of pantallas) exigirForma(p, p.screen);
  // Lo que se cortó, se cortó con «…» y el precio que no cabe no aparece: como el
  // `end` va en todos o en ninguno [M], esa lista entera va sin precio a la derecha.
  const menu = pantallas[0].data, platillos = menu.categorias[0]['on-click-action'].payload.platillos;
  assert(menu.categorias[0]['main-content'].title.endsWith('… (1/3)'));
  assert.equal(platillos[1]['main-content'].title.length, 30);
  assert.equal('end' in platillos[1], false, '$12,345,678 no cabe en end.title: se omite');
  assert.equal(platillos.some((p) => 'end' in p), false, 'y entonces ninguno de su lista lleva end');
  // En una lista donde todos caben, todos lo llevan (los tacos, con «desde»).
  const tacosHostil = pantallas.find((x) => x.screen === 'CATEGORIA' && x.data.platillos[0]?.id === 'tacos').data.platillos;
  assert.deepEqual([tacosHostil[0].end.title, tacosHostil.every((p) => p.end)], ['desde $30', true]);
  assert.equal(pantallas[0].data.menu_aviso.length, 300);
});

console.log(`RESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas} (catálogo tienda)`);
process.exit(fallidas ? 1 : 0);
