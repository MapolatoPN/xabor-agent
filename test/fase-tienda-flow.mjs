// Formulario «tienda» (tienda_v1), Fase 2 parte A: el borrador del endpoint
// (src/mesero-agente/flowTienda.js). Pura: sin base de datos, Meta ni red.
//
// Garantías que prueba:
//   forma       el borrador es el de carrito_v1 (filas eN/nN con su item):
//               las mismas acciones dan las mismas filas y el MISMO recibo
//               (comandosCarrito), también al editar, quitar, tacos y entrega
//   lectura     ver, ver_tacos, ver_carrito, editar, seguir y categoria no
//               escriben el borrador ni exigen la revisión
//   agregar     no exige la revisión; la apertura r{revision}.p{N} de «ver» es
//               de un solo uso (las últimas 20) y lo anterior a ellas se rechaza
//   revisión    aplicar, quitar, deshacer, continuar y los tacos la exigen
//   delegado    ENTREGA, DIRECCION y su Atrás son los de carrito_v1
//   A1          después de «Agregar» responde el MENU fresco
//   límites     20 renglones; cada respuesta tiene la forma que el Flow declara
//   aislado     Fase 2A no conecta nada: con la bandera apagada todo es igual
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { borradorTienda, cambiarTienda, respuestaTienda, itemDeFicha, pedidoDelBorrador, textoFaltantesTienda, productoDeLaFoto,
  ETAPAS_TIENDA, PANTALLAS_TIENDA, SOLO_LECTURA, MAX_APERTURAS } from '../src/mesero-agente/flowTienda.js';
import { borradorCarrito, cambiarCarrito, respuestaCarrito, comandosCarrito } from '../src/mesero-agente/flowCarrito.js';
import { MAX_RENGLONES_TIENDA, precioCentavos } from '../src/mesero-agente/catalogoFlowTienda.js';
import { fotoTienda, comoCarrito, vitrinaFalsa, exigirForma, dx, atras, INIT, RANURAS_VACIAS, sinVista } from './lib-fixtures-tienda.mjs';
import { definicionFlowTienda } from '../scripts/definicion-flow-tienda.mjs';

let pasadas = 0, fallidas = 0;
const t = async (nombre, fn) => {
  try { await fn(); pasadas++; console.log(`  ok  ${nombre}`); } catch (e) { fallidas++; console.log(`FALLA ${nombre}: ${e.message}`); }
};

/**
 * Una sesión como la ve el adaptador SQL: guarda el borrador solo si cambió la
 * revisión, y dibuja con lo que devolvió cambiarTienda. Cada respuesta se
 * exige con la forma del Flow; lo que no escribe no cambia nada del borrador.
 */
function sesion(foto = fotoTienda(), { vitrina = vitrinaFalsa().vitrina, b = null } = {}) {
  const s = { foto, b: b || borradorTienda(foto), escrituras: 0 };
  s.paso = (sol) => {
    const antes = s.b, r = cambiarTienda(foto, antes, sol);
    const resp = respuestaTienda(foto, r.borrador, 'tk', r.error || '', sol?.data ?? null, vitrina);
    exigirForma(resp, `${sol?.screen}/${sol?.data?.operacion}`);
    const escrito = r.borrador.revision !== antes.revision;
    if (escrito) { assert.equal(r.borrador.revision, antes.revision + 1, 'una escritura sube la revisión en 1'); s.escrituras++; s.b = r.borrador; }
    else assert.deepEqual(sinVista(r.borrador), sinVista(antes), 'lo que no escribe no cambia el borrador');
    return { error: r.error, resp, escrito, borrador: r.borrador };
  };
  s.rev = () => String(s.b.revision);
  /** ver + agregar con la apertura que dio «ver». */
  s.agregar = (producto, eleccion = {}) => {
    const v = s.paso(dx('CATEGORIA', { operacion: 'ver', producto }));
    assert.equal(v.resp.screen, 'PERSONALIZAR', v.error);
    return s.paso(dx('PERSONALIZAR', { operacion: 'agregar', apertura: v.resp.data.apertura, producto, ...RANURAS_VACIAS, cantidad: '1', observaciones: '', ...eleccion }));
  };
  return s;
}
// La elección completa de Chilaquiles (p0): Salsa Roja (Radio), Arrachera (Dropdown), dos guarniciones, un extra.
const CHILAQUILES = { g0_r: 'o0', g1_s: 'o8', g2_m: ['o0', 'o2'], g3_m: ['o1'], cantidad: '3', observaciones: 'bien dorados' };
const DIRECCION = { operacion: 'direccion', zona: 'zn', calle: 'Hidalgo 405', colonia: 'Centro', referencias: '' };
const ordenar = (v) => (Array.isArray(v) ? v.map(ordenar) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, ordenar(v[k])])) : v);
const normal = (filas) => filas.map((f) => ({ key: f.key, item: ordenar(Object.fromEntries(Object.entries(f.item)
  .filter(([, v]) => v !== undefined && v !== null && v !== '' && (!Array.isArray(v) || v.length)))) }));

// ── El borrador ──────────────────────────────────────────────────────────
await t('borrador inicial: el de carrito_v1 (filas eN, siguiente, deshacer, índices de entrega y pago) con la etapa TIENDA y sin aperturas', () => {
  const foto = fotoTienda(), b = borradorTienda(foto), c = borradorCarrito(comoCarrito(foto));
  assert.deepEqual({ ...b, etapa: 'CARRITO', aperturas: undefined }, { ...c, aperturas: undefined });
  assert.deepEqual([b.etapa, b.aperturas, b.revision], ['TIENDA', [], 0]);
  assert.deepEqual(b.filas.map((f) => f.key), ['e0', 'e1']);
  assert.deepEqual(b.filas[0].item, { producto0: 'p0', cantidad: '2', observaciones: 'Sin cebolla', g0_s: 'p0g0o1', g1_s: 'p0g1o2', g2_m: ['p0g2o0', 'p0g2o1'], g3_m: [] });
  assert.deepEqual(ETAPAS_TIENDA, ['TIENDA', 'ENTREGA', 'DIRECCION', 'FINAL']);
  // «Escribir dirección»: abre en DIRECCION, como carrito_v1.
  const dir = fotoTienda({ abrir: 'DIRECCION', modalidad: 'entrega a domicilio', pago: 'efectivo' });
  assert.equal(borradorTienda(dir).etapa, 'DIRECCION');
  assert.deepEqual([borradorTienda(dir).modalidad, borradorTienda(dir).pago], [1, 0]);
});
await t('INIT: abre en el MENU; con abrir=CARRITO y renglones, en el carrito; en DIRECCION si así se pidió; FINAL es SUCCESS', () => {
  const s = sesion();
  let r = s.paso(INIT);
  assert.deepEqual([r.resp.screen, r.escrito], ['MENU', false]);
  r = sesion(fotoTienda({ abrir: 'CARRITO' })).paso(INIT);
  assert.equal(r.resp.screen, 'CARRITO');
  assert.equal(sesion(fotoTienda({ abrir: 'CARRITO', lineas: [] })).paso(INIT).resp.screen, 'MENU', 'sin renglones no hay carrito que abrir');
  const dir = fotoTienda({ abrir: 'DIRECCION', modalidad: 'entrega a domicilio', pago: 'efectivo' });
  r = sesion(dir).paso(INIT);
  assert.deepEqual([r.resp.screen, r.escrito], ['DIRECCION', false]);
  const fin = sesion(fotoTienda(), { b: { ...borradorTienda(fotoTienda()), etapa: 'FINAL', revision: 7 } });
  r = fin.paso(INIT);
  assert.deepEqual(r.resp, { screen: 'SUCCESS', data: { extension_message_response: { params: { flow_token: 'tk', revision: '7' } } } });
  assert.equal(fin.paso(dx('MENU', { operacion: 'ver_carrito' })).resp.screen, 'SUCCESS', 'FINAL no se vuelve a abrir');
});
await t('INIT retomado a medio cierre (ENTREGA o DIRECCION sin «Escribir dirección»): vuelve al carrito y sube la revisión, como carrito_v1', () => {
  for (const etapa of ['ENTREGA', 'DIRECCION']) {
    const s = sesion(fotoTienda(), { b: { ...borradorTienda(fotoTienda()), etapa, revision: 4, modalidad: 'm1', pago: 'p0' } });
    const r = s.paso(INIT);
    assert.deepEqual([r.resp.screen, r.escrito, s.b.etapa, s.b.revision], ['CARRITO', true, 'TIENDA', 5], etapa);
    assert.deepEqual([s.b.modalidad, s.b.pago], ['m1', 'p0'], 'lo elegido se conserva');
  }
  const vacio = sesion(fotoTienda({ lineas: [] }), { b: { ...borradorTienda(fotoTienda({ lineas: [] })), etapa: 'ENTREGA', revision: 2 } });
  assert.equal(vacio.paso(INIT).resp.screen, 'MENU', 'sin renglones, al menú');
});

// ── Solo lectura ─────────────────────────────────────────────────────────
await t('solo lectura: ver, ver_tacos, ver_carrito, editar, seguir y categoria no escriben ni exigen revisión (ni con una vieja)', () => {
  assert.deepEqual([...SOLO_LECTURA].sort(), ['categoria', 'editar', 'seguir', 'ver', 'ver_carrito', 'ver_tacos']);
  const s = sesion();
  s.agregar('p1'); // revisión 1
  const casos = [
    [dx('CATEGORIA', { operacion: 'ver', producto: 'p0' }), 'PERSONALIZAR'],
    [dx('CATEGORIA', { operacion: 'ver_tacos', categoria: 'c2' }), 'TACOS'],
    [dx('CATEGORIA', { operacion: 'ver_carrito' }), 'CARRITO'],
    [dx('MENU', { operacion: 'ver_carrito' }), 'CARRITO'],
    [dx('CARRITO', { operacion: 'editar', fila: 'e0' }), 'EDITAR'],
    [dx('CARRITO', { operacion: 'seguir' }), 'MENU'],
    [dx('MENU', { operacion: 'categoria', categoria: 'c1' }), 'CATEGORIA'],
  ];
  for (const [sol, pantalla] of casos) {
    const r = s.paso(sol);
    assert.deepEqual([r.error, r.resp.screen, r.escrito], [undefined, pantalla, false], `${sol.screen}/${sol.data.operacion}`);
  }
  assert.equal(s.escrituras, 1);
  // Una clave «revision» no es parte de estas operaciones: se rechaza, no se usa.
  assert.equal(s.paso(dx('CARRITO', { operacion: 'seguir', revision: '0' })).error, 'Selección no disponible.');
});
await t('ver: la ficha trae la apertura r{revision}.p{N} (determinista) y el botón «Agregar · desde $X»; editar la trae precargada', () => {
  const s = sesion();
  let r = s.paso(dx('CATEGORIA', { operacion: 'ver', producto: 'p0' }));
  assert.deepEqual([r.resp.data.apertura, r.resp.data.producto, r.resp.data.boton], ['r0.p0', 'p0', 'Agregar · desde $145']);
  assert.equal(s.paso(dx('CATEGORIA', { operacion: 'ver', producto: 'p0' })).resp.data.apertura, 'r0.p0', 'misma revisión, misma apertura');
  assert.equal(s.paso(dx('CATEGORIA', { operacion: 'ver', producto: 'p1' })).resp.data.boton, 'Agregar · $139');
  s.agregar('p1');
  assert.equal(s.paso(dx('CATEGORIA', { operacion: 'ver', producto: 'p0' })).resp.data.apertura, 'r1.p0');
  r = s.paso(dx('CARRITO', { operacion: 'editar', fila: 'e0' }));
  assert.deepEqual([r.resp.data.fila, r.resp.data.revision, r.resp.data.cantidad_inicial, r.resp.data.observaciones_inicial],
    ['e0', '1', '2', 'Sin cebolla']);
  assert.deepEqual([r.resp.data.g0_inicial_r, r.resp.data.g1_inicial_s, r.resp.data.g2_inicial_m], ['o1', 'o2', ['o0', 'o1']]);
});
await t('lectura con datos que no existen: error en la pantalla de origen y nada se escribe', () => {
  const s = sesion();
  const casos = [
    [dx('CATEGORIA', { operacion: 'ver', producto: 'p99' }), 'MENU', 'Ese platillo ya no está disponible.'],
    [dx('CATEGORIA', { operacion: 'ver', producto: 'p01' }), 'MENU', 'Ese platillo ya no está disponible.'],
    [dx('CATEGORIA', { operacion: 'ver', producto: 3 }), 'MENU', 'Ese platillo ya no está disponible.'],
    [dx('CATEGORIA', { operacion: 'ver_tacos', categoria: 'c0' }), 'MENU', 'Selección no disponible.'],
    [dx('MENU', { operacion: 'categoria', categoria: 'c9' }), 'MENU', 'Esa categoría ya no está en el menú.'],
    [dx('CARRITO', { operacion: 'editar', fila: 'n7' }), 'CARRITO', 'Ese platillo ya no está en tu pedido.'],
  ];
  for (const [sol, pantalla, error] of casos) {
    const r = s.paso(sol);
    assert.deepEqual([r.error, r.resp.screen, r.escrito], [error, pantalla, false], JSON.stringify(sol.data));
  }
  // El error se ve: en el MENU va en la descripción de la lista.
  assert.equal(s.paso(casos[0][0]).resp.data.menu_aviso, 'Ese platillo ya no está disponible.');
});
await t('operación de otra pantalla, clave de más, pantalla desconocida o data que no es objeto: se rechaza sin escribir', () => {
  const s = sesion();
  const casos = [
    [dx('MENU', { operacion: 'ver', producto: 'p0' }), 'Acción no disponible.'],
    [dx('CARRITO', { operacion: 'agregar', apertura: 'r0.p0', producto: 'p0' }), 'Acción no disponible.'],
    [dx('PERSONALIZAR', { operacion: 'continuar', revision: '0' }), 'Acción no disponible.'],
    [dx('CATEGORIA', { operacion: 'ver', producto: 'p0', precio: '1' }), 'Selección no disponible.'],
    [dx('PERSONALIZAR', { operacion: 'agregar', apertura: 'r0.p1', producto: 'p1', ...RANURAS_VACIAS, cantidad: '1', observaciones: '', total: '0' }), 'Selección no disponible.'],
    [dx('EDITAR', { operacion: 'aplicar', revision: '0', fila: 'e1', ...RANURAS_VACIAS, cantidad: '1', observaciones: '', precio: '1' }), 'Selección no disponible.'],
    [dx('PAGO', { operacion: 'ver_carrito' }), 'Ventana no disponible.'],
    [dx('MENU', null), 'No pude leer la selección. Intenta de nuevo.'],
    [dx('MENU', ['ver_carrito']), 'No pude leer la selección. Intenta de nuevo.'],
    [{ action: 'ping' }, 'No pude leer la selección. Intenta de nuevo.'],
    [null, 'No pude leer la selección. Intenta de nuevo.'],
  ];
  for (const [sol, error] of casos) {
    const r = s.paso(sol);
    assert.deepEqual([r.error, r.escrito], [error, false], JSON.stringify(sol));
  }
  assert.equal(s.escrituras, 0);
  assert.deepEqual(PANTALLAS_TIENDA, ['MENU', 'CATEGORIA', 'PERSONALIZAR', 'TACOS', 'CARRITO', 'EDITAR']);
});

// ── Agregar ──────────────────────────────────────────────────────────────
await t('agregar: escribe la fila nN con la forma de carrito_v1 y responde el MENU fresco (A1) con «Tu pedido» al día', () => {
  const s = sesion();
  const r = s.agregar('p0', CHILAQUILES);
  assert.deepEqual([r.error, r.escrito, r.resp.screen], [undefined, true, 'MENU']);
  assert.deepEqual(s.b.filas.at(-1), { key: 'n0', item: { producto0: 'p0', cantidad: '3', observaciones: 'bien dorados',
    g0_s: 'p0g0o0', g1_s: 'p0g1o8', g2_m: ['p0g2o0', 'p0g2o2'], g3_m: ['p0g3o1'] } });
  assert.deepEqual([s.b.siguiente, s.b.aperturas, s.b.etapa], [1, ['r0.p0'], 'TIENDA']);
  const [barra] = r.resp.data.barra;
  // 2 Chilaquiles + 1 Café + 3 Chilaquiles nuevos; $290 + $45 + 3 × (145 + 30 + 12) = $896
  assert.deepEqual(barra['main-content'], { title: 'Tu pedido', description: '6 platillos', metadata: 'Agregaste: 3 × Chilaquiles' });
  assert.deepEqual(barra.end, { title: '$896' });
  assert.deepEqual(barra['on-click-action'], { name: 'data_exchange', payload: { operacion: 'ver_carrito' } });
  // El MENU fresco es el del INIT: mismas categorías y la barra copiada en cada una.
  const init = sesion().paso(INIT).resp.data;
  assert.deepEqual(r.resp.data.categorias.map((c) => c.id), init.categorias.map((c) => c.id));
  assert(r.resp.data.categorias.every((c) => JSON.stringify(c['on-click-action'].payload.barra) === JSON.stringify(r.resp.data.barra)));
});
await t('agregar no exige la revisión: una ficha abierta antes de otro cambio todavía agrega (es un alta)', () => {
  const s = sesion();
  const ficha = s.paso(dx('CATEGORIA', { operacion: 'ver', producto: 'p1' })).resp.data.apertura;
  s.agregar('p2'); s.paso(dx('EDITAR', { operacion: 'quitar', revision: s.rev(), fila: 'e1' }));
  assert.equal(s.b.revision, 2);
  const r = s.paso(dx('PERSONALIZAR', { operacion: 'agregar', apertura: ficha, producto: 'p1', ...RANURAS_VACIAS, cantidad: '2', observaciones: '' }));
  assert.deepEqual([r.error, r.escrito, s.b.filas.at(-1).item.producto0, s.b.filas.at(-1).item.cantidad], [undefined, true, 'p1', '2']);
});
await t('aperturas: la misma apertura dos veces (doble toque o Atrás hasta la ficha) no duplica: «Ya está en tu pedido»', () => {
  const s = sesion();
  const apertura = s.paso(dx('CATEGORIA', { operacion: 'ver', producto: 'p1' })).resp.data.apertura;
  const sol = dx('PERSONALIZAR', { operacion: 'agregar', apertura, producto: 'p1', ...RANURAS_VACIAS, cantidad: '1', observaciones: '' });
  assert.equal(s.paso(sol).escrito, true);
  const filas = structuredClone(s.b.filas);
  for (let k = 0; k < 3; k++) {
    const r = s.paso(sol);
    assert.deepEqual([r.error, r.escrito, r.resp.screen], [undefined, false, 'MENU']);
    assert.equal(r.resp.data.menu_aviso, 'Ya está en tu pedido: Hotcakes. Revísalo en «Tu pedido».');
  }
  assert.deepEqual(s.b.filas, filas);
  // Una apertura nueva (otra revisión) del mismo platillo sí es otro renglón.
  assert.equal(s.agregar('p1').escrito, true);
  assert.equal(s.b.filas.filter((f) => f.item.producto0 === 'p1').length, 2);
  // Quitados los dos, la ficha vieja tampoco lo agrega, y el aviso no dice que «ya está».
  for (const f of s.b.filas.filter((x) => x.item.producto0 === 'p1')) s.paso(dx('EDITAR', { operacion: 'quitar', revision: s.rev(), fila: f.key }));
  const r = s.paso(sol);
  assert.deepEqual([r.escrito, r.resp.data.menu_aviso], [false, 'Ya agregaste Hotcakes desde esa ficha y después lo quitaste. Para pedirlo otra vez, elígelo en el menú.']);
});
await t('aperturas que no salieron de «ver»: de una revisión futura, de otro platillo, mal formadas o ausentes, se rechazan', () => {
  const s = sesion();
  const base = { operacion: 'agregar', producto: 'p1', ...RANURAS_VACIAS, cantidad: '1', observaciones: '' };
  for (const apertura of ['r1.p1', 'r0.p2', 'r00.p1', 'r0.p01', 'r-1.p1', 'r0p1', '', 7, undefined]) {
    const r = s.paso(dx('PERSONALIZAR', { ...base, apertura }));
    assert.deepEqual([r.error, r.escrito, r.resp.screen], ['La ventana cambió. Elige el platillo otra vez.', false, 'MENU'], String(apertura));
  }
  const r = s.paso(dx('PERSONALIZAR', { ...base, producto: 'p99', apertura: 'r0.p99' }));
  assert.deepEqual([r.error, r.escrito], ['La ventana cambió. Elige el platillo otra vez.', false]);
  assert.equal(s.escrituras, 0);
});
await t(`aperturas: se recuerdan las últimas ${MAX_APERTURAS}; una anterior a ellas se rechaza en vez de agregarse otra vez`, () => {
  assert.equal(MAX_APERTURAS, 20);
  const s = sesion(fotoTienda({ lineas: [] }));
  const vieja = s.paso(dx('CATEGORIA', { operacion: 'ver', producto: 'p1' })).resp.data.apertura;
  const solVieja = dx('PERSONALIZAR', { operacion: 'agregar', apertura: vieja, producto: 'p1', ...RANURAS_VACIAS, cantidad: '1', observaciones: '' });
  assert.equal(s.paso(solVieja).escrito, true);
  const usadas = [vieja];
  // 21 altas más (quitando cada una para no llegar al tope de renglones).
  for (let k = 0; k < MAX_APERTURAS + 1; k++) {
    const r = s.agregar('p2');
    usadas.push(s.b.aperturas.at(-1));
    assert(r.escrito);
    s.paso(dx('EDITAR', { operacion: 'quitar', revision: s.rev(), fila: s.b.filas.at(-1).key }));
    assert(s.b.aperturas.length <= MAX_APERTURAS);
    assert(s.b.deshacer.length <= 10, 'deshacer recuerda 10 cambios, como carrito_v1');
  }
  assert.deepEqual(s.b.aperturas, usadas.slice(-MAX_APERTURAS));
  assert(s.b.apertura_minima > 0, 'subió la revisión mínima');
  // La primera ya no está en la lista: reenviarla NO agrega otro Hotcakes.
  const r = s.paso(solVieja);
  assert.deepEqual([r.error, r.escrito], ['La ventana cambió. Elige el platillo otra vez.', false]);
  assert.equal(s.b.filas.filter((f) => f.item.producto0 === 'p1').length, 1);
  // Una que sigue en la lista se reconoce (y como se quitó, el aviso lo dice).
  const reciente = usadas.at(-1);
  const otra = s.paso(dx('PERSONALIZAR', { operacion: 'agregar', apertura: reciente, producto: 'p2', ...RANURAS_VACIAS, cantidad: '1', observaciones: '' }));
  assert.deepEqual([otra.escrito, otra.error, otra.resp.data.menu_aviso.startsWith('Ya agregaste Café americano desde esa ficha')], [false, undefined, true]);
  // Una ficha abierta ahora sí agrega.
  assert.equal(s.agregar('p1').escrito, true);
});
await t('agregar valida la ficha como el recibo: variante estricta, opciones de su grupo, sin repetir, tope, faltantes con nombre', () => {
  const s = sesion();
  const ap = s.paso(dx('CATEGORIA', { operacion: 'ver', producto: 'p0' })).resp.data.apertura;
  const intento = (eleccion) => s.paso(dx('PERSONALIZAR', { operacion: 'agregar', apertura: ap, producto: 'p0', ...RANURAS_VACIAS, ...CHILAQUILES, ...eleccion }));
  const casos = [
    [{ g0_r: '', g0_s: 'o0' }, 'Selección no disponible.'], // Salsa se dibuja como Radio
    [{ g1_s: '', g1_r: 'o1' }, 'Selección no disponible.'], // Proteína (9) es Dropdown
    [{ g2_m: 'o0' }, 'Selección no disponible.'],
    [{ g0_r: ['o0'] }, 'Selección no disponible.'],
    [{ g0_r: 'o3' }, 'Selección no disponible.'],
    [{ g0_r: 'p0g0o0' }, 'Selección no disponible.'],
    [{ g2_m: ['o0', 'o0'] }, 'Selección no disponible.'],
    [{ g2_m: ['o0', 1] }, 'Selección no disponible.'],
    [{ g4_r: 'o0' }, 'Selección no disponible.'], // ranura sin grupo
    [{ g5_m: ['o0'] }, 'Selección no disponible.'],
    [{ g2_m: ['o0', 'o1', 'o2'] }, 'En Guarniciones elige hasta 2.'],
    [{ g0_r: '', g1_s: '' }, 'Falta elegir Salsa y Proteína para este platillo.'],
    [{ g2_m: [] }, 'Falta elegir Guarniciones para este platillo.'],
    [{ cantidad: '0' }, 'Elige la cantidad del platillo.'],
    [{ cantidad: '21' }, 'Elige la cantidad del platillo.'],
    [{ cantidad: 2 }, 'Elige la cantidad del platillo.'],
    [{ observaciones: 'x'.repeat(301) }, 'Usa hasta 300 caracteres de texto en la nota para cocina.'],
    [{ observaciones: 'hola\u0007' }, 'Usa hasta 300 caracteres de texto en la nota para cocina.'],
  ];
  for (const [eleccion, error] of casos) {
    const r = intento(eleccion);
    assert.deepEqual([r.error, r.escrito, r.resp.screen], [error, false, 'PERSONALIZAR'], JSON.stringify(eleccion));
    assert.equal(r.resp.data.apertura, ap, 'la ficha conserva su apertura');
  }
  // El error conserva lo elegido en ese intento.
  const r = intento({ g2_m: [], cantidad: '4', observaciones: 'sin crema' });
  assert.deepEqual([r.resp.data.g0_inicial_r, r.resp.data.g1_inicial_s, r.resp.data.cantidad_inicial, r.resp.data.observaciones_inicial, r.resp.data.error_visible],
    ['o0', 'o8', '4', 'sin crema', true]);
  assert.equal(s.escrituras, 0);
  // Lo de un intento con OTRA apertura (otra ficha u otra revisión) no se copia.
  const ajena = respuestaTienda(s.foto, { ...s.b, vista: { pantalla: 'PERSONALIZAR', producto: 'p0', apertura: ap } }, 'tk', 'x',
    { ...CHILAQUILES, apertura: 'r9.p0', cantidad: '7' });
  assert.deepEqual([ajena.data.g0_inicial_r, ajena.data.cantidad_inicial, ajena.data.apertura], ['', '1', ap]);
  // La nota se guarda saneada (una línea), como la lee el recibo.
  const ok = intento({ observaciones: ' bien \n dorados ' });
  assert.deepEqual([ok.escrito, s.b.filas.at(-1).item.observaciones], [true, 'bien dorados']);
});
await t('itemDeFicha: la misma traducción que la ficha de carrito_v1 (p{i}g{G}o{N}); un grupo opcional vacío va como en itemDeLinea', () => {
  const foto = fotoTienda();
  assert.deepEqual(itemDeFicha(foto, 0, { ...RANURAS_VACIAS, ...CHILAQUILES, g3_m: [] }).item,
    { producto0: 'p0', cantidad: '3', observaciones: 'bien dorados', g0_s: 'p0g0o0', g1_s: 'p0g1o8', g2_m: ['p0g2o0', 'p0g2o2'], g3_m: [] });
  assert.deepEqual(itemDeFicha(foto, 2, { cantidad: '1' }).item, { producto0: 'p2', cantidad: '1', observaciones: '' }, 'sin grupos, sin ranuras');
  assert.equal(itemDeFicha(foto, 99, { cantidad: '1' }).error, 'Ese platillo ya no está disponible.');
  assert.deepEqual([productoDeLaFoto(foto, 'p6'), productoDeLaFoto(foto, 'p7'), productoDeLaFoto(foto, 'P1'), productoDeLaFoto(foto, null)], [6, -1, -1, -1]);
});

// ── Tope de renglones ────────────────────────────────────────────────────
await t(`tope: con ${MAX_RENGLONES_TIENDA} renglones no se agrega otro (ni por la ficha ni por los tacos); sí se puede editar y continuar`, () => {
  assert.equal(MAX_RENGLONES_TIENDA, 20);
  const s = sesion(fotoTienda({ lineas: [] }));
  for (let k = 0; k < MAX_RENGLONES_TIENDA; k++) assert(s.agregar('p2').escrito, `alta ${k}`);
  assert.equal(s.b.filas.length, 20);
  const r = s.agregar('p1');
  assert.deepEqual([r.escrito, r.resp.screen], [false, 'PERSONALIZAR']);
  assert.match(r.error, /llegó a 20 renglones/);
  s.paso(dx('CATEGORIA', { operacion: 'ver_tacos', categoria: 'c2' }));
  const tacos = s.paso(dx('TACOS', { operacion: 'terminar', revision: s.rev(), tortilla: 'maiz', t0_q: '1' }));
  assert.deepEqual([tacos.escrito, tacos.resp.screen], [false, 'TACOS']); assert.match(tacos.error, /hasta 20 renglones/);
  assert.equal(s.paso(dx('CARRITO', { operacion: 'continuar', revision: s.rev() })).resp.screen, 'ENTREGA');
});
await t('tope: los tacos que sumados pasan de 20 renglones se rechazan enteros (19 + 2)', () => {
  const s = sesion(fotoTienda({ lineas: [] }));
  for (let k = 0; k < 19; k++) s.agregar('p2');
  s.paso(dx('CATEGORIA', { operacion: 'ver_tacos', categoria: 'c2' }));
  const r = s.paso(dx('TACOS', { operacion: 'terminar', revision: s.rev(), tortilla: 'harina', t0_q: '1', t1_q: '1' }));
  assert.deepEqual([r.escrito, s.b.filas.length], [false, 19]);
});

// ── Cambios que exigen la revisión ───────────────────────────────────────
await t('revisión obsoleta: aplicar, quitar, deshacer, continuar y los tacos se rechazan sin escribir', () => {
  const s = sesion();
  s.agregar('p1'); s.agregar('p2'); // revisión 2
  const vieja = '1';
  const casos = [
    [dx('EDITAR', { operacion: 'aplicar', revision: vieja, fila: 'e1', ...RANURAS_VACIAS, cantidad: '5', observaciones: '' }), 'CARRITO'],
    [dx('EDITAR', { operacion: 'quitar', revision: vieja, fila: 'e1' }), 'CARRITO'],
    [dx('CARRITO', { operacion: 'deshacer', revision: vieja }), 'CARRITO'],
    [dx('CARRITO', { operacion: 'continuar', revision: vieja }), 'CARRITO'],
    [dx('CARRITO', { operacion: 'continuar', revision: 2 }), 'CARRITO'], // número, no texto
    [dx('CARRITO', { operacion: 'continuar' }), 'CARRITO'],
    [dx('TACOS', { operacion: 'terminar', revision: vieja, tortilla: 'maiz', t0_q: '2' }), 'MENU'],
  ];
  for (const [sol, pantalla] of casos) {
    const r = s.paso(sol);
    assert.deepEqual([r.escrito, r.resp.screen], [false, pantalla], JSON.stringify(sol.data));
    assert.match(r.error, /La ventana cambió/);
  }
  assert.equal(s.b.revision, 2);
  // Con la revisión al día, sí.
  assert.equal(s.paso(dx('EDITAR', { operacion: 'quitar', revision: '2', fila: 'e1' })).escrito, true);
});
await t('aplicar: cambia el renglón (misma key) y vuelve al carrito; con un error se queda en EDITAR con lo que eligió', () => {
  const s = sesion();
  const sol = (eleccion) => dx('EDITAR', { operacion: 'aplicar', revision: s.rev(), fila: 'e0', ...RANURAS_VACIAS, cantidad: '1', observaciones: '', ...eleccion });
  let r = s.paso(sol({ g0_r: 'o2', g1_s: '', g2_m: ['o1'], cantidad: '4' }));
  assert.deepEqual([r.error, r.escrito, r.resp.screen], ['Falta elegir Proteína para este platillo.', false, 'EDITAR']);
  assert.deepEqual([r.resp.data.g0_inicial_r, r.resp.data.g2_inicial_m, r.resp.data.cantidad_inicial, r.resp.data.fila], ['o2', ['o1'], '4', 'e0']);
  r = s.paso(sol({ g0_r: 'o2', g1_s: 'o2', g2_m: ['o1'], cantidad: '4' }));
  assert.deepEqual([r.error, r.escrito, r.resp.screen], [undefined, true, 'CARRITO']);
  assert.deepEqual(s.b.filas[0], { key: 'e0', item: { producto0: 'p0', cantidad: '4', observaciones: '', g0_s: 'p0g0o2', g1_s: 'p0g1o2', g2_m: ['p0g2o1'], g3_m: [] } });
  r = s.paso(dx('EDITAR', { operacion: 'aplicar', revision: s.rev(), fila: 'n4', ...RANURAS_VACIAS, cantidad: '1', observaciones: '' }));
  assert.deepEqual([r.error, r.escrito, r.resp.screen], ['Ese platillo ya no está en tu pedido.', false, 'CARRITO']);
  // Un intento viejo (otra revisión u otro renglón) no se copia a la ficha.
  const otra = respuestaTienda(s.foto, { ...s.b, vista: { pantalla: 'EDITAR', fila: 'e0' } }, 'tk', 'x', { revision: '0', fila: 'e0', g0_r: 'o0', cantidad: '9' });
  assert.deepEqual([otra.data.g0_inicial_r, otra.data.cantidad_inicial], ['o2', '4']);
});
await t('quitar y deshacer: deshacer devuelve renglones y aperturas (lo deshecho se puede volver a agregar); sin nada que deshacer, error', () => {
  const s = sesion();
  let r = s.paso(dx('CARRITO', { operacion: 'deshacer', revision: s.rev() }));
  assert.deepEqual([r.error, r.escrito], ['No hay cambios para deshacer.', false]);
  assert.equal(sesion().paso(dx('CARRITO', { operacion: 'ver_carrito' })).error, 'Acción no disponible.');
  assert.equal(s.paso(dx('MENU', { operacion: 'ver_carrito' })).resp.data.puede_deshacer, false);
  const ap = s.paso(dx('CATEGORIA', { operacion: 'ver', producto: 'p1' })).resp.data.apertura;
  const alta = dx('PERSONALIZAR', { operacion: 'agregar', apertura: ap, producto: 'p1', ...RANURAS_VACIAS, cantidad: '1', observaciones: '' });
  s.paso(alta);
  s.paso(dx('EDITAR', { operacion: 'quitar', revision: s.rev(), fila: 'e0' }));
  assert.deepEqual(s.b.filas.map((f) => f.key), ['e1', 'n0']);
  r = s.paso(dx('MENU', { operacion: 'ver_carrito' }));
  assert.equal(r.resp.data.puede_deshacer, true);
  r = s.paso(dx('CARRITO', { operacion: 'deshacer', revision: s.rev() }));
  assert.deepEqual([r.escrito, r.resp.screen, s.b.filas.map((f) => f.key)], [true, 'CARRITO', ['e0', 'e1', 'n0']]);
  r = s.paso(dx('CARRITO', { operacion: 'deshacer', revision: s.rev() }));
  assert.deepEqual([s.b.filas.map((f) => f.key), s.b.aperturas], [['e0', 'e1'], []]);
  // Deshecha el alta, la misma ficha vuelve a agregar.
  assert.equal(s.paso(alta).escrito, true);
  assert.equal(s.b.deshacer.length <= 10, true);
});
await t('continuar: faltantes con nombre; sin platillos y sin pedido, error; vaciar un pedido que tenía platillos cierra sin entrega', () => {
  const incompleta = fotoTienda();
  incompleta.lineas[0].seleccion = [{ grupo: 'Proteína', opcion: 'Pollo' }];
  let s = sesion(incompleta);
  let r = s.paso(dx('CARRITO', { operacion: 'continuar', revision: s.rev() }));
  assert.deepEqual([r.escrito, r.resp.screen], [false, 'CARRITO']);
  assert.equal(r.error, 'Para continuar falta elegir Salsa y Guarniciones en Chilaquiles. Ábrelo en «Editar o quitar».');
  assert.equal(textoFaltantesTienda([{ nombre: 'A', grupos: ['x'] }, { nombre: 'B', grupos: ['y'] }]),
    'Para continuar falta elegir opciones en 2 platillos (A y B). Ábrelos uno por uno en «Editar o quitar».');
  s = sesion(fotoTienda({ lineas: [] }));
  r = s.paso(dx('CARRITO', { operacion: 'continuar', revision: s.rev() }));
  assert.deepEqual([r.error, r.escrito], ['Tu pedido está vacío. Toca «Seguir pidiendo» y elige un platillo.', false]);
  s = sesion();
  s.paso(dx('EDITAR', { operacion: 'quitar', revision: s.rev(), fila: 'e0' }));
  s.paso(dx('EDITAR', { operacion: 'quitar', revision: s.rev(), fila: 'e1' }));
  r = s.paso(dx('CARRITO', { operacion: 'continuar', revision: s.rev() }));
  assert.deepEqual([r.escrito, r.resp.screen, s.b.etapa, s.b.filas], [true, 'SUCCESS', 'FINAL', []]);
  const recibo = { flow_token: 'tk', filas: s.b.filas, modalidad: s.b.modalidad, pago: s.b.pago };
  assert.deepEqual(comandosCarrito(s.foto, recibo), [{ herramienta: 'quitar_linea', argumentos: { linea_id: 'L1' } },
    { herramienta: 'quitar_linea', argumentos: { linea_id: 'L2' } }], 'vaciar es quitar cada línea, sin entrega');
});

// ── ENTREGA, DIRECCION y Atrás: los de carrito_v1 ────────────────────────
await t('continuar → ENTREGA (resumen de la tienda) → DIRECCION → FINAL; recoger cierra sin dirección; la nota se guarda', () => {
  let s = sesion();
  let r = s.paso(dx('CARRITO', { operacion: 'continuar', revision: s.rev() }));
  assert.deepEqual([r.escrito, r.resp.screen, s.b.etapa], [true, 'ENTREGA', 'ENTREGA']);
  assert.equal(r.resp.data.resumen, 'Tu pedido: 3 platillos · $335. Elige cómo lo recibes y cómo pagas.');
  r = s.paso(dx('ENTREGA', { operacion: 'revisar', revision: s.rev(), modalidad: 'm1', pago: 'p1', nota: ' Feliz cumpleaños ' }));
  assert.deepEqual([r.resp.screen, s.b.etapa, s.b.nota, s.b.modalidad, s.b.pago], ['DIRECCION', 'DIRECCION', 'Feliz cumpleaños', 'm1', 'p1']);
  r = s.paso(dx('DIRECCION', { ...DIRECCION, revision: s.rev() }));
  assert.deepEqual([r.resp.screen, s.b.etapa, s.b.direccion.calle], ['SUCCESS', 'FINAL', 'Hidalgo 405']);
  assert.equal(r.resp.data.extension_message_response.params.revision, s.rev());
  s = sesion();
  s.paso(dx('CARRITO', { operacion: 'continuar', revision: s.rev() }));
  r = s.paso(dx('ENTREGA', { operacion: 'revisar', revision: s.rev(), modalidad: 'm0', pago: 'p0', nota: '' }));
  assert.deepEqual([r.resp.screen, 'direccion' in s.b], ['SUCCESS', false]);
});
await t('Atrás: desde DIRECCION a ENTREGA y desde ENTREGA al carrito (etapa TIENDA); desde el carrito al MENU sin escribir', () => {
  const s = sesion();
  s.paso(dx('CARRITO', { operacion: 'continuar', revision: s.rev() }));
  s.paso(dx('ENTREGA', { operacion: 'revisar', revision: s.rev(), modalidad: 'm1', pago: 'p0', nota: 'x' }));
  let r = s.paso(atras('DIRECCION'));
  assert.deepEqual([r.escrito, r.resp.screen, s.b.etapa, r.resp.data.modalidad_inicial, r.resp.data.nota_inicial], [true, 'ENTREGA', 'ENTREGA', 'm1', 'x']);
  r = s.paso(atras('ENTREGA'));
  assert.deepEqual([r.escrito, r.resp.screen, s.b.etapa], [true, 'CARRITO', 'TIENDA']);
  r = s.paso(atras('CARRITO'));
  assert.deepEqual([r.escrito, r.resp.screen], [false, 'MENU']);
  // Un Atrás viejo (de una pantalla que ya no es la etapa) no retrocede otro paso.
  r = s.paso(atras('ENTREGA'));
  assert.deepEqual([r.escrito, r.resp.screen, s.b.etapa], [false, 'CARRITO', 'TIENDA']);
  for (const p of ['MENU', 'CATEGORIA', 'PERSONALIZAR', 'TACOS']) assert.equal(s.paso(atras(p)).resp.screen, 'MENU', p);
  assert.equal(s.paso(atras('EDITAR')).resp.screen, 'CARRITO');
});
await t('ENTREGA y DIRECCION solo se dibujan en su etapa; un envío de ENTREGA fuera de ella vuelve al carrito con error', () => {
  const s = sesion();
  const r = s.paso(dx('ENTREGA', { operacion: 'revisar', revision: s.rev(), modalidad: 'm0', pago: 'p0', nota: '' }));
  assert.deepEqual([r.escrito, r.resp.screen], [false, 'CARRITO']); assert.match(r.error, /La ventana cambió/);
  for (const pantalla of ['ENTREGA', 'DIRECCION', 'FINAL']) {
    assert.equal(respuestaTienda(s.foto, { ...s.b, vista: { pantalla } }, 'tk').screen, 'CARRITO', pantalla);
  }
  const d = sesion();
  d.paso(dx('CARRITO', { operacion: 'continuar', revision: d.rev() }));
  const mal = d.paso(dx('ENTREGA', { operacion: 'revisar', revision: d.rev(), modalidad: 'm7', pago: 'p0', nota: '' }));
  assert.deepEqual([mal.escrito, mal.resp.screen, mal.error], [false, 'ENTREGA', 'Elige la entrega y la forma de pago.']);
  assert.equal(d.paso(dx('ENTREGA', { operacion: 'revisar', revision: d.rev(), modalidad: 'm0', pago: 'p0', nota: 'x'.repeat(201) })).error,
    'La nota del pedido admite hasta 200 letras.');
});

// ── Tacos ────────────────────────────────────────────────────────────────
await t('tacos por cantidad: «Agregar» los suma y responde el MENU fresco; «Agregar más» se queda; «Otros tacos»; sin «Guardar y ver categorías»', () => {
  const s = sesion(fotoTienda({ lineas: [] }));
  let r = s.paso(dx('CATEGORIA', { operacion: 'ver_tacos', categoria: 'c2' }));
  assert.deepEqual([r.resp.screen, r.resp.data.resumen, r.resp.data.t0_titulo, r.resp.data.t2_visible], ['TACOS', 'Elige tus tacos.', 'Taco de Barbacoa · $30 c/u', false]);
  const lote = (operacion, extra = {}) => dx('TACOS', { operacion, revision: s.rev(), tortilla: 'maiz', t0_q: '0', t1_q: '0', ...extra });
  r = s.paso(lote('agregar', { t0_q: '2', t0_nota: 'con todo' }));
  assert.deepEqual([r.escrito, r.resp.screen, r.resp.data.resumen, r.resp.data.t0_inicial], [true, 'TACOS', 'Tu pedido: 2 platillos · $60', '0']);
  assert.deepEqual(s.b.filas, [{ key: 'n0', item: { producto0: 'p4', cantidad: '2', observaciones: 'con todo', g0_s: 'p4g0o1' } }]);
  r = s.paso(lote('terminar', { t1_q: '1' }));
  assert.deepEqual([r.escrito, r.resp.screen, r.resp.data.barra[0]['main-content'].metadata], [true, 'MENU', 'Agregaste: 1 × Taco de Pastor']);
  r = s.paso(lote('terminar'));
  assert.deepEqual([r.escrito, r.error, r.resp.screen], [false, 'Elige al menos un platillo y su cantidad.', 'TACOS'],
    'sin tacos elegidos, «Agregar» lo pide; para salir sin agregar está la flecha');
  // «Guardar y ver categorías» hacía lo mismo que «Agregar»: la tienda no lo ofrece ni lo acepta.
  r = s.paso(lote('categorias', { t0_q: '1' }));
  assert.deepEqual([r.escrito, r.error, r.resp.screen], [false, 'Acción no disponible.', 'MENU']);
  r = s.paso(lote('individual'));
  assert.deepEqual([r.escrito, r.resp.screen, r.resp.data.platillos.map((p) => p.id)], [false, 'CATEGORIA', ['tacos', 'p4', 'p5', 'p6']]);
  r = s.paso(lote('agregar'));
  assert.deepEqual([r.escrito, r.error], [false, 'Elige al menos un platillo y su cantidad.']);
  r = s.paso(lote('terminar', { tortilla: '', t0_q: '1' }));
  assert.deepEqual([r.escrito, r.error, r.resp.data.t0_inicial], [false, 'Elige la tortilla para estos tacos.', '1']);
  r = s.paso(dx('TACOS', { operacion: 'terminar', revision: s.rev(), tortilla: 'maiz', t0_q: '1', precio: '0' }));
  assert.deepEqual([r.escrito, r.error], [false, 'Selección no disponible.']);
  // Sin categoría de tacos (variosTacos), el lote no existe.
  const sinTacos = sesion(fotoTienda({ productos: fotoTienda().productos.slice(0, 4), lineas: [] }));
  assert.equal(sinTacos.paso(dx('CATEGORIA', { operacion: 'ver_tacos', categoria: 'c2' })).error, 'Selección no disponible.');
});

// ── La forma de carrito_v1: mismas acciones, mismo recibo ─────────────────
await t('mismas acciones que en «Tu carrito»: las mismas filas y el MISMO recibo (comandosCarrito), con platillo, tacos, editar, quitar, entrega, dirección y nota', () => {
  const foto = fotoTienda(), fc = comoCarrito(foto);
  // carrito_v1 (Flow de hoy)
  let c = borradorCarrito(fc);
  const cx = (screen, data) => { const r = cambiarCarrito(fc, c, dx(screen, { revision: String(c.revision), ...data })); assert.equal(r.error, undefined, `${screen}: ${r.error}`); c = r.borrador; };
  cx('CARRITO', { operacion: 'agregar' }); cx('MENU', { operacion: 'categoria', categoria: 'c0' });
  cx('PLATILLO', { operacion: 'terminar', producto0: 'p0', g0_s: 'p0g0o0', g1_s: 'p0g1o8', g2_m: ['p0g2o0', 'p0g2o2'], g3_m: ['p0g3o1'], cantidad: '3', observaciones: 'bien dorados' });
  cx('CARRITO', { operacion: 'agregar' }); cx('MENU', { operacion: 'categoria', categoria: 'c2' });
  cx('TACOS', { operacion: 'terminar', tortilla: 'maiz', t0_q: '2', t0_nota: 'con todo', t1_q: '1' });
  cx('CARRITO', { operacion: 'editar', editar: 'e0' });
  cx('EDITAR', { operacion: 'aplicar_opciones', cantidad: '1', observaciones: '', g0_s: 'l0g0o2', g1_s: 'l0g1o2', g2_m: ['l0g2o1'], g3_m: [] });
  cx('CARRITO', { operacion: 'pagina', pagina: 'p0', q1: '0' });
  cx('CARRITO', { operacion: 'guardar' });
  cx('ENTREGA', { operacion: 'revisar', modalidad: 'm1', pago: 'p0', nota: 'Feliz cumpleaños' });
  cx('DIRECCION', DIRECCION);
  // tienda_v1
  const s = sesion(foto);
  s.agregar('p0', CHILAQUILES);
  s.paso(dx('CATEGORIA', { operacion: 'ver_tacos', categoria: 'c2' }));
  s.paso(dx('TACOS', { operacion: 'terminar', revision: s.rev(), tortilla: 'maiz', t0_q: '2', t0_nota: 'con todo', t1_q: '1' }));
  s.paso(dx('CARRITO', { operacion: 'editar', fila: 'e0' }));
  s.paso(dx('EDITAR', { operacion: 'aplicar', revision: s.rev(), fila: 'e0', ...RANURAS_VACIAS, g0_r: 'o2', g1_s: 'o2', g2_m: ['o1'], cantidad: '1', observaciones: '' }));
  s.paso(dx('EDITAR', { operacion: 'quitar', revision: s.rev(), fila: 'e1' }));
  s.paso(dx('CARRITO', { operacion: 'continuar', revision: s.rev() }));
  s.paso(dx('ENTREGA', { operacion: 'revisar', revision: s.rev(), modalidad: 'm1', pago: 'p0', nota: 'Feliz cumpleaños' }));
  s.paso(dx('DIRECCION', { ...DIRECCION, revision: s.rev() }));
  assert.deepEqual([c.etapa, s.b.etapa], ['FINAL', 'FINAL']);
  assert.deepEqual(s.b.filas.map((f) => f.key), c.filas.map((f) => f.key));
  assert.deepEqual(normal(s.b.filas), normal(c.filas));
  for (const f of s.b.filas) {
    assert.deepEqual(Object.keys(f).sort(), ['item', 'key']);
    for (const [k, v] of Object.entries(f.item)) assert(/^(producto0|cantidad|observaciones|g[0-5]_[sm])$/.test(k) && (typeof v === 'string' || Array.isArray(v)), k);
  }
  assert.deepEqual([s.b.modalidad, s.b.pago, s.b.nota, s.b.direccion], [c.modalidad, c.pago, c.nota, c.direccion]);
  // El recibo que arma resolverFinalFlow para carrito_v1, desde cada borrador.
  const recibo = (b) => ({ flow_token: 'tk', filas: b.filas, modalidad: b.modalidad, pago: b.pago, direccion: b.direccion, nota: b.nota });
  const ct = comandosCarrito(foto, recibo(s.b)), cc = comandosCarrito(fc, recibo(c));
  assert(ct && cc, 'los dos recibos son válidos');
  assert.deepEqual(ct, cc);
  assert.deepEqual([...new Set(ct.map((x) => x.herramienta))].sort(), ['agregar_producto', 'definir_entrega', 'definir_pago', 'modificar_linea', 'quitar_linea']);
});
await t('el subtotal de la barra y del carrito es el de carrito_v1 (centavos por renglón); el resumen cuenta piezas', () => {
  const foto = fotoTienda(), s = sesion(foto);
  s.agregar('p3', { cantidad: '3' }); s.agregar('p0', CHILAQUILES);
  const p = pedidoDelBorrador(foto, s.b);
  const delCarrito = respuestaCarrito(comoCarrito(foto), { ...s.b, etapa: 'CARRITO' }, 'tk').data.importe.match(/\$(\d+\.\d\d)/)[1];
  assert.equal(precioCentavos(p.subtotalCentavos / 100), `$${Number(delCarrito).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  assert.deepEqual([p.unidades, p.renglones.length, p.subtotalCentavos], [9, 4, 29000 + 4500 + 16650 + 56100]);
  assert.deepEqual(p.renglones[0], { key: 'e0', nombre: 'Chilaquiles', cantidad: 2, detalle: 'Verde · Pollo · Frijoles · Papas · Sin cebolla', importeCentavos: 29000, faltan: [] });
});

// ── Aislamiento: la Fase 2B la conecta solo en el endpoint y en la foto ───
// ── La pila del teléfono ─────────────────────────────────────────────────
// WhatsApp apila las pantallas. Cada respuesta del endpoint debe ser la misma
// pantalla, una arista del routing_model o un ancestro en la pila CON
// refresh_on_back (4-oct: con MENU sin él, el teléfono rechazó «Agregar» →
// MENU aunque MENU era la raíz); el Atrás de una pantalla con
// refresh_on_back, la que queda arriba al sacarla. Los saltos
// que no cumplen y ya se conocen (revisión del 3-oct) son SALTOS_CONOCIDOS: se
// prueban en el teléfono de prueba antes de pasar a --todos. Uno nuevo, o uno
// conocido que desaparece, hace fallar esta prueba.
const DEF_TIENDA = definicionFlowTienda();
const RUTAS = DEF_TIENDA.routing_model;
const REFRESCA = Object.fromEntries(DEF_TIENDA.screens.map((p) => [p.id, p.refresh_on_back === true]));
const SALTOS_CONOCIDOS = Object.freeze([
  // Atrás en «Tu pedido» abierto desde una categoría: responde el MENU, no la categoría (el servidor no sabe de dónde vino).
  'menú · Atrás desde CARRITO: CATEGORIA → MENU',
  // «Seguir pidiendo» con «Tu pedido» como primera pantalla: MENU no es arista de CARRITO ni ancestro.
  'tu pedido · CARRITO/seguir: CARRITO → MENU',
  // Heredado de carrito_v1 (hoy en producción): Atrás en «Escribir dirección» como primera pantalla.
  'dirección · Atrás desde DIRECCION: (raíz) → ENTREGA',
  'retomado · CARRITO/seguir: CARRITO → MENU',
]);
function telefono(nombre, foto, b = null) {
  const s = sesion(foto, b ? { b } : {}), pila = [], saltos = [];
  const recibir = (r, donde, deAtras = false) => {
    assert.equal(r.error ?? '', '', `${nombre} · ${donde}: ${r.error}`);
    const x = r.resp.screen, tope = pila.at(-1);
    t.ultima = r.resp;
    if (x === 'SUCCESS') { pila.length = 0; return x; }
    if (x === tope || (!tope && !deAtras && !pila.length)) { if (!tope) pila.push(x); return x; }
    if (!deAtras && RUTAS[tope]?.includes(x)) { pila.push(x); return x; }
    const i = pila.lastIndexOf(x);
    if (!deAtras && i >= 0 && REFRESCA[x]) { pila.length = i + 1; return x; }
    saltos.push(`${nombre} · ${donde}: ${tope ?? '(raíz)'} → ${x}`);
    if (i >= 0) pila.length = i + 1; else pila.push(x);
    return x;
  };
  const t = { pila, saltos, s,
    init: () => recibir(s.paso(INIT), 'INIT'),
    navegar: (x) => { assert(RUTAS[pila.at(-1)].includes(x), `navigate ${pila.at(-1)} → ${x}`); pila.push(x); },
    dx: (data) => recibir(s.paso(dx(pila.at(-1), data)), `${pila.at(-1)}/${data.operacion}`),
    atras: () => { const deja = pila.pop(); return REFRESCA[deja] ? recibir(s.paso(atras(deja)), `Atrás desde ${deja}`, true) : pila.at(-1); } };
  return t;
}
await t('la pila del teléfono: cada respuesta es la misma pantalla, una ruta del routing_model o un ancestro; fuera de eso, solo los saltos conocidos', () => {
  const saltos = [];
  const tacos = (f, operacion, extra = {}) => f.dx({ operacion, revision: f.s.rev(), tortilla: 'maiz', t0_q: '0', t1_q: '0', ...extra });
  // «Haz tu pedido»: abre en el MENU; explora, agrega, edita, tacos, carrito, Atrás y cierre a domicilio.
  const m = telefono('menú', fotoTienda({ lineas: [] }));
  assert.equal(m.init(), 'MENU');
  m.navegar('CATEGORIA');
  // Atrás en una categoría (refresh_on_back desde el 4-oct): el servidor responde el MENU fresco.
  assert.equal(m.atras(), 'MENU');
  m.navegar('CATEGORIA');
  assert.equal(m.dx({ operacion: 'ver', producto: 'p0' }), 'PERSONALIZAR');
  assert.equal(m.dx({ operacion: 'agregar', apertura: m.ultima.data.apertura, producto: 'p0', ...RANURAS_VACIAS, ...CHILAQUILES }), 'MENU');
  assert.equal(m.dx({ operacion: 'ver_carrito' }), 'CARRITO');
  assert.equal(m.dx({ operacion: 'editar', fila: 'n0' }), 'EDITAR');
  assert.equal(m.dx({ operacion: 'aplicar', revision: m.s.rev(), fila: 'n0', ...RANURAS_VACIAS, ...CHILAQUILES, cantidad: '1' }), 'CARRITO');
  assert.equal(m.dx({ operacion: 'seguir' }), 'MENU');
  m.navegar('CATEGORIA');
  assert.equal(m.dx({ operacion: 'ver_tacos', categoria: 'c2' }), 'TACOS');
  assert.equal(tacos(m, 'agregar', { t0_q: '2' }), 'TACOS');
  assert.equal(tacos(m, 'individual'), 'CATEGORIA');
  assert.equal(m.dx({ operacion: 'ver_carrito' }), 'CARRITO');
  assert.equal(m.atras(), 'MENU');
  assert.equal(m.dx({ operacion: 'ver_carrito' }), 'CARRITO');
  assert.equal(m.dx({ operacion: 'editar', fila: 'n1' }), 'EDITAR');
  assert.equal(m.dx({ operacion: 'quitar', revision: m.s.rev(), fila: 'n1' }), 'CARRITO');
  assert.equal(m.dx({ operacion: 'continuar', revision: m.s.rev() }), 'ENTREGA');
  assert.equal(m.atras(), 'CARRITO');
  assert.equal(m.dx({ operacion: 'continuar', revision: m.s.rev() }), 'ENTREGA');
  assert.equal(m.dx({ operacion: 'revisar', revision: m.s.rev(), modalidad: 'm1', pago: 'p0', nota: '' }), 'DIRECCION');
  assert.equal(m.atras(), 'ENTREGA');
  assert.equal(m.dx({ operacion: 'revisar', revision: m.s.rev(), modalidad: 'm1', pago: 'p0', nota: '' }), 'DIRECCION');
  assert.equal(m.dx({ ...DIRECCION, revision: m.s.rev() }), 'SUCCESS');
  saltos.push(...m.saltos);
  // «Ver mi pedido»: abre en «Tu pedido» (primera pantalla de la pila).
  const c = telefono('tu pedido', fotoTienda({ abrir: 'CARRITO' }));
  assert.equal(c.init(), 'CARRITO');
  assert.equal(c.dx({ operacion: 'seguir' }), 'MENU');
  assert.equal(c.dx({ operacion: 'ver_carrito' }), 'CARRITO');
  assert.equal(c.atras(), 'MENU');
  saltos.push(...c.saltos);
  // «Escribir dirección»: abre en DIRECCION; Atrás en la primera pantalla.
  const d = telefono('dirección', fotoTienda({ abrir: 'DIRECCION', modalidad: 'entrega a domicilio', pago: 'efectivo' }));
  assert.equal(d.init(), 'DIRECCION');
  assert.equal(d.atras(), 'ENTREGA');
  assert.equal(d.dx({ operacion: 'revisar', revision: d.s.rev(), modalidad: 'm1', pago: 'p0', nota: '' }), 'DIRECCION');
  assert.equal(d.dx({ ...DIRECCION, revision: d.s.rev() }), 'SUCCESS');
  saltos.push(...d.saltos);
  // Retomado a medio cierre: el INIT vuelve a «Tu pedido».
  const r = telefono('retomado', fotoTienda(), { ...borradorTienda(fotoTienda()), etapa: 'ENTREGA', revision: 2 });
  assert.equal(r.init(), 'CARRITO');
  assert.equal(r.dx({ operacion: 'seguir' }), 'MENU');
  saltos.push(...r.saltos);
  assert.deepEqual(saltos, [...SALTOS_CONOCIDOS]);
});

await t('aislado: solo el endpoint (flowRepetibleSql.js) importa flowTienda.js, y el catálogo solo flowTienda.js y la foto (formularioAgrupado.js); la tienda no toca base, sharp ni red', () => {
  const raiz = new URL('../', import.meta.url), fuera = { flowTienda: [], catalogoFlowTienda: [] };
  const recorrer = (dir) => {
    for (const e of readdirSync(new URL(dir, raiz), { withFileTypes: true })) {
      const rel = join(dir, e.name).replaceAll('\\', '/');
      if (e.isDirectory()) recorrer(`${rel}/`);
      else if (/\.(m?js)$/.test(e.name)) {
        const fuente = readFileSync(new URL(rel, raiz), 'utf8');
        for (const m of Object.keys(fuera)) if (new RegExp(`from '[^']*/${m}\\.js'`).test(fuente)) fuera[m].push(rel);
      }
    }
  };
  recorrer('src/');
  for (const k of Object.keys(fuera)) fuera[k].sort();
  assert.deepEqual(fuera, { flowTienda: ['src/mesero-agente/flowRepetibleSql.js'],
    catalogoFlowTienda: ['src/mesero-agente/flowTienda.js', 'src/mesero-agente/formularioAgrupado.js'] },
    'la Fase 2B la conecta solo en el endpoint y en la foto, detrás de la bandera');
  for (const archivo of ['flowTienda.js', 'catalogoFlowTienda.js']) {
    const fuente = readFileSync(new URL(`../src/mesero-agente/${archivo}`, import.meta.url), 'utf8');
    const imports = [...fuente.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    assert(imports.every((i) => i.startsWith('./')), `${archivo}: ${imports}`);
    assert(!imports.some((i) => /database|miniaturas|vitrina|sharp|^pg$/.test(i)), `${archivo}: ${imports}`);
    const codigo = fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(codigo, /\bpool\b|\bquery\(|fetch\(|https?:\/\/|process\.env/, archivo);
  }
});

console.log(`RESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas} (flow tienda)`);
process.exit(fallidas ? 1 : 0);
