// PRUEBA MAESTRA de resiliencia.
//
// No pregunta "compila". Pregunta: cuando desaparece la nube a mitad del
// turno, cuando el Edge se reinicia con la comanda a medias, cuando Meta
// reentrega el mismo webhook cinco veces y cuando un worker muere con el
// trabajo en la mano -- cuantas operaciones se perdieron y cuantas se
// duplicaron. Las dos respuestas tienen que ser cero.
//
// Semilla fija para poder repetir un fallo exacto: SEED=... node ...
import assert from 'assert';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SEED = Number(process.env.SEED || 20260810);
const OPS_ONLINE  = Number(process.env.OPS_ONLINE  || 100);
const OPS_OFFLINE = Number(process.env.OPS_OFFLINE || 500);
const EVENTOS_WA  = Number(process.env.EVENTOS_WA  || 1000);

const { pool } = await import('../src/services/database.js');
const { sincronizarLote, conflictosPendientes, registrarGeneracion } =
  await import('../src/services/syncService.js');
const wa = await import('../src/services/whatsappDurable.js');
const { crearAlmacen } = await import('../edge/storage/index.js');
const { crearJournal } = await import('../edge/journal/index.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// xorshift32: mismo caos con la misma semilla.
function crearAzar(semilla) {
  let x = semilla >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 0xFFFFFFFF; };
}
const azar = crearAzar(SEED);
const entre = (a, b) => a + Math.floor(azar() * (b - a + 1));
const elegir = (arr) => arr[Math.floor(azar() * arr.length)];

const temporales = [];
const dirTemporal = () => { const d = mkdtempSync(join(tmpdir(), 'xabor-res-')); temporales.push(d); return d; };

const sinCapturar = [];
process.on('unhandledRejection', (e) => sinCapturar.push(String(e?.message || e)));

const { rows: [neg] } = await pool.query(
  `INSERT INTO negocios (nombre, slug) VALUES ('Resiliencia Chaos','res-chaos')
   ON CONFLICT (slug) DO UPDATE SET nombre='Resiliencia Chaos' RETURNING id`);
const NEG = neg.id;
await pool.query(
  `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
   ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [NEG]);

const PRODUCTOS = ['Chilaquiles', 'Enchiladas', 'Ensalada', 'Coca-Cola', 'Cafe', 'Flan'];
const SALSAS = ['Verde', 'Roja'];

// La nube puede estar "caida": cuando lo esta, sincronizar lanza, igual que
// un fetch contra un Railway que no responde.
let nubeViva = true;
const metricas = {
  opsOnline: 0, opsOffline: 0, intentosSync: 0, syncFallidos: 0,
  reinicios: 0, waEnviados: 0, waDuplicadosInyectados: 0, waCrashesWorker: 0,
};

async function sincronizar(journal) {
  metricas.intentosSync++;
  if (!nubeViva) { metricas.syncFallidos++; throw new Error('ECONNREFUSED: la nube no responde'); }
  const pendientes = journal.pendientes();
  if (!pendientes.length) return { resumen: { aceptadas: 0, duplicadas: 0, conflictos: 0, rechazadas: 0 } };
  const { resultados, resumen } = await sincronizarLote(NEG, pendientes);
  for (const r of resultados) journal.marcarSincronizada(r.operationId, r.resultado);
  return { resumen };
}

// Un turno real: abre cuenta, mete platillos con modificadores y notas,
// manda rondas, a veces mueve la mesa.
const cuentasVivas = [];
function operarUnPoco(journal) {
  const dado = azar();
  if (dado < 0.25 || cuentasVivas.length === 0) {
    const cuentaId = randomUUID();
    journal.abrirCuenta({ cuentaId, mesa: entre(1, 20), mesero: `mesero-${entre(1, 4)}`, personas: entre(1, 6) });
    cuentasVivas.push(cuentaId);
    return 1;
  }
  const cuentaId = elegir(cuentasVivas);
  if (dado < 0.80) {
    journal.agregarItem({
      cuentaId, itemId: randomUUID(), producto: elegir(PRODUCTOS), cantidad: entre(1, 3),
      modificadores: azar() < 0.4 ? [{ grupo: 'Salsa', opcion: elegir(SALSAS) }] : [],
      notas: azar() < 0.25 ? 'Sin cebolla' : null,
    });
    return 1;
  }
  if (dado < 0.92) { journal.enviarRonda({ cuentaId, ronda: entre(1, 4) }); return 1; }
  journal.moverMesa({ cuentaId, mesaId: cuentaId, mesaDestino: entre(1, 20) });
  return 1;
}

// ─── CASO 1: nube sana ──────────────────────────────────────────────────────

const dirEdge = dirTemporal();
let almacen = crearAlmacen({ almacen: 'auto', rutaDatos: dirEdge, logger: null });
let journal = crearJournal({ almacen, negocioId: NEG });
const generacionOriginal = journal.generacion;
const dispositivoOriginal = journal.dispositivoId;

await t('CASO A', `1. nube sana: ${OPS_ONLINE} operaciones sincronizan`, async () => {
  for (let i = 0; i < OPS_ONLINE; i++) metricas.opsOnline += operarUnPoco(journal);
  const { resumen } = await sincronizar(journal);
  assert.strictEqual(resumen.rechazadas, 0, 'ninguna operacion legitima puede ser rechazada');
  assert.strictEqual(journal.pendientes().length, 0, 'no queda nada por sincronizar');

  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM sync_operaciones WHERE negocio_id=$1 AND dispositivo_id=$2`,
    [NEG, dispositivoOriginal]);
  assert.strictEqual(rows[0].n, OPS_ONLINE, `la nube tiene ${rows[0].n} de ${OPS_ONLINE}`);
});

// ─── CASO B y C: se cae la nube ─────────────────────────────────────────────

await t('CASO B/C', `2. sin nube: ${OPS_OFFLINE} operaciones mas, con reinicio del Edge a mitad`, async () => {
  nubeViva = false;
  const mitad = Math.floor(OPS_OFFLINE / 2);

  for (let i = 0; i < mitad; i++) {
    metricas.opsOffline += operarUnPoco(journal);
    // El Edge intenta sincronizar y falla: es lo que hara de verdad.
    if (i % 50 === 0) { try { await sincronizar(journal); } catch { /* la nube no esta */ } }
  }

  // Reinicio duro a mitad del turno, con la cola llena.
  almacen.cerrar();
  metricas.reinicios++;
  almacen = crearAlmacen({ almacen: 'auto', rutaDatos: dirEdge, logger: null });
  journal = crearJournal({ almacen, negocioId: NEG });

  assert.strictEqual(journal.dispositivoId, dispositivoOriginal, 'la identidad sobrevive al reinicio');
  assert.strictEqual(journal.generacion, generacionOriginal, 'y la generacion tambien');

  for (let i = mitad; i < OPS_OFFLINE; i++) metricas.opsOffline += operarUnPoco(journal);
});

await t('CASO C', '3. el turno siguio: el journal tiene TODO lo de antes y despues del reinicio', () => {
  const total = journal.todas().length;
  assert.strictEqual(total, OPS_ONLINE + OPS_OFFLINE,
    `el journal tiene ${total}, deberia tener ${OPS_ONLINE + OPS_OFFLINE}`);
});

await t('CASO C', '4. la proyeccion se reconstruye desde el journal, sin estado a medias', () => {
  // Si un crash deja la proyeccion inconsistente, no hay que adivinar cual
  // era la buena: se tira y se rehace.
  const cuentas = journal.proyectar();
  assert.ok(cuentas.size > 0, 'tiene que haber cuentas abiertas');
  let items = 0;
  for (const c of cuentas.values()) items += c.items.length;
  assert.ok(items > 0, 'con sus platillos dentro');

  // Y rehacerla dos veces da lo mismo: es determinista.
  const otra = journal.proyectar();
  assert.strictEqual(otra.size, cuentas.size);
});

// ─── CASO D: vuelve la nube ─────────────────────────────────────────────────

let resumenReconciliacion = null;
await t('CASO D', `5. vuelve la nube: las ${OPS_OFFLINE} se reconcilian`, async () => {
  nubeViva = true;
  const gen = await registrarGeneracion(NEG, dispositivoOriginal, generacionOriginal);
  assert.strictEqual(gen.amnesia, false, 'el Edge conservo su journal: no es amnesia');

  resumenReconciliacion = (await sincronizar(journal)).resumen;
  assert.strictEqual(journal.pendientes().length, 0, 'no puede quedar nada colgado');
});

await t('CASO D', '6. cero perdidas: la nube tiene exactamente lo que el Edge hizo', async () => {
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM sync_operaciones WHERE negocio_id=$1 AND dispositivo_id=$2`,
    [NEG, dispositivoOriginal]);
  const esperadas = OPS_ONLINE + OPS_OFFLINE;
  assert.strictEqual(rows[0].n, esperadas,
    `la nube tiene ${rows[0].n} y el Edge hizo ${esperadas}: se perdieron ${esperadas - rows[0].n}`);
});

await t('CASO E', '7. cero duplicados: reenviar TODO el journal no crea ni una fila mas', async () => {
  const antes = (await pool.query(
    `SELECT count(*)::int n FROM sync_operaciones WHERE negocio_id=$1 AND dispositivo_id=$2`,
    [NEG, dispositivoOriginal])).rows[0].n;

  // Tres reenvios completos, como un Edge que no recibio la respuesta.
  for (let i = 0; i < 3; i++) {
    const { resumen } = await sincronizarLote(NEG, journal.todas());
    assert.strictEqual(resumen.aceptadas, 0, 'un reenvio no puede aceptar nada nuevo');
    assert.strictEqual(resumen.duplicadas + resumen.conflictos, journal.todas().length);
  }

  const despues = (await pool.query(
    `SELECT count(*)::int n FROM sync_operaciones WHERE negocio_id=$1 AND dispositivo_id=$2`,
    [NEG, dispositivoOriginal])).rows[0].n;
  assert.strictEqual(despues, antes, `aparecieron ${despues - antes} filas de la nada`);
});

// ─── CASO F: dos dispositivos ───────────────────────────────────────────────

await t('CASO F', '8. dos dispositivos offline: ni un solo id colisiona', async () => {
  const j1 = crearJournal({ almacen: crearAlmacen({ almacen: 'auto', rutaDatos: dirTemporal() }), negocioId: NEG });
  const j2 = crearJournal({ almacen: crearAlmacen({ almacen: 'auto', rutaDatos: dirTemporal() }), negocioId: NEG });
  assert.notStrictEqual(j1.dispositivoId, j2.dispositivoId);

  const cuentaCompartida = randomUUID();
  j1.abrirCuenta({ cuentaId: cuentaCompartida, mesa: 5, mesero: 'A', personas: 2 });
  for (let i = 0; i < 60; i++) {
    j1.agregarItem({ cuentaId: cuentaCompartida, itemId: randomUUID(), producto: elegir(PRODUCTOS), cantidad: 1 });
    j2.agregarItem({ cuentaId: cuentaCompartida, itemId: randomUUID(), producto: elegir(PRODUCTOS), cantidad: 1 });
  }
  const ids = new Set([...j1.todas(), ...j2.todas()].map(o => o.operationId));
  assert.strictEqual(ids.size, j1.todas().length + j2.todas().length, 'operation_id colisionado');

  // Ambos sincronizan: aditivo, sin conflicto.
  const r1 = await sincronizarLote(NEG, j1.pendientes());
  const r2 = await sincronizarLote(NEG, j2.pendientes());
  assert.strictEqual(r1.resumen.conflictos, 0);
  assert.strictEqual(r2.resumen.conflictos, 0, 'dos meseros en la misma mesa no es un conflicto');

  // Pero cerrarla los dos SI lo es.
  j1.cerrarCuenta({ cuentaId: cuentaCompartida, total: 900 });
  j2.cerrarCuenta({ cuentaId: cuentaCompartida, total: 750 });
  const c1 = await sincronizarLote(NEG, j1.pendientes());
  const c2 = await sincronizarLote(NEG, j2.pendientes());
  const conflictos = c1.resumen.conflictos + c2.resumen.conflictos;
  assert.strictEqual(conflictos, 1, `dos cierres deberian dar 1 conflicto, dieron ${conflictos}`);
});

await t('CASO F', '9. el conflicto quedo visible, no pisado', async () => {
  const pend = await conflictosPendientes(NEG);
  assert.ok(pend.length >= 1, 'un conflicto silencioso es exactamente lo que no queremos');
});

// ─── CASO G: amnesia del Edge ───────────────────────────────────────────────

await t('CASO G', '10. un Edge que pierde su journal NO finge continuidad', async () => {
  const r = await registrarGeneracion(NEG, dispositivoOriginal, randomUUID());
  assert.strictEqual(r.amnesia, true, 'la nube tiene que darse cuenta');
  assert.ok(r.ultimaSecuencia > 0, 'y decirle hasta donde habia llegado, para entrar en recuperacion');
});

// ─── CASO H/I/J: WhatsApp ───────────────────────────────────────────────────

const eventosLogicos = new Set();
await t('CASO H/J', `11. ${EVENTOS_WA} webhooks con duplicados inyectados`, async () => {
  for (let i = 0; i < EVENTOS_WA; i++) {
    const wamid = `wamid.CH${SEED}.${i}`;
    const clave = wa.claveEvento('mensaje', { id: wamid });
    eventosLogicos.add(clave);
    await wa.encolarEntrante({ negocioId: NEG, eventoId: clave, tipo: 'mensaje',
      phoneNumberId: 'pn-chaos', payload: { id: wamid, from: '5218780000000', text: { body: `m${i}` } } });
    metricas.waEnviados++;

    // Meta reentrega: mismo webhook otra vez, a veces varias.
    if (azar() < 0.18) {
      const veces = entre(1, 3);
      for (let k = 0; k < veces; k++) {
        await wa.encolarEntrante({ negocioId: NEG, eventoId: clave, tipo: 'mensaje',
          phoneNumberId: 'pn-chaos', payload: { id: wamid } });
        metricas.waDuplicadosInyectados++;
      }
    }
  }
});

await t('CASO J', '12. duplicados de Meta: N eventos enviados, N eventos logicos', async () => {
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM whatsapp_inbox WHERE tipo='mensaje' AND phone_number_id='pn-chaos'`);
  assert.strictEqual(rows[0].n, EVENTOS_WA,
    `esperados ${EVENTOS_WA} logicos, hay ${rows[0].n} (se inyectaron ${metricas.waDuplicadosInyectados} duplicados)`);
});

await t('CASO H', '13. dos workers procesan la cola con crashes: ninguno se procesa dos veces', async () => {
  const procesados = new Set();
  const dobles = [];
  let vueltas = 0;

  while (vueltas++ < 400) {
    const workerId = `w-${entre(1, 2)}`;
    // Lease corto para que un crash no bloquee la cola mucho rato.
    const lote = await wa.reclamarEntrantes(workerId, { limite: 20, leaseMs: 200 });
    if (!lote.length) {
      const quedan = await pool.query(
        `SELECT count(*)::int n FROM whatsapp_inbox
          WHERE tipo='mensaje' AND phone_number_id='pn-chaos' AND estado IN ('pendiente','procesando')`);
      if (quedan.rows[0].n === 0) break;
      await new Promise(r => setTimeout(r, 60));   // esperando a que venzan leases
      continue;
    }

    for (const ev of lote) {
      // El worker muere con el evento en la mano: no marca nada.
      if (azar() < 0.08) { metricas.waCrashesWorker++; continue; }
      if (procesados.has(ev.evento_id)) dobles.push(ev.evento_id);
      procesados.add(ev.evento_id);
      await wa.marcarEntranteProcesado(ev.id);
    }
  }

  assert.strictEqual(dobles.length, 0,
    `${dobles.length} eventos se procesaron dos veces pese al claiming`);
  assert.strictEqual(procesados.size, EVENTOS_WA,
    `se procesaron ${procesados.size} de ${EVENTOS_WA}: faltan ${EVENTOS_WA - procesados.size}`);
});

await t('CASO I', '14. cero eventos perdidos: todos quedaron en un estado explicable', async () => {
  const { rows } = await pool.query(
    `SELECT estado, count(*)::int n FROM whatsapp_inbox
      WHERE tipo='mensaje' AND phone_number_id='pn-chaos' GROUP BY estado ORDER BY estado`);
  const porEstado = Object.fromEntries(rows.map(r => [r.estado, r.n]));
  const total = rows.reduce((s, r) => s + r.n, 0);
  console.log(`      estados: ${JSON.stringify(porEstado)}`);
  assert.strictEqual(total, EVENTOS_WA, 'ni uno se evaporo');
  assert.strictEqual(porEstado.procesado, EVENTOS_WA, 'y todos acabaron procesados');
});

await t('CASO I', '15. la base caida no pierde el evento: se persiste antes de contestar', async () => {
  // Se simula el orden correcto: si el INSERT falla, el webhook NO puede
  // haber contestado 200 todavia -- por eso encolarEntrante devuelve ok:false
  // en vez de tragarse el error.
  const r = await wa.encolarEntrante({ negocioId: NEG, eventoId: null, tipo: 'mensaje', payload: {} });
  assert.strictEqual(r.ok, false, 'un fallo al persistir tiene que ser visible para el webhook');
});

// ─── CASO: dos workers cloud, uno muere ─────────────────────────────────────

await t('CASO G-cloud', '16. muere un worker de salida y el otro sigue vaciando la cola', async () => {
  const N = 120;
  // La cola es global: si otra suite corrio antes en esta misma base, sus
  // salientes compiten por el limite del claiming y el conteo deja de ser
  // determinista. Se retiran de la cola (no se borran) para medir solo este
  // caso.
  await pool.query(
    `UPDATE whatsapp_outbox SET estado='cancelado'
      WHERE estado IN ('encolado','enviando','fallo_reintentable') AND clave_idem NOT LIKE $1`,
    [`chaos-out-${SEED}-%`]);

  for (let i = 0; i < N; i++) {
    await wa.encolarSaliente({ negocioId: NEG, claveIdem: `chaos-out-${SEED}-${i}`,
      destino: '5218780000000', contenido: { texto: `salida ${i}` } });
  }

  // El worker A toma un lote y "muere": nunca marca nada.
  const loteA = await wa.reclamarSalientes('cloud-A', { limite: 40, leaseMs: 150 });
  assert.strictEqual(loteA.length, 40);
  await new Promise(r => setTimeout(r, 200));   // vence su lease

  // Lo que quedo en vuelo es AMBIGUO: pudo llegar a Meta. No se reencola.
  const rescatados = await wa.recuperarSalientesColgados();
  assert.strictEqual(rescatados, 40, 'los 40 de A quedan marcados, no reintentados a ciegas');

  // B vacia el resto sin tocar los inciertos.
  let enviadosPorB = 0;
  for (let v = 0; v < 30; v++) {
    const lote = await wa.reclamarSalientes('cloud-B', { limite: 25 });
    if (!lote.length) break;
    for (const m of lote) { await wa.marcarSalienteEnviado(m.id, `wamid.B${m.id.slice(0, 6)}`); enviadosPorB++; }
  }

  const { rows } = await pool.query(
    `SELECT estado, count(*)::int n FROM whatsapp_outbox
      WHERE clave_idem LIKE $1 GROUP BY estado`, [`chaos-out-${SEED}-%`]);
  const porEstado = Object.fromEntries(rows.map(r => [r.estado, r.n]));
  console.log(`      salida: ${JSON.stringify(porEstado)} (B envio ${enviadosPorB})`);

  assert.strictEqual((porEstado.enviado_a_meta || 0) + (porEstado.incierto || 0), N,
    'todos los mensajes tienen que estar en uno de los dos estados, ninguno perdido');
  assert.strictEqual(porEstado.incierto, 40, 'exactamente los que murieron en vuelo');
});

// ─── Cierre ─────────────────────────────────────────────────────────────────

await t('CHAOS', '17. ninguna promesa sin capturar en todo el caos', () => {
  assert.deepStrictEqual(sinCapturar, [], `hubo ${sinCapturar.length} rechazos sin capturar`);
});

await t('CHAOS', '18. resumen', async () => {
  const conf = await conflictosPendientes(NEG);
  console.log(`      seed ${SEED}`);
  console.log(`      restaurante: ${metricas.opsOnline} online + ${metricas.opsOffline} offline = ${metricas.opsOnline + metricas.opsOffline} operaciones`);
  console.log(`      reconciliadas ${resumenReconciliacion.aceptadas} · duplicadas ${resumenReconciliacion.duplicadas} · perdidas 0`);
  console.log(`      reinicios del Edge ${metricas.reinicios} · intentos de sync ${metricas.intentosSync} (${metricas.syncFallidos} contra nube caida)`);
  console.log(`      whatsapp: ${metricas.waEnviados} eventos logicos, ${metricas.waDuplicadosInyectados} duplicados inyectados, ${metricas.waCrashesWorker} crashes de worker`);
  console.log(`      conflictos pendientes de revision: ${conf.length}`);
});

for (const d of temporales) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
await pool.end();
process.exit(fallidas ? 1 : 0);
