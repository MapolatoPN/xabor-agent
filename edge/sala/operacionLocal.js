// OPERACIÓN DE SALA SIN INTERNET.
//
// Por qué existe: hoy, si se cae el enlace, el restaurante se para. Edge V1 ya
// sobrevive a un corte para IMPRIMIR lo que tenía en cola, pero abrir una mesa,
// capturar un producto o cobrar necesitan la nube. Un sábado a las 14:00 sin
// internet, con Wansoft ya cancelado, eso es un cierre operativo.
//
// ── El hallazgo que hace esto viable ────────────────────────────────────────
// `docs/xabor-edge-offline-roadmap.md` daba por "el punto crítico" que los
// folios globales no sirven offline: dos Edges desconectados generarían el
// mismo número. Eso es cierto para `pedidos_activos.folio` (la secuencia de
// pedidos de WhatsApp/mostrador), pero el camino de SALA no la usa:
//
//   · `restaurante_cuentas`, `..._items` y `..._pagos` tienen PK UUID.
//   · El folio de venta se DERIVA de la cuenta:
//     `RM-<8 hex del uuid>-<reversos>` (restauranteService.js:379).
//   · Ese insert ya es `ON CONFLICT (folio) DO NOTHING`.
//
// Es decir: la sala entera se puede operar offline con identificadores
// generados aquí, y subirlos después es un upsert por UUID. No hace falta la
// arquitectura de dos capas (id local + folio de la nube) que proponía la hoja
// de ruta. Se documenta aquí porque es lo que convierte una fase grande en una
// alcanzable.
//
// ── Reglas ─────────────────────────────────────────────────────────────────
// 1. MISMOS INVARIANTES que la nube. Este módulo es un espejo de
//    `restauranteService.js`, no una versión relajada: mesa 1..500, una sola
//    cuenta abierta por mesa, comanda que solo saca lo pendiente, cierre que
//    exige saldo cero. Si offline se permitiera algo que online no, la
//    sincronización tendría que rechazar trabajo ya cobrado.
// 2. MISMOS CÓDIGOS DE ERROR (`MESA_OCUPADA`, `CUENTA_NO_ABIERTA`, ...), para
//    que la interfaz se comporte igual con y sin enlace.
// 3. APPEND-ONLY con UUID. Nada se identifica por posición ni por orden de
//    llegada: subir dos veces el mismo lote no puede duplicar nada.
// 4. DINERO EN CENTAVOS. La nube usa NUMERIC(10,2); en JavaScript sumar
//    flotantes acumula error y el cierre exige saldo cero. Internamente todo
//    es entero de centavos y solo se convierte al exponer.
//
// Módulo PURO: sin I/O, sin red, sin reloj propio. Recibe `ahora` y `uuid` para
// que las pruebas sean deterministas y para que la persistencia la decida quien
// lo usa (ver `serializar`/`estadoInicial`).

const MESA_MIN = 1, MESA_MAX = 500;
const PERSONAS_MIN = 1, PERSONAS_MAX = 100;
const CANTIDAD_MIN = 1, CANTIDAD_MAX = 200;
const METODOS = new Set(['efectivo', 'terminal', 'transferencia', 'enlace_pago']);
// La nube tolera medio centavo al comparar el saldo (restauranteService.js:360).
// En centavos enteros la tolerancia es exactamente cero, que es más estricto y
// nunca deja pasar un cierre descuadrado.
const TOLERANCIA_CENTAVOS = 0;

export class ErrorSala extends Error {
  constructor(mensaje, codigo) { super(mensaje); this.name = 'ErrorSala'; this.codigo = codigo; }
}
const fallar = (mensaje, codigo) => { throw new ErrorSala(mensaje, codigo); };

const aCentavos = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100);
};
const aPesos = (centavos) => Number((centavos / 100).toFixed(2));

/**
 * El folio de venta de una cuenta. Réplica EXACTA de restauranteService.js:379
 * — si estas dos expresiones divergen, una venta hecha offline entraría a la
 * nube con un folio distinto del que imprimió el ticket del cliente.
 */
export function folioDeVenta(cuentaId, reversos = 0) {
  return `RM-${String(cuentaId).replace(/-/g, '').slice(0, 8).toUpperCase()}-${reversos}`;
}

export function crearSalaLocal({ ahora = () => new Date(), uuid, estadoInicial = null } = {}) {
  if (typeof uuid !== 'function') throw new Error('crearSalaLocal: hace falta un generador `uuid`');

  // `cuentas` es el espejo local; `outbox` es lo que falta subir. Se separan a
  // propósito: una cuenta puede sincronizarse y seguir viva en sala.
  const estado = estadoInicial
    ? { cuentas: new Map(estadoInicial.cuentas.map((c) => [c.id, c])), outbox: [...(estadoInicial.outbox || [])] }
    : { cuentas: new Map(), outbox: [] };

  const ts = () => ahora().toISOString();

  // Cada mutación deja constancia. El `id` es del EVENTO, no de la entidad:
  // permite reintentar el envío de un lote sin repetir efectos.
  const anotar = (tipo, cuentaId, datos) => {
    estado.outbox.push({ id: uuid(), tipo, cuentaId, datos, ts: ts() });
  };

  const buscarCuenta = (cuentaId) => {
    const c = estado.cuentas.get(cuentaId);
    if (!c) fallar('Cuenta no encontrada', 'CUENTA_NO_ENCONTRADA');
    return c;
  };
  const exigirAbierta = (c) => {
    if (c.estado !== 'abierta') fallar('La cuenta no está abierta', 'CUENTA_NO_ABIERTA');
    return c;
  };

  const totalesDe = (c) => {
    const total = c.items
      .filter((i) => i.estado !== 'cancelado')
      .reduce((s, i) => s + i.cantidad * i.precio_unitario_centavos, 0);
    const pagado = c.pagos.reduce((s, p) => s + p.monto_centavos, 0);
    const propinas = c.pagos.reduce((s, p) => s + p.propina_centavos, 0);
    return { total, pagado, propinas, saldo: total - pagado };
  };

  return {
    // ── Mesas ──────────────────────────────────────────────────────────────
    abrirMesa({ mesaNumero, personas = 1, meseroUsuarioId, meseroNombre = null, abiertaPor }) {
      const mesa = parseInt(mesaNumero, 10);
      if (!Number.isInteger(mesa) || mesa < MESA_MIN || mesa > MESA_MAX) {
        fallar('Número de mesa inválido', 'MESA_INVALIDA');
      }
      const pers = parseInt(personas, 10) || 1;
      if (pers < PERSONAS_MIN || pers > PERSONAS_MAX) fallar('Número de personas inválido', 'PERSONAS_INVALIDAS');
      if (!meseroUsuarioId) fallar('El mesero no pertenece a este negocio', 'MESERO_INVALIDO');
      // Espejo del índice único parcial `idx_restaurante_mesa_abierta`: una
      // mesa solo tiene UNA cuenta abierta. Offline no hay base que lo imponga,
      // así que lo impone este módulo -- si no, dos capturas en la misma mesa
      // chocarían recién al reconectar, con el cliente ya cobrado.
      for (const c of estado.cuentas.values()) {
        if (c.estado === 'abierta' && c.mesa_numero === mesa) {
          fallar(`La mesa ${mesa} ya tiene una cuenta abierta`, 'MESA_OCUPADA');
        }
      }
      const cuenta = {
        id: uuid(), mesa_numero: mesa, personas: pers,
        mesero_usuario_id: meseroUsuarioId, mesero_nombre: meseroNombre,
        estado: 'abierta', abierta_por: abiertaPor || meseroUsuarioId, abierta_at: ts(),
        cerrada_por: null, cerrada_at: null, comandas_emitidas: 0, reversos: 0,
        venta_folio: null, notas: null,
        items: [], pagos: [],
        // Marca de origen: la reconciliación distingue lo nacido sin enlace de
        // lo que solo se editó offline.
        origen: 'offline',
      };
      estado.cuentas.set(cuenta.id, cuenta);
      anotar('cuenta_abierta', cuenta.id, {
        mesa_numero: mesa, personas: pers, mesero_usuario_id: meseroUsuarioId,
        abierta_por: cuenta.abierta_por, abierta_at: cuenta.abierta_at,
      });
      return this.obtenerCuenta(cuenta.id);
    },

    // ── Comanda ────────────────────────────────────────────────────────────
    agregarItems(cuentaId, items) {
      const c = exigirAbierta(buscarCuenta(cuentaId));
      if (!Array.isArray(items) || !items.length) fallar('Sin items que agregar', 'SIN_ITEMS');
      const agregados = [];
      for (const it of items) {
        const cantidad = parseInt(it.cantidad, 10) || 1;
        if (cantidad < CANTIDAD_MIN || cantidad > CANTIDAD_MAX) fallar('Cantidad inválida', 'ITEM_INVALIDO');
        if (!it.producto || typeof it.producto !== 'string') fallar('Item sin producto', 'ITEM_INVALIDO');
        const precio = aCentavos(it.precio_unitario);
        if (precio === null || precio < 0) fallar('Precio inválido', 'ITEM_INVALIDO');
        const fila = {
          id: uuid(), producto: it.producto.trim(), cantidad,
          precio_unitario_centavos: precio,
          modificadores: Array.isArray(it.modificadores) ? it.modificadores : [],
          notas: it.notas || null, estado: 'pendiente', comanda_num: null,
          agregado_por: it.agregadoPor || c.mesero_usuario_id, created_at: ts(),
          cancelado_por: null, motivo_cancelacion: null, cancelado_at: null,
        };
        c.items.push(fila);
        agregados.push(fila);
      }
      anotar('items_agregados', c.id, { items: agregados.map((i) => ({ ...i })) });
      return agregados.map(exponerItem);
    },

    /**
     * Saca a cocina SOLO lo pendiente. Devuelve exactamente los items de ESTA
     * comanda: es el contrato de impresión (C8), y es lo que impide que un
     * segundo envío reimprima lo anterior.
     */
    enviarComanda(cuentaId) {
      const c = exigirAbierta(buscarCuenta(cuentaId));
      const pendientes = c.items.filter((i) => i.estado === 'pendiente');
      if (!pendientes.length) fallar('No hay items pendientes por enviar', 'SIN_ITEMS_PENDIENTES');
      const num = c.comandas_emitidas + 1;
      for (const i of pendientes) { i.estado = 'enviado'; i.comanda_num = num; }
      c.comandas_emitidas = num;
      anotar('comanda_enviada', c.id, { comanda_num: num, item_ids: pendientes.map((i) => i.id) });
      return {
        comanda: num,
        tipo: num === 1 ? 'inicial' : 'adicional',
        mesa: c.mesa_numero, personas: c.personas, mesero: c.mesero_nombre,
        items: pendientes.map(exponerItem),
      };
    },

    cancelarItem(cuentaId, itemId, { motivo, usuarioId = null } = {}) {
      const c = exigirAbierta(buscarCuenta(cuentaId));
      if (!motivo || !String(motivo).trim()) fallar('El motivo de cancelación es obligatorio', 'MOTIVO_REQUERIDO');
      const item = c.items.find((i) => i.id === itemId);
      if (!item || item.estado === 'cancelado') fallar('Item no encontrado o ya cancelado', 'ITEM_NO_CANCELABLE');
      item.estado = 'cancelado';
      item.cancelado_por = usuarioId;
      item.motivo_cancelacion = String(motivo).trim();
      item.cancelado_at = ts();
      anotar('item_cancelado', c.id, {
        item_id: item.id, motivo: item.motivo_cancelacion,
        cancelado_por: usuarioId, cancelado_at: item.cancelado_at,
        ya_enviado: item.comanda_num !== null,
      });
      return { ...exponerItem(item), yaEnviado: item.comanda_num !== null };
    },

    // ── Cobro ──────────────────────────────────────────────────────────────
    registrarPago(cuentaId, { metodo, monto, propina = 0, cubre = null, referencia = null, usuarioId = null }) {
      const c = exigirAbierta(buscarCuenta(cuentaId));
      if (!METODOS.has(metodo)) fallar('Forma de pago no válida', 'METODO_INVALIDO');
      const m = aCentavos(monto);
      if (m === null || m <= 0) fallar('El monto debe ser mayor a cero', 'MONTO_INVALIDO');
      const p = aCentavos(propina) ?? 0;
      if (p < 0) fallar('La propina no puede ser negativa', 'PROPINA_INVALIDA');
      // Sin conexión NO se llama a ningún proveedor: 'terminal' y 'enlace_pago'
      // registran un cobro que ya ocurrió por fuera (la terminal bancaria es
      // otro aparato y funciona sola). Cobrar de verdad exigiría red.
      const pago = {
        id: uuid(), metodo, monto_centavos: m, propina_centavos: p,
        cubre: cubre || null, referencia: referencia || null,
        registrado_por: usuarioId || c.mesero_usuario_id, created_at: ts(),
      };
      c.pagos.push(pago);
      anotar('pago_registrado', c.id, { ...pago });
      const t = totalesDe(c);
      return { ...exponerPago(pago), saldo: aPesos(t.saldo) };
    },

    /**
     * Cierra y produce la venta. El folio se deriva del UUID de la cuenta, así
     * que el ticket que se imprime sin internet lleva YA el folio definitivo:
     * al sincronizar no cambia de número. La cocina y el cliente nunca ven un
     * identificador que después signifique otra cosa.
     */
    cerrarCuenta(cuentaId, { usuarioId = null } = {}) {
      const c = buscarCuenta(cuentaId);
      if (c.estado === 'cerrada' && c.venta_folio) {
        return { ok: true, yaCerrada: true, ventaFolio: c.venta_folio };
      }
      exigirAbierta(c);
      const t = totalesDe(c);
      if (Math.abs(t.saldo) > TOLERANCIA_CENTAVOS) {
        fallar(`No se puede cerrar con saldo pendiente ($${aPesos(t.saldo).toFixed(2)})`, 'SALDO_PENDIENTE');
      }
      c.estado = 'cerrada';
      c.cerrada_por = usuarioId;
      c.cerrada_at = ts();
      c.venta_folio = folioDeVenta(c.id, c.reversos);
      anotar('cuenta_cerrada', c.id, {
        venta_folio: c.venta_folio, cerrada_por: usuarioId, cerrada_at: c.cerrada_at,
        total_centavos: t.total, propinas_centavos: t.propinas,
      });
      return {
        ok: true, ventaFolio: c.venta_folio,
        total: aPesos(t.total), propinas: aPesos(t.propinas),
        pagos: c.pagos.map(exponerPago),
      };
    },

    // ── Lectura ────────────────────────────────────────────────────────────
    obtenerCuenta(cuentaId) {
      const c = estado.cuentas.get(cuentaId);
      if (!c) return null;
      const t = totalesDe(c);
      return {
        id: c.id, mesa: c.mesa_numero, personas: c.personas, estado: c.estado,
        mesero: { id: c.mesero_usuario_id, nombre: c.mesero_nombre },
        abiertaAt: c.abierta_at, cerradaAt: c.cerrada_at,
        comandasEmitidas: c.comandas_emitidas, ventaFolio: c.venta_folio,
        total: aPesos(t.total), pagado: aPesos(t.pagado),
        propinas: aPesos(t.propinas), saldo: aPesos(t.saldo),
        items: c.items.map(exponerItem), pagos: c.pagos.map(exponerPago),
        origen: c.origen,
      };
    },

    listarMesasOcupadas() {
      return [...estado.cuentas.values()]
        .filter((c) => c.estado === 'abierta')
        .sort((a, b) => a.mesa_numero - b.mesa_numero)
        .map((c) => this.obtenerCuenta(c.id));
    },

    // ── Sincronización ─────────────────────────────────────────────────────
    /**
     * El lote que sube a la nube: los eventos pendientes MÁS el estado completo
     * de cada cuenta que tocaron. Va el estado y no solo los comandos porque
     * hace la reaplicación idempotente por sí sola: la nube hace upsert por
     * UUID y el resultado es el mismo se aplique una vez o cinco.
     */
    exportarLote({ limite = 500 } = {}) {
      const eventos = estado.outbox.slice(0, limite);
      const ids = [...new Set(eventos.map((e) => e.cuentaId))];
      const cuentas = ids.map((id) => estado.cuentas.get(id)).filter(Boolean).map(serializarCuenta);
      return { eventos, cuentas, generadoAt: ts() };
    },

    /** Solo se descartan los eventos que la nube confirmó, por id. */
    marcarLoteSincronizado(eventoIds) {
      const confirmados = new Set(eventoIds);
      const antes = estado.outbox.length;
      estado.outbox = estado.outbox.filter((e) => !confirmados.has(e.id));
      return antes - estado.outbox.length;
    },

    pendientesDeSincronizar() { return estado.outbox.length; },

    /** Para persistir en el almacén del Edge y sobrevivir a un reinicio. */
    serializar() {
      return { cuentas: [...estado.cuentas.values()].map(serializarCuenta), outbox: [...estado.outbox] };
    },
  };
}

// El dinero viaja en centavos dentro del módulo y en pesos hacia afuera: quien
// consume esto (pantalla, ticket, nube) trabaja en la misma unidad que la nube.
function exponerItem(i) {
  return {
    id: i.id, producto: i.producto, cantidad: i.cantidad,
    precio_unitario: aPesos(i.precio_unitario_centavos),
    modificadores: i.modificadores, notas: i.notas, estado: i.estado,
    comanda_num: i.comanda_num, motivo_cancelacion: i.motivo_cancelacion,
    created_at: i.created_at,
  };
}
function exponerPago(p) {
  return {
    id: p.id, metodo: p.metodo, monto: aPesos(p.monto_centavos),
    propina: aPesos(p.propina_centavos), cubre: p.cubre,
    referencia: p.referencia, created_at: p.created_at,
  };
}
function serializarCuenta(c) {
  return JSON.parse(JSON.stringify(c));
}
