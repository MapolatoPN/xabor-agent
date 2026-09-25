import assert from 'node:assert/strict';
import { estadoNuevo, crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { accionesParaOpcionesPendientes } from '../src/mesero-agente/continuidadDeterminista.js';
import { politicaDelTurno, opcionNegativaExplicita } from '../src/mesero-agente/politicaDelTurno.js';
import { alcanceDePruebaPermite, permiteAtencionEnPrueba } from '../src/mesero-agente/alcanceDePrueba.js';

const grupo = (nombre, opciones, maximo = 1) => ({ nombre, requerido: true, minimo: 1, maximo,
  opciones: opciones.map((nombre) => ({ nombre, disponible: true })) });
const catalogo = [{ nombre: 'Bebidas', productos: [{ id: 112, nombre: 'Licuado', disponible: true, precio: 55,
  modificadores: [grupo('Medida', ['Chico', 'Grande 1 Litro']), grupo('Sabor', ['Platáno', 'Fresa']),
    grupo('¿Fruta Extra?', ['Plátano', 'Fresa', 'Sin fruta extra']),
    grupo('Complementos', ['Chocolate', 'Vainilla', 'Canela'], 3)] }] }];
const nuevo = () => {
  const e = estadoNuevo({ negocioId: 'contrato', conversacionId: 'c1' });
  e.carrito.items = [{ id: 112, lid: 'l1', nombre: 'Licuado', cantidad: 1, modificadores: [], notas: '' }];
  return e;
};
const herramienta = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t-${name}`, name, input }] });
const texto = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const piloto = { bot_whatsapp_solo_prueba: 'true', mesero_agente_telefonos: '528199001122', mesero_agente_porcentaje: '100' };
assert.equal(alcanceDePruebaPermite(piloto, '5218199001122'), true);
assert.equal(alcanceDePruebaPermite(piloto, '5218199001133'), false);
assert.equal(alcanceDePruebaPermite(piloto, '18199001122'), false, 'Otro país no comparte la autorización por sus últimos diez dígitos');
assert.equal(alcanceDePruebaPermite({ ...piloto, mesero_agente_telefonos: '' }, '5218199001122'), false);
assert.equal(alcanceDePruebaPermite({ bot_whatsapp_solo_prueba: 'incorrecto' }, '5218199001122'), false);
assert.equal(await permiteAtencionEnPrueba('prueba', '5218199001122', async () => { throw Error('base no disponible'); }), false);

// Consultar nunca equivale a elegir, incluso sin signos de interrogación.
for (const mensaje of ['Tienen licuados?', 'tienen licuados', '¿Qué sabores hay?', 'Cuánto cuesta el licuado', 'Quiero saber si tienen licuados']) {
  assert(politicaDelTurno(mensaje).soloLectura);
  const e = nuevo(); const antes = JSON.stringify(e.carrito);
  const r = await crearEjecutor({ estado: e, catalogo, mensaje }).ejecutar('agregar_producto', { producto_id: '112', cantidad: 1 });
  assert.equal(r.aplicado, false); assert.equal(JSON.stringify(e.carrito), antes);
}
assert.equal(politicaDelTurno('¿Tienen licuados? Agrega uno').soloLectura, false);
assert.equal(politicaDelTurno('No, el viernes, no hay problema, perfecto').soloLectura, false);

// Una opción que expresa ausencia conserva su significado también al completar
// dos grupos en el mismo mensaje, sin depender del modelo para rescatarla.
const cartaLeche = [{ nombre: 'Bebidas', productos: [{ id: 112, nombre: 'Licuado', disponible: true, precio: 55,
  modificadores: [grupo('Leche', ['Entera', 'Deslactosada']), grupo('Endulzante', ['Azucar normal', 'Splenda', 'Sin azucar'])] }] }];
const leche = nuevo();
leche.foco = { tipo: 'opcion', linea_id: 'l1', grupo: 'Leche' };
const sinAzucar = await atenderTurnoConHerramientas({ estado: leche, catalogo: cartaLeche,
  mensaje: 'Leche entera y sin azúcar',
  llamarModelo: async () => { throw Error('Ambas elecciones explícitas deben resolverse sin modelo'); } });
assert.equal(sinAzucar.escalado, false);
assert.deepEqual(sinAzucar.pedido.lineas[0].opciones.map(o => o.opcion).sort(), ['Entera', 'Sin azucar']);
assert.equal(opcionNegativaExplicita('Sin azucar', 'Quita la opción sin azúcar'), false);
assert.equal(opcionNegativaExplicita('Sin azucar', 'No quiero sin azúcar'), false);
assert.equal(opcionNegativaExplicita('Sin azucar', 'Leche entera y sin azúcar'), true);

// Un nombre compartido se interpreta en contexto, no se reparte en TODOS los grupos.
const e = nuevo(); const v = crearEjecutor({ estado: e, catalogo }).vista();
const r = accionesParaOpcionesPendientes({ estado: e, pedido: v,
  mensaje: 'Grande de plátano con fresa, chocolate, vainilla y canela' });
assert.equal(r.requiereInterpretacion, true);
assert.equal(r.ambiguas.length, 0);
assert(r.acciones.every((a) => a.argumentos.opciones.every((o) => !['Sabor', '¿Fruta Extra?'].includes(o.grupo))));

// La respuesta a «Fruta extra» no puede reemplazar el sabor ya guardado.
e.carrito.items[0].modificadores = [{ grupo: 'Sabor', opciones: ['Platáno'] }];
e.foco = { tipo: 'opcion', linea_id: 'l1', grupo: '¿Fruta Extra?' };
const ex = crearEjecutor({ estado: e, catalogo, mensaje: 'Fresa' });
assert.equal((await ex.ejecutar('modificar_linea', { linea_id: 'l1', opciones: [{ grupo: 'Sabor', opcion: 'Fresa' }] })).aplicado, false);
assert.equal((await ex.ejecutar('modificar_linea', { linea_id: 'l1', opciones: [{ grupo: '¿Fruta Extra?', opcion: 'Fresa' }] })).aplicado, true);
assert.equal(ex.vista().lineas[0].opciones.find((o) => o.grupo === 'Sabor').opcion, 'Platáno');
const continuacion = nuevo();
continuacion.foco = { tipo: 'opcion', linea_id: 'l1', grupo: 'Medida' };
assert.equal((await crearEjecutor({ estado: continuacion, catalogo,
  mensaje: 'Grande de plátano con fresa, chocolate, vainilla y canela' }).ejecutar('agregar_producto',
{ producto_id: '112', cantidad: 1 })).aplicado, false);
assert.equal(continuacion.carrito.items.length, 1);
assert.equal((await crearEjecutor({ estado: continuacion, catalogo,
  mensaje: 'El licuado grande de plátano' }).ejecutar('agregar_producto',
{ producto_id: '112', cantidad: 1 })).aplicado, false);

// El mismo fragmento tampoco autoriza que el modelo llene dos grupos.
const ambos = nuevo();
assert.equal((await crearEjecutor({ estado: ambos, catalogo, mensaje: 'Fresa' }).ejecutar('modificar_linea', {
  linea_id: 'l1', opciones: [{ grupo: 'Sabor', opcion: 'Fresa' }, { grupo: '¿Fruta Extra?', opcion: 'Fresa' }],
})).aplicado, false);
const separados = crearEjecutor({ estado: nuevo(), catalogo, mensaje: 'Fresa' });
assert.equal((await separados.ejecutar('modificar_linea', {
  linea_id: 'l1', opciones: [{ grupo: 'Sabor', opcion: 'Fresa' }],
})).aplicado, true);
assert.equal((await separados.ejecutar('modificar_linea', {
  linea_id: 'l1', opciones: [{ grupo: '¿Fruta Extra?', opcion: 'Fresa' }],
})).aplicado, false, 'Dividir las llamadas no permite reutilizar la misma mención en otro grupo');

// Una redacción inválida durante una consulta recupera LA CONSULTA, no el carrito.
let llamada = 0;
const consulta = await atenderTurnoConHerramientas({ estado: nuevo(), catalogo, mensaje: 'Tienen licuados?',
  llamarModelo: async (p) => {
    assert(!p.tools.some((t) => t.name === 'agregar_producto'));
    return ++llamada === 1 ? herramienta('buscar_producto', { texto: 'licuados' }) : texto('Listo, te registré el pedido.');
  } });
assert.match(consulta.texto, /Sí, contamos con Licuado/);
assert.doesNotMatch(consulta.texto, /Tu borrador|Confirmas/);
assert.equal(consulta.escalado, false);

// Una respuesta parcial se descarta entera; reintentar no ejecuta sus herramientas.
let intentos = 0;
const parcial = nuevo();
const salida = await atenderTurnoConHerramientas({ estado: parcial, catalogo, mensaje: 'Tienen licuados?',
  llamarModelo: async () => ++intentos === 1
    ? { ...herramienta('agregar_producto', { producto_id: '112', cantidad: 1 }), stop_reason: 'max_tokens' }
    : texto('Sí, con gusto te comparto las opciones.') });
assert.equal(intentos, 2); assert.equal(salida.escalado, false);
assert.equal(parcial.carrito.items.length, 1); assert.equal(salida.operaciones.length, 0);

// La mención ambigua del PRIMER mensaje también se conserva si el modelo
// guarda solo la opción inequívoca que ya satisface el mínimo del catálogo.
const cartaGuarniciones = [{ nombre: 'Desayunos', productos: [{ id: 85, nombre: 'Chilaquiles', precio: 195,
  disponible: true, modificadores: [grupo('Guarniciones', ['Frijolitos naturales', 'Frijolitos con chorizo', 'Papas a la mexicana'], 2)] }] }];
const inicial = estadoNuevo({ negocioId: 'contrato', conversacionId: 'inicial' });
const primerEjecutor = crearEjecutor({ estado: inicial, catalogo: cartaGuarniciones,
  mensaje: 'Quiero chilaquiles con frijolitos y papas a la mexicana' });
const parcialInicial = await primerEjecutor.ejecutar('agregar_producto', { producto_id: '85', cantidad: 1,
  opciones: [{ grupo: 'Guarniciones', opcion: 'Frijolitos naturales' },
    { grupo: 'Guarniciones', opcion: 'Papas a la mexicana' }] });
assert.equal(parcialInicial.aplicado, true, 'El producto explícito no se pierde por una opción ambigua');
assert.equal(parcialInicial.parcial, true);
assert.equal(inicial.carrito.items.length, 1);
assert.deepEqual(primerEjecutor.vista().lineas[0].opciones.map(o => o.opcion), ['Papas a la mexicana'],
  'El modelo no puede inventar naturales cuando el cliente solo dijo frijolitos');
assert.equal(primerEjecutor.vista().estado, 'aclarando');
assert.equal(inicial.opcionesPendientes.length, 1);
const recargado = JSON.parse(JSON.stringify(inicial));
const aclarado = await atenderTurnoConHerramientas({ estado: recargado, catalogo: cartaGuarniciones,
  mensaje: 'Naturales', modalidades: ['recoger en tienda', 'entrega a domicilio'],
  llamarModelo: async () => { throw Error('La elección debe sobrevivir sin historial ni modelo'); } });
assert.equal(aclarado.escalado, false);
assert.deepEqual(aclarado.pedido.lineas[0].opciones.map(o => o.opcion).sort(), ['Frijolitos naturales', 'Papas a la mexicana']);
console.log('OK contrato del turno: consulta sin escritura, elecciones con alcance y recuperación limitada sin repetir efectos.');
