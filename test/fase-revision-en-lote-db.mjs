// ─── «MARCAR TODAS COMO REVISADAS», CONTRA POSTGRES ─────────────────────────
//
// 29-oct-2026: Obispado juntó 116 conversaciones en revisión, todas con el bot
// pausado. Mario aprobó un botón que las marca de una vez y deja fuera las que
// una persona debe ver una por una (pago, comprobante o pedido sin confirmar;
// factura, evento o queja; cliente que escribió en las últimas 24 h; una que
// alguien tomó o atiende ahora).
//
// Por el servicio REAL (revisionEnLote.js) contra una base local: la lectura
// que comparte con el job de vencimiento, el candado, la relectura, la
// semántica de «Revisé y atendí» y la auditoría. Cada caso crea SU negocio.
// Base local test_botones_*, red solo local. Sin teléfonos ni pagos reales.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/services/database.js';
import { exigirBaseBotonesLocal } from './lib-botones-local.mjs';
import {
  previsualizarRevisionEnLote, aplicarRevisionEnLote, decidirRevisionEnLote, listaValida, MAX_POR_LOTE,
} from '../src/services/revisionEnLote.js';
import { leerCandidatas, SQL_CANDIDATAS, sqlCandidatas, claveDelCandado } from '../src/services/vencimientoPausasWhatsapp.js';
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';

exigirBaseBotonesLocal();
const telefonoFalso = () => `52000${Math.floor(Math.random() * 1e7).toString().padStart(7, '0')}`;

let n = 0; let fallidas = 0;
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function caso(nombre, fn) {
  if (SOLO.length && !SOLO.includes(nombre.split(' ')[0])) return;
  try { await fn(); console.log(`OK revision-en-lote ${++n}: ${nombre}`); }
  catch (e) {
    fallidas++;
    const detalle = e?.code === 'ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 200)} · esperado=${JSON.stringify(e.expected)?.slice(0, 120)}` : '';
    console.log(`FALLA revision-en-lote: ${nombre}\n  ${String(e?.message || e).split('\n')[0]}${detalle}`);
  }
}

// ── Fixtures (las mismas formas que fase-pausa-vence-db) ────────────────────
async function negocio() {
  const { rows: [r] } = await pool.query('INSERT INTO negocios(nombre,slug,bot_whatsapp_activo) VALUES($1,$2,true) RETURNING id',
    ['Revisión en lote', `revision-lote-${randomUUID()}`]);
  return r.id;
}
async function usuario(negocioId) {
  const { rows: [u] } = await pool.query(
    'INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,$4) RETURNING id',
    [negocioId, 'Admin de prueba', `revision-lote-${randomUUID()}@test.local`, 'x']);
  return u.id;
}
const hace = (h) => `now() - make_interval(secs => ${Number(h) * 3600})`;

/** Una conversación en revisión. `cliente` = hace cuántas horas escribió el cliente. */
async function conversacion(negocioId, {
  telefono = telefonoFalso(), motivo = 'AGENTE_PIDE_HUMANO', revision = true, pausa = true, updatedBy = null,
  horas = 72, cliente = 72, takeover = false, agente = undefined,
} = {}) {
  await pool.query("INSERT INTO clientes(telefono,negocio_id,nombre) VALUES($1,$2,'Cliente de prueba') ON CONFLICT (telefono) DO NOTHING",
    [telefono, negocioId]);
  if (takeover) await pool.query("UPDATE clientes SET human_takeover_until=now()+interval '30 minutes' WHERE telefono=$1", [telefono]);
  await pool.query(`INSERT INTO whatsapp_conversaciones(negocio_id,telefono,requiere_revision,motivo,actualizado_at)
    VALUES($1,$2,$3,$4,${hace(horas)})`, [negocioId, telefono, revision, revision ? motivo : null]);
  if (pausa) {
    await pool.query(`INSERT INTO conversaciones_control(negocio_id,telefono,bot_pausado,updated_by,updated_at)
      VALUES($1,$2,true,$3,${hace(horas)})`, [negocioId, telefono, updatedBy]);
  }
  await pool.query(`INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado,recibido_at)
    VALUES($1,$2,$3,$4,$5,${hace(cliente)})`, [negocioId, telefono, `wamid.local.${randomUUID()}`,
    JSON.stringify({ message: { type: 'text', text: { body: 'hola' } } }), revision ? 'revision' : 'completado']);
  await pool.query(`INSERT INTO mensajes(telefono,nombre,direccion,texto,negocio_id,origen,"timestamp")
    VALUES($1,'Cliente de prueba','entrante','hola',$2,'cliente',${hace(cliente)})`, [telefono, negocioId]);
  const estado = agente || estadoNuevo({ negocioId, conversacionId: `agente:${telefono}` });
  await pool.query('INSERT INTO conversacion_estado(negocio_id,session_id,estado,revision) VALUES($1,$2,$3,1)',
    [negocioId, `agente:${telefono}`, JSON.stringify(estado)]);
  await pool.query("INSERT INTO conversacion_estado(negocio_id,session_id,estado,revision) VALUES($1,$2,'{}'::jsonb,1)",
    [negocioId, `meta-${negocioId}-${telefono}`]);
  return telefono;
}
async function foto(negocioId, telefono) {
  const { rows: [r] } = await pool.query(`SELECT
      (SELECT row_to_json(c) FROM (SELECT bot_pausado, updated_by FROM conversaciones_control WHERE negocio_id=$1 AND telefono=$2) c) AS control,
      (SELECT row_to_json(w) FROM (SELECT requiere_revision, motivo, revision FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2) w) AS conv,
      (SELECT json_agg(estado ORDER BY id) FROM whatsapp_entradas WHERE negocio_id=$1 AND telefono=$2) AS entradas,
      (SELECT estado FROM conversacion_estado WHERE negocio_id=$1 AND session_id='agente:'||$2) AS agente,
      EXISTS (SELECT 1 FROM conversacion_estado WHERE negocio_id=$1 AND session_id='meta-'||$1::text||'-'||$2) AS meta`,
  [negocioId, telefono]);
  return r;
}
const intacta = (f, motivo) => {
  assert.equal(f.control.bot_pausado, true, 'la pausa se quitó');
  assert.deepEqual(f.conv, { requiere_revision: true, motivo, revision: 0 });
  assert.equal(f.meta, true, 'se borró la sesión legada');
};
const fueraComoObjeto = (fuera) => Object.fromEntries(fuera.map((x) => [x.razon, x.n]));
const panel = [];
const ADMIN = async (A) => { const u = await usuario(A); return { usuarioId: u, actor: { actorUsuarioId: u } }; };
const aplicar = (A, lista, quien) => aplicarRevisionEnLote(A, lista, { ...quien, broadcast: (telefono) => panel.push({ A, telefono }) });

try {
  await caso('01 vista previa: marca la vieja sin pendientes y explica por qué quedan fuera las demás', async () => {
    const A = await negocio(); const B = await negocio();
    const libre = await conversacion(A, { motivo: 'AGENTE_PIDE_HUMANO' });
    const libre2 = await conversacion(A, { motivo: 'RECEPCION_PEDIDO_ESCRITO' });
    await conversacion(A, { motivo: 'RECEPCION_IMAGEN', cliente: 3 });             // escribió hace 3 h
    await conversacion(A, { motivo: 'PAGO_COMPROBANTE_REVISION' });
    await conversacion(A, { motivo: 'FACTURACION_REVISION_HUMANA' });
    await conversacion(A, { motivo: 'SOLICITUD_EVENTO' });
    await conversacion(A, { motivo: 'RECEPCION_QUEJA' });
    await conversacion(A, { motivo: 'AGENTE_RESPUESTA_INCIERTA' });
    await conversacion(A, { motivo: 'AGENTE_PIDE_HUMANO', updatedBy: await usuario(A) }); // la tomó una persona
    await conversacion(A, { motivo: 'AGENTE_PIDE_HUMANO', takeover: true });
    await conversacion(A, { revision: false });                                      // pausada SIN revisión: no es de este botón
    await conversacion(B, { motivo: 'AGENTE_PIDE_HUMANO' });                          // otro negocio
    const v = await previsualizarRevisionEnLote(A);
    assert.equal(v.total, 10, 'solo cuentan las en revisión de ESTE negocio');
    assert.deepEqual(v.conversaciones.map((x) => x.telefono).sort(), [libre, libre2].sort());
    assert.ok(v.conversaciones.every((x) => typeof x.huella === 'string' && x.huella.length > 10));
    assert.deepEqual(fueraComoObjeto(v.fuera), {
      cliente_reciente: 1, pago_o_incierto: 2, caso_delicado: 3, tomada_por_persona: 1, atendiendo_ahora: 1,
    });
    assert.ok(v.fuera.every((x) => x.etiqueta && x.etiqueta !== x.razon), 'una razón sin etiqueta para el panel');
  });

  await caso('02 aplicar: la misma semántica que «Revisé y atendí», con auditoría y aviso al panel; las de fuera intactas', async () => {
    const A = await negocio(); const quien = await ADMIN(A);
    const t = await conversacion(A, { motivo: 'RECEPCION_TRAS_PERSONAL' });
    const queja = await conversacion(A, { motivo: 'RECEPCION_QUEJA' });
    const v = await previsualizarRevisionEnLote(A);
    const r = await aplicar(A, v.conversaciones, quien);
    assert.deepEqual(r, { marcadas: 1, omitidas: [] });
    const f = await foto(A, t);
    assert.deepEqual(f.control, { bot_pausado: false, updated_by: quien.usuarioId }, 'la pausa no la quitó el admin');
    assert.deepEqual(f.conv, { requiere_revision: false, motivo: null, revision: 1 });
    assert.deepEqual(f.entradas, ['revisado'], 'lo del cliente no se reprocesa: queda revisado');
    assert.equal(f.meta, false, 'la sesión legada debía borrarse');
    assert.equal(f.agente.conversacionId, `agente:${t}:r1`, 'el agente no se reinició con identidad nueva');
    const { rows: aud } = await pool.query(`SELECT actor_usuario_id, accion, estado_anterior, estado_nuevo FROM auditoria_plataforma
      WHERE negocio_id=$1 AND estado_nuevo->>'telefono'=$2`, [A, t]);
    assert.equal(aud.length, 1);
    assert.equal(aud[0].actor_usuario_id, quien.usuarioId); assert.equal(aud[0].accion, 'devolver_conversacion_bot');
    assert.equal(aud[0].estado_nuevo.revision_en_lote, true); assert.equal(aud[0].estado_anterior.motivo, 'RECEPCION_TRAS_PERSONAL');
    assert.deepEqual(panel.filter((p) => p.A === A).map((p) => p.telefono), [t]);
    intacta(await foto(A, queja), 'RECEPCION_QUEJA');
    // Ya no aparece en una segunda vista previa.
    assert.deepEqual((await previsualizarRevisionEnLote(A)).conversaciones, []);
  });

  await caso('03 lo que cambió entre la vista previa y la confirmación no se marca; lo demás sí', async () => {
    const A = await negocio(); const quien = await ADMIN(A);
    const escribe = await conversacion(A); const tomada = await conversacion(A);
    const yaRevisada = await conversacion(A); const normal = await conversacion(A);
    const v = await previsualizarRevisionEnLote(A);
    assert.equal(v.conversaciones.length, 4);
    // El cliente escribe ahora, alguien toma otra y otra se revisa a mano.
    await pool.query(`INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,'{}'::jsonb,'revision')`,
      [A, escribe, `wamid.local.${randomUUID()}`]);
    await pool.query(`UPDATE conversaciones_control SET updated_by=$3, updated_at=now() WHERE negocio_id=$1 AND telefono=$2`, [A, tomada, quien.usuarioId]);
    await pool.query(`UPDATE whatsapp_conversaciones SET requiere_revision=false, motivo=NULL, revision=revision+1 WHERE negocio_id=$1 AND telefono=$2`, [A, yaRevisada]);
    const r = await aplicar(A, v.conversaciones, quien);
    assert.equal(r.marcadas, 1);
    assert.deepEqual(fueraComoObjeto(r.omitidas), { cliente_reciente: 1, cambio: 2 });
    assert.equal((await foto(A, normal)).conv.requiere_revision, false);
    const e = await foto(A, escribe);
    assert.equal(e.conv.requiere_revision, true); assert.deepEqual(e.entradas, ['revision', 'revision'], 'el mensaje nuevo se marcó revisado sin que nadie lo viera');
    assert.equal((await foto(A, tomada)).control.bot_pausado, true, 'se deshizo el «Tomar»');
  });

  await caso('04 dinero en lo que guardó el agente o en un pedido: fuera aunque el motivo de la revisión no hable de dinero', async () => {
    const A = await negocio();
    const incierta = await conversacion(A, { agente: { ...estadoNuevo({ negocioId: A, conversacionId: 'x' }), confirmacionIncierta: true } });
    await pool.query(`UPDATE conversacion_estado SET estado = jsonb_set(estado,'{conversacionId}',to_jsonb('agente:'||$2::text))
      WHERE negocio_id=$1 AND session_id='agente:'||$2`, [A, incierta]);
    const traspaso = await conversacion(A, { agente: { ...estadoNuevo({ negocioId: A, conversacionId: 'x' }), handoff: { motivo: 'dice que ya pagó por transferencia' } } });
    const libro = await conversacion(A);
    await pool.query(`INSERT INTO agente_operaciones(negocio_id,conversacion_id,turno_id,operacion_clave,herramienta,argumentos_hash,estado,created_at)
      VALUES($1,$2,$3,$4,'confirmar_pedido','h','error',${hace(70)})`, [A, `agente:${libro}`, `turno-${randomUUID()}`, `rl-${randomUUID()}`]);
    const espera = await conversacion(A);
    const folio = `XAB-RL${Math.floor(Math.random() * 1e6)}`;
    await pool.query(`INSERT INTO pedidos_activos (folio, datos, estado, negocio_id) VALUES ($1,$2::jsonb,'pendiente_pago',$3)`,
      [folio, JSON.stringify({ id: folio, estado: 'pendiente_pago', canal: 'test', forma_pago: 'enlace', total: 100,
        cliente: { nombre: 'Cliente de prueba', telefono: espera.slice(-10) }, items: [] }), A]);
    try {
      const v = await previsualizarRevisionEnLote(A);
      assert.deepEqual(v.conversaciones, []);
      assert.deepEqual(fueraComoObjeto(v.fuera), { pago_o_incierto: 4 });
    } finally { await pool.query('DELETE FROM pedidos_activos WHERE folio=$1', [folio]); }
  });

  await caso('05 un turno en vuelo (candado tomado) se respeta: esa no se toca', async () => {
    const A = await negocio(); const quien = await ADMIN(A);
    const t = await conversacion(A);
    const v = await previsualizarRevisionEnLote(A);
    const otro = await pool.connect();
    try {
      await otro.query('BEGIN');
      await otro.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [claveDelCandado(A, t)]);
      const r = await aplicar(A, v.conversaciones, quien);
      assert.deepEqual(r.marcadas, 0); assert.deepEqual(fueraComoObjeto(r.omitidas), { atendiendo_ahora: 1 });
    } finally { await otro.query('ROLLBACK'); otro.release(); }
    intacta(await foto(A, t), 'AGENTE_PIDE_HUMANO');
  });

  await caso('06 la lista que llega del panel se valida entera', async () => {
    const ok = { telefono: '5218780000001', huella: 'x|y|z' };
    assert.deepEqual(listaValida([ok]), [ok]);
    for (const [nombre, l] of [['vacía', []], ['no arreglo', 'x'], ['duplicada', [ok, ok]], ['teléfono raro', [{ ...ok, telefono: '87-80' }]],
      ['sin huella', [{ telefono: ok.telefono }]], ['huella enorme', [{ ...ok, huella: 'x'.repeat(401) }]],
      ['demasiadas', Array.from({ length: MAX_POR_LOTE + 1 }, (_, i) => ({ telefono: String(5218780000000 + i), huella: 'h' }))]]) {
      assert.equal(listaValida(l), null, `aceptó una lista ${nombre}`);
    }
    await assert.rejects(leerCandidatas(pool, { revisionEnLote: true }), /SIN_NEGOCIO/, 'sin negocio leería todos los negocios');
  });

  await caso('07 la decisión, guarda por guarda', () => {
    const base = { requiere_revision: true, motivo: 'AGENTE_PIDE_HUMANO', bot_pausado: true, horas_desde_cliente: 72,
      entradas_procesando: 0, motivos_agente: [] };
    assert.deepEqual(decidirRevisionEnLote(base), { marca: true, razon: 'marca' });
    const razon = (cambio) => decidirRevisionEnLote({ ...base, ...cambio }).razon;
    assert.equal(razon({ requiere_revision: false }), 'sin_revision');
    for (const motivo of ['PAGO_COMPROBANTE_REVISION', 'COMPROBANTE_PAGO', 'RECEPCION_QUEJA_PAGO', 'AGENTE_ESTADO_INCIERTO', 'SOBRE_LEGADO_INCOMPLETO'])
      assert.equal(razon({ motivo }), 'pago_o_incierto', motivo);
    for (const motivo of ['FACTURACION_REVISION_HUMANA', 'SOLICITUD_EVENTO', 'CATERING_DATOS_LISTOS', 'RECEPCION_QUEJA', 'RECEPCION_RETRASO'])
      assert.equal(razon({ motivo }), 'caso_delicado', motivo);
    assert.equal(razon({ confirmacion_incierta: true }), 'pago_o_incierto');
    assert.equal(razon({ confirmacion_sin_resultado: true }), 'pago_o_incierto');
    assert.equal(razon({ handoff_motivo: 'quiere un reembolso' }), 'pago_o_incierto');
    assert.equal(razon({ motivos_agente: ['AGENTE_ENLACE_PAGO_FALLO'] }), 'pago_o_incierto');
    assert.equal(razon({ pedido_esperando_pago: true }), 'pago_o_incierto');
    assert.equal(razon({ updated_by: 'u' }), 'tomada_por_persona');
    assert.equal(razon({ ultima_accion: 'tomar_conversacion' }), 'tomada_por_persona');
    assert.equal(razon({ takeover_vigente: true }), 'atendiendo_ahora');
    assert.equal(razon({ entradas_procesando: 1 }), 'atendiendo_ahora');
    assert.equal(razon({ horas_desde_cliente: 23.9 }), 'cliente_reciente');
    assert.equal(razon({ horas_desde_cliente: null }), 'marca', 'sin mensajes del cliente no hay a quién esperar');
  });

  await caso('08 el job de vencimiento lee exactamente lo mismo que antes', () => {
    assert.equal(SQL_CANDIDATAS, sqlCandidatas());
    assert.ok(!SQL_CANDIDATAS.includes('horas_desde_cliente'), 'la columna del lote se coló en el job');
    assert.match(SQL_CANDIDATAS, /WHERE cc\.bot_pausado AND/, 'el job dejó de leer las pausas sin revisión');
    const lote = sqlCandidatas({ revisionEnLote: true });
    assert.match(lote, /WHERE n\.id = \$1::uuid/); assert.ok(!/WHERE cc\.bot_pausado AND/.test(lote));
  });
} finally {
  await pool.end().catch(() => {});
}
console.log(`\n${n} pasadas, ${fallidas} fallidas`);
process.exit(fallidas ? 1 : 0);
