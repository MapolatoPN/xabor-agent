// ─── EL PEDIDO QUE SE INTENTARÍA CREAR, SIN CREARLO ───────────────────────
//
// El artefacto contesta: «si esto se autorizara ahora, ¿qué estructura exacta
// intentaría crear Xabor?». Lo que se prueba aquí es que contesta la verdad y
// que no puede hacer nada más que contestar.
//
// ── LAS TRES CAPAS, Y POR QUÉ ESTA ES LA DE EN MEDIO ────────────────────
//
//   A  ESTADO CONVERSACIONAL   carrito, resumen, cliente, modalidad, pago
//   B  ARTEFACTO HIPOTÉTICO    la propuesta que iría al borde   ← esto
//   C  PEDIDO PERSISTIDO       con id, folio, totales, sellos de la base
//
// `registrarPedido` no recibe un pedido: recibe una PROPUESTA y la canoniza
// contra el catálogo real. Un artefacto que intentara producir C duplicaría al
// validador, que es la barrera que impide que el modelo invente precios.
//
// Por eso aquí no se afirma ni un importe: medido en validadorOrden.js:
// 1026-1045, el `precio_unitario` del llamador se ignora como autoridad y si
// no viene ni se anota. El dinero es del borde.
import assert from 'node:assert/strict';
import { construirPedidoHipotetico, LOS_PONE_EL_BORDE } from '../src/mesero-whatsapp/pedidoHipotetico.js';
import { atenderTurno } from '../src/mesero-whatsapp/meseroDigital.js';

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

// ── EL FIXTURE CERTIFICADO ───────────────────────────────────────────────
const g = (nombre, minimo, maximo, opciones, requerido = true) => ({
  nombre, requerido, minimo, maximo,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});
const CARTA = [
  { id: 26, nombre: 'CHILAQUILES', orden: 1, productos: [
    { id: 85, nombre: 'Chilaquiles Sencillos', orden: 0, precio: 195, disponible: true,
      opciones: { variante: { base: true } },
      modificadores: [g('Salsa', 1, 1, ['Roja', 'Suiza', 'Chipotle']),
        g('Proteina', 1, 1, ['Huevos Estrellados', 'Pechuga de pollo']),
        g('Guarniciones', 1, 2, ['Frijolitos con chorizo', 'Papas a la mexicana'])] },
    { id: 107, nombre: 'Chilaquiles Mixtos', orden: 1, precio: 215, disponible: true,
      opciones: { variante: { discriminadores: ['mixtos'] } },
      modificadores: [g('Salsa', 2, 2, ['Roja', 'Suiza', 'Chipotle']),
        g('Proteina', 1, 1, ['Huevos Estrellados', 'Pechuga de pollo']),
        g('Guarniciones', 1, 2, ['Frijolitos con chorizo', 'Papas a la mexicana'])] },
  ] },
  { id: 40, nombre: 'BEBIDAS', orden: 2, productos: [
    { id: 90, nombre: 'Coca Cola', orden: 0, precio: 35, disponible: true }] },
];

// El pedido ya certificado: una línea, un lid, Mixtos 107.
const LINEA_107 = () => ({
  lid: 'L1', nombre: 'Chilaquiles Mixtos', id: 107, cantidad: 1, notas: '',
  modificadores: [
    { grupo: 'Salsa', opciones: ['Suiza', 'Chipotle'] },
    { grupo: 'Proteina', opciones: ['Huevos Estrellados'] },
    { grupo: 'Guarniciones', opciones: ['Frijolitos con chorizo'] },
  ],
});
const CLIENTE_AUTORIZADO = { nombre: 'Mario', calle: 'Reforma 200' };
const DATOS = () => ({
  modalidad: 'entrega a domicilio',
  forma_pago: 'efectivo',
  cliente: { ...CLIENTE_AUTORIZADO },
});
const CARRITO = (extra = {}) => ({ items: [LINEA_107()], datos: { ...DATOS(), ...extra } });

const IDENTIDAD = {
  negocioId: '5de544d8-9a0a-4972-9c92-fd48ff22de66',
  canal: 'whatsapp',
  telefonoConversacion: '5218781234567',
};
const construir = (over = {}) => construirPedidoHipotetico({
  carrito: CARRITO(), catalogo: CARTA, ...IDENTIDAD,
  aclaraciones: [], falta: [], confirmacionVigente: true, requierePago: true,
  ...over,
});

console.log('\n══ T1-T5. LA LÍNEA, SU IDENTIDAD Y SUS OPCIONES ══');

await t('T1. una línea conversacional produce un item hipotético', () => {
  const a = construir();
  assert.equal(a.listo, true, `bloqueos: ${JSON.stringify(a.bloqueos)}`);
  assert.equal(a.propuesta.items.length, 1, JSON.stringify(a.propuesta.items));
});

await t('T2. el producto_id sale del catálogo, no del nombre', () => {
  assert.equal(construir().propuesta.items[0].producto_id, 107);
});

await t('T2b. y si el renglón no está en la carta, no hay artefacto listo', () => {
  const carrito = { items: [{ lid: 'L9', nombre: 'Sopa de Piedra', cantidad: 1 }], datos: DATOS() };
  const a = construir({ carrito });
  assert.equal(a.listo, false);
  assert.ok(a.bloqueos.some((b) => b.startsWith('producto_sin_id:')), JSON.stringify(a.bloqueos));
});

await t('T3. la cantidad es la del carrito', () => {
  const carrito = CARRITO();
  carrito.items[0].cantidad = 3;
  assert.equal(construir({ carrito }).propuesta.items[0].cantidad, 3);
});

await t('T4. los modificadores viajan canónicos y por grupo', () => {
  const mods = construir().propuesta.items[0].modificadores;
  assert.deepEqual(mods, [
    { grupo: 'Salsa', opciones: ['Suiza', 'Chipotle'] },
    { grupo: 'Proteina', opciones: ['Huevos Estrellados'] },
    { grupo: 'Guarniciones', opciones: ['Frijolitos con chorizo'] },
  ], JSON.stringify(mods));
});

await t('T5. la variante es la 107, no la 85', () => {
  const it = construir().propuesta.items[0];
  assert.equal(it.producto_id, 107);
  assert.equal(it.nombre, 'Chilaquiles Mixtos');
  assert.equal(it.categoria_id, 26);
});

console.log('\n══ T6-T9. CLIENTE, MODALIDAD, PAGO E IDENTIDAD ══');

await t('T6. el cliente lleva sólo los campos autorizados', () => {
  const c = construir().propuesta.cliente;
  assert.deepEqual(Object.keys(c).sort(), ['calle', 'nombre']);
  assert.equal(c.nombre, 'Mario');
  assert.equal(c.calle, 'Reforma 200');
});

await t('T6b. no completa ni infiere lo que nadie autorizó', () => {
  const c = construir().propuesta.cliente;
  for (const campo of ['colonia', 'numero_interior', 'referencia', 'telefono', 'direccion']) {
    assert.equal(c[campo], undefined, `inventó ${campo}: ${JSON.stringify(c)}`);
  }
});

await t('T6c. y `cliente` existe siempre, aunque vaya vacío', () => {
  // El canal hace `orden.cliente.telefono = ...` SIN optional chaining
  // (whatsapp-meta.js:1189): una propuesta sin `cliente` revienta ahí.
  const carrito = { items: [LINEA_107()], datos: { modalidad: 'recoger en tienda', forma_pago: 'efectivo' } };
  const a = construir({ carrito });
  assert.deepEqual(a.propuesta.cliente, {}, JSON.stringify(a.propuesta.cliente));
});

await t('T7. la modalidad es la autorizada', () => {
  assert.equal(construir().propuesta.modalidad, 'entrega a domicilio');
});

await t('T8. el pago es el autorizado, sin normalizar', () => {
  // `forma_pago` sobrevive crudo hasta el validador, que resuelve el canónico
  // aparte en `forma_pago_tipo`. Normalizar aquí sería inventar contrato.
  assert.equal(construir().propuesta.forma_pago, 'efectivo');
  assert.equal(construir().propuesta.forma_pago_tipo, undefined);
});

await t('T9. negocio, canal y teléfono NO vienen del carrito', () => {
  // Los sella el canal. Aunque el borrador los metiera en `datos`, el
  // artefacto usa los que le pasa quien llama.
  const carrito = CARRITO();
  carrito.datos.negocioId = 'negocio-inventado-por-el-modelo';
  carrito.datos.canal = 'inventado';
  carrito.datos.telefono_conversacion = '0000000000';
  const p = construir({ carrito }).propuesta;
  assert.equal(p.negocioId, IDENTIDAD.negocioId);
  assert.equal(p.canal, 'whatsapp');
  assert.equal(p.telefono_conversacion, IDENTIDAD.telefonoConversacion);
});

await t('T9b. sin identidad no hay propuesta', () => {
  for (const falta of [{ negocioId: null }, { canal: null }]) {
    const a = construir(falta);
    assert.equal(a.propuesta, null, JSON.stringify(a));
    assert.equal(a.listo, false);
  }
});

console.log('\n══ T10. LO QUE PONE EL BORDE, NO EL MESERO ══');

await t('T10. ni id, ni folio, ni timestamp, ni dinero', () => {
  const p = construir().propuesta;
  for (const campo of LOS_PONE_EL_BORDE) {
    assert.equal(p[campo], undefined, `el artefacto afirmó ${campo}: ${JSON.stringify(p[campo])}`);
  }
});

await t('T10b. tampoco dentro de los items', () => {
  const it = construir().propuesta.items[0];
  for (const campo of ['precio_unitario', 'precio_base', 'subtotal', 'total', 'id', 'folio']) {
    assert.equal(it[campo], undefined, `el item afirmó ${campo}`);
  }
});

await t('T10c. el lid viaja aparte y no es contrato', () => {
  // En los 33 items reales medidos no aparece ni una vez. Va con guion bajo
  // para que nadie lo confunda con un campo del pedido.
  const it = construir().propuesta.items[0];
  assert.equal(it._lid, 'L1');
  assert.equal(it.lid, undefined);
});

console.log('\n══ T11-T14. PUREZA: EL GRAFO, NO LA INTENCIÓN ══');

const grafoDe = async (entrada) => {
  const { readFileSync } = await import('node:fs');
  const { dirname, resolve, relative } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const vistos = new Set();
  const cola = [resolve(RAIZ, entrada)];
  while (cola.length) {
    const archivo = cola.pop();
    if (vistos.has(archivo)) continue;
    vistos.add(archivo);
    const fuente = readFileSync(archivo, 'utf8');
    for (const m of fuente.matchAll(/(?:^import[^;]*from|^import|await import\()\s*'([^']+)'/gm)) {
      const spec = m[1];
      if (spec.startsWith('node:')) continue;
      assert(spec.startsWith('.'), `${relative(RAIZ, archivo)} alcanza el paquete "${spec}"`);
      cola.push(resolve(dirname(archivo), spec));
    }
  }
  const lista = [...vistos];
  // ── SE MIRA EL CÓDIGO, NO LOS COMENTARIOS ──────────────────────────────
  //
  // Este módulo EXPLICA en su cabecera por qué no construye el pedido final, y
  // para explicarlo nombra a `registrarPedido` y a `validarOrdenPropuesta`.
  // Un caminante que busque la palabra en el texto crudo tumba la prueba por
  // la documentación, que es el peor incentivo posible: obligaría a borrar la
  // explicación para que pase. Una llamada de verdad sobrevive a quitar
  // comentarios; una mención no.
  const sinComentarios = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
  return {
    modulos: lista.map((a) => relative(RAIZ, a).replace(/\\/g, '/')),
    fuentes: lista.map((a) => sinComentarios(readFileSync(a, 'utf8'))),
  };
};
const ARTEFACTO = 'src/mesero-whatsapp/pedidoHipotetico.js';

await t('T11. el artefacto no puede alcanzar la persistencia', async () => {
  const { modulos, fuentes } = await grafoDe(ARTEFACTO);
  for (const m of modulos) {
    for (const p of ['services/database', 'orders/orderManager', 'channels/', 'server.js']) {
      assert.equal(m.includes(p), false, `alcanza ${m} (prohibido: ${p})`);
    }
  }
  for (const [i, src] of fuentes.entries()) {
    for (const fn of ['registrarPedido', 'guardarPedidoActivo', 'INSERT INTO', 'pool.query']) {
      assert.equal(src.includes(fn), false, `${modulos[i]} nombra ${fn}`);
    }
  }
});

await t('T12. ni la impresión', async () => {
  const { modulos, fuentes } = await grafoDe(ARTEFACTO);
  for (const m of modulos) assert.equal(m.includes('services/impresion'), false, `alcanza ${m}`);
  for (const [i, src] of fuentes.entries()) {
    for (const fn of ['imprimirComanda', 'imprimirTicketCliente', 'encolarImpresion']) {
      assert.equal(src.includes(fn), false, `${modulos[i]} nombra ${fn}`);
    }
  }
});

await t('T13. ni los pagos ni la facturación', async () => {
  const { modulos, fuentes } = await grafoDe(ARTEFACTO);
  for (const m of modulos) {
    for (const p of ['services/clip-api', 'services/pagos', 'services/webhookPagos', 'services/facturapi']) {
      assert.equal(m.includes(p), false, `alcanza ${m} (prohibido: ${p})`);
    }
  }
  for (const [i, src] of fuentes.entries()) {
    assert.equal(src.includes('crearEnlacePago'), false, `${modulos[i]} nombra crearEnlacePago`);
  }
});

await t('T14. ni la red, ni un folio, ni un modelo', async () => {
  const { modulos, fuentes } = await grafoDe(ARTEFACTO);
  for (const [i, src] of fuentes.entries()) {
    for (const fn of ['fetch(', 'siguienteFolio', 'reservarFolio', 'nextval', 'anthropic', 'openai']) {
      assert.equal(src.toLowerCase().includes(fn.toLowerCase()), false, `${modulos[i]} nombra ${fn}`);
    }
  }
  // Y el grafo entero es de UN módulo: si crece, que alguien lo mire aposta.
  assert.deepEqual(modulos, [ARTEFACTO], `el grafo creció: ${JSON.stringify(modulos)}`);
});

console.log('\n══ T15-T18. DOS LÍNEAS, CONSULTAS, CAMBIOS Y VIGENCIA ══');

await t('T15. dos líneas dan dos items, sin mezclar lids', () => {
  const carrito = {
    items: [LINEA_107(), { lid: 'L2', nombre: 'Coca Cola', id: 90, cantidad: 2, notas: '', modificadores: [] }],
    datos: DATOS(),
  };
  const items = construir({ carrito }).propuesta.items;
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.producto_id), [107, 90]);
  assert.deepEqual(items.map((i) => i._lid), ['L1', 'L2']);
  assert.deepEqual(items.map((i) => i.cantidad), [1, 2]);
  assert.deepEqual(items[1].modificadores, [], 'le colgó los modificadores de la otra línea');
});

await t('T16. una consulta posterior no cambia el artefacto', async () => {
  const antes = construir().propuesta;
  const r = await atenderTurno({
    negocioId: IDENTIDAD.negocioId, conversacionId: 'c-consulta', mensaje: '¿qué bebidas tienes?',
    catalogo: CARTA, requierePago: true, carrito: CARRITO(), proponer: async () => null,
  });
  const despues = construirPedidoHipotetico({
    carrito: r.carrito, catalogo: CARTA, ...IDENTIDAD,
    aclaraciones: r.aclaraciones, falta: r.falta, confirmacionVigente: true, requierePago: true,
  }).propuesta;
  assert.equal(JSON.stringify(despues), JSON.stringify(antes), 'la consulta movió el artefacto');
});

await t('T17. un cambio autorizado antes de confirmar SÍ lo cambia', async () => {
  const r = await atenderTurno({
    negocioId: IDENTIDAD.negocioId, conversacionId: 'c-cambio', mensaje: 'mejor con tarjeta',
    catalogo: CARTA, requierePago: true, carrito: CARRITO(),
    proponer: async () => ({ items: [], forma_pago: 'terminal' }),
  });
  const a = construirPedidoHipotetico({
    carrito: r.carrito, catalogo: CARTA, ...IDENTIDAD,
    aclaraciones: r.aclaraciones, falta: r.falta, confirmacionVigente: true, requierePago: true,
  });
  assert.equal(a.propuesta.forma_pago, 'terminal', JSON.stringify(a.propuesta));
});

await t('T18. con el resumen no vigente, el artefacto NO está listo', () => {
  const a = construir({ confirmacionVigente: false });
  assert.equal(a.listo, false);
  assert.ok(a.bloqueos.includes('resumen_no_vigente'), JSON.stringify(a.bloqueos));
  // Se puede MIRAR —media gracia de observar en sombra— pero no entregar.
  assert.notEqual(a.propuesta, null, 'dejó de poder observarse');
});

await t('T18b. y lo que falta bloquea, uno por uno', () => {
  const casos = [
    [{ carrito: { items: [LINEA_107()], datos: { forma_pago: 'efectivo' } } }, 'sin_modalidad'],
    [{ carrito: { items: [LINEA_107()], datos: { modalidad: 'recoger en tienda' } } }, 'sin_pago'],
    [{ aclaraciones: [{ tipo: 'grupo_requerido', grupo: 'Salsa' }] }, 'aclaraciones_abiertas'],
    [{ falta: ['modalidad'] }, 'falta:modalidad'],
    [{ carrito: { items: [], datos: DATOS() } }, 'sin_items'],
  ];
  for (const [over, esperado] of casos) {
    const a = construir(over);
    assert.equal(a.listo, false, `debió bloquear por ${esperado}`);
    assert.ok(a.bloqueos.includes(esperado), `${esperado} no apareció: ${JSON.stringify(a.bloqueos)}`);
  }
});

console.log('\n══ IDEMPOTENCIA ══');

await t('I1. el mismo estado da el mismo artefacto, byte a byte', () => {
  const a = JSON.stringify(construir());
  const b = JSON.stringify(construir());
  assert.equal(a, b);
});

await t('I2. y el módulo no tiene de dónde sacar algo no determinista', async () => {
  // I1 mide el resultado; esto mira la causa. Husmear UUIDs en la salida no
  // servía: el `negocioId` del fixture ES un UUID, así que la prueba se
  // disparaba con un dato de ENTRADA perfectamente legítimo. Lo que importa
  // no es que aparezca un UUID, es que el módulo pueda FABRICAR uno.
  const { readFileSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const src = readFileSync(resolve(RAIZ, ARTEFACTO), 'utf8');
  for (const fuente of ['randomUUID', 'Math.random', 'Date.now', 'new Date', 'process.hrtime']) {
    assert.equal(src.includes(fuente), false, `el artefacto puede fabricar algo no determinista: ${fuente}`);
  }
});

await t('I3. y el artefacto no cambia si el estado no cambia, ni entre carritos clonados', () => {
  const uno = construir({ carrito: CARRITO() });
  const dos = construir({ carrito: JSON.parse(JSON.stringify(CARRITO())) });
  assert.equal(JSON.stringify(uno), JSON.stringify(dos));
});

console.log(`\n${'─'.repeat(70)}`);
console.log(`PASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
