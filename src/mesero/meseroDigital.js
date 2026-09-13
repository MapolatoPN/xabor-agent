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
import {
  contextoDeLaConversacion, anotarTurno, sincronizarLineas, tocarLinea,
  anotarReferencia, anotarPendiente, resolverPendiente, resumenDelContexto,
} from './contextoMesa.js';
import {
  caducarViejas, leerRespuesta, aplicarDesenlace, evidenciaDeAceptacion, proponer as registrarPropuesta,
} from './propuestasDelBot.js';
import { clasificarIntenciones, textoQueAutoriza } from './intencionesDelCliente.js';
import { resolverReferencia } from './referenciasDelCliente.js';
import { aplicarPropuestas, propuestasDesdeBorrador, propuesta } from './motorTransaccional.js';
import { responderConsulta, resolverTermino, buscarProductos } from './consultasDelMenu.js';
import { recomendar, recomendarPorPista, puedeRecomendarAhora } from './recomendaciones.js';
import { recolectarAclaraciones, aPreguntarAhora, paraElModelo } from './aclaraciones.js';
import { faseDelTurno, loQueFalta, siguientePregunta, listoParaConfirmar } from './faseConversacional.js';
import { resumenDelPedido } from './resumenDelPedido.js';
import { decidirHandoff, equipajeDelHandoff } from './handoffHumano.js';
import { eventosDelTurno } from './metricasMesero.js';

const vacio = () => ({ items: [], datos: {} });

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
  const handoff = decidirHandoff({ texto: dicho, intenciones, contexto: ctx });
  if (handoff.escalar) {
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
  const evidenciaDelSi = evidenciaDeAceptacion(desenlace.aceptadas);

  // 5) ¿A qué renglón apunta?
  const referencia = resolverReferencia(dicho, { contexto: ctx, carrito: carritoActual });
  if (referencia.tipo) anotarReferencia(ctx, referencia.frase, referencia.lids[0] || null);

  // 6) EL TEXTO QUE AUTORIZA. Lo que el cliente pidió (sin sus preguntas) más
  //    lo que su «sí» acaba de autorizar. Es lo único que el reconciliador va a
  //    aceptar como respaldo.
  const autoriza = [textoQueAutoriza(dicho, { fase: ctx.fase }), evidenciaDelSi].filter(Boolean).join(' ');
  const textoCiclo = [
    ...ctx.turnos.filter((t) => t.rol === 'cliente' && t.turno < turno).map((t) => t.dicho ?? t.texto),
    autoriza,
  ].filter(Boolean).join(' \n ');

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
  if (referencia.resuelta) {
    if (referencia.accion === 'duplicar') {
      for (const lid of referencia.lids) {
        propuestas.push(propuesta({ accion: 'duplicar', lid, evidencia: referencia.frase }));
      }
    } else if (intenciones.includes('QUITAR')) {
      for (const lid of referencia.lids) {
        propuestas.push(propuesta({ accion: 'quitar', lid, evidencia: referencia.frase }));
      }
    }
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
  const nombraAlgoDeLaCarta = catalogo.length
    ? buscarProductos(catalogo, dicho).length > 0
    : false;
  const atribuidos = (referencia.resuelta
    && ['eliptica', 'deictico', 'ordinal', 'ultimo', 'otro', 'anterior', 'ambos', 'poseedor'].includes(referencia.tipo)
    && !nombraAlgoDeLaCarta)
    ? referencia.lids : [];

  // 9) EL MOTOR DECIDE. Aquí no hay reglas nuevas: se traduce y se reconcilia.
  const resultado = aplicarPropuestas(carritoActual, propuestas.filter(Boolean), {
    mensaje: dicho, textoCiclo, datoOperativoPendiente, terminos,
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
    cambios: resultado.cambios,
    referencia: referencia.tipo && !referencia.resuelta ? referencia : null,
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
  for (const clave of ['modalidad', 'pago']) if (datos[clave]) resolverPendiente(ctx, clave);
  const siguiente = siguientePregunta(entradaFase, (ctx.pendientes || []).map((p) => p.clave));
  // ¿Se movió algo este turno? Es lo que separa «vamos avanzando y todavía
  // falta la modalidad» de «llevamos tres turnos sin entendernos».
  const avanzo = (resultado.cambios?.autorizados || []).length > 0
    || (resultado.cambios?.agregados || []).length > 0
    || (resultado.cambios?.quitados || []).length > 0;
  if (siguiente) anotarPendiente(ctx, siguiente, '', { avanzo });

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
    handoff: { escalar: false, motivo: null },
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
      no_repetir: (ctx.pendientes || []).filter((p) => (p.veces || 1) > 1).map((p) => p.clave),
      contexto: resumenDelContexto(ctx),
    },
    eventos: eventosDelTurno({
      negocioId, conversacion: conversacionId, intenciones, aclaraciones: aPreguntarAhora(aclaraciones),
      recomendaciones, desenlace, decisiones: resultado.decisiones, cambios: resultado.cambios,
      handoff: null, confirmado, fase: ctx.fase,
    }),
  };
}

/** Que el contexto que se guarda sea JSON y nada más que JSON. */
export const contextoSerializable = (ctx) => JSON.parse(JSON.stringify(ctx ?? null));
