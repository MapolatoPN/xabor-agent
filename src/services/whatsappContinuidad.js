import {createHash} from 'node:crypto';
// El pool de locks debe ser independiente del pool utilizado por los efectos.
// Nunca se reejecuta un turno interrumpido después de comenzar sus efectos:
// se conserva para revisión. Pendientes nunca empezados sí se recuperan solos.
export function crearContinuidad({ pool, locks, procesar, cargarSesion, leerSesion, alRevision = async () => {}, ventanaMs = 6000 }) {
  let timer, escaneando = false;
  const activos = new Map();
  const clave = (n, t) => `wa:${n}:${t}`;

  async function recibir(entradas, sobre = null) {
    const db = await pool.connect();
    const mensajes = [];
    try {
      await db.query('BEGIN');
      let reciboId;
      if(sobre) {
        const ids=[];
        for(const e of sobre.entry || []) for(const c of e.changes || []) for(const m of c.value?.messages || []) if(m.id) ids.push(m.id);
        const referencia=ids.length===1 ? ids[0] : 'sha:'+createHash('sha256').update(JSON.stringify(sobre)).digest('hex');
        const {rows:[recibo]}=await db.query(`INSERT INTO webhook_entrante(canal,referencia,payload,intentos) VALUES('whatsapp',$1,$2,1)
          ON CONFLICT(canal,referencia) DO UPDATE SET intentos=webhook_entrante.intentos+1 RETURNING id`,[referencia,JSON.stringify(sobre)]);
        reciboId=recibo.id;
      }
      for (const e of entradas) {
        if (!e.negocioId || !e.telefono || !e.wamid) throw new Error('IDENTIDAD_ENTRADA_REQUERIDA');
        await db.query(`INSERT INTO whatsapp_conversaciones(negocio_id,telefono) VALUES($1,$2) ON CONFLICT DO NOTHING`, [e.negocioId,e.telefono]);
        // Serializa recepción con el acuse humano: un mensaje que llegue
        // mientras se revisa no puede quedar marcado como atendido sin verlo.
        await db.query('SELECT 1 FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2 FOR UPDATE', [e.negocioId,e.telefono]);
        const insertada=await db.query(`INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload) VALUES($1,$2,$3,$4) ON CONFLICT(negocio_id,wamid) DO NOTHING RETURNING id`,
          [e.negocioId,e.telefono,e.wamid,JSON.stringify(e.payload)]);
        if(!insertada.rows.length) {console.log(`[wa-continuidad] reentrega ignorada wamid=${String(e.wamid).slice(-12)}`);continue;}
        const previo=await db.query('SELECT 1 FROM mensajes WHERE negocio_id=$1 AND message_id_externo=$2',[e.negocioId,e.wamid]);
        if(previo.rows.length) {
          // Mensaje de la versión anterior: tener historial no prueba si sus
          // efectos terminaron. Nunca volver a comprar por una reentrega vieja.
          await db.query("UPDATE whatsapp_entradas SET estado='revision' WHERE id=$1",[insertada.rows[0].id]);
          await db.query("UPDATE whatsapp_conversaciones SET requiere_revision=true,motivo='REENTREGA_LEGADA' WHERE negocio_id=$1 AND telefono=$2",[e.negocioId,e.telefono]);
        }
        const m = e.payload.message;
        if (m && ['text','image','document'].includes(m.type)) {
          const texto = m.type === 'text' ? m.text?.body || '' : m.type === 'image' ? `📷 ${m.image?.caption || 'Imagen recibida'}` : `📄 ${m.document?.filename || 'Documento recibido'}`;
          const r = await db.query(`INSERT INTO mensajes(telefono,nombre,direccion,texto,negocio_id,origen,message_id_externo)
            VALUES($1,$2,'entrante',$3,$4,'cliente',$5)
            ON CONFLICT(message_id_externo) WHERE message_id_externo IS NOT NULL DO NOTHING RETURNING *`,
            [e.telefono,e.payload.value?.contacts?.[0]?.profile?.name || null,texto,e.negocioId,e.wamid]);
          if (r.rows[0]) mensajes.push(r.rows[0]);
        }
      }
      if(reciboId) await db.query("UPDATE webhook_entrante SET estado='procesado',procesado_at=now() WHERE id=$1",[reciboId]);
      await db.query('COMMIT');
      return mensajes;
    } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
    finally { db.release(); }
  }

  async function marcarRevision(db, n, t, motivo) {
    await db.query('BEGIN');
    try {
      await db.query(`UPDATE whatsapp_conversaciones SET requiere_revision=true,motivo=$3,actualizado_at=now() WHERE negocio_id=$1 AND telefono=$2`, [n,t,motivo]);
      await db.query(`UPDATE whatsapp_entradas SET estado='revision',actualizado_at=now() WHERE negocio_id=$1 AND telefono=$2 AND estado='procesando'`, [n,t]);
      await db.query('COMMIT');
    } catch(e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
    await alRevision(n,t,motivo).catch(e => console.error('[wa-continuidad] aviso:',e.message));
  }

  async function ejecutar(n, t) {
    const k = clave(n,t);
    if (activos.has(k)) return activos.get(k);
    const trabajo = (async () => {
      const db = await locks.connect();
      let bloqueado = false;
      // pg emite error si muere la conexión que sostiene el lock. No se
      // guarda estado como exitoso después de perder la exclusión.
      let desconectado = false;
      const errorConexion = () => { desconectado = true; };
      db.on('error', errorConexion);
      try {
        const r = await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok',[k]);
        bloqueado = r.rows[0].ok;
        if (!bloqueado) return;
        const { rows:[c] } = await db.query(`SELECT c.*,s.estado AS sesion,clock_timestamp() AS reloj FROM whatsapp_conversaciones c
          LEFT JOIN conversacion_estado s ON s.negocio_id=c.negocio_id AND s.session_id='meta-' || c.negocio_id::text || '-' || c.telefono
          WHERE c.negocio_id=$1 AND c.telefono=$2`,[n,t]);
        if (!c || c.requiere_revision) return;
        const { rows } = await db.query(`SELECT * FROM whatsapp_entradas WHERE negocio_id=$1 AND telefono=$2 AND estado IN ('pendiente','procesando') ORDER BY id`,[n,t]);
        if (rows.some(e => e.estado === 'procesando')) {
          await marcarRevision(db,n,t,'EJECUCION_INTERRUMPIDA'); return;
        }
        if (!rows.length) return;
        // Límite de espera: un cliente que escribe sin parar no puede impedir
        // indefinidamente que se atienda su primer mensaje.
        const ahora = new Date(c.reloj).getTime();
        const ultimo = new Date(rows.at(-1).recibido_at).getTime();
        const primero = new Date(rows[0].recibido_at).getTime();
        if (ahora < ultimo + ventanaMs && ahora < primero + Math.max(ventanaMs,30000)) return;
        const lote = rows.slice(0,30);
        const ids = lote.map(e => e.id);
        // Checkpoint ANTES de cualquier efecto. Un crash no borra esta señal.
        await db.query(`UPDATE whatsapp_entradas SET estado='procesando',actualizado_at=now() WHERE negocio_id=$1 AND id=ANY($2::bigint[])`,[n,ids]);
        try {
          await cargarSesion(n,t,c.sesion);
          await procesar(lote.map(e => e.payload),n,t);
          if (desconectado) throw new Error('LOCK_PERDIDO');
          const sesion = await leerSesion(n,t);
          await db.query('BEGIN');
          await db.query(`INSERT INTO conversacion_estado(negocio_id,session_id,estado) VALUES($1,$2,$3)
            ON CONFLICT(negocio_id,session_id) DO UPDATE SET estado=excluded.estado,revision=conversacion_estado.revision+1,actualizado_at=now()`,[n,`meta-${n}-${t}`,JSON.stringify(sesion)]);
          await db.query(`UPDATE whatsapp_conversaciones SET revision=revision+1,actualizado_at=now() WHERE negocio_id=$1 AND telefono=$2`,[n,t]);
          await db.query(`UPDATE whatsapp_entradas SET estado='completado',actualizado_at=now() WHERE negocio_id=$1 AND id=ANY($2::bigint[])`,[n,ids]);
          await db.query('COMMIT');
        } catch(e) {
          await db.query('ROLLBACK').catch(() => {});
          if (!desconectado) await marcarRevision(db,n,t,'EJECUCION_NO_VERIFICADA');
          console.error('[wa-continuidad] ejecución requiere revisión:',e.message);
        }
      } finally {
        if (bloqueado && !desconectado) await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[k]).catch(() => {desconectado=true;});
        db.removeListener('error',errorConexion);
        db.release(desconectado);
      }
    })();
    activos.set(k,trabajo);
    try { return await trabajo; } finally { activos.delete(k); }
  }

  async function barrer() {
    if (escaneando) return;
    escaneando = true;
    try {
      const { rows } = await pool.query(`SELECT e.negocio_id,e.telefono,min(e.id) AS primero FROM whatsapp_entradas e
        JOIN whatsapp_conversaciones c USING(negocio_id,telefono)
        WHERE e.estado IN ('pendiente','procesando') AND NOT c.requiere_revision
        GROUP BY e.negocio_id,e.telefono ORDER BY min(e.id) LIMIT 32`);
      // Cada conversación progresa aparte; no se espera al cliente más lento.
      for (const e of rows) {
        if(activos.size >= 4) break;
        if(activos.has(clave(e.negocio_id,e.telefono))) continue;
        ejecutar(e.negocio_id,e.telefono).catch(err => console.error('[wa-continuidad] worker:',err.message));
      }
    } finally { escaneando = false; }
  }
  async function iniciar() {
    await pool.query('SELECT 1 FROM whatsapp_entradas LIMIT 0');
    if (!timer) { timer = setInterval(() => barrer().catch(e => console.error('[wa-continuidad] scanner:',e.message)),500); timer.unref(); }
  }
  async function detener() { clearInterval(timer); timer=null; await Promise.allSettled([...activos.values()]); }
  return { recibir, ejecutar, barrer, iniciar, detener };
}
