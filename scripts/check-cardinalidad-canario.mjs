import assert from 'node:assert/strict';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { estadoNuevo, estadoSerializable, validarOpciones, crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { fichaPorId } from '../src/mesero-agente/vistaDelPedido.js';
import { accionesParaOpcionesPendientes } from '../src/mesero-agente/continuidadDeterminista.js';
import { cardinalidadDeGrupo } from '../src/services/modificadores.js';

const grupo = (nombre, opciones, maximo) => ({ nombre, requerido: true, minimo: 1, maximo,
  opciones: opciones.map(nombre => ({ nombre, disponible: true })) });
const productos = [
  { id: 107, nombre: 'Chilaquiles Mixtos', precio: 205,
    modificadores: [grupo('Guarniciones', ['Frijolitos naturales', 'Frijolitos con chorizo', 'Papas con chorizo'], 2)] },
  { id: 112, nombre: 'Licuado', precio: 90, modificadores: [] },
  { id: 87, nombre: 'Omelette Clásico', precio: 189,
    modificadores: [grupo('Tortillas', ['Tortillas de harina', 'Tortillas de maiz', 'Tortillas mixtas', 'Sin tortillas'], 0)] },
  ...['Tacos Chicharrón Prensado', 'Taco de Huevo con Machacado', 'Taco de Barbacoa'].map((nombre, i) => ({
    id: [96,133,130][i], nombre, precio: 25, modificadores: [grupo('Tortilla', ['Harina', 'Maíz'], 1)],
  })),
].map(p => ({ ...p, disponible: true }));
const catalogo = [{ nombre: 'Menú', productos }];
const nuevo = () => {
  const estado = estadoNuevo({ negocioId: 'prueba', conversacionId: 'cardinalidad' });
  estado.carrito.items = productos.map(p => ({ id: p.id, lid: `l${p.id}`, nombre: p.nombre,
    cantidad: 1, modificadores: [], notas: '' }));
  estado.carrito.items[0].modificadores = [{ grupo: 'Guarniciones', opciones: ['Papas con chorizo'] }];
  estado.opcionesPendientes = [{ lid: 'l107', grupo: 'Guarniciones', tipo: 'eleccion_ambigua',
    maximo: 2, producto: 'Chilaquiles Mixtos', candidatos: ['Frijolitos naturales', 'Frijolitos con chorizo'] }];
  estado.foco = { tipo: 'opcion', linea_id: 'l107', grupo: 'Guarniciones' };
  return estado;
};
// La misma semántica que POS/Restaurante para todos los valores históricos.
for (const maximo of [0, '0', null, undefined, 1, 2]) {
  const ficha = fichaPorId(catalogo, 87); ficha.grupos[0].maximo = maximo;
  const dos = ['Tortillas de harina', 'Tortillas de maiz'].map(opcion => ({ grupo: 'Tortillas', opcion }));
  assert.equal(validarOpciones(ficha, dos).ok, 2 <= cardinalidadDeGrupo(ficha.grupos[0]).maximo);
  assert.equal(validarOpciones(ficha, dos.slice(0,1)).ok, true);
  assert.equal(validarOpciones(ficha, [{ grupo: 'Tortillas', opcion: 'Inventada' }]).ok, false);
}
const estado = nuevo();
const r = await atenderTurnoConHerramientas({ estado, catalogo, mensaje: 'Tortillas de maíz',
  llamarModelo: async () => { throw Error('La elección exacta no necesita proveedor'); } });
assert.equal(r.escalado, false);
assert.equal(r.llamadasAlModelo, 0);
assert.equal(r.operaciones.length, 1);
assert.equal(r.operaciones[0].argumentos.linea_id, 'l87');
assert.equal(r.operaciones[0].resultado.aplicado, true);
assert.match(r.texto, /Frijolitos naturales.*Frijolitos con chorizo/);
const durable = JSON.parse(JSON.stringify(estadoSerializable(estado)));
assert.deepEqual(durable.carrito.items[2].modificadores, [{ grupo: 'Tortillas', opciones: ['Tortillas de maiz'] }]);
assert(durable.carrito.items.slice(3).every(i => i.modificadores.length === 0));
assert.equal(durable.carrito.items.length, 6);
assert.equal(durable.opcionesPendientes.length, 1);
assert.equal(durable.hechos.confirmado, false);
// Una palabra compartida no elige tres tacos; el foco explícito sí elige uno.
const compartido = nuevo();
let acciones = accionesParaOpcionesPendientes({ estado: compartido,
  pedido: crearEjecutor({ estado: compartido, catalogo }).vista(), mensaje: 'Maíz' });
assert.equal(acciones.acciones.length, 0);
assert.equal(acciones.requiereInterpretacion, true);
compartido.foco = { tipo: 'opcion', linea_id: 'l96', grupo: 'Tortilla' };
acciones = accionesParaOpcionesPendientes({ estado: compartido,
  pedido: crearEjecutor({ estado: compartido, catalogo }).vista(), mensaje: 'Maíz' });
assert.equal(acciones.acciones.length, 1);
assert.equal(acciones.acciones[0].argumentos.linea_id, 'l96');
// Sin límite tampoco significa elegir solo una en la continuación determinista.
const unico = nuevo();unico.carrito.items = [unico.carrito.items[2]];unico.opcionesPendientes = [];unico.foco = null;
const multi = await atenderTurnoConHerramientas({ estado: unico, catalogo,
  mensaje: 'Tortillas de harina y tortillas de maiz',
  llamarModelo: async () => { throw Error('Opciones inequívocas sin límite'); } });
assert.equal(multi.escalado, false);
assert.equal(multi.pedido.lineas[0].opciones.length, 2);
console.log('OK: maximo cero sin límite; elección exacta del omelette durable y sin extenderla a los tacos.');
