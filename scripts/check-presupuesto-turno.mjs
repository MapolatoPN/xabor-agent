import assert from 'node:assert/strict';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { estadoNuevo, estadoSerializable } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { puedeCerrarConAvance } from '../src/mesero-agente/recuperacionDelTurno.js';

const nombres = ['Taco de Chicharrón Prensado', 'Taco de Huevo con Machacado', 'Taco de Barbacoa'];
const catalogo = [{ nombre: 'Tacos', productos: nombres.map((nombre, i) => ({
  id: i + 1, nombre, disponible: true, precio: 25,
  modificadores: [{ nombre: 'Tortilla', requerido: true, minimo: 1, maximo: 1,
    opciones: ['Harina', 'Maíz'].map(nombre => ({ nombre, disponible: true })) }],
})) }];
const nuevo = () => estadoNuevo({ negocioId: 'prueba', conversacionId: 'presupuesto' });
async function recorrido(topeIteraciones = 6, carta = catalogo) {
  const estado = nuevo(); let llamadas = 0;
  const r = await atenderTurnoConHerramientas({ estado, catalogo: carta, topeIteraciones,
    mensaje: 'Agrega 1 taco de chicharrón prensado, 1 taco de huevo con machacado y 1 taco de barbacoa',
    llamarModelo: async () => {
      const paso = llamadas++, i = Math.floor(paso / 2);
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `paso-${paso}`,
        name: paso % 2 ? 'agregar_producto' : 'buscar_producto',
        input: paso % 2 ? { producto_id: String(i + 1), cantidad: 1 } : { texto: nombres[i] } }] };
    },
  });
  assert.equal(llamadas, topeIteraciones, 'No aumenta el presupuesto ni repite llamadas');
  assert.equal(r.escalado, false);
  assert.equal(r.confirmado, false);
  assert.equal(r.recuperacion, 'presupuesto_con_avance_verificado');
  assert(!r.operaciones.some(op => ['pedir_humano', 'confirmar_pedido'].includes(op.herramienta)));
  assert.match(r.texto, /Hasta ahora tu borrador contiene/);
  assert.match(r.texto, /Si falta algún producto o cambio/);
  assert.doesNotMatch(r.texto, /¿Confirmas|pedido completo|equipo/);
  const guardado = JSON.parse(JSON.stringify(estadoSerializable(estado)));
  assert.equal(guardado.carrito.items.length, Math.floor(topeIteraciones / 2));
  return r;
}
const completo = await recorrido();
for (const nombre of nombres) assert(completo.texto.includes(nombre));
assert.match(completo.texto, /Harina.*Maíz/);
const parcial = await recorrido(2);
assert(parcial.texto.includes(nombres[0]));
assert(!parcial.texto.includes(nombres[1]));
assert(!parcial.texto.includes(nombres[2]));
// Incluso sin grupos pendientes, no confunde fin del presupuesto con pedido completo.
await recorrido(2, [{ ...catalogo[0], productos: catalogo[0].productos.map(p => ({ ...p, modificadores: [] })) }]);
const aplicada = { herramienta: 'agregar_producto', resultado: { aplicado: true, estado: 'ok' } };
for (const estado of [{ ...nuevo(), folio: 'XAB-1' }, { ...nuevo(), confirmacionIncierta: true },
  { ...nuevo(), hechos: { confirmado: true } }, { ...nuevo(), hechos: { fallido: true } },
  { ...nuevo(), hechos: { escalado: true } }, { ...nuevo(), evento: {} }]) {
  assert.equal(puedeCerrarConAvance(estado, [aplicada]), false);
}
for (const herramienta of ['confirmar_pedido', 'cancelar_pedido', 'pedir_humano', 'enviar_menu',
  'registrar_solicitud_evento', 'herramienta_nueva']) {
  assert.equal(puedeCerrarConAvance(nuevo(), [aplicada, { herramienta, resultado: { aplicado: true } }]), false);
}
for (const resultado of [{ aplicado: false }, { aplicado: true, estado: 'ilegal' },
  { aplicado: true, parcial: true }, { aplicado: true, error: 'timeout' }]) {
  assert.equal(puedeCerrarConAvance(nuevo(), [aplicada, { ...aplicada, resultado }]), false);
}
assert.equal(puedeCerrarConAvance(nuevo(), []), false);
const rechazado = await atenderTurnoConHerramientas({ estado: nuevo(), catalogo, mensaje: 'Agrega un taco',
  topeIteraciones: 1, llamarModelo: async () => ({ stop_reason: 'tool_use', content: [{
    type: 'tool_use', id: 'invalido', name: 'agregar_producto', input: { producto_id: '999' },
  }] }) });
assert.equal(rechazado.motivoCierre, 'sin_iteraciones');
assert(rechazado.operaciones.some(op => op.herramienta === 'pedir_humano'));
console.log('OK: presupuesto agotado conserva avances, muestra omisiones posibles y mantiene barreras de efectos inciertos.');
