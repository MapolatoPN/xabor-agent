/**
 * descuentoTrasCierre.js — al abrir, el descuento para quien escribió en
 * horario habitual un día que estuvimos cerrados.
 *
 * Decisión de Mario (10-nov-2026), empezando por Acuña. QUIÉN y QUÉ TEXTO lo
 * decide descuentoTrasCierrePolitica.js (puro y probado sin base); aquí están
 * la lectura, la reserva y el envío.
 *
 * Corre cada minuto en segundo plano (server.js), nunca en el camino del
 * webhook, recibe el envío y el panel por parámetro y NUNCA lanza. No toca
 * whatsapp-meta.js ni el estado del bot: solo escribe su bitácora (136) y el
 * mensaje en el chat, como cualquier mensaje del bot.
 *
 * Falla cerrado en cada paso: sin código configurado, sin la promoción viva
 * en la tienda, sin tienda publicada, con el negocio cerrado o fuera de la
 * ventana de 24 h, no sale nada. Cada teléfono lo recibe UNA sola vez: la
 * fila de la 136 se aparta ANTES de enviar (UNIQUE por negocio y teléfono), así
 * que ni dos instancias durante un despliegue ni un reintento lo duplican. Un
 * envío fallido no se reintenta.
 */
import { pool as poolApp, guardarMensaje } from './database.js';
import { cargarReglas, validarEstructuraReglas } from '../agent/prompts.js';
import { obtenerConfigTienda } from './tiendaOnline.js';
import { TZ_DEFAULT, esZonaValida, fechaHoyEn, minutosDelDiaEn } from './zonaHoraria.js';
import { instanteDeVigencia } from './vigenciaPromos.js';
import {
  CLAVE_CODIGO, VENTANA_CLIENTE_HORAS, TIPOS_QUE_SE_DICEN,
  codigoConfigurado, cuandoFue, decidirEnvio, estabaAbierto, llegoCerradoEnHorarioHabitual,
  telefonoEnmascarado, textoDelDescuento, venceEl,
} from './descuentoTrasCierrePolitica.js';

export const MAX_ENVIOS_POR_CORRIDA = 30;
const PREFIJO = '[DESCUENTO-CIERRE]';

// Un mismo aviso de configuración (código vencido, tienda sin publicar) sale
// en el log a lo más una vez por hora y negocio, no cada minuto.
const avisados = new Map();
function avisarUnaVez(log, clave, texto, ahoraMs) {
  const antes = avisados.get(clave);
  if (antes && ahoraMs - antes < 3600000) return;
  avisados.set(clave, ahoraMs);
  log(`${PREFIJO} ${texto}`);
}

// La promoción del código, tal como la aplicaría la tienda en línea HOY: con
// código, activa, para la tienda, vigente y con cupo. Sin ella no se promete.
// La vigencia de ARRIBA no se mira aquí: la pone el job. Cada tanda la lleva a
// 7 días después de su envío (nunca la acorta), así que un código vencido
// desde el domingo anterior vuelve a valer para los nuevos. Para apagarlo de
// verdad: quitar la bandera o desactivar la promoción.
const SQL_PROMO = `
  SELECT id, codigo, tipo, valor, vigencia_hasta FROM tienda_promociones
   WHERE negocio_id = $1 AND lower(codigo) = lower($2) AND activa AND NOT automatica
     AND canales @> '["tienda_online"]'::jsonb
     AND (vigencia_desde IS NULL OR vigencia_desde <= $3::timestamptz)
     AND (limite_usos IS NULL OR usos < limite_usos)
   ORDER BY created_at DESC LIMIT 1`;

// Lleva la vigencia al final del día en que vence el código que se manda hoy.
// Solo la alarga: si ya vale más (porque alguien la puso más larga), se queda.
const SQL_ALARGAR_VIGENCIA = `
  UPDATE tienda_promociones SET vigencia_hasta = $2::timestamptz, updated_at = now()
   WHERE id = $1 AND (vigencia_hasta IS NULL OR vigencia_hasta < $2::timestamptz)`;

// `mensajes.timestamp` es TIMESTAMP sin zona, en UTC: la fecha y el minuto
// LOCALES se calculan aquí, en SQL, con la zona del negocio. El filtro compara
// contra la columna sin envolverla, para que use su índice.
const SQL_ENTRANTES = `
  SELECT m.telefono,
         (extract(epoch FROM (m."timestamp" AT TIME ZONE 'UTC')) * 1000)::bigint AS at,
         to_char((m."timestamp" AT TIME ZONE 'UTC') AT TIME ZONE $3, 'YYYY-MM-DD') AS fecha,
         (extract(hour FROM (m."timestamp" AT TIME ZONE 'UTC') AT TIME ZONE $3) * 60
          + extract(minute FROM (m."timestamp" AT TIME ZONE 'UTC') AT TIME ZONE $3))::int AS minuto
    FROM mensajes m
   WHERE m.negocio_id = $1 AND m.direccion = 'entrante'
     AND m."timestamp" >  ($2::timestamptz AT TIME ZONE 'UTC') - interval '${VENTANA_CLIENTE_HORAS} hours'
     AND m."timestamp" <= ($2::timestamptz AT TIME ZONE 'UTC')
   ORDER BY m.telefono, m."timestamp", m.id`;

// Los hechos de UN teléfono entre su primer mensaje en el cierre ($3) y
// «ahora» ($4). La cota de arriba no cambia nada en vivo (no hay hechos
// futuros); permite repasar un día pasado con el mismo criterio.
const SQL_HECHOS = `
  SELECT
    EXISTS (SELECT 1 FROM descuento_tras_cierre_envios e WHERE e.negocio_id = $1 AND e.telefono = $2) AS ya_enviado,
    (EXISTS (SELECT 1 FROM mensajes h
              WHERE h.negocio_id = $1 AND h.telefono = $2 AND h.direccion = 'saliente' AND h.origen = 'humano'
                AND h."timestamp" >= ($3::timestamptz AT TIME ZONE 'UTC') AND h."timestamp" <= ($4::timestamptz AT TIME ZONE 'UTC'))
     OR EXISTS (SELECT 1 FROM clientes c
                 WHERE c.negocio_id = $1 AND c.telefono = $2
                   AND c.last_business_app_message_at >= $3::timestamptz AND c.last_business_app_message_at <= $4::timestamptz)
    ) AS humano_despues,
    (EXISTS (SELECT 1 FROM pedidos_activos pa
               CROSS JOIN LATERAL (VALUES (pa.datos->'cliente'->>'telefono'), (pa.datos->>'telefono_conversacion')) x(tel)
              WHERE pa.negocio_id = $1 AND x.tel IS NOT NULL
                AND pa.created_at >= ($3::timestamptz AT TIME ZONE 'UTC') AND pa.created_at <= ($4::timestamptz AT TIME ZONE 'UTC')
                AND right(regexp_replace(x.tel, '\\D', '', 'g'), 10) = right(regexp_replace($2, '\\D', '', 'g'), 10))
     OR EXISTS (SELECT 1 FROM pedidos_programados pr
               CROSS JOIN LATERAL (VALUES (pr.datos->'cliente'->>'telefono'), (pr.datos->>'telefono_conversacion')) x(tel)
              WHERE pr.negocio_id = $1 AND x.tel IS NOT NULL
                AND pr.created_at >= ($3::timestamptz AT TIME ZONE 'UTC') AND pr.created_at <= ($4::timestamptz AT TIME ZONE 'UTC')
                AND right(regexp_replace(x.tel, '\\D', '', 'g'), 10) = right(regexp_replace($2, '\\D', '', 'g'), 10))
    ) AS pedido_despues,
    (COALESCE((SELECT cc.bot_pausado FROM conversaciones_control cc WHERE cc.negocio_id = $1 AND cc.telefono = $2), false)
     OR COALESCE((SELECT c.human_takeover_until > $4::timestamptz FROM clientes c
                   WHERE c.negocio_id = $1 AND c.telefono = $2), false)) AS pausado,
    COALESCE((SELECT w.requiere_revision FROM whatsapp_conversaciones w
               WHERE w.negocio_id = $1 AND w.telefono = $2), false) AS en_revision`;

const SQL_APARTAR = `
  INSERT INTO descuento_tras_cierre_envios (negocio_id, telefono, codigo, mensaje_cliente_at, estado)
  VALUES ($1, $2, $3, $4::timestamptz, 'enviando')
  ON CONFLICT (negocio_id, telefono) DO NOTHING
  RETURNING id`;

export function enlaceDeLaTienda(configTienda, { baseUrl = process.env.PUBLIC_URL || 'https://xabor.mx' } = {}) {
  if (configTienda?.estado !== 'publicada' || !configTienda?.slug) return null;
  return `${String(baseUrl).replace(/\/+$/, '')}/t/${encodeURIComponent(configTienda.slug)}`;
}

/** Sus mensajes de las últimas 24 h, agrupados por teléfono y en orden. */
export async function leerEntrantes(db, negocioId, ahora, zona) {
  const { rows } = await db.query(SQL_ENTRANTES, [negocioId, ahora.toISOString(), zona]);
  const porTelefono = new Map();
  for (const r of rows) {
    const lista = porTelefono.get(r.telefono) || [];
    lista.push({ at: Number(r.at), fecha: r.fecha, minuto: Number(r.minuto) });
    porTelefono.set(r.telefono, lista);
  }
  return porTelefono;
}

async function leerHechos(db, negocioId, telefono, desdeMs, ahora) {
  const { rows: [h] } = await db.query(SQL_HECHOS,
    [negocioId, telefono, new Date(desdeMs).toISOString(), ahora.toISOString()]);
  return {
    yaEnviado: h.ya_enviado === true, humanoDespues: h.humano_despues === true,
    pedidoDespues: h.pedido_despues === true, pausado: h.pausado === true, enRevision: h.en_revision === true,
  };
}

/**
 * Las reglas del negocio solo si tiene SU horario guardado y bien formado.
 * cargarReglas cae a un horario genérico (lunes a sábado 9:00–20:00) cuando
 * no lo tiene: con ese horario se mandarían descuentos a deshoras.
 */
export async function reglasPropias(db, negocioId) {
  const { rows: [r] } = await db.query(
    "SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'reglas_atencion'", [negocioId]);
  let crudo = null;
  try { crudo = r?.valor ? JSON.parse(r.valor) : null; } catch { crudo = null; }
  if (!crudo || !validarEstructuraReglas(crudo)) return null;
  return cargarReglas(negocioId);
}

/**
 * Quién califica y qué se decide con cada uno en el instante `ahora`, sin
 * escribir ni enviar nada y sin mirar la promoción ni la tienda. La usan el
 * job (a través de evaluarNegocio) y el lector de producción que repasa un
 * día pasado.
 */
export async function decisionesDelNegocio(db, negocioId, reglas, { ahora = new Date() } = {}) {
  const zona = esZonaValida(reglas?.timezone) ? reglas.timezone : TZ_DEFAULT;
  const entrantes = await leerEntrantes(db, negocioId, ahora, zona);
  const decisiones = [];
  for (const [telefono, lista] of entrantes) {
    // Lo barato primero: sin un mensaje en el cierre no hay nada que leer.
    const primero = lista.find((m) => llegoCerradoEnHorarioHabitual(reglas, m.fecha, m.minuto));
    if (!primero) continue;
    const hechos = await leerHechos(db, negocioId, telefono, primero.at, ahora);
    decisiones.push({ telefono, ...decidirEnvio({ telefono, entrantes: lista, ...hechos }, { reglas, ahoraMs: ahora.getTime() }) });
  }
  return decisiones;
}

/**
 * Lo que haría con UN negocio en este instante, sin escribir ni enviar nada.
 * Devuelve { listo, razon, codigo, promo, enlace, fechaHoy, decisiones: [{telefono, enviar, razon, primero}] }.
 */
export async function evaluarNegocio(db, negocioId, codigo, {
  ahora = new Date(), leerReglas = (nid) => reglasPropias(db, nid), leerTienda = obtenerConfigTienda,
} = {}) {
  const reglas = await leerReglas(negocioId);
  if (!reglas) return { codigo, fechaHoy: null, decisiones: [], listo: false, razon: 'sin_horario_propio' };
  const zona = esZonaValida(reglas?.timezone) ? reglas.timezone : TZ_DEFAULT;
  const fechaHoy = fechaHoyEn(zona, ahora);
  const base = { codigo, fechaHoy, zona, decisiones: [] };
  if (!estabaAbierto(reglas, fechaHoy, minutosDelDiaEn(zona, ahora))) return { ...base, listo: false, razon: 'cerrado_ahora' };
  const { rows: [promo] } = await db.query(SQL_PROMO, [negocioId, codigo, ahora.toISOString()]);
  if (!promo) return { ...base, listo: false, razon: 'codigo_no_vigente' };
  if (!TIPOS_QUE_SE_DICEN.includes(promo.tipo) || !(Number(promo.valor) > 0)) {
    return { ...base, promo, listo: false, razon: 'promocion_que_no_se_dice' };
  }
  const enlace = enlaceDeLaTienda(await leerTienda(negocioId));
  if (!enlace) return { ...base, promo, listo: false, razon: 'tienda_sin_publicar' };
  const decisiones = await decisionesDelNegocio(db, negocioId, reglas, { ahora });
  return { ...base, promo, enlace, listo: true, razon: 'listo', decisiones };
}

async function marcar(db, id, estado, { wamid = null, error = null } = {}) {
  await db.query(`UPDATE descuento_tras_cierre_envios SET estado = $2, wamid = $3, error = $4, actualizado_at = now()
                   WHERE id = $1`, [id, estado, wamid, error ? String(error).slice(0, 300) : null]);
}

/**
 * Una corrida. Nunca lanza.
 * `enviar(negocioId, telefono, texto)` devuelve el wamid si Meta aceptó, null
 * si el negocio no tiene WhatsApp propio, y lanza si Meta lo rechaza.
 *
 * `antesDeApartar(negocioId, telefono)` existe solo para las pruebas de
 * carrera: corre entre la decisión y la reserva, que es la ventana en la que
 * otra instancia puede adelantarse.
 */
export async function enviarDescuentosTrasCierre({
  db = poolApp, enviar = null, broadcastPanel = null, log = console.warn, ahora = new Date(),
  negocioId = null, maxEnvios = MAX_ENVIOS_POR_CORRIDA, leerReglas = (nid) => reglasPropias(db, nid),
  leerTienda = obtenerConfigTienda, guardar = guardarMensaje, antesDeApartar = null,
} = {}) {
  const resumen = { negocios: 0, enviados: 0, fallidos: 0, omitidos: {} };
  const omitir = (razon) => { resumen.omitidos[razon] = (resumen.omitidos[razon] || 0) + 1; };
  if (typeof enviar !== 'function') return resumen;
  let banderas;
  try {
    ({ rows: banderas } = await db.query(
      `SELECT negocio_id, valor FROM configuracion
        WHERE clave = $1 AND btrim(COALESCE(valor, '')) <> '' AND ($2::uuid IS NULL OR negocio_id = $2::uuid)`,
      [CLAVE_CODIGO, negocioId]));
  } catch (e) {
    log(`${PREFIJO} no se pudo leer la configuración (no afecta al bot): ${e.message}`);
    return resumen;
  }

  for (const { negocio_id: nid, valor } of banderas) {
    const codigo = codigoConfigurado({ [CLAVE_CODIGO]: valor });
    if (!codigo) { avisarUnaVez(log, `${nid}:codigo`, `negocio=${nid} ${CLAVE_CODIGO} no es un código válido: no se envía`, ahora.getTime()); continue; }
    resumen.negocios++;
    let ev;
    try {
      ev = await evaluarNegocio(db, nid, codigo, { ahora, leerReglas, leerTienda });
    } catch (e) {
      log(`${PREFIJO} negocio=${nid} no se pudo evaluar: ${e.message}`);
      continue;
    }
    if (!ev.listo) {
      if (ev.razon !== 'cerrado_ahora') {
        avisarUnaVez(log, `${nid}:${ev.razon}`, `negocio=${nid} código ${codigo}: ${ev.razon} — no se envía`, ahora.getTime());
      }
      omitir(ev.razon);
      continue;
    }
    // Antes de mandar: el código tiene que valer hasta la fecha que dice el
    // mensaje. Si no se pudo alargar la vigencia, no se manda nada a nadie:
    // se le prometería una fecha que la tienda no respetaría.
    const vence = venceEl(ev.fechaHoy);
    if (ev.decisiones.some((d) => d.enviar)) {
      try {
        await db.query(SQL_ALARGAR_VIGENCIA, [ev.promo.id, instanteDeVigencia(vence, ev.zona, 'hasta')]);
      } catch (e) {
        log(`${PREFIJO} negocio=${nid} no se pudo poner la vigencia del código ${codigo} (no se envía): ${e.message}`);
        for (const d of ev.decisiones) omitir(d.enviar ? 'vigencia_sin_poner' : d.razon);
        continue;
      }
    }
    for (const d of ev.decisiones) {
      if (!d.enviar) { omitir(d.razon); continue; }
      if (resumen.enviados + resumen.fallidos >= maxEnvios) { omitir('tope_por_corrida'); continue; }
      const texto = textoDelDescuento({ codigo: ev.promo.codigo, tipo: ev.promo.tipo, valor: ev.promo.valor,
        enlace: ev.enlace, cuando: cuandoFue(d.primero.fecha, ev.fechaHoy), vence });
      if (!texto) { omitir('sin_texto'); continue; }
      let id = null;
      try {
        if (antesDeApartar) await antesDeApartar(nid, d.telefono);
        const { rows: [fila] } = await db.query(SQL_APARTAR, [nid, d.telefono, ev.promo.codigo, new Date(d.primero.at).toISOString()]);
        id = fila?.id ?? null;
      } catch (e) {
        log(`${PREFIJO} negocio=${nid} telefono=${telefonoEnmascarado(d.telefono)} no se pudo apartar: ${e.message}`);
        omitir('error');
        continue;
      }
      if (!id) { omitir('ya_enviado'); continue; }
      let wamid = null;
      try {
        wamid = await enviar(nid, d.telefono, texto);
      } catch (e) {
        resumen.fallidos++;
        await marcar(db, id, 'fallido', { error: e.message }).catch(() => {});
        log(`${PREFIJO} negocio=${nid} telefono=${telefonoEnmascarado(d.telefono)} Meta lo rechazó: ${String(e.message).slice(0, 200)}`);
        continue;
      }
      if (!wamid) {
        resumen.fallidos++;
        await marcar(db, id, 'fallido', { error: 'sin_whatsapp_propio' }).catch(() => {});
        continue;
      }
      resumen.enviados++;
      await marcar(db, id, 'aceptado', { wamid }).catch((e) => log(`${PREFIJO} bitácora: ${e.message}`));
      log(`${PREFIJO} negocio=${nid} telefono=${telefonoEnmascarado(d.telefono)} enviado (código ${ev.promo.codigo})`);
      // Al chat, como cualquier mensaje del bot: el personal lo ve en Chats.
      try {
        const guardado = await guardar(d.telefono, null, 'saliente', texto, nid, 'bot', wamid);
        if (guardado && broadcastPanel) broadcastPanel(nid, { tipo: 'nuevo_mensaje', mensaje: guardado });
      } catch (e) { log(`${PREFIJO} no se guardó en el chat: ${e.message}`); }
    }
  }
  if (resumen.enviados || resumen.fallidos) {
    log(`${PREFIJO} corrida enviados=${resumen.enviados} fallidos=${resumen.fallidos} omitidos=${JSON.stringify(resumen.omitidos)}`);
  }
  return resumen;
}
