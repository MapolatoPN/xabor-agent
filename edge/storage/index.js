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

export function crearAlmacen({ almacen = 'auto', rutaDatos, logger } = {}) {
  const quiereSqlite = almacen === 'sqlite' || (almacen === 'auto' && sqliteDisponible());

  if (quiereSqlite) {
    if (!sqliteDisponible()) {
      throw new Error('XABOR_EDGE_ALMACEN=sqlite pero este Node no trae node:sqlite (hace falta Node 22.5 o superior)');
    }
    const ruta = rutaPorDefectoSqlite(rutaDatos);
    logger?.info('almacen.abierto', { tipo: 'sqlite', ruta });
    return crearAlmacenSqlite({ ruta });
  }

  const ruta = rutaPorDefectoJson(rutaDatos);
  logger?.info('almacen.abierto', { tipo: 'json', ruta, motivo: almacen === 'auto' ? 'node:sqlite no disponible' : 'configurado' });
  return crearAlmacenJson({ ruta });
}
