// El worker durable, corriendo de verdad en el runtime.
//
// Persistir sin procesar no es durabilidad: es una fuga con mejor
// contabilidad. Estas pruebas verifican la mitad que faltaba -- que alguien
// vacía el buzón, que sobrevive a un reinicio, y que un worker muerto no deja
// eventos atrapados.
//
// El caso 3 es el bloqueador: webhook -> 200 -> kill -9 -> reiniciar. Meta ya
// tiene su acuse y no va a reintentar; si el evento no se procesa solo,
// alguien tiene que ir a buscarlo a mano, y eso no es aceptable.
import assert from 'assert';
import { randomUUID } from 'crypto';
import { spawn } from 'node:child_process';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT || '4991';
const { pool } = await import('../src/services/database.js');
const wa = await import('../src/services/whatsappDurable.js');
const { crearWorkerWhatsapp } = await import('../src/services/whatsappWorker.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
async function hasta(cond, { limiteMs = 20000, pasoMs = 100, que = 'la condicion' } = {}) {
  const fin = Date.now() + limiteMs;
  while (Date.now() < fin) { if (await cond()) return true; await esperar(pasoMs); }
  throw new Error(`se agoto la espera de ${que}`);
}

const PNID = `pnw-${Date.now()}`;
const { rows: [neg] } = await pool.query(
  `INSERT INTO negocios (nombre, slug) VALUES ('WA Worker','wa-worker')
   ON CONFLICT (slug) DO UPDATE SET nombre='WA Worker' RETURNING id`);
const NEG = neg.id;
await pool.query(
  `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
   ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [NEG]);
await pool.query(
  `INSERT INTO integraciones_canal (negocio_id, canal, identificador, activo)
   VALUES ($1,'whatsapp',$2,true)
   ON CONFLICT (canal, identificador) DO UPDATE SET negocio_id = $1, activo = true`,
  [NEG, PNID]);

const evento = (clave, tipo = 'mensaje') => wa.encolarEntrante({
  negocioId: NEG, eventoId: clave, tipo, phoneNumberId: PNID,
  payload: { id: clave.replace(/^msg:/, ''), from: '5218781234567', type: 'text',
             text: { body: 'hola' }, timestamp: '1780000000' },
});

// ─── Ciclo de vida ──────────────────────────────────────────────────────────

await t('CICLO', '1. el worker arranca, procesa y se detiene ordenadamente', async () => {
  const vistos = [];
  const w = crearWorkerWhatsapp({ procesarEvento: async (f) => { vistos.push(f.evento_id); },
                                  logger: null, intervaloMs: 50 });
  for (let i = 0; i < 5; i++) await evento(`ciclo-${i}-${randomUUID()}`);

  w.iniciar();
  assert.strictEqual(w.corriendo, true);
  await hasta(() => vistos.length >= 5, { que: 'que procese los 5' });
  await w.detener();
  assert.strictEqual(w.corriendo, false);
  assert.ok(w.estadisticas().procesados >= 5);
});

await t('CICLO', '2. detener() espera la vuelta en curso, no corta a media', async () => {
  let dentro = 0, maximoSimultaneo = 0, terminados = 0;
  const w = crearWorkerWhatsapp({
    procesarEvento: async () => {
      dentro++; maximoSimultaneo = Math.max(maximoSimultaneo, dentro);
      await esperar(60); dentro--; terminados++;
    }, logger: null, intervaloMs: 20 });
  for (let i = 0; i < 3; i++) await evento(`parada-${i}-${randomUUID()}`);

  w.iniciar();
  await hasta(() => terminados >= 1, { que: 'que empiece a procesar' });
  await w.detener();
  assert.strictEqual(dentro, 0, 'no puede quedar un evento a medio procesar al volver de detener()');
});

// ─── EL BLOQUEADOR: crash despues del ACK ───────────────────────────────────

await t('BLOQUEADOR', '3. crash justo despues del 200: al reiniciar, el worker lo termina solo', async () => {
  // Servidor real, webhook real. Se le manda un webhook, se comprueba que
  // contesto 200 y que el evento quedo guardado, y se le mata a lo bruto sin
  // darle tiempo a procesarlo.
  const wamid = `wamid.KILL-${randomUUID()}`;
  const cuerpo = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: PNID },
      contacts: [{ profile: { name: 'Cliente' }, wa_id: '5218781234567' }],
      messages: [{ from: '5218781234567', id: wamid, timestamp: '1780000000',
                   type: 'text', text: { body: 'mensaje que no puede perderse' } }],
    } }] }],
  };

  const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
  let acuse = null;
  try {
    const r = await fetch(`http://localhost:${PUERTO}/webhook/whatsapp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    });
    acuse = r.status;
    assert.strictEqual(acuse, 200, 'Meta recibio su acuse');

    const { rows } = await pool.query(
      `SELECT estado FROM whatsapp_inbox WHERE evento_id = $1`, [`msg:${wamid}`]);
    assert.strictEqual(rows.length, 1, 'y el evento ya estaba guardado');
  } finally {
    // kill -9: sin apagado ordenado, sin flush, sin nada.
    // detener() en lib-servidor es proc.kill(): terminacion inmediata, sin
    // apagado ordenado. Es exactamente el crash que se quiere simular.
    srv.detener();
    await esperar(500);
  }

  // Meta NO va a reintentar: ya recibio 200. El unico camino de vuelta es el
  // worker al reiniciar.
  const { rows: antes } = await pool.query(
    `SELECT estado, procesado_en FROM whatsapp_inbox WHERE evento_id = $1`, [`msg:${wamid}`]);
  assert.ok(['pendiente', 'procesando'].includes(antes[0].estado),
    `tras el crash quedo en "${antes[0].estado}"`);

  // Reinicio: un worker nuevo, como el que arranca con el proceso.
  const procesadosTrasReinicio = [];
  const w = crearWorkerWhatsapp({
    procesarEvento: async (f) => { procesadosTrasReinicio.push(f.evento_id); },
    logger: null, intervaloMs: 50 });
  w.iniciar();
  await hasta(() => procesadosTrasReinicio.includes(`msg:${wamid}`),
    { que: 'que el worker recupere el evento tras el reinicio', limiteMs: 20000 });
  await w.detener();

  const { rows: despues } = await pool.query(
    `SELECT estado FROM whatsapp_inbox WHERE evento_id = $1`, [`msg:${wamid}`]);
  assert.strictEqual(despues[0].estado, 'procesado',
    'sin intervencion manual y sin que Meta reenvie nada');
});

// ─── Lease abandonado ───────────────────────────────────────────────────────

await t('LEASE', '4. un worker que muere con el evento en la mano no lo deja atrapado', async () => {
  const clave = `abandonado-${randomUUID()}`;
  await evento(clave);

  // El worker lo reclama con un lease minusculo y "muere": nunca marca nada.
  const tomado = await wa.reclamarEntrantes('worker-que-muere', { limite: 1, leaseMs: 1 });
  assert.ok(tomado.some(e => e.evento_id === clave));
  await esperar(50);

  const vistos = [];
  const w = crearWorkerWhatsapp({ procesarEvento: async (f) => { vistos.push(f.evento_id); },
                                  logger: null, intervaloMs: 50 });
  w.iniciar();
  await hasta(() => vistos.includes(clave), { que: 'que otro worker lo recoja' });
  await w.detener();

  const { rows } = await pool.query(
    `SELECT estado FROM whatsapp_inbox WHERE evento_id = $1`, [clave]);
  assert.strictEqual(rows[0].estado, 'procesado', 'no puede quedarse en procesando para siempre');
});

// ─── Dos workers ────────────────────────────────────────────────────────────

await t('DOS WORKERS', '5. dos workers a la vez: cada evento se procesa una sola vez', async () => {
  const N = 60;
  for (let i = 0; i < N; i++) await evento(`dos-${i}-${randomUUID()}`);

  const cuenta = new Map();
  const anotar = (f) => cuenta.set(f.evento_id, (cuenta.get(f.evento_id) || 0) + 1);
  const a = crearWorkerWhatsapp({ procesarEvento: async (f) => { anotar(f); await esperar(5); },
                                  logger: null, intervaloMs: 20, workerId: 'A' });
  const b = crearWorkerWhatsapp({ procesarEvento: async (f) => { anotar(f); await esperar(5); },
                                  logger: null, intervaloMs: 20, workerId: 'B' });
  a.iniciar(); b.iniciar();
  await hasta(async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM whatsapp_inbox WHERE evento_id LIKE 'dos-%' AND estado <> 'procesado'`);
    return rows[0].n === 0;
  }, { que: 'que los dos vacien la cola', limiteMs: 30000 });
  await Promise.all([a.detener(), b.detener()]);

  const dobles = [...cuenta.entries()].filter(([, n]) => n > 1);
  assert.deepStrictEqual(dobles, [], `procesados dos veces: ${JSON.stringify(dobles)}`);
  assert.strictEqual(cuenta.size, N, `se procesaron ${cuenta.size} de ${N}`);
  console.log(`      ${N} eventos entre dos workers, 0 procesamientos dobles`);
});

// ─── Efectos idempotentes ───────────────────────────────────────────────────

await t('IDEMPOTENCIA', '6. crash DESPUES del efecto y ANTES de marcar: no duplica', async () => {
  // Es la ventana que ninguna cola resuelve sola: el efecto ya ocurrio pero
  // el evento sigue pendiente, asi que se reintenta. Lo que impide el
  // duplicado es que el efecto deduplique por su cuenta.
  const clave = `efecto-${randomUUID()}`;
  await evento(clave);

  const efectos = new Set();          // simula una tabla con clave unica
  let intentos = 0;
  const w = crearWorkerWhatsapp({
    procesarEvento: async (f) => {
      intentos++;
      efectos.add(f.evento_id);       // idempotente: es un Set, no un push
      if (intentos === 1) throw new Error('el proceso murio tras aplicar el efecto');
    }, logger: null, intervaloMs: 50 });

  w.iniciar();
  await hasta(() => intentos >= 2, { que: 'el reintento' });
  await w.detener();

  assert.ok(intentos >= 2, 'el evento se reintento, que es lo correcto');
  assert.strictEqual(efectos.size, 1, 'pero el efecto logico sigue siendo uno');
});

// ─── Observabilidad ─────────────────────────────────────────────────────────

await t('METRICAS', '7. el worker expone lo necesario para alertar', async () => {
  const w = crearWorkerWhatsapp({ procesarEvento: async () => {}, logger: null });
  const e = w.estadisticas();
  for (const k of ['vueltas', 'procesados', 'fallidos', 'workerId', 'corriendo']) {
    assert.ok(k in e, `falta ${k}`);
  }
  const m = await w.metricas();
  assert.ok(typeof m.inbox_pendientes === 'number');
  assert.ok(typeof m.inbox_mas_viejo_seg === 'number', 'la edad del mas viejo es la que importa');
});

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
await pool.end();
process.exit(fallidas ? 1 : 0);
