// Contrato del ticket final de cuenta (piloto restaurante).
// No necesita Postgres ni servidor: valida el contrato del panel
// (enrutamiento del trabajo cuenta_final + plantilla) renderizando la
// plantilla REAL extraída de panel/index.html con datos ficticios.
//
// Uso: node test/fase-ticket-final-contrato.mjs [--preview]
//   --preview escribe los HTML renderizados a test/.preview-ticket-*.html
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');
const PREVIEW = process.argv.includes('--preview');

let pasadas = 0, fallidas = 0;
const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}

// ── Extraer las funciones reales del panel ──────────────────────────────────
function extraerFuncion(nombre) {
  const inicio = html.indexOf(`function ${nombre}(`);
  assert.ok(inicio !== -1, `panel/index.html debe definir ${nombre}()`);
  // Balance de llaves desde la primera '{' de la función.
  let i = html.indexOf('{', inicio), nivel = 0, fin = -1;
  for (; i < html.length; i++) {
    if (html[i] === '{') nivel++;
    else if (html[i] === '}') { nivel--; if (nivel === 0) { fin = i + 1; break; } }
  }
  assert.ok(fin !== -1, `no se pudo extraer ${nombre}() completa`);
  return html.slice(inicio, fin);
}

const negocio = {
  nombre: 'Mapolato Acuña', nombre_corto: 'Mapolato',
  direccion: 'Domicilio pendiente', ciudad: 'Acuña', telefono: '8787899919',
};
const sandbox = new Function(
  'negocio',
  `${extraerFuncion('totalEnLetras')}\n${extraerFuncion('cuentaFinalHTML')}\nreturn cuentaFinalHTML;`
);
const cuentaFinalHTML = sandbox(negocio);

const trabajoBase = {
  id: 'RM-0A1B2C3D-0',
  folio_venta: 'RM-0A1B2C3D-0',
  tipo_comanda: 'cuenta_final',
  mesa: 4, personas: 3, mesero: 'María Peña',
  items: [
    { nombre: 'Parrillada niño envuelto', cantidad: 1, precio_unitario: 260, notas: 'término medio, sin cebolla, salsa aparte — nota larga de prueba con acentos: jalapeño, azúcar' },
    { nombre: 'Limonada', cantidad: 2, precio_unitario: 35 },
    { nombre: 'Café', cantidad: 1, precio_unitario: 0 },
  ],
  total: 330, propina: 45,
  pagos: [
    { metodo: 'efectivo', monto: 200, propina: 20 },
    { metodo: 'terminal', monto: 130, propina: 25 },
  ],
  modalidad: 'mesa', canal: 'restaurante',
};

// ── Enrutamiento en el panel ────────────────────────────────────────────────
t('el WS intercepta cuenta_final ANTES de agregarPedido (no entra al tablero)', () => {
  assert.ok(html.includes(`msg.pedido?.tipo_comanda === 'cuenta_final'`), 'guard de tipo_comanda');
  // Fixture actualizado (fase Edge): la llamada real lleva además la
  // bandera impresionEdge -- el contrato bajo prueba (cuenta_final se
  // intercepta y va a recibirCuentaFinal, jamás al tablero) es el mismo.
  assert.ok(html.includes('recibirCuentaFinal(msg.pedido, msg.impresionEdge === true)'), 'va a recibirCuentaFinal');
  // El contrato es el ORDEN, no la forma del if/else. Antes se buscaba el
  // literal `else if (msg.tipo === 'nuevo_pedido')`, y el dedupe de eventos
  // (`nuevo_pedido:<negocio>:<folio>`) reestructuro esa rama para envolver las
  // dos ramas en un solo `if (msg.tipo === 'nuevo_pedido')`. Lo que hay que
  // seguir garantizando es lo mismo de siempre: el guard de `cuenta_final`
  // aparece ANTES de la llamada a `agregarPedido`, asi que un ticket de cuenta
  // jamas cae en el tablero.
  const guard = html.indexOf(`tipo_comanda === 'cuenta_final'`);
  const normal = html.indexOf(`agregarPedido(msg.pedido, msg.impresionEdge === true)`);
  assert.ok(guard !== -1, 'no existe el guard de cuenta_final');
  assert.ok(normal !== -1, 'las comandas normales ya no van a agregarPedido');
  assert.ok(guard < normal, 'el guard de cuenta_final dejo de ir ANTES de agregarPedido');
  // Y las dos ramas siguen colgando del mismo tipo de mensaje.
  const raiz = html.indexOf(`if (msg.tipo === 'nuevo_pedido')`);
  assert.ok(raiz !== -1 && raiz < guard, 'la rama de nuevo_pedido dejo de envolver el guard');
});

t('la impresión automática respeta el guard de replay (panelListo)', () => {
  const fn = extraerFuncion('recibirCuentaFinal');
  assert.ok(fn.includes('if (panelListo)'), 'sin panelListo no se imprime (replay del servidor)');
  assert.ok(fn.includes('cuentaFinalHTML'), 'usa SU plantilla, no la comanda de cocina');
  assert.ok(!fn.includes('agregarPedido'), 'jamás agrega tarjeta al tablero');
});

t('reimpresión controlada: solo manual, solo el último ticket, con botón dedicado', () => {
  assert.ok(html.includes('id="btn-reimprimir-cuenta"'), 'botón presente');
  assert.ok(html.includes('style="display:none;"') || html.includes("style='display:none;'"), 'oculto hasta recibir un ticket');
  const fn = extraerFuncion('reimprimirUltimaCuentaFinal');
  assert.ok(fn.includes('if (!ultimaCuentaFinal) return'), 'sin ticket previo no hace nada');
});

// ── Plantilla ───────────────────────────────────────────────────────────────
t('ticket con pago mixto: folio RM-, mesa, mesero, pagos por método, propina separada, saldo cero', () => {
  const out = cuentaFinalHTML(trabajoBase);
  for (const esperado of [
    'RM-0A1B2C3D-0', 'Mesa:', '>4<', 'Personas:', 'María Peña',
    'PAGOS POR MÉTODO', 'Efectivo', '$200.00', '(+$20.00 propina)',
    'Terminal', '$130.00', '(+$25.00 propina)',
    '$330.00', 'Propina (no incluida en el total):', '$45.00',
    'Saldo:', '$0.00', 'CUENTA CERRADA', 'MAPOLATO ACUÑA',
    'Gracias por su visita', 'Venta registrada en reportes con folio RM-0A1B2C3D-0',
  ]) {
    assert.ok(out.includes(esperado), `el ticket debe incluir: ${esperado}`);
  }
  assert.ok(out.includes('jalapeño'), 'caracteres en español intactos (UTF-8)');
  assert.ok(out.includes('size:80mm'), 'ancho 80 mm como las plantillas existentes');
  if (PREVIEW) writeFileSync(join(__dirname, '.preview-ticket-mixto.html'), out);
});

t('ticket en efectivo sin propina: sin línea de propina, un solo método', () => {
  const out = cuentaFinalHTML({
    ...trabajoBase, propina: 0,
    pagos: [{ metodo: 'efectivo', monto: 330, propina: 0 }],
  });
  assert.ok(!out.includes('Propina (no incluida'), 'sin propina no se imprime la línea');
  assert.ok(out.includes('Efectivo') && out.includes('$330.00'));
  assert.ok(!out.includes('Terminal'));
  if (PREVIEW) writeFileSync(join(__dirname, '.preview-ticket-efectivo.html'), out);
});

t('cuenta en cero (sin pagos): sin sección de métodos, total $0.00', () => {
  const out = cuentaFinalHTML({ ...trabajoBase, total: 0, propina: 0, pagos: [], items: [] });
  assert.ok(!out.includes('PAGOS POR MÉTODO'));
  assert.ok(out.includes('$0.00'));
});

t('los importes usan centavos exactos (toFixed(2)), nunca redondeo a peso', () => {
  const out = cuentaFinalHTML({
    ...trabajoBase, total: 100.55, propina: 10.05,
    items: [{ nombre: 'Combo', cantidad: 1, precio_unitario: 100.55 }],
    pagos: [{ metodo: 'terminal', monto: 100.55, propina: 10.05 }],
  });
  assert.ok(out.includes('$100.55'), 'total al centavo');
  assert.ok(out.includes('55/100'), 'leyenda en letras con centavos reales');
});

t('el contenido del trabajo se escapa (nombres/notas nunca inyectan HTML)', () => {
  const out = cuentaFinalHTML({
    ...trabajoBase,
    mesero: '<script>alert(1)</script>',
    items: [{ nombre: '<b>Taco</b>', cantidad: 1, precio_unitario: 10, notas: '"comillas" & <i>etiquetas</i>' }],
  });
  assert.ok(!out.includes('<script>alert'), 'script escapado');
  assert.ok(!out.includes('<b>Taco</b>'), 'etiquetas escapadas');
  assert.ok(out.includes('&lt;b&gt;Taco&lt;/b&gt;'));
});

t('muchos productos y notas largas no rompen el render', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({
    nombre: `Producto de nombre considerablemente largo número ${i + 1}`,
    cantidad: (i % 3) + 1, precio_unitario: 12.5,
    notas: i % 2 ? 'modificadores: extra queso, sin cebolla, salsa verde aparte, tortilla de harina, bien dorado' : '',
  }));
  const out = cuentaFinalHTML({ ...trabajoBase, items, total: 999.99 });
  assert.ok(out.includes('Producto de nombre considerablemente largo número 40'));
  assert.ok(out.includes('$999.99'));
  if (PREVIEW) writeFileSync(join(__dirname, '.preview-ticket-largo.html'), out);
});

t('las comandas de cocina NO usan la plantilla de cuenta: comandaHTML sigue intacta', () => {
  assert.ok(html.includes('function comandaHTML(p)'), 'plantilla de comanda presente');
  const fnComanda = extraerFuncion('comandaHTML');
  assert.ok(!fnComanda.includes('cuenta_final'), 'la comanda no sabe de cuentas -- cero reimpresión cruzada');
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) fallos.forEach(f => console.log(` - ${f}`));
process.exit(fallidas > 0 ? 1 : 0);
