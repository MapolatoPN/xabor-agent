// Bloqueo del directorio de datos: un solo proceso Edge por cola.
//
// El problema real: alguien deja abierta una ventana con el Edge y arranca
// otra, o el servicio de Windows se instala dos veces. Los dos procesos
// abrirían la MISMA cola y los dos sacarían los mismos trabajos -- cada
// comanda por duplicado, esta vez sin que el servidor pueda evitarlo (para la
// nube es la misma terminal y el mismo trabajo; lo que se duplica es el
// consumo local).
//
// La defensa es un archivo de bloqueo con el pid dentro, creado en modo
// exclusivo con `open(..., 'wx')`: falla si el archivo ya existe. Nada de
// primitivas de bloqueo propias de Unix, que en Windows no existen o se
// comportan distinto.
//
// Bloqueo obsoleto: si el proceso anterior murió sin limpiar, el archivo
// queda ahí. Antes de rendirse se comprueba si ese pid sigue vivo; si no lo
// está, se toma el relevo. Un Edge que no arranca porque se fue la luz sería
// peor que el problema que se quiere evitar.
import { openSync, closeSync, writeSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class BloqueoOcupado extends Error {
  constructor(pid, ruta) {
    super(`ya hay otro Xabor Edge usando esta carpeta de datos (pid ${pid}). ` +
          `Cierra el otro proceso, o usa XABOR_EDGE_DATOS para darle su propia carpeta.`);
    this.code = 'EDGE_YA_EN_EJECUCION';
    this.pid = pid;
    this.ruta = ruta;
  }
}

function procesoVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Señal 0: no manda nada, solo comprueba si el proceso existe y es
    // accesible. Funciona igual en Windows.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = existe pero es de otro usuario: sigue vivo.
    return e.code === 'EPERM';
  }
}

export function tomarBloqueo(rutaDatos, { logger } = {}) {
  mkdirSync(rutaDatos, { recursive: true });
  const ruta = join(rutaDatos, 'edge.lock');

  const escribir = () => {
    const fd = openSync(ruta, 'wx');            // falla si ya existe
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, desde: new Date().toISOString() }));
    } finally { closeSync(fd); }
  };

  try {
    escribir();
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;

    let dueno = null;
    try { dueno = JSON.parse(readFileSync(ruta, 'utf8')); } catch { /* ilegible: se trata como obsoleto */ }
    const pid = Number(dueno?.pid);

    // Se refusa aunque el pid sea el nuestro: abrir dos veces la misma cola
    // desde el mismo proceso es el mismo error, y `liberar()` borra el
    // archivo, así que un reinicio limpio nunca llega aquí.
    if (procesoVivo(pid)) throw new BloqueoOcupado(pid, ruta);

    logger?.warn('almacen.bloqueo.obsoleto', {
      pid: pid || 'desconocido',
      motivo: 'el proceso anterior no lo liberó (corte de luz o cierre brusco)',
    });
    try { unlinkSync(ruta); } catch {}
    escribir();
  }

  let liberado = false;
  return {
    ruta,
    liberar() {
      if (liberado) return;
      liberado = true;
      // Solo se borra si sigue siendo nuestro: si otro proceso tomó el relevo
      // tras considerarnos muertos, no hay que quitarle el suyo.
      try {
        const dueno = JSON.parse(readFileSync(ruta, 'utf8'));
        if (Number(dueno?.pid) === process.pid) unlinkSync(ruta);
      } catch { /* ya no está o es ilegible: nada que liberar */ }
    },
  };
}

export const rutaBloqueo = (dir) => join(dir, 'edge.lock');
export const hayBloqueo = (dir) => existsSync(rutaBloqueo(dir));
