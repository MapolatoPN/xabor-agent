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

if (!codigo) salir(5, 'Falta el codigo de conexion.');
if (codigo.length > 64) salir(5, 'El codigo de conexion no es valido.');

// ─── Reinstalación sobre un equipo ya vinculado ─────────────────────────────
//
// Si ya hay credenciales, NO se pisan en silencio: perderlas significa que la
// terminal registrada en Xabor queda huérfana y el restaurante ve un equipo
// fantasma en su panel. Reinstalar para reparar el servicio es un caso normal
// y debe conservar la vinculación.
if (existsSync(RUTA_CONFIG) && !forzar) {
  try {
    const previa = JSON.parse(readFileSync(RUTA_CONFIG, 'utf8'));
    if (previa.terminalId && previa.terminalToken) {
      salir(0, `Este equipo ya estaba conectado a Xabor (${previa.nombreEquipo || 'sin nombre'}). Se conservan sus credenciales.`);
    }
  } catch {
    // Config ilegible o corrupta: se sigue y se sobrescribe. Peor es dejar el
    // equipo sin poder vincularse.
  }
}

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
try {
  execFileSync('icacls.exe', [RUTA_CONFIG, '/inheritance:r',
    '/grant:r', 'SYSTEM:(F)', '/grant:r', 'Administrators:(F)'], { stdio: 'ignore' });
} catch {
  // No es fatal: el equipo queda funcionando. Pero hay que decirlo, porque es
  // una credencial peor protegida de lo que deberia.
  console.log('AVISO: no se pudieron restringir los permisos del archivo de configuracion.');
}

// Ni el token ni el codigo salen por aqui. Lo unico que se confirma es que
// quedo vinculado y con que nombre.
salir(0, `Equipo vinculado a Xabor como "${nombreEquipo}".`);
