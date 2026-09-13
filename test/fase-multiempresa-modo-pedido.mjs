// UN PROCESO, MUCHOS NEGOCIOS, UN MODO CADA UNO.
//
// El 12-sep se apuntó producción a esta rama para observar en sombra a un
// negocio con el bot apagado. Al mirar el interruptor del bot negocio por
// negocio aparecieron otros dos con el bot ENCENDIDO: para ellos el despliegue
// no era una observación, era el reconciliador nuevo decidiendo pedidos reales.
// Se revirtió en tres minutos y no hubo tráfico, pero la garantía nunca existió:
// `PEDIDO_SHADOW_MODE` es del proceso y la pregunta es de cada negocio.
//
// Esta suite defiende lo que faltaba: que desplegar no le cambie el
// comportamiento a NADIE que no lo haya pedido, y que tres negocios con tres
// modos distintos convivan en el MISMO runtime sin contaminarse.
//
// Los negocios se crean aquí y se identifican por su id: no hay un solo slug ni
// UUID de producción en este archivo.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const mock = await arrancarAnthropicMock();
process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-multiempresa';
process.env.PORT = process.env.PORT || '4322';

const { pool } = await import('../src/services/database.js');
assert(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname),
  'Solo base local de pruebas');

const { modoDelPedido, esVerdadero } = await import('../src/orders/modoDelPedido.js');
const { procesarMensaje } = await import('../src/agent/brain.js');
const { getSession, deleteSession } = await import('../src/agent/session.js');

let ok = 0, fail = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); ok++; console.log(`  OK  ${nombre}`); }
  catch (e) { fail++; fallos.push(`${nombre}: ${e.message}`); console.log(`FALLO ${nombre}: ${e.message}`); }
}
const q = async (s, p) => (await pool.query(s, p)).rows[0];
const mod = (grupo, ...opciones) => ({ grupo, opciones });

// ── Tres negocios con la MISMA carta ────────────────────────────────────────
// Igual a propósito: si los tres piden lo mismo y se comportan distinto, la
// diferencia es del modo y de nada más.
async function sembrarNegocio(etiqueta) {
  const neg = (await q('INSERT INTO negocios(nombre,slug) VALUES ($1,$2) RETURNING id',
    [`Multi ${etiqueta}`, `multi-${etiqueta}-${randomUUID()}`])).id;
  const cat = (await q('INSERT INTO menu_categorias(negocio_id,nombre,activa) VALUES($1,$2,true) RETURNING id',
    [neg, 'Carta'])).id;
  const plato = (await q(`INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio,disponible)
    VALUES($1,$2,'Plato Base',150,true) RETURNING id`, [neg, cat])).id;
  const gid = (await q(`INSERT INTO menu_modificadores_grupos(negocio_id,producto_id,nombre,requerido,minimo,maximo)
    VALUES($1,$2,'Salsa',true,1,1) RETURNING id`, [neg, plato])).id;
  for (const o of ['Roja', 'Verde']) {
    await pool.query(`INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,disponible)
      VALUES($1,$2,$3,0,true)`, [neg, gid, o]);
  }
  // Un segundo producto, para poder pedir dos cosas y ver si una se pierde.
  await pool.query(`INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio,disponible)
    VALUES($1,$2,'Postre Base',60,true)`, [neg, cat]);
  return neg;
}

const A = await sembrarNegocio('a');   // legacy, bot ON
const B = await sembrarNegocio('b');   // shadow, bot OFF
const C = await sembrarNegocio('c');   // v2 productivo, bot ON

const ponerFlag = async (neg, clave, valor) => {
  if (valor === null) { await pool.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2', [neg, clave]); return; }
  await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $3`, [neg, clave, valor]);
};

// El turno del modelo: propuesta + menciones, como en el resto de las suites.
const encolarTurno = (borrador, menciones = []) => {
  mock.drenar();
  mock.encolarRespuesta('Claro. <PEDIDO_BORRADOR>' + JSON.stringify(borrador) + '</PEDIDO_BORRADOR>');
  mock.encolarRespuesta(JSON.stringify({ menciones }));
};

// LA SEÑAL QUE DISTINGUE V2 DE LEGACY, sin depender de textos.
//
// El carrito es lo único que V2 crea y legacy no. Que exista, y que conserve un
// artículo que el modelo olvidó, es la huella de que corrió el reconciliador.
const tieneCarrito = (sid) => Array.isArray(getSession(sid).carrito?.items);
const itemsDelCarrito = (sid) => (getSession(sid).carrito?.items || []).map((i) => i.nombre);

const DOS = { items: [
  { nombre: 'Plato Base', cantidad: 1, modificadores: [mod('Salsa', 'Roja')] },
  { nombre: 'Postre Base', cantidad: 1, modificadores: [] },
] };
const SOLO_UNO = { items: [{ nombre: 'Plato Base', cantidad: 1, modificadores: [mod('Salsa', 'Roja')] }] };
const PEDIDO = 'quiero un plato base con salsa roja y un postre base';

/**
 * La conversación que separa legacy de V2, en tres turnos:
 *
 *   1. el cliente pide DOS cosas y el modelo las anota bien;
 *   2. contesta la modalidad y el modelo OLVIDA el postre;
 *   3. contesta la forma de pago y el backend le enseña la cuenta.
 *
 * En legacy la cuenta del turno 3 llega sin el postre. En V2 llega completa.
 * Es la misma conversación para los tres negocios: lo único que cambia es el
 * modo, así que cualquier diferencia es del modo.
 */
async function conversacionQueOlvida(sid, neg, tel) {
  deleteSession(sid);
  encolarTurno(DOS);
  await procesarMensaje(sid, PEDIDO, null, 'whatsapp', neg, tel);
  encolarTurno({ ...SOLO_UNO, modalidad: 'recoger' });
  await procesarMensaje(sid, 'para recoger', null, 'whatsapp', neg, tel);
  encolarTurno({ ...SOLO_UNO, modalidad: 'recoger', forma_pago: 'efectivo' });
  return procesarMensaje(sid, 'en efectivo', null, 'whatsapp', neg, tel);
}

try {

// ── El estado de partida ───────────────────────────────────────────────────
await ponerFlag(A, 'pedido_reconciliador_v2', null);
await ponerFlag(A, 'pedido_shadow', null);
await ponerFlag(B, 'pedido_shadow', 'true');
await ponerFlag(C, 'pedido_reconciliador_v2', 'true');
process.env.PEDIDO_SHADOW_MODE = 'true';

await t('M1. negocio A sin flags: LEGACY, el carrito ni se crea', async () => {
  const sid = 'multi-a1-' + randomUUID();
  const r = await conversacionQueOlvida(sid, A, '5210000000401');
  assert.equal(tieneCarrito(sid), false,
    `un negocio legacy no puede tener carrito — ${JSON.stringify(getSession(sid).carrito)}`);
  assert.doesNotMatch(r.texto || '', /Postre/i,
    `y por tanto pierde el plato olvidado, como en main — ${r.texto}`);
});

await t('M2. negocio B con shadow: el modo lo dice, y no toca el pedido', async () => {
  const modo = await modoDelPedido(B);
  assert.deepEqual({ v2: modo.v2, shadow: modo.shadow }, { v2: false, shadow: true }, JSON.stringify(modo));
  // Aunque le llegara un turno por el camino productivo, sigue siendo legacy:
  // la sombra vive en el canal, no aquí.
  const sid = 'multi-b1-' + randomUUID();
  await conversacionQueOlvida(sid, B, '5210000000402');
  assert.equal(tieneCarrito(sid), false, 'shadow no es V2: el pedido productivo sigue legacy');
});

await t('M3. negocio C con v2: el reconciliador decide de verdad', async () => {
  const sid = 'multi-c1-' + randomUUID();
  const r = await conversacionQueOlvida(sid, C, '5210000000403');
  assert.equal(itemsDelCarrito(sid).length, 2,
    `el carrito conserva lo que el modelo olvidó — ${JSON.stringify(itemsDelCarrito(sid))}`);
  assert.match(r.texto || '', /Postre/i, `y la cuenta le llega completa — ${r.texto}`);
});

await t('M4. A, B y C intercalados: cada uno mantiene lo suyo', async () => {
  const sa = 'multi-x-a-' + randomUUID(), sb = 'multi-x-b-' + randomUUID(), sc = 'multi-x-c-' + randomUUID();
  for (const s of [sa, sb, sc]) deleteSession(s);
  // Turno 1 de los tres, alternando.
  for (const [sid, neg, tel] of [[sa, A, '5210000000411'], [sb, B, '5210000000412'], [sc, C, '5210000000413']]) {
    encolarTurno(DOS);
    await procesarMensaje(sid, PEDIDO, null, 'whatsapp', neg, tel);
  }
  // Turno 2 de los tres, en otro orden, con el modelo olvidando el postre.
  for (const [sid, neg, tel] of [[sc, C, '5210000000413'], [sa, A, '5210000000411'], [sb, B, '5210000000412']]) {
    encolarTurno({ ...SOLO_UNO, modalidad: 'recoger' });
    await procesarMensaje(sid, 'para recoger', null, 'whatsapp', neg, tel);
  }
  assert.equal(tieneCarrito(sa), false, 'A sigue legacy después de que C usara V2');
  assert.equal(tieneCarrito(sb), false, 'B sigue legacy en el camino productivo');
  assert.equal(itemsDelCarrito(sc).length, 2, `C sigue en V2 — ${JSON.stringify(itemsDelCarrito(sc))}`);
});

await t('M5. encender shadow en B no cambia a A', async () => {
  await ponerFlag(B, 'pedido_shadow', 'true');
  const sid = 'multi-a2-' + randomUUID();
  await conversacionQueOlvida(sid, A, '5210000000404');
  assert.equal(tieneCarrito(sid), false, 'A no se entera de lo que se encienda en B');
  assert.equal((await modoDelPedido(A)).modo, 'legacy');
});

await t('M6. encender v2 en C no cambia a A ni a B', async () => {
  await ponerFlag(C, 'pedido_reconciliador_v2', 'true');
  assert.equal((await modoDelPedido(A)).modo, 'legacy');
  assert.equal((await modoDelPedido(B)).modo, 'shadow');
  assert.equal((await modoDelPedido(C)).modo, 'v2');
});

await t('M7. negocio recién creado, sin ninguna configuración: LEGACY', async () => {
  const nuevo = await sembrarNegocio('sin-config');
  const modo = await modoDelPedido(nuevo);
  assert.deepEqual({ v2: modo.v2, shadow: modo.shadow }, { v2: false, shadow: false }, JSON.stringify(modo));
  const sid = 'multi-nuevo-' + randomUUID();
  await conversacionQueOlvida(sid, nuevo, '5210000000405');
  assert.equal(tieneCarrito(sid), false, 'sin configuración explícita no participa de nada');
});

await t('M8. global apagada + negocio con shadow: NO observa', async () => {
  const antes = process.env.PEDIDO_SHADOW_MODE;
  process.env.PEDIDO_SHADOW_MODE = 'false';
  try {
    assert.equal((await modoDelPedido(B)).shadow, false, 'la global es un interruptor de emergencia real');
  } finally { process.env.PEDIDO_SHADOW_MODE = antes; }
});

await t('M9. global encendida + negocio sin shadow: NO observa', async () => {
  process.env.PEDIDO_SHADOW_MODE = 'true';
  assert.equal((await modoDelPedido(A)).shadow, false,
    'la global sola no puede encender a nadie: esa fue la falla del 12-sep');
});

await t('M10. apagar pedido_shadow vale para el siguiente mensaje, sin reiniciar', async () => {
  assert.equal((await modoDelPedido(B)).shadow, true);
  await ponerFlag(B, 'pedido_shadow', 'false');
  assert.equal((await modoDelPedido(B)).shadow, false, 'sin caché, el cambio es inmediato');
  await ponerFlag(B, 'pedido_shadow', 'true');
  assert.equal((await modoDelPedido(B)).shadow, true, 'y se puede volver a encender igual de rápido');
});

await t('M11. apagar v2 devuelve a C a legacy en el siguiente mensaje', async () => {
  await ponerFlag(C, 'pedido_reconciliador_v2', 'false');
  const sid = 'multi-c2-' + randomUUID();
  await conversacionQueOlvida(sid, C, '5210000000406');
  assert.equal(tieneCarrito(sid), false, 'vuelve a legacy sin reiniciar el proceso');
  await ponerFlag(C, 'pedido_reconciliador_v2', 'true');
  const sid2 = 'multi-c3-' + randomUUID();
  await conversacionQueOlvida(sid2, C, '5210000000407');
  assert.equal(itemsDelCarrito(sid2).length, 2, 'y vuelve a V2 igual de rápido');
});

await t('M12. valores inválidos, vacíos o nulos: fail safe a LEGACY', async () => {
  const raro = await sembrarNegocio('raro');
  for (const valor of ['', 'false', '0', 'si', 'yes', '1', 'TRUE ', 'null', 'undefined']) {
    await ponerFlag(raro, 'pedido_reconciliador_v2', valor);
    const esperado = valor.trim().toLowerCase() === 'true';
    assert.equal((await modoDelPedido(raro)).v2, esperado,
      `${JSON.stringify(valor)} debía dar v2=${esperado}`);
  }
  await ponerFlag(raro, 'pedido_reconciliador_v2', null);
  assert.equal((await modoDelPedido(raro)).v2, false, 'clave borrada = legacy');
  // Y sin negocio, tampoco.
  for (const sinId of [null, undefined, '', '   ']) {
    assert.equal((await modoDelPedido(sinId)).modo, 'legacy', `sin negocio (${JSON.stringify(sinId)}) = legacy`);
  }
});

await t('M13. error leyendo la configuración: LEGACY, jamás V2', async () => {
  // Se rompe la lectura de verdad, no con un mock del módulo: se le pasa un id
  // que hace fallar la consulta (uuid inválido para la columna).
  const modo = await modoDelPedido('no-soy-un-uuid');
  assert.deepEqual({ v2: modo.v2, shadow: modo.shadow }, { v2: false, shadow: false },
    `un fallo de lectura no puede encender nada — ${JSON.stringify(modo)}`);
});

await t('M13b. si la LECTURA lanza de verdad: LEGACY, jamás V2', async () => {
  // El caso anterior pasa por `obtenerConfiguracion`, que se traga sus propios
  // errores y devuelve {}. Aquí se rompe la lectura DE VERDAD, para que el
  // catch de `modoDelPedido` sea una garantía comprobada y no una intención.
  const modo = await modoDelPedido(C, {
    leerConfiguracion: () => { throw new Error('base caída'); },
  });
  assert.deepEqual({ v2: modo.v2, shadow: modo.shadow }, { v2: false, shadow: false },
    `un negocio que HOY es v2 cae a legacy si no se puede leer su configuración — ${JSON.stringify(modo)}`);
});
await t('M14. un error en el turno de un negocio no arrastra a los demás', async () => {
  const sa = 'multi-err-a-' + randomUUID(), sc = 'multi-err-c-' + randomUUID();
  deleteSession(sa); deleteSession(sc);
  // C recibe un borrador ilegible: su turno se resuelve como pueda.
  mock.drenar();
  mock.encolarRespuesta('Claro. <PEDIDO_BORRADOR>{ esto no es json }</PEDIDO_BORRADOR>');
  mock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  await procesarMensaje(sc, PEDIDO, null, 'whatsapp', C, '5210000000408').catch(() => {});
  // A, justo después, sigue legacy y funcionando.
  const r = await conversacionQueOlvida(sa, A, '5210000000409');
  assert.equal(tieneCarrito(sa), false, 'A no hereda nada del fallo de C');
  assert.ok(r, 'y su turno se atiende');
  assert.equal((await modoDelPedido(A)).modo, 'legacy');
});

await t('M15. el modo de un negocio no se filtra al siguiente mensaje de otro', async () => {
  // El riesgo real de un proceso compartido: que el modo se resuelva una vez y
  // se reutilice. Se alternan C (v2) y A (legacy) cinco veces seguidas.
  for (let i = 0; i < 5; i++) {
    const sc = `multi-alt-c${i}-` + randomUUID(), sa = `multi-alt-a${i}-` + randomUUID();
    await conversacionQueOlvida(sc, C, '5210000000410');
    assert.equal(itemsDelCarrito(sc).length, 2, `vuelta ${i}: C debía seguir en V2`);
    await conversacionQueOlvida(sa, A, '5210000000411');
    assert.equal(tieneCarrito(sa), false, `vuelta ${i}: A debía seguir legacy`);
  }
});

// ── El escenario exacto que se quiere desplegar ────────────────────────────
await t('ESCENARIO. uno en sombra y dos en legacy, en el mismo proceso', async () => {
  // Los nombres son de la prueba, no del código: aquí solo hay ids.
  const obispado = B, acuna = A, nonna = await sembrarNegocio('nonna');
  await ponerFlag(obispado, 'pedido_shadow', 'true');
  await ponerFlag(obispado, 'pedido_reconciliador_v2', 'false');
  for (const n of [acuna, nonna]) {
    await ponerFlag(n, 'pedido_shadow', 'false');
    await ponerFlag(n, 'pedido_reconciliador_v2', 'false');
  }
  process.env.PEDIDO_SHADOW_MODE = 'true';

  assert.deepEqual(await modoDelPedido(obispado).then((m) => ({ v2: m.v2, shadow: m.shadow })),
    { v2: false, shadow: true }, 'el del bot apagado: solo observa');
  for (const [etiqueta, n] of [['acuña', acuna], ['nonna', nonna]]) {
    assert.deepEqual(await modoDelPedido(n).then((m) => ({ v2: m.v2, shadow: m.shadow })),
      { v2: false, shadow: false }, `${etiqueta}: legacy productivo, intacto`);
  }
  // Y los dos productivos siguen comportándose como `main` con tráfico real.
  for (const [etiqueta, n, tel] of [['acuña', acuna, '5210000000420'], ['nonna', nonna, '5210000000421']]) {
    const sid = `escenario-${etiqueta}-` + randomUUID();
    const r = await conversacionQueOlvida(sid, n, tel);
    assert.equal(tieneCarrito(sid), false, `${etiqueta} no puede tener carrito`);
    assert.ok(r, `${etiqueta} atendido`);
  }
});

await t('BONUS. shadow y v2 a la vez: manda v2 y no se observa', async () => {
  const ambos = await sembrarNegocio('ambos');
  await ponerFlag(ambos, 'pedido_shadow', 'true');
  await ponerFlag(ambos, 'pedido_reconciliador_v2', 'true');
  const modo = await modoDelPedido(ambos);
  assert.equal(modo.v2, true, 'V2 manda');
  assert.equal(modo.shadow, false, 'y la sombra no corre: observar lo que ya decide no mide nada');
  assert.equal(modo.modo, 'v2');
});

await t('BONUS2. la comparación de la bandera es explícita, no truthiness', () => {
  for (const [v, esperado] of [[undefined, false], ['', false], ['false', false], ['0', false],
    ['no', false], ['1', false], ['true', true], ['TRUE', true], ['  true  ', true]]) {
    assert.equal(esVerdadero(v), esperado, `${JSON.stringify(v)} debía dar ${esperado}`);
  }
});

} finally {
  mock.detener();
  for (const neg of [A, B, C]) {
    for (const tabla of ['configuracion', 'menu_modificadores_opciones', 'menu_modificadores_grupos',
      'menu_productos', 'menu_categorias']) {
      await pool.query(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [neg]).catch(() => {});
    }
  }
  await pool.query(`DELETE FROM negocios WHERE slug LIKE 'multi-%'`).catch(() => {});
  await pool.end();
}

console.log(`\n${fail ? 'CON FALLOS' : 'TODO VERDE'} — ${ok} pasadas, ${fail} fallidas`);
for (const f of fallos) console.log('  · ' + f);
process.exit(fail ? 1 : 0);
