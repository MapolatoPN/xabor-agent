import assert from 'node:assert/strict';
import { estadoNuevo, crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { acusarDialogo } from '../src/mesero-agente/contratoConversacional.js';
import { sellarEstado } from '../src/mesero-agente/estadoCanonico.js';
import { preguntaPorOpcionesCompartidas } from '../src/mesero-agente/continuidadDeterminista.js';

// Fixture del contrato, sin clientes, conexiones ni efectos productivos.
const grupo = (nombre, opciones, maximo = 1) => ({ nombre, requerido: true, minimo: 1, maximo,
  opciones: opciones.map(nombre => ({ nombre, disponible: true })) });
const catalogo = [{ nombre: 'Carta de prueba', productos: [
  { id: 85, nombre: 'Chilaquiles Sencillos', precio: 195, disponible: true, modificadores: [
    grupo('Salsa', ['Suiza', 'Roja', 'Verde']), grupo('Proteína', ['Pechuga de pollo']),
    grupo('Guarniciones', ['Frijolitos naturales', 'Papas con chorizo'], 2),
  ] },
  { id: 112, nombre: 'Licuado', precio: 55, disponible: true, modificadores: [
    grupo('Medida', ['Chico', 'Grande 1 Litro']), grupo('Sabor', ['Platáno', 'Fresa', 'Melón', 'Papaya']),
    grupo('¿Fruta Extra?', ['Plátano', 'Fresa', 'Sin fruta extra', 'Melón', 'Papaya']),
    grupo('Complementos', ['Chocolate', 'Vainilla', 'Sin complementos'], 2),
    grupo('Tipo de leche', ['Entera', 'Deslactosada']), grupo('Endulzante', ['Azúcar', 'Splenda']),
  ] },
  { id: 113, nombre: 'Café americano', precio: 35, disponible: true },
] }];
const texto = text => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
// El importe es deliberadamente sintético: comprueba que una ambigüedad no
// autoriza un extra de pago, y que al elegirlo el motor sí suma su precio.
catalogo[0].productos[1].modificadores.find(g => g.nombre === '¿Fruta Extra?')
  .opciones.find(o => o.nombre === 'Fresa').precio_extra = 15;
export { catalogo as cartaLicuado };
const herramienta = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: name, name, input }] });
const guion = (...pasos) => async () => {
  assert(pasos.length, 'No se permite una llamada inesperada al modelo');
  return pasos.shift();
};
const noModelo = async () => { throw Error('Esta aclaración no necesita al modelo'); };
let numero = 0, fallos = 0, casos = 0;
const nuevo = () => estadoNuevo({ negocioId: 'local-licuado', conversacionId: `prueba-${++numero}` });
async function turno(e, mensaje, llamarModelo = noModelo, efectos = {}) {
  const r = await atenderTurnoConHerramientas({ estado: e, catalogo, mensaje,
    llamarModelo, efectos, turnoId: `turno-${++numero}`, modalidades: ['recoger en tienda'], metodosPago: ['efectivo'] });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.erroresProveedor, [], 'El guion no debe esconder llamadas inesperadas como fallos del proveedor');
  assert.equal(r.escalado, false, r.texto);
  sellarEstado(e, r.pedido);
  assert(acusarDialogo(e, r.dialogoId, r.texto));
  return r;
}
async function t(nombre, fn) {
  casos++;
  try { await fn(); console.log(`OK continuidad licuado: ${nombre}`); }
  catch (e) { fallos++; console.error(`FALLO continuidad licuado: ${nombre}: ${e.message}`); }
}
async function conLicuado() {
  const e = nuevo();
  await turno(e, 'Me agregas un licuado por favor', guion(
    herramienta('agregar_producto', { producto_id: '112', cantidad: 1 }), texto('¿De qué medida lo quieres?')));
  assert.equal(e.pendiente.grupo, 'Medida');
  return e;
}
const opciones = e => e.carrito.items.find(i => i.id === 112).modificadores;
const preguntarMedida = texto('Ya tienes tu licuado en el pedido, solo falta completarlo. ¿De qué medida lo quieres: Chico o Grande de 1 litro?');

for (const intentarAgregar of [true, false]) await t(`búsqueda del producto existente conserva pregunta (intento de agregar: ${intentarAgregar})`, async () => {
  const e = await conLicuado();
  const pasos = [herramienta('buscar_producto', { texto: 'licuado' })];
  if (intentarAgregar) pasos.push(herramienta('agregar_producto', { producto_id: '112', cantidad: 1 }));
  pasos.push(preguntarMedida);
  const r = await turno(e, 'Me agregas un licuado por favor', guion(...pasos));
  assert.equal(e.carrito.items.length, 1);
  assert.equal(e.carrito.items[0].cantidad, 1);
  assert.equal(e.pendiente?.grupo, 'Medida', 'La pregunta emitida debe quedar pendiente');
  assert.equal(e.dialogo.pendiente.grupo, 'Medida');
  assert.equal(e.pendiente.dialogo_id, r.dialogoId);
  const recargado = JSON.parse(JSON.stringify(e));
  await turno(recargado, 'Grande');
  assert.equal(recargado.pendiente.grupo, 'Sabor');
});

for (const mensaje of ['Plátano y fresa', 'Fresa y plátano', 'Plátano con fresa']) await t(`aclara el grupo sin inventar extras: ${mensaje}`, async () => {
  const e = await conLicuado(); await turno(e, 'Grande');
  const antes = JSON.stringify(e.carrito);
  const r = await turno(e, mensaje);
  assert.equal(JSON.stringify(e.carrito), antes);
  assert.equal(r.llamadasAlModelo, 0);
  assert.match(r.texto, /Sabor/);
  assert.match(r.texto, /Fruta Extra/);
  assert.match(r.texto, /coinciden|aparecen.*grupos/i);
  assert.equal(e.pendiente.grupo, 'Sabor');
});

await t('consulta y oferta nueva conservan su propio significado', async () => {
  const e = await conLicuado();
  const consulta = await turno(e, '¿Tienen café americano?', guion(
    herramienta('buscar_producto', { texto: 'Café americano' }), texto('Sí, contamos con Café americano.')));
  assert.match(consulta.texto, /Café americano/);
  assert.equal(e.pendiente?.tipo, 'aceptar_producto');
  const oferta = await turno(e, 'Quiero otra bebida', guion(
    herramienta('buscar_producto', { texto: 'Café americano' }), texto('Tenemos Café americano. ¿Quieres uno?')));
  assert.match(oferta.texto, /Café americano/);
  assert.equal(e.pendiente?.tipo, 'aceptar_producto');
  assert.equal(e.pendiente.producto_id, '113');
  assert.equal(e.carrito.items.length, 1);
});

await t('frase con condición no se reduce a elecciones', async () => {
  const e = await conLicuado(); await turno(e, 'Grande');
  const antes = JSON.stringify(e.carrito);
  const r = await turno(e, 'Plátano y fresa si no cuesta más', guion(texto('¿Qué deseas revisar?')));
  assert.equal(r.llamadasAlModelo, 1);
  assert.equal(JSON.stringify(e.carrito), antes);
});

await t('no reabre terminales ni elige entre dos renglones', async () => {
  const e = await conLicuado(); await turno(e, 'Grande');
  const pedido = crearEjecutor({ estado: e, catalogo }).vista();
  for (const terminal of [{ folio: 'YA-REGISTRADO' }, { confirmacionIncierta: true },
    { hechos: { escalado: true } }, { hechos: { cancelado: true } }]) {
    assert.equal(preguntaPorOpcionesCompartidas({ estado: { ...e, ...terminal }, pedido, mensaje: 'Plátano y fresa' }), null);
  }
  const dosLineas = { ...pedido, aclaraciones: [...pedido.aclaraciones,
    ...pedido.aclaraciones.map(a => ({ ...a, lid: 'otro-licuado' }))] };
  assert.equal(preguntaPorOpcionesCompartidas({ estado: e, pedido: dosLineas, mensaje: 'Plátano y fresa' }), null);
});

await t('recorrido reportado completo, recarga entre turnos y una confirmación', async () => {
  let e = nuevo(), confirmaciones = 0;
  const efectos = { confirmar: async () => { confirmaciones++; return { ok: true, folio: 'SIM-LICUADO' }; } };
  const enviar = async (mensaje, modelo = noModelo) => {
    e = JSON.parse(JSON.stringify(e));
    return turno(e, mensaje, modelo, efectos);
  };
  await enviar('Quiero unos chilaquiles suizos con pollo', guion(herramienta('agregar_producto', {
    producto_id: '85', cantidad: 1, opciones: [{ grupo: 'Salsa', opcion: 'Suiza' }, { grupo: 'Proteína', opcion: 'Pechuga de pollo' }],
  }), texto('¿Qué guarniciones prefieres?')));
  await enviar('Frijoles naturales y papas con chorizo');
  await enviar('Recoger');
  await enviar('Me agregas un licuado por favor', guion(herramienta('buscar_producto', { texto: 'licuado' }),
    herramienta('agregar_producto', { producto_id: '112', cantidad: 1 }), texto('¿Qué medida prefieres?')));
  await enviar('Me agregas un licuado por favor', guion(herramienta('buscar_producto', { texto: 'licuado' }),
    herramienta('agregar_producto', { producto_id: '112', cantidad: 1 }), preguntarMedida));
  assert.equal(e.pendiente?.grupo, 'Medida');
  await enviar('Grande');
  await enviar('Plátano y fresa');
  await enviar('Plátano');
  assert.equal(e.pendiente.grupo, '¿Fruta Extra?');
  await enviar('Fresa');
  await enviar('Chocolate y vainilla');
  await enviar('Entera y splenda');
  assert.equal(e.pendiente.tipo, 'pago');
  await enviar('Efectivo');
  assert.equal(e.pendiente.tipo, 'confirmar_resumen');
  assert.equal(e.carrito.items.length, 2);
  assert.equal(e.carrito.items.find(i => i.id === 112).cantidad, 1);
  assert.deepEqual(opciones(e).find(g => g.grupo === 'Sabor').opciones, ['Platáno']);
  assert.deepEqual(opciones(e).find(g => g.grupo === '¿Fruta Extra?').opciones, ['Fresa']);
  assert.deepEqual(opciones(e).find(g => g.grupo === 'Complementos').opciones, ['Chocolate', 'Vainilla']);
  assert.equal(crearEjecutor({ estado: e, catalogo }).vista().total, 265);
  assert.equal(confirmaciones, 0);
  await enviar('Sí, confirmo');
  await enviar('Sí, confirmo', guion(texto('Tu pedido quedó registrado.')));
  assert.equal(confirmaciones, 1);
});

assert.equal(fallos, 0, `${fallos}/${casos} casos de continuidad fallaron`);
console.log(`OK continuidad licuado: ${casos}/${casos}`);
