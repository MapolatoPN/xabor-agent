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
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { crearAlmacenSqlite, sqliteDisponible, rutaPorDefectoSqlite } from './sqlite.js';
import { crearAlmacenJson, rutaPorDefectoJson } from './jsonFile.js';
import { tomarBloqueo } from './bloqueo.js';

// ─── Cola de un Edge anterior con Node < 22.5 ───────────────────────────────
//
// Un Edge que corría en un Node sin `node:sqlite` guardaba su cola en
// edge-cola.json. Al actualizarlo a un Node que sí lo trae, `auto` abre
// edge-cola.sqlite vacía, y lo que estaba esperando en la PC (una comanda
// sin papel, un ticket en reintento) se quedaba en el JSON sin imprimirse.
// Aquí se pasa a SQLite lo que no terminó (con su estado, para que «incierto»
// y «agotado» sigan pidiendo a una persona) y la identidad de la
// instalación, y el JSON se renombra: no se vuelve a migrar ni se borra.
// Nunca impide arrancar: si algo falla, se registra y el Edge sigue.
const SIN_TERMINAR = new Set(['pendiente', 'fallido', 'incierto', 'agotado']);

export function migrarColaJson(sqlite, rutaJson, logger = null) {
  if (!existsSync(rutaJson)) return { migrados: 0 };
  let datos;
  try { datos = JSON.parse(readFileSync(rutaJson, 'utf8')); }
  catch (e) {
    // Ilegible: se deja donde está para que alguien lo revise.
    logger?.error('almacen.migracion.ilegible', { ruta: rutaJson, motivo: e.message });
    return { migrados: 0, error: e.message };
  }
  let migrados = 0;
  for (const t of Object.values(datos?.trabajos || {})) {
    if (!t || typeof t.id !== 'string' || !SIN_TERMINAR.has(t.estado)) continue;
    if (sqlite.registrarTrabajo(t)) {
      sqlite.actualizar(t.id, { estado: t.estado, intentos: Number(t.intentos) || 0, ultimoError: t.ultimoError ?? null, proximoIntentoEn: 0 });
      migrados++;
    }
  }
  for (const [clave, valor] of Object.entries(datos?.estado || {})) {
    if (sqlite.leerEstado(clave) == null && valor != null) sqlite.escribirEstado(clave, valor);
  }
  const destino = `${rutaJson}.migrado-${Date.now()}`;
  renameSync(rutaJson, destino);
  logger?.info('almacen.migrado', { desde: 'json', trabajos: migrados, respaldo: destino });
  return { migrados, respaldo: destino };
}

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
      try { migrarColaJson(base, rutaPorDefectoJson(rutaDatos), logger); }
      catch (e) { logger?.error('almacen.migracion.fallo', { motivo: e.message }); }
    } else {
      const ruta = rutaPorDefectoJson(rutaDatos);
      logger?.info('almacen.abierto', { tipo: 'json', ruta, motivo: almacen === 'auto' ? 'node:sqlite no disponible' : 'configurado' });
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
