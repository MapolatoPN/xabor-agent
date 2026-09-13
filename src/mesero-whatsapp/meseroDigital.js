// ─── El Mesero Digital: un turno, de principio a fin ──────────────────────
//
// Orquestador. No inventa reglas: llama a las capas en el orden correcto y
// devuelve todo lo que hace falta para responder y para persistir.
//
//   mensaje
//     -> procedencia          qué dijo el cliente y qué percibió el sistema
//     -> intenciones          preguntar no es pedir
//     -> handoff              ¿esto es para una persona?
//     -> propuestas del bot   ¿el cliente contestó a lo que se le ofreció?
//     -> referencias          ¿a qué renglón apunta?
//     -> modelo               una PROPUESTA de pedido
//     -> motor transaccional  el reconciliador decide campo a campo
//     -> menú                 lo que se preguntó, contestado desde el catálogo
//     -> recomendación        si es momento, y solo del catálogo
//     -> aclaraciones         lo que quedó sin decidir, en forma de pregunta
//     -> fase / resumen       qué falta y cómo va el pedido
//     -> métricas
//
// ── Lo que este archivo NO hace ──────────────────────────────────────────
//
// No envía mensajes, no consulta la base, no registra pedidos, no imprime, no
// cobra. Recibe el catálogo ya leído y devuelve datos. Es lo que permite correr
// una conversación entera de veinte turnos en una prueba de un segundo, y lo
// que hace imposible que un error aquí le hable a un cliente.
//
// Quien lo llame decide qué hacer con lo que devuelve. Ese es el punto de
// integración, y es pequeño a propósito.
import { separarProcedencia } from '../orders/procedenciaDeEvidencia.js';
import { hayVerboDeQuitar } from '../orders/carritoDelPedido.js';
import { palabrasQueLaSostienen } from '../orders/evidenciaDeEleccion.js';
import { nombradoPorElCliente } from '../orders/carritoDelPedido.js';
import {
  contextoDeLaConversacion, anotarTurno, sincronizarLineas, tocarLinea,
  anotarReferencia, sincronizarPendientes, clavePendiente, anotarIntentoFallido,
  marcarPreguntado, preguntadoRecientemente, resumenDelContexto,
} from './contextoMesa.js';
import {
  caducarViejas, leerRespuesta, aplicarDesenlace, proponer as registrarPropuesta,
} from './propuestasDelBot.js';
import { clasificarIntenciones, textoQueAutoriza, partirEnClausulas } from './intencionesDelCliente.js';
import { resolverReferencia } from './referenciasDelCliente.js';
import { aplicarPropuestas, propuestasDesdeBorrador, propuesta } from './motorTransaccional.js';
import { responderConsulta, resolverTermino, buscarProductos, opcionesAmbiguas } from './consultasDelMenu.js';
import { recomendar, recomendarPorPista, puedeRecomendarAhora } from './recomendaciones.js';
import { recolectarAclaraciones, aPreguntarAhora, paraElModelo } from './aclaraciones.js';
import { faseDelTurno, loQueFalta, siguientePregunta, listoParaConfirmar } from './faseConversacional.js';
import { resumenDelPedido } from './resumenDelPedido.js';
import { decidirHandoff, equipajeDelHandoff } from './handoffHumano.js';
import { eventosDelTurno } from './metricasMesero.js';

const vacio = () => ({ items: [], datos: {} });

/**
 * La cláusula donde está el verbo de quitar, y solo esa.
 *
 * «El otro déjalo igual, quita el café» son dos actos: el verbo pertenece al
 * segundo y la referencia «el otro» al primero. Juntarlos borraba «el otro».
 *
 * Se toma de la CLASIFICACIÓN y no volviendo a partir el texto acotado: ese
 * texto une los fragmentos con espacios, así que ya perdió las comas y volver a
 * cortarlo devuelve una sola cláusula. El bug duró exactamente una prueba.
 */
function clausulaDeLaBaja(clasificacion) {
  const c = (clasificacion?.porClausula || []).find((x) => x.intenciones.includes('QUITAR'));
  return c ? c.fragmento : null;
}

// Palabras que solo señalan o rellenan. Lo que sobra después de quitarlas es un
// OBJETO: algo de lo que el cliente está hablando y que no es «este renglón».
const SOLO_SENALAN = new Set([
  'el', 'la', 'lo', 'los', 'las', 'le', 'les', 'un', 'una', 'unos', 'unas',
  'ese', 'esa', 'eso', 'este', 'esta', 'esto', 'esos', 'esas', 'estos', 'estas',
  'otro', 'otra', 'otros', 'otras', 'mismo', 'misma', 'igual', 'anterior',
  'primero', 'primera', 'segundo', 'segunda', 'tercero', 'tercera', 'ultimo', 'ultima',
  'primeros', 'primeras', 'segundos', 'segundas', 'ultimos', 'ultimas',
  'ambos', 'ambas', 'todo', 'toda', 'todos', 'todas', 'dos', 'tres',
  'de', 'del', 'al', 'a', 'y', 'que', 'me', 'mi', 'tu', 'su', 'porfa', 'favor',
  'por', 'ya', 'no', 'mejor', 'pues', 'ahi', 'ahora', 'entonces', 'nomas',
]);

const enPalabras = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter(Boolean);

/**
 * ¿La baja habla de OTRA cosa además del renglón?
 *
 * «Quítale la cebolla» y «quítalo» se parecen y significan cosas distintas: la
 * primera habla de un ingrediente. Se mira lo que queda de la cláusula después
 * de sacar el verbo y las palabras que solo señalan; si queda algo, el cliente
 * nombró un objeto y esta vía —que borra el renglón entero— no es la suya.
 *
 * Se mide así y no contra el catálogo porque el ingrediente puede no estar en
 * la carta: «sin cebolla» es una nota tan válida como una opción, y borrar el
 * platillo por no encontrar la cebolla en el menú sería el peor de los mundos.
 */
function laBajaTieneOtroObjeto(clausula) {
  if (!clausula) return true;
  const verbo = enPalabras(clausula).find((w) => hayVerboDeQuitar(w));
  return enPalabras(clausula)
    .filter((w) => w !== verbo && w.length >= 3 && !SOLO_SENALAN.has(w))
    .length > 0;
}

/**
 * ¿La frase nombra una OPCIÓN de este platillo?
 *
 * «Quítale la cebolla» y «quítalo» se parecen mucho y significan cosas
 * distintas: la primera habla de un ingrediente y la segunda del plato. Si la
 * cláusula nombra algo que está en los grupos de ese producto, es lo primero, y
 * el renglón no se toca — el reconciliador ya sabe quitar opciones.
 */
function nombraUnaOpcionDe(catalogo, item, clausula) {
  if (!item || !clausula) return false;
  const producto = (catalogo || []).flatMap((c) => c?.productos || [])
    .find((p) => String(p?.nombre || '').toLowerCase() === String(item.nombre || '').toLowerCase());
  const delCatalogo = (producto?.modificadores || [])
    .flatMap((g) => (g?.opciones || []).map((o) => String(o?.nombre || '')));
  const yaPuestas = (item.modificadores || [])
    .flatMap((g) => (g?.opciones || []).map((o) => String(typeof o === 'string' ? o : o?.nombre || '')));
  return [...delCatalogo, ...yaPuestas].filter(Boolean)
    .some((o) => palabrasQueLaSostienen(o, clausula).size > 0);
}

// ── DE LO QUE FALTA A UN PENDIENTE ESTRUCTURADO ──────────────────────────
//
// Cada aclaración y cada dato que falta se convierte en un descriptor con
// identidad propia. Lo que NO se guarda nunca es la frase: `aclaraciones.js` la
// vuelve a redactar a partir de esto, así que una pregunta no puede sobrevivir
// al estado que la originó.
function descriptoresPendientes({ aclaraciones = [], falta = [], dicho = '' }) {
  const fuera = [];
  for (const a of aclaraciones) {
    const base = { candidatos: a.candidatos || [], evidenciaOrigen: dicho };
    switch (a.tipo) {
      case 'opcion_ambigua':
        fuera.push({ ...base, tipo: 'opcion_ambigua', lid: a.lid || null, producto: a.producto, grupo: a.grupo });
        break;
      case 'grupo_requerido':
        fuera.push({ ...base, tipo: 'grupo_requerido', lid: a.lid || null, producto: a.producto, grupo: a.grupo });
        break;
      case 'termino_ambiguo':
        fuera.push({ ...base, tipo: 'termino_ambiguo', dato: a.termino });
        break;
      case 'referencia_ambigua':
        fuera.push({ ...base, tipo: 'referencia_ambigua', dato: 'referencia',
          candidatos: (a.candidatos || []).map((c) => c?.nombre || c) });
        break;
      case 'respuesta_ambigua':
        fuera.push({ ...base, tipo: 'respuesta_ambigua', dato: 'propuesta' });
        break;
      case 'quitar_ambiguo':
        fuera.push({ ...base, tipo: 'quitar_ambiguo', dato: 'quitar' });
        break;
      default: break;
    }
  }
  // Los datos operativos que faltan. Los grupos requeridos ya vinieron como
  // aclaración, así que no se duplican.
  for (const f of falta) {
    if (String(f).startsWith('grupo:')) continue;
    fuera.push({ tipo: 'dato', dato: String(f), candidatos: [], evidenciaOrigen: dicho });
  }
  return fuera;
}

/**
 * LOS PENDIENTES QUE SIGUEN VIVOS AUNQUE ESTE TURNO NO LOS MENCIONE.
 *
 * `opcion_ambigua` nace del TEXTO: se detecta el turno en que el cliente dice
 * «frijolitos». Si solo existiera mientras el texto lo repite, bastaba con que
 * el cliente preguntara por los licuados para que la pregunta se diera por
 * contestada — y al turno siguiente volviera a nacer, con su contador a cero y
 * su frase recién redactada. Eso es exactamente lo que se vio en el tráfico
 * real: la misma aclaración, una y otra vez, sin memoria de haberla hecho.
 *
 * Un pendiente vive mientras viva su MOTIVO, y el motivo está en el carrito, no
 * en el mensaje: existe la línea y su grupo sigue sin elegir. Eso es lo que se
 * comprueba aquí, y es lo que hace genérica la resolución — no hace falta una
 * regla por tipo de pregunta.
 */
function pendientesQueSiguenVivos(ctx, carrito, yaVigentes) {
  const porLid = new Map((carrito?.items || []).map((i) => [i.lid, i]));
  const yaEstan = new Set(yaVigentes.map((d) => clavePendiente(d)));
  const fuera = [];
  for (const p of (ctx?.pendientes || [])) {
    if (yaEstan.has(p.clave)) continue;                 // este turno lo rehizo
    if (p.tipo !== 'opcion_ambigua' && p.tipo !== 'grupo_requerido') continue;
    const item = p.lid ? porLid.get(p.lid) : null;
    if (!item) continue;                                // su línea se fue: cancelado
    const suGrupo = String(p.grupo || '').toLowerCase();
    const yaElegido = (item.modificadores || []).some((g) => String(g?.grupo ?? '').toLowerCase() === suGrupo
      && (g?.opciones || []).length > 0);
    if (yaElegido) continue;                            // resuelto de verdad
    // Se devuelven los MISMOS candidatos: si cambiaran, el pendiente se daría
    // por obsoleto y perdería el contador de intentos que justifica el handoff.
    fuera.push({ tipo: p.tipo, lid: p.lid, producto: p.producto, grupo: p.grupo,
      candidatos: p.candidatos, evidenciaOrigen: p.evidenciaOrigen });
  }
  return fuera;
}

/** La clave corta con la que `loQueFalta` y `siguientePregunta` hablan. */
const claveCorta = (p) => (p.tipo === 'dato' ? p.dato
  : (p.tipo === 'grupo_requerido' ? `grupo:${p.grupo}` : p.clave));

/**
 * ¿ESTE mensaje contesta a ESTE pendiente?
 *
 * Para los que ofrecen candidatos: que el cliente nombre alguno. Para los datos
 * operativos: que la intención del turno sea la que resuelve ese dato.
 *
 * Todo lo demás es cambiar de tema, y cambiar de tema no es fallar.
 */
function respondeAlPendiente(p, dicho, intenciones) {
  if (p.tipo === 'dato') {
    const porDato = {
      modalidad: 'DEFINIR_MODALIDAD',
      pago: 'DEFINIR_PAGO',
      productos: 'AGREGAR_PRODUCTO',
    };
    const esperada = porDato[p.dato];
    return !!esperada && intenciones.includes(esperada);
  }
  return (p.candidatos || []).some((c) => palabrasQueLaSostienen(c, dicho).size > 0);
}

/** Los grupos requeridos que a un renglón le faltan por elegir. */
function gruposRequeridosFaltantes(carrito, catalogo) {
  const porNombre = new Map();
  for (const cat of catalogo || []) {
    for (const p of (cat?.productos || [])) porNombre.set(String(p.nombre || '').toLowerCase(), p);
  }
  const falta = [];
  for (const it of (carrito?.items || [])) {
    const p = porNombre.get(String(it.nombre || '').toLowerCase());
    if (!p) continue;
    const elegidos = new Set();
    for (const m of (it.modificadores || [])) elegidos.add(String(m?.grupo ?? '').toLowerCase());
    for (const g of (p.modificadores || [])) {
      if (g?.requerido !== true) continue;
      if (elegidos.has(String(g.nombre || '').toLowerCase())) continue;
      falta.push({ lid: it.lid, producto: it.nombre, grupo: g.nombre,
        opciones: (g.opciones || []).filter((o) => o?.disponible !== false).map((o) => o.nombre) });
    }
  }
  return falta;
}

/**
 * UN TURNO.
 *
 * `proponer` es la capa del modelo: recibe `{ texto, contexto, carrito }` y
 * devuelve un borrador (la forma que ya emite el extractor de hoy) o una lista
 * de propuestas estructuradas. Si no se pasa, el turno corre sin modelo — que
 * es como corren las pruebas y como corre el modo sombra cuando el modelo falla.
 *
 * Nunca lanza. Un fallo del modelo se convierte en `handoff` por ERROR, que es
 * lo que ya hace el canal con una excepción: pausa y avisa.
 */
export async function atenderTurno({
  negocioId, conversacionId, mensaje = '',
  contextoGuardado = null, carrito = null,
  catalogo = [], promociones = [], complementos = {}, popularidad = [], precios = null,
  requierePago = true, confirmado = false,
  datoOperativoPendiente = false, terminos = [],
  proponer = null,
  // SOLO para el modo sombra: no detenerse en un handoff, registrarlo y seguir.
  observando = false,
} = {}) {
  const ctx = contextoDeLaConversacion(contextoGuardado, { negocioId, conversacionId });
  let carritoActual = (carrito && Array.isArray(carrito.items)) ? carrito : vacio();
  sincronizarLineas(ctx, carritoActual);

  // 1) Qué dijo el cliente y qué percibió el sistema de su foto. La segunda
  //    mitad no autoriza nada, y por eso viaja aparte desde el primer paso.
  const { dicho, percibido } = separarProcedencia(mensaje);
  const turno = anotarTurno(ctx, 'cliente', mensaje, { dicho, percibido });
  caducarViejas(ctx);

  // 2) De qué tipo de acto es este mensaje.
  const clasificacion = clasificarIntenciones(dicho, { fase: ctx.fase });
  const intenciones = clasificacion.intenciones;

  // 3) ¿Esto es para una persona? Se decide ANTES de tocar el pedido: si la
  //    conversación se escala, el carrito se queda como estaba y quien entre
  //    verá lo que el cliente pidió, no lo que el bot alcanzó a interpretar.
  // ── EL HANDOFF, Y LO QUE CAMBIA EN SOMBRA ──────────────────────────────
  //
  // En producción, escalar es terminal: el bot deja de atender y una persona
  // toma la conversación. Correcto, y no se toca.
  //
  // Observando es distinto. Si la copia también se detiene, se deja de aprender
  // exactamente cuando la conversación se pone interesante: en el primer día de
  // tráfico real, 21 de 46 turnos quedaron sin observar por esto, y entre ellos
  // el turno en que el cliente por fin pidió su omelet.
  //
  // Así que se separan dos cosas que hasta ahora eran una:
  //
  //   habriaEscalado    en producción, aquí habría pasado a un humano
  //   dejarDeObservar   la copia se detiene
  //
  // Con `observando: true` lo primero se registra y lo segundo no ocurre. El
  // resultado de los turnos siguientes va marcado (`postHandoff`) para que
  // nadie lo confunda con lo que habría pasado de verdad.
  const handoff = decidirHandoff({ texto: dicho, intenciones, contexto: ctx });
  if (handoff.escalar && observando && !ctx.habriaEscalado) {
    ctx.habriaEscalado = { turno, motivo: handoff.motivo };
  }
  const yaHabriaEscalado = !!ctx.habriaEscalado;
  if (handoff.escalar && !observando) {
    ctx.fase = 'escalado_humano';
    const equipaje = equipajeDelHandoff({ contexto: ctx, carrito: carritoActual, motivo: handoff.motivo });
    return {
      contexto: ctx, carrito: carritoActual, cambios: null, decisiones: [],
      intenciones, referencia: null, desenlace: null, consulta: null, recomendaciones: [],
      aclaraciones: [], fase: ctx.fase, falta: [], siguiente: null,
      resumen: resumenDelPedido(carritoActual, { precios, requierePago }),
      handoff: { ...handoff, equipaje },
      paraElModelo: { fase: ctx.fase, handoff: handoff.motivo },
      eventos: eventosDelTurno({ negocioId, conversacion: conversacionId, intenciones, handoff, fase: ctx.fase }),
    };
  }

  // 4) ¿Contestó a lo que se le ofreció? Un «sí» produce evidencia, y solo
  //    para la referencia concreta que se le ofreció.
  const desenlace = leerRespuesta(ctx, dicho);
  aplicarDesenlace(ctx, desenlace);

  // 5) ¿A qué renglón apunta?
  const referencia = resolverReferencia(dicho, { contexto: ctx, carrito: carritoActual });
  if (referencia.tipo) anotarReferencia(ctx, referencia.frase, referencia.lids[0] || null);

  // 6) LO QUE EL CLIENTE ESCRIBIÓ, sin sus preguntas. Y NADA MÁS: la evidencia que
  // produce un «sí» viaja por su propio canal (`evidenciaAceptada`), no
  // concatenada aquí. Mezclarlas hacía que el nombre del producto aceptado
  // pudiera respaldar de paso un modificador o una nota que compartiera una
  // palabra con él, y el reconciliador no tenía cómo distinguirlas.
  const autoriza = textoQueAutoriza(dicho, { fase: ctx.fase });
  const turnosPrevios = ctx.turnos.filter((t) => t.rol === 'cliente' && t.turno < turno);
  const dichoDelCiclo = [
    ...turnosPrevios.map((t) => textoQueAutoriza(t.dicho ?? t.texto)),
    autoriza,
  ].filter(Boolean).join(' \n ');
  // El ciclo CRUDO viaja aparte: de él sale lo PERCIBIDO, y eso no se filtra —
  // se sigue queriendo saber qué creyó ver el sistema para poder preguntarlo.
  const textoCiclo = [...turnosPrevios.map((t) => t.texto), mensaje].filter(Boolean).join(' \n ');

  // 7) El modelo propone. Si falla, no se cae el turno: se escala.
  let propuestas = [];
  let errorDelModelo = null;
  if (typeof proponer === 'function') {
    try {
      const salida = await proponer({ texto: mensaje, dicho, contexto: ctx, carrito: carritoActual, intenciones });
      if (Array.isArray(salida)) propuestas = salida.filter(Boolean);
      else if (salida && typeof salida === 'object') {
        propuestas = propuestasDesdeBorrador(carritoActual, salida, { evidencia: autoriza });
      }
    } catch (e) {
      errorDelModelo = e?.message || 'fallo del modelo';
    }
  }
  if (errorDelModelo) {
    ctx.fase = 'escalado_humano';
    const porError = { escalar: true, motivo: 'ERROR', etiqueta: errorDelModelo };
    return {
      contexto: ctx, carrito: carritoActual, cambios: null, decisiones: [], intenciones,
      referencia, desenlace, consulta: null, recomendaciones: [], aclaraciones: [],
      fase: ctx.fase, falta: [], siguiente: null,
      resumen: resumenDelPedido(carritoActual, { precios, requierePago }),
      handoff: { ...porError, equipaje: equipajeDelHandoff({ contexto: ctx, carrito: carritoActual, motivo: 'ERROR' }) },
      paraElModelo: null,
      eventos: eventosDelTurno({ negocioId, conversacion: conversacionId, intenciones, handoff: porError, fase: ctx.fase }),
    };
  }

  // 8) Las propuestas que produce la REFERENCIA y el modelo no puede expresar:
  //    quitar o duplicar algo que el cliente señaló sin nombrarlo.
  // ── QUITAR POR REFERENCIA: CUATRO CANDADOS ─────────────────────────────
  //
  // Esta es la rama que más daño puede hacer, porque su resultado es borrar un
  // renglón entero, y una auditoría adversarial encontró nueve formas de que
  // borrara lo que no era. Todas tenían la misma raíz: se tomaba el verbo de
  // TODO el turno y la referencia de TODO el turno, y se los juntaba.
  //
  //   «quítale la cebolla al primero»   el verbo va al ingrediente, no al plato
  //   «quítale todo el picante»         «todo» resolvía a TODAS las líneas
  //   «el otro déjalo igual»            el verbo era de otra cláusula
  //   «quítalos, los chilaquiles»       la frase YA identificaba: se iba de más
  //
  // Los cuatro candados, en orden:
  //
  //   1. la referencia señala UNA sola línea;
  //   2. el verbo y la referencia salen de la MISMA cláusula;
  //   3. el objeto del verbo no es una opción de ese platillo — si el cliente
  //      nombró un ingrediente, habla del ingrediente;
  //   4. si la frase ya identificó alguna línea por su nombre, la referencia no
  //      añade nada: manda la frase, y el reconciliador ya sabe hacer eso.
  //
  // Con los cuatro puestos, «quita el otro» sigue funcionando y ninguno de los
  // nueve casos sobrevive.
  let referenciaBajaMultiple = null;
  if (referencia.resuelta) {
    if (referencia.accion === 'duplicar') {
      for (const lid of referencia.lids) {
        propuestas.push(propuesta({ accion: 'duplicar', lid, evidencia: referencia.frase }));
      }
    } else if (intenciones.includes('QUITAR') && referencia.lids.length > 1) {
      // «Quita los dos» es la acción de más daño posible dicha con un pronombre.
      // No se ejecuta y NO se calla: se pregunta. Callar era el comportamiento
      // anterior —la referencia resolvía, la baja no salía, y nadie decía nada—
      // y un no-op silencioso es peor que una pregunta.
      referenciaBajaMultiple = {
        tipo: referencia.tipo, frase: referencia.frase, resuelta: false, motivo: 'baja_multiple',
        candidatos: (carritoActual.items || [])
          .filter((i) => referencia.lids.includes(i.lid))
          .map((i, n) => ({ lid: i.lid, nombre: i.nombre, posicion: n + 1 })),
      };
    } else if (intenciones.includes('QUITAR') && referencia.lids.length === 1) {
      const lid = referencia.lids[0];
      const objetivo = (carritoActual.items || []).find((i) => i.lid === lid);
      const clausula = clausulaDeLaBaja(clasificacion);
      const habla = clausula && resolverReferencia(clausula, { contexto: ctx, carrito: carritoActual });
      const mismaClausula = !!habla?.resuelta && habla.lids.length === 1 && habla.lids[0] === lid;
      const hayOtroObjeto = laBajaTieneOtroObjeto(clausula)
        || nombraUnaOpcionDe(catalogo, objetivo, clausula);
      const laFraseNombraLineas = (carritoActual.items || [])
        .some((i) => palabrasQueLaSostienen(i.nombre, autoriza).size > 0);
      if (mismaClausula && !hayOtroObjeto && !laFraseNombraLineas) {
        propuestas.push(propuesta({ accion: 'quitar', lid, evidencia: clausula }));
      }
    }
  }

  // 8a) ¿LA FRASE SEPARA LA OPCIÓN DE SUS HERMANAS?
  //
  // El reconciliador exige que una opción tenga respaldo, y «frijoles» respalda
  // igual de bien a «Frijoles naturales» y a «Frijoles con chorizo»: pasa la
  // que el modelo haya escrito. El desempate ya existe —`distingueLaEleccion`—
  // pero vive en el validador, y el mesero no ejecuta el validador.
  //
  // Aquí se ejecuta. Lo que no se distingue NO se propone: se pregunta. Y la
  // pregunta abierta del turno anterior estrecha las hermanas, para que la
  // respuesta del cliente se mida contra lo que se le ofreció.
  const abiertaDelGrupo = (grupo) => (ctx.aclaraciones || [])
    .find((a) => a.tipo === 'opcion_ambigua' && String(a.grupo || '') === String(grupo || ''));
  const opcionesQueNoSeparan = [];
  if (catalogo.length) {
    propuestas = propuestas.filter((p) => {
      if (!p || p.accion !== 'cambiar_modificador') return true;
      const destino = (carritoActual.items || []).find((i) => i.lid === p.lid);
      const abierta = abiertaDelGrupo(p.campo);
      const { claras, ambiguas } = opcionesAmbiguas({
        catalogo,
        producto: destino?.nombre || '',
        grupo: p.campo,
        opciones: p.valorNuevo,
        texto: autoriza,
        hermanasRestringidas: abierta?.candidatos || null,
      });
      if (!ambiguas.length) return true;
      // El `lid` viaja con la ambigüedad: sin él, el pendiente no sabría a qué
      // renglón pertenece y no podría cancelarse cuando ese renglón se va.
      opcionesQueNoSeparan.push(...ambiguas.map((a) => ({ ...a, lid: p.lid })));
      // Lo que sí se distinguió del mismo grupo sigue adelante; lo ambiguo no.
      if (claras.length) { p.valorNuevo = claras; return true; }
      return false;
    });
  }

  // 8b) ¿PUEDE EL FOCO ATRIBUIR ESTE CAMBIO?
  //
  // Solo cuando el cliente NO nombró nada. «Mejor dos» no nombra, y entonces
  // hablar del renglón en foco es la única lectura posible. «Ponme dos cocas»
  // sí nombra, y ahí manda la regla de siempre: la palabra identifica, y si no
  // identifica, se pregunta.
  //
  // Sin esta condición, «ponme dos cocas» dicho mientras el foco está en los
  // chilaquiles autorizaría subir los chilaquiles a dos, porque la referencia
  // elíptica también casa con esa frase. Es el agujero exacto que abre atribuir
  // por contexto sin mirar si el contexto hacía falta.
  // ── LA GUARDA SE MIDE CON LA VARA DEL RECONCILIADOR ────────────────────
  //
  // Antes se usaba `buscarProductos`, que es más estricto: una errata
  // («gyosas») o un producto agotado hacían que la guarda no viera el producto
  // que el cliente sí había nombrado, y la atribución se activaba igual. Se
  // mide con `nombradoPorElCliente`, que es exactamente lo que el reconciliador
  // usará después, y sobre TODOS los productos de la carta, agotados incluidos:
  // aquí no se decide si se puede vender, se decide si el cliente nombró algo.
  //
  // Y sin catálogo NO se atribuye. La versión anterior devolvía `false` —«no
  // nombró nada»— y entregaba la atribución en todos los turnos de cualquier
  // negocio cuya carta no se pudiera leer ese día. Un fallo de lectura no puede
  // abrir una puerta.
  const todosLosNombres = (catalogo || []).flatMap((c) => (c?.productos || []).map((p) => String(p?.nombre || '')));
  const nombraAlgoDeLaCarta = !catalogo.length
    || todosLosNombres.some((n) => n && nombradoPorElCliente(n, autoriza));
  // UNA SOLA LÍNEA, Y NUNCA «TODOS».
  //
  // La atribución por foco existe para «mejor dos», que habla de un renglón.
  // Extenderla a varios abría una puerta que no hacía falta: «ponme todo para
  // 3 personas» resuelve la referencia «todo» a TODAS las líneas, y el «3»
  // suelto del mensaje habría autorizado subir a tres cualquiera de ellas que
  // el modelo tocara. Con un solo objetivo, el peor caso vuelve a ser el que
  // ya existía antes del mesero para un carrito de un renglón.
  // Y EL TURNO TIENE QUE SER UN ACTO DE CANTIDAD.
  //
  // Atar la atribución al renglón no bastaba: había que atarla también al ACTO.
  // «Así está bien, somos 3» y «Morelos 12» y «paso a las 2» traen un número y
  // una palabra que resuelve la referencia, y ninguno pide más comida. Con esta
  // condición, la atribución solo existe cuando el cliente está cambiando una
  // cantidad — que es para lo único que se añadió.
  const TIPOS_QUE_SENALAN_UNO = ['eliptica', 'deictico', 'ordinal', 'ultimo', 'otro', 'anterior', 'poseedor'];
  const atribuidos = (referencia.resuelta
    && referencia.lids.length === 1
    && TIPOS_QUE_SENALAN_UNO.includes(referencia.tipo)
    && intenciones.includes('CAMBIAR_CANTIDAD')
    && !nombraAlgoDeLaCarta)
    ? referencia.lids : [];

  // 9) EL MOTOR DECIDE. Aquí no hay reglas nuevas: se traduce y se reconcilia.
  const resultado = aplicarPropuestas(carritoActual, propuestas.filter(Boolean), {
    // Crudo, para que el carrito separe la percepción por su cuenta; y aparte,
    // acotado, lo que de verdad autoriza.
    mensaje, textoCiclo,
    dichoDelTurno: autoriza,
    dichoDelCiclo,
    // Los productos que el cliente acaba de aceptar de una sugerencia. Solo
    // habilitan que ESE renglón exista; sus campos siguen necesitando lo suyo.
    evidenciaAceptada: (desenlace.aceptadas || []).map((p) => p.referencia),
    datoOperativoPendiente, terminos,
    // Lo que la referencia identificó sin que la frase lo nombre. El carrito
    // sigue exigiendo el número por su cuenta; lo único que cambia es de dónde
    // sale la atribución.
    atribuidoPorLid: atribuidos,
  });
  const lidsAntes = new Set((carritoActual.items || []).map((i) => i.lid));
  carritoActual = resultado.carrito;
  sincronizarLineas(ctx, carritoActual);
  for (const a of resultado.cambios?.autorizados || []) if (a.lid) tocarLinea(ctx, a.lid, { foco: false });

  // ── EL FOCO ────────────────────────────────────────────────────────────
  //
  // Es de lo que va a hablar el cliente en el turno siguiente, y de él depende
  // que «mejor dos» acierte. El orden importa:
  //
  //   1. lo que el cliente acaba de señalar, si señaló algo;
  //   2. el renglón que acaba de NACER — quien pide una coca habla de la coca;
  //   3. el único renglón tocado;
  //   4. el único renglón que hay.
  //
  // El renglón nuevo se detecta comparando los `lid` de antes y de después, y
  // no por `cambios.agregados`, que lleva nombres: dos renglones del mismo
  // producto tienen el mismo nombre y distinto `lid`, que es justo el caso en
  // el que equivocarse de foco se nota.
  const nacidos = (carritoActual.items || []).map((i) => i.lid).filter((l) => !lidsAntes.has(l));
  const tocados = (resultado.cambios?.autorizados || []).map((a) => a.lid).filter(Boolean);
  if (referencia.resuelta && referencia.accion !== 'duplicar') {
    for (const lid of referencia.lids) tocarLinea(ctx, lid);
  } else if (nacidos.length === 1) tocarLinea(ctx, nacidos[0]);
  else if (tocados.length === 1) tocarLinea(ctx, tocados[0]);
  else if (carritoActual.items.length === 1) tocarLinea(ctx, carritoActual.items[0].lid);

  // 10) Lo que preguntó, contestado desde el catálogo del negocio.
  const consulta = intenciones.some((i) => i.startsWith('CONSULTA_'))
    ? responderConsulta({ catalogo, texto: dicho, intenciones, promociones })
    : null;

  // 11) Recomendar, si toca. Cada recomendación queda como PROPUESTA: no entra
  //     al pedido, y un «sí» del turno siguiente la autorizará por su nombre.
  const momento = puedeRecomendarAhora(ctx, { intenciones });
  let recomendaciones = [];
  if (momento.puede) {
    recomendaciones = intenciones.includes('PEDIR_RECOMENDACION')
      ? recomendarPorPista({ catalogo, pista: dicho, carrito: carritoActual, contexto: ctx })
      : recomendar({ catalogo, carrito: carritoActual, contexto: ctx, promociones, complementos, popularidad });
  }
  // Se anotan sobre un turno del bot: es el bot quien va a decirlas, y el
  // desenlace del turno siguiente se mide contra ese turno.
  if (recomendaciones.length) {
    anotarTurno(ctx, 'bot', recomendaciones.map((r) => r.nombre).join(', '));
    recomendaciones = recomendaciones
      .map((r) => (registrarPropuesta(ctx, { clase: 'producto', referencia: r.nombre, etiqueta: r.nombre, datos: r }) ? r : null))
      .filter(Boolean);
  }

  // 12) Lo que quedó sin decidir.
  const terminosAmbiguos = [];
  for (const s of resultado.cambios?.sinRespaldo || []) {
    if (s.campo !== 'articulo' || !catalogo.length) continue;
    const r = resolverTermino(catalogo, s.nombre);
    if (!r.resuelto && r.candidatos.length > 1) {
      terminosAmbiguos.push({ termino: s.nombre, candidatos: r.candidatos.map((c) => c.nombre) });
    }
  }
  const aclaraciones = recolectarAclaraciones({
    opcionesAmbiguas: opcionesQueNoSeparan,
    cambios: resultado.cambios,
    referencia: referenciaBajaMultiple
      || (referencia.tipo && !referencia.resuelta ? referencia : null),
    propuestas: desenlace,
    terminos: terminosAmbiguos,
    gruposFaltantes: gruposRequeridosFaltantes(carritoActual, catalogo),
  });

  // 13) En qué punto vamos y qué falta.
  const datos = { modalidad: carritoActual.datos?.modalidad ?? null, pago: carritoActual.datos?.forma_pago ?? null };
  ctx.modalidad = datos.modalidad;
  ctx.pago = datos.pago;
  ctx.aclaraciones = aclaraciones;
  const entradaFase = { intenciones, carrito: carritoActual, datos, aclaraciones, confirmado, requierePago };
  ctx.fase = faseDelTurno(entradaFase);
  const falta = loQueFalta(entradaFase);

  // ── LOS PENDIENTES, RECALCULADOS DESDE CERO CADA TURNO ─────────────────
  //
  // No se «arrastran»: se vuelven a deducir de lo que hace falta AHORA y se
  // reconcilian contra lo guardado. Un pendiente cuya línea desapareció se
  // cancela solo; uno cuyos candidatos cambiaron se rehace, porque la pregunta
  // de antes ya no lo representa. La frase no se guarda en ningún momento.
  const clavesAntes = new Set((ctx.pendientes || []).map((p) => p.clave));
  const delTurno = descriptoresPendientes({ aclaraciones, falta, dicho: autoriza });
  const vigentes = [...delTurno, ...pendientesQueSiguenVivos(ctx, carritoActual, delTurno)];
  const cicloPendientes = sincronizarPendientes(ctx, vigentes, {
    lidsVivos: (carritoActual.items || []).map((i) => i.lid),
  });

  // ── QUÉ CUENTA COMO UN INTENTO FALLIDO ─────────────────────────────────
  //
  // Solo esto: el pendiente ya existía, el cliente contestó A ÉL, y sigue sin
  // poder resolverse. Un mensaje sobre otra cosa —la dirección, otro producto,
  // un «no encuentro el menú»— no es un fallo del cliente en contestar: es una
  // conversación normal, y contarlo mandó a un humano el 46% de los turnos del
  // primer día de tráfico real.
  const aclaracionesRepetidas = [];
  for (const p of ctx.pendientes) {
    if (!clavesAntes.has(p.clave)) continue;           // nació este turno
    if (!respondeAlPendiente(p, autoriza, intenciones)) continue;
    anotarIntentoFallido(ctx, p.clave);
    aclaracionesRepetidas.push({ tipo: p.tipo, intentos: p.intentos });
  }

  const siguiente = siguientePregunta(entradaFase,
    (ctx.pendientes || []).filter((p) => preguntadoRecientemente(ctx, p.clave)).map((p) => claveCorta(p)));
  if (siguiente) {
    const suyo = (ctx.pendientes || []).find((p) => claveCorta(p) === siguiente);
    if (suyo) marcarPreguntado(ctx, suyo.clave);
  }

  const resumen = resumenDelPedido(carritoActual, { precios, requierePago });

  return {
    contexto: ctx,
    carrito: carritoActual,
    cambios: resultado.cambios,
    decisiones: resultado.decisiones,
    intenciones,
    clasificacion,
    referencia,
    desenlace,
    consulta,
    recomendaciones,
    aclaraciones,
    fase: ctx.fase,
    falta,
    siguiente,
    resumen,
    listoParaConfirmar: listoParaConfirmar(entradaFase),
    handoff: {
      escalar: false,
      // En sombra: aquí habría pasado a un humano, pero la copia siguió.
      habriaEscalado: yaHabriaEscalado,
      motivo: ctx.habriaEscalado?.motivo ?? null,
      turnoDelEscalado: ctx.habriaEscalado?.turno ?? null,
    },
    // Todo lo de este turno es CONTRAFACTUAL si el escalado ya había ocurrido:
    // en producción el bot no habría estado aquí.
    postHandoff: yaHabriaEscalado && ctx.habriaEscalado.turno < turno,
    // El ciclo de vida de las preguntas, en crudo. Va aparte de `eventos`
    // porque quien observa escribe UNA línea JSON por turno y no lee la lista
    // de eventos: si estos números solo viven ahí, no se pueden medir.
    cicloPendientes,
    aclaracionesRepetidas,
    // EL BRIEFING PARA EL MODELO. Hechos, nunca frases hechas: si se le diera
    // la redacción, la copiaría y el bot volvería a sonar a máquina.
    paraElModelo: {
      fase: ctx.fase,
      intenciones,
      pedido: resumen,
      falta,
      siguiente_pregunta: siguiente,
      consulta,
      recomendaciones: recomendaciones.map((r) => ({ nombre: r.nombre, motivo: r.motivo })),
      aclaraciones: paraElModelo(aclaraciones),
      // Lo que ya se preguntó y sigue vivo. Que el modelo lo tenga no autoriza
      // nada: solo evita que vuelva a soltar la misma frase palabra por palabra.
      no_repetir: (ctx.pendientes || [])
        .filter((p) => p.turnoUltimaPregunta !== null && p.turnoUltimaPregunta !== undefined)
        .map((p) => p.clave),
      contexto: resumenDelContexto(ctx),
    },
    eventos: eventosDelTurno({
      negocioId, conversacion: conversacionId, intenciones, aclaraciones: aPreguntarAhora(aclaraciones),
      recomendaciones, desenlace, decisiones: resultado.decisiones, cambios: resultado.cambios,
      // El evento del escalado hipotético se emite UNA vez, en su turno. Los
      // siguientes llevan `post_handoff`, que es otra cosa y se cuenta aparte.
      handoff: yaHabriaEscalado && ctx.habriaEscalado.turno === turno
        ? { escalar: false, habriaEscalado: true, motivo: ctx.habriaEscalado.motivo, turnoDelEscalado: turno }
        : null,
      confirmado, fase: ctx.fase,
      pendientes: cicloPendientes,
      aclaracionesRepetidas,
      postHandoff: yaHabriaEscalado && ctx.habriaEscalado.turno < turno,
    }),
  };
}

/** Que el contexto que se guarda sea JSON y nada más que JSON. */
export const contextoSerializable = (ctx) => JSON.parse(JSON.stringify(ctx ?? null));
