// Asistente del restaurante, Fase 3: el resumen por WhatsApp.
//
// Diario a la hora que fije la sucursal (18:00 a 23:30) y semanal los lunes a
// las 9:00, al número que esté en la tarjeta 🤖 Asistente. Sin número, o con
// el resumen apagado, no sale nada. Sale del número de WhatsApp de ESA
// sucursal (sus credenciales, las mismas del bot y de las campañas) con la
// plantilla de Meta PLANTILLA_RESUMEN: fuera de la ventana de 24 h Meta no
// entrega otra cosa.
//
// Nunca dos veces: cada resumen se aparta en asistente_restaurante_resumenes
// (un diario y un semanal por sucursal y día, índice único) ANTES de mandarlo.
// Si Meta no contesta a tiempo queda 'incierto' y no se reintenta: mejor un
// resumen perdido que uno duplicado. Si no sale, la campanita lo dice con el
// motivo de Meta en palabras simples (decisión del dueño del 24-nov: las
// alertas, en el panel).
//
// La IA solo reescribe lo que ya está escrito (resumen.js lo revisa); si falla,
// se pasa del tope o su texto no sirve, sale el texto de las reglas. Nunca está
// en el camino de un pedido: lo llama un temporizador del servidor y no toca
// pedidos, cobros, impresión, Rappi, Clip ni Facturapi, ni el bot.
import { pool, obtenerCredencialesWhatsappNegocio } from '../services/database.js';
import { fechaOperativaDe } from '../services/cortesCaja.js';
import { TZ_DEFAULT, esZonaValida } from '../services/zonaHoraria.js';
import { registrarAvisoPanel } from '../services/avisosPanel.js';
import { explicarCodigo, telefonoParaMeta } from '../services/campanasWaPlantillas.js';
import { BANDERA } from './avisos.js';
import { TIPOS_CONTROL, UMBRALES_ASISTENTE, umbralPedidoGrande, sumarDias, fechaCorta } from './reglas.js';
import { CLAVE_RESUMEN, PLANTILLA_RESUMEN, leerConfiguracion, paraLaRevision, ultimos4 } from './configuracion.js';
import { leerVentasDeResumen } from './datos.js';
import { pedirJson, avisarTopeUnaVez } from './ia.js';
import {
  calcularResumen, variablesDe, textoDelMensaje, MAXIMO_CUERPO, entradaResumen, aplicarRespuestaResumen,
  SISTEMA_RESUMEN, ESQUEMA_RESUMEN, esLunes, variablesDePrueba, limpiarVariable,
} from './resumen.js';

export const HORA_SEMANAL = '09:00';
export const FIN_SEMANAL = '14:00';
export const PRUEBAS_POR_HORA = 5;
const MINUTOS_ATASCADO = 30;
const graph = () => `${process.env.META_GRAPH_BASE_URL || 'https://graph.facebook.com'}/v20.0`;
const esUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const zonaDe = (v) => { const tz = String(v || '').trim(); return tz && esZonaValida(tz) ? tz : TZ_DEFAULT; };

/** 'HH:MM' de un instante en esa zona. */
export function horaHM(instante, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instante);
}

/** El nombre y la zona de UNA sucursal. */
export async function negocioDe(db, negocioId) {
  if (!esUuid(negocioId)) { const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e; }
  const { rows: [n] } = await db.query(`
    SELECT n.id::text AS id, n.nombre,
           (SELECT z.valor FROM configuracion z WHERE z.negocio_id = n.id AND z.clave = 'timezone' LIMIT 1) AS tz
      FROM negocios n WHERE n.id = $1`, [negocioId]);
  return n ? { id: n.id, nombre: n.nombre || '', tz: zonaDe(n.tz) } : null;
}

/**
 * Manda la plantilla. Devuelve { ok: true, wamid } o { ok: false, tipo, codigo }
 * con tipo 'fallo' (Meta lo rechazó) o 'incierto' (no sabemos si salió).
 */
export async function mandarPlantilla({ credenciales, numero, variables, fetchImpl = fetch }) {
  const to = telefonoParaMeta(numero);
  if (!to) return { ok: false, tipo: 'fallo', codigo: null, explicacion: 'El número que recibe el resumen no es válido' };
  let resp;
  try {
    resp = await fetchImpl(`${graph()}/${encodeURIComponent(credenciales.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credenciales.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
        template: {
          name: PLANTILLA_RESUMEN.nombre, language: { code: PLANTILLA_RESUMEN.idioma },
          components: [{ type: 'body', parameters: variables.map((text) => ({ type: 'text', text })) }],
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, tipo: 'incierto', codigo: null };
  }
  let datos = null;
  try { datos = await resp.json(); } catch { datos = null; }
  const wamid = datos?.messages?.[0]?.id;
  if (resp.ok && typeof wamid === 'string') return { ok: true, wamid: wamid.slice(0, 200) };
  if (resp.ok) return { ok: false, tipo: 'incierto', codigo: null };
  const codigo = Number.isSafeInteger(datos?.error?.code) ? datos.error.code : null;
  return { ok: false, tipo: resp.status >= 500 && codigo === null ? 'incierto' : 'fallo', codigo };
}

function explicar(envio) {
  if (envio.explicacion) return envio.explicacion;
  if (envio.tipo === 'incierto') return 'Meta no contestó a tiempo: puede que sí haya llegado';
  if (envio.codigo === 132001) return `La plantilla ${PLANTILLA_RESUMEN.nombre} no existe o no está aprobada en Meta`;
  return explicarCodigo(envio.codigo);
}
const nombreDe = (tipo, hoy) => `${tipo === 'semanal' ? 'Resumen semanal' : 'Resumen diario'} del ${fechaCorta(hoy)}`;

async function avisarFallo(negocioId, tipo, hoy, explicacion) {
  await registrarAvisoPanel(negocioId, 'asistente_resumen_fallo', { datos: { motivo: explicacion, razon: nombreDe(tipo, hoy) } });
}

/**
 * Aparta el resumen de hoy. Devuelve su id, o null si ya se mandó, falló o lo
 * está mandando otro proceso. Uno «preparando» que se quedó atorado (el
 * servidor se reinició ANTES de mandarlo) se puede retomar a los 30 min; uno
 * «enviando» nunca, porque pudo haber salido.
 */
export async function apartarResumen(db, negocioId, tipo, fecha) {
  const { rows: [r] } = await db.query(`
    INSERT INTO asistente_restaurante_resumenes (negocio_id, tipo, fecha) VALUES ($1, $2, $3)
    ON CONFLICT (negocio_id, tipo, fecha) WHERE tipo IN ('diario', 'semanal')
    DO UPDATE SET estado = 'preparando', creado_en = now(), error = NULL
     WHERE asistente_restaurante_resumenes.estado = 'preparando'
       AND asistente_restaurante_resumenes.creado_en < now() - make_interval(mins => $4)
    RETURNING id`, [negocioId, tipo, fecha, MINUTOS_ATASCADO]);
  return r ? String(r.id) : null;
}

/** Los avisos que eligió la revisión de esa mañana, primero los de control. */
async function elegidosDeLaManana(db, negocioId, fecha) {
  const { rows } = await db.query(`
    SELECT h.tipo, h.titulo, h.contenido
      FROM asistente_restaurante_hallazgos h
      JOIN asistente_restaurante_corridas c ON c.negocio_id = h.negocio_id AND c.id = h.corrida_id
     WHERE h.negocio_id = $1 AND c.fecha = $2 AND c.estado = 'lista' AND h.elegido
     ORDER BY (h.tipo = ANY($3::text[])) DESC,
              CASE WHEN h.contenido->'ia'->>'orden' ~ '^[0-9]{1,2}$' THEN (h.contenido->'ia'->>'orden')::int END ASC NULLS LAST,
              h.impacto DESC, h.id
     LIMIT 3`, [negocioId, fecha, [...TIPOS_CONTROL]]);
  return rows.map((r) => ({ tipo: r.tipo, titulo: r.titulo, sugerencia: r.contenido?.sugerencia || '', ia: r.contenido?.ia || null }));
}

/** Las variables finales: con la IA si se pudo, y siempre dentro del largo de Meta. */
async function redactar({ db, negocio, tipo, r, cfg, clienteIA, ahora }) {
  let texto = {}; let conIa = false;
  if (cfg.resumen.ia) {
    const res = await pedirJson({
      db, negocioId: negocio.id, tz: negocio.tz, proposito: tipo === 'semanal' ? 'resumen_semanal' : 'resumen_diario',
      sistema: SISTEMA_RESUMEN, usuario: JSON.stringify(entradaResumen(r)), esquema: ESQUEMA_RESUMEN,
      maxTokens: 3000, topeUsd: cfg.resumen.topeUsd, cliente: clienteIA, ahora,
    });
    if (res.ok) ({ texto, conIa } = aplicarRespuestaResumen(r, res.datos));
    else if (res.motivo === 'tope') await avisarTopeUnaVez(db, negocio.id, negocio.tz, cfg.resumen.topeUsd, ahora);
  }
  let variables = variablesDe(r, texto);
  if (textoDelMensaje(variables).length > MAXIMO_CUERPO) { variables = variablesDe(r); conIa = false; }
  if (textoDelMensaje(variables).length > MAXIMO_CUERPO) variables = variables.map((v) => limpiarVariable(v, 110));
  return { variables, conIa };
}

/**
 * Prepara y manda UN resumen ('diario' o 'semanal') de UNA sucursal.
 * Devuelve { estado } o { omitido: true } si ya estaba apartado. Nunca lanza
 * por un fallo de Meta o de la IA: queda en la tabla y en la campanita.
 */
export async function prepararYEnviar({
  db = pool, negocio, tipo, hoy, ahora = new Date(), cfg, fetchImpl = fetch, clienteIA,
  credencialesDe = obtenerCredencialesWhatsappNegocio,
}) {
  if (!negocio || !esUuid(negocio.id)) { const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e; }
  const nid = negocio.id;
  const id = await apartarResumen(db, nid, tipo, hoy);
  if (!id) return { omitido: true };
  const fin = (estado, { error = null, codigo = null, wamid = null } = {}) => db.query(`
    UPDATE asistente_restaurante_resumenes
       SET estado = $3, error = $4, error_codigo = $5, wamid = $6,
           enviado_en = CASE WHEN $3 = 'enviado' THEN now() ELSE enviado_en END
     WHERE negocio_id = $1 AND id = $2`, [nid, id, estado, error ? String(error).slice(0, 300) : null, codigo, wamid]);
  try {
    const ajustes = paraLaRevision(cfg);
    const U = { ...UMBRALES_ASISTENTE, ...ajustes.umbrales };
    const cliente = await db.connect();
    let ventas;
    try { ventas = await leerVentasDeResumen(cliente, { negocio, desde: sumarDias(hoy, -95), hasta: hoy }); } finally { cliente.release(); }
    const r = calcularResumen({
      tipo, negocio, ventas, hoy, horaCorte: tipo === 'diario' ? horaHM(ahora, negocio.tz) : '23:59',
      umbralGrande: umbralPedidoGrande(ventas, sumarDias(hoy, -1), U),
      elegidos: await elegidosDeLaManana(db, nid, hoy),
    });
    if (tipo === 'diario' && !r.actual.tickets && !r.actual.grandes) {
      await fin('omitido', { error: 'Sin ventas en el día' });
      return { estado: 'omitido' };
    }
    const { variables, conIa } = await redactar({ db, negocio, tipo, r, cfg, clienteIA, ahora });
    await db.query(`UPDATE asistente_restaurante_resumenes SET variables = $3::jsonb, con_ia = $4, destino = $5 WHERE negocio_id = $1 AND id = $2`,
      [nid, id, JSON.stringify(variables), conIa, ultimos4(cfg.resumen.numero)]);
    const credenciales = await credencialesDe(nid);
    if (!credenciales?.phoneNumberId || !credenciales?.accessToken) {
      const explicacion = 'La sucursal no tiene WhatsApp conectado';
      await fin('fallo', { error: explicacion });
      await avisarFallo(nid, tipo, hoy, explicacion);
      return { estado: 'fallo' };
    }
    await fin('enviando');
    const envio = await mandarPlantilla({ credenciales, numero: cfg.resumen.numero, variables, fetchImpl });
    if (envio.ok) {
      await fin('enviado', { wamid: envio.wamid });
      return { estado: 'enviado', conIa };
    }
    const explicacion = explicar(envio);
    await fin(envio.tipo === 'incierto' ? 'incierto' : 'fallo', { error: explicacion, codigo: envio.codigo });
    await avisarFallo(nid, tipo, hoy, explicacion);
    return { estado: envio.tipo === 'incierto' ? 'incierto' : 'fallo' };
  } catch (e) {
    console.error(`[Asistente] Resumen ${tipo} de ${nid} (${hoy}):`, e.message);
    await fin('fallo', { error: 'No se pudo preparar el resumen' }).catch(() => {});
    await avisarFallo(nid, tipo, hoy, 'No se pudo preparar el resumen');
    return { estado: 'fallo' };
  }
}

/** ¿Ya hay un resumen de ese tipo y día que no se pueda retomar? */
async function yaHay(db, negocioId, tipo, fecha) {
  const { rows } = await db.query(`
    SELECT 1 FROM asistente_restaurante_resumenes
     WHERE negocio_id = $1 AND tipo = $2 AND fecha = $3
       AND (estado <> 'preparando' OR creado_en >= now() - make_interval(mins => $4))`, [negocioId, tipo, fecha, MINUTOS_ATASCADO]);
  return rows.length > 0;
}

// ─── El temporizador de cada minuto ──────────────────────────────────────
let enCurso = false;

/** Manda los resúmenes que ya tocan, en las sucursales que los encendieron. */
export async function enviarResumenesPendientes({ db = pool, ahora = new Date(), fetchImpl, clienteIA, credencialesDe } = {}) {
  if (enCurso) return { omitido: true };
  enCurso = true;
  const resultado = { revisadas: 0, enviados: 0, fallos: 0 };
  try {
    const { rows: [t] } = await db.query("SELECT to_regclass('public.asistente_restaurante_resumenes') IS NOT NULL AS hay");
    if (!t.hay) return resultado;
    const { rows } = await db.query(`
      SELECT c.negocio_id::text AS id, n.nombre,
             (SELECT z.valor FROM configuracion z WHERE z.negocio_id = c.negocio_id AND z.clave = 'timezone' LIMIT 1) AS tz
        FROM configuracion c JOIN negocios n ON n.id = c.negocio_id
       WHERE c.clave = $1 AND btrim(c.valor) = 'true' AND n.activo IS NOT FALSE
         AND EXISTS (SELECT 1 FROM configuracion r WHERE r.negocio_id = c.negocio_id AND r.clave = $2)
       ORDER BY c.negocio_id`, [BANDERA, CLAVE_RESUMEN]);
    for (const s of rows) {
      const cfg = await leerConfiguracion(db, s.id);
      const R = cfg.resumen;
      if (!cfg.activo || !R.numero || (!R.diario && !R.semanal)) continue;
      const negocio = { id: s.id, nombre: s.nombre || '', tz: zonaDe(s.tz) };
      const hoy = fechaOperativaDe(ahora, negocio.tz);
      const hm = horaHM(ahora, negocio.tz);
      const tipos = [];
      if (R.semanal && esLunes(hoy) && hm >= HORA_SEMANAL && hm < FIN_SEMANAL) {
        // Espera a la revisión de esta mañana (o a las 10:00, lo que pase antes).
        const { rows: lista } = await db.query(
          "SELECT 1 FROM asistente_restaurante_corridas WHERE negocio_id = $1 AND fecha = $2 AND estado = 'lista'", [s.id, hoy]);
        if (lista.length || hm >= '10:00') tipos.push('semanal');
      }
      if (R.diario && hm >= R.hora) tipos.push('diario');
      for (const tipo of tipos) {
        if (await yaHay(db, s.id, tipo, hoy)) continue;
        resultado.revisadas++;
        try {
          const r = await prepararYEnviar({ db, negocio, tipo, hoy, ahora, cfg, fetchImpl, clienteIA, credencialesDe });
          if (r.estado === 'enviado') resultado.enviados++;
          else if (r.estado === 'fallo' || r.estado === 'incierto') resultado.fallos++;
          if (r.estado) console.log(`[Asistente] Resumen ${tipo} de ${s.id} ${hoy}: ${r.estado}${r.conIa ? ' (con IA)' : ''}.`);
        } catch (e) {
          resultado.fallos++;
          console.error(`[Asistente] Resumen ${tipo} de ${s.id} ${hoy}: ${e.message}`);
        }
      }
    }
    return resultado;
  } finally {
    enCurso = false;
  }
}

/**
 * El botón «Enviar prueba» de la tarjeta: la plantilla sin cifras, ahora, al
 * número guardado. Máximo 5 por hora y sucursal. Devuelve { ok, mensaje }.
 */
export async function enviarPrueba({
  db = pool, negocio, cfg, ahora = new Date(), fetchImpl = fetch, credencialesDe = obtenerCredencialesWhatsappNegocio,
}) {
  const numero = cfg?.resumen?.numero;
  if (!numero) return { ok: false, mensaje: 'Primero guarda el número que recibe el resumen.' };
  const { rows: [c] } = await db.query(
    "SELECT COUNT(*)::int AS n FROM asistente_restaurante_resumenes WHERE negocio_id = $1 AND tipo = 'prueba' AND creado_en > now() - interval '1 hour'",
    [negocio.id]);
  if (c.n >= PRUEBAS_POR_HORA) return { ok: false, mensaje: `Ya mandaste ${PRUEBAS_POR_HORA} pruebas en la última hora; espera un poco.` };
  const credenciales = await credencialesDe(negocio.id);
  if (!credenciales?.phoneNumberId || !credenciales?.accessToken) return { ok: false, mensaje: 'La sucursal no tiene WhatsApp conectado.' };
  const variables = variablesDePrueba(negocio.nombre);
  const { rows: [fila] } = await db.query(`
    INSERT INTO asistente_restaurante_resumenes (negocio_id, tipo, fecha, estado, variables, destino)
    VALUES ($1, 'prueba', $2, 'enviando', $3::jsonb, $4) RETURNING id`,
  [negocio.id, fechaOperativaDe(ahora, negocio.tz), JSON.stringify(variables), ultimos4(numero)]);
  const envio = await mandarPlantilla({ credenciales, numero, variables, fetchImpl });
  const explicacion = envio.ok ? null : explicar(envio);
  await db.query(`
    UPDATE asistente_restaurante_resumenes
       SET estado = $3, wamid = $4, error = $5, error_codigo = $6, enviado_en = CASE WHEN $3 = 'enviado' THEN now() ELSE NULL END
     WHERE negocio_id = $1 AND id = $2`,
  [negocio.id, fila.id, envio.ok ? 'enviado' : envio.tipo === 'incierto' ? 'incierto' : 'fallo', envio.wamid || null, explicacion, envio.codigo ?? null]);
  return envio.ok
    ? { ok: true, mensaje: `Listo: Meta aceptó la prueba para el número que termina en ${ultimos4(numero)}.` }
    : { ok: false, mensaje: `No salió: ${explicacion}.` };
}
