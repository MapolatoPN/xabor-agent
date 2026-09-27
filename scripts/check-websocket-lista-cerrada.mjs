// Barrera de predeploy: el upgrade WebSocket es una LISTA CERRADA.
//
// Hasta el 27-sep-2026, toda ruta desconocida caía en la «raíz legado»: sin
// credencial, se asignaba al único negocio con print_agent_legacy_activo y
// se llevaba sus comandas pendientes (con los datos del pedido). En producción
// solo imprime Edge autenticado y no hubo conexiones legado: se retiró. Esta
// barrera falla si vuelve cualquier pieza de aquello:
//
//  1. el upgrade atiende algo más que /ws/panel, /ws/superadmin y
//     /ws/print-agent, o las compara de forma no exacta (normalizando);
//  2. después de esas tres rutas hay otra cosa que el rechazo por defecto
//     (404 + destroy): un fallback, una consulta, un handleUpgrade;
//  3. reaparece la clase de conexión 'legacy', el contexto por omisión o la
//     resolución automática del único negocio legado;
//  4. un print-agent recibe trabajos antes de autenticar su terminal, o el
//     destino del modo legado vuelve a tener sockets;
//  5. (27-sep-2026, segunda vuelta) initDB vuelve a sembrar
//     print_agent_legacy_activo = 'true' —lo hacía para Nonna Maye en CADA
//     arranque—, o /ws/print-agent pierde su blindaje: maxPayload explícito y
//     acotado (sin él, ws junta frames de 100 MiB antes de autenticar), la
//     escucha de 'error' en toda conexión (sin ella, un frame inválido termina
//     el proceso), la comprobación de que el JSON es un objeto antes de leerlo
//     (`null.tipo` terminaba el proceso) y el .catch del manejador de mensajes
//     (una promesa rechazada sin manejador también lo termina).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const leer = (ruta) => readFileSync(join(RAIZ, ruta), 'utf8');
const sinComentarios = (fuente) => fuente.split('\n')
  .filter((l) => { const s = l.trim(); return !(s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')); })
  .join('\n');
const compacto = (s) => s.replace(/\s+/g, ' ').trim();

// Devuelve el índice de la llave que cierra la que abre en `desde` (saltando
// cadenas y plantillas: el manejador escribe cabeceras HTTP como texto).
function cierreDe(fuente, desde) {
  assert.equal(fuente[desde], '{', 'cierreDe espera una llave de apertura');
  let nivel = 0;
  for (let i = desde; i < fuente.length; i++) {
    const c = fuente[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < fuente.length && fuente[i] !== c; i++) if (fuente[i] === '\\') i++;
      continue;
    }
    if (c === '{') nivel++;
    else if (c === '}') { nivel--; if (nivel === 0) return i; }
  }
  throw new Error('llave sin cerrar');
}
function cuerpoDe(fuente, marcador, que) {
  const i = fuente.indexOf(marcador);
  assert.ok(i >= 0, `no se encontró ${que}`);
  const abre = fuente.indexOf('{', i + marcador.length - 1);
  const cierra = cierreDe(fuente, abre);
  return { cuerpo: fuente.slice(abre + 1, cierra), inicio: abre + 1, fin: cierra };
}

const server = sinComentarios(leer('src/server.js'));

// ── 1 y 2 · el manejador de upgrade ────────────────────────────────────────
const { cuerpo: upgrade } = cuerpoDe(server, "server.on('upgrade', (req, socket, head) => {", 'el manejador de upgrade');
const PERMITIDAS = ['/ws/panel', '/ws/superadmin', '/ws/print-agent'];
const bloques = [];
for (const m of upgrade.matchAll(/if\s*\(\s*pathname\s*===\s*'([^']*)'\s*\)\s*\{/g)) {
  const abre = m.index + m[0].length - 1;
  const cierra = cierreDe(upgrade, abre);
  bloques.push({ ruta: m[1], desde: m.index, hasta: cierra + 1, cuerpo: upgrade.slice(abre + 1, cierra) });
}
assert.deepEqual(bloques.map((b) => b.ruta).sort(), [...PERMITIDAS].sort(),
  `el upgrade atiende otras rutas que las tres permitidas: ${bloques.map((b) => b.ruta).join(', ')}`);
for (const b of bloques) {
  assert.ok(/return;\s*$/.test(b.cuerpo), `la rama ${b.ruta} no termina en return: seguiría hacia el rechazo o más allá`);
}
const ramaPrintAgent = bloques.find((b) => b.ruta === '/ws/print-agent').cuerpo;
assert.ok(/tipo:\s*'print-agent-pendiente'/.test(ramaPrintAgent) && /autenticado:\s*false/.test(ramaPrintAgent),
  '/ws/print-agent ya no nace como print-agent-pendiente sin autenticar');

// Lo que queda fuera de las tres ramas: la declaración de pathname y el rechazo.
let resto = upgrade;
for (const b of [...bloques].sort((x, y) => y.desde - x.desde)) resto = resto.slice(0, b.desde) + resto.slice(b.hasta);
const DECLARACION = "const pathname = String(req.url || '').split('?')[0];";
assert.ok(resto.includes(DECLARACION),
  'la ruta ya no se toma tal cual (sin normalizar mayúsculas, barras, %xx ni ..): la comparación dejó de ser exacta');
const RECHAZO = "socket.write('HTTP/1.1 404 Not Found\\r\\nConnection: close\\r\\n\\r\\n'); socket.destroy();";
assert.equal(compacto(resto.replace(DECLARACION, '')), RECHAZO,
  'fuera de las tres rutas permitidas hay algo más que el rechazo por defecto (404 + destroy): un fallback, una consulta o un upgrade');
const iRechazo = upgrade.indexOf("socket.write('HTTP/1.1 404 Not Found");
assert.ok(bloques.every((b) => b.hasta <= iRechazo), 'el rechazo por defecto no está DESPUÉS de evaluar la lista permitida');
assert.ok(!/\bpathname\s*\.\s*(toLowerCase|toUpperCase|normalize|replace|startsWith|endsWith|includes|match)\b|decodeURI/.test(upgrade),
  'el upgrade normaliza o compara la ruta de forma no exacta');

// Panel y Superadmin completan el upgrade solo después de verificar la sesión.
const panel = cuerpoDe(server, 'async function autenticarUpgradePanel(', 'autenticarUpgradePanel').cuerpo;
const iUpPanel = panel.indexOf('wss.handleUpgrade(');
assert.ok(iUpPanel > panel.indexOf('verificarTokenSesion(') && iUpPanel > panel.indexOf('obtenerMembresiaUsuarioNegocio('),
  '/ws/panel completa el upgrade antes de verificar sesión y membresía');
const superadmin = cuerpoDe(server, 'async function autenticarUpgradeSuperadmin(', 'autenticarUpgradeSuperadmin').cuerpo;
const iUpSuper = superadmin.indexOf('wss.handleUpgrade(');
assert.ok(iUpSuper > superadmin.indexOf('verificarTokenSesion(') && iUpSuper > superadmin.indexOf('esSuperadmin('),
  '/ws/superadmin completa el upgrade antes de verificar Superadmin');

// ── 3 · ninguna huella del legado ──────────────────────────────────────────
assert.ok(!/\btipo\s*(===|!==|==|!=)\s*['"`]legacy['"`]|\btipo\s*:\s*['"`]legacy['"`]/.test(server),
  "reapareció la clase de conexión 'legacy' en server.js");
assert.ok(!/contextoWS\s*\|\|/.test(server), 'reapareció un contexto WebSocket por omisión');
assert.ok(!/print_agent_legacy_activo/.test(server), 'server.js vuelve a consultar print_agent_legacy_activo');
const conexion = cuerpoDe(server, "wss.on('connection', (ws) => {", "wss.on('connection')").cuerpo;
// Lo único que puede ir antes es la escucha de 'error' (sección 5).
const mError = /^\s*ws\.on\('error',\s*\([^)]*\)\s*=>\s*\{/.exec(conexion);
assert.ok(mError, "wss.on('connection') no registra, antes que nada, una escucha de 'error' en el socket: un frame inválido o mayor que maxPayload terminaría el proceso");
const trasError = conexion.slice(cierreDe(conexion, mError.index + mError[0].length - 1) + 1).replace(/^\s*\);/, '');
assert.ok(/^\s*if\s*\(\s*!ws\.contextoWS\s*\)\s*\{[^}]*close\(1008/.test(trasError),
  'wss.on(connection) ya no cierra, antes que nada, una conexión sin contexto de upgrade');

function archivos(dir) {
  const out = [];
  for (const n of readdirSync(join(RAIZ, dir))) {
    const ruta = `${dir}/${n}`;
    if (statSync(join(RAIZ, ruta)).isDirectory()) out.push(...archivos(ruta));
    else if (/\.(m?js|cjs)$/.test(n)) out.push(ruta);
  }
  return out;
}
const hallazgos = [];
for (const ruta of archivos('src')) {
  const codigo = sinComentarios(leer(ruta));
  for (const nombre of ['resolverNegocioLegacyUnico', 'reclamarTrabajosLegacyPendientes', 'devolverTrabajoLegacyAPendiente']) {
    if (new RegExp(`\\b${nombre}\\b`).test(codigo)) hallazgos.push(`${ruta}: ${nombre}`);
  }
  // La bandera solo se lee para decidir el MODO de impresión (database.js).
  if (ruta !== 'src/services/database.js' && /print_agent_legacy_activo/.test(codigo)) hallazgos.push(`${ruta}: print_agent_legacy_activo`);
}
assert.deepEqual(hallazgos, [], `volvió la resolución o la entrega del legado:\n  ${hallazgos.join('\n  ')}`);

// ── 3b · la bandera legado no se vuelve a sembrar ─────────────────────────
// initDB la insertaba 'true' para Nonna Maye con ON CONFLICT DO NOTHING: si
// alguien borraba la fila, el siguiente arranque la devolvía. En database.js
// la bandera solo puede aparecer dentro de resolverModoImpresion (la lee); en
// ningún código, migración ni script de predeploy puede escribirse 'true'.
const db = sinComentarios(leer('src/services/database.js'));
const modoImpresion = cuerpoDe(db, 'export async function resolverModoImpresion(', 'resolverModoImpresion');
assert.ok(!/print_agent_legacy_activo/.test(db.slice(0, modoImpresion.inicio) + db.slice(modoImpresion.fin)),
  'database.js vuelve a sembrar o escribir print_agent_legacy_activo (solo resolverModoImpresion puede leerla)');
const SIEMBRA_LEGADO = [
  /['"`]print_agent_legacy_activo['"`]\s*,\s*['"`]true['"`]/,                   // VALUES (.., 'print_agent_legacy_activo', 'true')
  /\bprint_agent_legacy_activo['"`]?\s*:\s*['"`]true['"`]/,                      // { print_agent_legacy_activo: 'true' }
  /\bvalor\s*=\s*['"`]true['"`][^;]{0,300}['"`]print_agent_legacy_activo['"`]/, // SET valor = 'true' WHERE clave = ...
];
const ESTA_BARRERA = 'scripts/check-websocket-lista-cerrada.mjs';
function archivosCon(dir, extension) {
  const out = [];
  for (const n of readdirSync(join(RAIZ, dir))) {
    const ruta = `${dir}/${n}`;
    if (statSync(join(RAIZ, ruta)).isDirectory()) out.push(...archivosCon(ruta, extension));
    else if (extension.test(n)) out.push(ruta);
  }
  return out;
}
const siembras = [];
for (const ruta of [...archivos('src'), ...archivosCon('scripts', /\.(m?js|cjs)$/), ...archivosCon('migrations', /\.sql$/)]) {
  if (ruta === ESTA_BARRERA) continue;
  const fuente = leer(ruta);
  const codigo = ruta.endsWith('.sql')
    ? fuente.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    : sinComentarios(fuente);
  if (SIEMBRA_LEGADO.some((re) => re.test(codigo))) siembras.push(ruta);
}
assert.deepEqual(siembras, [], `vuelve a sembrarse print_agent_legacy_activo = 'true':\n  ${siembras.join('\n  ')}`);

// ── 4 · nada sale hacia un print-agent sin autenticar ─────────────────────
const { cuerpo: ramaPendiente } = cuerpoDe(conexion, "if (ws.tipo === 'print-agent-pendiente') {", 'la rama print-agent-pendiente');
const iHash = ramaPendiente.indexOf('timingSafeEqual(');
const iAuth = ramaPendiente.indexOf('ws.autenticado = true');
const entregas = [...ramaPendiente.matchAll(/entregarTrabajosPendientes\(/g)].map((m) => m.index);
assert.ok(iHash > 0 && iAuth > iHash, 'el print-agent se marca autenticado sin comparar su token');
assert.equal(entregas.length, 1, 'la rama del print-agent entrega trabajos por más de un camino');
assert.ok(entregas[0] > iAuth, 'se entregan trabajos ANTES de autenticar la terminal');
assert.ok(/if\s*\(\s*procesado\s*&&\s*ws\.autenticado\s*\)\s*\{?\s*return manejarMensajeDeEdge\(/.test(ramaPendiente),
  'los mensajes de Edge (ACK, latidos) se aceptan sin una terminal autenticada');
const envio = cuerpoDe(server, 'function enviarTrabajoATerminal(', 'enviarTrabajoATerminal').cuerpo;
assert.ok(/client\.tipo !== 'print-agent' \|\| !client\.autenticado/.test(envio),
  'enviarTrabajoATerminal manda trabajos a sockets que no son print-agents autenticados');
const legado = cuerpoDe(server, 'function broadcastPrintAgentLegacy(', 'broadcastPrintAgentLegacy').cuerpo;
assert.ok(!/wss\.clients|\.send\(/.test(legado), 'el destino del modo legado vuelve a mandar a sockets');

// ── 5 · /ws/print-agent: tamaño acotado, JSON no objeto, rechazos async ────
// 5a. maxPayload explícito y acotado en TODO WebSocketServer. El primer
// mensaje (autenticar_terminal) tiene que caber; el peor caso legítimo del
// Edge (impresoras_detectadas) mide 63,173 bytes. Subirlo de 64 KiB exige
// revisar el protocolo del Edge y esta barrera a la vez.
const mMax = /const MAX_PAYLOAD_WS = ([\d\s*]+);/.exec(server);
assert.ok(mMax, 'falta MAX_PAYLOAD_WS: sin maxPayload, ws junta frames de hasta 100 MiB antes de que nadie autentique');
const maxPayload = mMax[1].split('*').reduce((p, x) => p * Number(x.trim()), 1);
assert.ok(Number.isInteger(maxPayload) && maxPayload >= 4096 && maxPayload <= 64 * 1024,
  `MAX_PAYLOAD_WS = ${maxPayload}: debe dejar pasar el primer mensaje (4 KiB) y no pasar de 64 KiB sin revisar el protocolo del Edge`);
const sinLimite = [];
for (const ruta of archivos('src')) {
  const codigo = sinComentarios(leer(ruta));
  for (const m of codigo.matchAll(/new WebSocketServer\(([^)]*)\)/g)) {
    if (!/maxPayload:\s*MAX_PAYLOAD_WS\b/.test(m[1])) sinLimite.push(`${ruta}: new WebSocketServer(${compacto(m[1])})`);
  }
  // Un manejador de mensajes async sin .catch es una promesa rechazada sin
  // manejador en cuanto algo lance: Node termina el proceso.
  if (/\.on\(\s*['"`]message['"`]\s*,\s*async\b/.test(codigo)) sinLimite.push(`${ruta}: .on('message', async ...) sin .catch explícito`);
}
assert.deepEqual(sinLimite, [], `WebSocket sin límite de tamaño o con un manejador que puede tumbar el proceso:\n  ${sinLimite.join('\n  ')}`);

// 5b. JSON.parse también devuelve null, números, cadenas y arreglos: se
// comprueba que es un objeto ANTES de leer una sola propiedad, al autenticar y
// ya autenticado.
assert.equal(compacto(cuerpoDe(server, 'function esObjetoJSON(v)', 'esObjetoJSON').cuerpo),
  "return v !== null && typeof v === 'object' && !Array.isArray(v);",
  'esObjetoJSON ya no exige un objeto que no sea null ni arreglo');
const primerUso = (fuente) => fuente.search(/\bmsg\s*(\.|\?\.|\[)/);
const edgeAutenticado = cuerpoDe(server, 'async function manejarMensajeDeEdge(ws, raw)', 'manejarMensajeDeEdge').cuerpo;
const iValidaEdge = edgeAutenticado.indexOf('if (!esObjetoJSON(msg))');
assert.ok(iValidaEdge > edgeAutenticado.indexOf('JSON.parse(') && iValidaEdge < primerUso(edgeAutenticado),
  'manejarMensajeDeEdge lee el mensaje antes de comprobar que es un objeto JSON (null.tipo termina el proceso)');
const iTipoEdge = edgeAutenticado.indexOf("if (typeof msg.tipo !== 'string')");
assert.ok(iTipoEdge > iValidaEdge && iTipoEdge < edgeAutenticado.indexOf('msg.tipo ==='),
  'manejarMensajeDeEdge compara msg.tipo sin comprobar antes que es texto');
const iParseAuth = ramaPendiente.indexOf('msg = JSON.parse(');
const iValidaAuth = ramaPendiente.indexOf('if (!esObjetoJSON(msg))');
assert.ok(iParseAuth >= 0 && iValidaAuth > iParseAuth && iValidaAuth < primerUso(ramaPendiente),
  'la autenticación del print-agent lee el mensaje antes de comprobar que es un objeto JSON');

// 5c. Toda promesa que nace de un mensaje del print-agent tiene su .catch.
const mMensaje = /ws\.on\('message',\s*\(raw\)\s*=>\s*\{/.exec(ramaPendiente);
assert.ok(mMensaje, "la rama print-agent-pendiente ya no registra su manejador de mensajes como ws.on('message', (raw) => { ... })");
const manejador = ramaPendiente.slice(mMensaje.index + mMensaje[0].length, cierreDe(ramaPendiente, mMensaje.index + mMensaje[0].length - 1));
assert.ok(/^\s*procesarMensajePrintAgent\(raw\)\.catch\(/.test(manejador),
  'el manejador de mensajes del print-agent no recoge el rechazo de su promesa: una excepción terminaría el proceso');
assert.ok(/ws\.close\(1011/.test(manejador), 'un error inesperado antes de autenticar ya no cierra la conexión de forma controlada (1011)');
assert.equal([...server.matchAll(/\bmanejarMensajeDeEdge\(/g)].length, 2,
  'manejarMensajeDeEdge se llama desde otro sitio que el manejador protegido por .catch');

console.log('OK: WebSocket en lista cerrada — solo /ws/panel, /ws/superadmin y /ws/print-agent (exactas), 404 por defecto sin consultar nada, sin legado ni su siembra, sin trabajos antes de autenticar; maxPayload de ' + maxPayload + ' bytes, escucha de error en toda conexión, JSON validado como objeto y rechazos async contenidos.');
