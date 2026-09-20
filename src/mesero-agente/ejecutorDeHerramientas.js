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
import { transicionLegal, esTerminal } from './maquinaDeEstados.js';
import { vistaDelPedido, fichaPorId, fichaPorNombre } from './vistaDelPedido.js';
import { tieneEfecto } from './contratoDeHerramientas.js';

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
    turno: 0,
    // Lo que el bot puso delante del cliente en el turno ANTERIOR y que un
    // «sí» puede aceptar. Ver `evidenciaAceptada`, abajo.
    ofrecidos: [],
    ofrecidosDelTurno: [],
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
  efectos = null, registrarOfrecido = true,
} = {}) {
  const vista = () => vistaDelPedido({
    carrito: estado.carrito, catalogo, precios, requierePago, hechos: estado.hechos,
  });

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
      let fichas = buscarProductos(catalogo, t, { limite: 8 });
      if (categoria) {
        const c = norm(categoria);
        fichas = fichas.filter((f) => norm(f.categoria) === c);
      }
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

    definir_entrega({ modalidad, direccion, referencias }) {
      const props = [];
      if (modalidad) props.push(propuesta({ accion: 'definir_modalidad', valorNuevo: modalidad, evidencia: mensaje }));
      if (direccion || referencias) {
        props.push(propuesta({ accion: 'definir_cliente',
          valorNuevo: { ...(direccion ? { direccion } : {}), ...(referencias ? { referencias } : {}) },
          evidencia: mensaje }));
      }
      const r = aplicar(props);
      if (!r.aplicado) return noAplicado(porQueNo(r.decisiones), { pedido: r.pedido });
      return ok({ pedido: r.pedido });
    },

    definir_pago({ forma_pago, paga_con }) {
      const props = [propuesta({ accion: 'definir_pago', valorNuevo: forma_pago, evidencia: mensaje })];
      if (paga_con !== undefined) {
        props.push(propuesta({ accion: 'definir_cliente', valorNuevo: { paga_con }, evidencia: mensaje }));
      }
      const r = aplicar(props);
      if (!r.aplicado) return noAplicado(porQueNo(r.decisiones), { pedido: r.pedido });
      return ok({ pedido: r.pedido });
    },

    definir_cliente({ nombre }) {
      const r = aplicar([propuesta({ accion: 'definir_cliente', valorNuevo: { nombre }, evidencia: mensaje })]);
      if (!r.aplicado) return noAplicado(porQueNo(r.decisiones), { pedido: r.pedido });
      return ok({ pedido: r.pedido });
    },

    cancelar_pedido({ motivo }) {
      estado.carrito = carritoVacio();
      estado.hechos.cancelado = true;
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
      if (!r?.ok) return noAplicado(`no_se_pudo_registrar: ${r?.motivo || 'desconocido'}`, { pedido: antes });

      estado.hechos.confirmado = true;
      estado.folio = r.folio ?? null;
      return ok({ pedido: vista(), folio: r.folio ?? null, simulado: !!r.simulado });
    },

    async pedir_humano({ motivo }) {
      const r = efectos?.escalar
        ? await efectos.escalar({ estado, motivo, pedido: vista() })
        : { ok: true, simulado: true };
      estado.hechos.escalado = true;
      estado.motivoEscalado = String(motivo || '').slice(0, 200);
      return ok({ pedido: vista(), escalado: true, simulado: !!r?.simulado });
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
