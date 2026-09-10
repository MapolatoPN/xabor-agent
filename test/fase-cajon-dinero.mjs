// EL CAJÓN DE DINERO.
//
// Hasta hoy no existía en el código: una búsqueda en todo el repo por
// "cajón"/"drawer"/"kick" solo devolvía el menú lateral del panel en móvil. La
// caja principal de un restaurante no podía abrir su cajón desde el sistema, y
// eso salió como bloqueante en la auditoría de paridad con Wansoft.
//
// El cajón no se conecta a la computadora sino a la impresora de tickets, por
// un RJ11 que parece cable de teléfono. Se abre cuando la impresora recibe el
// pulso `ESC p m t1 t2`, así que el pulso viaja DENTRO del ticket.
//
// Lo que protege esta suite, por orden de importancia:
//   1. Que un cajón NUNCA se abra desde una comanda de cocina.
//   2. Que los bytes sean exactamente los del estándar (no hay forma de
//      probarlo contra hardware desde aquí, así que se fija el contrato).
//   3. Que duraciones absurdas no lleguen a la impresora.
//
// Uso: node test/fase-cajon-dinero.mjs
import assert from 'assert';

const { abrirCajon, ABRIR_CAJON } = await import('../edge/renderers/escpos.js');
const { renderCuenta, renderComanda } = await import('../edge/renderers/index.js');

let pasadas = 0, fallidas = 0; const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
// ESC p ... = 0x1B 0x70
const PULSO = Buffer.from([0x1b, 0x70]);
const traePulso = (buf) => buf.indexOf(PULSO) !== -1;

const CUENTA = {
  negocio: 'Mapolato', mesa: 4, mesero: 'Ana', folio: 'RM-3F2A9B1C-0',
  items: [{ cantidad: 1, producto: 'Chilaquiles', precio_unitario: 195 }],
  subtotal: 195, total: 195, pagos: [{ metodo: 'efectivo', monto: 195 }],
};
const COMANDA = {
  mesa: 4, mesero: 'Ana', ronda: 1, tipoRonda: 'inicial',
  items: [{ cantidad: 1, producto: 'Chilaquiles', modificadores: [] }],
};

// ═══ A. La regla que no se puede romper ════════════════════════════════════
t('A1. una comanda de cocina JAMÁS abre el cajón', () => {
  const buf = renderComanda(COMANDA, { ancho: 42 });
  assert.ok(!traePulso(buf),
    'un pulso en la comanda abriría el cajón cada vez que entra un platillo');
});

t('A2. el ticket solo abre el cajón si se le pide explícitamente', () => {
  assert.ok(!traePulso(renderCuenta(CUENTA, { ancho: 42 })),
    'imprimir la cuenta para llevarla a la mesa no debe abrir la caja');
  assert.ok(traePulso(renderCuenta({ ...CUENTA, abrirCajon: true }, { ancho: 42 })),
    'con un cobro en efectivo en caja, sí');
});

t('A3. el pulso va al principio: el cajón abre mientras sale el papel', () => {
  const buf = renderCuenta({ ...CUENTA, abrirCajon: true }, { ancho: 42 });
  const posPulso = buf.indexOf(PULSO);
  const posTotal = buf.indexOf(Buffer.from('TOTAL', 'latin1'));
  assert.ok(posPulso >= 0 && posTotal > posPulso,
    'si el pulso fuera al final, la cajera esperaría el ticket completo');
});

// ═══ B. Los bytes exactos ══════════════════════════════════════════════════
t('B1. ESC p m t1 t2, con las duraciones en unidades de 2 ms', () => {
  // 50 ms encendido = 25 unidades; 250 ms apagado = 125 unidades.
  assert.deepStrictEqual([...abrirCajon()], [0x1b, 0x70, 0x00, 25, 125]);
  assert.deepStrictEqual([...ABRIR_CAJON], [0x1b, 0x70, 0x00, 25, 125]);
});

t('B2. el pin 5 es una alternativa real, no un capricho', () => {
  // Según cómo esté cableado ese cajón responde la patilla 2 o la 5. Si no
  // abre, probar el otro pin es lo PRIMERO que hay que hacer en sitio.
  assert.deepStrictEqual([...abrirCajon({ pin: 1 })], [0x1b, 0x70, 0x01, 25, 125]);
  assert.deepStrictEqual([...abrirCajon({ pin: 0 })], [0x1b, 0x70, 0x00, 25, 125]);
  assert.deepStrictEqual([...abrirCajon({ pin: 7 })], [0x1b, 0x70, 0x00, 25, 125], 'un pin raro cae al 2');
});

t('B3. duraciones a medida', () => {
  assert.deepStrictEqual([...abrirCajon({ msOn: 100, msOff: 100 })], [0x1b, 0x70, 0x00, 50, 50]);
});

// ═══ C. Nada absurdo llega a la impresora ══════════════════════════════════
t('C1. un pulso larguísimo se acota: el solenoide se calienta', () => {
  const b = abrirCajon({ msOn: 60000, msOff: 60000 });
  assert.strictEqual(b[3], 255, 'tope de 255 unidades (510 ms)');
  assert.strictEqual(b[4], 255);
});

t('C2. valores basura caen a los de fábrica en vez de mandar bytes inválidos', () => {
  for (const malo of [null, undefined, 'mucho', NaN, -5, 0]) {
    const b = abrirCajon({ msOn: malo, msOff: malo });
    assert.deepStrictEqual([...b], [0x1b, 0x70, 0x00, 25, 125], `falló con ${JSON.stringify(malo)}`);
  }
});

t('C3. el pulso mide siempre 5 bytes', () => {
  for (const opts of [{}, { pin: 1 }, { msOn: 2 }, { msOn: 99999 }, { msOff: 'x' }]) {
    assert.strictEqual(abrirCajon(opts).length, 5, JSON.stringify(opts));
  }
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
