// ASISTENTE DEL RESTAURANTE, Mejora 2: recomendaciones concretas (sin base).
//
// Con ventas INVENTADAS cuya respuesta se sabe de antemano se comprueba lo
// que pidió el dueño el 28-nov-2026:
//   C. categorías: qué platillos suman el cambio («Chilaquiles y Omelette
//      suman el 70 % del aumento»), en qué día y franja se concentra, y que
//      una categoría que sube igual que el total NO sale;
//   K. canales: venta nueva o venta que cambió de canal, con el total y los
//      otros canales del mismo periodo;
//   S. cada recomendación trae un dato concreto; sin datos, sin recomendación
//      (nunca la genérica de antes); sin causa y efecto ni datos personales;
//   O. el orden en tres grupos: lo que pide decisión, las buenas noticias y lo
//      informativo, cada grupo por pesos;
//   I. la IA: su recomendación también necesita un dato concreto, no inventa
//      una donde las reglas no la dieron y no cambia una decisión por una
//      buena noticia;
//   T. la tarjeta: las cifras chicas y la tarjeta sin recomendación;
//   A. apagada la bandera, todo sale como antes.
import assert from 'assert';
import {
  buscarHallazgos, faltasDeHallazgo, tieneDatoConcreto, sumarDias, periodosDe, TIPOS_HALLAZGO, FRASES_CAUSALES, PARECE_DATO_PERSONAL,
} from '../src/asistenteRestaurante/reglas.js';
import {
  concretarHallazgos, grupoV2, TIPOS_DECISION, TIPOS_BUENAS_NOTICIAS, BANDERA_REGLAS_V2, claseDeCanal,
} from '../src/asistenteRestaurante/recomendaciones.js';
import { priorizar } from '../src/asistenteRestaurante/priorizar.js';
import { entradaAvisos, aplicarRespuestaAvisos, SISTEMA_AVISOS, SISTEMA_AVISOS_V2 } from '../src/asistenteRestaurante/redaccion.js';
import { tarjetaDe } from '../src/asistenteRestaurante/pantalla.js';
import { TIPOS_INFORMATIVOS } from '../src/asistenteRestaurante/reglas.js';

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  if (process.env.CASOS && !new RegExp(process.env.CASOS).test(nombre)) return;
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const V2 = { concretar: concretarHallazgos };
const HOY = '2026-11-25'; // miércoles: sin semanales
const AYER = sumarDias(HOY, -1);
const { P, A } = periodosDe(AYER);
const diaDe = (f) => new Date(`${f}T12:00:00Z`).getUTCDay();
const diasDe = (r) => { const out = []; for (let f = r.desde; f <= r.hasta; f = sumarDias(f, 1)) out.push(f); return out; };

// Tickets del reporte de Productos: `spec(fecha, dia, periodo)` → [[producto, categoría, tickets, precio, franja?]].
// Cada ticket lleva UNA línea (precios abajo de $1,000: ningún pedido grande).
function tickets(spec) {
  const out = { actual: [], anterior: [] };
  for (const [per, lista, cual] of [[P, out.actual, 'P'], [A, out.anterior, 'A']]) {
    for (const f of diasDe(per)) {
      for (const [prod, cat, n, precio, franja = '13-15'] of spec(f, diaDe(f), cual)) {
        for (let i = 0; i < n; i++) lista.push({ neta: precio * 100, fecha: f, dia: diaDe(f), franja, desglose: true, lineas: [[prod, cat, 1, precio * 100]] });
      }
    }
  }
  return out;
}
const NOMBRES = {
  productos: { p1: 'Chilaquiles', p2: 'Omelette', p3: 'Molletes', p4: 'Hotcakes', p9: 'Café',
    ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`q${i}`, `Guisado ${i + 1}`])) },
  categorias: { c1: 'Desayunos', c2: 'Bebidas', c3: 'Comidas' },
};
const ctxDe = ({ productos = null, ventas = [] } = {}) => ({
  negocio: { id: 'n1', nombre: 'Sucursal de prueba' }, tz: 'America/Matamoros', hoy: HOY, ayer: AYER,
  ventas, eventosMesa: [], menu90: null, reglasAtencion: null,
  productos: productos ? { ...productos, nombres: NOMBRES } : null,
});
const por = (hs, firma) => hs.find((h) => h.firma === firma);

// Desayunos sube 25 %: Chilaquiles +$400 al día, Omelette +$300, Molletes y
// Hotcakes +$150 cada uno (de $1,000 extra al día, los dos primeros suman el
// 70 %). Café no se mueve: el total sube 12.5 %.
const DESAYUNOS = tickets((f, d, cual) => cual === 'A'
  ? [['p1', 'c1', 10, 100], ['p2', 'c1', 10, 100], ['p3', 'c1', 10, 100], ['p4', 'c1', 10, 100], ['p9', 'c2', 40, 100]]
  : [['p1', 'c1', 14, 100], ['p2', 'c1', 13, 100], ['p3', 'c1', 10, 115], ['p4', 'c1', 10, 115], ['p9', 'c2', 40, 100]]);

// ═══ C. Categorías ═════════════════════════════════════════════════════════
await t('C1. los platillos que suman el cambio: «Chilaquiles» y «Omelette» suman el 70 % del aumento', () => {
  const v2 = buscarHallazgos(ctxDe({ productos: DESAYUNOS }), V2).hallazgos;
  const h = por(v2, 'categoria_sube:c1');
  assert.ok(h, `no salió la categoría: ${v2.map((x) => x.firma).join(', ')}`);
  assert.strictEqual(h.sugerencia, 'Asegura existencias de «Chilaquiles» y «Omelette» de 13 a 15: suman el 70 % del aumento.');
  assert.match(h.titulo, /^La categoría Desayunos vendió 25 % más que las 4 semanas anteriores \(\+\$28,000\)\. El total del negocio subió 12\.5 %\.$/);
  assert.deepStrictEqual(h.pantalla.datos, ['Total del negocio +12.5 %', '13 a 15: 100 % del aumento']);
  assert.deepStrictEqual(h.detalle.tabla.columnas, ['Platillo', 'Últimas 4 semanas', '4 anteriores', 'Cambio']);
  assert.deepStrictEqual(h.detalle.tabla.filas.slice(0, 2), [['Chilaquiles', 39200, 28000, 11200], ['Omelette', 36400, 28000, 8400]]);
  assert.deepStrictEqual(h.detalle.numeros.slice(-2).map((n) => n.valor), [252000, 224000], 'falta la venta total del mismo periodo');
  for (const c of ['Desayunos', 'Chilaquiles', 'Omelette']) assert.ok(h.concretos.includes(c), `faltó ${c} en concretos`);
  // Lo de las reglas se queda: el botón, el número a revisar, el impacto.
  const v1 = por(buscarHallazgos(ctxDe({ productos: DESAYUNOS })).hallazgos, 'categoria_sube:c1');
  assert.deepStrictEqual([h.impacto, h.accion, h.revisar, h.pantalla.encabezado], [v1.impacto, v1.accion, v1.revisar, v1.pantalla.encabezado]);
  assert.strictEqual(v1.sugerencia, 'Asegura el inventario para que sus platillos no se agoten.', 'cambió el texto de siempre');
});

await t('C2. lo obvio no sale: una categoría que sube igual que el total del negocio', () => {
  // Café también sube 25 %: todo el negocio sube 25 %.
  const todo = tickets((f, d, cual) => cual === 'A'
    ? [['p1', 'c1', 10, 100], ['p2', 'c1', 10, 100], ['p3', 'c1', 10, 100], ['p4', 'c1', 10, 100], ['p9', 'c2', 40, 100]]
    : [['p1', 'c1', 14, 100], ['p2', 'c1', 13, 100], ['p3', 'c1', 10, 115], ['p4', 'c1', 10, 115], ['p9', 'c2', 40, 125]]);
  const v1 = buscarHallazgos(ctxDe({ productos: todo })).hallazgos;
  assert.ok(por(v1, 'categoria_sube:c1') && por(v1, 'categoria_sube:c2'), 'antes sí salían las dos (la prueba no prueba nada)');
  const v2 = buscarHallazgos(ctxDe({ productos: todo }), V2).hallazgos;
  assert.ok(!v2.some((h) => h.tipo.startsWith('categoria_')), `salió una categoría que solo sigue al total: ${v2.map((x) => x.firma)}`);
  // Los productos sí siguen (no se pidió quitarlos).
  assert.ok(por(v2, 'producto_sube:p1'));
  // Y al revés: si el negocio baja 25 % y una categoría también, tampoco.
  const baja = tickets((f, d, cual) => cual === 'A'
    ? [['p1', 'c1', 40, 100], ['p9', 'c2', 40, 100]] : [['p1', 'c1', 30, 100], ['p9', 'c2', 30, 100]]);
  assert.ok(!buscarHallazgos(ctxDe({ productos: baja }), V2).hallazgos.some((h) => h.tipo.startsWith('categoria_')));
  assert.ok(buscarHallazgos(ctxDe({ productos: baja })).hallazgos.some((h) => h.tipo === 'categoria_baja'));
});

await t('C3. el cambio repartido entre muchos platillos: sale el hallazgo SIN recomendación, nunca la genérica', () => {
  // Comidas: 10 guisados que suben 20 % cada uno; ninguno suma la mitad. El
  // total sube ~9 % (Café no se mueve): la categoría le gana 11 puntos.
  const reparto = tickets((f, d, cual) => [
    ...Array.from({ length: 10 }, (_, i) => [`q${i}`, 'c3', 10, cual === 'A' ? 100 : 120]),
    ['p9', 'c2', 120, 100],
  ]);
  const v2 = buscarHallazgos(ctxDe({ productos: reparto }), V2).hallazgos;
  const h = por(v2, 'categoria_sube:c3');
  assert.ok(h, 'no salió la categoría');
  assert.strictEqual(h.sugerencia, '', 'puso una recomendación sin dato concreto');
  assert.match(h.detalle.nota, /repartido entre muchos platillos/);
  assert.deepStrictEqual(faltasDeHallazgo(h, { v2: true }), []);
  assert.deepStrictEqual(faltasDeHallazgo(h).slice(0, 1), ['sin acción'], 'sin la bandera, una sugerencia vacía debe seguir siendo falta');
  const { todos } = priorizar(v2, { hoy: HOY, v2: true });
  assert.ok(!String(todos.find((x) => x.firma === h.firma).motivo).startsWith('forma'), 'el aviso sin recomendación quedó fuera por su forma');
});

await t('C4. el día y la franja donde se concentra: «los sábados» y «de 9 a 11»; si está parejo, no se nombra', () => {
  // Chilaquiles: igual de lunes a viernes a las 13; los sábados, 20 tickets más de 9 a 11.
  const pico = tickets((f, d, cual) => [['p1', 'c1', 10, 100, '13-15'], ...(cual === 'P' && d === 6 ? [['p1', 'c1', 20, 100, '9-11']] : []), ['p9', 'c2', 40, 100]]);
  const h = por(buscarHallazgos(ctxDe({ productos: pico }), V2).hallazgos, 'producto_sube:p1');
  assert.ok(h);
  assert.strictEqual(h.sugerencia, 'Asegura existencias de «Chilaquiles» los sábados y de 9 a 11, donde más subió: vende $8,000 más que en las 4 semanas anteriores.');
  assert.deepStrictEqual(h.pantalla.datos.slice(1), ['Sábados: 100 % del aumento', '9 a 11: 100 % del aumento']);
  assert.match(h.detalle.nota, /El 100 % del aumento fue los sábados; el 100 %, de 9 a 11\./);
  assert.ok(h.concretos.includes('sábado') && h.concretos.includes('de 9 a 11'));
  // Parejo toda la semana (Desayunos de C1): sin día.
  const parejo = por(buscarHallazgos(ctxDe({ productos: DESAYUNOS }), V2).hallazgos, 'producto_sube:p1');
  assert.ok(!/sábado|domingo|lunes|martes|miércoles|jueves|viernes/.test(parejo.sugerencia), parejo.sugerencia);
  // «Otras horas» no es un horario: no se nombra como pico.
  const otras = tickets((f, d, cual) => [['p1', 'c1', cual === 'A' ? 10 : 20, 100, 'otras'], ['p9', 'c2', 40, 100]]);
  const ho = por(buscarHallazgos(ctxDe({ productos: otras }), V2).hallazgos, 'producto_sube:p1');
  assert.ok(ho && !/otras horas|fuera de/i.test(ho.sugerencia), ho && ho.sugerencia);
});

// ═══ K. Canales ════════════════════════════════════════════════════════════
// Ventas por día de WhatsApp y Mostrador a $200, en las dos ventanas de 4 semanas.
function ventasCanal(wa, mo) {
  const out = [];
  let n = 0;
  for (const [per, cual] of [[P, 'P'], [A, 'A']]) {
    for (const f of diasDe(per)) {
      for (const [canal, etiqueta, cuantos] of [['whatsapp', 'WhatsApp', wa[cual]], ['mostrador', 'Mostrador', mo[cual]]]) {
        for (let i = 0; i < cuantos; i++) {
          out.push({ folio: `XAB-${++n}`, clase: 'venta', fecha: f, hora: '13:00', instante: `${f}T19:00:00.000Z`, neta: 200, canal, canal_etiqueta: etiqueta,
            forma_pago: 'efectivo', n_items: 1, items: [{ nombre: 'Café' }], descuento: 0, cortesia: false });
        }
      }
    }
  }
  return out;
}

await t('K1. un canal que crece mientras el total no se mueve: parece venta que cambió de canal', () => {
  const hs = buscarHallazgos(ctxDe({ ventas: ventasCanal({ A: 20, P: 30 }, { A: 40, P: 30 }) }), V2).hallazgos;
  const wa = por(hs, 'canal_sube:whatsapp');
  assert.ok(wa, hs.map((h) => h.firma).join(', '));
  assert.strictEqual(wa.titulo, 'WhatsApp vendió 50 % más que las 4 semanas anteriores (+$56,000). Parece venta que cambió de canal: Mostrador bajó 25 % y el total casi no cambió (0 %).');
  assert.deepStrictEqual(wa.pantalla.datos, ['Total del negocio igual', 'Parece cambio de canal', 'Mostrador −25 %']);
  assert.strictEqual(wa.sugerencia, 'Compara lo que te deja cada canal: WhatsApp subió $56,000 y Mostrador bajó $56,000 en 4 semanas.');
  // Empatan en venta: van por nombre, y el total al final.
  assert.deepStrictEqual(wa.detalle.tabla.filas, [['Mostrador', 168000, 224000, -25], ['WhatsApp', 168000, 112000, 50], ['Total', 336000, 336000, 0]]);
  const mo = por(hs, 'canal_baja:mostrador');
  assert.strictEqual(mo.sugerencia, 'Revisa si los clientes de Mostrador ahora piden por WhatsApp (+$56,000 en 4 semanas).');
  assert.ok(mo.concretos.includes('Mostrador') && mo.concretos.includes('WhatsApp'));
});

await t('K2. un canal que crece y el total crece igual: es venta nueva', () => {
  const wa = por(buscarHallazgos(ctxDe({ ventas: ventasCanal({ A: 20, P: 30 }, { A: 40, P: 40 }) }), V2).hallazgos, 'canal_sube:whatsapp');
  assert.match(wa.titulo, /\. Es venta nueva: el total subió 16\.7 %\.$/);
  assert.deepStrictEqual(wa.pantalla.datos, ['Total del negocio +16.7 %', 'Venta nueva']);
  assert.strictEqual(wa.sugerencia, 'Asegura que WhatsApp se atienda a tiempo con el volumen nuevo: +$56,000 en 4 semanas.');
  assert.strictEqual(claseDeCanal({ P: new Map([['w', { venta: 30 }], ['m', { venta: 40 }]]), A: new Map([['w', { venta: 20 }], ['m', { venta: 40 }]]), totalP: 70, totalA: 60 }, 'w').clase, 'nueva');
});

await t('K3. un canal que baja y el total baja con él: no se pasó a otro canal', () => {
  const wa = por(buscarHallazgos(ctxDe({ ventas: ventasCanal({ A: 20, P: 10 }, { A: 40, P: 40 }) }), V2).hallazgos, 'canal_baja:whatsapp');
  assert.match(wa.titulo, /\. No se pasó a otro canal: el total bajó 16\.7 %\.$/);
  assert.deepStrictEqual(wa.pantalla.datos, ['Total del negocio −16.7 %', 'No se pasó a otro canal']);
  assert.strictEqual(wa.sugerencia, 'Revisa que WhatsApp funcione y se anuncie igual que antes: vendió $56,000 menos y el total no lo compensó.');
});

await t('K4. en parte nueva y en parte de otro canal', () => {
  // WhatsApp +$2,000 al día; Mostrador −$800: los otros compensan el 40 %.
  const wa = por(buscarHallazgos(ctxDe({ ventas: ventasCanal({ A: 20, P: 30 }, { A: 40, P: 36 }) }), V2).hallazgos, 'canal_sube:whatsapp');
  assert.match(wa.titulo, /\. En parte es venta nueva: el total subió 10 % y Mostrador bajó 10 %\.$/);
  assert.deepStrictEqual(wa.pantalla.datos, ['Total del negocio +10 %', 'En parte venta nueva', 'Mostrador −10 %']);
});

// ═══ S. Datos concretos ════════════════════════════════════════════════════
// La sucursal inventada de la Fase 1 (fase-asistente-f1-reglas): un lunes con
// casi todos los tipos.
function sucursalF1() {
  const hoy = '2026-11-23';
  const ayer = sumarDias(hoy, -1);
  const per = periodosDe(ayer);
  let n = 0;
  const ventas = [];
  const tks = { actual: [], anterior: [] };
  const franjaDe = (h) => (h < 9 ? '7-9' : h < 11 ? '9-11' : h < 13 ? '11-13' : h < 15 ? '13-15' : 'otras');
  for (let d = 119; d >= 0; d--) {
    const fecha = sumarDias(ayer, -d);
    const dow = diaDe(fecha);
    for (let k = 0; k < 40; k++) {
      n++;
      const hora = 8 + (k % 12);
      const enP = fecha >= per.P.desde, enA = fecha >= per.A.desde && fecha <= per.A.hasta;
      const conP1 = enP ? k % 4 === 0 : k % 2 === 0;
      const grande = k === 39 && d === 2;
      const neta = grande ? 9000 : 300 + (k % 5) * 40;
      const cliente = k === 0 && fecha < sumarDias(ayer, -30) ? 'c-frecuente' : (k === 1 ? `c-nuevo-${fecha}` : null);
      ventas.push({
        folio: `XAB-${n}`, clase: 'venta',
        instante: k === 7 && d === 1 ? new Date(Date.parse(`${fecha}T23:40:00-06:00`)).toISOString() : new Date(Date.parse(`${fecha}T${String(hora).padStart(2, '0')}:10:00-06:00`)).toISOString(),
        fecha, hora: `${hora}:10`, neta, canal: k % 3 === 0 ? 'whatsapp' : 'mostrador', canal_etiqueta: k % 3 === 0 ? 'WhatsApp' : 'Mostrador',
        forma_pago: k === 5 && d < 3 ? null : 'efectivo', n_items: 2, items: [{ nombre: conP1 ? 'Chilaquiles' : 'Enchiladas' }, { nombre: 'Café' }],
        cortesia: false, cortesia_monto: 0, descuento: d < 7 && k < 8 ? 120 : (k === 0 ? 20 : 0), descuento_motivo: 'cliente frecuente', descuento_autorizo: 'Ana',
        cancelacion_motivo: null, cancelacion_autorizo: null, cliente_id: cliente,
        cliente_nombre: cliente === 'c-frecuente' ? 'MARÍA PÉREZ' : (cliente ? 'Cliente nuevo' : null),
        cliente_primera: cliente === 'c-frecuente' ? sumarDias(ayer, -119) : (cliente ? fecha : null), nombre_en_venta: null,
      });
      const tk = { neta: neta * 100, fecha, dia: dow, franja: franjaDe(hora), desglose: true, lineas: [[conP1 ? 'p1' : 'p2', 'c1', 1, (neta - 60) * 100], ['p3', 'c2', 1, 6000]] };
      if (enP) tks.actual.push(tk); else if (enA) tks.anterior.push(tk);
    }
  }
  const HORARIO = { horarios: Object.fromEntries(['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'].map((d) => [d, { abierto: true, apertura: '08:00', cierre: '22:00' }])) };
  return { negocio: { id: 'n1', nombre: 'Sucursal de prueba' }, tz: 'America/Matamoros', hoy, ayer, ventas, eventosMesa: [],
    productos: { ...tks, nombres: { productos: { p1: 'Chilaquiles', p2: 'Enchiladas', p3: 'Café' }, categorias: { c1: 'Desayunos', c2: 'Bebidas' } } },
    menu90: { tickets: 3600, sinMovimiento: [{ nombre: 'Pozole', categoria: 'Caldos', unidades: 2 }, { nombre: 'Menudo', categoria: 'Caldos', unidades: 1 }, { nombre: 'Tamal', categoria: 'Otros', unidades: 0 }] },
    reglasAtencion: HORARIO };
}

// Hallazgos con la forma de las reglas para los tipos que la sucursal de la
// Fase 1 no trae (los números van en el orden de reglas.js).
const num = (etiqueta, valor, formato = 'dinero') => ({ etiqueta, valor, formato });
const base = (tipo, firma, numeros, extra = {}) => ({ tipo, firma, impacto: 1000, titulo: `Título de ${tipo}.`, sugerencia: 'Texto genérico de antes.',
  detalle: { numeros, ...extra }, revisar: { numero: 'x', valor: 1, formato: 'entero', el: '2026-12-09' }, pantalla: { encabezado: tipo } });
const SUELTOS = [
  base('dia_flojo', 'dia_flojo:2', [num('a', 800), num('b', 1000), num('c', 40, 'entero'), num('d', 50, 'entero'), num('e', 3200)]),
  base('franja_floja', 'franja_floja:13-15', [num('a', 800), num('b', 1000)]),
  base('franja_floja', 'franja_floja:otras', [num('a', 800), num('b', 1000)]),
  base('nuevos_regresan_menos', 'nuevos_regresan_menos', [num('a', 40, 'entero'), num('b', 8, 'entero'), num('c', 50, 'entero'), num('d', 20, 'entero')]),
  base('cancelaciones_altas', 'cancelaciones_altas', [num('a', 2000), num('b', 500), num('c', 1500), num('d', 6, 'entero')], { tabla: { columnas: ['Autorizó', 'Monto'], filas: [['Sin registrar', 1200], ['Luis', 800]] } }),
  base('cortesias_altas', 'cortesias_altas', [num('a', 900), num('b', 200), num('c', 700), num('d', 3, 'entero')], { tabla: { columnas: ['Autorizó', 'Monto'], filas: [['Sin registrar', 900]] } }),
  base('ventas_incompletas', 'ventas_incompletas', [num('Ventas', 1, 'entero'), num('Monto', 150)]),
  base('combinaciones', 'combinaciones:c1|c2', [num('a', 42, 'entero'), num('b', 12, 'pct')]),
  base('clientes_cambiaron', 'clientes_cambiaron', [num('Clientes', 2, 'entero')]),
];

await t('S1. cada recomendación nombra algo concreto de su aviso; las de antes eran genéricas', () => {
  const s = sucursalF1();
  const v1 = buscarHallazgos(s).hallazgos;
  const v2 = buscarHallazgos(s, V2).hallazgos;
  const sueltos = concretarHallazgos(SUELTOS, { ...s, umbrales: {}, periodos: periodosDe(s.ayer), umbralGrande: 1000 });
  const todos = [...v2, ...sueltos];
  const vistos = new Set(todos.map((h) => h.tipo));
  assert.deepStrictEqual(TIPOS_HALLAZGO.filter((x) => !vistos.has(x) && !['producto_baja', 'categoria_baja', 'categoria_sube', 'canal_baja', 'canal_sube'].includes(x)), [],
    'falta probar algún tipo');
  for (const h of todos) {
    assert.ok(h.sugerencia, `${h.firma}: sin recomendación`);
    assert.ok(tieneDatoConcreto(h.sugerencia, h), `${h.firma}: «${h.sugerencia}» no trae un dato concreto`);
    assert.deepStrictEqual(faltasDeHallazgo(h, { v2: true }), [], `${h.firma}: ${faltasDeHallazgo(h, { v2: true }).join('; ')}`);
  }
  // Las de antes no traían ni cifra ni nombre (la prueba sí distingue).
  for (const h of v1) assert.ok(!tieneDatoConcreto(h.sugerencia, { concretos: [] }), `${h.firma}: la de antes ya era concreta: ${h.sugerencia}`);
  const de = (f) => todos.find((h) => h.firma === f).sugerencia;
  assert.strictEqual(de('descuentos_altos'), 'Revisa con Ana, que autorizó todo ($6,720), que cada descuento haya sido correcto.');
  // La misma cifra que el título de las reglas (Xabor la calcula; aquí solo se repite).
  assert.match(todos.find((h) => h.firma === 'clientes_dejaron').titulo, /gastaban \$9,102 al mes/);
  assert.strictEqual(de('clientes_dejaron'), 'Escríbele a este cliente (gastaba $9,102 al mes) o mándale una promoción para que vuelva.');
  assert.strictEqual(de('poca_venta'), 'Decide si «Pozole», «Menudo» y 1 más se quedan en el menú, se cambian o se promueven.');
  assert.strictEqual(de('dia_flojo:2'), 'Prueba una promoción o un platillo del día solo los martes: vendieron $1,000 menos en 4 semanas.');
  assert.strictEqual(de('franja_floja:otras'), 'Revisa el personal y la oferta fuera de 7 a 15 y prueba una promoción solo en ese horario: vendió $1,000 menos en 4 semanas.');
  assert.strictEqual(de('cancelaciones_altas'), 'Revisa con Luis, que autorizó $800 de los $2,000, que cada cancelación tenga su motivo.');
  assert.strictEqual(de('cortesias_altas'), 'Revisa a quién se dieron las 3 cortesías de la semana y por qué ($900).');
  assert.strictEqual(de('combinaciones:c1|c2'), 'Prueba ofrecer Desayunos y Bebidas juntas (un combo o una sugerencia al tomar la orden).');
  assert.strictEqual(de('ventas_incompletas'), 'Revisa esa venta ($150) y complétala.');
});

await t('S2. «Asegura el inventario para que sus platillos no se agoten» no pasa; un nombre o una cifra sí', () => {
  const h = { concretos: ['Chilaquiles', 'sábado', 'de 9 a 11'] };
  assert.strictEqual(tieneDatoConcreto('Asegura el inventario para que sus platillos no se agoten.', h), false);
  assert.strictEqual(tieneDatoConcreto('Ten listos los chilaquiles.', h), true, 'sin acentos ni mayúsculas también cuenta');
  assert.strictEqual(tieneDatoConcreto('Refuerza la cocina el SABADO.', h), true);
  assert.strictEqual(tieneDatoConcreto('Revisa las 3 ventas.', {}), true);
  assert.strictEqual(tieneDatoConcreto('Revisa la venta XAB-1234.', {}), false, 'un folio no es un dato del aviso');
  assert.strictEqual(tieneDatoConcreto('', h), false);
  const forma = { tipo: 'producto_baja', firma: 'producto_baja:p1', impacto: 10, titulo: 'x', revisar: { numero: 'x', el: '2026-12-09' }, concretos: ['Chilaquiles'] };
  assert.deepStrictEqual(faltasDeHallazgo({ ...forma, sugerencia: 'Revisa que esté disponible.' }, { v2: true }), ['recomendación sin dato concreto']);
  assert.deepStrictEqual(faltasDeHallazgo({ ...forma, sugerencia: 'Revisa que esté disponible.' }), [], 'sin la bandera la regla es la de antes');
  assert.deepStrictEqual(faltasDeHallazgo({ ...forma, sugerencia: '' }, { v2: true }), []);
});

await t('S3. sin causa y efecto ni datos personales en nada de lo nuevo (títulos, cifras chicas, tablas, notas)', () => {
  const todos = [
    ...buscarHallazgos(sucursalF1(), V2).hallazgos,
    ...buscarHallazgos(ctxDe({ productos: DESAYUNOS }), V2).hallazgos,
    ...buscarHallazgos(ctxDe({ ventas: ventasCanal({ A: 20, P: 30 }, { A: 40, P: 30 }) }), V2).hallazgos,
  ];
  for (const h of todos) {
    const textos = [h.titulo, h.sugerencia, h.detalle?.nota, ...(h.pantalla?.datos || []), ...(h.detalle?.tabla?.filas || []).flat().filter((x) => typeof x === 'string')];
    for (const x of textos) {
      assert.ok(!FRASES_CAUSALES.test(x), `${h.firma}: lenguaje causal en «${x}»`);
      assert.ok(!PARECE_DATO_PERSONAL.test(String(x).replace(/\b[A-Z]{2,5}-[0-9A-Z-]{1,24}\b/g, '')), `${h.firma}: parece dato personal «${x}»`);
    }
    assert.ok((h.pantalla?.datos || []).length <= 3 && (h.pantalla?.datos || []).every((x) => x.length <= 48), `${h.firma}: cifras chicas de más`);
  }
});

await t('S4. un aviso al que le faltan sus números sale sin recomendación, nunca con la genérica, y no se pierde', () => {
  const s = sucursalF1();
  const ctx = { ...s, umbrales: {}, periodos: periodosDe(s.ayer), umbralGrande: 1000 };
  // (el día flojo usa su impacto, que siempre trae; sin un día válido no hay de qué hablar)
  const vacios = [base('dia_flojo', 'dia_flojo:9', []), base('clientes_dejaron', 'clientes_dejaron', []), base('ventas_sin_forma_pago', 'ventas_sin_forma_pago', [])];
  const r = concretarHallazgos(vacios, ctx);
  assert.deepStrictEqual(r.map((h) => h.firma), vacios.map((h) => h.firma), 'se perdió un aviso');
  for (const h of r) {
    assert.strictEqual(h.sugerencia, '', `${h.firma} se quedó con «${h.sugerencia}»`);
    assert.deepStrictEqual(faltasDeHallazgo(h, { v2: true }).filter((f) => /recomendaci|acci/.test(f)), [], h.firma);
  }
});

// ═══ O. El orden ═══════════════════════════════════════════════════════════
const hall = (tipo, impacto, sugerencia = `Revisa los ${impacto} pesos.`) => ({ tipo, firma: `${tipo}:x`, impacto, titulo: `Aviso ${tipo}.`, sugerencia,
  revisar: { numero: 'x', valor: 1, formato: 'entero', el: '2026-12-09' }, detalle: { numeros: [] }, frecuencia: 'diaria', pantalla: { encabezado: tipo } });

await t('O1. tres grupos: lo que pide decisión (por pesos), luego las buenas noticias, al final lo informativo', () => {
  assert.deepStrictEqual([...TIPOS_DECISION, ...TIPOS_BUENAS_NOTICIAS, ...TIPOS_INFORMATIVOS].sort(), [...TIPOS_HALLAZGO].sort(), 'algún tipo sin grupo o en dos');
  const cand = [hall('descuentos_altos', 600), hall('producto_baja', 4200), hall('producto_sube', 9000), hall('combinaciones', 0)];
  const v2 = priorizar(cand, { hoy: HOY, v2: true });
  assert.deepStrictEqual(v2.elegidos.map((h) => h.tipo), ['producto_baja', 'descuentos_altos', 'producto_sube'], 'la caída de $4,200 va antes del descuento de $600');
  const v1 = priorizar(cand, { hoy: HOY });
  assert.deepStrictEqual(v1.elegidos.map((h) => h.tipo), ['descuentos_altos', 'producto_sube', 'producto_baja'], 'sin la bandera cambió el orden de siempre');
  // Una buena noticia de $9,000 no le gana el lugar a tres decisiones chicas.
  const llenas = priorizar([hall('producto_sube', 9000), hall('canal_baja', 1600), hall('clientes_dejaron', 1200), hall('franja_floja', 1500)], { hoy: HOY, v2: true });
  assert.deepStrictEqual(llenas.elegidos.map((h) => h.tipo), ['canal_baja', 'franja_floja', 'clientes_dejaron']);
  assert.match(llenas.todos.find((h) => h.tipo === 'producto_sube').motivo, /^no cupo/);
  assert.strictEqual(grupoV2('pedidos_grandes'), 1);
  assert.strictEqual(grupoV2('clientes_cambiaron'), 2);
});

// ═══ I. La IA ══════════════════════════════════════════════════════════════
const NEG = { id: 'n1', nombre: 'Sucursal de prueba' };
function pool2() {
  const cand = [
    { ...hall('producto_baja', 4200, 'Revisa que «Chilaquiles» esté disponible: $4,200 menos en 4 semanas.'), concretos: ['Chilaquiles'] },
    { ...hall('categoria_sube', 3000, ''), concretos: ['Comidas'] },
    { ...hall('producto_sube', 9000, 'Asegura existencias de «Omelette»: vende $9,000 más.'), concretos: ['Omelette'] },
  ];
  return priorizar(cand, { hoy: HOY, v2: true }).todos;
}
const idDe = (todos, tipo) => `a${todos.findIndex((h) => h.tipo === tipo)}`;

await t('I1. la recomendación de la IA también necesita un dato concreto; si no, queda la de Xabor', () => {
  const todos = pool2();
  const resp = (sug) => ({ avisos: [
    { id: idDe(todos, 'producto_baja'), titulo: 'Chilaquiles vende menos.', explicacion: 'Vendió $4,200 menos en 4 semanas.', sugerencia: sug },
    { id: idDe(todos, 'categoria_sube'), titulo: 'Comidas vende más.', explicacion: 'Subió.', sugerencia: '' },
    { id: idDe(todos, 'producto_sube'), titulo: 'Omelette vende más.', explicacion: 'Subió $9,000.', sugerencia: 'Asegura existencias de Omelette.' },
  ] });
  const mal = aplicarRespuestaAvisos({ todos, maximo: 3, hoy: HOY, respuesta: resp('Asegura el inventario para que no se agote.'), v2: true });
  assert.strictEqual(mal.estado, 'parcial');
  assert.ok(mal.faltas.includes('sugerencia: sin dato concreto'), mal.faltas.join('; '));
  assert.strictEqual(mal.todos.find((h) => h.tipo === 'producto_baja').ia, null, 'se quedó el texto genérico de la IA');
  assert.strictEqual(mal.todos.find((h) => h.tipo === 'producto_sube').ia.sugerencia, 'Asegura existencias de Omelette.');
  const bien = aplicarRespuestaAvisos({ todos, maximo: 3, hoy: HOY, respuesta: resp('Ten listos los Chilaquiles para el fin de semana.'), v2: true });
  assert.strictEqual(bien.estado, 'ok', bien.faltas.join('; '));
  // Sin la bandera, la regla de siempre (la genérica pasa).
  const v1 = aplicarRespuestaAvisos({ todos: priorizar(pool2().map((h) => ({ ...h, sugerencia: h.sugerencia || 'x' })), { hoy: HOY }).todos, maximo: 3, hoy: HOY,
    respuesta: resp('Asegura el inventario para que no se agote.') });
  assert.ok(!v1.faltas.includes('sugerencia: sin dato concreto'));
});

await t('I2. donde las reglas no dieron recomendación, la IA tampoco pone una', () => {
  const todos = pool2();
  const r = aplicarRespuestaAvisos({ todos, maximo: 3, hoy: HOY, v2: true, respuesta: { avisos: [
    { id: idDe(todos, 'producto_baja'), titulo: 'Chilaquiles vende menos.', explicacion: 'Bajó.', sugerencia: 'Revisa los Chilaquiles.' },
    { id: idDe(todos, 'categoria_sube'), titulo: 'Comidas vende más.', explicacion: 'Subió.', sugerencia: 'Asegura el inventario de 3 platillos.' },
  ] } });
  const c = r.todos.find((h) => h.tipo === 'categoria_sube');
  assert.ok(c.ia, 'se perdió el texto de la IA');
  assert.strictEqual(c.ia.sugerencia, '', 'la IA puso una recomendación donde Xabor no tenía datos');
});

await t('I3. la IA no puede cambiar una decisión por una buena noticia; recibe los grupos y los «concretos»', () => {
  const todos = pool2();
  const e = entradaAvisos({ negocio: NEG, hoy: HOY, todos, maximo: 3, v2: true });
  assert.deepStrictEqual(e.obligatorios.map((h) => h.tipo).sort(), ['categoria_sube', 'producto_baja'].filter((x) => TIPOS_DECISION.includes(x)).concat(), 'los obligatorios no son las decisiones elegidas');
  const aviso = e.datos.avisos.find((x) => x.tipo === 'producto_baja');
  assert.deepStrictEqual([aviso.grupo, aviso.concretos], ['pide_decision', ['Chilaquiles']]);
  assert.strictEqual(e.datos.avisos.find((x) => x.tipo === 'producto_sube').grupo, 'buena_noticia');
  const r = aplicarRespuestaAvisos({ todos, maximo: 3, hoy: HOY, v2: true, respuesta: { avisos: [
    { id: idDe(todos, 'producto_sube'), titulo: 'Omelette vende más.', explicacion: 'Subió.', sugerencia: 'Asegura existencias de Omelette.' },
  ] } });
  assert.strictEqual(r.estado, 'invalida');
  assert.ok(r.faltas.includes('dejó fuera un aviso que pide decisión'));
  assert.ok(SISTEMA_AVISOS_V2.startsWith(SISTEMA_AVISOS) && /dato concreto/.test(SISTEMA_AVISOS_V2) && /pide_decision/.test(SISTEMA_AVISOS_V2));
  // Sin la bandera, la entrada es la de siempre: sin «concretos» y con los grupos de antes.
  const e1 = entradaAvisos({ negocio: NEG, hoy: HOY, todos, maximo: 3 });
  assert.ok(e1.datos.avisos.every((x) => !('concretos' in x) && ['control', 'ventas', 'informativo'].includes(x.grupo)));
});

// ═══ T. La tarjeta ═════════════════════════════════════════════════════════
await t('T1. la tarjeta trae hasta 3 cifras chicas; sin recomendación de Xabor no hay «qué hacer» (tampoco de la IA)', () => {
  const fila = (contenido) => ({ id: 5, tipo: 'categoria_sube', titulo: 'Título.', opinion: null, contenido });
  const con = tarjetaDe(fila({ sugerencia: 'Asegura existencias de «A».', pantalla: { encabezado: 'x', datos: ['Total del negocio +8 %', 'Sábados: 40 % del aumento', '9 a 11: 60 %', 'cuarta'] } }));
  assert.deepStrictEqual(con.datos, ['Total del negocio +8 %', 'Sábados: 40 % del aumento', '9 a 11: 60 %']);
  const sin = tarjetaDe(fila({ sugerencia: '', ia: { titulo: 'T', explicacion: 'E', sugerencia: 'Haz algo genérico.' } }));
  assert.strictEqual(sin.sugerencia, '');
  assert.strictEqual(sin.titulo, 'T');
  // Las de antes (sin cifras chicas) salen exactamente igual: sin la llave `datos`.
  const vieja = tarjetaDe(fila({ sugerencia: 'Texto.', pantalla: { encabezado: 'x' } }));
  assert.ok(!('datos' in vieja));
  const dañada = tarjetaDe(fila({ sugerencia: 'Texto.', pantalla: { datos: 'no es lista' } }));
  assert.ok(!('datos' in dañada));
  assert.ok(!('datos' in tarjetaDe(fila({ sugerencia: 'Texto.', pantalla: { datos: [1, null, '  '] } }))));
});

// ═══ A. Apagada ════════════════════════════════════════════════════════════
await t('A1. sin la bandera (sin `concretar`), las reglas dan lo mismo que antes; la bandera se llama asistente_restaurante_reglas_v2', () => {
  assert.strictEqual(BANDERA_REGLAS_V2, 'asistente_restaurante_reglas_v2');
  const s = sucursalF1();
  const a = buscarHallazgos(s);
  const b = buscarHallazgos(s, {});
  assert.deepStrictEqual(a, b);
  assert.ok(a.hallazgos.every((h) => !('concretos' in h) && !('datos' in (h.pantalla || {}))), 'sin la bandera salió algo de la Mejora 2');
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) { for (const f of fallos) console.log(`  · ${f}`); process.exit(1); }
