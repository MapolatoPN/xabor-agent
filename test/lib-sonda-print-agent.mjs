// Sonda de PRUEBAS que test/fase-print-agent-payload.mjs carga en el proceso
// del SERVIDOR con NODE_OPTIONS=--import. Nada de src/ la importa: en
// producción no existe.
//
// 1. Espía de SQL. La consulta que busca una terminal para autenticarla (la
//    única con «AS terminal_activo», obtenerTerminalParaAutenticacion) deja
//    «[SONDA-SQL] autenticar-terminal» en la salida del servidor. Así la suite
//    demuestra que un frame rechazado no llegó a resolver terminal, sucursal ni
//    negocio.
// 2. Falla inyectada. Si console.warn o console.error reciben un texto con
//    MARCA_FALLA, LANZAN en vez de escribir. Así se provoca una excepción
//    DENTRO del manejador de mensajes del print-agent sin tocar el código de
//    producción: con el JSON validado, ningún mensaje real lanza ya, y es la
//    única forma de probar que el .catch de ese manejador sigue ahí. El error
//    que lanza no lleva la marca: el .catch puede registrarlo sin volver a
//    lanzar.
import { createRequire } from 'node:module';

export const MARCA_FALLA = '__falla_inyectada_ws__';

const require = createRequire(import.meta.url);
const pg = require('pg');
const consultaOriginal = pg.Client.prototype.query;
pg.Client.prototype.query = function consultaEspiada(config, ...resto) {
  const sql = typeof config === 'string' ? config : (config?.text ?? '');
  if (/AS\s+terminal_activo/.test(sql)) process.stdout.write('[SONDA-SQL] autenticar-terminal\n');
  return consultaOriginal.call(this, config, ...resto);
};

for (const nivel of ['warn', 'error']) {
  const original = console[nivel].bind(console);
  console[nivel] = (...args) => {
    if (args.some((a) => typeof a === 'string' && a.includes(MARCA_FALLA))) {
      throw new Error('falla inyectada por la sonda de pruebas');
    }
    return original(...args);
  };
}

process.stdout.write('[SONDA] cargada en el servidor\n');
