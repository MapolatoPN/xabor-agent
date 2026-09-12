import {createHash} from 'node:crypto';
// El pool de locks debe ser independiente del pool utilizado por los efectos.
// Nunca se reejecuta un turno interrumpido después de comenzar sus efectos:
// se conserva para revisión. Pendientes nunca empezados sí se recuperan solos.
export function crearContinuidad({ pool, locks, procesar, cargarSesion, leerSesion, alRevision = async () => {}, alLiberar = async () => {}, ventanaMs = 6000 }) {
  let timer, escaneando = false;
  let timerOlvidos = null;
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
    // Cada minuto: revisiones que nadie atendió. Aparte del barrido de 500 ms
    // porque es una consulta distinta y mucho menos frecuente.
    if (!timerOlvidos) {
      timerOlvidos = setInterval(
        () => liberarRevisionesOlvidadas().catch(e => console.error('[wa-continuidad] olvidos:',e.message)),
        60000);
      timerOlvidos.unref();
    }
  }
  async function detener() { clearInterval(timer); timer=null; clearInterval(timerOlvidos); timerOlvidos=null; await Promise.allSettled([...activos.values()]); }

  /**
   * Manda una conversación a revisión humana desde FUERA de este módulo.
   *
   * Existe para la política «si no sé, no invento»: cuando el bot se queda sin
   * saber qué contestar —pidió un humano, no pudo verificar el pedido contra el
   * menú, o estuvo a punto de negar algo que sí vendemos— la conversación se
   * marca aquí y el bot deja de responderla, en vez de inventar una respuesta y
   * que alguien tenga que apagarlo después.
   *
   * Es la MISMA puerta que ya usaban REENTREGA_LEGADA y EJECUCION_INTERRUMPIDA:
   * no se duplica la lógica de pausar, avisar al panel y dejar las entradas en
   * 'revision'. Solo se le abren disparadores nuevos.
   *
   * Nunca lanza: dejar de marcar una revisión no puede tumbar el turno.
   * Devuelve `true` si la conversación quedó marcada por ESTA llamada.
   */
  async function enviarARevision(negocioId, telefono, motivo) {
    if (!negocioId || !telefono || !motivo) return false;
    const db = await pool.connect();
    try {
      // La fila la crea `recibir` en cada mensaje entrante, así que a estas
      // alturas siempre existe. Se asegura igual: sin fila, el UPDATE de abajo
      // no afectaría nada y la conversación seguiría contestándose sola -- un
      // fallo mudo, que es justo lo que esta política existe para evitar.
      await db.query(`INSERT INTO whatsapp_conversaciones(negocio_id,telefono) VALUES($1,$2)
        ON CONFLICT DO NOTHING`, [negocioId, telefono]);
      // Si ya estaba en revisión no se vuelve a avisar: el equipo ya la tiene
      // en su lista y repetir el aviso solo hace ruido.
      const { rows:[c] } = await db.query(
        'SELECT requiere_revision FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2',[negocioId,telefono]);
      if (c?.requiere_revision) return false;
      await marcarRevision(db, negocioId, telefono, motivo);
      return true;
    } catch (e) {
      console.error('[wa-continuidad] enviarARevision:', e.message);
      return false;
    } finally { db.release(); }
  }

  // ─── La pausa no puede ser eterna ────────────────────────────────────────
  //
  // Una conversación en revisión NO recibe ninguna respuesta del bot: ni un
  // pedido, ni un saludo. Eso es lo que se pidió, y está bien mientras alguien
  // entre a atenderla. El 2026-09-11 nadie entró: un cliente escribió tres
  // veces y no recibió nada durante horas, y encima el botón para devolverla
  // estaba roto. Un bot que contesta imperfecto es mejor que un cliente
  // ignorado media noche.
  //
  // Se suelta SOLO lo que pausó el sistema. Si una persona tomó la
  // conversación a mano (`conversaciones_control.updated_by` con usuario), no
  // se toca jamás: contestarle encima a alguien del equipo que está atendiendo
  // sería peor que el problema que esto resuelve.
  const MINUTOS_POR_DEFECTO = 30;

  /** Minutos que el negocio quiere esperar. 0 o menos = nunca soltar. */
  function minutosDeEspera(valor) {
    if (valor === null || valor === undefined || String(valor).trim() === '') return MINUTOS_POR_DEFECTO;
    const n = Number(String(valor).trim());
    return Number.isFinite(n) ? n : MINUTOS_POR_DEFECTO;
  }

  async function liberarRevisionesOlvidadas() {
    let candidatas = [];
    try {
      const { rows } = await pool.query(`
        SELECT c.negocio_id, c.telefono, c.motivo, c.actualizado_at, cc.updated_by,
               (SELECT valor FROM configuracion
                 WHERE negocio_id = c.negocio_id AND clave = 'bot_revision_minutos') AS minutos
          FROM whatsapp_conversaciones c
          LEFT JOIN conversaciones_control cc
                 ON cc.negocio_id = c.negocio_id AND cc.telefono = c.telefono
         WHERE c.requiere_revision = TRUE
         ORDER BY c.actualizado_at ASC
         LIMIT 200`);
      candidatas = rows;
    } catch (e) {
      console.error('[wa-continuidad] no se pudieron leer las revisiones pendientes:', e.message);
      return 0;
    }
    const ahora = Date.now();
    let sueltas = 0;
    for (const c of candidatas) {
      if (c.updated_by) continue;                       // la tomó una persona
      const minutos = minutosDeEspera(c.minutos);
      if (minutos <= 0) continue;                       // el negocio la quiere permanente
      const edadMin = (ahora - new Date(c.actualizado_at).getTime()) / 60000;
      if (edadMin < minutos) continue;
      if (await soltar(c.negocio_id, c.telefono, c.motivo, Math.round(edadMin))) sueltas++;
    }
    return sueltas;
  }

  /**
   * Devuelve la conversación al bot, con la MISMA semántica que el botón del
   * panel: las entradas pendientes quedan como atendidas y NO se reprocesan.
   *
   * Eso importa: reprocesar el atasco podría registrar dos veces un pedido. Lo
   * que se recupera es la conversación hacia adelante, no lo que quedó atrás.
   */
  async function soltar(negocioId, telefono, motivo, edadMin) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      // Se vuelve a comprobar DENTRO de la transacción: entre la lectura y
      // ahora alguien pudo tomar la conversación.
      const { rows:[c] } = await db.query(
        `SELECT c.requiere_revision, cc.updated_by
           FROM whatsapp_conversaciones c
           LEFT JOIN conversaciones_control cc
                  ON cc.negocio_id = c.negocio_id AND cc.telefono = c.telefono
          WHERE c.negocio_id = $1 AND c.telefono = $2 FOR UPDATE OF c`, [negocioId, telefono]);
      if (!c?.requiere_revision || c.updated_by) { await db.query('ROLLBACK'); return false; }
      await db.query(`UPDATE whatsapp_entradas SET estado='revisado', actualizado_at=now()
         WHERE negocio_id=$1 AND telefono=$2 AND estado IN ('revision','pendiente')`, [negocioId, telefono]);
      await db.query(`UPDATE whatsapp_conversaciones
          SET requiere_revision=false, motivo=NULL, revision=revision+1, actualizado_at=now()
         WHERE negocio_id=$1 AND telefono=$2`, [negocioId, telefono]);
      await db.query(`DELETE FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2`,
        [negocioId, `meta-${negocioId}-${telefono}`]);
      await db.query(`UPDATE conversaciones_control SET bot_pausado=false, updated_at=now()
         WHERE negocio_id=$1 AND telefono=$2 AND updated_by IS NULL`, [negocioId, telefono]);
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      console.error(`[wa-continuidad] no se pudo devolver al bot ${telefono}:`, e.message);
      return false;
    } finally { db.release(); }
    console.warn(`[wa-continuidad] revisión sin atender ${edadMin} min: el bot retoma telefono=${telefono} motivo=${motivo}`);
    await alLiberar(negocioId, telefono, motivo, edadMin)
      .catch((e) => console.error('[wa-continuidad] aviso de liberación:', e.message));
    return true;
  }

  return { recibir, ejecutar, barrer, iniciar, detener, enviarARevision, liberarRevisionesOlvidadas };
}
