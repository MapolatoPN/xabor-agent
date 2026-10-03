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
assert.match(salida.texto, /Chilaquiles.*\nModalidad: Recoger en tienda.*\nForma de pago: Efectivo.*\n\*Total: \$195\*\n¿Confirmas/s);
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
// El resumen repite lo que el cliente escribió: «Frente al Registro Civil» no
// es Xabor diciendo que registró algo. Un «hola» con el resumen pendiente no
// puede acabar en TEXTO_CAMBIO_NO_GUARDADO ni en un handoff (01-oct-2026).
const conCliente = (cliente, modalidad = 'entrega a domicilio') => {
  const e = nuevo();
  e.carrito.datos = { modalidad, forma_pago: 'efectivo', cliente };
  return e;
};
const llamadasAntesDelResumen = llamadas;
for (const [cliente, modalidad, lineasDelCliente] of [
  [{ nombre: 'Ana', direccion: 'Frente al Registro Civil' }, undefined,
    ['Dirección: Frente al Registro Civil']],
  [{ nombre: 'Ana', direccion: 'Atrás del registro de agua' }, undefined,
    ['Dirección: Atrás del registro de agua']],
  [{ nombre: 'Ana', direccion: 'Hidalgo 210', referencia: 'Frente al Registro Civil' }, undefined,
    ['Referencia: Frente al Registro Civil']],
  [{ nombre: 'Ana', referencia: 'Atrás del registro de agua' }, 'recoger en tienda',
    ['Referencia: Atrás del registro de agua']],
  // Cada etiqueta de texto libre del resumen, con la palabra dentro: si alguien
  // renombra una en respuestaDesdePedido sin tocar el detector, cae aquí. El
  // teléfono lo pone Xabor desde WhatsApp (dígitos) y no necesita retirarse.
  [{ nombre: 'Ana del Registro', telefono: '8781234567', calle: 'Callejón del Registro',
    numero_exterior: 'S/N junto al registro', numero_interior: 'Junto al registro de luz',
    colonia: 'Registro Civil', entre_calles: 'Registro y Juárez',
    referencia: 'Atrás del registro de agua', direccion: 'Frente al Registro Civil' }, undefined,
  ['Nombre: Ana del Registro', 'Teléfono: 8781234567', 'Calle: Callejón del Registro',
    'Número exterior: S/N junto al registro', 'Interior: Junto al registro de luz',
    'Colonia: Registro Civil', 'Entre calles: Registro y Juárez',
    'Referencia: Atrás del registro de agua', 'Dirección: Frente al Registro Civil']],
]) {
  const resumen = await ejecutar(conCliente(cliente, modalidad), 'Hola');
  for (const linea of lineasDelCliente) {
    assert(resumen.texto.split('\n').includes(linea), `el caso no llegó al resumen: ${linea}`);
  }
  assert.equal(resumen.operaciones.length, 0);
  assert.equal(resumen.escalado, false);
  assert.equal(respuestaAfirmaCambioSinAplicar(resumen), false,
    `un dato del cliente en el resumen se leyó como afirmación de Xabor: ${lineasDelCliente.join(' | ')}`);
}
assert.equal(llamadas, llamadasAntesDelResumen, 'el resumen debía salir del estado, sin llamar al modelo');
// Retirar los datos del cliente no puede tapar una afirmación real del modelo
// alrededor de ese mismo resumen.
const resumenConRegistro = (await ejecutar(
  conCliente({ nombre: 'Ana', direccion: 'Frente al Registro Civil' }), 'Hola')).texto;
for (const afirmacion of [
  `Listo, ya anoté tu dirección.\n${resumenConRegistro}`,
  `Va agregado tu café.\n${resumenConRegistro}`,
  `${resumenConRegistro}\nTe lo registro enseguida.`,
]) {
  assert.equal(respuestaAfirmaCambioSinAplicar({ texto: afirmacion, operaciones: [] }), true,
    `una afirmación sin efecto pasó escondida junto al resumen: ${afirmacion.split('\n')[0]}`);
}
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
console.log('OK: saludo y redacción recuperables conservan el borrador; efectos inciertos siguen protegidos; los datos del cliente en el resumen no se leen como afirmación.');
