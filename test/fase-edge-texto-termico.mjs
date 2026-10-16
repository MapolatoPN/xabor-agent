// Texto para la térmica — prueba rápida sin Postgres.
//
// El renderer del Edge escribe en latin1 byte a byte. Un carácter fuera de
// latin1 no se descarta: Node se queda con su byte bajo. La raya larga de
// «Orden 1 — Ana» (U+2014) llegaba a la impresora como 0x14 (DC4), las
// comillas tipográficas como 0x1C/0x1D (FS/GS, prefijos de comandos ESC/POS)
// y un emoji como dos bytes sueltos. El nombre de la persona lo teclea el
// mesero, así que cualquier cosa puede llegar ahí. Esta suite fija que todo
// lo que el renderer manda al papel sea latin1 imprimible o un comando que el
// propio renderer emitió.
import assert from 'assert';
import * as escpos from '../edge/renderers/escpos.js';
import { renderComanda, renderCuenta, renderCancelacion, renderPrueba } from '../edge/renderers/index.js';
import { tituloPersona } from '../edge/renderers/personas.js';

let ok = 0;
function t(nombre, fn) {
  try { fn(); console.log('  OK  ' + nombre); ok++; }
  catch (e) { console.error('FALLO ' + nombre + ': ' + e.message); process.exitCode = 1; }
}

// Recorre los bytes y salta SOLO los comandos que emite escpos.js. Lo demás
// tiene que ser un salto de línea o latin1 imprimible; si no, se devuelve con
// un poco de contexto para que el fallo diga dónde está.
function bytesFueraDeLugar(buf) {
  const malos = [];
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 0x1b) {
      const n = buf[i + 1];
      if (n === 0x40) { i += 1; continue; }                               // INIT
      if (n === 0x61 && buf[i + 2] <= 2) { i += 2; continue; }            // ALIGN
      if (n === 0x45 && buf[i + 2] <= 1) { i += 2; continue; }            // BOLD
    } else if (c === 0x1d) {
      const n = buf[i + 1];
      if (n === 0x21 && [0x00, 0x01, 0x11].includes(buf[i + 2])) { i += 2; continue; } // SIZE
      if (n === 0x56 && buf[i + 2] === 0x41) { i += 3; continue; }        // CUT
    } else if (c === 0x0a || (c >= 0x20 && c <= 0x7e) || c >= 0xa0) {
      continue;
    }
    const contexto = buf.subarray(Math.max(0, i - 12), i + 12).toString('latin1').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
    malos.push(`0x${c.toString(16).padStart(2, '0')} en «${contexto}»`);
  }
  return malos;
}

function limpio(buf) {
  const malos = bytesFueraDeLugar(buf);
  assert.deepStrictEqual(malos, [], 'bytes que no son texto imprimible ni comando del renderer');
}

// Las líneas de texto del papel, sin los comandos que las preceden.
const lineas = (buf) => buf.toString('latin1').split('\n')
  .map(l => l.replace(/\x1b[@]|\x1b[aE][\x00-\x02]|\x1d![\x00\x01\x11]|\x1dVA\x03/g, ''));

const comandaDosPersonas = (nombreAna = 'Ana') => ({
  negocio: 'Mapolato', mesa: 7, mesero: 'Karina', ronda: 1,
  items: [
    { cantidad: 1, producto: 'Chilaquiles', persona: { numero: 1, nombre: nombreAna } },
    { cantidad: 2, producto: 'Molletes', persona: { numero: 2, nombre: 'Beto' } },
  ],
});

t('1. la comanda por persona dice «ORDEN 1 - ANA» sin el byte 0x14', () => {
  for (const ancho of [32, 42]) {
    const b = renderComanda(comandaDosPersonas(), { ancho });
    assert.ok(!b.includes(0x14), `ancho ${ancho}: la raya larga llegó como DC4 (0x14)`);
    const s = b.toString('latin1');
    assert.ok(s.includes('ORDEN 1 - ANA'), `ancho ${ancho}: falta «ORDEN 1 - ANA»`);
    assert.ok(s.includes('ORDEN 2 - BETO'), `ancho ${ancho}: falta «ORDEN 2 - BETO»`);
    limpio(b);
  }
});

t('2. un emoji en el nombre de la persona no llega a la térmica', () => {
  const b = renderComanda(comandaDosPersonas('Ana 🎂'));
  assert.ok(b.toString('latin1').includes('ORDEN 1 - ANA'));
  limpio(b);
});

t('3. la etiqueta que el servidor pone en la nota se sigue quitando', () => {
  // Así la arma impresionService.js para los Edge con el renderer anterior.
  const persona = { numero: 1, nombre: 'Ana' };
  const b = renderComanda({
    negocio: 'Mapolato', mesa: 7,
    items: [{ cantidad: 1, producto: 'Chilaquiles', persona, persona_en_notas: true,
      notas: [tituloPersona(persona), 'Sin cebolla'].join(' · ') }],
  });
  const s = b.toString('latin1');
  assert.ok(s.includes('NOTA: Sin cebolla'), 'la nota perdió su texto');
  assert.ok(!s.includes('NOTA: Orden'), 'la etiqueta de persona se repitió en la nota');
  assert.strictEqual(s.match(/ORDEN 1/g).length, 1);
  limpio(b);
});

t('4. la cancelación imprime la persona y el motivo limpios', () => {
  const b = renderCancelacion({
    mesa: 7,
    items: [{ cantidad: 1, producto: 'Café – americano', persona: { numero: 1, nombre: 'Ana 😊' } }],
    motivo: 'Se equivocó de mesa — sin cargo',
  });
  const s = b.toString('latin1');
  // `bloque` junta los espacios dobles al envolver: «1  CAFÉ» sale «1 CAFÉ».
  assert.ok(s.includes('1 CAFÉ - AMERICANO'), 'el producto no salió con guion');
  assert.ok(s.includes('Orden 1 - Ana'), 'la persona no salió con guion');
  assert.ok(s.includes('MOTIVO: Se equivocó de mesa - sin cargo'), 'el motivo no salió con guion');
  limpio(b);
});

t('5. la cuenta y la precuenta salen limpias y alineadas', () => {
  const ancho = 42;
  const b = renderCuenta({
    precuenta: true, leyenda: 'ORDEN 1 — ANA - NO ES COMPROBANTE DE PAGO',
    negocio: 'Mapolato', mesa: 7, mesero: 'Karina 😊',
    items: [{ producto: 'Café – americano', cantidad: 1, precioUnitario: 45,
      modificadores: ['Leche: Deslactosada'], notas: 'Sin “azúcar”… bien caliente' }],
    subtotal: 45, descuento: 5, descuentoMotivo: 'Promo “2x1” 🎉', total: 40,
  }, { ancho });
  const s = b.toString('latin1');
  assert.ok(s.includes('ORDEN 1 - ANA - NO ES COMPROBANTE DE PAGO'));
  assert.ok(s.includes('Le atendió: Karina'));
  assert.ok(s.includes('NOTA: Sin "azúcar"... bien caliente'), 'comillas o puntos suspensivos sin convertir');
  const ls = lineas(b);
  const producto = ls.find(l => l.startsWith('1 Café - americano'));
  assert.ok(producto, 'falta la línea del producto con guion');
  assert.strictEqual(producto.length, ancho, 'la línea del producto perdió la alineación');
  const descuento = ls.find(l => l.startsWith('Descuento ('));
  assert.ok(descuento && descuento.startsWith('Descuento (Promo "2x1"'), 'el motivo del descuento no salió limpio');
  assert.strictEqual(descuento.length, ancho, 'la línea del descuento perdió la alineación');
  limpio(b);
});

t('6. la prueba de impresora tampoco deja pasar caracteres de control', () => {
  limpio(renderPrueba({ negocio: 'Mapolato — Obispado', impresora: 'Cocina “caliente”', terminal: 'PC caja 🖨️', transporte: 'windows_spooler' }));
});

t('7. textoTermico: rayas, comillas, puntos suspensivos, acentos y controles', () => {
  const { textoTermico } = escpos;
  assert.strictEqual(typeof textoTermico, 'function', 'escpos.js no exporta textoTermico');
  assert.strictEqual(textoTermico('Orden 1 — Ana'), 'Orden 1 - Ana');
  assert.strictEqual(textoTermico('a‒b–c—d―e'), 'a-b-c-d-e');
  assert.strictEqual(textoTermico('“Sin” ‘chile’ ‛x'), '"Sin" \'chile\' \'x');
  assert.strictEqual(textoTermico('Pollo…'), 'Pollo...');
  // Acentos descompuestos (teclados de iPhone/Mac): se recomponen, no se pierden.
  assert.strictEqual(textoTermico('Jose\u0301'), 'José');
  assert.strictEqual(Buffer.from(textoTermico('Jose\u0301'), 'latin1').at(-1), 0xe9);
  assert.strictEqual(textoTermico('Ñoño ¿sí? ¡ya! · 2×1 °C'), 'Ñoño ¿sí? ¡ya! · 2×1 °C');
  assert.strictEqual(textoTermico('a\tb\r\nc'), 'a b  c');
  assert.strictEqual(textoTermico('Ana 🎂'), 'Ana ');
  assert.strictEqual(textoTermico('\x1b@\x1dVA\x00x\x7f\x85'), '@VAx');
  assert.strictEqual(textoTermico(null), '');
  assert.strictEqual(textoTermico(undefined), '');
  assert.strictEqual(textoTermico(7), '7');
  // Barrido: ningún código de 0 a U+2FFF, ni un emoji, sobrevive fuera de latin1 imprimible.
  let todo = '';
  for (let cp = 0; cp <= 0x2fff; cp++) todo += String.fromCodePoint(cp);
  todo += '🎂😊🖨️👍🏽‍';
  assert.ok(/^[\x20-\x7e\xa0-\xff]*$/.test(textoTermico(todo)), 'quedó un carácter fuera de latin1 imprimible');
});

t('8. el texto se sanea ANTES de medirlo: ninguna línea se pasa del ancho', () => {
  for (const ancho of [21, 32, 42]) {
    const b = escpos.bloque('NOTA: ' + 'Pollo… “bien” '.repeat(12), ancho, '  ');
    for (const l of lineas(b).filter(Boolean)) {
      assert.ok(l.length <= ancho, `ancho ${ancho}: «${l}» mide ${l.length}`);
    }
    limpio(b);
  }
});

console.log(`\n${ok} casos OK`);
