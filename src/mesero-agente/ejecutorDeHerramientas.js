// ─── EL EJECUTOR: donde Xabor decide, no el modelo ────────────────────────
//
// Recibe una llamada a herramienta ya validada contra su esquema y la ejecuta
// contra el estado REAL. Cuatro reglas, y ninguna es negociable:
//
//   1. Nada se aplica sin pasar por `reconciliar`. El reconciliador es el
//      único juez de qué entra al pedido, y sigue exigiendo evidencia en lo
//      que DIJO el cliente. Un `agregar_producto` con un id perfecto y sin
//      respaldo en el mensaje se rechaza igual.
//   2. Ningún producto ni opción existe si no está en la carta. Los ids se
//      vuelven a resolver aquí; que vinieran de `buscar_producto` no se da
//      por bueno.
//   3. Después de mutar se RELEE el pedido. Lo que vuelve al modelo es el
//      estado leído, no el prometido.
//   4. El resultado nunca miente sobre el éxito. `aplicado:false` con su
//      motivo es un desenlace normal, no una excepción.
//
// ── Lo que este archivo NO hace ──────────────────────────────────────────
//
// No habla con el modelo, no manda WhatsApp, no imprime y no cobra. Los
// efectos irreversibles —confirmar y escalar— entran por `efectos`, que quien
// llama inyecta: en producción son los de verdad, en sombra y en replay son
// grabadoras. Por eso el mismo código corre en los tres modos sin una bandera
// que decida si esta vez sí se cobra.
import { aplicarPropuestas, propuesta } from '../mesero-whatsapp/motorTransaccional.js';
import { carritoVacio } from '../orders/carritoDelPedido.js';
import { buscarProductos, indiceDeLaCarta, productosVendibles, fichaDeProducto } from '../mesero-whatsapp/consultasDelMenu.js';
import { anclarLinea } from '../mesero-whatsapp/anclajeAlCatalogo.js';
import { transicionLegal, esTerminal } from './maquinaDeEstados.js';
import { vistaDelPedido, fichaPorId, fichaPorNombre, opcionesDeLinea } from './vistaDelPedido.js';
import { tieneEfecto } from './contratoDeHerramientas.js';
import { evaluarFormaPago, etiquetaTipoPago } from './politicaDePagos.js';
import { validarProgramado } from './programadoDelAgente.js';
import { evaluarModalidad, etiquetaTipoModalidad } from '../orders/modalidadesDelPedido.js';
import { partesFechaHoraCatering } from '../agent/comercialMarkers.js';
import { esSolicitudCatering } from '../agent/catering.js';
import { solicitaAtencionHumana } from '../utils/solicitudPersona.js';
import {
  eventoCateringPublico, eventoCateringVerificado, filtrarDatosEventoCatering,
  sellarEventoCatering,
} from '../agent/evidenciaCatering.js';

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

const ok = (datos) => ({ aplicado: true, estado: 'ok', ...datos });
const noAplicado = (motivo, datos = {}) => ({ aplicado: false, estado: 'rechazada', motivo, ...datos });
const invalido = (motivo, datos = {}) => ({ aplicado: false, estado: 'ilegal', motivo, ...datos });

/**
 * EL ESTADO DE UNA CONVERSACIÓN, tal como lo ve el ejecutor.
 *
 * Es un objeto plano y serializable a propósito: se guarda entre turnos, se
 * compara en el replay y se puede imprimir en un log sin que nada se pierda.
 */
export function estadoNuevo({ negocioId, conversacionId }) {
  return {
    negocioId,
    conversacionId,
    carrito: carritoVacio(),
    hechos: { confirmado: false, escalado: false, cancelado: false, fallido: false },
    folio: null,
    motivoEscalado: null,
    motivoCancelado: null,
    pagoOfrecido: null,
    // Hecho durable, fijado por el adaptador a partir de las palabras del
    // cliente. Si el modelo olvida llamar `programar_para`, la confirmacion no
    // puede degradar silenciosamente el pedido de mañana a uno para hoy.
    programacionRequerida: false,
    turno: 0,
    // Lo que el bot puso delante del cliente en el turno ANTERIOR y que un
    // «sí» puede aceptar. Ver `evidenciaAceptada`, abajo.
    ofrecidos: [],
    ofrecidosDelTurno: [],
    // Los datos de un evento se juntan a trozos entre turnos. Vive aqui y
    // no en el carrito porque un evento NO es un pedido: no tiene renglones,
    // ni precio, ni modalidad, y meterlo en el carrito lo haria pasar por
    // el reconciliador, que no tiene nada que decidir sobre el.
    evento: null,
  };
}

export const estadoSerializable = (e) => JSON.parse(JSON.stringify(e ?? null));

/**
 * Crea el ejecutor de UN turno.
 *
 *   `estado`      el de la conversación; se MUTA (carrito, hechos, folio)
 *   `catalogo`    la carta real del negocio, ya leída
 *   `mensaje`     lo que el cliente escribió ESTE turno — la evidencia
 *   `textoCiclo`  lo que lleva dicho en el ciclo de pedido en curso
 *   `efectos`     `{ confirmar, escalar }`; en sombra y replay, grabadoras
 */
export function crearEjecutor({
  estado, catalogo = [], precios = null, requierePago = true,
  mensaje = '', textoCiclo = '', terminos = [], datoOperativoPendiente = false,
  efectos = null, registrarOfrecido = true, metodosPago = null, modalidades = null,
  reglas = null, configTienda = null, promocionesActivas = [], opcionesAceptadas = [],
  zonaDelNegocio = undefined,
} = {}) {
  const vista = () => {
    const pedido = vistaDelPedido({
      carrito: estado.carrito, catalogo, precios, requierePago, hechos: estado.hechos,
      reglas, promocionesActivas,
    });
    const conContinuidad = (estado.ofrecidos || []).length
      ? { ...pedido, ofrecidos: estado.ofrecidos.slice() }
      : pedido;
    const conPago = estado.pagoOfrecido
      ? { ...conContinuidad, pago_ofrecido: etiquetaTipoPago(estado.pagoOfrecido) }
      : conContinuidad;
    return estado.evento
      ? { ...conPago, evento: eventoCateringPublico(estado.evento) }
      : conPago;
  };

  // ── LO QUE AUTORIZA UN «SÍ» ────────────────────────────────────────────
  //
  // Cuando el bot enseña UN producto y el cliente contesta «ese» o «sí», el
  // nombre del producto no aparece en ninguna frase suya y el reconciliador
  // —con razón— no lo deja entrar. `evidenciaAceptada` es el canal que ya
  // existe para eso, y aquí se alimenta de un hecho, no de un recuerdo: de lo
  // que `buscar_producto` devolvió en el turno ANTERIOR, y solo cuando devolvió
  // EXACTAMENTE UNO.
  //
  // Las dos restricciones importan. Si se alimentara de lo que el modelo cree
  // haber ofrecido, sería el modelo autorizando; si valiera con varios
  // candidatos, un «sí» ambiguo metería el primero de una lista. Y caduca al
  // turno siguiente: un producto que se enseñó hace cinco turnos no lo
  // autoriza un «sí» de ahora.
  const evidenciaAceptada = () => (estado.ofrecidos || []).slice();

  const anotarOfrecido = (nombre) => {
    if (!registrarOfrecido || !nombre) return;
    if (!estado.ofrecidosDelTurno.includes(nombre)) estado.ofrecidosDelTurno.push(nombre);
  };

  const opcionesDeReconciliacion = () => ({
    mensaje,
    textoCiclo: textoCiclo || mensaje,
    terminos,
    datoOperativoPendiente,
    evidenciaAceptada: evidenciaAceptada(),
    evidenciaOpcionesAceptadas: opcionesAceptadas,
  });

  /** Aplica propuestas y RELEE. Devuelve `{ aplicado, decisiones, cambios, pedido }`. */
  const aplicar = (propuestas) => {
    const limpias = propuestas.filter(Boolean);
    if (!limpias.length) return { aplicado: false, motivo: 'propuesta_vacia', decisiones: [], pedido: vista() };
    const r = aplicarPropuestas(estado.carrito, limpias, opcionesDeReconciliacion());
    estado.carrito = r.carrito;
    const aceptadas = r.decisiones.filter((d) => d.decision === 'aceptada');
    return {
      aplicado: aceptadas.length > 0,
      decisiones: r.decisiones,
      cambios: r.cambios,
      // LA RELECTURA. Todo lo que el modelo va a leer sale de aquí.
      pedido: vista(),
    };
  };

  /** El motivo de un rechazo, en palabras que el modelo pueda accionar. */
  const porQueNo = (decisiones) => {
    const mala = decisiones.find((d) => d.decision === 'rechazada');
    const m = mala?.motivo || 'sin_respaldo_del_reconciliador';
    if (m === 'sin_respaldo_del_reconciliador') {
      return 'el_cliente_no_lo_dijo: el pedido NO cambió. Xabor solo aplica lo que el cliente '
        + 'escribió en este turno. Si crees que lo pidió, pregúntaselo con sus palabras en vez de darlo por hecho.';
    }
    if (m === 'renglon_inexistente') return 'renglon_inexistente: ese linea_id ya no está en el pedido. Llama a ver_pedido.';
    return m;
  };

  // ── LAS HERRAMIENTAS ───────────────────────────────────────────────────

  const impl = {
    ver_pedido() {
      return ok({ pedido: vista() });
    },

    buscar_producto({ texto, categoria }) {
      const t = String(texto || '').trim();
      if (!t) {
        return ok({ categorias: indiceDeLaCarta(catalogo) });
      }

      // XAB-0481: «y papas a la mexicana» era una guarnición de los
      // chilaquiles ya agregados. La búsqueda por palabras encontró tacos y
      // convirtió una opción real en otro producto. Las opciones exactas de
      // los renglones actuales se detectan antes de buscar productos.
      const dicho = norm(t);
      const opcionesDelPedido = [];
      for (const item of (estado.carrito?.items || [])) {
        const fichaItem = fichaPorNombre(catalogo, item?.nombre);
        if (!fichaItem) continue;
        const actuales = opcionesDeLinea(item);
        for (const grupo of (fichaItem.grupos || [])) {
          for (const opcion of (grupo.opciones || [])) {
            const nombreOpcion = norm(opcion.nombre);
            if (!nombreOpcion || !(` ${dicho} `.includes(` ${nombreOpcion} `))) continue;
            opcionesDelPedido.push({
              linea_id: item.lid,
              producto: item.nombre,
              grupo: grupo.nombre,
              opcion: opcion.nombre,
              maximo: grupo.maximo,
              opciones_actuales: actuales
                .filter((o) => norm(o.grupo) === norm(grupo.nombre))
                .map((o) => o.opcion),
            });
          }
        }
      }
      const productoExacto = productosVendibles(catalogo)
        .some((p) => norm(p.nombre) === dicho);
      if (opcionesDelPedido.length && !productoExacto) {
        return ok({
          encontrados: [],
          existe: true,
          es_opcion_del_pedido: true,
          coincidencias_opcion: opcionesDelPedido,
          nota: 'Esto coincide con una OPCIÓN de un producto que ya está en el pedido, no con un producto nuevo. '
            + 'Usa modificar_linea. Si el cliente no dijo a cuál renglón se aplica, pregúntale; conserva las opciones_actuales del grupo.',
        });
      }
      let fichas = buscarProductos(catalogo, t, { limite: 8 });
      if (categoria) {
        const c = norm(categoria);
        fichas = fichas.filter((f) => norm(f.categoria) === c);
      }

      // La coincidencia por palabras encuentra la FAMILIA, pero una opción
      // que el cliente ya nombró también puede resolver la variante. Ejemplo
      // real: «chilaquiles suizos» comparte el mismo nombre base con cuatro
      // productos, pero la carta declara cuál es la variante base y que
      // «Suiza» pertenece al grupo Salsa. El resolvedor canónico ya sabe hacer
      // esa lectura sin inventar; la herramienta del agente no lo consultaba.
      //
      // Una mención totalmente genérica sigue devolviendo varios candidatos:
      // solo se acota cuando el cliente nombró una variante o cuando al menos
      // una opción de la carta quedó identificada de forma inequívoca.
      const evidencia = String(textoCiclo || mensaje || t);
      const anclada = anclarLinea({
        catalogo, nombrePropuesto: t, evidencia,
        dichoDelCliente: String(mensaje || evidencia),
      });
      const elecciones = (anclada?.grupos || [])
        .map((g) => ({ grupo: g.grupo, opciones: (g.elegidas || []).slice() }))
        .filter((g) => g.opciones.length);
      const varianteNombrada = anclada?.motivo === 'variante_nombrada';
      if (anclada?.estado === 'resuelto' && (varianteNombrada || elecciones.length)) {
        const resuelta = fichas.find((f) => String(f.id) === String(anclada.producto?.id));
        if (resuelta) fichas = [resuelta];
      }
      // La búsqueda por palabras también devuelve hermanos (por ejemplo,
      // «Licuado de fresa» junto a «Licuado de plátano»). Si el texto coincide
      // con UN nombre exacto de la carta, ese producto ya está elegido.
      const exactas = fichas.filter((f) => norm(f.nombre) === norm(t));
      if (exactas.length === 1) fichas = exactas;
      if (!fichas.length) {
        // NO EXISTE. Se dice así, con la carta a mano, y no se sustituye por
        // el más parecido: sustituir es cómo un cliente recibe una torta de
        // otra cosa dada por confirmada.
        return ok({
          encontrados: [],
          existe: false,
          nota: 'Ese producto NO está en la carta de este negocio. Díselo al cliente; no lo cambies por otro.',
          categorias: indiceDeLaCarta(catalogo),
        });
      }
      const encontrados = fichas.map((f) => ({
        producto_id: String(f.id),
        nombre: f.nombre,
        categoria: f.categoria,
        precio: f.precio,
        descripcion: f.descripcion,
        opciones_obligatorias: (f.grupos || []).filter((g) => g.requerido || (Number(g.minimo) || 0) > 0)
          .map((g) => g.nombre),
        ...(String(f.id) === String(anclada?.producto?.id) && elecciones.length
          ? { opciones_mencionadas: elecciones }
          : {}),
      }));
      // Un solo candidato es lo que un «sí» puede aceptar después. Con varios,
      // el cliente todavía no ha dicho cuál, y decidirlo por él es el error
      // que esta arquitectura existe para impedir.
      if (encontrados.length === 1) anotarOfrecido(encontrados[0].nombre);
      return ok({
        encontrados,
        existe: true,
        ...(encontrados.length > 1
          ? { nota: 'Hay varios. El cliente NO ha dicho cuál: pregúntaselo antes de agregar nada.' }
          : {}),
      });
    },

    ver_opciones_producto({ producto_id }) {
      const f = fichaPorId(catalogo, producto_id);
      if (!f) return invalido(`producto_id_inexistente: ${producto_id}. Usa buscar_producto para obtener uno válido.`);
      anotarOfrecido(f.nombre);
      return ok({
        producto_id: String(f.id),
        nombre: f.nombre,
        precio: f.precio,
        grupos: (f.grupos || []).map((g) => ({
          grupo: g.nombre,
          obligatorio: !!g.requerido || (Number(g.minimo) || 0) > 0,
          minimo: Number(g.minimo) || 0,
          maximo: g.maximo,
          opciones: (g.opciones || []).map((o) => ({ opcion: o.nombre, precio_extra: o.precio_extra })),
        })),
      });
    },

    agregar_producto({ producto_id, cantidad = 1, opciones = [], nota }) {
      const f = fichaPorId(catalogo, producto_id);
      if (!f) return invalido(`producto_id_inexistente: ${producto_id}. Usa buscar_producto para obtener uno válido.`);

      const val = validarOpciones(f, opciones);
      if (!val.ok) return invalido(val.motivo, { grupos: val.grupos });

      const r = aplicar([propuesta({
        accion: 'agregar',
        valorNuevo: {
          id: f.id,
          nombre: f.nombre,
          cantidad,
          modificadores: val.modificadores,
          notas: nota || '',
        },
        evidencia: mensaje,
      })]);
      if (!r.aplicado) return noAplicado(porQueNo(r.decisiones), { pedido: r.pedido });
      return ok({ pedido: r.pedido });
    },

    modificar_linea({ linea_id, cantidad, opciones, sin_opciones, nota }) {
      const item = (estado.carrito.items || []).find((i) => i.lid === linea_id);
      if (!item) return invalido(`linea_inexistente: ${linea_id}. Llama a ver_pedido para ver los linea_id vigentes.`);
      const ficha = fichaPorNombre(catalogo, item.nombre);
      if ((opciones !== undefined || sin_opciones !== undefined) && !ficha) {
        return invalido(`renglon_fuera_de_carta: "${item.nombre}" ya no está en la carta.`);
      }

      const props = [];
      if (cantidad !== undefined) {
        props.push(propuesta({ accion: 'cambiar_cantidad', lid: linea_id, valorNuevo: cantidad, evidencia: mensaje }));
      }
      if (opciones !== undefined) {
        const val = validarOpciones(ficha, opciones);
        if (!val.ok) return invalido(val.motivo, { grupos: val.grupos });
        for (const g of val.modificadores) {
          props.push(propuesta({ accion: 'cambiar_modificador', lid: linea_id,
            campo: g.grupo, valorNuevo: g.opciones, evidencia: mensaje }));
        }
      }
      // ── QUITAR UNA OPCIÓN NO ES SUSTITUIRLA ─────────────────────────────
      //
      // «sin huevo», «sin fruta». Se expresa como un grupo con la lista vacía,
      // que es como `conGrupo` lo borra. El grupo tiene que EXISTIR en el
      // producto: quitar de un grupo que no tiene es la misma clase de invento
      // que agregarle una opción que no ofrece.
      const quitarGrupos = [];
      for (const nombreGrupo of (sin_opciones || [])) {
        const g = (ficha.grupos || []).find((x) => norm(x.nombre) === norm(nombreGrupo));
        if (!g) {
          return invalido(`grupo_inexistente: "${nombreGrupo}" no es un grupo de "${item.nombre}". `
            + `Los grupos reales son: ${(ficha.grupos || []).map((x) => x.nombre).join(', ') || '(ninguno)'}.`);
        }
        quitarGrupos.push(g.nombre);
        props.push(propuesta({ accion: 'cambiar_modificador', lid: linea_id,
          campo: g.nombre, valorNuevo: [], evidencia: mensaje }));
      }

      if (nota !== undefined) {
        props.push(propuesta({ accion: 'agregar_nota', lid: linea_id, valorNuevo: nota, evidencia: mensaje }));
      }
      if (!props.length) return invalido('nada_que_cambiar: manda al menos cantidad, opciones, sin_opciones o nota.');

      const r = aplicar(props);

      // ── EL RESULTADO SE LEE DEL PEDIDO, NO DE LAS DECISIONES ───────────
      //
      // Para quitar un grupo hay que proponer la lista vacía, y la contabilidad
      // de `aplicarPropuestas` da por no aplicada toda propuesta de modificador
      // cuyo valor esperado esté vacío — mide «¿quedaron puestas las que pedí?»
      // y no hay ninguna que comprobar. Antes que tocar esa contabilidad, que
      // es compartida con el mesero, se comprueba aquí contra la RELECTURA, que
      // además es la fuente de verdad de todas formas.
      const despues = (r.pedido.lineas || []).find((l) => l.linea_id === linea_id);
      const quitados = quitarGrupos.filter((g) => !(despues?.opciones || [])
        .some((o) => norm(o.grupo) === norm(g)));
      const seQuito = quitarGrupos.length > 0 && quitados.length === quitarGrupos.length;

      if (!r.aplicado && !seQuito) return noAplicado(porQueNo(r.decisiones), { pedido: r.pedido });
      return ok({ pedido: r.pedido,
        parcial: r.decisiones.some((d) => d.decision === 'rechazada') && !seQuito ? true : undefined });
    },

    quitar_linea({ linea_id }) {
      const item = (estado.carrito.items || []).find((i) => i.lid === linea_id);
      if (!item) return invalido(`linea_inexistente: ${linea_id}. Llama a ver_pedido para ver los linea_id vigentes.`);
      const r = aplicar([propuesta({ accion: 'quitar', lid: linea_id, evidencia: mensaje })]);
      if (!r.aplicado) return noAplicado(porQueNo(r.decisiones), { pedido: r.pedido });
      return ok({ pedido: r.pedido });
    },

    definir_entrega({ modalidad, direccion, referencias, zona_entrega }) {
      const props = [];
      let rechazoModalidad = null;
      let modalidadEvaluada = null;
      let costoPorModalidad = null;
      if (modalidad) {
        const evaluacion = evaluarModalidad({ modalidad, modalidades, mensaje });
        if (!evaluacion.ok) {
          rechazoModalidad = {
            motivo: evaluacion.motivo,
            codigo: evaluacion.codigo,
            modalidad_solicitada: evaluacion.tipo,
            modalidades_disponibles: evaluacion.disponibles.map((m) => etiquetaTipoModalidad(m.tipo)),
          };
        } else {
          modalidadEvaluada = evaluacion;
          props.push(propuesta({
            accion: 'definir_modalidad', valorNuevo: evaluacion.valor, evidencia: mensaje,
          }));
          // Cambiar de modalidad invalida cualquier tarifa anterior. En
          // domicilio se recupera la base; recoger/sitio guardan cero, que al
          // volver a domicilio tampoco puede confundirse con una zona.
          const costoBase = Number(reglas?.pedidos?.costo_envio) || 0;
          costoPorModalidad = evaluacion.tipo === 'domicilio' ? costoBase : 0;
        }
      }
      if (direccion || referencias) {
        props.push(propuesta({ accion: 'definir_cliente',
          valorNuevo: { ...(direccion ? { direccion } : {}), ...(referencias ? { referencias } : {}) },
          evidencia: mensaje }));
      }

      let zonaAplicada = null;
      let rechazoZona = null;
      if (zona_entrega) {
        const zonas = Array.isArray(reglas?.pedidos?.zonas_entrega) ? reglas.pedidos.zonas_entrega : [];
        const zona = zonas.find((z) => norm(z?.nombre) === norm(zona_entrega)
          && Number.isFinite(Number(z?.costo)));
        if (!zona) {
          rechazoZona = {
            codigo: 'zona_no_configurada', zona_solicitada: String(zona_entrega),
            zonas_disponibles: zonas.map((z) => z?.nombre).filter(Boolean),
            motivo: `zona_no_configurada: "${zona_entrega}". Zonas disponibles: `
              + `${zonas.map((z) => z?.nombre).filter(Boolean).join(', ') || 'ninguna'}.`,
          };
        } else if (!norm(mensaje).includes(norm(zona.nombre))) {
          rechazoZona = {
            codigo: 'zona_sin_respaldo', zona_solicitada: String(zona.nombre),
            motivo: `zona_sin_respaldo: el cliente no mencionó "${zona.nombre}" en este mensaje.`,
          };
        } else {
          const modalidadFinal = rechazoModalidad ? null : (modalidadEvaluada?.tipo
            || evaluarModalidad({ modalidad: estado.carrito?.datos?.modalidad,
              modalidades, mensaje, exigirEvidencia: false }).tipo);
          if (modalidadFinal !== 'domicilio') {
            rechazoZona = {
              codigo: 'zona_sin_domicilio', zona_solicitada: String(zona.nombre),
              motivo: `zona_sin_domicilio: ${zona.nombre} solo aplica a entrega a domicilio.`,
            };
          } else {
            zonaAplicada = { nombre: String(zona.nombre), costo: Number(zona.costo) };
            costoPorModalidad = zonaAplicada.costo;
          }
        }
      }
      if (costoPorModalidad !== null) props.push(propuesta({ accion: 'definir_costo_envio',
        valorNuevo: costoPorModalidad, evidencia: mensaje }));
      const r = aplicar(props);
      if (rechazoModalidad && r.aplicado) {
        return ok({ ...rechazoModalidad, pedido: r.pedido, parcial: true });
      }
      if (rechazoModalidad) {
        return noAplicado(rechazoModalidad.motivo, { ...rechazoModalidad, pedido: r.pedido });
      }
      if (rechazoZona && r.aplicado) {
        return ok({ ...rechazoZona, pedido: r.pedido, parcial: true });
      }
      if (rechazoZona) {
        return noAplicado(rechazoZona.motivo, { ...rechazoZona, pedido: r.pedido });
      }
      if (!r.aplicado) return noAplicado(porQueNo(r.decisiones), { pedido: r.pedido });
      return ok({ pedido: r.pedido, ...(zonaAplicada ? { zona_entrega: zonaAplicada } : {}) });
    },

    definir_pago({ forma_pago, paga_con }) {
      const evaluacion = evaluarFormaPago({
        formaPago: forma_pago, metodosPago, mensaje, ofrecido: estado.pagoOfrecido,
      });
      if (!evaluacion.ok) {
        if (evaluacion.alternativa) estado.pagoOfrecido = evaluacion.alternativa;
        return noAplicado(evaluacion.motivo, {
          codigo: evaluacion.codigo,
          metodo_solicitado: evaluacion.tipo,
          metodos_disponibles: evaluacion.disponibles.map(etiquetaTipoPago),
          alternativa: evaluacion.alternativa ? etiquetaTipoPago(evaluacion.alternativa) : null,
          pedido: vista(),
        });
      }
      const props = [propuesta({ accion: 'definir_pago', valorNuevo: evaluacion.tipo, evidencia: mensaje })];
      if (paga_con !== undefined) {
        props.push(propuesta({ accion: 'definir_cliente', valorNuevo: { paga_con }, evidencia: mensaje }));
      }
      const r = aplicar(props);
      if (!r.aplicado) return noAplicado(porQueNo(r.decisiones), { pedido: r.pedido });
      estado.pagoOfrecido = null;
      return ok({ metodo: evaluacion.tipo, pedido: vista() });
    },

    definir_cliente({ nombre }) {
      const r = aplicar([propuesta({ accion: 'definir_cliente', valorNuevo: { nombre }, evidencia: mensaje })]);
      if (!r.aplicado) return noAplicado(porQueNo(r.decisiones), { pedido: r.pedido });
      return ok({ pedido: r.pedido });
    },

    cancelar_pedido({ motivo }) {
      estado.carrito = carritoVacio();
      estado.hechos.cancelado = true;
      estado.terminadoEn = new Date().toISOString();
      estado.motivoCancelado = String(motivo || '').slice(0, 200);
      return ok({ pedido: vista(), cancelado: true });
    },

    async confirmar_pedido({ huella_resumen }) {
      const antes = vista();
      // ── LA COMPROBACIÓN QUE HACE QUE LA CONFIRMACIÓN NO SEA TEATRO ─────
      //
      // La huella es la del resumen que el cliente LEYÓ. Si el pedido cambió
      // entre aquel resumen y este «sí», el sí no vale para lo que hay ahora.
      // No se confirma y se devuelve el resumen fresco para que se vuelva a
      // mostrar. Es la única forma de que «confirmado» signifique siempre lo
      // mismo que el cliente aceptó.
      if (String(huella_resumen) !== String(antes.huella)) {
        return invalido('resumen_caducado: el pedido cambió desde el resumen que le mostraste al cliente. '
          + 'Vuelve a mostrarle el pedido de abajo y pídele que lo confirme otra vez.',
        { pedido: antes });
      }
      if (antes.falta.length || antes.aclaraciones.length) {
        // No debería llegar aquí: la máquina de estados ya lo filtró. Se
        // comprueba igual porque es la invariante que más caro cuesta romper.
        return invalido(`pedido_incompleto: falta ${antes.falta.join(', ') || 'una aclaración'}.`, { pedido: antes });
      }
      const r = efectos?.confirmar
        ? await efectos.confirmar({ estado, pedido: antes, catalogo, precios })
        : { ok: true, folio: null, simulado: true };
      if (!r?.ok) return noAplicado(`no_se_pudo_registrar: ${r?.motivo || 'desconocido'}`, {
        pedido: antes,
        ...(r?.resumen_canonico ? { resumen_canonico: r.resumen_canonico } : {}),
      });

      estado.hechos.confirmado = true;
      estado.terminadoEn = new Date().toISOString();
      estado.folio = r.folio ?? null;
      return ok({
        pedido: vista(), folio: r.folio ?? null, simulado: !!r.simulado,
        ...(r.total !== undefined ? { total: r.total } : {}),
        ...(r.subtotal !== undefined ? { subtotal: r.subtotal } : {}),
        ...(r.costo_envio !== undefined ? { costo_envio: r.costo_envio } : {}),
        ...(r.programado_para ? { programado_para: r.programado_para } : {}),
        ...(r.enlacePago?.url ? { enlace_pago: r.enlacePago.url } : {}),
        ...(r.enlacePagoError ? { enlace_pago_error: r.enlacePagoError } : {}),
      });
    },

    async pedir_humano({ motivo }) {
      const r = efectos?.escalar
        ? await efectos.escalar({ estado, motivo, pedido: vista() })
        : { ok: true, simulado: true };
      if (!r?.ok) return noAplicado(`no_se_pudo_escalar: ${r?.motivo || 'desconocido'}`, { pedido: vista() });
      estado.hechos.escalado = true;
      estado.motivoEscalado = String(motivo || '').slice(0, 200);
      return ok({ pedido: vista(), escalado: true, simulado: !!r?.simulado });
    },

    // ── EL MENÚ LO MANDA XABOR, Y DICE SI SALIÓ ────────────────────────
    //
    // El envío real lo hace `enviarMenuAutomatico`, que ya manda todas las
    // páginas en orden, reintenta una vez y redacta su propio aviso honesto
    // si algo falla. Por eso el resultado insiste en que el modelo NO diga
    // «aquí está tu menú»: esa frase ya la escribió quien sabe si de verdad
    // llegó, y duplicarla es —en el peor caso— afirmar un envío que falló.
    //
    // Va por el libro de operaciones como cualquier herramienta con efecto,
    // y su esquema no tiene argumentos: dos llamadas en el mismo turno dan la
    // misma clave, así que el cliente no recibe el menú dos veces.
    async enviar_menu() {
      if (!efectos?.enviarMenu) {
        return noAplicado('sin_canal_para_el_menu: este entorno no puede mandar imágenes. '
          + 'Descríbele la carta con palabras usando buscar_producto.', { pedido: vista() });
      }
      const r = await efectos.enviarMenu({ estado });
      if (!r?.ok) {
        return noAplicado(`no_se_pudo_enviar_el_menu: ${r?.motivo || 'desconocido'}. `
          + 'Díselo y ofrécele contarle la carta con palabras.', { pedido: vista() });
      }
      return ok({ pedido: vista(), paginas: r.paginas ?? null, simulado: !!r.simulado,
        nota: 'El menú ya se envió, con su texto. NO repitas que se lo mandaste: pregunta qué se le antoja.' });
    },

    // ── PROGRAMAR PARA OTRO DÍA ────────────────────────────────────────
    //
    // Se guarda en los datos del carrito y NO pasa por `reconciliar`: el
    // reconciliador decide qué ARTÍCULOS entran al pedido contra lo que dijo
    // el cliente, y una fecha no es un artículo. Lo que la autoriza es la
    // validación contra el horario del negocio, que es dato duro y no
    // interpretación.
    //
    // Quien lo convierte en reserva durable es `confirmar_pedido`, llamando a
    // `convertirPedidoAProgramado` después de registrar. Hasta entonces esto
    // es una intención, no una promesa.
    programar_para({ fecha, hora }) {
      const r = validarProgramado({
        fecha, hora, reglas, configTienda, zona: zonaDelNegocio,
        minutosPreparacion: reglas?.pedidos?.tiempo_preparacion_minutos ?? null,
      });
      if (!r.ok) return invalido(`${r.motivo}: ${r.mensaje}`, { pedido: vista() });

      estado.programacionRequerida = true;
      estado.carrito.datos = { ...(estado.carrito.datos || {}), programado_para: r.iso };
      return ok({ pedido: vista(), programado_para: r.iso, dia: r.dia, hora: r.hora,
        anticipacion_minutos: r.anticipacionMinutos,
        nota: `Queda para el ${r.dia} a las ${r.hora}. Díselo con esas palabras y sigue con el pedido. `
          + 'La comanda sale en cocina una hora antes, no ahora.' });
    },

    // ── UN EVENTO SE ANOTA, NO SE COTIZA ───────────────────────────────
    //
    // Decisión del dueño: el agente toma cuatro mínimos y avisa de que alguien
    // del equipo se comunica. No propone menús, no da precios, no promete
    // disponibilidad. Un evento se cotiza mirando personal, agenda y margen,
    // y nada de eso está en la carta.
    //
    // Los datos se ACUMULAN entre llamadas porque una persona los da a
    // trozos. Mientras falte alguno, la herramienta contesta qué falta y no
    // escala: escalar a medias le daría a quien conteste un aviso sin datos.
    async registrar_solicitud_evento(datos) {
      // El modelo no convierte un pedido grande en evento. La primera llamada
      // necesita una señal explícita en las palabras del cliente; después el
      // estado durable permite continuar con respuestas sueltas (nombre,
      // lugar, asistentes, fecha/hora).
      if (!estado.evento && !esSolicitudCatering(mensaje)) {
        return invalido('solicitud_evento_sin_senal_explicita: trátalo como pedido normal; '
          + 'la cantidad de artículos o personas no convierte un pedido en catering.');
      }
      // Estados escritos antes de la barrera de procedencia no son hechos:
      // se conservan únicamente los valores cuya firma coincide. El nombre
      // confiable del canal ya llega firmado al inicializar la ficha.
      const previo = eventoCateringVerificado(estado.evento || {});
      const evidencia = filtrarDatosEventoCatering(datos, {
        mensaje,
        eventoPrevio: previo,
      });
      const eventoSinSello = {
        nombre: evidencia.aceptados.nombre ?? previo.nombre ?? null,
        lugar: evidencia.aceptados.lugar ?? previo.lugar ?? null,
        fecha_hora: evidencia.aceptados.fecha_hora ?? previo.fecha_hora ?? null,
        tipo_servicio: evidencia.aceptados.tipo_servicio ?? previo.tipo_servicio ?? null,
        personas: evidencia.aceptados.personas ?? previo.personas ?? null,
      };
      const evento = sellarEventoCatering(
        { ...previo, ...eventoSinSello }, Object.keys(evidencia.aceptados));
      estado.evento = evento;
      const eventoPublico = eventoCateringPublico(evento);

      // Mínimos deterministas: nombre + fecha/hora + lugar + asistentes. El
      // teléfono ya viene del canal. `tipo_servicio` se conserva si lo dijo,
      // pero no se le obliga a elegir una categoría ni bloquea el handoff.
      const faltan = ['nombre', 'personas', 'lugar'].filter((k) => !eventoPublico[k]);
      const fechaHora = partesFechaHoraCatering({ fecha_evento: eventoPublico.fecha_hora });
      if (!fechaHora.tieneFecha || !fechaHora.tieneHora) faltan.push('fecha_hora');
      if (faltan.length) {
        return ok({ registrado: false, evento: eventoPublico, faltan,
          ...(evidencia.rechazados.length ? { sin_evidencia: evidencia.rechazados } : {}),
          nota: `Anotado lo que hay. Todavía falta: ${faltan.join(', ')}. Pregúntaselo, de uno en uno.` });
      }

      const r = efectos?.registrarEvento
        ? await efectos.registrarEvento({ estado, evento: eventoPublico })
        : { ok: true, simulado: true };
      if (!r?.ok) {
        return noAplicado(`no_se_pudo_registrar_el_evento: ${r?.motivo || 'desconocido'}`, { pedido: vista() });
      }

      // Queda escalado: a partir de aquí contesta una persona. Es el mismo
      // desenlace que `pedir_humano` y por eso reutiliza su estado, en vez de
      // inventar un sexto hecho irreversible que habría que mantener aparte.
      estado.hechos.escalado = true;
      estado.motivoEscalado = `solicitud de evento${eventoPublico.tipo_servicio ? `: ${eventoPublico.tipo_servicio}` : ''}`;
      return ok({ registrado: true, evento: eventoPublico, pedido: vista(), escalado: true, simulado: !!r.simulado,
        nota: 'Ya quedó anotado. Dile que alguien del equipo se comunica con él para los detalles. '
          + 'No le des precios ni propongas menú.' });
    },
  };

  /**
   * EJECUTA UNA LLAMADA. Único punto de entrada.
   *
   * El orden importa y es el mismo siempre: legalidad de la transición ->
   * implementación -> relectura. Una herramienta ilegal ni siquiera llega a
   * tocar el carrito.
   */
  return {
    vista,
    async ejecutar(nombre, argumentos) {
      // Una ficha de evento es un flujo separado, sin carrito, precios, pago,
      // menú ni confirmación. El prompt orienta; esta barrera impide efectos
      // aunque el modelo ignore por completo esas instrucciones.
      if (estado.evento && !['registrar_solicitud_evento', 'pedir_humano'].includes(nombre)) {
        return invalido(`flujo_catering_activo: ${nombre} no está permitido mientras se recopilan datos de evento`, {
          pedido: vista(),
        });
      }
      if (estado.evento && nombre === 'pedir_humano' && !solicitaAtencionHumana(mensaje)) {
        const evento = eventoCateringPublico(eventoCateringVerificado(estado.evento));
        const fecha = partesFechaHoraCatering({ fecha_evento: evento.fecha_hora });
        const incompleta = !evento.nombre || !evento.personas || !evento.lugar
          || !fecha.tieneFecha || !fecha.tieneHora;
        if (incompleta) {
          return invalido('catering_datos_incompletos: recopila los cuatro datos antes de entregar el caso', {
            pedido: vista(),
          });
        }
      }
      const pedidoAhora = vista();
      const t = transicionLegal(nombre, pedidoAhora.estado);
      if (!t.legal) return invalido(t.motivo, { pedido: pedidoAhora });

      const fn = impl[nombre];
      if (!fn) return invalido(`herramienta_desconocida: ${nombre}`);
      const r = await fn(argumentos || {});
      return r;
    },
    /** Al cerrar el turno: lo ofrecido AHORA es lo que un «sí» podrá aceptar DESPUÉS. */
    cerrarTurno() {
      estado.ofrecidos = estado.ofrecidosDelTurno.slice();
      estado.ofrecidosDelTurno = [];
      estado.turno += 1;
    },
  };
}

/**
 * ¿EXISTEN ESTAS OPCIONES EN ESTE PRODUCTO?
 *
 * Contra los grupos REALES del producto real. Un grupo que no tiene, o una
 * opción que ese grupo no ofrece, es un `ilegal` con la lista de lo que sí
 * hay — para que el modelo pueda corregir en el mismo turno en vez de
 * inventar por segunda vez.
 *
 * Se compara normalizado (acentos, mayúsculas) porque el modelo copia los
 * nombres a mano y una tilde no debería costar un turno; pero se GUARDA el
 * nombre canónico de la carta, nunca el que escribió el modelo.
 */
export function validarOpciones(ficha, opciones = []) {
  const grupos = (ficha?.grupos || []);
  const elegidas = Array.isArray(opciones) ? opciones : [];
  const porGrupo = new Map();

  for (const e of elegidas) {
    const g = grupos.find((x) => norm(x.nombre) === norm(e.grupo));
    if (!g) {
      return { ok: false,
        motivo: `grupo_inexistente: "${e.grupo}" no es un grupo de "${ficha?.nombre}". `
          + `Los grupos reales son: ${grupos.map((x) => x.nombre).join(', ') || '(ninguno)'}.`,
        grupos: grupos.map((x) => ({ grupo: x.nombre, opciones: (x.opciones || []).map((o) => o.nombre) })) };
    }
    const o = (g.opciones || []).find((x) => norm(x.nombre) === norm(e.opcion));
    if (!o) {
      return { ok: false,
        motivo: `opcion_inexistente: "${e.opcion}" no existe en el grupo "${g.nombre}" de "${ficha?.nombre}". `
          + `Las opciones reales son: ${(g.opciones || []).map((x) => x.nombre).join(', ') || '(ninguna)'}.`,
        grupos: [{ grupo: g.nombre, opciones: (g.opciones || []).map((x) => x.nombre) }] };
    }
    const lista = porGrupo.get(g.nombre) || [];
    if (!lista.includes(o.nombre)) lista.push(o.nombre);
    porGrupo.set(g.nombre, lista);
  }

  // La cardinalidad la declara el negocio y aquí se respeta: pedir dos salsas
  // de un grupo que admite una no es una preferencia del cliente que haya que
  // acomodar, es una elección imposible en esa carta.
  for (const [nombre, lista] of porGrupo) {
    const g = grupos.find((x) => x.nombre === nombre);
    const max = g?.maximo === null || g?.maximo === undefined ? null : Number(g.maximo);
    if (max !== null && lista.length > max) {
      return { ok: false,
        motivo: `demasiadas_opciones: "${nombre}" admite como máximo ${max} y mandaste ${lista.length}. `
          + 'Pregúntale al cliente cuál quiere.',
        grupos: [{ grupo: nombre, opciones: (g.opciones || []).map((x) => x.nombre), maximo: max }] };
    }
  }

  return { ok: true, motivo: null,
    modificadores: [...porGrupo.entries()].map(([grupo, ops]) => ({ grupo, opciones: ops })) };
}

export { tieneEfecto, esTerminal, productosVendibles, fichaDeProducto };
