// metaDesconexion.js — desconectar el WhatsApp de un negocio de Xabor sin
// tocar los activos del negocio.
//
// Hoy no existe una desconexión: «Suspender» y «Eliminar credenciales»
// conservan el phone_number_id en la fila, y un número que aparece en
// cualquier fila de otro negocio no se puede volver a conectar (el callback
// responde 409). Este módulo hace la desconexión completa y ordenada:
//
//   1. Le pide a Meta que deje de mandarle a Xabor los webhooks de esa WABA
//      (DELETE /{WABA_ID}/subscribed_apps, con la credencial del negocio).
//      Es lo único que se le pide a Meta. Si Meta no responde, se sigue: la
//      desconexión en Xabor no puede depender de la red.
//   2. En UNA transacción: borra la credencial cifrada, deja la integración
//      en 'desconectado' (activo = false, ya no enruta ni envía) y LIBERA el
//      phone_number_id, para que el mismo número pueda reconectarse aquí o en
//      otro negocio. El id anterior queda guardado en
//      configuracion.desconexion para soporte.
//   3. Deja constancia en auditoria_plataforma (sin token, sin PIN).
//
// Lo que NO hace, a propósito:
//   - NO llama a /deregister: eso quitaría el número de la Cloud API y, en
//     coexistencia, puede afectar al teléfono del negocio. El número, la WABA,
//     el portafolio y la página siguen siendo del negocio, intactos.
//   - NO apaga el bot ni toca pedidos, conversaciones o historial.
//   - NO borra la fila: la auditoría y el historial la referencian.
//
// Para retirar por completo el acceso de Xabor, el negocio puede además
// quitar a Xabor como socio desde la configuración de su portafolio en Meta
// (eso lo hace el negocio, no Xabor).
import { pool as poolApp, registrarAuditoriaSecundaria, normalizarActor } from './database.js';
import { descifrarSecretoIntegracion } from './cifradoIntegraciones.js';
import { activoParaEstadoWhatsapp } from './estadoIntegracionWhatsapp.js';
import { llamarGraph, esIdGraph } from './metaGraph.js';

export const PREFIJO_LIBERADO = 'liberado:';
export const CONFIRMACION_REQUERIDA = 'DESCONECTAR';

/** Retira la suscripción de la app a la WABA. Nunca lanza. */
export async function retirarSuscripcionWaba({ wabaId, accessToken, fetchImpl } = {}) {
  if (!esIdGraph(wabaId) || typeof accessToken !== 'string' || !accessToken) {
    return { ok: false, omitido: true, motivo: 'sin_waba_o_credencial' };
  }
  // Sin atajo «simulado»: si Meta (o el Graph de pruebas) no confirma, se
  // reporta como no retirada. Un éxito inventado escondería webhooks vivos.
  const r = await llamarGraph({ metodo: 'DELETE', ruta: `${wabaId.trim()}/subscribed_apps`, token: accessToken, fetchImpl });
  if (r.ok && r.datos?.success === true) return { ok: true };
  return { ok: false, motivo: 'meta_rechazo', error: r.error };
}

/**
 * Desconecta el WhatsApp (proveedor 'meta') del negocio.
 *
 * @param {string} negocioId  SIEMPRE de la sesión o de la ruta de Superadmin
 * @param {object} actor      { superadminId } o { actorUsuarioId }
 * @param {object} [o]
 * @param {string} [o.motivo] texto corto para la auditoría
 * @param {object} [o.db]     pool inyectable (pruebas)
 * @param {Function} [o.fetchImpl]
 */
export async function desconectarWhatsappNegocio(negocioId, actor, { motivo = null, db = poolApp, fetchImpl } = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return { ok: false, error: 'negocioId inválido' };
  const id = negocioId.trim();
  const { superadminId, actorUsuarioId, actualizadoPorId } = normalizarActor(actor);

  const { rows } = await db.query(
    `SELECT ic.id, ic.identificador, ic.waba_id, ic.estado, ic.connection_mode,
            cc.access_token_cifrado, cc.token_iv, cc.token_auth_tag, cc.token_formato_version
       FROM integraciones_canal ic
       LEFT JOIN integraciones_canal_credenciales cc ON cc.integracion_id = ic.id
      WHERE ic.negocio_id = $1 AND ic.canal = 'whatsapp' AND ic.proveedor = 'meta'`,
    [id]);
  const fila = rows[0];
  if (!fila) return { ok: false, error: 'Este negocio no tiene WhatsApp conectado' };
  const yaLiberado = String(fila.identificador || '').startsWith(PREFIJO_LIBERADO);
  if (fila.estado === 'desconectado' && yaLiberado && !fila.access_token_cifrado) {
    return { ok: true, yaEstabaDesconectado: true, estado: 'desconectado' };
  }

  // Paso 1 — Meta (fuera de la transacción: no se retiene una conexión de la
  // base esperando a la red).
  let accessToken = null;
  if (fila.access_token_cifrado) {
    try {
      accessToken = descifrarSecretoIntegracion({
        cifrado: fila.access_token_cifrado, iv: fila.token_iv,
        authTag: fila.token_auth_tag, version: fila.token_formato_version,
      });
    } catch {
      accessToken = null; // credencial ilegible: se desconecta igual en Xabor
    }
  }
  const retiro = await retirarSuscripcionWaba({ wabaId: fila.waba_id, accessToken, fetchImpl });

  // Paso 2 — Xabor, todo o nada.
  const identificadorAnterior = yaLiberado ? null : fila.identificador;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id = $1`, [fila.id]);
    // La credencial heredada (configuracion.int_wa_*) también se retira. Solo
    // se anota que existía, nunca su valor.
    const textoPlano = await client.query(
      `DELETE FROM configuracion WHERE negocio_id = $1 AND clave IN ('int_wa_token', 'int_wa_phone_id') RETURNING clave`,
      [id]);
    const textoPlanoRetirado = textoPlano.rowCount > 0;
    await client.query(
      `UPDATE integraciones_canal SET
         estado = 'desconectado', activo = $2,
         identificador = $3,
         app_suscrita_waba = CASE WHEN $4 THEN FALSE ELSE app_suscrita_waba END,
         configuracion = jsonb_set(COALESCE(configuracion, '{}'::jsonb), '{desconexion}', $5::jsonb, true),
         actualizado_por = $6, updated_at = NOW()
       WHERE id = $1`,
      [fila.id, activoParaEstadoWhatsapp('desconectado'), `${PREFIJO_LIBERADO}${fila.id}`,
       retiro.ok === true,
       JSON.stringify({
         at: new Date().toISOString(),
         identificador_anterior: identificadorAnterior,
         waba_id: fila.waba_id || null,
         modo: fila.connection_mode || null,
         suscripcion_retirada: retiro.ok === true,
         texto_plano_retirado: textoPlanoRetirado,
         motivo: motivo ? String(motivo).slice(0, 200) : null,
       }),
       actualizadoPorId]);
    await registrarAuditoriaSecundaria({
      superadminId, actorUsuarioId,
      accion: 'integracion_whatsapp_desconectada',
      negocioId: id,
      estadoAnterior: { estado: fila.estado },
      estadoNuevo: { estado: 'desconectado', numeroLiberado: Boolean(identificadorAnterior) },
      contexto: {
        wabaId: fila.waba_id || null,
        connectionMode: fila.connection_mode || null,
        suscripcionRetirada: retiro.ok === true,
        textoPlanoRetirado,
        errorMeta: retiro.ok ? null : (retiro.error ? { codigo: retiro.error.codigo, status: retiro.error.status } : { motivo: retiro.motivo }),
        motivo: motivo ? String(motivo).slice(0, 200) : null,
      },
    }, client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return {
    ok: true,
    estado: 'desconectado',
    numeroLiberado: Boolean(identificadorAnterior),
    suscripcionRetirada: retiro.ok === true,
    // Sin credencial no se pudo avisar a Meta: los webhooks de esa WABA
    // pueden seguir llegando, pero ya no enrutan a ningún negocio.
    avisoMeta: retiro.ok ? null : 'No pudimos avisarle a Meta; Xabor ya no usará este número. Si quieres, quita a Xabor como socio desde tu portafolio de Meta.',
  };
}
