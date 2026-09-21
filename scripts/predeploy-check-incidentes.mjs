// Regresiones productivas del 21-sep que Railway ejecuta ANTES de desplegar.
// Este archivo vive en scripts/ porque .dockerignore excluye test/ y la
// barrera tiene que existir dentro de la imagen, no solo en el checkout local.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { libroDeOperaciones, almacenEnMemoria } from '../src/mesero-agente/libroDeOperaciones.js';
import { cicloParaTurno } from '../src/mesero-agente/cicloDelAgente.js';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));

// ── XAB-0467 / XAB-0469: confirmar una vez por ciclo ─────────────────────
const NEGOCIO = '11111111-1111-4111-8111-111111111111';
const CONVERSACION = 'agente:5218781175648';
let ejecuciones = 0;
const libro = libroDeOperaciones(almacenEnMemoria());
const confirmar = (turnoId) => libro.ejecutarUnaVez({
  negocioId: NEGOCIO,
  conversacionId: CONVERSACION,
  turnoId,
  herramienta: 'confirmar_pedido',
  argumentos: {},
}, async () => {
  ejecuciones += 1;
  return { aplicada: true, estado: 'ok', resultado: { aplicado: true, folio: 'XAB-0467' } };
});

const primera = await confirmar('wa-confirmacion-original');
assert.equal(primera.repetida, false);
assert.equal(primera.resultado.folio, 'XAB-0467');
assert.equal(ejecuciones, 1);

const estadoConfirmado = {
  negocioId: NEGOCIO,
  conversacionId: CONVERSACION,
  ciclo: 0,
  hechos: { confirmado: true, cancelado: false, escalado: false, fallido: false },
};
for (const mensaje of ['gracias', 'tiempo de envio?', 'si', 'si, todo correcto']) {
  assert.equal(cicloParaTurno(estadoConfirmado, mensaje), estadoConfirmado,
    `"${mensaje}" abrió un ciclo nuevo sin que el cliente pidiera otro pedido`);
}
for (const turno of ['wa-gracias', 'wa-tiempo-envio', 'wa-si-posterior']) {
  const repetida = await confirmar(turno);
  assert.equal(repetida.repetida, true);
  assert.equal(repetida.aplicada, true);
  assert.equal(repetida.resultado.folio, 'XAB-0467');
}
assert.equal(ejecuciones, 1, 'se ejecutó registrarPedido más de una vez en el mismo ciclo');

const cicloNuevo = cicloParaTurno(estadoConfirmado, 'quiero hacer otro pedido');
assert.notEqual(cicloNuevo, estadoConfirmado);
assert.equal(cicloNuevo.conversacionId, `${CONVERSACION}:c1`);
const segundaLegitima = await libro.ejecutarUnaVez({
  negocioId: NEGOCIO,
  conversacionId: cicloNuevo.conversacionId,
  turnoId: 'wa-otro-pedido',
  herramienta: 'confirmar_pedido',
  argumentos: {},
}, async () => ({ aplicada: true, estado: 'ok', resultado: { aplicado: true, folio: 'XAB-0500' } }));
assert.equal(segundaLegitima.repetida, false);

const runner = readFileSync(join(RAIZ, 'scripts', 'predeploy-run-032-033.mjs'), 'utf8');
const i83 = runner.indexOf("'083-restaurante-division-consumo'");
const i84 = runner.indexOf("'084-agente-operaciones'");
const i85 = runner.indexOf("'085-agente-outbox'");
assert.ok(i83 >= 0 && i84 > i83 && i85 > i84,
  'el predeploy debe aplicar 084 y 085, en orden, antes del binario nuevo');

// ── Panel: sesión, menú, Restaurante y replay operativo ──────────────────
const leer = (ruta) => readFileSync(join(RAIZ, ruta), 'utf8');
const panel = leer('panel/index.html');
const captura = leer('panel/captura.js');
const mesas = leer('panel/mesas.html');
const server = leer('src/server.js');

const auth = panel.indexOf("fetch('/api/auth/me'");
const cargaMenu = panel.indexOf('renderMenuPOS().catch', auth);
const ws = panel.indexOf('conectarWS();', auth);
assert.ok(auth >= 0 && cargaMenu > auth && ws > auth,
  'el panel debe validar la sesión antes de cargar menú y conectar WebSocket');
assert.match(panel, /renderMenuPOS\(\)\.catch\([^\n]+No se pudo cargar el menú/,
  'un fallo de menú no debe rechazar la autenticación ni mandar al login');
assert.match(captura, /catch \(e\) \{[\s\S]*?se conserva el anterior:[\s\S]*?finally \{ _enVuelo = null; \}/,
  'la captura compartida debe conservar el último catálogo bueno');
assert.match(captura, /if \(_arbol && _arbol\.length && !refrescar\) \{ revalidar\(\); return _arbol; \}/,
  'las modalidades deben pintar cache bueno y revalidar en segundo plano');
assert.match(mesas, /catch \{[\s\S]*?MENU = null;[\s\S]*?\}/,
  'Restaurante debe dejar el menú reintentable después de un fallo');
assert.match(mesas, /onclick="cargarMenu\(\)"[^>]*>Reintentar/,
  'Restaurante debe ofrecer reintento visible');
assert.match(server, /res\.set\('Cache-Control', 'private, no-store'\);[\s\S]*?res\.json\(menu\)/,
  'el endpoint de menú no debe cachear una respuesta vacía transitoria');
assert.match(server, /if \(p\.estado === 'entregado' \|\| p\.estado === 'cancelado'\) return false;/,
  'el replay no debe devolver entregados ni cancelados');
assert.match(server, /fechaOperativaDe\(instante, tz\) === hoy/,
  'el replay debe limitarse al día operativo del negocio');

console.log('OK: doble confirmación, sesión, menú, Restaurante y replay protegidos.');
