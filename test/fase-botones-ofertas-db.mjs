import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, actualizarConfiguracion } from '../src/services/database.js';
import { prepararNegocioBotones, prepararNegocioMixtos } from './lib-botones-local.mjs';
import { atenderConAgente } from '../src/mesero-agente/canalDelAgente.js';
import { entregarRespuesta } from '../src/mesero-agente/entregaDeRespuestas.js';
import { leerEstadoVersionado } from '../src/mesero-agente/persistenciaDelTurno.js';
import { prepararEnvioInteractivo } from '../src/mesero-agente/transporteInteractivo.js';
process.env.MESERO_AGENTE_MODE='true';process.env.WHATSAPP_INTERACTIVOS='true';
let cuenta=0;
async function caso(n,f){await f();console.log(`OK ${++cuenta}: ${n}`);}
const prohibido=async()=>{throw Error('NO_LLM_PARA_BOTONES');};
async function flujo({mixtos=false}={}) {
  const f=await (mixtos?prepararNegocioMixtos():prepararNegocioBotones());
  await actualizarConfiguracion({whatsapp_interactivos_elecciones_v1:'true'},f.negocioId);
  if(!mixtos){f.estado.carrito.items=[];await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',[f.negocioId,`agente:${f.telefono}`,JSON.stringify(f.estado)]);}
  const entrada=async m=>pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')",[f.negocioId,f.telefono,m.id,JSON.stringify({message:m})]);
  const identidad=()=>({id:`wamid.LOCAL-${randomUUID()}`,from:f.telefono,timestamp:String(Math.floor(Date.now()/1000))});
  const enviar=async (m,mensaje='',llamarModelo=prohibido)=>{
    await entrada(m);
    const r=await atenderConAgente({...f,nombre:'Cliente local',mensaje,wamids:[m.id],llamarModelo,
      ...(m.type==='interactive'?{interaccion:{mensajes:[m],mixto:false}}:{})});
    assert(r.ok,JSON.stringify(r));if(r.sinRespuesta)return null;
    const o=(await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1',[r.outbox.clave])).rows[0];
    const salida=`wamid.LOCAL-SALIDA-${randomUUID()}`;
    const entregado=await entregarRespuesta({outboxClave:r.outbox.clave,enviar:async()=>({messages:[{id:salida}]}),alHumano:async()=>true});
    assert.equal(entregado.estado,'entregado');return {...o,salida,recuperacion:r.recuperacion};
  };
  const preguntar=(mensaje,llamarModelo)=>enviar({...identidad(),type:'text',text:{body:mensaje}},mensaje,llamarModelo);
  const tocar=(o,accion,valor)=>{
    return pool.query('SELECT b.* FROM agente_botones b JOIN agente_preguntas_interactivas q ON q.id=b.pregunta_id WHERE q.outbox_clave=$1',[o.evento_clave]).then(async({rows})=>{
      const b=rows.find(b=>b.accion===accion&&(valor==null||b.datos.valor===valor||b.datos.producto_id===String(valor)));assert(b,JSON.stringify(rows));
      const tipo=o.carga.interactivo.type==='list'?'list_reply':'button_reply';
      return enviar({...identidad(),type:'interactive',context:{id:o.salida},interactive:{type:tipo,[tipo]:{id:b.token,title:'Manipulado'}}});
    });
  };
  return {...f,preguntar,tocar,leer:()=>leerEstadoVersionado(f.negocioId,f.telefono)};
}
try {
  await caso('consulta oficial de promoción -> aceptar cantidad persistida una sola vez',async()=>{
    const f=await flujo();await pool.query("INSERT INTO tienda_promociones(negocio_id,nombre,tipo,automatica,canales,productos,cantidad_requerida,cantidad_beneficiada) VALUES($1,'Café dos por uno','2x1',true,'[\"whatsapp\"]',$2,2,1)",[f.negocioId,JSON.stringify([f.productoId])]);
    const q=await f.preguntar('Que promociones hay');assert(q.carga.interactivo,JSON.stringify(q.carga));
    await f.tocar(q,'aceptar');let e=await f.leer();assert.equal(e.carrito.items.length,1);assert.equal(e.carrito.items[0].cantidad,2);
    assert.equal(await f.tocar(q,'aceptar'),null);e=await f.leer();assert.equal(e.carrito.items[0].cantidad,2);
  });
  await caso('promoción desactivada no agrega producto; rechazo tampoco',async()=>{
    const f=await flujo();await pool.query("INSERT INTO tienda_promociones(negocio_id,nombre,tipo,automatica,canales,productos) VALUES($1,'Dos cafés','2x1',true,'[\"whatsapp\"]',$2)",[f.negocioId,JSON.stringify([f.productoId])]);
    const q=await f.preguntar('Que promociones hay');await pool.query('UPDATE tienda_promociones SET activa=false WHERE negocio_id=$1',[f.negocioId]);
    await f.tocar(q,'aceptar');assert.equal((await f.leer()).carrito.items.length,0);
    await pool.query('UPDATE tienda_promociones SET activa=true WHERE negocio_id=$1',[f.negocioId]);
    const nueva=await f.preguntar('Que promociones hay');await f.tocar(nueva,'rechazar');assert.equal((await f.leer()).carrito.items.length,0);
  });
  await caso('elegir producto persiste identidad y dos unidades sin modelo',async()=>{
    const f=await flujo();const {rows:[p]}=await pool.query("INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio,disponible) SELECT $1,categoria_id,'Café de olla',40,true FROM menu_productos WHERE id=$2 RETURNING id",[f.negocioId,f.productoId]);
    await pool.query('INSERT INTO whatsapp_productos(negocio_id,producto_id,publicado) VALUES($1,$2,true)',[f.negocioId,p.id]);
    const q=await f.preguntar('quiero 2 cafes');assert(q.carga.interactivo,JSON.stringify(q.carga));
    await f.tocar(q,'elegir_producto',p.id);const e=await f.leer();assert.equal(e.carrito.items[0].nombre,'Café de olla');assert.equal(e.carrito.items[0].cantidad,2);
  });
  await caso('opción con precio cambiado repregunta; nueva asociación aplica el extra exacto',async()=>{
    const f=await flujo({mixtos:true});const q=await f.preguntar('Hola');
    await pool.query("UPDATE menu_modificadores_opciones SET precio_extra=9 WHERE negocio_id=$1 AND nombre='Chipotle'",[f.negocioId]);
    const nueva=await f.tocar(q,'agregar_a_grupo','Chipotle');assert.equal((await f.leer()).carrito.items[0].modificadores.length,0);
    assert.match(nueva.carga.texto,/No apliqué ese toque/);
    assert.equal(nueva.carga.interactivo.action.sections[0].rows.find(r=>r.title==='Chipotle').description,'+$9');
    assert.match(nueva.carga.texto_fallback,/Chipotle \(\+\$9\)/);await f.tocar(nueva,'agregar_a_grupo','Chipotle');
    assert.deepEqual((await f.leer()).carrito.items[0].modificadores[0].opciones,['Chipotle']);
  });
  await caso('bandera de elecciones apagada conserva grupo abierto y permite terminar por texto',async()=>{
    const f=await flujo({mixtos:true});let q=await f.preguntar('Hola');q=await f.tocar(q,'agregar_a_grupo','Roja');
    await actualizarConfiguracion({whatsapp_interactivos_elecciones_v1:'false'},f.negocioId);
    assert.deepEqual(await prepararEnvioInteractivo({db:pool,...f,interactivo:q.carga.interactivo,texto:q.carga.texto}),{permitido:true,interactivo:null});
    await f.tocar(q,'agregar_a_grupo','Verde');assert.deepEqual((await f.leer()).carrito.items[0].modificadores[0].opciones,['Roja']);
    await f.preguntar('listo');assert.equal((await f.leer()).eleccionInteractiva,undefined);
  });
  await caso('texto ambiguo llega entero al intérprete; el reconciliador conserva la selección y la lista sigue abierta',async()=>{
    // Desde afea8b0 la lista abierta ya no intercepta el texto que no casa con
    // una opción: lo interpreta el modelo y su propuesta pasa por el reconciliador.
    const f=await flujo({mixtos:true});let q=await f.preguntar('Hola');q=await f.tocar(q,'agregar_a_grupo','Roja');
    const abierta=(await f.leer()).eleccionInteractiva;assert(abierta?.id);
    const vistos=[];
    const modelo=async({messages})=>{vistos.push(structuredClone(messages.at(-1)));
      return vistos.length===1
        ? {stop_reason:'tool_use',content:[{type:'tool_use',id:randomUUID(),name:'modificar_linea',
          input:{linea_id:'mixtos-1',opciones:[{grupo:'Salsa',opcion:'Verde'}]}}]}
        : {stop_reason:'end_turn',content:[{type:'text',text:'¿Qué salsa prefieres?'}]};};
    const nueva=await f.preguntar('solo aguacate',modelo);
    assert.deepEqual(vistos[0],{role:'user',content:'solo aguacate'});
    const e=await f.leer();assert.deepEqual(e.carrito.items[0].modificadores[0].opciones,['Roja']);
    assert(nueva.carga.interactivo);assert.equal(e.eleccionInteractiva?.id,abierta.id);
    assert.equal(nueva.recuperacion,'eleccion_sin_evidencia_pedir_aclaracion');
  });
  await caso('si el intérprete falla con la lista abierta, el aviso sobrevive a la lista regenerada',async()=>{
    const f=await flujo({mixtos:true});let q=await f.preguntar('Hola');q=await f.tocar(q,'agregar_a_grupo','Roja');
    const abierta=(await f.leer()).eleccionInteractiva;
    const nueva=await f.preguntar('solo aguacate');assert.equal(nueva.recuperacion,'fallo_proveedor_sin_efectos');
    assert.match(nueva.carga.texto,/No pude completar tu último mensaje.*\n\*Chilaquiles Mixtos · Salsa\*/,'el cliente debe saber que su mensaje no se aplicó');
    const e=await f.leer();assert.deepEqual(e.carrito.items[0].modificadores[0].opciones,['Roja']);
    assert(nueva.carga.interactivo);assert.equal(e.eleccionInteractiva?.id,abierta.id);
  });
  console.log(`Ofertas y elecciones en PostgreSQL: ${cuenta}/${cuenta}.`);
} finally {await pool.end();}
