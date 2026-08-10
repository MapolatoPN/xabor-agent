// Journal de operaciones locales del restaurante.
//
// ─── POR QUE UN JOURNAL Y NO "GUARDAR EL ESTADO" ────────────────────────────
//
// Si el Edge guardara solo el estado final ("mesa 4 tiene estos 6 platillos"),
// al reconectar tendria que elegir entre pisar la nube con su version o dejar
// que la nube pise la suya. Las dos opciones pierden trabajo real.
//
// Guardando las OPERACIONES ("se agrego 1 chilaquiles a la cuenta X a las
// 21:04 desde la tablet 2") la reconciliacion deja de ser una eleccion: dos
// meseros que agregaron platillos a la misma mesa produjeron dos operaciones
// aditivas y las dos valen. Solo lo que de verdad choca -- dos cierres de la
// misma cuenta -- queda como conflicto.
//
// ─── IDENTIDAD ──────────────────────────────────────────────────────────────
//
// Cada operacion nace con un operation_id UUIDv4. No un folio: el folio es un
// contador global y dos tablets sin red generarian el mismo numero para
// pedidos distintos. Eso ya paso una vez en el POS y costo un hotfix.
//
// Se eligio UUIDv4 sobre ULID/UUIDv7 por una razon concreta: v7 y ULID
// codifican el reloj local en el propio id, y aqui el reloj local es
// justamente lo que no es de fiar (una tablet puede tener la hora mal). El
// orden se reconstruye con (dispositivo_id, secuencia), que es monotona por
// dispositivo y no depende de ningun reloj. El id solo tiene que ser unico,
// y v4 lo es sin arrastrar una mentira temporal.
//
// ─── DURABILIDAD ────────────────────────────────────────────────────────────
//
// Reutiliza el almacen del Edge de impresion (SQLite WAL con
// synchronous=FULL, o JSON atomico como respaldo) en vez de inventar otro.
// Ese ya sobrevivio al chaos de 500 rondas.
import { randomUUID } from 'node:crypto';

// Los tipos son un contrato con la nube: si el Edge inventa uno, la nube lo
// rechaza. Mejor fallar aqui, con la operacion todavia en la mano.
export const TIPOS = Object.freeze({
  CUENTA_ABIERTA: 'CUENTA_ABIERTA',
  ITEM_AGREGADO: 'ITEM_AGREGADO',
  ITEM_QUITADO: 'ITEM_QUITADO',
  RONDA_ENVIADA: 'RONDA_ENVIADA',
  MESA_MOVIDA: 'MESA_MOVIDA',
  PAGO_REGISTRADO: 'PAGO_REGISTRADO',
  CUENTA_CERRADA: 'CUENTA_CERRADA',
});

const VERSION_PAYLOAD = 1;
const CLAVE_SECUENCIA = 'journal_secuencia';
const CLAVE_DISPOSITIVO = 'journal_dispositivo_id';
const CLAVE_GENERACION = 'journal_generacion';

/**
 * @param almacen  el almacen durable del Edge (edge/storage)
 * @param negocioId / sucursalId  contexto del Edge, NUNCA del cliente
 */
export function crearJournal({ almacen, negocioId, sucursalId = null, logger = null }) {
  if (!almacen) throw new Error('crearJournal requiere un almacen durable');
  if (!negocioId) throw new Error('crearJournal requiere negocioId');

  // El id del dispositivo y la generacion viven DENTRO del almacen. Si
  // alguien borra la carpeta de datos, desaparecen con ella -- que es
  // exactamente lo que queremos: la nube detecta la generacion nueva y sabe
  // que este Edge perdio la memoria, en vez de dejarlo resincronizar a ciegas
  // y duplicar el turno.
  let dispositivoId = almacen.leerEstado(CLAVE_DISPOSITIVO);
  if (!dispositivoId) {
    dispositivoId = `dev-${randomUUID()}`;
    almacen.escribirEstado(CLAVE_DISPOSITIVO, dispositivoId);
  }
  let generacion = almacen.leerEstado(CLAVE_GENERACION);
  if (!generacion) {
    generacion = randomUUID();
    almacen.escribirEstado(CLAVE_GENERACION, generacion);
  }

  // La secuencia se persiste ANTES de usarse. Si el proceso muere entre
  // reservar y escribir la operacion, se pierde un numero de la serie -- eso
  // es inocuo. Lo que no puede pasar es reutilizar uno.
  let secuencia = Number(almacen.leerEstado(CLAVE_SECUENCIA) || 0);

  const operaciones = new Map();  // memoria: proyeccion del journal persistido
  const orden = [];

  // El almacen de impresion guarda "trabajos"; aqui se guardan operaciones
  // como trabajos de un tipo reservado. Reutilizar su durabilidad ya probada
  // vale mas que un formato propio mas bonito.
  function cargarDeDisco() {
    for (const t of almacen.todos()) {
      if (!t?.payload || t.payload.__journal !== true) continue;
      const op = t.payload.operacion;
      operaciones.set(op.operationId, { ...op, estadoSync: t.estado });
      orden.push(op.operationId);
      if (op.secuencia > secuencia) secuencia = op.secuencia;
    }
    orden.sort((a, b) => operaciones.get(a).secuencia - operaciones.get(b).secuencia);
  }
  cargarDeDisco();

  function registrar(tipo, payload = {}) {
    if (!TIPOS[tipo]) throw new Error(`tipo de operacion desconocido: ${tipo}`);

    secuencia += 1;
    almacen.escribirEstado(CLAVE_SECUENCIA, secuencia);

    const operacion = {
      operationId: randomUUID(),
      dispositivoId,
      generacion,
      negocioId,
      sucursalId,
      secuencia,
      tipo,
      version: VERSION_PAYLOAD,
      payload,
      // Se guarda el reloj local como DATO, no como criterio de orden.
      creadaEnLocal: new Date().toISOString(),
    };

    // Persistir primero. Si el proceso muere justo despues de esta linea, al
    // reiniciar la operacion sigue ahi y se sincronizara; si muere justo
    // antes, nunca existio y el mesero la volvera a capturar. Lo que no
    // ocurre es que el mesero la vea confirmada y luego desaparezca.
    // Se guarda como un "trabajo" de tipo journal: el almacen del Edge de
    // impresion ya resuelve durabilidad, recuperacion tras crash y lock de
    // proceso, y esos tres problemas son identicos aqui. `documento` es
    // obligatorio en su esquema y sirve de discriminante.
    almacen.registrarTrabajo({
      id: operacion.operationId,
      documento: 'journal',
      payload: { __journal: true, operacion },
    });

    operaciones.set(operacion.operationId, { ...operacion, estadoSync: 'pendiente' });
    orden.push(operacion.operationId);
    logger?.info?.('journal.operacion', { tipo, operationId: operacion.operationId, secuencia });
    return operacion;
  }

  return {
    dispositivoId,
    generacion,
    get secuencia() { return secuencia; },

    registrar,
    abrirCuenta: (p) => registrar('CUENTA_ABIERTA', p),
    agregarItem: (p) => registrar('ITEM_AGREGADO', p),
    quitarItem: (p) => registrar('ITEM_QUITADO', p),
    enviarRonda: (p) => registrar('RONDA_ENVIADA', p),
    moverMesa: (p) => registrar('MESA_MOVIDA', p),
    registrarPago: (p) => registrar('PAGO_REGISTRADO', p),
    cerrarCuenta: (p) => registrar('CUENTA_CERRADA', p),

    /** Todo el journal, en orden de secuencia. Es la fuente de verdad. */
    todas() { return orden.map(id => operaciones.get(id)); },

    /** Lo que falta por confirmar en la nube. */
    pendientes() {
      return orden.map(id => operaciones.get(id))
                  .filter(o => o.estadoSync === 'pendiente' || o.estadoSync === 'fallido');
    },

    /**
     * Aplica el veredicto de la nube. 'duplicada' cuenta como sincronizada:
     * significa que la nube ya la tenia, que es justo lo que queriamos.
     */
    marcarSincronizada(operationId, resultado) {
      const op = operaciones.get(operationId);
      if (!op) return false;
      const estado = (resultado === 'aceptada' || resultado === 'duplicada') ? 'enviado'
                   : resultado === 'conflicto' ? 'incierto'
                   : 'fallido';
      op.estadoSync = estado;
      almacen.actualizar(operationId, { estado });
      return true;
    },

    /**
     * Reconstruye el estado de las mesas leyendo el journal entero.
     *
     * Existe para poder tirar la proyeccion y rehacerla: si un crash deja la
     * proyeccion a medias, no hay que adivinar cual de las dos era la buena
     * -- el journal manda y la proyeccion se regenera.
     */
    proyectar() {
      const cuentas = new Map();
      for (const id of orden) {
        const op = operaciones.get(id);
        const cid = op.payload?.cuentaId;
        switch (op.tipo) {
          case 'CUENTA_ABIERTA':
            cuentas.set(cid, { cuentaId: cid, mesa: op.payload.mesa, mesero: op.payload.mesero,
                               personas: op.payload.personas, items: [], rondas: 0,
                               pagos: [], estado: 'abierta' });
            break;
          case 'ITEM_AGREGADO': {
            const c = cuentas.get(cid); if (!c) break;
            c.items.push({ itemId: op.payload.itemId, producto: op.payload.producto,
                           cantidad: op.payload.cantidad, modificadores: op.payload.modificadores || [],
                           notas: op.payload.notas || null, ronda: op.payload.ronda ?? null });
            break;
          }
          case 'ITEM_QUITADO': {
            // Tombstone, no borrado: se marca. Un borrado fisico no se puede
            // reconciliar con lo que otro dispositivo hizo sobre ese item.
            const c = cuentas.get(cid); if (!c) break;
            const it = c.items.find(i => i.itemId === op.payload.itemId);
            if (it) { it.quitado = true; it.quitadoPor = op.dispositivoId; }
            break;
          }
          case 'RONDA_ENVIADA': {
            const c = cuentas.get(cid); if (!c) break;
            c.rondas = Math.max(c.rondas, op.payload.ronda ?? c.rondas + 1);
            break;
          }
          case 'MESA_MOVIDA': {
            const c = cuentas.get(cid); if (!c) break;
            c.mesa = op.payload.mesaDestino;
            break;
          }
          case 'PAGO_REGISTRADO': {
            const c = cuentas.get(cid); if (!c) break;
            c.pagos.push({ metodo: op.payload.metodo, monto: op.payload.monto });
            break;
          }
          case 'CUENTA_CERRADA': {
            const c = cuentas.get(cid); if (!c) break;
            c.estado = 'cerrada';
            break;
          }
        }
      }
      return cuentas;
    },

    resumen() {
      const porEstado = {};
      for (const op of operaciones.values()) {
        porEstado[op.estadoSync] = (porEstado[op.estadoSync] || 0) + 1;
      }
      return { total: operaciones.size, dispositivoId, generacion, secuencia, porEstado };
    },
  };
}
