// WhatsApp durable: que pasa cuando el proceso muere en cada punto del flujo.
//
// El flujo de hoy responde 200 en la PRIMERA linea del webhook. Estas pruebas
// verifican el flujo nuevo: persistir primero, contestar despues, procesar
// aparte -- y que dos workers en dos instancias nunca tomen el mismo evento.
import assert from 'assert';
import { randomUUID } from 'crypto';

const { pool } = await import('../src/services/database.js');
const wa = await import('../src/services/whatsappDurable.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

const { rows: [n] } = await pool.query(
  `INSERT INTO negocios (nombre, slug) VALUES ('WA Durable','wa-durable')
   ON CONFLICT (slug) DO UPDATE SET nombre='WA Durable' RETURNING id`);
const NEG = n.id;
const PNID = '1234567890';

const mensajeMeta = (id, texto = 'hola') => ({
  id, from: '5218780000000', type: 'text', text: { body: texto }, timestamp: '1750000000',
});

// ─── Deduplicacion ──────────────────────────────────────────────────────────

await t('DEDUPE', '1. la clave de un mensaje es su wamid', () => {
  assert.strictEqual(wa.claveEvento('mensaje', { id: 'wamid.ABC' }), 'msg:wamid.ABC');
});

await t('DEDUPE', '2. los tres estados del MISMO mensaje son eventos distintos', () => {
  // Si se dedujera solo por wamid, de sent/delivered/read solo sobreviviria
  // uno y perderiamos el seguimiento de entrega.
  const base = { id: 'wamid.X', timestamp: '1750000001' };
  const s = wa.claveEvento('estado', { ...base, status: 'sent' });
  const d = wa.claveEvento('estado', { ...base, status: 'delivered' });
  const r = wa.claveEvento('estado', { ...base, status: 'read' });
  assert.strictEqual(new Set([s, d, r]).size, 3);
});

await t('DEDUPE', '3. el mismo webhook reentregado es UN evento, y se avisa', async () => {
  const id = `wamid.${randomUUID()}`;
  const p = wa.claveEvento('mensaje', mensajeMeta(id));
  const a = await wa.encolarEntrante({ negocioId: NEG, eventoId: p, tipo: 'mensaje', phoneNumberId: PNID, payload: mensajeMeta(id) });
  const b = await wa.encolarEntrante({ negocioId: NEG, eventoId: p, tipo: 'mensaje', phoneNumberId: PNID, payload: mensajeMeta(id) });

  assert.strictEqual(a.duplicado, false);
  assert.strictEqual(b.duplicado, true, 'el webhook tiene que poder cortar en seco aqui');
  assert.strictEqual(b.id, a.id);

  const { rows } = await pool.query(`SELECT count(*)::int n FROM whatsapp_inbox WHERE evento_id=$1`, [p]);
  assert.strictEqual(rows[0].n, 1);
});

await t('DEDUPE', '4. 50 reentregas del mismo evento siguen siendo una fila', async () => {
  const id = `wamid.${randomUUID()}`;
  const clave = wa.claveEvento('mensaje', mensajeMeta(id));
  const rs = await Promise.all(Array.from({ length: 50 }, () =>
    wa.encolarEntrante({ negocioId: NEG, eventoId: clave, tipo: 'mensaje', phoneNumberId: PNID, payload: {} })));
  assert.strictEqual(rs.filter(r => !r.duplicado).length, 1, 'exactamente una insercion gana');
  const { rows } = await pool.query(`SELECT count(*)::int n FROM whatsapp_inbox WHERE evento_id=$1`, [clave]);
  assert.strictEqual(rows[0].n, 1);
});

// ─── Eventos sin negocio ────────────────────────────────────────────────────

await t('HUERFANO', '5. un evento sin negocio mapeado se GUARDA, no se tira', async () => {
  // Hoy se descarta con un console.error. Perder el mensaje de un cliente
  // porque falta una fila de configuracion es peor que guardarlo sin dueno.
  const clave = `msg:huerfano-${randomUUID()}`;
  const r = await wa.encolarEntrante({ negocioId: null, eventoId: clave, tipo: 'mensaje', phoneNumberId: 'sin-mapear', payload: { x: 1 } });
  assert.strictEqual(r.estado, 'huerfano');
});

await t('HUERFANO', '6. y se recupera cuando el negocio por fin se configura', async () => {
  const adoptados = await wa.adoptarHuerfanos('sin-mapear', NEG);
  assert.ok(adoptados >= 1);
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM whatsapp_inbox WHERE phone_number_id='sin-mapear' AND estado='huerfano'`);
  assert.strictEqual(rows[0].n, 0, 'ya no queda ninguno sin dueno');
});

// ─── Claiming distribuido ───────────────────────────────────────────────────

await t('CLAIMING', '7. dos workers NO toman el mismo evento', async () => {
  await pool.query(`DELETE FROM whatsapp_inbox WHERE tipo = 'claim'`);
  for (let i = 0; i < 40; i++) {
    await wa.encolarEntrante({ negocioId: NEG, eventoId: `claim-${i}-${randomUUID()}`, tipo: 'claim', payload: { i } });
  }
  // En paralelo, como estarian en dos instancias distintas.
  const [a, b] = await Promise.all([
    wa.reclamarEntrantes('worker-A', { limite: 25 }),
    wa.reclamarEntrantes('worker-B', { limite: 25 }),
  ]);
  const ids = [...a, ...b].map(r => r.id);
  assert.strictEqual(new Set(ids).size, ids.length,
    'FOR UPDATE SKIP LOCKED tiene que impedir el solapamiento');
  assert.ok(ids.length >= 40, `entre los dos se llevaron ${ids.length}, se esperaban al menos 40`);

  // Y ninguno de los 40 de este caso puede haber quedado sin reclamar por
  // partida doble: cada uno aparece exactamente una vez.
  const deEsteCaso = [...a, ...b].filter(r => r.tipo === 'claim');
  assert.strictEqual(deEsteCaso.length, 40, `se reclamaron ${deEsteCaso.length} de los 40`);
  assert.strictEqual(new Set(deEsteCaso.map(r => r.id)).size, 40);
});

await t('CLAIMING', '8. lo reclamado queda en procesando con su worker y su lease', async () => {
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM whatsapp_inbox
      WHERE tipo='claim' AND estado='procesando' AND worker_id IS NOT NULL AND lease_hasta > NOW()`);
  assert.strictEqual(rows[0].n, 40);
});

await t('CLAIMING', '9. si un worker muere, el lease vence y OTRO lo recoge', async () => {
  const clave = `lease-${randomUUID()}`;
  await wa.encolarEntrante({ negocioId: NEG, eventoId: clave, tipo: 'lease', payload: {} });
  // Lease minusculo: simula un worker que murio sin soltar la fila.
  const tomado = await wa.reclamarEntrantes('worker-muerto', { limite: 1, leaseMs: 1 });
  assert.strictEqual(tomado.length, 1);
  await esperar(30);

  const rescatado = await wa.reclamarEntrantes('worker-vivo', { limite: 10 });
  assert.ok(rescatado.some(r => r.evento_id === clave),
    'un evento no puede quedarse atrapado porque su worker murio');
});

await t('CLAIMING', '10. procesado se marca solo desde procesando', async () => {
  const clave = `proc-${randomUUID()}`;
  await wa.encolarEntrante({ negocioId: NEG, eventoId: clave, tipo: 'proc', payload: {} });
  const [ev] = await wa.reclamarEntrantes('w1', { limite: 1 });
  assert.strictEqual(await wa.marcarEntranteProcesado(ev.id), true);
  assert.strictEqual(await wa.marcarEntranteProcesado(ev.id), false,
    'marcar dos veces no puede "procesar" dos veces');
});

await t('CLAIMING', '11. un evento que falla se reintenta y acaba fallido, nunca borrado', async () => {
  const clave = `falla-${randomUUID()}`;
  await wa.encolarEntrante({ negocioId: NEG, eventoId: clave, tipo: 'falla', payload: {} });
  let estado = null;
  for (let i = 0; i < 8; i++) {
    const lote = await wa.reclamarEntrantes('w-falla', { limite: 10 });
    const mio = lote.find(e => e.evento_id === clave);
    if (!mio) break;
    estado = (await wa.marcarEntranteFallido(mio.id, 'el bot exploto'))?.estado;
  }
  assert.strictEqual(estado, 'fallido');
  const { rows } = await pool.query(`SELECT ultimo_error FROM whatsapp_inbox WHERE evento_id=$1`, [clave]);
  assert.match(rows[0].ultimo_error, /exploto/, 'con su error visible para poder investigarlo');
});

// ─── Outbox ─────────────────────────────────────────────────────────────────

await t('OUTBOX', '12. un saliente se encola antes de tocar Meta', async () => {
  const r = await wa.encolarSaliente({ negocioId: NEG, claveIdem: `k-${randomUUID()}`,
    destino: '5218780000000', contenido: { texto: 'tu pedido va en camino' } });
  assert.strictEqual(r.duplicado, false);
});

await t('OUTBOX', '13. la misma causa dos veces es UN mensaje, no dos', async () => {
  const clave = `pedido-listo-${randomUUID()}`;
  const a = await wa.encolarSaliente({ negocioId: NEG, claveIdem: clave, destino: '52187800', contenido: { t: 1 } });
  const b = await wa.encolarSaliente({ negocioId: NEG, claveIdem: clave, destino: '52187800', contenido: { t: 1 } });
  assert.strictEqual(a.duplicado, false);
  assert.strictEqual(b.duplicado, true);
  assert.strictEqual(b.id, a.id);
});

await t('OUTBOX', '14. dos workers no reclaman el mismo saliente', async () => {
  for (let i = 0; i < 30; i++) {
    await wa.encolarSaliente({ negocioId: NEG, claveIdem: `out-${i}-${randomUUID()}`, destino: '5218', contenido: { i } });
  }
  const [a, b] = await Promise.all([
    wa.reclamarSalientes('out-A', { limite: 20 }),
    wa.reclamarSalientes('out-B', { limite: 20 }),
  ]);
  const ids = [...a, ...b].map(r => r.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

await t('OUTBOX', '15. un fallo ANTES de escribir es reintentable con backoff', async () => {
  const clave = `retry-${randomUUID()}`;
  const { id } = await wa.encolarSaliente({ negocioId: NEG, claveIdem: clave, destino: '5218', contenido: {} });
  await wa.reclamarSalientes('w', { limite: 50 });
  const r = await wa.marcarSalienteFallido(id, { codigo: '500', error: 'Meta 500', reintentable: true });
  assert.strictEqual(r.estado, 'fallo_reintentable');

  const { rows } = await pool.query(`SELECT proximo_intento_en > NOW() AS espera FROM whatsapp_outbox WHERE id=$1`, [id]);
  assert.strictEqual(rows[0].espera, true, 'no se martillea a Meta cuando esta caido');
});

await t('OUTBOX', '16. un worker que muere EN VUELO deja el mensaje incierto, no reencolado', async () => {
  // Es la misma leccion que la impresion: si los bytes pudieron salir, no se
  // reintenta solo. Reintentar = el cliente recibe el mensaje dos veces.
  const clave = `vuelo-${randomUUID()}`;
  const { id } = await wa.encolarSaliente({ negocioId: NEG, claveIdem: clave, destino: '5218', contenido: {} });
  await wa.reclamarSalientes('w-muere', { limite: 50, leaseMs: 1 });
  await esperar(30);

  const rescatados = await wa.recuperarSalientesColgados();
  assert.ok(rescatados >= 1);

  const { rows } = await pool.query(`SELECT estado FROM whatsapp_outbox WHERE id=$1`, [id]);
  assert.strictEqual(rows[0].estado, 'incierto',
    'ambiguo se marca, no se reintenta ni se da por enviado');
});

await t('OUTBOX', '17. un incierto NO vuelve a la cola por si solo', async () => {
  const antes = await pool.query(`SELECT id FROM whatsapp_outbox WHERE estado='incierto'`);
  const reclamados = await wa.reclamarSalientes('w-goloso', { limite: 100 });
  const inciertosTomados = reclamados.filter(r => antes.rows.some(a => a.id === r.id));
  assert.strictEqual(inciertosTomados.length, 0, 'lo ambiguo lo decide una persona');
});

await t('OUTBOX', '18. enviado_a_meta guarda el wamid que Meta devolvio', async () => {
  const clave = `ok-${randomUUID()}`;
  const { id } = await wa.encolarSaliente({ negocioId: NEG, claveIdem: clave, destino: '5218', contenido: {} });
  await wa.reclamarSalientes('w', { limite: 100 });
  assert.strictEqual(await wa.marcarSalienteEnviado(id, 'wamid.RESP'), true);
  const { rows } = await pool.query(`SELECT estado, wamid FROM whatsapp_outbox WHERE id=$1`, [id]);
  assert.strictEqual(rows[0].estado, 'enviado_a_meta');
  assert.strictEqual(rows[0].wamid, 'wamid.RESP');
});

// ─── Observabilidad ─────────────────────────────────────────────────────────

await t('METRICAS', '19. hay metricas de cola, incluida la edad del mas viejo', async () => {
  const m = await wa.metricasWhatsapp();
  for (const k of ['inbox_pendientes', 'inbox_fallidos', 'inbox_mas_viejo_seg',
                   'outbox_pendientes', 'outbox_inciertos', 'outbox_mas_viejo_seg']) {
    assert.ok(typeof m[k] === 'number', `falta la metrica ${k}`);
  }
  // La edad importa mas que el numero: 3 mensajes parados 40 minutos es peor
  // que 300 avanzando.
  assert.ok(m.inbox_mas_viejo_seg >= 0);
});

await t('METRICAS', '20. las metricas se pueden filtrar por negocio', async () => {
  const m = await wa.metricasWhatsapp(NEG);
  assert.ok(typeof m.inbox_pendientes === 'number');
});

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
await pool.end();
process.exit(fallidas ? 1 : 0);
