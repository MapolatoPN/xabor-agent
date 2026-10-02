// Fase 1: la dirección de entrega dentro de los formularios (contrato
// direccion_v1), de punta a punta: el canal arma el formulario, el endpoint
// recorre las pantallas y el recibo final deja el pedido con su dirección y su
// envío. Base local test_botones_*, red solo local, sin modelo, sin Meta.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool,actualizarConfiguracion } from '../src/services/database.js';
import { prepararNegocioBotones } from './lib-botones-local.mjs';
import { atenderConAgente } from '../src/mesero-agente/canalDelAgente.js';
import { leerEstadoVersionado } from '../src/mesero-agente/persistenciaDelTurno.js';
import { entregarRespuesta } from '../src/mesero-agente/entregaDeRespuestas.js';
import { atenderFlowRepetible } from '../src/mesero-agente/flowRepetibleSql.js';
Object.assign(process.env,{MESERO_AGENTE_MODE:'true',WHATSAPP_INTERACTIVOS:'true',WHATSAPP_FLOW_ENDPOINT:'true',
  WHATSAPP_FLOW_PRIVATE_KEY:'solo-local',META_APP_SECRET:'solo-local'});
const sinEfectos=async()=>{throw Error('NO_PEDIDOS_PAGOS_TICKETS');};
const IDS={categorias:'66666666666',carrito:'77777777777',categoriasDir:'88888888888',carritoDir:'99999999999'};
let n=0,fallidas=0;
async function caso(nombre,fn){
  try {await fn();console.log(`OK flows-direccion ${++n}: ${nombre}`);}
  catch(e) {
    fallidas++;
    const detalle=e?.code==='ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0,200)} · esperado=${JSON.stringify(e.expected)?.slice(0,120)}` : '';
    console.log(`FALLA flows-direccion: ${nombre}\n  ${String(e?.message || e).split('\n')[0]}${detalle}`);
  }
}

// Configuración de Mapolato Obispado (atención general, Flows, beta híbrida)
// con sus zonas de envío. Un café en el carrito, recoger y efectivo.
async function fixture({direccion=true,vacio=false}={}) {
  const f=await prepararNegocioBotones();
  const reglas={restaurante:'Prueba aislada',timezone:'America/Matamoros',
    horarios:Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo']
      .map(d=>[d,{abierto:true,apertura:'00:00',cierre:'24:00'}])),
    pedidos:{modalidades:['recoger en tienda','entrega a domicilio'],tiempo_preparacion_minutos:20,
      pedido_minimo_entrega:0,costo_envio:60,pago_aceptado:['efectivo'],zonas_entrega:[
        {nombre:'UTNC',costo:150},{nombre:'Cervecera',costo:150},{nombre:'Cartonera',costo:120}]},
    cierres_especiales:[],promociones:[],politicas:[]};
  await actualizarConfiguracion({nombre:'Mapolato Obispado',reglas_atencion:JSON.stringify(reglas),
    whatsapp_inicio_mapo_v1:'true',whatsapp_atencion_general_v1:'true',bot_whatsapp_solo_prueba:'false',
    mesero_agente_porcentaje:'100',mesero_agente_telefonos:'',whatsapp_flows_v1:'true',whatsapp_flows_telefonos:'',
    whatsapp_beta_hibrido_v1:'true',whatsapp_beta_telefonos:'',whatsapp_carrito_unificado_v1:'true',
    whatsapp_interactivos_elecciones_v1:'true',whatsapp_flow_categorias_id:IDS.categorias,whatsapp_flow_carrito_id:IDS.carrito,
    whatsapp_flow_configurar_id:'44444444444',whatsapp_trazabilidad_formularios_v1:'true',
    ...(direccion?{whatsapp_flow_categorias_dir_id:IDS.categoriasDir,whatsapp_flow_carrito_dir_id:IDS.carritoDir}:{})},f.negocioId);
  if(vacio) {
    f.estado.carrito.items=[];
    await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',
      [f.negocioId,`agente:${f.telefono}`,JSON.stringify(f.estado)]);
  }
  const leer=()=>leerEstadoVersionado(f.negocioId,f.telefono);
  const ident=()=>({id:'wamid.dirflow.'+randomUUID(),from:f.telefono,timestamp:String(Math.floor(Date.now()/1000))});
  const texto=body=>({...ident(),type:'text',text:{body}});
  const recibo=(q,revision)=>({...ident(),type:'interactive',context:{id:q.wamid},interactive:{type:'nfm_reply',nfm_reply:{
    name:'flow',body:'Sent',response_json:JSON.stringify({flow_token:q.interactivo.action.parameters.flow_token,revision})}}});
  const enviados=[];
  const procesar=async(m,{modelo=null}={})=>{
    let inesperadas=0;
    const llamar=modelo || (async()=>{inesperadas++;throw Error('NO_DEBE_LLAMAR_MODELO');});
    await pool.query(`INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')
      ON CONFLICT (negocio_id,wamid) DO UPDATE SET estado='completado'`,[f.negocioId,f.telefono,m.id,JSON.stringify({message:m})]);
    const interaccion=m.type==='interactive'?{interaccion:{mensajes:[m],mixto:false}}:{};
    const r=await atenderConAgente({...f,mensaje:m.text?.body || '',wamids:[m.id],...interaccion,llamarModelo:llamar,
      registrar:sinEfectos,emitir:sinEfectos,guardar:sinEfectos,crearPago:sinEfectos});
    assert.equal(inesperadas,0,`el turno llamó al modelo sin esperarlo: ${m.text?.body || m.type}`);
    assert.equal(r.ok,true,JSON.stringify(r));
    if(!r.outbox)return {r};
    const {rows:[fila]}=await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1',[r.outbox.clave]);
    const wamid='wamid.salida.'+randomUUID();
    if(!r.yaEntregado)assert.equal((await entregarRespuesta({outboxClave:fila.evento_clave,
      enviar:async(x)=>{enviados.push(x);return {messages:[{id:wamid}]};},alHumano:sinEfectos})).estado,'entregado');
    return {...fila.carga,r,wamid,enviado:enviados.at(-1)};
  };
  const flow=(q)=>{
    const flow_token=q.interactivo.action.parameters.flow_token;
    return {
      init:()=>atenderFlowRepetible(pool,{action:'INIT',flow_token}),
      atras:(screen)=>atenderFlowRepetible(pool,{action:'BACK',flow_token,screen}),
      paso:(screen,revision,data)=>atenderFlowRepetible(pool,{action:'data_exchange',flow_token,screen,data:{revision,...data}}),
    };
  };
  return {...f,leer,texto,recibo,procesar,flow};
}

try {
  await caso('carrito: Guardar con domicilio pide la dirección en el formulario y el pedido queda con la zona y su envío',async()=>{
    const f=await fixture();
    const q=await f.procesar(f.texto('seguir pedido'));
    assert.equal(q.interactivo?.type,'flow');
    assert.equal(q.interactivo.action.parameters.flow_id,IDS.carritoDir);
    assert.equal(q.enviado.interactivo?.action?.parameters?.flow_id,IDS.carritoDir,'el transporte deja salir el formulario nuevo');
    const fl=f.flow(q);
    let v=await fl.init();assert.equal(v.screen,'CARRITO');
    v=await fl.paso('CARRITO',v.data.revision,{operacion:'guardar',modalidad:'m1',pago:'p0'});
    assert.equal(v.screen,'DIRECCION');assert.equal(v.data.hay_zonas,true);
    assert.deepEqual(v.data.zonas.map(z=>z.title),['En la ciudad','UTNC','Cervecera','Cartonera']);
    v=await fl.paso('DIRECCION',v.data.revision,{operacion:'direccion',zona:'z0',calle:'Edificio 3',colonia:'',referencias:'Caseta norte'});
    assert.equal(v.screen,'SUCCESS');
    const fin=await f.procesar(f.recibo(q,v.data.extension_message_response.params.revision));
    const e=await f.leer();
    assert.equal(e.carrito.datos.cliente.direccion,'Edificio 3, UTNC');
    assert.equal(e.carrito.datos.cliente.referencias,'Caseta norte');
    assert.deepEqual(e.carrito.datos.cliente.direccion_partes,{calle:'Edificio 3',colonia:'',zona:'UTNC'});
    assert.equal(Number(e.carrito.datos.costo_envio),150);
    assert.match(fin.texto,/Dirección: Edificio 3, UTNC/);assert.match(fin.texto,/Envío: \$150/);
    assert.equal(e.pendiente?.tipo,'confirmar_resumen');assert.equal(e.folio,null);
  });

  await caso('pregunta de dirección pendiente: «Escribir dirección» abre directo en la pantalla de dirección',async()=>{
    const f=await fixture();
    let vuelta=0;
    const q=await f.procesar(f.texto('Lo quiero a domicilio'),{modelo:async()=>vuelta++===0
      ? {content:[{type:'tool_use',id:'entrega-'+randomUUID(),name:'definir_entrega',input:{modalidad:'entrega a domicilio'}}],stop_reason:'tool_use'}
      : {content:[{type:'text',text:'Listo.'}],stop_reason:'end_turn'}});
    assert.equal(q.interactivo?.type,'flow',JSON.stringify(q.texto));
    assert.equal(q.interactivo.action.parameters.flow_cta,'Escribir dirección');
    assert.match(q.texto,/Dirección de entrega/);
    const fl=f.flow(q);
    let v=await fl.init();assert.equal(v.screen,'DIRECCION');
    v=await fl.paso('DIRECCION',v.data.revision,{operacion:'direccion',zona:'zn',calle:'Hidalgo 405',colonia:'Centro',referencias:''});
    assert.equal(v.screen,'SUCCESS');
    const fin=await f.procesar(f.recibo(q,v.data.extension_message_response.params.revision));
    const e=await f.leer();
    assert.equal(e.carrito.datos.cliente.direccion,'Hidalgo 405, Centro');
    assert.equal(Number(e.carrito.datos.costo_envio),60);
    assert.match(fin.texto,/Revisa tu pedido/);
  });

  await caso('Arma tu pedido: ENTREGA con domicilio lleva a la dirección; el aviso de zona se confirma reenviando',async()=>{
    const f=await fixture({vacio:true});
    const q=await f.procesar(f.texto('Quiero ordenar'));
    assert.equal(q.interactivo?.type,'flow',JSON.stringify(q.texto));
    assert.equal(q.interactivo.action.parameters.flow_id,IDS.categoriasDir);
    assert.match(q.texto,/ahí mismo escribes la dirección/);
    const fl=f.flow(q);
    let v=await fl.init();assert.equal(v.screen,'MENU');
    v=await fl.paso('MENU',v.data.revision,{operacion:'categoria',categoria:v.data.categorias[0].id});
    assert.equal(v.screen,'PLATILLO');
    v=await fl.paso('PLATILLO',v.data.revision,{operacion:'terminar',producto0:v.data.productos0[0].id,cantidad:'1'});
    assert.equal(v.screen,'ENTREGA');
    v=await fl.paso('ENTREGA',v.data.revision,{operacion:'revisar',modalidad:'m1',pago:'p0'});
    assert.equal(v.screen,'DIRECCION');
    const atras=await fl.atras('DIRECCION');assert.equal(atras.screen,'ENTREGA');assert.equal(atras.data.modalidad_inicial,'m1');
    v=await fl.paso('ENTREGA',atras.data.revision,{operacion:'revisar',modalidad:'m1',pago:'p0'});
    assert.equal(v.screen,'DIRECCION');
    const datos={operacion:'direccion',zona:'zn',calle:'Calle Cervecera 210',colonia:'Centro',referencias:'Portón negro'};
    v=await fl.paso('DIRECCION',v.data.revision,datos);
    assert.equal(v.screen,'DIRECCION');assert.match(v.data.error,/menciona Cervecera/);assert.equal(v.data.calle_inicial,'Calle Cervecera 210');
    v=await fl.paso('DIRECCION',v.data.revision,datos);
    assert.equal(v.screen,'SUCCESS');
    await f.procesar(f.recibo(q,v.data.extension_message_response.params.revision));
    const e=await f.leer();
    assert.equal(e.carrito.items.length,1);
    assert.equal(e.carrito.datos.cliente.direccion,'Calle Cervecera 210, Centro');
    assert.equal(Number(e.carrito.datos.costo_envio),60,'«En la ciudad» confirmado: tarifa base');
  });

  await caso('sin las claves nuevas, el carrito guarda como hoy (sin pantalla de dirección)',async()=>{
    const f=await fixture({direccion:false});
    const q=await f.procesar(f.texto('seguir pedido'));
    assert.equal(q.interactivo.action.parameters.flow_id,IDS.carrito);
    assert.doesNotMatch(q.texto,/escribes la dirección/);
    const fl=f.flow(q);
    let v=await fl.init();
    v=await fl.paso('CARRITO',v.data.revision,{operacion:'guardar',modalidad:'m1',pago:'p0'});
    assert.equal(v.screen,'SUCCESS');
  });

  await caso('revertir (borrar la clave) cierra los formularios nuevos abiertos sin tocar el pedido',async()=>{
    const f=await fixture();
    const q=await f.procesar(f.texto('seguir pedido'));
    const antes=(await f.leer()).carrito;
    await pool.query("DELETE FROM configuracion WHERE negocio_id=$1 AND clave='whatsapp_flow_carrito_dir_id'",[f.negocioId]);
    await assert.rejects(f.flow(q).init(),e=>e.status===427);
    assert.deepEqual((await f.leer()).carrito,antes);
  });

  await caso('activar con un formulario sin dirección abierto lo corta en el endpoint, no en el recibo final',async()=>{
    const f=await fixture({direccion:false});
    const q=await f.procesar(f.texto('seguir pedido'));
    assert.equal(q.interactivo.action.parameters.flow_id,IDS.carrito);
    const antes=(await f.leer()).carrito;
    await actualizarConfiguracion({whatsapp_flow_carrito_dir_id:IDS.carritoDir},f.negocioId);
    await assert.rejects(f.flow(q).init(),e=>e.status===427);
    assert.deepEqual((await f.leer()).carrito,antes);
  });

  await caso('Arma tu pedido: aviso de zona, Atrás y «recoger»: el pedido se aplica, sin dirección',async()=>{
    const f=await fixture({vacio:true});
    const q=await f.procesar(f.texto('Quiero ordenar'));
    const fl=f.flow(q);
    let v=await fl.init();
    v=await fl.paso('MENU',v.data.revision,{operacion:'categoria',categoria:v.data.categorias[0].id});
    v=await fl.paso('PLATILLO',v.data.revision,{operacion:'terminar',producto0:v.data.productos0[0].id,cantidad:'1'});
    v=await fl.paso('ENTREGA',v.data.revision,{operacion:'revisar',modalidad:'m1',pago:'p0'});
    v=await fl.paso('DIRECCION',v.data.revision,{operacion:'direccion',zona:'zn',calle:'Calle Cervecera 210',colonia:'Centro',referencias:''});
    assert.match(v.data.error,/menciona Cervecera/);
    const atras=await fl.atras('DIRECCION');assert.equal(atras.screen,'ENTREGA');
    v=await fl.paso('ENTREGA',atras.data.revision,{operacion:'revisar',modalidad:'m0',pago:'p0'});
    assert.equal(v.screen,'SUCCESS');
    const fin=await f.procesar(f.recibo(q,v.data.extension_message_response.params.revision));
    const e=await f.leer();
    assert.equal(e.carrito.items.length,1,JSON.stringify(fin.texto));
    assert.equal(e.carrito.datos.modalidad,'recoger en tienda');
    assert.equal(e.carrito.datos.cliente?.direccion,undefined);
  });
} finally {
  await pool.end();
}
console.log(`flows-direccion: ${n} OK, ${fallidas} fallos`);
if(fallidas)process.exitCode=1;
