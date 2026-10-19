import assert from 'node:assert/strict';
import { randomUUID,createHmac } from 'node:crypto';
import sharp from 'sharp';
import { pool,actualizarConfiguracion,crearUsuarioConPassword } from '../src/services/database.js';
import { prepararNegocioBotones,exigirBaseBotonesLocal } from './lib-botones-local.mjs';
import { guardarImagenMenu,guardarConfigMenu,obtenerMenuNegocio } from '../src/services/menuAutomatico.js';
import { registrarRevisionMenu } from '../src/services/revisionMenuWhatsapp.js';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
exigirBaseBotonesLocal();
Object.assign(process.env,{STORAGE_DRIVER:'local',STORAGE_ENV_PREFIX:'test',NODE_ENV:'test'});
const secreto='conversion-solo-local';let servidor,meta;
const imagen=await sharp({create:{width:400,height:500,channels:3,background:'#eeeeee'}}).jpeg().toBuffer();
async function fixture(activa){
  const f=await prepararNegocioBotones();f.estado.carrito.items=[];
  await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',[f.negocioId,`agente:${f.telefono}`,JSON.stringify(f.estado)]);
  await actualizarConfiguracion({nombre:'Local',whatsapp_ia_modo_v1:'formulario',whatsapp_ia_modo_alcance:'todos',
    whatsapp_atencion_general_v1:'true',bot_whatsapp_solo_prueba:'false',mesero_agente_porcentaje:'100',
    whatsapp_inicio_mapo_v1:'true',whatsapp_beta_hibrido_v1:'true',whatsapp_interactivos_elecciones_v1:'true',
    whatsapp_rescate_humano_v1:'true',whatsapp_eventos_formulario_v1:'true',whatsapp_flow_evento_id:'55555555555',
    whatsapp_flows_v1:'true',whatsapp_flow_categorias_id:'66666666666',whatsapp_flow_carrito_id:'77777777777',
    whatsapp_flow_direccion_v1:'true',whatsapp_flow_categorias_dir_id:'88888888888',whatsapp_flow_carrito_dir_id:'99999999999',
    whatsapp_flow_nota_v1:'true',whatsapp_flow_categorias_nota_id:'12121212121',whatsapp_flow_carrito_nota_id:'13131313131',
    whatsapp_flow_tienda_v1:'true',whatsapp_flow_tienda_id:'14141414141',
    ...(activa?{whatsapp_formulario_conversion_v1:'true'}:{})},f.negocioId);
  const usuario=await crearUsuarioConPassword({negocioId:f.negocioId,nombre:'Admin local',email:randomUUID()+'@test.local',password:'SoloLocal123!',rol:'admin'});
  assert((await guardarImagenMenu(f.negocioId,imagen,'menu.jpg',usuario.id)).ok);
  assert((await guardarConfigMenu(f.negocioId,{activo:true},usuario.id)).ok);
  const r=await obtenerMenuNegocio(f.negocioId);assert((await registrarRevisionMenu(f.negocioId,usuario.id,r.revision)).ok);
  return f;
}
async function enviar(f,id){
  const body=JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:f.marca},
    contacts:[{wa_id:f.telefono,profile:{name:'Local'}}],messages:[{id,from:f.telefono,type:'text',timestamp:String(Math.floor(Date.now()/1000)),text:{body:'Me mandas el menú'}}]}}]}]});
  const r=await fetch(servidor.base+'/webhook/whatsapp',{method:'POST',body,headers:{'Content-Type':'application/json',
    'X-Hub-Signature-256':'sha256='+createHmac('sha256',secreto).update(body).digest('hex')}});assert.equal(r.status,200);
}
async function esperar(f,id){
  const limite=Date.now()+45000;
  while(Date.now()<limite){
    const {rows:[e]}=await pool.query('SELECT estado FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=$2',[f.negocioId,id]);
    if(['completado','revision'].includes(e?.estado))return;
    await new Promise(r=>setTimeout(r,100));
  }
  throw Error('Timeout webhook: '+servidor.obtenerSalida().slice(-2500));
}
try {
  meta=await arrancarMetaMock();
  servidor=await arrancarServidor({PORT:'55984',META_GRAPH_BASE_URL:meta.baseUrl,META_APP_SECRET:secreto,
    MESERO_AGENTE_MODE:'true',WHATSAPP_INTERACTIVOS:'true',WHATSAPP_FLOW_ENDPOINT:'true',WHATSAPP_FLOW_PRIVATE_KEY:'solo-local',
    ANTHROPIC_BASE_URL:'http://127.0.0.1:1',ANTHROPIC_API_KEY:'solo-local'}, {timeoutMs:30000});
  for(const [activa,revisada] of [[true,true],[false,true],[true,false]]){
    const f=await fixture(activa),id='wamid.menu.conversion.'+randomUUID();
    if(!revisada)await pool.query('UPDATE menu_productos SET precio=precio+1 WHERE id=$1',[f.productoId]);
    await Promise.all([enviar(f,id),enviar(f,id)]);await esperar(f,id);
    const salidas=meta.obtenerMensajesEnviados().filter(m=>m.to===f.telefono);
    assert.equal(salidas.filter(m=>m.type==='image').length,revisada?1:0);
    const flows=salidas.filter(m=>m.interactive?.type==='flow');assert.equal(flows.length,activa?1:0);
    if(activa){
      assert.equal(flows[0].interactive.action.parameters.flow_cta,'Ordenar ahora');
      assert(salidas.indexOf(flows[0])>salidas.findIndex(m=>m.type===(revisada?'image':'text')));
      assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos_activos WHERE negocio_id=$1',[f.negocioId])).rows[0].n,0);
    }
    console.log(`OK menú HTTP: conversión ${activa?'activa: menú '+(revisada?'en imagen':'textual vigente')+' + formulario nativo':'apagada: imágenes como antes'}; webhook duplicado sin duplicar salidas.`);
  }
} finally {
  if(servidor){const fin=new Promise(r=>servidor.proc.once('exit',r));servidor.detener();await fin;}
  meta?.detener();await pool.end();
}
