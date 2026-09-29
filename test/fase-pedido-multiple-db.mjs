// Canal productivo + catálogo/persistencia/outbox reales, base local desechable.
// Meta y el modelo son simulados; no es una evaluación del proveedor real.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/services/database.js';
import { prepararNegocioMixtos } from './lib-botones-local.mjs';
import { atenderConAgente } from '../src/mesero-agente/canalDelAgente.js';
import { entregarRespuesta } from '../src/mesero-agente/entregaDeRespuestas.js';
import { leerEstadoVersionado } from '../src/mesero-agente/persistenciaDelTurno.js';
process.env.MESERO_AGENTE_MODE='true';process.env.WHATSAPP_INTERACTIVOS='true';
const f=await prepararNegocioMixtos();
const {negocioId,telefono}=f;
const leer=()=>leerEstadoVersionado(negocioId,telefono);
let llamadas=0;
const tool=xs=>({stop_reason:'tool_use',content:xs.map(([name,input])=>({type:'tool_use',id:randomUUID(),name,input}))});
const fin={stop_reason:'end_turn',content:[{type:'text',text:'Revisemos tu pedido.'}]};
async function turno(mensaje,respuestas=[]) {
  const wamid=`wamid.multiple.${randomUUID()}`;
  await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')",
    [negocioId,telefono,wamid,JSON.stringify({message:{id:wamid,from:telefono,timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:mensaje}}})]);
  const r=await atenderConAgente({...f,mensaje,wamids:[wamid],llamarModelo:async()=>{
    llamadas++;assert(respuestas.length,'Modelo inesperado');return respuestas.shift();}});
  assert(r.ok,JSON.stringify(r));assert(!r.escalado,JSON.stringify(r));assert.equal(respuestas.length,0);
  const q=(await pool.query('SELECT carga FROM agente_outbox WHERE evento_clave=$1',[r.outbox.clave])).rows[0].carga;
  const envio=await entregarRespuesta({outboxClave:r.outbox.clave,enviar:async()=>({messages:[{id:`wamid.local.${randomUUID()}`}]}),alHumano:async()=>true});
  assert.equal(envio.estado,'entregado',JSON.stringify(envio));
  return {r,q,e:await leer()};
}
try {
  const ids=[];
  for (const nombre of ['Chilaquiles Rojos','Chilaquiles Verdes']) {
    const {rows:[p]}=await pool.query('INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio,disponible) SELECT $1,categoria_id,$2,100,true FROM menu_productos WHERE id=$3 RETURNING id',[negocioId,nombre,f.mixtosId]);
    ids.push(String(p.id));
    await pool.query('INSERT INTO whatsapp_productos(negocio_id,producto_id,publicado) VALUES($1,$2,true)',[negocioId,p.id]);
    const grupos=(await pool.query("SELECT * FROM menu_modificadores_grupos WHERE producto_id=$1 AND nombre<>'Salsa'",[f.mixtosId])).rows;
    for(const g of grupos){
      const {rows:[nuevo]}=await pool.query('INSERT INTO menu_modificadores_grupos(negocio_id,producto_id,nombre,requerido,minimo,maximo,orden) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[negocioId,p.id,g.nombre,g.requerido,g.minimo,g.maximo,g.orden]);
      await pool.query('INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,disponible,orden) SELECT negocio_id,$2,nombre,precio_extra,disponible,orden FROM menu_modificadores_opciones WHERE grupo_id=$1',[g.id,nuevo.id]);
    }
  }
  f.estado.carrito.items=[];
  await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',[negocioId,`agente:${telefono}`,JSON.stringify(f.estado)]);
  const lados=['Frijoles','Papas a la mexicana'].map(opcion=>({grupo:'Guarnición',opcion}));
  const op=(proteina,salsas=[])=>[...lados,...(proteina?[{grupo:'Proteína',opcion:proteina}]:[]),...salsas.map(opcion=>({grupo:'Salsa',opcion}))];
  let x=await turno('Quiero chilaquiles rojos con pollo, chilaquiles verdes con huevo y chilaquiles mixtos con roja y verde. Todos con frijoles y papas a la mexicana. Para recoger, pago en efectivo.',[
    tool([['agregar_producto',{producto_id:ids[0],cantidad:1,opciones:op('Pollo')}],
      ['agregar_producto',{producto_id:ids[1],cantidad:1,opciones:op('Huevo')}],
      ['agregar_producto',{producto_id:String(f.mixtosId),cantidad:1,opciones:op(null,['Roja','Verde'])}],
      ['definir_entrega',{modalidad:'recoger en tienda'}],['definir_pago',{forma_pago:'efectivo'}]]),fin]);
  assert.equal(x.e.carrito.items.length,3);assert.equal(x.e.pendiente.grupo,'Proteína');
  assert.equal(x.e.pendiente.linea_id,x.e.carrito.items[2].lid);
  assert(x.q.interactivo);assert(!x.e.eleccionInteractiva,'Las salsas escritas ya están completas');
  const primeros=structuredClone(x.e.carrito.items.slice(0,2));
  x=await turno('Pollo');
  assert.equal(x.e.pendiente.tipo,'confirmar_resumen');assert(x.q.interactivo);
  assert.equal(x.q.interactivo.type,'button');assert(x.q.interactivo.body.text.length<=1024);
  assert.match(x.q.interactivo.body.text,/Total: \$360/);
  assert.deepEqual(x.e.carrito.items.slice(0,2),primeros);
  const lidSegundo=x.e.carrito.items[1].lid;
  x=await turno('Al segundo cámbiale la proteína por pollo',[
    tool([['modificar_linea',{linea_id:lidSegundo,opciones:[{grupo:'Proteína',opcion:'Pollo'}]}]]),fin]);
  assert.equal(x.e.pendiente.tipo,'confirmar_resumen');
  assert.match(x.q.interactivo.body.text,/Total: \$380/);
  assert.deepEqual(x.e.carrito.items[0],primeros[0]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos_activos WHERE negocio_id=$1',[negocioId])).rows[0].n,0);
  console.log('OK múltiple DB: tres platillos en un mensaje, una aclaración, resumen con botones; cambio del segundo no toca los otros. Cero pedidos sin confirmar.');
  console.log(`Modelo simulado: ${llamadas} llamadas; ningún servicio externo.`);
} finally {await pool.end();}
