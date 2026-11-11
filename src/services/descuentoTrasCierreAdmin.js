/**
 * descuentoTrasCierreAdmin.js — el botón del panel para encender y apagar el
 * descuento a quien escribió con el negocio cerrado (Tienda → Promociones).
 *
 * Pedido de Mario (11-nov-2026): «deberías poner un botón, nada en código».
 * Hace lo mismo que `activar` / `desactivar` del script de operación
 * (scripts/ops/descuento-tras-cierre-2026-11/descuento.mjs), con sus mismas
 * protecciones:
 *
 *   Encender: si el negocio ya tiene la promoción DOMINGO15 la usa (y la
 *   reactiva si estaba inactiva); si no, la crea con lo que decidió Mario:
 *   15 %, un uso por cliente, solo tienda en línea, no acumulable, sin límite
 *   total y sin fecha de fin (la pone el job en cada tanda: 7 días). Escribe
 *   `cerrado_descuento_codigo` y, DENTRO de la misma transacción, le pregunta
 *   al job real si podría mandar. Si no podría (sin horario propio, tienda sin
 *   publicar, promoción que no sirve), no guarda nada y dice por qué.
 *
 *   Apagar: borra la clave; el job deja de mandar. La promoción sigue viva:
 *   a quien ya recibió el código le vale hasta la fecha que se le dijo.
 *
 * No manda nada a nadie: los envíos los hace solo el job (descuentoTrasCierre.js).
 */
import { pool as poolApp } from './database.js';
import { obtenerConfigTienda } from './tiendaOnline.js';
import { evaluarNegocio, reglasPropias, revisarCodigo } from './descuentoTrasCierre.js';
import { CLAVE_CODIGO, DIAS_VIGENCIA_CODIGO, codigoConfigurado } from './descuentoTrasCierrePolitica.js';

export const CODIGO_POR_OMISION = 'DOMINGO15';
export const PORCENTAJE_POR_OMISION = 15;
const PREFIJO = '[DESCUENTO-CIERRE]';

// Lo que el job no podría arreglar solo, dicho para quien está en el panel.
// «cerrado_ahora» no está: es lo normal si se enciende en domingo, y el job
// manda al abrir.
export const POR_QUE_NO = Object.freeze({
  sin_horario_propio: 'Primero guarda tu horario de atención en Configuración: sin él no sabemos cuándo estuviste cerrado.',
  codigo_no_vigente: 'La promoción del código no se puede usar en la tienda en línea (es automática, es de otro canal, aún no empieza o ya no tiene cupo). Revísala en la lista de promociones.',
  promocion_que_no_se_dice: 'La promoción del código no es de porcentaje ni de monto fijo: el mensaje no podría decir cuánto descuenta.',
  tienda_sin_publicar: 'Publica tu tienda en línea: el código solo se puede usar ahí.',
});

export class ErrorDescuentoCierre extends Error {
  constructor(codigo, mensaje) { super(mensaje); this.codigo = codigo; }
}

const SQL_PROMO = `
  SELECT id, nombre, codigo, tipo, valor, activa, automatica, usos, limite_por_cliente, vigencia_hasta
    FROM tienda_promociones WHERE negocio_id = $1 AND lower(codigo) = lower($2)
   ORDER BY created_at DESC LIMIT 1`;

async function codigoGuardado(db, negocioId) {
  const { rows: [r] } = await db.query('SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2', [negocioId, CLAVE_CODIGO]);
  return codigoConfigurado({ [CLAVE_CODIGO]: r?.valor });
}

const promoParaElPanel = (p) => (p ? {
  id: p.id, nombre: p.nombre, codigo: p.codigo, tipo: p.tipo, valor: Number(p.valor), activa: p.activa === true,
  usos: Number(p.usos) || 0, limitePorCliente: p.limite_por_cliente ?? null,
  vigenciaHasta: p.vigencia_hasta ? new Date(p.vigencia_hasta).toISOString() : null,
} : null);

/** Lo que muestra la tarjeta del panel. Solo lee. */
export async function estadoDescuentoTrasCierre(negocioId, { db = poolApp, ahora = new Date(), leerTienda = obtenerConfigTienda } = {}) {
  const tienda = await leerTienda(negocioId);
  const codigo = await codigoGuardado(db, negocioId);
  const { rows: [promo] } = await db.query(SQL_PROMO, [negocioId, codigo || CODIGO_POR_OMISION]);
  const { rows: [envios] } = await db.query(`
    SELECT COUNT(*) FILTER (WHERE estado = 'aceptado')::int AS aceptados,
           COUNT(*) FILTER (WHERE estado = 'fallido')::int AS fallidos,
           MAX(created_at) AS ultimo
      FROM descuento_tras_cierre_envios WHERE negocio_id = $1`, [negocioId]);
  let job = null;
  if (codigo) {
    const ev = await evaluarNegocio(db, negocioId, codigo, { ahora, leerTienda });
    // Con el negocio cerrado el job no llega a revisar el código ni la tienda:
    // se revisan aquí, para avisar el domingo y no el lunes a las 7:30.
    let razon = ev.razon;
    if (razon === 'cerrado_ahora') {
      const rc = await revisarCodigo(db, negocioId, codigo, { ahora });
      if (rc.razon !== 'listo') razon = rc.razon;
      else if (tienda?.estado !== 'publicada') razon = 'tienda_sin_publicar';
    }
    job = {
      listo: ev.listo === true, razon,
      porMandar: (ev.decisiones || []).filter((d) => d.enviar).length,
      problema: razon === 'codigo_no_vigente' && promo && promo.activa !== true
        ? `La promoción ${promo.codigo} está desactivada en la lista de promociones: mientras siga así no se manda nada.`
        : POR_QUE_NO[razon] || null,
    };
  }
  return {
    encendido: Boolean(codigo),
    codigo: codigo || CODIGO_POR_OMISION,
    porcentajeNuevo: PORCENTAJE_POR_OMISION,
    diasVigencia: DIAS_VIGENCIA_CODIGO,
    tiendaPublicada: tienda?.estado === 'publicada',
    horarioPropio: Boolean(await reglasPropias(db, negocioId)),
    promo: promoParaElPanel(promo),
    job,
    enviados: {
      aceptados: envios?.aceptados || 0, fallidos: envios?.fallidos || 0,
      ultimo: envios?.ultimo ? new Date(envios.ultimo).toISOString() : null,
    },
  };
}

/**
 * Enciende el descuento del negocio. Todo o nada: si el job no podría mandar,
 * lanza ErrorDescuentoCierre y no queda guardado nada.
 */
export async function encenderDescuentoTrasCierre(negocioId, {
  pool = poolApp, usuarioId = null, ahora = new Date(), leerTienda = obtenerConfigTienda, log = console.log,
} = {}) {
  const tienda = await leerTienda(negocioId);
  if (tienda?.estado !== 'publicada') throw new ErrorDescuentoCierre('tienda_sin_publicar', POR_QUE_NO.tienda_sin_publicar);
  const codigo = CODIGO_POR_OMISION;
  const c = await pool.connect();
  let promocion;
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout = '5s'");
    const { rows: [existente] } = await c.query(SQL_PROMO, [negocioId, codigo]);
    if (existente) {
      promocion = { id: existente.id, creada: false, reactivada: existente.activa !== true };
      // Quien la apagó desde la lista y luego pulsa «Encender» quiere que
      // funcione: se reactiva. Lo demás de la promoción no se toca.
      if (promocion.reactivada) {
        await c.query('UPDATE tienda_promociones SET activa = true, updated_at = now() WHERE id = $1 AND negocio_id = $2', [existente.id, negocioId]);
      }
    } else {
      const { rows: [nueva] } = await c.query(`
        INSERT INTO tienda_promociones (negocio_id, nombre, tipo, codigo, automatica, valor, minimo_compra,
               limite_por_cliente, solo_primera_compra, canales, acumulable, prioridad, activa)
        VALUES ($1, $2, 'porcentaje', $3, false, $4, 0, 1, false, '["tienda_online"]'::jsonb, false, 100, true)
        RETURNING id`, [negocioId, `Disculpa por cierre (${PORCENTAJE_POR_OMISION} %)`, codigo, PORCENTAJE_POR_OMISION]);
      promocion = { id: nueva.id, creada: true, reactivada: false };
    }
    await c.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, $2, $3)
                   ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = EXCLUDED.valor`, [negocioId, CLAVE_CODIGO, codigo]);
    // El código se revisa a cualquier hora (también en domingo, cuando el job
    // contestaría «cerrado» sin mirarlo); después, el job completo.
    const rc = await revisarCodigo(c, negocioId, codigo, { ahora });
    if (rc.razon !== 'listo') throw new ErrorDescuentoCierre(rc.razon, POR_QUE_NO[rc.razon]);
    const ev = await evaluarNegocio(c, negocioId, codigo, { ahora, leerTienda });
    if (POR_QUE_NO[ev.razon]) throw new ErrorDescuentoCierre(ev.razon, POR_QUE_NO[ev.razon]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  log(`${PREFIJO} negocio=${negocioId} ENCENDIDO desde el panel por usuario=${usuarioId ?? '?'} (código ${codigo}, promoción ${promocion.creada ? 'creada' : promocion.reactivada ? 'reactivada' : 'existente'})`);
  return { promocion, estado: await estadoDescuentoTrasCierre(negocioId, { db: pool, ahora, leerTienda }) };
}

/** Apaga el descuento: el job deja de mandar. La promoción se queda como está. */
export async function apagarDescuentoTrasCierre(negocioId, {
  pool = poolApp, usuarioId = null, ahora = new Date(), leerTienda = obtenerConfigTienda, log = console.log,
} = {}) {
  const { rowCount } = await pool.query('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2', [negocioId, CLAVE_CODIGO]);
  if (rowCount) log(`${PREFIJO} negocio=${negocioId} APAGADO desde el panel por usuario=${usuarioId ?? '?'}`);
  return { estado: await estadoDescuentoTrasCierre(negocioId, { db: pool, ahora, leerTienda }) };
}
