// Motor de routing y renderers de Xabor Edge.
//
// Suite pura: sin Postgres, sin WebSocket, sin impresora. Es donde se prueba
// la regla que da sentido a toda la fase -- "los chilaquiles salen en su
// estación Y en cocina general" -- y donde se fija la semántica de
// precedencia, que es la parte que más fácil se rompe sin darse cuenta.
import assert from 'assert';
import {
  normalizarClave, indexarReglas, resolverDestinosDeItem,
  agruparItemsPorImpresora, destinosDeDocumento,
} from '../src/printing/routingEngine.js';
import { renderizar } from '../edge/renderers/index.js';

let pasadas = 0, fallidas = 0;
const fallos = [];
function t(cat, nombre, fn) {
  try { fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// Las cuatro impresoras reales de Mapolato Obispado.
const P = { tickets: 'p-tickets', chilaquiles: 'p-chilaquiles', general: 'p-general', bebidas: 'p-bebidas' };

const REGLAS_MAPOLATO = indexarReglas([
  // Todo lo de comer pasa por cocina general.
  { ambito: 'categoria', clave: 'fuertes',  impresora_id: P.general,     impresora_nombre: 'COCINA GENERAL', modo: 'agregar', activa: true },
  { ambito: 'categoria', clave: 'ensaladas', impresora_id: P.general,    impresora_nombre: 'COCINA GENERAL', modo: 'agregar', activa: true },
  { ambito: 'categoria', clave: 'bebidas',  impresora_id: P.bebidas,     impresora_nombre: 'BEBIDAS',        modo: 'agregar', activa: true },
  // Y los chilaquiles ADEMÁS en su propia estación.
  { ambito: 'producto',  clave: 'chilaquiles', impresora_id: P.chilaquiles, impresora_nombre: 'CHILAQUILES', modo: 'agregar', activa: true },
  // La cuenta va solo a tickets.
  { ambito: 'documento', clave: 'cuenta', impresora_id: P.tickets, impresora_nombre: 'TICKETS', modo: 'agregar', activa: true },
]);

const CHILAQUILES = {
  producto: 'Chilaquiles', categoria: 'Fuertes', cantidad: 1,
  modificadores: [{ grupo: 'Salsa', opcion: 'Verde' }, { grupo: 'Proteína', opcion: 'Bistec' },
                  { grupo: 'Guarnición', opcion: 'Frijoles' }, { grupo: 'Guarnición', opcion: 'Papas' }],
  notas: 'Sin cebolla',
};
const ENSALADA = { producto: 'Ensalada', categoria: 'Ensaladas', cantidad: 1, modificadores: [], notas: null };
const COCA = { producto: 'Coca-Cola', categoria: 'Bebidas', cantidad: 2, modificadores: [], notas: null };

// ── Normalización ───────────────────────────────────────────────────────────
t('CLAVE', '1. la clave ignora mayúsculas, acentos y espacios de más', () => {
  assert.strictEqual(normalizarClave('  Café  '), 'cafe');
  assert.strictEqual(normalizarClave('BEBIDAS'), 'bebidas');
  assert.strictEqual(normalizarClave('Chilaquiles   Verdes'), 'chilaquiles verdes');
  assert.strictEqual(normalizarClave('Piña'), 'pina');
  assert.strictEqual(normalizarClave(null), '');
});

// ── Los casos de Mapolato ───────────────────────────────────────────────────
t('ROUTING', '2. un producto con una sola regla va a un destino', () => {
  const { destinos } = resolverDestinosDeItem(COCA, REGLAS_MAPOLATO);
  assert.deepStrictEqual(destinos.map(d => d.impresoraId), [P.bebidas]);
});

t('ROUTING', '3. chilaquiles salen en su estación Y en cocina general', () => {
  const { destinos } = resolverDestinosDeItem(CHILAQUILES, REGLAS_MAPOLATO);
  const ids = destinos.map(d => d.impresoraId).sort();
  assert.deepStrictEqual(ids, [P.chilaquiles, P.general].sort(),
    'el mismo item tiene que ir a los DOS destinos, no elegir uno');
});

t('ROUTING', '4. la ensalada hereda el destino de su categoría', () => {
  const { destinos } = resolverDestinosDeItem(ENSALADA, REGLAS_MAPOLATO);
  assert.deepStrictEqual(destinos.map(d => d.impresoraId), [P.general]);
});

t('ROUTING', '5. una regla de producto en modo exclusivo sustituye a la categoría', () => {
  const reglas = indexarReglas([
    { ambito: 'categoria', clave: 'fuertes', impresora_id: P.general, modo: 'agregar', activa: true },
    { ambito: 'producto', clave: 'sopa fria', impresora_id: P.bebidas, modo: 'exclusivo', activa: true },
  ]);
  const { destinos } = resolverDestinosDeItem({ producto: 'Sopa fría', categoria: 'Fuertes' }, reglas);
  assert.deepStrictEqual(destinos.map(d => d.impresoraId), [P.bebidas],
    'exclusivo debe QUITAR el destino de la categoría, no sumarse');
});

t('ROUTING', '6. si hay reglas exclusivas y aditivas a la vez, manda la exclusiva y se avisa', () => {
  const reglas = indexarReglas([
    { ambito: 'categoria', clave: 'fuertes', impresora_id: P.general, modo: 'agregar', activa: true },
    { ambito: 'producto', clave: 'x', impresora_id: P.bebidas, modo: 'exclusivo', activa: true },
    { ambito: 'producto', clave: 'x', impresora_id: P.chilaquiles, modo: 'agregar', activa: true },
  ]);
  const { destinos, avisos } = resolverDestinosDeItem({ producto: 'X', categoria: 'Fuertes' }, reglas);
  assert.deepStrictEqual(destinos.map(d => d.impresoraId), [P.bebidas]);
  assert.ok(avisos.some(a => /exclusiv/i.test(a)), 'la ambigüedad tiene que quedar registrada');
});

t('ROUTING', '7. dos reglas hacia la misma impresora producen UN destino, no dos', () => {
  const reglas = indexarReglas([
    { ambito: 'categoria', clave: 'fuertes', impresora_id: P.general, modo: 'agregar', activa: true },
    { ambito: 'producto', clave: 'tacos', impresora_id: P.general, modo: 'agregar', activa: true },
  ]);
  const { destinos } = resolverDestinosDeItem({ producto: 'Tacos', categoria: 'Fuertes' }, reglas);
  assert.strictEqual(destinos.length, 1, 'una configuración redundante no puede imprimir dos papeles iguales');
});

t('ROUTING', '8. las reglas desactivadas no enrutan nada', () => {
  const reglas = indexarReglas([{ ambito: 'categoria', clave: 'bebidas', impresora_id: P.bebidas, modo: 'agregar', activa: false }]);
  const { destinos } = resolverDestinosDeItem(COCA, reglas);
  assert.strictEqual(destinos.length, 0);
});

// ── Agrupación de una ronda completa ────────────────────────────────────────
t('RONDA', '9. la orden demo se reparte exactamente como pide el negocio', () => {
  const { grupos, sinRuta } = agruparItemsPorImpresora([CHILAQUILES, ENSALADA, COCA], REGLAS_MAPOLATO);
  const porId = Object.fromEntries(grupos.map(g => [g.impresoraId, g.items.map(i => i.producto)]));

  assert.deepStrictEqual(porId[P.chilaquiles], ['Chilaquiles'], 'CHILAQUILES: solo los chilaquiles');
  assert.deepStrictEqual(porId[P.general], ['Chilaquiles', 'Ensalada'], 'GENERAL: chilaquiles y ensalada, en orden');
  assert.deepStrictEqual(porId[P.bebidas], ['Coca-Cola'], 'BEBIDAS: solo la coca');
  assert.strictEqual(porId[P.tickets], undefined, 'TICKETS no recibe NADA de cocina');
  assert.strictEqual(sinRuta.length, 0);
  assert.strictEqual(grupos.length, 3, 'tres destinos, tres trabajos');
});

t('RONDA', '10. un producto sin ruta no rompe la ronda: sale en sinRuta y los demás siguen', () => {
  const misterioso = { producto: 'Postre nuevo', categoria: 'Postres', cantidad: 1 };
  const { grupos, sinRuta, avisos } = agruparItemsPorImpresora([COCA, misterioso], REGLAS_MAPOLATO);
  assert.deepStrictEqual(sinRuta, ['Postre nuevo']);
  assert.ok(avisos.some(a => /sin impresora/i.test(a)));
  assert.strictEqual(grupos.length, 1, 'la coca se imprime igual');
  assert.deepStrictEqual(grupos[0].items.map(i => i.producto), ['Coca-Cola']);
});

t('RONDA', '11. el orden de captura se respeta dentro de cada impresora', () => {
  const items = [
    { producto: 'A', categoria: 'Fuertes' }, { producto: 'B', categoria: 'Fuertes' },
    { producto: 'C', categoria: 'Fuertes' },
  ];
  const { grupos } = agruparItemsPorImpresora(items, REGLAS_MAPOLATO);
  assert.deepStrictEqual(grupos[0].items.map(i => i.producto), ['A', 'B', 'C']);
});

t('DOCUMENTO', '12. la cuenta va a tickets y nunca hereda reglas de cocina', () => {
  const destinos = destinosDeDocumento('cuenta', REGLAS_MAPOLATO);
  assert.deepStrictEqual(destinos.map(d => d.impresoraId), [P.tickets]);
  assert.deepStrictEqual(destinosDeDocumento('comanda', REGLAS_MAPOLATO), [],
    'sin regla explícita, un documento no cae en ninguna impresora de categoría');
});

// ── Renderers ───────────────────────────────────────────────────────────────
const leer = (buf) => buf.toString('latin1');

t('RENDER', '13. la comanda incluye mesa, mesero, ronda, producto, modificadores y nota', () => {
  const bytes = renderizar('comanda', {
    negocio: 'Mapolato Demo', mesa: 4, mesero: 'ANGEL', ronda: 2,
    emitidoAt: '2026-08-09T18:42:00.000Z', impresora: 'CHILAQUILES',
    items: [CHILAQUILES],
  }, { ancho: 42 });
  const texto = leer(bytes);
  for (const esperado of ['MAPOLATO DEMO', 'MESA 4', 'ANGEL', 'RONDA 2', 'CHILAQUILES', 'Salsa: Verde', 'Proteína: Bistec', 'Frijoles', 'Papas', 'NOTA: Sin cebolla']) {
    assert.ok(texto.includes(esperado), `falta "${esperado}" en la comanda`);
  }
});

t('RENDER', '14. la comanda de cocina NO lleva precios', () => {
  const bytes = renderizar('comanda', { negocio: 'X', mesa: 1, items: [{ producto: 'Taco', cantidad: 1, precioUnitario: 55 }] });
  assert.ok(!/\$/.test(leer(bytes)), 'a la cocina no le sirven los importes y solo estorban');
});

t('RENDER', '15. la cuenta sí lleva importes y total', () => {
  const texto = leer(renderizar('cuenta', {
    negocio: 'Mapolato Demo', mesa: 4, folio: 'XAB-0124',
    items: [{ producto: 'Chilaquiles', cantidad: 1, precioUnitario: 195, modificadores: [] }],
    subtotal: 195, propina: 30, total: 195, pagos: [{ metodo: 'efectivo', monto: 225 }],
  }));
  assert.ok(texto.includes('$195.00') && texto.includes('TOTAL') && texto.includes('XAB-0124'));
  assert.ok(texto.includes('efectivo'));
});

t('RENDER', '16. la prueba de impresora dice a dónde salió el papel', () => {
  const texto = leer(renderizar('prueba', {
    negocio: 'Mapolato Demo', impresora: 'BEBIDAS', terminal: 'Edge caja', transporte: 'tcp_raw',
    emitidoAt: new Date().toISOString(), jobId: 'abc-123',
  }));
  for (const esperado of ['PRUEBA DE IMPRESORA', 'Mapolato Demo', 'BEBIDAS', 'Edge caja', 'tcp_raw']) {
    assert.ok(texto.includes(esperado), `falta "${esperado}" en el ticket de prueba`);
  }
});

t('RENDER', '17. el ancho de papel cambia el envoltorio del texto', () => {
  const payload = { negocio: 'X', mesa: 1, items: [{ producto: 'Un platillo con nombre bastante largo para forzar el corte', cantidad: 1, modificadores: [] }] };
  const anchas = leer(renderizar('comanda', payload, { ancho: 42 })).split('\n');
  const angostas = leer(renderizar('comanda', payload, { ancho: 32 })).split('\n');
  assert.ok(angostas.length >= anchas.length, 'a 58 mm el mismo texto ocupa más líneas');
  assert.ok(anchas.every(l => l.length <= 60), 'ninguna línea puede desbordar el papel de forma absurda');
});

t('RENDER', '18. una reimpresión se marca en el papel', () => {
  const texto = leer(renderizar('comanda', { negocio: 'X', mesa: 1, items: [], reimpresion: true }));
  assert.ok(/REIMPRESION/.test(texto), 'cocina tiene que poder distinguir una reimpresión de una comanda nueva');
});

t('RENDER', '19. un documento desconocido falla claro, no imprime basura', () => {
  assert.throws(() => renderizar('inventado', {}), /No hay renderer/);
});

t('RENDER', '20. el ESC/POS abre con INIT y cierra con corte', () => {
  const bytes = renderizar('comanda', { negocio: 'X', mesa: 1, items: [] });
  assert.strictEqual(bytes[0], 0x1b, 'primer byte ESC');
  assert.strictEqual(bytes[1], 0x40, 'segundo byte @: inicialización');
  const cola = bytes.subarray(bytes.length - 4);
  assert.ok(cola.includes(0x1d) && cola.includes(0x56), 'debe terminar con el comando de corte GS V');
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
