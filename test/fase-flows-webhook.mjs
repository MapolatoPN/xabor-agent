// Webhook firmado y dos procesos reales; Meta/modelo están SOLO en localhost.
import assert from 'node:assert/strict';
import { createHmac,generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { peticionCifrada } from './lib-flow-cifrado.mjs';
import { createServer } from 'node:http';
import { pool,actualizarConfiguracion } from '../src/services/database.js';
import { prepararNegocioMixtos,prepararNegocioCombitoOmelette } from './lib-botones-local.mjs';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';
const incidente=process.argv.includes('--combito-omelette');
const continuo=process.argv.includes('--continuo');
const categorias=process.argv.includes('--categorias');
const repetible=process.argv.includes('--repetible') || categorias;
const notasEsperadas=['Sin crema','Huevos bien cocidos','','Salsa aparte','Sin cebolla','','Sin queso','Bien calientes'];
const llaves=repetible?generateKeyPairSync('rsa',{modulusLength:2048,
  privateKeyEncoding:{format:'pem',type:'pkcs8'},publicKeyEncoding:{format:'pem',type:'spki'}}):null;
const f=await (incidente?prepararNegocioCombitoOmelette():prepararNegocioMixtos()),{negocioId,telefono,marca}=f;
const combito=incidente?structuredClone(f.estado.carrito.items[0]):null;
let totalEsperado=incidente?325:425,numeroLineas=incidente?2:3;
await actualizarConfiguracion({whatsapp_flows_v1:'true',bot_whatsapp_solo_prueba:'true',whatsapp_flows_telefonos:telefono,
  whatsapp_flow_productos_id:'11111111111',whatsapp_flow_configurar_id:'22222222222',
  ...(continuo?{whatsapp_flow_pedido_id:'33333333333'}:{})},negocioId);
if(repetible) {
  execFileSync(process.execPath,['scripts/predeploy-107-agente-flow-repetible.mjs'],{stdio:'pipe',timeout:30000});
  await actualizarConfiguracion({whatsapp_flow_repetible_id:'44444444444'},negocioId);
}
if(categorias) {
  await actualizarConfiguracion({whatsapp_flow_categorias_id:'55555555555'},negocioId);
  const {rows:[c]}=await pool.query("INSERT INTO menu_categorias(negocio_id,nombre,activa) VALUES($1,'TACOS',true) RETURNING id",[negocioId]);
  for(const [ordenProducto,[nombre,precio]] of [['Taco de bistec',30],['Taco de papa',25]].entries()) {
    const {rows:[p]}=await pool.query('INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio,disponible,orden) VALUES($1,$2,$3,$4,true,$5) RETURNING id',[negocioId,c.id,nombre,precio,ordenProducto]);
    await pool.query('INSERT INTO whatsapp_productos(negocio_id,producto_id,publicado) VALUES($1,$2,true)',[negocioId,p.id]);
    const {rows:[g]}=await pool.query("INSERT INTO menu_modificadores_grupos(negocio_id,producto_id,nombre,requerido,minimo,maximo) VALUES($1,$2,'Tortilla',true,1,1) RETURNING id",[negocioId,p.id]);
    for(const [orden,opcion] of ['Harina','Maíz'].entries())await pool.query('INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,disponible,orden) VALUES($1,$2,$3,0,true,$4)',[negocioId,g.id,opcion,orden]);
  }
}
if(!incidente)f.estado.carrito.items=[];
await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',[negocioId,`agente:${telefono}`,JSON.stringify(f.estado)]);
const secreto='flows-solo-local',salidas=[];
let s1,s2,meta,ia,secuencia=0;
const parar=async s=>{if(!s||s.proc.exitCode!==null||s.proc.signalCode!==null)return;const fin=new Promise(r=>s.proc.once('exit',r));s.detener();await fin;};
const leer=async()=> (await pool.query('SELECT estado FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2',[negocioId,`agente:${telefono}`])).rows[0].estado;
const esperar=async fn=>{const fin=Date.now()+45000;while(Date.now()<fin){if(await fn())return;await new Promise(r=>setTimeout(r,100));}
  throw Error(`Timeout\n${s1?.obtenerSalida().slice(-5000)}\n${s2?.obtenerSalida().slice(-5000)}`);};
const identidad=()=>({id:`wamid.FLOW-${marca}-${++secuencia}`,from:telefono,timestamp:String(Math.floor(Date.now()/1000))});
const texto=body=>({...identidad(),type:'text',text:{body}});
const respuesta=(q,campos)=>({...identidad(),type:'interactive',context:{id:q.id},interactive:{type:'nfm_reply',nfm_reply:{
  name:'flow',body:'Sent',response_json:JSON.stringify({flow_token:q.interactive.action.parameters.flow_token,...campos})}}});
const toque=(q,title)=>({...identidad(),type:'interactive',context:{id:q.id},interactive:{type:'button_reply',button_reply:{
  id:q.interactive.action.buttons.find(b=>b.reply.title===title).reply.id,title}}});
const post=async(base,messages)=>{
  const body=JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{
    metadata:{phone_number_id:marca},contacts:[{wa_id:telefono,profile:{name:'Cliente local'}}],messages}}]}]});
  const r=await fetch(`${base}/webhook/whatsapp`,{method:'POST',body,headers:{'Content-Type':'application/json',
    'X-Hub-Signature-256':`sha256=${createHmac('sha256',secreto).update(body).digest('hex')}`}});assert.equal(r.status,200);
};
const procesar=async(messages,n=1)=>{const antes=salidas.length;await Promise.all([post(s1.base,messages),post(s2.base,messages)]);
  await esperar(async()=> (await pool.query("SELECT count(*)::int n FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=ANY($2::text[]) AND estado='completado'",[negocioId,messages.map(m=>m.id)])).rows[0].n===messages.length);
  assert.equal(salidas.length,antes+n,'una sola respuesta por pregunta');return salidas.at(-1);};
try {
  meta=createServer((req,res)=>{let b='';req.on('data',x=>b+=x);req.on('end',()=>{
    const p=JSON.parse(b);res.setHeader('Content-Type','application/json');
    if(p.status==='read'){res.end('{"success":true}');return;}
    assert.equal(p.to,telefono);const id=`wamid.FLOW-OUT-${marca}-${salidas.length}`;
    salidas.push({...p,id});res.end(JSON.stringify({messages:[{id}]}));
  });});
  await new Promise(r=>meta.listen(0,'127.0.0.1',r));ia=await arrancarAnthropicMock();
  const env={META_GRAPH_BASE_URL:`http://127.0.0.1:${meta.address().port}`,ANTHROPIC_BASE_URL:ia.baseUrl,
    ANTHROPIC_API_KEY:'test-only',META_APP_SECRET:secreto,MESERO_AGENTE_MODE:'true',WHATSAPP_INTERACTIVOS:'true',
    ...(repetible?{WHATSAPP_FLOW_ENDPOINT:'true',WHATSAPP_FLOW_PRIVATE_KEY:llaves.privateKey}:{})};
  s1=await arrancarServidor({...env,PORT:'55974'});s2=await arrancarServidor({...env,PORT:'55975'});
  let q=await procesar([texto('Hola')]);assert.equal(q.interactive.type,'flow');
  if(repetible) {
    const inicial=q,token=q.interactive.action.parameters.flow_token;
    assert.equal(q.interactive.action.parameters.flow_action,'data_exchange');
    const pedir=async(base,solicitud)=>{
      const p=peticionCifrada({version:'3.0',flow_token:token,...solicitud},llaves.publicKey,secreto);
      const r=await fetch(`${base}/webhook/flows/pedido`,{method:'POST',body:p.body,headers:p.headers});
      assert.equal(r.status,200);return p.descifrar(await r.text());
    };
    let vista=await pedir(s1.base,{action:'INIT'});
    if(categorias) {
      assert.equal(vista.screen,'MENU');
      const cats=vista.data.categorias;
      vista=await pedir(s1.base,{action:'data_exchange',screen:'MENU',data:{revision:vista.data.revision,operacion:'categoria',categoria:cats.find(c=>c.title==='TACOS').id}});
      assert.equal(vista.screen,'TACOS');
      const lote={action:'data_exchange',screen:'TACOS',data:{revision:vista.data.revision,operacion:'agregar',tortilla:'maiz',t0_q:'2',t1_q:'3',t0_nota:'Sin cebolla',t1_nota:'Bien cocidos'}};
      const [a,b]=await Promise.all([pedir(s1.base,lote),pedir(s2.base,lote)]);assert.deepEqual(a,b);vista=a;
      assert.equal((await leer()).carrito.items.length,0);
      await parar(s1);await parar(s2);s1=await arrancarServidor({...env,PORT:'55974'});s2=await arrancarServidor({...env,PORT:'55975'});
      assert.deepEqual(await pedir(s1.base,{action:'INIT'}),vista);
      const revisionAntesDeAtras=vista.data.revision;
      const volver={action:'BACK',screen:'TACOS'};
      const regresos=await Promise.all([pedir(s1.base,volver),pedir(s2.base,volver)]);
      assert.deepEqual(regresos[0],regresos[1],'BACK concurrente produce un solo regreso');vista=regresos[0];
      assert.equal(vista.screen,'MENU');assert.notEqual(vista.data.revision,revisionAntesDeAtras);
      assert.deepEqual(await pedir(s2.base,volver),vista,'reintento de BACK conserva pantalla y revisión');
      vista=await pedir(s2.base,{action:'data_exchange',screen:'MENU',data:{revision:vista.data.revision,operacion:'categoria',categoria:cats.find(c=>c.title==='Bebidas').id}});
      assert.equal(vista.screen,'PLATILLO');
      assert(vista.data.productos0.every(p=>!p.title.startsWith('Taco')));
      const p=vista.data.productos0.find(p=>p.title==='Chilaquiles Mixtos').id;
      vista=await pedir(s1.base,{action:'data_exchange',screen:'PLATILLO',data:{revision:vista.data.revision,operacion:'terminar',producto0:p,cantidad:'2',observaciones:'Sin crema',
        g0_m:[`${p}g0o0`,`${p}g0o1`],g1_s:`${p}g1o0`,g2_m:[`${p}g2o0`,`${p}g2o1`]}});
      assert.equal(vista.screen,'ENTREGA');
      vista=await pedir(s1.base,{action:'BACK',screen:'ENTREGA'});
      assert.equal(vista.screen,'PLATILLO');assert.equal(vista.data.producto_inicial,'');
      assert.equal(vista.data.cantidad_inicial,'1');
      const revisionTrasRegresar=vista.data.revision;
      await parar(s1);s1=await arrancarServidor({...env,PORT:'55974'});
      assert.deepEqual(await pedir(s1.base,{action:'INIT'}),vista,'historial y revisión sobreviven al reinicio');
      vista=await pedir(s2.base,{action:'data_exchange',screen:'PLATILLO',data:{revision:revisionTrasRegresar,operacion:'terminar'}});
      assert.equal(vista.screen,'ENTREGA','terminar después de regresar no añade otra copia');
      vista=await pedir(s2.base,{action:'data_exchange',screen:'ENTREGA',data:{revision:vista.data.revision,operacion:'revisar',modalidad:'m0',pago:'p0'}});
      q=await procesar([respuesta(inicial,{revision:vista.data.extension_message_response.params.revision})]);
      await procesar([respuesta(inicial,{revision:vista.data.extension_message_response.params.revision})],0);
      assert.deepEqual((await leer()).carrito.items.map(i=>i.cantidad),[2,3,2]);
      assert.deepEqual((await leer()).carrito.items.map(i=>i.nombre),['Taco de bistec','Taco de papa','Chilaquiles Mixtos']);
      assert.deepEqual((await leer()).carrito.items.map(i=>i.notas),['Sin cebolla','Bien cocidos','Sin crema']);
      totalEsperado=415;numeroLineas=3;
      assert((q.interactive?.body.text || q.text?.body).includes('*Total: $415*'),JSON.stringify(q));
      assert.equal(salidas.length,2);
      console.log('OK HTTP categorías: tacos 2+3, mixtos x2, notas por grupo, reinicio, dos procesos, recibo repetido, solo apertura y resumen.');
    } else {
    const producto=vista.data.productos0.find(p=>p.title==='Chilaquiles Mixtos').id;
    for(let i=0;i<8;i++) {
      const r={action:'data_exchange',screen:'PLATILLO',data:{revision:vista.data.revision,operacion:'agregar',producto0:producto,
        g0_m:[`${producto}g0o0`,`${producto}g0o1`],g1_s:`${producto}g1o0`,g2_m:[`${producto}g2o0`,`${producto}g2o1`],
        ...(notasEsperadas[i]?{observaciones:notasEsperadas[i]}:{})}};
      const [a,b]=await Promise.all([pedir(s1.base,r),pedir(s2.base,r)]);assert.deepEqual(a,b);vista=a;
      assert.equal(vista.data.revision,String(i+1));assert.equal((await leer()).carrito.items.length,0);
      assert.equal(vista.data.observaciones_inicial,'','el siguiente platillo empieza sin nota');
      if(i===2) {
        await parar(s1);await parar(s2);
        s1=await arrancarServidor({...env,PORT:'55974'});s2=await arrancarServidor({...env,PORT:'55975'});
        assert.deepEqual(await pedir(s1.base,{action:'INIT'}),vista);
      }
    }
    vista=await pedir(s1.base,{action:'data_exchange',screen:'PLATILLO',data:{revision:vista.data.revision,operacion:'terminar'}});
    assert.equal(vista.screen,'ENTREGA');assert.equal((await leer()).folio,null);
    vista=await pedir(s2.base,{action:'data_exchange',screen:'ENTREGA',data:{revision:vista.data.revision,operacion:'revisar',modalidad:'m0',pago:'p0'}});
    const recibo=vista.data.extension_message_response.params;
    q=await procesar([respuesta(inicial,{revision:recibo.revision})]);
    await procesar([respuesta(inicial,{revision:recibo.revision})],0);
    numeroLineas=8;totalEsperado=1120;
    assert.equal((await leer()).carrito.items.length,8);assert.equal((await leer()).folio,null);
    assert.deepEqual((await leer()).carrito.items.map(i=>i.notas||''),notasEsperadas,'notas por renglón después de reiniciar');
    assert((q.interactive?.body.text || q.text?.body).includes('*Total: $1120*'));
    for(const nota of notasEsperadas.filter(Boolean))assert((q.interactive?.body.text || q.text?.body).includes(`Nota: ${nota}`));
    assert.equal(salidas.length,2,'no hay mensajes entre cada platillo');
    console.log('OK HTTP repetible: ocho platillos, dos procesos cifrados, doble toque, reinicio tras tercero, una única salida final.');
    }
  } else {
  let productoContinuo;
  if(continuo)productoContinuo=q.interactive.action.parameters.flow_action_payload.data.productos0.find(o=>o.title==='Chilaquiles Mixtos').id;
  if(!incidente && !continuo) {
    const opciones=q.interactive.action.parameters.flow_action_payload.data.productos;
    const mixtos=opciones.find(o=>o.title==='Chilaquiles Mixtos').id;
    q=await procesar([respuesta(q,{producto0:mixtos,producto1:mixtos,producto2:mixtos})]);
  }
  assert.equal((await leer()).carrito.items.length,continuo?0:numeroLineas);assert.equal(q.interactive.type,'flow');
  assert.doesNotMatch(q.interactive.body.text,/Infinity|null|undefined/);
  // El cliente deja abierto el formulario y los servidores reinician.
  await parar(s1);await parar(s2);
  s1=await arrancarServidor({...env,PORT:'55974'});s2=await arrancarServidor({...env,PORT:'55975'});
  const campos={modalidad:'m0',pago:'p0'};
  if(incidente) {
    const data=q.interactive.action.parameters.flow_action_payload.data;
    assert.equal(data.g7_max,4);assert.equal(data.g0_inicial_s,'o1');assert.equal(data.g3_inicial_s,'o1');
    for(let i=0;i<18;i++){campos[`g${i}_s`]=data[`g${i}_inicial_s`];campos[`g${i}_m`]=data[`g${i}_inicial_m`];}
    campos.g7_m=['o0','o1'];
  } else for(const [l,salsas] of [['0',['o0','o1']],['1',['o2']],['2',['o3']]]) {
    const base=Number(l)*6;campos[`g${base}_m`]=salsas;campos[`g${base+1}_s`]='o0';campos[`g${base+2}_m`]=['o0','o1'];
  }
  if(continuo)for(let l=0;l<3;l++) {
    campos[`producto${l}`]=productoContinuo;
    for(let g=0;g<6;g++)for(const t of ['s','m']) {
      const k=`g${l*6+g}_${t}`;
      if(campos[k])campos[k]=t==='m'?campos[k].map(id=>`${productoContinuo}g${g}${id}`):`${productoContinuo}g${g}${campos[k]}`;
    }
  }
  const formulario=q,m=respuesta(formulario,campos);
  q=await procesar([m]);assert(q.interactive.body.text.includes(`Total: $${totalEsperado}`));
  assert.equal((await leer()).folio,null);assert.equal((await leer()).carrito.items.length,numeroLineas);
  if(incidente) {
    assert.deepEqual((await leer()).carrito.items[0],combito);
    assert.deepEqual((await leer()).carrito.items[1].modificadores.find(g=>g.grupo==='Tortillas').opciones,['Tortillas de harina','Tortillas de maiz']);
  }
  await procesar([respuesta(formulario,campos)],0);
  if(continuo) {
    const anteriores=structuredClone((await leer()).carrito.items);
    q=await procesar([toque(q,'Agregar otro')]);assert.equal(q.interactive.type,'flow');
    assert.equal(q.interactive.action.parameters.flow_id,'33333333333');
    const otros={...campos,producto2:'ninguno',g12_m:[],g13_s:'',g14_m:[]};
    q=await procesar([respuesta(q,otros)]);numeroLineas=5;totalEsperado=705;
    assert.equal((await leer()).carrito.items.length,5);
    assert.deepEqual((await leer()).carrito.items.slice(0,3),anteriores);
    assert(q.interactive.body.text.includes(`Total: $${totalEsperado}`));
    assert.equal(salidas.filter(s=>['list'].includes(s.interactive?.type)).length,0,'el cuarto y quinto no regresan a listas');
  }
  console.log(`OK HTTP Flow: ${incidente?'combito + omelette sin límite':'tres platillos'}, reinicio, multiselección completa, dos procesos y duplicado sin efecto.`);
  }
  const resumen=q;
  if(repetible && !resumen.interactive)await procesar([texto('Confirmo')]);
  else {await procesar([toque(resumen,'Confirmar')]);await procesar([toque(resumen,'Confirmar')],0);}
  const e=await leer();assert(e.hechos.confirmado);
  const pedidos=(await pool.query('SELECT datos FROM pedidos_activos WHERE negocio_id=$1',[negocioId])).rows;
  assert.equal(pedidos.length,1);assert.equal(Number(pedidos[0].datos.total),totalEsperado);
  if(repetible)assert.deepEqual(pedidos[0].datos.items.map(i=>i.notas||''),categorias?['Sin cebolla','Bien cocidos','Sin crema']:notasEsperadas,'las notas llegan al pedido de cocina');
  const trazas=(await pool.query('SELECT errores_proveedor,acciones FROM agente_turnos WHERE negocio_id=$1',[negocioId])).rows;
  assert(trazas.every(t=>!t.errores_proveedor?.length&&!t.acciones.some(a=>a.origen==='modelo')));
  assert(salidas.every(s=>!JSON.stringify(s).includes('flow_token\\"')));
  console.log(`OK HTTP Flow: una confirmación final crea exactamente un pedido LOCAL de $${totalEsperado}; ninguna llamada al modelo.`);
} finally {await parar(s1);await parar(s2);ia?.detener();meta?.closeAllConnections();meta?.close();await pool.end();}
