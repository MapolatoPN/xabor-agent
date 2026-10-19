// Solo PostgreSQL local y dobles de proveedor/transporte. Ningún pedido,
// mensaje, pago o impresión real puede ejecutarse en esta suite.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pool, actualizarConfiguracion } from '../src/services/database.js';
import { prepararNegocioMixtos, exigirBaseBotonesLocal } from './lib-botones-local.mjs';
import { atenderConAgente } from '../src/mesero-agente/canalDelAgente.js';
import { leerEstadoVersionado } from '../src/mesero-agente/persistenciaDelTurno.js';
import { entregarRespuesta } from '../src/mesero-agente/entregaDeRespuestas.js';
import { atenderFlowRepetible } from '../src/mesero-agente/flowRepetibleSql.js';
import { leerPedidoParaRepetir } from '../src/mesero-agente/prellenadoFormulario.js';
import { esperarPrecalentamiento } from '../src/services/vitrinaTienda.js';
import { miniaturasMenu } from '../src/services/miniaturasMenu.js';
import { consultarEmbudoFormularios } from '../src/services/embudoFormularios.js';
import { enriquecerHistorialInteractivo } from '../src/services/historialInteractivo.js';
exigirBaseBotonesLocal();
Object.assign(process.env,{MESERO_AGENTE_MODE:'true',WHATSAPP_INTERACTIVOS:'true',WHATSAPP_FLOW_ENDPOINT:'true',WHATSAPP_FLOW_PRIVATE_KEY:'local',META_APP_SECRET:'local'});
const no=async()=>{throw Error('EFECTO_EXTERNO_PROHIBIDO');};
let n=0;
let completado;
async function caso(nombre,fn){await fn();console.log(`OK conversión-db ${++n}: ${nombre}`);}
async function fixture({bandera=true}={}) {
  const f=await prepararNegocioMixtos();
  f.estado.carrito={items:[],datos:{cliente:{nombre:'Cliente local',telefono:f.telefono}}};
  await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',[f.negocioId,`agente:${f.telefono}`,JSON.stringify(f.estado)]);
  await actualizarConfiguracion({nombre:'Sucursal local',whatsapp_ia_modo_v1:'formulario',whatsapp_ia_modo_alcance:'todos',
    whatsapp_inicio_mapo_v1:'true',whatsapp_atencion_general_v1:'true',bot_whatsapp_solo_prueba:'false',mesero_agente_porcentaje:'100',
    whatsapp_rescate_humano_v1:'true',whatsapp_eventos_formulario_v1:'true',whatsapp_flow_evento_id:'55555555555',
    whatsapp_flows_v1:'true',whatsapp_beta_hibrido_v1:'true',whatsapp_carrito_unificado_v1:'true',
    whatsapp_flow_categorias_id:'66666666666',whatsapp_flow_carrito_id:'77777777777',
    whatsapp_flow_direccion_v1:'true',whatsapp_flow_categorias_dir_id:'88888888888',whatsapp_flow_carrito_dir_id:'99999999999',
    whatsapp_flow_nota_v1:'true',whatsapp_flow_categorias_nota_id:'12121212121',whatsapp_flow_carrito_nota_id:'13131313131',
    whatsapp_flow_tienda_v1:'true',whatsapp_flow_tienda_id:'14141414141',whatsapp_trazabilidad_formularios_v1:'true',
    ...(bandera?{whatsapp_formulario_conversion_v1:'true'}:{})},f.negocioId);
  const leer=()=>leerEstadoVersionado(f.negocioId,f.telefono);
  let llamadas=0;
  const modelo=async p=>{
    llamadas++;assert.equal(p.tool_choice.name,'proponer_borrador');
    return {stop_reason:'tool_use',content:[{type:'tool_use',name:'proponer_borrador',input:{lineas:[{
      producto_id:String(f.mixtosId),cantidad:2,fragmento:'2 Chilaquiles Mixtos',opciones:[]}]}}]};
  };
  const texto=body=>({id:'wamid.conversion.'+randomUUID(),from:f.telefono,type:'text',text:{body},timestamp:String(Math.floor(Date.now()/1000))});
  const procesar=async(m,{llamarModelo=modelo}={})=>{
    await pool.query(`INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado') ON CONFLICT DO NOTHING`,
      [f.negocioId,f.telefono,m.id,JSON.stringify({message:m})]);
    const r=await atenderConAgente({...f,mensaje:m.text?.body || '',wamids:[m.id],
      ...(m.type==='interactive'?{interaccion:{mensajes:[m],mixto:false}}:{}),llamarModelo,
      registrar:no,emitir:no,guardar:no,crearPago:no,escalarAHumano:no});
    assert(r.ok,JSON.stringify(r));
    if(!r.outbox)return {r};
    const {rows:[o]}=await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1',[r.outbox.clave]);
    let wamid=o.wamid_salida;
    if(!r.yaEntregado){wamid='wamid.salida.'+randomUUID();const d=await entregarRespuesta({outboxClave:o.evento_clave,
      enviar:async()=>({messages:[{id:wamid}]}),alHumano:no});assert.equal(d.estado,'entregado');}
    const {rows:[q]}=await pool.query(`SELECT q.id,b.datos AS foto,d.contenido AS borrador FROM agente_preguntas_interactivas q
      JOIN agente_botones b ON b.pregunta_id=q.id LEFT JOIN agente_flows_borradores d ON d.pregunta_id=q.id
      WHERE q.outbox_clave=$1 LIMIT 1`,[o.evento_clave]);
    return {...o.carga,r,wamid,q};
  };
  const flow=async(q,s)=>atenderFlowRepetible(pool,{flow_token:q.interactivo.action.parameters.flow_token,...s},{vitrina:async()=>null});
  return {...f,leer,texto,procesar,flow,llamadas:()=>llamadas};
}
try {
  execFileSync(process.execPath,['scripts/predeploy-118-formulario-pantalla.mjs'],{stdio:'pipe'});
  await caso('pedido escrito crea borrador nativo, sin alterar carrito ni registrar pedido; webhook duplicado no vuelve a llamar IA',async()=>{
    const f=await fixture(),m=f.texto('Quiero 2 Chilaquiles Mixtos'),q=await f.procesar(m);
    assert.equal(q.interactivo.type,'flow');assert.equal(q.interactivo.action.parameters.flow_cta,'Revisar mi pedido');
    assert.equal(q.q.borrador.filas.length,1);assert.equal(q.q.borrador.filas[0].item.cantidad,'2');
    assert.equal((await f.leer()).carrito.items.length,0);assert.equal(f.llamadas(),1);
    await f.procesar(m);assert.equal(f.llamadas(),1);
    let v=await f.flow(q,{action:'INIT'});assert.equal(v.screen,'MENU');
    v=await f.flow(q,{action:'data_exchange',screen:'MENU',data:{operacion:'ver_carrito'}});
    assert.match(v.data.renglones_md,/2 × Chilaquiles Mixtos/);
    v=await f.flow(q,{action:'data_exchange',screen:'CARRITO',data:{operacion:'continuar',revision:v.data.revision}});
    assert.equal(v.screen,'CARRITO');assert(v.data.error_visible);assert.match(v.data.error,/Salsa/);
    assert.equal((await f.leer()).carrito.items.length,0);
    const e=(await pool.query('SELECT pantalla,tipo FROM agente_actividad_formulario WHERE pregunta_id=$1 ORDER BY observado_at',[q.q.id])).rows;
    assert.deepEqual(e.map(x=>x.pantalla),['MENU','CARRITO','CARRITO']);assert.equal(e.at(-1).tipo,'validacion');
    // El doble de transporte no escribe mensajes; el historial recibe esta
    // referencia y consulta preguntas, outbox y actividad reales en PostgreSQL.
    const mensajes=[{id:1,negocio_id:f.negocioId,telefono:f.telefono,message_id_externo:q.wamid,direccion:'saliente'}];
    const historial=await enriquecerHistorialInteractivo(pool,f.negocioId,f.telefono,mensajes);
    assert.equal(historial[0].interaccion.seguimiento.paso,'Carrito');assert(historial[0].interaccion.seguimiento.sugerirAyuda);
    assert(!JSON.stringify(historial[0].interaccion).includes(q.interactivo.action.parameters.flow_token));
    const paso=await f.flow(q,{action:'data_exchange',screen:'CARRITO',data:{operacion:'editar',fila:'n0'}});
    assert.equal(paso.screen,'EDITAR');
    const guardado=await f.flow(q,{action:'data_exchange',screen:'EDITAR',data:{operacion:'aplicar',fila:'n0',revision:paso.data.revision,
      cantidad:'2',observaciones:'',g0_m:['o0'],g1_r:'o0',g2_m:['o0','o1']}});
    assert(!guardado.data.error_visible,guardado.data.error);assert.equal(guardado.screen,'CARRITO');
    v=await f.flow(q,{action:'data_exchange',screen:'CARRITO',data:{operacion:'continuar',revision:guardado.data.revision}});
    assert.equal(v.screen,'ENTREGA');
    v=await f.flow(q,{action:'data_exchange',screen:'ENTREGA',data:{operacion:'revisar',revision:v.data.revision,modalidad:'m0',pago:'p0',nota:''}});
    assert.equal(v.screen,'SUCCESS');
    const params=v.data.extension_message_response.params;
    const recibido={id:'wamid.final.'+randomUUID(),from:f.telefono,type:'interactive',context:{id:q.wamid},timestamp:String(Math.floor(Date.now()/1000)),
      interactive:{type:'nfm_reply',nfm_reply:{response_json:JSON.stringify(params)}}};
    const fin=await f.procesar(recibido);assert.match(fin.texto,/Revisa tu pedido/);
    assert.equal((await f.leer()).pendiente.tipo,'confirmar_resumen');
    assert.equal((await f.leer()).carrito.items[0].cantidad,2);assert(!(await f.leer()).folio);
    assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos_activos WHERE negocio_id=$1',[f.negocioId])).rows[0].n,0);
    completado=f;
  });
  await caso('reenviar formulario preserva borrador y no pasa a humano por recibir otro pedido escrito',async()=>{
    const f=await fixture(),q=await f.procesar(f.texto('Quiero 2 Chilaquiles Mixtos'));
    await f.flow(q,{action:'INIT'});
    const otra=await f.procesar(f.texto('Quiero 2 Chilaquiles Mixtos'));
    assert.equal(otra.interactivo.type,'flow');assert.equal(f.llamadas(),1);
    assert.deepEqual(otra.q.borrador.filas,q.q.borrador.filas);assert.equal((await f.leer()).carrito.items.length,0);
    await actualizarConfiguracion({whatsapp_formulario_conversion_v1:'false'},f.negocioId);
    const v=await f.flow(otra,{action:'INIT'});assert.equal(v.screen,'MENU','reversa no invalida borrador existente');
  });
  await caso('apagado mantiene formulario vacío y no consulta IA para precargar',async()=>{
    const f=await fixture({bandera:false}),q=await f.procesar(f.texto('Quiero 2 Chilaquiles Mixtos'));
    assert.equal(q.interactivo.type,'flow');assert(!q.q.borrador);assert.equal(f.llamadas(),0);
  });
  await caso('una apertura vacía permite precargar el pedido escrito sin perder una edición previa',async()=>{
    const f=await fixture(),q=await f.procesar(f.texto('Quiero ordenar'));
    await f.flow(q,{action:'INIT'});assert.equal(f.llamadas(),0);
    const escrito=await f.procesar(f.texto('Quiero 2 Chilaquiles Mixtos'));
    assert.equal(escrito.q.borrador.filas[0].item.cantidad,'2');assert.equal(f.llamadas(),1);
  });
  await caso('fallo de proveedor deja formulario utilizable sin crear ni escalar un pedido',async()=>{
    const f=await fixture(),q=await f.procesar(f.texto('Quiero 2 Chilaquiles Mixtos'),{llamarModelo:async()=>{throw Error('sin proveedor');}});
    assert.equal(q.interactivo.type,'flow');assert(!q.q.borrador);assert.equal((await f.leer()).carrito.items.length,0);
  });
  await caso('repetir usa último entregado del cliente y negocio; excluye otra sucursal/teléfono, cancelados y productos retirados',async()=>{
    const f=await fixture(),otro=await fixture();
    const guardar=async(negocioId,tel,items,estado='entregado')=>pool.query(`INSERT INTO pedidos_activos(folio,negocio_id,estado,datos) VALUES($1,$2,$3,$4)`,
      ['LC-'+randomUUID().slice(0,12),negocioId,estado,JSON.stringify({cliente:{telefono:tel,direccion:'No copiar'},items,forma_pago:'tarjeta',total:1,programado_para:'2020-01-01'})]);
    const items=[{producto_id:f.mixtosId,cantidad:3,precio_unitario:1}];
    await guardar(f.negocioId,f.telefono,items);await guardar(otro.negocioId,f.telefono,[{producto_id:otro.mixtosId,cantidad:9}]);
    await guardar(f.negocioId,otro.telefono,[{producto_id:f.mixtosId,cantidad:8}]);await guardar(f.negocioId,f.telefono,[{producto_id:f.mixtosId,cantidad:7}],'cancelado');
    assert.deepEqual(await leerPedidoParaRepetir(pool,{negocioId:f.negocioId,telefono:f.telefono}),items);
    const q=await f.procesar(f.texto('Repetir mi pedido'));assert.equal(q.q.borrador.filas[0].item.cantidad,'3');
    assert(!q.q.borrador.direccion);assert.equal((await f.leer()).carrito.items.length,0);assert.equal(f.llamadas(),0);
    assert.equal(q.q.foto.productos.find(p=>p.id===String(f.mixtosId)).precio,120);
    const sin=await fixture();const menu=await sin.procesar(sin.texto('Hola'));
    assert(menu.interactivo.action.sections[0].rows.some(r=>r.title==='Repetir mi pedido'));
    const r=await sin.procesar(sin.texto('Repetir mi pedido'));assert.match(r.texto,/No pude recuperar/);assert(!r.q.borrador);
    await pool.query('UPDATE menu_productos SET disponible=false WHERE id=$1',[f.mixtosId]);
    const nuevo=await f.procesar(f.texto('Repetir mi pedido'));assert.match(nuevo.texto,/No pude recuperar/);assert(!nuevo.q.borrador);
  });
  await caso('repetir desde botón respeta la asociación vigente y prepara el mismo borrador',async()=>{
    const f=await fixture();
    await pool.query(`INSERT INTO pedidos_activos(folio,negocio_id,estado,datos) VALUES($1,$2,'entregado',$3)`,
      ['LC-'+randomUUID().slice(0,12),f.negocioId,JSON.stringify({cliente:{telefono:f.telefono},items:[{producto_id:f.mixtosId,cantidad:2}]})]);
    const menu=await f.procesar(f.texto('Hola')),row=menu.interactivo.action.sections[0].rows.find(r=>r.title==='Repetir mi pedido');
    const m={id:'wamid.click.'+randomUUID(),from:f.telefono,type:'interactive',context:{id:menu.wamid},timestamp:String(Math.floor(Date.now()/1000)),
      interactive:{type:'list_reply',list_reply:{id:row.id,title:row.title}}};
    const r=await f.procesar(m);assert.equal(r.q.borrador.filas[0].item.cantidad,'2');assert.equal(f.llamadas(),0);
  });
  await caso('informe READ ONLY no confunde aplicar con registrar/pagar y filtra el negocio',async()=>{
    const f=completado;
    await actualizarConfiguracion({timezone:'America/Matamoros'},f.negocioId);
    const {rows:[neg]}=await pool.query('SELECT slug FROM negocios WHERE id=$1',[f.negocioId]);
    const hoy=new Date(),desde=new Date(hoy.getTime()-86400000).toISOString().slice(0,10),hasta=new Date(hoy.getTime()+86400000).toISOString().slice(0,10);
    const tx=await pool.connect();
    try {
      const consultar=()=>consultarEmbudoFormularios(tx,{slug:neg.slug,desde,hasta});
      const a=await consultar();assert.equal(a.ciclosOfrecidos,1);assert.equal(a.respuestasAplicadas,1);assert.equal(a.pedidosRegistrados,0);
      assert.equal(a.conActividadObservada,1);assert.equal(a.pagosConfirmados,0);
      const estado=await f.leer();
      await pool.query(`INSERT INTO pedidos_activos(folio,negocio_id,estado,datos) VALUES($1,$2,'entregado',$3)`,
        ['LC-'+randomUUID().slice(0,12),f.negocioId,JSON.stringify({cliente:{telefono:f.telefono},origen_agente:{conversacion_id:estado.conversacionId},pago_confirmado:true})]);
      const b=await consultar();assert.equal(b.pedidosRegistrados,1);assert.equal(b.pagosConfirmados,1);assert.equal(b.conversionPorcentaje,100);
      assert(!JSON.stringify(b).includes(f.telefono));assert(!JSON.stringify(b).includes(f.negocioId));
      assert.equal((await tx.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'off');
    } finally {tx.release();}
  });
  console.log(`CONVERSIÓN DB: ${n} pruebas correctas`);
} finally {await esperarPrecalentamiento();await miniaturasMenu.esperar();await pool.end();}
