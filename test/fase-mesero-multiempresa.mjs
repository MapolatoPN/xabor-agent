// CUATRO NEGOCIOS EN EL MISMO PROCESO, Y NINGUNO SE ENTERA DE LOS OTROS.
//
// Fases V e Y del Mesero Digital.
//
// Xabor es un solo proceso con muchos negocios dentro, y el incidente del 12 de
// septiembre fue exactamente eso: un despliegue pensado para observar a UN
// negocio le cambió el motor a otros dos que tenían el bot encendido. Esta
// suite existe para que esa clase de error se vea en una prueba y no en
// producción.
//
// Los cuatro modos, con los mensajes INTERCALADOS —A, B, C, D, A, B, C, D— para
// que un estado compartido se note:
//
//   A  LEGACY    ni siquiera llama al mesero
//   B  MESERO    productivo
//   C  SOMBRA    observa y no contesta
//   D  TAKEOVER  una persona atiende; el bot calla
//
// Cada uno con SU carta, y las cartas no comparten un solo producto.
import assert from 'node:assert/strict';

const { atenderTurno, contextoSerializable } = await import('../src/mesero/meseroDigital.js');
const { modoDelPedido } = await import('../src/orders/modoDelPedido.js');
const sombra = await import('../src/mesero/sombraDelMesero.js');
const { observarTurnoDelMesero, reiniciarSombraMesero, conversacionesObservadas,
  textoSeguro, TOPE_TURNOS } = sombra;

let ok = 0, fail = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); ok++; console.log(`  OK  ${nombre}`); }
  catch (e) { fail++; fallos.push(`${nombre}: ${e.message}`); console.log(`FALLO ${nombre}: ${e.message}`); }
}

const prod = (id, nombre, precio, extra = {}) => ({
  id, nombre, precio, disponible: true, agotado: false, descripcion: '', modificadores: [], ...extra });

// Cuatro cartas sin una palabra en común.
const CARTAS = {
  A: [{ id: 1, nombre: 'Tortas', productos: [prod(1, 'Torta Ahogada', 90, { destacado: true })] }],
  B: [{ id: 2, nombre: 'Ramen', productos: [prod(2, 'Tonkotsu', 190, { destacado: true })] },
    { id: 3, nombre: 'Bebidas B', productos: [prod(3, 'Te Verde', 40, { destacado: true })] }],
  C: [{ id: 4, nombre: 'Pizzas', productos: [prod(4, 'Margarita', 160, { destacado: true })] }],
  D: [{ id: 5, nombre: 'Mariscos', productos: [prod(5, 'Aguachile', 210, { destacado: true })] }],
};
const NEG = { A: 'neg-a', B: 'neg-b', C: 'neg-c', D: 'neg-d' };
const lector = (cfg) => async () => cfg;

// ── LOS MODOS ───────────────────────────────────────────────────────────────

await t('Y1. el default es LEGACY: un negocio sin configurar no participa de nada', async () => {
  const m = await modoDelPedido(NEG.A, { leerConfiguracion: lector({}) });
  assert.deepEqual({ v2: m.v2, shadow: m.shadow, mesero: m.mesero, meseroSombra: m.meseroSombra },
    { v2: false, shadow: false, mesero: false, meseroSombra: false });
  assert.equal(m.modo, 'legacy');
});

await t('Y2. los cuatro negocios resuelven a cuatro modos distintos, a la vez', async () => {
  const antes = process.env.MESERO_SHADOW_MODE;
  try {
    process.env.MESERO_SHADOW_MODE = 'true';
    const cfgs = {
      A: {},
      B: { pedido_reconciliador_v2: 'true', mesero_whatsapp_v1: 'true' },
      C: { mesero_whatsapp_shadow: 'true' },
      D: { pedido_reconciliador_v2: 'true' },
    };
    const modos = {};
    for (const k of ['A', 'B', 'C', 'D']) {
      modos[k] = await modoDelPedido(NEG[k], { leerConfiguracion: lector(cfgs[k]) });
    }
    assert.equal(modos.A.modo, 'legacy');
    assert.equal(modos.B.modo, 'mesero');
    assert.equal(modos.C.modo, 'legacy');
    assert.equal(modos.C.meseroSombra, true, 'el negocio en sombra no quedó observado');
    assert.equal(modos.D.modo, 'v2');
    assert.equal(modos.D.mesero, false, 'V2 sin la bandera del mesero encendió el mesero');
  } finally {
    if (antes === undefined) delete process.env.MESERO_SHADOW_MODE; else process.env.MESERO_SHADOW_MODE = antes;
  }
});

// ── SIN CONTAMINACIÓN, CON MENSAJES INTERCALADOS ────────────────────────────

await t('Y3. catálogo, contexto y pedido no se cruzan entre negocios', async () => {
  const estado = { A: { ctx: null, car: null }, B: { ctx: null, car: null },
    C: { ctx: null, car: null }, D: { ctx: null, car: null } };
  const guion = [
    ['B', 'quiero un tonkotsu'],
    ['C', 'quiero una margarita'],
    ['D', 'quiero un aguachile'],
    ['B', 'y un te verde'],
    ['C', 'que tienen?'],
    ['D', 'mejor dos'],
    ['B', 'para recoger'],
    ['C', 'para recoger'],
  ];
  const vistos = [];
  for (const [neg, mensaje] of guion) {
    const r = await atenderTurno({
      negocioId: NEG[neg], conversacionId: `conv-${neg}`, mensaje,
      contextoGuardado: estado[neg].ctx, carrito: estado[neg].car,
      catalogo: CARTAS[neg],
      // El "modelo" propone exactamente lo que el cliente nombró, y solo eso.
      proponer: async ({ carrito }) => {
        const nombres = (CARTAS[neg][0].productos.concat(CARTAS[neg][1]?.productos || []))
          .map((p) => p.nombre)
          .filter((n) => mensaje.toLowerCase().includes(n.toLowerCase().split(' ')[0]));
        const previos = (carrito?.items || []).map((x) => ({ ...x }));
        for (const n of nombres) if (!previos.some((p) => p.nombre === n)) previos.push({ nombre: n, cantidad: 1 });
        return { items: previos, ...(/recoger/.test(mensaje) ? { modalidad: 'recoger' } : {}) };
      },
    });
    estado[neg].ctx = JSON.parse(JSON.stringify(contextoSerializable(r.contexto)));
    estado[neg].car = r.carrito;
    vistos.push({ neg, r });
  }

  const nombresDe = (k) => (estado[k].car?.items || []).map((i) => i.nombre).sort();
  assert.deepEqual(nombresDe('B'), ['Te Verde', 'Tonkotsu'], JSON.stringify(nombresDe('B')));
  assert.deepEqual(nombresDe('C'), ['Margarita'], JSON.stringify(nombresDe('C')));
  assert.deepEqual(nombresDe('D'), ['Aguachile'], JSON.stringify(nombresDe('D')));

  // Los datos operativos tampoco se cruzan: B y C dijeron 'para recoger', D no.
  assert.equal(estado.B.car.datos.modalidad, 'recoger');
  assert.equal(estado.C.car.datos.modalidad, 'recoger');
  assert.equal(estado.D.car.datos.modalidad, undefined, 'D heredo una modalidad que nadie le dijo');

  // Ni un producto de otra carta en ningún pedido.
  const ajenos = { B: ['Torta', 'Margarita', 'Aguachile'], C: ['Torta', 'Tonkotsu', 'Aguachile'],
    D: ['Torta', 'Tonkotsu', 'Margarita'] };
  for (const [k, prohibidos] of Object.entries(ajenos)) {
    for (const p of prohibidos) {
      assert(!nombresDe(k).some((n) => n.includes(p)), `${p} se coló en el pedido de ${k}`);
    }
  }

  // La consulta de C se contesta con la carta de C.
  const consultaC = vistos.find((v) => v.neg === 'C' && v.r.consulta);
  assert(consultaC, 'no se contestó la consulta');
  assert.equal(JSON.stringify(consultaC.r.consulta).includes('Tonkotsu'), false,
    'la carta de otro negocio contestó la pregunta');

  // El contexto de cada uno cuenta solo sus turnos.
  assert.equal(estado.B.ctx.negocioId, NEG.B);
  assert.equal(estado.C.ctx.negocioId, NEG.C);
  assert.equal(estado.B.ctx.turnos.filter((x) => x.rol === 'cliente').length, 3);
  assert.equal(estado.D.ctx.turnos.filter((x) => x.rol === 'cliente').length, 2);
});

await t('Y4. las recomendaciones de un negocio no aparecen en otro', async () => {
  const rec = {};
  for (const k of ['A', 'B', 'C', 'D']) {
    const r = await atenderTurno({
      negocioId: NEG[k], conversacionId: `rec-${k}`, mensaje: 'que me recomiendas?',
      catalogo: CARTAS[k], proponer: async () => null,
    });
    rec[k] = r.recomendaciones.map((x) => x.nombre);
    assert(rec[k].length > 0, `${k} no recomendó nada`);
  }
  const todos = Object.values(rec).flat();
  assert.equal(new Set(todos).size, todos.length, `una recomendación se repitió entre negocios: ${JSON.stringify(rec)}`);
  assert(rec.B.includes('Tonkotsu') || rec.B.includes('Te Verde'), JSON.stringify(rec.B));
  assert(!rec.B.includes('Margarita'));
});

await t('Y5. una conversación del mismo teléfono en dos negocios no se mezcla', async () => {
  // El mismo cliente escribe a dos negocios: el id de conversación coincide.
  const enB = await atenderTurno({
    negocioId: NEG.B, conversacionId: 'mismo-telefono', mensaje: 'quiero un tonkotsu',
    catalogo: CARTAS.B, proponer: async () => ({ items: [{ nombre: 'Tonkotsu', cantidad: 1 }] }),
  });
  const ctxB = JSON.parse(JSON.stringify(contextoSerializable(enB.contexto)));
  // …y ese contexto se le pasa por error al otro negocio.
  const enC = await atenderTurno({
    negocioId: NEG.C, conversacionId: 'mismo-telefono', mensaje: 'que tienen?',
    contextoGuardado: ctxB, carrito: enB.carrito, catalogo: CARTAS.C, proponer: async () => null,
  });
  assert.equal(enC.contexto.negocioId, NEG.C);
  assert.equal(enC.contexto.turnos.filter((x) => x.rol === 'cliente').length, 1,
    'el historial del otro negocio se coló');
  assert.equal(JSON.stringify(enC.consulta).includes('Tonkotsu'), false);
});

// ── FASE V — la sombra del mesero ───────────────────────────────────────────

await t('V1. observar NO devuelve respuesta, ni pedido, ni nada que enviar', async () => {
  reiniciarSombraMesero();
  const r = await observarTurnoDelMesero({
    sessionId: 'meta-x-555', negocioId: NEG.B, mensaje: 'quiero un tonkotsu',
    cargarCatalogo: async () => CARTAS.B,
    proponer: async () => ({ items: [{ nombre: 'Tonkotsu', cantidad: 1 }] }),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.texto, undefined, 'la sombra produjo un texto para enviar');
  assert.equal(r.pedido, undefined, 'la sombra produjo un pedido');
  assert.equal(r.resumen.renglones, 1, 'la sombra ni siquiera observó');
});

await t('V2. la sombra NO toca el carrito productivo que se le presta', async () => {
  reiniciarSombraMesero();
  const productivo = { items: [{ lid: 'P1', nombre: 'Tonkotsu', cantidad: 1, modificadores: [], notas: '' }], datos: {} };
  const copiaAntes = JSON.stringify(productivo);
  await observarTurnoDelMesero({
    sessionId: 'meta-x-556', negocioId: NEG.B, mensaje: 'ponme dos',
    carritoProductivo: productivo, cargarCatalogo: async () => CARTAS.B,
    proponer: async () => ({ items: [{ nombre: 'Tonkotsu', cantidad: 2 }] }),
  });
  assert.equal(JSON.stringify(productivo), copiaAntes, 'la observación modificó el pedido real');
});

await t('V3. dos conversaciones observadas no comparten estado', async () => {
  reiniciarSombraMesero();
  const uno = async (sid, msg, nombre) => observarTurnoDelMesero({
    sessionId: sid, negocioId: NEG.B, mensaje: msg, cargarCatalogo: async () => CARTAS.B,
    proponer: async () => ({ items: [{ nombre, cantidad: 1 }] }),
  });
  await uno('conv-1', 'quiero un tonkotsu', 'Tonkotsu');
  const b = await uno('conv-2', 'quiero un te verde', 'Te Verde');
  assert.equal(b.resumen.renglones, 1, 'la segunda conversación heredó el pedido de la primera');
  assert.equal(conversacionesObservadas(), 2);
});

await t('V4. un modelo que falla no rompe nada: la observación se contiene', async () => {
  reiniciarSombraMesero();
  const r = await observarTurnoDelMesero({
    sessionId: 'conv-err', negocioId: NEG.B, mensaje: 'quiero un tonkotsu',
    cargarCatalogo: async () => { throw new Error('base caida'); },
    proponer: async () => { throw new Error('modelo caido'); },
  });
  // Un fallo del modelo se convierte en handoff DENTRO de la copia; nada sale.
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.resumen.fase, 'escalado_humano');
  assert.equal(r.resumen.renglones, 0);
});

await t('V5. un observador lento se abandona; el turno real no lo espera', async () => {
  reiniciarSombraMesero();
  const inicio = Date.now();
  const r = await observarTurnoDelMesero({
    sessionId: 'conv-lenta', negocioId: NEG.B, mensaje: 'hola',
    cargarCatalogo: () => new Promise((res) => setTimeout(() => res(CARTAS.B), 5000)),
    proponer: async () => null, tope: 120,
  });
  const ms = Date.now() - inicio;
  assert(ms < 2000, `la observación retuvo ${ms} ms`);
  assert.equal(r.ok, true, JSON.stringify(r));
});

await t('V6. hay tope de turnos por conversación y de conversaciones', async () => {
  reiniciarSombraMesero();
  for (let i = 0; i <= TOPE_TURNOS + 2; i++) {
    var ultima = await observarTurnoDelMesero({
      sessionId: 'conv-larga', negocioId: NEG.B, mensaje: `mensaje ${i}`,
      cargarCatalogo: async () => CARTAS.B, proponer: async () => null,
    });
  }
  assert.equal(ultima.ok, false);
  assert.equal(ultima.motivo, 'tope_de_turnos');
});

await t('V7. la línea de sombra no lleva teléfono ni el mensaje entero', async () => {
  reiniciarSombraMesero();
  const r = await observarTurnoDelMesero({
    sessionId: 'meta-negb-528781234567', negocioId: NEG.B,
    mensaje: 'soy Ana, mi telefono es 8781234567 y vivo en Hidalgo 4521',
    cargarCatalogo: async () => CARTAS.B, proponer: async () => null,
  });
  assert.equal(r.ok, true);
  assert(!/8781234567|528781234567|4521/.test(r.linea), `se filtró un número: ${r.linea}`);
  assert(/conv=[0-9a-f]{10}/.test(r.linea), r.linea);
  assert.equal(textoSeguro('llamame al 8781234567'), 'llamame al ###');
});

await t('V8. el módulo de sombra no importa nada que pueda hablarle a un cliente', async () => {
  const { readFileSync } = await import('node:fs');
  const fuente = readFileSync(new URL('../src/mesero/sombraDelMesero.js', import.meta.url), 'utf8');
  const imports = [...fuente.matchAll(/^import[^;]*from '([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(),
    ['./contextoMesa.js', './meseroDigital.js', 'node:crypto'],
    `la sombra importa algo que no debería: ${JSON.stringify(imports)}`);
  for (const prohibido of ['whatsapp', 'enviarMensaje', 'registrarPedido', 'imprimir', 'clip']) {
    assert(!new RegExp(prohibido, 'i').test(fuente.replace(/^\/\/.*$/gm, '')),
      `la sombra menciona "${prohibido}" fuera de los comentarios`);
  }
});

console.log(`\n${fail === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${ok} pasadas, ${fail} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
process.exit(fail ? 1 : 0);
