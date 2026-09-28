// Regresión de los casos DB 18, 20, 23, 23b y 25. Una palabra de marca
// compartida no convierte un producto nuevo en la variante del que ya estaba.
import assert from 'node:assert/strict';
import { estadoNuevo, crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { varianteDelPedido, esCorreccionDeVariante } from '../src/mesero-agente/varianteDelPedido.js';
import { fichaDeProducto } from '../src/mesero-whatsapp/consultasDelMenu.js';

let casos=0;
for (const marca of ['CAN','Marca Norte']) {
  const catalogo=[{nombre:'Carta',productos:[
    {id:1,nombre:`${marca} Waffle`,precio:105,disponible:true},
    {id:2,nombre:`${marca} Café Americano`,precio:45,disponible:true},
  ]}];
  for (const mensaje of ['un café','y un café','agrégale un café','agrégale un café y confírmalo','Café Americano']) {
    const estado=estadoNuevo({negocioId:'local',conversacionId:'productos-distintos'});
    estado.carrito.items=[{lid:'waffle',id:1,nombre:`${marca} Waffle`,cantidad:1,modificadores:[],notas:''}];
    const antes=structuredClone(estado.carrito.items[0]);
    assert.equal(varianteDelPedido({estado,catalogo,mensaje}),null,`No reclasificar: ${marca}: ${mensaje}`);
    assert.equal(esCorreccionDeVariante({estado,catalogo,mensaje,ficha:fichaDeProducto(catalogo[0].productos[1])}),false);
    const r=await crearEjecutor({estado,catalogo,mensaje,textoCiclo:`un waffle\n${mensaje}`})
      .ejecutar('agregar_producto',{producto_id:'2',cantidad:1});
    assert.equal(r.aplicado,true,JSON.stringify(r));assert.equal(estado.carrito.items.length,2);
    assert.deepEqual(estado.carrito.items[0],antes);assert.equal(estado.carrito.items[1].id,2);
    casos++;
  }
}
console.log(`OK productos distintos: ${casos}/${casos}, prefijo común no autoriza reemplazo.`);
