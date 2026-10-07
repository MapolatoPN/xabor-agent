import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resumirEstadoBotPanel,leerEstadoBotPanel } from '../src/services/estadoBotPanel.js';
import { enriquecerHistorialInteractivo } from '../src/services/historialInteractivo.js';
const html=readFileSync(new URL('../panel/index.html',import.meta.url),'utf8');
for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(script[1]);
const nombres=['cargarBannerBotChats','cargarBotWhatsappPanel','esc','escaparHTML','textoWhatsAppHTML','contenidoTarjetaFormulario','contenidoBurbujaMensaje'];
const funciones=nombres.map(n=>{
  // JavaScript usa la última declaración si una función está repetida.
  const r=[...html.matchAll(new RegExp(`^(?:async )?function ${n}\\([^]*?^}`, 'gm'))].at(-1);assert(r,n);return r[0];
}).join('\n');
const nodos=new Map(['chats-banner-bot','bot-whatsapp-form'].map(id=>[id,{innerHTML:'',style:{},className:''}]));
const sandbox={window:{},document:{getElementById:id=>nodos.get(id)},ROL:'admin',WHATSAPP_CONFIGURADO:true,chatAbierto:null,
  atencionNegocioActiva:null,apiFetch:null};
vm.createContext(sandbox);vm.runInContext(`let secuenciaBannerBot=0,secuenciaEstadoBot=0;${funciones}`,sandbox);
const cfg={mesero_agente_v1:'true',bot_whatsapp_solo_prueba:'true',mesero_agente_telefonos:'528787899919,528781118093'};
process.env.MESERO_AGENTE_MODE='true';
const piloto=resumirEstadoBotPanel(true,cfg);assert.equal(piloto.telefonosPrueba,2);assert.equal(piloto.titulo,'Piloto del agente nuevo activo');
assert.equal(resumirEstadoBotPanel(false,cfg).titulo,'Atención automática pausada');
assert(!JSON.stringify(piloto).includes('52878'));
for (const activo of [false, true]) {
  sandbox.apiFetch=async()=>({ok:true,json:async()=>resumirEstadoBotPanel(activo,cfg,false)});
  await sandbox.cargarBotWhatsappPanel();await sandbox.cargarBannerBotChats();
  assert.equal(nodos.get('bot-whatsapp-form').innerHTML.includes('disabled title='),!activo);
  assert.match(nodos.get('chats-banner-bot').className,/pausado/);
}
for(const activo of [true,false]) {
  sandbox.apiFetch=async()=>({ok:true,json:async()=>resumirEstadoBotPanel(activo,cfg)});
  await sandbox.cargarBannerBotChats();await sandbox.cargarBotWhatsappPanel();
  assert.match(nodos.get('chats-banner-bot').innerHTML,/Configurar bot/);
  assert.equal(nodos.get('chats-banner-bot').style.display,'');
  assert.match(nodos.get('bot-whatsapp-form').innerHTML,activo?/Piloto del agente nuevo activo/:/pausada/);
}
for(const api of [async()=>({ok:false}),async()=>{throw Error('sin red');}]) {
  sandbox.apiFetch=api;await sandbox.cargarBannerBotChats();await sandbox.cargarBotWhatsappPanel();
  assert.match(nodos.get('chats-banner-bot').innerHTML,/Configurar bot/);
  assert.match(nodos.get('chats-banner-bot').innerHTML,/Reintentar/);
  assert.match(nodos.get('bot-whatsapp-form').innerHTML,/Reintentar/);
}
let resolver;
sandbox.apiFetch=()=>new Promise(r=>{resolver=r;});
const vieja=sandbox.cargarBotWhatsappPanel();
sandbox.apiFetch=async()=>({ok:true,json:async()=>piloto});await sandbox.cargarBotWhatsappPanel();
resolver({ok:true,json:async()=>resumirEstadoBotPanel(false,cfg)});await vieja;
assert.match(nodos.get('bot-whatsapp-form').innerHTML,/Piloto del agente nuevo activo/,'una petición vieja no oculta el estado nuevo');
const tarjeta=sandbox.contenidoBurbujaMensaje({direccion:'entrante',texto:'no mostrar JSON del cliente',interaccion:{tipo:'formulario',
  titulo:'Cambios guardados',detalle:'Xabor validó',resumen:'*Chilaquiles*\nSin crema <img src=x onerror=alert(1)>'}});
assert.match(tarjeta,/<strong>Chilaquiles<\/strong>/);assert.match(tarjeta,/Ver resultado guardado/);
assert.match(tarjeta,/<strong>Chilaquiles<\/strong><br>Sin crema/);
assert(!tarjeta.includes('<img'));assert(!tarjeta.includes('no mostrar JSON'));
assert(!tarjeta.includes('onclick='));
await assert.rejects(leerEstadoBotPanel({query:async()=>{throw Error('DB inaccesible');}},'local'));
const mensajes=[{id:1,negocio_id:'propio',telefono:'local',message_id_externo:'w1',direccion:'entrante',texto:'Formulario recibido'}];
let consultas=0;
const db={query:async(sql,args)=>{
  assert.equal(args[0],'propio');assert.equal(args[1],'local');consultas++;
  return {rows:sql.includes('SELECT e.wamid')?[{wamid:'w1',estado:'terminada',resultado:{formulario_aplicado:false},resumen:'NO PUBLICAR'}]:[]};
}};
const proyectado=await enriquecerHistorialInteractivo(db,'propio','local',mensajes);
assert.equal(consultas,3);assert.equal(proyectado[0].interaccion.titulo,'Formulario no aplicado');assert(!proyectado[0].interaccion.resumen);
assert.deepEqual(await enriquecerHistorialInteractivo(db,'ajeno','local',mensajes),mensajes);assert.equal(consultas,3);
console.log('OK panel: script completo válido, configuración estable, error/reintento, piloto, concurrencia, tarjetas seguras y aislamiento de historial.');

// Preview aislado con las funciones y estilos reales del panel. Solo localhost,
// sin sesión, credenciales, pedidos ni llamadas a producción.
if(process.argv.includes('--preview')) {
  const {createServer}=await import('node:http');
  sandbox.apiFetch=async()=>({ok:true,json:async()=>piloto});
  await sandbox.cargarBannerBotChats();await sandbox.cargarBotWhatsappPanel();
  const banner=nodos.get('chats-banner-bot').innerHTML,control=nodos.get('bot-whatsapp-form').innerHTML;
  sandbox.apiFetch=async()=>({ok:false});await sandbox.cargarBotWhatsappPanel();
  const error=nodos.get('bot-whatsapp-form').innerHTML;
  // Solo CSS del documento; no estilos de tickets dentro de plantillas JS.
  const estilos=[...html.split('<script')[0].matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m=>m[0]).join('\n');
  const enviado=sandbox.contenidoTarjetaFormulario({direccion:'saliente',texto:'*Tu carrito*\nAjusta cantidades, quita varios platillos o agrega más sin salir de la ventana.',
    interaccion:{titulo:'Formulario enviado',detalle:'Abrir carrito'}});
  const recibido=sandbox.contenidoTarjetaFormulario({direccion:'entrante',interaccion:{titulo:'Cambios guardados',detalle:'Xabor validó y guardó la respuesta. Esto no confirma ni cobra el pedido.',
    resumen:'*Tu pedido*\n\n*3 × Chilaquiles Mixtos · $615*\nRoja y verde · Huevo · Papas\nNota: Sin crema\n\nEntrega: Recoger en tienda\nPago: Efectivo\n\n*Total: $615*'}});
  const pagina=`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QA local · Bot y formularios</title>${estilos}
    <style>body{display:block!important;overflow:auto!important;background:#f4f2ed;padding:24px;font-family:Arial,sans-serif}main{max-width:1000px;width:100%;margin:auto;padding:0}h1{font-size:22px}section{background:white;padding:18px;border-radius:12px;margin:16px 0}#muestras{display:grid;grid-template-columns:1fr;gap:20px}button{cursor:pointer}details{line-height:1.5}@media(max-width:650px){body{padding:12px}section{padding:12px}}</style>
    <main><h1>Revisión local · Bot y formularios</h1><p>Datos ficticios. Los controles no modifican ninguna configuración.</p>
    <section><h2>Acceso estable</h2><div class="chat-botcard activo">${banner}</div>${control}</section>
    <section><h2>Error recuperable</h2>${error}</section>
    <section><h2>Historial de formularios</h2><div id="muestras"><div class="chat-msg-row saliente"><div class="chat-burbuja saliente">${enviado}</div></div><div class="chat-msg-row entrante"><div class="chat-burbuja entrante">${recibido}</div></div></div></section></main></html>`;
  createServer((_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(pagina);}).listen(55981,'127.0.0.1',()=>console.log('Preview local: http://127.0.0.1:55981'));
}
