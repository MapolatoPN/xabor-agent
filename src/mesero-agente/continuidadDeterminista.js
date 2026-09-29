// Continuaciones cortas del formulario de pedido que no necesitan criterio
// generativo. El catálogo y el estado ya contienen la respuesta correcta:
// aquí se enlaza una respuesta de opción con el grupo obligatorio que sigue
// pendiente. (Aceptar un producto, una promoción o un pago ofrecido ya no vive
// aquí: lo interpreta `respuestaCorta.js` contra `estado.pendiente`.)
//
// Esta capa propone las mismas herramientas que usaría el modelo. No escribe
// el carrito directamente: esquema, catálogo, reconciliador, idempotencia y
// auditoría siguen siendo obligatorios en agenteDelMesero.
import { esConfirmacionVerbal } from '../agent/confirmacionVerbal.js';
import { distingueLaEleccion, fuerzaDeEvidencia, palabrasQueLaSostienen } from '../orders/evidenciaDeEleccion.js';
import { modalidadesDisponibles, etiquetaTipoModalidad, normalizarTipoModalidad } from '../orders/modalidadesDelPedido.js';
import { fichaPorNombre } from './vistaDelPedido.js';
import { cardinalidadDeGrupo } from '../services/modificadores.js';
import { tiposDePagoDisponibles, etiquetaTipoPago } from './politicaDePagos.js';
import { elClientePidioQuitarLaOpcion } from '../orders/carritoDelPedido.js';
import { politicaDelTurno, gruposConEvidenciaCompartida, normalizarEleccion, opcionNegativaExplicita } from './politicaDelTurno.js';
import { textoParaPlatillo } from './alcanceDePlatillos.js';

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

/**
 * Resuelve únicamente elecciones inequívocas de grupos pendientes.
 *
 * La única traducción semántica es la de un grupo binario Sí/No que el motor
 * acaba de preguntar. «Sin las flores» puede entonces seleccionar la opción
 * canónica «No». La autorización queda marcada para que el reconciliador la
 * limite a ese renglón, grupo y opción exactos.
 */
export function accionesParaOpcionesPendientes({ estado, pedido, catalogo = [], mensaje = '' } = {}) {
  const acciones = [];
  const ambiguas = [];
  const descartadas = [];
  const aclaraciones = pedido?.aclaraciones || [];
  const t = normalizarEleccion(mensaje).replace(/\s+por favor$/, '');
  const respuestaAlFoco = aclaraciones.some((a) => focoCoincide(estado?.foco, a)
    && (a.candidatos || []).some((c) => normalizarEleccion(c) === t));
  // Un nombre completo exclusivo identifica su grupo aunque haya otras
  // preguntas pendientes. «Tortillas de maíz» no elige también «Maíz» en
  // tres tacos. Si el nombre completo se comparte, seguimos preguntando.
  const exactas = aclaraciones.filter(a => (a.candidatos || []).some(c => normalizarEleccion(c) === t));
  const destinosExactos = new Set(exactas.map(a => `${a.lid}|${a.grupo}`));
  const destinoExacto = !respuestaAlFoco && destinosExactos.size === 1 ? [...destinosExactos][0] : null;
  const compartidas = gruposConEvidenciaCompartida(aclaraciones, mensaje);
  let requiereInterpretacion = false;
  // Nombrar una opción dentro de una pregunta no equivale a elegirla:
  // «¿el refresco es light?» debe seguir siendo una consulta.
  if (politicaDelTurno(mensaje).soloLectura || /[?¿]/.test(String(mensaje || ''))) return { acciones, ambiguas, descartadas };
  if (!respuestaAlFoco && destinosExactos.size > 1) {
    return { acciones, ambiguas, descartadas, requiereInterpretacion: true };
  }
  for (const a of aclaraciones) {
    const fichaDelDestino = fichaPorNombre(catalogo,a.producto);
    const alcance = textoParaPlatillo({estado,mensaje,ficha:fichaDelDestino,lineaId:a.lid,catalogo});
    if (alcance.acotado && norm(alcance.texto) !== norm(mensaje)) {
      // No aplicar una opción aislada del mensaje global a todos los platos.
      // El intérprete trabaja el lote y el ejecutor valida su alcance.
      requiereInterpretacion = true;
      continue;
    }
    if (respuestaAlFoco && !focoCoincide(estado?.foco, a)) continue;
    if (destinoExacto && `${a.lid}|${a.grupo}` !== destinoExacto) continue;
    if (!respuestaAlFoco && !destinoExacto && compartidas.has(`${a.lid}|${a.grupo}`)) {
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

    // El encabezado de otro grupo no es una elección aquí. Por ejemplo,
    // «salsa suiza» no pide además una guarnición cuyo nombre acaba en salsa.
    // La lista sale de TODOS los grupos reales del producto, no solo de los
    // que todavía faltan: un grupo ya satisfecho también puede ser modificado
    // en el mismo lote de mensajes. El foco anterior tampoco da permiso para
    // apropiarse de la etiqueta de otro grupo.
    const soloEtiquetaAjena = (c) => {
      const evidencia = [...palabrasQueLaSostienen(c, mensaje)];
      if (!evidencia.length) return false;
      const linea = (pedido?.lineas || []).find((l) => String(l.linea_id) === String(a.lid));
      const ficha = fichaPorNombre(catalogo, a.producto || linea?.producto);
      const gruposReales = (ficha?.grupos || []).map((g) => g.nombre);
      // Compatibilidad con vistas parciales: si quien llama no tiene catálogo,
      // al menos conserva la separación entre las aclaraciones que sí recibió.
      const gruposConocidos = [...gruposReales, ...aclaraciones
        .filter((otra) => String(otra.lid) === String(a.lid))
        .map((otra) => otra.grupo)]
        .filter((grupo, indice, todos) => grupo && todos
          .findIndex((otro) => norm(otro) === norm(grupo)) === indice);
      return gruposConocidos.some((grupo) => norm(grupo) !== norm(a.grupo)
        && evidencia.every((w) => palabrasQueLaSostienen(grupo, mensaje).has(w)));
    };
    const sostenidos = candidatos.filter((c) => !soloEtiquetaAjena(c) && (opcionNegativaExplicita(c, mensaje)
      || (fuerzaDeEvidencia(c, mensaje) > 0 && !elClientePidioQuitarLaOpcion(c, mensaje))));
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
    const { maximo } = cardinalidadDeGrupo(a);
    if (distinguidos.length >= 1 && distinguidos.length <= maximo) {
      acciones.push({
        herramienta: 'modificar_linea',
        argumentos: { linea_id: a.lid,
          opciones: [...new Set([
            ...((a.tipo === 'eleccion_ambigua' || Number(a.minimo) > 1) && maximo > 1 ? (pedido.lineas.find((l) => l.linea_id === a.lid)
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

/** Explica opciones compartidas sin decidir por el cliente a qué grupo pertenecen. */
export function preguntaPorOpcionesCompartidas({ estado, pedido, mensaje }) {
  if (estado?.folio || estado?.confirmacionIncierta || estado?.evento
    || Object.values(estado?.hechos || {}).some(Boolean)) return null;
  const aclaraciones = pedido?.aclaraciones || [];
  const compartidas = gruposConEvidenciaCompartida(aclaraciones, mensaje);
  const afectadas = aclaraciones.filter(a => compartidas.has(`${a.lid}|${a.grupo}`));
  const foco = afectadas.find(a => focoCoincide(estado?.foco, a)) || afectadas[0];
  if (!foco) return null;
  const grupos = [...new Set(afectadas.filter(a => a.lid === foco.lid).map(a => a.grupo))];
  // Varias líneas necesitan identificar primero el artículo. No reutilizar
  // esta aclaración de grupos para decidir tácitamente cuál línea modificar.
  if (new Set(afectadas.map(a => a.lid)).size !== 1 || grupos.length < 2) return null;
  const { maximo } = cardinalidadDeGrupo(foco);
  return {
    texto: `Estas opciones coinciden en varios grupos de ${foco.producto}: ${grupos.join(' y ')}. `
      + `Para no asignarlas al grupo equivocado, elige primero ${maximo === 1 ? 'una opción' : `hasta ${maximo} opciones`} `
      + `para ${foco.grupo}. Opciones: ${(foco.candidatos || []).join(', ')}. ¿Cuál prefieres?`,
    foco: { tipo: 'opcion', linea_id: foco.lid, grupo: foco.grupo },
  };
}

/** Primera pregunta que se deduce por completo del estado canónico. */
export function siguientePreguntaDelPedido({ pedido, modalidades = null, metodosPago = null,
  requierePago = true } = {}) {
  const a = (pedido?.aclaraciones || [])[0];
  if (a) {
    return {
      texto: a.tipo === 'grupo_abierto'
        ? `Para ${a.producto}, ${a.grupo}: ${(a.elegidas || []).join(', ') || 'sin seleccionar'}. Puedes elegir de ${a.minimo} a ${a.maximo}. Opciones: ${(a.candidatos || []).join(', ')}. Al terminar, elige «Listo con estas» o escribe «listo».`
        : `Para ${a.producto}, falta elegir ${a.grupo}. Opciones: ${(a.candidatos || []).join(', ')}. ¿Cuál prefieres?`,
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
