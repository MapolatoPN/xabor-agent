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
  // Nombrar una opción dentro de una pregunta no equivale a elegirla:
  // «¿el refresco es light?» debe seguir siendo una consulta.
  if (/[?¿]/.test(String(mensaje || ''))) return { acciones, ambiguas };
  for (const a of (pedido?.aclaraciones || [])) {
    const candidatos = (a.candidatos || []).map(String).filter(Boolean);
    if (!candidatos.length) continue;

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

    const sostenidos = candidatos.filter((c) => fuerzaDeEvidencia(c, mensaje) > 0);
    const distinguidos = sostenidos.filter((c) => distingueLaEleccion(c, candidatos, mensaje).distingue);
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
          opciones: distinguidos.map((opcion) => ({ grupo: a.grupo, opcion })) },
        motivo: 'opcion_inequivoca_del_catalogo',
      });
    } else if (sostenidos.length) {
      ambiguas.push({ ...a, candidatos: sostenidos });
    }
  }
  return { acciones, ambiguas };
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
