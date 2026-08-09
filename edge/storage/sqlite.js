// Almacén local en SQLite, usando `node:sqlite` (integrado en Node ≥ 22.5).
//
// Se eligió el SQLite del propio runtime en vez de `better-sqlite3` a
// propósito: `better-sqlite3` es una extensión nativa y hay que compilarla o
// bajar un binario por versión de Node y arquitectura. En la PC de un
// restaurante, con Node actualizándose solo o sin herramientas de compilación,
// eso es exactamente el tipo de dependencia que rompe una instalación un
// viernes por la noche. `node:sqlite` no instala nada.
//
// Si el runtime no lo trae, `storage/index.js` cae al almacén JSON y el Edge
// sigue funcionando igual: los dos cumplen el mismo contrato.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// `node:sqlite` se carga con createRequire y no con import() porque el
// almacén expone una API síncrona (el worker la usa dentro de bucles) y un
// import dinámico obligaría a await en el constructor.
const requerir = createRequire(import.meta.url);

export function sqliteDisponible() {
  try {
    const mod = requerir('node:sqlite');
    return typeof mod?.DatabaseSync === 'function';
  } catch { return false; }
}

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS trabajos (
  id                TEXT PRIMARY KEY,
  documento         TEXT NOT NULL,
  impresora_id      TEXT,
  impresora_nombre  TEXT,
  transporte        TEXT,
  host              TEXT,
  puerto            INTEGER,
  ancho_columnas    INTEGER,
  payload           TEXT NOT NULL,
  estado            TEXT NOT NULL DEFAULT 'pendiente',
  intentos          INTEGER NOT NULL DEFAULT 0,
  ultimo_error      TEXT,
  proximo_intento_en INTEGER NOT NULL DEFAULT 0,
  creado_en         INTEGER NOT NULL,
  actualizado_en    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trabajos_cola ON trabajos (estado, proximo_intento_en, creado_en);
CREATE TABLE IF NOT EXISTS estado_edge (clave TEXT PRIMARY KEY, valor TEXT);
`;

function aFila(t) {
  return {
    id: t.id,
    documento: t.documento,
    impresoraId: t.impresora_id,
    impresoraNombre: t.impresora_nombre,
    transporte: t.transporte,
    host: t.host,
    puerto: t.puerto,
    anchoColumnas: t.ancho_columnas,
    payload: JSON.parse(t.payload),
    estado: t.estado,
    intentos: t.intentos,
    ultimoError: t.ultimo_error,
    proximoIntentoEn: t.proximo_intento_en,
    creadoEn: t.creado_en,
    actualizadoEn: t.actualizado_en,
  };
}

export function crearAlmacenSqlite({ ruta }) {
  mkdirSync(dirname(ruta), { recursive: true });
  const { DatabaseSync } = requerir('node:sqlite');
  const db = new DatabaseSync(ruta);

  // WAL: si el proceso muere a media escritura, la base queda consistente al
  // reabrirla. Es justo el caso "kill -9 durante una comanda".
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec(ESQUEMA);

  const insertar = db.prepare(`
    INSERT OR IGNORE INTO trabajos
      (id, documento, impresora_id, impresora_nombre, transporte, host, puerto, ancho_columnas,
       payload, estado, intentos, proximo_intento_en, creado_en, actualizado_en)
    VALUES (?,?,?,?,?,?,?,?,?,'pendiente',0,0,?,?)`);
  const porId = db.prepare('SELECT * FROM trabajos WHERE id = ?');
  const listos = db.prepare(`
    SELECT * FROM trabajos
     WHERE estado IN ('pendiente','fallido') AND proximo_intento_en <= ?
     ORDER BY creado_en`);
  const todos = db.prepare('SELECT * FROM trabajos');
  const conteo = db.prepare('SELECT estado, count(*) AS n FROM trabajos GROUP BY estado');
  const borrarViejos = db.prepare(`DELETE FROM trabajos WHERE estado IN ('enviado','cancelado') AND actualizado_en < ?`);
  const leerEstado = db.prepare('SELECT valor FROM estado_edge WHERE clave = ?');
  const escribirEstado = db.prepare('INSERT INTO estado_edge (clave, valor) VALUES (?,?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor');

  let cerrado = false;
  // Tras cerrar, cualquier uso es un error del llamador, no una corrupción.
  // Se avisa con un error identificable en vez de dejar que node:sqlite lance
  // "statement has been finalized" desde dentro de un handler y tumbe el
  // proceso.
  const exigirAbierto = () => {
    if (cerrado) {
      const e = new Error('el almacén local ya está cerrado');
      e.code = 'ALMACEN_CERRADO';
      throw e;
    }
  };

  return {
    tipo: 'sqlite',
    get cerrado() { return cerrado; },

    registrarTrabajo(t) {
      exigirAbierto();
      const ahora = Date.now();
      // INSERT OR IGNORE + comprobar de verdad si se insertó: `changes` es
      // 0 cuando el id ya existía. Sin esta comprobación tendríamos el mismo
      // fallo que "ON CONFLICT DO NOTHING con éxito incondicional".
      const r = insertar.run(
        t.id, t.documento, t.impresoraId ?? null, t.impresoraNombre ?? null,
        t.transporte ?? null, t.host ?? null, t.puerto ?? null, t.anchoColumnas ?? null,
        JSON.stringify(t.payload), ahora, ahora
      );
      return r.changes === 1;
    },

    obtener(id) { exigirAbierto(); const f = porId.get(id); return f ? aFila(f) : null; },
    pendientes(ahora = Date.now()) { exigirAbierto(); return listos.all(ahora).map(aFila); },
    todos() { exigirAbierto(); return todos.all().map(aFila); },

    actualizar(id, cambios) {
      exigirAbierto();
      const mapa = {
        estado: 'estado', intentos: 'intentos', ultimoError: 'ultimo_error',
        proximoIntentoEn: 'proximo_intento_en',
      };
      const sets = []; const vals = [];
      for (const [k, col] of Object.entries(mapa)) {
        if (k in cambios) { sets.push(`${col} = ?`); vals.push(cambios[k]); }
      }
      if (!sets.length) return this.obtener(id);
      sets.push('actualizado_en = ?'); vals.push(Date.now(), id);
      db.prepare(`UPDATE trabajos SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      return this.obtener(id);
    },

    contarPorEstado() {
      const salida = {};
      for (const r of conteo.all()) salida[r.estado] = r.n;
      return salida;
    },

    purgar({ antesDe }) { return borrarViejos.run(antesDe).changes; },

    leerEstado(clave) { const r = leerEstado.get(clave); return r ? r.valor : null; },
    escribirEstado(clave, valor) { escribirEstado.run(clave, String(valor)); },

    cerrar() { cerrado = true; try { db.close(); } catch {} },
  };
}

export const rutaPorDefectoSqlite = (dir) => join(dir, 'edge-cola.sqlite');
