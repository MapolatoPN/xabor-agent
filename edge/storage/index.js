// Selección del almacén local.
//
// Los dos cumplen el mismo contrato, así que el resto del Edge no sabe cuál
// está usando y las pruebas corren contra ambos:
//
//   registrarTrabajo(t) -> boolean   (false = ya estaba: entrega duplicada)
//   obtener(id)         -> trabajo | null
//   pendientes(ahora)   -> trabajo[]  (listos para intentar, más viejo primero)
//   actualizar(id, cambios)
//   todos() / contarPorEstado() / purgar({antesDe})
//   leerEstado(clave) / escribirEstado(clave, valor)
//   cerrar()
import { crearAlmacenSqlite, sqliteDisponible, rutaPorDefectoSqlite } from './sqlite.js';
import { crearAlmacenJson, rutaPorDefectoJson } from './jsonFile.js';
import { tomarBloqueo } from './bloqueo.js';

// `bloquear: false` solo para pruebas que abren varios almacenes a la vez
// sobre carpetas distintas y no necesitan la exclusión.
export function crearAlmacen({ almacen = 'auto', rutaDatos, logger, bloquear = true } = {}) {
  // El bloqueo va PRIMERO: si hay otro Edge usando esta carpeta hay que
  // fallar antes de tocar la cola, no después de haberla abierto.
  const bloqueo = bloquear ? tomarBloqueo(rutaDatos, { logger }) : null;

  let base;
  try {
    const quiereSqlite = almacen === 'sqlite' || (almacen === 'auto' && sqliteDisponible());
    if (quiereSqlite) {
      if (!sqliteDisponible()) {
        throw new Error('XABOR_EDGE_ALMACEN=sqlite pero este Node no trae node:sqlite (hace falta Node 22.5 o superior)');
      }
      const ruta = rutaPorDefectoSqlite(rutaDatos);
      logger?.info('almacen.abierto', { tipo: 'sqlite', ruta });
      base = crearAlmacenSqlite({ ruta });
    } else {
      // 'auto' + sin node:sqlite significa que este Node no llega a 22.5. El
      // respaldo JSON existe y funciona, pero NO da las mismas garantias que
      // SQLite en WAL con synchronous=FULL, y caer a el sin decir nada es la
      // peor version del problema: el Edge arranca "bien", nadie se entera, y
      // la diferencia solo se descubre el dia que hay un corte de luz a mitad
      // de un turno.
      //
      // Si alguien quiere JSON, que lo pida explicitamente.
      if (almacen === 'auto') {
        const e = new Error(
          `Este Node (${process.version}) no trae node:sqlite, que necesita Node 22.5 o superior.
` +
          `  Xabor Edge no arranca con una cola de menor garantia sin que alguien lo decida.
` +
          `  Opciones:
` +
          `    1. Instalar Node 22.5+ en este equipo (recomendado).
` +
          `    2. Aceptar el respaldo JSON a proposito: XABOR_EDGE_ALMACEN=json`);
        e.code = 'EDGE_NODE_INCOMPATIBLE';
        throw e;
      }
      const ruta = rutaPorDefectoJson(rutaDatos);
      logger?.info('almacen.abierto', { tipo: 'json', ruta, motivo: 'configurado explicitamente' });
      base = crearAlmacenJson({ ruta, logger });
    }
  } catch (e) {
    bloqueo?.liberar();
    throw e;
  }

  // Se envuelve `cerrar` para que liberar el bloqueo no dependa de que quien
  // llama se acuerde: cerrar el almacén y soltar la carpeta son la misma cosa.
  const cerrarBase = base.cerrar.bind(base);
  base.cerrar = () => { try { cerrarBase(); } finally { bloqueo?.liberar(); } };
  return base;
}

export { BloqueoOcupado } from './bloqueo.js';
