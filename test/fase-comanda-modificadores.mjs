// ─── Comanda de cocina: los modificadores como lista y en grande ────────────
//
// Lo que se lee en la estación tiene que decir, de un vistazo y a un metro,
// qué lleva el platillo. Esta suite fija tres cosas sobre el papel:
//
//   1. una línea por opción, nunca un renglón corrido;
//   2. esas líneas van en DOBLE ALTO (ESC/POS GS ! 1), no en el tamaño
//      normal que las dejaba a la mitad de alto que el producto;
//   3. la nota no repite los modificadores. POS, tienda en línea y envíos
//      los pegan dentro de `notas` para papeles viejos que no sabían de
//      modificadores; en una comanda que ya los lista, eso salía otra vez
//      como párrafo envuelto — el síntoma que motivó el cambio.
//
// Y una cuarta, que es la que protege al restaurante: lo que el mesero o el
// cliente escribieron NUNCA se pierde. Si la nota no calza exactamente con
// los modificadores, se imprime entera.
//
// Los casos usan las formas REALES que viajan hoy en Mapolato (leídas de
// impresion_trabajos y pedidos_activos el 2026-09-19): objetos {grupo,opcion}
// del POS/tienda, textos "Salsa: Mole" de Restaurante, y notas mezcladas con
// " · " y con ", ".
//
// Cubre los tres caminos del papel: el renderer del Edge, el payload que
// arma el servidor (para el Edge ya instalado, que no se actualiza solo) y
// la comanda que imprime el navegador desde el panel.
import assert from 'assert';
import vm from 'vm';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { renderizar } from '../edge/renderers/index.js';
import { lineasDeModificadores, notaSinModificadores } from '../edge/renderers/modificadores.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SALIDA = process.env.CAPTURAS_DIR || join(__dirname, '.capturas-comanda');
mkdirSync(SALIDA, { recursive: true });

let pasadas = 0, fallidas = 0;
const fallos = [];
function t(cat, nombre, fn) {
  try { fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// ── ESC/POS: leer el papel como lo vería la impresora ──
const leer = (buf) => buf.toString('latin1');

// Recorre el flujo tal como lo haría la impresora y devuelve cada línea con
// el tamaño con el que se imprime. Se hace caminando los bytes, no con una
// expresión regular: las secuencias de ESC/POS tienen largos distintos
// (ESC @ son 2 bytes, ESC a n son 3, GS V A n son 4) y una regex con un
// comodín se come caracteres del texto — pasó en el primer intento de esta
// suite y el papel parecía decir "aPOLATO".
function lineasConTamano(buf) {
  const txt = leer(buf);
  const lineas = [];
  let grande = false, actual = '', i = 0;
  while (i < txt.length) {
    const c = txt[i];
    if (c === '\x1B') { i += txt[i + 1] === '@' ? 2 : 3; continue; }      // init / alineación / negritas
    if (c === '\x1D') {
      if (txt[i + 1] === '!') { grande = txt.charCodeAt(i + 2) !== 0; i += 3; continue; }
      i += txt[i + 1] === 'V' ? 4 : 3; continue;                          // corte
    }
    if (c === '\n') { lineas.push({ texto: actual, grande }); actual = ''; i++; continue; }
    actual += c; i++;
  }
  if (actual) lineas.push({ texto: actual, grande });
  return lineas;
}
const lineasVisibles = (buf) => lineasConTamano(buf).map(l => l.texto);
const visible = (buf) => lineasVisibles(buf).join('\n');
const plano = (buf) => visible(buf).replace(/\s+/g, ' ').trim();
// ¿La línea donde aparece este fragmento se imprime en doble alto?
function enDobleAlto(buf, fragmento) {
  const linea = lineasConTamano(buf).find(l => l.texto.includes(fragmento));
  assert.ok(linea, `no aparece "${fragmento}" en el papel`);
  return linea.grande;
}

// ── Casos reales ──
// POS / tienda en línea: modificadores como objetos y la nota con los mismos
// modificadores pegados delante, separados por " · " (XAB-0376).
const AGUA_POS = {
  producto: 'Aguas Naturales', cantidad: 1,
  modificadores: [
    { grupo: 'Tamaño', opcion: 'Grande 1 Litro', grupo_id: 52, opcion_id: 233, precio_extra: 20 },
    { grupo: 'Sabor', opcion: 'Limonada', grupo_id: 53, opcion_id: 238, precio_extra: 0 },
  ],
  notas: 'Tamaño: Grande 1 Litro · Sabor: Limonada · que tenga mucho limon',
};
// POS con dos opciones del MISMO grupo: la nota las trae agrupadas (XAB-0375).
const HUEVOS_POS = {
  producto: 'Huevos revueltos con jamón', cantidad: 1,
  modificadores: [
    { grupo: 'Guarniciones', opcion: 'Frijolitos naturales' },
    { grupo: 'Guarniciones', opcion: 'Papas a la mexicana' },
  ],
  notas: 'Guarniciones: Frijolitos naturales, Papas a la mexicana',
};
// Restaurante: modificadores ya formateados como texto, sin nota.
const CHILAQUILES_MESA = {
  producto: 'Chilaquiles Sencillos', cantidad: 1,
  modificadores: ['Salsa: Mole', 'Proteína: Bistec en Salsa', 'Guarniciones: Papas con chorizo', 'Guarniciones: Papas a la mexicana'],
  notas: null,
};
// Restaurante por el camino antiguo: nota escrita a mano + modificadores
// pegados con ", " al final (así los arma /comanda cuando Edge no se hace
// cargo, y así se vieron en las ventas RM-*).
const TACO_LEGACY = {
  producto: 'Taco de Huevo con Tocino', cantidad: 2,
  modificadores: ['Tortilla: Harina'],
  notas: 'VAN HACER DE HUEVO CHORIZO, Tortilla: Harina',
};

const comanda = (items, extra = {}) => renderizar('comanda', {
  negocio: 'Mapolato Obispado', mesa: 7, mesero: 'ANGEL', ronda: 1,
  emitidoAt: '2026-09-19T14:30:00.000Z', impresora: 'COCINA', items, ...extra,
}, { ancho: 42 });

// ═══════════ Edge: lista y tamaño ═══════════
t('LISTA', '1. cada opción va en su propia línea, con viñeta y sangría', () => {
  const papel = comanda([CHILAQUILES_MESA]);
  const lineas = lineasVisibles(papel);
  const mods = lineas.filter(l => l.startsWith('  > '));
  assert.deepStrictEqual(mods, [
    '  > Salsa: Mole',
    '  > Proteína: Bistec en Salsa',
    '  > Guarniciones: Papas con chorizo',
    '  > Guarniciones: Papas a la mexicana',
  ], lineas.join('|'));
});

t('TAMANO', '2. los modificadores salen en DOBLE ALTO, no en tamaño normal', () => {
  const papel = comanda([CHILAQUILES_MESA]);
  for (const m of ['> Salsa: Mole', '> Proteína: Bistec en Salsa', '> Guarniciones: Papas a la mexicana']) {
    assert.ok(enDobleAlto(papel, m), `"${m}" no salió en doble alto`);
  }
  // Y el tamaño vuelve a normal antes del pie: no se deja la impresora en
  // doble alto para lo que siga.
  const pie = lineasConTamano(papel).filter(l => l.texto.startsWith('===')).pop();
  assert.ok(pie && !pie.grande, 'el tamaño no volvió a normal antes del pie');
});

t('TAMANO', '3. el producto sigue mandando: doble alto y negritas', () => {
  const papel = comanda([CHILAQUILES_MESA]);
  assert.ok(enDobleAlto(papel, 'CHILAQUILES'), 'el nombre se envuelve a 21 columnas por el doble alto');
  assert.ok(leer(papel).includes('\x1B' + 'E' + '\x01'), 'faltan las negritas del producto');
});

t('LISTA', '4. los objetos {grupo, opcion} del POS se leen igual que los textos de Restaurante', () => {
  const mods = lineasVisibles(comanda([AGUA_POS])).filter(l => l.startsWith('  > '));
  assert.deepStrictEqual(mods, ['  > Tamaño: Grande 1 Litro', '  > Sabor: Limonada']);
});

// ═══════════ La nota deja de repetir los modificadores ═══════════
t('NOTA', '5. la nota conserva SOLO lo que escribió el cliente', () => {
  const papel = comanda([AGUA_POS]);
  const lineas = lineasVisibles(papel).filter(l => l.includes('NOTA'));
  assert.strictEqual(lineas.length, 1, lineas.join('|'));
  assert.ok(lineas[0].includes('NOTA: que tenga mucho limon'), lineas[0]);
  // Y no vuelve a aparecer el bloque de modificadores dentro de la nota.
  assert.ok(!visible(papel).includes('NOTA: Tamaño'), 'la nota sigue repitiendo los modificadores');
  assert.strictEqual((visible(papel).match(/Limonada/g) || []).length, 1, 'Limonada aparece dos veces');
});

t('NOTA', '6. la nota que es SOLO modificadores agrupados desaparece', () => {
  const papel = comanda([HUEVOS_POS]);
  assert.ok(!visible(papel).includes('NOTA'), 'se imprimió una nota que solo repetía los modificadores');
  const mods = lineasVisibles(papel).filter(l => l.startsWith('  > '));
  assert.deepStrictEqual(mods, ['  > Guarniciones: Frijolitos naturales', '  > Guarniciones: Papas a la mexicana']);
});

t('NOTA', '7. con los modificadores pegados al final (camino antiguo de mesas) queda la parte escrita a mano', () => {
  const papel = comanda([TACO_LEGACY]);
  const nota = lineasVisibles(papel).filter(l => l.includes('NOTA'));
  assert.strictEqual(nota.length, 1, nota.join('|'));
  assert.ok(nota[0].includes('NOTA: VAN HACER DE HUEVO CHORIZO'), nota[0]);
  assert.ok(!nota[0].includes('Tortilla'), 'la nota repite el modificador');
  assert.ok(visible(papel).includes('> Tortilla: Harina'), 'el modificador debe seguir en la lista');
});

t('NOTA', '8. una nota escrita a mano NUNCA se pierde, aunque se parezca a un modificador', () => {
  const casos = [
    { notas: 'sin cebolla', mods: ['Salsa: Mole'], espera: 'sin cebolla' },
    { notas: 'Salsa: Mole pero poquita', mods: ['Salsa: Mole'], espera: 'Salsa: Mole pero poquita' },
    { notas: 'para llevar · sin cubiertos', mods: [], espera: 'para llevar · sin cubiertos' },
    { notas: 'Salsa: Mole · bien caliente', mods: ['Salsa: Mole'], espera: 'bien caliente' },
    { notas: 'bien caliente · Salsa: Mole', mods: ['Salsa: Mole'], espera: 'bien caliente' },
    { notas: '  ', mods: ['Salsa: Mole'], espera: null },
    { notas: null, mods: ['Salsa: Mole'], espera: null },
  ];
  for (const c of casos) {
    assert.strictEqual(notaSinModificadores(c.notas, c.mods), c.espera, JSON.stringify(c));
  }
});

t('NOTA', '9. sin modificadores, la nota se imprime entera aunque tenga separadores', () => {
  const papel = comanda([{ producto: 'Combo', cantidad: 1, modificadores: [], notas: 'Salsa: aparte · sin picante, por favor' }]);
  // La nota larga se envuelve en varias líneas: se compara el texto plano.
  assert.ok(plano(papel).includes('NOTA: Salsa: aparte · sin picante, por favor'), plano(papel));
});

t('NOTA', '10. la nota también va en doble alto y negritas: es lo que cambia el platillo', () => {
  const papel = comanda([AGUA_POS]);
  assert.ok(enDobleAlto(papel, 'NOTA: que tenga mucho limon'));
});

// ═══════════ Contratos que no se tocan ═══════════
t('CONTRATO', '11. la comanda sigue sin precios y con mesa, mesero, ronda e impresora', () => {
  const papel = comanda([CHILAQUILES_MESA, AGUA_POS]);
  const txt = visible(papel);
  assert.ok(!/\$/.test(txt), 'a la cocina no le sirven los importes');
  for (const esperado of ['MAPOLATO OBISPADO', 'MESA 7', 'ANGEL', 'RONDA 1', 'COCINA']) {
    assert.ok(txt.includes(esperado), `falta "${esperado}"`);
  }
});

t('CONTRATO', '12. la reimpresión sigue marcándose y el corte de papel no se pierde', () => {
  const papel = comanda([CHILAQUILES_MESA], { reimpresion: true });
  assert.ok(visible(papel).includes('*** REIMPRESION ***'));
  assert.ok(leer(papel).includes('\x1DVA'), 'falta el corte');
});

t('CONTRATO', '13. un item sin modificadores ni nota imprime solo el producto', () => {
  const papel = comanda([{ producto: 'Café Americano', cantidad: 2, modificadores: [], notas: null }]);
  const lineas = lineasVisibles(papel);
  assert.ok(lineas.some(l => l.includes('2 CAFÉ AMERICANO')), lineas.join('|'));
  assert.ok(!lineas.some(l => l.startsWith('  > ') || l.includes('NOTA')), lineas.join('|'));
});

t('CONTRATO', '14. la cuenta del cliente no cambia: sigue con importes y en tamaño normal', () => {
  const txt = leer(renderizar('cuenta', {
    negocio: 'Mapolato', mesa: 4, folio: 'RM-1',
    items: [{ producto: 'Chilaquiles', cantidad: 1, precioUnitario: 195, modificadores: ['Salsa: Mole'] }],
    subtotal: 195, total: 195, pagos: [{ metodo: 'efectivo', monto: 195 }],
  }));
  assert.ok(txt.includes('$195.00') && txt.includes('TOTAL'));
  assert.ok(txt.includes('    Salsa: Mole'), 'la cuenta conserva su sangría de cuatro');
  assert.ok(!txt.includes('> Salsa: Mole'), 'la viñeta es de la comanda, no de la cuenta');
});

// ═══════════ El payload del servidor ═══════════
const { _pruebas } = await import('../src/services/impresionService.js').then(m => ({ _pruebas: m })).catch(() => ({ _pruebas: null }));
t('PAYLOAD', '15. el servidor manda la nota ya limpia: el Edge instalado hoy deja de repetirla', () => {
  // itemsParaComanda no se exporta (es interno del servicio); se comprueba su
  // regla por la función compartida que usa, que es donde vive el criterio.
  assert.strictEqual(notaSinModificadores(AGUA_POS.notas, AGUA_POS.modificadores), 'que tenga mucho limon');
  assert.strictEqual(notaSinModificadores(HUEVOS_POS.notas, HUEVOS_POS.modificadores), null);
  const fuente = readFileSync(join(__dirname, '../src/services/impresionService.js'), 'utf8');
  assert.ok(fuente.includes('notas: notaSinModificadores(i.notas, modificadores)'), 'el payload no limpia la nota');
  assert.strictEqual((fuente.match(/items: itemsParaComanda\(grupo\.items\)/g) || []).length, 3,
    'los tres payloads de comanda (pedido, mesa y reenvío) deben usar el mismo criterio');
});

t('PAYLOAD', '16. el camino antiguo de mesas manda los modificadores aparte, sin quitarlos de la nota', () => {
  const server = readFileSync(join(__dirname, '../src/server.js'), 'utf8');
  const i = server.indexOf("id: `MESA${comanda.mesa}-C${comanda.comanda}`");
  assert.ok(i > 0, 'no se encontró el emisor antiguo de comanda de mesa');
  const bloque = server.slice(i, i + 900);
  assert.ok(/modificadores: Array\.isArray\(i\.modificadores\)/.test(bloque), 'no manda modificadores aparte');
  assert.ok(/notas: \[i\.notas, \.\.\.\(Array\.isArray\(i\.modificadores\)/.test(bloque),
    'la nota mezclada se conserva para los print-agent viejos');
});

// ═══════════ El panel (papel por navegador) ═══════════
const panel = readFileSync(join(__dirname, '../panel/index.html'), 'utf8');
function funcionesDelPanel() {
  const desde = panel.indexOf('function modsAgrupados(');
  const hasta = panel.indexOf('function ticketHTML(');
  assert.ok(desde > 0 && hasta > desde, 'no se encontró el bloque de impresión del panel');
  const ctx = {
    negocio: { nombre_corto: 'MAPOLATO' },
    getNombre: (p) => (p.cliente && p.cliente.nombre) || 'Cliente',
    horaCST: () => '19/09/2026 08:30',
    document: { getElementById: () => null, createElement: () => ({ style: {}, appendChild() {} }), body: { appendChild() {} } },
    window: {}, setTimeout: () => 0, console,
  };
  vm.createContext(ctx);
  vm.runInContext(panel.slice(desde, hasta), ctx, { filename: 'panel/index.html' });
  return ctx;
}
const P = funcionesDelPanel();

t('PANEL', '17. la comanda del navegador pinta un renglón por opción, no uno agrupado', () => {
  const html = P.comandaHTML({ id: 'XAB-0376', canal: 'presencial', modalidad: 'recoger en tienda', items: [AGUA_POS_PANEL()] });
  const divs = [...html.matchAll(/<div style="font-size:15px[^"]*">([^<]*)<\/div>/g)].map(m => m[1].trim());
  assert.deepStrictEqual(divs, ['&gt; Tamaño: Grande 1 Litro', '&gt; Sabor: Limonada', 'NOTA: que tenga mucho limon'], html);
});

t('PANEL', '18. la letra de los modificadores creció: 15px, antes 12px (y la nota 15px, antes 11px en cursiva)', () => {
  const html = P.comandaHTML({ id: 'XAB-1', items: [AGUA_POS_PANEL()] });
  // Se mira el bloque de items, no el CSS de la hoja (el cuerpo y el badge
  // siguen en 12px a propósito).
  const items = html.slice(html.indexOf('<table>'), html.indexOf('</table>'));
  assert.ok(!/font-size:12px/.test(items), 'quedó un renglón de 12px entre los items');
  assert.ok(!/font-size:11px/.test(items) && !/font-style:italic/.test(items), 'la nota sigue en cursiva pequeña');
  assert.ok(/font-size:18px[^"]*">1x/.test(html), 'la cantidad debe seguir siendo la más grande');
  assert.ok(/font-size:16px/.test(html), 'el producto debe crecer con los modificadores');
});

t('PANEL', '19. el panel escapa lo que imprime (un nombre con < ya no rompe el papel)', () => {
  const html = P.comandaHTML({ id: 'XAB-2', items: [{ nombre: 'Taco <b>especial</b>', cantidad: 1, modificadores: ['Salsa: <script>'], notas: 'sin & con' }] });
  assert.ok(html.includes('Taco &lt;b&gt;especial&lt;/b&gt;'), 'el producto no está escapado');
  assert.ok(html.includes('Salsa: &lt;script&gt;'), 'el modificador no está escapado');
  assert.ok(html.includes('sin &amp; con'), 'la nota no está escapada');
});

t('PANEL', '20. las dos implementaciones dicen lo mismo (panel y Edge no se separan)', () => {
  const casos = [
    [AGUA_POS.notas, AGUA_POS.modificadores],
    [HUEVOS_POS.notas, HUEVOS_POS.modificadores],
    [TACO_LEGACY.notas, TACO_LEGACY.modificadores],
    ['bien caliente', ['Salsa: Mole']],
    ['Salsa: Mole', ['Salsa: Mole']],
    [null, []],
    ['solo nota', []],
    ['Tortilla: Harina, Salsa: Verde', ['Tortilla: Harina', 'Salsa: Verde']],
  ];
  for (const [notas, mods] of casos) {
    const item = { modificadores: mods, notas };
    assert.deepStrictEqual(P.modsLineas(item), lineasDeModificadores(mods), `lineas: ${JSON.stringify(mods)}`);
    assert.strictEqual(P.notaSinMods(notas, P.modsLineas(item)), notaSinModificadores(notas, mods), `nota: ${JSON.stringify([notas, mods])}`);
  }
});

function AGUA_POS_PANEL() {
  return { nombre: AGUA_POS.producto, cantidad: AGUA_POS.cantidad, modificadores: AGUA_POS.modificadores, notas: AGUA_POS.notas };
}

// ═══════════ Muestras para ver el papel ═══════════
const papelMuestra = comanda([CHILAQUILES_MESA, AGUA_POS, HUEVOS_POS, TACO_LEGACY, { producto: 'Café Americano', cantidad: 2, modificadores: [], notas: null }]);
const conMarcas = lineasConTamano(papelMuestra)
  .map(l => `${l.grande ? 'GRANDE │ ' : '       │ '}${l.texto}`).join('\n');
writeFileSync(join(SALIDA, 'comanda-edge-nueva.txt'), conMarcas, 'utf8');
writeFileSync(join(SALIDA, 'comanda-navegador-nueva.html'),
  P.comandaHTML({ id: 'XAB-0376', canal: 'presencial', modalidad: 'recoger en tienda', cliente: { nombre: 'MARIO' },
    items: [AGUA_POS_PANEL(), { nombre: CHILAQUILES_MESA.producto, cantidad: 1, modificadores: CHILAQUILES_MESA.modificadores, notas: null },
            { nombre: TACO_LEGACY.producto, cantidad: 2, modificadores: TACO_LEGACY.modificadores, notas: TACO_LEGACY.notas }] }), 'utf8');

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
console.log(`Muestras en: ${SALIDA}`);
process.exitCode = fallidas > 0 ? 1 : 0;
