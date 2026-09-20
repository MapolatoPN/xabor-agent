// ─── LA RESPUESTA QUE SE PIERDE DESPUÉS DEL COMMIT ────────────────────────
//
// El riesgo abierto en `docs/mesero-rescue-status.md` §14: `registrarPedido`
// hace COMMIT en Postgres y la respuesta NO vuelve —la conexión se cae, el
// pool mata al cliente, el proceso muere—. El agente se queda sin saber si el
// pedido existe y, en el peor reparto posible, el estado de la conversación
// TAMPOCO llega a guardarse: la misma caída que se llevó la respuesta se lleva
// el `guardarEstado` de `canalDelAgente.js:184`.
//
// Ese es el caso que se prueba aquí, y es el peligroso, porque el turno
// siguiente rehidrata el estado ANTERIOR: el carrito completo, el pedido en
// «listo» y ni un solo hecho que diga que hubo un COMMIT. El cliente insiste
// —«¿sí quedó?»—, el modelo vuelve a llamar a `confirmar_pedido` y no hay nada
// en la conversación que pueda impedir el segundo pedido.
//
// Lo único que sobrevive a esa pérdida es lo que quedó escrito en Postgres: el
// pedido (invisible para la conversación, porque su folio nunca volvió) y la
// fila del libro de operaciones. Por eso la guardia vive en el libro
// —`buscarConfirmacionPrevia`, más el índice único de la migración 084— y no
// en el estado: un estado que puede perderse no puede ser la defensa contra
// perder el estado.
//
// ── Qué es de mentira aquí y qué no ──────────────────────────────────────
//
// Aislada de verdad: sin base, sin red, sin modelo y sin efectos reales. El
// «Postgres» es un array que hace de `pedidos_activos`, y el libro usa su
// almacén de memoria, que tiene la misma semántica que el de Postgres,
// incluidas la unicidad de la clave y la guardia por confirmación previa.
//
// Lo que NO se sustituye es el camino: el bucle real (`agenteDelMesero`), el
// ejecutor real, el reconciliador real, la máquina de estados real y
// `confirmarYEmitir` real —que es quien decide que un error sin clasificar no
// se puede degradar a «rechazado seguro»—.
//
// ── Las mordidas van dentro ──────────────────────────────────────────────
//
// P10 y P11 desactivan, una por una, las dos garantías que sostienen todo lo
// anterior, y exigen que con ellas apagadas SÍ nazca el segundo pedido. Una
// prueba que solo mira el caso bueno no distingue entre un sistema que
// protege y un sistema que nunca fue puesto a prueba.
import assert from 'node:assert/strict';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { estadoNuevo, estadoSerializable } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { libroDeOperaciones, almacenEnMemoria } from '../src/mesero-agente/libroDeOperaciones.js';
import { vistaDelPedido } from '../src/mesero-agente/vistaDelPedido.js';
import { confirmarYEmitir, desenlaceDelTurno, avisarAHumano } from '../src/mesero-agente/canalDelAgente.js';
import { cicloParaTurno } from '../src/mesero-agente/cicloDelAgente.js';
import { transicionLegal, FALLIDO } from '../src/mesero-agente/maquinaDeEstados.js';
import { NEGOCIOS, preciosDe, idDe } from './replay/cartas.mjs';

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

const NEGOCIO = NEGOCIOS.obispado;
const CATALOGO = NEGOCIO.catalogo;
const PRECIOS = preciosDe(CATALOGO);
const TELEFONO = '528781234567';
// Un producto sin grupos obligatorios: lo que se prueba aquí es la caída del
// registro, no el armado del pedido. Con «Waffle» el carrito queda listo en
// cuanto tiene modalidad y pago, sin aclaraciones de por medio.
const WAFFLE = idDe(CATALOGO, 'Waffle');
const CONVERSACION = `agente:${TELEFONO}`;

// ── EL POSTGRES DE MENTIRA, con la única propiedad que importa ───────────
//
// El INSERT ocurre ANTES de que la llamada pueda fallar. Eso es lo que hace
// que este caso no sea un error más: cuando `registrar` lanza, el pedido YA
// está, y nadie del lado de la conversación lo sabe.
function baseSimulada() {
  const base = {
    pedidos: [],
    // Qué le pasa a la respuesta del COMMIT: 'vuelve' o 'se_pierde'.
    respuesta: 'vuelve',
    contador: 9000,
    async registrar(orden, canal) {
      base.contador += 1;
      const pedido = {
        id: `XAB-${base.contador}`, negocioId: orden.negocioId, canal,
        items: orden.items, modalidad: orden.modalidad, estado: 'nuevo',
      };
      base.pedidos.push(pedido); // ← EL COMMIT. A partir de aquí no hay vuelta atrás.
      if (base.respuesta === 'se_pierde') {
        // Literalmente lo que devuelve `pg` cuando el servidor cierra la
        // conexión con la transacción ya confirmada.
        throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
      }
      return pedido;
    },
  };
  return base;
}

/**
 * El proceso murió justo después del COMMIT: el UPDATE que cierra la fila de
 * la confirmación nunca llegó a Postgres y la fila se queda en 'pendiente'.
 * Es el otro reparto posible de la misma caída, y el libro tiene que tratarlo
 * igual de mal.
 */
function almacenQueNoCierraLaConfirmacion() {
  const base = almacenEnMemoria();
  return {
    ...base,
    async cerrar(clave, cambios) {
      const fila = await base.buscar(clave);
      if (fila?.herramienta === 'confirmar_pedido') return null;
      return base.cerrar(clave, cambios);
    },
  };
}

/**
 * LA MORDIDA: la guardia solo mira confirmaciones que salieron bien.
 *
 * Es la regresión creíble —«una fila en error no debería bloquear nada»— y
 * apaga las DOS capas a la vez, porque las dos preguntan por aquí: la del
 * libro (`libroDeOperaciones.js:197`) y la del propio almacén, que es la que
 * refleja el índice único de la 084.
 */
function almacenQueSoloBloqueaExitos() {
  const base = almacenEnMemoria();
  return {
    ...base,
    async buscarConfirmacionPrevia(negocioId, conversacionId) {
      const previa = await base.buscarConfirmacionPrevia(negocioId, conversacionId);
      return previa && previa.estado === 'ok' ? previa : null;
    },
  };
}

// ── EL MODELO DE GUION ───────────────────────────────────────────────────
//
// Mismo trato que en el replay: el modelo se sustituye, el sistema no. Un
// paso puede traer su `input` como función para leer la huella del resumen
// VIVO, que es lo que hace el modelo real —la lee del `ver_pedido` que acaba
// de recibir— y lo que un valor escrito a mano dejaría de probar.
function modeloDeGuion(pasos, vivo) {
  let i = 0;
  return async () => {
    const paso = pasos[i];
    i += 1;
    if (!paso) return { stop_reason: 'end_turn', content: [{ type: 'text', text: '(guion agotado)' }] };
    if (paso.texto !== undefined) return { stop_reason: 'end_turn', content: [{ type: 'text', text: paso.texto }] };
    return {
      stop_reason: 'tool_use',
      content: (paso.tools || []).map((h, n) => ({
        type: 'tool_use', id: `tu_${i}_${n}`, name: h.name,
        input: typeof h.input === 'function' ? h.input(vivo()) : (h.input || {}),
      })),
    };
  };
}

const MENSAJE_ARMAR = 'un waffle para recoger, efectivo';
const RESUMEN_ARMAR = 'Un waffle, $105, para recoger, efectivo. ¿Lo confirmo?';

const GUION_ARMAR = [
  { tools: [{ name: 'buscar_producto', input: { texto: 'waffle' } }] },
  { tools: [{ name: 'agregar_producto', input: { producto_id: WAFFLE, cantidad: 1 } }] },
  { tools: [{ name: 'definir_entrega', input: { modalidad: 'recoger en tienda' } }] },
  { tools: [{ name: 'definir_pago', input: { forma_pago: 'efectivo' } }] },
  { tools: [{ name: 'ver_pedido', input: {} }] },
  { texto: RESUMEN_ARMAR },
];

const GUION_CONFIRMAR = [
  { tools: [{ name: 'ver_pedido', input: {} }] },
  { tools: [{ name: 'confirmar_pedido', input: (vista) => ({ huella_resumen: vista.huella }) }] },
  { texto: '¡Listo! Tu pedido quedó confirmado.' },
];

async function turno({ estado, libro, turnoId, mensaje, guion, efectos, historial = [] }) {
  const vivo = () => vistaDelPedido({
    carrito: estado.carrito, catalogo: CATALOGO, precios: PRECIOS,
    requierePago: true, hechos: estado.hechos,
  });
  return atenderTurnoConHerramientas({
    negocioId: NEGOCIO.id, conversacionId: estado.conversacionId, turnoId,
    mensaje, historial, catalogo: CATALOGO, precios: PRECIOS, requierePago: true,
    estado, libro, efectos, modo: 'prueba', topeIteraciones: 8,
    llamarModelo: modeloDeGuion(guion, vivo),
    contexto: { nombreNegocio: NEGOCIO.nombre, textoCiclo: mensaje },
  });
}

// Los efectos productivos, con la puerta real: `confirmarYEmitir`. Lo único
// inyectado es a dónde escribe —la base de mentira—, igual que hace
// `test/fase-agente-emision.mjs`.
function efectosDe(base, registro) {
  return {
    confirmar: async ({ estado, pedido }) => confirmarYEmitir({
      negocioId: NEGOCIO.id, telefono: TELEFONO, nombre: 'Prueba', canal: 'whatsapp',
      estado, pedido,
      registrar: (orden, canal) => base.registrar(orden, canal),
      emitir: async (p) => { registro.emitidos.push(p.id); },
      guardar: async (_tel, p) => { registro.historizados.push(p.id); },
    }),
    escalar: async ({ motivo }) => { registro.escalaciones.push(motivo); return { ok: true }; },
  };
}

/**
 * LA CAÍDA. Dos turnos: uno que deja el pedido listo y se guarda, y otro que
 * confirma, hace COMMIT y pierde la respuesta sin llegar a guardar nada.
 *
 * `degradarError` es la mordida P11: convierte el error sin clasificar en un
 * «rechazado seguro», que es justo lo que `confirmarYEmitir` se niega a hacer.
 */
async function escenarioRespuestaPerdida({ almacen = almacenEnMemoria(), degradarError = false } = {}) {
  const base = baseSimulada();
  const registro = { emitidos: [], historizados: [], escalaciones: [] };
  const libro = libroDeOperaciones(almacen);
  const reales = efectosDe(base, registro);
  const efectos = degradarError
    ? { ...reales,
      confirmar: async (args) => {
        try { return await reales.confirmar(args); } catch (e) { return { ok: false, motivo: e.message }; }
      } }
    : reales;
  const estado = estadoNuevo({ negocioId: NEGOCIO.id, conversacionId: CONVERSACION });

  const t1 = await turno({ estado, libro, turnoId: 't1', guion: GUION_ARMAR, efectos,
    mensaje: MENSAJE_ARMAR });
  // Fin del turno 1: el adaptador guarda el estado. Esta copia es lo que
  // quedaría en `conversacion_estado`, y es lo único que el turno siguiente
  // podrá leer después de la caída.
  const guardado = estadoSerializable(estado);

  base.respuesta = 'se_pierde';
  const t2 = await turno({ estado, libro, turnoId: 't2', guion: GUION_CONFIRMAR, efectos,
    mensaje: 'sí, confírmalo',
    historial: [{ rol: 'user', texto: MENSAJE_ARMAR }, { rol: 'assistant', texto: RESUMEN_ARMAR }] });
  // Y aquí NO se guarda nada. Ese es el caso.
  return { base, registro, libro, almacen, estado, guardado, efectos, t1, t2 };
}

/** El turno siguiente, con lo que de verdad hay en la base: el estado viejo. */
async function turnoSiguiente(esc, turnoId, mensaje = 'oye, ¿sí entró mi pedido? confírmalo, por favor') {
  const estado = estadoSerializable(esc.guardado);
  const salida = await turno({ estado, libro: esc.libro, turnoId, mensaje,
    guion: GUION_CONFIRMAR, efectos: esc.efectos,
    historial: [{ rol: 'user', texto: 'sí, confírmalo' }] });
  return { estado, salida };
}

// La señal exacta que mira el adaptador productivo (`canalDelAgente.js:173`)
// para escalar y no prometerle al cliente un pedido que no puede verificar.
const hayIncierta = (salida) => (salida.operaciones || [])
  .some((o) => o.resultado?.estado === 'incierta');

const opConfirmar = (salida) => (salida.operaciones || [])
  .find((o) => o.herramienta === 'confirmar_pedido');

// ═══════════════════════════════════════════════════════════════════════════
// EL ESCENARIO, corrido una vez y examinado por partes
// ═══════════════════════════════════════════════════════════════════════════

const perdida = await escenarioRespuestaPerdida();
const siguiente = await turnoSiguiente(perdida, 't3');

await t('P1 el COMMIT ocurrió aunque la respuesta no volviera', async () => {
  assert.equal(perdida.t1.pedido.estado, 'listo', 'el turno 1 tiene que dejar el pedido listo');
  assert.equal(perdida.base.pedidos.length, 1, 'el pedido tenía que quedar escrito en la base');
  assert.match(String(perdida.t2.error || ''), /Connection terminated/,
    'el turno de la caída tiene que terminar sabiendo que no sabe');
  assert.equal(perdida.t2.folio, null, 'no se puede conocer un folio cuya respuesta se perdió');
  // La consecuencia operativa, y la razón de que esto necesite a una persona:
  // el pedido existe y NO llegó ni al panel ni a la impresora.
  assert.deepEqual(perdida.registro.emitidos, [], 'un pedido cuya respuesta se perdió no se emite');
  assert.deepEqual(perdida.registro.historizados, [], 'tampoco se historiza');
});

await t('P2 la caída queda anotada en el libro, no en el aire', async () => {
  const filas = await perdida.libro.operacionesDelTurno({ conversacionId: CONVERSACION });
  const confirmaciones = filas.filter((f) => f.herramienta === 'confirmar_pedido');
  assert.equal(confirmaciones.length, 1, 'la confirmación caída tiene que dejar UNA fila');
  assert.equal(confirmaciones[0].estado, 'error');
  assert.equal(confirmaciones[0].aplicada, false);
  assert.match(String(confirmaciones[0].error || ''), /Connection terminated/);
});

await t('P3 el turno siguiente NO crea un segundo pedido', async () => {
  // El estado que se leyó es el de ANTES de la caída: pedido listo, sin
  // confirmar. La conversación no tiene forma de saber lo que pasó; la única
  // defensa es lo que quedó escrito.
  assert.equal(perdida.guardado.hechos.confirmado, false);
  assert.equal(perdida.guardado.folio, null);
  assert.equal(perdida.base.pedidos.length, 1, 'se registró un segundo pedido por el mismo waffle');
  assert.deepEqual(perdida.registro.emitidos, [], 'no puede emitirse un pedido que no se registró');
});

await t('P4 al modelo se le dice «incierta», no se le inventa un folio', async () => {
  const op = opConfirmar(siguiente.salida);
  assert.ok(op, 'el modelo volvió a llamar a confirmar_pedido y esa llamada tiene que constar');
  assert.equal(op.resultado.aplicado, false);
  assert.equal(op.resultado.estado, 'incierta');
  assert.match(String(op.resultado.motivo || ''), /confirmacion_incierta/);
  assert.equal(op.resultado.folio, undefined, 'no se puede anunciar un folio que nadie conoce');
  assert.equal(siguiente.estado.hechos.confirmado, false, 'un resultado incierto no es una confirmación');
  assert.equal(siguiente.estado.folio, null);
});

await t('P5 el adaptador recibe la señal que lo hace escalar', async () => {
  // `canalDelAgente.js:173` busca exactamente esto para pedir intervención
  // humana y contestarle al cliente que se está revisando. Sin la señal, el
  // bot responde con normalidad sobre un pedido que nadie concilió.
  assert.equal(hayIncierta(siguiente.salida), true);
});

await t('P6 si el proceso murió antes de cerrar la fila, tampoco duplica', async () => {
  // La otra mitad del mismo accidente: la fila queda 'pendiente' porque el
  // UPDATE nunca llegó. Un pendiente es una ejecución cortada a la mitad, y
  // en `confirmar_pedido` cortada a la mitad puede significar «ya hay pedido».
  const esc = await escenarioRespuestaPerdida({ almacen: almacenQueNoCierraLaConfirmacion() });
  const filas = await esc.libro.operacionesDelTurno({ conversacionId: CONVERSACION });
  const confirmacion = filas.find((f) => f.herramienta === 'confirmar_pedido');
  assert.equal(confirmacion?.estado, 'pendiente', 'la fila tenía que quedarse a medias');
  assert.equal(esc.base.pedidos.length, 1);

  const sig = await turnoSiguiente(esc, 't3');
  assert.equal(esc.base.pedidos.length, 1, 'una fila pendiente dejó pasar un segundo pedido');
  assert.equal(hayIncierta(sig.salida), true);
  assert.equal(sig.estado.hechos.confirmado, false);
});

await t('P7 la reentrega del mismo webhook tampoco reintenta', async () => {
  // Meta reintenta el webhook con el mismo mensaje: llega con el MISMO
  // turno_id, así que la clave de operación es la misma; y como el estado se
  // perdió, el pedido vuelve a estar «listo» y la huella vuelve a coincidir.
  const esc = await escenarioRespuestaPerdida();
  const sig = await turnoSiguiente(esc, 't2', 'sí, confírmalo');
  assert.equal(esc.base.pedidos.length, 1, 'la reentrega del webhook creó un segundo pedido');
  assert.equal(hayIncierta(sig.salida), true);
});

await t('P8 la congelación es de confirmar_pedido, no una parálisis general', async () => {
  // Un `agregar_producto` que revienta SÍ se reintenta: dar por aplicada una
  // operación que falló es cómo se pierde un renglón sin que nadie lo note.
  // Lo que no se reintenta a ciegas es lo único que pudo crear un pedido.
  const libro = libroDeOperaciones(almacenEnMemoria());
  const agregar = { negocioId: NEGOCIO.id, conversacionId: 'c-p8', turnoId: 't1',
    herramienta: 'agregar_producto', argumentos: { producto_id: WAFFLE, cantidad: 1 } };
  let intentosAgregar = 0;
  await assert.rejects(() => libro.ejecutarUnaVez(agregar, async () => {
    intentosAgregar += 1; throw new Error('timeout');
  }));
  await libro.ejecutarUnaVez(agregar, async () => {
    intentosAgregar += 1; return { aplicada: true, estado: 'ok', resultado: { aplicado: true } };
  });
  assert.equal(intentosAgregar, 2, 'un agregar que reventó tiene que poder reintentarse');

  const confirmar = { ...agregar, herramienta: 'confirmar_pedido', argumentos: { huella_resumen: 'h' } };
  let intentosConfirmar = 0;
  await assert.rejects(() => libro.ejecutarUnaVez(confirmar, async () => {
    intentosConfirmar += 1; throw new Error('Connection terminated unexpectedly');
  }));
  const segunda = await libro.ejecutarUnaVez({ ...confirmar, turnoId: 't2' }, async () => {
    intentosConfirmar += 1; return { aplicada: true, estado: 'ok', resultado: { aplicado: true, folio: 'XAB-9999' } };
  });
  assert.equal(intentosConfirmar, 1, 'una confirmación incierta no se reintenta a ciegas');
  assert.equal(segunda.estado, 'incierta');
});

await t('P9 la guardia es por conversación: un ciclo nuevo estrena identidad', async () => {
  // El límite de lo que esta prueba demuestra, dicho a propósito. El libro
  // bloquea dentro de ESTA conversación; un ciclo nuevo (`cicloDelAgente.js`)
  // estrena `conversacion_id` y la guardia ya no lo alcanza. Lo que cubre ese
  // camino es `estado.confirmacionIncierta`, y eso vive en el estado — que en
  // este accidente es justo lo que puede no haberse guardado.
  const previa = await perdida.almacen.buscarConfirmacionPrevia(NEGOCIO.id, CONVERSACION);
  assert.ok(previa, 'la confirmación caída tiene que quedar localizable por conversación');
  assert.equal(previa.herramienta, 'confirmar_pedido');
  const enOtroCiclo = await perdida.almacen.buscarConfirmacionPrevia(NEGOCIO.id, `${CONVERSACION}:c1`);
  assert.equal(enOtroCiclo, null, 'si esto cambia, la nota de riesgo de §14 hay que reescribirla');
});

// ── LAS MORDIDAS ─────────────────────────────────────────────────────────

await t('P10 mordida: si la guardia solo bloquea éxitos, nace el segundo pedido', async () => {
  const esc = await escenarioRespuestaPerdida({ almacen: almacenQueSoloBloqueaExitos() });
  assert.equal(esc.base.pedidos.length, 1, 'la mordida no debe alterar el primer COMMIT');
  const sig = await turnoSiguiente(esc, 't3');
  assert.equal(esc.base.pedidos.length, 2,
    'con la guardia apagada el duplicado tiene que aparecer; si no, P3 no está probando nada');
  assert.equal(hayIncierta(sig.salida), false);
});

await t('P11 mordida: degradar el error a «rechazo seguro» duplica el pedido', async () => {
  // `confirmarYEmitir` relanza lo que no puede clasificar (canalDelAgente.js:319)
  // justo para que el libro anote 'error' y no 'rechazada'. La regresión
  // tentadora es la contraria —«devolver ok:false es más limpio que lanzar»—,
  // y su precio es este: una confirmación con resultado desconocido queda
  // archivada como desenlace cerrado y deja de bloquear nada.
  const esc = await escenarioRespuestaPerdida({ degradarError: true });
  assert.equal(esc.base.pedidos.length, 1);
  const filas = await esc.libro.operacionesDelTurno({ conversacionId: CONVERSACION });
  const confirmacion = filas.find((f) => f.herramienta === 'confirmar_pedido');
  assert.equal(confirmacion?.estado, 'rechazada', 'el error degradado se archiva como rechazo');

  const sig = await turnoSiguiente(esc, 't3');
  assert.equal(esc.base.pedidos.length, 2,
    'con el error degradado el duplicado tiene que aparecer; si no, el relanzamiento no es lo que protege');
  assert.equal(hayIncierta(sig.salida), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// LA SEGUNDA MITAD DEL ACCIDENTE: QUE ALGUIEN SE ENTERE
// ═══════════════════════════════════════════════════════════════════════════
//
// Todo lo de arriba prueba que el pedido no se duplica. Nada de ello prueba
// que alguien lo sepa, y durante un tiempo nadie lo supo: el `catch` del
// agente marcaba FALLIDO y luego llamaba a `pedir_humano`, que era ilegal
// desde FALLIDO. El efecto no corría, el cliente leía «te paso con alguien
// del equipo» y el pedido se quedaba en Postgres sin llegar al panel ni a la
// impresora. Esta prueba no distinguía ese caso porque solo miraba duplicados.

await t('P12 la caída SÍ convoca a una persona', async () => {
  // El texto promete a alguien. Esto comprueba que ese alguien exista.
  assert.equal(perdida.registro.escalaciones.length > 0, true,
    'la caída tras el COMMIT dejó al cliente esperando a un humano que nadie llamó');
  assert.match(String(perdida.registro.escalaciones[0] || ''), /Connection terminated/,
    'el motivo del handoff tiene que decir qué reventó');
  assert.equal(perdida.t2.escalado, true, 'el turno tiene que salir escalado, no solo decirlo');
  assert.equal(perdida.t2.handoffPendiente, false, 'el handoff se entregó: no queda pendiente');
  assert.match(perdida.t2.texto, /alguien del equipo/);
});

await t('P13 escalar es legal desde un terminal, incluido FALLIDO', async () => {
  // La línea exacta que estaba mal. Escalar no muta el pedido: cambia de
  // manos la conversación, y un terminal es justo cuando más falta hace.
  assert.equal(transicionLegal('pedir_humano', FALLIDO).legal, true);
  // Y lo que NO cambió: desde un terminal sigue sin poderse tocar el pedido.
  assert.equal(transicionLegal('agregar_producto', FALLIDO).legal, false);
  assert.equal(transicionLegal('confirmar_pedido', FALLIDO).legal, false);
});

await t('P14 mordida: un handoff que no se entrega no se puede callar', async () => {
  // La garantía de fondo no es «pedir_humano es legal»: es que la salida de
  // emergencia no puede prometer una persona sin comprobar que la hay. Se
  // apaga el destino del handoff —el caso real es `escalarAHumano` sin
  // configurar, o el envío caído— y el turno tiene que DELATARLO.
  const base = baseSimulada();
  const registro = { emitidos: [], historizados: [], escalaciones: [] };
  const libro = libroDeOperaciones(almacenEnMemoria());
  const reales = efectosDe(base, registro);
  const efectos = { ...reales, escalar: async () => ({ ok: false, motivo: 'handoff_sin_destino' }) };
  const estado = estadoNuevo({ negocioId: NEGOCIO.id, conversacionId: 'agente:p14' });

  await turno({ estado, libro, turnoId: 't1', guion: GUION_ARMAR, efectos, mensaje: MENSAJE_ARMAR });
  base.respuesta = 'se_pierde';
  const t2 = await turno({ estado, libro, turnoId: 't2', guion: GUION_CONFIRMAR, efectos,
    mensaje: 'sí, confírmalo' });

  assert.equal(base.pedidos.length, 1, 'el COMMIT ocurrió igual');
  assert.equal(t2.escalado, false, 'sin destino no hay escalación de verdad');
  assert.equal(t2.handoffPendiente, true,
    'un handoff que no salió tiene que volver marcado; si no, el adaptador no puede reintentarlo');
  // Y con esa marca, el adaptador sabe que le toca a él.
  const d = desenlaceDelTurno({ salida: t2, confirmacionIntentada: false });
  assert.equal(d.motivoHandoff, 'AGENTE_HANDOFF_PENDIENTE');
});

await t('P14b el adaptador respeta false del canal de revisión', async () => {
  // `enviarARevision` no lanza cuando falla: devuelve false. Un callback que
  // resolvió su Promise no demuestra que la conversación quedó en revisión.
  const salio = await avisarAHumano(async () => false, NEGOCIO.id, TELEFONO, 'AGENTE_ESTADO_INCIERTO');
  assert.equal(salio, false, 'el adaptador no puede convertir false en un handoff entregado');
  const confirmado = await avisarAHumano(async () => true, NEGOCIO.id, TELEFONO, 'AGENTE_ESTADO_INCIERTO');
  assert.equal(confirmado, true);
});

await t('P15 el adaptador reconoce la caída aunque el turno vuelva sin excepción', async () => {
  // `atenderTurnoConHerramientas` NO relanza: devuelve con `error`. Por eso el
  // `catch` del adaptador nunca veía este caso, y por eso la decisión se mira
  // ahora también en el camino normal.
  const d = desenlaceDelTurno({ salida: perdida.t2, confirmacionIntentada: true });
  assert.equal(d.confirmacionRota, true);
  assert.equal(d.incierta, true);
  assert.equal(d.motivoHandoff, 'AGENTE_ESTADO_INCIERTO',
    'el aviso que le sirve a la operación es «puede haber un pedido sin dueño», no uno genérico');
  assert.match(d.texto, /evitar registrarlo dos veces/);

  // LA MORDIDA: mirar SOLO la señal del libro —lo que hacía el adaptador—
  // deja este turno sin nadie a quien llamar.
  const ciego = desenlaceDelTurno({ salida: perdida.t2, confirmacionIntentada: false });
  assert.equal(ciego.motivoHandoff, null,
    'si esto deja de ser null, la mordida ya no reproduce el defecto que se corrigió');

  // El turno SIGUIENTE sí traía la señal del libro, y ese camino no cambió.
  const previo = desenlaceDelTurno({ salida: siguiente.salida, confirmacionIntentada: false });
  assert.equal(previo.motivoHandoff, 'AGENTE_CONFIRMACION_INCIERTA');
});

await t('P16 la conversación queda congelada: un ciclo nuevo no puede duplicar', async () => {
  // El agujero que quedaba: con el estado guardado como `fallido`, «quiero
  // hacer otro pedido» abría otro ciclo, y la guardia del libro es POR
  // CONVERSACIÓN —en el ciclo nuevo no encuentra nada—. Lo que lo cierra es
  // que el adaptador marque `confirmacionIncierta` antes de guardar.
  const esc = await escenarioRespuestaPerdida();
  const d = desenlaceDelTurno({ salida: esc.t2, confirmacionIntentada: true });
  assert.equal(d.incierta, true, 'sin esto el adaptador no marcaría nada');

  const conMarca = estadoSerializable(esc.estado);
  conMarca.confirmacionIncierta = true;          // ← lo que escribe el adaptador
  const mismo = cicloParaTurno(conMarca, 'quiero hacer otro pedido');
  assert.equal(mismo.conversacionId, CONVERSACION,
    'una confirmación incierta no puede abrir ciclo nuevo: la guardia del libro dejaría de alcanzar');

  // LA MORDIDA: sin la marca, el ciclo nuevo estrena identidad y el segundo
  // pedido nace de verdad. Es el defecto, reproducido.
  const sinMarca = estadoSerializable(esc.estado);
  delete sinMarca.confirmacionIncierta;
  const otro = cicloParaTurno(sinMarca, 'quiero hacer otro pedido');
  assert.notEqual(otro.conversacionId, CONVERSACION, 'el ciclo nuevo tenía que estrenar identidad');

  esc.base.respuesta = 'vuelve';
  await turno({ estado: otro, libro: esc.libro, turnoId: 't8', guion: GUION_ARMAR,
    efectos: esc.efectos, mensaje: MENSAJE_ARMAR });
  await turno({ estado: otro, libro: esc.libro, turnoId: 't9', guion: GUION_CONFIRMAR,
    efectos: esc.efectos, mensaje: 'sí, confírmalo' });
  assert.equal(esc.base.pedidos.length, 2,
    'sin la marca el duplicado tiene que aparecer; si no, P16 no está probando nada');
});

await t('P17 un fallo tras una confirmación CONOCIDA no se disfraza de incierta', () => {
  // La otra mitad de la misma decisión, y el riesgo de pasarse de listo: si
  // el folio volvió, el pedido está y el cliente merece saberlo. Quien avisa
  // a la persona en ese caso es el `escalarYSalir` del propio agente.
  const d = desenlaceDelTurno({
    salida: { error: 'guardarEstado falló', confirmado: true, folio: 'XAB-9001',
      operaciones: [], handoffPendiente: false },
    confirmacionIntentada: true });
  assert.equal(d.confirmacionRota, false, 'con folio conocido no hay nada incierto');
  assert.equal(d.incierta, false);
  assert.equal(d.texto, null, 'no se siembra una duda sobre un pedido que sí está');
  assert.equal(d.motivoHandoff, null);

  // Y sin folio, el mismo fallo sí es el accidente de esta prueba.
  const sinFolio = desenlaceDelTurno({
    salida: { error: 'Connection terminated unexpectedly', confirmado: false, folio: null,
      operaciones: [], handoffPendiente: false },
    confirmacionIntentada: true });
  assert.equal(sinFolio.motivoHandoff, 'AGENTE_ESTADO_INCIERTO');
});

console.log(`\n${'─'.repeat(70)}`);
console.log(`PASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
