// ─── EL CONTRATO, EL EJECUTOR, LA MÁQUINA DE ESTADOS Y EL LIBRO ───────────
//
// Suite pura: sin Postgres, sin puertos, sin modelo. Lo que se prueba aquí es
// la frontera nueva — que el modelo NO pueda inventar un producto, ni una
// opción, ni confirmar un pedido que no está listo, ni aplicar dos veces la
// misma acción.
//
// Cada caso está escrito como la afirmación DESNUDA: si la garantía se quita,
// el caso cae. La tabla de mordidas está al final del archivo.
import assert from 'node:assert/strict';
import {
  definicionesParaElModelo, validarArgumentos, jsonSchemaDe, NOMBRES, CON_EFECTO, PORNOMBRE,
} from '../src/mesero-agente/contratoDeHerramientas.js';
import {
  crearEjecutor, estadoNuevo, validarOpciones,
} from '../src/mesero-agente/ejecutorDeHerramientas.js';
import {
  estadoDelPedido, transicionLegal, LISTO, ARMANDO, CONFIRMADO, NAVEGANDO, ACLARANDO,
} from '../src/mesero-agente/maquinaDeEstados.js';
import {
  libroDeOperaciones, almacenEnMemoria, hashDeArgumentos, claveDeOperacion,
} from '../src/mesero-agente/libroDeOperaciones.js';
import { articulosQueElClientePidioQuitar } from '../src/orders/carritoDelPedido.js';

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

// ── La carta ─────────────────────────────────────────────────────────────
const g = (nombre, minimo, maximo, opciones, requerido = true) => ({
  nombre, requerido, minimo, maximo,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});
const CARTA = [
  { id: 1, nombre: 'Desayunos', productos: [
    { id: 85, nombre: 'Chilaquiles Sencillos', precio: 195, disponible: true, orden: 0,
      modificadores: [g('Salsa', 1, 1, ['Roja', 'Verde', 'Suiza']),
        g('Proteína', 1, 1, ['Huevos Estrellados', 'Huevos Revueltos', 'Pollo'])] },
    { id: 107, nombre: 'Chilaquiles Mixtos', precio: 205, disponible: true, orden: 1,
      modificadores: [g('Salsa', 1, 2, ['Roja', 'Verde', 'Suiza']),
        g('Proteína', 1, 2, ['Huevos Estrellados', 'Huevos Revueltos', 'Pollo'])] },
    { id: 90, nombre: 'Hotcakes', precio: 95, disponible: true, orden: 2, modificadores: [] },
  ] },
  { id: 2, nombre: 'Bebidas', productos: [
    { id: 21, nombre: 'Coca Cola', precio: 35, disponible: true, orden: 0, modificadores: [] },
  ] },
];
const PRECIOS = { 'Chilaquiles Sencillos': 195, 'Chilaquiles Mixtos': 205, Hotcakes: 95, 'Coca Cola': 35 };

const ejecutorDe = (estado, mensaje, extra = {}) => crearEjecutor({
  estado, catalogo: CARTA, precios: PRECIOS, mensaje, textoCiclo: extra.textoCiclo ?? mensaje,
  requierePago: extra.requierePago ?? true, efectos: extra.efectos ?? null,
});
const nuevo = () => estadoNuevo({ negocioId: 'n1', conversacionId: 'c1' });

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── A. El esquema: estricto o no sirve ──');

await t('A1 · doce herramientas, y las de efecto son las que mutan', () => {
  assert.equal(NOMBRES.length, 12, `esperaba 12 herramientas, hay ${NOMBRES.length}`);
  assert.deepEqual([...CON_EFECTO].sort(), [
    'agregar_producto', 'cancelar_pedido', 'confirmar_pedido', 'definir_cliente',
    'definir_entrega', 'definir_pago', 'modificar_linea', 'pedir_humano', 'quitar_linea',
  ].sort());
  // Las tres de lectura NO tienen efecto: si alguna lo tuviera, pasaría por el
  // libro y una consulta repetida devolvería un resultado congelado.
  assert.ok(!CON_EFECTO.includes('ver_pedido') && !CON_EFECTO.includes('buscar_producto'));
});

await t('A2 · un argumento que no existe se rechaza, no se ignora', () => {
  const r = validarArgumentos('agregar_producto', { producto_id: '85', cantidad: 1, precio: 1 });
  assert.equal(r.ok, false, 'aceptó un campo inventado');
  assert.match(r.error, /argumentos_invalidos/);
});

await t('A3 · cantidad 0 y cantidad negativa se rechazan', () => {
  assert.equal(validarArgumentos('agregar_producto', { producto_id: '85', cantidad: 0 }).ok, false);
  assert.equal(validarArgumentos('agregar_producto', { producto_id: '85', cantidad: -2 }).ok, false);
  assert.equal(validarArgumentos('agregar_producto', { producto_id: '85', cantidad: 3 }).ok, true);
});

await t('A4 · definir_entrega sin ningún dato se rechaza', () => {
  assert.equal(validarArgumentos('definir_entrega', {}).ok, false, 'aceptó una entrega vacía');
  assert.equal(validarArgumentos('definir_entrega', { modalidad: 'domicilio' }).ok, true);
  assert.equal(validarArgumentos('definir_entrega', { direccion: 'Hidalgo 12' }).ok, true);
});

await t('A5 · el JSON Schema que ve el modelo sale del MISMO Zod', () => {
  const defs = definicionesParaElModelo();
  assert.equal(defs.length, 12);
  const agregar = defs.find((d) => d.name === 'agregar_producto');
  assert.deepEqual(agregar.input_schema.required, ['producto_id']);
  assert.equal(agregar.input_schema.additionalProperties, false,
    'sin additionalProperties:false el modelo puede mandar campos que nadie valida');
  assert.equal(agregar.input_schema.properties.cantidad.type, 'integer');
  assert.equal(agregar.input_schema.properties.cantidad.minimum, 1);
  // La prueba de que no hay dos fuentes: se deriva de nuevo y sale idéntico.
  const otra = jsonSchemaDe(PORNOMBRE.agregar_producto.esquema);
  assert.deepEqual(otra, agregar.input_schema);
});

await t('A6 · una herramienta desconocida no se valida «por si acaso»', () => {
  const r = validarArgumentos('borrar_todo', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /herramienta_desconocida/);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── B. La carta manda: nada se inventa ──');

await t('B1 · un producto que no está en la carta se dice, no se sustituye', async () => {
  const e = ejecutorDe(nuevo(), 'quiero unos waffles');
  const r = await e.ejecutar('buscar_producto', { texto: 'waffles' });
  assert.equal(r.existe, false, 'encontró algo que no existe');
  assert.deepEqual(r.encontrados, []);
  assert.ok(Array.isArray(r.categorias) && r.categorias.length, 'no devolvió la carta para poder ofrecer otra cosa');
});

await t('B2 · con varios candidatos se avisa de que el cliente no ha elegido', async () => {
  const e = ejecutorDe(nuevo(), 'quiero chilaquiles');
  const r = await e.ejecutar('buscar_producto', { texto: 'chilaquiles' });
  assert.ok(r.encontrados.length >= 2, `esperaba varios, hubo ${r.encontrados.length}`);
  assert.match(r.nota || '', /pregúntaselo|no ha dicho/i);
});

await t('B3 · un producto_id inventado no agrega nada', async () => {
  const estado = nuevo();
  const e = ejecutorDe(estado, 'quiero unos chilaquiles sencillos');
  const r = await e.ejecutar('agregar_producto', { producto_id: '999', cantidad: 1 });
  assert.equal(r.aplicado, false);
  assert.equal(r.estado, 'ilegal');
  assert.match(r.motivo, /producto_id_inexistente/);
  assert.equal(estado.carrito.items.length, 0, 'el carrito se tocó con un id inventado');
});

await t('B4 · un grupo que el producto no tiene se rechaza CON la lista real', async () => {
  const e = ejecutorDe(nuevo(), 'unos hotcakes con salsa verde');
  const r = await e.ejecutar('agregar_producto', {
    producto_id: '90', cantidad: 1, opciones: [{ grupo: 'Salsa', opcion: 'Verde' }] });
  assert.equal(r.aplicado, false);
  assert.match(r.motivo, /grupo_inexistente/);
  assert.match(r.motivo, /Salsa/);
});

await t('B5 · una opción que ese grupo no ofrece se rechaza CON las que sí', async () => {
  const e = ejecutorDe(nuevo(), 'chilaquiles sencillos con salsa de mango');
  const r = await e.ejecutar('agregar_producto', {
    producto_id: '85', opciones: [{ grupo: 'Salsa', opcion: 'Mango' }] });
  assert.equal(r.aplicado, false);
  assert.match(r.motivo, /opcion_inexistente/);
  assert.match(r.motivo, /Roja/, 'no dijo cuáles son las opciones reales');
});

await t('B6 · la cardinalidad del negocio se respeta', () => {
  const ficha = { nombre: 'Chilaquiles Sencillos', grupos: [
    { nombre: 'Salsa', requerido: true, minimo: 1, maximo: 1,
      opciones: [{ nombre: 'Roja' }, { nombre: 'Verde' }] }] };
  const r = validarOpciones(ficha, [{ grupo: 'Salsa', opcion: 'Roja' }, { grupo: 'Salsa', opcion: 'Verde' }]);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /demasiadas_opciones/);
});

await t('B7 · el nombre que se guarda es el de la CARTA, no el del modelo', async () => {
  const estado = nuevo();
  const e = ejecutorDe(estado, 'unos chilaquiles sencillos con salsa roja y huevos revueltos');
  const r = await e.ejecutar('agregar_producto', { producto_id: '85',
    opciones: [{ grupo: 'salsa', opcion: 'roja' }, { grupo: 'PROTEINA', opcion: 'huevos revueltos' }] });
  assert.equal(r.aplicado, true, `no se aplicó: ${r.motivo}`);
  assert.equal(estado.carrito.items[0].nombre, 'Chilaquiles Sencillos');
  const salsa = r.pedido.lineas[0].opciones.find((o) => o.grupo === 'Salsa');
  assert.equal(salsa.opcion, 'Roja', 'guardó la minúscula del modelo en vez del nombre de la carta');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── C. El reconciliador sigue mandando ──');

await t('C1 · un producto que el cliente NO nombró no entra, aunque el id sea real', async () => {
  const estado = nuevo();
  const e = ejecutorDe(estado, 'hola, buenas tardes');
  const r = await e.ejecutar('agregar_producto', { producto_id: '21', cantidad: 1 });
  assert.equal(r.aplicado, false, 'metió una Coca que nadie pidió');
  assert.match(r.motivo, /el_cliente_no_lo_dijo/);
  assert.equal(estado.carrito.items.length, 0);
});

await t('C2 · una cantidad que el cliente no dijo no se aplica', async () => {
  const estado = nuevo();
  await ejecutorDe(estado, 'una coca por favor').ejecutar('agregar_producto', { producto_id: '21', cantidad: 1 });
  assert.equal(estado.carrito.items.length, 1);
  const r = await ejecutorDe(estado, 'gracias').ejecutar('modificar_linea',
    { linea_id: estado.carrito.items[0].lid, cantidad: 5 });
  assert.equal(r.aplicado, false, 'subió a 5 sin que nadie dijera 5');
  assert.equal(estado.carrito.items[0].cantidad, 1);
});

await t('C3 · quitar exige que el cliente lo haya pedido', async () => {
  const estado = nuevo();
  await ejecutorDe(estado, 'una coca').ejecutar('agregar_producto', { producto_id: '21' });
  const lid = estado.carrito.items[0].lid;
  const r = await ejecutorDe(estado, 'y unos hotcakes').ejecutar('quitar_linea', { linea_id: lid });
  assert.equal(r.aplicado, false, 'quitó un renglón que nadie pidió quitar');
  assert.equal(estado.carrito.items.length, 1);
  const r2 = await ejecutorDe(estado, 'mejor quítame la coca').ejecutar('quitar_linea', { linea_id: lid });
  assert.equal(r2.aplicado, true, `no quitó cuando sí lo pidió: ${r2.motivo}`);
  assert.equal(estado.carrito.items.length, 0);
});

await t('C4 · un linea_id que ya no existe no se inventa', async () => {
  const e = ejecutorDe(nuevo(), 'quítame esa');
  const r = await e.ejecutar('quitar_linea', { linea_id: 'itzzz' });
  assert.equal(r.aplicado, false);
  assert.match(r.motivo, /linea_inexistente/);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── D. La máquina de estados ──');

await t('D1 · el estado se deduce del carrito, no se guarda', () => {
  assert.equal(estadoDelPedido({ carrito: { items: [], datos: {} } }), NAVEGANDO);
  assert.equal(estadoDelPedido({ carrito: { items: [{ nombre: 'x' }], datos: {} } }), ARMANDO);
  assert.equal(estadoDelPedido({ carrito: { items: [{ nombre: 'x' }], datos: {} },
    aclaraciones: [{ tipo: 'grupo_requerido' }] }), ACLARANDO);
  assert.equal(estadoDelPedido({
    carrito: { items: [{ nombre: 'x' }], datos: { modalidad: 'recoger', forma_pago: 'efectivo' } } }), LISTO);
  assert.equal(estadoDelPedido({ carrito: { items: [] }, hechos: { confirmado: true } }), CONFIRMADO);
});

await t('D2 · confirmar_pedido es ilegal en cualquier estado que no sea listo', () => {
  for (const estado of [NAVEGANDO, ARMANDO, ACLARANDO, CONFIRMADO]) {
    const r = transicionLegal('confirmar_pedido', estado);
    assert.equal(r.legal, false, `confirmar_pedido resultó legal en ${estado}`);
  }
  assert.equal(transicionLegal('confirmar_pedido', LISTO).legal, true);
});

await t('D3 · leer es legal siempre, incluso confirmado', () => {
  for (const h of ['ver_pedido', 'buscar_producto', 'ver_opciones_producto']) {
    assert.equal(transicionLegal(h, CONFIRMADO).legal, true, `${h} bloqueada tras confirmar`);
  }
});

await t('D4 · después de confirmar no se puede cambiar nada', async () => {
  const estado = nuevo();
  estado.hechos.confirmado = true;
  const e = ejecutorDe(estado, 'agrégame una coca');
  for (const h of ['agregar_producto', 'quitar_linea', 'modificar_linea', 'definir_pago', 'cancelar_pedido']) {
    const r = await e.ejecutar(h, { producto_id: '21', linea_id: 'x', forma_pago: 'efectivo', motivo: 'y' });
    assert.equal(r.aplicado, false, `${h} se aplicó con el pedido confirmado`);
    assert.match(r.motivo, /pedido_confirmado/);
  }
  // Y una persona sí puede entrar: es el caso de la queja después de confirmar.
  assert.equal(transicionLegal('pedir_humano', CONFIRMADO).legal, true);
});

await t('D5 · un domicilio sin dirección NO está listo', () => {
  const carrito = { items: [{ nombre: 'Hotcakes', cantidad: 1 }],
    datos: { modalidad: 'entrega a domicilio', forma_pago: 'efectivo' } };
  assert.equal(estadoDelPedido({ carrito }), ARMANDO, 'un domicilio sin dirección se dio por listo');
  carrito.datos.cliente = { direccion: 'Hidalgo 12' };
  assert.equal(estadoDelPedido({ carrito }), LISTO);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── E. La confirmación no es teatro ──');

const pedidoListo = async () => {
  const estado = nuevo();
  await ejecutorDe(estado, 'unos hotcakes').ejecutar('agregar_producto', { producto_id: '90' });
  await ejecutorDe(estado, 'para recoger en tienda').ejecutar('definir_entrega', { modalidad: 'recoger en tienda' });
  await ejecutorDe(estado, 'pago en efectivo').ejecutar('definir_pago', { forma_pago: 'efectivo' });
  return estado;
};

await t('E1 · un pedido completo llega a listo y confirma', async () => {
  const estado = await pedidoListo();
  const e = ejecutorDe(estado, 'sí, confirmo');
  const v = (await e.ejecutar('ver_pedido', {})).pedido;
  assert.equal(v.estado, LISTO, `esperaba listo, quedó ${v.estado} (falta: ${v.falta})`);
  const r = await e.ejecutar('confirmar_pedido', { huella_resumen: v.huella });
  assert.equal(r.aplicado, true, `no confirmó: ${r.motivo}`);
  assert.equal(estado.hechos.confirmado, true);
});

await t('E2 · una huella vieja NO confirma', async () => {
  const estado = await pedidoListo();
  const huellaVieja = (await ejecutorDe(estado, 'x').ejecutar('ver_pedido', {})).pedido.huella;
  // Entre el resumen y el «sí», el cliente agrega algo.
  await ejecutorDe(estado, 'agrégame una coca').ejecutar('agregar_producto', { producto_id: '21' });
  const r = await ejecutorDe(estado, 'sí').ejecutar('confirmar_pedido', { huella_resumen: huellaVieja });
  assert.equal(r.aplicado, false, 'confirmó un resumen que ya no era el pedido');
  assert.match(r.motivo, /resumen_caducado/);
  assert.equal(estado.hechos.confirmado, false);
  assert.ok(r.pedido, 'no devolvió el resumen fresco para volver a mostrarlo');
});

await t('E3 · un pedido incompleto no confirma ni con la huella correcta', async () => {
  const estado = nuevo();
  await ejecutorDe(estado, 'unos hotcakes').ejecutar('agregar_producto', { producto_id: '90' });
  const v = (await ejecutorDe(estado, 'x').ejecutar('ver_pedido', {})).pedido;
  assert.equal(v.estado, ARMANDO);
  const r = await ejecutorDe(estado, 'sí').ejecutar('confirmar_pedido', { huella_resumen: v.huella });
  assert.equal(r.aplicado, false, 'confirmó sin modalidad ni pago');
  assert.match(r.motivo, /no_se_puede_confirmar/);
});

await t('E4 · un grupo obligatorio sin elegir deja el pedido en aclarando', async () => {
  const estado = nuevo();
  const r = await ejecutorDe(estado, 'unos chilaquiles sencillos')
    .ejecutar('agregar_producto', { producto_id: '85' });
  assert.equal(r.aplicado, true, `no se agregó: ${r.motivo}`);
  assert.equal(r.pedido.estado, ACLARANDO, `quedó en ${r.pedido.estado}`);
  assert.equal(r.pedido.aclaraciones.length, 2, 'esperaba Salsa y Proteína sin elegir');
  assert.deepEqual(r.pedido.aclaraciones.map((a) => a.grupo).sort(), ['Proteína', 'Salsa']);
});

await t('E5 · el total solo existe si todos los renglones tienen precio', async () => {
  const estado = nuevo();
  await ejecutorDe(estado, 'unos hotcakes').ejecutar('agregar_producto', { producto_id: '90' });
  const conPrecio = crearEjecutor({ estado, catalogo: CARTA, precios: PRECIOS, mensaje: 'x' });
  assert.equal((await conPrecio.ejecutar('ver_pedido', {})).pedido.total, 95);
  const sinPrecio = crearEjecutor({ estado, catalogo: CARTA, precios: {}, mensaje: 'x' });
  assert.equal((await sinPrecio.ejecutar('ver_pedido', {})).pedido.total, null,
    'sacó un total parcial, que parece completo');
});

await t('E6 · la confirmación pasa por `efectos`, y sin ellos no cobra', async () => {
  const estado = await pedidoListo();
  const llamadas = [];
  const e = ejecutorDe(estado, 'sí', { efectos: {
    confirmar: async (args) => { llamadas.push(args); return { ok: true, folio: 'XAB-9001' }; } } });
  const v = (await e.ejecutar('ver_pedido', {})).pedido;
  const r = await e.ejecutar('confirmar_pedido', { huella_resumen: v.huella });
  assert.equal(r.folio, 'XAB-9001');
  assert.equal(llamadas.length, 1, 'no llamó al efecto, o lo llamó de más');
  assert.equal(estado.folio, 'XAB-9001');
});

await t('E7 · si el registro falla, el pedido NO queda confirmado', async () => {
  const estado = await pedidoListo();
  const e = ejecutorDe(estado, 'sí', { efectos: {
    confirmar: async () => ({ ok: false, motivo: 'la base no contesta' }) } });
  const v = (await e.ejecutar('ver_pedido', {})).pedido;
  const r = await e.ejecutar('confirmar_pedido', { huella_resumen: v.huella });
  assert.equal(r.aplicado, false);
  assert.equal(estado.hechos.confirmado, false, 'se dio por confirmado un pedido que no se registró');
});

await t('E8 · si el handoff falla, el pedido NO queda escalado', async () => {
  const estado = nuevo();
  const e = ejecutorDe(estado, 'quiero hablar con una persona', { efectos: {
    escalar: async () => ({ ok: false, motivo: 'la cola no contesta' }) } });
  const r = await e.ejecutar('pedir_humano', { motivo: 'cliente lo pidió' });
  assert.equal(r.aplicado, false);
  assert.match(r.motivo, /no_se_pudo_escalar/);
  assert.equal(estado.hechos.escalado, false, 'marcó escalado sin avisar a un humano');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── F. El libro de operaciones: una vez y solo una ──');

await t('F1 · la misma acción en el MISMO turno se ejecuta una sola vez', async () => {
  const libro = libroDeOperaciones(almacenEnMemoria());
  let veces = 0;
  const llamada = { negocioId: 'n1', conversacionId: 'c1', turnoId: 't1',
    herramienta: 'agregar_producto', argumentos: { producto_id: '21', cantidad: 1 } };
  const ejecutar = async () => { veces += 1; return { aplicada: true, resultado: { n: veces } }; };
  const a = await libro.ejecutarUnaVez(llamada, ejecutar);
  const b = await libro.ejecutarUnaVez({ ...llamada, toolCallId: 'otro' }, ejecutar);
  assert.equal(veces, 1, `se ejecutó ${veces} veces`);
  assert.equal(a.repetida, false);
  assert.equal(b.repetida, true, 'no detectó la repetición');
  assert.deepEqual(b.resultado, { n: 1 }, 'no devolvió el resultado guardado');
});

await t('F2 · la misma acción en OTRO turno sí se ejecuta: es lo que pidió el cliente', async () => {
  const libro = libroDeOperaciones(almacenEnMemoria());
  let veces = 0;
  const ejecutar = async () => { veces += 1; return { aplicada: true, resultado: {} }; };
  const base = { negocioId: 'n1', conversacionId: 'c1', herramienta: 'agregar_producto',
    argumentos: { producto_id: '21', cantidad: 1 } };
  await libro.ejecutarUnaVez({ ...base, turnoId: 't1' }, ejecutar);
  await libro.ejecutarUnaVez({ ...base, turnoId: 't2' }, ejecutar);
  assert.equal(veces, 2, '«otra igual» en el turno siguiente se tragó como duplicado');
});

await t('F3 · el orden de las claves de los argumentos no crea operaciones distintas', () => {
  assert.equal(hashDeArgumentos({ a: 1, b: [1, { x: 1, y: 2 }] }),
    hashDeArgumentos({ b: [1, { y: 2, x: 1 }], a: 1 }));
  assert.notEqual(hashDeArgumentos({ a: 1 }), hashDeArgumentos({ a: 2 }));
});

await t('F4 · la clave separa negocios y conversaciones', () => {
  const base = { negocioId: 'n1', conversacionId: 'c1', turnoId: 't1',
    herramienta: 'agregar_producto', argumentosHash: 'h' };
  assert.notEqual(claveDeOperacion(base), claveDeOperacion({ ...base, negocioId: 'n2' }));
  assert.notEqual(claveDeOperacion(base), claveDeOperacion({ ...base, conversacionId: 'c2' }));
});

await t('F5 · una ejecución que REVENTÓ no se da por aplicada: se reintenta', async () => {
  const libro = libroDeOperaciones(almacenEnMemoria());
  const llamada = { negocioId: 'n1', conversacionId: 'c1', turnoId: 't1',
    herramienta: 'agregar_producto', argumentos: { producto_id: '21' } };
  await assert.rejects(() => libro.ejecutarUnaVez(llamada, async () => { throw new Error('se cayó la base'); }));
  let segunda = false;
  const r = await libro.ejecutarUnaVez(llamada, async () => { segunda = true; return { aplicada: true, resultado: {} }; });
  assert.equal(segunda, true, 'dio por aplicada una operación que reventó');
  assert.equal(r.repetida, false);
});

await t('F6 · un rechazo del reconciliador SÍ es un desenlace cerrado', async () => {
  const libro = libroDeOperaciones(almacenEnMemoria());
  let veces = 0;
  const llamada = { negocioId: 'n1', conversacionId: 'c1', turnoId: 't1',
    herramienta: 'agregar_producto', argumentos: { producto_id: '21' } };
  const ejecutar = async () => { veces += 1; return { aplicada: false, estado: 'rechazada', resultado: { motivo: 'x' } }; };
  await libro.ejecutarUnaVez(llamada, ejecutar);
  const b = await libro.ejecutarUnaVez(llamada, ejecutar);
  assert.equal(veces, 1, 'reintentó un rechazo, que es determinista y daría lo mismo');
  assert.equal(b.repetida, true);
  assert.equal(b.aplicada, false);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── G. El «sí» a lo que el bot enseñó ──');

await t('G1 · un «sí» acepta lo que se enseñó, y solo si se enseñó UNO', async () => {
  const estado = nuevo();
  const e1 = ejecutorDe(estado, 'tienes coca?');
  await e1.ejecutar('buscar_producto', { texto: 'coca' });
  e1.cerrarTurno();
  const e2 = ejecutorDe(estado, 'sí porfa');
  const r = await e2.ejecutar('agregar_producto', { producto_id: '21' });
  assert.equal(r.aplicado, true, `un sí a lo enseñado no entró: ${r.motivo}`);
});

await t('G2 · con VARIOS candidatos, un «sí» no elige por el cliente', async () => {
  const estado = nuevo();
  const e1 = ejecutorDe(estado, 'tienen chilaquiles?');
  const b = await e1.ejecutar('buscar_producto', { texto: 'chilaquiles' });
  assert.ok(b.encontrados.length >= 2);
  e1.cerrarTurno();
  const r = await ejecutorDe(estado, 'sí').ejecutar('agregar_producto', { producto_id: '85' });
  assert.equal(r.aplicado, false, 'un «sí» ambiguo metió el primero de la lista');
});

await t('G3 · lo enseñado caduca al turno siguiente', async () => {
  const estado = nuevo();
  const e1 = ejecutorDe(estado, 'tienes coca?');
  await e1.ejecutar('buscar_producto', { texto: 'coca' });
  e1.cerrarTurno();
  const e2 = ejecutorDe(estado, 'ah ok');
  e2.cerrarTurno();                                    // pasa un turno sin enseñar nada
  const r = await ejecutorDe(estado, 'sí').ejecutar('agregar_producto', { producto_id: '21' });
  assert.equal(r.aplicado, false, 'un «sí» de hace dos turnos siguió autorizando');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── H. Los tres defectos que encontró el replay ──');

await t('H1 · «quita X, Y sí lo quiero» quita UNO, no los dos', async () => {
  const estado = nuevo();
  await ejecutorDe(estado, 'una coca y unos hotcakes')
    .ejecutar('agregar_producto', { producto_id: '21' });
  await ejecutorDe(estado, 'una coca y unos hotcakes')
    .ejecutar('agregar_producto', { producto_id: '90' });
  assert.equal(estado.carrito.items.length, 2);
  const lidHotcakes = estado.carrito.items.find((i) => i.nombre === 'Hotcakes').lid;
  const r = await ejecutorDe(estado, 'quita los hotcakes, la coca sí la quiero')
    .ejecutar('quitar_linea', { linea_id: lidHotcakes });
  assert.equal(r.aplicado, true, `no quitó: ${r.motivo}`);
  assert.deepEqual(estado.carrito.items.map((i) => i.nombre), ['Coca Cola'],
    'se llevó por delante el renglón que el cliente dijo que SÍ quería');
});

await t('H2 · una enumeración sin verbo propio SÍ sigue dentro del alcance de quitar', async () => {
  const carrito = { items: [{ lid: 'a', nombre: 'Hotcakes' }, { lid: 'b', nombre: 'Coca Cola' }] };
  const r = articulosQueElClientePidioQuitar(carrito, 'quita los hotcakes, la coca y ya');
  assert.deepEqual(r.fuera.sort(), ['a', 'b'],
    'una enumeración sin verbo propio dejó de quitar: el recorte se pasó de listo');
});

await t('H3 · «sin X» vacía el grupo, y solo si el cliente lo dijo', async () => {
  const estado = nuevo();
  const r0 = await ejecutorDe(estado, 'unos chilaquiles sencillos con salsa roja y huevos revueltos')
    .ejecutar('agregar_producto', { producto_id: '85',
      opciones: [{ grupo: 'Salsa', opcion: 'Roja' }, { grupo: 'Proteína', opcion: 'Huevos Revueltos' }] });
  assert.equal(r0.aplicado, true);
  const lid = estado.carrito.items[0].lid;

  // Sin que el cliente lo pida: no se vacía.
  const mudo = await ejecutorDe(estado, 'gracias')
    .ejecutar('modificar_linea', { linea_id: lid, sin_opciones: ['Proteína'] });
  assert.equal(mudo.aplicado, false, 'vació un grupo que nadie pidió vaciar');
  assert.ok(estado.carrito.items[0].modificadores.some((g) => g.grupo === 'Proteína'));

  // Diciéndolo: sí.
  const r = await ejecutorDe(estado, 'mejor sin huevo')
    .ejecutar('modificar_linea', { linea_id: lid, sin_opciones: ['Proteína'] });
  assert.equal(r.aplicado, true, `no vació: ${r.motivo}`);
  assert.ok(!estado.carrito.items[0].modificadores.some((g) => g.grupo === 'Proteína'),
    'el grupo siguió puesto después de autorizar el quitar');
  // Y al ser obligatorio, el renglón queda pendiente en vez de pasar por bueno.
  assert.equal(r.pedido.estado, ACLARANDO);
});

await t('H4 · quitar un grupo que el producto NO tiene se rechaza', async () => {
  const estado = nuevo();
  await ejecutorDe(estado, 'unos hotcakes').ejecutar('agregar_producto', { producto_id: '90' });
  const r = await ejecutorDe(estado, 'sin salsa')
    .ejecutar('modificar_linea', { linea_id: estado.carrito.items[0].lid, sin_opciones: ['Salsa'] });
  assert.equal(r.aplicado, false);
  assert.match(r.motivo, /grupo_inexistente/);
});

await t('H5 · dos acciones IDÉNTICAS en el mismo turno se aplican las dos', async () => {
  const libro = libroDeOperaciones(almacenEnMemoria());
  let veces = 0;
  const ejecutar = async () => { veces += 1; return { aplicada: true, resultado: { n: veces } }; };
  const base = { negocioId: 'n1', conversacionId: 'c1', turnoId: 't1',
    herramienta: 'agregar_producto', argumentos: { producto_id: '85' } };
  // «dos bowls iguales»: el modelo llama dos veces, ordinales 1 y 2.
  await libro.ejecutarUnaVez({ ...base, ocurrencia: 1 }, ejecutar);
  await libro.ejecutarUnaVez({ ...base, ocurrencia: 2 }, ejecutar);
  assert.equal(veces, 2, 'el segundo bowl se tragó como duplicado');
  // Y un reintento del turno entero reproduce los mismos ordinales: nada nuevo.
  await libro.ejecutarUnaVez({ ...base, ocurrencia: 1 }, ejecutar);
  await libro.ejecutarUnaVez({ ...base, ocurrencia: 2 }, ejecutar);
  assert.equal(veces, 2, 'el reintento del turno volvió a aplicar');
});

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
