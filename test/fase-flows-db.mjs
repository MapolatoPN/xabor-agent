import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pool,actualizarConfiguracion } from '../src/services/database.js';
import { prepararNegocioMixtos } from './lib-botones-local.mjs';
import { atenderConAgente } from '../src/mesero-agente/canalDelAgente.js';
import { entregarRespuesta } from '../src/mesero-agente/entregaDeRespuestas.js';
import { leerEstadoVersionado } from '../src/mesero-agente/persistenciaDelTurno.js';
import { comandosFormulario,leerRespuestaFlow } from '../src/mesero-agente/formularioAgrupado.js';
process.env.MESERO_AGENTE_MODE='true';process.env.WHATSAPP_INTERACTIVOS='true';
const noModelo=async()=>{throw Error('NO_MODELO');};
let n=0;
const caso=async(nombre,fn)=>{await fn();console.log(`OK Flow DB ${++n}: ${nombre}`);};
async function fixture({vacio=false,enviar=true,opcional=false,dosProteinas=false}={}) {
  const f=await prepararNegocioMixtos();
  if(dosProteinas)await pool.query("UPDATE menu_modificadores_grupos SET maximo=2 WHERE negocio_id=$1 AND producto_id=$2 AND nombre='Proteína'",[f.negocioId,f.mixtosId]);
  if(opcional) {
    const {rows:[g]}=await pool.query("INSERT INTO menu_modificadores_grupos(negocio_id,producto_id,nombre,requerido,minimo,maximo,orden) VALUES($1,$2,'Extras',false,0,2,3) RETURNING id",[f.negocioId,f.mixtosId]);
    await pool.query("INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,disponible,orden) VALUES($1,$2,'Queso',10,true,0)",[f.negocioId,g.id]);
    f.estado.carrito.items[0].modificadores=[{grupo:'Extras',opciones:['Queso']}];
  }
  if(vacio)f.estado.carrito.items=[];
  await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',[f.negocioId,`agente:${f.telefono}`,JSON.stringify(f.estado)]);
  await actualizarConfiguracion({whatsapp_flows_v1:'true',bot_whatsapp_solo_prueba:'true',
    bot_whatsapp_telefonos_prueba:f.telefono,whatsapp_flows_telefonos:f.telefono,
    whatsapp_flow_productos_id:'11111111111',whatsapp_flow_configurar_id:'22222222222'},f.negocioId);
  const leer=()=>leerEstadoVersionado(f.negocioId,f.telefono);
  const identidad=()=>({id:`wamid.flow.${randomUUID()}`,from:f.telefono,timestamp:String(Math.floor(Date.now()/1000))});
  const texto=body=>({...identidad(),type:'text',text:{body}});
  const respuesta=(q,fields)=>({...identidad(),type:'interactive',context:{id:q.wamid},interactive:{type:'nfm_reply',nfm_reply:{
    name:'flow',body:'Sent',response_json:JSON.stringify({flow_token:q.interactivo.action.parameters.flow_token,...fields})}}});
  const boton=(q,title)=>({...identidad(),type:'interactive',context:{id:q.wamid},interactive:{type:'button_reply',button_reply:{
    id:q.interactivo.action.buttons.find(b=>b.reply.title===title).reply.id,title:'no autoridad'}}});
  const foto=async q=>(await pool.query('SELECT b.datos FROM agente_botones b JOIN agente_preguntas_interactivas q ON q.id=b.pregunta_id WHERE q.outbox_clave=$1',[q.clave])).rows[0].datos;
  const procesar=async(mensajes,{enviar=true}={})=>{
    for(const m of mensajes)await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado') ON CONFLICT DO NOTHING",[f.negocioId,f.telefono,m.id,JSON.stringify({message:m})]);
    const toques=mensajes.filter(m=>m.type==='interactive'),textos=mensajes.filter(m=>m.type==='text');
    const r=await atenderConAgente({...f,mensaje:textos.map(m=>m.text.body).join('\n'),wamids:mensajes.map(m=>m.id),
      ...(toques.length?{interaccion:{mensajes:toques,mixto:!!textos.length}}:{}),llamarModelo:noModelo});
    assert.equal(r.ok,true,JSON.stringify(r));
    if(!r.outbox)return {r};
    const q=(await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1',[r.outbox.clave])).rows[0];
    const wamid=`wamid.flow.out.${randomUUID()}`;
    if(enviar && !r.yaEntregado)assert.equal((await entregarRespuesta({outboxClave:q.evento_clave,enviar:async()=>({messages:[{id:wamid}]}),alHumano:async()=>true})).estado,'entregado');
    return {r,...q.carga,clave:q.evento_clave,wamid};
  };
  const inicial=await procesar([texto('Hola')],{enviar});
  assert.equal(inicial.interactivo?.type,'flow',JSON.stringify(inicial.r));
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
    const f=await fixture({opcional:true}),r=campos(f.inicial);r.g3_m=['o0'];
    let q=await f.procesar([f.respuesta(f.inicial,r)]);assert.match(q.texto,/Total: \$150/);
    q=await f.procesar([f.boton(q,'Cambiar algo')]);assert.equal(q.interactivo.type,'flow');
    const r2=campos(q);r2.g3_m=[];
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
