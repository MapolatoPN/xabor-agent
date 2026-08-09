// Almacén local en un archivo JSON, con escritura atómica.
//
// Es el respaldo cuando el runtime no trae `node:sqlite` (Node < 22.5). No
// necesita compilar nada, funciona en cualquier Windows y usa el mismo
// patrón que ya probó `print-agent.js`: escribir a un temporal y renombrar,
// que en el mismo volumen es atómico -- o queda el archivo viejo entero, o
// el nuevo entero, nunca uno a medias.
//
// Su límite honesto: reescribe el archivo completo en cada cambio. Con
// cientos de trabajos al día es irrelevante; con cientos de miles no lo
// sería, y ahí es donde SQLite gana. Por eso `auto` prefiere SQLite.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const VACIO = () => ({ version: 1, trabajos: {}, estado: {} });

export function crearAlmacenJson({ ruta, logger = null }) {
  mkdirSync(dirname(ruta), { recursive: true });
  let datos = VACIO();

  function cargar() {
    if (!existsSync(ruta)) return VACIO();
    try {
      const parsed = JSON.parse(readFileSync(ruta, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.trabajos || typeof parsed.trabajos !== 'object') {
        throw new Error('estructura inesperada');
      }
      return { version: 1, trabajos: parsed.trabajos, estado: parsed.estado || {} };
    } catch (e) {
      // Un archivo corrupto se respalda y se empieza vacío. Perder el
      // historial local NO reimprime nada por sí solo: la nube conserva el
      // estado de cada trabajo y solo reenvía lo que no está confirmado.
      // Se avisa aunque no haya logger inyectado: perder la cola local en
      // silencio es justo lo que no debe pasar desapercibido.
      const respaldo = `${ruta}.corrupto-${Date.now()}.bak`;
      try {
        copyFileSync(ruta, respaldo);
        console.error(`[Edge] cola local ilegible (${e.message}) -- respaldada en ${respaldo}, se arranca vacía`);
        logger?.error('almacen.corrupto', { motivo: e.message, respaldo });
      } catch (fallo) {
        console.error(`[Edge] cola local ilegible (${e.message}) y NO se pudo respaldar (${fallo.message}) -- se arranca vacía`);
      }
      return VACIO();
    }
  }

  function guardar() {
    const tmp = `${ruta}.tmp`;
    writeFileSync(tmp, JSON.stringify(datos), 'utf8');
    renameSync(tmp, ruta);
  }

  datos = cargar();

  return {
    tipo: 'json',

    // Devuelve false si el trabajo YA estaba registrado. Ese booleano es la
    // deduplicación de entrega: la nube puede reenviar el mismo job y aquí
    // no se crea un segundo.
    registrarTrabajo(trabajo) {
      if (datos.trabajos[trabajo.id]) return false;
      datos.trabajos[trabajo.id] = {
        ...trabajo,
        estado: 'pendiente',
        intentos: 0,
        ultimoError: null,
        proximoIntentoEn: 0,
        creadoEn: Date.now(),
        actualizadoEn: Date.now(),
      };
      guardar();
      return true;
    },

    obtener(id) { return datos.trabajos[id] || null; },

    // Trabajos listos para intentar ahora: pendientes o fallidos cuyo
    // próximo intento ya venció. Los 'agotado' e 'incierto' no vuelven
    // solos: necesitan una persona.
    pendientes(ahora = Date.now()) {
      return Object.values(datos.trabajos)
        .filter(t => (t.estado === 'pendiente' || t.estado === 'fallido') && (t.proximoIntentoEn || 0) <= ahora)
        .sort((a, b) => a.creadoEn - b.creadoEn);
    },

    actualizar(id, cambios) {
      const t = datos.trabajos[id];
      if (!t) return null;
      Object.assign(t, cambios, { actualizadoEn: Date.now() });
      guardar();
      return t;
    },

    todos() { return Object.values(datos.trabajos); },

    contarPorEstado() {
      const conteo = {};
      for (const t of Object.values(datos.trabajos)) conteo[t.estado] = (conteo[t.estado] || 0) + 1;
      return conteo;
    },

    // Limpia lo ya resuelto y viejo para que el archivo no crezca sin fin.
    // Nunca borra lo que sigue pendiente ni lo que necesita atención.
    purgar({ antesDe }) {
      let borrados = 0;
      for (const [id, t] of Object.entries(datos.trabajos)) {
        if ((t.estado === 'enviado' || t.estado === 'cancelado') && t.actualizadoEn < antesDe) {
          delete datos.trabajos[id]; borrados++;
        }
      }
      if (borrados) guardar();
      return borrados;
    },

    leerEstado(clave) { return datos.estado[clave] ?? null; },
    escribirEstado(clave, valor) { datos.estado[clave] = valor; guardar(); },

    cerrar() { /* nada que cerrar */ },
  };
}

export const rutaPorDefectoJson = (dir) => join(dir, 'edge-cola.json');
