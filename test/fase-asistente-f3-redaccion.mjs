// ASISTENTE DEL RESTAURANTE, Fase 3: las piezas sin base de datos.
//
// Datos INVENTADOS. La IA y Meta son de mentira (se inyectan): esta suite no
// sale a la red. Cubre:
//   S. las cuentas del resumen (diario hasta la misma hora, semanal, pedidos
//      grandes aparte, la sugerencia) y sus 7 variables como las acepta Meta;
//   T. la revisión del texto de la IA en el resumen y en los avisos (cifras que
//      no están en los datos, lenguaje causal, datos personales, largos,
//      elección inválida, control que no se puede quitar, el orden de la IA);
//   G. el costo y el tope de gasto, y la llamada a la IA (lo que se manda, lo
//      que se registra, que nunca lanza);
//   M. el envío a Meta (lo que se manda y cómo se lee cada respuesta);
//   K. la configuración del resumen (número, hora, tope, todo apagado de siempre);
//   Z. el servidor: el reporte de las 22:01 ya no existe y el resumen tiene su
//      reloj, fuera del camino de los pedidos.
import assert from 'assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raiz = (r) => join(__dirname, '..', r);

const R = await import('../src/asistenteRestaurante/reglas.js');
const PR = await import('../src/asistenteRestaurante/priorizar.js');
const RD = await import('../src/asistenteRestaurante/redaccion.js');
const RS = await import('../src/asistenteRestaurante/resumen.js');
const IA = await import('../src/asistenteRestaurante/ia.js');
const EN = await import('../src/asistenteRestaurante/envioResumen.js');
const C = await import('../src/asistenteRestaurante/configuracion.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  if (process.env.CASOS && !new RegExp(process.env.CASOS).test(nombre)) return;
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ═══ S. Las cuentas del resumen ═══════════════════════════════════════════
const HOY = '2026-11-26'; // jueves
const v = (fecha, hora, neta, clase = 'venta') => ({ fecha, hora, neta, clase });
const VENTAS = [
  v(HOY, '10:00', 500), v(HOY, '14:00', 700), v(HOY, '22:00', 300), v(HOY, '13:00', 9000), v(HOY, '15:00', 450, 'cancelado'),
  v('2026-11-19', '11:00', 400), v('2026-11-19', '20:00', 600), v('2026-11-19', '22:30', 1000),
  v('2026-11-20', '12:00', 800),
];
const NEG = { nombre: 'Sucursal Centro' };

await t('S1. diario: hasta la misma hora contra el mismo día de la semana pasada; el pedido grande va aparte', () => {
  const r = RS.calcularResumen({ tipo: 'diario', negocio: NEG, ventas: VENTAS, hoy: HOY, horaCorte: '21:30', umbralGrande: 5000 });
  assert.deepStrictEqual(r.actual, { venta: 1200, tickets: 2, grandes: 1, grandesVenta: 9000 }, 'la venta de después de la hora, la cancelada o la grande entró');
  assert.deepStrictEqual(r.antes, { venta: 1000, tickets: 2, grandes: 0, grandesVenta: 0 }, 'la semana pasada no se cortó a la misma hora');
  assert.strictEqual(r.cambioPct, 20);
  assert.strictEqual(r.periodo, 'jueves 26 nov, hasta las 21:30');
  assert.strictEqual(r.venta, '$1,200 en 2 tickets; el jueves pasado, $1,000 en 2 tickets (+20 %)');
  assert.deepStrictEqual(r.puntos, ['Aparte, 1 pedido grande por $9,000 (no entra en la comparación)']);
  assert.strictEqual(r.sugerencia, 'Mañana es viernes: el viernes pasado vendiste $800 en 1 ticket; prepárate para un ritmo parecido.');
  assert.strictEqual(r.sucursal, 'Sucursal Centro');
});

await t('S2. diario: los avisos de la mañana son los puntos (primero el texto de la IA si lo hay) y dan la sugerencia', () => {
  const elegidos = [
    { tipo: 'descuentos_altos', titulo: 'Descuentos más altos que lo normal (−$600).', sugerencia: 'Revisa quién autorizó los descuentos.' },
    { tipo: 'producto_baja', titulo: '«Molletes» vendió 20 % menos.', sugerencia: 'Revisa el menú.', ia: { titulo: 'Los molletes bajaron 20 %.', sugerencia: 'Pruébalos tú hoy.' } },
    { tipo: 'canal_baja', titulo: 'La tienda en línea bajó.', sugerencia: '' },
  ];
  const r = RS.calcularResumen({ tipo: 'diario', negocio: NEG, ventas: VENTAS, hoy: HOY, horaCorte: '21:30', umbralGrande: 5000, elegidos });
  assert.deepStrictEqual(r.puntos, ['Descuentos más altos que lo normal (−$600).', 'Los molletes bajaron 20 %.', 'La tienda en línea bajó.'], 'nunca más de 3 puntos');
  assert.strictEqual(r.sugerencia, 'Revisa quién autorizó los descuentos.');
  const sinAntes = RS.calcularResumen({ tipo: 'diario', negocio: {}, ventas: [v(HOY, '10:00', 500)], hoy: HOY, horaCorte: '21:30', umbralGrande: 5000 });
  assert.strictEqual(sinAntes.venta, '$500 en 1 ticket; el jueves pasado no hubo ventas para comparar');
  assert.strictEqual(sinAntes.cambioPct, null);
  assert.strictEqual(sinAntes.sucursal, 'tu sucursal');
  assert.strictEqual(sinAntes.sugerencia, 'Revisa mañana en Reportes › Asistente las recomendaciones del asistente.');
});

await t('S3. semanal: lunes a domingo de la semana pasada contra la anterior', () => {
  const lunes = '2026-11-30';
  assert.strictEqual(RS.esLunes(lunes), true);
  assert.strictEqual(RS.esLunes(HOY), false);
  const ventas = [
    v('2026-11-23', '12:00', 1000), v('2026-11-29', '23:50', 500), v('2026-11-30', '09:00', 7000),
    v('2026-11-16', '12:00', 600), v('2026-11-22', '18:00', 400), v('2026-11-15', '12:00', 9999),
  ];
  const r = RS.calcularResumen({ tipo: 'semanal', negocio: NEG, ventas, hoy: lunes, umbralGrande: 5000 });
  assert.deepStrictEqual([r.actual.venta, r.actual.tickets, r.antes.venta, r.antes.tickets], [1500, 2, 1000, 2], 'entró un día fuera de las dos semanas');
  assert.strictEqual(r.cambioPct, 50);
  assert.strictEqual(r.periodo, 'semana del 23 nov al 29 nov');
  assert.match(r.venta, /^\$1,500 en 2 tickets; la semana anterior, \$1,000 en 2 tickets \(\+50 %\)$/);
  assert.strictEqual(r.sugerencia, 'Revisa en Reportes › Ventas los días que más cambiaron.');
});

await t('S4. las 7 variables: nunca vacías, sin saltos de línea, recortadas; el cuerpo cabe en Meta', () => {
  const r = RS.calcularResumen({ tipo: 'diario', negocio: NEG, ventas: VENTAS, hoy: HOY, horaCorte: '21:30', umbralGrande: 5000 });
  const vs = RS.variablesDe(r);
  assert.strictEqual(vs.length, 7);
  assert.deepStrictEqual(vs.slice(3, 6), ['Aparte, 1 pedido grande por $9,000 (no entra en la comparación)', RS.SIN_MAS, RS.NADA]);
  const sucio = RS.variablesDe({ ...r, sucursal: '  Sucursal\n\nCentro\t', puntos: ['x'.repeat(500)], sugerencia: '' });
  assert.strictEqual(sucio[0], 'Sucursal Centro');
  assert.strictEqual(sucio[3].length, 200);
  assert.ok(sucio[3].endsWith('…'));
  assert.ok(sucio.every((x) => x && !/[\r\n\t]/.test(x)), 'una variable quedó vacía o con salto de línea');
  const msg = RS.textoDelMensaje(vs);
  assert.ok(msg.startsWith('Resumen de Sucursal Centro (jueves 26 nov, hasta las 21:30):\n• Venta: $1,200 en 2 tickets'));
  assert.ok(msg.endsWith('Mensaje automático de Xabor; el detalle está en Reportes.'));
  assert.strictEqual((RS.TEXTO_PLANTILLA.match(/\{\{\d\}\}/g) || []).length, 7);
  // Lo peor que puede salir del recorte de emergencia (110 por variable) cabe.
  assert.ok(RS.textoDelMensaje(Array(7).fill('y'.repeat(300)).map((x) => RS.limpiarVariable(x, 110))).length <= RS.MAXIMO_CUERPO);
  const prueba = RS.variablesDePrueba('Sucursal Centro');
  assert.strictEqual(prueba.length, 7);
  assert.ok(prueba.every((x) => x && !x.includes('$')), 'la prueba lleva pesos');
});

// ═══ T. La revisión del texto de la IA ════════════════════════════════════
const R1 = RS.calcularResumen({ tipo: 'diario', negocio: NEG, ventas: VENTAS, hoy: HOY, horaCorte: '21:30', umbralGrande: 5000 });
const bueno = {
  venta: 'Vendiste $1,200 en 2 tickets hasta las 21:30, 20 % más que el jueves pasado ($1,000).',
  puntos: ['Hubo 1 pedido grande de $9,000 que va aparte.'],
  sugerencia: 'Mañana es viernes: el viernes pasado fueron $800; prepárate para algo parecido.',
};

await t('T1. resumen: el texto bueno de la IA se usa entero', () => {
  const a = RS.aplicarRespuestaResumen(R1, bueno);
  assert.deepStrictEqual(a.faltas, []);
  assert.strictEqual(a.conIa, true);
  assert.deepStrictEqual(a.texto, bueno);
  assert.strictEqual(RS.variablesDe(R1, a.texto)[2], bueno.venta);
});

await t('T2. resumen: cada parte que no cumple vuelve al texto de las reglas, sola', () => {
  const casos = [
    [{ venta: 'Vendiste $1,250 en 2 tickets.' }, /venta: cifra que no está en los datos: 1250/],
    [{ venta: 'Vendiste $1,200 porque hubo partido.' }, /venta: lenguaje causal/],
    [{ sugerencia: 'Llama al 878 123 4567 para pedir insumos.' }, /sugerencia: parece dato personal/],
    [{ sugerencia: 'Escríbele a compras@ejemplo.com.' }, /sugerencia: parece dato personal/],
    [{ sugerencia: 'Prepárate.\nY revisa.' }, /sugerencia: salto de línea/],
    [{ sugerencia: 'a'.repeat(191) }, /sugerencia: más de 190 letras/],
    [{ puntos: [] }, /puntos: lista inválida/],
    [{ puntos: ['Uno.', 'Dos.'] }, /puntos: lista inválida/],
    [{ puntos: ['El pedido grande fue de $9,500.'] }, /puntos: cifra que no está en los datos/],
    [{ venta: '' }, /venta: vacío/],
  ];
  for (const [cambio, patron] of casos) {
    const a = RS.aplicarRespuestaResumen(R1, { ...bueno, ...cambio });
    assert.ok(a.faltas.some((f) => patron.test(f)), `${JSON.stringify(cambio)} pasó: ${JSON.stringify(a.faltas)}`);
    const parte = Object.keys(cambio)[0];
    assert.strictEqual(a.texto[parte], undefined, `${parte} malo se usó igual`);
    assert.strictEqual(a.conIa, true, 'las demás partes buenas se tiraron');
  }
  const nada = RS.aplicarRespuestaResumen(R1, null);
  assert.strictEqual(nada.conIa, false);
  assert.deepStrictEqual(RS.variablesDe(R1, nada.texto), RS.variablesDe(R1));
});

const hz = (tipo, impacto, firma) => ({
  tipo, firma: firma || `${tipo}:x`, impacto, titulo: `Prueba ${tipo} (−$${impacto}).`,
  detalle: { numeros: [{ etiqueta: 'Venta', valor: impacto, formato: 'dinero' }], nota: 'n' },
  sugerencia: 'Revisa el menú.', revisar: { numero: 'Venta semanal', valor: 1, formato: 'dinero', el: '2026-12-10' }, frecuencia: 'diaria',
});
// a0 control (elegido) · a1 y a2 «no cupo» · a3 elegido · a4 tipo apagado (fuera de la lista)
const CAND = [hz('descuentos_altos', 600), hz('producto_baja', 2500, 'producto_baja:a'), hz('producto_baja', 1800, 'producto_baja:b'), hz('canal_baja', 3000), hz('producto_sube', 9000)];
const { todos: TODOS } = PR.priorizar(CAND, { hoy: HOY, maximo: 2, tiposApagados: ['producto_sube'] });
// Sin dígitos en los textos: «a0» dentro de un título ya sería una cifra.
const NOMBRE = { a0: 'uno', a1: 'dos', a2: 'tres', a3: 'cuatro', a4: 'cinco', a9: 'nueve' };
const txt = (id, extra = {}) => ({ id, titulo: `Título ${NOMBRE[id]}.`, explicacion: 'Bajó contra su promedio.', sugerencia: 'Revísalo hoy.', ...extra });
const aplicar = (avisos) => RD.aplicarRespuestaAvisos({ todos: TODOS, maximo: 2, hoy: HOY, respuesta: { avisos } });

await t('T3. avisos: lo que ve la IA es solo lo que las reglas dejaron pasar, con los de control como obligatorios', () => {
  assert.deepStrictEqual(TODOS.map((h) => [h.elegido, h.motivo]), [
    [true, 'elegido'], [false, 'no cupo (máximo 2 al día)'], [false, 'no cupo (máximo 2 al día)'], [true, 'elegido'], [false, 'tipo apagado'],
  ]);
  const e = RD.entradaAvisos({ negocio: NEG, hoy: HOY, todos: TODOS, maximo: 2 });
  assert.deepStrictEqual(e.datos.avisos.map((x) => x.id), ['a0', 'a1', 'a2', 'a3'], 'la IA ve un aviso de un tipo apagado');
  assert.deepStrictEqual(e.datos.obligatorios, ['a0']);
  assert.strictEqual(e.datos.avisos[0].grupo, 'control');
  assert.ok(!JSON.stringify(e.datos).includes('firma'), 'a la IA le llega la firma interna');
});

await t('T4. avisos: una elección buena se respeta, con su orden y sin tocar el texto de las reglas', () => {
  const a = aplicar([txt('a1'), txt('a0')]);
  assert.strictEqual(a.estado, 'ok', JSON.stringify(a.faltas));
  const [c0, c1, c2, c3, c4] = a.todos;
  assert.deepStrictEqual([c0.elegido, c1.elegido, c2.elegido, c3.elegido, c4.elegido], [true, true, false, false, false]);
  assert.strictEqual(c1.motivo, 'elegido por la IA');
  assert.strictEqual(c3.motivo, 'la IA eligió otro');
  assert.strictEqual(c4.motivo, 'tipo apagado');
  assert.deepStrictEqual(c1.ia, { titulo: 'Título dos.', explicacion: 'Bajó contra su promedio.', sugerencia: 'Revísalo hoy.', orden: 0 });
  assert.strictEqual(c0.ia.orden, 1);
  assert.strictEqual(c1.titulo, CAND[1].titulo, 'se perdió el título de las reglas');
  assert.strictEqual(c3.ia, null);
});

await t('T5. avisos: una elección que no cumple deja los elegidos de las reglas', () => {
  const casos = [
    [[txt('a3'), txt('a1')], /dejó fuera un aviso de control/],
    [[txt('a0'), txt('a1'), txt('a3')], /más de 2 avisos/],
    [[txt('a0'), txt('a9')], /id desconocido: a9/],
    [[txt('a0'), txt('a4')], /id desconocido: a4/],
    [[txt('a0'), txt('a0')], /id repetido/],
    [[], /no eligió ninguno/],
  ];
  for (const [avisos, patron] of casos) {
    const a = aplicar(avisos);
    assert.strictEqual(a.estado, 'invalida', `${JSON.stringify(avisos.map((x) => x.id))} quedó ${a.estado}`);
    assert.ok(a.faltas.some((f) => patron.test(f)), JSON.stringify(a.faltas));
    assert.deepStrictEqual(a.todos.map((h) => h.elegido), [true, false, false, true, false], 'cambió la elección de las reglas');
    assert.ok(a.todos.every((h) => !h.ia || h.ia.orden === undefined), 'quedó un orden de una elección inválida');
  }
  assert.strictEqual(RD.aplicarRespuestaAvisos({ todos: TODOS, maximo: 2, hoy: HOY, respuesta: { nada: 1 } }).estado, 'invalida');
});

await t('T6. avisos: un texto que no cumple deja ESE aviso con el texto de las reglas («parcial»)', () => {
  const a = aplicar([txt('a0', { explicacion: 'Subió 37 % contra el mes pasado.' }), txt('a3', { titulo: 'La tienda bajó $3,000 el 26 nov de 2026.' })]);
  assert.strictEqual(a.estado, 'parcial');
  assert.ok(a.faltas.some((f) => /explicación: cifra que no está en los datos: 37/.test(f)), JSON.stringify(a.faltas));
  assert.strictEqual(a.todos[0].ia, null);
  assert.strictEqual(a.todos[0].elegido, true);
  assert.strictEqual(a.todos[3].ia.titulo, 'La tienda bajó $3,000 el 26 nov de 2026.', 'la fecha del aviso y su impacto son cifras permitidas');
  const b = aplicar([txt('a0', { sugerencia: 'Bajó debido a la lluvia.' }), txt('a3', { titulo: 'x'.repeat(121) })]);
  assert.strictEqual(b.estado, 'parcial');
  assert.ok(b.faltas.some((f) => /lenguaje causal/.test(f)) && b.faltas.some((f) => /más de 120 letras/.test(f)), JSON.stringify(b.faltas));
});

// ═══ G. Costo, tope y la llamada a la IA ══════════════════════════════════
const NID = '33333333-3333-4333-8333-333333333333';
function dbFalsa(gastado = 0) {
  const registros = [];
  return {
    registros,
    query: async (sql, params) => {
      if (/SUM\(costo_usd\)/.test(sql)) return { rows: [{ usd: gastado }] };
      if (/INSERT INTO asistente_restaurante_gasto_ia/.test(sql)) { registros.push(params); return { rows: [] }; }
      throw new Error(`consulta inesperada: ${sql.slice(0, 60)}`);
    },
  };
}
function iaFalsa(respuesta) {
  const pedidas = [];
  return {
    pedidas,
    messages: { create: async (body) => { pedidas.push(body); if (respuesta instanceof Error) throw respuesta; return respuesta; } },
  };
}
const USO = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 };
const resp = (texto, extra = {}) => ({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: texto }], usage: USO, ...extra });
const pedir = (db, cliente, extra = {}) => IA.pedirJson({
  db, negocioId: NID, tz: 'America/Matamoros', proposito: 'avisos', sistema: 'S', usuario: 'U', esquema: RD.ESQUEMA_AVISOS,
  maxTokens: 4000, topeUsd: 10, cliente, ahora: new Date('2026-11-26T18:00:00Z'), ...extra,
});

await t('G1. el costo de una respuesta y el peor caso de una llamada', () => {
  assert.strictEqual(IA.costoDe(USO), 0.0149);
  assert.strictEqual(IA.costoDe({}), 0);
  assert.strictEqual(IA.costoDe({ input_tokens: -5, output_tokens: 'x' }), 0);
  assert.strictEqual(IA.costoMaximo({ caracteresEntrada: 3000, maxTokens: 4000 }), 0.09);
  assert.strictEqual(IA.MODELO_IA, 'claude-opus-5-5');
});

await t('G2. la llamada: modelo, esfuerzo bajo y formato fijo; se registra lo que costó', async () => {
  const db = dbFalsa(1.5);
  const cli = iaFalsa(resp('{"avisos":[]}'));
  const r = await pedir(db, cli);
  assert.deepStrictEqual(r, { ok: true, datos: { avisos: [] }, costoUsd: 0.0149 });
  assert.strictEqual(cli.pedidas.length, 1);
  const b = cli.pedidas[0];
  assert.strictEqual(b.model, 'claude-opus-5-5');
  assert.strictEqual(b.max_tokens, 4000);
  assert.strictEqual(b.system, 'S');
  assert.deepStrictEqual(b.messages, [{ role: 'user', content: 'U' }]);
  assert.deepStrictEqual(b.output_config, { effort: 'low', format: { type: 'json_schema', schema: RD.ESQUEMA_AVISOS } });
  assert.ok(!('thinking' in b), 'Opus 5.5 rechaza thinking desactivado');
  assert.strictEqual(db.registros.length, 1);
  const [neg, proposito, modelo, ent, sal, cache, costo, resultado] = db.registros[0];
  assert.deepStrictEqual([neg, proposito, modelo, ent, sal, cache, costo, resultado], [NID, 'avisos', 'claude-opus-5-5', 1000, 500, 2100, 0.0149, 'ok']);
});

await t('G3. el tope se revisa ANTES de llamar, con el peor caso', async () => {
  for (const [gastado, tope] of [[9.95, 10], [10, 10], [0, 0], [0, undefined], [0, -1]]) {
    const db = dbFalsa(gastado); const cli = iaFalsa(resp('{}'));
    const r = await pedir(db, cli, { topeUsd: tope });
    assert.strictEqual(r.motivo, 'tope', `gastado ${gastado} de ${tope}: ${JSON.stringify(r)}`);
    assert.strictEqual(cli.pedidas.length, 0, 'llamó a la IA pasando el tope');
    assert.strictEqual(db.registros.length, 0);
  }
  const db = dbFalsa(9.9); const cli = iaFalsa(resp('{"a":1}'));
  assert.strictEqual((await pedir(db, cli)).ok, true, 'con margen para el peor caso no llamó');
});

await t('G4. lo que no sirve se registra y se dice; un error de la API no lanza ni registra', async () => {
  const casos = [
    [resp('{"a":1}', { stop_reason: 'refusal' }), 'error', 'rechazo'],
    [resp('{"a":', { stop_reason: 'max_tokens' }), 'invalida', 'invalida'],
    [resp('no es json'), 'invalida', 'invalida'],
    [resp('[1,2]'), 'invalida', 'invalida'],
    [{ stop_reason: 'end_turn', content: [], usage: USO }, 'invalida', 'invalida'],
  ];
  for (const [respuesta, motivo, resultado] of casos) {
    const db = dbFalsa(); const r = await pedir(db, iaFalsa(respuesta));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.motivo, motivo, JSON.stringify(r));
    assert.strictEqual(db.registros.length, 1);
    assert.strictEqual(db.registros[0][7], resultado);
  }
  const err = Object.assign(new Error('overloaded'), { status: 529 });
  const db = dbFalsa(); const r = await pedir(db, iaFalsa(err));
  assert.deepStrictEqual([r.ok, r.motivo, r.detalle], [false, 'error', '529']);
  assert.strictEqual(db.registros.length, 0);
  const malo = await pedir(dbFalsa(), iaFalsa(resp('{}')), { negocioId: 'otro' });
  assert.strictEqual(malo.motivo, 'error');
  const proposito = await pedir(dbFalsa(), iaFalsa(resp('{}')), { proposito: 'chat' });
  assert.strictEqual(proposito.motivo, 'error');
  const roto = { query: async () => { throw new Error('sin base'); } };
  assert.strictEqual((await pedir(roto, iaFalsa(resp('{}')))).ok, false, 'una base caída lanzó');
});

// ═══ M. El envío a Meta ═══════════════════════════════════════════════════
const CRED = { phoneNumberId: 'PHONE-INVENTADO', accessToken: 'TOKEN-INVENTADO' };
function metaFalsa(status, cuerpo) {
  const pedidas = [];
  const f = async (url, opts) => {
    pedidas.push({ url, opts, body: JSON.parse(opts.body) });
    if (status instanceof Error) throw status;
    return { ok: status >= 200 && status < 300, status, json: async () => { if (cuerpo === undefined) throw new Error('sin json'); return cuerpo; } };
  };
  f.pedidas = pedidas;
  return f;
}
const VARS = RS.variablesDe(R1);

await t('M1. lo que se manda a Meta: la plantilla de la sucursal, al número guardado, con sus 7 variables', async () => {
  const f = metaFalsa(200, { messages: [{ id: 'wamid.INVENTADO' }] });
  const r = await EN.mandarPlantilla({ credenciales: CRED, numero: '8780000001', variables: VARS, fetchImpl: f });
  assert.deepStrictEqual(r, { ok: true, wamid: 'wamid.INVENTADO' });
  const p = f.pedidas[0];
  assert.match(p.url, /\/v20\.0\/PHONE-INVENTADO\/messages$/);
  assert.strictEqual(p.opts.method, 'POST');
  assert.strictEqual(p.opts.headers.Authorization, 'Bearer TOKEN-INVENTADO');
  assert.ok(p.opts.signal, 'sin tiempo máximo');
  assert.strictEqual(p.body.to, '528780000001');
  assert.strictEqual(p.body.type, 'template');
  assert.deepStrictEqual(p.body.template.name, 'xabor_resumen_asistente_v1');
  assert.deepStrictEqual(p.body.template.language, { code: 'es_MX' });
  assert.deepStrictEqual(p.body.template.components, [{ type: 'body', parameters: VARS.map((text) => ({ type: 'text', text })) }]);
});

await t('M2. cada respuesta de Meta: rechazo = «fallo»; sin saber si salió = «incierto» (no se reintenta)', async () => {
  const casos = [
    [metaFalsa(400, { error: { code: 132001 } }), { ok: false, tipo: 'fallo', codigo: 132001 }],
    [metaFalsa(400, { error: { code: 131047 } }), { ok: false, tipo: 'fallo', codigo: 131047 }],
    [metaFalsa(500, { error: { code: 131000 } }), { ok: false, tipo: 'fallo', codigo: 131000 }],
    [metaFalsa(503, undefined), { ok: false, tipo: 'incierto', codigo: null }],
    [metaFalsa(200, {}), { ok: false, tipo: 'incierto', codigo: null }],
    [metaFalsa(new Error('timeout')), { ok: false, tipo: 'incierto', codigo: null }],
  ];
  for (const [f, esperado] of casos) assert.deepStrictEqual(await EN.mandarPlantilla({ credenciales: CRED, numero: '8780000001', variables: VARS, fetchImpl: f }), esperado);
  const f = metaFalsa(200, { messages: [{ id: 'x' }] });
  const malo = await EN.mandarPlantilla({ credenciales: CRED, numero: '12', variables: VARS, fetchImpl: f });
  assert.strictEqual(malo.tipo, 'fallo');
  assert.strictEqual(f.pedidas.length, 0, 'mandó a un número inválido');
});

await t('M3. la hora local de un instante', () => {
  assert.strictEqual(EN.horaHM(new Date('2026-11-27T03:30:00Z'), 'America/Matamoros'), '21:30');
  assert.strictEqual(EN.horaHM(new Date('2026-11-26T15:05:00Z'), 'Asia/Tokyo'), '00:05');
  assert.deepStrictEqual([EN.HORA_SEMANAL, EN.FIN_SEMANAL, EN.PRUEBAS_POR_HORA], ['09:00', '14:00', 5]);
});

// ═══ K. La configuración del resumen ══════════════════════════════════════
await t('K1. de siempre todo apagado; el número a 10 dígitos; lo dañado vuelve a lo de siempre', () => {
  assert.deepStrictEqual(C.RESUMEN_DE_SIEMPRE, { ia: false, topeUsd: 10, diario: false, hora: '21:30', semanal: false, numero: '' });
  assert.deepStrictEqual(C.PLANTILLA_RESUMEN, { nombre: 'xabor_resumen_asistente_v1', idioma: 'es_MX', categoria: 'UTILITY' });
  for (const [entrada, salida] of [['878 000 0001', '8780000001'], ['+52 1 (878) 000-0001', '8780000001'], ['52 8780000001', '8780000001'],
    ['878000000', null], ['18780000001', null], ['abc', null], ['', null]]) {
    assert.strictEqual(C.numeroDeResumen(entrada), salida, entrada);
  }
  assert.strictEqual(C.ultimos4('8780000001'), '0001');
  assert.strictEqual(C.ultimos4('123'), null);
  assert.deepStrictEqual(C.resumenDe('dañado'), C.RESUMEN_DE_SIEMPRE);
  assert.deepStrictEqual(C.resumenDe(JSON.stringify({ ia: true, topeUsd: 99, diario: true, hora: '17:00', semanal: true, numero: '' })),
    { ...C.RESUMEN_DE_SIEMPRE, ia: true }, 'sin número no se puede encender el resumen; el tope y la hora fuera de rango vuelven a los de siempre');
  assert.deepStrictEqual(C.resumenDe(JSON.stringify({ ia: 'sí', topeUsd: 25, diario: true, hora: '22:15', semanal: false, numero: '8780000001' })),
    { ia: false, topeUsd: 25, diario: true, hora: '22:15', semanal: false, numero: '8780000001' });
  assert.deepStrictEqual([C.paraLaRevision({}).ia, C.paraLaRevision({}).topeUsd], [false, 10]);
  assert.deepStrictEqual([C.paraLaRevision({ resumen: { ia: true, topeUsd: 3 } }).ia, C.paraLaRevision({ resumen: { ia: true, topeUsd: 3 } }).topeUsd], [true, 3]);
});

await t('K2. un cambio del resumen se valida completo', () => {
  const ok = { ia: true, topeUsd: 25, diario: true, hora: '22:00', semanal: true, numero: '+52 878 000 0001' };
  assert.deepStrictEqual(C.validarResumen(ok), { ...ok, numero: '8780000001' });
  assert.deepStrictEqual(C.validarResumen({ ...ok, diario: false, semanal: false, numero: '  ' }).numero, '');
  const rechaza = (r, patron) => assert.throws(() => C.validarResumen(r), (e) => e.code === 'CONFIGURACION_INVALIDA' && patron.test(e.message), JSON.stringify(r));
  rechaza(null, /Falta la configuración/);
  rechaza({ ...ok, otro: 1 }, /No se reconoce «otro»/);
  rechaza({ ...ok, ia: 'true' }, /interruptor/);
  for (const tope of [0, 51, 2.5, '10', null]) rechaza({ ...ok, topeUsd: tope }, /entre 1 y 50/);
  for (const hora of ['17:59', '23:31', '9:00', '21:3', '24:00', null]) rechaza({ ...ok, hora }, /entre las 18:00 y las 23:30/);
  rechaza({ ...ok, numero: '87800' }, /10 dígitos/);
  rechaza({ ...ok, numero: 5 }, /Falta el número/);
  rechaza({ ...ok, numero: '' }, /Escribe el número/);
  rechaza({ ...ok, diario: false, numero: '' }, /Escribe el número/);
  const yo = '11111111-1111-4111-8111-111111111111';
  const base = { modo: 'ensayo', tiposApagados: [], ajustes: { ...C.AJUSTES_DE_SIEMPRE }, destinatarios: [yo] };
  assert.strictEqual('resumen' in C.validarCambio(base, { usuarioId: yo }), false, 'sin resumen en el cuerpo, el cambio no debe traerlo (se conserva lo guardado)');
  assert.strictEqual(C.validarCambio({ ...base, resumen: ok }, { usuarioId: yo }).resumen.numero, '8780000001');
});

// ═══ Z. El servidor ═══════════════════════════════════════════════════════
await t('Z1. el reporte de las 22:01 ya no existe; su ruta responde 410 solo a superadmin; el resumen tiene su reloj', () => {
  const S = readFileSync(raiz('src/server.js'), 'utf8');
  assert.ok(!/enviarReporteDiario/.test(S), 'quedó enviarReporteDiario');
  assert.ok(!/===\s*'22:01'/.test(S), 'quedó el reloj de las 22:01');
  assert.match(S, /app\.post\('\/api\/admin\/reporte-diario\/enviar', requireSuperadmin, \(req, res\) => \{\n\s+res\.status\(410\)\.json\(/);
  assert.match(S, /wa_admin_numero:\s+'WHATSAPP_ADMIN_NUMERO'/, 'se quitó WHATSAPP_ADMIN_NUMERO (lo usan las quejas)');
  assert.strictEqual(S.split("import('./asistenteRestaurante/envioResumen.js')").length - 1, 1, 'el reloj del resumen no está o está dos veces');
  assert.match(S, /import\('\.\/asistenteRestaurante\/envioResumen\.js'\)\s*\n\s*\.then\(m => m\.enviarResumenesPendientes\(\)\)\s*\n\s*\.catch\(/, 'el reloj del resumen sin .catch');
  assert.ok(!/from '\.\/asistenteRestaurante\/envioResumen\.js'/.test(S), 'server.js importa el resumen al arrancar (debe ser import dinámico)');
  const RUTAS = readFileSync(raiz('src/asistenteRestaurante/rutas.js'), 'utf8');
  assert.ok(RUTAS.includes('app.post(`${baseCfg}/enviar-prueba`, ...guardias,'), 'la ruta de la prueba sin las guardias');
  assert.match(RUTAS, /const cfg = await editable\(req\);\n\s+if \(!cfg\) return res\.status\(403\)/, 'la prueba no pregunta si quien llama puede cambiar la configuración');
  assert.ok(!/req\.body\??\.numero/.test(RUTAS), 'la prueba toma el número del cuerpo');
  const ENV = readFileSync(raiz('src/asistenteRestaurante/envioResumen.js'), 'utf8');
  for (const prohibido of ['orderManager', 'brain.js', 'whatsapp-meta', 'imprim', 'rappi', 'clip', 'facturapi']) {
    assert.ok(!new RegExp(prohibido, 'i').test(ENV.replace(/^\s*\/\/.*$/gm, '')), `el resumen toca ${prohibido}`);
  }
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) { console.log(fallos.map((f) => ` - ${f}`).join('\n')); }
try { (await import('../src/services/database.js')).pool.end().catch(() => {}); } catch { /* sin base */ }
process.exit(fallidas ? 1 : 0);
