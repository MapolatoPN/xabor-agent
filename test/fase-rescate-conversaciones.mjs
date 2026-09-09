// RESCATE DE CONVERSACIONES — el cliente que se quedó esperando deja rastro.
//
// Reproduce el incidente del 2026-09-09: alguien del restaurante saludó a mano
// desde la Business App, eso activó el takeover de 30 minutos, y la clienta
// escribió dos veces sin que nadie le contestara durante trece minutos. Nadie
// se enteró.
//
// Lo que se fija aquí no es que el bot conteste —el takeover existe justamente
// para que no lo haga— sino que ESA ESPERA SE VEA.
//
// Uso: mismas env vars que la batería.
import assert from 'assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

const { pool } = await import('../src/services/database.js');
const {
  buscarConversacionesEnEspera, revisarConversacionesEnEspera,
  telefonoEnmascarado, textoDeAviso, reiniciarAvisos, ESPERA_POR_DEFECTO_MIN,
} = await import('../src/services/rescateConversaciones.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG = SEED.negocioA;
const TEL = '5219990000001';   // namespace propio de esta suite
const TEL_B = '5219990000002';

async function limpiar() {
  await pool.query(`DELETE FROM mensajes WHERE telefono LIKE '521999000000%'`);
  await pool.query(`DELETE FROM clientes WHERE telefono LIKE '521999000000%'`);
  reiniciarAvisos();
}

/** Deja la conversación en un estado concreto, con tiempos controlados. */
async function situar({ telefono = TEL, takeoverMin = 30, clienteHaceMin = 10, humanoHaceMin = null }) {
  await pool.query(
    `INSERT INTO clientes (telefono, negocio_id, human_takeover_until, last_business_app_message_at)
     VALUES ($1, $2, ${takeoverMin === null ? 'NULL' : `NOW() + ($3 || ' minutes')::interval`}, NOW())
     ON CONFLICT (telefono) DO UPDATE SET negocio_id = $2,
       human_takeover_until = ${takeoverMin === null ? 'NULL' : `NOW() + ($3 || ' minutes')::interval`}`,
    takeoverMin === null ? [telefono, NEG] : [telefono, NEG, String(takeoverMin)]);
  if (humanoHaceMin !== null) {
    await pool.query(
      `INSERT INTO mensajes (telefono, direccion, texto, negocio_id, origen, "timestamp")
       VALUES ($1,'saliente','respuesta del dueño',$2,'humano', NOW() - ($3 || ' minutes')::interval)`,
      [telefono, NEG, String(humanoHaceMin)]);
  }
  await pool.query(
    `INSERT INTO mensajes (telefono, direccion, texto, negocio_id, origen, "timestamp")
     VALUES ($1,'entrante','sería porfavor, unos hotcakes infantiles',$2,'cliente', NOW() - ($3 || ' minutes')::interval)`,
    [telefono, NEG, String(clienteHaceMin)]);
}

const esperando = (filas, tel = TEL) => filas.some(f => f.telefono === tel);

try {
await limpiar();

// ═══ El caso real ═══════════════════════════════════════════════════════════
await t('R1. takeover activo + cliente esperando 10 min sin respuesta humana → se detecta', async () => {
  await limpiar();
  await situar({ clienteHaceMin: 10 });
  const filas = await buscarConversacionesEnEspera(5);
  assert.ok(esperando(filas), 'la conversación de Elizabeth debía aparecer');
  const fila = filas.find(f => f.telefono === TEL);
  assert.ok(fila.segundos_esperando >= 9 * 60, `debía llevar ~10 min esperando, lleva ${fila.segundos_esperando}s`);
});

// ═══ Los controles: cuándo NO hay que avisar ════════════════════════════════
await t('R2. si el humano YA contestó después del cliente, no hay nada que rescatar', async () => {
  await limpiar();
  // El dueño respondió hace 2 min; el cliente había escrito hace 10.
  await situar({ clienteHaceMin: 10, humanoHaceMin: 2 });
  const filas = await buscarConversacionesEnEspera(5);
  assert.ok(!esperando(filas), 'atendida no es esperando');
});

await t('R3. sin takeover no se avisa: el bot está contestando, no hay silencio', async () => {
  await limpiar();
  await situar({ takeoverMin: null, clienteHaceMin: 10 });
  const filas = await buscarConversacionesEnEspera(5);
  assert.ok(!esperando(filas), 'sin takeover el bot responde y esto no aplica');
});

await t('R4. takeover VENCIDO tampoco: el bot ya volvió a responder', async () => {
  await limpiar();
  await situar({ takeoverMin: -5, clienteHaceMin: 10 });
  const filas = await buscarConversacionesEnEspera(5);
  assert.ok(!esperando(filas), 'un takeover vencido no silencia a nadie');
});

await t('R5. una espera normal no dispara nada (el umbral existe por algo)', async () => {
  await limpiar();
  await situar({ clienteHaceMin: 1 });
  const filas = await buscarConversacionesEnEspera(5);
  assert.ok(!esperando(filas), 'un minuto esperando es una conversación, no un incidente');
});

// ═══ Un aviso por espera, no uno por minuto ═════════════════════════════════
await t('R6. el job corre cada minuto y avisa UNA vez; si el cliente insiste, avisa de nuevo', async () => {
  await limpiar();
  await situar({ clienteHaceMin: 10 });
  const avisos = [];
  const opts = {
    minutos: 5,
    enviarAvisoWhatsapp: async (a, txt) => { avisos.push({ a, txt }); },
    broadcastPanel: () => {},
    log: () => {},
  };
  assert.strictEqual(await revisarConversacionesEnEspera(opts), 1, 'primera revisión: avisa');
  assert.strictEqual(await revisarConversacionesEnEspera(opts), 0, 'segunda: la misma espera NO vuelve a avisar');
  assert.strictEqual(await revisarConversacionesEnEspera(opts), 0, 'tercera tampoco');
  // El cliente vuelve a escribir: es una espera NUEVA.
  await pool.query(
    `INSERT INTO mensajes (telefono, direccion, texto, negocio_id, origen, "timestamp")
     VALUES ($1,'entrante','sigues ahí?',$2,'cliente', NOW() - INTERVAL '6 minutes')`, [TEL, NEG]);
  assert.strictEqual(await revisarConversacionesEnEspera(opts), 1, 'un mensaje nuevo sin respuesta vuelve a avisar');
});

// ═══ El aviso no puede filtrar datos del cliente ════════════════════════════
await t('R7. ni el aviso ni el evento del panel llevan el teléfono completo', async () => {
  await limpiar();
  await situar({ clienteHaceMin: 10 });
  const avisos = []; const eventos = [];
  await revisarConversacionesEnEspera({
    minutos: 5,
    enviarAvisoWhatsapp: async (a, txt) => { avisos.push(txt); },
    broadcastPanel: (neg, ev) => { eventos.push(ev); },
    log: () => {},
  });
  const todo = JSON.stringify(avisos) + JSON.stringify(eventos);
  assert.ok(!todo.includes(TEL), `el teléfono completo NO puede aparecer: ${todo.slice(0, 200)}`);
  assert.ok(todo.includes('***0001'), 'sí van los últimos 4 dígitos, para poder identificar el chat');
  assert.strictEqual(telefonoEnmascarado('5219990000001'), '***0001');
  assert.ok(/esperando/i.test(textoDeAviso({ telefono: TEL, segundos_esperando: 600 })));
});

// ═══ Un fallo aquí jamás puede tumbar el bot ═══════════════════════════════
await t('R8. si el aviso falla, la revisión NO lanza: el bot nunca se cae por esto', async () => {
  await limpiar();
  await situar({ clienteHaceMin: 10 });
  const n = await revisarConversacionesEnEspera({
    minutos: 5,
    enviarAvisoWhatsapp: async () => { throw new Error('WhatsApp caído'); },
    broadcastPanel: () => { throw new Error('panel caído'); },
    log: () => {},
  });
  assert.strictEqual(n, 1, 'la espera se detectó igual, aunque los dos avisos fallaran');
});

await t('R9. dos negocios: cada aviso viaja con SU negocio, nunca cruzado', async () => {
  await limpiar();
  await situar({ telefono: TEL, clienteHaceMin: 10 });
  await situar({ telefono: TEL_B, clienteHaceMin: 10 });
  const eventos = [];
  await revisarConversacionesEnEspera({
    minutos: 5, broadcastPanel: (neg, ev) => eventos.push({ neg, ev }), log: () => {},
  });
  assert.strictEqual(eventos.length, 2, 'las dos esperas se ven');
  for (const e of eventos) assert.strictEqual(e.neg, NEG, 'cada evento va a su negocio');
});

assert.strictEqual(ESPERA_POR_DEFECTO_MIN, 5, 'el umbral por defecto queda documentado en el módulo');

} finally {
  await limpiar();
  await pool.end();
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:'); fallos.forEach(f => console.log(' - ' + f)); process.exit(1); }
