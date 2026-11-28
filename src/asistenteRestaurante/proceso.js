// Asistente del restaurante, Fase 1: la corrida de cada mañana.
//
// Una vez al día por sucursal, entre las 6:00 y las 12:00 de SU hora, se leen
// las ventas hasta el día anterior (datos.js, transacción de solo lectura),
// se buscan hallazgos con reglas fijas (reglas.js), se eligen hasta 3
// (priorizar.js) y se guardan TODOS con su motivo. Corre a las 6:00 y no al
// cierre para tener el día completo aunque se cobre pasada la medianoche.
//
// Solo en la sucursal con asistente_restaurante_v1 = 'true'. En modo ensayo
// (lo normal al principio) se guarda todo y no se muestra nada.
//
// Nunca está en el camino de un pedido: lo llama un temporizador del servidor
// (server.js) y cualquier falla se queda en la corrida (estado 'fallo') y en
// el log. No toca pedidos, cobros, impresión, Rappi, WhatsApp, Clip ni
// Facturapi.
import { pool } from '../services/database.js';
import { TZ_DEFAULT, esZonaValida } from '../services/zonaHoraria.js';
import { fechaOperativaDe } from '../services/cortesCaja.js';
import { leerDatosSucursal } from './datos.js';
import { buscarHallazgos, sumarDias } from './reglas.js';
import { priorizar, DIAS_SIN_REPETIR_INFORMATIVO } from './priorizar.js';
import { BANDERA, CLAVE_MODO } from './avisos.js';
import { leerConfiguracion, paraLaRevision } from './configuracion.js';
import { pedirJson } from './ia.js';
import { entradaAvisos, aplicarRespuestaAvisos, SISTEMA_AVISOS, ESQUEMA_AVISOS } from './redaccion.js';

export const HORA_DESDE = 6;   // hora local en que empieza la ventana
export const HORA_HASTA = 12;  // y en la que termina (sin incluirla)
export const DIAS_NO_UTIL = 90;
// Una corrida que se quedó «corriendo» (el servidor se reinició a la mitad)
// se puede retomar pasado este tiempo; una que falló, pasada una hora.
const MINUTOS_ATASCADA = 30;

const esUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export function zonaDe(valor) {
  const tz = String(valor || '').trim();
  return tz && esZonaValida(tz) ? tz : TZ_DEFAULT;
}

/** La hora (0–23) de un instante en esa zona. */
export function horaLocal(instante, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).formatToParts(instante);
  return Number(p.find((x) => x.type === 'hour')?.value) % 24;
}

export const enVentana = (instante, tz) => { const h = horaLocal(instante, tz); return h >= HORA_DESDE && h < HORA_HASTA; };

/** Lo que priorizar necesita recordar de corridas anteriores de ESTA sucursal. */
export async function leerMemoria(db, negocioId, hoy) {
  const { rows: mostrados } = await db.query(`
    SELECT h.firma, h.impacto::float AS impacto, c.fecha::text AS fecha
      FROM asistente_restaurante_hallazgos h
      JOIN asistente_restaurante_corridas c ON c.negocio_id = h.negocio_id AND c.id = h.corrida_id
     WHERE h.negocio_id = $1 AND h.elegido AND c.fecha >= $2::date AND c.fecha < $3::date`,
  [negocioId, sumarDias(hoy, -DIAS_SIN_REPETIR_INFORMATIVO), hoy]);
  const { rows: noUtil } = await db.query(`
    SELECT tipo, COUNT(*)::int AS n FROM asistente_restaurante_opiniones
     WHERE negocio_id = $1 AND opinion = 'no_util' AND actualizado_en > now() - make_interval(days => $2)
     GROUP BY tipo`, [negocioId, DIAS_NO_UTIL]);
  const { rows: silenciados } = await db.query(
    'SELECT firma FROM asistente_restaurante_silenciados WHERE negocio_id = $1', [negocioId]);
  return {
    hoy,
    mostrados,
    noUtilPorTipo: Object.fromEntries(noUtil.map((r) => [r.tipo, r.n])),
    silenciados: silenciados.map((r) => r.firma),
  };
}

/**
 * Lee y calcula SIN escribir nada (la base solo recibe lecturas).
 * `umbrales` (Fase 2, configuración de la sucursal) ajusta las reglas; la
 * memoria trae además los tipos apagados, los mínimos y el máximo al día.
 */
export async function calcularSucursal(db, { negocio, hoy, ahora = new Date(), memoria = { hoy }, umbrales = {} }) {
  const cliente = await db.connect();
  let datos;
  try {
    datos = await leerDatosSucursal(cliente, { negocio, hoy, ahora });
  } finally {
    cliente.release();
  }
  const { hallazgos, umbralGrande, esLunes } = buscarHallazgos({ ...datos, umbrales });
  const { elegidos, todos } = priorizar(hallazgos, { ...memoria, hoy });
  return { ventas: datos.ventas.length, umbralGrande, esLunes, elegidos, todos };
}

/**
 * Fase 3: la IA elige entre los avisos que las reglas dejaron pasar y los
 * redacta (redaccion.js revisa cifras y lenguaje). Se llama FUERA de toda
 * transacción. Si no se puede (tope, sin llave, error o respuesta que no
 * sirve), quedan los elegidos y los textos de las reglas, igual que en la
 * Fase 2. Devuelve { todos, estadoIA } (estadoIA va a corridas.ia).
 */
export async function redactarAvisos({ db, negocio, hoy, todos, maximo, topeUsd, clienteIA, ahora = new Date() }) {
  const max = Math.min(Number.isInteger(maximo) && maximo > 0 ? maximo : 3, 3);
  const entrada = entradaAvisos({ negocio, hoy, todos, maximo: max });
  if (!entrada.pool.length) return { todos, estadoIA: 'sin_avisos' };
  const tz = zonaDe(negocio.tz);
  const res = await pedirJson({
    db, negocioId: negocio.id, tz, proposito: 'avisos', sistema: SISTEMA_AVISOS,
    usuario: JSON.stringify(entrada.datos), esquema: ESQUEMA_AVISOS, maxTokens: 4000, topeUsd, cliente: clienteIA, ahora,
  });
  if (!res.ok) {
    // Fase 4: el tope ya no va a la campanita (es para atender clientes); lo
    // dice la pestaña Asistente de Reportes, que lee corridas.ia = 'tope'.
    console.warn(`[Asistente] ${negocio.id} ${hoy}: sin IA (${res.motivo}${res.detalle ? `: ${res.detalle}` : ''}); quedan los textos de las reglas.`);
    return { todos, estadoIA: res.motivo };
  }
  const a = aplicarRespuestaAvisos({ todos, maximo: max, hoy, respuesta: res.datos });
  if (a.faltas.length) console.warn(`[Asistente] ${negocio.id} ${hoy}: la IA quedó «${a.estado}»: ${a.faltas.slice(0, 3).join('; ')}`);
  return { todos: a.todos, estadoIA: a.estado };
}

/**
 * Aparta la corrida del día. Devuelve su id, o null si ya corrió (o la está
 * corriendo otro proceso). La UNIQUE (negocio_id, fecha) lo garantiza aunque
 * dos procesos lleguen a la vez.
 */
async function apartarCorrida(db, negocioId, fecha, modo) {
  const { rows: [r] } = await db.query(`
    INSERT INTO asistente_restaurante_corridas (negocio_id, fecha, modo) VALUES ($1, $2, $3)
    ON CONFLICT (negocio_id, fecha) DO UPDATE
       SET estado = 'corriendo', modo = EXCLUDED.modo, error = NULL, iniciada_en = now(), terminada_en = NULL
     WHERE (asistente_restaurante_corridas.estado = 'corriendo'
            AND asistente_restaurante_corridas.iniciada_en < now() - make_interval(mins => $4))
        OR (asistente_restaurante_corridas.estado = 'fallo'
            AND asistente_restaurante_corridas.terminada_en < now() - interval '1 hour')
    RETURNING id`, [negocioId, fecha, modo, MINUTOS_ATASCADA]);
  return r ? String(r.id) : null;
}

/** La corrida de UNA sucursal para el día `hoy` (fecha local). */
export async function correrSucursal({ db = pool, negocio, modo = 'ensayo', hoy, ahora = new Date(), clienteIA }) {
  if (!negocio || !esUuid(negocio.id)) { const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e; }
  const nid = negocio.id;
  const modoCorrida = modo === 'visible' ? 'visible' : 'ensayo';
  const corridaId = await apartarCorrida(db, nid, hoy, modoCorrida);
  if (!corridaId) return { omitida: true };
  try {
    // La configuración de la sucursal (Fase 2): tipos apagados, umbrales y
    // avisos por día. Un valor dañado vuelve a su valor de siempre.
    const ajustes = paraLaRevision(await leerConfiguracion(db, nid));
    const memoria = {
      ...(await leerMemoria(db, nid, hoy)),
      tiposApagados: ajustes.tiposApagados, minimos: ajustes.minimos, maximo: ajustes.maximo,
    };
    const r = await calcularSucursal(db, { negocio, hoy, ahora, memoria, umbrales: ajustes.umbrales });
    // Fase 3: solo si la sucursal encendió «Redactar con IA».
    let todos = r.todos;
    let estadoIA = null;
    if (ajustes.ia) {
      ({ todos, estadoIA } = await redactarAvisos({ db, negocio, hoy, todos: r.todos, maximo: ajustes.maximo, topeUsd: ajustes.topeUsd, clienteIA, ahora }));
    }
    const elegidos = todos.filter((h) => h.elegido).length;
    const cliente = await db.connect();
    try {
      await cliente.query('BEGIN');
      for (const h of todos) {
        await cliente.query(`
          INSERT INTO asistente_restaurante_hallazgos
                 (negocio_id, corrida_id, tipo, firma, impacto, titulo, contenido, elegido, motivo, mostrado)
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
        [nid, corridaId, h.tipo, String(h.firma).slice(0, 300), Math.round((Number(h.impacto) || 0) * 100) / 100,
          String(h.titulo).slice(0, 300),
          // El texto de la IA va APARTE (`ia`): el de las reglas nunca se pierde.
          JSON.stringify({
            detalle: h.detalle || null, sugerencia: h.sugerencia || '', revisar: h.revisar || null, frecuencia: h.frecuencia || null,
            // Fase 4: el título corto y la gráfica de la tarjeta en Reportes.
            ...(h.pantalla ? { pantalla: h.pantalla } : {}),
            ...(h.ia ? { ia: h.ia } : {}),
          }),
          h.elegido, h.motivo, h.elegido && modoCorrida === 'visible']);
      }
      await cliente.query(`
        UPDATE asistente_restaurante_corridas
           SET estado = 'lista', candidatos = $3, elegidos = $4, terminada_en = now(), ia = $5
         WHERE negocio_id = $1 AND id = $2`, [nid, corridaId, todos.length, elegidos, estadoIA]);
      await cliente.query('COMMIT');
    } catch (e) {
      await cliente.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      cliente.release();
    }
    return { corridaId, modo: modoCorrida, candidatos: todos.length, elegidos, ia: estadoIA };
  } catch (e) {
    await db.query(`
      UPDATE asistente_restaurante_corridas SET estado = 'fallo', error = $3, terminada_en = now()
       WHERE negocio_id = $1 AND id = $2`, [nid, corridaId, String(e?.message || e).slice(0, 300)]).catch(() => {});
    throw e;
  }
}

// ─── El temporizador de cada minuto ──────────────────────────────────────
let enCurso = false;

/** Corre las sucursales con la bandera encendida que estén en su ventana y no hayan corrido hoy. */
export async function correrSucursalesPendientes({ db = pool, ahora = new Date(), clienteIA } = {}) {
  if (enCurso) return { omitido: true };
  enCurso = true;
  const resultado = { revisadas: 0, corridas: 0, fallos: 0 };
  try {
    const { rows: [t] } = await db.query("SELECT to_regclass('public.asistente_restaurante_corridas') IS NOT NULL AS hay");
    if (!t.hay) return resultado;
    const { rows } = await db.query(`
      SELECT c.negocio_id::text AS id, n.nombre,
             (SELECT z.valor FROM configuracion z WHERE z.negocio_id = c.negocio_id AND z.clave = 'timezone' LIMIT 1) AS tz,
             (SELECT m.valor FROM configuracion m WHERE m.negocio_id = c.negocio_id AND m.clave = $2 LIMIT 1) AS modo
        FROM configuracion c JOIN negocios n ON n.id = c.negocio_id
       WHERE c.clave = $1 AND btrim(c.valor) = 'true' AND n.activo IS NOT FALSE
       ORDER BY c.negocio_id`, [BANDERA, CLAVE_MODO]);
    for (const s of rows) {
      const tz = zonaDe(s.tz);
      if (!enVentana(ahora, tz)) continue;
      const hoy = fechaOperativaDe(ahora, tz);
      resultado.revisadas++;
      const { rows: [ya] } = await db.query(`
        SELECT 1 FROM asistente_restaurante_corridas
         WHERE negocio_id = $1 AND fecha = $2
           AND (estado = 'lista'
                OR (estado = 'corriendo' AND iniciada_en >= now() - make_interval(mins => $3))
                OR (estado = 'fallo' AND terminada_en >= now() - interval '1 hour'))`, [s.id, hoy, MINUTOS_ATASCADA]);
      if (ya) continue;
      try {
        const r = await correrSucursal({ db, negocio: { id: s.id, nombre: s.nombre, tz }, modo: String(s.modo || '').trim(), hoy, ahora, clienteIA });
        if (!r.omitida) {
          resultado.corridas++;
          console.log(`[Asistente] ${s.id} ${hoy} (${r.modo}): ${r.candidatos} hallazgo(s), ${r.elegidos} elegido(s)${r.ia ? `, IA: ${r.ia}` : ''}.`);
        }
      } catch (e) {
        resultado.fallos++;
        console.error(`[Asistente] No se pudo revisar la sucursal ${s.id} el ${hoy}: ${e.message}`);
      }
    }
    return resultado;
  } finally {
    enCurso = false;
  }
}
