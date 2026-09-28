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
//     (una promesa rechazada sin manejador también lo termina);
//  6. (tercera vuelta) el upgrade de /ws/panel y /ws/superadmin pierde su
//     contención: la escucha de 'error' del socket crudo antes del primer
//     await (un reset durante la consulta a la base terminaba el proceso), el
//     catch de cada promesa de autenticación con 503 genérico, la respuesta
//     única y solo sobre un socket escribible; o leerCookieSesion vuelve a
//     lanzar con una cookie mal codificada (una petición anónima con
//     `xabor_sesion=%` terminaba el proceso);
//  7. el Edge (edge/connection.js) manda un mensaje distinto de los cuatro
//     medidos para MAX_PAYLOAD_WS (los lotes offline no caben: ver
//     docs/ws-limite-mensajes-edge.md);
//  8. (cuarta vuelta) vuelve un envío a todos los sockets: algún recorrido de
//     wss.clients deja de elegir UNA clase autenticada y su identidad antes
//     de enviar, o reaparece broadcast(), o se guardan sockets fuera de wss, o
//     se inyecta a un módulo un emisor que no sea uno de los filtrados. Así
//     llegaban a /ws/print-agent SIN autenticar el folio entregado por un
//     repartidor y los eventos del webhook de Rappi.
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

// Panel y Superadmin completan el upgrade solo después de verificar la sesión:
// su autenticación decide y llama a aceptar() al final; el socket y
// handleUpgrade son solo de prepararUpgrade (sección 6).
const panel = cuerpoDe(server, 'async function autenticarUpgradePanel(', 'autenticarUpgradePanel').cuerpo;
const iUpPanel = panel.indexOf('aceptar(');
assert.ok(iUpPanel > panel.indexOf('verificarTokenSesion(') && iUpPanel > panel.indexOf('obtenerMembresiaUsuarioNegocio('),
  '/ws/panel completa el upgrade antes de verificar sesión y membresía');
const superadmin = cuerpoDe(server, 'async function autenticarUpgradeSuperadmin(', 'autenticarUpgradeSuperadmin').cuerpo;
const iUpSuper = superadmin.indexOf('aceptar(');
assert.ok(iUpSuper > superadmin.indexOf('verificarTokenSesion(') && iUpSuper > superadmin.indexOf('esSuperadmin('),
  '/ws/superadmin completa el upgrade antes de verificar Superadmin');
for (const [nombre, cuerpo] of [['autenticarUpgradePanel', panel], ['autenticarUpgradeSuperadmin', superadmin]]) {
  assert.ok(!/\bsocket\b|wss\.handleUpgrade\(/.test(cuerpo), `${nombre} toca el socket o completa el upgrade por su cuenta: solo prepararUpgrade puede`);
  assert.equal((cuerpo.match(/\baceptar\(/g) || []).length, 1, `${nombre} acepta el upgrade por más de un camino`);
}

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

// ── 6 · el upgrade autenticado (panel, Superadmin) no tumba el proceso ─────
// Mientras la autenticación espera a la base, el socket crudo no tiene dueño
// (Node quitó su escucha al emitir 'upgrade'; ws no pone la suya hasta
// handleUpgrade): un reset del cliente emitía 'error' sin escucha. Y la
// promesa de la autenticación no tenía catch.
const preparar = cuerpoDe(server, 'function prepararUpgrade(req, socket, head, ruta)', 'prepararUpgrade').cuerpo;
assert.ok(/^\s*let resuelto = false;\s*socket\.on\('error',/.test(preparar),
  'prepararUpgrade no pone, antes que nada, la escucha de error del socket crudo: un reset durante la autenticación terminaría el proceso');
assert.ok(/const escribible = \(\) => socket\.writable && !socket\.destroyed;/.test(preparar),
  'prepararUpgrade ya no comprueba que el socket siga escribible y sin destruir');
const rechazarUp = cuerpoDe(preparar, 'const rechazar = (status, motivo) => {', 'rechazar() de prepararUpgrade').cuerpo;
assert.ok(/^\s*if \(resuelto\) return;\s*resuelto = true;/.test(rechazarUp), 'rechazar() puede responder dos veces');
assert.ok(/^\s*if \(escribible\(\)\) \{\s*socket\.write\(/m.test(rechazarUp.replace(/^\s*if \(resuelto\) return;\s*resuelto = true;/, '')),
  'rechazar() escribe la respuesta sin comprobar antes que el socket sigue escribible');
const aceptarUp = cuerpoDe(preparar, 'const aceptar = (contextoWS) => {', 'aceptar() de prepararUpgrade').cuerpo;
assert.ok(/^\s*if \(resuelto\) return;\s*resuelto = true;\s*if \(!escribible\(\)\) \{/.test(aceptarUp)
  && aceptarUp.indexOf('if (!escribible())') < aceptarUp.indexOf('wss.handleUpgrade('),
  'aceptar() puede completar el upgrade dos veces o sin comprobar que el cliente sigue ahí');
const falloUp = cuerpoDe(preparar, 'const fallo = (e) => {', 'fallo() de prepararUpgrade').cuerpo;
assert.ok(/rechazar\(503, 'Service Unavailable'\)/.test(falloUp), 'un error inesperado al autenticar ya no termina en un rechazo genérico 503');
assert.ok(!/\.message|\.stack|cookie|token|req\./i.test(falloUp.replace(/rechazar\(503[^)]*\)/, '')),
  'el catch del upgrade registra el mensaje o la pila del error, la cookie, el token o la petición');
const ramaDe = (ruta) => compacto(bloques.find((b) => b.ruta === ruta).cuerpo);
assert.equal(ramaDe('/ws/panel'), "const upgrade = prepararUpgrade(req, socket, head, '/ws/panel'); autenticarUpgradePanel(req, upgrade).catch(upgrade.fallo); return;",
  '/ws/panel ya no prepara el socket antes de autenticar o su promesa no tiene catch');
assert.equal(ramaDe('/ws/superadmin'), "const upgrade = prepararUpgrade(req, socket, head, '/ws/superadmin'); autenticarUpgradeSuperadmin(req, upgrade).catch(upgrade.fallo); return;",
  '/ws/superadmin ya no prepara el socket antes de autenticar o su promesa no tiene catch');
assert.equal((server.match(/socket\.write\(/g) || []).length, 2,
  'hay una escritura al socket crudo fuera de prepararUpgrade y del 404 por defecto');
// La cookie de sesión se lee en middlewares async y en estos upgrades: si
// decodificarla lanza, nadie recoge el rechazo.
const cookie = cuerpoDe(server, 'function leerCookieSesion(req)', 'leerCookieSesion').cuerpo;
assert.ok((cookie.match(/decodeURIComponent\(/g) || []).length === 1 && /try \{ return decodeURIComponent\(/.test(cookie),
  'leerCookieSesion decodifica la cookie fuera de un try: una cookie con «%» inválido termina el proceso');

// ── 7 · lo que manda el Edge cabe en MAX_PAYLOAD_WS ────────────────────────
// El límite se midió contra los CUATRO mensajes que manda hoy el Edge. Los
// lotes offline de las ramas offline/sala-v1 e integracion/obispado-personal
// (sala_lote, llevar_lote) no caben: docs/ws-limite-mensajes-edge.md. Si el
// Edge gana un mensaje, esta barrera falla hasta que se revise el límite o se
// fragmente ese mensaje.
const edgeConexion = sinComentarios(leer('edge/connection.js'));
const enviosEdge = [...edgeConexion.matchAll(/\.send\(\s*JSON\.stringify\(\s*\{([^}]*)\}/g)].map((m) => m[1]);
assert.equal((edgeConexion.match(/\.send\(/g) || []).length, enviosEdge.length,
  'edge/connection.js manda algo que no es un objeto JSON literal: no se puede saber si cabe en MAX_PAYLOAD_WS');
const tiposEdge = [...new Set(enviosEdge.map((c) => (/\btipo:\s*'([\w-]+)'/.exec(c) || [null, `(tipo no literal: ${compacto(c).slice(0, 30)})`])[1]))].sort();
assert.deepEqual(tiposEdge, ['ack_impresion', 'autenticar_terminal', 'impresoras_detectadas', 'latido'],
  `el Edge manda mensajes distintos de los cuatro medidos para MAX_PAYLOAD_WS (${tiposEdge.join(', ')}): revisar docs/ws-limite-mensajes-edge.md antes de integrarlos`);

// ── 8 · ningún envío llega a un print-agent sin autenticar ────────────────
// broadcast() recorría wss.clients sin mirar la clase de la conexión: el folio
// entregado por un repartidor y tres eventos del webhook de Rappi llegaban a
// los paneles de todos los negocios, a Superadmin, a los Edge de otros
// negocios y a /ws/print-agent sin autenticar (cualquiera la abre, 5 s de
// gracia). Ahora cada recorrido elige UNA clase autenticada y su identidad
// ANTES de tocar el socket; 'print-agent-pendiente' nunca es destino.
assert.ok(!/\bfunction\s+broadcast\s*\(|(?<![\w.$])broadcast\s*\(/.test(server),
  'volvió broadcast(): un envío a todos los sockets llega también a /ws/print-agent sin autenticar');
const CLASES = { panel: ['negocioId'], superadmin: [], 'print-agent': ['autenticado'] };
const recorridos = [];
for (const m of server.matchAll(/\bwss\.clients\b/g)) {
  const f = /^wss\.clients\.forEach\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\{/.exec(server.slice(m.index));
  assert.ok(f, `wss.clients se usa fuera de un forEach con filtro de clase: «${compacto(server.slice(m.index, m.index + 70))}»`);
  const abre = m.index + f[0].length - 1;
  const funcion = [...server.slice(0, m.index).matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].pop()?.[1] ?? '?';
  recorridos.push({ p: f[1], cuerpo: server.slice(abre + 1, cierreDe(server, abre)), donde: `${funcion}()` });
}
assert.ok(recorridos.length >= 5, `solo se encontraron ${recorridos.length} recorridos de wss.clients: la barrera ya no reconoce la forma del código`);
const problemas = [];
for (const r of recorridos) {
  const p = r.p.replace(/\$/g, '\\$');
  const pos = (re) => { const i = r.cuerpo.search(re); return i < 0 ? Infinity : i; };
  // Lo primero que toca el socket: enviarle, cerrarlo, pasarlo o guardarlo.
  const iEfecto = Math.min(
    pos(new RegExp(`\\b${p}\\.(send|close|terminate)\\(`)),
    pos(new RegExp(`(?<![=!<>])=(?!=)\\s*${p}\\b(?![.\\w$])`)),
    pos(new RegExp(`[(,]\\s*${p}\\s*[,)]`)));
  const clases = [...r.cuerpo.matchAll(new RegExp(`\\b${p}\\.tipo\\s*(?:!==|===)\\s*'([\\w-]+)'`, 'g'))];
  const nombres = [...new Set(clases.map((c) => c[1]))];
  if (/print-agent-pendiente/.test(r.cuerpo)) { problemas.push(`${r.donde}: nombra 'print-agent-pendiente' como destino`); continue; }
  if (nombres.length !== 1 || !(nombres[0] in CLASES)) {
    problemas.push(`${r.donde}: debe elegir exactamente una clase autenticada (${Object.keys(CLASES).join(', ')}) y elige [${nombres.join(', ')}]`);
    continue;
  }
  if (!clases.some((c) => c.index < iEfecto)) problemas.push(`${r.donde}: toca el socket antes de mirar su clase`);
  for (const campo of CLASES[nombres[0]]) {
    if (!(pos(new RegExp(`\\b${p}\\.${campo}\\b`)) < iEfecto)) problemas.push(`${r.donde}: clase '${nombres[0]}' sin comprobar ${campo} antes de tocar el socket`);
  }
  if (nombres[0] === 'print-agent'
    && !(pos(new RegExp(`\\b${p}\\.terminalId\\b`)) < iEfecto)
    && !(Math.max(pos(new RegExp(`\\b${p}\\.negocioId\\b`)), pos(new RegExp(`\\b${p}\\.sucursalId\\b`))) < iEfecto)) {
    problemas.push(`${r.donde}: un Edge autenticado sin comprobar su terminal (o negocio y sucursal) antes de tocar el socket`);
  }
}
assert.deepEqual(problemas, [], `un recorrido de wss.clients puede llegar a quien no debe:\n  ${problemas.join('\n  ')}`);
// Los sockets solo se alcanzan por wss.clients (arriba) o dentro de su propio
// manejador: nada los guarda aparte ni los exporta.
assert.ok(!/\.(add|push|set)\([^()]*\b(ws|client|otro)\s*\)/.test(server) && !/export\s*(\{[^}]*\bwss\b|(const|let|var)\s+wss\b)/.test(server),
  'server.js guarda o exporta sockets fuera de wss: esa colección no tendría el filtro de clase');
// Antes de autenticar, la conexión de /ws/print-agent solo puede recibir la
// respuesta de su propio intento fallido.
const enviosPendiente = [...ramaPendiente.matchAll(/\bws\.send\(/g)].map((m) => m.index).filter((i) => i < iAuth);
assert.ok(enviosPendiente.length === 1
  && ramaPendiente.startsWith("ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Autenticación fallida' }))", enviosPendiente[0]),
  'la conexión de /ws/print-agent recibe algo más que el error de su propio intento antes de autenticarse');
// Lo que se inyecta a los módulos (WhatsApp, Rappi, pedidos, impresión) es
// siempre uno de los emisores filtrados de arriba.
const EMISORES = new Set(['broadcastNegocio', 'broadcastSuperadmin', 'broadcastPrintAgentLegacy', 'broadcastPrintAgentNegocio', 'entregarTrabajos']);
const inyectados = [...server.matchAll(/\b(set\w*(?:Broadcast|AvisoImpresion|EntregaEdge)\w*)\(([^)]*)\)/g)];
assert.ok(inyectados.length >= 6, `solo se encontraron ${inyectados.length} inyecciones de emisores: la barrera ya no reconoce la forma del código`);
const ajenos = inyectados.flatMap((m) => [...m[2].replace(/\b[A-Za-z_$][\w$]*\s*:/g, '').matchAll(/[A-Za-z_$][\w$]*/g)]
  .map((x) => x[0]).filter((id) => !EMISORES.has(id)).map((id) => `${m[1]}(… ${id} …)`));
assert.deepEqual(ajenos, [], `se inyecta a un módulo un emisor que no filtra por clase autenticada:\n  ${ajenos.join('\n  ')}`);

console.log('OK: WebSocket en lista cerrada — solo /ws/panel, /ws/superadmin y /ws/print-agent (exactas), 404 por defecto sin consultar nada, sin legado ni su siembra, sin trabajos antes de autenticar; maxPayload de ' + maxPayload + ' bytes para los 4 mensajes del Edge, escucha de error en toda conexión, JSON validado como objeto y rechazos async contenidos; upgrade de panel y Superadmin contenido (escucha de error antes del await, catch con 503, respuesta única) y cookie mal codificada sin lanzar; sin envío a todos los sockets: ' + recorridos.length + ' recorridos de wss.clients, cada uno con una clase autenticada y su identidad, nada antes de autenticar el print-agent.');
