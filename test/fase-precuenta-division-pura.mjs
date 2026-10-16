// ─── Precuentas de la cuenta dividida: la aritmética y el papel ────────────
//
// Sin Postgres ni servidor. Lo que se protege:
//   · cada precuenta dice EXACTAMENTE lo que cobraría la caja con esa
//     selección (importeDePorcion), con o sin descuento y con fracciones;
//   · en el papel, subtotal - descuento = total al centavo, y la suma de los
//     renglones impresos es el subtotal;
//   · «una por persona» reparte todo lo pendiente: la suma de los papeles es
//     lo que debe la mesa, sin repetir ni olvidar un renglón;
//   · el renderer del Edge YA INSTALADO imprime la persona y la fracción con
//     los campos que conoce, y sin bytes de control que vengan de un nombre.
//
// Uso: node test/fase-precuenta-division-pura.mjs
import assert from 'assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { renderCuenta } from '../edge/renderers/index.js';
import {
  textoTermico, etiquetaPersona, seleccionDesdeCuerpo, precuentaDeSeleccion, gruposPorPersona,
} from '../src/services/precuentaDivision.js';
import {
  fraccion, sumar, restar, comparar, esCero, textoFraccion, aCentavos, aPesos, netosDeRenglones, importeDePorcion, UNO,
} from '../src/services/divisionConsumo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
let pasadas = 0, fallidas = 0;
function t(nombre, fn) {
  try { fn(); console.log('  OK  ' + nombre); pasadas++; }
  catch (e) { console.log('FALLO ' + nombre + ': ' + e.message); fallidas++; }
}

// Una división con la MISMA forma que devuelve estadoDivision: netos con el
// descuento prorrateado por mayores residuos y porciones ya cobradas.
function division(renglones, { descuentoCentavos = 0, motivo = null } = {}) {
  const netos = netosDeRenglones(renglones.map(r => ({ id: r.id, brutoCentavos: aCentavos(r.cantidad * r.precio) })), descuentoCentavos);
  const porId = new Map(netos.map(n => [n.id, n]));
  const lista = renglones.map(r => {
    const n = porId.get(r.id);
    let cobrada = fraccion(0, 1), cobradoCentavos = 0;
    for (const f of r.cobradas || []) {
      // Cada porción previa se cobró con la misma regla que el servidor.
      const pendiente = restar(UNO, cobrada);
      cobradoCentavos += importeDePorcion({ netoCentavos: n.netoCentavos, cobradoCentavos, pendiente, fraccion: f });
      cobrada = sumar(cobrada, f);
    }
    const pendiente = restar(UNO, cobrada);
    return {
      id: r.id, producto: r.producto, cantidad: r.cantidad, precioUnitario: r.precio, modificadores: r.modificadores || [], notas: r.notas || null,
      persona: r.persona || null,
      brutoCentavos: n.brutoCentavos, netoCentavos: n.netoCentavos, cobradoCentavos,
      pendienteCentavos: n.netoCentavos - cobradoCentavos,
      fraccionCobrada: textoFraccion(cobrada), fraccionPendiente: textoFraccion(pendiente),
      pendienteNum: pendiente.num, pendienteDen: pendiente.den,
      estado: esCero(cobrada) ? 'pendiente' : (esCero(pendiente) ? 'pagado' : 'parcial'),
    };
  });
  const total = aPesos(lista.reduce((s, r) => s + r.netoCentavos, 0));
  const saldo = aPesos(lista.reduce((s, r) => s + r.pendienteCentavos, 0));
  return { renglones: lista, descuento: descuentoCentavos ? { monto: aPesos(descuentoCentavos), motivo } : null, total, saldo };
}
const CUENTA = { mesa: 12, personas: 8, mesero: { nombre: 'Karina' } };
const centavos = (pesos) => Math.round(pesos * 100);
// Lo que cobraría la caja con esa selección: la misma cuenta que hace
// cobrarConsumo, renglón por renglón.
function importeDeCobro(div, pedidas) {
  let s = 0;
  for (const r of div.renglones) {
    if (!pedidas.has(r.id)) continue;
    s += importeDePorcion({ netoCentavos: r.netoCentavos, cobradoCentavos: r.cobradoCentavos, pendiente: fraccion(r.pendienteNum, r.pendienteDen), fraccion: pedidas.get(r.id) });
  }
  return s;
}
// La suma de lo que el papel imprime renglón por renglón (el renderer hace
// cantidad × precioUnitario de cada uno).
const sumaImpresa = (p) => p.items.reduce((s, i) => s + Math.round(i.cantidad * i.precioUnitario * 100), 0);
function cuadra(p, esperadoCentavos) {
  assert.strictEqual(centavos(p.total), esperadoCentavos, `total ${p.total} ≠ cobro ${aPesos(esperadoCentavos)}`);
  assert.strictEqual(centavos(p.subtotal) - centavos(p.descuento), centavos(p.total), 'subtotal - descuento ≠ total');
  assert.ok(p.descuento >= 0, `descuento negativo: ${p.descuento}`);
  assert.strictEqual(sumaImpresa(p), centavos(p.subtotal), 'los renglones impresos no suman el subtotal');
}

t('1. el texto para la térmica cambia la raya por guion, quita lo que no es latin1 y respeta acentos', () => {
  assert.strictEqual(textoTermico('Ana — mesa ☕ 3'), 'Ana - mesa 3');
  assert.strictEqual(textoTermico('Peña Ñoño'), 'Peña Ñoño');
  assert.strictEqual(textoTermico('x'.repeat(90), 48).length, 48);
  assert.strictEqual(etiquetaPersona({ numero: 3, nombre: 'Luis — 😀' }), 'Orden 3 - Luis -');
  assert.strictEqual(etiquetaPersona({ numero: 4, nombre: '' }), 'Orden 4');
  assert.strictEqual(etiquetaPersona(null), 'Sin asignar');
});

t('2. selección de renglones completos sin descuento: el papel dice lo que cobra la caja', () => {
  const d = division([
    { id: 'a', producto: 'Protein Pancakes', cantidad: 1, precio: 169 },
    { id: 'b', producto: 'Refresco', cantidad: 4, precio: 39 },
    { id: 'c', producto: 'Café Americano', cantidad: 1, precio: 39 },
  ]);
  const pedidas = seleccionDesdeCuerpo(d, [{ itemId: 'a', numerador: 1, denominador: 1 }, { itemId: 'b', cantidad: 2 }]);
  const p = precuentaDeSeleccion(d, pedidas, { cuenta: CUENTA, negocio: 'Mapolato' });
  cuadra(p, importeDeCobro(d, pedidas));
  assert.strictEqual(p.total, 247);
  assert.deepStrictEqual(p.items.map(i => [i.cantidad, i.producto, i.precioUnitario]), [[1, 'Protein Pancakes', 169], [2, 'Refresco', 39]]);
  assert.strictEqual(p.precuenta, true);
  assert.strictEqual(p.leyenda, 'CUENTA DIVIDIDA - NO ES COMPROBANTE DE PAGO');
  assert.deepStrictEqual([p.pagado, p.propina, p.pagos.length, p.mesa, p.mesero], [0, 0, 0, 12, 'Karina']);
});

t('3. media orden compartida: un renglón con su importe y la fracción como modificador; las dos mitades suman el platillo', () => {
  const d = division([{ id: 'a', producto: 'Chilaquiles', cantidad: 1, precio: 225.05, modificadores: ['Salsa: Verde'] }]);
  const mitad = seleccionDesdeCuerpo(d, [{ itemId: 'a', numerador: 1, denominador: 2 }]);
  const p1 = precuentaDeSeleccion(d, mitad, { cuenta: CUENTA });
  cuadra(p1, importeDeCobro(d, mitad));
  assert.deepStrictEqual(p1.items[0].modificadores, ['Compartido: 1/2', 'Salsa: Verde']);
  assert.strictEqual(p1.items[0].cantidad, 1);
  // La otra mitad, después de cobrada la primera: se lleva lo que falta.
  const d2 = division([{ id: 'a', producto: 'Chilaquiles', cantidad: 1, precio: 225.05, cobradas: [fraccion(1, 2)] }]);
  const resto = seleccionDesdeCuerpo(d2, 'resto');
  const p2 = precuentaDeSeleccion(d2, resto, { cuenta: CUENTA });
  cuadra(p2, importeDeCobro(d2, resto));
  assert.strictEqual(centavos(p1.total) + centavos(p2.total), 22505, 'las dos mitades no suman el platillo');
});

t('4. con descuento prorrateado y cualquier selección: total = cobro, subtotal - descuento = total, nada negativo (2 000 casos)', () => {
  let semilla = 7;
  const azar = (n) => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla % n; };
  const fracciones = [[1, 2], [1, 3], [2, 3], [1, 4], [3, 4], [1, 1]];
  for (let caso = 0; caso < 2000; caso++) {
    const renglones = Array.from({ length: 1 + azar(6) }, (_, i) => {
      const cantidad = 1 + azar(4);
      const previas = azar(3) === 0 ? [fraccion(1, 4 * cantidad)] : [];
      return { id: `r${i}`, producto: `P${i}`, cantidad, precio: (1 + azar(30000)) / 100, cobradas: previas };
    });
    const bruto = renglones.reduce((s, r) => s + aCentavos(r.cantidad * r.precio), 0);
    const d = division(renglones, { descuentoCentavos: azar(3) === 0 ? 0 : azar(bruto + 1), motivo: 'Cortesía' });
    const seleccion = [];
    for (const r of d.renglones) {
      if (azar(2) === 0) continue;
      const pend = fraccion(r.pendienteNum, r.pendienteDen);
      if (esCero(pend)) continue;
      const [a, b] = fracciones[azar(fracciones.length)];
      const f = comparar(fraccion(a, b), pend) <= 0 ? fraccion(a, b) : pend;
      seleccion.push({ itemId: r.id, numerador: f.num, denominador: f.den });
    }
    if (!seleccion.length) continue;
    const pedidas = seleccionDesdeCuerpo(d, seleccion);
    const p = precuentaDeSeleccion(d, pedidas, { cuenta: CUENTA });
    try { cuadra(p, importeDeCobro(d, pedidas)); }
    catch (e) { throw new Error(`caso ${caso}: ${e.message} · ${JSON.stringify({ seleccion, renglones })}`); }
  }
});

t('5. la porción que completa unidades enteras tras dos cuartos sueltos no imprime un descuento negativo', () => {
  // 2 × $0.03: dos cuartos cobrados (floor) dejan 1 unidad que vale 4 centavos con precio de lista 3.
  const d = division([{ id: 'a', producto: 'Galleta', cantidad: 2, precio: 0.03, cobradas: [fraccion(1, 4), fraccion(1, 4)] }]);
  const pedidas = seleccionDesdeCuerpo(d, 'resto');
  const p = precuentaDeSeleccion(d, pedidas, { cuenta: CUENTA });
  cuadra(p, importeDeCobro(d, pedidas));
  assert.strictEqual(centavos(p.total), 4);
});

t('6. una por persona: orden por número, «Sin asignar» al final, lo pagado no sale y la suma es el saldo de la mesa', () => {
  const d = division([
    { id: 'a', producto: 'Hamburguesa', cantidad: 1, precio: 180, persona: { numero: 2, nombre: '' } },
    { id: 'b', producto: 'Ensalada', cantidad: 1, precio: 150, persona: { numero: 1, nombre: 'Ana' } },
    { id: 'c', producto: 'Refresco', cantidad: 2, precio: 39, persona: { numero: 2, nombre: 'Luis' } },
    { id: 'd', producto: 'Nachos', cantidad: 1, precio: 120 },
    { id: 'e', producto: 'Café', cantidad: 1, precio: 39, persona: { numero: 3, nombre: '' }, cobradas: [fraccion(1, 1)] },
    { id: 'f', producto: 'Pastel', cantidad: 1, precio: 95, persona: { numero: 1, nombre: 'Ana' }, cobradas: [fraccion(1, 2)] },
  ], { descuentoCentavos: 5333, motivo: 'Cumpleaños' });
  const grupos = gruposPorPersona(d);
  assert.deepStrictEqual(grupos.map(g => etiquetaPersona(g.persona)), ['Orden 1 - Ana', 'Orden 2 - Luis', 'Sin asignar']);
  assert.deepStrictEqual(grupos.map(g => [...g.pedidas.keys()]), [['b', 'f'], ['a', 'c'], ['d']]);
  const papeles = grupos.map(g => precuentaDeSeleccion(d, g.pedidas, { cuenta: CUENTA, etiqueta: etiquetaPersona(g.persona) }));
  papeles.forEach((p, i) => cuadra(p, importeDeCobro(d, grupos[i].pedidas)));
  assert.strictEqual(papeles.reduce((s, p) => s + centavos(p.total), 0), centavos(d.saldo), 'los papeles no suman lo que debe la mesa');
  assert.strictEqual(papeles[0].leyenda, 'ORDEN 1 - ANA - NO ES COMPROBANTE DE PAGO');
  assert.strictEqual(papeles[0].descuentoMotivo, 'Cumpleaños');
});

t('7. la selección se valida como el cobro: producto ajeno, más de lo pendiente, vacía o cantidad imposible', () => {
  const d = division([{ id: 'a', producto: 'Sopa', cantidad: 2, precio: 60, cobradas: [fraccion(1, 2)] }]);
  const codigo = (fn) => { try { fn(); return 'sin error'; } catch (e) { return e.code; } };
  assert.strictEqual(codigo(() => seleccionDesdeCuerpo(d, [{ itemId: 'zzz', numerador: 1, denominador: 1 }])), 'ITEM_INVALIDO');
  assert.strictEqual(codigo(() => seleccionDesdeCuerpo(d, [{ itemId: 'a', numerador: 1, denominador: 1 }])), 'CONSUMO_YA_PAGADO');
  assert.strictEqual(codigo(() => seleccionDesdeCuerpo(d, [{ itemId: 'a', numerador: 1, denominador: 4 }, { itemId: 'a', numerador: 1, denominador: 3 }])), 'CONSUMO_YA_PAGADO');
  assert.strictEqual(codigo(() => seleccionDesdeCuerpo(d, [])), 'SELECCION_VACIA');
  assert.strictEqual(codigo(() => seleccionDesdeCuerpo(d, [{ itemId: 'a', cantidad: 3 }])), 'FRACCION_INVALIDA');
  assert.strictEqual(codigo(() => seleccionDesdeCuerpo(d, [{ itemId: 'a', numerador: 1, denominador: 0 }])), 'FRACCION_INVALIDA');
  const resto = seleccionDesdeCuerpo(d, 'resto');
  assert.strictEqual(textoFraccion(resto.get('a')), '1/2');
});

t('8. el Edge instalado imprime persona, fracción y total; un nombre con raya no mete bytes de control', () => {
  const d = division([
    { id: 'a', producto: 'Chilaquiles', cantidad: 1, precio: 225, persona: { numero: 2, nombre: 'Ana — Pérez' } },
    { id: 'b', producto: 'Pizza', cantidad: 1, precio: 300, persona: { numero: 2, nombre: 'Ana — Pérez' } },
  ]);
  const g = gruposPorPersona(d)[0];
  g.pedidas.set('b', fraccion(1, 3));
  const p = precuentaDeSeleccion(d, g.pedidas, { cuenta: CUENTA, negocio: 'Mapolato', etiqueta: etiquetaPersona(g.persona) });
  const s = renderCuenta({ ...p, documento: 'cuenta' }).toString('latin1');
  assert.ok(s.includes('PRECUENTA'));
  assert.ok(s.includes('ORDEN 2 - ANA - PÉREZ - NO ES COMPROBANTE DE PAGO'), 'la leyenda con la persona');
  assert.ok(s.includes('Compartido: 1/3'), 'la fracción compartida');
  assert.ok(s.includes('$325.00'), 'el total de la persona');
  assert.ok(!s.includes('Pagado'), 'sin renglón de Pagado');
  // La leyenda llega tal cual: la raya del nombre ya es un guion, no 0x14.
  assert.ok(!s.includes('ANA \x14'), 'la raya llegó al papel como byte de control');
});

// ─── Lo que tiene que seguir así en el servidor y en la pantalla ───────────
const server = readFileSync(join(root, 'src/server.js'), 'utf8');
const mesas = readFileSync(join(root, 'panel/mesas.html'), 'utf8');

t('9. el endpoint solo imprime: documento cuenta, sin cobrar, cerrar ni tocar cocina', () => {
  const ini = server.indexOf("app.post('/api/restaurante/cuentas/:cuentaId/precuenta-division'");
  const fin = server.indexOf('\napp.', ini + 10);
  assert.ok(ini >= 0 && fin > ini, 'no existe el endpoint');
  const bloque = server.slice(ini, fin);
  assert.ok(bloque.includes('requireOperacionRestaurante') && bloque.includes("requireModulo('restaurante')"));
  assert.ok(bloque.includes("documento: 'cuenta'"));
  assert.ok(bloque.includes("origenTipo: 'restaurante_precuenta_division'"));
  for (const prohibido of ['cobrarConsumo(', 'cobrarParteIgual(', 'registrarPago(', 'cerrarCuenta(', "documento: 'comanda'", 'crearTrabajosDeComanda(']) {
    assert.ok(!bloque.includes(prohibido), `el endpoint llama ${prohibido}`);
  }
  assert.ok(bloque.includes("destino: 'navegador'") && bloque.includes("destino: 'edge'"));
});

t('10. la pantalla ofrece los dos botones y cada función nueva se declara una sola vez', () => {
  assert.ok(mesas.includes('Imprimir selección') && mesas.includes('Imprimir una por persona'));
  assert.ok(mesas.includes('/precuenta-division'));
  for (const nombre of ['dvImprimirSeleccion', 'dvImprimirPorPersona', 'imprimirPrecuentasDivision', 'imprimirPrecuentasEnNavegador', 'htmlPrecuenta', 'nuevaSolicitudId']) {
    const n = (mesas.match(new RegExp(`function ${nombre}\\b`, 'g')) || []).length;
    assert.strictEqual(n, 1, `${nombre} declarada ${n} veces`);
  }
  // Varias precuentas van en UN diálogo, una por hoja, y la página mide la hoja más larga.
  assert.ok(mesas.includes("querySelectorAll('.hoja')"));
  assert.ok(/\.hoja\{[^}]*break-after:page/.test(mesas));
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
process.exitCode = fallidas ? 1 : 0;
