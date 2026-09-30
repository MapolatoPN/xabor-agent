import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool,actualizarConfiguracion } from '../src/services/database.js';
import { prepararNegocioBotones } from './lib-botones-local.mjs';
import { atenderConAgente } from '../src/mesero-agente/canalDelAgente.js';
import { leerEstadoVersionado } from '../src/mesero-agente/persistenciaDelTurno.js';
import { entregarRespuesta } from '../src/mesero-agente/entregaDeRespuestas.js';
import { atenderFlowRepetible } from '../src/mesero-agente/flowRepetibleSql.js';
import { autorizaConfirmacion } from '../src/mesero-agente/contratoConversacional.js';
Object.assign(process.env,{MESERO_AGENTE_MODE:'true',WHATSAPP_INTERACTIVOS:'true',WHATSAPP_FLOW_ENDPOINT:'true',
  WHATSAPP_FLOW_PRIVATE_KEY:'solo-local',META_APP_SECRET:'solo-local'});
const noModelo=async()=>{throw Error('NO_DEBE_LLAMAR_MODELO');};
const sinEfectos=async()=>{throw Error('NO_PEDIDOS_PAGOS_TICKETS');};
let n=0;
async function caso(nombre,fn){await fn();console.log(`OK beta DB ${++n}: ${nombre}`);}
async function fixture({vacio=false}={}) {
  const f=await prepararNegocioBotones();
  if(vacio){f.estado.carrito.items=[];await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',[f.negocioId,`agente:${f.telefono}`,JSON.stringify(f.estado)]);}
  await actualizarConfiguracion({whatsapp_beta_hibrido_v1:'true',whatsapp_beta_telefonos:f.telefono,
    bot_whatsapp_solo_prueba:'true',whatsapp_flows_telefonos:f.telefono,whatsapp_flows_v1:'true',
    whatsapp_interactivos_elecciones_v1:'true',whatsapp_flow_categorias_id:'11111111111',whatsapp_flow_carrito_id:'22222222222',
    whatsapp_flow_carrito_duplicar_v1:'true',whatsapp_catalogo_nativo_v1:'true',whatsapp_catalogo_meta_id:'33333333333',
    whatsapp_catalogo_meta_mapa:JSON.stringify([{retailer_id:'cafe',producto_id:String(f.productoId),opciones:[]}])},f.negocioId);
  const leer=()=>leerEstadoVersionado(f.negocioId,f.telefono);
  const identidad=()=>({id:'wamid.beta.'+randomUUID(),from:f.telefono,timestamp:String(Math.floor(Date.now()/1000))});
  const texto=body=>({...identidad(),type:'text',text:{body}});
  const carrito=()=>({...identidad(),type:'order',order:{catalog_id:'33333333333',product_items:[{product_retailer_id:'cafe',quantity:'3',item_price:'45',currency:'MXN'}]}});
  const procesar=async(m,{modelo=noModelo,nativo=m.type==='order',enviar=true}={})=>{
    await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado') ON CONFLICT DO NOTHING",[f.negocioId,f.telefono,m.id,JSON.stringify({message:m})]);
    const r=await atenderConAgente({...f,mensaje:m.text?.body || '',wamids:[m.id],pedidoCatalogo:nativo,llamarModelo:modelo,
      registrar:sinEfectos,emitir:sinEfectos,guardar:sinEfectos,crearPago:sinEfectos});
    assert.equal(r.ok,true,JSON.stringify(r));
    if(!r.outbox)return {r};
    const {rows:[fila]}=await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1',[r.outbox.clave]);
    const wamid='wamid.salida.'+randomUUID();
    if(enviar && !r.yaEntregado)assert.equal((await entregarRespuesta({outboxClave:fila.evento_clave,enviar:async()=>({messages:[{id:wamid}]}),alHumano:sinEfectos})).estado,'entregado');
    return {...fila.carga,r,wamid};
  };
  return {...f,leer,texto,carrito,procesar};
}
const token=q=>q.interactivo.action.parameters.flow_token;
const abrir=q=>atenderFlowRepetible(pool,{action:'INIT',flow_token:token(q)});
try {
  await caso('pregunta con un alta no pierde el cambio; consulta de cortesía no autoriza altas',async()=>{
    const f=await fixture();let llamadas=0;
    await f.procesar(f.texto('Añádeme 2 cafés americanos y dime a qué hora cierran'),{modelo:async({tools})=>{
      assert(tools.some(t=>t.name==='agregar_producto'),'el cambio no debe degradarse a solo consulta');
      if(llamadas++===0)return {content:[{type:'tool_use',id:'alta-mixta-local',name:'agregar_producto',
        input:{producto_id:String(f.productoId),cantidad:2}}],stop_reason:'tool_use'};
      return {content:[{type:'text',text:'En este local de prueba atendemos todo el día.'}],stop_reason:'end_turn'};
    }});
    const estado=await f.leer();
    assert.equal(estado.carrito.items.reduce((n,i)=>n+i.cantidad,0),3);
    assert.equal(estado.folio,null);
    const antes=structuredClone(estado.carrito);let consultas=0;
    const q=await f.procesar(f.texto('Quiero saber a qué hora cierran'),{modelo:async({tools})=>{
      assert(!tools.some(t=>t.name==='agregar_producto'),'la cortesía no concede autoridad');
      if(consultas++===0)return {content:[{type:'tool_use',id:'alta-no-autorizada-local',name:'agregar_producto',
        input:{producto_id:String(f.productoId),cantidad:8}}],stop_reason:'tool_use'};
      return {content:[{type:'text',text:'En este local de prueba atendemos todo el día.'}],stop_reason:'end_turn'};
    }});
    assert.deepEqual((await f.leer()).carrito,antes);
    assert.match(q.texto,/atendemos todo el día/);
    assert.equal(q.interactivo.action.parameters.flow_cta,'Continuar pedido');
  });
  await caso('consulta conserva respuesta, carrito y edición pendiente; retomar invalida la ventana anterior',async()=>{
    const f=await fixture(),antes=(await f.leer()).carrito;
    const q=await f.procesar(f.texto('seguir pedido'));assert.equal(q.interactivo.type,'flow');
    let v=await abrir(q);assert.equal(v.screen,'CARRITO');
    v=await atenderFlowRepetible(pool,{action:'data_exchange',flow_token:token(q),screen:'CARRITO',data:{revision:v.data.revision,operacion:'duplicar',duplicar:'e0'}});
    assert.equal(v.data.q1_inicial,'1');
    const respuesta='Estamos disponibles durante el horario publicado.';
    const consulta=await f.procesar(f.texto('¿A qué hora cierran?'),{modelo:async()=>({content:[{type:'text',text:respuesta}],stop_reason:'end_turn'})});
    assert.match(consulta.texto,/Estamos disponibles/);assert.equal(consulta.interactivo.action.parameters.flow_cta,'Continuar pedido');
    assert.deepEqual((await f.leer()).carrito,antes);assert.notEqual((await f.leer()).pendiente.tipo,'confirmar_resumen');
    assert.equal(autorizaConfirmacion({estado:await f.leer(),mensaje:'sí',huella:'resumen-anterior'}),false);
    const retomada=await abrir(consulta);assert.equal(retomada.data.q1_inicial,'1','recupera copia recibida por servidor, no vuelve a cero');
    await assert.rejects(abrir(q),e=>e.status===427);
    // Cambio concurrente real invalida cualquier recuperación basada en otra foto.
    const e=await f.leer();e.carrito.items[0].cantidad=7;
    await pool.query('UPDATE conversacion_estado SET estado=$3,revision=revision+1 WHERE negocio_id=$1 AND session_id=$2',[f.negocioId,`agente:${f.telefono}`,JSON.stringify(e)]);
    const nueva=await f.procesar(f.texto('abrir carrito'));v=await abrir(nueva);
    assert.equal(v.data.q0_inicial,'7');assert.equal(v.data.r1_visible,false,'no mezcla edición vieja con pedido nuevo');
  });
  await caso('catálogo persistido: misma entrada aplicada una vez; segundo carrito no suma',async()=>{
    const f=await fixture({vacio:true}),m=f.carrito();
    const a=await f.procesar(m);assert.equal((await f.leer()).carrito.items[0].cantidad,3);
    assert.match(a.texto,/Café americano/);
    await f.procesar(m);assert.equal((await f.leer()).carrito.items[0].cantidad,3);
    const b=await f.procesar(f.carrito());assert.match(b.texto,/No sumé otro carrito/);
    assert.equal((await f.leer()).carrito.items.length,1);assert.equal((await f.leer()).folio,null);
  });
  await caso('precio diferente no cambia nada y se explica sin afirmar que se agregó',async()=>{
    const f=await fixture({vacio:true}),m=f.carrito();m.order.product_items[0].item_price='40';
    const r=await f.procesar(m);assert.match(r.texto,/precio vigente/);assert.equal((await f.leer()).carrito.items.length,0);
  });
  await caso('bot apagado, pausa humana, takeover y beta apagada no ejecutan catálogo',async()=>{
    for(const tipo of ['maestro','pausa','takeover','beta']) {
      const f=await fixture({vacio:true});
      if(tipo==='maestro')await pool.query('UPDATE negocios SET bot_whatsapp_activo=false WHERE id=$1',[f.negocioId]);
      if(tipo==='pausa')await pool.query('INSERT INTO conversaciones_control(negocio_id,telefono,bot_pausado) VALUES($1,$2,true)',[f.negocioId,f.telefono]);
      if(tipo==='takeover')await pool.query("UPDATE clientes SET human_takeover_until=now()+interval '1 hour' WHERE negocio_id=$1 AND telefono=$2",[f.negocioId,f.telefono]);
      if(tipo==='beta')await actualizarConfiguracion({whatsapp_beta_hibrido_v1:'false'},f.negocioId);
      const r=await f.procesar(f.carrito());assert.equal(r.r.sinRespuesta,true,tipo);assert.equal((await f.leer()).carrito.items.length,0,tipo);
    }
  });
  await caso('wamid ajeno a negocio o teléfono nunca aporta autoridad',async()=>{
    const a=await fixture({vacio:true}),b=await fixture({vacio:true}),m=a.carrito();
    await a.procesar(m);
    const r=await atenderConAgente({...b,mensaje:'',wamids:[m.id],pedidoCatalogo:true,llamarModelo:noModelo,
      registrar:sinEfectos,emitir:sinEfectos,guardar:sinEfectos,crearPago:sinEfectos});
    assert.equal(r.ok,true);assert.equal((await b.leer()).carrito.items.length,0);
  });
  await caso('edición expirada no se recupera; no se mezcla con un borrador actual',async()=>{
    const f=await fixture(),q=await f.procesar(f.texto('seguir pedido'));
    const v=await abrir(q);
    await atenderFlowRepetible(pool,{action:'data_exchange',flow_token:token(q),screen:'CARRITO',data:{revision:v.data.revision,operacion:'duplicar',duplicar:'e0'}});
    await pool.query("UPDATE agente_preguntas_interactivas SET created_at=now()-interval '31 minutes' WHERE negocio_id=$1",[f.negocioId]);
    const siguiente=await f.procesar(f.texto('seguir pedido')),actual=await abrir(siguiente);
    assert.equal(actual.data.r1_visible,false);assert.equal(actual.data.q0_inicial,'1');
  });
  await caso('pausa posterior al commit también impide avisos de texto de la beta',async()=>{
    for(const tipo of ['maestro','pausa','takeover','revision','beta','catalogo','piloto','ventana']) {
      const f=await fixture({vacio:true}),m=f.carrito();m.order.product_items[0].item_price='40';
      const q=await f.procesar(m,{enviar:false});assert.equal(q.beta,'catalogo');assert(!q.interactivo);
      if(tipo==='maestro')await pool.query('UPDATE negocios SET bot_whatsapp_activo=false WHERE id=$1',[f.negocioId]);
      if(tipo==='pausa')await pool.query('INSERT INTO conversaciones_control(negocio_id,telefono,bot_pausado) VALUES($1,$2,true)',[f.negocioId,f.telefono]);
      if(tipo==='takeover')await pool.query("UPDATE clientes SET human_takeover_until=now()+interval '1 hour' WHERE negocio_id=$1 AND telefono=$2",[f.negocioId,f.telefono]);
      if(tipo==='revision')await pool.query('UPDATE whatsapp_conversaciones SET requiere_revision=true WHERE negocio_id=$1 AND telefono=$2',[f.negocioId,f.telefono]);
      if(tipo==='beta')await actualizarConfiguracion({whatsapp_beta_hibrido_v1:'false'},f.negocioId);
      if(tipo==='catalogo')await actualizarConfiguracion({whatsapp_catalogo_nativo_v1:'false'},f.negocioId);
      if(tipo==='piloto')await actualizarConfiguracion({whatsapp_beta_telefonos:''},f.negocioId);
      if(tipo==='ventana')await pool.query("UPDATE whatsapp_entradas SET payload=jsonb_set(payload,'{message,timestamp}',to_jsonb(extract(epoch FROM now()-interval '25 hours')::bigint::text)),recibido_at=now()-interval '25 hours' WHERE negocio_id=$1",[f.negocioId]);
      const r=await entregarRespuesta({outboxClave:q.r.outbox.clave,enviar:sinEfectos,alHumano:sinEfectos});
      assert.equal(r.estado,'descartado',tipo);
      assert.equal((await pool.query('SELECT estado FROM agente_outbox WHERE evento_clave=$1',[q.r.outbox.clave])).rows[0].estado,'descartado',tipo);
    }
  });
  await caso('error leyendo barreras no envía, reprograma; al recuperarse se entrega una vez',async()=>{
    const f=await fixture({vacio:true}),m=f.carrito();m.order.product_items[0].item_price='40';
    const q=await f.procesar(m,{enviar:false});
    const db={query:async(sql,args)=>{if(sql.includes('bot_whatsapp_activo'))throw Error('lectura-local-fallida');return pool.query(sql,args);}};
    const r=await entregarRespuesta({db,outboxClave:q.r.outbox.clave,enviar:sinEfectos,alHumano:sinEfectos});
    assert.equal(r.estado,'reintentar');let envios=0;
    const enviar=async()=>{envios++;return {messages:[{id:'wamid.beta.reintento.'+randomUUID()}]};};
    assert.equal((await entregarRespuesta({outboxClave:q.r.outbox.clave,enviar,alHumano:sinEfectos})).estado,'entregado');
    assert.equal((await entregarRespuesta({outboxClave:q.r.outbox.clave,enviar,alHumano:sinEfectos})).estado,'no_reclamada');
    assert.equal(envios,1);
  });
  console.log(`Beta DB: ${n}/${n}. Sin red externa, mensajes, pedidos o pagos reales.`);
} finally {await pool.end();}
