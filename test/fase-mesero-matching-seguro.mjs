// ─── Una única coincidencia débil sigue siendo débil ──────────────────────
//
// M1–M16. Todo el matching del Mesero respondía a una sola pregunta —«¿hay otro
// candidato tan bueno como éste?»— y ninguna capa preguntaba «¿es éste bastante
// bueno?». Son preguntas distintas, y confundirlas convierte peticiones que el
// negocio NO puede servir en selecciones canónicas silenciosas.
//
// ── El caso que lo destapó ───────────────────────────────────────────────
//
// Carta con «Queso Panela en Salsa» entre las proteínas. El cliente pide
// «queso azul».
//
//   palabrasQueLaSostienen("Queso Panela en Salsa", "queso azul") = {queso}
//   fuerza 1, y NADIE más tiene la palabra «queso»
//   -> sin empate -> distingueLaEleccion dice que sí distingue
//   -> «Queso Panela en Salsa» entra al pedido
//
// El cliente no pidió panela: pidió AZUL. La ausencia de competencia no es
// evidencia.
//
// ── La regla, y es una sola ──────────────────────────────────────────────
//
// Un candidato tiene que EXPLICAR las palabras distintivas de la mención. La
// que no explique lo descarta. Se mide con `palabrasSinExplicar`, que reutiliza
// exactamente la misma `palabrasQueLaSostienen` de siempre —género, número y
// diminutivo incluidos—: no hay un segundo motor de fuzzy matching ni un umbral
// numérico que ajustar.
//
// Quien explica no es sólo el nombre del candidato: también su grupo o su
// categoría, las opciones que ofrece y los alias que el negocio declaró. Por eso
// «salsa suiza» sigue resolviendo a «Suiza» —«salsa» la explica el grupo— y
// «combo» sigue resolviendo a «Combito» si el negocio lo declaró.
//
// ── Y sigue sin saber qué vende nadie ────────────────────────────────────
//
// M12 corre el mismo motor sobre una carta japonesa que no comparte una palabra
// con ninguna otra. M13 pone dos negocios con vocabulario parecido. Y una
// prueba lee el código y falla si aparece una palabra de cualquier menú.
import assert from 'node:assert/strict';
import { anclarLinea, anclarPropuestas } from '../src/mesero-whatsapp/anclajeAlCatalogo.js';
import { atenderTurno } from '../src/mesero-whatsapp/meseroDigital.js';
import { palabrasSinExplicar, explicaLaMencion } from '../src/orders/evidenciaDeEleccion.js';

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

const g = (nombre, minimo, maximo, opciones, requerido = true) => ({
  nombre, requerido, minimo, maximo,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});

// ── La carta del enunciado (§8): estructura real de Obispado ─────────────
const SALSAS = ['Roja', 'Suiza', 'Verde', 'Mole', 'Chipotle'];
const PROTS = ['Huevos Estrellados', 'Huevos Revueltos', 'Pechuga de pollo', 'Chicharron Prensado',
  'Bistec en Salsa', 'Queso Panela en Salsa', 'Chicharron Cuerito en Salsa'];
const GUARNS = ['Frijolitos naturales', 'Frijolitos con chorizo', 'Papas a la mexicana', 'Papas con chorizo'];
const CARTA = [
  { id: 1, nombre: 'CHILAQUILES', productos: [
    { id: 11, nombre: 'Chilaquiles Sencillos', orden: 0, precio: 195, disponible: true,
      opciones: { variante: { base: true } },
      modificadores: [g('Salsa', 1, 1, SALSAS), g('Proteina', 1, 1, PROTS), g('Guarniciones', 1, 2, GUARNS)] },
    { id: 12, nombre: 'Chilaquiles Mixtos', orden: 1, precio: 205, disponible: true,
      modificadores: [g('Salsa', 1, 2, SALSAS), g('Proteina', 1, 2, PROTS), g('Guarniciones', 1, 2, GUARNS)] },
    { id: 13, nombre: 'Combito de Chilaquiles', orden: 2, precio: 195, disponible: true,
      opciones: { variante: { requiere_mencion: true, discriminadores: ['combito', 'combo'] } },
      modificadores: [g('Salsa', 1, 1, SALSAS), g('Proteina', 1, 1, PROTS)] },
  ] },
];

// ── La carta mínima del §8, para aislar el caso sin nada alrededor ──────
const MINIMA = [
  { id: 1, nombre: 'GUISOS', productos: [
    { id: 21, nombre: 'Guiso del dia', orden: 0, precio: 100, disponible: true,
      modificadores: [g('Relleno', 1, 1, ['Queso Panela en Salsa', 'Huevos Estrellados', 'Pollo'])] },
  ] },
];

// ── La carta del §9: familia reconocida, atributo no ────────────────────
const TORTAS = [
  { id: 1, nombre: 'TORTAS', productos: [
    // Mismo `orden`: el negocio no ha dicho cuál es la normal, así que la
    // familia no tiene base y un genérico es una pregunta. Es la regla de
    // variantes de siempre, y aquí hace falta que NO decida ella para poder
    // medir el matching.
    { id: 31, nombre: 'Torta de Pierna', orden: 0, precio: 90, disponible: true, modificadores: [] },
    { id: 32, nombre: 'Torta de Pollo', orden: 0, precio: 90, disponible: true, modificadores: [] },
  ] },
];

// ── M12: una carta que no comparte una palabra con ninguna de las otras ──
const JAPONESA = [
  { id: 1, nombre: 'RAMEN', productos: [
    { id: 41, nombre: 'Ramen Tonkotsu', orden: 0, precio: 180, disponible: true,
      modificadores: [g('Topping', 1, 1, ['Chashu', 'Ajitama', 'Menma'])] },
    { id: 42, nombre: 'Ramen Shoyu', orden: 0, precio: 170, disponible: true,
      modificadores: [g('Topping', 1, 1, ['Chashu', 'Ajitama', 'Menma'])] },
  ] },
];

const it = (nombre, modificadores = []) => ({ nombre, cantidad: 1, modificadores, notas: '' });
const grupo = (gr, ...opciones) => ({ grupo: gr, opciones });
const propuesta = (nombre, modificadores) => ({
  accion: 'agregar', lid: null, campo: null, valorAnterior: null,
  valorNuevo: { nombre, cantidad: 1, modificadores, notas: '' }, evidencia: '',
});

let seq = 0;
async function conversar(guion, catalogo = CARTA, negocioId = 'n-mat') {
  seq += 1;
  let contexto = null; let carrito = null; const fuera = [];
  for (const paso of guion) {
    const r = await atenderTurno({
      negocioId, conversacionId: `c-mat-${seq}`, mensaje: paso.cliente,
      catalogo, requierePago: false, contextoGuardado: contexto, carrito,
      proponer: async () => paso.borrador ?? null,
    });
    contexto = JSON.parse(JSON.stringify(r.contexto));
    carrito = r.carrito;
    fuera.push(r);
  }
  return fuera;
}
const opcsDe = (r, i = 0) => (r.carrito?.items?.[i]?.modificadores || [])
  .flatMap((m) => (m.opciones || []).map((o) => (typeof o === 'string' ? o : o?.nombre)));
const anclar = (catalogo, pista, evidencia = pista) => anclarLinea({ catalogo, nombrePropuesto: pista, evidencia });

// ═══════════════════════════════════════════════════════════════════════════
// M1–M3 · FUERTE NO ES LO MISMO QUE ÚNICA
// ═══════════════════════════════════════════════════════════════════════════

await t('M1. un único candidato sostenido por UNA palabra genérica NO resuelve', async () => {
  // «Queso Panela en Salsa» es la única opción del grupo con la palabra
  // «queso». Nadie compite, y eso era todo lo que hacía falta para entrar.
  const r = anclarPropuestas({
    catalogo: MINIMA, carrito: { items: [] }, evidencia: 'un guiso con queso azul',
    propuestas: [propuesta('Guiso del dia', [grupo('relleno', 'Queso azul')])],
  });
  const puestas = r.propuestas[0]?.valorNuevo?.modificadores?.flatMap((m) => m.opciones) || [];
  assert.deepEqual(puestas, [], `entró una opción que nadie pidió: ${JSON.stringify(puestas)}`);
  const d = (r.descartados || []).find((x) => /azul/i.test(x.opcion || ''));
  assert(d, `no se reportó el descarte: ${JSON.stringify(r.descartados)}`);
  assert.equal(d.motivo, 'no_reconocida', JSON.stringify(d));
  assert(d.noReconocidas?.includes('azul'), JSON.stringify(d));
});

await t('M2. «queso azul» no termina en Queso Panela, ni siquiera en la conversación', async () => {
  const rs = await conversar([
    { cliente: 'Quiero un guiso del dia con queso azul',
      borrador: { items: [it('Guiso del dia', [grupo('relleno', 'Queso azul')])] } },
  ], MINIMA);
  const puestas = opcsDe(rs[0]);
  assert(!puestas.some((o) => /panela/i.test(o)),
    `se sirvió un queso que el cliente no pidió: ${JSON.stringify(puestas)}`);
  assert.deepEqual(puestas, [], JSON.stringify(puestas));
});

await t('M3. una coincidencia DISTINTIVA de una sola palabra sí resuelve', async () => {
  // «panela» también encuentra una sola palabra de «Queso Panela en Salsa»,
  // pero no deja nada del cliente sin explicar. Esa es toda la diferencia.
  const r = anclarPropuestas({
    catalogo: MINIMA, carrito: { items: [] }, evidencia: 'un guiso con panela',
    propuestas: [propuesta('Guiso del dia', [grupo('relleno', 'panela')])],
  });
  const puestas = r.propuestas[0]?.valorNuevo?.modificadores?.flatMap((m) => m.opciones) || [];
  assert.deepEqual(puestas, ['Queso Panela en Salsa'], JSON.stringify(puestas));
});

// ═══════════════════════════════════════════════════════════════════════════
// M4–M6 · LO QUE YA FUNCIONABA SIGUE FUNCIONANDO
// ═══════════════════════════════════════════════════════════════════════════

await t('M4. plural y género siguen resolviendo («suizos» → Suiza)', async () => {
  assert(explicaLaMencion('suizos', ['Suiza', 'Salsa']), 'se perdió la concordancia');
  const r = anclarPropuestas({
    catalogo: CARTA, carrito: { items: [] }, evidencia: 'unos chilaquiles suizos',
    propuestas: [propuesta('Chilaquiles Sencillos', [grupo('tipo', 'suizos')])],
  });
  const puestas = r.propuestas[0]?.valorNuevo?.modificadores?.flatMap((m) => m.opciones) || [];
  assert.deepEqual(puestas, ['Suiza'], JSON.stringify(puestas));
});

await t('M5. el diminutivo sigue resolviendo («frijoles» → Frijolitos)', async () => {
  assert(explicaLaMencion('frijoles con chorizo', ['Frijolitos con chorizo', 'Guarniciones']),
    'se perdió el diminutivo');
  const r = anclarPropuestas({
    catalogo: CARTA, carrito: { items: [] }, evidencia: 'con frijoles con chorizo',
    propuestas: [propuesta('Chilaquiles Sencillos', [grupo('acompañamiento', 'frijoles con chorizo')])],
  });
  const puestas = r.propuestas[0]?.valorNuevo?.modificadores?.flatMap((m) => m.opciones) || [];
  assert.deepEqual(puestas, ['Frijolitos con chorizo'], JSON.stringify(puestas));
});

await t('M6. un alias DECLARADO explica lo que el nombre no explica', async () => {
  // El alias tiene que hacer trabajo que el nombre no hace. «Combo» contra
  // «Combito» lo resolvería solo el diminutivo, así que no probaría nada: aquí
  // el alias es la ÚNICA cosa de la carta que puede explicar esa palabra.
  const PAQUETES = (declarar) => ([{ id: 1, nombre: 'PAQUETES', productos: [
    { id: 51, nombre: 'Paquete Familiar', orden: 0, precio: 320, disponible: true,
      ...(declarar ? { opciones: { variante: { discriminadores: ['combo'] } } } : {}),
      modificadores: [] }] }]);
  // «paquete combo»: el alias va en posición de ESPECIE, detrás de lo que el
  // catálogo sí explica, que es donde la regla exige que alguien lo explique.
  const con = anclar(PAQUETES(true), 'el paquete combo');
  assert.equal(con.estado, 'resuelto', `${con.estado} / ${con.motivo} / ${JSON.stringify(con.noReconocidas)}`);
  assert.equal(con.producto.nombre, 'Paquete Familiar');
  // Y sin declararlo, la misma frase deja «combo» sin explicar: no se inventa.
  const sin = anclar(PAQUETES(false), 'el paquete combo');
  assert.equal(sin.estado, 'sin_candidatos', `resolvió sin alias declarado: ${sin.producto?.nombre}`);
  assert.deepEqual(sin.noReconocidas, ['combo'], JSON.stringify(sin.noReconocidas));
});

await t('M6b. y el alias sigue sirviendo para NOMBRAR la variante, como antes', async () => {
  const r = anclar(CARTA, 'combo de chilaquiles');
  assert.equal(r.estado, 'resuelto', `${r.estado} / ${r.motivo}`);
  assert.equal(r.producto.nombre, 'Combito de Chilaquiles');
});

// ═══════════════════════════════════════════════════════════════════════════
// M7 · FAMILIA RECONOCIDA + ATRIBUTO DESCONOCIDO
// ═══════════════════════════════════════════════════════════════════════════

await t('M7. familia conocida y atributo inexistente: no inventa variante, y conserva la familia', async () => {
  const r = anclar(TORTAS, 'torta de salmon');
  assert.equal(r.estado, 'sin_candidatos', `resolvió ${r.producto?.nombre} por ${r.motivo}`);
  assert.equal(r.motivo, 'no_reconocido', r.motivo);
  assert.deepEqual(r.noReconocidas, ['salmon'], JSON.stringify(r.noReconocidas));
  assert.deepEqual(r.familia.slice().sort(), ['Torta de Pierna', 'Torta de Pollo'],
    `se perdió la familia reconocida: ${JSON.stringify(r.familia)}`);
});

await t('M7b. y la pregunta lo dice: ni «no existe torta», ni una torta inventada', async () => {
  const rs = await conversar([
    { cliente: 'Quiero una torta de salmon', borrador: { items: [it('Torta de salmon')] } },
  ], TORTAS);
  assert.deepEqual(rs[0].carrito.items, [], `nació una línea: ${JSON.stringify(rs[0].carrito.items)}`);
  const a = (rs[0].aclaraciones || []).find((x) => x.tipo === 'producto_inexistente');
  assert(a, JSON.stringify(rs[0].aclaraciones));
  assert.deepEqual(a.candidatos.slice().sort(), ['Torta de Pierna', 'Torta de Pollo'],
    `la pregunta no ofrece la familia: ${JSON.stringify(a)}`);
  assert(/salmon/i.test(a.pregunta), a.pregunta);
  assert(/pierna/i.test(a.pregunta) && /pollo/i.test(a.pregunta), a.pregunta);
});

// ═══════════════════════════════════════════════════════════════════════════
// M8–M11 · 0 / 1 / N SOBRE CANDIDATOS SUFICIENTEMENTE SUSTENTADOS
// ═══════════════════════════════════════════════════════════════════════════

await t('M8. 0 candidatos fuertes → ninguna línea ni opción canónica', async () => {
  const r = anclar(TORTAS, 'sushi de atun');
  assert.equal(r.estado, 'sin_candidatos', JSON.stringify(r));
  assert.equal(r.producto, null);
});

await t('M9. 2 candidatos fuertes → ambiguo, no se elige', async () => {
  const r = anclar(TORTAS, 'torta');
  assert.equal(r.estado, 'ambiguo', `${r.estado} -> ${r.producto?.nombre} por ${r.motivo}`);
  assert.deepEqual(r.candidatos.map((c) => c.nombre).sort(), ['Torta de Pierna', 'Torta de Pollo']);
});

await t('M9b. y si el negocio SÍ declara una base, la base sigue ganando', async () => {
  // Esto no lo toca esta corrección y no debe tocarlo: la regla de variantes
  // decide DESPUÉS, entre candidatos que ya explicaron lo que se les pidió.
  const r = anclar(CARTA, 'chilaquiles');
  assert.equal(r.estado, 'resuelto', `${r.estado} / ${r.motivo}`);
  assert.equal(r.producto.nombre, 'Chilaquiles Sencillos');
  // Pero con un atributo que nadie explica, la base ya no la salva.
  const conAtributo = anclar(CARTA, 'chilaquiles de salmon');
  assert.equal(conAtributo.estado, 'sin_candidatos',
    `la base tapó un atributo desconocido: ${conAtributo.producto?.nombre} por ${conAtributo.motivo}`);
  assert.deepEqual(conAtributo.noReconocidas, ['salmon'], JSON.stringify(conAtributo.noReconocidas));
});

await t('M10. 1 candidato fuerte → resuelto', async () => {
  const r = anclar(TORTAS, 'torta de pierna');
  assert.equal(r.estado, 'resuelto', JSON.stringify(r));
  assert.equal(r.producto.nombre, 'Torta de Pierna');
});

await t('M11. el mejor candidato débil NO gana por no tener segundo', async () => {
  // Una sola torta en la carta: ni empate posible. Aun así «de salmón» no la
  // convierte en la torta del cliente.
  const UNA = [{ id: 1, nombre: 'TORTAS', productos: [
    { id: 31, nombre: 'Torta de Pierna', orden: 0, precio: 90, disponible: true, modificadores: [] }] }];
  const r = anclar(UNA, 'torta de salmon');
  assert.notEqual(r.estado, 'resuelto',
    `resolvió con un solo candidato débil: ${r.producto?.nombre} por ${r.motivo}`);
  assert.deepEqual(r.noReconocidas, ['salmon'], JSON.stringify(r.noReconocidas));
  // Y con la misma carta, la mención que sí la explica resuelve.
  assert.equal(anclar(UNA, 'torta de pierna').estado, 'resuelto');
});

// ═══════════════════════════════════════════════════════════════════════════
// M12–M13 · EL MOTOR NO SABE DE NINGÚN NEGOCIO
// ═══════════════════════════════════════════════════════════════════════════

await t('M12. el mismo motor, en una carta sin una palabra en común', async () => {
  // Fuerte: el topping nombrado por su nombre.
  const fuerte = anclarPropuestas({
    catalogo: JAPONESA, carrito: { items: [] }, evidencia: 'un ramen tonkotsu con chashu',
    propuestas: [propuesta('Ramen Tonkotsu', [grupo('extras', 'chashu')])],
  });
  assert.deepEqual(fuerte.propuestas[0].valorNuevo.modificadores.flatMap((m) => m.opciones), ['Chashu']);
  // Débil: comparte «ramen» con las dos y pide algo que no existe.
  const debil = anclar(JAPONESA, 'ramen de birria');
  assert.equal(debil.estado, 'sin_candidatos', `${debil.estado} -> ${debil.producto?.nombre}`);
  assert.deepEqual(debil.noReconocidas, ['birria'], JSON.stringify(debil.noReconocidas));
  assert.equal(debil.familia.length, 2, JSON.stringify(debil.familia));
  // Y el genérico sigue siendo una pregunta, no una elección.
  assert.equal(anclar(JAPONESA, 'ramen').estado, 'ambiguo');
});

await t('M13. dos negocios con vocabulario parecido no se contaminan', async () => {
  const OTRO = [{ id: 9, nombre: 'CHILAQUILES', productos: [
    { id: 91, nombre: 'Chilaquiles Sencillos', orden: 0, precio: 150, disponible: true,
      modificadores: [g('Salsa', 1, 1, ['Roja', 'Verde'])] }] }];
  // La suiza existe en el primer negocio y NO en el segundo. Nada del primero
  // puede sostener una elección en el segundo.
  const r = anclarPropuestas({
    catalogo: OTRO, carrito: { items: [] }, evidencia: 'chilaquiles suizos',
    propuestas: [propuesta('Chilaquiles Sencillos', [grupo('tipo', 'suiza')])],
  });
  const puestas = r.propuestas[0]?.valorNuevo?.modificadores?.flatMap((m) => m.opciones) || [];
  assert.deepEqual(puestas, [], `se coló una opción del otro negocio: ${JSON.stringify(puestas)}`);
  // Y en el primero sigue resolviendo.
  const r2 = anclarPropuestas({
    catalogo: CARTA, carrito: { items: [] }, evidencia: 'chilaquiles suizos',
    propuestas: [propuesta('Chilaquiles Sencillos', [grupo('tipo', 'suiza')])],
  });
  assert.deepEqual(r2.propuestas[0].valorNuevo.modificadores.flatMap((m) => m.opciones), ['Suiza']);
});

// ═══════════════════════════════════════════════════════════════════════════
// M14–M16 · LOS TRES QUE NO SE PUEDEN PERDER
// ═══════════════════════════════════════════════════════════════════════════

await t('M14. «frijoles con chorizo» sigue resolviendo Frijolitos con chorizo', async () => {
  const rs = await conversar([
    { cliente: 'Quiero unos Chilaquiles Sencillos con frijoles con chorizo',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('acompañamiento', 'frijoles con chorizo')])] } },
  ]);
  assert(opcsDe(rs[0]).includes('Frijolitos con chorizo'), JSON.stringify(opcsDe(rs[0])));
});

await t('M15. «huevo estrellado» sigue resolviendo Huevos Estrellados', async () => {
  const rs = await conversar([
    { cliente: 'Quiero unos Chilaquiles Sencillos con huevo estrellado',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('proteina', 'huevo estrellado')])] } },
  ]);
  assert(opcsDe(rs[0]).includes('Huevos Estrellados'), JSON.stringify(opcsDe(rs[0])));
});

await t('M16. «suizos» sigue resolviendo Suiza, y «salsa suiza» también', async () => {
  const rs = await conversar([
    { cliente: 'Quiero unos Chilaquiles Sencillos suizos',
      borrador: { items: [it('Chilaquiles Sencillos', [grupo('tipo', 'suizos')])] } },
  ]);
  assert(opcsDe(rs[0]).includes('Suiza'), JSON.stringify(opcsDe(rs[0])));
  // «salsa» no está en el nombre de la opción. La sostienen DOS cosas a la vez,
  // y conviene decirlo porque si una se rompiera la otra taparía el hueco: va
  // DELANTE (es el género, no descalifica) y además la explica el GRUPO.
  const r = anclarPropuestas({
    catalogo: CARTA, carrito: { items: [] }, evidencia: 'con salsa suiza',
    propuestas: [propuesta('Chilaquiles Sencillos', [grupo('tipo', 'salsa suiza')])],
  });
  assert.deepEqual(r.propuestas[0].valorNuevo.modificadores.flatMap((m) => m.opciones), ['Suiza'],
    JSON.stringify(r.descartados));
});

await t('M18. descalifica lo que dijo el CLIENTE, no lo que adivinó el modelo', async () => {
  // El modelo propone una variante por su cuenta y el cliente sólo nombró un
  // sabor. Si la palabra del modelo contara como evidencia, su suposición sería
  // vinculante y dejaría fuera a la presentación que sí encaja: el modelo
  // propone, el catálogo identifica, y el texto del cliente es lo único que
  // autoriza. Carta propia, sin una palabra en común con las otras.
  const PIZZAS = [{ id: 1, nombre: 'PIZZAS', productos: [
    { id: 61, nombre: 'Pizza Individual', orden: 0, precio: 120, disponible: true,
      modificadores: [g('Sabor', 1, 1, ['Pepperoni', 'Hawaiana', 'Mexicana'])] },
    { id: 62, nombre: 'Pizza Mitad y Mitad', orden: 1, precio: 160, disponible: true,
      modificadores: [g('Sabor', 2, 2, ['Pepperoni', 'Hawaiana', 'Mexicana'])] }] }];
  const delModelo = anclarLinea({
    catalogo: PIZZAS, nombrePropuesto: 'Pizza Mitad y Mitad',
    evidencia: 'quiero una pizza de pepperoni', dichoDelCliente: 'quiero una pizza de pepperoni',
  });
  assert.equal(delModelo.estado, 'resuelto', `${delModelo.estado} / ${delModelo.motivo}`);
  assert.equal(delModelo.producto.nombre, 'Pizza Individual',
    `la suposición del modelo se volvió vinculante: ${delModelo.producto?.nombre}`);
  // Y con la MISMA forma, una palabra que el cliente sí dijo descalifica.
  const delCliente = anclarLinea({
    catalogo: PIZZAS, nombrePropuesto: 'Pizza de birria',
    evidencia: 'Pizza de birria', dichoDelCliente: 'quiero una pizza de birria',
  });
  assert.equal(delCliente.estado, 'sin_candidatos', `resolvió ${delCliente.producto?.nombre}`);
  assert.deepEqual(delCliente.noReconocidas, ['birria'], JSON.stringify(delCliente.noReconocidas));
});

// ═══════════════════════════════════════════════════════════════════════════
// M19–M24 · LO QUE NO ES UNA PETICIÓN NO PUEDE NEGAR NADA
// ═══════════════════════════════════════════════════════════════════════════
//
// Una auditoría del propio motor encontró que la regla, tal como se escribió
// primero, convertía frases perfectamente claras en rechazos. Son tres clases,
// y ninguna se arregla con un umbral: se arreglan distinguiendo qué parte de lo
// que dijo el cliente AFIRMA algo sobre lo que quiere.

const CANTINA = [
  { id: 1, nombre: 'TORTAS', productos: [
    { id: 11, nombre: 'Torta de Pierna', orden: 0, precio: 90, disponible: true,
      modificadores: [g('Complemento', 0, 2, ['Jalapeño', 'Aguacate'], false)] }] },
  { id: 2, nombre: 'BEBIDAS', productos: [
    { id: 21, nombre: 'Coca Cola', orden: 0, precio: 35, disponible: true, modificadores: [] }] },
];

await t('M19. una EXCLUSIÓN no es una petición: «sin chile» no niega la torta', async () => {
  // El error al revés, y el peor de todos: el cliente quita el chile y el bot le
  // niega el producto POR el chile. `MARCAS_DE_NOTA` ya existía para esto.
  const r = anclar(CANTINA, 'Torta de pierna sin chile');
  assert.equal(r.estado, 'resuelto', `${r.estado} / ${JSON.stringify(r.noReconocidas)}`);
  assert.equal(r.producto.nombre, 'Torta de Pierna');
  assert.deepEqual(palabrasSinExplicar('torta sin chile', ['Torta de Pierna']), []);
});

await t('M20. la LOGÍSTICA no es un atributo del menú: «para llevar» tampoco', async () => {
  const r = anclar(CANTINA, 'Torta de pierna para llevar');
  assert.equal(r.estado, 'resuelto', `${r.estado} / ${JSON.stringify(r.noReconocidas)}`);
  assert.deepEqual(palabrasSinExplicar('torta a domicilio', ['Torta de Pierna']), []);
});

await t('M21. un intensificador encabeza una preparación: «bien fría»', async () => {
  const r = anclar(CANTINA, 'Coca bien fria');
  assert.equal(r.estado, 'resuelto', `${r.estado} / ${JSON.stringify(r.noReconocidas)}`);
  assert.equal(r.producto.nombre, 'Coca Cola');
});

await t('M22. el GÉNERO va delante y no descalifica; la ESPECIE va detrás y sí', async () => {
  // «chile jalapeño» contra una opción llamada «Jalapeño» en un grupo llamado
  // «Complemento»: nadie escribió «chile» en la carta, y el chile existe.
  const r = anclarPropuestas({
    catalogo: CANTINA, carrito: { items: [] }, evidencia: 'la torta con chile jalapeño',
    propuestas: [propuesta('Torta de Pierna', [grupo('extras', 'chile jalapeño')])],
  });
  assert.deepEqual(r.propuestas[0].valorNuevo.modificadores.flatMap((m) => m.opciones), ['Jalapeño'],
    JSON.stringify(r.descartados));
  // Y la simétrica sigue cayendo: lo que va DETRÁS sí tiene que explicarse.
  assert.deepEqual(palabrasSinExplicar('queso azul', ['Queso Panela en Salsa', 'Proteina']), ['azul']);
  assert.deepEqual(palabrasSinExplicar('chile jalapeño', ['Jalapeño', 'Complemento']), []);
});

await t('M23. una opción que no existe NUNCA se cae en silencio', async () => {
  // La otra mitad de §8: no elegir el queso más parecido es correcto, y callarlo
  // dejaría al cliente con un platillo sin queso, sin explicación y con el grupo
  // requerido vacío preguntando lo mismo turno tras turno.
  const rs = await conversar([
    { cliente: 'Quiero un guiso del dia con queso azul',
      borrador: { items: [it('Guiso del dia', [grupo('relleno', 'Queso azul')])] } },
  ], MINIMA);
  const a = (rs[0].aclaraciones || []).find((x) => x.tipo === 'opcion_inexistente');
  assert(a, `nadie dijo nada: ${JSON.stringify((rs[0].aclaraciones || []).map((x) => x.tipo))}`);
  assert(a.noReconocidas.includes('azul'), JSON.stringify(a));
  assert(a.candidatos.includes('Queso Panela en Salsa'), `no ofrece las reales: ${JSON.stringify(a.candidatos)}`);
  assert(/azul/i.test(a.pregunta) && /panela/i.test(a.pregunta), a.pregunta);
});

await t('M24. la opción buena no la envenena una más fuerte que no cubre', async () => {
  // «pollito asado» contra «Pechuga de pollo asada»: la cobertura se aplica
  // ANTES del desempate, así que una candidata que no explica «asado» no puede
  // ganar y dejar el grupo vacío.
  const POLLOS = [{ id: 1, nombre: 'GUISOS', productos: [
    { id: 71, nombre: 'Guiso del dia', orden: 0, precio: 100, disponible: true,
      modificadores: [g('Proteina', 1, 1, ['Pechuga de pollo asada', 'Pollo en mole'])] }] }];
  const r = anclarPropuestas({
    catalogo: POLLOS, carrito: { items: [] }, evidencia: 'un guiso con pollito asado',
    propuestas: [propuesta('Guiso del dia', [grupo('proteina', 'pollito asado')])],
  });
  assert.deepEqual(r.propuestas[0].valorNuevo.modificadores.flatMap((m) => m.opciones),
    ['Pechuga de pollo asada'], JSON.stringify(r.descartados));
});

// ── Y el módulo sigue sin saber de ningún restaurante ────────────────────
await t('M17. ni el motor ni la regla mencionan un solo producto, grupo o negocio', async () => {
  const { readFileSync } = await import('node:fs');
  for (const ruta of ['../src/mesero-whatsapp/anclajeAlCatalogo.js', '../src/orders/evidenciaDeEleccion.js']) {
    const fuente = readFileSync(new URL(ruta, import.meta.url), 'utf8');
    const codigo = fuente.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const palabra of ['chilaquil', 'mapolato', 'frijol', 'suiza', 'chipotle', 'queso', 'panela',
      'azul', 'salsa', 'torta', 'salmon', 'pollo', 'carne', 'cafe', 'taco', 'ramen', 'obispado']) {
      assert(!new RegExp(palabra, 'i').test(codigo),
        `${ruta} menciona "${palabra}" fuera de los comentarios: deja de ser genérico`);
    }
  }
});

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
