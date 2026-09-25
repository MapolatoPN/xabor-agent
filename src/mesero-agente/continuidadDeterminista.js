// Continuaciones cortas del formulario de pedido que no necesitan criterio
// generativo. El catálogo y el estado ya contienen la respuesta correcta:
// aquí solo se enlaza un «sí» con el único producto ofrecido y una respuesta
// de opción con el grupo obligatorio que sigue pendiente.
//
// Esta capa propone las mismas herramientas que usaría el modelo. No escribe
// el carrito directamente: esquema, catálogo, reconciliador, idempotencia y
// auditoría siguen siendo obligatorios en agenteDelMesero.
import { esConfirmacionVerbal } from '../agent/confirmacionVerbal.js';
import { distingueLaEleccion, fuerzaDeEvidencia, palabrasQueLaSostienen } from '../orders/evidenciaDeEleccion.js';
import { modalidadesDisponibles, etiquetaTipoModalidad, normalizarTipoModalidad } from '../orders/modalidadesDelPedido.js';
import { fichaPorNombre } from './vistaDelPedido.js';
import { tiposDePagoDisponibles, etiquetaTipoPago } from './politicaDePagos.js';
import { elClientePidioQuitarLaOpcion } from '../orders/carritoDelPedido.js';
import { politicaDelTurno, gruposConEvidenciaCompartida, normalizarEleccion, opcionNegativaExplicita } from './politicaDelTurno.js';

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

const focoCoincide = (foco, aclaracion) => foco?.tipo === 'opcion'
  && String(foco.linea_id) === String(aclaracion?.lid)
  && norm(foco.grupo) === norm(aclaracion?.grupo);

const esNoBinario = (texto) => {
  const t = norm(texto);
  return /^(no|nop|nel|no gracias)$/.test(t)
    || /^(sin|no quiero|no agregues|no anadas|no le pongas)\b/.test(t);
};

/** Un «sí» solo acepta una oferta cuando el turno anterior dejó UNA. */
export function accionParaOfertaAceptada({ estado, catalogo = [], mensaje = '' } = {}) {
  const ofertaPromo = estado?.ofertaPromocionPendiente;
  if (ofertaPromo && esConfirmacionVerbal(mensaje)) {
    const participantes = Array.isArray(ofertaPromo.participantes)
      ? ofertaPromo.participantes.filter(Boolean) : [];
    // Una aceptación solo puede autorizar una oferta inequívoca. Si hay más
    // de un producto participante, el cliente todavía tiene que elegirlo;
    // dejar que el modelo decida por él reintroduciría la misma divergencia
    // que este camino determinista evita.
    if (participantes.length === 1) {
      const ficha = fichaPorNombre(catalogo, participantes[0]);
      if (!ficha) return null;
      return {
        herramienta: 'agregar_producto',
        argumentos: {
          producto_id: String(ficha.id),
          cantidad: Number(ofertaPromo.cantidadRequerida) >= 1
            ? Number(ofertaPromo.cantidadRequerida) : 1,
        },
        motivo: 'aceptacion_de_oferta_promocion',
        consumeOfertaPromocion: true,
      };
    }
  }
  const ofrecidos = Array.isArray(estado?.ofrecidos) ? estado.ofrecidos.filter(Boolean) : [];
  if (ofrecidos.length !== 1 || !esConfirmacionVerbal(mensaje)) return null;
  const ficha = fichaPorNombre(catalogo, ofrecidos[0]);
  if (!ficha) return null;
  return {
    herramienta: 'agregar_producto',
    argumentos: { producto_id: String(ficha.id), cantidad: 1 },
    motivo: 'aceptacion_de_unica_oferta',
  };
}

/**
 * Resuelve únicamente elecciones inequívocas de grupos pendientes.
 *
 * La única traducción semántica es la de un grupo binario Sí/No que el motor
 * acaba de preguntar. «Sin las flores» puede entonces seleccionar la opción
 * canónica «No». La autorización queda marcada para que el reconciliador la
 * limite a ese renglón, grupo y opción exactos.
 */
export function accionesParaOpcionesPendientes({ estado, pedido, mensaje = '' } = {}) {
  const acciones = [];
  const ambiguas = [];
  const descartadas = [];
  const aclaraciones = pedido?.aclaraciones || [];
  const t = normalizarEleccion(mensaje).replace(/\s+por favor$/, '');
  const respuestaAlFoco = aclaraciones.some((a) => focoCoincide(estado?.foco, a)
    && (a.candidatos || []).some((c) => normalizarEleccion(c) === t));
  const compartidas = gruposConEvidenciaCompartida(aclaraciones, mensaje);
  let requiereInterpretacion = false;
  // Nombrar una opción dentro de una pregunta no equivale a elegirla:
  // «¿el refresco es light?» debe seguir siendo una consulta.
  if (politicaDelTurno(mensaje).soloLectura || /[?¿]/.test(String(mensaje || ''))) return { acciones, ambiguas, descartadas };
  for (const a of aclaraciones) {
    if (respuestaAlFoco && !focoCoincide(estado?.foco, a)) continue;
    if (!respuestaAlFoco && compartidas.has(`${a.lid}|${a.grupo}`)) {
      requiereInterpretacion = true;
      continue;
    }
    const candidatos = (a.candidatos || []).map(String).filter(Boolean);
    if (!candidatos.length) continue;
    if (a.tipo === 'eleccion_ambigua' && focoCoincide(estado?.foco, a)
      && candidatos.every((c) => !opcionNegativaExplicita(c, mensaje) && elClientePidioQuitarLaOpcion(c, mensaje))) {
      descartadas.push(a);
      continue;
    }

    const si = candidatos.find((c) => norm(c) === 'si');
    const no = candidatos.find((c) => norm(c) === 'no');
    if (si && no && focoCoincide(estado?.foco, a)) {
      let opcion = null;
      if (esConfirmacionVerbal(mensaje)) opcion = si;
      else if (esNoBinario(mensaje)
        && (norm(mensaje) === 'no' || palabrasQueLaSostienen(a.grupo, mensaje).size > 0)) opcion = no;
      if (opcion) {
        acciones.push({
          herramienta: 'modificar_linea',
          argumentos: { linea_id: a.lid, opciones: [{ grupo: a.grupo, opcion }] },
          opcionAceptada: { lid: a.lid, grupo: a.grupo, opcion },
          motivo: 'respuesta_binaria_a_grupo_en_foco',
        });
        continue;
      }
    }

    const sostenidos = candidatos.filter((c) => opcionNegativaExplicita(c, mensaje)
      || (fuerzaDeEvidencia(c, mensaje) > 0 && !elClientePidioQuitarLaOpcion(c, mensaje)));
    const distinguidos = sostenidos.filter((c) => opcionNegativaExplicita(c, mensaje)
      || distingueLaEleccion(c, candidatos, mensaje).distingue);
    // Una coincidencia clara no explica otra mención independiente ambigua.
    // Excluir solo las hermanas cuya evidencia ya explica la elección clara.
    const sinResolver = sostenidos.filter((c) => !distinguidos.includes(c)
      && !distinguidos.some((d) => [...palabrasQueLaSostienen(c, mensaje)]
        .every((w) => palabrasQueLaSostienen(d, mensaje).has(w))));
    // Algunos grupos permiten más de una elección (por ejemplo, hasta dos
    // guarniciones). Si el cliente nombra varias opciones canónicas y cada una
    // queda distinguida de sus hermanas, deben viajar juntas en una sola
    // mutación; tratar el caso como ambigüedad provoca el bucle de repetir la
    // misma pregunta aunque la respuesta sí sea suficiente.
    const maximo = Number.isFinite(Number(a.maximo)) && Number(a.maximo) > 0
      ? Number(a.maximo) : 1;
    if (distinguidos.length >= 1 && distinguidos.length <= maximo) {
      acciones.push({
        herramienta: 'modificar_linea',
        argumentos: { linea_id: a.lid,
          opciones: [...new Set([
            ...(a.tipo === 'eleccion_ambigua' && maximo > 1 ? (pedido.lineas.find((l) => l.linea_id === a.lid)
              ?.opciones || []).filter((o) => norm(o.grupo) === norm(a.grupo)).map((o) => o.opcion) : []),
            ...distinguidos,
          ])].map((opcion) => ({ grupo: a.grupo, opcion })) },
        motivo: 'opcion_inequivoca_del_catalogo',
      });
    }
    const pendientes = distinguidos.length >= 1 && distinguidos.length <= maximo
      ? sinResolver : sostenidos;
    // Cada mención tiene su propia aclaración: resolver «frijoles» no puede
    // eliminar unas «papas» todavía ambiguas en el mismo grupo.
    const porEvidencia = new Map();
    for (const c of pendientes) {
      // Un grupo de elección única plantea UNA decisión entre alternativas.
      // Separarlas en pendientes individuales hacía que elegir Fresa dejara
      // Plátano pendiente y cambiara la respuesta en el siguiente turno.
      const clave = maximo === 1 ? 'eleccion_unica' : [...palabrasQueLaSostienen(c, mensaje)].sort().join('|');
      porEvidencia.set(clave, [...(porEvidencia.get(clave) || []), c]);
    }
    for (const opciones of porEvidencia.values()) {
      ambiguas.push({ ...a, tipo: 'eleccion_ambigua', candidatos: opciones });
    }
  }
  // Varias aclaraciones del mismo grupo se resuelven en una sola mutación;
  // aplicar dos reemplazos basados en la foto inicial perdería la primera.
  const unificadas = [];
  for (const accion of acciones) {
    const previa = unificadas.find((p) => p.argumentos.linea_id === accion.argumentos.linea_id
      && p.argumentos.opciones[0]?.grupo === accion.argumentos.opciones[0]?.grupo);
    if (!previa) unificadas.push(accion);
    else for (const opcion of accion.argumentos.opciones) {
      if (!previa.argumentos.opciones.some((o) => o.grupo === opcion.grupo && o.opcion === opcion.opcion)) {
        previa.argumentos.opciones.push(opcion);
      }
    }
  }
  return { acciones: unificadas, ambiguas, descartadas, requiereInterpretacion };
}

/** Primera pregunta que se deduce por completo del estado canónico. */
export function siguientePreguntaDelPedido({ pedido, modalidades = null, metodosPago = null,
  requierePago = true } = {}) {
  const a = (pedido?.aclaraciones || [])[0];
  if (a) {
    return {
      texto: `Para ${a.producto}, falta elegir ${a.grupo}. Opciones: ${(a.candidatos || []).join(', ')}. ¿Cuál prefieres?`,
      foco: { tipo: 'opcion', linea_id: a.lid, grupo: a.grupo },
    };
  }
  if (!(pedido?.lineas || []).length) return null;

  if (!pedido.modalidad) {
    const disponibles = modalidadesDisponibles(modalidades);
    const etiquetas = (disponibles || []).map((m) => etiquetaTipoModalidad(m.tipo));
    return {
      texto: etiquetas.length
        ? `¿Será para ${etiquetas.join(' o ')}?`
        : '¿Cómo deseas recibir tu pedido?',
      foco: { tipo: 'modalidad' },
    };
  }

  if (normalizarTipoModalidad(pedido.modalidad) === 'domicilio' && !pedido.cliente?.direccion) {
    return { texto: '¿Cuál es la dirección completa para la entrega?', foco: { tipo: 'direccion' } };
  }

  if (requierePago && !pedido.forma_pago) {
    const metodos = (tiposDePagoDisponibles(metodosPago) || []).map(etiquetaTipoPago);
    return {
      texto: metodos.length
        ? `¿Cómo deseas pagar? Opciones: ${metodos.join(', ')}.`
        : '¿Cómo deseas pagar?',
      foco: { tipo: 'pago' },
    };
  }
  return null;
}

/**
 * Detecta encabezados de grupos reales de la carta que no pertenecen al
 * producto actual. Evita que «Guarniciones: frijoles» se convierta por
 * parecido léxico en otro platillo.
 */
export function grupoExplicitoNoAplicable({ pedido, catalogo = [], mensaje = '' } = {}) {
  if (!(pedido?.aclaraciones || []).length || (pedido?.lineas || []).length !== 1) return null;
  const primeraLinea = norm(String(mensaje || '').split('\n').find((x) => x.trim()) || '');
  if (!primeraLinea) return null;

  const gruposCarta = [];
  for (const categoria of (catalogo || [])) {
    for (const producto of (categoria?.productos || [])) {
      const ficha = fichaPorNombre(catalogo, producto?.nombre);
      for (const g of (ficha?.grupos || [])) {
        if (!gruposCarta.some((x) => norm(x) === norm(g.nombre))) gruposCarta.push(g.nombre);
      }
    }
  }
  const nombrado = gruposCarta.find((g) => {
    const n = norm(g);
    return n.length >= 4 && (primeraLinea === n || primeraLinea.startsWith(`${n} `));
  });
  if (!nombrado) return null;

  const linea = pedido.lineas[0];
  const ficha = fichaPorNombre(catalogo, linea.producto);
  if ((ficha?.grupos || []).some((g) => norm(g.nombre) === norm(nombrado))) return null;
  return { grupo: nombrado, producto: linea.producto };
}
