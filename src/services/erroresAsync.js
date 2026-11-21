// ─── Un error en una ruta ya no apaga el servidor (Fase 1, bloque 1.2) ──────
//
// Express 4 no recoge el rechazo de una ruta `async`: la promesa queda sin
// manejar y Node 22 termina el proceso, para TODOS los negocios a la vez
// (railway.toml reintenta 3 veces y luego deja el servicio abajo). Bastaba un
// id que no es número en una ruta del menú, o un nombre de más de 100
// caracteres.
//
// La red tiene tres piezas:
//   1. capturarErroresAsync(): en Layer (la pieza por la que pasa TODA ruta y
//      middleware de Express 4, de la app y de cada Router), si el handler
//      devuelve una promesa que se rechaza, el error va a next(err), como ya
//      pasaba con los errores síncronos.
//   2. manejadorErroresFinal: responde 500 sin detalles internos (ni el
//      mensaje de Postgres, ni la pila) y lo anota en el log. Los 4xx de
//      body-parser (JSON mal formado, cuerpo demasiado grande) conservan su
//      estado.
//   3. vigilarRechazosSinManejar(): una promesa rechazada fuera de una
//      petición (un job, un temporizador) se anota y el servidor sigue.
//      La línea dice «unhandledRejection» a propósito: las suites del Edge
//      buscan esa palabra en la salida para detectar rechazos sin manejar.
//
// Lo que NO cambia: una excepción síncrona fuera de una petición
// (uncaughtException) sigue terminando el proceso; ahí el estado en memoria
// puede quedar a medias y reiniciar es lo seguro.
import Layer from 'express/lib/router/layer.js';

const MARCA = Symbol.for('xabor.erroresAsync');

export function capturarErroresAsync(LayerClase = Layer) {
  const proto = LayerClase.prototype;
  if (proto[MARCA]) return false;

  const handleRequest = proto.handle_request;
  const handleError = proto.handle_error;
  if (typeof handleRequest !== 'function' || typeof handleError !== 'function') {
    throw new Error('capturarErroresAsync: esta versión de Express no tiene Layer.handle_request/handle_error');
  }

  proto.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next();
    let resultado;
    try {
      resultado = fn(req, res, next);
    } catch (err) {
      return next(err);
    }
    if (resultado && typeof resultado.then === 'function') {
      resultado.then(undefined, (err) => next(err ?? new Error('Ruta rechazada sin motivo')));
    }
  };

  proto.handle_error = function handleErr(error, req, res, next) {
    const fn = this.handle;
    if (fn.length !== 4) return next(error);
    let resultado;
    try {
      resultado = fn(error, req, res, next);
    } catch (err) {
      return next(err);
    }
    if (resultado && typeof resultado.then === 'function') {
      resultado.then(undefined, (err) => next(err ?? error));
    }
  };

  proto[MARCA] = true;
  return true;
}

export function erroresAsyncInstalados(LayerClase = Layer) {
  return LayerClase.prototype[MARCA] === true;
}

// Los errores de body-parser traen `type` y un status 4xx: el cliente mandó
// algo mal (JSON roto, cuerpo enorme). Se respeta el estado; el texto es fijo.
function esErrorDelCliente(err) {
  const status = Number(err?.status ?? err?.statusCode);
  return Number.isInteger(status) && status >= 400 && status < 500 && (err?.expose === true || typeof err?.type === 'string');
}

// eslint-disable-next-line no-unused-vars
export function manejadorErroresFinal(err, req, res, next) {
  const ruta = `${req.method} ${req.originalUrl?.split('?')[0] ?? req.path}`;
  if (esErrorDelCliente(err)) {
    const status = Number(err.status ?? err.statusCode);
    if (res.headersSent) return next(err);
    return res.status(status).json({ error: 'La petición no es válida', code: 'PETICION_INVALIDA' });
  }
  console.error(`[Error] ${ruta} -> 500: ${err?.message ?? err}`);
  if (res.headersSent) {
    // Ya salió parte de la respuesta: Express corta la conexión.
    return next(err);
  }
  return res.status(500).json({ error: 'Ocurrió un error. Inténtalo de nuevo.', code: 'ERROR_INTERNO' });
}

let vigilando = false;
export function vigilarRechazosSinManejar(proc = process) {
  if (vigilando) return false;
  vigilando = true;
  proc.on('unhandledRejection', (motivo) => {
    const texto = motivo instanceof Error ? (motivo.stack || motivo.message) : String(motivo);
    console.error(`[Proceso] unhandledRejection (el servidor sigue): ${texto}`);
  });
  return true;
}
