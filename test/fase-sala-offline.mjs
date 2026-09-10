// SALA SIN INTERNET — el motor local del Edge.
//
// Lo que protege esta suite: que operar sin enlace produzca EXACTAMENTE el
// mismo resultado que operar con él. No una versión relajada "para la
// emergencia": si offline se permitiera algo que online rechaza, la
// sincronización tendría que deshacer trabajo ya cobrado, y eso no se le puede
// explicar a un cliente que ya pagó y se fue.
//
// Los invariantes son los de `src/services/restauranteService.js`:
//   · una sola cuenta abierta por mesa (índice único parcial en la nube)
//   · la comanda saca SOLO lo pendiente y nunca reimprime lo anterior
//   · no se cierra una cuenta con saldo
//   · el folio de venta se deriva del UUID de la cuenta
//
// Módulo puro: sin base de datos, sin red, con reloj y uuid inyectados.
//
// Uso: node test/fase-sala-offline.mjs
import assert from 'assert';

const { crearSalaLocal, folioDeVenta, ErrorSala } = await import('../edge/sala/operacionLocal.js');

let pasadas = 0, fallidas = 0; const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const lanza = (codigo, fn) => {
  try { fn(); }
  catch (e) {
    assert.ok(e instanceof ErrorSala, `esperaba ErrorSala y vino ${e.name}: ${e.message}`);
    assert.strictEqual(e.codigo, codigo, `esperaba ${codigo} y vino ${e.codigo}`);
    return e;
  }
  assert.fail(`no lanzó ${codigo}`);
};

// Reloj y uuid deterministas: dos corridas producen los mismos identificadores.
function sala() {
  let n = 0, ms = Date.UTC(2026, 8, 9, 20, 0, 0);
  return crearSalaLocal({
    uuid: () => {
      n += 1;
      const hex = n.toString(16).padStart(8, '0');
      return `${hex}-0000-4000-8000-000000000000`;
    },
    ahora: () => { ms += 1000; return new Date(ms); },
  });
}
const MESERO = 'mesero-uuid-1';
const abrir = (s, mesa = 1) => s.abrirMesa({ mesaNumero: mesa, personas: 2, meseroUsuarioId: MESERO, meseroNombre: 'Ana' });
const item = (producto, precio, cantidad = 1) => ({ producto, precio_unitario: precio, cantidad });

// ═══ A. Flujo completo de una mesa, de punta a punta ════════════════════════
t('A1. abrir, capturar, comandar, cobrar y cerrar — sin internet en ningún paso', () => {
  const s = sala();
  const c = abrir(s);
  assert.strictEqual(c.estado, 'abierta');
  assert.strictEqual(c.mesa, 1);

  s.agregarItems(c.id, [item('Chilaquiles', 195), item('Café', 45, 2)]);
  const cta = s.obtenerCuenta(c.id);
  assert.strictEqual(cta.total, 285, '195 + 45*2');
  assert.strictEqual(cta.saldo, 285);

  const comanda = s.enviarComanda(c.id);
  assert.strictEqual(comanda.comanda, 1);
  assert.strictEqual(comanda.tipo, 'inicial');
  assert.strictEqual(comanda.items.length, 2, 'la comanda lleva lo que va a cocina');

  s.registrarPago(c.id, { metodo: 'efectivo', monto: 285, propina: 30 });
  const cerrada = s.cerrarCuenta(c.id);
  assert.strictEqual(cerrada.ok, true);
  assert.strictEqual(cerrada.total, 285);
  assert.strictEqual(cerrada.propinas, 30);
  assert.match(cerrada.ventaFolio, /^RM-[0-9A-F]{8}-0$/, 'folio con la forma de la nube');
});

t('A2. el folio se deriva del UUID: el ticket impreso offline YA trae el definitivo', () => {
  // Réplica literal de restauranteService.js:379. Si algún día cambia allá y no
  // aquí, esta prueba lo detecta antes de que un ticket lleve un folio que la
  // nube después contradiga.
  const id = '3f2a9b1c-1111-4000-8000-000000000000';
  const esperado = `RM-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}-0`;
  assert.strictEqual(folioDeVenta(id, 0), esperado);
  assert.strictEqual(folioDeVenta(id, 0), 'RM-3F2A9B1C-0');
  assert.strictEqual(folioDeVenta(id, 2), 'RM-3F2A9B1C-2', 'un reverso genera folio nuevo');
});

t('A3. cerrar dos veces devuelve el MISMO folio, no crea otra venta', () => {
  const s = sala();
  const c = abrir(s);
  s.agregarItems(c.id, [item('Sopa', 100)]);
  s.registrarPago(c.id, { metodo: 'efectivo', monto: 100 });
  const uno = s.cerrarCuenta(c.id);
  const dos = s.cerrarCuenta(c.id);
  assert.strictEqual(dos.yaCerrada, true);
  assert.strictEqual(dos.ventaFolio, uno.ventaFolio, 'un doble clic no puede duplicar la venta');
});

// ═══ B. Los invariantes de la nube, sin base que los imponga ════════════════
t('B1. una mesa solo admite UNA cuenta abierta', () => {
  const s = sala();
  abrir(s, 5);
  lanza('MESA_OCUPADA', () => abrir(s, 5));
});

t('B2. cerrada la cuenta, la mesa vuelve a estar libre', () => {
  const s = sala();
  const c = abrir(s, 5);
  s.agregarItems(c.id, [item('Agua', 30)]);
  s.registrarPago(c.id, { metodo: 'efectivo', monto: 30 });
  s.cerrarCuenta(c.id);
  const nueva = abrir(s, 5);
  assert.notStrictEqual(nueva.id, c.id, 'es otra cuenta, con su propio folio');
});

t('B3. números de mesa y personas fuera de rango se rechazan', () => {
  const s = sala();
  lanza('MESA_INVALIDA', () => s.abrirMesa({ mesaNumero: 0, meseroUsuarioId: MESERO }));
  lanza('MESA_INVALIDA', () => s.abrirMesa({ mesaNumero: 501, meseroUsuarioId: MESERO }));
  lanza('PERSONAS_INVALIDAS', () => s.abrirMesa({ mesaNumero: 3, personas: 101, meseroUsuarioId: MESERO }));
  lanza('MESERO_INVALIDO', () => s.abrirMesa({ mesaNumero: 3, meseroUsuarioId: null }));
});

t('B4. no se cierra una cuenta con saldo', () => {
  const s = sala();
  const c = abrir(s);
  s.agregarItems(c.id, [item('Plato', 200)]);
  s.registrarPago(c.id, { metodo: 'efectivo', monto: 150 });
  const e = lanza('SALDO_PENDIENTE', () => s.cerrarCuenta(c.id));
  assert.match(e.message, /50\.00/, 'el mensaje dice cuánto falta');
});

t('B5. sobre una cuenta cerrada no se captura ni se cobra', () => {
  const s = sala();
  const c = abrir(s);
  s.agregarItems(c.id, [item('Plato', 100)]);
  s.registrarPago(c.id, { metodo: 'efectivo', monto: 100 });
  s.cerrarCuenta(c.id);
  lanza('CUENTA_NO_ABIERTA', () => s.agregarItems(c.id, [item('Otro', 50)]));
  lanza('CUENTA_NO_ABIERTA', () => s.registrarPago(c.id, { metodo: 'efectivo', monto: 10 }));
  lanza('CUENTA_NO_ABIERTA', () => s.enviarComanda(c.id));
});

t('B6. una cuenta inexistente no se inventa', () => {
  const s = sala();
  lanza('CUENTA_NO_ENCONTRADA', () => s.agregarItems('no-existe', [item('X', 10)]));
  assert.strictEqual(s.obtenerCuenta('no-existe'), null);
});

// ═══ C. Comandas: el contrato de impresión ══════════════════════════════════
t('C1. la segunda comanda lleva SOLO lo nuevo — nunca reimprime la primera', () => {
  const s = sala();
  const c = abrir(s);
  s.agregarItems(c.id, [item('Entrada', 80)]);
  const primera = s.enviarComanda(c.id);
  s.agregarItems(c.id, [item('Postre', 60)]);
  const segunda = s.enviarComanda(c.id);
  assert.strictEqual(segunda.comanda, 2);
  assert.strictEqual(segunda.tipo, 'adicional');
  assert.deepStrictEqual(segunda.items.map((i) => i.producto), ['Postre'],
    'si la segunda comanda repitiera la entrada, la cocina la haría dos veces');
  assert.deepStrictEqual(primera.items.map((i) => i.producto), ['Entrada']);
});

t('C2. doble envío sin nada pendiente falla, no emite comanda vacía', () => {
  const s = sala();
  const c = abrir(s);
  s.agregarItems(c.id, [item('Entrada', 80)]);
  s.enviarComanda(c.id);
  lanza('SIN_ITEMS_PENDIENTES', () => s.enviarComanda(c.id));
  assert.strictEqual(s.obtenerCuenta(c.id).comandasEmitidas, 1, 'el contador no avanza en falso');
});

t('C3. cancelar exige motivo, y lo cancelado deja de cobrarse', () => {
  const s = sala();
  const c = abrir(s);
  const [a, b] = s.agregarItems(c.id, [item('Plato', 100), item('Bebida', 40)]);
  lanza('MOTIVO_REQUERIDO', () => s.cancelarItem(c.id, b.id, { motivo: '  ' }));
  const cancelado = s.cancelarItem(c.id, b.id, { motivo: 'El cliente cambió de opinión' });
  assert.strictEqual(cancelado.yaEnviado, false);
  assert.strictEqual(s.obtenerCuenta(c.id).total, 100, 'el cancelado sale del total');
  lanza('ITEM_NO_CANCELABLE', () => s.cancelarItem(c.id, b.id, { motivo: 'otra vez' }));
  assert.ok(a.id);
});

t('C4. cancelar algo YA enviado se marca como tal (la cocina ya lo tiene)', () => {
  const s = sala();
  const c = abrir(s);
  const [a] = s.agregarItems(c.id, [item('Plato', 100)]);
  s.enviarComanda(c.id);
  const r = s.cancelarItem(c.id, a.id, { motivo: 'se tiró' });
  assert.strictEqual(r.yaEnviado, true, 'quien lo lea sabe que hay que avisar a cocina');
});

// ═══ D. Dinero: sin deriva de punto flotante ═══════════════════════════════
t('D1. precios con centavos cierran EXACTO (donde el flotante fallaría)', () => {
  const s = sala();
  const c = abrir(s);
  s.agregarItems(c.id, [item('A', 19.99), item('B', 0.1), item('C', 0.2)]);
  const cta = s.obtenerCuenta(c.id);
  assert.strictEqual(cta.total, 20.29, `0.1+0.2 en flotante da 0.30000000000000004; vino ${cta.total}`);
  s.registrarPago(c.id, { metodo: 'efectivo', monto: 20.29 });
  assert.strictEqual(s.obtenerCuenta(c.id).saldo, 0);
  assert.strictEqual(s.cerrarCuenta(c.id).ok, true, 'debe poder cerrar: el saldo es cero de verdad');
});

t('D2. pagos divididos suman hasta cerrar', () => {
  const s = sala();
  const c = abrir(s);
  s.agregarItems(c.id, [item('Mesa completa', 300)]);
  s.registrarPago(c.id, { metodo: 'efectivo', monto: 100, cubre: 'persona 1' });
  s.registrarPago(c.id, { metodo: 'terminal', monto: 100, cubre: 'persona 2' });
  lanza('SALDO_PENDIENTE', () => s.cerrarCuenta(c.id));
  const r = s.registrarPago(c.id, { metodo: 'transferencia', monto: 100, cubre: 'persona 3' });
  assert.strictEqual(r.saldo, 0);
  const cerrada = s.cerrarCuenta(c.id);
  assert.strictEqual(cerrada.pagos.length, 3, 'los tres pagos viajan a la venta');
});

t('D3. la propina NO reduce el saldo (igual que la nube)', () => {
  const s = sala();
  const c = abrir(s);
  s.agregarItems(c.id, [item('Plato', 100)]);
  s.registrarPago(c.id, { metodo: 'efectivo', monto: 100, propina: 50 });
  const cta = s.obtenerCuenta(c.id);
  assert.strictEqual(cta.saldo, 0);
  assert.strictEqual(cta.propinas, 50);
  assert.strictEqual(cta.total, 100, 'la propina no es consumo');
});

t('D4. montos y métodos inválidos se rechazan', () => {
  const s = sala();
  const c = abrir(s);
  s.agregarItems(c.id, [item('Plato', 100)]);
  lanza('METODO_INVALIDO', () => s.registrarPago(c.id, { metodo: 'bitcoin', monto: 10 }));
  lanza('MONTO_INVALIDO', () => s.registrarPago(c.id, { metodo: 'efectivo', monto: 0 }));
  lanza('MONTO_INVALIDO', () => s.registrarPago(c.id, { metodo: 'efectivo', monto: -5 }));
  lanza('PROPINA_INVALIDA', () => s.registrarPago(c.id, { metodo: 'efectivo', monto: 10, propina: -1 }));
  lanza('ITEM_INVALIDO', () => s.agregarItems(c.id, [item('X', -1)]));
  lanza('ITEM_INVALIDO', () => s.agregarItems(c.id, [{ producto: '', precio_unitario: 10 }]));
});

// ═══ E. La cola de sincronización ══════════════════════════════════════════
t('E1. cada mutación deja constancia, y el lote lleva el estado completo', () => {
  const s = sala();
  const c = abrir(s);
  s.agregarItems(c.id, [item('Plato', 100)]);
  s.enviarComanda(c.id);
  s.registrarPago(c.id, { metodo: 'efectivo', monto: 100 });
  s.cerrarCuenta(c.id);
  assert.strictEqual(s.pendientesDeSincronizar(), 5, 'abrir, agregar, comandar, pagar, cerrar');
  const lote = s.exportarLote();
  assert.deepStrictEqual(lote.eventos.map((e) => e.tipo),
    ['cuenta_abierta', 'items_agregados', 'comanda_enviada', 'pago_registrado', 'cuenta_cerrada']);
  assert.strictEqual(lote.cuentas.length, 1, 'y el estado final de la cuenta que tocaron');
  assert.strictEqual(lote.cuentas[0].venta_folio, s.obtenerCuenta(c.id).ventaFolio);
});

t('E2. exportar NO consume: solo se descarta lo que la nube confirmó', () => {
  const s = sala();
  const c = abrir(s);
  s.agregarItems(c.id, [item('Plato', 100)]);
  const lote = s.exportarLote();
  assert.strictEqual(s.pendientesDeSincronizar(), 2, 'un envío que se pierde no borra nada');
  const descartados = s.marcarLoteSincronizado([lote.eventos[0].id]);
  assert.strictEqual(descartados, 1);
  assert.strictEqual(s.pendientesDeSincronizar(), 1, 'lo no confirmado sigue en cola');
});

t('E3. reexportar el mismo lote da los MISMOS ids de evento (reintentar no duplica)', () => {
  const s = sala();
  const c = abrir(s);
  s.agregarItems(c.id, [item('Plato', 100)]);
  const a = s.exportarLote(), b = s.exportarLote();
  assert.deepStrictEqual(a.eventos.map((e) => e.id), b.eventos.map((e) => e.id));
});

t('E4. el estado sobrevive a un reinicio del Edge (corte de luz a media mesa)', () => {
  const s = sala();
  const c = abrir(s);
  s.agregarItems(c.id, [item('Plato', 100)]);
  const guardado = JSON.parse(JSON.stringify(s.serializar()));

  let n = 100;
  const revivido = crearSalaLocal({
    uuid: () => `${(n += 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    ahora: () => new Date(Date.UTC(2026, 8, 9, 21, 0, 0)),
    estadoInicial: guardado,
  });
  const cta = revivido.obtenerCuenta(c.id);
  assert.ok(cta, 'la mesa sigue abierta tras el reinicio');
  assert.strictEqual(cta.total, 100);
  assert.strictEqual(revivido.pendientesDeSincronizar(), 2, 'y lo pendiente de subir no se perdió');
  revivido.registrarPago(c.id, { metodo: 'efectivo', monto: 100 });
  assert.strictEqual(revivido.cerrarCuenta(c.id).ventaFolio, folioDeVenta(c.id, 0),
    'el folio depende del UUID de la cuenta, no de la sesión: sobrevive al reinicio');
});

t('E5. la mesa ocupada se ve en el tablero local mientras no haya enlace', () => {
  const s = sala();
  const a = abrir(s, 3), b = abrir(s, 1);
  s.agregarItems(a.id, [item('Plato', 100)]);
  const ocupadas = s.listarMesasOcupadas();
  assert.deepStrictEqual(ocupadas.map((m) => m.mesa), [1, 3], 'ordenadas por número de mesa');
  assert.strictEqual(ocupadas.find((m) => m.mesa === 3).total, 100);
  assert.ok(b.id);
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
