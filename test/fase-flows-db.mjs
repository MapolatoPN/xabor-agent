import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pool,actualizarConfiguracion,guardarMensaje,obtenerConversacion } from '../src/services/database.js';
import { prepararNegocioMixtos,prepararNegocioCombitoOmelette } from './lib-botones-local.mjs';
import { atenderConAgente } from '../src/mesero-agente/canalDelAgente.js';
import { entregarRespuesta } from '../src/mesero-agente/entregaDeRespuestas.js';
import { leerEstadoVersionado } from '../src/mesero-agente/persistenciaDelTurno.js';
import { comandosFormulario,leerRespuestaFlow } from '../src/mesero-agente/formularioAgrupado.js';
import { atenderFlowRepetible } from '../src/mesero-agente/flowRepetibleSql.js';
process.env.MESERO_AGENTE_MODE='true';process.env.WHATSAPP_INTERACTIVOS='true';
const noModelo=async()=>{throw Error('NO_MODELO');};
let n=0;
const caso=async(nombre,fn)=>{await fn();console.log(`OK Flow DB ${++n}: ${nombre}`);};
async function fixture({vacio=false,enviar=true,opcional=false,dosProteinas=false,combito=false,flows=true,continuo=false,repetible=false,edicion=false,renglones=9,historial=false}={}) {
  const f=await (combito?prepararNegocioCombitoOmelette():prepararNegocioMixtos());
  if(dosProteinas)await pool.query("UPDATE menu_modificadores_grupos SET maximo=2 WHERE negocio_id=$1 AND producto_id=$2 AND nombre='Proteína'",[f.negocioId,f.mixtosId]);
  if(opcional) {
    const {rows:[g]}=await pool.query("INSERT INTO menu_modificadores_grupos(negocio_id,producto_id,nombre,requerido,minimo,maximo,orden) VALUES($1,$2,'Extras',false,0,2,3) RETURNING id",[f.negocioId,f.mixtosId]);
    await pool.query("INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,disponible,orden) VALUES($1,$2,'Queso',10,true,0)",[f.negocioId,g.id]);
    f.estado.carrito.items[0].modificadores=[{grupo:'Extras',opciones:['Queso']}];
  }
  if(vacio)f.estado.carrito.items=[];
  if(edicion) {
    f.estado.carrito.items=Array.from({length:renglones},(_,i)=>({id:f.mixtosId,lid:`edicion-${i}`,nombre:'Chilaquiles Mixtos',cantidad:1,
      notas:`Nota ${i}`,modificadores:[{grupo:'Salsa',opciones:['Roja']},{grupo:'Proteína',opciones:['Huevo']},
        {grupo:'Guarnición',opciones:['Frijoles','Arroz']}]}));
    Object.assign(f.estado.carrito.datos,{modalidad:'recoger en tienda',forma_pago:'efectivo'});
  }
  await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',[f.negocioId,`agente:${f.telefono}`,JSON.stringify(f.estado)]);
  await actualizarConfiguracion({whatsapp_flows_v1:String(flows),bot_whatsapp_solo_prueba:'true',
    bot_whatsapp_telefonos_prueba:f.telefono,whatsapp_flows_telefonos:f.telefono,
    whatsapp_flow_productos_id:'11111111111',whatsapp_flow_configurar_id:'22222222222',
    ...(edicion===true?{whatsapp_flow_editar_id:'55555555555'}:{}),
    ...(continuo?{whatsapp_flow_pedido_id:'33333333333'}:{})},f.negocioId);
  if(repetible)await actualizarConfiguracion({whatsapp_flow_repetible_id:'44444444444'},f.negocioId);
  const leer=()=>leerEstadoVersionado(f.negocioId,f.telefono);
  const identidad=()=>({id:`wamid.flow.${randomUUID()}`,from:f.telefono,timestamp:String(Math.floor(Date.now()/1000))});
  const texto=body=>({...identidad(),type:'text',text:{body}});
  const respuesta=(q,fields)=>({...identidad(),type:'interactive',context:{id:q.wamid},interactive:{type:'nfm_reply',nfm_reply:{
    name:'flow',body:'Sent',response_json:JSON.stringify({flow_token:q.interactivo.action.parameters.flow_token,...fields})}}});
  const boton=(q,title)=>{
    const lista=q.interactivo.type==='list',type=lista?'list_reply':'button_reply';
    const opciones=lista?q.interactivo.action.sections.flatMap(s=>s.rows):q.interactivo.action.buttons.map(b=>b.reply);
    return {...identidad(),type:'interactive',context:{id:q.wamid},interactive:{type,[type]:{
      id:opciones.find(b=>b.title===title).id,title:'no autoridad'}}};
  };
  const foto=async q=>(await pool.query('SELECT b.datos FROM agente_botones b JOIN agente_preguntas_interactivas q ON q.id=b.pregunta_id WHERE q.outbox_clave=$1',[q.clave])).rows[0].datos;
  const procesar=async(mensajes,{enviar=true}={})=>{
    for(const m of mensajes)await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado') ON CONFLICT DO NOTHING",[f.negocioId,f.telefono,m.id,JSON.stringify({message:m})]);
    if(historial)for(const m of mensajes)await guardarMensaje(f.telefono,'Prueba local','entrante',m.text?.body || 'Formulario recibido',f.negocioId,'cliente',m.id);
    const toques=mensajes.filter(m=>m.type==='interactive'),textos=mensajes.filter(m=>m.type==='text');
    const r=await atenderConAgente({...f,mensaje:textos.map(m=>m.text.body).join('\n'),wamids:mensajes.map(m=>m.id),
      ...(toques.length?{interaccion:{mensajes:toques,mixto:!!textos.length}}:{}),llamarModelo:noModelo});
    assert.equal(r.ok,true,JSON.stringify(r));
    if(!r.outbox)return {r};
    const q=(await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1',[r.outbox.clave])).rows[0];
    const wamid=`wamid.flow.out.${randomUUID()}`;
    if(enviar && !r.yaEntregado)assert.equal((await entregarRespuesta({outboxClave:q.evento_clave,enviar:async()=>({messages:[{id:wamid}]}),alHumano:async()=>true})).estado,'entregado');
    if(historial && enviar)await guardarMensaje(f.telefono,'Prueba local','saliente',q.carga.texto,f.negocioId,'bot',wamid);
    return {r,...q.carga,clave:q.evento_clave,wamid};
  };
  const inicial=await procesar([texto(vacio?'Quiero ordenar':'Hola')],{enviar});
  assert.equal(inicial.interactivo?.type,edicion?'button':flows?'flow':'list',JSON.stringify(inicial.r));
  return {...f,leer,texto,respuesta,boton,procesar,inicial,foto};
}
function campos(q) {
  const d=q.interactivo.action.parameters.flow_action_payload.data,r={modalidad:'m0',pago:'p0'};
  for(let i=0;i<18;i++) {
    r[`g${i}_s`]=d[`g${i}_simple`]?'o0':null;
    r[`g${i}_m`]=d[`g${i}_multiple`]?d[`g${i}_opciones`].slice(0,d[`g${i}_min`]).map(o=>o.id):null;
  }
  return r;
}
try {
  execFileSync(process.execPath,['scripts/predeploy-107-agente-flow-repetible.mjs'],{stdio:'pipe',timeout:30000});
  await caso('carrito SQL: edición múltiple, borrador reversible, doble envío y tarjeta con resultado validado',async()=>{
    Object.assign(process.env,{WHATSAPP_FLOW_ENDPOINT:'true',WHATSAPP_FLOW_PRIVATE_KEY:'solo-local',META_APP_SECRET:'solo-local'});
    try {
      const f=await fixture({edicion:true,historial:true}),antes=(await f.leer()).carrito;
      await actualizarConfiguracion({whatsapp_flow_categorias_id:'66666666666',whatsapp_flow_carrito_id:'77777777777'},f.negocioId);
      const q=await f.procesar([f.boton(f.inicial,'Cambiar algo')]),foto=await f.foto(q);
      assert.equal(foto.version,'carrito_v1');
      const flow_token=q.interactivo.action.parameters.flow_token;
      let v=await atenderFlowRepetible(pool,{action:'INIT',flow_token});assert.equal(v.screen,'CARRITO');
      const solicitud={action:'data_exchange',flow_token,screen:v.screen,data:{revision:v.data.revision,operacion:'agregar',q0:'0',q1:'0',q2:'4'}};
      const [a,b]=await Promise.all([atenderFlowRepetible(pool,solicitud),atenderFlowRepetible(pool,solicitud)]);
      assert.deepEqual(a,b);assert.equal(a.screen,'MENU');assert.deepEqual((await f.leer()).carrito,antes);
      v=await atenderFlowRepetible(pool,{action:'BACK',flow_token,screen:'MENU'});assert.equal(v.screen,'CARRITO');
      assert.equal(v.data.q0_inicial,'4');assert.match(v.data.r0_detalle,/Nota 2/);
      // Una conexión nueva recupera el borrador persistido, no la memoria del proceso.
      const tx=await pool.connect();try {v=await atenderFlowRepetible({connect:async()=>({query:tx.query.bind(tx),release:()=>{}})},{action:'INIT',flow_token});}finally{tx.release();}
      await pool.query('UPDATE negocios SET bot_whatsapp_activo=false WHERE id=$1',[f.negocioId]);
      await assert.rejects(atenderFlowRepetible(pool,{action:'INIT',flow_token}),e=>e.status===427);
      await pool.query('UPDATE negocios SET bot_whatsapp_activo=true WHERE id=$1',[f.negocioId]);
      v=await atenderFlowRepetible(pool,{action:'data_exchange',flow_token,screen:'CARRITO',data:{revision:v.data.revision,operacion:'guardar',modalidad:'m0',pago:'p0'}});
      assert.equal(v.screen,'SUCCESS');
      const receipt=v.data.extension_message_response.params,m=f.respuesta(q,{revision:receipt.revision});
      const salida=await f.procesar([m]);const despues=(await f.leer()).carrito;
      assert.equal(despues.items.length,7);assert.equal(despues.items[0].lid,'edicion-2');assert.equal(despues.items[0].cantidad,4);
      assert.deepEqual(despues.items.slice(1),antes.items.slice(3));assert.equal((await f.leer()).folio,null);
      assert.match(salida.texto,/Total/);
      await f.procesar([m]);await f.procesar([f.respuesta(q,{revision:receipt.revision})]);assert.deepEqual((await f.leer()).carrito,despues);
      const historia=await obtenerConversacion(f.telefono,f.negocioId);
      assert(historia.some(m=>m.interaccion?.titulo==='Formulario enviado'));
      const aplicada=historia.find(x=>x.message_id_externo===m.id).interaccion;
      assert.equal(aplicada.titulo,'Cambios guardados');assert.match(aplicada.resumen,/Total/);
      assert(!JSON.stringify(historia).includes(flow_token),'no exponer token en historial');
      const ajena=await obtenerConversacion(f.telefono,(await fixture()).negocioId);assert.equal(ajena.length,0);
      await assert.rejects(atenderFlowRepetible(pool,{action:'INIT',flow_token}),e=>e.status===427);
    } finally {delete process.env.WHATSAPP_FLOW_ENDPOINT;delete process.env.WHATSAPP_FLOW_PRIVATE_KEY;delete process.env.META_APP_SECRET;}
  });
  await caso('cantidad y eliminación exactas; el último regresa al menú sin cancelar ni confirmar',async()=>{
    const f=await fixture({edicion:true}),antes=(await f.leer()).carrito;
    let q=await f.procesar([f.boton(f.inicial,'Cambiar algo')]);
    const seleccion={linea:'l8',operacion:'editar',cantidad:'4',g0_m:['l8g0o0'],g1_s:'l8g1o1',
      g2_m:['l8g2o0','l8g2o2'],observaciones:'Nota 8',modalidad:'m0',pago:'p0'};
    q=await f.procesar([f.respuesta(q,seleccion)]);
    assert.equal((await f.leer()).carrito.items[8].cantidad,4);
    assert.deepEqual((await f.leer()).carrito.items.slice(0,8),antes.items.slice(0,8));
    const resumenViejo=q,datosAntesDeEliminar=structuredClone((await f.leer()).carrito.datos);
    q=await f.procesar([f.boton(q,'Cambiar algo')]);
    const remover={linea:'l8',operacion:'eliminar',confirmar_eliminacion:true},m=f.respuesta(q,remover);
    await f.procesar([m]);const guardado=(await f.leer()).carrito;
    assert.deepEqual(guardado.items,antes.items.slice(0,8));assert.deepEqual(guardado.datos,datosAntesDeEliminar);
    await f.procesar([m]);await f.procesar([f.respuesta(q,remover)]);
    await f.procesar([f.boton(resumenViejo,'Confirmar')]);
    assert.deepEqual((await f.leer()).carrito,guardado);assert.equal((await f.leer()).folio,null);
    const u=await fixture({edicion:true,renglones:1});
    q=await u.procesar([u.boton(u.inicial,'Cambiar algo')]);
    const ultimo=await u.procesar([u.respuesta(q,{...remover,linea:'l0'})]);
    assert.equal(ultimo.interactivo.type,'flow');assert.equal(ultimo.interactivo.action.parameters.flow_id,'11111111111');
    const e=await u.leer();assert.equal(e.carrito.items.length,0);assert.equal(e.hechos.cancelado,false);
    assert.equal(e.pendiente.tipo,'agregar_otro');assert.equal(e.folio,null);
  });
  await caso('editar el noveno platillo, nota y doble respuesta sin alterar los otros ocho',async()=>{
    const f=await fixture({edicion:true}),antes=(await f.leer()).carrito;
    const q=await f.procesar([f.boton(f.inicial,'Cambiar algo')]);
    assert.equal(q.interactivo.type,'flow');assert.equal(q.interactivo.action.parameters.flow_id,'55555555555');
    const foto=await f.foto(q);assert.equal(foto.lineas.length,9);assert.equal(foto.version,'edicion_v1');
    const campos={linea:'l8',g0_m:['l8g0o1'],g1_s:'l8g1o0',g2_m:['l8g2o0','l8g2o1'],observaciones:'Sin crema',modalidad:'m0',pago:'p0'};
    const mensaje=f.respuesta(q,campos),resultado=await f.procesar([mensaje]),e=await f.leer();
    assert.match(resultado.texto,/Revisa tu pedido/);assert.equal(e.pendiente.tipo,'confirmar_resumen');
    assert.deepEqual(e.carrito.items.slice(0,8),antes.items.slice(0,8));
    assert.equal(e.carrito.items[8].notas,'Sin crema');assert.deepEqual(e.carrito.items[8].modificadores[0].opciones,['Verde']);
    assert.equal(e.folio,null);const guardado=structuredClone(e.carrito);
    await f.procesar([mensaje]);await f.procesar([f.respuesta(q,campos)]);
    assert.deepEqual((await f.leer()).carrito,guardado);
    assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos_activos WHERE negocio_id=$1',[f.negocioId])).rows[0].n,0);
  });
  await caso('cancelación real invalida el editor abierto; saludo siguiente inicia vacío',async()=>{
    const f=await fixture({edicion:true}),q=await f.procesar([f.boton(f.inicial,'Cambiar algo')]);
    const cancelacion=f.texto('Cancelar ese pedido'),r=await f.procesar([cancelacion]);
    assert.match(r.texto,/borrador fue cancelado/);assert.equal((await f.leer()).carrito.items.length,0);
    assert.equal((await f.leer()).hechos.cancelado,true);await f.procesar([cancelacion]);
    await f.procesar([f.respuesta(q,{linea:'pedido',modalidad:'m0',pago:'p0',observaciones:''})]);
    assert.equal((await f.leer()).carrito.items.length,0);
    const saludo=await f.procesar([f.texto('Hola')]);assert.equal(saludo.interactivo,undefined,'el saludo no abre una compra');
    const nuevo=await f.procesar([f.texto('Quiero ordenar')]);assert.equal(nuevo.interactivo.type,'flow');
    assert.equal((await f.leer()).carrito.items.length,0);assert.equal((await f.leer()).folio,null);
  });
  await caso('sin editor publicado no promete una ventana inexistente para nueve renglones',async()=>{
    const f=await fixture({edicion:'sin_config'}),antes=(await f.leer()).carrito;
    const q=await f.procesar([f.boton(f.inicial,'Cambiar algo')]);
    assert.match(q.texto,/Dime qué platillo/);assert(!q.interactivo);assert.deepEqual((await f.leer()).carrito,antes);
  });
  await caso('repetible: ocho platillos, doble toque concurrente, reapertura y recibo final único',async()=>{
    process.env.WHATSAPP_FLOW_ENDPOINT='true';process.env.WHATSAPP_FLOW_PRIVATE_KEY='solo-test';process.env.META_APP_SECRET='solo-test';
    try {
      const f=await fixture({vacio:true,repetible:true,dosProteinas:true}),foto=await f.foto(f.inicial);
      const token=f.inicial.interactivo.action.parameters.flow_token;
      const llamar=r=>atenderFlowRepetible(pool,{version:'3.0',flow_token:token,...r});
      let s=await llamar({action:'INIT'});
      const p=foto.productos.findIndex(p=>p.id===String(f.mixtosId));
      const esperado=[];
      for(let i=0;i<8;i++) {
        const item={producto0:`p${p}`};
        foto.productos[p].grupos.forEach((g,j)=>{
          const ids=Array.from({length:g.minimo},(_,k)=>`p${p}g${j}o${j===0?(i+k)%g.opciones.length:k}`);
          item[`g${j}_${g.maximo>1?'m':'s'}`]=g.maximo>1?ids:(ids[0] || '');
        });
        esperado.push(item);
        const req={action:'data_exchange',screen:'PLATILLO',data:{revision:s.data.revision,operacion:'agregar',...item}};
        const [a,b]=await Promise.all([llamar(req),llamar(req)]);assert.deepEqual(a,b);s=a;
        assert.equal(s.data.revision,String(i+1));assert.equal(s.data.producto_inicial,'');
        assert.equal((await f.leer()).carrito.items.length,0,'No cambia el carrito mientras arma la ventana');
      }
      assert.deepEqual(await llamar({action:'INIT'}),s,'Reabrir recupera el borrador durable');
      const vieja=await llamar({action:'data_exchange',screen:'PLATILLO',data:{revision:'0',operacion:'agregar',...esperado[0]}});
      assert.equal(vieja.data.revision,'8');assert(vieja.data.error_visible);
      s=await llamar({action:'data_exchange',screen:'PLATILLO',data:{revision:'8',operacion:'terminar'}});
      assert.equal(s.screen,'ENTREGA');assert.equal((await f.leer()).folio,null);
      s=await llamar({action:'data_exchange',screen:'ENTREGA',data:{revision:s.data.revision,operacion:'revisar',modalidad:'m0',pago:'p0'}});
      assert.equal(s.screen,'SUCCESS');const recibo=s.data.extension_message_response.params;
      let q=await f.procesar([f.respuesta(f.inicial,{revision:recibo.revision})]),e=await f.leer();
      assert.equal(e.carrito.items.length,8);assert.equal(e.folio,null);assert.equal(e.carrito.datos.forma_pago,'efectivo');
      assert.match(q.texto,/\*Revisa tu pedido\*/);assert.match(q.texto,/\*Total:/);
      for(let i=0;i<8;i++)assert.deepEqual(e.carrito.items[i].modificadores.find(g=>g.grupo==='Salsa').opciones,
        [foto.productos[p].grupos[0].opciones[i%foto.productos[p].grupos[0].opciones.length].nombre]);
      const antes=structuredClone(e.carrito);
      assert.equal((await f.procesar([f.respuesta(f.inicial,{revision:recibo.revision})])).r.sinRespuesta,true);
      assert.deepEqual((await f.leer()).carrito,antes);
      assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos_activos WHERE negocio_id=$1',[f.negocioId])).rows[0].n,0);
      await assert.rejects(llamar({action:'INIT'}),/no está disponible/);
    } finally {delete process.env.WHATSAPP_FLOW_ENDPOINT;delete process.env.WHATSAPP_FLOW_PRIVATE_KEY;delete process.env.META_APP_SECRET;}
  });
  await caso('repetible: bot apagado, pausa, formulario antiguo, token desconocido y recibo inventado fallan cerrados',async()=>{
    process.env.WHATSAPP_FLOW_ENDPOINT='true';process.env.WHATSAPP_FLOW_PRIVATE_KEY='solo-test';process.env.META_APP_SECRET='solo-test';
    try {
      for(const modo of ['apagado','pausa','vencido','desconocido','recibo']) {
        const f=await fixture({vacio:true,repetible:true}),token=f.inicial.interactivo.action.parameters.flow_token;
        if(modo==='apagado')await pool.query('UPDATE negocios SET bot_whatsapp_activo=false WHERE id=$1',[f.negocioId]);
        if(modo==='pausa')await pool.query('INSERT INTO conversaciones_control(negocio_id,telefono,bot_pausado) VALUES($1,$2,true)',[f.negocioId,f.telefono]);
        if(modo==='vencido')await pool.query("UPDATE agente_preguntas_interactivas SET created_at=now()-interval '31 minutes' WHERE outbox_clave=$1",[f.inicial.clave]);
        if(modo==='recibo')await f.procesar([f.respuesta(f.inicial,{revision:'2',items:[{producto0:'p0'}],modalidad:'m0',pago:'p0'})]);
        else await assert.rejects(atenderFlowRepetible(pool,{action:'INIT',flow_token:modo==='desconocido'?'xb1:abcdefghijklmnopqrstuv':token}),/no está disponible/);
        assert.equal((await f.leer()).carrito.items.length,0);
      }
    } finally {delete process.env.WHATSAPP_FLOW_ENDPOINT;delete process.env.WHATSAPP_FLOW_PRIVATE_KEY;delete process.env.META_APP_SECRET;}
  });
  await caso('continuo: selección + personalización; cuarto y quinto sin listas ni reconfigurar anteriores',async()=>{
    const f=await fixture({vacio:true,continuo:true}),foto=await f.foto(f.inicial);
    const p=foto.productos.findIndex(p=>p.id===String(f.mixtosId));
    const r={modalidad:'m0',pago:'p0'};
    for(let i=0;i<3;i++) {
      r[`producto${i}`]=`p${p}`;r[`g${i*6}_m`]=[`p${p}g0o${i}`];
      r[`g${i*6+1}_s`]=`p${p}g1o0`;r[`g${i*6+2}_m`]=[`p${p}g2o0`,`p${p}g2o1`];
    }
    const m=f.respuesta(f.inicial,r);
    let q=await f.procesar([m]),e=await f.leer();
    assert.equal(e.carrito.items.length,3);assert.equal(q.interactivo.type,'button');
    assert.match(q.texto,/\*Revisa tu pedido\*/);assert.match(q.texto,/\*Total: \$420\*/);
    const anteriores=structuredClone(e.carrito.items);
    assert.equal((await f.procesar([m])).r.repetido,true);
    assert.equal((await f.procesar([f.respuesta(f.inicial,r)])).r.sinRespuesta,true);
    q=await f.procesar([f.boton(q,'Agregar otro')]);assert.equal(q.interactivo.type,'flow');
    assert.equal(q.interactivo.action.parameters.flow_id,'33333333333');
    const r2={...r,producto2:'ninguno',g12_m:[],g13_s:'',g14_m:[]};
    q=await f.procesar([f.respuesta(q,r2)]);e=await f.leer();
    assert.equal(e.carrito.items.length,5);assert.equal(q.interactivo.type,'button');
    assert.deepEqual(e.carrito.items.slice(0,3),anteriores);assert.equal(e.folio,null);
    assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos_activos WHERE negocio_id=$1',[f.negocioId])).rows[0].n,0);
  });
  await caso('continuo: una elección ajena en el tercer plato no guarda ninguno',async()=>{
    const f=await fixture({vacio:true,continuo:true}),antes=(await f.leer()).carrito;
    const q=await f.procesar([f.respuesta(f.inicial,{producto0:'p0',producto2:'p0',g12_s:'p1g0o0',modalidad:'m0',pago:'p0'})]);
    assert.match(q.texto,/No apliqué/);assert.equal(q.interactivo.type,'flow');
    assert.deepEqual((await f.leer()).carrito,antes);
  });
  await caso('incidente combito + omelette: límite cero, selección, edición y reintentos conservan el pedido',async()=>{
    const f=await fixture({combito:true}),combito=(await f.leer()).carrito.items[0];
    const foto=await f.foto(f.inicial),d=f.inicial.interactivo.action.parameters.flow_action_payload.data;
    assert.equal(foto.lineas[1].ficha.grupos[1].maximo,4);assert.equal(d.g7_max,4);
    assert.deepEqual(d.g7_inicial_m,[]);assert.equal(d.g0_inicial_s,'o1');assert.equal(d.g3_inicial_s,'o1');
    const r={modalidad:'m0',pago:'p0'};
    for(let i=0;i<18;i++){r[`g${i}_s`]=d[`g${i}_inicial_s`];r[`g${i}_m`]=d[`g${i}_inicial_m`];}
    r.g7_m=['o0'];const m=f.respuesta(f.inicial,r);
    let q=await f.procesar([m]),e=await f.leer();
    assert.match(q.texto,/Total: \$325/);assert.doesNotMatch(q.texto,/Infinity|null|undefined/);
    assert.deepEqual(e.carrito.items[0],combito);assert.equal(e.folio,null);
    assert.deepEqual(e.carrito.items[1].modificadores.find(g=>g.grupo==='Tortillas').opciones,['Tortillas de harina']);
    const carrito=structuredClone(e.carrito);
    assert.equal((await f.procesar([m])).r.repetido,true);
    assert.equal((await f.procesar([f.respuesta(f.inicial,r)])).r.sinRespuesta,true);
    assert.deepEqual((await f.leer()).carrito,carrito);
    q=await f.procesar([f.boton(q,'Cambiar algo')]);assert.equal(q.interactivo.type,'flow');
    assert.deepEqual(q.interactivo.action.parameters.flow_action_payload.data.g7_inicial_m,['o0']);
    q=await f.procesar([f.respuesta(q,{...r,g7_m:['o0','o1']})]);assert.match(q.texto,/Total: \$325/);
    assert.deepEqual((await f.leer()).carrito.items[0],combito);
    assert.deepEqual((await f.leer()).carrito.items[1].modificadores.find(g=>g.grupo==='Tortillas').opciones,['Tortillas de harina','Tortillas de maiz']);
    assert.equal((await pool.query("SELECT maximo FROM menu_modificadores_grupos WHERE producto_id=$1 AND nombre='Tortillas'",[f.omeletteId])).rows[0].maximo,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos_activos WHERE negocio_id=$1',[f.negocioId])).rows[0].n,0);
  });
  await caso('listas sin Flows: límite cero persiste finito y permite dos tortillas y continuar',async()=>{
    const f=await fixture({combito:true,flows:false}),o=f.inicial;
    assert.match(o.texto,/1 a 4/);assert.doesNotMatch(o.texto,/Infinity|null/);
    const foto=await f.foto(o);assert.equal(foto.maximo,4);
    await f.procesar([f.boton(o,'Tortillas de harina')]);
    let q=await f.procesar([f.boton(o,'Tortillas de maiz')]);
    assert.deepEqual((await f.leer()).carrito.items[1].modificadores.find(g=>g.grupo==='Tortillas').opciones,['Tortillas de harina','Tortillas de maiz']);
    q=await f.procesar([f.boton(q,'Continuar')]);assert.match(q.texto,/Total: \$325/);assert.equal((await f.leer()).folio,null);
  });
  await caso('mixtos: dos salsas, dos proteínas y dos guarniciones en un formulario',async()=>{
    const f=await fixture({dosProteinas:true}),r=campos(f.inicial);r.g0_m=['o0','o1'];r.g1_m=['o0','o1'];
    await f.procesar([f.respuesta(f.inicial,r)]);
    assert.deepEqual((await f.leer()).carrito.items[0].modificadores.find(g=>g.grupo==='Proteína').opciones,['Pollo','Huevo']);
    assert.equal((await f.leer()).pendiente.tipo,'confirmar_resumen');
  });
  await caso('selección agrupada: dos salsas, proteína, dos guarniciones y entrega/pago en una sola respuesta',async()=>{
    const f=await fixture(),r=campos(f.inicial);r.g0_m=['o0','o1'];
    const q=await f.procesar([f.respuesta(f.inicial,r)]),e=await f.leer();
    assert.equal(e.carrito.items.length,1);assert.deepEqual(e.carrito.items[0].modificadores.find(g=>g.grupo==='Salsa').opciones,['Roja','Verde']);
    assert.equal(e.carrito.datos.forma_pago,'efectivo');assert.equal(e.pendiente.tipo,'confirmar_resumen');
    assert.match(q.texto,/Total: \$140/);assert.equal(e.folio,null);assert.equal(q.interactivo.type,'button');
    assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos_activos WHERE negocio_id=$1',[f.negocioId])).rows[0].n,0);
  });
  await caso('tres platillos iguales conservan renglones y selecciones independientes',async()=>{
    const f=await fixture({vacio:true});const foto=await f.foto(f.inicial),i=foto.productos.findIndex(p=>p.id===String(f.mixtosId));assert(i>=0);
    const q=await f.procesar([f.respuesta(f.inicial,{producto0:`p${i}`,producto1:`p${i}`,producto2:`p${i}`})]);
    assert.equal((await f.leer()).carrito.items.length,3);assert.equal(q.interactivo.type,'flow');
    const r=campos(q);r.g0_m=['o0','o1'];r.g6_m=['o2'];r.g12_m=['o3'];
    const fin=await f.procesar([f.respuesta(q,r)]),e=await f.leer();
    assert.equal(new Set(e.carrito.items.map(l=>l.lid)).size,3);
    assert.deepEqual(e.carrito.items.map(l=>l.modificadores.find(g=>g.grupo==='Salsa').opciones),[['Roja','Verde'],['Suiza'],['Chipotle']]);
    assert.match(fin.texto,/Total: \$425/);assert.equal(e.folio,null);
  });
  await caso('reenvío con otro wamid y reentrega del mismo wamid no repiten mutaciones',async()=>{
    const f=await fixture({vacio:true}),r={producto0:'p0',producto1:null,producto2:null},m=f.respuesta(f.inicial,r);
    await f.procesar([m]);const antes=(await f.leer()).carrito;
    assert.equal((await f.procesar([m])).r.repetido,true);
    assert.equal((await f.procesar([f.respuesta(f.inicial,r)])).r.sinRespuesta,true);
    assert.deepEqual((await f.leer()).carrito,antes);
  });
  await caso('respuesta inválida no aplica ni el primer grupo y muestra aviso junto al nuevo formulario',async()=>{
    const f=await fixture(),antes=(await f.leer()).carrito,r=campos(f.inicial);r.g2_m=['o0'];
    const q=await f.procesar([f.respuesta(f.inicial,r)]);
    assert.deepEqual((await f.leer()).carrito,antes);assert.match(q.texto,/No apliqué/);assert.equal(q.interactivo.type,'flow');
  });
  await caso('precio cambiado, formulario vencido y bandera apagada rechazan la foto antigua',async()=>{
    for(const tipo of ['precio','vencido','bandera']) {
      const f=await fixture(),antes=(await f.leer()).carrito;
      if(tipo==='precio')await pool.query('UPDATE menu_productos SET precio=precio+5 WHERE id=$1',[f.mixtosId]);
      if(tipo==='vencido')await pool.query("UPDATE agente_preguntas_interactivas SET created_at=now()-interval '31 minutes' WHERE outbox_clave=$1",[f.inicial.clave]);
      if(tipo==='bandera')await actualizarConfiguracion({whatsapp_flows_v1:'false'},f.negocioId);
      await f.procesar([f.respuesta(f.inicial,campos(f.inicial))]);assert.deepEqual((await f.leer()).carrito,antes);
    }
  });
  await caso('editar formulario: borrar extra opcional respeta salsa/proteína/guarniciones',async()=>{
    const f=await fixture({opcional:true}),r=campos(f.inicial);
    // Solo hay un extra disponible: el límite realizable es uno, aunque el
    // catálogo declare dos. La respuesta usa el control realmente mostrado.
    assert.equal(f.inicial.interactivo.action.parameters.flow_action_payload.data.g3_simple,true);
    r.g3_s='o0';
    let q=await f.procesar([f.respuesta(f.inicial,r)]);assert.match(q.texto,/Total: \$150/);
    q=await f.procesar([f.boton(q,'Cambiar algo')]);assert.equal(q.interactivo.type,'flow');
    const r2=campos(q);r2.g3_s='';r2.g3_m=[];
    q=await f.procesar([f.respuesta(q,r2)]);assert.match(q.texto,/Total: \$140/);
    assert(!(await f.leer()).carrito.items[0].modificadores.some(g=>g.grupo==='Extras' && g.opciones.length));
  });
  await caso('texto junto al formulario descarta selecciones del formulario',async()=>{
    const f=await fixture();await f.procesar([f.respuesta(f.inicial,campos(f.inicial)),f.texto('Verde')]);
    const e=await f.leer();assert.deepEqual(e.carrito.items[0].modificadores[0].opciones,['Verde']);
    assert.equal(e.carrito.datos.forma_pago,undefined);
  });
  await caso('bot apagado, pausa humana, teléfono/contexto ajenos y botón fingiendo Flow no tienen efecto',async()=>{
    for(const tipo of ['apagado','humano','telefono','contexto','falso']) {
      const f=await fixture(),antes=(await f.leer()).carrito,m=f.respuesta(f.inicial,campos(f.inicial));
      if(tipo==='apagado')await pool.query('UPDATE negocios SET bot_whatsapp_activo=false WHERE id=$1',[f.negocioId]);
      if(tipo==='humano')await pool.query('INSERT INTO conversaciones_control(negocio_id,telefono,bot_pausado) VALUES($1,$2,true)',[f.negocioId,f.telefono]);
      if(tipo==='telefono')m.from='5210000000000';
      if(tipo==='contexto')m.context.id='wamid.otro';
      if(tipo==='falso')m.interactive={type:'button_reply',button_reply:{id:f.inicial.interactivo.action.parameters.flow_token,title:'Confirmar'}};
      assert.equal((await f.procesar([m])).r.sinRespuesta,true);assert.deepEqual((await f.leer()).carrito,antes);
    }
  });
  await caso('bandera apagada y ventana de 24 h cerrada al enviar no despachan el Flow',async()=>{
    for(const tipo of ['bandera','24h']) {
      const f=await fixture({enviar:false});
      if(tipo==='bandera')await actualizarConfiguracion({whatsapp_flows_v1:'false'},f.negocioId);
      else await pool.query("UPDATE whatsapp_entradas SET recibido_at=now()-interval '25 hours',payload=jsonb_set(payload,'{message,timestamp}',to_jsonb((extract(epoch from now()-interval '25 hours'))::bigint::text)) WHERE negocio_id=$1",[f.negocioId]);
      let carga=null;
      await entregarRespuesta({outboxClave:f.inicial.clave,enviar:async c=>{carga=c;return {messages:[{id:'wamid.local'}]};},alHumano:async()=>true});
      if(tipo==='bandera'){assert.equal(carga.interactivo,null);assert.match(carga.texto,/no está disponible/);}
      else assert.equal(carga,null);
    }
  });
  await caso('campos extra, grupo oculto, opción falsa, duplicada o tipo inválido se rechazan',async()=>{
    const f=await fixture(),foto=await f.foto(f.inicial),base=campos(f.inicial);
    for(const cambio of [{total:1},{g17_s:'o0'},{g0_m:['o99']},{g0_m:['o0','o0']},{g0_s:'o0'},{g1_s:[]},{modalidad:'m99'},{pago:'p99'}])
      assert.equal(comandosFormulario(foto,{...base,...cambio}),null,JSON.stringify(cambio));
    assert.equal(leerRespuestaFlow({type:'interactive',interactive:{type:'nfm_reply',nfm_reply:{response_json:'{"flow_token":'}}}),null);
  });
  await caso('migraciones 104–106 repetidas preservan tokens y constraint ampliado',async()=>{
    const count=async()=>(await pool.query('SELECT count(*)::int n FROM agente_botones')).rows[0].n,antes=await count();
    for(let i=0;i<2;i++)for(const s of ['104-agente-elecciones','105-agente-edicion-interactiva','106-agente-flows'])execFileSync(process.execPath,[`scripts/predeploy-${s}.mjs`],{stdio:'pipe',timeout:30000});
    assert.equal(await count(),antes);
    const regla=(await pool.query("SELECT pg_get_constraintdef(oid) r FROM pg_constraint WHERE conrelid='agente_botones'::regclass AND conname='agente_botones_accion_check'")).rows[0].r;
    assert(regla.includes('flow_productos'));assert(regla.includes('flow_configurar'));
  });
  console.log(`Flows DB: ${n}/${n}. Red externa bloqueada, sin pedidos/pagos/tickets reales.`);
} finally {await pool.end();}
