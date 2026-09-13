// LA MEMORIA NO AUTORIZA, Y EL NOMBRE NO SE PRESTA ENTRE NEGOCIOS.
//
// Fases P y Q del Mesero Digital. Módulos puros.
//
// El caso que hay que cerrar antes que ninguno: `clientes.telefono` es CLAVE
// PRIMARIA GLOBAL en Xabor. Hay una sola fila por número para toda la
// plataforma y `nombre` se sobreescribe con el último que se haya visto, en el
// negocio que sea. Saludar con ese nombre es decirle a un restaurante cómo se
// llamó esa persona en otro.
import assert from 'node:assert/strict';

const { perfilDelCliente, nombreParaSaludar, repetirLoDeSiempre, atajosOperativos,
  perfilParaElModelo, PEDIDOS_QUE_CUENTAN } = await import('../src/mesero-whatsapp/memoriaDelCliente.js');
const { contextoNuevo, anotarTurno } = await import('../src/mesero-whatsapp/contextoMesa.js');
const { proponer, leerRespuesta, aplicarDesenlace, evidenciaDeAceptacion } =
  await import('../src/mesero-whatsapp/propuestasDelBot.js');
const { reconciliar, carritoVacio } = await import('../src/orders/carritoDelPedido.js');

let ok = 0, fail = 0; const fallos = [];
function t(nombre, fn) {
  try { fn(); ok++; console.log(`  OK  ${nombre}`); }
  catch (e) { fail++; fallos.push(`${nombre}: ${e.message}`); console.log(`FALLO ${nombre}: ${e.message}`); }
}

const A = 'neg-alfa', B = 'neg-beta';
const pedido = (negocio_id, nombre, items, extra = {}) => ({
  negocio_id, datos: { cliente: { nombre }, items, ...extra },
});
const CARTA = [{ id: 1, nombre: 'Fuertes', productos: [
  { id: 1, nombre: 'Birria de Res', precio: 150, disponible: true, agotado: false, modificadores: [] },
  { id: 2, nombre: 'Consome', precio: 45, disponible: true, agotado: false, modificadores: [] },
  { id: 3, nombre: 'Tacos Dorados', precio: 80, disponible: true, agotado: true, modificadores: [] },
] }];

const HISTORIAL = [
  pedido(A, 'Mario', [{ nombre: 'Birria de Res', cantidad: 1 }, { nombre: 'Consome', cantidad: 1 }],
    { modalidad: 'recoger', forma_pago: 'efectivo' }),
  pedido(A, 'Mario', [{ nombre: 'Birria de Res', cantidad: 2 }], { modalidad: 'recoger', forma_pago: 'efectivo' }),
  pedido(A, 'Mario', [{ nombre: 'Tacos Dorados', cantidad: 1 }], { modalidad: 'recoger', forma_pago: 'tarjeta' }),
];

// ── FASE Q — reconocer al cliente ───────────────────────────────────────────

t('Q1. sin pedidos en este negocio no se conoce a nadie, y no se saluda por nombre', () => {
  const p = perfilDelCliente([], { negocioId: A });
  assert.equal(p.conoce, false);
  assert.equal(nombreParaSaludar(p), null);
  assert.equal(perfilParaElModelo(p), null);
});

t('Q2. el nombre que dejó en OTRO negocio no se usa aquí', () => {
  // La misma persona pidió en el negocio B y dejó su nombre allá.
  const historialAjeno = [pedido(B, 'Mario', [{ nombre: 'Pizza', cantidad: 1 }])];
  const p = perfilDelCliente(historialAjeno, { negocioId: A });
  assert.equal(p.conoce, false, 'se adoptó el historial de otro negocio');
  assert.equal(nombreParaSaludar(p), null, 'se filtró a un negocio el nombre que se dio a otro');
});

t('Q3. mezclar historiales solo deja pasar el del negocio que pregunta', () => {
  const mezclado = [
    pedido(B, 'Mario Cantu', [{ nombre: 'Pizza', cantidad: 1 }]),
    ...HISTORIAL,
    pedido(B, 'Mario Cantu', [{ nombre: 'Pizza', cantidad: 3 }]),
  ];
  const p = perfilDelCliente(mezclado, { negocioId: A });
  assert.equal(p.visitas, 3, 'contó pedidos de otro negocio');
  assert(!p.favoritos.some((f) => f.nombre === 'Pizza'), 'un producto de otra carta entró al perfil');
});

t('Q4. el nombre sale del pedido de este negocio, y solo el primero', () => {
  const p = perfilDelCliente(HISTORIAL, { negocioId: A });
  assert.equal(p.nombre, 'Mario');
  assert.equal(nombreParaSaludar(p), 'Mario');
  const conApellido = perfilDelCliente([pedido(A, 'Ana Sofia Perez', [{ nombre: 'Consome', cantidad: 1 }])],
    { negocioId: A });
  assert.equal(nombreParaSaludar(conApellido), 'Ana', 'saludó con el nombre completo');
});

t('Q5. un «nombre» que no es un nombre no se usa', () => {
  for (const basura of ['', ' ', 'X', '2', '12345', null]) {
    const p = perfilDelCliente([pedido(A, basura, [{ nombre: 'Consome', cantidad: 1 }])], { negocioId: A });
    assert.equal(nombreParaSaludar(p), null, `se saludó con "${basura}"`);
  }
});

t('Q6. sin negocio no hay perfil: no se puede fallar hacia el lado abierto', () => {
  assert.equal(perfilDelCliente(HISTORIAL, {}).conoce, false);
  assert.equal(perfilDelCliente(HISTORIAL, { negocioId: '' }).conoce, false);
  assert.equal(perfilDelCliente(null, { negocioId: A }).conoce, false);
});

// ── FASE P — el historial propone, nunca pide ───────────────────────────────

t('P1. los favoritos salen de lo que pidió aquí, ordenados por cantidad', () => {
  const p = perfilDelCliente(HISTORIAL, { negocioId: A });
  assert.equal(p.favoritos[0].nombre, 'Birria de Res');
  assert.equal(p.favoritos[0].veces, 3);
  assert.equal(p.modalidadHabitual, 'recoger');
  assert.equal(p.pagoHabitual, 'efectivo');
});

t('P2. un favorito agotado NO se ofrece', () => {
  const soloTacos = [pedido(A, 'Mario', [{ nombre: 'Tacos Dorados', cantidad: 5 }])];
  const p = perfilDelCliente(soloTacos, { negocioId: A });
  assert.equal(p.favoritos[0].nombre, 'Tacos Dorados');
  assert.deepEqual(repetirLoDeSiempre(p, { catalogo: CARTA }), [],
    'se ofreció repetir algo que hoy no hay');
});

t('P3. un favorito que ya no está en la carta tampoco', () => {
  const p = perfilDelCliente([pedido(A, 'Mario', [{ nombre: 'Menudo', cantidad: 4 }])], { negocioId: A });
  assert.deepEqual(repetirLoDeSiempre(p, { catalogo: CARTA }), []);
});

t('P4. lo que ya está en el pedido de hoy no se ofrece a repetir', () => {
  const p = perfilDelCliente(HISTORIAL, { negocioId: A });
  const r = repetirLoDeSiempre(p, { catalogo: CARTA, carrito: { items: [{ nombre: 'Birria de Res' }] } });
  assert(!r.some((x) => x.nombre === 'Birria de Res'), JSON.stringify(r));
});

t('P5. EL HISTORIAL NO AGREGA NADA: solo produce una propuesta', () => {
  const p = perfilDelCliente(HISTORIAL, { negocioId: A });
  const sugerencias = repetirLoDeSiempre(p, { catalogo: CARTA });
  assert.equal(sugerencias[0].nombre, 'Birria de Res');
  assert.equal(sugerencias[0].motivo, 'lo_pidio_antes');

  // El cliente escribe algo que no nombra el producto. Aunque el modelo lo
  // meta al borrador, el reconciliador no tiene con qué autorizarlo: haber
  // pedido birria la vez pasada no es evidencia de pedirla hoy.
  const { carrito } = reconciliar(carritoVacio(), { items: [{ nombre: 'Birria de Res', cantidad: 1 }] },
    { mensaje: 'hola, buenas tardes', textoCiclo: 'hola, buenas tardes' });
  assert.deepEqual(carrito.items, [], 'la memoria autorizó un pedido');
});

t('P6. la propuesta del historial necesita el mismo «sí» que cualquier otra', () => {
  const ctx = contextoNuevo({ negocioId: A, conversacionId: 'c1' });
  anotarTurno(ctx, 'cliente', 'hola');
  anotarTurno(ctx, 'bot', 'la vez pasada pediste Birria de Res, ¿te la repito?');
  proponer(ctx, { clase: 'repetir', referencia: 'Birria de Res' });

  anotarTurno(ctx, 'cliente', 'si porfa');
  const d = leerRespuesta(ctx, 'si porfa');
  aplicarDesenlace(ctx, d);
  assert.equal(d.aceptadas.length, 1);

  // Y solo ese «sí» produce la evidencia con la que el carrito la deja entrar.
  const evidencia = evidenciaDeAceptacion(d.aceptadas);
  const { carrito } = reconciliar(carritoVacio(), { items: [{ nombre: 'Birria de Res', cantidad: 1 }] },
    { mensaje: `si porfa ${evidencia}`, textoCiclo: `hola si porfa ${evidencia}` });
  assert.equal(carrito.items.length, 1, 'el sí a una propuesta del historial no bastó');
  assert.equal(carrito.items[0].nombre, 'Birria de Res');
});

t('P7. los atajos operativos son sugerencias, no valores puestos', () => {
  const p = perfilDelCliente(HISTORIAL, { negocioId: A });
  const a = atajosOperativos(p);
  assert.equal(a.modalidadSugerida, 'recoger');
  assert.equal(a.pagoSugerido, 'efectivo');
  // Y ninguna de las dos claves se llama como las del carrito: nadie las puede
  // volcar por descuido en `datos`.
  assert.equal(a.modalidad, undefined);
  assert.equal(a.forma_pago, undefined);
});

t('P8. solo cuentan los últimos pedidos, no la vida entera del cliente', () => {
  const muchos = Array.from({ length: PEDIDOS_QUE_CUENTAN + 5 },
    (_, i) => pedido(A, 'Mario', [{ nombre: i < 3 ? 'Consome' : 'Birria de Res', cantidad: 1 }]));
  const p = perfilDelCliente(muchos, { negocioId: A });
  assert.equal(p.visitas, PEDIDOS_QUE_CUENTAN);
});

t('P9. lo que se le pasa al modelo no lleva teléfono ni el historial crudo', () => {
  const p = perfilDelCliente(HISTORIAL, { negocioId: A });
  const paraEl = JSON.stringify(perfilParaElModelo(p));
  assert(!/telefono|negocio_id|neg-alfa/.test(paraEl), paraEl);
  assert(/Mario/.test(paraEl), 'el nombre sí es útil y sí va');
  assert(/Birria de Res/.test(paraEl));
});

console.log(`\n${fail === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${ok} pasadas, ${fail} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
process.exit(fail ? 1 : 0);
