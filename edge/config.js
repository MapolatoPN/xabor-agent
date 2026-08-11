// Configuración de Xabor Edge.
//
// Todo por variables de entorno o por un archivo .env junto al ejecutable.
// Nada hardcodeado: ni la URL de la nube, ni el id de la terminal, ni el
// token, ni el puerto de ninguna impresora. Un Edge sin configurar no
// arranca a medias -- se niega a arrancar y dice qué le falta.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));

// .env propio del Edge, opcional. Formato CLAVE=valor, una por línea.
// No se usa dotenv para no arrastrar una dependencia al equipo del cliente.
function cargarEnvLocal(ruta) {
  if (!existsSync(ruta)) return {};
  const salida = {};
  for (const linea of readFileSync(ruta, 'utf8').split(/\r?\n/)) {
    const limpia = linea.trim();
    if (!limpia || limpia.startsWith('#')) continue;
    const i = limpia.indexOf('=');
    if (i < 1) continue;
    const clave = limpia.slice(0, i).trim();
    let valor = limpia.slice(i + 1).trim();
    if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
      valor = valor.slice(1, -1);
    }
    salida[clave] = valor;
  }
  return salida;
}

function entero(valor, porDefecto) {
  const n = parseInt(valor, 10);
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
}

// Configuración escrita por el instalador de Windows, en ProgramData.
//
// Cuando el agente corre como servicio, sus credenciales NO pueden estar en
// un .env junto a los binarios ni en las variables del servicio: lo primero
// es legible por cualquiera que abra la carpeta de instalación y lo segundo
// deja el token a la vista en la línea de comandos del proceso. Van en un
// JSON aparte con ACL restringida a SYSTEM y administradores.
//
// Solo se mira si XABOR_EDGE_PROGRAMDATA está definida, que es algo que hace
// el servicio y nadie más. Ejecutar `node edge/index.js` a mano sigue
// funcionando exactamente igual que hasta hoy.
function cargarConfigInstalada(env) {
  const base = env.XABOR_EDGE_PROGRAMDATA;
  if (!base) return {};
  const ruta = join(base, 'config', 'config.json');
  if (!existsSync(ruta)) return {};
  try {
    const j = JSON.parse(readFileSync(ruta, 'utf8'));
    const salida = {};
    // Se traduce a las mismas claves que usa el resto: una sola forma de leer
    // la configuración, venga de donde venga.
    if (j.terminalId)    salida.XABOR_TERMINAL_ID = j.terminalId;
    if (j.terminalToken) salida.XABOR_TERMINAL_TOKEN = j.terminalToken;
    if (j.urlNube)       salida.XABOR_EDGE_WS_URL = j.urlNube;
    // La cola y los datos también viven en ProgramData: sobreviven a una
    // reinstalación, que es justo lo que hace falta si dentro hay comandas
    // sin imprimir.
    salida.XABOR_EDGE_DATOS = join(base, 'data');
    return salida;
  } catch {
    // Config ilegible: se ignora y el agente se negará a arrancar por falta
    // de credenciales, diciendo qué le falta. Mejor eso que arrancar a medias.
    return {};
  }
}

export function cargarConfig({ env = process.env, rutaEnv = join(AQUI, '.env') } = {}) {
  const archivo = cargarEnvLocal(rutaEnv);
  const instalada = cargarConfigInstalada(env);
  // Precedencia: entorno explícito > .env local > config del instalador. Así
  // se puede depurar en sitio sobrescribiendo una variable sin tocar el JSON.
  const leer = (clave, porDefecto = '') => (env[clave] ?? archivo[clave] ?? instalada[clave] ?? porDefecto);

  const config = {
    // Conexión con la nube. Siempre SALIENTE: el Edge llama, nadie lo llama.
    urlNube:       leer('XABOR_EDGE_WS_URL'),
    terminalId:    leer('XABOR_TERMINAL_ID'),
    terminalToken: leer('XABOR_TERMINAL_TOKEN'),

    // Almacén local. 'auto' usa node:sqlite si el runtime lo trae y cae a
    // JSON durable si no -- ver storage/index.js.
    almacen:       leer('XABOR_EDGE_ALMACEN', 'auto'),
    rutaDatos:     leer('XABOR_EDGE_DATOS', join(AQUI, 'datos')),

    // Reintentos. Backoff exponencial con tope: nunca martillear una
    // impresora apagada, nunca rendirse en silencio.
    reintentoBaseMs:   entero(leer('XABOR_EDGE_REINTENTO_MS'), 3000),
    reintentoMaximoMs: entero(leer('XABOR_EDGE_REINTENTO_MAX_MS'), 300000), // 5 min
    maxIntentos:       entero(leer('XABOR_EDGE_MAX_INTENTOS'), 8),

    // Ritmo del worker y de la reconexión.
    intervaloColaMs:      entero(leer('XABOR_EDGE_INTERVALO_MS'), 1000),
    reconexionBaseMs:     entero(leer('XABOR_EDGE_RECONEXION_MS'), 2000),
    reconexionMaximaMs:   entero(leer('XABOR_EDGE_RECONEXION_MAX_MS'), 60000),
    heartbeatMs:          entero(leer('XABOR_EDGE_HEARTBEAT_MS'), 25000),

    // Timeout de la conexión TCP a una impresora. Sin valor por defecto
    // heroico: una impresora térmica que no responde en 10 s está apagada.
    timeoutImpresoraMs:   entero(leer('XABOR_EDGE_TIMEOUT_IMPRESORA_MS'), 10000),

    nivelLog: leer('XABOR_EDGE_LOG', 'info'),
  };

  return config;
}

// Un Edge mal configurado tiene que fallar al arrancar, con un mensaje que
// diga exactamente qué falta. Fallar más tarde -- cuando ya hay comandas
// esperando -- es mucho peor.
export function validarConfig(config) {
  const faltan = [];
  if (!config.urlNube) faltan.push('XABOR_EDGE_WS_URL');
  if (!config.terminalId) faltan.push('XABOR_TERMINAL_ID');
  if (!config.terminalToken) faltan.push('XABOR_TERMINAL_TOKEN');

  const errores = faltan.length
    ? [`faltan variables obligatorias: ${faltan.join(', ')}`]
    : [];

  if (config.urlNube && !/^wss?:\/\//i.test(config.urlNube)) {
    errores.push(`XABOR_EDGE_WS_URL debe empezar por ws:// o wss:// (recibido: ${config.urlNube.slice(0, 40)})`);
  }
  if (config.reintentoMaximoMs < config.reintentoBaseMs) {
    errores.push('XABOR_EDGE_REINTENTO_MAX_MS no puede ser menor que XABOR_EDGE_REINTENTO_MS');
  }
  return { valida: errores.length === 0, errores };
}

// Backoff exponencial con jitter. El jitter existe para que cuatro
// impresoras que se cayeron a la vez (se fue la luz del área de cocina) no
// reintenten todas en el mismo milisegundo al volver.
export function calcularEspera(intento, { baseMs, maximoMs }) {
  const exponencial = Math.min(baseMs * Math.pow(2, Math.max(0, intento - 1)), maximoMs);
  const jitter = Math.random() * exponencial * 0.2;
  return Math.round(Math.min(exponencial + jitter, maximoMs));
}
