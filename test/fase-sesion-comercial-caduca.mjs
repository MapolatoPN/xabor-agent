// ─── UNA SESIÓN COMERCIAL QUE NO CADUCA ANCLA AL CLIENTE AL BOT VIEJO ─────
//
// El incidente, medido en producción el 23-sep-2026 (Mapolato Obispado):
//
//   · `whatsapp-meta.js` desvía al bot anterior TODA conversación con sesión
//     comercial activa, antes del agente de herramientas y con `return`;
//   · nadie marcaba `abandonada` nunca — ni job, ni barrido, ni el flujo;
//   · resultado: 24 clientes anclados al bot viejo, 6 con actividad esa
//     semana, todos con `campos_capturados = {}` y un solo evento.
//
// Uno de ellos llevaba 129 mensajes en siete días pidiendo chilaquiles, y
// ninguno llegó al agente. Su sesión se había abierto el 1 de septiembre.
//
// Uso: DATABASE_URL=... node test/fase-sesion-comercial-caduca.mjs
// Requiere aplicar-migraciones.mjs y seed-datos-prueba.mjs ya corridos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;

const { pool } = await import('../src/services/database.js');
const {
  obtenerSesionActiva, obtenerOCrearSesionActiva, actualizarCamposSesion,
  finalizarSesion, ttlDeSesionHoras, CLAVE_TTL_SESION,
} = await import('../src/services/sesionComercial.js');

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

const TEL = `+52999${Date.now().toString().slice(-7)}`;
const TEL_B = `+52998${Date.now().toString().slice(-7)}`;
const HORA = 3600 * 1000;
const enHoras = (n) => new Date(Date.now() + n * HORA);

const limpiar = async () => {
  for (const [neg, tel] of [[NEG_A, TEL], [NEG_B, TEL_B], [NEG_A, TEL_B]]) {
    const { rows } = await pool.query(
      'SELECT id FROM sesiones_comerciales WHERE negocio_id=$1 AND telefono=$2', [neg, tel]);
    for (const r of rows) {
      await pool.query('DELETE FROM sesiones_comerciales_eventos WHERE sesion_id=$1', [r.id]);
    }
    await pool.query('DELETE FROM sesiones_comerciales WHERE negocio_id=$1 AND telefono=$2', [neg, tel]);
  }
  await pool.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2', [NEG_A, CLAVE_TTL_SESION]);
};
await limpiar();

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── A. La caducidad ──');

await t('A1 · una sesión recién abierta SÍ está activa', async () => {
  const s = await obtenerSesionActiva(NEG_A, TEL);
  assert.strictEqual(s, null, 'había una sesión de antes: la limpieza no limpió');
  await obtenerOCrearSesionActiva(NEG_A, TEL);
  const viva = await obtenerSesionActiva(NEG_A, TEL);
  assert.ok(viva, 'una sesión recién creada no se encontró');
  assert.strictEqual(viva.estado, 'descubriendo_necesidad');
});

await t('A2 · pasado el TTL sin novedad, deja de estar activa', async () => {
  // El reloj se inyecta en vez de retrasar `updated_at`: el trigger
  // `set_updated_at` de la 028 lo pisaría en cualquier UPDATE, así que
  // retrasarlo a mano probaría el trigger, no la regla.
  const s = await obtenerSesionActiva(NEG_A, TEL, { ahora: enHoras(49) });
  assert.strictEqual(s, null, 'una sesión sin novedad en 49 h siguió anclando al cliente');
});

await t('A3 · y se marca abandonada, con su evento — no se ignora en silencio', async () => {
  const { rows } = await pool.query(
    'SELECT id, estado FROM sesiones_comerciales WHERE negocio_id=$1 AND telefono=$2', [NEG_A, TEL]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].estado, 'abandonada',
    'quedó abierta: el panel seguiría enseñando una oportunidad que no existe');
  const { rows: ev } = await pool.query(
    `SELECT tipo_evento, detalle FROM sesiones_comerciales_eventos
      WHERE sesion_id=$1 AND tipo_evento='sesion_abandonada_por_caducidad'`, [rows[0].id]);
  assert.strictEqual(ev.length, 1, 'se cerró sin dejar rastro en la auditoría');
  assert.strictEqual(Number(ev[0].detalle.ttl_horas), 48);
  assert.strictEqual(ev[0].detalle.estado_previo, 'descubriendo_necesidad');
});

await t('A4 · justo por debajo del TTL sigue viva', async () => {
  await limpiar();
  await obtenerOCrearSesionActiva(NEG_A, TEL);
  assert.ok(await obtenerSesionActiva(NEG_A, TEL, { ahora: enHoras(47) }), 'caducó antes de tiempo');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── B. Una cotización que avanza NO caduca ──');

await t('B1 · capturar un campo renueva la sesión: cuenta la NOVEDAD, no el nacimiento', async () => {
  await limpiar();
  const s = await obtenerOCrearSesionActiva(NEG_A, TEL);

  // Se envejece el NACIMIENTO cinco días. El trigger `set_updated_at` de la
  // 028 pone `updated_at = now()` en ese mismo UPDATE, así que queda
  // exactamente el caso que separa las dos reglas:
  //
  //   created_at  hace 5 días   -> con la regla equivocada, caducada
  //   updated_at  ahora mismo   -> con la regla correcta, viva
  //
  // Sin envejecer el nacimiento las dos fechas van juntas y el caso no
  // distingue nada: lo encontró la prueba de mordida nº 2, que no tumbaba
  // esta prueba aunque el TTL se midiera desde `created_at`.
  await pool.query(
    `UPDATE sesiones_comerciales SET created_at = now() - interval '5 days' WHERE id = $1`, [s.id]);
  await actualizarCamposSesion(s.id, NEG_A, { numero_personas: '30' });

  const { rows } = await pool.query(
    'SELECT created_at, updated_at FROM sesiones_comerciales WHERE id=$1', [s.id]);
  assert.ok((rows[0].updated_at - rows[0].created_at) > 4 * 24 * HORA,
    'el trigger no renovó updated_at: este caso no probaría lo que dice');

  const viva = await obtenerSesionActiva(NEG_A, TEL, { ahora: enHoras(1) });
  assert.ok(viva, 'una cotización que acaba de avanzar se dio por abandonada');
  assert.strictEqual(viva.campos_capturados.numero_personas, '30');
});

await t('B2 · la diferencia es la NOVEDAD, no que el cliente escriba', async () => {
  // La afirmación desnuda del caso real: los 24 anclados tenían
  // `campos_capturados = {}` y un solo evento; uno de ellos mandaba mensajes
  // todos los días. Si la regla mirara «último mensaje», no habría caducado
  // ninguno de los que más daño hacían.
  await limpiar();
  await obtenerOCrearSesionActiva(NEG_A, TEL);      // se abre y no captura nada
  assert.strictEqual(await obtenerSesionActiva(NEG_A, TEL, { ahora: enHoras(49) }), null,
    'la sesión que no capturó nada sobrevivió al TTL');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── C. El TTL lo decide el negocio, con un default seguro ──');

await t('C1 · un TTL por negocio manda sobre el default', async () => {
  await limpiar();
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,'120')
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor='120'`, [NEG_A, CLAVE_TTL_SESION]);
  await obtenerOCrearSesionActiva(NEG_A, TEL);
  assert.ok(await obtenerSesionActiva(NEG_A, TEL, { ahora: enHoras(100) }),
    'con TTL de 120 h caducó a las 100');
  assert.strictEqual(await obtenerSesionActiva(NEG_A, TEL, { ahora: enHoras(121) }), null);
  await pool.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2', [NEG_A, CLAVE_TTL_SESION]);
});

await t('C2 · un valor raro, cero o negativo cae al default, no a «caduca todo»', () => {
  assert.strictEqual(ttlDeSesionHoras({}), 48);
  assert.strictEqual(ttlDeSesionHoras({ [CLAVE_TTL_SESION]: '' }), 48);
  assert.strictEqual(ttlDeSesionHoras({ [CLAVE_TTL_SESION]: 'mañana' }), 48);
  assert.strictEqual(ttlDeSesionHoras({ [CLAVE_TTL_SESION]: '0' }), 48,
    'un 0 dejaría el asistente comercial inservible sin que nadie tocara su módulo');
  assert.strictEqual(ttlDeSesionHoras({ [CLAVE_TTL_SESION]: '-5' }), 48);
  assert.strictEqual(ttlDeSesionHoras({ [CLAVE_TTL_SESION]: ' 12 ' }), 12);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── D. Multiempresa ──');

await t('D1 · caducar la sesión de un negocio no toca la del otro', async () => {
  await limpiar();
  await obtenerOCrearSesionActiva(NEG_A, TEL_B);
  await obtenerOCrearSesionActiva(NEG_B, TEL_B);
  // Caduca la de A mirando 49 h; la de B se consulta en el presente.
  assert.strictEqual(await obtenerSesionActiva(NEG_A, TEL_B, { ahora: enHoras(49) }), null);
  const viva = await obtenerSesionActiva(NEG_B, TEL_B);
  assert.ok(viva, 'cerrar la sesión de un negocio se llevó por delante la del otro');
  assert.strictEqual(viva.negocio_id, NEG_B);
});

await t('D2 · una sesión ya finalizada sigue sin estar activa y no se re-cierra', async () => {
  await limpiar();
  const s = await obtenerOCrearSesionActiva(NEG_A, TEL);
  await finalizarSesion(s.id, NEG_A, 'aprobada');
  assert.strictEqual(await obtenerSesionActiva(NEG_A, TEL, { ahora: enHoras(99) }), null);
  const { rows } = await pool.query('SELECT estado FROM sesiones_comerciales WHERE id=$1', [s.id]);
  assert.strictEqual(rows[0].estado, 'finalizada', 'una sesión cerrada bien se reescribió como abandonada');
});

await limpiar();
await pool.end();

console.log(fallos.length
  ? `\n> CON FALLOS — ${pasadas} pasadas, ${fallos.length} fallidas\n    · ${fallos.join('\n    · ')}`
  : `\n  TODO VERDE — ${pasadas} pasadas, 0 fallidas`);
process.exit(fallos.length ? 1 : 0);
