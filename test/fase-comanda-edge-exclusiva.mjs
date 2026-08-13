// Quién imprime la comanda: Edge o el navegador. Nunca los dos.
//
// El día que Mapolato conectó su primera térmica pasó esto: `Imprimir prueba`
// sacaba papel solo, pero la comanda real seguía abriendo el diálogo de
// Chrome. Dos defectos distintos:
//
//   1. La impresora asignada desde el panel crea una regla ambito='documento',
//      clave='comanda'. El enrutador de comandas solo miraba categoría y
//      producto, así que la ronda entera salía "sin ruta" y no se creaba ni un
//      trabajo. La regla existía y se cargaba; nadie la leía.
//   2. Los pedidos (WhatsApp, POS, Rappi, voz) nunca habían tenido camino
//      Edge. Para ellos el navegador no era el camino viejo: era el único.
//
// Y una vez arreglados los dos, aparece el riesgo de verdad: que la comanda
// salga por Edge Y por el navegador. Dos papeles idénticos en una cocina no
// son un detalle estético -- son dos platillos.
//
// Esta suite fija la regla completa: el SERVIDOR decide, y su decisión es un
// hecho comprobable ("existe un trabajo para esta comanda"), no una
// configuración. El navegador obedece. Un negocio sin Edge no nota nada.
//
// Uso: DATABASE_URL=... PANEL_SECRET=... SESSION_SECRET=... ADMIN_PASSWORD=...
//      node test/fase-comanda-edge-exclusiva.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { pool } = await import('../src/services/database.js');
const { crearEdge: altaEdge } = await import('../src/services/edgeService.js');
const { crearImpresora, crearRuta, crearTrabajosDeComanda, crearTrabajosDePedido,
        crearTrabajosDeDocumento, listarTrabajos } = await import('../src/services/impresionService.js');
const { indexarReglas, resolverDestinosDeItem, agruparItemsPorImpresora,
        destinosDeDocumento, CLAVE_COMANDA } = await import('../src/printing/routingEngine.js');
const { DESTINOS } = await import('../src/services/impresionSelfService.js');
const { emitirComandaDePedidoPorEdge, setEntregaEdge, _resetEntregaEdgeParaPruebas } =
  await import('../src/printing/edgeComanda.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// ═══════════ 1. El motor, sin base de datos ═══════════

const P = { cocina: 'p-cocina', tickets: 'p-tickets', chilaquiles: 'p-chila', bebidas: 'p-bebidas' };

// El caso del restaurante que acaba de conectar su primera impresora: una
// sola regla, la que crea el panel al asignar "Cocina".
const SOLO_DOCUMENTO = indexarReglas([
  { ambito: 'documento', clave: 'comanda', impresora_id: P.cocina, impresora_nombre: 'COCINA', modo: 'agregar', activa: true },
]);

// El caso de Mapolato Obispado: estaciones separadas.
const MULTIESTACION = indexarReglas([
  { ambito: 'categoria', clave: 'fuertes', impresora_id: P.cocina, impresora_nombre: 'COCINA GENERAL', modo: 'agregar', activa: true },
  { ambito: 'categoria', clave: 'bebidas', impresora_id: P.bebidas, impresora_nombre: 'BEBIDAS', modo: 'agregar', activa: true },
  { ambito: 'producto', clave: 'chilaquiles', impresora_id: P.chilaquiles, impresora_nombre: 'CHILAQUILES', modo: 'agregar', activa: true },
  { ambito: 'documento', clave: 'comanda', impresora_id: P.tickets, impresora_nombre: 'MOSTRADOR', modo: 'agregar', activa: true },
  { ambito: 'documento', clave: 'cuenta', impresora_id: P.tickets, impresora_nombre: 'TICKETS', modo: 'agregar', activa: true },
]);

const CHILAQUILES = { producto: 'Chilaquiles', categoria: 'Fuertes', cantidad: 1, notas: 'Sin cebolla' };
const COCA = { producto: 'Coca-Cola', categoria: 'Bebidas', cantidad: 2 };
const FLAN = { producto: 'Flan', categoria: 'Postres', cantidad: 1 };  // ninguna regla lo nombra

await t('MOTOR', '1. con solo la regla documento/comanda, la ronda entera tiene destino', () => {
  const { grupos, sinRuta } = agruparItemsPorImpresora([CHILAQUILES, COCA], SOLO_DOCUMENTO);
  assert.strictEqual(grupos.length, 1, 'una impresora, un grupo');
  assert.strictEqual(grupos[0].impresoraId, P.cocina);
  assert.strictEqual(grupos[0].items.length, 2, 'la ronda completa, no la mitad');
  assert.deepStrictEqual(sinRuta, [],
    'sin esto, un restaurante con una sola impresora no imprimía NADA: era el defecto');
});

await t('MOTOR', '2. la regla específica gana al destino por defecto', () => {
  const chila = resolverDestinosDeItem(CHILAQUILES, MULTIESTACION);
  const ids = chila.destinos.map(d => d.impresoraId).sort();
  assert.deepStrictEqual(ids, [P.chilaquiles, P.cocina].sort(),
    'los chilaquiles siguen saliendo en su estación Y en cocina general');
  assert.ok(!ids.includes(P.tickets),
    'y NO caen además en el destino por defecto: eso sería un tercer papel de la nada');
});

await t('MOTOR', '3. el defecto recoge solo lo que nadie reclamó', () => {
  const { grupos } = agruparItemsPorImpresora([CHILAQUILES, COCA, FLAN], MULTIESTACION);
  const porImpresora = Object.fromEntries(grupos.map(g => [g.impresoraId, g.items.map(i => i.producto)]));
  assert.deepStrictEqual(porImpresora[P.chilaquiles], ['Chilaquiles']);
  assert.deepStrictEqual(porImpresora[P.bebidas], ['Coca-Cola']);
  assert.deepStrictEqual(porImpresora[P.cocina], ['Chilaquiles']);
  assert.deepStrictEqual(porImpresora[P.tickets], ['Flan'],
    'el postre no tiene regla: antes se perdía en silencio, ahora sale en la impresora por defecto');
});

await t('MOTOR', '4. multiestación sin regla de documento sigue exactamente igual', () => {
  const sinDefecto = indexarReglas([
    { ambito: 'categoria', clave: 'fuertes', impresora_id: P.cocina, impresora_nombre: 'COCINA GENERAL', modo: 'agregar', activa: true },
    { ambito: 'producto', clave: 'chilaquiles', impresora_id: P.chilaquiles, impresora_nombre: 'CHILAQUILES', modo: 'agregar', activa: true },
  ]);
  const { grupos, sinRuta } = agruparItemsPorImpresora([CHILAQUILES, FLAN], sinDefecto);
  assert.strictEqual(grupos.length, 2);
  assert.deepStrictEqual(sinRuta, ['Flan'], 'sin destino por defecto, lo que no tiene regla se sigue reportando');
});

await t('MOTOR', '5. la cuenta jamás hereda el destino de comanda', () => {
  const destinos = destinosDeDocumento('cuenta', MULTIESTACION);
  assert.strictEqual(destinos.length, 1);
  assert.strictEqual(destinos[0].impresoraId, P.tickets);
  const soloComanda = destinosDeDocumento('cuenta', SOLO_DOCUMENTO);
  assert.deepStrictEqual(soloComanda, [],
    'una impresora asignada a Cocina no puede acabar imprimiendo la cuenta del cliente');
});

await t('MOTOR', '6. la comanda jamás cae en la impresora de la cuenta', () => {
  const soloCuenta = indexarReglas([
    { ambito: 'documento', clave: 'cuenta', impresora_id: P.tickets, impresora_nombre: 'TICKETS', modo: 'agregar', activa: true },
  ]);
  const { grupos, sinRuta } = agruparItemsPorImpresora([CHILAQUILES, COCA], soloCuenta);
  assert.deepStrictEqual(grupos, [],
    'con Caja configurada y Cocina no, la comanda NO sale por Caja: sale por ningún lado y se avisa');
  assert.strictEqual(sinRuta.length, 2);
});

await t('MOTOR', '7. la clave del destino por defecto es la misma que escribe el panel', () => {
  assert.strictEqual(CLAVE_COMANDA, DESTINOS.cocina.clave,
    'si el panel y el motor dejan de usar la misma palabra, la impresora se configura y no imprime nada');
});

// ═══════════ 2. El contrato del panel, ejecutado de verdad ═══════════
//
// No se comprueba que el archivo "contenga" el guard: se extrae la función que
// se envía al navegador y se ejecuta con el DOM simulado. Si mañana alguien
// mueve el `if`, esta prueba lo nota; una que solo busque texto, no.

const PANEL = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');

function extraerFuncion(nombre) {
  const inicio = PANEL.indexOf(`function ${nombre}(`);
  assert.ok(inicio > 0, `no se encontró function ${nombre}() en panel/index.html`);
  let i = PANEL.indexOf('{', inicio), nivel = 0;
  for (let j = i; j < PANEL.length; j++) {
    if (PANEL[j] === '{') nivel++;
    else if (PANEL[j] === '}') { nivel--; if (nivel === 0) return PANEL.slice(inicio, j + 1); }
  }
  throw new Error(`no se pudo delimitar ${nombre}()`);
}

// Ejecuta agregarPedido() con todo lo que toca simulado, y devuelve si habría
// abierto el diálogo de impresión.
function correrAgregarPedido({ impresionEdge, panelListo = true }) {
  const llamadas = { imprimirComanda: 0, sonarAlerta: 0 };
  const contexto = {
    document: { getElementById: () => null, createElement: () => ({ style: {}, querySelector: () => null }) },
    pedidos: {}, sinPedidos: { style: {} },
    grid: { prepend: () => {} },
    actualizarContador: () => {}, renderComanda: () => '',
    sonarAlerta: () => { llamadas.sonarAlerta++; },
    imprimirComanda: () => { llamadas.imprimirComanda++; },
    setTimeout: (fn) => { fn(); return 0; },
    panelListo,
  };
  const args = Object.keys(contexto);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...args, `${extraerFuncion('agregarPedido')}\nreturn agregarPedido;`)
    (...args.map(k => contexto[k]));
  fn({ id: 'XAB-0001' }, impresionEdge);
  return llamadas;
}

await t('PANEL', '8. impresionEdge=true → el navegador NO imprime', () => {
  const r = correrAgregarPedido({ impresionEdge: true });
  assert.strictEqual(r.imprimirComanda, 0,
    'el papel ya está saliendo por la térmica: pedir permiso a Chrome sería imprimir dos veces');
  assert.strictEqual(r.sonarAlerta, 1,
    'pero el aviso sonoro se queda: quien está en la barra tiene que enterarse igual');
});

await t('PANEL', '9. impresionEdge=false → el navegador imprime como siempre', () => {
  const r = correrAgregarPedido({ impresionEdge: false });
  assert.strictEqual(r.imprimirComanda, 1,
    'un negocio sin Edge no puede perder su impresión al desplegar esto');
});

await t('PANEL', '10. sin el campo (servidor viejo) se conserva el comportamiento actual', () => {
  const llamadas = correrAgregarPedido({ impresionEdge: undefined });
  assert.strictEqual(llamadas.imprimirComanda, 1, 'ante la duda, se imprime: nunca dejar a la cocina sin papel');
});

await t('PANEL', '11. N pestañas abiertas con Edge activo → N veces cero diálogos', () => {
  // La decisión no la toma el navegador, así que da igual cuántas copias del
  // panel haya. Antes cada pestaña decidía por su cuenta e imprimía.
  let total = 0;
  for (let pestana = 0; pestana < 4; pestana++) total += correrAgregarPedido({ impresionEdge: true }).imprimirComanda;
  assert.strictEqual(total, 0, 'cuatro pestañas abiertas no pueden producir cuatro papeles');
});

await t('PANEL', '12. el ticket de cuenta respeta la misma bandera', () => {
  const cuerpo = extraerFuncion('recibirCuentaFinal');
  assert.ok(/impresionEdge/.test(cuerpo) && /if \(!impresionEdge\)/.test(cuerpo),
    'el cierre de cuenta necesita el mismo gate o el cliente recibe dos tickets');
});

// ═══════════ 3. De punta a punta, con Postgres real ═══════════

async function montarNegocio(slug, nombre) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET nombre = $1 RETURNING id`, [nombre, slug]);
  const { rows: [s] } = await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true RETURNING id`, [n.id]);
  return { negocioId: n.id, sucursalId: s.id };
}

// A: restaurante con Edge y una sola impresora de cocina (el caso Acuña).
const A = await montarNegocio('edge-excl-a', 'Acuña Demo');
// B: negocio SIN Edge ni impresoras (el caso que no debe cambiar).
const B = await montarNegocio('edge-excl-b', 'Sin Edge Demo');

// Higiene entre corridas: los negocios son persistentes (por slug) y una
// corrida anterior interrumpida dejaba el terminal 'PC CAJA' vivo -- el
// alta de abajo tronaba con NOMBRE_DUPLICADO en pleno setup. Se parte
// siempre de cero terminales/impresoras/rutas para ambos negocios mock.
for (const neg of [A, B]) {
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id = $1`, [neg.negocioId]).catch(() => {});
  await pool.query(`DELETE FROM impresoras WHERE negocio_id = $1`, [neg.negocioId]).catch(() => {});
  await pool.query(
    `DELETE FROM terminales WHERE sucursal_id IN (SELECT id FROM sucursales WHERE negocio_id = $1)`,
    [neg.negocioId]).catch(() => {});
}

const edgeA = await altaEdge(A.negocioId, { nombre: 'PC CAJA' });
const impCocina = await crearImpresora(A.negocioId, {
  terminalId: edgeA.id, nombre: 'POS Printer 203DPI  Series 2',
  transporte: 'windows_spooler', anchoColumnas: 42, config: { spoolerNombre: 'POS Printer 203DPI  Series 2' },
});
await crearRuta(A.negocioId, { impresoraId: impCocina.id, ambito: 'documento', clave: DESTINOS.cocina.clave });

const PEDIDO_BASE = {
  negocioId: A.negocioId, canal: 'whatsapp', modalidad: 'entrega a domicilio',
  cliente: { nombre: 'Doña Rosa', telefono: '8781234567', direccion: 'Calle 5 #12' },
  items: [{ nombre: 'Chilaquiles', cantidad: 1, notas: 'Sin cebolla' }, { nombre: 'Coca-Cola', cantidad: 2 }],
  total: 195,
};

await t('E2E', '13. comanda de mesa con solo la regla documento/comanda → trabajo Edge', async () => {
  const cuentaId = randomUUID();
  const r = await crearTrabajosDeComanda({
    negocioId: A.negocioId, cuentaId,
    comanda: { comanda: 1, tipo: 'inicial', mesa: 4, personas: 2, mesero: 'ANGEL',
               items: [{ producto: 'Chilaquiles', categoria: 'Fuertes', cantidad: 1 }] },
  });
  assert.strictEqual(r.creados.length, 1, `se esperaba 1 trabajo y hubo ${r.creados.length}: ${r.avisos.join(' | ')}`);
  assert.strictEqual(r.creados[0].documento, 'comanda');
  assert.strictEqual(r.creados[0].impresora_nombre, 'POS Printer 203DPI  Series 2');
});

await t('E2E', '14. pedido de WhatsApp con Edge → exactamente un trabajo', async () => {
  const pedido = { ...PEDIDO_BASE, id: `XAB-W${Date.now()}` };
  const r = await crearTrabajosDePedido({ negocioId: A.negocioId, pedido });
  assert.strictEqual(r.creados.length, 1, `un pedido, un papel; hubo ${r.creados.length}`);
  assert.strictEqual(r.creados[0].documento, 'comanda');
  assert.strictEqual(r.creados[0].origen_tipo, 'pedido');
  assert.strictEqual(r.creados[0].origen_id, pedido.id, 'el folio es el origen: por ahí entra la idempotencia');
});

await t('E2E', '15. pedido de POS y de Rappi usan el MISMO pipeline', async () => {
  for (const canal of ['pos', 'rappi', 'voz']) {
    const pedido = { ...PEDIDO_BASE, canal, id: `XAB-${canal.toUpperCase()}${Date.now()}` };
    const r = await crearTrabajosDePedido({ negocioId: A.negocioId, pedido });
    assert.strictEqual(r.creados.length, 1, `${canal}: se esperaba 1 trabajo y hubo ${r.creados.length}`);
    assert.strictEqual(r.creados[0].payload.canal, canal, 'el papel dice de dónde vino el pedido');
  }
});

await t('E2E', '16. el papel de cocina no lleva teléfono ni dirección del cliente', async () => {
  const pedido = { ...PEDIDO_BASE, id: `XAB-P${Date.now()}` };
  const r = await crearTrabajosDePedido({ negocioId: A.negocioId, pedido });
  const texto = JSON.stringify(r.creados[0].payload);
  assert.ok(texto.includes('Doña Rosa'), 'el nombre sí: es como se canta el pedido');
  assert.ok(!texto.includes('8781234567'), 'el teléfono no sirve en la estación y es dato personal de más');
  assert.ok(!texto.includes('Calle 5'), 'la dirección tampoco');
});

await t('E2E', '17. negocio SIN Edge → cero trabajos y el navegador conserva su impresión', async () => {
  const pedido = { ...PEDIDO_BASE, negocioId: B.negocioId, id: `XAB-SIN${Date.now()}` };
  const r = await crearTrabajosDePedido({ negocioId: B.negocioId, pedido });
  assert.strictEqual(r.creados.length, 0);

  const decision = await emitirComandaDePedidoPorEdge(pedido);
  assert.strictEqual(decision.seHizoCargo, false,
    'esta es LA prueba que protege a los negocios que hoy imprimen por Chrome');
});

await t('E2E', '18. con Edge, la autoridad dice que se hizo cargo', async () => {
  const entregados = [];
  setEntregaEdge(async (trabajos) => { entregados.push(...trabajos); });
  try {
    const pedido = { ...PEDIDO_BASE, id: `XAB-A${Date.now()}` };
    const decision = await emitirComandaDePedidoPorEdge(pedido);
    assert.strictEqual(decision.seHizoCargo, true);
    assert.strictEqual(decision.trabajos, 1);
    assert.strictEqual(entregados.length, 1, 'y el trabajo se entrega al Edge conectado, no se queda esperando');
  } finally { _resetEntregaEdgeParaPruebas(); }
});

await t('E2E', '19. reenviar el MISMO pedido no produce un segundo papel', async () => {
  const pedido = { ...PEDIDO_BASE, id: `XAB-IDEM${Date.now()}` };
  const primera = await crearTrabajosDePedido({ negocioId: A.negocioId, pedido });
  const segunda = await crearTrabajosDePedido({ negocioId: A.negocioId, pedido });
  assert.strictEqual(primera.creados.length, 1);
  assert.strictEqual(segunda.creados.length, 0, 'la segunda vez no crea nada');
  assert.strictEqual(segunda.duplicados.length, 1, 'la reconoce como la misma, no como una nueva');

  // Y el panel sigue sin imprimir: para él, Edge ya tiene este pedido.
  const decision = await emitirComandaDePedidoPorEdge(pedido);
  assert.strictEqual(decision.seHizoCargo, true,
    'un duplicado también cuenta como "Edge ya lo tiene": si no, el reintento acabaría en el navegador');
  assert.strictEqual(decision.trabajos, 0, 'pero sin crear ni entregar nada nuevo');
});

await t('E2E', '20. reenviar la misma ronda de mesa tampoco duplica', async () => {
  const cuentaId = randomUUID();
  const comanda = { comanda: 2, tipo: 'adicional', mesa: 7, personas: 2, mesero: 'ANGEL',
                    items: [{ producto: 'Flan', categoria: 'Postres', cantidad: 1 }] };
  const a = await crearTrabajosDeComanda({ negocioId: A.negocioId, cuentaId, comanda });
  const b = await crearTrabajosDeComanda({ negocioId: A.negocioId, cuentaId, comanda });
  assert.strictEqual(a.creados.length, 1);
  assert.strictEqual(b.creados.length, 0);
  assert.strictEqual(b.duplicados.length, 1, 'origen_id = cuenta:ronda sigue siendo la defensa');
});

await t('E2E', '21. la cuenta con Caja configurada sale UNA vez y nunca por cocina', async () => {
  const impCaja = await crearImpresora(A.negocioId, {
    terminalId: edgeA.id, nombre: 'TICKETS CAJA',
    transporte: 'windows_spooler', anchoColumnas: 42, config: { spoolerNombre: 'TICKETS CAJA' },
  });
  await crearRuta(A.negocioId, { impresoraId: impCaja.id, ambito: 'documento', clave: DESTINOS.caja.clave });

  const folio = `V-${Date.now()}`;
  const r = await crearTrabajosDeDocumento({
    negocioId: A.negocioId, documento: 'cuenta', origenTipo: 'restaurante_cuenta', origenId: folio,
    payload: { folio, total: 195, items: [] },
  });
  assert.strictEqual(r.creados.length, 1, 'un cierre, un ticket');
  assert.strictEqual(r.creados[0].impresora_nombre, 'TICKETS CAJA');
  assert.notStrictEqual(r.creados[0].impresora_nombre, 'POS Printer 203DPI  Series 2',
    'la cuenta del cliente no puede salir en la plancha de la cocina');
});

await t('E2E', '22. y la comanda sigue sin caer en Caja aunque Caja ya exista', async () => {
  const cuentaId = randomUUID();
  const r = await crearTrabajosDeComanda({
    negocioId: A.negocioId, cuentaId,
    comanda: { comanda: 1, tipo: 'inicial', mesa: 9, personas: 1, mesero: 'ANGEL',
               items: [{ producto: 'Chilaquiles', categoria: 'Fuertes', cantidad: 1 }] },
  });
  const destinos = r.creados.map(x => x.impresora_nombre);
  assert.deepStrictEqual(destinos, ['POS Printer 203DPI  Series 2'],
    'el destino por defecto de comanda es Cocina, y solo Cocina');
});

await t('E2E', '23. aislamiento: el negocio vecino no recibe ni un trabajo', async () => {
  const trabajosB = await listarTrabajos(B.negocioId, {});
  assert.strictEqual(trabajosB.length ?? trabajosB.trabajos?.length ?? 0, 0,
    'ninguna comanda de A puede aparecer en B');
});

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
