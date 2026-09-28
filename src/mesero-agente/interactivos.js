import { randomBytes, randomUUID } from 'node:crypto';
import { enElCanario, esVerdadero } from '../orders/modoDelPedido.js';
import { alcanceDePruebaPermite } from './alcanceDePrueba.js';
import { eleccionesActivas, opcionesInteractivas, asociacionVigente } from './eleccionesInteractivas.js';

export const TOKEN_BOTON = /^xb1:[A-Za-z0-9_-]{22}$/;
const autorizaciones = new WeakMap();
export const interactivosActivos = cfg => esVerdadero(process.env.WHATSAPP_INTERACTIVOS)
  && esVerdadero(cfg?.whatsapp_interactivos_v1);
export const agenteDentro = (cfg, telefono) => esVerdadero(process.env.MESERO_AGENTE_MODE)
  && esVerdadero(cfg?.mesero_agente_v1) && enElCanario(telefono, {
    lista: cfg?.mesero_agente_telefonos, porcentaje: cfg?.mesero_agente_porcentaje }).dentro;

export function leerBoton(message) {
  const tipo = message?.interactive?.type;
  const b = ['button_reply','list_reply'].includes(tipo) ? message.interactive[tipo] : null;
  if (message?.type !== 'interactive'
    || typeof b?.id !== 'string' || !TOKEN_BOTON.test(b.id)
    || ![message.id, message.from, message.context?.id].every(v => typeof v === 'string' && v.length > 0 && v.length <= 512)) return null;
  return { token: b.id, wamid: message.id, telefono: message.from, contexto: message.context.id };
}
export const esInteraccion = m => ['interactive','button'].includes(m?.type);
export const textoInteraccion = m => `▸ ${String(m?.interactive?.button_reply?.title
  || m?.interactive?.list_reply?.title || m?.button?.text || 'Respuesta interactiva').slice(0, 100)}`;

// Capacidad efímera: no serializable ni alcanzable desde argumentos del modelo.
export function autorizarBotonReservado(estado, reserva) {
  if (reserva?.accion === 'confirmar' && reserva?.reservaId && reserva?.ids?.length) {
    autorizaciones.set(estado, { ciclo: estado.conversacionId, dialogo: estado.dialogo?.id, huella: reserva.huella });
  }
}
export function tieneAutorizacionDeBoton(estado, huella) {
  const a = autorizaciones.get(estado);
  return !!a && a.ciclo === estado.conversacionId && a.dialogo === estado.dialogo?.id && a.huella === huella;
}

export function construirBotones({ estado, pedido, texto, cfg, ...contexto }) {
  if (estado.pendiente?.tipo !== 'confirmar_resumen') return construirElecciones({estado,pedido,texto,cfg,...contexto});
  if (!interactivosActivos(cfg) || estado.pendiente?.tipo !== 'confirmar_resumen'
    || estado.pendiente.huella !== pedido.huella || estado.dialogo?.id !== estado.pendiente.dialogo_id
    || estado.dialogo?.tipo !== 'resumen' || estado.dialogo.huella !== pedido.huella
    || estado.dialogo.ciclo !== estado.conversacionId || estado.dialogo.texto !== texto
    || estado.folio || estado.evento || estado.confirmacionIncierta || Object.values(estado.hechos || {}).some(Boolean)
    || pedido.falta?.length || pedido.aclaraciones?.length || !texto || texto.length > 1024) return null;
  const importe = estado.totalMostrado?.huella === pedido.huella ? estado.totalMostrado.total : pedido.total;
  if (typeof importe !== 'number' && (typeof importe !== 'string' || !importe.trim())) return null;
  const total = Number(importe);
  if (!Number.isFinite(total) || total < 0) return null;
  const botones = [['confirmar','Confirmar'],['cambiar_algo','Cambiar algo']].map(([accion,title]) => ({
    token: `xb1:${randomBytes(16).toString('base64url')}`, accion, title }));
  return { preguntaId: randomUUID(), ciclo: estado.conversacionId, dialogoId: estado.dialogo.id,
    huella: pedido.huella, total, botones,
    carga: { type: 'button', body: { text: texto }, action: {
      buttons: botones.map(b => ({ type: 'reply', reply: { id: b.token, title: b.title } })) } } };
}

function construirElecciones({estado,pedido,texto,cfg,...contexto}) {
  if (!interactivosActivos(cfg) || !eleccionesActivas(cfg) || !estado.pendiente
    || estado.dialogo?.id !== estado.pendiente.dialogo_id || estado.dialogo?.texto !== texto
    || estado.dialogo?.ciclo !== estado.conversacionId || estado.folio || estado.evento
    || estado.confirmacionIncierta || Object.values(estado.hechos || {}).some(Boolean)) return null;
  const opciones = opcionesInteractivas({estado,...contexto});
  if (!opciones.length || opciones.length > 10 || !texto || texto.length > 1024) return null;
  const botones = opciones.map(o => ({...o,token:`xb1:${randomBytes(16).toString('base64url')}`}));
  const cortos = opciones.length <= 3 && opciones.every(o => o.title.length <= 20)
    && new Set(opciones.map(o => o.title)).size === opciones.length;
  // Los títulos largos tienen ordinal visible para que nunca colisionen al
  // abreviarlos. El ordinal NO se usa para resolver la respuesta.
  const rows = botones.map((b,i) => ({id:b.token,
    title:b.title.length <= 24 ? b.title : `${i+1}. ${b.title}`.slice(0,24),
    description:b.title.slice(0,72)}));
  if (new Set(rows.map(r => r.title)).size !== rows.length) return null;
  return {preguntaId:randomUUID(),ciclo:estado.conversacionId,dialogoId:estado.dialogo.id,
    huella:pedido.huella,total:pedido.total,botones,
    carga:{type:cortos?'button':'list',body:{text:texto},action:cortos
      ? {buttons:botones.map(b => ({type:'reply',reply:{id:b.token,title:b.title}}))}
      : {button:'Elegir opción',sections:[{title:'Opciones disponibles',rows}]}}};
}

export async function guardarBotones(tx, { preparado, negocioId, sessionId, outboxClave }) {
  if (!preparado) return;
  await tx.query(`INSERT INTO agente_preguntas_interactivas
    (id,negocio_id,session_id,ciclo,dialogo_id,outbox_clave,huella,total_mostrado)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [preparado.preguntaId, negocioId, sessionId,
    preparado.ciclo, preparado.dialogoId, outboxClave, preparado.huella, preparado.total]);
  for (const b of preparado.botones) await tx.query(
    'INSERT INTO agente_botones(token,pregunta_id,accion,datos) VALUES($1,$2,$3,$4)', [b.token, preparado.preguntaId, b.accion,JSON.stringify(b.datos || {})]);
}

// SQL compartido por reserva/envío. No confundir ausencia con bot activo.
export async function barrerasDeBotones(db, negocioId, telefono) {
  const { rows: [r] } = await db.query(`SELECT
    (SELECT bot_whatsapp_activo FROM negocios WHERE id=$1) IS TRUE
    AND EXISTS (SELECT 1 FROM integraciones_canal WHERE negocio_id=$1 AND canal='whatsapp' AND activo IS TRUE)
    AND NOT COALESCE((SELECT bot_pausado FROM conversaciones_control WHERE negocio_id=$1 AND telefono=$2),false)
    AND NOT EXISTS (SELECT 1 FROM clientes WHERE telefono=$2 AND (negocio_id=$1 OR negocio_id IS NULL)
      AND human_takeover_until > now())
    AND NOT COALESCE((SELECT requiere_revision FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2),false) AS activo,
    (SELECT jsonb_object_agg(clave,valor) FROM configuracion WHERE negocio_id=$1) AS cfg`, [negocioId, telefono]);
  return { activo: r?.activo === true && agenteDentro(r?.cfg, telefono)
    && alcanceDePruebaPermite(r?.cfg, telefono), cfg: r?.cfg || {} };
}

// Descartar no ejecuta acciones. Se hace antes de los atajos del texto (menú,
// archivos, repartidor...), incluso cuando estos no llegan al agente. La
// recepción ya es durable y el lock de continuidad serializa el lote entero.
export async function descartarToquesMixtos({ db, negocioId, telefono, mensajes }) {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    if (!(await barrerasDeBotones(tx, negocioId, telefono)).activo) { await tx.query('ROLLBACK'); return; }
    for (const m of mensajes) {
      const t = leerBoton(m);
      if (!t || t.telefono !== telefono) continue;
      await tx.query(`UPDATE agente_preguntas_interactivas q
        SET estado='terminada',terminado_at=now(),comando=$5::jsonb,resultado='{"descartado":"lote_mixto"}'::jsonb
        FROM agente_botones b,agente_outbox o,conversacion_estado s,whatsapp_entradas e
        WHERE b.token=$1 AND b.pregunta_id=q.id AND q.negocio_id=$2 AND q.session_id=$3
        AND q.estado='disponible' AND o.evento_clave=q.outbox_clave
        AND (o.wamid_salida IS NULL OR o.wamid_salida=$4)
        AND s.negocio_id=q.negocio_id AND s.session_id=q.session_id AND s.estado->>'conversacionId'=q.ciclo
        AND e.negocio_id=q.negocio_id AND e.telefono=$6 AND e.wamid=$7`,
      [t.token,negocioId,`agente:${telefono}`,t.contexto,JSON.stringify({accion:'texto',wamid:t.wamid}),telefono,t.wamid]);
    }
    await tx.query('COMMIT');
  } catch (e) { await tx.query('ROLLBACK').catch(()=>{}); throw e; }
  finally { tx.release(); }
}

export async function reservarBotones({ db, negocioId, telefono, estado, pedido, mensajes, mixto, turnoClave, ...contexto }) {
  if (!(mensajes || []).some(m => leerBoton(m)?.telefono === telefono)) return { ignorar: true };
  const sessionId = `agente:${telefono}`, tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const { rows: [s] } = await tx.query('SELECT revision,estado FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2 FOR UPDATE', [negocioId,sessionId]);
    if (!s) { await tx.query('ROLLBACK'); return { ignorar: true }; }
    if (Number(s.revision) !== estado._revision) throw Error('BOTON_CONFLICTO_REVISION');
    const barreras = await barrerasDeBotones(tx, negocioId, telefono);
    if (!barreras.activo || estado.folio || estado.evento || estado.confirmacionIncierta
      || Object.values(estado.hechos || {}).some(Boolean)) { await tx.query('ROLLBACK'); return { ignorar: true }; }
    if (s.estado.botonesReserva) throw Error('BOTON_RESERVA_PENDIENTE');
    const candidatas = [], idsVistos = new Set();
    for (const m of mensajes || []) {
      const toque = leerBoton(m);
      if (!toque || toque.telefono !== telefono) continue;
      const { rows: [q] } = await tx.query(`SELECT q.*,b.accion,b.datos,o.estado AS envio,o.wamid_salida,
        EXTRACT(EPOCH FROM (clock_timestamp()-e.recibido_at)) AS edad,
        EXISTS (SELECT 1 FROM whatsapp_entradas posterior WHERE posterior.negocio_id=q.negocio_id
          AND posterior.telefono=$3 AND posterior.id<e.id AND posterior.recibido_at>q.created_at
          AND posterior.payload->'message'->>'type' IN ('text','image','document')) AS texto_posterior
        FROM agente_botones b JOIN agente_preguntas_interactivas q ON q.id=b.pregunta_id
        JOIN agente_outbox o ON o.evento_clave=q.outbox_clave
        JOIN whatsapp_entradas e ON e.negocio_id=q.negocio_id AND e.wamid=$4 AND e.telefono=$3
        WHERE b.token=$1 AND q.negocio_id=$2 AND q.session_id=$5 FOR UPDATE OF q`,
      [toque.token,negocioId,telefono,toque.wamid,sessionId]);
      if (!q || q.ciclo !== estado.conversacionId || q.estado !== 'disponible' || idsVistos.has(q.id)) continue;
      // context.id ajeno nunca consume una pregunta válida.
      if (q.wamid_salida && toque.contexto !== q.wamid_salida) continue;
      let accion = q.accion;
      // También invalida un texto que tomó un atajo (menú, archivo...), aunque
      // ese atajo no haya reemplazado el diálogo del agente.
      const vigente = q.dialogo_id === estado.pendiente?.dialogo_id && !q.texto_posterior;
      if (mixto) accion = 'texto';
      else if (!vigente || !interactivosActivos(barreras.cfg)) accion = 'aviso';
      else if (['pendiente','enviando'].includes(q.envio) && Number(q.edad) < 120) {
        await tx.query('ROLLBACK'); return { retenerBotones: true };
      } else if (q.envio !== 'entregado' || !q.wamid_salida) accion = 'aviso';
      else if (q.huella !== pedido.huella) accion = 'aviso';
      else if (['confirmar','cambiar_algo'].includes(q.accion)) {
        if (estado.pendiente?.tipo !== 'confirmar_resumen' || pedido.falta?.length || pedido.aclaraciones?.length) accion = 'aviso';
      } else if (!eleccionesActivas(barreras.cfg) || !asociacionVigente(q,{estado,...contexto})) accion = 'aviso';
      candidatas.push({ ...q, accion, wamid: toque.wamid }); idsVistos.add(q.id);
      if (!mixto) break; // primera pregunta reconocida: una respuesta por turno
    }
    if (!candidatas.length) { await tx.query('ROLLBACK'); return { ignorar: true }; }
    const reservaId = randomUUID(), ids = candidatas.map(q => q.id), primera = candidatas[0];
    for (const q of candidatas) await tx.query(`UPDATE agente_preguntas_interactivas
      SET estado='reservada',reserva_id=$2,reservado_at=now(),comando=$3::jsonb WHERE id=$1`,
    [q.id,reservaId,JSON.stringify({ accion:q.accion,datos:q.datos,wamid:q.wamid,turnoClave,huella:q.huella,total:Number(q.total_mostrado) })]);
    estado.botonesReserva = { reservaId, ids, turnoClave };
    estado.version = estado._revision + 1;
    const { rows: [n] } = await tx.query(`UPDATE conversacion_estado SET estado=$3::jsonb,revision=revision+1
      WHERE negocio_id=$1 AND session_id=$2 RETURNING revision`,[negocioId,sessionId,JSON.stringify(estado)]);
    await tx.query('COMMIT'); estado._revision = Number(n.revision);
    return { reservaId, ids, accion: primera.accion, datos:primera.datos, huella: primera.huella, total: Number(primera.total_mostrado) };
  } catch (e) { await tx.query('ROLLBACK').catch(() => {}); throw e; }
  finally { tx.release(); }
}

export async function terminarBotones(tx, { reserva, clave, folio, incierta = false }) {
  if (!reserva?.reservaId) return;
  const { rowCount } = await tx.query(`UPDATE agente_preguntas_interactivas SET estado=$3,
    respuesta_clave=$4,resultado=$5::jsonb,terminado_at=now()
    WHERE id=ANY($1::uuid[]) AND reserva_id=$2 AND estado='reservada'`,
  [reserva.ids,reserva.reservaId,incierta ? 'incierta':'terminada',clave,JSON.stringify({ folio: folio || null })]);
  if (rowCount !== reserva.ids.length) throw Error('BOTON_RESERVA_PERDIDA');
}

// Solo concilia evidencia, nunca repite efectos ni libera una reserva incierta.
export async function conciliarReservaBotones(db, negocioId, estado) {
  if (!estado.botonesReserva) return;
  const { rows: [p] } = await db.query(`SELECT folio FROM pedidos_activos WHERE negocio_id=$1
    AND datos->'origen_agente'->>'conversacion_id'=$2 UNION ALL
    SELECT folio FROM pedidos_programados WHERE negocio_id=$1
    AND datos->'origen_agente'->>'conversacion_id'=$2 LIMIT 1`, [negocioId,estado.conversacionId]);
  await db.query(`UPDATE agente_preguntas_interactivas SET estado='incierta',resultado=$3::jsonb
    WHERE id=ANY($1::uuid[]) AND reserva_id=$2 AND estado='reservada'`,
  [estado.botonesReserva.ids,estado.botonesReserva.reservaId,JSON.stringify({ folio:p?.folio || null, revisionHumana:true })]);
  return p?.folio || null;
}
