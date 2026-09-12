// ─── Modo sombra: mirar sin tocar ────────────────────────────────────────
//
// Registra qué HABRÍA hecho el reconciliador del carrito con un turno real,
// sin que ese turno se entere. Se enciende con `PEDIDO_SHADOW_MODE=true` y la
// decisión de usarlo vive en `brain.js`; aquí solo se redacta la línea.
//
// ── Por qué una línea de log y no una tabla ──────────────────────────────
//
// Lo que hay que poder responder después es: «de estos 40 ciclos, qué quiso
// cambiar el modelo, qué dejó pasar el reconciliador, qué bloqueó y por qué».
// Eso son 40 líneas legibles, no un esquema nuevo con su migración, su
// retención y su backup. El repo ya tiene una convención para esto —`[TXN]
// evento=…`— y los logs de Railway ya se leen todos los días. Reutilizarla
// cuesta cero y no deja nada que limpiar cuando el modo se apague.
//
// ── Qué NO se guarda ─────────────────────────────────────────────────────
//
// La conversación se identifica por un hash corto de su id, no por el
// teléfono. El mensaje del cliente se recorta y se le tapan las corridas
// largas de dígitos —un teléfono, un número de tarjeta dictado— porque para
// entender una decisión del carrito no hace falta ninguna de las dos cosas.
// La dirección puede quedar dentro del texto recortado: es el precio de poder
// leer el turno, y por eso el recorte es corto y el modo es temporal.
import { createHash } from 'node:crypto';

const MAX_TEXTO = 240;

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
 * Una línea por turno. `recon` es lo que devolvió `reconciliar`.
 *
 * Nunca lanza: un fallo escribiendo un log de observación no puede tumbar el
 * turno de un cliente, que es justo lo que el modo sombra promete no hacer.
 */
export function registrarSombra({ sessionId, negocioId, mensaje, previo, propuesta, recon }) {
  try {
    const c = recon?.cambios || {};
    const linea = {
      ts: new Date().toISOString(),
      conv: idCorto(sessionId),
      negocio: negocioId,
      dijo: textoSeguro(mensaje),
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
    };
    console.warn('[TXN] evento=carrito_sombra ' + JSON.stringify(linea));
  } catch (e) {
    console.error('[SOMBRA] no se pudo registrar el turno:', e.message);
  }
}
