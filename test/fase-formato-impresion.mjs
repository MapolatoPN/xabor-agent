// ─── Formato de impresión v1: el servidor arma el papel, el Edge lo imprime ─
//
// Fija el contrato que permite cambiar el diseño de la comanda y del ticket
// sin volver a tocar la PC del restaurante:
//
//   A. el maquetador nunca deja un renglón más ancho que el papel;
//   B. las opciones del negocio se validan: nada mal escrito rompe el papel;
//   C. la comanda: número de orden, tipo y hora arriba; platillo en el tamaño
//      más grande que no lo parta; opciones grandes y sin repetirse en la nota;
//   D. el ticket: datos del negocio sin etiquetas vacías, importes alineados;
//   E. el intérprete del Edge: solo comandos propios, texto saneado, ancho
//      defendido otra vez, estado normal tras cada renglón;
//   F. compatibilidad: un Edge viejo ignora `formato`; uno nuevo sin formato
//      (o con uno raro) imprime el diseño de siempre.
//   G. (con Postgres) el servidor le pone el formato a cada trabajo.
import assert from 'assert';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  columnasDisponibles, puntosDeRenglon, parrafo, filaColumnas, estiloLimpio, envolver,
} from '../src/printing/formato/maquetador.js';
import { normalizarFormato, FORMATO_POR_DEFECTO } from '../src/printing/formato/opciones.js';
import { renglonesDeComanda, tipoDePedido, numeroDeOrden } from '../src/printing/formato/comanda.js';
import { renglonesDeTicket } from '../src/printing/formato/ticket.js';
import { formatoDeDocumento } from '../src/printing/formato/index.js';
import { renderizar, renderComanda } from '../edge/renderers/index.js';
import { interpretarFormato, esFormatoValido } from '../edge/renderers/formato.js';
import { textoTermico } from '../edge/renderers/escpos.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// La comanda de la foto del 20-oct-2026 (Mapolato Acuña).
const FOTO = [
  { producto: 'Chilaquiles Mixtos', cantidad: 1, modificadores: ['Salsa: Verde', 'Proteína: Huevos Estrellados', 'Guarniciones: Frijolitos con chorizo'], notas: 'Sin aguacate' },
  { producto: 'Chilaquiles Sencillos', cantidad: 1, modificadores: ['Salsa: Chipotle', 'Proteína: Pechuga de pollo'], notas: null },
  { producto: 'Combito de Chilaquiles', cantidad: 1, modificadores: ['Salsa: Roja', 'Proteína: Chicharrón prensado'], notas: null },
  { producto: 'Huevos Revueltos con Jamón', cantidad: 1,
    modificadores: [{ grupo: 'Guarniciones', opcion: 'Frijolitos naturales' }, { grupo: 'Guarniciones', opcion: 'Papas con chorizo' }],
    // Así los pegan POS y tienda: la nota repite las opciones (el doble que reportó Chrome).
    notas: 'Guarniciones: Frijolitos naturales, Papas con chorizo' },
];
const DATOS = { negocio: 'Mapolato Acuña', folio: 'XAB-2077', modalidad: 'recoger en tienda', cliente: 'Manuel',
  emitidoAt: '2026-10-20T16:10:51Z', impresora: 'Cocina', items: FOTO };
const textos = (R) => R.filter(r => typeof r.texto === 'string').map(r => r.texto);
const buscar = (R, f) => R.find(r => typeof r.texto === 'string' && r.texto.includes(f));

// ═══════════ A. Maquetador ═══════════
await t('MAQUETA', '1. columnas por tamaño y aire (fuente A, 12 puntos)', async () => {
  assert.deepStrictEqual(
    [[42, 'normal', 0], [42, 'alto', 0], [42, 'doble', 0], [42, 'normal', 2], [48, 'doble', 0], [48, 'alto', 2], [32, 'ancho', 0]]
      .map(([a, tam, aire]) => columnasDisponibles(a, { tam, aire })),
    [42, 42, 21, 36, 24, 41, 16]);
});

await t('MAQUETA', '2. ningún renglón se pasa del papel y no se pierde ninguna palabra (barrido)', async () => {
  const frases = [
    'Chilaquiles verdes con pollo deshebrado y doble porción de crema y queso',
    'CHILAQUILESVERDESCONPOLLOYQUESOEXTRAGRATINADOSALHORNO',
    'Sin  cebolla\tni cilantro\npor favor 🎂 “bien” caliente…',
    'á é í ó ú ñ Ñ ¿? ¡!',
  ];
  for (const ancho of [20, 32, 42, 48, 64]) for (const tam of ['normal', 'alto', 'ancho', 'doble']) for (const aire of [0, 1, 2, 4]) {
    for (const f of frases) for (const sangria of ['', '  ']) {
      const R = parrafo(f, { tam, aire }, ancho, { sangria });
      for (const r of R) assert.ok(puntosDeRenglon(r) <= ancho * 12, `${ancho}/${tam}/${aire}: «${r.texto}» mide ${puntosDeRenglon(r)}`);
      const juntas = R.map(r => r.texto.trim()).join(' ').replace(/\s+/g, '');
      assert.strictEqual(juntas, textoTermico(f).replace(/\s+/g, ''), `${ancho}/${tam}/${aire}: se perdió texto`);
    }
  }
});

await t('MAQUETA', '3. una fila con importe: el importe nunca se corta y cae en el borde', async () => {
  for (const ancho of [32, 42, 48]) for (const tam of ['normal', 'doble']) {
    const r = filaColumnas('1 Huevos revueltos con jamón y frijoles refritos', '$1,234.50', { tam }, ancho);
    assert.ok(r.texto.endsWith('$1,234.50'), r.texto);
    assert.strictEqual(r.texto.length, columnasDisponibles(ancho, { tam }), r.texto);
  }
});

await t('MAQUETA', '4. un estilo desconocido cae al valor seguro', async () => {
  assert.deepStrictEqual(estiloLimpio({ tam: 'gigante', alinear: 'diagonal', aire: 99, negrita: 'si', invertido: 1 }), { aire: 4 });
  assert.deepStrictEqual(estiloLimpio({ tam: 'doble', alinear: 'centro', negrita: true }), { tam: 'doble', alinear: 'centro', negrita: true });
  assert.deepStrictEqual(envolver('a b', 0), ['a', 'b'], 'columnas 0 no debe colgarse');
});

// ═══════════ B. Opciones del negocio ═══════════
await t('OPCIONES', '5. lo guardado se valida: basura, JSON roto y valores fuera de lista caen al de fábrica', async () => {
  for (const g of [null, undefined, 'no es json', 42, [], { comanda: 'x', ticket: 7 }]) {
    assert.deepStrictEqual(normalizarFormato(g), normalizarFormato({}), JSON.stringify(g));
  }
  assert.deepStrictEqual(normalizarFormato({}).comanda, { ...FORMATO_POR_DEFECTO.comanda });
  const raro = normalizarFormato(JSON.stringify({ comanda: { producto: 'enorme', aire: 9, mostrarGrupo: 'no', tamOrden: 'alto' },
    ticket: { pie: `Síguenos\u0007 en\nredes ${'x'.repeat(300)}`, totalGrande: false } }));
  assert.strictEqual(raro.comanda.producto, 'auto');
  assert.strictEqual(raro.comanda.aire, 'auto');
  assert.strictEqual(raro.comanda.mostrarGrupo, true);
  assert.strictEqual(raro.comanda.tamOrden, 'alto');
  assert.strictEqual(raro.ticket.totalGrande, false);
  assert.ok(raro.ticket.pie.startsWith('Síguenos en redes') && raro.ticket.pie.length <= 160, raro.ticket.pie);
});

// ═══════════ C. Comanda ═══════════
await t('COMANDA', '6. arriba, grande: número de orden, tipo y hora, y el cliente; sin precios', async () => {
  const R = renglonesDeComanda(DATOS, { ancho: 42 });
  assert.deepStrictEqual(buscar(R, '#2077'), { texto: '#2077', tam: 'doble', negrita: true, alinear: 'centro' });
  assert.ok(buscar(R, 'PARA RECOGER · ')?.tam === 'alto', 'falta el tipo y la hora en grande');
  assert.ok(/PARA RECOGER · \d\d:\d\d/.test(buscar(R, 'PARA RECOGER').texto));
  assert.ok(buscar(R, 'Cliente: Manuel'), 'falta el cliente');
  assert.ok(buscar(R, 'MAPOLATO ACUÑA') && buscar(R, 'COCINA'));
  assert.ok(!textos(R).some(x => x.includes('$')), 'a la cocina no le sirven los importes');
  assert.deepStrictEqual(R.slice(-3), [{ linea: '=' }, { espacio: 3 }, { corte: true }]);
});

await t('COMANDA', '7. platillo en un renglón: alto con 42, doble con 48; opciones grandes, negritas y con aire en 48', async () => {
  const R42 = renglonesDeComanda(DATOS, { ancho: 42 });
  for (const p of ['1 CHILAQUILES SENCILLOS', '1 COMBITO DE CHILAQUILES', '1 HUEVOS REVUELTOS CON JAMÓN']) {
    assert.deepStrictEqual(buscar(R42, p), { texto: p, tam: 'alto', negrita: true }, p);
  }
  const R48 = renglonesDeComanda(DATOS, { ancho: 48 });
  assert.deepStrictEqual(buscar(R48, '1 CHILAQUILES SENCILLOS'), { texto: '1 CHILAQUILES SENCILLOS', tam: 'doble', negrita: true });
  assert.deepStrictEqual(buscar(R48, '> Guarniciones: Frijolitos con chorizo'),
    { texto: '  > Guarniciones: Frijolitos con chorizo', tam: 'alto', negrita: true, aire: 2 });
  assert.ok(R48.filter(r => r.texto !== undefined).every(r => puntosDeRenglon(r) <= 48 * 12));
});

await t('COMANDA', '8. la nota no repite las opciones (el doble que vio Chrome) y lo escrito a mano se queda', async () => {
  const R = renglonesDeComanda(DATOS, { ancho: 42 });
  assert.ok(!textos(R).some(x => x.includes('NOTA: Guarniciones')), 'la nota repite las opciones');
  assert.strictEqual(textos(R).filter(x => x.includes('Papas con chorizo')).length, 1);
  assert.ok(buscar(R, 'NOTA: Sin aguacate'), 'se perdió la nota escrita');
});

await t('COMANDA', '9. personas, «cambio de», nota del pedido y reimpresión', async () => {
  const R = renglonesDeComanda({ ...DATOS, reimpresion: true, notaPedido: 'Tocar el timbre',
    items: [{ producto: 'Molletes', cantidad: 2, persona: { numero: 1, nombre: 'Ana' }, en_lugar_de: 'Chilaquiles' },
            { producto: 'Café', cantidad: 1, persona: { numero: 2, nombre: 'Beto' } }] }, { ancho: 42 });
  assert.ok(buscar(R, 'ORDEN 1 - ANA') && buscar(R, 'ORDEN 2 - BETO'), textos(R).join('|'));
  assert.ok(buscar(R, 'CAMBIO DE: Chilaquiles') && buscar(R, 'NOTA DEL PEDIDO: Tocar el timbre'));
  assert.ok(buscar(R, '*** REIMPRESION ***'));
  assert.ok(!textos(R).some(x => x.includes('NOTA: Orden')), 'la persona no va en la nota');
});

await t('COMANDA', '10. las opciones del negocio se aplican', async () => {
  const formato = normalizarFormato({ comanda: { mostrarGrupo: false, notaInvertida: true, producto: 'normal',
    modificadores: 'normal', negocio: false, cliente: false, impresora: false, tamOrden: 'alto' } });
  const R = renglonesDeComanda(DATOS, { ancho: 42, formato });
  assert.ok(buscar(R, '> Verde') && !buscar(R, '> Salsa: Verde'), 'no se quitó el nombre del grupo');
  assert.strictEqual(buscar(R, 'NOTA: Sin aguacate').invertido, true);
  assert.strictEqual(buscar(R, '1 CHILAQUILES MIXTOS').tam, undefined, 'el platillo debía ir normal');
  assert.strictEqual(buscar(R, '> Verde').tam, undefined);
  assert.ok(!buscar(R, 'MAPOLATO') && !buscar(R, 'Cliente:') && !buscar(R, 'COCINA'));
  assert.strictEqual(buscar(R, '#2077').tam, 'alto');
});

await t('COMANDA', '11. mesa: MESA y ronda arriba, mesero; tipos de pedido y números de orden', async () => {
  const R = renglonesDeComanda({ negocio: 'Mapolato', mesa: 7, ronda: 2, mesero: 'ANGEL', emitidoAt: DATOS.emitidoAt, items: FOTO.slice(0, 1) }, { ancho: 42 });
  assert.strictEqual(buscar(R, 'MESA 7').tam, 'doble');
  assert.ok(/^RONDA 2 · \d\d:\d\d$/.test(buscar(R, 'RONDA 2').texto));
  assert.ok(buscar(R, 'Mesero: ANGEL') && !buscar(R, 'Cliente:'));
  assert.deepStrictEqual(['entrega a domicilio', 'recoger en tienda', 'para llevar', 'mesa', '', null].map(tipoDePedido),
    ['DOMICILIO', 'PARA RECOGER', 'PARA LLEVAR', 'COMER AQUÍ', 'PARA LLEVAR', 'PARA LLEVAR']);
  assert.deepStrictEqual(['XAB-0207', 'XAB-2077', 'RM-ABC-0'].map(numeroDeOrden), ['#207', '#2077', 'RM-ABC-0']);
});

// ═══════════ D. Ticket ═══════════
const TICKET = { mesa: 4, mesero: 'Karina', folio: 'RM-1', emitidoAt: DATOS.emitidoAt,
  items: [{ producto: 'Chilaquiles', cantidad: 2, precioUnitario: 120, modificadores: ['Salsa: Verde'], notas: 'Salsa: Verde · sin crema' }],
  subtotal: 240, descuento: 24, descuentoMotivo: 'Martes 2x1', propina: 20, total: 236,
  pagos: [{ metodo: 'efectivo', monto: 300 }], efectivoRecibido: 300, cambio: 64 };
const NEGOCIO = { nombre: 'Mapolato Obispado', direccion: 'Av. Obispado 100', ciudad: 'Monterrey', rfc: 'MAP010101AAA', telefono: '81 1234 5678', whatsapp: '' };

await t('TICKET', '12. encabezado del negocio; sin WhatsApp no sale la etiqueta', async () => {
  const R = renglonesDeTicket(TICKET, { ancho: 42, negocio: NEGOCIO });
  assert.ok(buscar(R, 'MAPOLATO OBISPADO') && buscar(R, 'Av. Obispado 100, Monterrey') && buscar(R, 'RFC: MAP010101AAA') && buscar(R, 'Tel: 81 1234 5678'));
  assert.ok(!buscar(R, 'WhatsApp'), 'la etiqueta vacía de WhatsApp');
  const sinRfc = renglonesDeTicket(TICKET, { ancho: 42, negocio: NEGOCIO, formato: normalizarFormato({ ticket: { rfc: false, pie: '' } }) });
  assert.ok(!buscar(sinRfc, 'RFC') && !buscar(sinRfc, 'Gracias'));
});

await t('TICKET', '13. importes al borde, nota sin repetir opciones, total grande y pie', async () => {
  for (const ancho of [32, 42, 48]) {
    const R = renglonesDeTicket(TICKET, { ancho, negocio: NEGOCIO });
    const linea = buscar(R, '2 Chilaquiles');
    assert.ok(linea.texto.endsWith('$240.00') && linea.texto.length === ancho, linea.texto);
    assert.ok(buscar(R, 'NOTA: sin crema') && !buscar(R, 'NOTA: Salsa'), textos(R).join('|'));
    assert.deepStrictEqual({ tam: buscar(R, 'TOTAL').tam, negrita: buscar(R, 'TOTAL').negrita }, { tam: 'doble', negrita: true });
    assert.ok(buscar(R, 'TOTAL').texto.endsWith('$236.00'));
    assert.ok(buscar(R, 'Descuento (Martes 2x1)').texto.endsWith('-$24.00') && buscar(R, 'Cambio').texto.endsWith('$64.00'));
    assert.ok(buscar(R, 'Gracias por su visita'));
    for (const r of R) if (r.texto !== undefined) assert.ok(puntosDeRenglon(r) <= ancho * 12, `${ancho}: «${r.texto}»`);
  }
  const qr = renglonesDeTicket({ ...TICKET, autofacturaQr: { size: 21, data: Array(441).fill(1) }, autofacturaUrl: 'https://x' }, { ancho: 42 });
  assert.ok(qr.some(r => r.qr) && buscar(qr, 'ESCANEA PARA FACTURAR'));
  assert.ok(buscar(renglonesDeTicket({ ...TICKET, precuenta: true }, { ancho: 42 }), 'PRECUENTA'));
});

// ═══════════ E. Intérprete del Edge ═══════════
// Recorre los bytes como la impresora: solo admite los comandos que emite el
// Edge y devuelve cada renglón con su estado.
function leerBytes(buf) {
  const lineas = [];
  const raros = [];
  let st = { tam: 0, negrita: false, invertido: false, subrayado: false, aire: 0, alinear: 0 };
  let actual = '';
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i], n = buf[i + 1], v = buf[i + 2];
    if (c === 0x1b) {
      if (n === 0x40) { st = { tam: 0, negrita: false, invertido: false, subrayado: false, aire: 0, alinear: 0 }; i += 1; continue; }
      if (n === 0x74 && v === 16) { i += 2; continue; }
      if (n === 0x61 && v <= 2) { st.alinear = v; i += 2; continue; }
      if (n === 0x45 && v <= 1) { st.negrita = v === 1; i += 2; continue; }
      if (n === 0x2d && v <= 1) { st.subrayado = v === 1; i += 2; continue; }
      if (n === 0x20 && v <= 4) { st.aire = v; i += 2; continue; }
    } else if (c === 0x1d) {
      if (n === 0x21 && [0x00, 0x01, 0x10, 0x11].includes(v)) { st.tam = v; i += 2; continue; }
      if (n === 0x42 && v <= 1) { st.invertido = v === 1; i += 2; continue; }
      if (n === 0x56 && v === 0x41) { i += 3; continue; }
      if (n === 0x76 && v === 0x30) {                                       // imagen (QR)
        const ancho = buf[i + 4] | (buf[i + 5] << 8), alto = buf[i + 6] | (buf[i + 7] << 8);
        i += 7 + ancho * alto; continue;
      }
    } else if (c === 0x0a) { lineas.push({ texto: actual, ...st }); actual = ''; continue; }
    else if ((c >= 0x20 && c <= 0x7e) || c >= 0xa0) { actual += String.fromCharCode(c); continue; }
    raros.push(`0x${c.toString(16)} en ${i}`);
  }
  return { lineas, raros };
}
const puntosImpresos = (l) => l.texto.length * ((l.tam & 0x10) ? 2 : 1) * (12 + l.aire);

await t('EDGE', '14. abre con ESC @ + tabla WPC1252 y solo emite comandos propios', async () => {
  const f = formatoDeDocumento('comanda', DATOS, { ancho: 48 });
  const bytes = interpretarFormato(f, { ancho: 48 });
  assert.deepStrictEqual([...bytes.subarray(0, 5)], [0x1b, 0x40, 0x1b, 0x74, 16]);
  const { lineas, raros } = leerBytes(bytes);
  assert.deepStrictEqual(raros, []);
  const plat = lineas.find(l => l.texto === '1 CHILAQUILES SENCILLOS');
  assert.ok(plat && plat.tam === 0x11 && plat.negrita, 'el platillo no salió en letra doble y negritas');
  const mod = lineas.find(l => l.texto.includes('> Proteína: Pechuga de pollo'));
  assert.ok(mod && mod.tam === 0x01 && mod.negrita && mod.aire === 2);
});

await t('EDGE', '15. un texto con comandos o emojis no llega como comando a la impresora', async () => {
  const f = { v: 1, renglones: [{ texto: 'Ana \u001b@\u001dV0 “x” 🎂 — y', tam: 'alto' }, { corte: true }] };
  const { lineas, raros } = leerBytes(interpretarFormato(f, { ancho: 42 }));
  assert.deepStrictEqual(raros, []);
  assert.strictEqual(lineas[0].texto, 'Ana @V0 "x"  - y');
});

await t('EDGE', '16. si el servidor armó para 48 y la impresora es de 32, el Edge vuelve a envolver', async () => {
  const f = formatoDeDocumento('comanda', DATOS, { ancho: 48 });
  const { lineas } = leerBytes(interpretarFormato(f, { ancho: 32 }));
  for (const l of lineas) assert.ok(puntosImpresos(l) <= 32 * 12, `«${l.texto}» mide ${puntosImpresos(l)}`);
});

await t('EDGE', '17. después de cada renglón la impresora vuelve a normal (también para los renglones en blanco)', async () => {
  // Un renglón en blanco tras uno grande y en blanco sobre negro: sin volver
  // a normal, ese espacio sale en doble alto (más papel) y con el modo
  // invertido encendido.
  const f = { v: 1, renglones: [{ texto: 'GRANDE', tam: 'doble', negrita: true, invertido: true, subrayado: true, aire: 3, alinear: 'centro' },
    { espacio: 1 }, { texto: 'normal' }] };
  const { lineas } = leerBytes(interpretarFormato(f, { ancho: 42 }));
  const NORMAL = { tam: 0, negrita: false, invertido: false, subrayado: false, aire: 0, alinear: 0 };
  assert.deepStrictEqual(lineas[0], { texto: 'GRANDE', tam: 0x11, negrita: true, invertido: true, subrayado: true, aire: 3, alinear: 1 });
  assert.deepStrictEqual(lineas[1], { texto: '', ...NORMAL }, 'el renglón en blanco heredó el estilo del anterior');
  assert.deepStrictEqual(lineas[2], { texto: 'normal', ...NORMAL });
});

// ═══════════ F. Compatibilidad ═══════════
await t('COMPAT', '18. sin formato, o con uno raro o que truena, sale el diseño de siempre', async () => {
  const payload = { mesa: 7, items: [{ producto: 'Molletes', cantidad: 1, modificadores: [] }] };
  const siempre = renderComanda(payload, { ancho: 42 });
  const trueno = { v: 1, get renglones() { throw new Error('boom'); } };
  const casos = [undefined, null, { v: 2, renglones: [{ texto: 'x' }] }, { v: 1, renglones: 'x' }, { v: 1, renglones: [] },
    { v: 1, renglones: Array(1501).fill({ texto: 'x' }) }, trueno];
  for (const [i, formato] of casos.entries()) {
    assert.ok(renderizar('comanda', { ...payload, formato }, { ancho: 42 }).equals(siempre), `caso ${i} no cayó al diseño de siempre`);
  }
  assert.strictEqual(esFormatoValido({ v: 1, renglones: [{ texto: 'x' }] }), true);
});

await t('COMPAT', '19. el Edge instalado hoy (v1.1.0) ignora `formato`: mismo papel que sin él', async () => {
  const dir = join(tmpdir(), `xabor-edge-110-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  try {
    for (const f of ['index.js', 'escpos.js']) {
      writeFileSync(join(dir, f), execFileSync('git', ['show', `d2cb728:edge/renderers/${f}`], { cwd: join(__dirname, '..'), encoding: 'utf8' }));
    }
    const viejo = await import(pathToFileURL(join(dir, 'index.js')).href);
    const payload = { negocio: 'Mapolato', mesa: 7, items: FOTO };
    const sin = viejo.renderizar('comanda', payload, { ancho: 42 });
    const con = viejo.renderizar('comanda', { ...payload, formato: formatoDeDocumento('comanda', DATOS, { ancho: 42 }) }, { ancho: 42 });
    assert.ok(con.equals(sin), 'el Edge viejo cambió su papel por traer formato');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await t('COMPAT', '20. formatoDeDocumento nunca lanza: documento desconocido o datos rotos → null', async () => {
  assert.strictEqual(formatoDeDocumento('corte_caja', { x: 1 }), null);
  assert.strictEqual(formatoDeDocumento('comanda', null), null);
  assert.strictEqual(formatoDeDocumento('comanda', { get items() { throw new Error('x'); } }), null);
  const f = formatoDeDocumento('comanda', DATOS, { ancho: 'mucho' });
  assert.strictEqual(f.ancho, 42);
  assert.ok(JSON.stringify(f).length < 6000, `la comanda de la foto pesa ${JSON.stringify(f).length} bytes`);
});

// ═══════════ G. Con Postgres ═══════════
const SEED_PATH = join(__dirname, '.datos-prueba.json');
const url = process.env.DATABASE_URL || '';
if (!url || /railway|rlwy/.test(url) || !existsSync(SEED_PATH)) {
  console.log('\n(Parte G omitida: hace falta DATABASE_URL local y test/.datos-prueba.json)');
} else {
  const SEED = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  const { pool } = await import('../src/services/database.js');
  const S = await import('../src/services/impresionService.js');
  const { crearEdge } = await import('../src/services/edgeService.js');
  const nid = SEED.negocioA;
  const sufijo = randomUUID().slice(0, 8);
  const { rows: [suc] } = await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1, $2) RETURNING id`, [nid, `Formato ${sufijo}`]);
  const sid = suc.id;
  const eq = await crearEdge(nid, { nombre: `FORMATO-${sufijo}`, sucursalId: sid });
  const cocina = await S.crearImpresora(nid, { terminalId: eq.id, nombre: `COCINA-${sufijo}`, transporte: 'mock', anchoColumnas: 48 });
  const caja = await S.crearImpresora(nid, { terminalId: eq.id, nombre: `CAJA-${sufijo}`, transporte: 'mock', anchoColumnas: 32 });
  await S.crearRuta(nid, { impresoraId: cocina.id, ambito: 'documento', clave: 'comanda' });
  await S.crearRuta(nid, { impresoraId: caja.id, ambito: 'documento', clave: 'cuenta' });
  const previo = await pool.query(`SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'impresion_formato'`, [nid]);
  try {
    await t('DB', '21. el pedido sale con su formato, al ancho de SU impresora y con el diseño del negocio', async () => {
      await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, 'impresion_formato', $2)
        ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`, [nid, JSON.stringify({ comanda: { notaInvertida: true } })]);
      const folio = `XAB-${String(Date.now()).slice(-6)}`;
      const r = await S.crearTrabajosDePedido({ negocioId: nid, sucursalId: sid,
        pedido: { id: folio, negocioId: nid, canal: 'pos', modalidad: 'entrega a domicilio', cliente: { nombre: 'Manuel', telefono: '000' },
          items: [{ producto: `Molletes ${sufijo}`, cantidad: 1, modificadores: ['Pan: Blanco'], notas: 'Pan: Blanco · bien dorados' }] } });
      assert.strictEqual(r.creados.length, 1, r.avisos.join(' | '));
      const p = r.creados[0].payload;
      assert.strictEqual(p.formato?.v, 1, 'el trabajo no trae formato');
      assert.strictEqual(p.formato.ancho, 48, 'no usó el ancho de su impresora');
      assert.ok(p.formato.renglones.some(x => x.texto === 'DOMICILIO' || x.texto?.startsWith('DOMICILIO ·')), 'falta el tipo');
      assert.ok(p.formato.renglones.some(x => x.texto === 'Cliente: Manuel'));
      assert.strictEqual(p.formato.renglones.find(x => x.texto?.includes('NOTA: bien dorados'))?.invertido, true, 'no aplicó el diseño del negocio');
      assert.ok(Array.isArray(p.items) && p.items[0].producto && p.folio === folio, 'el payload de siempre debe seguir completo');
      assert.ok(!JSON.stringify(p.formato).includes('000'), 'el teléfono no va al papel');
    });

    await t('DB', '22. ticket con el encabezado del negocio y al ancho de la caja; un documento sin armador sale sin formato', async () => {
      const r = await S.crearTrabajosDeDocumento({ negocioId: nid, sucursalId: sid, documento: 'cuenta',
        origenTipo: 'prueba_formato', origenId: randomUUID(), payload: { items: [], total: 10 } });
      const f = r.creados[0].payload.formato;
      assert.strictEqual(f?.ancho, 32);
      assert.ok(f.renglones.some(x => x.texto?.includes('TOTAL')));
      await S.crearRuta(nid, { impresoraId: caja.id, ambito: 'documento', clave: 'corte_caja' });
      const c = await S.crearTrabajosDeDocumento({ negocioId: nid, sucursalId: sid, documento: 'corte_caja',
        origenTipo: 'prueba_formato', origenId: randomUUID(), payload: { total: 1 } });
      assert.strictEqual(c.creados[0].payload.formato, undefined);
    });

    await t('DB', '23. prueba de impresora con formato; la reimpresión lleva la marca una sola vez', async () => {
      const prueba = await S.crearTrabajoDePrueba(nid, cocina.id);
      assert.ok(prueba.payload.formato?.renglones.some(x => x.texto?.startsWith('Acentos:')));
      const re = await S.reimprimirTrabajo(nid, prueba.id);
      const marcas = re.payload.formato.renglones.filter(x => x.texto === '*** REIMPRESION ***');
      assert.strictEqual(marcas.length, 1);
      const re2 = await S.reimprimirTrabajo(nid, re.id);
      assert.strictEqual(re2.payload.formato.renglones.filter(x => x.texto === '*** REIMPRESION ***').length, 1);
    });
  } finally {
    if (previo.rows.length) await pool.query(`UPDATE configuracion SET valor = $2 WHERE negocio_id = $1 AND clave = 'impresion_formato'`, [nid, previo.rows[0].valor]);
    else await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'impresion_formato'`, [nid]);
    await pool.query(`DELETE FROM impresion_trabajos WHERE sucursal_id = $1`, [sid]).catch(() => {});
    await pool.query(`DELETE FROM sucursales WHERE id = $1`, [sid]).catch(() => {});
    await pool.end();
  }
}

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
