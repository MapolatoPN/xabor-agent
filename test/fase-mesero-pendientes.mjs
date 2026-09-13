// ─── Los pendientes, después del primer día de tráfico real ───────────────
//
// P1–P14 del mandato del 13-sep. Todo lo de aquí sale de UNA observación: el
// Mesero Shadow de Obispado atendió 46 turnos y en 21 de ellos escaló por
// DEMASIADAS_ACLARACIONES sin que el cliente hubiera fallado en contestar nada.
//
// Las tres causas, y cada una tiene su bloque:
//
//   la pregunta pegada     el pendiente guardaba la FRASE redactada, así que
//                          seguía viva aunque su motivo ya no existiera
//   el contador ciego      `veces` subía con cualquier turno, incluido el que
//                          hablaba de otra cosa
//   el handoff terminal    en sombra detenía la observación justo donde la
//                          conversación se ponía interesante
//
// Suite pura: no toca base, ni canal, ni red. El «modelo» es una función que
// devuelve lo que se le diga.
import assert from 'node:assert/strict';
import { atenderTurno } from '../src/mesero-whatsapp/meseroDigital.js';
import {
  contextoDeLaConversacion, sincronizarPendientes, clavePendiente,
  anotarIntentoFallido, marcarPreguntado, preguntadoRecientemente,
} from '../src/mesero-whatsapp/contextoMesa.js';
import {
  redactarDireccion, redactarContacto, palabrasDeLaCarta, MARCA_DIRECCION,
} from '../src/mesero-whatsapp/redaccionPII.js';
import {
  registroDelTurno, textoSeguro, pareceSensibleElRegistro,
} from '../src/mesero-whatsapp/sombraDelMesero.js';
import { TOPE_ACLARACIONES } from '../src/mesero-whatsapp/handoffHumano.js';

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

// ── LA CARTA DEL MANDATO ─────────────────────────────────────────────────
//
// Chilaquiles con una guarnición de cuatro opciones, dos de las cuales empiezan
// igual. Es la carta que produjo el caso real y la mínima que lo reproduce.
const grupo = (nombre, opciones, requerido = false) => ({
  nombre, requerido, minimo: requerido ? 1 : 0, maximo: 1,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});
const GUARNICIONES = ['Frijolitos naturales', 'Frijolitos con chorizo',
  'Papas naturales', 'Papas a la mexicana'];
const PRESENTACIONES = ['Sencillos', 'Mixtos', 'Bowl', 'Combito'];

const CARTA = [
  {
    id: 1,
    nombre: 'Desayunos',
    productos: [
      { id: 11, nombre: 'Chilaquiles', precio: 120, disponible: true, agotado: false,
        modificadores: [grupo('Guarnicion', GUARNICIONES)] },
      { id: 12, nombre: 'Chilaquiles suizos con pollo', precio: 150, disponible: true, agotado: false,
        modificadores: [grupo('Presentacion', PRESENTACIONES, true)] },
    ],
  },
  {
    id: 2,
    nombre: 'Bebidas',
    productos: [
      { id: 21, nombre: 'Licuado de fresa', precio: 60, disponible: true, agotado: false, modificadores: [] },
      { id: 22, nombre: 'Licuado de platano', precio: 60, disponible: true, agotado: false, modificadores: [] },
      { id: 23, nombre: 'Jugo de naranja', precio: 45, disponible: true, agotado: false, modificadores: [] },
    ],
  },
];

// ── El modelo, simulado ──────────────────────────────────────────────────
//
// Un borrador por turno, escrito a mano. El modelo es una ENTRADA del sistema,
// no parte de él, y en los turnos ambiguos se le hace acertar a una de las dos
// candidatas a propósito: es justo lo que hace de verdad, y lo que el código
// tiene que frenar.
const it = (nombre, modificadores = [], extra = {}) => ({ nombre, cantidad: 1, modificadores, notas: '', ...extra });
const guar = (...opciones) => ({ grupo: 'Guarnicion', opciones });
const pres = (...opciones) => ({ grupo: 'Presentacion', opciones });

/** Encadena turnos. Cada paso es `{ cliente, borrador }`. */
async function conversar(guion, extra = {}) {
  let contexto = null; let carrito = null;
  const fuera = [];
  for (const paso of guion) {
    const r = await atenderTurno({
      negocioId: 'n-test', conversacionId: 'c-test',
      mensaje: paso.cliente, catalogo: CARTA, requierePago: false,
      contextoGuardado: contexto, carrito,
      proponer: async () => paso.borrador ?? null,
      ...extra,
    });
    contexto = JSON.parse(JSON.stringify(r.contexto));
    carrito = r.carrito;
    fuera.push(r);
  }
  return fuera;
}

// Los guiones que se reutilizan.
const CHILAQUILES = { cliente: 'Quiero unos chilaquiles', borrador: { items: [it('Chilaquiles')] } };
// El modelo elige una de las dos de frijolitos por su cuenta. No debe pasar.
const FRIJOLITOS = { cliente: 'Frijolitos',
  borrador: { items: [it('Chilaquiles', [guar('Frijolitos naturales')])] } };
const opcionesDe = (carrito, nombre = /chilaquil/i) => {
  const item = (carrito?.items || []).find((i) => nombre.test(i.nombre));
  return (item?.modificadores || []).flatMap((g) => g.opciones || [])
    .map((o) => (typeof o === 'string' ? o : o.nombre)).sort();
};

const pendientesDe = (r) => (r.contexto.pendientes || []);
const clavesDe = (r) => pendientesDe(r).map((p) => p.clave);
const pideGuarnicion = (r) => pendientesDe(r).find((p) => p.grupo === 'Guarnicion') || null;

// ═══════════════════════════════════════════════════════════════════════════
// EL CASO DE LOS FRIJOLITOS, TURNO POR TURNO (T1–T5 del mandato)
// ═══════════════════════════════════════════════════════════════════════════

const LICUADOS = { cliente: '¿Qué licuados tienen?', borrador: null };
const FRESA = { cliente: 'Y uno de fresa',
  borrador: { items: [it('Chilaquiles'), it('Licuado de fresa')] } };
const CON_CHORIZO = { cliente: 'Los frijolitos con chorizo',
  borrador: { items: [it('Chilaquiles', [guar('Frijolitos con chorizo')]), it('Licuado de fresa')] } };

await t('T1–T2. «frijolitos» detecta dos candidatos, no elige, y deja un pendiente estructurado', async () => {
  const [, t2] = await conversar([CHILAQUILES, FRIJOLITOS]);
  const p = pideGuarnicion(t2);
  assert(p, `no quedó pendiente de la guarnición: ${JSON.stringify(clavesDe(t2))}`);
  assert.deepEqual(p.candidatos.slice().sort(), ['Frijolitos con chorizo', 'Frijolitos naturales']);
  assert.equal(p.tipo, 'opcion_ambigua');
  assert(p.lid, 'el pendiente no sabe de qué renglón es');
  assert.equal(p.intentos, 0);
  // Y lo que NO se guarda: la frase.
  assert(!Object.values(p).some((v) => typeof v === 'string' && v.includes('¿')),
    `el pendiente guardó una pregunta redactada: ${JSON.stringify(p)}`);
  assert.deepEqual(opcionesDe(t2.carrito), [], 'eligió sin preguntar');
});

await t('T3. una consulta nueva conserva el pendiente y NO cuenta como intento fallido', async () => {
  const [, t2, t3] = await conversar([CHILAQUILES, FRIJOLITOS, LICUADOS]);
  const antes = pideGuarnicion(t2);
  const despues = pideGuarnicion(t3);
  assert(despues, 'la consulta se llevó por delante el pendiente');
  assert.equal(despues.clave, antes.clave, 'el pendiente se recreó en vez de conservarse');
  assert.equal(despues.intentos, 0, 'una pregunta sobre licuados se contó como respuesta fallida');
  assert(t3.consulta, 'no entendió la consulta nueva');
});

await t('T4. «y uno de fresa» procesa el producto nuevo sin tocar el pendiente', async () => {
  const [, t2, , t4] = await conversar([CHILAQUILES, FRIJOLITOS, LICUADOS, FRESA]);
  const nombres = t4.carrito.items.map((i) => i.nombre);
  assert(nombres.some((n) => /fresa/i.test(n)), `no agregó el licuado: ${JSON.stringify(nombres)}`);
  const p = pideGuarnicion(t4);
  assert(p, 'el producto nuevo borró el pendiente del chilaquil');
  assert.equal(p.clave, pideGuarnicion(t2).clave);
  assert.equal(p.intentos, 0, '«uno de fresa» se contó como intento de contestar la guarnición');
});

await t('T5. «los frijolitos con chorizo» resuelve el pendiente original, en su renglón', async () => {
  const t5 = (await conversar([CHILAQUILES, FRIJOLITOS, LICUADOS, FRESA, CON_CHORIZO])).at(-1);
  assert.equal(pideGuarnicion(t5), null,
    `el pendiente sobrevivió a su respuesta: ${JSON.stringify(clavesDe(t5))}`);
  assert.deepEqual(opcionesDe(t5.carrito), ['Frijolitos con chorizo']);
  // Y no se la puso al licuado.
  assert.deepEqual(opcionesDe(t5.carrito, /fresa/i), [], 'la guarnición aterrizó en el licuado');
});

// ═══════════════════════════════════════════════════════════════════════════
// P1–P14
// ═══════════════════════════════════════════════════════════════════════════

const OTRO_TEMA = [
  { cliente: '¿Tienen estacionamiento?', borrador: null },
  { cliente: '¿A qué hora cierran?', borrador: null },
];

await t('P1. un pendiente de PRODUCTO se resuelve cuando el producto llega', async () => {
  const [t1, t2] = await conversar([
    { cliente: 'Hola, buenos días', borrador: null },
    CHILAQUILES,
  ]);
  assert(clavesDe(t1).some((c) => c.includes('productos')),
    `sin pedido, «productos» tenía que estar pendiente: ${JSON.stringify(clavesDe(t1))}`);
  assert(!clavesDe(t2).some((c) => c.includes('productos')),
    `llegó el producto y el pendiente siguió vivo: ${JSON.stringify(clavesDe(t2))}`);
});

await t('P2. un pendiente de MODIFICADOR se resuelve cuando se elige la opción', async () => {
  const [, t2, t3] = await conversar([CHILAQUILES, FRIJOLITOS,
    { cliente: 'Los naturales', borrador: { items: [it('Chilaquiles', [guar('Frijolitos naturales')])] } }]);
  assert(pideGuarnicion(t2), 'no llegó a haber pendiente que resolver');
  assert.equal(pideGuarnicion(t3), null, 'la opción elegida no cerró el pendiente');
  assert.deepEqual(opcionesDe(t3.carrito), ['Frijolitos naturales']);
});

await t('P3. un cambio de tema NO marca el pendiente como fallido', async () => {
  const rs = await conversar([CHILAQUILES, FRIJOLITOS, ...OTRO_TEMA,
    { cliente: 'Ok gracias', borrador: null }]);
  const p = pideGuarnicion(rs.at(-1));
  assert(p, 'tres turnos de otra cosa se llevaron el pendiente');
  assert.equal(p.intentos, 0,
    `tres mensajes ajenos subieron el contador a ${p.intentos}`);
});

await t('P4. volver al pendiente varios turnos después lo resuelve', async () => {
  const t5 = (await conversar([CHILAQUILES, FRIJOLITOS, ...OTRO_TEMA,
    { cliente: 'Con chorizo porfa',
      borrador: { items: [it('Chilaquiles', [guar('Frijolitos con chorizo')])] } }])).at(-1);
  assert.equal(pideGuarnicion(t5), null, 'la respuesta tardía no resolvió nada');
  assert.deepEqual(opcionesDe(t5.carrito), ['Frijolitos con chorizo']);
});

await t('P5. borrar la línea borra su pendiente, y lo cuenta como CANCELADO', async () => {
  const t3 = (await conversar([CHILAQUILES, FRIJOLITOS,
    { cliente: 'Mejor quita los chilaquiles', borrador: { items: [] } }])).at(-1);
  assert.equal(t3.carrito.items.length, 0, 'no se quitó el renglón');
  assert.equal(pideGuarnicion(t3), null,
    `quedó una pregunta sobre un platillo que ya no existe: ${JSON.stringify(clavesDe(t3))}`);
  // Y el motivo se distingue: no se «resolvió», se cayó con su línea.
  const c = contextoDeLaConversacion(null, {});
  c.contador = 1;
  sincronizarPendientes(c, [{ tipo: 'opcion_ambigua', lid: 'L9', grupo: 'G', candidatos: ['a', 'b'] }],
    { lidsVivos: ['L9'] });
  const ciclo = sincronizarPendientes(c, [], { lidsVivos: [] });
  assert.equal(ciclo.cancelados, 1);
  assert.equal(ciclo.resueltos, 0);
});

await t('P6. si cambian los candidatos, la pregunta vieja queda OBSOLETA', async () => {
  const c = contextoDeLaConversacion(null, {});
  c.contador = 1;
  const antes = { tipo: 'opcion_ambigua', lid: 'L1', grupo: 'Guarnicion', producto: 'Chilaquiles',
    candidatos: ['Frijolitos naturales', 'Frijolitos con chorizo'] };
  sincronizarPendientes(c, [antes], { lidsVivos: ['L1'] });
  marcarPreguntado(c, clavePendiente(antes));
  anotarIntentoFallido(c, clavePendiente(antes));

  c.contador = 2;
  const ahora = { ...antes, candidatos: ['Papas naturales', 'Papas a la mexicana'] };
  const ciclo = sincronizarPendientes(c, [ahora], { lidsVivos: ['L1'] });
  assert.equal(ciclo.obsoletos, 1, 'la pregunta vieja sobrevivió a su propio motivo');
  assert.deepEqual(c.pendientes[0].candidatos, ['Papas naturales', 'Papas a la mexicana']);
  assert.equal(c.pendientes[0].intentos, 0, 'los intentos de la pregunta vieja se arrastraron');
  assert.equal(c.pendientes[0].turnoUltimaPregunta, null, 'la pregunta nueva nació ya preguntada');
});

await t('P7. la MISMA pregunta no se repite cinco turnos seguidos', async () => {
  // Es el caso exacto del tráfico real: la carta ofrece cuatro presentaciones,
  // el cliente habla de otra cosa, y la pregunta volvía idéntica cada turno.
  const rs = await conversar([
    { cliente: 'Quiero unos chilaquiles suizos con pollo',
      borrador: { items: [it('Chilaquiles suizos con pollo')] } },
    { cliente: '¿Tienen servicio a domicilio?', borrador: null },
    { cliente: 'Ok', borrador: null },
    { cliente: '¿Y cuánto tardan?', borrador: null },
    { cliente: 'Va', borrador: null },
  ]);
  const preguntas = rs.map((r) => r.siguiente);
  const repetidas = preguntas.filter((p) => p && p.startsWith('grupo:')).length;
  const p = rs.at(-1).contexto.pendientes.find((x) => x.grupo === 'Presentacion');
  assert(p, 'se perdió el pendiente que sí bloquea');
  // Y es LA MISMA pregunta, no cinco preguntas nuevas con las mismas palabras.
  // Esa distinción es todo: una pregunta que renace cada turno llega siempre
  // con el contador a cero y sin memoria de haberse hecho ya.
  assert.equal(p.turnoCreacion, 1,
    `la pregunta se volvió a crear en el turno ${p.turnoCreacion}`);
  assert(p.turnoUltimaPregunta !== null, 'no quedó constancia de haberla preguntado');
  // Sigue bloqueando —y por eso se vuelve a poner delante— pero el contador de
  // intentos NO sube, que es lo que mandaba a un humano.
  assert.equal(p.intentos, 0, `subió a ${p.intentos} con turnos que no le contestaban`);
  assert(repetidas <= 5, `la pregunta se emitió ${repetidas} veces`);
  assert.equal(rs.at(-1).handoff.escalar, false, 'escaló por repetir una pregunta que nadie falló');
});

// El cliente contesta A la pregunta, y su respuesta sigue sin separar las dos.
// Son cuatro y no tres: el handoff lee el contador ANTES de tocar el pedido,
// así que el tercer intento se ve en el turno siguiente.
const INSISTE = ['frijolitos', 'los frijolitos', 'frijolitos pues', 'frijolitos'].map((cliente) => ({
  cliente, borrador: { items: [it('Chilaquiles', [guar('Frijolitos naturales')])] },
}));
const LICUADO_NUEVO = { cliente: 'Mejor unos licuados de fresa',
  borrador: { items: [it('Chilaquiles'), it('Licuado de fresa')] } };

await t('P8. tres respuestas REALMENTE ambiguas sí escalan', async () => {
  // El cliente contesta A la pregunta, tres veces, y su respuesta sigue sin
  // separar las dos candidatas. Eso sí es un caso para una persona.
  const rs = await conversar([CHILAQUILES, FRIJOLITOS, ...INSISTE]);
  const escalo = rs.some((r) => r.handoff.escalar);
  assert(escalo, `${TOPE_ACLARACIONES} intentos sobre la misma pregunta y no escaló`);
  const cuando = rs.findIndex((r) => r.handoff.escalar);
  assert.equal(rs[cuando].handoff.motivo, 'DEMASIADAS_ACLARACIONES');
});

await t('P9. tres mensajes NO relacionados no provocan handoff', async () => {
  const rs = await conversar([CHILAQUILES, FRIJOLITOS, ...OTRO_TEMA,
    { cliente: '¿Aceptan tarjeta?', borrador: null },
    { cliente: 'Mándame la ubicación del local', borrador: null }]);
  for (const [i, r] of rs.entries()) {
    assert.equal(r.handoff.escalar, false, `escaló en el turno ${i + 1}: ${r.handoff.motivo}`);
  }
});

// ── EL HANDOFF EN SOMBRA ────────────────────────────────────────────────

await t('P10. en sombra el handoff se REGISTRA y la observación continúa', async () => {
  const rs = await conversar([CHILAQUILES, FRIJOLITOS, ...INSISTE, LICUADO_NUEVO],
    { observando: true });

  for (const [i, r] of rs.entries()) {
    assert.equal(r.handoff.escalar, false, `la copia se detuvo en el turno ${i + 1}`);
  }
  const primero = rs.findIndex((r) => r.handoff.habriaEscalado);
  assert(primero >= 0, 'no registró que en producción habría escalado');
  assert.equal(rs[primero].handoff.motivo, 'DEMASIADAS_ACLARACIONES');
  assert.equal(rs[primero].postHandoff, false, 'el turno del escalado no es posterior a sí mismo');

  // Y lo de después queda MARCADO, para que nadie lo lea como si el bot
  // hubiera seguido atendiendo de verdad.
  const ultimo = rs.at(-1);
  assert.equal(ultimo.postHandoff, true, 'los turnos contrafactuales no van marcados');
  assert.equal(ultimo.handoff.turnoDelEscalado, rs[primero].handoff.turnoDelEscalado);
  // Se siguió aprendiendo: el licuado entró.
  assert(ultimo.carrito.items.some((i) => /fresa/i.test(i.nombre)),
    'dejó de observar justo donde la conversación se ponía interesante');
  assert(ultimo.eventos.some((l) => l.includes('whatsapp_mesero_post_handoff')));
  assert.equal(rs.filter((r) => r.eventos.some((l) => l.includes('handoff_hipotetico'))).length, 1,
    'el escalado hipotético se emitió más de una vez');
});

await t('P11. sin `observando`, el handoff sigue siendo terminal', async () => {
  const rs = await conversar([CHILAQUILES, FRIJOLITOS, ...INSISTE, LICUADO_NUEVO]);
  const cuando = rs.findIndex((r) => r.handoff.escalar);
  assert(cuando >= 0, 'no escaló en producción');
  const despues = rs[cuando];
  // Lo terminal se nota en la forma del resultado: no hay cambios, no hay
  // propuestas, el carrito queda como estaba y viaja el equipaje para la persona.
  assert.equal(despues.cambios, null);
  assert.deepEqual(despues.decisiones, []);
  assert.equal(despues.fase, 'escalado_humano');
  assert(despues.handoff.equipaje, 'el humano entra sin saber qué pasaba');
  // Y el turno siguiente tampoco atiende.
  const ultimo = rs.at(-1);
  assert.equal(ultimo.handoff.escalar, true, 'el bot volvió solo después de escalar');
  assert(!ultimo.carrito.items.some((i) => /fresa/i.test(i.nombre)),
    'siguió tomando pedido después de pasar la conversación a una persona');
});

// ── PII ──────────────────────────────────────────────────────────────────

const VOCAB = palabrasDeLaCarta(CARTA);

await t('P12. la dirección sale redactada del log', async () => {
  const casos = [
    'Calle Nogal 900 col. Álamos',
    'Blvd Cbtis 34 #208 Col Guillén',
    'mi dirección es Hidalgo 452 entre calles Juárez y Morelos',
  ];
  for (const c of casos) {
    const r = redactarDireccion(c, { entrega: true, vocabulario: VOCAB });
    assert.equal(r.redactado, true, `no redactó: ${c}`);
    assert(r.texto.includes(MARCA_DIRECCION), r.texto);
    // Ni un topónimo sobreviviente.
    for (const palabra of ['Nogal', 'Álamos', 'Cbtis', 'Guillén', 'Hidalgo', 'Juárez', 'Morelos']) {
      assert(!r.texto.includes(palabra), `sobrevivió «${palabra}» en: ${r.texto}`);
    }
  }
  // Y también desde el registro completo, que es por donde sale de verdad.
  const registro = registroDelTurno({
    negocioId: 'n1', sessionId: 's1', mensaje: 'mándamelo a Nogal 900 col. Álamos',
    r: { intenciones: [], contexto: {}, carrito: { items: [] } }, antes: null, ms: 1,
    entrega: true, vocabulario: VOCAB, ahora: new Date('2026-09-13T00:00:00Z'),
  });
  assert.equal(registro.direccion_redactada, true);
  assert(!/Nogal|Álamos/.test(JSON.stringify(registro)), JSON.stringify(registro));
});

await t('P13. teléfono, correo y coordenadas salen redactados', async () => {
  assert.equal(textoSeguro('llámame al 8781234567'), 'llámame al ###');
  assert.equal(redactarContacto('escríbeme a ana.lopez+pedidos@gmail.com'),
    'escríbeme a [EMAIL_REDACTADO]');
  assert.equal(redactarContacto('estoy en 25.426801, -100.987654'),
    'estoy en [COORDENADAS_REDACTADAS]');
  assert.equal(redactarContacto('te paso https://maps.app.goo.gl/abc123'),
    'te paso [ENLACE_REDACTADO]');
  // Y las coordenadas NO acaban convertidas en `##.####`: se van enteras.
  const seguro = textoSeguro('estoy en 25.426801, -100.987654');
  assert(!/\d/.test(seguro.replace(/\[[^\]]+\]/g, '')), seguro);
});

await t('P12b. las direcciones que NO dicen «calle» tampoco se publican', async () => {
  // Todas salieron de una revisión adversarial del propio redactor. Cada una
  // se colaba entera en el log antes de este arreglo.
  const casos = [
    ['vivo en Hidalgo 4521', false],
    ['mi casa esta en Loma Bonita', false],
    ['Col 20 de Noviembre 45', true],
    ['Col 5 de Mayo 12', true],
    ['te paso mi ubicacion', false],
    ['estan en la esquina de Juarez y Morelos', false],
  ];
  for (const [texto, entrega] of casos) {
    const r = redactarDireccion(texto, { entrega, vocabulario: VOCAB });
    assert.equal(r.redactado, true, `no redactó: ${texto}`);
    for (const palabra of ['Hidalgo', 'Loma Bonita', 'Noviembre', 'Mayo', 'Juarez', 'Morelos']) {
      assert(!r.texto.includes(palabra), `sobrevivió «${palabra}» en: ${r.texto}`);
    }
  }
});

await t('P14b. redactar PII no puede comerse el pedido', async () => {
  // El reverso de P12b, y el que más daño hace: un redactor que tapa de más
  // deja un log lleno de `[DIRECCION_REDACTADA]` con el que no se puede medir
  // nada. `n[ºo]\\s*\\d` sin frontera de palabra borraba «bueno 3 tortas».
  const intactos = [
    ['bueno 3 tortas', false],
    ['chile relleno 2', false],
    ['cafe americano 2', false],
    ['voy en camino', true],
    ['ya cerraron?', false],
    ['mandame la ubicacion del local', false],
    ['ensalada de col con zanahoria', false],
    ['son 2 chilaquiles y 1 omelet', true],
  ];
  for (const [texto, entrega] of intactos) {
    const r = redactarDireccion(texto, { entrega, vocabulario: VOCAB });
    assert.equal(r.redactado, false, `tapó semántica que no era PII: ${texto} → ${r.texto}`);
  }
});

await t('P13b. la NOTA del artículo pasa por las mismas capas que el mensaje', async () => {
  // Era la puerta trasera: el mensaje se redactaba y la nota del renglón
  // entraba cruda al registro por `pedido_hipotetico` y `antes_items`.
  const registro = registroDelTurno({
    negocioId: 'n1', sessionId: 's1', mensaje: 'ok',
    r: { intenciones: [], contexto: {}, carrito: { items: [
      { nombre: 'Chilaquiles', cantidad: 1, modificadores: [],
        notas: 'dejarlo con el portero, Calle Nogal 900, tel 8781234567' },
    ] } },
    antes: null, ms: 1, entrega: true, vocabulario: VOCAB,
    ahora: new Date('2026-09-13T00:00:00Z'),
  });
  const json = JSON.stringify(registro);
  assert(!/Nogal/.test(json), `la nota publicó una calle: ${json}`);
  assert(!/8781234567/.test(json), `la nota publicó un teléfono: ${json}`);
  assert(/Chilaquiles/.test(json), 'y de paso se llevó el producto');
  assert.equal(pareceSensibleElRegistro(registro), false, json);
});

await t('P14. productos, modificadores y candidatos siguen visibles', async () => {
  const [, t2] = await conversar([CHILAQUILES, FRIJOLITOS]);
  const registro = registroDelTurno({
    negocioId: 'n1', sessionId: 's1', mensaje: 'Frijolitos, y mándamelo a Nogal 900 col. Álamos',
    r: t2, antes: null, ms: 1, entrega: true, vocabulario: VOCAB,
    ahora: new Date('2026-09-13T00:00:00Z'),
  });
  const json = JSON.stringify(registro);
  // Lo que se quería tapar, tapado.
  assert(!/Nogal|Álamos/.test(json), json);
  // Lo que hace útil el log, intacto.
  assert(registro.dijo.toLowerCase().includes('frijolitos'),
    `se comió la semántica gastronómica: ${registro.dijo}`);
  assert(/Frijolitos con chorizo/.test(json), 'perdió los candidatos');
  assert(/Chilaquiles/.test(json), 'perdió el producto');
  assert(registro.ambiguedades.length > 0, 'perdió las aclaraciones');
  assert(registro.pendientes.length > 0, 'perdió los pendientes');
  // Y el mensaje NO es un `[REDACTADO]` entero.
  assert(registro.dijo.replace(/\[[^\]]+\]/g, '').trim().length > 5, registro.dijo);
});

// ── El caso exacto del tráfico real, ya anonimizado ─────────────────────

await t('R1. el caso real: la aclaración de los chilaquiles suizos deja de pegarse', async () => {
  // Secuencia real del 13-sep en Obispado, con la dirección sustituida. La
  // pregunta «De Chilaquiles suizos con pollo tenemos Sencillos, Mixtos, Bowl,
  // Combito» se repitió turno tras turno y acabó escalando la conversación.
  const suizos = (mods = []) => ({ items: [it('Chilaquiles suizos con pollo', mods)] });
  const rs = await conversar([
    { cliente: 'Buenos días', borrador: null },
    { cliente: 'Quiero unos chilaquiles suizos con pollo', borrador: suizos() },
    { cliente: '¿Hacen entrega a domicilio?', borrador: null },
    { cliente: 'Sí, a [DIRECCION]', borrador: suizos() },
    { cliente: '¿Cuánto tarda?', borrador: null },
    { cliente: 'Ok, sencillos está bien', borrador: suizos([pres('Sencillos')]) },
  ], { observando: true });

  // No escaló, ni de verdad ni en la copia.
  for (const [i, r] of rs.entries()) {
    assert.equal(r.handoff.escalar, false, `la copia se detuvo en el turno ${i + 1}`);
    assert.equal(!!r.handoff.habriaEscalado, false,
      `escalado artificial en el turno ${i + 1}: ${r.handoff.motivo}`);
  }
  // La pregunta se resolvió al contestarla, y desapareció.
  const ultimo = rs.at(-1);
  assert.equal(ultimo.contexto.pendientes.find((p) => p.grupo === 'Presentacion') ?? null, null,
    `la pregunta vieja sobrevivió: ${JSON.stringify(clavesDe(ultimo))}`);
  assert.deepEqual(opcionesDe(ultimo.carrito, /suizos/i), ['Sencillos']);
  // Y en ningún momento el mismo pendiente acumuló intentos.
  const maximo = Math.max(...rs.flatMap((r) => r.contexto.pendientes.map((p) => p.intentos || 0)), 0);
  assert(maximo < TOPE_ACLARACIONES, `un pendiente llegó a ${maximo} intentos`);
});

await t('R2. el ciclo de vida se puede contar: creados, resueltos, cancelados, obsoletos', async () => {
  const rs = await conversar([CHILAQUILES, FRIJOLITOS,
    { cliente: 'Los naturales', borrador: { items: [it('Chilaquiles', [guar('Frijolitos naturales')])] } }]);
  const suma = { creados: 0, resueltos: 0, cancelados: 0, obsoletos: 0 };
  for (const r of rs) {
    const linea = r.eventos.find((l) => l.includes('whatsapp_mesero_pendientes'));
    assert(linea, 'un turno no emitió el evento del ciclo de pendientes');
    for (const k of Object.keys(suma)) {
      suma[k] += Number(linea.match(new RegExp(`${k}=(\\d+)`))?.[1] ?? 0);
    }
  }
  assert(suma.creados >= 2, `creados=${suma.creados}`);
  assert(suma.resueltos >= 1, `resueltos=${suma.resueltos}`);
  assert.equal(suma.cancelados, 0);
});

await t('R4. las métricas del ciclo llegan al registro, no solo a una lista que nadie lee', async () => {
  // `atenderTurno` construía los eventos cada turno y la sombra los tiraba: los
  // cuatro contadores nuevos no aparecían en ningún log del modo observado.
  const [, t2] = await conversar([CHILAQUILES, FRIJOLITOS]);
  assert(t2.cicloPendientes, 'el turno no devuelve el ciclo de pendientes');
  const registro = registroDelTurno({
    negocioId: 'n1', sessionId: 's1', mensaje: 'Frijolitos', r: t2, antes: null, ms: 1,
    vocabulario: VOCAB, ahora: new Date('2026-09-13T00:00:00Z'),
  });
  for (const k of ['creados', 'resueltos', 'cancelados', 'obsoletos', 'vivos']) {
    assert(typeof registro.ciclo_pendientes[k] === 'number', `falta ${k} en el registro`);
  }
  assert.equal(registro.ciclo_pendientes.creados, 1, JSON.stringify(registro.ciclo_pendientes));
  assert.equal(typeof registro.aclaraciones_repetidas, 'number');
  // Y los eventos con nombre siguen existiendo para quien los cuente.
  assert(t2.eventos.some((l) => l.includes('whatsapp_mesero_pendientes')));
});

await t('R3. una pregunta ya hecha y viva NO vuelve a redactarse desde cero', async () => {
  const c = contextoDeLaConversacion(null, {});
  c.contador = 1;
  const d = { tipo: 'opcion_ambigua', lid: 'L1', grupo: 'Guarnicion', producto: 'Chilaquiles',
    candidatos: ['Frijolitos naturales', 'Frijolitos con chorizo'] };
  sincronizarPendientes(c, [d], { lidsVivos: ['L1'] });
  marcarPreguntado(c, clavePendiente(d));
  assert.equal(preguntadoRecientemente(c, clavePendiente(d)), true);
  c.contador = 2;
  sincronizarPendientes(c, [d], { lidsVivos: ['L1'] });
  assert.equal(c.pendientes[0].turnoUltimaPregunta, 1,
    'la marca de «ya preguntado» se perdió al reconciliar');
  c.contador = 5;
  assert.equal(preguntadoRecientemente(c, clavePendiente(d)), false,
    'cuatro turnos después sigue considerándose recién preguntada');
});

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
