// ─── LAS PAUSAS DEL BOT VENCEN, CONTRA POSTGRES ─────────────────────────────
//
// P3 (3-oct-2026): 63 pausas activas en Obispado que no vencían nunca. Por el
// JOB REAL (vencerPausasWhatsapp) contra una base local: la consulta que mide
// en SQL, el candado `wa:<negocio>:<tel>`, la verificación optimista, la
// semántica de «Revisé y atendí», la bitácora 113, la simulación deduplicada
// y que, liberada la pausa, la continuidad vuelve a procesar al cliente. De
// mentira solo el panel y el WhatsApp al encargado (dobles que anotan).
//
// Cada caso crea SU negocio: los casos no se pisan y CASOS=07 corre uno solo.
// Base local test_botones_*, red solo local. Sin teléfonos reales, mensajes,
// pedidos ni pagos reales.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pool, actualizarConfiguracion, upsertControlConversacion, getBotPausado } from '../src/services/database.js';
import { exigirBaseBotonesLocal } from './lib-botones-local.mjs';
import { vencerPausasWhatsapp, leerCandidatas, claveDelCandado } from '../src/services/vencimientoPausasWhatsapp.js';
import { decidirVencimiento, opcionesDeConfiguracion } from '../src/services/pausaVencePolitica.js';
import { crearContinuidad } from '../src/services/whatsappContinuidad.js';
import { obtenerEstadoAtencionConversacion } from '../src/services/estadoAtencionConversacion.js';
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';

exigirBaseBotonesLocal();
const ADMIN_LOCAL = '520000000001'; // número de prueba: el envío es un doble
const telefonoFalso = () => `52000${Math.floor(Math.random() * 1e7).toString().padStart(7, '0')}`;

let n = 0; let fallidas = 0;
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function caso(nombre, fn) {
  if (SOLO.length && !SOLO.includes(nombre.split(' ')[0])) return;
  try { await fn(); console.log(`OK pausa-vence-db ${++n}: ${nombre}`); }
  catch (e) {
    fallidas++;
    const detalle = e?.code === 'ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 160)} · esperado=${JSON.stringify(e.expected)?.slice(0, 80)}` : '';
    console.log(`FALLA pausa-vence-db: ${nombre}\n  ${String(e?.message || e).split('\n')[0]}${detalle}`);
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────
async function negocio(cfg = { whatsapp_pausa_vence_horas: '12' }, { bot = true } = {}) {
  const { rows: [r] } = await pool.query('INSERT INTO negocios(nombre,slug,bot_whatsapp_activo) VALUES($1,$2,$3) RETURNING id',
    ['Pausas que vencen', `pausa-vence-${randomUUID()}`, bot]);
  await actualizarConfiguracion({ wa_admin_numero: ADMIN_LOCAL, ...cfg }, r.id);
  return r.id;
}
async function usuario(negocioId) {
  const { rows: [u] } = await pool.query(
    'INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,$4) RETURNING id',
    [negocioId, 'Persona del equipo', `pausa-vence-${randomUUID()}@test.local`, 'x']);
  return u.id;
}
const hace = (h) => `now() - make_interval(secs => ${Number(h) * 3600})`;

/**
 * Una conversación pausada. `horas` = hace cuánto empezó la pausa/revisión.
 * entradas: [{estado, h}] · mensajes: [{dir:'entrante'|'saliente', origen, h}]
 */
async function conversacion(negocioId, {
  telefono = telefonoFalso(), pausa = true, updatedBy = null, motivo = 'AGENTE_RESPUESTA_NO_ENTREGADA', revision = true,
  horas = 30, entradas = [], mensajes = [], agente = undefined, takeover = false, conCliente = true,
} = {}) {
  if (conCliente) {
    await pool.query("INSERT INTO clientes(telefono,negocio_id,nombre) VALUES($1,$2,'Cliente de prueba') ON CONFLICT (telefono) DO NOTHING",
      [telefono, negocioId]);
  }
  if (takeover) await pool.query("UPDATE clientes SET human_takeover_until=now()+interval '30 minutes' WHERE telefono=$1", [telefono]);
  await pool.query(`INSERT INTO whatsapp_conversaciones(negocio_id,telefono,requiere_revision,motivo,actualizado_at)
    VALUES($1,$2,$3,$4,${hace(horas)})`, [negocioId, telefono, revision, revision ? motivo : null]);
  if (pausa) {
    await pool.query(`INSERT INTO conversaciones_control(negocio_id,telefono,bot_pausado,updated_by,updated_at)
      VALUES($1,$2,true,$3,${hace(horas)})`, [negocioId, telefono, updatedBy]);
  }
  for (const e of entradas) {
    await pool.query(`INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado,recibido_at)
      VALUES($1,$2,$3,$4,$5,${hace(e.h)})`, [negocioId, telefono, `wamid.local.${randomUUID()}`,
      JSON.stringify({ message: { type: 'text', text: { body: 'hola' } } }), e.estado]);
  }
  for (const m of mensajes) {
    await pool.query(`INSERT INTO mensajes(telefono,nombre,direccion,texto,negocio_id,origen,"timestamp")
      VALUES($1,$2,$3,$4,$5,$6,${hace(m.h)})`, [telefono, m.dir === 'entrante' ? 'Cliente de prueba' : null, m.dir,
      m.texto || (m.dir === 'entrante' ? 'gracias' : 'Te paso con alguien del equipo'), negocioId,
      m.origen || (m.dir === 'entrante' ? 'cliente' : 'bot')]);
  }
  // El estado del agente y la sesión legada, para ver qué hace con ellos.
  if (agente !== null) {
    const estado = agente || estadoNuevo({ negocioId, conversacionId: `agente:${telefono}` });
    await pool.query('INSERT INTO conversacion_estado(negocio_id,session_id,estado,revision) VALUES($1,$2,$3,1)',
      [negocioId, `agente:${telefono}`, JSON.stringify(estado)]);
  }
  await pool.query("INSERT INTO conversacion_estado(negocio_id,session_id,estado,revision) VALUES($1,$2,'{}'::jsonb,1)",
    [negocioId, `meta-${negocioId}-${telefono}`]);
  return telefono;
}
async function tomar(negocioId, telefono, usuarioId, h = 30) {
  await pool.query(`INSERT INTO auditoria_plataforma(actor_usuario_id,accion,negocio_id,estado_anterior,estado_nuevo,created_at)
    VALUES($1,'tomar_conversacion',$2,$3,$4,${hace(h)})`, [usuarioId, negocioId,
    JSON.stringify({ telefono, bot_pausado: false }), JSON.stringify({ telefono, bot_pausado: true })]);
}
async function foto(negocioId, telefono) {
  const { rows: [r] } = await pool.query(`SELECT
      (SELECT row_to_json(c) FROM (SELECT bot_pausado, updated_by FROM conversaciones_control WHERE negocio_id=$1 AND telefono=$2) c) AS control,
      (SELECT row_to_json(w) FROM (SELECT requiere_revision, motivo, revision FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2) w) AS conv,
      (SELECT json_agg(estado ORDER BY id) FROM whatsapp_entradas WHERE negocio_id=$1 AND telefono=$2) AS entradas,
      (SELECT estado FROM conversacion_estado WHERE negocio_id=$1 AND session_id='agente:'||$2) AS agente,
      EXISTS (SELECT 1 FROM conversacion_estado WHERE negocio_id=$1 AND session_id='meta-'||$1::text||'-'||$2) AS meta,
      (SELECT json_agg(row_to_json(v) ORDER BY v.id) FROM conversaciones_pausa_vencimientos v WHERE negocio_id=$1 AND telefono=$2) AS bitacora`,
  [negocioId, telefono]);
  return r;
}
/** La razón exacta con la que la política decide sobre ESTA conversación. */
async function razon(negocioId, telefono) {
  const [f] = await leerCandidatas(pool, { negocioId, telefono, limite: 1 });
  if (!f) return 'sin_candidata';
  return decidirVencimiento(f, opcionesDeConfiguracion({ whatsapp_pausa_vence_horas: f.cfg_horas,
    whatsapp_pausa_vence_manuales: f.cfg_manuales, whatsapp_pausa_vence_sin_atender: f.cfg_sin_atender })).razon;
}
/**
 * Espera a que `promesa` (otra conexión) se quede esperando un candado de
 * fila o termine. Determinista: la transacción del job sigue abierta mientras
 * tanto, así que si el FOR UPDATE está, la otra conexión SOLO puede bloquearse.
 */
async function bloqueadaOTermino(promesa, { ms = 8000 } = {}) {
  let fin = false;
  promesa.then(() => { fin = true; }, () => { fin = true; });
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (fin) return 'termino';
    const { rows: [r] } = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
    if (r.n > 0) return 'bloqueada';
    await new Promise((res) => setTimeout(res, 25));
  }
  return 'timeout';
}
/** Una operación del libro del agente, tal como la deja `reservar`/`cerrar`. */
async function operacion(negocioId, conversacionId, { herramienta = 'confirmar_pedido', estado = 'error', h = 30 } = {}) {
  await pool.query(`INSERT INTO agente_operaciones(negocio_id,conversacion_id,turno_id,operacion_clave,herramienta,argumentos_hash,estado,created_at)
    VALUES($1,$2,$3,$4,$5,'h',$6,${hace(h)})`, [negocioId, conversacionId, `turno-${randomUUID()}`, `pv-${randomUUID()}`, herramienta, estado]);
}
const panel = []; const whatsapp = []; const logs = [];
const correr = (extra = {}) => vencerPausasWhatsapp({
  broadcastPanel: (negocioId, data) => panel.push({ negocioId, data }),
  enviarAvisoWhatsapp: async (numero, texto, negocioId) => { whatsapp.push({ numero, texto, negocioId }); return true; },
  log: (l) => logs.push(l), ...extra,
});

try {
  // La bitácora de la 113 (idempotente): la misma SQL que aplica el predeploy.
  await pool.query(readFileSync(new URL('../migrations/113_conversaciones_pausa_vencimientos.sql', import.meta.url), 'utf8'));

  await caso('01 revisión automática de 30 h: vuelve al bot con la semántica de «Revisé y atendí»', async () => {
    const A = await negocio();
    const t = await conversacion(A, { entradas: [{ estado: 'revision', h: 30 }, { estado: 'pendiente', h: 26 }],
      mensajes: [{ dir: 'entrante', h: 30 }, { dir: 'saliente', origen: 'bot', h: 30 }, { dir: 'entrante', h: 26 }] });
    const r = await correr({ negocioId: A });
    assert.equal(r.aplicadas, 1);
    const f = await foto(A, t);
    assert.deepEqual(f.control, { bot_pausado: false, updated_by: null });
    assert.deepEqual(f.conv, { requiere_revision: false, motivo: null, revision: 1 });
    assert.deepEqual(f.entradas, ['revisado', 'revisado'], 'lo pendiente no se reprocesa: queda revisado');
    assert.equal(f.meta, false, 'la sesión legada debía borrarse');
    assert.equal(f.agente.conversacionId, `agente:${t}:r1`, 'el agente no se reinició con identidad nueva');
    assert.equal(f.bitacora.length, 1);
    const b = f.bitacora[0];
    assert.equal(b.modo, 'aplicado'); assert.equal(b.origen_pausa, 'automatica'); assert.equal(b.motivo_revision, 'AGENTE_RESPUESTA_NO_ENTREGADA');
    assert.equal(b.requeria_revision, true); assert.equal(Number(b.revision_nueva), 1); assert.equal(Number(b.horas_configuradas), 12);
    assert.ok(Number(b.horas_sin_personal) >= 29.9); assert.equal(b.atendida_por_humano, false);
    const ws = panel.filter((p) => p.negocioId === A);
    assert.deepEqual(ws.map((p) => p.data), [{ tipo: 'bot_pausado', telefono: t, pausado: false, requiereRevision: false, motivo: null }]);
    // El dueño revisa al entrar al sistema: sin su bandera NO sale WhatsApp
    // al encargado (aunque haya número) y la bitácora lo dice.
    assert.equal(whatsapp.filter((w) => w.negocioId === A).length, 0, 'salió un WhatsApp sin whatsapp_pausa_vence_aviso_whatsapp');
    assert.equal(b.aviso, 'no_aplica');
  });

  await caso('02 la misma pausa en un negocio SIN la bandera queda intacta (corrida global)', async () => {
    const A = await negocio(); const B = await negocio({});
    const t = telefonoFalso();
    await conversacion(A, { telefono: t, mensajes: [{ dir: 'entrante', h: 30 }] });
    await conversacion(B, { telefono: t, conCliente: false, mensajes: [{ dir: 'entrante', h: 30 }] });
    const antesB = await foto(B, t);
    await correr();
    assert.equal((await foto(A, t)).control.bot_pausado, false, 'A con bandera debía liberarse');
    assert.deepEqual(await foto(B, t), antesB, 'B sin bandera cambió');
  });

  await caso('03 petición de persona: el recibo del bot no la «atiende»; un mensaje del equipo sí', async () => {
    const A = await negocio();
    const sinAtender = await conversacion(A, { motivo: 'AGENTE_PIDE_HUMANO', entradas: [{ estado: 'pendiente', h: 29 }],
      mensajes: [{ dir: 'entrante', h: 30 }, { dir: 'saliente', origen: 'bot', h: 30 }, { dir: 'entrante', h: 29 }] });
    const atendida = await conversacion(A, { motivo: 'AGENTE_PIDE_HUMANO', entradas: [{ estado: 'pendiente', h: 29 }],
      mensajes: [{ dir: 'entrante', h: 30 }, { dir: 'saliente', origen: 'bot', h: 30 }, { dir: 'entrante', h: 29 },
        { dir: 'saliente', origen: 'humano', h: 20 }] });
    assert.equal(await razon(A, sinAtender), 'peticion_sin_atender');
    await correr({ negocioId: A });
    assert.equal((await foto(A, sinAtender)).control.bot_pausado, true, 'una petición nunca contestada se liberó');
    const f = await foto(A, atendida);
    assert.equal(f.control.bot_pausado, false); assert.equal(f.bitacora[0].atendida_por_humano, true);
    // Con la bandera explícita, también la nunca atendida.
    await actualizarConfiguracion({ whatsapp_pausa_vence_sin_atender: 'true' }, A);
    await correr({ negocioId: A });
    assert.equal((await foto(A, sinAtender)).control.bot_pausado, false);
  });

  await caso('04 cliente esperando: se compara con el último mensaje HUMANO, no con el recibo del bot', async () => {
    const A = await negocio();
    const t = await conversacion(A, { horas: 13, entradas: [{ estado: 'revision', h: 13 }],
      mensajes: [{ dir: 'entrante', h: 13 }, { dir: 'saliente', origen: 'bot', h: 12.9 }] });
    assert.equal(await razon(A, t), 'cliente_esperando');
    await correr({ negocioId: A });
    assert.equal((await foto(A, t)).control.bot_pausado, true);
  });

  await caso('05 un mensaje del equipo hace 2 h reinicia el plazo', async () => {
    const A = await negocio();
    const t = await conversacion(A, { mensajes: [{ dir: 'entrante', h: 30 }, { dir: 'saliente', origen: 'humano', h: 2 }] });
    assert.equal(await razon(A, t), 'reciente');
    await correr({ negocioId: A });
    assert.equal((await foto(A, t)).control.bot_pausado, true);
  });

  await caso('06 pausa manual: no vence con la bandera apagada; con «true» sí, y se atribuye a quien la puso', async () => {
    const A = await negocio(); const u = await usuario(A);
    const t = await conversacion(A, { revision: false, updatedBy: u, mensajes: [{ dir: 'entrante', h: 31 }, { dir: 'saliente', origen: 'humano', h: 30 }] });
    await tomar(A, t, u);
    assert.equal(await razon(A, t), 'manual_excluida');
    await correr({ negocioId: A });
    assert.equal((await foto(A, t)).control.bot_pausado, true);
    await actualizarConfiguracion({ whatsapp_pausa_vence_manuales: 'true' }, A);
    await correr({ negocioId: A });
    const f = await foto(A, t);
    assert.deepEqual(f.control, { bot_pausado: false, updated_by: null });
    assert.equal(f.bitacora[0].origen_pausa, 'manual'); assert.equal(f.bitacora[0].pausado_por, u);
    assert.equal(f.bitacora[0].requeria_revision, false); assert.equal(f.bitacora[0].revision_nueva, null);
    assert.equal(f.agente.conversacionId, `agente:${t}`, 'sin revisión no se reinicia el agente (igual que el botón)');
  });

  await caso('07 pausa manual que el bot sobrescribió con NULL sigue siendo manual (auditoría)', async () => {
    const A = await negocio(); const u = await usuario(A);
    const t = await conversacion(A, { motivo: 'SOLICITUD_CLIENTE', mensajes: [{ dir: 'entrante', h: 31 }, { dir: 'saliente', origen: 'humano', h: 29 }] });
    await tomar(A, t, u, 31);
    assert.equal(await razon(A, t), 'manual_excluida');
    await correr({ negocioId: A });
    assert.equal((await foto(A, t)).control.bot_pausado, true);
  });

  await caso('08 pausa sin rastro (relleno de la 066) se trata como manual', async () => {
    const A = await negocio();
    const t = await conversacion(A, { revision: false, mensajes: [{ dir: 'entrante', h: 40 }] });
    assert.equal(await razon(A, t), 'manual_excluida');
    await correr({ negocioId: A });
    assert.equal((await foto(A, t)).control.bot_pausado, true);
  });

  await caso('09 efecto incierto en la revisión: nunca vence, ni con todas las banderas', async () => {
    const A = await negocio({ whatsapp_pausa_vence_horas: '12', whatsapp_pausa_vence_manuales: 'true', whatsapp_pausa_vence_sin_atender: 'true' });
    const t = await conversacion(A, { motivo: 'AGENTE_ESTADO_INCIERTO', mensajes: [{ dir: 'entrante', h: 30 }] });
    assert.equal(await razon(A, t), 'motivo_no_vence');
    await correr({ negocioId: A });
    assert.equal((await foto(A, t)).control.bot_pausado, true);
  });

  await caso('10 confirmación incierta en el agente: no vence y el estado del agente queda intacto', async () => {
    const A = await negocio({ whatsapp_pausa_vence_horas: '12', whatsapp_pausa_vence_sin_atender: 'true' });
    const agente = estadoNuevo({ negocioId: A, conversacionId: 'agente:x' });
    agente.confirmacionIncierta = true;
    const t = await conversacion(A, { motivo: 'AGENTE_PIDE_HUMANO', agente,
      mensajes: [{ dir: 'entrante', h: 30 }, { dir: 'saliente', origen: 'humano', h: 20 }] });
    const antes = (await foto(A, t)).agente;
    // Primero el efecto (dos barreras: la política y la guarda dentro de la
    // transacción) y al final la razón (solo la política).
    await correr({ negocioId: A });
    const f = await foto(A, t);
    assert.equal(f.control.bot_pausado, true, 'se liberó una conversación con confirmación incierta');
    assert.deepEqual(f.agente, antes, 'se reinició el agente con una confirmación incierta');
    assert.equal(await razon(A, t), 'confirmacion_incierta');
  });

  await caso('11 el agente anotó un enlace de pago fallido después del primer motivo: no vence', async () => {
    const A = await negocio();
    const t = await conversacion(A, { motivo: 'AGENTE_PIDE_HUMANO',
      mensajes: [{ dir: 'entrante', h: 30 }, { dir: 'saliente', origen: 'humano', h: 20 }] });
    await pool.query(`INSERT INTO agente_outbox(negocio_id,evento_clave,tipo,carga,conversacion_id,created_at)
      VALUES($1,$2,'handoff',$3,$4,${hace(29.9)})`, [A, `pv-${randomUUID()}`,
      JSON.stringify({ motivo: 'AGENTE_ENLACE_PAGO_FALLO' }), `agente:${t}`]);
    // El traspaso del modelo en texto libre habla de un pago.
    const agente = estadoNuevo({ negocioId: A, conversacionId: 'agente:x' });
    agente.handoff = { motivo: 'El cliente dice que ya pagó y no le llegó confirmación', en: new Date().toISOString() };
    const t2 = await conversacion(A, { motivo: 'AGENTE_PIDE_HUMANO', agente,
      mensajes: [{ dir: 'entrante', h: 30 }, { dir: 'saliente', origen: 'humano', h: 20 }] });
    assert.equal(await razon(A, t), 'agente_marco_dinero_o_incierto');
    assert.equal(await razon(A, t2), 'traspaso_de_dinero_o_incierto');
    await correr({ negocioId: A });
    assert.equal((await foto(A, t)).control.bot_pausado, true);
    assert.equal((await foto(A, t2)).control.bot_pausado, true);
  });

  await caso('12 un pedido de ese cliente espera el pago con enlace: no vence', async () => {
    const A = await negocio();
    const t = await conversacion(A, { mensajes: [{ dir: 'entrante', h: 30 }] });
    const folio = `PV${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 1e4)}`;
    await pool.query(`INSERT INTO pedidos_activos (folio, datos, estado, negocio_id) VALUES ($1,$2::jsonb,'pendiente_pago',$3)`,
      [folio, JSON.stringify({ id: folio, estado: 'pendiente_pago', canal: 'test', forma_pago: 'enlace', total: 100,
        cliente: { nombre: 'Cliente de prueba', telefono: t.slice(-10) }, items: [] }), A]);
    assert.equal(await razon(A, t), 'pedido_esperando_pago');
    await correr({ negocioId: A });
    assert.equal((await foto(A, t)).control.bot_pausado, true);
  });

  await caso('13 takeover vigente y turno en curso: no se toca', async () => {
    const A = await negocio();
    const conTakeover = await conversacion(A, { takeover: true, mensajes: [{ dir: 'entrante', h: 30 }] });
    const enCurso = await conversacion(A, { entradas: [{ estado: 'procesando', h: 30 }], mensajes: [{ dir: 'entrante', h: 30 }] });
    assert.equal(await razon(A, conTakeover), 'takeover_vigente');
    assert.equal(await razon(A, enCurso), 'turno_en_curso');
    await correr({ negocioId: A });
    assert.equal((await foto(A, conTakeover)).control.bot_pausado, true);
    assert.equal((await foto(A, enCurso)).control.bot_pausado, true);
  });

  await caso('14 revisión SIN pausa (setBotPausado falló) también vuelve al bot', async () => {
    const A = await negocio();
    const t = await conversacion(A, { pausa: false, mensajes: [{ dir: 'entrante', h: 30 }] });
    await correr({ negocioId: A });
    const f = await foto(A, t);
    assert.equal(f.control, null); assert.equal(f.conv.requiere_revision, false);
    assert.equal(f.bitacora[0].origen_pausa, 'automatica');
  });

  await caso('15 lo que suelta soltar() no tiene segundo dueño, salvo que el negocio lo apagó', async () => {
    const A = await negocio();
    const t = await conversacion(A, { motivo: 'ESCALADA_MODELO', mensajes: [{ dir: 'entrante', h: 30 }] });
    assert.equal(await razon(A, t), 'la_suelta_continuidad');
    await correr({ negocioId: A });
    assert.equal((await foto(A, t)).control.bot_pausado, true);
    await actualizarConfiguracion({ bot_revision_minutos: '0' }, A);
    await correr({ negocioId: A });
    assert.equal((await foto(A, t)).control.bot_pausado, false);
  });

  await caso('16 simular: una sola fila por pausa aunque corra dos veces, y cero escrituras', async () => {
    const A = await negocio({ whatsapp_pausa_vence_horas: '12', whatsapp_pausa_vence_simular: 'true' });
    const t = await conversacion(A, { entradas: [{ estado: 'revision', h: 30 }], mensajes: [{ dir: 'entrante', h: 30 }] });
    const antes = await foto(A, t);
    const logsAntes = logs.length; const wsAntes = panel.length; const waAntes = whatsapp.length;
    const r1 = await correr({ negocioId: A }); const r2 = await correr({ negocioId: A });
    assert.equal(r1.simuladas, 1); assert.equal(r2.simuladas, 0); assert.equal(r1.aplicadas + r2.aplicadas, 0);
    const f = await foto(A, t);
    assert.equal(f.bitacora.length, 1); assert.equal(f.bitacora[0].modo, 'simulado'); assert.equal(f.bitacora[0].aviso, 'no_aplica');
    const { bitacora: _b, ...resto } = f; const { bitacora: _a, ...restoAntes } = antes;
    assert.deepEqual(resto, restoAntes, 'simular escribió en la conversación');
    assert.equal(panel.length, wsAntes); assert.equal(whatsapp.length, waAntes);
    assert.equal(logs.slice(logsAntes).filter((l) => l.includes('modo=simulado')).length, 1);
    // Al apagar la simulación, la misma pausa sí se aplica (otra fila, otro modo).
    await actualizarConfiguracion({ whatsapp_pausa_vence_simular: 'false' }, A);
    await correr({ negocioId: A });
    assert.deepEqual((await foto(A, t)).bitacora.map((b) => b.modo), ['simulado', 'aplicado']);
  });

  await caso('17 el candado wa:<negocio>:<tel> ocupado (un turno en vuelo) hace esperar a la siguiente corrida', async () => {
    const A = await negocio();
    const t = await conversacion(A, { mensajes: [{ dir: 'entrante', h: 30 }] });
    const otro = await pool.connect();
    try {
      await otro.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [claveDelCandado(A, t)]);
      const r = await correr({ negocioId: A });
      assert.equal(r.retenidas.candado_ocupado, 1);
      assert.equal((await foto(A, t)).control.bot_pausado, true);
      await otro.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [claveDelCandado(A, t)]);
    } finally { otro.release(); }
    await correr({ negocioId: A });
    assert.equal((await foto(A, t)).control.bot_pausado, false);
  });

  await caso('18 «Tomar conversación» entre la lectura y la transacción gana', async () => {
    const A = await negocio(); const u = await usuario(A);
    const t = await conversacion(A, { mensajes: [{ dir: 'entrante', h: 30 }] });
    const r = await correr({ negocioId: A, antesDeAplicar: async (f) => {
      if (f.telefono === t) await upsertControlConversacion(t, true, A, u);
    } });
    assert.equal(r.aplicadas, 0); assert.equal(r.retenidas.la_pausa_cambio, 1);
    const f = await foto(A, t);
    assert.deepEqual(f.control, { bot_pausado: true, updated_by: u });
    assert.equal(f.conv.requiere_revision, true); assert.equal(f.bitacora, null);
  });

  await caso('19 dos instancias a la vez: una sola liberación y un solo registro', async () => {
    const A = await negocio();
    const t = await conversacion(A, { mensajes: [{ dir: 'entrante', h: 30 }] });
    const [r1, r2] = await Promise.all([correr({ negocioId: A }), correr({ negocioId: A })]);
    assert.equal(r1.aplicadas + r2.aplicadas, 1);
    const f = await foto(A, t);
    assert.equal(f.conv.revision, 1); assert.equal(f.bitacora.length, 1);
  });

  await caso('20 liberada la pausa, la continuidad vuelve a procesar al cliente; /estado-bot lo cuenta', async () => {
    const A = await negocio();
    // El «gracias» que el cliente escribió después del traspaso, sin procesar.
    const t = await conversacion(A, { entradas: [{ estado: 'pendiente', h: 29 }],
      mensajes: [{ dir: 'entrante', h: 30 }, { dir: 'entrante', h: 29 }] });
    const procesados = [];
    const continuidad = crearContinuidad({ pool, locks: pool, ventanaMs: 0,
      procesar: async (payloads) => { procesados.push(payloads.length); }, cargarSesion: async () => {}, leerSesion: async () => ({}) });
    await continuidad.ejecutar(A, t);
    assert.equal(procesados.length, 0, 'en revisión la continuidad no debía procesar');
    await correr({ negocioId: A });
    assert.equal(await getBotPausado(t, A), false); assert.equal(await continuidad.revisionActiva(A, t), false);
    // Lo de antes quedó revisado (no se reprocesa); lo nuevo sí llega.
    await continuidad.recibir([{ negocioId: A, telefono: t, wamid: `wamid.local.${randomUUID()}`,
      payload: { message: { type: 'text', text: { body: 'hola de nuevo' } } } }]);
    await continuidad.ejecutar(A, t);
    assert.deepEqual(procesados, [1], 'el mensaje nuevo no llegó al procesador');
    const e = await obtenerEstadoAtencionConversacion(pool, A, t);
    assert.equal(e.pausado, false); assert.equal(e.pausaVence.horas, 12);
    assert.equal(e.ultimoVencimiento?.origen, 'automatica');
  });

  await caso('21 resumen OPCIONAL al encargado: con su bandera, uno por negocio y corrida; sin número o sin envío queda registrado', async () => {
    const conAviso = { whatsapp_pausa_vence_horas: '12', whatsapp_pausa_vence_aviso_whatsapp: 'true' };
    const A = await negocio(conAviso);
    const t1 = await conversacion(A, { mensajes: [{ dir: 'entrante', h: 30 }] });
    const t2 = await conversacion(A, { mensajes: [{ dir: 'entrante', h: 31 }] });
    const waAntes = whatsapp.length;
    await correr({ negocioId: A });
    assert.equal(whatsapp.length - waAntes, 1, 'debía salir UN resumen para dos conversaciones');
    const aviso = whatsapp.at(-1);
    assert.equal(aviso.numero, ADMIN_LOCAL); assert.match(aviso.texto, /2 conversaciones/);
    assert.match(aviso.texto, new RegExp(`\\*\\*\\*${t1.slice(-4)}`)); assert.ok(!aviso.texto.includes(t1), 'el aviso trae el teléfono completo');
    // 'aceptado' = Meta aceptó el envío; no prueba que se entregó.
    assert.equal((await foto(A, t1)).bitacora[0].aviso, 'aceptado'); assert.equal((await foto(A, t2)).bitacora[0].aviso, 'aceptado');
    const B = await negocio({ ...conAviso, wa_admin_numero: '' });
    const t3 = await conversacion(B, { mensajes: [{ dir: 'entrante', h: 30 }] });
    await correr({ negocioId: B });
    assert.equal((await foto(B, t3)).bitacora[0].aviso, 'sin_numero');
    const C = await negocio(conAviso);
    const t4 = await conversacion(C, { mensajes: [{ dir: 'entrante', h: 30 }] });
    await correr({ negocioId: C, enviarAvisoWhatsapp: async () => false });
    assert.equal((await foto(C, t4)).bitacora[0].aviso, 'fallido');
  });

  await caso('22 interruptor maestro del negocio apagado: no se libera', async () => {
    const A = await negocio(undefined, { bot: false });
    const t = await conversacion(A, { mensajes: [{ dir: 'entrante', h: 30 }] });
    assert.equal(await razon(A, t), 'bot_del_negocio_apagado');
    await correr({ negocioId: A });
    assert.equal((await foto(A, t)).control.bot_pausado, true);
  });

  // Las dos barreras de la transacción, cada una con un caso que SOLO ella
  // detiene: la huella (la pausa ya es otra) y la nueva decisión con datos
  // frescos (llegó un mensaje del equipo, que no cambia la huella).
  await caso('23 la revisión cambió de número entre la lectura y la transacción: no se aplica sobre la lectura vieja', async () => {
    const A = await negocio();
    const t = await conversacion(A, { mensajes: [{ dir: 'entrante', h: 30 }] });
    const r = await correr({ negocioId: A, antesDeAplicar: async (f) => {
      if (f.telefono === t) await pool.query('UPDATE whatsapp_conversaciones SET revision=revision+5 WHERE negocio_id=$1 AND telefono=$2', [A, t]);
    } });
    assert.equal(r.aplicadas, 0); assert.equal(r.retenidas.la_pausa_cambio, 1);
    assert.equal((await foto(A, t)).control.bot_pausado, true);
  });

  await caso('24 un mensaje del equipo entre la lectura y la transacción: se vuelve a decidir con datos frescos', async () => {
    const A = await negocio();
    const t = await conversacion(A, { mensajes: [{ dir: 'entrante', h: 30 }] });
    const r = await correr({ negocioId: A, antesDeAplicar: async (f) => {
      if (f.telefono === t) await pool.query(`INSERT INTO mensajes(telefono,direccion,texto,negocio_id,origen)
        VALUES($1,'saliente','Ya te atiendo',$2,'humano')`, [t, A]);
    } });
    assert.equal(r.aplicadas, 0); assert.equal(r.retenidas.reciente, 1);
    assert.equal((await foto(A, t)).control.bot_pausado, true);
  });

  // ── Revisión del 3-oct ────────────────────────────────────────────────

  await caso('25 rescate y turno que reventó son peticiones: sin respuesta del equipo no vencen; con ella, sí', async () => {
    const A = await negocio();
    for (const motivo of ['FORMULARIO_NO_CARGA', 'AGENTE_FALLO_REPETIDO', 'AGENTE_NO_PUDO_ATENDER']) {
      const sinAtender = await conversacion(A, { motivo, mensajes: [{ dir: 'entrante', h: 30 }, { dir: 'saliente', origen: 'bot', h: 30 }] });
      const atendida = await conversacion(A, { motivo, mensajes: [{ dir: 'entrante', h: 30 }, { dir: 'saliente', origen: 'humano', h: 20 }] });
      assert.equal(await razon(A, sinAtender), 'peticion_sin_atender', motivo);
      await correr({ negocioId: A });
      assert.equal((await foto(A, sinAtender)).control.bot_pausado, true, `${motivo} sin respuesta del equipo se liberó`);
      assert.equal((await foto(A, atendida)).control.bot_pausado, false, `${motivo} atendida no se liberó`);
    }
  });

  await caso('26 confirmar_pedido sin resultado en el libro: no vence aunque el estado del turno se perdiera', async () => {
    // Todas las banderas que podrían soltarla, y una persona que sí escribió:
    // lo ÚNICO que la retiene es la operación del libro.
    const A = await negocio({ whatsapp_pausa_vence_horas: '12', whatsapp_pausa_vence_sin_atender: 'true' });
    const atendida = { motivo: 'AGENTE_NO_PUDO_ATENDER', mensajes: [{ dir: 'entrante', h: 30 }, { dir: 'saliente', origen: 'humano', h: 20 }] };
    // a) 'error' en el ciclo vigente (`agente:<tel>`), a la hora del turno que reventó.
    const a = await conversacion(A, atendida);
    await operacion(A, `agente:${a}`, { estado: 'error', h: 30 });
    // b) 'pendiente' en otro ciclo del mismo teléfono, dentro del margen de la pausa.
    const b = await conversacion(A, atendida);
    await operacion(A, `agente:${b}:c3`, { estado: 'pendiente', h: 30.2 });
    // c) 'pendiente' viejo pero en el ciclo VIGENTE del agente: su índice único sigue bloqueando ese ciclo.
    const c = telefonoFalso();
    await conversacion(A, { telefono: c, ...atendida, agente: estadoNuevo({ negocioId: A, conversacionId: `agente:${c}:c2` }) });
    await operacion(A, `agente:${c}:c2`, { estado: 'pendiente', h: 200 });
    // d) Lo que NO retiene: un 'error' de un ciclo anterior ya revisado (otro
    //    id, antes de esta pausa), una confirmación 'ok' o 'rechazada', y otra herramienta.
    const d = telefonoFalso();
    await conversacion(A, { telefono: d, ...atendida, agente: estadoNuevo({ negocioId: A, conversacionId: `agente:${d}:r2` }) });
    await operacion(A, `agente:${d}:r1`, { estado: 'error', h: 100 });
    await operacion(A, `agente:${d}:r2:c1`, { estado: 'ok', h: 30 });
    await operacion(A, `agente:${d}:r2:c2`, { estado: 'rechazada', h: 30 });
    await operacion(A, `agente:${d}:r2`, { herramienta: 'pedir_humano', estado: 'error', h: 30 });
    // e) Otro teléfono que empieza igual no cuenta (prefijo con «:»).
    const e = await conversacion(A, atendida);
    await operacion(A, `agente:${e}9`, { estado: 'error', h: 30 });
    const agentes = {};
    for (const t of [a, b, c]) agentes[t] = (await foto(A, t)).agente;
    for (const t of [a, b, c]) assert.equal(await razon(A, t), 'confirmacion_sin_resultado', t);
    await correr({ negocioId: A });
    for (const t of [a, b, c]) {
      const f = await foto(A, t);
      assert.equal(f.control.bot_pausado, true, `se liberó con una confirmar_pedido sin resultado (${t})`);
      assert.deepEqual(f.agente, agentes[t], 'se reinició el agente con una confirmación sin resultado');
    }
    assert.equal((await foto(A, d)).control.bot_pausado, false, 'lo ya revisado o con resultado no debía retener');
    assert.equal((await foto(A, e)).control.bot_pausado, false, 'la operación de otro teléfono retuvo esta');
  });

  await caso('27 un mensaje que llega con la transacción abierta espera a que termine y NO queda revisado', async () => {
    const A = await negocio();
    const t = await conversacion(A, { entradas: [{ estado: 'revision', h: 30 }], mensajes: [{ dir: 'entrante', h: 30 }] });
    const continuidad = crearContinuidad({ pool, locks: pool, ventanaMs: 0,
      procesar: async () => {}, cargarSesion: async () => {}, leerSesion: async () => ({}) });
    const wamid = `wamid.local.${randomUUID()}`;
    let recepcion = null; let observado = null;
    const r = await correr({ negocioId: A, dentroDeLaTransaccion: async (f) => {
      if (f.telefono !== t) return;
      recepcion = continuidad.recibir([{ negocioId: A, telefono: t, wamid,
        payload: { message: { type: 'text', text: { body: 'sigo esperando' } } } }]);
      observado = await bloqueadaOTermino(recepcion);
    } });
    await recepcion;
    assert.equal(observado, 'bloqueada', 'recibir no esperó: falta el FOR UPDATE de whatsapp_conversaciones');
    assert.equal(r.aplicadas, 1);
    const { rows: [nueva] } = await pool.query('SELECT estado FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=$2', [A, wamid]);
    assert.equal(nueva.estado, 'pendiente', 'el mensaje nuevo quedó revisado sin que nadie lo viera');
    assert.deepEqual((await foto(A, t)).entradas, ['revisado', 'pendiente']);
  });

  await caso('28 «Tomar conversación» con la transacción abierta espera y gana después', async () => {
    const A = await negocio(); const u = await usuario(A);
    const t = await conversacion(A, { mensajes: [{ dir: 'entrante', h: 30 }] });
    let toma = null; let observado = null;
    const r = await correr({ negocioId: A, dentroDeLaTransaccion: async (f) => {
      if (f.telefono !== t) return;
      toma = upsertControlConversacion(t, true, A, u);
      observado = await bloqueadaOTermino(toma);
    } });
    await toma;
    assert.equal(observado, 'bloqueada', '«Tomar» no esperó: falta el FOR UPDATE de conversaciones_control');
    assert.equal(r.aplicadas, 1);
    assert.deepEqual((await foto(A, t)).control, { bot_pausado: true, updated_by: u }, 'el job pisó la toma');
  });

  await caso('29 revisión sin pausa: «Tomar» que crea la fila con la transacción abierta gana (UPDATE condicionado)', async () => {
    const A = await negocio(); const u = await usuario(A);
    const t = await conversacion(A, { pausa: false, mensajes: [{ dir: 'entrante', h: 30 }] });
    const r = await correr({ negocioId: A, dentroDeLaTransaccion: async (f) => {
      if (f.telefono === t) await upsertControlConversacion(t, true, A, u);
    } });
    assert.equal(r.aplicadas, 0); assert.equal(r.retenidas.la_pausa_cambio, 1);
    const f = await foto(A, t);
    assert.deepEqual(f.control, { bot_pausado: true, updated_by: u }, 'el job pisó la pausa recién puesta');
    assert.equal(f.conv.requiere_revision, true); assert.equal(f.bitacora, null);
  });

  // Ramas de fallo cerrado del SQL que ningún caso ejercitaba.
  const atendida = (extra = {}) => ({ motivo: 'AGENTE_PIDE_HUMANO',
    mensajes: [{ dir: 'entrante', h: 30 }, { dir: 'saliente', origen: 'humano', h: 20 }], ...extra });

  await caso('30 outbox: un paso a persona de dinero en una fila que no es de tipo handoff (humano_motivo)', async () => {
    const A = await negocio();
    const t = await conversacion(A, atendida());
    await pool.query(`INSERT INTO agente_outbox(negocio_id,evento_clave,tipo,carga,conversacion_id,humano_motivo,humano_solicitado_at,created_at)
      VALUES($1,$2,'respuesta_cliente','{}'::jsonb,$3,'AGENTE_ENLACE_PAGO_FALLO',${hace(29.9)},${hace(29.9)})`,
    [A, `pv-${randomUUID()}`, `agente:${t}`]);
    assert.equal(await razon(A, t), 'agente_marco_dinero_o_incierto');
    await correr({ negocioId: A });
    assert.equal((await foto(A, t)).control.bot_pausado, true);
  });

  await caso('31 traza del turno: motivo_handoff de efecto incierto en otro ciclo del mismo teléfono', async () => {
    const A = await negocio();
    const t = await conversacion(A, atendida());
    await pool.query(`INSERT INTO agente_turnos(negocio_id,conversacion_id,turno_clave,motivo_handoff,created_at)
      VALUES($1,$2,$3,'AGENTE_CONFIRMACION_INCIERTA',${hace(29.95)})`, [A, `agente:${t}:c2`, `pv-${randomUUID()}`]);
    assert.equal(await razon(A, t), 'agente_marco_dinero_o_incierto');
    await correr({ negocioId: A });
    assert.equal((await foto(A, t)).control.bot_pausado, true);
  });

  await caso('32 pedido esperando el pago que solo trae telefono_conversacion', async () => {
    const A = await negocio();
    const t = await conversacion(A, atendida());
    const folio = `PW${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 1e4)}`;
    await pool.query(`INSERT INTO pedidos_activos (folio, datos, estado, negocio_id) VALUES ($1,$2::jsonb,'pendiente_pago',$3)`,
      [folio, JSON.stringify({ id: folio, estado: 'pendiente_pago', canal: 'test', forma_pago: 'enlace', total: 100,
        telefono_conversacion: t, cliente: { nombre: 'Cliente de prueba', telefono: '—' }, items: [] }), A]);
    assert.equal(await razon(A, t), 'pedido_esperando_pago');
  });

  await caso('33 un audio (solo en whatsapp_entradas, no en mensajes) dentro de la ventana: el cliente espera', async () => {
    const A = await negocio();
    const t = await conversacion(A, atendida());
    await pool.query(`INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado,recibido_at)
      VALUES($1,$2,$3,$4,'pendiente',${hace(2)})`, [A, t, `wamid.local.${randomUUID()}`,
      JSON.stringify({ message: { type: 'audio', audio: { id: 'local' } } })]);
    assert.equal(await razon(A, t), 'cliente_esperando');
    await correr({ negocioId: A });
    assert.equal((await foto(A, t)).control.bot_pausado, true);
  });

  await caso('34 un eco de la Business App hace 2 h reinicia el plazo (last_business_app_message_at)', async () => {
    const A = await negocio();
    const t = await conversacion(A, { mensajes: [{ dir: 'entrante', h: 30 }] });
    await pool.query(`UPDATE clientes SET last_business_app_message_at = ${hace(2)} WHERE telefono=$1`, [t]);
    assert.equal(await razon(A, t), 'reciente');
    await correr({ negocioId: A });
    assert.equal((await foto(A, t)).control.bot_pausado, true);
  });

  await caso('35 una reserva programada esperando el pago con enlace: no vence', async () => {
    const A = await negocio();
    const t = await conversacion(A, atendida());
    const folio = `PP${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 1e4)}`;
    await pool.query(`INSERT INTO pedidos_programados (folio, datos, programado_para, activado, negocio_id)
      VALUES ($1,$2::jsonb, now() + interval '2 days', false, $3)`,
    [folio, JSON.stringify({ id: folio, estado: 'pendiente_pago', canal: 'test', forma_pago: 'enlace', total: 100,
      cliente: { nombre: 'Cliente de prueba', telefono: t.slice(-10) }, items: [] }), A]);
    // Una reserva ya pagada (estado nuevo) o cerrada (activado) no retiene.
    const t2 = await conversacion(A, atendida());
    const folio2 = `PQ${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 1e4)}`;
    await pool.query(`INSERT INTO pedidos_programados (folio, datos, programado_para, activado, negocio_id)
      VALUES ($1,$2::jsonb, now() + interval '2 days', true, $3)`,
    [folio2, JSON.stringify({ id: folio2, estado: 'pendiente_pago', cliente: { telefono: t2.slice(-10) }, items: [] }), A]);
    assert.equal(await razon(A, t), 'pedido_esperando_pago');
    await correr({ negocioId: A });
    assert.equal((await foto(A, t)).control.bot_pausado, true);
    assert.equal((await foto(A, t2)).control.bot_pausado, false, 'una reserva cerrada retuvo la pausa');
  });

  // ÚLTIMO: borra y recrea la tabla 113.
  await caso('36 predeploy-113 con tráfico en vivo entre sus dos conteos: no aborta el despliegue', async () => {
    const A = await negocio();
    const t = await conversacion(A, { entradas: [{ estado: 'pendiente', h: 1 }], mensajes: [{ dir: 'entrante', h: 1 }] });
    await pool.query('DROP TABLE IF EXISTS conversaciones_pausa_vencimientos');
    // Retiene el CREATE TABLE … REFERENCES negocios (pide SHARE ROW EXCLUSIVE)
    // DESPUÉS del primer conteo, como un candado ocupado en producción.
    const bloqueo = await pool.connect();
    let hijo;
    try {
      await bloqueo.query('BEGIN');
      await bloqueo.query('LOCK TABLE negocios IN ROW EXCLUSIVE MODE');
      const script = fileURLToPath(new URL('../scripts/predeploy-113-pausa-vencimientos.mjs', import.meta.url));
      hijo = new Promise((resolve) => {
        const p = spawn(process.execPath, [script], { env: process.env });
        let salida = '';
        p.stdout.on('data', (d) => { salida += d; }); p.stderr.on('data', (d) => { salida += d; });
        p.on('close', (codigo) => resolve({ codigo, salida }));
      });
      let esperando = false;
      for (let i = 0; i < 400 && !esperando; i++) {
        // pg_stat_activity trunca la consulta (1 KB): se reconoce por su cabecera.
        const { rows: [r] } = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
            AND query LIKE '-- 113%'`);
        esperando = r.n > 0;
        if (!esperando) await new Promise((res) => setTimeout(res, 25));
      }
      assert.ok(esperando, 'el predeploy no llegó a esperar el candado de negocios');
      // El binario viejo atiende un mensaje mientras tanto: revision+1 y la
      // entrada pasa de pendiente a completado.
      await pool.query('UPDATE whatsapp_conversaciones SET revision=revision+1 WHERE negocio_id=$1 AND telefono=$2', [A, t]);
      await pool.query("UPDATE whatsapp_entradas SET estado='completado' WHERE negocio_id=$1 AND telefono=$2 AND estado='pendiente'", [A, t]);
    } finally {
      await bloqueo.query('COMMIT').catch(() => {});
      bloqueo.release();
    }
    const { codigo, salida } = await hijo;
    assert.equal(codigo, 0, `el predeploy abortó con tráfico en vivo: ${salida.trim().split('\n').at(-1)}`);
    const { rows: [x] } = await pool.query("SELECT to_regclass('public.conversaciones_pausa_vencimientos') IS NOT NULL AS ok");
    assert.equal(x.ok, true);
  });

  console.log(`Pausa vence DB: ${n} pasadas, ${fallidas} fallidas. Sin red externa, mensajes, pedidos o pagos reales.`);
  if (fallidas) process.exitCode = 1;
} finally {
  await pool.end();
}
