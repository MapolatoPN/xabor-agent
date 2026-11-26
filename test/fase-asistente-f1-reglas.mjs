// ASISTENTE DEL RESTAURANTE, Fase 1: las reglas y la elección (sin base).
//
// Con ventas INVENTADAS (nada de una sucursal real) se comprueba lo que pidió
// el dueño en 5.4:
//   · salen los hallazgos que los datos justifican y no otros;
//   · cada uno trae una acción y un número a revisar con su fecha;
//   · nunca lenguaje de causa y efecto, nunca teléfonos ni correos;
//   · mínimo de tickets (100 por producto) antes de comparar;
//   · los pedidos grandes no cuentan en las comparaciones y salen aparte;
//   · los semanales solo el lunes;
//   · máximo 3 al día: primero control y calidad (decisión del dueño del
//     26-nov), luego por pesos en juego; sin repetir en 7 días salvo que
//     empeore, «No avisar de esto» y «No útil».
import assert from 'assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  buscarHallazgos, faltasDeHallazgo, sumarDias, periodosDe, umbralPedidoGrande, fueraDeHorario,
  TIPOS_HALLAZGO, TIPOS_SEMANALES, TIPOS_INFORMATIVOS, TIPOS_CONTROL, FRASES_CAUSALES,
} from '../src/asistenteRestaurante/reglas.js';
import { priorizar, MAXIMO_AL_DIA, factorPorNoUtil } from '../src/asistenteRestaurante/priorizar.js';
import { normalizarVenta } from '../src/asistenteRestaurante/datos.js';
import { DIAS_PARA_REVISAR } from '../src/services/reporteConsejeroV2.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raiz = (r) => join(__dirname, '..', r);

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  if (process.env.CASOS && !new RegExp(process.env.CASOS).test(nombre)) return;
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const LUNES = '2026-11-23';
const MARTES = '2026-11-24';
const HORARIO = { horarios: Object.fromEntries(['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']
  .map((d) => [d, { abierto: true, apertura: '08:00', cierre: '22:00' }])) };

// Una sucursal inventada: 120 días con `porDia` ventas. El chilaquil (p1) se
// vende la mitad en las últimas 4 semanas; hay descuentos altos en la última
// semana, 3 ventas sin forma de pago, 1 fuera de horario, 1 pedido grande de
// $9,000 y un cliente frecuente que dejó de pedir.
function sucursal({ hoy = LUNES, porDia = 40, conGrande = true, sinGrandeEnTickets = false } = {}) {
  const ayer = sumarDias(hoy, -1);
  const { P, A } = periodosDe(ayer);
  let n = 0;
  const ventas = [];
  const tickets = { actual: [], anterior: [] };
  const franjaDe = (h) => (h < 12 ? 'manana' : h < 17 ? 'tarde' : 'noche');
  for (let d = 119; d >= 0; d--) {
    const fecha = sumarDias(ayer, -d);
    const dow = new Date(`${fecha}T12:00:00Z`).getUTCDay();
    for (let k = 0; k < porDia; k++) {
      n++;
      const hora = 8 + (k % 12);
      const utc = new Date(Date.parse(`${fecha}T${String(hora).padStart(2, '0')}:10:00-06:00`)).toISOString();
      const enP = fecha >= P.desde, enA = fecha >= A.desde && fecha <= A.hasta;
      const conP1 = enP ? k % 4 === 0 : k % 2 === 0;
      const grande = conGrande && k === 39 && d === 2;
      const neta = grande ? 9000 : 300 + (k % 5) * 40;
      const cliente = k === 0 && fecha < sumarDias(ayer, -30) ? 'c-frecuente' : (k === 1 ? `c-nuevo-${fecha}` : null);
      ventas.push({
        folio: `XAB-${n}`, clase: 'venta',
        instante: k === 7 && d === 1 ? new Date(Date.parse(`${fecha}T23:40:00-06:00`)).toISOString() : utc,
        fecha, hora: `${hora}:10`, neta,
        canal: k % 3 === 0 ? 'whatsapp' : 'mostrador', canal_etiqueta: k % 3 === 0 ? 'WhatsApp' : 'Mostrador',
        forma_pago: k === 5 && d < 3 ? null : 'efectivo', n_items: 2,
        items: [{ nombre: conP1 ? 'Chilaquiles' : 'Enchiladas' }, { nombre: 'Café' }],
        cortesia: false, cortesia_monto: 0,
        descuento: d < 7 && k < 8 ? 120 : (k === 0 ? 20 : 0), descuento_motivo: 'cliente frecuente', descuento_autorizo: 'Ana',
        cancelacion_motivo: null, cancelacion_autorizo: null,
        cliente_id: cliente, cliente_nombre: cliente === 'c-frecuente' ? 'MARÍA PÉREZ' : (cliente ? 'Cliente nuevo' : null),
        cliente_primera: cliente === 'c-frecuente' ? sumarDias(ayer, -119) : (cliente ? fecha : null), nombre_en_venta: null,
      });
      if (grande && sinGrandeEnTickets) continue;
      const tk = { negocio: 'n1', modalidad: 'recoger', neta: neta * 100, fecha, fecha_venta: fecha, dia: dow, franja: franjaDe(hora), desglose: true,
        lineas: [[conP1 ? 'p1' : 'p2', 'c1', 1, (neta - 60) * 100], ['p3', 'c2', 1, 6000]] };
      if (enP) tickets.actual.push(tk); else if (enA) tickets.anterior.push(tk);
    }
  }
  if (conGrande && sinGrandeEnTickets) {
    // El pedido grande tampoco existe como venta: lo que debe quedar igual.
    const i = ventas.findIndex((v) => v.neta === 9000);
    ventas.splice(i, 1);
  }
  return {
    negocio: { id: 'n1', nombre: 'Sucursal de prueba' }, tz: 'America/Matamoros', hoy, ayer, ventas, eventosMesa: [],
    productos: { ...tickets, nombres: { productos: { p1: 'Chilaquiles', p2: 'Enchiladas', p3: 'Café' }, categorias: { c1: 'Desayunos', c2: 'Bebidas' } } },
    menu90: { tickets: porDia * 90, sinMovimiento: [{ nombre: 'Pozole', categoria: 'Caldos', unidades: 2 }] },
    reglasAtencion: HORARIO,
  };
}
const tipos = (hs) => hs.map((h) => h.tipo).sort();

// ═══ Reglas ════════════════════════════════════════════════════════════════
const base = buscarHallazgos(sucursal());

await t('R1. con los datos inventados salen exactamente los hallazgos que se justifican', () => {
  assert.deepStrictEqual(tipos(base.hallazgos), ['clientes_dejaron', 'descuentos_altos', 'pedidos_grandes', 'poca_venta',
    'producto_baja', 'producto_sube', 'ventas_fuera_horario', 'ventas_sin_forma_pago']);
  const baja = base.hallazgos.find((h) => h.tipo === 'producto_baja');
  assert.match(baja.titulo, /^«Chilaquiles» vendió 50 % menos que las 4 semanas anteriores/);
  const sinPago = base.hallazgos.find((h) => h.tipo === 'ventas_sin_forma_pago');
  assert.strictEqual(sinPago.detalle.tabla.filas.length, 3);
  assert.ok(base.hallazgos.every((h) => TIPOS_HALLAZGO.includes(h.tipo)));
});

await t('R1b. «sin forma de pago» no cuenta Rappi (la cobra la plataforma) ni cortesías', () => {
  const s = sucursal();
  const molde = s.ventas.find((v) => v.fecha === s.ayer);
  s.ventas.push({ ...molde, folio: 'XAB-R1', canal: 'rappi', canal_etiqueta: 'Rappi', forma_pago: null, neta: 410 });
  s.ventas.push({ ...molde, folio: 'XAB-C1', forma_pago: null, cortesia: true, cortesia_monto: 150, neta: 0 });
  const sinPago = buscarHallazgos(s).hallazgos.find((h) => h.tipo === 'ventas_sin_forma_pago');
  assert.strictEqual(sinPago.detalle.tabla.filas.length, 3, 'contó la de Rappi o la cortesía');
  assert.ok(!sinPago.detalle.tabla.filas.some((f) => f[0] === 'XAB-R1' || f[0] === 'XAB-C1'));
});

await t('R2. cada hallazgo trae acción y número a revisar con fecha; sin causa y efecto ni datos personales', () => {
  for (const h of base.hallazgos) {
    assert.deepStrictEqual(faltasDeHallazgo(h), [], `${h.tipo}: ${faltasDeHallazgo(h).join('; ')}`);
    assert.ok(h.sugerencia.trim().length > 10, `${h.tipo} sin acción`);
    assert.strictEqual(h.revisar.el, sumarDias(LUNES, DIAS_PARA_REVISAR), `${h.tipo}: fecha a revisar`);
    assert.ok(Number(h.impacto) >= 0);
  }
  const todo = JSON.stringify(base.hallazgos);
  assert.ok(!FRASES_CAUSALES.test(todo), 'hay lenguaje causal en algún texto');
  assert.ok(!/@/.test(todo), 'hay una @ (correo)');
});

await t('R2b. los textos concuerdan en número: un solo cliente se nombra en singular', () => {
  // La sucursal inventada trae exactamente un cliente frecuente que dejó de venir.
  const c1 = base.hallazgos.find((h) => h.tipo === 'clientes_dejaron');
  assert.strictEqual(c1.detalle.numeros.find((x) => x.etiqueta === 'Clientes').valor, 1);
  assert.match(c1.titulo, /^1 cliente frecuente lleva/);
  assert.strictEqual(c1.sugerencia, 'Escríbele o mándale una promoción para que vuelva.');
  assert.strictEqual(c1.revisar.numero, 'Pedidos nuevos de este cliente');
  // Con un segundo cliente igual, todo pasa a plural.
  const s = sucursal();
  for (const v of s.ventas.filter((x) => x.cliente_id === 'c-frecuente')) s.ventas.push({ ...v, folio: `${v.folio}-B`, cliente_id: 'c-frecuente-2' });
  const c2 = buscarHallazgos(s).hallazgos.find((h) => h.tipo === 'clientes_dejaron');
  assert.strictEqual(c2.detalle.numeros.find((x) => x.etiqueta === 'Clientes').valor, 2);
  assert.match(c2.titulo, /^2 clientes frecuentes llevan/);
  assert.strictEqual(c2.sugerencia, 'Escríbeles o mándales una promoción para que vuelvan.');
  assert.match(c2.revisar.numero, /estos 2 clientes/);
  // Una franja que vende la mitad: «La franja … vendió», no «vendieron».
  const f = sucursal();
  for (const tk of f.productos.actual) if (tk.franja === 'noche') tk.neta = Math.round(tk.neta / 2);
  const floja = buscarHallazgos(f).hallazgos.find((h) => h.tipo === 'franja_floja');
  assert.ok(floja, 'no salió la franja floja');
  assert.match(floja.titulo, /^La franja de .+ vendió \d+ % menos por día abierto/);
});

await t('R3. menos de 100 tickets: el producto no se compara', () => {
  // 6 ventas al día: el chilaquil queda en ~42 tickets en 4 semanas.
  const poco = buscarHallazgos(sucursal({ porDia: 6, conGrande: false }));
  assert.ok(!poco.hallazgos.some((h) => h.tipo === 'producto_baja'), 'comparó un producto con menos de 100 tickets');
});

await t('R4. los pedidos grandes (> 4× la mediana, piso $1,000) se reportan aparte y no mueven las comparaciones', () => {
  assert.strictEqual(base.umbralGrande, 1520, '4 × mediana de $380');
  const g = base.hallazgos.find((h) => h.tipo === 'pedidos_grandes');
  assert.match(g.titulo, /1 pedido grande en la semana, por \$9,000/);
  // Sin el pedido grande, la comparación de productos da lo mismo.
  const sin = buscarHallazgos(sucursal({ sinGrandeEnTickets: true }));
  const imp = (r, tipo) => r.hallazgos.find((h) => h.tipo === tipo)?.impacto;
  assert.strictEqual(imp(sin, 'producto_baja'), imp(base, 'producto_baja'), 'el pedido grande cambió la comparación');
  assert.strictEqual(imp(sin, 'producto_sube'), imp(base, 'producto_sube'));
  // Con ventas chicas manda el piso de $1,000.
  const chicas = Array.from({ length: 50 }, (_, i) => ({ clase: 'venta', canal: 'mostrador', neta: 100, fecha: sumarDias(MARTES, -1 - (i % 30)) }));
  assert.strictEqual(umbralPedidoGrande(chicas, sumarDias(MARTES, -1)), 1000);
});

await t('R5. los semanales salen solo el lunes', () => {
  const martes = buscarHallazgos(sucursal({ hoy: MARTES }));
  assert.strictEqual(martes.esLunes, false);
  for (const tipo of TIPOS_SEMANALES) assert.ok(!martes.hallazgos.some((h) => h.tipo === tipo), `${tipo} salió en martes`);
  assert.ok(martes.hallazgos.some((h) => h.tipo === 'producto_baja'), 'el diario sí sale en martes');
});

await t('R6. fuera de horario: margen de media hora antes de abrir y una hora después de cerrar; un instante inválido no cuenta', () => {
  const tz = 'America/Matamoros';
  const local = (hm) => new Date(Date.parse(`2026-11-24T${hm}:00-06:00`)).toISOString();
  assert.strictEqual(fueraDeHorario(local('07:40'), HORARIO, tz), false);
  assert.strictEqual(fueraDeHorario(local('07:20'), HORARIO, tz), true);
  assert.strictEqual(fueraDeHorario(local('22:50'), HORARIO, tz), false);
  assert.strictEqual(fueraDeHorario(local('23:10'), HORARIO, tz), true);
  assert.strictEqual(fueraDeHorario('2026-11-24T26:10:00Z', HORARIO, tz), false);
  assert.strictEqual(fueraDeHorario('', HORARIO, tz), false);
});

await t('R7. la revisión de forma caza causa y efecto, teléfonos y correos, y deja pasar folios', () => {
  const bueno = base.hallazgos[0];
  const con = (cambio) => faltasDeHallazgo({ ...bueno, ...cambio });
  assert.ok(con({ titulo: 'Bajó porque llovió' }).some((f) => f.startsWith('lenguaje causal')));
  assert.ok(con({ sugerencia: 'Esto se debe a la promoción' }).some((f) => f.startsWith('lenguaje causal')));
  assert.ok(con({ titulo: 'Llama al 878 123 4567' }).some((f) => f.startsWith('parece dato personal')));
  assert.ok(con({ titulo: 'Escribe a dueno@ejemplo.mx' }).some((f) => f.startsWith('parece dato personal')));
  assert.deepStrictEqual(con({ titulo: 'Revisa el folio XAB-1234567' }), [], 'un folio no es un dato personal');
  assert.ok(con({ sugerencia: '' }).includes('sin acción'));
  assert.ok(con({ revisar: { numero: 'x', el: 'mañana' } }).includes('sin número a revisar'));
  assert.ok(con({ tipo: 'otro' }).includes('tipo desconocido'));
});

await t('R8. normalizarVenta no deja pasar teléfono, dirección ni correo aunque vengan en el pedido', () => {
  const v = normalizarVenta({
    folio: 'XAB-77', estado: 'entregado', creado_at: new Date('2026-11-24T18:00:00Z'), cliente_id: null,
    datos: { total: 250, subtotal: 250, canal: 'whatsapp', forma_pago: 'efectivo', items: [{ nombre: 'Café', cantidad: 1, precio_unitario: 250 }],
      cliente_nombre: 'Juan', telefono: '8781234567', direccion: 'Calle Falsa 123', email: 'juan@ejemplo.mx',
      cliente: { telefono: '8781234567', direccion: 'Calle Falsa 123' } },
  }, { tz: 'America/Matamoros', primeras: new Map(), usuarios: new Map() });
  const s = JSON.stringify(v);
  for (const prohibido of ['8781234567', 'Calle Falsa', 'juan@', 'telefono', 'direccion', 'email']) assert.ok(!s.includes(prohibido), `salió «${prohibido}»`);
  assert.strictEqual(v.neta, 250);
  assert.strictEqual(v.forma_pago, 'efectivo');
});

await t('R9. las consultas de datos.js no sacan teléfono, dirección, correo ni pagos de la base', () => {
  const src = readFileSync(raiz('src/asistenteRestaurante/datos.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const selects = [...src.matchAll(/SELECT([\s\S]*?)\bFROM\b/g)].map((m) => m[1]);
  assert.ok(selects.length >= 6, 'no se encontraron las consultas');
  for (const lista of selects) {
    const limpia = lista.replace(/\$\{TEL10\}/g, '');
    assert.ok(!/telefono|direccion|email|correo|tarjeta|clabe|referencia/i.test(limpia), `una consulta saca un dato personal: ${lista.slice(0, 120)}`);
  }
  assert.match(src, /await db\.query\('BEGIN READ ONLY'\)/, 'la lectura no es de solo lectura');
  assert.match(src, /SET LOCAL statement_timeout/);
});

// ═══ La elección ═══════════════════════════════════════════════════════════
const H = base.hallazgos;
const elegir = (memoria = {}) => priorizar(H, { hoy: LUNES, ...memoria });
const por = (r, tipo) => r.todos.find((x) => x.tipo === tipo);
// Los mismos hallazgos sin los de control y calidad: ahí mandan los pesos.
const HV = H.filter((h) => !TIPOS_CONTROL.includes(h.tipo));
const elegirVentas = (memoria = {}) => priorizar(HV, { hoy: LUNES, ...memoria });

await t('P1. máximo 3 al día: primero control y calidad, luego por pesos; los informativos al final', () => {
  const r = elegir();
  assert.strictEqual(MAXIMO_AL_DIA, 3);
  assert.deepStrictEqual(TIPOS_CONTROL, ['descuentos_altos', 'cancelaciones_altas', 'cortesias_altas',
    'ventas_sin_forma_pago', 'ventas_fuera_horario', 'ventas_incompletas']);
  // La sucursal inventada trae 3 de control: ganan los 3 lugares aunque
  // valgan menos que la baja del chilaquil; entre ellos, por pesos.
  assert.deepStrictEqual(r.elegidos.map((e) => e.tipo), ['descuentos_altos', 'ventas_sin_forma_pago', 'ventas_fuera_horario']);
  for (let i = 1; i < r.elegidos.length; i++) assert.ok(r.elegidos[i - 1].impacto >= r.elegidos[i].impacto);
  assert.ok(por(r, 'ventas_fuera_horario').impacto < por(r, 'producto_baja').impacto, 'el de control debía valer menos');
  assert.strictEqual(por(r, 'producto_baja').motivo, 'no cupo (máximo 3 al día)');
  assert.strictEqual(por(r, 'poca_venta').motivo, 'no cupo (máximo 3 al día)');
  assert.strictEqual(r.todos.length, H.length, 'todos los candidatos se guardan con su motivo');
  assert.ok(r.todos.every((x) => typeof x.motivo === 'string' && x.motivo));
  // Un solo aviso de control va primero y el resto se llena por pesos.
  const uno = priorizar(H.filter((h) => h.tipo === 'ventas_fuera_horario' || !TIPOS_CONTROL.includes(h.tipo)), { hoy: LUNES });
  assert.deepStrictEqual(uno.elegidos.map((e) => e.tipo), ['ventas_fuera_horario', 'producto_baja', 'producto_sube']);
  // Sin control, por pesos.
  assert.deepStrictEqual(elegirVentas().elegidos.map((e) => e.tipo), ['producto_baja', 'producto_sube', 'clientes_dejaron']);
  // Con solo informativos y nada más, el informativo sí cabe.
  const solo = priorizar(H.filter((h) => TIPOS_INFORMATIVOS.includes(h.tipo)), { hoy: LUNES });
  assert.deepStrictEqual(solo.elegidos.map((e) => e.tipo), ['poca_venta']);
});

await t('P2. no se repite en 7 días salvo que empeore 20 %; pasada la semana vuelve', () => {
  const baja = H.find((h) => h.tipo === 'producto_baja');
  const ayer = sumarDias(LUNES, -1);
  const elegir = elegirVentas;
  const igual = elegir({ mostrados: [{ firma: baja.firma, impacto: baja.impacto, fecha: ayer }] });
  assert.match(por(igual, 'producto_baja').motivo, /^ya se mostró hace 1 días y no empeoró$/);
  assert.deepStrictEqual(igual.elegidos.map((e) => e.tipo), ['producto_sube', 'clientes_dejaron', 'pedidos_grandes'], 'su lugar lo toma el siguiente');
  const peor = elegir({ mostrados: [{ firma: baja.firma, impacto: baja.impacto / 1.25, fecha: ayer }] });
  assert.ok(peor.elegidos.some((e) => e.tipo === 'producto_baja'), 'empeoró 25 % y no se volvió a avisar');
  const viejo = elegir({ mostrados: [{ firma: baja.firma, impacto: baja.impacto, fecha: sumarDias(LUNES, -7) }] });
  assert.ok(viejo.elegidos.some((e) => e.tipo === 'producto_baja'), 'a los 7 días debe poder volver');
});

await t('P3. un informativo no se repite en 28 días', () => {
  const poca = H.find((h) => h.tipo === 'poca_venta');
  const r = priorizar([poca], { hoy: LUNES, mostrados: [{ firma: poca.firma, impacto: 0, fecha: sumarDias(LUNES, -20) }] });
  assert.strictEqual(r.elegidos.length, 0);
  const r2 = priorizar([poca], { hoy: LUNES, mostrados: [{ firma: poca.firma, impacto: 0, fecha: sumarDias(LUNES, -28) }] });
  assert.strictEqual(r2.elegidos.length, 1);
});

await t('P4. «No avisar de esto» calla esa firma; un tipo apagado no sale', () => {
  const baja = H.find((h) => h.tipo === 'producto_baja');
  const r = elegir({ silenciados: [baja.firma], tiposApagados: ['producto_sube'] });
  assert.strictEqual(por(r, 'producto_baja').motivo, 'no avisar de esto');
  assert.strictEqual(por(r, 'producto_sube').motivo, 'tipo apagado');
  assert.ok(!r.elegidos.some((e) => ['producto_baja', 'producto_sube'].includes(e.tipo)));
});

await t('P5. «No útil»: cada 2 sube el mínimo de pesos de ese tipo; un informativo con 2 ya no sale', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4, 6, 20].map(factorPorNoUtil), [1, 1, 1.5, 1.5, 2, 2.5, 3]);
  const fuera = H.find((h) => h.tipo === 'ventas_fuera_horario'); // $380, sin piso propio
  const sinOpinion = priorizar([fuera], { hoy: LUNES });
  assert.strictEqual(sinOpinion.elegidos.length, 1);
  const baja = H.find((h) => h.tipo === 'descuentos_altos'); // $6,580 contra un piso de $500
  const muchas = priorizar([baja], { hoy: LUNES, noUtilPorTipo: { descuentos_altos: 20 } });
  assert.strictEqual(muchas.elegidos.length, 1, 'con el tope (×3 = $1,500) aún vale la pena');
  const caro = priorizar([{ ...baja, impacto: 1200 }], { hoy: LUNES, noUtilPorTipo: { descuentos_altos: 20 } });
  assert.match(caro.todos[0].motivo, /^menos de \$1500 en juego$/);
  const poca = H.find((h) => h.tipo === 'poca_venta');
  assert.strictEqual(priorizar([poca], { hoy: LUNES, noUtilPorTipo: { poca_venta: 2 } }).todos[0].motivo, 'no útil (informativo)');
});

await t('P6. un hallazgo mal formado nunca se elige', () => {
  const malo = { ...H.find((h) => h.tipo === 'producto_baja'), sugerencia: 'Subió porque hubo promoción' };
  const r = priorizar([malo], { hoy: LUNES });
  assert.strictEqual(r.elegidos.length, 0);
  assert.match(r.todos[0].motivo, /^forma: lenguaje causal/);
});

console.log(`\n${pasadas} OK, ${fallidas} FALLO`);
if (fallos.length) console.log(fallos.map((f) => `  - ${f}`).join('\n'));
process.exit(fallidas ? 1 : 0);
