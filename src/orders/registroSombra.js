// ─── Modo sombra: mirar sin tocar ────────────────────────────────────────
//
// Evalúa qué HARÍA el reconciliador del carrito con un turno real, y lo
// registra. Se enciende con `PEDIDO_SHADOW_MODE=true`.
//
// ── Dónde vive, y por qué ahí ────────────────────────────────────────────
//
// La primera versión metía la sombra DENTRO del turno productivo: el bot
// contestaba como siempre y, de paso, se calculaba el carrito en paralelo. Esa
// forma no sirve para el experimento que hace falta, y la auditoría lo dejó
// claro: con el bot encendido, el cliente recibe respuestas, se registran
// pedidos, se imprimen comandas y se generan cobros. La bandera solo apagaba el
// carrito; todo lo demás seguía pasando.
//
// Así que la sombra se movió al único sitio donde el sistema YA está callado:
// los tres puntos del canal en los que se decide no contestar —bot apagado,
// cliente pausado, takeover humano—. Ahí el mensaje ya se guardó y ya se mostró
// en el panel (comportamiento de siempre, ajeno a esto) y el bot no va a
// responder. Observar ahí no puede producir nada nuevo: este módulo no tiene a
// mano ninguna función que envíe, registre, imprima o cobre.
//
// Es un módulo, no una arquitectura paralela: la propuesta la produce el MISMO
// extractor acotado que ya usa `brain.js`, inyectado por quien llama, y la
// evaluación es el MISMO `reconciliar`.
//
// ── Fail closed ──────────────────────────────────────────────────────────
//
// Nada de lo que pase aquí puede alterar el turno. Todo va dentro de un
// try/catch que devuelve `{ ok: false }`, con un tope de tiempo propio, y no
// existe ninguna rama que, ante un fallo de la sombra, ejecute el flujo real:
// quien llama ya decidió callar ANTES de entrar aquí, y este módulo no devuelve
// nada que pueda cambiar esa decisión.
//
// ── Qué NO se guarda ─────────────────────────────────────────────────────
//
// La conversación se identifica por un hash corto de su id, no por el
// teléfono. El mensaje se recorta y se le tapan las corridas largas de dígitos
// —un teléfono, una tarjeta dictada—. El anonimizado ocurre al construir la
// línea, antes de escribirla.
import { createHash } from 'node:crypto';
import { reconciliar } from './carritoDelPedido.js';
import { procedenciaDelCiclo } from './procedenciaDeEvidencia.js';

const MAX_TEXTO = 240;
const MAX_TURNOS = 12;            // historial por conversación que se conserva
const MAX_CONVERSACIONES = 500;   // tope de memoria del experimento
const TOPE_MS = 8000;             // por debajo de lo que dura un turno

/**
 * ¿Está encendido el modo sombra?
 *
 * Comparación EXPLÍCITA contra la cadena "true", sin truthiness: una variable
 * de entorno siempre es un string, así que `"false"` y `"0"` son verdaderos
 * para JavaScript y encenderían el experimento por accidente. El único valor
 * que enciende es `true` (con espacios o mayúsculas alrededor, nada más).
 */
export function sombraActiva() {
  return String(process.env.PEDIDO_SHADOW_MODE ?? '').trim().toLowerCase() === 'true';
}

// Estado del experimento, SEPARADO de la sesión productiva.
//
// Vivía en `session.carritoSombra` y se persistía junto al estado real. Eso es
// escribir en la sesión productiva y engordar su fila durable por una prueba,
// justo lo que la sombra promete no hacer. Ahora vive aquí, en memoria, y se
// pierde con un reinicio: para un experimento de observación es el precio
// correcto, y queda dicho en la bitácora.
const conversaciones = new Map();

/** Vacía el estado del experimento. Para las pruebas y para apagarlo en caliente. */
export function reiniciarSombra() { conversaciones.clear(); }

function estadoDe(sessionId) {
  if (!conversaciones.has(sessionId)) {
    // Tope duro: si el experimento se deja encendido mucho tiempo, no puede
    // crecer sin freno. Se tira la más vieja, que es la menos interesante.
    if (conversaciones.size >= MAX_CONVERSACIONES) {
      conversaciones.delete(conversaciones.keys().next().value);
    }
    conversaciones.set(sessionId, { turnos: [], carrito: null });
  }
  return conversaciones.get(sessionId);
}

/** Identidad estable de la conversación, sin el teléfono dentro. */
const idCorto = (s) => createHash('sha256').update(String(s || '')).digest('hex').slice(0, 12);

/** El texto del cliente, recortado y sin corridas largas de dígitos. */
export function textoSeguro(texto) {
  return String(texto || '')
    .replace(/\d[\d\s().-]{6,}\d/g, '[num]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXTO);
}

/** Los artículos, en la forma mínima que hace falta para entender la decisión. */
const resumirItems = (carrito) => (carrito?.items || []).map((i) => ({
  n: i.nombre,
  c: i.cantidad,
  m: (i.modificadores || []).map((g) => `${g?.grupo ?? ''}:${(g?.opciones || []).join('/')}`),
  ...(i.notas ? { nota: i.notas } : {}),
}));

/**
 * Observa un turno que el bot NO va a contestar.
 *
 * `proponer(mensajes)` la inyecta quien llama: es el extractor acotado de
 * `brain.js`. Inyectarlo en vez de importarlo mantiene este módulo sin
 * dependencia del cerebro y hace que las pruebas puedan darle una propuesta
 * fija —o hacerla explotar— sin tocar el modelo.
 *
 * Nunca lanza y nunca devuelve nada que el llamador deba aplicar: su único
 * efecto es una línea de log.
 */
export async function observarTurno({ sessionId, negocioId, mensaje, proponer }) {
  if (!sombraActiva()) return { ok: false, motivo: 'apagado' };
  try {
    const estado = estadoDe(sessionId);
    estado.turnos.push({ role: 'user', content: String(mensaje || '') });
    if (estado.turnos.length > MAX_TURNOS) estado.turnos.splice(0, estado.turnos.length - MAX_TURNOS);

    // Tope de tiempo propio: un modelo lento no puede quedarse con el handler
    // de un webhook que ya decidió no contestar.
    const propuesta = await Promise.race([
      Promise.resolve(proponer ? proponer(estado.turnos.slice()) : null),
      new Promise((_, rechaza) => setTimeout(() => rechaza(new Error('SOMBRA_TIMEOUT')), TOPE_MS)),
    ]);

    const dichos = estado.turnos.filter((t) => t.role === 'user').map((t) => t.content);
    const evidencia = procedenciaDelCiclo(dichos);
    const previo = estado.carrito;
    const recon = reconciliar(previo, propuesta || {}, {
      mensaje: String(mensaje || ''),
      textoCiclo: dichos.join(' \n '),
    });
    estado.carrito = recon.carrito;
    registrarSombra({ sessionId, negocioId, mensaje, previo, propuesta, recon, evidencia });
    return { ok: true };
  } catch (e) {
    // Fail closed: la sombra se calla y el turno sigue exactamente igual de
    // callado. No hay rama alternativa ni reintento hacia el flujo real.
    console.error('[SOMBRA] turno no evaluado (sin efecto sobre el cliente):', e.message);
    return { ok: false, motivo: e.message };
  }
}

/**
 * Una línea por turno. `recon` es lo que devolvió `reconciliar`.
 *
 * Nunca lanza: un fallo escribiendo un log de observación no puede alterar
 * nada, que es justo lo que el modo sombra promete.
 */
export function registrarSombra({ sessionId, negocioId, mensaje, previo, propuesta, recon, evidencia }) {
  try {
    const c = recon?.cambios || {};
    const linea = {
      ts: new Date().toISOString(),
      conv: idCorto(sessionId),
      negocio: negocioId,
      dijo: textoSeguro(mensaje),
      evidencia_dicho: textoSeguro(evidencia?.dicho),
      evidencia_percibido: textoSeguro(evidencia?.percibido),
      antes: resumirItems(previo),
      propuso: resumirItems({ items: propuesta?.items || [] }),
      quedaria: resumirItems(recon?.carrito),
      autorizado: (c.autorizados || []).map((a) => `${a.nombre}|${a.campo}|${a.via}`),
      rechazado: [
        ...(c.congelados || []).map((x) => `${x.nombre}|${x.campo}|no_lo_dijo_el_cliente`),
        ...(c.sinRespaldo || []).map((x) => `${x.nombre}|${x.campo}|sin_respaldo`),
        ...(c.porConfirmar || []).map((x) => `${x.nombre}|articulo|${x.motivo}`),
        ...(c.ambiguos || []).map((x) => `${x.nombre}|quitar|ambiguo`),
      ],
      conservado: (c.conservados || []).slice(0, 8),
      quitado: (c.quitados || []).slice(0, 8),
      // Si hubiera hecho falta preguntarle algo al cliente, y qué. En sombra la
      // pregunta NO se envía: solo se anota que la habría habido.
      requeria_aclaracion: !!((c.ambiguos || []).length || (c.porConfirmar || []).length),
    };
    console.warn('[TXN] evento=carrito_sombra ' + JSON.stringify(linea));
  } catch (e) {
    console.error('[SOMBRA] no se pudo registrar el turno:', e.message);
  }
}
