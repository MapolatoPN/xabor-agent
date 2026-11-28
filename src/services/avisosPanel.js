/**
 * Avisos del panel: la campanita (24-nov-2026, pedido de Mario).
 *
 * Los avisos al dueño (el bot falló, una conversación pasó a una persona, un
 * cliente lleva rato esperando...) ya no van por WhatsApp: se quedan DENTRO
 * del panel. Se guardan en `avisos_panel` (migración 160) para verlos al
 * entrar, y llegan en vivo al panel abierto (evento WS `aviso_panel`, solo a
 * administradores: server.js lo tiene en EVENTOS_WS_SOLO_ADMIN).
 *
 * Reglas:
 *   · Bandera por negocio `avisos_panel_v1` en `configuracion`, apagada por
 *     omisión. Apagada, nada se lee ni se escribe: todo queda como antes.
 *   · Cada consulta filtra por negocio. Un negocio nunca ve ni marca los
 *     avisos de otro.
 *   · Guardar un aviso NUNCA lanza ni detiene al que avisa: el bot ya le
 *     contestó al cliente (o lo intentó) y un fallo aquí solo se anota.
 *   · El mismo aviso del mismo cliente no se repite mientras siga sin verse
 *     (30 min): «cliente esperando» puede dispararse varias veces seguidas.
 *   · `datos` lleva solo lo que el panel necesita para el texto, recortado.
 *     El panel lo pinta con textContent (panel/avisos-panel.js): un producto
 *     que escribió el cliente nunca se interpreta como HTML.
 *
 * Encender en un negocio, sin redeploy:
 *   INSERT INTO configuracion (negocio_id, clave, valor)
 *   VALUES ('<id del negocio>', 'avisos_panel_v1', 'true')
 *   ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = EXCLUDED.valor;
 */
import { pool, obtenerConfiguracion } from './database.js';

export const BANDERA_AVISOS_PANEL = 'avisos_panel_v1';

// La misma lista que el CHECK avisos_panel_tipo (160, y la 165 suma los dos
// del asistente del restaurante: el resumen que no salió y el tope de la IA).
export const TIPOS_AVISO_PANEL = Object.freeze([
  'cliente_esperando',
  'revision_humana',
  'bot_retomo',
  'fallas_bot',
  'negativa_falsa',
  'pago_sin_proveedor',
  'asistente_resumen_fallo',
  'asistente_tope_ia',
]);

// La campanita es para atender clientes (decisión del dueño, 27-nov-2026): los
// dos tipos del asistente del restaurante ya no se crean ni se listan. Siguen
// en TIPOS_AVISO_PANEL porque el CHECK de la 165 los admite y las filas viejas
// quedan en la tabla, sin mostrarse.
export const TIPOS_FUERA_DE_LA_CAMPANITA = Object.freeze(['asistente_resumen_fallo', 'asistente_tope_ia']);

export const DIAS_LISTA = 7;
export const LIMITE_LISTA = 100;
const MINUTOS_SIN_REPETIR = 30;
const LARGO_TEXTO = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Quién reparte el evento en vivo. server.js lo conecta con broadcastNegocio
// al arrancar; sin él (pruebas, scripts) el aviso se guarda igual. El nombre
// set…Broadcast… es a propósito: scripts/check-websocket-lista-cerrada.mjs
// revisa que lo que se inyecte aquí sea un emisor que filtra por negocio.
let emisor = null;
export function setBroadcastAvisosPanel(fn) {
  emisor = typeof fn === 'function' ? fn : null;
}

const negocioValido = (n) => typeof n === 'string' && UUID.test(n.trim());
const banderaEncendida = (cfg) => String(cfg?.[BANDERA_AVISOS_PANEL] ?? '') === 'true';

function recortar(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, LARGO_TEXTO) : null;
}

// Solo los campos que el panel usa, cada uno con su forma. Lo demás se tira.
export function limpiarDatosAviso(datos) {
  const d = (datos && typeof datos === 'object' && !Array.isArray(datos)) ? datos : {};
  const out = {};
  for (const k of ['minutos', 'errores']) {
    const n = Number(d[k]);
    if (Number.isFinite(n) && n >= 0) out[k] = Math.min(Math.round(n), 100000);
  }
  for (const k of ['motivo', 'razon', 'negado']) {
    const s = recortar(d[k]);
    if (s) out[k] = s;
  }
  if (Array.isArray(d.existen)) {
    const lista = d.existen.map(recortar).filter(Boolean).slice(0, 3);
    if (lista.length) out.existen = lista;
  }
  return out;
}

function limpiarTelefono(t) {
  if (typeof t !== 'string') return null;
  const s = t.trim();
  return s && s.length <= 40 ? s : null;
}

/**
 * Guarda un aviso del negocio y lo manda al panel abierto. Nunca lanza.
 * Devuelve la fila guardada, o null si no se guardó (bandera apagada, tipo
 * desconocido, repetido sin ver o fallo de la base).
 */
export async function registrarAvisoPanel(negocioId, tipo, { telefono = null, datos = {} } = {}) {
  try {
    if (!negocioValido(negocioId) || !TIPOS_AVISO_PANEL.includes(tipo) || TIPOS_FUERA_DE_LA_CAMPANITA.includes(tipo)) return null;
    const n = negocioId.trim();
    const cfg = await obtenerConfiguracion(n);
    if (!banderaEncendida(cfg)) return null;
    const tel = limpiarTelefono(telefono);
    const limpios = limpiarDatosAviso(datos);
    // Con cliente: no se repite mientras el mismo aviso siga sin verse. Sin
    // cliente (fallas, negativa falsa), el que avisa ya trae su propio freno.
    const { rows: [fila] } = await pool.query(
      `INSERT INTO avisos_panel (negocio_id, tipo, telefono, datos)
       SELECT $1::uuid, $2::text, $3::text, $4::jsonb
        WHERE $3::text IS NULL OR NOT EXISTS (
          SELECT 1 FROM avisos_panel
           WHERE negocio_id = $1::uuid AND tipo = $2::text AND telefono = $3::text AND visto_en IS NULL
             AND creado_en > now() - make_interval(mins => $5::int))
       RETURNING id::text, tipo, telefono, datos, creado_en, visto_en`,
      [n, tipo, tel, JSON.stringify(limpios), MINUTOS_SIN_REPETIR]);
    if (!fila) return null;
    if (emisor) {
      try { emisor(n, { tipo: 'aviso_panel', aviso: fila }); }
      catch (e) { console.error('[Avisos panel] envío en vivo:', e.message); }
    }
    return fila;
  } catch (e) {
    console.error(`[Avisos panel] no se guardó el aviso ${tipo} del negocio ${negocioId}:`, e.message);
    return null;
  }
}

/** La lista de la campanita: últimos 7 días del negocio y cuántos faltan por ver. */
export async function listarAvisosPanel(negocioId) {
  if (!negocioValido(negocioId)) return { activo: false, sinVer: 0, avisos: [] };
  const n = negocioId.trim();
  const cfg = await obtenerConfiguracion(n);
  if (!banderaEncendida(cfg)) return { activo: false, sinVer: 0, avisos: [] };
  const fuera = [...TIPOS_FUERA_DE_LA_CAMPANITA];
  const { rows: avisos } = await pool.query(
    `SELECT id::text, tipo, telefono, datos, creado_en, visto_en
       FROM avisos_panel
      WHERE negocio_id = $1 AND creado_en > now() - make_interval(days => $2)
        AND tipo <> ALL($4::text[])
      ORDER BY creado_en DESC, id DESC
      LIMIT $3`, [n, DIAS_LISTA, LIMITE_LISTA, fuera]);
  const { rows: [c] } = await pool.query(
    `SELECT COUNT(*)::int AS sin_ver FROM avisos_panel
      WHERE negocio_id = $1 AND visto_en IS NULL AND creado_en > now() - make_interval(days => $2)
        AND tipo <> ALL($3::text[])`,
    [n, DIAS_LISTA, fuera]);
  return { activo: true, sinVer: c.sin_ver, avisos };
}

/**
 * Marca como visto un aviso (id) o todos los del negocio (sin id). Solo los
 * del negocio que pregunta. Devuelve cuántos marcó.
 */
export async function marcarAvisosVistos(negocioId, { id = null, usuarioId = null } = {}) {
  if (!negocioValido(negocioId)) return { activo: false, marcados: 0 };
  const n = negocioId.trim();
  const cfg = await obtenerConfiguracion(n);
  if (!banderaEncendida(cfg)) return { activo: false, marcados: 0 };
  if (id !== null && !/^\d{1,18}$/.test(String(id))) return { activo: true, marcados: 0 };
  const quien = typeof usuarioId === 'string' && UUID.test(usuarioId) ? usuarioId : null;
  const { rowCount } = await pool.query(
    `UPDATE avisos_panel SET visto_en = now(), visto_por = $3::uuid
      WHERE negocio_id = $1 AND visto_en IS NULL AND ($2::bigint IS NULL OR id = $2::bigint)`,
    [n, id === null ? null : String(id), quien]);
  return { activo: true, marcados: rowCount };
}
