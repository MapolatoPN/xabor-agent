// ─── MENÚ, EVENTOS Y PEDIDOS PARA OTRO DÍA ────────────────────────────────
//
// Las tres decisiones del dueño del 23-sep-2026, cada una con su prueba:
//
//   1. el agente puede mandar la imagen del menú;
//   2. un pedido para otro día va a la TIENDA EN LÍNEA, no a una persona
//      (y solo a una persona si esa tienda no existe o no agenda);
//   3. catering: se toman cinco datos y llama alguien del equipo. No se
//      propone menú, no se dan precios.
//
// Suite pura: sin Postgres, sin puertos, sin modelo.
import assert from 'node:assert/strict';
import { NOMBRES, CON_EFECTO, validarArgumentos } from '../src/mesero-agente/contratoDeHerramientas.js';
import { crearEjecutor, estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { transicionLegal, CONFIRMADO, ESCALADO, NAVEGANDO } from '../src/mesero-agente/maquinaDeEstados.js';
import { respuestaAPedidoProgramado, enlaceDeTienda } from '../src/mesero-agente/horarioDelAgente.js';
import { esSolicitudDePedidoProgramado } from '../src/mesero-agente/seguridadConversacional.js';

let pasadas = 0;
const fallos = [];
const t = async (nombre, fn) => {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
};

const g = (nombre, minimo, maximo, opciones, requerido = true) => ({
  nombre, requerido, minimo, maximo,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});
const CARTA = [{ id: 1, nombre: 'Desayunos', productos: [
  { id: 90, nombre: 'Hotcakes', precio: 95, disponible: true, orden: 0, modificadores: [] },
  { id: 85, nombre: 'Chilaquiles', precio: 195, disponible: true, orden: 1,
    modificadores: [g('Salsa', 1, 1, ['Roja', 'Verde'])] },
] }];

const nuevo = () => estadoNuevo({ negocioId: 'n1', conversacionId: 'c1' });
const ejecutorDe = (estado, mensaje, efectos = null) => crearEjecutor({
  estado, catalogo: CARTA, precios: { Hotcakes: 95, Chilaquiles: 195 }, mensaje, textoCiclo: mensaje, efectos,
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── A. El menú ──');

await t('A1 · la herramienta existe, tiene efecto y no lleva argumentos', () => {
  assert.ok(NOMBRES.includes('enviar_menu'));
  assert.ok(CON_EFECTO.includes('enviar_menu'),
    'sin efecto no pasaría por el libro y el cliente podría recibir el menú dos veces en un turno');
  assert.equal(validarArgumentos('enviar_menu', {}).ok, true);
  assert.equal(validarArgumentos('enviar_menu', { paginas: 2 }).ok, false, 'aceptó un argumento inventado');
});

await t('A2 · lo manda el canal, y el resultado dice cuántas páginas', async () => {
  const llamadas = [];
  const r = await ejecutorDe(nuevo(), 'me pasas el menú?', {
    enviarMenu: async () => { llamadas.push(1); return { ok: true, paginas: 3 }; },
  }).ejecutar('enviar_menu', {});
  assert.equal(r.aplicado, true, r.motivo);
  assert.equal(r.paginas, 3);
  assert.equal(llamadas.length, 1);
  assert.match(r.nota, /NO repitas/i, 'no le dice al modelo que se calle: diría «aquí está tu menú» encima del texto real');
});

await t('A3 · si el envío falla, NO se da por mandado', async () => {
  const r = await ejecutorDe(nuevo(), 'el menú porfa', {
    enviarMenu: async () => ({ ok: false, motivo: 'meta no contesta' }),
  }).ejecutar('enviar_menu', {});
  assert.equal(r.aplicado, false, 'dio por enviado un menú que no salió');
  assert.match(r.motivo, /no_se_pudo_enviar_el_menu/);
  assert.match(r.motivo, /palabras/, 'no le ofrece al modelo una salida: el cliente se queda sin nada');
});

await t('A4 · sin canal de envío lo dice, no revienta', async () => {
  const r = await ejecutorDe(nuevo(), 'el menú', null).ejecutar('enviar_menu', {});
  assert.equal(r.aplicado, false);
  assert.match(r.motivo, /sin_canal_para_el_menu/);
});

await t('A5 · mandar la carta es legal incluso con el pedido confirmado', () => {
  assert.equal(transicionLegal('enviar_menu', CONFIRMADO).legal, true);
  assert.equal(transicionLegal('enviar_menu', NAVEGANDO).legal, true);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── B. Un pedido para otro día ──');

const TIENDA_OK = { estado: 'publicada', aceptaProgramados: true, slug: 'mapolato-obispado' };

await t('B1 · con tienda que agenda: enlace, y NO se escala', () => {
  const r = respuestaAPedidoProgramado({ configTienda: TIENDA_OK, baseUrl: 'https://xabor.mx' });
  assert.equal(r.escalar, false, 'mandó a una persona algo que el cliente puede hacer solo');
  assert.match(r.texto, /xabor\.mx\/t\/mapolato-obispado/, 'no pegó el enlace');
  assert.match(r.texto, /hoy/i, 'no le deja la puerta abierta a pedir para hoy');
});

await t('B2 · sin tienda, o con tienda que NO agenda: a una persona', () => {
  for (const cfg of [null,
    { estado: 'borrador', aceptaProgramados: true, slug: 'x' },
    { estado: 'publicada', aceptaProgramados: false, slug: 'x' },
    { estado: 'publicada', aceptaProgramados: true, slug: null }]) {
    const r = respuestaAPedidoProgramado({ configTienda: cfg });
    assert.equal(r.escalar, true, `deberia escalar con ${JSON.stringify(cfg)}`);
    assert.ok(!/http/.test(r.texto), 'prometió una tienda que no puede agendar');
  }
});

await t('B3 · el enlace solo sale si la tienda de verdad agenda', () => {
  assert.equal(enlaceDeTienda(TIENDA_OK, { baseUrl: 'https://xabor.mx' }), 'https://xabor.mx/t/mapolato-obispado');
  assert.equal(enlaceDeTienda({ ...TIENDA_OK, aceptaProgramados: false }), null);
});

await t('B4 · un pedido para HOY no se desvía a ningún lado', () => {
  for (const m of ['quiero unos hotcakes', 'me das chilaquiles para recoger', 'a domicilio porfa']) {
    assert.equal(esSolicitudDePedidoProgramado(m, {}), false, `"${m}" se tomó por programado`);
  }
  assert.equal(esSolicitudDePedidoProgramado('quiero pedir para mañana a las 10', {}), true);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── C. Catering: se anota, no se cotiza ──');

await t('C1 · la herramienta no admite precios ni menús', () => {
  assert.ok(NOMBRES.includes('registrar_solicitud_evento'));
  assert.equal(validarArgumentos('registrar_solicitud_evento', { precio: 5000 }).ok, false);
  assert.equal(validarArgumentos('registrar_solicitud_evento', { menu: 'tacos' }).ok, false);
  // Y el tipo de servicio es una lista cerrada: los cinco que dijo el dueño.
  assert.equal(validarArgumentos('registrar_solicitud_evento', { tipo_servicio: 'buffet' }).ok, false);
  for (const s of ['almuerzo', 'comida', 'cena', 'mesa de postres', 'coffee break']) {
    assert.equal(validarArgumentos('registrar_solicitud_evento', { tipo_servicio: s }).ok, true, s);
  }
});

await t('C2 · con datos a medias NO escala: dice qué falta', async () => {
  const estado = nuevo();
  let escalado = 0;
  const efectos = { registrarEvento: async () => { escalado += 1; return { ok: true }; } };
  const r = await ejecutorDe(estado, 'quiero un catering', efectos)
    .ejecutar('registrar_solicitud_evento', { nombre: 'Sol' });
  assert.equal(r.aplicado, true);
  assert.equal(r.registrado, false, 'lo dio por registrado con un solo dato');
  assert.deepEqual(r.faltan, ['lugar', 'fecha_hora', 'tipo_servicio']);
  assert.equal(escalado, 0, 'escaló con el aviso vacío: quien conteste no tendría datos');
  assert.equal(estado.hechos.escalado, false);
});

await t('C3 · los datos se ACUMULAN entre llamadas', async () => {
  const estado = nuevo();
  const recibidos = [];
  const efectos = { registrarEvento: async ({ evento }) => { recibidos.push(evento); return { ok: true }; } };
  const e = () => ejecutorDe(estado, 'para un evento', efectos);
  await e().ejecutar('registrar_solicitud_evento', { nombre: 'Sol' });
  await e().ejecutar('registrar_solicitud_evento', { lugar: 'Salón Las Palmas' });
  await e().ejecutar('registrar_solicitud_evento', { fecha_hora: 'el sábado 5 a las 2', personas: 30 });
  const r = await e().ejecutar('registrar_solicitud_evento', { tipo_servicio: 'comida' });

  assert.equal(r.registrado, true, `no se registró: faltan=${JSON.stringify(r.faltan)}`);
  assert.equal(recibidos.length, 1, 'llamó al efecto más de una vez');
  assert.deepEqual(recibidos[0], {
    nombre: 'Sol', lugar: 'Salón Las Palmas', fecha_hora: 'el sábado 5 a las 2',
    tipo_servicio: 'comida', personas: 30,
  }, 'se perdió por el camino algún dato que el cliente ya había dado');
  assert.match(r.nota, /No le des precios/i);
});

await t('C4 · registrar un evento deja la conversación en manos de una persona', async () => {
  const estado = nuevo();
  await ejecutorDe(estado, 'catering para el sábado', { registrarEvento: async () => ({ ok: true }) })
    .ejecutar('registrar_solicitud_evento', {
      nombre: 'Sol', lugar: 'Las Palmas', fecha_hora: 'sábado 2pm', tipo_servicio: 'mesa de postres' });
  assert.equal(estado.hechos.escalado, true);
  assert.match(estado.motivoEscalado, /mesa de postres/);
});

await t('C5 · si el aviso a la persona no sale, el evento NO se da por registrado', async () => {
  const estado = nuevo();
  const r = await ejecutorDe(estado, 'catering', { registrarEvento: async () => ({ ok: false, motivo: 'sin destino' }) })
    .ejecutar('registrar_solicitud_evento', {
      nombre: 'Sol', lugar: 'Las Palmas', fecha_hora: 'sábado', tipo_servicio: 'cena' });
  assert.equal(r.aplicado, false, 'le dijo al cliente que alguien le llamaría y nadie se enteró');
  assert.equal(estado.hechos.escalado, false);
});

await t('C6 · un evento NO toca el carrito ni el pedido', async () => {
  const estado = nuevo();
  await ejecutorDe(estado, 'unos hotcakes').ejecutar('agregar_producto', { producto_id: '90' });
  const antes = JSON.stringify(estado.carrito);
  await ejecutorDe(estado, 'y catering para el sábado', { registrarEvento: async () => ({ ok: true }) })
    .ejecutar('registrar_solicitud_evento', {
      nombre: 'Sol', lugar: 'Las Palmas', fecha_hora: 'sábado', tipo_servicio: 'almuerzo' });
  assert.equal(JSON.stringify(estado.carrito), antes, 'el evento se coló en el carrito');
});

await t('C7 · con la conversación ya escalada, no se anota otro evento encima', () => {
  assert.equal(transicionLegal('registrar_solicitud_evento', ESCALADO).legal, false);
  assert.equal(transicionLegal('registrar_solicitud_evento', CONFIRMADO).legal, true,
    'después de cerrar un desayuno se tiene que poder pedir un evento');
});

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
