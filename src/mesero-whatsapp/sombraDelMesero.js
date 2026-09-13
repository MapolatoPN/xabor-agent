// ─── Ver qué haría el mesero, sin que haga nada ───────────────────────────
//
// Observación en copia. Corre el turno completo del mesero contra un contexto y
// un carrito que viven FUERA de la sesión productiva, y escribe una línea.
//
// ── Por qué se copia el patrón de `registroSombra` y no se reutiliza ─────
//
// Aquel observa al reconciliador; este observa al mesero entero, que es otro
// experimento con otro código y otro riesgo. Compartir el estado haría que
// encender uno moviera al otro, y compartir el interruptor haría imposible
// apagar solo el que estorba. Lo que sí se copia —porque es lo que lo hace
// seguro— es la disciplina:
//
//   estado propio          un Map suyo, acotado, que no toca `session`
//   nunca lanza            todo dentro de un try/catch que devuelve {ok:false}
//   nunca espera           tope de tiempo, y quien llama no aguarda el
//                          resultado; un observador lento no puede retener un
//                          turno hasta que el vigilante lo dé por no verificado
//   sin efectos            este archivo no importa el canal, ni la base de
//                          escritura, ni el registro de pedidos. No hay forma
//                          de que responda: no tiene con qué
//   sin datos personales   la conversación es un hash, los números se tapan
//
// ── Y una diferencia con la sombra del reconciliador ─────────────────────
//
// Aquella vive en los tres puntos donde el canal YA decidió callar. Esta puede
// vivir ahí también, pero su caso interesante es otro: un negocio con el bot
// ENCENDIDO y en V2, donde se quiere comparar lo que el mesero habría hecho con
// lo que el sistema hizo. Por eso `observarTurnoDelMesero` recibe el carrito
// productivo como PUNTO DE PARTIDA opcional y jamás lo devuelve modificado: se
// clona antes de tocarlo.
import { createHash } from 'node:crypto';
import { atenderTurno } from './meseroDigital.js';
import { resumenDelContexto } from './contextoMesa.js';

/** Cuántas conversaciones se recuerdan a la vez. */
export const TOPE_CONVERSACIONES = 500;

/** Cuántos turnos de cada una. */
export const TOPE_TURNOS = 12;

/** Cuánto se le da al turno antes de abandonarlo. */
export const TOPE_MS = 8000;

const estado = new Map();

/** Para las pruebas: dejar la memoria como estaba. */
export const reiniciarSombraMesero = () => estado.clear();

/** Cuántas conversaciones se están observando. */
export const conversacionesObservadas = () => estado.size;

const hash = (s) => createHash('sha256').update(String(s || '')).digest('hex').slice(0, 10);

/** Rachas de dígitos fuera: un teléfono o una dirección no aportan nada al log. */
export const textoSeguro = (s) => String(s || '').replace(/\d{3,}/g, '###').slice(0, 160);

function conLimite(promesa, ms) {
  return new Promise((resolve) => {
    const reloj = setTimeout(() => resolve({ ok: false, motivo: 'tiempo' }), ms);
    Promise.resolve(promesa).then(
      (v) => { clearTimeout(reloj); resolve({ ok: true, valor: v }); },
      (e) => { clearTimeout(reloj); resolve({ ok: false, motivo: e?.message || 'error' }); },
    );
  });
}

/**
 * Observa un turno con el mesero. No responde, no guarda pedido, no cobra.
 *
 * Devuelve siempre un objeto; nunca lanza. `{ ok: false }` significa que la
 * observación no pudo hacerse, y eso NO es un problema del turno real.
 *
 * `cargarCatalogo` es opcional: sin él, el mesero observa sin carta y las
 * consultas de menú quedan sin contestar en la copia. Es preferible a que la
 * observación añada una consulta a la base en el camino caliente de cada turno.
 */
export async function observarTurnoDelMesero({
  sessionId, negocioId, mensaje, carritoProductivo = null,
  cargarCatalogo = null, proponer = null, tope = TOPE_MS,
} = {}) {
  try {
    const clave = `${negocioId}::${sessionId}`;
    if (!estado.has(clave)) {
      if (estado.size >= TOPE_CONVERSACIONES) {
        // La más vieja se va. Un observador que crece sin límite acaba tirando
        // el proceso que observa, que es la peor forma de fallar.
        estado.delete(estado.keys().next().value);
      }
      estado.set(clave, { contexto: null, carrito: null, turnos: 0 });
    }
    const guardado = estado.get(clave);
    if (guardado.turnos >= TOPE_TURNOS) return { ok: false, motivo: 'tope_de_turnos' };

    let catalogo = [];
    if (typeof cargarCatalogo === 'function') {
      const leido = await conLimite(cargarCatalogo(negocioId), tope);
      if (leido.ok && Array.isArray(leido.valor)) catalogo = leido.valor;
    }

    // El carrito productivo se CLONA. Es la línea que impide que observar
    // cambie lo observado.
    const partida = guardado.carrito
      ?? (carritoProductivo ? JSON.parse(JSON.stringify(carritoProductivo)) : null);

    const corrida = await conLimite(atenderTurno({
      negocioId,
      conversacionId: `sombra-${hash(sessionId)}`,
      mensaje,
      contextoGuardado: guardado.contexto,
      carrito: partida,
      catalogo,
      proponer,
    }), tope);

    if (!corrida.ok) return { ok: false, motivo: corrida.motivo };
    const r = corrida.valor;
    guardado.contexto = JSON.parse(JSON.stringify(r.contexto));
    guardado.carrito = r.carrito;
    guardado.turnos += 1;

    return {
      ok: true,
      linea: lineaDeSombra({ negocioId, sessionId, r, mensaje }),
      resumen: {
        fase: r.fase,
        renglones: r.carrito.items.length,
        intenciones: r.intenciones,
        aclaraciones: r.aclaraciones.map((a) => a.tipo),
        recomendaciones: r.recomendaciones.map((x) => x.nombre),
        bloqueados: (r.decisiones || []).filter((d) => d.decision === 'rechazada').length,
      },
    };
  } catch (e) {
    // Contenido. Un fallo de la observación no puede tocar el turno real.
    return { ok: false, motivo: e?.message || 'error' };
  }
}

/** La línea que se escribe. Sin teléfono, sin nombre, con el mensaje tapado. */
export function lineaDeSombra({ negocioId, sessionId, r, mensaje }) {
  return '[SOMBRA-MESERO]'
    + ` negocio=${negocioId}`
    + ` conv=${hash(sessionId)}`
    + ` fase=${r.fase}`
    + ` intenciones=${r.intenciones.join('|')}`
    + ` renglones=${r.carrito.items.length}`
    + ` bloqueados=${(r.decisiones || []).filter((d) => d.decision === 'rechazada').length}`
    + ` aclara=${r.aclaraciones.map((a) => a.tipo).join('|') || '-'}`
    + ` recomienda=${r.recomendaciones.map((x) => x.nombre).join('|') || '-'}`
    + ` ctx=${JSON.stringify(resumenDelContexto(r.contexto))}`
    + ` msg="${textoSeguro(mensaje)}"`;
}
