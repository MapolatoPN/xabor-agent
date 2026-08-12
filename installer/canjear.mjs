// Canje del código de emparejamiento, durante la instalación.
//
// Lo ejecuta el instalador con el runtime privado de Node, justo después de
// que la persona escribe el código de seis caracteres que le dio Xabor. Si
// esto sale bien, el equipo queda vinculado y el servicio puede arrancar. Si
// sale mal, el instalador aborta -- nunca se queda un servicio instalado
// apuntando a ninguna parte.
//
// El código de emparejamiento NO se guarda. Es de un solo uso y de vida
// corta; una vez canjeado no sirve para nada y conservarlo solo sería una
// credencial más tirada en un disco.
//
// Uso:  node canjear.mjs --codigo ABC123 [--nombre "Caja principal"]
//                        [--url https://xabor.mx]
//
// Salida por stdout: una línea por resultado, pensada para que el instalador
// la muestre tal cual. NUNCA incluye el token.
//
// Códigos de salida -- el instalador los distingue para dar un mensaje útil:
//   0  vinculado
//   2  código inválido o vencido
//   3  no hay conexión con Xabor
//   4  no se pudo escribir la configuración (permisos)
//   5  uso incorrecto
//   6  ya hay configuración, pero está protegida y no se puede leer sin
//      elevación. NO se canjea nada: gastar un código de un solo uso por un
//      problema de permisos sería el peor de los desenlaces.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';

const PROGRAMDATA = process.env.XABOR_EDGE_PROGRAMDATA
  || join(process.env.ProgramData || 'C:\\ProgramData', 'Xabor', 'Edge');
const DIR_CONFIG = join(PROGRAMDATA, 'config');
const RUTA_CONFIG = join(DIR_CONFIG, 'config.json');

function argumento(nombre) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function salir(codigo, mensaje) {
  console.log(mensaje);
  process.exit(codigo);
}

const codigo = (argumento('codigo') || '').trim().toUpperCase();
const nombreEquipo = (argumento('nombre') || hostname() || 'Caja').trim().slice(0, 80);
const urlBase = (argumento('url') || 'https://xabor.mx').replace(/\/+$/, '');
const forzar = process.argv.includes('--forzar');

if (codigo.length > 64) salir(5, 'El codigo de conexion no es valido.');

// El origen de una URL, sin importar si vino como http(s) o ws(s): ambas
// formas nombran al MISMO Xabor. Sirve para comparar la config existente
// (que guarda urlNube en ws://) contra la URL del instalador (que llega en
// http://). Una URL ilegible devuelve null y null nunca es igual a nada:
// una config que no se puede interpretar jamás se considera "del mismo
// entorno" por accidente.
function origenDe(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    return new URL(url.replace(/^ws(s?):\/\//i, 'http$1://')).origin.toLowerCase();
  } catch {
    return null;
  }
}

// ─── Reinstalación sobre un equipo ya vinculado ─────────────────────────────
//
// Si ya hay credenciales DEL MISMO XABOR, NO se pisan en silencio: perderlas
// significa que la terminal registrada queda huérfana y el restaurante ve un
// equipo fantasma en su panel. Reinstalar para reparar el servicio es un caso
// normal y debe conservar la vinculación.
//
// Pero "hay una config" no es lo mismo que "hay una config de ESTE Xabor".
// El Setup de producción de Acuña reutilizó sin preguntar una config de
// prueba que apuntaba a ws://localhost:4300 -- y terminó "correctamente" con
// un servicio hablando con nadie. Una config de otro origen (localhost,
// staging, otra instancia) exige re-emparejar: sus credenciales no valen en
// este entorno aunque el archivo esté perfecto.
if (existsSync(RUTA_CONFIG) && !forzar) {
  let previa = null;
  try {
    previa = JSON.parse(readFileSync(RUTA_CONFIG, 'utf8'));
  } catch (e) {
    // "No puedo leerlo" NO es lo mismo que "no existe", y confundirlos es
    // peligroso: la ACL que protege el token deja el archivo ilegible para
    // quien no esté elevado. Si aquí se siguiera adelante, se canjearía un
    // código nuevo y se intentaría sobrescribir una vinculación que estaba
    // perfectamente bien -- gastando un código de un solo uso por un problema
    // de permisos.
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      salir(6, 'Xabor Edge ya tiene configuracion protegida en este equipo.\n' +
               'Ejecuta el instalador o esta herramienta como administrador.');
    }
    // Cualquier otro motivo (JSON corrupto, archivo truncado) sí justifica
    // rehacerla: peor es dejar el equipo sin poder vincularse.
  }
  if (previa && previa.terminalId && previa.terminalToken) {
    const origenPrevio = origenDe(previa.urlNube);
    const origenPedido = origenDe(urlBase);
    if (origenPrevio && origenPedido && origenPrevio === origenPedido) {
      salir(0, `Este equipo ya estaba conectado a Xabor (${previa.nombreEquipo || 'sin nombre'}). Se conservan sus credenciales.`);
    }
    // Origen distinto (o urlNube ilegible): la vinculación no sirve aquí.
    // Se sigue al canje -- la config vieja solo se sobrescribe si el canje
    // NUEVO tiene éxito; un fallo de red o un código malo la dejan intacta.
    console.log(`La configuracion existente apunta a otro Xabor (${origenPrevio || 'origen ilegible'}); este instalador es de ${origenPedido}. Se requiere un codigo de conexion nuevo.`);
  }
}

// El código solo hace falta si de verdad se va a canjear -- una reparación
// del mismo entorno ya salió por arriba sin necesitarlo.
if (!codigo) salir(5, 'Falta el codigo de conexion.');

// ─── El canje ───────────────────────────────────────────────────────────────

let respuesta;
try {
  respuesta = await fetch(`${urlBase}/api/edge/emparejar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codigo }),
    signal: AbortSignal.timeout(20000),
  });
} catch (e) {
  salir(3, `No se pudo contactar con Xabor. Revisa la conexion a internet de este equipo.`);
}

if (respuesta.status !== 201) {
  // El servidor devuelve el MISMO mensaje para "no existe", "ya se uso" y
  // "vencio", a proposito. Aqui se respeta esa decision.
  salir(2, 'El codigo de conexion no es valido o ya vencio. Genera uno nuevo en Xabor y vuelve a intentarlo.');
}

let datos;
try { datos = await respuesta.json(); } catch { salir(2, 'Xabor devolvio una respuesta inesperada.'); }
if (!datos?.terminalId || !datos?.token) salir(2, 'Xabor no devolvio credenciales para este equipo.');

// ─── Guardar ────────────────────────────────────────────────────────────────

const config = {
  terminalId: datos.terminalId,
  terminalToken: datos.token,
  urlNube: urlBase.replace(/^http/, 'ws') + '/ws/print-agent',
  nombreEquipo,
  vinculadoEn: new Date().toISOString(),
};

try {
  mkdirSync(DIR_CONFIG, { recursive: true });
  writeFileSync(RUTA_CONFIG, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
} catch (e) {
  salir(4, `No se pudo guardar la configuracion en ${DIR_CONFIG}. Ejecuta el instalador como administrador.`);
}

// ACL: solo SYSTEM y los administradores. El modo 0o600 de arriba no significa
// nada en Windows -- lo que manda es la lista de control de acceso. Sin esto,
// el token de la terminal seria legible por cualquier usuario del equipo, y en
// la caja de un restaurante hay varias personas con sesion.
// Se usan SIDs y no nombres: en un Windows en espanol el grupo NO se llama
// 'Administrators' sino 'Administradores', y icacls falla con un nombre que no
// existe. Se descubrio probando -- el aviso de abajo salia siempre, dejando el
// token sin proteger justo en los equipos donde va a instalarse. Los SIDs son
// los mismos en cualquier idioma de Windows:
//
//   *S-1-5-18      NT AUTHORITY\SYSTEM, la cuenta bajo la que corre el servicio
//   *S-1-5-32-544  el grupo de administradores local
try {
  execFileSync('icacls.exe', [RUTA_CONFIG, '/inheritance:r',
    '/grant:r', '*S-1-5-18:(F)', '/grant:r', '*S-1-5-32-544:(F)'], { stdio: 'ignore' });
} catch {
  // No es fatal: el equipo queda funcionando. Pero hay que decirlo, porque es
  // una credencial peor protegida de lo que deberia.
  console.log('AVISO: no se pudieron restringir los permisos del archivo de configuracion.');
}

// Ni el token ni el codigo salen por aqui. Lo unico que se confirma es que
// quedo vinculado y con que nombre.
salir(0, `Equipo vinculado a Xabor como "${nombreEquipo}".`);
