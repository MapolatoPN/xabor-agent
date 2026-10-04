// Qué Flows publica cada alcance de publicar-flows-pedido.mjs, y cómo se
// llaman en Meta. Puro (sin Meta ni base): así las pruebas cubren el alcance
// sin tocar la red. Publicar sigue siendo una escritura explícita en Meta.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { definicionProductos,definicionConfigurar,definicionPedidoContinuo } from './definicion-flows-pedido.mjs';
import { definicionFlowRepetible } from './definicion-flow-repetible.mjs';
import { definicionFlowCategorias } from './definicion-flow-categorias.mjs';
import { definicionFlowEditar } from './definicion-flow-editar.mjs';
import { definicionFlowCarrito } from './definicion-flow-carrito.mjs';
import { definicionFlowTienda,validarFlowTienda,nombreFlowTienda } from './definicion-flow-tienda.mjs';

export const ALCANCES_FLOWS=['pedido','repetible','categorias','editar','carrito','carrito-beta',
  'categorias-direccion','carrito-direccion','carrito-direccion-beta',
  'categorias-direccion-nota','carrito-direccion-nota','carrito-direccion-nota-beta',
  // Contrato tienda_v1 (formulario «tienda» con fotos): un Flow propio, con
  // endpoint, que ya trae la dirección y la nota. Se activa con activar-flows-tienda.mjs.
  'tienda'];
// Los Flows con endpoint (data_exchange cifrado): se crean con endpoint_uri y
// publicarlos exige la clave de cifrado verificada en Meta.
export const TIPOS_CON_ENDPOINT=['repetible','categorias','carrito','tienda'];
export const ENDPOINT_FLOWS='https://xabor.mx/webhook/flows/pedido';

/** [[tipo, definicion]] de un alcance (sin alcance: «productos» y «configurar», los de siempre). */
export function flowsDelAlcance(alcance) {
  assert(!alcance || ALCANCES_FLOWS.includes(alcance),'Alcance inválido');
  // Contrato direccion_v1: mismos tipos (endpoint y cifrado), otra definición y,
  // por su sha, otro Flow en Meta. Activarlos es otro paso (activar-flows-direccion.mjs).
  const conDireccion=alcance?.includes('-direccion');
  // Contrato nota_v1 (solo con dirección): «Nota del pedido» en «Entrega y pago».
  // Otro Flow más; se activa con activar-flows-nota.mjs.
  const conNota=alcance?.includes('-nota');
  const flows=['carrito','carrito-beta','carrito-direccion','carrito-direccion-beta','carrito-direccion-nota','carrito-direccion-nota-beta'].includes(alcance)
    ? [['carrito',definicionFlowCarrito({duplicar:alcance.endsWith('-beta'),direccion:conDireccion,nota:conNota})]] : alcance==='editar' ? [['editar',definicionFlowEditar()]]
    : alcance==='tienda' ? [['tienda',definicionFlowTienda()]]
    : ['categorias','categorias-direccion','categorias-direccion-nota'].includes(alcance) ? [['categorias',definicionFlowCategorias({direccion:conDireccion,nota:conNota})]] : alcance==='repetible' ? [['repetible',definicionFlowRepetible()]] : alcance==='pedido' ? [['pedido',definicionPedidoContinuo()]]
    : [['productos',definicionProductos()],['configurar',definicionConfigurar()]];
  for(const [tipo,definicion] of flows) {
    if(conDireccion)assert(Array.isArray(definicion.routing_model.DIRECCION) && definicion.data_api_version==='3.0','Falta la pantalla DIRECCION');
    if(conNota)assert(JSON.stringify(definicion.screens.find(s=>s.id==='ENTREGA')).includes('"name":"nota"'),'Falta la nota del pedido en ENTREGA');
    if(tipo==='tienda') {
      // La tienda siempre lleva dirección y nota, y pasa su validador estático (límites de Meta).
      assert.deepEqual(validarFlowTienda(definicion),[],'La definición de la tienda no pasa su validador');
      assert(Array.isArray(definicion.routing_model.DIRECCION) && definicion.data_api_version==='3.0','Falta la pantalla DIRECCION');
      assert(JSON.stringify(definicion.screens.find(s=>s.id==='ENTREGA')).includes('"name":"nota"'),'Falta la nota del pedido en ENTREGA');
    }
  }
  return flows;
}

/** El nombre del Flow en Meta: xabor_<tipo>_agrupado_<12 hex del sha256 del JSON>. */
export function nombreDelFlow(tipo,definicion) {
  const sha=createHash('sha256').update(JSON.stringify(definicion)).digest('hex');
  const name=`xabor_${tipo}_agrupado_${sha.slice(0,12)}`;
  // El de la tienda es el que exige activar-flows-tienda.mjs.
  if(tipo==='tienda')assert.equal(name,nombreFlowTienda(definicion),'El nombre de la tienda debe ser el que exige activar-flows-tienda.mjs');
  return {sha,name};
}
