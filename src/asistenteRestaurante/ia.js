// Asistente del restaurante, Fase 3: la llamada a la IA, el tope de gasto y su
// registro.
//
// La IA (API de Claude) NUNCA calcula: recibe lo que las reglas ya encontraron
// y devuelve texto en un formato fijo (JSON). Quien llama revisa ese texto
// (redaccion.js) antes de usarlo; si algo falla aquí, quien llama sigue con el
// texto de las reglas. Por eso esta función nunca lanza: responde
// { ok: false, motivo } y el resto del asistente sigue igual.
//
// Tope por sucursal y por mes (en dólares, configurable en la tarjeta): antes
// de cada llamada se suma lo gastado este mes más lo MÁXIMO que podría costar
// esta llamada; si se pasaría, no se llama. Cada llamada que llega a la API
// queda en asistente_restaurante_gasto_ia con sus tokens y su costo.
//
// Cliente propio, como el del Mesero (src/mesero-agente/modeloDelAgente.js), y
// no el de brain.js: brain.js es un componente protegido y su política de
// reintentos es para un cliente que espera. Aquí es un proceso de fondo.
import Anthropic from '@anthropic-ai/sdk';
import { fechaOperativaDe, rangoUtcDeFecha } from '../services/cortesCaja.js';
import { registrarAvisoPanel } from '../services/avisosPanel.js';

export const MODELO_IA = 'claude-opus-5-5';
// Dólares por millón de tokens (Opus 5.5). La escritura de caché es la de 5 min.
export const PRECIO_USD_POR_MILLON = Object.freeze({ entrada: 4, salida: 20, cacheLectura: 0.2, cacheEscritura: 5 });
export const TIEMPO_MAXIMO_MS = 60_000;
// Redactar con datos ya calculados es una tarea corta: con esfuerzo bajo piensa
// menos, cuesta menos y es más difícil que la respuesta se corte.
export const ESFUERZO_IA = 'low';
export const PROPOSITOS = Object.freeze(['avisos', 'resumen_diario', 'resumen_semanal']);

const esUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const entero = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };

/** Lo que costó una respuesta, en dólares, según su `usage`. */
export function costoDe(usage = {}) {
  const P = PRECIO_USD_POR_MILLON;
  const usd = (entero(usage.input_tokens) * P.entrada + entero(usage.output_tokens) * P.salida
    + entero(usage.cache_read_input_tokens) * P.cacheLectura + entero(usage.cache_creation_input_tokens) * P.cacheEscritura) / 1e6;
  return Math.round(usd * 1e5) / 1e5;
}

/**
 * Lo más que podría costar una llamada: la entrada calculada a lo alto (3
 * letras por token, más el formato) y TODA la salida permitida.
 */
export function costoMaximo({ caracteresEntrada = 0, maxTokens = 0 } = {}) {
  const entrada = Math.ceil((Number(caracteresEntrada) || 0) / 3) + 1500;
  return Math.round(((entrada * PRECIO_USD_POR_MILLON.entrada + entero(maxTokens) * PRECIO_USD_POR_MILLON.salida) / 1e6) * 1e5) / 1e5;
}

const inicioDelMes = (ahora, tz) => rangoUtcDeFecha(`${fechaOperativaDe(ahora, tz).slice(0, 7)}-01`, tz).inicio.toISOString();

/** Lo gastado en la IA este mes (mes de la sucursal), en dólares. */
export async function gastoDelMes(db, negocioId, tz, ahora = new Date()) {
  if (!esUuid(negocioId)) { const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e; }
  const inicio = inicioDelMes(ahora, tz);
  const { rows: [r] } = await db.query(
    `SELECT COALESCE(SUM(costo_usd), 0)::float AS usd FROM asistente_restaurante_gasto_ia
      WHERE negocio_id = $1 AND creado_en >= $2`, [negocioId, inicio]);
  return Number(r?.usd) || 0;
}

/**
 * «Se alcanzó el tope de gasto de la IA» en la campanita, UNA vez al mes por
 * sucursal (los avisos sin cliente no traen freno propio). Nunca lanza.
 */
export async function avisarTopeUnaVez(db, negocioId, tz, topeUsd, ahora = new Date()) {
  try {
    const { rows } = await db.query(
      "SELECT 1 FROM avisos_panel WHERE negocio_id = $1 AND tipo = 'asistente_tope_ia' AND creado_en >= $2 LIMIT 1",
      [negocioId, inicioDelMes(ahora, tz)]);
    if (rows.length) return null;
    return await registrarAvisoPanel(negocioId, 'asistente_tope_ia', { datos: { motivo: `US$${Number(topeUsd) || 0}` } });
  } catch (e) {
    console.error('[Asistente] aviso de tope:', e.message);
    return null;
  }
}

async function registrarGasto(db, { negocioId, proposito, usage, resultado }) {
  await db.query(`
    INSERT INTO asistente_restaurante_gasto_ia
           (negocio_id, proposito, modelo, tokens_entrada, tokens_salida, tokens_cache, costo_usd, resultado)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [negocioId, proposito, MODELO_IA, entero(usage?.input_tokens), entero(usage?.output_tokens),
    entero(usage?.cache_read_input_tokens) + entero(usage?.cache_creation_input_tokens), costoDe(usage), resultado]);
}

// ── La llave se lee tarde, y por eso con import dinámico (como el Mesero) ──
let _leerIntegracion = null;
async function claveDelProveedor() {
  if (_leerIntegracion === null) {
    try { _leerIntegracion = (await import('../server.js')).getIntegracion; } catch { _leerIntegracion = false; }
  }
  return (_leerIntegracion && _leerIntegracion('anthropic_api_key')) || process.env.ANTHROPIC_API_KEY || null;
}
let _cliente = null;
let _clave = null;
async function clienteReal() {
  const clave = await claveDelProveedor();
  if (!clave) return null;
  if (!_cliente || _clave !== clave) {
    _cliente = new Anthropic({ apiKey: clave, timeout: TIEMPO_MAXIMO_MS, maxRetries: 1 });
    _clave = clave;
  }
  return _cliente;
}

/**
 * Pide a la IA una respuesta con el formato `esquema` (JSON Schema).
 * Devuelve { ok: true, datos, costoUsd } o { ok: false, motivo, detalle? } con
 * motivo: 'tope' | 'sin_clave' | 'error' | 'invalida'. Nunca lanza.
 * `cliente`: para las pruebas (un objeto con messages.create).
 */
export async function pedirJson({
  db, negocioId, tz, proposito, sistema, usuario, esquema, maxTokens = 4000, topeUsd, cliente, ahora = new Date(),
}) {
  try {
    if (!esUuid(negocioId) || !PROPOSITOS.includes(proposito)) return { ok: false, motivo: 'error', detalle: 'llamada inválida' };
    const tope = Number(topeUsd);
    if (!(tope > 0)) return { ok: false, motivo: 'tope', detalle: 'sin tope' };
    const gastado = await gastoDelMes(db, negocioId, tz, ahora);
    const maximo = costoMaximo({ caracteresEntrada: String(sistema).length + String(usuario).length + JSON.stringify(esquema).length, maxTokens });
    if (gastado + maximo > tope) return { ok: false, motivo: 'tope', detalle: `gastado US$${gastado.toFixed(2)} de US$${tope}` };
    const cli = cliente || await clienteReal();
    if (!cli) return { ok: false, motivo: 'sin_clave' };
    let r;
    try {
      r = await cli.messages.create({
        model: MODELO_IA,
        max_tokens: maxTokens,
        system: sistema,
        messages: [{ role: 'user', content: usuario }],
        output_config: { effort: ESFUERZO_IA, format: { type: 'json_schema', schema: esquema } },
      });
    } catch (e) {
      return { ok: false, motivo: 'error', detalle: String(e?.status || e?.message || e).slice(0, 200) };
    }
    const usage = r?.usage || {};
    const costoUsd = costoDe(usage);
    if (r?.stop_reason === 'refusal') {
      await registrarGasto(db, { negocioId, proposito, usage, resultado: 'rechazo' });
      return { ok: false, motivo: 'error', detalle: 'la IA no quiso responder' };
    }
    const texto = Array.isArray(r?.content) ? r.content.find((b) => b?.type === 'text')?.text : null;
    let datos = null;
    if (r?.stop_reason !== 'max_tokens' && typeof texto === 'string') {
      try { datos = JSON.parse(texto); } catch { datos = null; }
    }
    if (!datos || typeof datos !== 'object' || Array.isArray(datos)) {
      await registrarGasto(db, { negocioId, proposito, usage, resultado: 'invalida' });
      return { ok: false, motivo: 'invalida', detalle: r?.stop_reason === 'max_tokens' ? 'respuesta cortada' : 'no es JSON' };
    }
    await registrarGasto(db, { negocioId, proposito, usage, resultado: 'ok' });
    return { ok: true, datos, costoUsd };
  } catch (e) {
    return { ok: false, motivo: 'error', detalle: String(e?.message || e).slice(0, 200) };
  }
}
