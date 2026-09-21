// Regresiones productivas del 21-sep que Railway ejecuta ANTES de desplegar.
// Este archivo vive en scripts/ porque .dockerignore excluye test/ y la
// barrera tiene que existir dentro de la imagen, no solo en el checkout local.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { libroDeOperaciones, almacenEnMemoria } from '../src/mesero-agente/libroDeOperaciones.js';
import { cicloParaTurno } from '../src/mesero-agente/cicloDelAgente.js';
import { pedidoActivoDesdeFila } from '../src/orders/proyeccionPedidoActivo.js';
import { puedeProcesarTurno } from '../src/orders/modoDelPedido.js';
import { crearEjecutor, estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { vistaDelPedido } from '../src/mesero-agente/vistaDelPedido.js';
import { aplicarRespuestaDeConfirmacion, confirmarYEmitir } from '../src/mesero-agente/canalDelAgente.js';
import {
  esSolicitudDePedidoProgramado, respuestaAfirmaCambioSinAplicar,
} from '../src/mesero-agente/seguridadConversacional.js';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));

// El interruptor que usa el negocio en el panel es el corte maestro. El
// agente nuevo no puede saltárselo aunque su propia bandera y alcance sigan
// encendidos por error.
assert.equal(puedeProcesarTurno({ botGlobalActivo: false, agenteCanario: true }), false,
  'apagar el bot visible dejó al agente nuevo respondiendo');
assert.equal(puedeProcesarTurno({ botGlobalActivo: true, agenteCanario: true }), true);

// Conversación terminada en 7753: el agente prometió un envío para mañana y
// dijo «apunto» sin haber aplicado ninguna herramienta.
assert.equal(esSolicitudDePedidoProgramado('Si por favor sería para enviarlo mañana'), true,
  'un pedido futuro volvió a entrar al agente sin herramienta de programación');
assert.equal(esSolicitudDePedidoProgramado('Mañana a las 10', { hayPedidoEnCurso: true }), true,
  'una continuación temporal corta no se reconoció con un carrito en curso');
assert.equal(esSolicitudDePedidoProgramado('¿Qué promociones hay mañana?'), false,
  'una consulta futura inocente se mandó innecesariamente a revisión');
assert.equal(respuestaAfirmaCambioSinAplicar({
  texto: 'Va, apunto los chilaquiles suizos.', operaciones: [],
}), true, 'el agente volvió a afirmar un cambio que no guardó');
assert.equal(respuestaAfirmaCambioSinAplicar({
  texto: 'Listo, salsa suiza anotada.',
  operaciones: [{ herramienta: 'modificar_linea', resultado: { aplicado: true } }],
}), false, 'se bloqueó una afirmación respaldada por una herramienta aplicada');
const fuenteCanalAgente = readFileSync(join(RAIZ, 'src', 'mesero-agente', 'canalDelAgente.js'), 'utf8');
assert.match(fuenteCanalAgente, /esSolicitudDePedidoProgramado\(mensaje/,
  'el detector de programados existe pero quedó desconectado del adaptador productivo');
assert.match(fuenteCanalAgente, /respuestaAfirmaCambioSinAplicar\(salida\)/,
  'la barrera de afirmaciones existe pero quedó desconectada de la respuesta productiva');

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
const i86 = runner.indexOf("'086-estado-pedidos'");
assert.ok(i83 >= 0 && i84 > i83 && i85 > i84 && i86 > i85,
  'el predeploy debe aplicar 084, 085 y 086, en orden, antes del binario nuevo');

// ── Panel: sesión, menú, Restaurante y replay operativo ──────────────────
const leer = (ruta) => readFileSync(join(RAIZ, ruta), 'utf8');
const panel = leer('panel/index.html');
const captura = leer('panel/captura.js');
const mesas = leer('panel/mesas.html');
const server = leer('src/server.js');
const migracion086 = leer('migrations/086_estado_pedido_autoritativo.sql');

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

// XAB-0458: pago confirmado e impresión correcta, pero la fotografía JSON
// seguía pendiente_pago. Después de recuperar el proceso, el tablero debe usar
// el estado SQL nuevo y mantener el pedido visible para que se pueda entregar.
const tiendaPagadaRecuperada = pedidoActivoDesdeFila({
  estado: 'nuevo',
  negocio_id: NEGOCIO,
  entregado_at: null,
  datos: {
    folio: 'XAB-0458',
    canal: 'tienda_online',
    estado: 'pendiente_pago',
    pago_confirmado: true,
  },
});
assert.equal(tiendaPagadaRecuperada.estado, 'nuevo',
  'el estado SQL pagado debe reemplazar la fotografía pendiente_pago');
assert.equal(tiendaPagadaRecuperada.negocioId, NEGOCIO,
  'el pedido recuperado debe conservar el negocio de su columna SQL');
assert.match(migracion086, /UPDATE pedidos_activos[\s\S]*?datos->>'estado' IS DISTINCT FROM estado/,
  'la 086 debe reparar las fotografías ya desalineadas');
assert.match(migracion086, /BEFORE INSERT OR UPDATE OF estado, datos ON pedidos_activos/,
  'la 086 debe impedir nuevas desalineaciones de estado');
assert.ok(runner.indexOf("'086-estado-pedidos'") > runner.indexOf("'085-agente-outbox'"),
  'el runner productivo debe aplicar la 086 después de la 085');

// XAB-0481: el borrador omitió el extra de bistec, confundió una guarnición
// con tacos y descartó una dirección al rechazar una modalidad inferida.
const opcion = (nombre, precio_extra = 0) => ({ nombre, precio_extra, disponible: true });
const catalogo481 = [{ id: 48, nombre: 'Desayunos', productos: [
  { id: 107, nombre: 'Chilaquiles Mixtos', precio: 205, disponible: true, modificadores: [
    { nombre: 'Salsa', requerido: true, minimo: 1, maximo: 2, opciones: [opcion('Verde')] },
    { nombre: 'Proteína', requerido: true, minimo: 1, maximo: 2,
      opciones: [opcion('Huevos Estrellados'), opcion('Bistec en Salsa', 30)] },
    { nombre: 'Guarniciones', requerido: true, minimo: 1, maximo: 2,
      opciones: [opcion('Frijolitos con chorizo'), opcion('Papas a la mexicana')] },
  ] },
  { id: 501, nombre: 'Taco de papa a la mexicana', precio: 35, disponible: true, modificadores: [] },
] }];
const estado481 = estadoNuevo({ negocioId: NEGOCIO, conversacionId: 'agente:5218721242184' });
estado481.carrito.items = [
  { lid: 'linea-1', nombre: 'Chilaquiles Mixtos', cantidad: 1, notas: 'sin cebolla arriba',
    modificadores: [
      { grupo: 'Salsa', opciones: ['Verde'] },
      { grupo: 'Proteína', opciones: ['Huevos Estrellados'] },
      { grupo: 'Guarniciones', opciones: ['Frijolitos con chorizo'] },
    ] },
  { lid: 'linea-2', nombre: 'Chilaquiles Mixtos', cantidad: 1, notas: 'sin cebolla arriba',
    modificadores: [
      { grupo: 'Salsa', opciones: ['Verde'] },
      { grupo: 'Proteína', opciones: ['Huevos Estrellados', 'Bistec en Salsa'] },
      { grupo: 'Guarniciones', opciones: ['Frijolitos con chorizo'] },
    ] },
];
estado481.carrito.datos = { modalidad: 'entrega a domicilio', forma_pago: 'terminal',
  cliente: { nombre: 'Aide', direccion: 'Libramiento 1384' } };
const vista481 = vistaDelPedido({ carrito: estado481.carrito, catalogo: catalogo481,
  precios: { 'Chilaquiles Mixtos': 205, 'Taco de papa a la mexicana': 35 },
  reglas: { pedidos: { costo_envio: 60 } } });
assert.equal(vista481.subtotal, 440, 'el resumen omitió los $30 del bistec');
assert.equal(vista481.total, 500, 'el total no sumó extra y envío antes de confirmar');

const ejecutor481 = crearEjecutor({ estado: estado481, catalogo: catalogo481,
  precios: { 'Chilaquiles Mixtos': 205, 'Taco de papa a la mexicana': 35 },
  mensaje: 'Y papas a la mexicana', textoCiclo: 'Y papas a la mexicana' });
const busqueda481 = await ejecutor481.ejecutar('buscar_producto', { texto: 'papas a la mexicana' });
assert.equal(busqueda481.es_opcion_del_pedido, true,
  'Papas a la mexicana volvió a tratarse como taco en vez de guarnición');
assert.deepEqual(busqueda481.encontrados, []);
assert.equal(busqueda481.coincidencias_opcion.length, 2);

const estadoDireccion481 = estadoNuevo({ negocioId: NEGOCIO, conversacionId: 'direccion-481' });
const entrega481 = await crearEjecutor({ estado: estadoDireccion481, catalogo: catalogo481,
  precios: { 'Chilaquiles Mixtos': 205 },
  modalidades: ['recoger en tienda', 'entrega a domicilio'],
  mensaje: 'Dirección: Guardia Nacional frente al Banco Bienestar',
  textoCiclo: 'Dirección: Guardia Nacional frente al Banco Bienestar' })
  .ejecutar('definir_entrega', {
    modalidad: 'domicilio', direccion: 'Guardia Nacional frente al Banco Bienestar',
  });
assert.equal(entrega481.aplicado, true, 'la dirección se perdió junto con la modalidad inferida');
assert.equal(entrega481.codigo, 'modalidad_sin_respaldo');
assert.equal(estadoDireccion481.carrito.datos.modalidad, undefined);
assert.equal(estadoDireccion481.carrito.datos.cliente.direccion,
  'Guardia Nacional frente al Banco Bienestar');

const respuesta481 = aplicarRespuestaDeConfirmacion({ estado: estado481,
  salida: { texto: 'Confirmado por $470', operaciones: [{ herramienta: 'confirmar_pedido',
    resultado: { aplicado: true, folio: 'XAB-0481', total: 500, costo_envio: 60 } }] } });
assert.match(respuesta481.texto, /\$500 MXN/);
assert.doesNotMatch(respuesta481.texto, /\$470/);

let registros481 = 0;
const barrera481 = await confirmarYEmitir({
  negocioId: NEGOCIO, telefono: '5218721242184', canal: 'whatsapp', estado: estado481,
  pedido: { total: 470 }, emitir: async () => {}, guardar: async () => {},
  previsualizar: async () => ({ ok: true, preview: { total: 500 } }),
  registrar: async () => { registros481 += 1; return { id: 'NO-DEBE-EXISTIR' }; },
});
assert.equal(barrera481.ok, false);
assert.equal(registros481, 0, 'registró un pedido cuyo total canónico difería del confirmado');

console.log('OK: corte maestro, programados, afirmaciones guardadas, doble confirmación, sesión, menú, Restaurante, replay, XAB-0458 y XAB-0481 protegidos.');
