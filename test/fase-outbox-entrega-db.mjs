// ─── LA RESPUESTA COMPROMETIDA SALE UNA SOLA VEZ ─────────────────────────
//
// Hallazgo P1 de la revisión: el despachador enviaba a Meta, luego guardaba el
// historial; si el guardado fallaba DESPUÉS de que Meta devolviera el wamid,
// la llamada lanzaba, se leía como fallo de envío y la misma respuesta se
// reprogramaba: Meta la aceptó y Xabor la volvía a mandar.
//
// Aquí se prueban, con fallos REALES inyectados y contra Postgres:
//   · Meta acepta + el historial falla → cero reenvíos, wamid persistido;
//   · Meta acepta + la base falla al anotarlo → incierto, cero reenvíos;
//   · dos despachadores a la vez → cada fila una vez;
//   · el camino en línea y el despachador compitiendo → una vez;
//   · rechazo confirmado → reintentos acotados; resultado incierto → persona;
//   · un emisor que murió con la fila en `enviando` → incierto, sin reenvío;
//   · el acuse del diálogo perdido se concilia desde el outbox;
//   · una respuesta que el cliente NO recibió (rechazo agotado, en línea,
//     vencida, incierta) pasa a una persona de forma durable: la marca va en
//     la fila, la confirmación se reintenta si falla, un reclamo de un proceso
//     muerto se retoma y dos procesos a la vez piden UNA sola persona.
//
// Meta es un doble que cuenta llamadas por fila. Nada sale de la máquina.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const HOST = new URL(process.env.DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(HOST)) throw new Error('Solo acepta Postgres local');

const { pool } = await import('../src/services/database.js');
const {
  entregarRespuesta, despacharRespuestasPendientes, clasificarErrorDeEnvio, enviarYClasificar,
  conciliarDialogoEntregado, confirmarEntregaHumana, MOTIVO_HUMANO,
} = await import('../src/mesero-agente/entregaDeRespuestas.js');
const { crearContinuidad } = await import('../src/services/whatsappContinuidad.js');
const { leerEstadoVersionado } = await import('../src/mesero-agente/persistenciaDelTurno.js');
const { estadoNuevo } = await import('../src/mesero-agente/ejecutorDeHerramientas.js');
const { normalizarEstado } = await import('../src/mesero-agente/estadoCanonico.js');

let pasadas = 0;
const fallos = [];
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function t(nombre, fn) {
  if (SOLO.length && !SOLO.includes(nombre.split(' ')[0])) return;
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
  finally {
    // Cada caso empieza sin sobras del anterior: nada pendiente de enviar y
    // ningún paso a persona por confirmar (el despachador es global y los
    // contaría en el caso siguiente).
    await pool.query(`UPDATE agente_outbox SET estado = 'descartado' WHERE negocio_id = $1 AND estado IN ('pendiente','enviando')`, [NEG]).catch(() => {});
    await pool.query(`UPDATE agente_outbox SET humano_confirmado_at = now(), humano_reclamado_at = NULL
      WHERE negocio_id = $1 AND humano_motivo IS NOT NULL AND humano_confirmado_at IS NULL`, [NEG]).catch(() => {});
  }
}

// El bot del negocio está encendido (interruptor maestro): con él apagado el
// despachador no entrega nada (ver O11c).
const { rows: [negocio] } = await pool.query(
  'INSERT INTO negocios (nombre, slug, bot_whatsapp_activo) VALUES ($1,$2,TRUE) RETURNING id',
  ['OUTBOX Entrega', `outbox-${randomUUID()}`]);
const NEG = negocio.id;
let nTel = 0;
const tel = () => `52819922${String(++nTel).padStart(2, '0')}`;

// Una conversación con un resumen SIN acusar y su respuesta comprometida.
async function respuestaComprometida(telefono, { texto = 'Tu borrador contiene: 1 × Waffle. ¿Confirmas este pedido?', minutos = 0 } = {}) {
  const sessionId = `agente:${telefono}`;
  const estado = normalizarEstado(estadoNuevo({ negocioId: NEG, conversacionId: sessionId }));
  const dialogoId = randomUUID();
  estado.dialogo = { id: dialogoId, ciclo: sessionId, mensaje: 'un waffle', texto, tipo: 'resumen', huella: 'h1', enviado: false };
  await pool.query(`INSERT INTO conversacion_estado (negocio_id, session_id, estado, revision) VALUES ($1,$2,$3::jsonb,1)
    ON CONFLICT (negocio_id, session_id) DO UPDATE SET estado = EXCLUDED.estado`, [NEG, sessionId, JSON.stringify(estado)]);
  const clave = createHash('sha256').update(`${sessionId}|${randomUUID()}`).digest('hex');
  const { rows: [fila] } = await pool.query(
    `INSERT INTO agente_outbox (negocio_id, evento_clave, tipo, carga, conversacion_id, turno_clave, disponible_at, created_at)
     VALUES ($1,$2,'respuesta_cliente',$3::jsonb,$4,$5, now(), now() - ($6 || ' minutes')::interval) RETURNING *`,
    [NEG, clave, JSON.stringify({ telefono, texto, dialogo_id: dialogoId, session_id: sessionId }), sessionId,
      `wa:${randomUUID()}`, String(minutos)]);
  return { clave, id: fila.id, sessionId, dialogoId, texto };
}
const fila = async (id) => (await pool.query(
  `SELECT estado, intentos, wamid_salida, ultimo_error, carga, reclamado_por, disponible_at > now() AS futuro,
          humano_motivo, humano_solicitado_at IS NOT NULL AS humano_solicitado,
          humano_reclamado_at IS NOT NULL AS humano_reclamado, humano_confirmado_at IS NOT NULL AS humano_confirmado
     FROM agente_outbox WHERE id = $1`, [id])).rows[0];

// El paso a una persona de mentira: cuenta llamadas POR FILA y confirma (o no)
// según se le pida. Con `demoraMs` abre la ventana de carrera entre procesos.
function personaDoble(comportamiento = () => true, { demoraMs = 0 } = {}) {
  const llamadas = [];
  const alHumano = async (x) => {
    llamadas.push(x);
    if (demoraMs) await new Promise((ok) => setTimeout(ok, demoraMs));
    return comportamiento(x, llamadas.filter((l) => l.fila?.id === x.fila?.id).length);
  };
  alHumano.llamadas = llamadas;
  alHumano.veces = (id) => llamadas.filter((l) => String(l.fila?.id) === String(id)).length;
  return alHumano;
}
const dialogoDe = async (sessionId) => (await pool.query(
  'SELECT estado->\'dialogo\' AS d FROM conversacion_estado WHERE negocio_id = $1 AND session_id = $2', [NEG, sessionId])).rows[0]?.d;
const ahoraDisponible = (id) => pool.query('UPDATE agente_outbox SET disponible_at = now() WHERE id = $1', [id]);

// Meta de mentira: cuenta llamadas POR TELÉFONO y hace lo que se le pida.
function metaDoble(comportamiento = () => ({ messages: [{ id: `wamid.${randomUUID()}` }] }), { demoraMs = 0 } = {}) {
  const llamadas = new Map();
  const enviar = async ({ telefono, texto }) => {
    llamadas.set(telefono, (llamadas.get(telefono) || 0) + 1);
    if (demoraMs) await new Promise((ok) => setTimeout(ok, demoraMs));
    return comportamiento({ telefono, texto, n: llamadas.get(telefono) });
  };
  enviar.veces = (telefono) => llamadas.get(telefono) || 0;
  enviar.total = () => [...llamadas.values()].reduce((a, b) => a + b, 0);
  return enviar;
}
const historialQueFalla = async () => { throw new Error('historial caído: mensajes no disponible'); };

try {
  // ═══ 1-5 · META ACEPTA + EL GUARDADO LOCAL FALLA + CERO REENVÍOS ════════
  await t('O1 despachador: Meta acepta, el historial falla → wamid persistido y CERO reenvíos', async () => {
    const T = tel();
    const r = await respuestaComprometida(T);
    const enviar = metaDoble(() => ({ messages: [{ id: 'wamid.O1.aceptado' }] }));
    const res = await despacharRespuestasPendientes({ enviar, registrarHistorial: historialQueFalla });
    assert.equal(res.entregadas, 1, JSON.stringify(res));
    let f = await fila(r.id);
    assert.equal(f.estado, 'entregado');
    assert.equal(f.wamid_salida, 'wamid.O1.aceptado', 'la aceptación de Meta no quedó en la fila');
    assert.match(String(f.ultimo_error), /^post_aceptacion: historial/, 'no quedó evidencia para conciliar');
    // El despachador vuelve a correr (y otra vez): la fila ya no está disponible.
    await ahoraDisponible(r.id);
    await despacharRespuestasPendientes({ enviar, registrarHistorial: historialQueFalla });
    await despacharRespuestasPendientes({ enviar, registrarHistorial: historialQueFalla });
    assert.equal(enviar.veces(T), 1, `Meta fue invocado ${enviar.veces(T)} veces`);
    f = await fila(r.id);
    assert.equal(f.estado, 'entregado');
    // El acuse del diálogo es independiente del historial: el resumen cuenta como leído.
    assert.equal((await dialogoDe(r.sessionId)).enviado, true);
  });

  await t('O1b en línea: Meta acepta, el historial falla → entregado; el despachador después no reenvía', async () => {
    const T = tel();
    const r = await respuestaComprometida(T);
    const enviar = metaDoble(() => ({ messages: [{ id: 'wamid.O1b' }] }));
    const e = await entregarRespuesta({ outboxClave: r.clave, enviar, registrarHistorial: historialQueFalla,
      politicaRechazo: 'no_reintentar' });
    assert.equal(e.estado, 'entregado');
    await ahoraDisponible(r.id);
    await despacharRespuestasPendientes({ enviar });
    assert.equal(enviar.veces(T), 1);
    assert.equal((await fila(r.id)).wamid_salida, 'wamid.O1b');
  });

  await t('O2 Meta acepta y la BASE falla al anotarlo → no se reenvía: incierto y a una persona', async () => {
    const T = tel();
    const r = await respuestaComprometida(T);
    const enviar = metaDoble(() => ({ messages: [{ id: 'wamid.O2' }] }));
    const dbQueFallaAlAceptar = {
      query: (sql, p) => (/SET estado = 'entregado'/.test(sql) ? Promise.reject(new Error('conexión perdida'))
        : pool.query(sql, p)),
      connect: () => pool.connect(),
    };
    const e = await entregarRespuesta({ db: dbQueFallaAlAceptar, outboxClave: r.clave, enviar });
    assert.equal(e.estado, 'entregado', 'Meta aceptó: el emisor no debe reintentar');
    assert.equal(e.aceptacionRegistrada, false);
    assert.equal((await fila(r.id)).estado, 'enviando');
    const revisiones = [];
    const res = await despacharRespuestasPendientes({ enviar, arrendamientoSeg: 0,
      alIncierto: (x) => { revisiones.push(x); return true; } });
    assert.equal(res.colgadas, 1, JSON.stringify(res));
    const f = await fila(r.id);
    assert.equal(f.estado, 'incierto');
    assert.equal(f.humano_motivo, MOTIVO_HUMANO.INCIERTA);
    assert.equal(f.humano_confirmado, true, 'la revisión humana no quedó confirmada en la fila');
    assert.equal(revisiones.length, 1);
    assert.equal(revisiones[0].telefono, T);
    await ahoraDisponible(r.id);
    await despacharRespuestasPendientes({ enviar });
    assert.equal(enviar.veces(T), 1, 'una respuesta que Meta aceptó se volvió a enviar');
  });

  // ═══ 6 · DOS DESPACHADORES A LA VEZ ═════════════════════════════════════
  await t('O3 dos despachadores concurrentes: cada fila sale UNA vez', async () => {
    const tels = [tel(), tel(), tel(), tel(), tel()];
    const filas = [];
    for (const T of tels) filas.push(await respuestaComprometida(T));
    const enviar = metaDoble(({ telefono }) => ({ messages: [{ id: `wamid.O3.${telefono}` }] }), { demoraMs: 120 });
    const [a, b] = await Promise.all([
      despacharRespuestasPendientes({ enviar, reclamador: 'despachador-A' }),
      despacharRespuestasPendientes({ enviar, reclamador: 'despachador-B' }),
    ]);
    assert.equal(a.tomadas + b.tomadas, 5, `${JSON.stringify(a)} ${JSON.stringify(b)}`);
    for (const T of tels) assert.equal(enviar.veces(T), 1, `${T} se envió ${enviar.veces(T)} veces`);
    for (const f of filas) assert.equal((await fila(f.id)).estado, 'entregado');
  });

  await t('O3b en línea vs despachador: quien reclama primero envía; el otro no', async () => {
    // (a) el camino en línea reclama y tarda; el despachador corre en medio.
    const T1 = tel();
    const r1 = await respuestaComprometida(T1);
    const enviar1 = metaDoble(() => ({ messages: [{ id: 'wamid.O3b.1' }] }), { demoraMs: 200 });
    const enLinea = entregarRespuesta({ outboxClave: r1.clave, enviar: enviar1, politicaRechazo: 'no_reintentar' });
    await new Promise((ok) => setTimeout(ok, 40));
    await despacharRespuestasPendientes({ enviar: enviar1 });
    assert.equal((await enLinea).estado, 'entregado');
    assert.equal(enviar1.veces(T1), 1);
    // (b) el despachador reclamó primero; el camino en línea llega tarde.
    const T2 = tel();
    const r2 = await respuestaComprometida(T2);
    const enviar2 = metaDoble(() => ({ messages: [{ id: 'wamid.O3b.2' }] }), { demoraMs: 200 });
    const despacho = despacharRespuestasPendientes({ enviar: enviar2 });
    await new Promise((ok) => setTimeout(ok, 40));
    const tarde = await entregarRespuesta({ outboxClave: r2.clave, enviar: enviar2, politicaRechazo: 'no_reintentar' });
    await despacho;
    assert.equal(tarde.estado, 'no_reclamada');
    assert.ok(['enviando', 'entregado'].includes(tarde.estadoFila), tarde.estadoFila);
    assert.equal(enviar2.veces(T2), 1);
  });

  // ═══ 7 · RECHAZO CONFIRMADO → REINTENTOS ACOTADOS ═══════════════════════
  await t('O4 Meta rechaza (error confirmado): se reintenta con espera y se agota en fallido', async () => {
    const T = tel();
    const r = await respuestaComprometida(T);
    const enviar = metaDoble(() => { throw new Error('Meta API: {"error":{"code":131047,"message":"Re-engagement message"}}'); });
    const alHumano = personaDoble();
    let res = await despacharRespuestasPendientes({ enviar, maxIntentos: 3, alHumano });
    assert.equal(res.reprogramadas, 1, JSON.stringify(res));
    let f = await fila(r.id);
    assert.deepEqual([f.estado, f.intentos, f.futuro], ['pendiente', 1, true], JSON.stringify(f));
    assert.match(String(f.ultimo_error), /^rechazado: Meta API/);
    // Mientras se reintenta NO es un caso para una persona: todavía puede llegar.
    assert.equal(f.humano_motivo, null, 'un rechazo reintentable ya pidió a una persona');
    assert.equal(alHumano.veces(r.id), 0);
    await ahoraDisponible(r.id); await despacharRespuestasPendientes({ enviar, maxIntentos: 3, alHumano });
    await ahoraDisponible(r.id); res = await despacharRespuestasPendientes({ enviar, maxIntentos: 3, alHumano });
    assert.equal(res.fallidas, 1, JSON.stringify(res));
    await ahoraDisponible(r.id); await despacharRespuestasPendientes({ enviar, maxIntentos: 3, alHumano });
    f = await fila(r.id);
    assert.equal(f.estado, 'fallido');
    assert.equal(enviar.veces(T), 3, 'los reintentos no quedaron acotados');
  });

  // ═══ PASO A PERSONA: una respuesta que el cliente NO recibió ════════════
  await t('O10 rechazo agotado → fallido + paso a persona durable, confirmado UNA vez', async () => {
    const T = tel();
    const r = await respuestaComprometida(T);
    const enviar = metaDoble(() => { throw new Error('Meta API: {"error":{"code":131026,"message":"Message undeliverable"}}'); });
    const alHumano = personaDoble();
    for (let i = 0; i < 3; i += 1) {
      await ahoraDisponible(r.id);
      await despacharRespuestasPendientes({ enviar, maxIntentos: 3, alHumano });
    }
    let f = await fila(r.id);
    assert.equal(f.estado, 'fallido');
    assert.equal(f.humano_motivo, MOTIVO_HUMANO.NO_ENTREGADA, JSON.stringify(f));
    assert.equal(f.humano_confirmado, true, 'el rechazo agotado no quedó en manos de una persona');
    assert.equal(alHumano.veces(r.id), 1);
    assert.equal(alHumano.llamadas[0].telefono, T);
    assert.equal(alHumano.llamadas[0].motivo, MOTIVO_HUMANO.NO_ENTREGADA);
    // Más barridos: ni se reenvía ni se vuelve a pedir a la persona.
    await ahoraDisponible(r.id);
    await despacharRespuestasPendientes({ enviar, maxIntentos: 3, alHumano });
    await despacharRespuestasPendientes({ enviar, maxIntentos: 3, alHumano });
    f = await fila(r.id);
    assert.equal(enviar.veces(T), 3, 'una respuesta fallida se volvió a enviar');
    assert.equal(alHumano.veces(r.id), 1, `se pidió a una persona ${alHumano.veces(r.id)} veces`);
  });

  await t('O10b en línea: un rechazo no se reintenta y pasa a persona en el acto', async () => {
    const T = tel();
    const r = await respuestaComprometida(T);
    const enviar = metaDoble(() => { throw new Error('Meta API: {"error":{"code":131047}}'); });
    const alHumano = personaDoble();
    const e = await entregarRespuesta({ outboxClave: r.clave, enviar, politicaRechazo: 'no_reintentar', alHumano });
    assert.equal(e.estado, 'fallido');
    assert.equal(e.humano, 'confirmada');
    const f = await fila(r.id);
    assert.deepEqual([f.estado, f.humano_motivo, f.humano_confirmado], ['fallido', MOTIVO_HUMANO.NO_ENTREGADA, true]);
    assert.equal(alHumano.veces(r.id), 1);
    await despacharRespuestasPendientes({ enviar, alHumano });
    assert.equal(alHumano.veces(r.id), 1, 'el despachador repitió el paso a persona ya confirmado');
    assert.equal(enviar.veces(T), 1);
  });

  await t('O11 respuesta vencida → descartada SIN enviar + paso a persona confirmado', async () => {
    const T = tel();
    const r = await respuestaComprometida(T, { minutos: 30 });
    const enviar = metaDoble();
    const alHumano = personaDoble();
    const res = await despacharRespuestasPendientes({ enviar, alHumano });
    assert.equal(res.vencidas, 1, JSON.stringify(res));
    assert.equal(res.humanasConfirmadas, 1, JSON.stringify(res));
    const f = await fila(r.id);
    assert.equal(f.estado, 'descartado');
    assert.match(String(f.ultimo_error), /respuesta_vencida/);
    assert.equal(f.humano_motivo, MOTIVO_HUMANO.VENCIDA);
    assert.equal(f.humano_confirmado, true);
    assert.equal(enviar.total(), 0, 'una respuesta vencida salió fuera de contexto');
    assert.equal(alHumano.veces(r.id), 1);
    assert.equal(alHumano.llamadas[0].telefono, T);
    await despacharRespuestasPendientes({ enviar, alHumano });
    assert.equal(alHumano.veces(r.id), 1);
  });

  await t('O11b superada o ya atendida por una persona → descartada SIN paso a persona', async () => {
    const enviar = metaDoble();
    const alHumano = personaDoble();
    const T1 = tel();
    const superada = await respuestaComprometida(T1, { minutos: 30 });
    await pool.query(`INSERT INTO agente_outbox (negocio_id, evento_clave, tipo, carga, conversacion_id, disponible_at)
      VALUES ($1,$2,'respuesta_cliente',$3::jsonb,$4, now() + interval '1 hour')`,
    [NEG, `sup-${randomUUID()}`, JSON.stringify({ telefono: T1, texto: 'más nueva' }), superada.sessionId]);
    const T2 = tel();
    const atendida = await respuestaComprometida(T2, { minutos: 30 });
    await pool.query(`INSERT INTO conversaciones_control (negocio_id, telefono, bot_pausado) VALUES ($1,$2,TRUE)
      ON CONFLICT (negocio_id, telefono) DO UPDATE SET bot_pausado = TRUE`, [NEG, T2]);
    await despacharRespuestasPendientes({ enviar, alHumano });
    for (const x of [superada, atendida]) {
      const f = await fila(x.id);
      assert.equal(f.estado, 'descartado');
      assert.equal(f.humano_motivo, null, `${x.id}: pidió una persona sin necesitarla`);
    }
    assert.equal(alHumano.llamadas.length, 0);
    assert.equal(enviar.total(), 0);
  });

  await t('O11c bot del negocio APAGADO: lo que quedó en cola no sale (apagado inmediato de verdad)', async () => {
    const T = tel();
    const r = await respuestaComprometida(T);
    const enviar = metaDoble();
    const alHumano = personaDoble();
    await pool.query('UPDATE negocios SET bot_whatsapp_activo = FALSE WHERE id = $1', [NEG]);
    try {
      await despacharRespuestasPendientes({ enviar, alHumano });
    } finally {
      await pool.query('UPDATE negocios SET bot_whatsapp_activo = TRUE WHERE id = $1', [NEG]);
    }
    const f = await fila(r.id);
    assert.equal(f.estado, 'descartado', JSON.stringify(f));
    assert.match(String(f.ultimo_error), /bot_apagado/);
    assert.equal(f.humano_motivo, null, 'con el bot apagado todo es atención manual: no se pide otra persona');
    assert.equal(enviar.total(), 0, 'con el bot apagado salió una respuesta del bot');
    assert.equal(alHumano.llamadas.length, 0);
  });

  await t('O12 la confirmación falla → queda por confirmar y el siguiente barrido la completa (una vez)', async () => {
    const T = tel();
    const r = await respuestaComprometida(T, { minutos: 30 });
    const enviar = metaDoble();
    // 1ª: la revisión no quedó activa; 2ª: lanza; 3ª: confirma.
    const alHumano = personaDoble((_x, n) => {
      if (n === 2) throw new Error('base de revisiones caída');
      return n >= 3;
    });
    let res = await despacharRespuestasPendientes({ enviar, alHumano });
    let f = await fila(r.id);
    assert.equal(res.humanasPendientes, 1, JSON.stringify(res));
    assert.deepEqual([f.estado, f.humano_confirmado, f.humano_reclamado], ['descartado', false, false], JSON.stringify(f));
    assert.match(String(f.ultimo_error), /humano_sin_confirmar/);
    res = await despacharRespuestasPendientes({ enviar, alHumano });
    f = await fila(r.id);
    assert.equal(f.humano_confirmado, false);
    res = await despacharRespuestasPendientes({ enviar, alHumano });
    f = await fila(r.id);
    assert.equal(f.humano_confirmado, true, JSON.stringify(res));
    await despacharRespuestasPendientes({ enviar, alHumano });
    assert.equal(alHumano.veces(r.id), 3, `llamadas: ${alHumano.veces(r.id)}`);
    assert.equal(enviar.total(), 0);
  });

  await t('O13 un proceso murió con el paso a persona reclamado: se retoma al vencer; vigente, no se toca', async () => {
    const T1 = tel();
    const muerta = await respuestaComprometida(T1);
    const T2 = tel();
    const vigente = await respuestaComprometida(T2);
    for (const [x, hace] of [[muerta, '10 minutes'], [vigente, '1 second']]) {
      await pool.query(`UPDATE agente_outbox SET estado = 'descartado', humano_motivo = $2,
          humano_solicitado_at = now(), humano_reclamado_at = now() - $3::interval WHERE id = $1`,
      [x.id, MOTIVO_HUMANO.VENCIDA, hace]);
    }
    const alHumano = personaDoble();
    await despacharRespuestasPendientes({ enviar: metaDoble(), alHumano, arrendamientoHumanoSeg: 60 });
    assert.equal((await fila(muerta.id)).humano_confirmado, true, 'el reclamo de un proceso muerto no se retomó');
    assert.equal(alHumano.veces(vigente.id), 0, 'se pisó el reclamo vigente de otro proceso');
    assert.equal((await fila(vigente.id)).humano_confirmado, false);
    // Y confirmarEntregaHumana directo respeta el mismo reclamo.
    assert.equal((await confirmarEntregaHumana({ id: vigente.id, alHumano, arrendamientoSeg: 60 })).estado, 'no_reclamada');
  });

  // ═══ DOS PROCESOS: UN SOLO PASO A PERSONA ═══════════════════════════════
  await t('O14 dos despachadores a la vez sobre respuestas vencidas: una persona por fila, ni una más', async () => {
    const filas = [];
    for (let i = 0; i < 5; i += 1) filas.push(await respuestaComprometida(tel(), { minutos: 30 }));
    const alHumano = personaDoble(() => true, { demoraMs: 80 });
    const enviar = metaDoble();
    const [a, b] = await Promise.all([
      despacharRespuestasPendientes({ enviar, alHumano, reclamador: 'despachador-A' }),
      despacharRespuestasPendientes({ enviar, alHumano, reclamador: 'despachador-B' }),
    ]);
    assert.equal(a.humanasConfirmadas + b.humanasConfirmadas, 5, `${JSON.stringify(a)} ${JSON.stringify(b)}`);
    for (const x of filas) {
      assert.equal(alHumano.veces(x.id), 1, `${x.id}: ${alHumano.veces(x.id)} pasos a persona`);
      assert.equal((await fila(x.id)).humano_confirmado, true);
    }
    // Y una tercera y cuarta corrida simultáneas ya no piden nada.
    await Promise.all([despacharRespuestasPendientes({ enviar, alHumano }), despacharRespuestasPendientes({ enviar, alHumano })]);
    assert.equal(alHumano.llamadas.length, 5);
    assert.equal(enviar.total(), 0);
  });

  await t('O14c tres procesos confirman A LA VEZ la misma fila marcada: una sola persona', async () => {
    const filas = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await respuestaComprometida(tel());
      await pool.query(`UPDATE agente_outbox SET estado = 'fallido', humano_motivo = $2, humano_solicitado_at = now()
        WHERE id = $1`, [r.id, MOTIVO_HUMANO.NO_ENTREGADA]);
      filas.push(r);
    }
    const alHumano = personaDoble(() => true, { demoraMs: 120 });
    for (const r of filas) {
      const resultados = await Promise.all(Array.from({ length: 3 },
        () => confirmarEntregaHumana({ id: r.id, alHumano, arrendamientoSeg: 60 })));
      assert.deepEqual(resultados.map((x) => x.estado).sort(), ['confirmada', 'no_reclamada', 'no_reclamada'],
        JSON.stringify(resultados));
      assert.equal(alHumano.veces(r.id), 1, `${r.id}: ${alHumano.veces(r.id)} llamadas`);
      assert.equal((await fila(r.id)).humano_confirmado, true);
    }
  });

  await t('O10c la confirmación del rechazo agotado y del incierto falla: la marca QUEDA y el barrido la completa', async () => {
    // Rechazo agotado en línea con la persona caída la primera vez.
    const T1 = tel();
    const r1 = await respuestaComprometida(T1);
    const cae = personaDoble((_x, n) => { if (n === 1) throw new Error('revisiones caídas'); return true; });
    const e1 = await entregarRespuesta({ outboxClave: r1.clave, politicaRechazo: 'no_reintentar', alHumano: cae,
      enviar: metaDoble(() => { throw new Error('Meta API: {"error":{"code":131026}}'); }) });
    assert.deepEqual([e1.estado, e1.humano], ['fallido', 'pendiente']);
    let f = await fila(r1.id);
    assert.deepEqual([f.estado, f.humano_motivo, f.humano_confirmado, f.humano_reclamado],
      ['fallido', MOTIVO_HUMANO.NO_ENTREGADA, false, false], JSON.stringify(f));
    // Incierto (timeout) con la persona que no queda activa la primera vez.
    const T2 = tel();
    const r2 = await respuestaComprometida(T2);
    const noQueda = personaDoble((_x, n) => n >= 2);
    const e2 = await entregarRespuesta({ outboxClave: r2.clave, alHumano: noQueda,
      enviar: metaDoble(() => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }) });
    assert.deepEqual([e2.estado, e2.humano], ['incierto', 'pendiente']);
    f = await fila(r2.id);
    assert.deepEqual([f.estado, f.humano_motivo, f.humano_confirmado], ['incierto', MOTIVO_HUMANO.INCIERTA, false]);
    // El barrido confirma las dos, una vez cada una, sin reenviar nada.
    const todas = async (x) => ((x.fila?.id === r1.id) ? cae(x) : noQueda(x));
    const enviar = metaDoble();
    await despacharRespuestasPendientes({ enviar, alHumano: todas });
    await despacharRespuestasPendientes({ enviar, alHumano: todas });
    assert.equal((await fila(r1.id)).humano_confirmado, true);
    assert.equal((await fila(r2.id)).humano_confirmado, true);
    assert.equal(cae.veces(r1.id), 2);
    assert.equal(noQueda.veces(r2.id), 2);
    assert.equal(enviar.total(), 0, 'una respuesta fallida o incierta se reenvió');
  });

  await t('O14b la revisión de la conversación es atómica: 6 pedidos simultáneos → 1 marca y 1 aviso', async () => {
    const avisos = [];
    const continuidad = crearContinuidad({
      pool, locks: pool, procesar: async () => {}, cargarSesion: async () => {}, leerSesion: async () => ({}),
      alRevision: async (n, t, m) => { avisos.push({ n, t, m }); },
    });
    const T = tel();
    // La conversación YA existe (en producción la crea `recibir` con el primer
    // mensaje): así lo que ordena a los concurrentes es el FOR UPDATE de la
    // fila, no la espera del INSERT de una fila nueva.
    await pool.query(`INSERT INTO whatsapp_conversaciones (negocio_id, telefono, requiere_revision) VALUES ($1,$2,FALSE)
      ON CONFLICT (negocio_id, telefono) DO UPDATE SET requiere_revision = FALSE`, [NEG, T]);
    const marcas = await Promise.all(Array.from({ length: 6 },
      () => continuidad.enviarARevision(NEG, T, MOTIVO_HUMANO.VENCIDA)));
    assert.equal(marcas.filter(Boolean).length, 1, `marcas: ${JSON.stringify(marcas)}`);
    assert.equal(avisos.length, 1, `avisos al equipo: ${avisos.length}`);
    assert.equal(await continuidad.revisionActiva(NEG, T), true);
    // Dos respuestas de OTRA conversación rechazadas a la vez por dos procesos
    // en línea, con el mismo alHumano que usa producción (marca o confirma la
    // ya activa): las dos filas quedan confirmadas y el equipo recibe UN aviso.
    const alHumano = async ({ negocioId, telefono, motivo }) => (await continuidad.enviarARevision(negocioId, telefono, motivo))
      || continuidad.revisionActiva(negocioId, telefono);
    const T2 = tel();
    await pool.query(`INSERT INTO whatsapp_conversaciones (negocio_id, telefono, requiere_revision) VALUES ($1,$2,FALSE)
      ON CONFLICT (negocio_id, telefono) DO UPDATE SET requiere_revision = FALSE`, [NEG, T2]);
    const r1 = await respuestaComprometida(T2);
    const r2 = await respuestaComprometida(T2);
    const rechaza = metaDoble(() => { throw new Error('Meta API: {"error":{"code":131026}}'); }, { demoraMs: 60 });
    const [e1, e2] = await Promise.all([r1, r2].map((r, i) => entregarRespuesta({ outboxClave: r.clave, enviar: rechaza,
      politicaRechazo: 'no_reintentar', alHumano, reclamador: `en-linea-${i}` })));
    assert.deepEqual([e1.humano, e2.humano], ['confirmada', 'confirmada']);
    for (const r of [r1, r2]) assert.equal((await fila(r.id)).humano_confirmado, true);
    assert.equal(avisos.filter((a) => a.t === T2).length, 1, 'la misma conversación avisó al equipo más de una vez');
    // Una respuesta vencida de una conversación que YA está en revisión no
    // pide otra persona: se descarta como atendida.
    const T3 = tel();
    assert.equal(await continuidad.enviarARevision(NEG, T3, 'ESCALADA_MODELO'), true);
    const r3 = await respuestaComprometida(T3, { minutos: 30 });
    const otra = personaDoble();
    await despacharRespuestasPendientes({ enviar: metaDoble(), alHumano: otra });
    const f3 = await fila(r3.id);
    assert.deepEqual([f3.estado, f3.humano_motivo], ['descartado', null], JSON.stringify(f3));
    assert.match(String(f3.ultimo_error), /atencion_humana/);
    assert.equal(otra.llamadas.length, 0);
  });

  await t('O4b sin conexión (ECONNREFUSED) o sin credenciales: rechazo confirmado, reintentable', async () => {
    const T1 = tel();
    const r1 = await respuestaComprometida(T1);
    const sinConexion = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    await despacharRespuestasPendientes({ enviar: metaDoble(() => { throw sinConexion; }) });
    assert.equal((await fila(r1.id)).estado, 'pendiente');
    const T2 = tel();
    const r2 = await respuestaComprometida(T2);
    await despacharRespuestasPendientes({ enviar: metaDoble(() => null) });
    const f2 = await fila(r2.id);
    assert.equal(f2.estado, 'pendiente');
    assert.match(String(f2.ultimo_error), /no_intentado/);
  });

  // ═══ 8 · RESULTADO INCIERTO → NUNCA A CIEGAS ════════════════════════════
  await t('O5 timeout / conexión cortada / 200 sin wamid: incierto, a una persona, sin reenvío', async () => {
    const casos = [
      ['timeout', () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }],
      ['reset', () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }); }],
      ['sin_wamid', () => ({ messages: [] })],
    ];
    for (const [nombre, comportamiento] of casos) {
      const T = tel();
      const r = await respuestaComprometida(T);
      const enviar = metaDoble(comportamiento);
      const revisiones = [];
      const res = await despacharRespuestasPendientes({ enviar, alIncierto: (x) => { revisiones.push(x); return true; } });
      assert.equal(res.inciertas, 1, `${nombre}: ${JSON.stringify(res)}`);
      const f = await fila(r.id);
      assert.equal(f.estado, 'incierto', nombre);
      assert.deepEqual([f.humano_motivo, f.humano_confirmado], [MOTIVO_HUMANO.INCIERTA, true], nombre);
      assert.equal(revisiones.length, 1, `${nombre}: no se pidió revisión humana`);
      await ahoraDisponible(r.id);
      await despacharRespuestasPendientes({ enviar });
      assert.equal(enviar.veces(T), 1, `${nombre}: un resultado incierto se reenvió`);
    }
  });

  await t('O6 un emisor que murió con la fila en `enviando`: incierto, sin reenvío', async () => {
    const T = tel();
    const r = await respuestaComprometida(T);
    await pool.query(`UPDATE agente_outbox SET estado = 'enviando', reclamado_por = 'proceso-muerto',
      reclamado_at = now() - interval '10 minutes', intentos = 1 WHERE id = $1`, [r.id]);
    const enviar = metaDoble();
    const revisiones = [];
    const res = await despacharRespuestasPendientes({ enviar, alIncierto: (x) => { revisiones.push(x); return true; } });
    assert.equal(res.colgadas, 1);
    const f = await fila(r.id);
    assert.equal(f.estado, 'incierto');
    assert.deepEqual([f.humano_motivo, f.humano_confirmado], [MOTIVO_HUMANO.INCIERTA, true]);
    assert.equal(revisiones.length, 1);
    assert.equal(enviar.total(), 0, 'se reenvió una respuesta cuyo destino no se conoce');
  });

  await t('O7 descartes de siempre: vencida, superada o tomada por una persona → sin envío', async () => {
    const enviar = metaDoble();
    const T1 = tel();
    const vieja = await respuestaComprometida(T1, { minutos: 30 });
    const T2 = tel();
    const superada = await respuestaComprometida(T2, { minutos: 1 });
    await pool.query(`INSERT INTO agente_outbox (negocio_id, evento_clave, tipo, carga, conversacion_id, disponible_at)
      VALUES ($1,$2,'respuesta_cliente',$3::jsonb,$4, now() + interval '1 hour')`,
    [NEG, `sup-${randomUUID()}`, JSON.stringify({ telefono: T2, texto: 'más nueva' }), superada.sessionId]);
    const T3 = tel();
    const pausada = await respuestaComprometida(T3);
    await pool.query(`INSERT INTO conversaciones_control (negocio_id, telefono, bot_pausado) VALUES ($1,$2,TRUE)
      ON CONFLICT (negocio_id, telefono) DO UPDATE SET bot_pausado = TRUE`, [NEG, T3]).catch(() => {});
    const res = await despacharRespuestasPendientes({ enviar });
    assert.equal(enviar.total(), 0, JSON.stringify(res));
    for (const f of [vieja, superada]) assert.equal((await fila(f.id)).estado, 'descartado');
    const fp = await fila(pausada.id);
    assert.ok(['descartado'].includes(fp.estado), `pausada: ${fp.estado}`);
  });

  await t('O15 un error ANTES de enviar una fila la devuelve a la cola y el lote sigue', async () => {
    const T1 = tel();
    const r1 = await respuestaComprometida(T1);
    const T2 = tel();
    const r2 = await respuestaComprometida(T2);
    // La consulta de «respuesta superada» falla SOLO para la primera fila.
    const dbQueFallaUnaVez = {
      query: (sql, p) => (/created_at > \$3 AND id <> \$4/.test(sql) && p?.[3] === r1.id
        ? Promise.reject(new Error('conexión perdida a media fila')) : pool.query(sql, p)),
      connect: () => pool.connect(),
    };
    const enviar = metaDoble();
    await despacharRespuestasPendientes({ db: dbQueFallaUnaVez, enviar, alHumano: personaDoble() });
    const f1 = await fila(r1.id);
    assert.deepEqual([f1.estado, f1.reclamado_por], ['pendiente', null], `la fila con error: ${JSON.stringify(f1)}`);
    assert.equal(enviar.veces(T1), 0);
    assert.equal((await fila(r2.id)).estado, 'entregado', 'el error de otra fila tumbó el lote');
    assert.equal(enviar.veces(T2), 1);
    // En el siguiente ciclo se entrega una vez.
    await ahoraDisponible(r1.id);
    await despacharRespuestasPendientes({ enviar });
    assert.equal((await fila(r1.id)).estado, 'entregado');
    assert.equal(enviar.veces(T1), 1);
  });

  await t('O16 una fila que otra corrida barrió mientras el lote avanzaba NO se envía', async () => {
    const T = tel();
    const r = await respuestaComprometida(T);
    // Simula la carrera: justo cuando esta corrida va a enviar, la fila ya fue
    // barrida a `incierto` por otra (su reclamo ya no es de esta corrida).
    const dbQueBarre = {
      query: async (sql, p) => {
        if (/SET reclamado_at = now\(\)\s+WHERE id = \$1 AND estado = 'enviando' AND reclamado_por = \$2/.test(sql)) {
          await pool.query(`UPDATE agente_outbox SET estado = 'incierto', humano_motivo = $2, humano_solicitado_at = now()
            WHERE id = $1`, [p[0], MOTIVO_HUMANO.INCIERTA]);
        }
        return pool.query(sql, p);
      },
      connect: () => pool.connect(),
    };
    const enviar = metaDoble();
    await despacharRespuestasPendientes({ db: dbQueBarre, enviar });
    assert.equal(enviar.total(), 0, 'se envió una fila que ya se había dado por incierta');
    assert.equal((await fila(r.id)).estado, 'incierto');
  });

  // ═══ CONCILIACIÓN DEL ACUSE DEL DIÁLOGO ═════════════════════════════════
  await t('O8 el acuse del diálogo perdido se concilia desde el outbox al leer la conversación', async () => {
    const T = tel();
    const r = await respuestaComprometida(T);
    await pool.query(`UPDATE agente_outbox SET estado = 'entregado', wamid_salida = 'wamid.O8' WHERE id = $1`, [r.id]);
    assert.equal((await dialogoDe(r.sessionId)).enviado, false);
    const estado = await leerEstadoVersionado(NEG, T);
    assert.equal(estado.dialogo.enviado, true, 'Meta aceptó la respuesta y el diálogo sigue sin acusar');
    assert.equal(estado.dialogo.wamid, 'wamid.O8');
    // Una respuesta que NO se entregó no concilia nada.
    const T2 = tel();
    const r2 = await respuestaComprometida(T2);
    const e2 = await leerEstadoVersionado(NEG, T2);
    assert.equal(e2.dialogo.enviado, false);
    assert.equal(await conciliarDialogoEntregado(e2, { negocioId: NEG }), false);
    void r2;
  });

  // ═══ CLASIFICACIÓN (pura) ═══════════════════════════════════════════════
  await t('O9 clasificación de lo que devuelve o lanza el transporte', async () => {
    const c = (e) => clasificarErrorDeEnvio(e).resultado;
    assert.equal(c(new Error('Meta API: {"error":{}}')), 'rechazado');
    assert.equal(c(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 'rechazado');
    assert.equal(c(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })), 'rechazado');
    assert.equal(c(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'incierto');
    assert.equal(c(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), 'incierto');
    assert.equal(c(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } })), 'incierto');
    assert.equal(c(new SyntaxError('Unexpected token <')), 'incierto');
    assert.equal(c(new Error('META_NO_CONFIRMÓ_ENVIO')), 'incierto');
    assert.deepEqual(await enviarYClasificar(async () => ({ messages: [{ id: 'w1' }] })), { resultado: 'aceptado', wamid: 'w1' });
    assert.deepEqual(await enviarYClasificar(async () => 'w2'), { resultado: 'aceptado', wamid: 'w2' });
    assert.equal((await enviarYClasificar(async () => null)).resultado, 'rechazado');
    assert.equal((await enviarYClasificar(async () => ({}))).resultado, 'incierto');
  });
} finally {
  for (const sql of ['DELETE FROM agente_outbox WHERE negocio_id=$1', 'DELETE FROM conversacion_estado WHERE negocio_id=$1',
    'DELETE FROM conversaciones_control WHERE negocio_id=$1', 'DELETE FROM whatsapp_entradas WHERE negocio_id=$1',
    'DELETE FROM whatsapp_conversaciones WHERE negocio_id=$1', 'DELETE FROM negocios WHERE id=$1']) {
    await pool.query(sql, [NEG]).catch(() => {});
  }
  await pool.end().catch(() => {});
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`${pasadas} pasadas, ${fallos.length} fallidas de ${pasadas + fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
