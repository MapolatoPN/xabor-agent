import assert from 'node:assert/strict';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { estadoNuevo, crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { puedeRecuperarSinEfectos, saludoDelNegocio } from '../src/mesero-agente/recuperacionDelTurno.js';
import { respuestaAfirmaCambioSinAplicar } from '../src/mesero-agente/seguridadConversacional.js';

const catalogo = [{ nombre: 'Prueba', productos: [{ id: 1, nombre: 'Chilaquiles',
  precio: 195, disponible: true, modificadores: [] }] }];
const nuevo = () => {
  const estado = estadoNuevo({ negocioId: 'prueba', conversacionId: 'retorno' });
  estado.carrito = { items: [{ id: 1, lid: 'l1', nombre: 'Chilaquiles', cantidad: 1,
    modificadores: [], notas: '' }], datos: { modalidad: 'recoger en tienda', forma_pago: 'efectivo' } };
  return estado;
};
let llamadas = 0;
const ejecutar = (estado, mensaje, texto = 'Listo, te registré el pedido.') => atenderTurnoConHerramientas({
  estado, mensaje, catalogo, modalidades: ['recoger en tienda', 'entrega a domicilio'],
  llamarModelo: async () => { llamadas += 1; return { stop_reason: 'end_turn',
    content: [{ type: 'text', text: texto }] }; },
});
const estado = nuevo();
estado.programacionRequerida = true;
const vista = crearEjecutor({ estado, catalogo }).vista();
assert.equal(vista.estado, 'armando');
assert(vista.falta.includes('programacion'));
assert.equal(vista.resumen.completo, false);
const carrito = JSON.stringify(estado.carrito);
let salida = await ejecutar(estado, 'Hola');
assert.equal(llamadas, 0);
assert.equal(salida.escalado, false);
assert.equal(salida.recuperacion, 'saludo_desde_estado');
assert.match(salida.texto, /fecha.*hoy.*otra fecha/);
assert.equal(JSON.stringify(estado.carrito), carrito);
assert.equal(estado.programacionRequerida, true);
salida = await ejecutar(estado, 'Continuamos');
assert.equal(llamadas, 1);
assert.equal(salida.recuperacion, 'afirmacion_sin_efectos');
assert.equal(respuestaAfirmaCambioSinAplicar(salida), false);
assert.equal(salida.operaciones.length, 0);
assert.equal(salida.escalado, false);
const listo = nuevo();
salida = await ejecutar(listo, 'Hola');
assert.match(salida.texto, /Chilaquiles.*\nModalidad: recoger en tienda.*\nForma de pago: efectivo.*\nTotal: \$195.*\n¿Confirmas/s);
assert.equal(listo.hechos.confirmado, false);
for (const protegido of [{ ...estado, confirmacionIncierta: true },
  { ...estado, hechos: { confirmado: true } }, { ...estado, hechos: { fallido: true } },
  { ...estado, evento: { tipo: 'catering' } }]) {
  assert.equal(puedeRecuperarSinEfectos(protegido), false);
}
assert.equal(puedeRecuperarSinEfectos(estado, [{ herramienta: 'confirmar_pedido',
  resultado: { aplicado: false } }]), false);
assert.equal(puedeRecuperarSinEfectos(estado, [{ herramienta: 'modificar_linea',
  resultado: { aplicado: false } }]), false);
assert.equal(respuestaAfirmaCambioSinAplicar({ texto: 'Listo, te registré el pedido.', operaciones: [] }), true);
const reglasSaludo = { bot: { saludo: 'Hola, muy buen día, como podemos servirte?',
  tono: 'amable, calido, cortes, servicial, juvenil, respetuoso' } };
for (const [instante, franja] of [
  ['2026-09-25T14:00:00Z', 'buenos días'],
  ['2026-09-25T20:00:00Z', 'buenas tardes'],
  ['2026-09-26T01:00:00Z', 'buenas noches'],
]) {
  const saludo = saludoDelNegocio({ reglas: reglasSaludo, zonaDelNegocio: 'America/Matamoros', ahora: new Date(instante) });
  assert.equal(saludo, `Hola, muy ${franja}, como podemos servirte?`);
}
assert.match(saludoDelNegocio({ ahora: new Date('2026-09-25T14:00:00Z'),
  zonaDelNegocio: 'America/Matamoros' }), /Buenos días.*Con gusto.*Cómo podemos ayudarte/);
assert.doesNotMatch(saludoDelNegocio({ reglas: { bot: { saludo: 'Listo, te registré el pedido.' } } }), /registré/);
const inicio = estadoNuevo({ negocioId: 'prueba', conversacionId: 'saludo-configurado' });
const bienvenida = await atenderTurnoConHerramientas({ estado: inicio, mensaje: 'Hola', catalogo,
  reglas: reglasSaludo, zonaDelNegocio: 'America/Matamoros',
  llamarModelo: async () => { throw new Error('Un saludo no requiere el modelo'); } });
assert.match(bienvenida.texto, /^Hola, muy (?:buenos días|buenas tardes|buenas noches), como podemos servirte\?$/);
assert.equal(bienvenida.escalado, false);
assert.equal(bienvenida.operaciones.length, 0);
assert.equal(inicio.carrito.items.length, 0);
console.log('OK: saludo y redacción recuperables conservan el borrador; efectos inciertos siguen protegidos.');
