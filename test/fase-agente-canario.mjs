// ─── EL CANARIO Y LA SOMBRA DEL AGENTE ────────────────────────────────────
//
// Lo que se prueba aquí es el ALCANCE: a quién atiende el agente y a quién no.
// Es la pieza que faltó el 12 de septiembre, cuando un experimento pensado
// para un negocio alcanzó a otros dos que tenían el bot encendido.
//
// La afirmación central, y todo lo demás cuelga de ella:
//
//   encender la bandera del negocio SIN decir a quién, no atiende a nadie.
//
// Suite pura: `modoDelPedido` acepta un lector de configuración inyectado, así
// que no hace falta base ni negocios de prueba.
import assert from 'node:assert/strict';
import { modoDelPedido, enElCanario, puedeProcesarTurno } from '../src/orders/modoDelPedido.js';

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

const NEG = '11111111-1111-1111-1111-111111111111';
const con = (cfg) => ({ leerConfiguracion: async () => cfg });
const limpiarEntorno = () => {
  delete process.env.MESERO_AGENTE_MODE;
  delete process.env.MESERO_AGENTE_SHADOW;
};

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── A. El alcance es explícito o no hay alcance ──');

await t('A1 · la bandera del negocio SIN alcance no atiende a nadie', async () => {
  process.env.MESERO_AGENTE_MODE = 'true';
  const m = await modoDelPedido(NEG, { ...con({ mesero_agente_v1: 'true' }), telefono: '528781234567' });
  assert.equal(m.agente, false, 'encender la bandera desplegó el agente a todo el negocio');
  assert.equal(m.canario.via, 'sin_alcance');
  limpiarEntorno();
});

await t('A2 · con lista, SOLO la lista', async () => {
  process.env.MESERO_AGENTE_MODE = 'true';
  const cfg = { mesero_agente_v1: 'true', mesero_agente_telefonos: '52 878 123 4567, 528787654321' };
  const dentro = await modoDelPedido(NEG, { ...con(cfg), telefono: '528781234567' });
  const fuera = await modoDelPedido(NEG, { ...con(cfg), telefono: '528789999999' });
  assert.equal(dentro.agente, true, 'un número de la lista se quedó fuera');
  assert.equal(fuera.agente, false, 'un número que NO está en la lista entró');
  limpiarEntorno();
});

await t('A3 · el formato del teléfono no decide nada: solo los dígitos', () => {
  const lista = '+52 (878) 123-4567';
  for (const t2 of ['528781234567', '+52 878 123 4567', '52-878-123-4567']) {
    assert.equal(enElCanario(t2, { lista }).dentro, true, `no reconoció ${t2}`);
  }
});

await t('A4 · la lista manda sobre el porcentaje', () => {
  // Con lista puesta, un porcentaje al 100 no puede abrir la puerta a nadie más.
  const r = enElCanario('528789999999', { lista: '528781234567', porcentaje: '100' });
  assert.equal(r.dentro, false, 'el porcentaje se saltó la lista');
  assert.equal(r.via, 'lista');
});

await t('A5 · el porcentaje es estable por teléfono, no al azar', () => {
  // Un cliente que salta entre el bot viejo y el nuevo a mitad de pedido es la
  // peor forma posible de hacer un canario.
  const uno = enElCanario('528781234567', { porcentaje: '50' });
  for (let i = 0; i < 25; i += 1) {
    assert.equal(enElCanario('528781234567', { porcentaje: '50' }).dentro, uno.dentro,
      'el mismo teléfono cayó de los dos lados');
  }
});

await t('A6 · un porcentaje reparte de verdad', () => {
  const telefonos = Array.from({ length: 400 }, (_, i) => `52878${String(1000000 + i)}`);
  const dentro = telefonos.filter((x) => enElCanario(x, { porcentaje: '25' }).dentro).length;
  assert.ok(dentro > 40 && dentro < 160, `con 25% cayeron ${dentro} de 400: el reparto no es un reparto`);
  assert.equal(telefonos.filter((x) => enElCanario(x, { porcentaje: '0' }).dentro).length, 0);
  assert.equal(telefonos.filter((x) => enElCanario(x, { porcentaje: '100' }).dentro).length, 400);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── B. Las dos llaves: el kill switch ──');

await t('B1 · sin la llave del PROCESO no atiende, aunque el negocio y el canario digan que sí', async () => {
  limpiarEntorno();
  const m = await modoDelPedido(NEG, {
    ...con({ mesero_agente_v1: 'true', mesero_agente_telefonos: '528781234567' }),
    telefono: '528781234567' });
  assert.equal(m.agente, false, 'MESERO_AGENTE_MODE apagado y aun así atendió: no hay kill switch');
});

await t('B2 · sin la bandera del NEGOCIO tampoco, aunque la llave esté puesta', async () => {
  process.env.MESERO_AGENTE_MODE = 'true';
  const m = await modoDelPedido(NEG, {
    ...con({ mesero_agente_telefonos: '528781234567' }), telefono: '528781234567' });
  assert.equal(m.agente, false);
  limpiarEntorno();
});

await t('B3 · «true» es la palabra, no cualquier cosa que JavaScript crea verdadera', async () => {
  process.env.MESERO_AGENTE_MODE = 'true';
  for (const valor of ['false', '0', 'si', 'yes', '1', '']) {
    const m = await modoDelPedido(NEG, {
      ...con({ mesero_agente_v1: valor, mesero_agente_telefonos: '528781234567' }),
      telefono: '528781234567' });
    assert.equal(m.agente, false, `"${valor}" encendió el agente`);
  }
  limpiarEntorno();
});

await t('B4 · un fallo leyendo la configuración cae APAGADO', async () => {
  process.env.MESERO_AGENTE_MODE = 'true';
  const m = await modoDelPedido(NEG, {
    leerConfiguracion: async () => { throw new Error('la base no contesta'); },
    telefono: '528781234567' });
  assert.equal(m.agente, false, 'un error de lectura encendió el agente');
  assert.equal(m.modo, 'legacy');
  limpiarEntorno();
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── C. La sombra ──');

await t('C1 · la sombra no necesita canario, pero sí sus dos llaves', async () => {
  limpiarEntorno();
  const sinLlave = await modoDelPedido(NEG, { ...con({ mesero_agente_shadow: 'true' }), telefono: '5287' });
  assert.equal(sinLlave.agenteSombra, false, 'observó sin la llave del proceso');

  process.env.MESERO_AGENTE_SHADOW = 'true';
  const conLlave = await modoDelPedido(NEG, { ...con({ mesero_agente_shadow: 'true' }), telefono: '5287' });
  assert.equal(conLlave.agenteSombra, true, 'con las dos llaves no observó');
  // Y observar no es atender.
  assert.equal(conLlave.agente, false);
  limpiarEntorno();
});

await t('C2 · si el agente ATIENDE, no se observa a sí mismo', async () => {
  process.env.MESERO_AGENTE_MODE = 'true';
  process.env.MESERO_AGENTE_SHADOW = 'true';
  const m = await modoDelPedido(NEG, {
    ...con({ mesero_agente_v1: 'true', mesero_agente_shadow: 'true',
      mesero_agente_telefonos: '528781234567' }),
    telefono: '528781234567' });
  assert.equal(m.agente, true);
  assert.equal(m.agenteSombra, false, 'se estaba observando a sí mismo: dos turnos por mensaje');
  limpiarEntorno();
});

await t('C3 · el agente no enciende nada de lo viejo, ni lo viejo a él', async () => {
  process.env.MESERO_AGENTE_MODE = 'true';
  const m = await modoDelPedido(NEG, {
    ...con({ mesero_agente_v1: 'true', mesero_agente_telefonos: '528781234567' }),
    telefono: '528781234567' });
  assert.equal(m.agente, true);
  assert.equal(m.v2, false, 'encendió el reconciliador V2 del bot viejo');
  assert.equal(m.mesero, false, 'encendió el Mesero anterior');
  assert.equal(m.shadow, false);
  assert.equal(m.modo, 'agente');
  limpiarEntorno();
});

await t('C4 · sin teléfono no hay canario por porcentaje', async () => {
  process.env.MESERO_AGENTE_MODE = 'true';
  const m = await modoDelPedido(NEG, {
    ...con({ mesero_agente_v1: 'true', mesero_agente_porcentaje: '100' }), telefono: null });
  // Con 100% sí, porque 100 es «todos» y no depende del reparto; con menos, no.
  assert.equal(m.agente, true);
  const parcial = await modoDelPedido(NEG, {
    ...con({ mesero_agente_v1: 'true', mesero_agente_porcentaje: '50' }), telefono: null });
  assert.equal(parcial.agente, false, 'repartió un tráfico que no puede identificar');
  limpiarEntorno();
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── D. El canario no depende de encender el bot legacy ──');

await t('D1 · el teléfono canario entra con el bot legacy apagado', () => {
  assert.equal(puedeProcesarTurno({ botGlobalActivo: false, agenteCanario: true }), true);
});

await t('D2 · otro teléfono sigue fuera con el bot legacy apagado', () => {
  assert.equal(puedeProcesarTurno({ botGlobalActivo: false, agenteCanario: false }), false);
});

await t('D3 · pausa y takeover cierran también el canario', () => {
  assert.equal(puedeProcesarTurno({ agenteCanario: true, pausado: true }), false);
  assert.equal(puedeProcesarTurno({ agenteCanario: true, takeoverVigente: true }), false);
});

limpiarEntorno();
console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
