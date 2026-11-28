// metaPanelPlataforma.js — la vista de Xabor (Superadmin) sobre las
// integraciones de Meta de TODOS los negocios: quién está conectado, qué
// credencial vence, qué falló, cuántos formularios tiene y cuándo llegó el
// último mensaje. Solo lectura.
//
// Sirve para diagnosticar sin pedirle a nadie su contraseña de Facebook: todo
// lo que se muestra sale de la base de Xabor o de lecturas a Meta con la
// credencial que el propio negocio concedió.
//
// Nada de lo que devuelve contiene un token, un PIN ni el secreto de la app.
// El phone_number_id y el waba_id salen enmascarados (últimos 4), y esta
// vista nunca llega al panel de un negocio.
import { pool as poolApp } from './database.js';
import { esCodigoDeRechazo } from './credencialWhatsappPolitica.js';

const DIA_MS = 24 * 60 * 60 * 1000;
export const enmascarar = (v) => (v ? `…${String(v).slice(-4)}` : null);
export const DIAS_AVISO_VENCIMIENTO = 15;

/**
 * Alertas de UNA integración. Pura: recibe la fila ya leída y el reloj.
 * Cada alerta: { clave, nivel: 'critico'|'aviso', texto }.
 */
export function alertasDeIntegracion(f, ahora = new Date()) {
  const alertas = [];
  if (!f || !f.estado) return alertas;
  const venceMs = f.token_expira_at ? new Date(f.token_expira_at).getTime() - ahora.getTime() : null;

  if (f.estado === 'activo' && esCodigoDeRechazo(f.ultimo_error_codigo)) {
    alertas.push({ clave: 'credencial_rechazada', nivel: 'critico', texto: 'Meta rechaza la credencial: el bot no puede contestar. Requiere reconexión.' });
  }
  if (venceMs !== null && venceMs <= 0) {
    alertas.push({ clave: 'credencial_vencida', nivel: 'critico', texto: 'La credencial ya venció. Requiere reconexión.' });
  } else if (venceMs !== null && venceMs <= DIAS_AVISO_VENCIMIENTO * DIA_MS) {
    const dias = Math.max(1, Math.ceil(venceMs / DIA_MS));
    alertas.push({ clave: 'credencial_por_vencer', nivel: dias <= 3 ? 'critico' : 'aviso', texto: `La credencial vence en ${dias} día${dias === 1 ? '' : 's'}.` });
  }
  if (f.estado === 'activo' && !f.token_expira_at && f.tiene_credencial) {
    alertas.push({ clave: 'vencimiento_desconocido', nivel: 'aviso', texto: 'No sabemos cuándo vence la credencial (Meta no lo ha confirmado).' });
  }
  if (f.estado === 'pendiente_activacion') {
    alertas.push({ clave: 'activacion_pendiente', nivel: 'aviso', texto: 'La conexión quedó a medias: falta registrar el número o suscribir la cuenta.' });
  }
  if (f.estado === 'error') {
    alertas.push({ clave: 'estado_error', nivel: 'critico', texto: 'La última conexión falló.' });
  }
  if (f.estado === 'desconectado') {
    alertas.push({ clave: 'desconectado', nivel: 'aviso', texto: 'Desconectado: no recibe ni envía mensajes.' });
  }
  if (f.estado === 'activo' && f.app_suscrita_waba === false) {
    alertas.push({ clave: 'sin_suscripcion', nivel: 'critico', texto: 'La cuenta no está suscrita: Meta no le manda mensajes a Xabor.' });
  }
  if (f.estado === 'activo' && String(f.estado_nombre || '').toUpperCase() === 'REJECTED') {
    alertas.push({ clave: 'nombre_rechazado', nivel: 'aviso', texto: 'Meta rechazó el nombre visible.' });
  }
  return alertas;
}

/** Estado legible para la tabla de Superadmin. */
export function estadoLegible(f) {
  if (!f || !f.estado) return 'Sin WhatsApp';
  return ({
    activo: f.connection_mode === 'coexistence' ? 'Conectado (coexistencia)' : 'Conectado',
    pendiente_activacion: 'Activación pendiente',
    desconectado: 'Desconectado',
    suspendido: 'Suspendido',
    error: 'Error',
    no_configurado: 'Sin configurar',
    pendiente_configuracion: 'Configuración incompleta',
  })[f.estado] || f.estado;
}

/**
 * Resumen de todos los negocios. Devuelve { totales, negocios[] }.
 * @param {object} [o]
 * @param {object} [o.db]
 * @param {Date}   [o.ahora]
 */
export async function resumenIntegracionesMeta({ db = poolApp, ahora = new Date() } = {}) {
  const { rows } = await db.query(
    `SELECT n.id AS negocio_id, n.nombre, n.slug, n.activo AS negocio_activo, n.plan,
            n.bot_whatsapp_activo,
            ic.id AS integracion_id, ic.estado, ic.connection_mode, ic.identificador,
            ic.waba_id, ic.business_id, ic.display_phone_number, ic.verified_name, ic.estado_nombre,
            ic.app_suscrita_waba, ic.numero_registrado_cloud_api,
            ic.ultimo_error_codigo, ic.ultimo_error_at, ic.ultima_prueba_at, ic.ultima_prueba_ok,
            ic.conectado_at, ic.updated_at AS integracion_actualizada_at,
            (cc.integracion_id IS NOT NULL) AS tiene_credencial, cc.token_expira_at,
            (SELECT count(*)::int FROM configuracion c
              WHERE c.negocio_id = n.id AND c.clave LIKE 'whatsapp\\_flow\\_%\\_id'
                AND COALESCE(c.valor, '') <> '') AS formularios_configurados,
            (SELECT e.recibido_at FROM whatsapp_entradas e
              WHERE e.negocio_id = n.id ORDER BY e.id DESC LIMIT 1) AS ultimo_mensaje_at
       FROM negocios n
       LEFT JOIN integraciones_canal ic
              ON ic.negocio_id = n.id AND ic.canal = 'whatsapp' AND ic.proveedor = 'meta'
       LEFT JOIN integraciones_canal_credenciales cc ON cc.integracion_id = ic.id
      ORDER BY n.nombre`);

  const negocios = rows.map(f => {
    const alertas = alertasDeIntegracion(f, ahora);
    const liberado = String(f.identificador || '').startsWith('liberado:');
    return {
      negocioId: f.negocio_id,
      nombre: f.nombre,
      slug: f.slug,
      negocioActivo: f.negocio_activo,
      plan: f.plan || null,
      botActivo: Boolean(f.bot_whatsapp_activo),
      whatsapp: f.estado ? {
        estado: f.estado,
        estadoLegible: estadoLegible(f),
        modo: f.connection_mode || 'cloud_api',
        numero: f.display_phone_number || null,
        nombreVisible: f.verified_name || null,
        estadoNombre: f.estado_nombre || null,
        // Enmascarados a los últimos 4, igual que la ficha de Superadmin
        // (database.js, obtenerFichaNegocio): basta para cruzarlos con Meta.
        phoneNumberId: liberado ? null : enmascarar(f.identificador),
        wabaId: enmascarar(f.waba_id),
        businessId: enmascarar(f.business_id),
        appSuscrita: Boolean(f.app_suscrita_waba),
        numeroRegistrado: Boolean(f.numero_registrado_cloud_api),
        tieneCredencial: Boolean(f.tiene_credencial),
        credencialVence: f.token_expira_at || null,
        ultimoError: f.ultimo_error_codigo || null,
        ultimoErrorAt: f.ultimo_error_at || null,
        ultimaPruebaAt: f.ultima_prueba_at || null,
        ultimaPruebaOk: f.ultima_prueba_ok ?? null,
        conectadoAt: f.conectado_at || null,
      } : null,
      formulariosConfigurados: f.formularios_configurados || 0,
      ultimoMensajeAt: f.ultimo_mensaje_at || null,
      alertas,
    };
  });

  const conWa = negocios.filter(n => n.whatsapp);
  const totales = {
    negocios: negocios.length,
    negociosActivos: negocios.filter(n => n.negocioActivo).length,
    conectados: conWa.filter(n => n.whatsapp.estado === 'activo').length,
    coexistencia: conWa.filter(n => n.whatsapp.estado === 'activo' && n.whatsapp.modo === 'coexistence').length,
    pendientes: conWa.filter(n => ['pendiente_activacion', 'pendiente_configuracion', 'error'].includes(n.whatsapp.estado)).length,
    desconectados: conWa.filter(n => n.whatsapp.estado === 'desconectado').length,
    sinWhatsapp: negocios.length - conWa.length,
    conFormularios: negocios.filter(n => n.formulariosConfigurados > 0).length,
    alertasCriticas: negocios.reduce((s, n) => s + n.alertas.filter(a => a.nivel === 'critico').length, 0),
    porVencer: negocios.filter(n => n.alertas.some(a => a.clave === 'credencial_por_vencer' || a.clave === 'credencial_vencida')).length,
  };
  return { generadoAt: ahora.toISOString(), totales, negocios };
}
