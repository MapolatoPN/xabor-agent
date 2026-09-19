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
import { palabrasQueLaSostienen, elTextoRespaldaElValor } from '../orders/evidenciaDeEleccion.js';
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
import { compilarTurno, pideOtraUnidad } from './compilarTurno.js';
import { responderConsulta, resolverTermino, buscarProductos, opcionesAmbiguas, grupoRealDeLaOpcion } from './consultasDelMenu.js';
import { recomendar, recomendarPorPista, puedeRecomendarAhora } from './recomendaciones.js';
import { recolectarAclaraciones, aPreguntarAhora, paraElModelo } from './aclaraciones.js';
import { anclarPropuestas, anclarLinea } from './anclajeAlCatalogo.js';
import { operacionSobreElGrupo } from './mutacionDeOpciones.js';
import { faseDelTurno, loQueFalta, siguientePregunta, listoParaConfirmar } from './faseConversacional.js';
import { resumenDelPedido, huellaDelResumen } from './resumenDelPedido.js';
import { decidirHandoff, equipajeDelHandoff } from './handoffHumano.js';
import { eventosDelTurno } from './metricasMesero.js';

const vacio = () => ({ items: [], datos: {} });

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

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
      // La identidad del renglón. Su clave es el término que dijo el cliente,
      // porque todavía no hay `lid` al que colgarla: la línea no nace hasta que
      // se sabe cuál de la carta es.
      case 'producto_ambiguo':
        fuera.push({ ...base, tipo: 'producto_ambiguo', lid: a.lid || null, dato: a.termino });
        break;
      case 'opcion_inexistente':
        fuera.push({ ...base, tipo: 'opcion_inexistente', lid: a.lid || null,
          producto: a.producto, grupo: a.grupo, dato: a.termino, candidatos: a.candidatos || [] });
        break;
      case 'producto_inexistente':
        // Los candidatos son la FAMILIA que sí se reconoció, cuando la hubo:
        // sin ellos el pendiente no puede volver a ofrecer nada y la
        // conversación se queda sin salida.
        fuera.push({ ...base, tipo: 'producto_inexistente', dato: a.termino, candidatos: a.candidatos || [] });
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
    // LA IDENTIDAD PENDIENTE NO CADUCA PORQUE EL CLIENTE PREGUNTE OTRA COSA.
    //
    // Nace del TEXTO, como la opción ambigua, así que un turno de consulta
    // —«¿qué licuados tienen?»— no vuelve a generarla y se daba por resuelta.
    // Vive mientras ninguna línea del carrito sea uno de sus candidatos: ahí es
    // cuando el cliente por fin eligió.
    if (p.tipo === 'producto_ambiguo') {
      const resuelto = (carrito?.items || []).some((i) => (p.candidatos || [])
        .some((c) => String(c).toLowerCase() === String(i.nombre || '').toLowerCase()));
      if (!resuelto) {
        fuera.push({ tipo: p.tipo, dato: p.dato, lid: p.lid || null,
          candidatos: p.candidatos, evidenciaOrigen: p.evidenciaOrigen });
      }
      continue;
    }
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
  let lineasAmbiguas = [];
  if (typeof proponer === 'function') {
    try {
      const salida = await proponer({ texto: mensaje, dicho, contexto: ctx, carrito: carritoActual, intenciones });
      if (Array.isArray(salida)) propuestas = salida.filter(Boolean);
      else if (salida && typeof salida === 'object') {
        // ── EL BORRADOR ES UNA HIPÓTESIS, NO UNA ESTRUCTURA ──────────────
        //
        // `propuestasDesdeBorrador` empareja por NOMBRE, y el anclaje renombra
        // el renglón a su forma canónica: desde el turno siguiente el modelo
        // dice «chilaquiles suizos», el carrito dice «Chilaquiles Sencillos»,
        // y `parecido` los declara ajenos (-1). El smoke real del 15-sep hizo
        // seis renglones con seis mensajes por exactamente eso.
        //
        // `compilarTurno` decide con el CONTEXTO a qué renglón habla el turno,
        // encuentra en el texto del cliente las entidades que el modelo omitió,
        // resuelve las respuestas contra la pregunta abierta, y deja inerte a
        // una consulta pura. Lo que sale sigue pasando por el reconciliador.
        // El motor de siempre sigue leyendo el borrador —modalidad, pago,
        // cliente, cantidades—; el compilador sólo REESCRIBE lo que habla de un
        // renglón, que es lo único que el modelo no sabe atribuir.
        const compilado = compilarTurno({
          catalogo, carrito: carritoActual, contexto: ctx, borrador: salida,
          intenciones, dicho: autoriza, referencia, pendientes: ctx.pendientes || [],
          propuestasBase: propuestasDesdeBorrador(carritoActual, salida, { evidencia: autoriza }),
        });
        propuestas = compilado.propuestas;
        lineasAmbiguas = compilado.preguntas;
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
  // Lo que el compilador del turno no pudo decidir sin adivinar entra por el
  // mismo canal que ya sabe preguntar: no hay una segunda vía de preguntas.
  for (const q of lineasAmbiguas) {
    if (q?.tipo !== 'opcion_ambigua' || !(q.candidatos || []).length) continue;
    opcionesQueNoSeparan.push({
      opcion: q.candidatos[0], empatan: q.candidatos.slice(1),
      grupo: q.grupo || '', producto: q.producto || '', lid: q.lid || null,
    });
  }
  if (catalogo.length) {
    propuestas = propuestas.filter((p) => {
      if (!p || p.accion !== 'cambiar_modificador') return true;
      const destino = (carritoActual.items || []).find((i) => i.lid === p.lid);
      const abierta = abiertaDelGrupo(p.campo);

      // ── LO QUE YA ESTABA NO SE VUELVE A ELEGIR ─────────────────────────
      //
      // Este filtro medía TODAS las opciones propuestas contra el texto de
      // ESTE turno. «También chipotle» no contiene la palabra «suiza», así que
      // la Suiza que el cliente había pedido un turno antes —y que el
      // reconciliador ya había autorizado con su evidencia de entonces— se
      // declaraba ambigua y se caía aquí, antes de llegar a nadie. El grupo
      // quedaba en [Chipotle] y era imposible pedir dos salsas en dos turnos.
      //
      // Una opción que YA está en el renglón no es una elección nueva: es una
      // elección hecha. Su prueba de autorización es que está ahí — el
      // reconciliador no la habría puesto sin evidencia en su momento. Lo que
      // tiene que distinguirse en este turno es sólo lo que ENTRA ahora.
      //
      // Y SE BUSCA EN EL GRUPO DE VERDAD. El renglón guarda los grupos con su
      // nombre de catálogo; `p.campo` trae el que escribió el modelo, que puede
      // ser «tipo» o «acompañamiento». Comparando los dos nombres, la Suiza que
      // sí estaba puesta no se encontraba nunca y volvía a tratarse como una
      // elección nueva — sin evidencia en este turno, se caía otra vez.
      const propuestas_ = Array.isArray(p.valorNuevo) ? p.valorNuevo : [p.valorNuevo];
      const yaPuesta = (opcion) => (destino?.modificadores || [])
        .filter((gr) => norm(gr?.grupo) === norm(
          grupoRealDeLaOpcion(catalogo, destino?.nombre || '', p.campo, opcion)))
        .flatMap((gr) => (gr.opciones || []).map((o) => String(typeof o === 'string' ? o : o?.nombre || '')))
        .some((v) => v && norm(v) === norm(opcion));
      // ── REPETIR LO QUE YA ESTÁ NO ES CAMBIAR NADA ──────────────────────
      //
      // Cuando el cliente habla de OTRA cosa —«con frijolitos»— el modelo
      // suele reescribir el renglón entero, salsa incluida. Esa reescritura no
      // propone ningún cambio, pero entraba al filtro como una elección nueva:
      // el turno no dice «suiza», así que no la distinguía de sus hermanas y
      // acababa preguntando «¿suiza?», por algo que el cliente ya había
      // elegido. Una propuesta que deja el grupo exactamente como está no se
      // discute: se descarta.
      const gruposReales = new Set(propuestas_
        .map((o) => norm(grupoRealDeLaOpcion(catalogo, destino?.nombre || '', p.campo, o))));
      // Lo que el renglón tiene HOY en ese grupo, con su nombre de catálogo.
      // Se calcula una vez: sirve para descartar una reescritura idéntica y,
      // más abajo, para que sumar no borre lo que el modelo no repitió.
      const enEseGrupo = gruposReales.size === 1
        ? (destino?.modificadores || [])
          .filter((gr) => norm(gr?.grupo) === [...gruposReales][0])
          .flatMap((gr) => (gr.opciones || []).map((o) => String(typeof o === 'string' ? o : o?.nombre || '')))
          .filter(Boolean)
        : [];
      if (gruposReales.size === 1
        && enEseGrupo.length === propuestas_.length && propuestas_.every((o) => yaPuesta(o))) return false;
      // …PERO SÓLO SI EL CLIENTE PIDIÓ SUMAR.
      //
      // Dejar sobrevivir lo ya elegido es correcto para «también chipotle» y
      // peligroso para «mejor chipotle»: si el modelo propone las dos salsas y
      // el cliente pidió cambiar, conservar la suiza le sirve algo que quiso
      // quitar. Sin señal explícita de suma, el grupo se sustituye — que es el
      // comportamiento de siempre. La operación la dice el TEXTO, no el modelo.
      // Sobrevive lo ya elegido cuando el cliente SUMA («también chipotle») y
      // cuando RESTA («quítale el chipotle»): en los dos casos lo que no se
      // menciona se queda donde estaba, y el reconciliador decide la baja con
      // su propia evidencia. Sólo al REEMPLAZAR —«mejor chipotle»— lo nuevo
      // desplaza a lo viejo, y sin ninguna señal se sustituye, como siempre.
      const operacion = operacionSobreElGrupo(autoriza);
      const preserva = operacion === 'agregar' || operacion === 'quitar';
      const conservadas = preserva ? propuestas_.filter((o) => yaPuesta(o)) : [];
      const entrantes = preserva ? propuestas_.filter((o) => !yaPuesta(o)) : propuestas_;

      // ── UN GRUPO PARCIAL NO ES UNA FOTO DEL GRUPO ──────────────────────
      //
      // Lo de arriba rescata lo ya elegido SÓLO si el modelo se acordó de
      // repetirlo. En el smoke real del 16-sep no se acordó: el cliente dijo
      // «también chipotle», el borrador mandó `Salsa: [Chipotle]` a secas, y
      // como no había nada ambiguo el filtro devolvía la propuesta intacta.
      // El reconciliador escribe `valorNuevo` como el grupo entero, así que la
      // Suiza del primer turno desaparecía del pedido.
      //
      // Cuando el texto dice SUMAR, lo que el modelo omite no es una baja: es
      // una omisión. La foto del grupo la tiene el renglón —`enEseGrupo`—, no
      // el borrador, y el valor final es la unión de las dos. Sin señal de
      // suma no se toca nada: «mejor chipotle» sigue sustituyendo, y «sin
      // suiza» sigue restando por su propio camino.
      const heredadas = operacion === 'agregar' ? enEseGrupo : [];
      const unir = (...listas) => {
        const vistas = new Set();
        const fuera = [];
        for (const lista of listas) {
          for (const o of lista) {
            const clave = norm(o);
            if (!clave || vistas.has(clave)) continue;
            vistas.add(clave);
            fuera.push(o);
          }
        }
        return fuera;
      };

      const { claras, ambiguas } = opcionesAmbiguas({
        catalogo,
        producto: destino?.nombre || '',
        grupo: p.campo,
        opciones: entrantes,
        texto: autoriza,
        hermanasRestringidas: abierta?.candidatos || null,
      });
      if (!ambiguas.length) {
        if (heredadas.length) p.valorNuevo = unir(heredadas, propuestas_);
        return true;
      }
      // El `lid` viaja con la ambigüedad: sin él, el pendiente no sabría a qué
      // renglón pertenece y no podría cancelarse cuando ese renglón se va.
      opcionesQueNoSeparan.push(...ambiguas.map((a) => ({ ...a, lid: p.lid })));
      // Lo que sí se distinguió del mismo grupo sigue adelante —junto con lo
      // que ya estaba—; lo ambiguo no.
      const sobreviven = unir(heredadas, conservadas, claras);
      if (sobreviven.length) { p.valorNuevo = sobreviven; return true; }
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

  // ── 8b) EL CATÁLOGO IDENTIFICA, ANTES DE QUE NADIE AUTORICE ────────────
  //
  // Aquí se corta el problema del 13-sep. El modelo propone significado; este
  // paso lo convierte en identidad REAL o lo tira. Después de esta línea, una
  // propuesta sólo puede nombrar productos, grupos y opciones que existen en la
  // carta de ESTE negocio.
  //
  // No autoriza nada: lo que sale sigue pasando por el reconciliador con sus
  // mismas reglas de evidencia. Identificar y autorizar son dos preguntas
  // distintas, y confundirlas fue exactamente el error anterior —«¿lo dijo el
  // cliente?» respondía que sí para «chilaquiles», una palabra que el cliente
  // había dicho y que no era ningún producto—.
  const anclasPorLid = new Map(
    (ctx.lineas || []).filter((l) => l.ancla).map((l) => [l.lid, l.ancla]),
  );
  // Lo que ya se había descartado en turnos anteriores sigue descartado: los
  // candidatos que quedaron vivos viajan en el pendiente de identidad.
  const candidatosPrevios = new Map(
    (ctx.pendientes || [])
      .filter((p) => p.tipo === 'producto_ambiguo' && (p.candidatos || []).length)
      .map((p) => [norm(p.dato || ''), p.candidatos]),
  );
  const anclado = catalogo.length
    ? anclarPropuestas({
      catalogo, propuestas: propuestas.filter(Boolean), carrito: carritoActual,
      evidencia: dichoDelCiclo, candidatosPrevios,
    })
    : { propuestas: propuestas.filter(Boolean), ambiguos: [], rechazados: [], anclas: new Map(), reclasificados: [] };

  // ── 8c) EL RENGLÓN NUEVO SE MIDE CON LA MISMA VARA ─────────────────────
  //
  // El filtro de 8a sólo mira `cambiar_modificador`, porque cuando se escribió
  // un renglón nuevo traía las opciones que el modelo hubiera escrito y el
  // reconciliador era el único guardia. Con el anclaje eso cambió: ahora lo que
  // el modelo escribe se CANONIZA contra la carta, y «salsa de cacahuate»
  // —que no existe— acaba señalando a «Bistec en Salsa» porque comparten la
  // palabra «salsa». El reconciliador la deja pasar: el cliente dijo «salsa»,
  // y respaldo tiene. Lo que falta es lo de siempre, que la palabra la SEPARE
  // de sus hermanas; y eso, en un renglón nuevo, no lo comprobaba nadie.
  //
  // Aquí se comprueba, con la misma función y la misma regla que en 8a. Lo que
  // no se distingue no entra: se pregunta.
  if (catalogo.length) {
    for (const p of anclado.propuestas) {
      if (!p || p.accion !== 'agregar') continue;
      const grupos = Array.isArray(p.valorNuevo?.modificadores) ? p.valorNuevo.modificadores : [];
      if (!grupos.length) continue;
      const quedan = [];
      for (const gr of grupos) {
        const { claras, ambiguas } = opcionesAmbiguas({
          catalogo,
          producto: String(p.valorNuevo?.nombre || ''),
          grupo: String(gr?.grupo || ''),
          opciones: Array.isArray(gr?.opciones) ? gr.opciones : [],
          texto: autoriza,
          hermanasRestringidas: abiertaDelGrupo(gr?.grupo)?.candidatos || null,
        });
        if (ambiguas.length) opcionesQueNoSeparan.push(...ambiguas.map((a) => ({ ...a, lid: null })));
        if (claras.length) quedan.push({ ...gr, opciones: claras });
      }
      p.valorNuevo = { ...p.valorNuevo, modificadores: quedan };
    }
  }

  // ── 8c-bis) UN ARTÍCULO NUEVO NO SE AUTORIZA CON PALABRAS DE OTROS TURNOS ──
  //
  // El 19-sep, con el cliente escribiendo sólo «Confirmo» sobre un pedido ya
  // completo, entró un segundo platillo que nadie pidió: «Huevos revueltos con
  // chorizo». Lo autorizó `articulo|dicho`, y esa vía mide contra el texto del
  // CICLO: en el ciclo estaban «huevos» (turno 2, una PROTEÍNA) y «chorizo»
  // (turno 3, una GUARNICIÓN), las dos ya puestas en el renglón que existía. La
  // fase retrocedió de `confirmando` a `completando_producto` y la confirmación
  // quedó invalidada: un pedido ya confirmado dejó de poder cruzar.
  //
  // ── POR QUÉ AQUÍ Y NO EN EL RECONCILIADOR ────────────────────────────
  //
  // `procedenciaDelArticulo` vive en `carritoDelPedido.js`, y ese módulo NO es
  // sólo del Mesero: `brain.js` lo llama en cada turno del bot legacy, que está
  // encendido en Mapolato Acuña. Cambiar la autoridad allí toca pedidos reales
  // hoy mismo.
  //
  // Y hay una razón de fondo, no sólo de riesgo: la regla que hace falta
  // necesita saber QUÉ pretende el turno, y las intenciones sólo existen a esta
  // altura. El reconciliador no puede distinguir un turno que confirma de uno
  // que pide, y sin esa distinción la regla se queda corta — medido: con sólo
  // la de «palabra libre», un producto RETIRADO y uno NEGADO volvían a entrar
  // durante el «Confirmo», porque al no estar en el carrito sus palabras
  // estaban libres.
  //
  // Es el mismo sitio y la misma disciplina que 8d, justo abajo: se filtra lo
  // que el cliente no sostiene ANTES de que el motor lo vea, y lo tirado se
  // cuenta por el canal de siempre.
  //
  // ── LAS PUERTAS, EN ORDEN ────────────────────────────────────────────
  //
  //   1. se le ofreció y dijo que sí        → entra (su canal, intacto)
  //   2. lo nombró en ESTE turno            → entra
  //   3. el turno SÓLO confirma             → no entra nada nuevo
  //   4. pidió otra unidad en este turno    → entra («otra igual»)
  //   5. el ciclo no lo sostiene por nombre → no es esta vía; decide el motor
  //                                           (un término de categoría —«un
  //                                           refresco»— entra por ahí)
  //   6. lo sostiene sólo con palabras ya puestas en otro renglón → no entra
  //
  // La discriminación de la 6 es la que hace falta y ninguna más: si el cliente
  // nombró el platillo, alguna palabra suya queda libre —«revueltos» en «huevos
  // revueltos con chorizo»— y entra igual.
  // ── Y TAMBIÉN SU ACLARACIÓN ────────────────────────────────────────────
  //
  // Smoke del 19-sep, turno 7, con el filtro de arriba ya desplegado: el
  // carrito aguantó —una línea, `invenciones_bloqueadas: ["Frijol"]`— pero la
  // confirmación se cayó igual. El modelo había propuesto además «Con huevos
  // estrellados», que es literalmente la frase del turno 2 del cliente y no es
  // ningún producto. El anclaje no la reconoce, la saca de `propuestas` y la
  // manda a `rechazados` (`anclajeAlCatalogo.js`, rama `sin_candidatos`), así
  // que el filtro de arriba NO LA VE. `recolectarAclaraciones` la convierte en
  // `producto_inexistente`, `loQueFalta` en `producto:…`, y la fase cae de
  // `revisando` a `completando_producto`.
  //
  // Son DOS caminos para el mismo daño: mutar el carrito y levantar una
  // aclaración. El primero manda comida que nadie pidió —es el peligroso— y ya
  // estaba cerrado; el segundo sólo impide cerrar, y es el que falta.
  //
  // Se cierra con EL MISMO PREDICADO, no con uno nuevo. Tener dos reglas para
  // la misma pregunta es cómo se acaba con una que dice que sí y otra que dice
  // que no: aquí la pregunta es una —«¿autorizó el cliente que este artículo
  // entre en juego este turno?»— y la respuesta se calcula una vez.
  //
  // NO se silencian las aclaraciones de una confirmación: se silencian las de
  // un artículo QUE EL CLIENTE NO PUSO. «Confirmo, y unas enchiladas de pollo»
  // nombra el platillo en el turno, pasa la puerta 2, y si no existe se
  // pregunta igual — que es lo que hay que hacer.
  const sinRespaldoDeArticulo = [];
  {
    const puestas = new Set();
    for (const i of (carritoActual.items || [])) {
      for (const w of palabrasQueLaSostienen(i.nombre, dichoDelCiclo)) puestas.add(w);
      for (const g of (Array.isArray(i.modificadores) ? i.modificadores : [])) {
        for (const o of (Array.isArray(g?.opciones) ? g.opciones : [])) {
          const nom = typeof o === 'string' ? o : String(o?.nombre || '');
          for (const w of palabrasQueLaSostienen(nom, dichoDelCiclo)) puestas.add(w);
        }
      }
    }
    // «Sólo confirma» es literal: si el turno además pide algo, no es este caso
    // y manda lo que pide. «Confirmo y ponme una coca» sigue metiendo la coca.
    const soloConfirma = intenciones.includes('CONFIRMAR') && !intenciones.includes('AGREGAR_PRODUCTO');
    const aceptadas = new Set((desenlace.aceptadas || []).map((p) => norm(p.referencia)));

    /**
     * ¿Autorizó el cliente que ESTE artículo entre en juego en ESTE turno?
     *
     * El nombre que se le pasa es el que haya: el canónico si el anclaje lo
     * resolvió, o el crudo del modelo si no lo reconoció. Las dos formas valen
     * porque las puertas miden contra el TEXTO DEL CLIENTE, no contra la carta.
     *
     * Devuelve `null` cuando sí, o el motivo del rechazo cuando no.
     */
    const porQueNoEntra = (nombre) => {
      if (!nombre) return null;
      if (aceptadas.has(norm(nombre))) return null;
      if (nombradoPorElCliente(nombre, autoriza)) return null;
      if (soloConfirma) return 'solo_confirmaba';
      if (pideOtraUnidad(autoriza)) return null;
      const sostienen = palabrasQueLaSostienen(nombre, dichoDelCiclo);
      if (!sostienen.size) return null;
      if ([...sostienen].some((w) => !puestas.has(w))) return null;
      return 'palabras_ya_puestas_en_otro_renglon';
    };

    // 1) Lo que SÍ llegó a ser propuesta: no muta el carrito.
    anclado.propuestas = (anclado.propuestas || []).filter((p) => {
      if (p?.accion !== 'agregar') return true;
      const nombre = String(p?.valorNuevo?.nombre || '');
      const motivo = porQueNoEntra(nombre);
      if (!motivo) return true;
      sinRespaldoDeArticulo.push({ nombre, campo: 'articulo', motivo, noPreguntar: true });
      return false;
    });

    // 2) Lo que el anclaje apartó antes de que fuera propuesta: no pregunta.
    //
    // Se filtran SOLO las entradas del alta de artículo. La rama de
    // `cambiar_modificador` también empuja a `rechazados`, con `lid` y motivo
    // `linea_sin_ancla`, y ésa habla de una línea que YA está en el carrito:
    // callarla escondería un renglón roto.
    const deAlta = (x) => x && x.lid === undefined;
    const cribar = (lista, tipo) => (lista || []).filter((x) => {
      if (!deAlta(x)) return true;
      const nombre = String(x.propuesto || '');
      const motivo = porQueNoEntra(nombre);
      if (!motivo) return true;
      // El rechazo se CONSERVA, sólo que como invención bloqueada y no como
      // pregunta al cliente: si esto no se contara, una invención que nadie
      // registra sería indistinguible de un turno en el que el modelo no
      // propuso nada, y es justo lo que el negocio querrá medir.
      sinRespaldoDeArticulo.push({ nombre, campo: 'articulo', motivo: `${motivo}:${tipo}`, noPreguntar: true });
      return false;
    });
    anclado.rechazados = cribar(anclado.rechazados, 'inexistente');
    anclado.ambiguos = cribar(anclado.ambiguos, 'ambiguo');
  }

  // ── 8d) LA MODALIDAD, EL PAGO Y LA DIRECCIÓN TAMBIÉN LOS AUTORIZA EL CLIENTE ──
  //
  // El reconciliador acumula los datos operativos sin pedirles respaldo: el
  // comentario del paso 5 de `carritoDelPedido` explica que «nunca tocan
  // comida», y es verdad, pero eso garantiza que no corrompen el platillo, no
  // que el cliente los haya pedido. La auditoría del cierre lo midió:
  //
  //   cliente   «con salsa suiza porfa»
  //   borrador  modalidad="entrega a domicilio", pago="terminal",
  //             cliente={Quien Sea, Calle Falsa 123}
  //   carrito   los tres, con `autorizados: []` — ni rastro de autorización
  //   resultado listoParaConfirmar: true
  //
  // Una dirección inventada por el modelo llegaba a la puerta del cierre. Y la
  // comida llevaba meses protegida contra exactamente esto.
  //
  // Aquí se aplica la MISMA regla, con las MISMAS herramientas. No hay ni un
  // regex nuevo: quien dice que el cliente habló de modalidad o de pago es
  // `clasificarIntenciones`, que ya lo hacía para `respondeAlPendiente`; y
  // quien dice que un valor concreto está en su texto es
  // `palabrasQueLaSostienen`, la misma que sostiene las opciones del menú.
  //
  // Tres puertas, y basta una:
  //
  //   · el cliente habló de eso           «para recoger», «con tarjeta»
  //   · el valor está en su texto         «Reforma 200» → direccion
  //   · se le acababa de preguntar        `datoOperativoPendiente`
  //
  // El dato de cliente se mira CAMPO A CAMPO: que el modelo acierte el nombre
  // no le da la dirección de propina. Y lo que ya estaba autorizado antes se
  // deja pasar, porque repetirlo no es proponerlo de nuevo.
  const sinRespaldoOperativo = [];
  const loDijoElCliente = (valor) => palabrasQueLaSostienen(String(valor ?? ''), autoriza).size > 0;

  // ── Y PARA EL CLIENTE, TODAS LAS PALABRAS, NO UNA ──────────────────────
  //
  // Con «basta una» —que es lo que vale para la modalidad y el pago, donde el
  // catálogo del negocio pone el nombre final— una dirección se colaba a
  // medias:
  //
  //   cliente  «Reforma 200»
  //   modelo   «Reforma 200, Depto 5B»     «reforma» respalda → entraba entero
  //
  // Un repartidor subiendo a un departamento que nadie pidió. Un nombre, una
  // calle o una colonia no los canoniza ninguna carta: lo que el modelo
  // escribe ahí sólo puede venir de la boca del cliente.
  //
  // `elTextoRespaldaElValor` hace las dos preguntas juntas —que no sobre nada
  // y que el valor afirme algo comprobable— porque separadas se pisan: un
  // teléfono dictado con espacios pasa la primera y lo tira la segunda. Un
  // valor que no afirma nada —«Av 5 #3»— no entra por aquí, y sigue entrando
  // por el pendiente: lo abre la pregunta, no la forma del valor.
  const loRespaldaEntero = (valor) => elTextoRespaldaElValor(valor, autoriza);
  const preguntado = norm(datoOperativoPendiente || '');
  const clientePrevio = carritoActual.datos?.cliente || {};
  anclado.propuestas = (anclado.propuestas || []).filter((p) => {
    if (p?.accion === 'definir_modalidad') {
      if (intenciones.includes('DEFINIR_MODALIDAD') || preguntado === 'modalidad'
        || loDijoElCliente(p.valorNuevo)) return true;
      sinRespaldoOperativo.push({ nombre: '', campo: 'modalidad', propuesto: p.valorNuevo });
      return false;
    }
    if (p?.accion === 'definir_pago') {
      if (intenciones.includes('DEFINIR_PAGO') || preguntado === 'pago'
        || loDijoElCliente(p.valorNuevo)) return true;
      sinRespaldoOperativo.push({ nombre: '', campo: 'forma_pago', propuesto: p.valorNuevo });
      return false;
    }
    if (p?.accion !== 'definir_cliente') return true;
    const quedan = {};
    for (const [campo, valor] of Object.entries(p.valorNuevo || {})) {
      if (clientePrevio[campo] === valor || preguntado === norm(campo) || loRespaldaEntero(valor)) {
        quedan[campo] = valor;
        continue;
      }
      sinRespaldoOperativo.push({ nombre: '', campo: `cliente:${campo}`, propuesto: valor });
    }
    if (!Object.keys(quedan).length) return false;
    p.valorNuevo = quedan;
    return true;
  });

  // 9) EL MOTOR DECIDE. Aquí no hay reglas nuevas: se traduce y se reconcilia.
  const resultado = aplicarPropuestas(carritoActual, anclado.propuestas, {
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
  // Lo que 8d tiró viaja por el canal de siempre. Un dato operativo que el
  // modelo se inventó y nadie registra es indistinguible de uno que nunca
  // propuso, y la diferencia importa: la primera es una invención que el
  // negocio querrá ver contada.
  if (sinRespaldoOperativo.length) {
    (resultado.cambios.sinRespaldo || (resultado.cambios.sinRespaldo = []))
      .push(...sinRespaldoOperativo);
  }
  // Y lo que tiró 8c, por el mismo canal y por el mismo motivo: un platillo
  // que el modelo coló y nadie registra es indistinguible de uno que nunca
  // propuso, y aquí la diferencia es justo lo que se quiere contar.
  if (sinRespaldoDeArticulo.length) {
    (resultado.cambios.sinRespaldo || (resultado.cambios.sinRespaldo = []))
      .push(...sinRespaldoDeArticulo);
  }
  const lidsAntes = new Set((carritoActual.items || []).map((i) => i.lid));
  carritoActual = resultado.carrito;

  // ── 9b) LA PRESENTACIÓN SIGUE A LAS OPCIONES QUE YA SE AUTORIZARON ─────
  //
  // «Quiero chilaquiles suizos» y después «también chipotle»: el reconciliador
  // acaba de autorizar la segunda salsa —el cliente la dijo— y con dos salsas
  // la presentación de antes ya no es compatible. Si el catálogo deja
  // exactamente una que sí lo sea, el renglón pasa a ser esa.
  //
  // NO es una mutación nueva ni una invención: no se añade ninguna opción, no
  // cambia la cantidad, no se toca la nota, y el `lid` es el mismo. Lo único
  // que cambia es la IDENTIDAD CANÓNICA de lo que el cliente ya pidió. Quien
  // decidió qué opciones entran fue el reconciliador, un paso antes; aquí sólo
  // se le pone a eso el nombre que le da la carta.
  //
  // Y LA IDENTIDAD ES EL `id`, NO EL NOMBRE. Cambiar sólo el nombre dejaba el
  // renglón diciendo «Chilaquiles Mixtos» con el `id` de los Sencillos: quien
  // cobra por `id` cobra la presentación vieja, quien imprime por nombre manda
  // a cocinar la nueva, y la cardinalidad se valida contra un producto que ya
  // no es ese —dos salsas contra un máximo de una— y tumba el pedido. Es el
  // mismo renglón, pero de otro producto: van los dos campos o no va ninguno.
  //
  // Y si quedan dos presentaciones compatibles, no se elige: se pregunta.
  const reclasificadas = [];
  if (catalogo.length) {
    const items = (carritoActual.items || []).map((it) => {
      const suyas = (it.modificadores || [])
        .flatMap((g) => (g.opciones || []).map((o) => (typeof o === 'string' ? o : o?.nombre)))
        .filter(Boolean).join(' ');
      if (!suyas) return it;
      const a = anclarLinea({
        catalogo, nombrePropuesto: String(it.nombre || ''), evidencia: `${it.nombre} ${suyas}`,
        ampliarFamilia: true,
      });
      if (a.estado !== 'resuelto') return it;
      if (norm(a.producto.nombre) === norm(it.nombre)) return it;
      reclasificadas.push({ lid: it.lid, de: String(it.nombre || ''), a: a.producto.nombre, por: suyas });
      return {
        ...it,
        nombre: a.producto.nombre,
        ...(a.producto.id === null || a.producto.id === undefined ? {} : { id: a.producto.id }),
      };
    });
    if (reclasificadas.length) carritoActual = { ...carritoActual, items };
  }

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
    // ── EL TERCER CAMINO ────────────────────────────────────────────────
    //
    // Este bucle existe para rescatar lo que el RECONCILIADOR tiró: si el
    // cliente dijo «un refresco» y la carta tiene una categoría que se llama
    // así, se le pregunta cuál. Es útil y se queda.
    //
    // Pero lee `sinRespaldo` entero, y ahí también está lo que tiró 8c-bis —
    // que se anota a propósito, para que una invención quede contada—. El
    // resultado era que conservar el registro volvía a levantar la pregunta
    // por la puerta de atrás: en la suite, «Con huevos estrellados» reaparecía
    // como `termino_ambiguo` con los dos huevos de la carta de candidatos.
    //
    // Lo que 8c-bis tira ya tiene su motivo —el cliente no lo puso— y no hay
    // nada que preguntarle. Se salta, y el registro se conserva igual.
    if (s.campo !== 'articulo' || s.noPreguntar || !catalogo.length) continue;
    const r = resolverTermino(catalogo, s.nombre);
    if (!r.resuelto && r.candidatos.length > 1) {
      terminosAmbiguos.push({ termino: s.nombre, candidatos: r.candidatos.map((c) => c.nombre) });
    }
  }
  const aclaraciones = recolectarAclaraciones({
    // Lo que el catálogo no pudo identificar solo. Va primero: sin identidad de
    // producto no hay grupos que preguntar ni línea que confirmar.
    productosAmbiguos: anclado.ambiguos,
    productosInexistentes: anclado.rechazados,
    // Una opcion que el catalogo no reconoce no puede caerse en silencio: el
    // renglon se quedaria sin lo que el cliente pidio y sin nadie que lo diga.
    opcionesNoReconocidas: (anclado.descartados || []).filter((d) => d?.motivo === 'no_reconocida'),
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

  // ── UN «SÍ» CONFIRMA LO QUE EL CLIENTE ACABA DE LEER, NO OTRA COSA ──────
  //
  // `huellaDelResumen` y `resumenSigueVigente` llevaban escritas desde que se
  // escribió el resumen, con su comentario explicando para qué servían, y no
  // las llamaba nadie: una protección construida y desconectada. Se conectan
  // aquí, que es el único sitio donde hay las dos cosas a la vez —el resumen
  // que se enseñó y el pedido de ahora—.
  //
  // El resumen de ESTE turno se calcula ya, antes de la fase, porque de él
  // depende si el «sí» de este turno vale. Y se compara contra la huella del
  // que se enseñó al terminar el turno anterior:
  //
  //   turno n-1   pedido completo → se le enseña el resumen, se guarda su huella
  //   turno n     «sí, confirmo» y nada cambió  → las huellas coinciden → vale
  //   turno n     «mejor roja, sí confirmo»     → la huella ya es otra → no vale
  //
  // El segundo caso es el que importa: el cambio y la confirmación llegan en
  // el MISMO mensaje, el resumen que el cliente leyó describe el pedido de
  // antes, y su «sí» habla de ese. No se rechaza al cliente: se le vuelve a
  // enseñar el pedido con el cambio puesto, y el «sí» siguiente sí vale.
  //
  // Y una huella se consume UNA vez. Sin eso, cuatro «sí, confirmo» seguidos
  // daban cuatro confirmaciones del mismo pedido.
  const resumen = resumenDelPedido(carritoActual, { precios, requierePago });
  const huellaAhora = huellaDelResumen(resumen);
  const confirmacionVigente = ctx.resumenMostrado?.huella === huellaAhora
    && ctx.resumenConfirmado?.huella !== huellaAhora;

  const entradaFase = { intenciones, carrito: carritoActual, datos, aclaraciones, confirmado,
    requierePago, confirmacionVigente };
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

  // EL RESUMEN QUE SE LE ACABA DE ENSEÑAR. Sólo cuenta cuando no falta nada:
  // un resumen incompleto no es una oferta que confirmar, es un avance. Y si
  // este turno confirmó, la huella queda marcada como consumida.
  ctx.resumenMostrado = listoParaConfirmar(entradaFase) ? { huella: huellaAhora, turno } : null;
  if (ctx.fase === 'confirmando') ctx.resumenConfirmado = { huella: huellaAhora, turno };

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
    // ¿Es SEGURO pedirle confirmación a este resumen? Completo no basta:
    // tiene que ser el que el cliente leyó y no haber sido ya confirmado.
    confirmacionVigente,
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
      // Que esto es una COPIA tiene que verse en la metrica: `modo=mesero` en
      // una linea de sombra invita a contar turnos productivos que no existen.
      modo: observando ? 'shadow' : 'mesero',
      pendientes: cicloPendientes,
      aclaracionesRepetidas,
      postHandoff: yaHabriaEscalado && ctx.habriaEscalado.turno < turno,
    }),
  };
}

/** Que el contexto que se guarda sea JSON y nada más que JSON. */
export const contextoSerializable = (ctx) => JSON.parse(JSON.stringify(ctx ?? null));
