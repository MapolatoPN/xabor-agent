// UNA CONVERSACIÓN ENTERA, TURNO POR TURNO.
//
// Fase W del Mesero Digital. Corre la conversación completa contra una carta
// sintética y comprueba el pedido final, exacto.
//
// El modelo está simulado con un guion de borradores: es una ENTRADA del
// sistema, no parte de él. Y el guion incluye a propósito las tres cosas que
// los modelos hacen de verdad y que costaron incidentes reales:
//
//   turno 6   el modelo olvida los hotcakes al cambiar los chilaquiles
//   turno 9   el modelo reescribe el pedido entero
//   turno 10  el modelo cuela un producto que nadie pidió
//
// Ninguna debe llegar al pedido final. Con `--traza` imprime el detalle de
// cada turno: contexto antes, intención, evidencia, referencia, propuesta,
// decisión, contexto después.
import assert from 'node:assert/strict';

const { atenderTurno, contextoSerializable } = await import('../src/mesero-whatsapp/meseroDigital.js');
const { resumenEnTexto } = await import('../src/mesero-whatsapp/resumenDelPedido.js');
const { pareceSensible } = await import('../src/mesero-whatsapp/metricasMesero.js');

const TRAZA = process.argv.includes('--traza');
let ok = 0, fail = 0; const fallos = [];
function t(nombre, fn) {
  try { fn(); ok++; console.log(`  OK  ${nombre}`); }
  catch (e) { fail++; fallos.push(`${nombre}: ${e.message}`); console.log(`FALLO ${nombre}: ${e.message}`); }
}

// ── La carta ────────────────────────────────────────────────────────────────
const g = (nombre, opciones, requerido = false) => ({
  nombre, requerido, minimo: requerido ? 1 : 0, maximo: 1,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});
const CATALOGO = [
  { id: 1, nombre: 'Fuertes', productos: [
    { id: 11, nombre: 'Chilaquiles', precio: 130, disponible: true, agotado: false,
      descripcion: 'Totopos bañados, con proteína. Bien llenador.',
      modificadores: [g('Salsa', ['Salsa Verde', 'Salsa Roja'], true), g('Proteina', ['Pollo', 'Res'], true)] },
    { id: 12, nombre: 'Hotcakes', precio: 95, disponible: true, agotado: false,
      descripcion: 'Tres piezas con mantequilla. Ligero y dulce.', modificadores: [] },
  ] },
  { id: 2, nombre: 'Bebidas', productos: [
    { id: 21, nombre: 'Coca Cola', precio: 35, disponible: true, agotado: false, modificadores: [] },
    { id: 22, nombre: 'Agua Mineral', precio: 30, disponible: true, agotado: false, modificadores: [] },
  ] },
];
const PRECIOS = { Chilaquiles: 130, Hotcakes: 95, 'Coca Cola': 35, 'Agua Mineral': 30 };

// ── El guion del modelo ─────────────────────────────────────────────────────
const chil = (extra = {}) => ({ nombre: 'Chilaquiles', cantidad: 1, modificadores: [], notas: '', ...extra });
const mod = (grupo, ...opciones) => ({ grupo, opciones });

const GUION = [
  { cliente: 'Hola, qué me recomiendas?', borrador: null },
  { cliente: 'algo llenador', borrador: null },
  { cliente: 'va unos chilaquiles', borrador: { items: [chil()] } },
  { cliente: 'con pollo', borrador: { items: [chil({ modificadores: [mod('Proteina', 'Pollo')] })] } },
  { cliente: 'y unos hotcakes para ella',
    borrador: { items: [chil({ modificadores: [mod('Proteina', 'Pollo')] }), { nombre: 'Hotcakes', cantidad: 1 }] } },
  // El modelo cambia los chilaquiles y OLVIDA los hotcakes.
  { cliente: 'los chilaquiles mejor rojos y sin cebolla',
    borrador: { items: [chil({ modificadores: [mod('Salsa', 'Salsa Roja'), mod('Proteina', 'Pollo')], notas: 'sin cebolla' })] } },
  { cliente: 'qué bebidas tienes?', borrador: null },
  { cliente: 'una coca',
    borrador: { items: [chil({ modificadores: [mod('Salsa', 'Salsa Roja'), mod('Proteina', 'Pollo')], notas: 'sin cebolla' }),
      { nombre: 'Hotcakes', cantidad: 1 }, { nombre: 'Coca Cola', cantidad: 1 }] } },
  // El modelo reescribe el pedido entero para cambiar una cantidad.
  { cliente: 'mejor dos',
    borrador: { items: [chil({ modificadores: [mod('Salsa', 'Salsa Roja'), mod('Proteina', 'Pollo')], notas: 'sin cebolla' }),
      { nombre: 'Hotcakes', cantidad: 1 }, { nombre: 'Coca Cola', cantidad: 2 }] } },
  // …y de paso cuela un Agua Mineral que nadie pidió.
  { cliente: 'para recoger',
    borrador: { items: [chil({ modificadores: [mod('Salsa', 'Salsa Roja'), mod('Proteina', 'Pollo')], notas: 'sin cebolla' }),
      { nombre: 'Hotcakes', cantidad: 1 }, { nombre: 'Coca Cola', cantidad: 2 }, { nombre: 'Agua Mineral', cantidad: 1 }],
      modalidad: 'recoger' } },
  { cliente: 'efectivo', borrador: { items: [], forma_pago: 'efectivo' } },
  { cliente: 'sí, así está bien', borrador: null },
];

// ── La conversación ─────────────────────────────────────────────────────────
const NEG = 'negocio-e2e';
const CONV = 'conv-e2e';
let contexto = null, carrito = null;
const turnos = [];
const todosLosEventos = [];

for (const [i, paso] of GUION.entries()) {
  const antes = contexto ? { fase: contexto.fase, foco: contexto.foco, lineas: contexto.lineas.length } : null;
  const r = await atenderTurno({
    negocioId: NEG, conversacionId: CONV, mensaje: paso.cliente,
    contextoGuardado: contexto, carrito, catalogo: CATALOGO, precios: PRECIOS,
    complementos: { Fuertes: ['Bebidas'] },
    proponer: async () => paso.borrador,
  });
  // El contexto viaja por JSON entre turnos, como en producción.
  contexto = JSON.parse(JSON.stringify(contextoSerializable(r.contexto)));
  carrito = r.carrito;
  todosLosEventos.push(...r.eventos);
  turnos.push({ n: i + 1, cliente: paso.cliente, antes, r });

  if (TRAZA) {
    console.log(`\n─── turno ${i + 1} · «${paso.cliente}»`);
    console.log(`  antes        ${JSON.stringify(antes)}`);
    console.log(`  intenciones  ${r.intenciones.join(', ')}`);
    console.log(`  referencia   ${r.referencia?.tipo || '—'} ${r.referencia?.resuelta ? '→ ' + r.referencia.lids : (r.referencia?.tipo ? '(sin resolver: ' + r.referencia.motivo + ')' : '')}`);
    console.log(`  propuestas   ${r.decisiones.map((d) => `${d.propuesta.accion}${d.propuesta.campo ? ':' + d.propuesta.campo : ''}=${d.decision}`).join(', ') || '—'}`);
    console.log(`  bloqueado    conservados=${JSON.stringify(r.cambios?.conservados || [])} sin_respaldo=${JSON.stringify((r.cambios?.sinRespaldo || []).map((x) => x.nombre))}`);
    console.log(`  consulta     ${r.consulta?.tipo || '—'}`);
    console.log(`  recomienda   ${r.recomendaciones.map((x) => x.nombre).join(', ') || '—'}`);
    console.log(`  aclara       ${r.aclaraciones.map((a) => a.tipo).join(', ') || '—'}`);
    console.log(`  despues      fase=${r.fase} foco=${r.contexto.foco} falta=${JSON.stringify(r.falta)} siguiente=${r.siguiente}`);
    console.log(`  pedido       ${r.carrito.items.map((x) => `${x.cantidad}x ${x.nombre}`).join(' | ') || '—'}`);
  }
}

const ultimo = turnos.at(-1).r;
const porNombre = (n) => carrito.items.filter((i) => i.nombre === n);
const opcionesDe = (item) => (item.modificadores || []).flatMap((m) => m.opciones || []);

// ── EL PEDIDO FINAL, EXACTO ─────────────────────────────────────────────────

t('W1. el pedido final tiene exactamente tres renglones', () => {
  assert.deepEqual(carrito.items.map((i) => `${i.cantidad}x ${i.nombre}`),
    ['1x Chilaquiles', '1x Hotcakes', '2x Coca Cola'],
    JSON.stringify(carrito.items.map((i) => ({ n: i.nombre, c: i.cantidad })), null, 1));
});

t('W2. los chilaquiles llevan salsa roja, pollo y la nota', () => {
  const c = porNombre('Chilaquiles')[0];
  assert(c, 'desaparecieron los chilaquiles');
  assert.deepEqual(opcionesDe(c).sort(), ['Pollo', 'Salsa Roja']);
  assert.equal(c.notas, 'sin cebolla');
});

t('W3. los hotcakes sobrevivieron al turno en que el modelo los olvidó', () => {
  assert.equal(porNombre('Hotcakes').length, 1,
    'la omisión del modelo borró un platillo que el cliente sí pidió');

  // OMITIR NO ES UN ACTO, y ahora se ve dos veces.
  //
  // El turno 6 no produce NINGUNA propuesta sobre los hotcakes: el borrador no
  // los menciona, y no mencionar algo no es pedir nada sobre ello. Antes del
  // mesero la protección estaba una capa más abajo —el reconciliador conservaba
  // lo omitido— y sigue estando; lo que cambia es que ahora la omisión ni
  // siquiera llega a plantearse como un cambio.
  const t6 = turnos[5].r;
  const sobreHotcakes = t6.decisiones.filter((d) => {
    const v = d.propuesta?.valorNuevo;
    return /hotcakes/i.test(JSON.stringify(v ?? '')) || d.propuesta?.lid === lidDe('Hotcakes', turnos[4].r.carrito);
  });
  assert.deepEqual(sobreHotcakes, [], `el turno 6 propuso algo sobre los hotcakes: ${JSON.stringify(sobreHotcakes)}`);

  // Y el renglón salió idéntico, con el mismo `lid`: no se borró y se volvió a
  // crear, que es la otra forma de perder un platillo sin que se note.
  const antes = turnos[4].r.carrito.items.find((i) => i.nombre === 'Hotcakes');
  const despues = t6.carrito.items.find((i) => i.nombre === 'Hotcakes');
  assert(despues, 'los hotcakes desaparecieron en el turno 6');
  assert.equal(despues.lid, antes.lid, 'los hotcakes se recrearon: perdieron su identidad');
  assert.equal(despues.cantidad, antes.cantidad);
});

function lidDe(nombre, carritoDeEseTurno) {
  return (carritoDeEseTurno?.items || []).find((i) => i.nombre === nombre)?.lid || null;
}

t('W4. el Agua Mineral que el modelo coló nunca entró', () => {
  assert.equal(porNombre('Agua Mineral').length, 0, 'entró un producto que nadie pidió');
  const t10 = turnos[9].r;
  assert(t10.cambios.sinRespaldo.some((s) => s.nombre === 'Agua Mineral'),
    `no quedó rastro del rechazo: ${JSON.stringify(t10.cambios.sinRespaldo)}`);
});

t('W5. «mejor dos» subió la cantidad de la coca y de nada más', () => {
  assert.equal(porNombre('Coca Cola')[0].cantidad, 2);
  assert.equal(porNombre('Chilaquiles')[0].cantidad, 1, 'se contagió la cantidad');
  assert.equal(porNombre('Hotcakes')[0].cantidad, 1, 'se contagió la cantidad');
});

t('W6. modalidad y pago quedaron, y sin tocar la comida', () => {
  assert.equal(carrito.datos.modalidad, 'recoger');
  assert.equal(carrito.datos.forma_pago, 'efectivo');
  const t11 = turnos[10].r;
  assert.equal(t11.carrito.items.length, 3, 'contestar la forma de pago cambió los artículos');
});

t('W7. el total sale de los precios del negocio, no del modelo', () => {
  // 130 + 95 + 2×35 = 295
  assert.equal(ultimo.resumen.total, 295);
  assert.equal(ultimo.resumen.completo, true);
});

// ── EL CAMINO, NO SOLO EL DESTINO ───────────────────────────────────────────

t('W8. la pregunta por las bebidas no agregó ninguna bebida', () => {
  const t7 = turnos[6].r;
  assert.equal(t7.consulta.tipo, 'categoria');
  assert.equal(t7.consulta.categoria.nombre, 'Bebidas');
  assert.equal(t7.carrito.items.length, 2, 'la consulta metió algo al pedido');
});

t('W9. el bot recomendó cuando se lo pidieron, y solo de la carta', () => {
  const t2 = turnos[1].r;
  assert(t2.recomendaciones.length > 0, 'no contestó a quien le pidió una recomendación');
  const enCarta = ['Chilaquiles', 'Hotcakes', 'Coca Cola', 'Agua Mineral'];
  for (const r of t2.recomendaciones) assert(enCarta.includes(r.nombre), `${r.nombre} no está en la carta`);
  assert.equal(t2.recomendaciones[0].nombre, 'Chilaquiles', '«algo llenador» no encontró lo llenador');
});

t('W10. mientras el cliente corregía, el bot no ofreció nada', () => {
  const t6 = turnos[5].r;   // «los chilaquiles mejor rojos y sin cebolla»
  assert.deepEqual(t6.recomendaciones, [], 'interrumpió una corrección para vender');
});

t('W11. el grupo requerido faltante se preguntó, y dejó de preguntarse al llenarse', () => {
  const t3 = turnos[2].r;   // chilaquiles sin salsa ni proteína
  assert(t3.aclaraciones.some((a) => a.tipo === 'grupo_requerido'), JSON.stringify(t3.aclaraciones));
  assert.equal(t3.fase, 'completando_producto');
  const t6 = turnos[5].r;   // ya tiene salsa y proteína
  assert(!t6.aclaraciones.some((a) => a.tipo === 'grupo_requerido'),
    `siguió preguntando por un grupo ya elegido: ${JSON.stringify(t6.aclaraciones)}`);
});

t('W12. la fase avanzó sin encerrar a nadie', () => {
  const fases = turnos.map((x) => x.r.fase);
  assert.equal(fases[0], 'explorando_menu');
  assert.equal(fases.at(-1), 'confirmando', JSON.stringify(fases));
  assert(fases.includes('esperando_modalidad'), JSON.stringify(fases));
});

t('W13. al final no queda nada abierto y se puede confirmar', () => {
  assert.deepEqual(ultimo.falta, []);
  assert.deepEqual(ultimo.aclaraciones, []);
  assert.equal(ultimo.listoParaConfirmar, true);
});

t('W14. el resumen legible dice exactamente lo que hay', () => {
  const texto = resumenEnTexto(ultimo.resumen);
  assert(/1× Chilaquiles/.test(texto), texto);
  assert(/Salsa Roja/.test(texto) && /Pollo/.test(texto));
  assert(/sin cebolla/.test(texto));
  assert(/2× Coca Cola/.test(texto));
  assert(!/Agua Mineral/.test(texto), 'el resumen enseñó algo que no está en el pedido');
  assert(/Total: \$295/.test(texto));
});

t('W15. el briefing al modelo lleva hechos, no frases hechas', () => {
  const b = turnos[2].r.paraElModelo;    // el turno con el grupo requerido abierto
  assert.equal(b.aclaraciones[0].pregunta, undefined, 'se le pasó la redacción y la va a copiar');
  assert.equal(b.aclaraciones[0].tipo, 'grupo_requerido');
  assert(Array.isArray(b.aclaraciones[0].candidatos));
  assert.equal(b.pedido.items[0].nombre, 'Chilaquiles');
});

t('W16. las métricas no llevan teléfono, correo ni el texto del cliente', () => {
  assert.equal(pareceSensible(todosLosEventos), false, 'una métrica llevó algo que parece PII');
  const todo = todosLosEventos.join('\n');
  assert(!/qué bebidas|mejor dos|para ella/.test(todo), 'se registró lo que escribió el cliente');
  assert(/whatsapp_mesero_invento_bloqueado/.test(todo), 'no se midió la invención que se frenó');
  assert(/whatsapp_mesero_recomendacion\b/.test(todo));
});

t('W17. el contexto viajó por JSON los doce turnos sin perder el hilo', () => {
  assert.equal(ultimo.contexto.contador >= 12, true);
  assert.equal(ultimo.contexto.negocioId, NEG);
  assert.equal(ultimo.contexto.lineas.length, 3);
  // El orden de aparición sigue diciendo quién llegó primero.
  const orden = ultimo.contexto.lineas.slice().sort((a, b) => a.orden - b.orden).map((l) => l.lid);
  assert.deepEqual(orden, carrito.items.map((i) => i.lid));
});

if (TRAZA) {
  console.log('\n─── pedido final ───');
  console.log(resumenEnTexto(ultimo.resumen));
}

console.log(`\n${fail === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${ok} pasadas, ${fail} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
process.exit(fail ? 1 : 0);
