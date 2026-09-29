import assert from 'node:assert/strict';
import { respuestaDesdePedido } from '../src/mesero-agente/recuperacionDelTurno.js';
import { resumenConPromociones } from '../src/mesero-agente/canalDelAgente.js';
const productos=[
  ['Combito de Chilaquiles',225,['Suiza','Pechuga de pollo','Hotcakes','Cajeta']],
  ['Omelette Clásico',189,['frijoles con chorizo','papa con chorizo','Tortillas de maiz']],
  ['Chilaquiles Sencillos',195,['Mole','Pechuga de pollo','Papas con chorizo','Papas a la mexicana']],
  ['Hotcakes Tradicionales',139,['Tradicional','Fruta mixta']],
  ['Hotcakes Tradicionales',169,['Nutella','Fresa y platano']],
];
const pedido={lineas:productos.map(([producto,precio_unitario,opciones])=>({producto,precio_unitario,cantidad:1,
  opciones:opciones.map(opcion=>({opcion})),nota:''})),falta:[],aclaraciones:[],subtotal:917,costo_envio:60,total:977,
  modalidad:'entrega a domicilio',forma_pago:'efectivo',cliente:{direccion:'Calle de prueba 208, Colonia de prueba'}};
const render=p=>respuestaDesdePedido({estado:{},pedido:p,modalidades:['entrega a domicilio'],metodosPago:[],requierePago:true});
const texto=resumenConPromociones(render(pedido),{total:838,promociones:[{nombre:'Martes 2x1',descuento:139}]});
assert.match(texto,/^\*Revisa tu pedido\*\n\n\*1 × Combito de Chilaquiles · \$225\*/);
assert.equal((texto.match(/\n\n\*1 × /g)||[]).length,5,'un bloque separado por renglón');
for(const [nombre,,opciones] of productos)for(const valor of [nombre,...opciones])assert(texto.includes(valor));
assert.match(texto,/Subtotal: \$917\nEnvío: \$60\nPromoción Martes 2x1: -\$139\n\*Total: \$838\*\n¿Confirmas este pedido\?$/);
assert(texto.length<=1024,`los cinco platos de la captura deben conservar botones (${texto.length})`);
assert.doesNotMatch(texto,/borrador contiene|Infinity|undefined|NaN/);
const doble=render({...pedido,lineas:[{...pedido.lineas[0],cantidad:2}],subtotal:450,total:510});
assert.match(doble,/\*2 × Combito de Chilaquiles · \$450\*\n\$225 c\/u/);
const larga=render({...pedido,lineas:Array(12).fill(pedido.lineas[0])});
assert.equal((larga.match(/\*1 × Combito/g)||[]).length,12,'nunca truncar productos por caber en botones');
console.log(`OK resumen legible: cinco platos, opciones completas, bloques, promoción y total real (${texto.length}/1024 caracteres).`);
