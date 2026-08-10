// Sincronizacion idempotente: lo que pasa cuando el Edge reintenta.
//
// La pregunta que responde esta suite no es "funciona el endpoint" sino
// "cuando la red se corta a mitad y el Edge no sabe si llego, que ocurre".
import assert from 'assert';
import { randomUUID } from 'crypto';

const { pool } = await import('../src/services/database.js');
const { registrarOperacion, sincronizarLote, conflictosPendientes,
        marcarConflictoRevisado, registrarGeneracion } =
  await import('../src/services/syncService.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

async function crearNegocio(slug, nombre) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1,$2)
     ON CONFLICT (slug) DO UPDATE SET nombre = $1 RETURNING id`, [nombre, slug]);
  await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [n.id]);
  return n.id;
}

const A = await crearNegocio('res-a', 'Resiliencia A');
const B = await crearNegocio('res-b', 'Resiliencia B');

let seq = 0;
function op(tipo, payload = {}, extra = {}) {
  return {
    operationId: randomUUID(),
    dispositivoId: extra.dispositivoId || 'tablet-1',
    generacion: extra.generacion || 'gen-1',
    secuencia: extra.secuencia ?? ++seq,
    tipo,
    payload,
    creadaEnLocal: new Date().toISOString(),
    ...extra,
  };
}

// ─── Idempotencia ───────────────────────────────────────────────────────────

await t('IDEMPOTENCIA', '1. una operacion nueva se acepta', async () => {
  const r = await registrarOperacion(A, op('CUENTA_ABIERTA', { cuentaId: randomUUID(), mesa: 4 }));
  assert.strictEqual(r.resultado, 'aceptada');
});

await t('IDEMPOTENCIA', '2. el MISMO operationId reenviado es duplicado, no una segunda operacion', async () => {
  const o = op('ITEM_AGREGADO', { cuentaId: 'c1', producto: 'Chilaquiles', cantidad: 1 });
  const primera = await registrarOperacion(A, o);
  const segunda = await registrarOperacion(A, o);
  assert.strictEqual(primera.resultado, 'aceptada');
  assert.strictEqual(segunda.resultado, 'duplicada');

  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM sync_operaciones WHERE negocio_id=$1 AND operation_id=$2`,
    [A, o.operationId]);
  assert.strictEqual(rows[0].n, 1, 'solo puede existir una fila');
});

await t('IDEMPOTENCIA', '3. el duplicado devuelve el MISMO efecto que el original', async () => {
  // Esto es lo que evita que el Edge reciba dos folios distintos para la
  // misma operacion y crea que son dos pedidos.
  const o = op('CUENTA_ABIERTA', { cuentaId: randomUUID(), mesa: 7 });
  const aplicar = async () => ({ folio: 'XAB-9001', cuentaCloudId: 'cloud-abc' });

  const primera = await registrarOperacion(A, o, aplicar);
  const segunda = await registrarOperacion(A, o, aplicar);

  assert.deepStrictEqual(primera.efecto, { folio: 'XAB-9001', cuentaCloudId: 'cloud-abc' });
  assert.deepStrictEqual(segunda.efecto, primera.efecto,
    'un reintento tiene que recibir exactamente la misma respuesta');
});

await t('IDEMPOTENCIA', '4. 20 reintentos del mismo lote producen una sola aplicacion', async () => {
  const lote = Array.from({ length: 10 }, (_, i) =>
    op('ITEM_AGREGADO', { cuentaId: 'c-lote', producto: `P${i}`, cantidad: 1 }));

  let aplicaciones = 0;
  const aplicar = async () => { aplicaciones++; return { ok: true }; };

  for (let i = 0; i < 20; i++) await sincronizarLote(A, lote, aplicar);

  assert.strictEqual(aplicaciones, 10, `se aplico ${aplicaciones} veces en vez de 10`);
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM sync_operaciones WHERE negocio_id=$1 AND payload->>'cuentaId'='c-lote'`, [A]);
  assert.strictEqual(rows[0].n, 10);
});

await t('IDEMPOTENCIA', '5. el mismo operationId en OTRO negocio no colisiona ni filtra', async () => {
  const o = op('ITEM_AGREGADO', { cuentaId: 'x', producto: 'Cafe', cantidad: 1 });
  const enA = await registrarOperacion(A, o, async () => ({ marca: 'A' }));
  const enB = await registrarOperacion(B, { ...o }, async () => ({ marca: 'B' }));
  assert.strictEqual(enA.resultado, 'aceptada');
  assert.strictEqual(enB.resultado, 'aceptada', 'un id de otro tenant no puede bloquear');
  assert.strictEqual(enB.efecto.marca, 'B', 'y jamas puede devolver el efecto del otro negocio');
});

// ─── Identidad ──────────────────────────────────────────────────────────────

await t('IDENTIDAD', '6. un folio como operationId se RECHAZA', async () => {
  const r = await registrarOperacion(A, { ...op('ITEM_AGREGADO'), operationId: 'XAB-0124' });
  assert.strictEqual(r.resultado, 'rechazada');
  assert.match(r.motivo, /folio/i, 'el motivo debe decir por que');
});

await t('IDENTIDAD', '7. un tipo desconocido se rechaza en vez de guardarse "por si acaso"', async () => {
  const r = await registrarOperacion(A, { ...op('ITEM_AGREGADO'), tipo: 'BORRAR_TODO' });
  assert.strictEqual(r.resultado, 'rechazada');
});

await t('IDENTIDAD', '8. sin dispositivoId o sin secuencia no se acepta', async () => {
  const sinDisp = await registrarOperacion(A, { ...op('ITEM_AGREGADO'), dispositivoId: '' });
  const sinSeq  = await registrarOperacion(A, { ...op('ITEM_AGREGADO'), secuencia: -1 });
  assert.strictEqual(sinDisp.resultado, 'rechazada');
  assert.strictEqual(sinSeq.resultado, 'rechazada');
});

// ─── Conflictos ─────────────────────────────────────────────────────────────

await t('CONFLICTO', '9. dos dispositivos agregando a la MISMA mesa: se fusiona, no choca', async () => {
  const cuentaId = randomUUID();
  const r1 = await registrarOperacion(A, op('ITEM_AGREGADO', { cuentaId, producto: 'Chilaquiles', cantidad: 2 },
    { dispositivoId: 'tablet-1', secuencia: 100 }));
  const r2 = await registrarOperacion(A, op('ITEM_AGREGADO', { cuentaId, producto: 'Cafe', cantidad: 1 },
    { dispositivoId: 'tablet-2', secuencia: 100 }));
  assert.strictEqual(r1.resultado, 'aceptada');
  assert.strictEqual(r2.resultado, 'aceptada', 'dos meseros en la misma mesa es un turno normal');
});

await t('CONFLICTO', '10. dos dispositivos CERRANDO la misma cuenta: conflicto, no last-write-wins', async () => {
  const cuentaId = randomUUID();
  const r1 = await registrarOperacion(A, op('CUENTA_CERRADA', { cuentaId, total: 680 },
    { dispositivoId: 'tablet-1', secuencia: 200 }));
  const r2 = await registrarOperacion(A, op('CUENTA_CERRADA', { cuentaId, total: 540 },
    { dispositivoId: 'tablet-2', secuencia: 200 }));

  assert.strictEqual(r1.resultado, 'aceptada');
  assert.strictEqual(r2.resultado, 'conflicto', 'con dinero de por medio no se pisa en silencio');
  assert.ok(r2.requiereRevision);
  assert.match(r2.motivo, /tablet-1/, 'el motivo tiene que decir quien la cerro antes');
});

await t('CONFLICTO', '11. el conflicto NO desaparece: queda listado para revision', async () => {
  const pendientes = await conflictosPendientes(A);
  assert.ok(pendientes.length >= 1, 'un conflicto invisible es peor que un error');
  const uno = pendientes[0];
  assert.ok(uno.motivo && uno.payload, 'con su motivo y su payload intactos');

  assert.strictEqual(await marcarConflictoRevisado(A, uno.operation_id), true);
  assert.strictEqual(await marcarConflictoRevisado(A, uno.operation_id), false,
    'revisar dos veces no puede "resolver" dos conflictos');
});

await t('CONFLICTO', '12. una mesa movida a dos destinos distintos es conflicto', async () => {
  const mesaId = randomUUID();
  await registrarOperacion(A, op('MESA_MOVIDA', { mesaId, mesaDestino: 9 },
    { dispositivoId: 'tablet-1', secuencia: 300 }));
  const r = await registrarOperacion(A, op('MESA_MOVIDA', { mesaId, mesaDestino: 12 },
    { dispositivoId: 'tablet-2', secuencia: 300 }));
  assert.strictEqual(r.resultado, 'conflicto');
});

// ─── Fallo al aplicar ───────────────────────────────────────────────────────

await t('ATOMICIDAD', '13. si aplicar() falla, NO queda la operacion registrada como aceptada', async () => {
  const o = op('ITEM_AGREGADO', { cuentaId: 'c-falla', producto: 'X', cantidad: 1 });
  const r = await registrarOperacion(A, o, async () => { throw new Error('la base se cayo'); });

  assert.strictEqual(r.resultado, 'rechazada');
  assert.strictEqual(r.reintentable, true, 'un fallo de infra es reintentable, no un rechazo definitivo');

  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM sync_operaciones WHERE negocio_id=$1 AND operation_id=$2`,
    [A, o.operationId]);
  assert.strictEqual(rows[0].n, 0, 'no puede quedar media operacion');
});

await t('ATOMICIDAD', '14. y despues del fallo, el reintento SI la aplica', async () => {
  const o = op('ITEM_AGREGADO', { cuentaId: 'c-recup', producto: 'Y', cantidad: 1 });
  await registrarOperacion(A, o, async () => { throw new Error('cayo'); });
  const r = await registrarOperacion(A, o, async () => ({ ok: true }));
  assert.strictEqual(r.resultado, 'aceptada', 'el reintento tiene que poder salir adelante');
});

// ─── Orden ──────────────────────────────────────────────────────────────────

await t('ORDEN', '15. el lote se ordena por (dispositivo, secuencia), no por reloj', async () => {
  // Una tablet con la hora atrasada no puede reordenar lo que hizo otra.
  const cuentaId = randomUUID();
  const viejo = new Date(Date.now() - 3600_000).toISOString();
  const lote = [
    { ...op('RONDA_ENVIADA', { cuentaId, ronda: 2 }, { dispositivoId: 'tablet-9', secuencia: 2 }), creadaEnLocal: viejo },
    op('CUENTA_ABIERTA', { cuentaId }, { dispositivoId: 'tablet-9', secuencia: 1 }),
  ];
  const aplicadas = [];
  await sincronizarLote(A, lote, async (_c, o) => { aplicadas.push(o.secuencia); return null; });
  assert.deepStrictEqual(aplicadas, [1, 2], 'la secuencia manda sobre el reloj mentiroso');
});

// ─── Amnesia del Edge ───────────────────────────────────────────────────────

await t('AMNESIA', '16. un dispositivo nuevo no es amnesia', async () => {
  const r = await registrarGeneracion(A, 'tablet-nueva', 'gen-x');
  assert.strictEqual(r.conocido, false);
  assert.strictEqual(r.amnesia, false);
});

await t('AMNESIA', '17. misma generacion: continuidad normal', async () => {
  await registrarGeneracion(A, 'tablet-mem', 'gen-1');
  const r = await registrarGeneracion(A, 'tablet-mem', 'gen-1');
  assert.strictEqual(r.amnesia, false);
});

await t('AMNESIA', '18. generacion distinta: la nube detecta que el Edge perdio su journal', async () => {
  await registrarGeneracion(A, 'tablet-borrada', 'gen-vieja');
  await registrarOperacion(A, op('ITEM_AGREGADO', { cuentaId: 'z', producto: 'Q', cantidad: 1 },
    { dispositivoId: 'tablet-borrada', secuencia: 42 }));

  const r = await registrarGeneracion(A, 'tablet-borrada', 'gen-nueva');
  assert.strictEqual(r.amnesia, true, 'no se puede fingir continuidad');
  assert.strictEqual(r.ultimaSecuencia, 42, 'y hay que decirle hasta donde habia llegado');
});

// ─── Resumen ────────────────────────────────────────────────────────────────
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { for (const f of fallos) console.log(`  - ${f}`); }
await pool.end();
process.exit(fallidas ? 1 : 0);
