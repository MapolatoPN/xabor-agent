// Log estructurado del Edge.
//
// Una línea por evento, con los identificadores que hacen falta para seguir
// un trabajo de punta a punta: job, impresora, terminal, intento, resultado.
//
// Lo que NUNCA sale por aquí: el token de la terminal, el contenido del
// payload (lleva nombres de clientes y notas), credenciales, URLs con
// secretos. Si algo de eso llegara a un log, viajaría a un archivo del
// equipo del restaurante y de ahí a cualquier parte.
const NIVELES = { debug: 10, info: 20, warn: 30, error: 40 };

const CLAVES_PROHIBIDAS = /^(token|terminalToken|password|secret|authorization|apiKey|databaseUrl|payload)$/i;

function sanear(datos) {
  const salida = {};
  for (const [k, v] of Object.entries(datos || {})) {
    if (CLAVES_PROHIBIDAS.test(k)) { salida[k] = '[oculto]'; continue; }
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') { salida[k] = '[objeto]'; continue; }
    const s = String(v);
    salida[k] = s.length > 200 ? `${s.slice(0, 200)}…` : s;
  }
  return salida;
}

export function crearLogger({ nivel = 'info', salida = console } = {}) {
  const minimo = NIVELES[nivel] ?? NIVELES.info;

  function emitir(nivelEvento, evento, datos) {
    if ((NIVELES[nivelEvento] ?? 0) < minimo) return;
    const campos = sanear(datos);
    const partes = Object.entries(campos).map(([k, v]) => `${k}=${v}`);
    const linea = `${new Date().toISOString()} [${nivelEvento.toUpperCase()}] ${evento}${partes.length ? ' ' + partes.join(' ') : ''}`;
    if (nivelEvento === 'error') salida.error(linea);
    else if (nivelEvento === 'warn') salida.warn(linea);
    else salida.log(linea);
  }

  return {
    debug: (evento, datos) => emitir('debug', evento, datos),
    info:  (evento, datos) => emitir('info', evento, datos),
    warn:  (evento, datos) => emitir('warn', evento, datos),
    error: (evento, datos) => emitir('error', evento, datos),
  };
}

export const loggerSilencioso = {
  debug() {}, info() {}, warn() {}, error() {},
};
