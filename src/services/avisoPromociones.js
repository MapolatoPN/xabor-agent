/**
 * avisoPromociones.js — el aviso de promociones de la tienda en línea y la
 * aceptación que queda al pedir (fase 2 del saneamiento de Clientes,
 * 21-nov-2026, puntos 7 a 9 del prompt maestro).
 *
 * Decisión de Mario: las campañas de WhatsApp van a todos menos a quien se dio
 * de baja; no se pide permiso uno por uno. El aviso deja dicho, a la vista,
 * que al pedir se aceptan promociones y que la baja está a un toque.
 *
 *   Versiones   aviso_promociones (146). Cada cambio es una fila nueva; la
 *               vigente es la más reciente. Así se sabe qué texto vio cada
 *               cliente, y volver al anterior es guardar otra vez ese texto.
 *   Aceptación  una fila en cliente_consentimientos (fuente 'tienda_pedido',
 *               con el folio y la versión) por cada cliente que pidió en la
 *               tienda con el aviso a la vista. La anota un trabajo en segundo
 *               plano: el checkout no se toca y nunca espera por esto.
 *
 * Reglas:
 *   - El negocio sale SIEMPRE de la sesión (rutas) o de la tienda resuelta.
 *   - Pedir NO deshace una baja: solo se anota la aceptación de quien no tiene
 *     ningún dato de promociones por WhatsApp (ni aceptó ni se dio de baja).
 *   - Un pedido hecho antes de que existiera el aviso, o con el aviso apagado,
 *     no deja aceptación.
 *   - La tienda nunca falla por el aviso: si no se puede leer, no se muestra.
 */
import { pool } from './database.js';

export const MAX_TEXTO = 300;

export class ErrorAviso extends Error {
  constructor(mensaje, codigo, http = 400) { super(mensaje); this.codigo = codigo; this.http = http; }
}

const limpiar = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);

/** El texto que pidió Mario, con el nombre del negocio. */
export function textoPorOmision(nombre) {
  const n = limpiar(nombre, 80) || 'este negocio';
  return `Al pedir aceptas recibir promociones de ${n}; puedes darte de baja cuando quieras.`;
}

function version(r) {
  if (!r) return null;
  return { id: Number(r.id), texto: r.texto, enTienda: r.en_tienda === true, creadoPor: r.creado_por || null, fecha: r.created_at };
}

// El nombre con el que el cliente conoce al negocio: el de la tienda si lo
// tiene, si no el del negocio.
async function nombreDelNegocio(negocioId) {
  const { rows: [r] } = await pool.query(
    `SELECT COALESCE(NULLIF(btrim(tc.titular), ''), n.nombre) AS nombre
       FROM negocios n LEFT JOIN tienda_config tc ON tc.negocio_id = n.id WHERE n.id = $1`, [negocioId]);
  return r?.nombre || null;
}

export async function avisoVigente(negocioId) {
  const { rows: [r] } = await pool.query(
    `SELECT * FROM aviso_promociones WHERE negocio_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [negocioId]);
  return version(r);
}

/**
 * Lo que la tienda pública muestra junto al botón de pedir: { id, texto } o
 * null (sin aviso, apagado o sin poder leerlo). Nunca lanza.
 */
export async function avisoParaTienda(negocioId) {
  try {
    const v = await avisoVigente(negocioId);
    return v && v.enTienda ? { id: v.id, texto: v.texto } : null;
  } catch (e) {
    console.error('[AVISO] No se pudo leer el aviso de promociones:', e.message);
    return null;
  }
}

/** Para el panel: la vigente, el texto por omisión y las últimas versiones. */
export async function avisoParaPanel(negocioId) {
  const [nombre, { rows }] = await Promise.all([
    nombreDelNegocio(negocioId),
    pool.query(`SELECT * FROM aviso_promociones WHERE negocio_id = $1 ORDER BY created_at DESC, id DESC LIMIT 10`, [negocioId]),
  ]);
  const { rows: [cuenta] } = await pool.query(
    `SELECT count(*)::int AS n FROM cliente_consentimientos WHERE negocio_id = $1 AND fuente = 'tienda_pedido'`, [negocioId]);
  return {
    vigente: version(rows[0]) || null,
    porOmision: textoPorOmision(nombre),
    historial: rows.map(version),
    aceptacionesAlPedir: cuenta?.n || 0,
    maxTexto: MAX_TEXTO,
  };
}

/**
 * Guarda una versión nueva si cambia algo (texto o encendido). Igual a la
 * vigente: no escribe nada y responde cambio = false.
 */
export async function guardarAviso(negocioId, { texto, enTienda } = {}, quien = null) {
  const t = limpiar(texto, MAX_TEXTO + 1);
  if (!t) throw new ErrorAviso('Escribe el aviso: es lo que el cliente lee antes de pedir.', 'TEXTO_VACIO');
  if (t.length > MAX_TEXTO) throw new ErrorAviso(`El aviso puede tener hasta ${MAX_TEXTO} caracteres.`, 'TEXTO_LARGO');
  if (typeof enTienda !== 'boolean') throw new ErrorAviso('Indica si el aviso se muestra en la tienda.', 'EN_TIENDA_INVALIDO');
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    // Dos administradores guardando a la vez: uno después del otro.
    await cliente.query(`SELECT pg_advisory_xact_lock(hashtextextended('aviso-promociones:' || $1::text, 0))`, [negocioId]);
    const { rows: [previa] } = await cliente.query(
      `SELECT * FROM aviso_promociones WHERE negocio_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [negocioId]);
    if (previa && previa.texto === t && previa.en_tienda === enTienda) {
      await cliente.query('ROLLBACK');
      return { cambio: false, vigente: version(previa) };
    }
    const { rows: [nueva] } = await cliente.query(
      `INSERT INTO aviso_promociones (negocio_id, texto, en_tienda, creado_por)
       VALUES ($1, $2, $3, $4) RETURNING *`, [negocioId, t, enTienda, quien ? String(quien).slice(0, 80) : null]);
    await cliente.query('COMMIT');
    return { cambio: true, vigente: version(nueva) };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { cliente.release(); }
}

/**
 * Siembra el texto por omisión, encendido, en cada negocio activo con tienda
 * que todavía no tenga ninguna versión. Lo pidió Mario (punto 8): el aviso
 * aparece sin que nadie lo configure. Si el administrador lo apaga, queda
 * apagado: ya hay una versión y esto no vuelve a sembrar.
 */
export async function asegurarAvisoInicial() {
  const { rows } = await pool.query(
    `SELECT n.id, COALESCE(NULLIF(btrim(tc.titular), ''), n.nombre) AS nombre
       FROM negocios n JOIN tienda_config tc ON tc.negocio_id = n.id
      WHERE n.activo AND NOT EXISTS (SELECT 1 FROM aviso_promociones a WHERE a.negocio_id = n.id)`);
  let sembrados = 0;
  for (const r of rows) {
    // El candado de guardarAviso, y la revisión DESPUÉS de tomarlo: si un
    // administrador guardó en ese instante, gana el suyo y aquí no se agrega nada.
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query(`SELECT pg_advisory_xact_lock(hashtextextended('aviso-promociones:' || $1::text, 0))`, [r.id]);
      const { rowCount } = await cliente.query(
        `INSERT INTO aviso_promociones (negocio_id, texto, en_tienda, creado_por)
         SELECT $1, $2, true, 'sistema'
          WHERE NOT EXISTS (SELECT 1 FROM aviso_promociones a WHERE a.negocio_id = $1)`, [r.id, textoPorOmision(r.nombre)]);
      await cliente.query('COMMIT');
      sembrados += rowCount;
    } catch (e) {
      await cliente.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { cliente.release(); }
  }
  if (sembrados) console.log(`[AVISO] Aviso de promociones por omisión en ${sembrados} tienda(s)`);
  return sembrados;
}

/**
 * Anota «aceptó» (fuente 'tienda_pedido') a cada cliente de la Lista que pidió
 * en la tienda con el aviso encendido a la vista, si no tenía ningún dato de
 * promociones por WhatsApp. La fecha es la del pedido. Idempotente: un
 * cliente con cualquier fila ya no recibe otra, y el índice único de la 146
 * impide dos aceptaciones al pedir aunque corran dos servidores a la vez.
 *
 * Un pedido pendiente de pago (pago en línea sin completar) o cancelado no
 * cuenta: aceptar es pedir de verdad. Si se paga dentro de la ventana, se
 * anota entonces.
 */
export async function registrarAceptacionesTienda(ventana = '2 days') {
  // pedidos_activos.created_at es timestamp SIN zona y guarda UTC: se compara
  // como UTC, nunca con la zona de la sesión.
  const { rowCount } = await pool.query(
    `INSERT INTO cliente_consentimientos (negocio_id, cliente_id, canal, otorgado, fuente, referencia, aviso_id, created_at)
     SELECT DISTINCT ON (c.id) c.negocio_id, c.id, 'whatsapp', true, 'tienda_pedido', pa.folio, av.id,
            (pa.created_at AT TIME ZONE 'UTC')
       FROM pedidos_activos pa
       JOIN clientes_negocio c
         ON c.negocio_id = pa.negocio_id
        AND c.telefono = right(regexp_replace(pa.datos->'cliente'->>'telefono', '\\D', '', 'g'), 10)
       JOIN LATERAL (
         SELECT a.id, a.en_tienda FROM aviso_promociones a
          WHERE a.negocio_id = pa.negocio_id AND a.created_at <= (pa.created_at AT TIME ZONE 'UTC')
          ORDER BY a.created_at DESC, a.id DESC LIMIT 1
       ) av ON av.en_tienda
      WHERE pa.negocio_id IS NOT NULL
        AND pa.datos->>'canal' = 'tienda_online'
        AND pa.estado NOT IN ('cancelado', 'pendiente_pago')
        AND pa.created_at > (NOW() AT TIME ZONE 'UTC') - $1::interval
        AND NOT EXISTS (SELECT 1 FROM cliente_consentimientos cc
                         WHERE cc.negocio_id = c.negocio_id AND cc.cliente_id = c.id AND cc.canal = 'whatsapp')
      ORDER BY c.id, pa.created_at ASC
     ON CONFLICT DO NOTHING`, [ventana]);
  if (rowCount) console.log(`[AVISO] ${rowCount} aceptación(es) de promociones al pedir en la tienda`);
  return rowCount;
}
