// ─── EL HANDOFF QUE HABRÍA OCURRIDO, OBSERVADO SIN OCURRIR ────────────────
//
// `pedidoHipotetico` contesta QUÉ cruzaría el borde. Esto contesta CUÁNDO, y
// prueba que la sombra sella la identidad igual que el canal productivo y que
// no puede hacer nada más que mirar.
//
// La frontera real son cuatro asignaciones y una llamada (whatsapp-meta.js):
//
//   1188  orden.canal = 'whatsapp'
//   1189  orden.cliente.telefono = orden.cliente.telefono || telefono
//   1197  orden.negocioId = negocioId
//   1203  orden.telefono_conversacion = telefono
//   1210  await registrarPedido(orden, 'whatsapp')
//
// Se reproducen las cuatro y se para antes de la quinta.
//
// Los dos teléfonos NO son el mismo — incidente XAB-0114: el cliente puede
// dictar un teléfono de ENTREGA distinto del suyo, y la identidad de la
// conversación es siempre el remitente del webhook. Por eso uno lleva `||` y
// el otro no.
import assert from 'node:assert/strict';
import { atenderTurno } from '../src/mesero-whatsapp/meseroDigital.js';
import { handoffDeSombra, huellaDeLaPropuesta, registroDeHandoff, lineaDeHandoff }
  from '../src/mesero-whatsapp/handoffDeSombra.js';
import { pareceSensibleElRegistro, observarTurnoDelMesero, reiniciarSombraMesero }
  from '../src/mesero-whatsapp/sombraDelMesero.js';

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

// ── La carta de Obispado, con las dos presentaciones ─────────────────────
const g = (nombre, minimo, maximo, opciones, requerido = true) => ({
  nombre, requerido, minimo, maximo,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});
const SALSAS = ['Roja', 'Suiza', 'Verde', 'Chipotle'];
const PROTS = ['Huevos Estrellados', 'Pechuga de pollo'];
const GUARNS = ['Frijolitos naturales', 'Frijolitos con chorizo', 'Papas a la mexicana'];
const CARTA = [
  { id: 26, nombre: 'CHILAQUILES', orden: 1, productos: [
    { id: 85, nombre: 'Chilaquiles Sencillos', orden: 0, precio: 195, disponible: true,
      opciones: { variante: { base: true } },
      modificadores: [g('Salsa', 1, 1, SALSAS), g('Proteina', 1, 1, PROTS), g('Guarniciones', 1, 2, GUARNS)] },
    { id: 107, nombre: 'Chilaquiles Mixtos', orden: 1, precio: 215, disponible: true,
      opciones: { variante: { discriminadores: ['mixtos'] } },
      modificadores: [g('Salsa', 2, 2, SALSAS), g('Proteina', 1, 1, PROTS), g('Guarniciones', 1, 2, GUARNS)] },
  ] },
  { id: 40, nombre: 'BEBIDAS', orden: 2, productos: [
    { id: 90, nombre: 'Coca Cola', orden: 0, precio: 35, disponible: true },
    { id: 91, nombre: 'Licuado de fresa', orden: 1, precio: 60, disponible: true },
  ] },
];

// La identidad la sella el canal. El modelo no la ve.
const SELLO = {
  negocioId: '5de544d8-9a0a-4972-9c92-fd48ff22de66',
  canal: 'whatsapp',
  telefonoConversacion: '5218781234567',
};

const LINEA = () => ({
  lid: 'L1', nombre: 'Chilaquiles Mixtos', id: 107, cantidad: 1, notas: '',
  modificadores: [
    { grupo: 'Salsa', opciones: ['Suiza', 'Chipotle'] },
    { grupo: 'Proteina', opciones: ['Huevos Estrellados'] },
    { grupo: 'Guarniciones', opciones: ['Frijolitos con chorizo'] },
  ],
});

let n = 0;
function conversacion(id = `c${n += 1}`, datos = {}) {
  let contexto = null;
  let carrito = { items: [LINEA()], datos: { ...datos } };
  let previo = null;
  return {
    get carrito() { return carrito; },
    get previo() { return previo; },
    recordar(h) { if (h.listo) previo = h.huella; return h; },
    async turno(mensaje, borrador = null, extra = {}) {
      const r = await atenderTurno({
        negocioId: SELLO.negocioId, conversacionId: id, mensaje,
        catalogo: CARTA, requierePago: true,
        contextoGuardado: contexto, carrito,
        proponer: async () => borrador,
        ...extra,
      });
      contexto = r.contexto;
      carrito = r.carrito;
      r.handoff = handoffDeSombra(r, { ...SELLO, catalogo: CARTA, handoffPrevio: previo });
      return r;
    },
  };
}

// Llevar una conversación hasta tener resumen vigente, sin confirmar.
const hastaResumen = async (id) => {
  const c = conversacion(id);
  await c.turno('a domicilio, vivo en Reforma 200',
    { items: [], modalidad: 'entrega a domicilio', cliente: { calle: 'Reforma 200' } });
  const r = await c.turno('pago en efectivo', { items: [], forma_pago: 'efectivo' });
  assert.equal(r.listoParaConfirmar, true, `no llegó a listo: ${JSON.stringify(r.falta)}`);
  return c;
};

console.log('\n══ S1-S5. CUÁNDO HAY HANDOFF, Y CUÁNDO NO ══');

await t('S1. pedido incompleto → handoff_ready=false', async () => {
  const c = conversacion();
  const r = await c.turno('con salsa suiza porfa', { items: [] });
  assert.equal(r.handoff.listo, false, JSON.stringify(r.handoff.bloqueos));
  assert.ok(r.handoff.bloqueos.includes('sin_modalidad'), JSON.stringify(r.handoff.bloqueos));
});

await t('S2. completo pero sin resumen vigente → false', async () => {
  const c = conversacion();
  // Todo en un turno: nunca se le enseñó un resumen que revisar.
  const r = await c.turno('a domicilio, pago en efectivo, confirmo',
    { items: [], modalidad: 'entrega a domicilio', forma_pago: 'efectivo' });
  assert.equal(r.handoff.listo, false);
  assert.ok(r.handoff.bloqueos.includes('resumen_no_vigente'), JSON.stringify(r.handoff.bloqueos));
});

await t('S3. resumen vigente pero SIN confirmación → false', async () => {
  const c = await hastaResumen('s3');
  const r = await c.turno('gracias', null);
  assert.equal(r.handoff.listo, false);
  assert.ok(r.handoff.bloqueos.includes('sin_confirmacion'), JSON.stringify(r.handoff.bloqueos));
});

await t('S4. confirmación sin resumen previo → false', async () => {
  const c = conversacion();
  const r = await c.turno('sí, confirmo', { items: [] });
  assert.equal(r.handoff.listo, false);
});

await t('S5. confirmación válida → true', async () => {
  const c = await hastaResumen('s5');
  const r = await c.turno('sí, confirmo', null);
  assert.equal(r.fase, 'confirmando', `fase=${r.fase}`);
  assert.equal(r.handoff.listo, true, JSON.stringify(r.handoff.bloqueos));
  assert.equal(r.handoff.nuevo, true);
});

console.log('\n══ S6-S13. LA PROPUESTA EXACTA ══');

const confirmada = async (id) => {
  const c = await hastaResumen(id);
  const r = await c.turno('sí, confirmo', null);
  assert.equal(r.handoff.listo, true, JSON.stringify(r.handoff.bloqueos));
  return { c, r, p: r.handoff.propuesta };
};

await t('S6. la propuesta lleva exactamente los campos del contrato', async () => {
  const { p } = await confirmada('s6');
  assert.deepEqual(Object.keys(p).sort(),
    ['canal', 'cliente', 'forma_pago', 'items', 'modalidad', 'negocioId', 'telefono_conversacion'],
    JSON.stringify(Object.keys(p)));
});

// ── POR QUÉ LA IDENTIDAD SE INYECTA EN `datos` Y NO EN EL BORRADOR ───────
//
// La primera versión de S7/S8 metía `negocioId` y `canal` en el BORRADOR del
// modelo, y pasaban solas: el reconciliador sólo copia modalidad, pago,
// costo_envio y cliente, así que esos campos no llegaban ni al carrito. Eran
// pruebas que no probaban nada, y lo delató la mordida SH3 al no morder.
//
// `carrito.datos` sí es un sitio del que alguien podría leer por error el día
// de mañana — es donde viven modalidad y pago—, así que es ahí donde hay que
// poner el veneno para que la prueba signifique algo.
const conIdentidadEnvenenada = async (id) => {
  const c = await hastaResumen(id);
  c.carrito.datos.negocioId = 'negocio-del-modelo';
  c.carrito.datos.canal = 'canal-del-modelo';
  c.carrito.datos.telefono_conversacion = '5210000000000';
  return c.turno('sí, confirmo', null);
};

await t('S7. negocioId sellado: lo del carrito no lo mueve', async () => {
  const r = await conIdentidadEnvenenada('s7');
  assert.equal(r.handoff.propuesta.negocioId, SELLO.negocioId);
});

await t('S8. canal sellado', async () => {
  const r = await conIdentidadEnvenenada('s8');
  assert.equal(r.handoff.propuesta.canal, 'whatsapp');
});

await t('S9. telefono_conversacion sellado, y NO es el dictado', async () => {
  // XAB-0114: el cliente puede dictar un teléfono de ENTREGA. Ese va a
  // `cliente.telefono`; la identidad de la conversación es el del webhook.
  const c = conversacion('s9');
  await c.turno('a domicilio, vivo en Reforma 200',
    { items: [], modalidad: 'entrega a domicilio', cliente: { calle: 'Reforma 200' } });
  await c.turno('apunta mi numero 8789998877', { items: [], cliente: { telefono: '8789998877' } });
  await c.turno('pago en efectivo', { items: [], forma_pago: 'efectivo' });
  c.carrito.datos.telefono_conversacion = '5210000000000';
  const r = await c.turno('sí, confirmo', null);
  const p = r.handoff.propuesta;
  assert.equal(p.telefono_conversacion, SELLO.telefonoConversacion, 'se coló otro como identidad');
  assert.equal(p.cliente.telefono, '8789998877', 'perdió el teléfono de entrega dictado');
});

await t('S9b. y si nadie dictó teléfono, el cliente hereda el de la conversación', async () => {
  // La otra mitad del `||` de whatsapp-meta.js:1189.
  const { p } = await confirmada('s9b');
  assert.equal(p.cliente.telefono, SELLO.telefonoConversacion);
});

await t('S10. el cliente lleva sólo lo autorizado', async () => {
  const { p } = await confirmada('s10');
  assert.deepEqual(Object.keys(p.cliente).sort(), ['calle', 'telefono']);
  assert.equal(p.cliente.calle, 'Reforma 200');
  for (const campo of ['nombre', 'colonia', 'referencia', 'numero_interior']) {
    assert.equal(p.cliente[campo], undefined, `inventó ${campo}`);
  }
});

await t('S11. el item conserva producto_id 107', async () => {
  const { p } = await confirmada('s11');
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].producto_id, 107);
  assert.equal(p.items[0].nombre, 'Chilaquiles Mixtos');
  assert.equal(p.items[0].cantidad, 1);
});

await t('S12. los modificadores, exactos', async () => {
  const { p } = await confirmada('s12');
  assert.deepEqual(p.items[0].modificadores, [
    { grupo: 'Salsa', opciones: ['Suiza', 'Chipotle'] },
    { grupo: 'Proteina', opciones: ['Huevos Estrellados'] },
    { grupo: 'Guarniciones', opciones: ['Frijolitos con chorizo'] },
  ]);
});

await t('S13. sin precios, sin total, sin folio, sin id', async () => {
  const { p } = await confirmada('s13');
  for (const campo of ['subtotal', 'total', 'descuento', 'costo_envio', 'promociones',
    'ajustesValidacion', 'forma_pago_tipo', 'id', 'folio', 'timestamp', 'estado']) {
    assert.equal(p[campo], undefined, `la propuesta afirmó ${campo}`);
  }
  for (const campo of ['precio_unitario', 'precio_base']) {
    assert.equal(p.items[0][campo], undefined, `el item afirmó ${campo}`);
  }
});

console.log('\n══ S14-S19. IDEMPOTENCIA, HUELLA E INVALIDACIÓN ══');

await t('S14. confirmar dos veces NO genera un segundo handoff', async () => {
  const c = await hastaResumen('s14');
  const uno = c.recordar((await c.turno('sí, confirmo', null)).handoff);
  assert.equal(uno.listo, true);
  assert.equal(uno.nuevo, true);
  const dos = (await c.turno('sí, confirmo', null)).handoff;
  assert.equal(dos.listo, false, 'el mismo pedido cruzó dos veces');
  assert.ok(dos.bloqueos.includes('sin_confirmacion'), JSON.stringify(dos.bloqueos));
});

await t('S14b. y observar el mismo handoff no lo cuenta como nuevo', async () => {
  const { r } = await confirmada('s14b');
  const otra = handoffDeSombra(r, { ...SELLO, catalogo: CARTA, handoffPrevio: r.handoff.huella });
  assert.equal(otra.listo, true, 'dejó de poder observarse');
  assert.equal(otra.nuevo, false, 'contó un pedido donde hubo uno');
  assert.equal(otra.yaObservado, true);
});

await t('S15. mismo estado → misma huella', async () => {
  const a = await confirmada('s15a');
  const b = await confirmada('s15b');
  assert.equal(a.r.handoff.huella, b.r.handoff.huella,
    `${JSON.stringify(a.p)}\n${JSON.stringify(b.p)}`);
});

await t('S16. cambio real → huella distinta', async () => {
  const { p } = await confirmada('s16');
  const base = huellaDeLaPropuesta(p);
  const variar = (f) => { const q = JSON.parse(JSON.stringify(p)); f(q); return huellaDeLaPropuesta(q); };
  assert.notEqual(variar((q) => { q.items[0].cantidad = 2; }), base, 'la cantidad no movió la huella');
  assert.notEqual(variar((q) => { q.items[0].producto_id = 85; }), base, 'el producto no la movió');
  assert.notEqual(variar((q) => { q.items[0].modificadores[0].opciones = ['Roja', 'Verde']; }), base,
    'los modificadores no la movieron');
  assert.notEqual(variar((q) => { q.modalidad = 'recoger en tienda'; }), base, 'la modalidad no la movió');
  assert.notEqual(variar((q) => { q.forma_pago = 'terminal'; }), base, 'el pago no la movió');
  assert.notEqual(variar((q) => { q.cliente.calle = 'Juarez 5'; }), base, 'la calle no la movió');
  // El lid es del observador, no del pedido: dos carritos iguales con lids
  // distintos son el MISMO pedido.
  assert.equal(variar((q) => { q.items[0]._lid = 'L99'; }), base, 'el lid movió la huella');
});

await t('S17. un cambio después de confirmar invalida el handoff', async () => {
  const c = await hastaResumen('s17');
  const antes = c.recordar((await c.turno('sí, confirmo', null)).handoff);
  assert.equal(antes.listo, true);
  const r = await c.turno('mejor con tarjeta', { items: [], forma_pago: 'terminal' });
  assert.equal(r.handoff.listo, false, 'siguió listo tras cambiar el pago');
  assert.notEqual(r.handoff.huella, antes.huella, 'la huella no se enteró del cambio');
});

await t('S18. resumen nuevo + confirmación nueva → handoff nuevo y distinto', async () => {
  const c = await hastaResumen('s18');
  const a = c.recordar((await c.turno('sí, confirmo', null)).handoff);
  await c.turno('mejor con tarjeta', { items: [], forma_pago: 'terminal' });
  const b = (await c.turno('sí, confirmo', null)).handoff;
  assert.equal(b.listo, true, JSON.stringify(b.bloqueos));
  assert.equal(b.nuevo, true, 'no lo contó como handoff nuevo');
  assert.notEqual(b.huella, a.huella);
  assert.equal(b.propuesta.forma_pago, 'terminal');
});

await t('S19. una consulta no mueve la huella ni genera handoff', async () => {
  const c = await hastaResumen('s19');
  const antes = (await c.turno('gracias', null)).handoff.huella;
  const r = await c.turno('¿qué licuados tienen?', null);
  assert.equal(r.handoff.huella, antes, 'la consulta movió la propuesta');
  assert.equal(r.handoff.listo, false);
  // Y no invalidó el resumen: el pedido no cambió, así que el «sí» siguiente vale.
  const fin = await c.turno('sí, confirmo', null);
  assert.equal(fin.handoff.listo, true, `la consulta rompió el cierre: ${JSON.stringify(fin.handoff.bloqueos)}`);
});

console.log('\n══ S20-S21. DOS LÍNEAS ══');

await t('S20. dos líneas → dos items correctos', async () => {
  const c = conversacion('s20');
  await c.turno('a domicilio, vivo en Reforma 200',
    { items: [], modalidad: 'entrega a domicilio', cliente: { calle: 'Reforma 200' } });
  await c.turno('ponme una coca', { items: [{ nombre: 'Chilaquiles Mixtos', cantidad: 1,
    modificadores: [{ grupo: 'Salsa', opciones: ['Suiza', 'Chipotle'] },
      { grupo: 'Proteina', opciones: ['Huevos Estrellados'] },
      { grupo: 'Guarniciones', opciones: ['Frijolitos con chorizo'] }] },
  { nombre: 'Coca Cola', cantidad: 2 }] });
  await c.turno('pago en efectivo', { items: [], forma_pago: 'efectivo' });
  const r = await c.turno('sí, confirmo', null);
  const items = r.handoff.propuesta.items;
  assert.equal(items.length, 2, JSON.stringify(items.map((i) => i.nombre)));
  assert.deepEqual(items.map((i) => i.producto_id).sort((a, b) => a - b), [90, 107]);
});

await t('S21. y no mezcla los lids', async () => {
  const carrito = { items: [LINEA(), { lid: 'L2', nombre: 'Coca Cola', id: 90, cantidad: 2, notas: '', modificadores: [] }],
    datos: { modalidad: 'recoger en tienda', forma_pago: 'efectivo' } };
  const h = handoffDeSombra({ carrito, aclaraciones: [], falta: [], confirmacionVigente: true, fase: 'confirmando' },
    { ...SELLO, catalogo: CARTA });
  assert.deepEqual(h.propuesta.items.map((i) => i._lid), ['L1', 'L2']);
  assert.deepEqual(h.propuesta.items[1].modificadores, [], 'le colgó los modificadores de la otra línea');
});

console.log('\n══ S22-S26. EL GRAFO: LO QUE NO PUEDE ALCANZAR ══');

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
  // Se mira el CÓDIGO, no los comentarios: estos módulos explican por qué NO
  // llaman a `registrarPedido`, y castigar la explicación obligaría a borrarla.
  const sinComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
  const lista = [...vistos];
  return {
    modulos: lista.map((a) => relative(RAIZ, a).replace(/\\/g, '/')),
    fuentes: lista.map((a) => sinComentarios(readFileSync(a, 'utf8'))),
  };
};
const HANDOFF = 'src/mesero-whatsapp/handoffDeSombra.js';

await t('S22/S23. el handoff no puede alcanzar registrarPedido ni orderManager', async () => {
  const { modulos, fuentes } = await grafoDe(HANDOFF);
  for (const m of modulos) {
    assert.equal(m.includes('orders/orderManager'), false, `alcanza ${m}`);
    assert.equal(m.includes('server.js'), false, `alcanza ${m}`);
    assert.equal(m.includes('channels/'), false, `alcanza ${m}`);
  }
  for (const [i, src] of fuentes.entries()) {
    for (const fn of ['registrarPedido', 'guardarPedidoActivo', 'emitirPedido']) {
      assert.equal(src.includes(fn), false, `${modulos[i]} nombra ${fn}`);
    }
  }
});

await t('S24. ni escribir en la base', async () => {
  const { modulos, fuentes } = await grafoDe(HANDOFF);
  for (const m of modulos) assert.equal(m.includes('services/database'), false, `alcanza ${m}`);
  for (const [i, src] of fuentes.entries()) {
    for (const fn of ['pool.query', 'INSERT INTO', 'UPDATE ', 'DELETE FROM']) {
      assert.equal(src.includes(fn), false, `${modulos[i]} nombra ${fn}`);
    }
  }
});

await t('S25. ni imprimir', async () => {
  const { modulos, fuentes } = await grafoDe(HANDOFF);
  for (const m of modulos) assert.equal(m.includes('services/impresion'), false, `alcanza ${m}`);
  for (const [i, src] of fuentes.entries()) {
    for (const fn of ['imprimirComanda', 'imprimirTicketCliente', 'encolarImpresion']) {
      assert.equal(src.includes(fn), false, `${modulos[i]} nombra ${fn}`);
    }
  }
});

await t('S26. ni cobrar, ni facturar, ni salir a la red', async () => {
  const { modulos, fuentes } = await grafoDe(HANDOFF);
  for (const m of modulos) {
    for (const p of ['services/clip-api', 'services/pagos', 'services/webhookPagos', 'services/facturapi']) {
      assert.equal(m.includes(p), false, `alcanza ${m}`);
    }
  }
  for (const [i, src] of fuentes.entries()) {
    for (const fn of ['fetch(', 'crearEnlacePago', 'siguienteFolio', 'nextval']) {
      assert.equal(src.includes(fn), false, `${modulos[i]} nombra ${fn}`);
    }
  }
  // Grafo pequeño y conocido: si crece, que alguien lo mire aposta.
  assert.deepEqual(modulos.sort(), [HANDOFF, 'src/mesero-whatsapp/pedidoHipotetico.js'].sort(),
    `el grafo creció: ${JSON.stringify(modulos)}`);
});

console.log('\n══ S27. LO QUE NO PUEDE SALIR AL LOG ══');

await t('S27. el registro no lleva teléfono, dirección ni nombre', async () => {
  const c = conversacion('s27');
  await c.turno('a domicilio, vivo en Reforma 200',
    { items: [], modalidad: 'entrega a domicilio', cliente: { calle: 'Reforma 200' } });
  await c.turno('soy Mario', { items: [], cliente: { nombre: 'Mario' } });
  await c.turno('pago en efectivo', { items: [], forma_pago: 'efectivo' });
  const r = await c.turno('sí, confirmo', null);
  const p = r.handoff.propuesta;
  assert.equal(p.cliente.nombre, 'Mario', 'el fixture no cargó el nombre: la prueba no probaría nada');
  assert.equal(p.cliente.calle, 'Reforma 200');

  const registro = registroDeHandoff(r.handoff, { turno: 4, negocioId: SELLO.negocioId, conversacion: 'abc123' });
  const linea = lineaDeHandoff(registro);
  assert.equal(linea.includes('Mario'), false, `el nombre salió al log: ${linea}`);
  assert.equal(linea.includes('Reforma'), false, `la dirección salió al log: ${linea}`);
  assert.equal(linea.includes(SELLO.telefonoConversacion), false, `el teléfono salió al log: ${linea}`);
  // Y la misma guardia que ya vigila la línea de sombra.
  assert.equal(pareceSensibleElRegistro(registro), false, `la guardia lo marcó: ${linea}`);
});

await t('S27b. pero el registro SÍ dice lo que hace falta para contar', async () => {
  const { r } = await confirmada('s27b');
  const reg = registroDeHandoff(r.handoff, { turno: 3, negocioId: SELLO.negocioId, conversacion: 'abc123' });
  assert.equal(reg.handoff_ready, true);
  assert.equal(reg.items_count, 1);
  assert.equal(reg.unidades, 1);
  assert.equal(reg.modalidad, 'entrega a domicilio');
  assert.equal(reg.forma_pago, 'efectivo');
  assert.equal(reg.cliente_con_direccion, true);
  assert.equal(typeof reg.huella, 'string');
  assert.equal(typeof reg.tel_conv, 'string');
  assert.equal(reg.tel_conv.length, 11, 'el teléfono no está hasheado en dos grupos');
  assert.equal(/\d{7,}/.test(JSON.stringify(reg)), false, 'un hash quedó con pinta de teléfono');
});

await t('S28. sin identidad de canal o remitente no hay handoff listo', async () => {
  const { r } = await confirmada('s28');
  for (const identidad of [{canal:null}, {telefonoConversacion:null}, {telefonoConversacion:'  '}]) {
    const h = handoffDeSombra(r, {...SELLO, catalogo:CARTA, ...identidad});
    assert.equal(h.listo, false);
    assert.equal(h.nuevo, false);
  }
});

await t('S29. los detalles libres de bloqueos y etiquetas nunca salen al log', () => {
  const h = { bloqueos:['producto_sin_id:Mario 8789998877', 'falta:Calle Reforma 200'],
    propuesta:{items:[], modalidad:'Mario 8789998877', forma_pago:'Calle Reforma 200'} };
  const reg = registroDeHandoff(h);
  assert.equal(pareceSensibleElRegistro(reg), false);
  assert.doesNotMatch(JSON.stringify(reg), /Mario|Reforma|8789998877/);
  assert.deepEqual(reg.bloqueos, ['producto_sin_id','falta']);
});

for (const rafaga of [false, true]) await t(`S30. fixture completo por observador ${rafaga ? 'en ráfaga' : 'en serie'}`, async () => {
  reiniciarSombraMesero();
  const guion = [
    ['Quiero chilaquiles suizos', {items:[{nombre:'Chilaquiles Sencillos',cantidad:1,modificadores:[{grupo:'Salsa',opciones:['Suiza']}]}]}],
    ['Con frijolitos', {items:[{nombre:'Chilaquiles Sencillos',cantidad:1,modificadores:[{grupo:'Guarniciones',opciones:['Frijolitos']}]}]}],
    ['Con chorizo por favor', {items:[{nombre:'Chilaquiles Sencillos',cantidad:1,modificadores:[{grupo:'Guarniciones',opciones:['Frijolitos con chorizo']}]}]}],
    ['Tambien chipotle', {items:[{nombre:'Chilaquiles Sencillos',cantidad:1,modificadores:[{grupo:'Salsa',opciones:['Chipotle']}]}]}],
    ['Con huevos estrellados', {items:[{nombre:'Chilaquiles Mixtos',cantidad:1,modificadores:[{grupo:'Proteina',opciones:['Huevos Estrellados']}]}]}],
    ['Que licuados tienen?', null],
    ['a domicilio, vivo en Reforma 200', {items:[],modalidad:'entrega a domicilio',cliente:{calle:'Reforma 200'}}],
    ['pago en efectivo', {items:[],forma_pago:'efectivo'}],
    ['sí, confirmo', null], ['sí, confirmo', null],
  ];
  const llamar = ([mensaje, borrador]) => observarTurnoDelMesero({
    ...SELLO, sessionId:`s30-${rafaga}`, mensaje, cargarCatalogo:async()=>CARTA,
    proponer:async()=>borrador,
  });
  const resultados = [];
  if (rafaga) resultados.push(...await Promise.all(guion.map(llamar)));
  else for (const paso of guion) resultados.push(await llamar(paso));
  for (const r of resultados) assert.equal(r.ok, true, r.motivo);
  assert.equal(resultados[5].handoff.huella, resultados[4].handoff.huella, 'la consulta T6 no altera la propuesta');
  for (const r of resultados.slice(0,8)) assert.equal(r.handoff.listo, false);
  assert.equal(resultados.filter(r=>r.handoff.nuevo).length, 1);
  assert.equal(resultados.filter(r=>r.lineaHandoff).length, 1);
  const listo = resultados[8];
  assert.equal(listo.handoff.listo, true, JSON.stringify(listo.handoff.bloqueos));
  assert.equal(listo.registroHandoff.confirmacion_vigente, true);
  assert.equal(listo.registroHandoff.conv, listo.registro.conv);
  const p = listo.handoff.propuesta;
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].producto_id, 107);
  const porGrupo = mods => [...mods].sort((a,b)=>a.grupo.localeCompare(b.grupo));
  assert.deepEqual(porGrupo(p.items[0].modificadores), porGrupo(LINEA().modificadores));
  assert.equal(p.items[0]._lid, resultados[0].handoff.propuesta.items[0]._lid);
  assert.equal(p.cliente.calle, 'Reforma 200');
  assert.equal(p.telefono_conversacion, SELLO.telefonoConversacion);
  assert.equal(resultados[9].handoff.listo, false);
  assert.equal(pareceSensibleElRegistro(listo.registroHandoff), false);
});

console.log(`\n${'─'.repeat(70)}`);
console.log(`PASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
