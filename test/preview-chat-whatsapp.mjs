// Preview LOCAL: reutiliza las funciones reales del panel con mensajes ficticios.
// No conecta a DB, Meta, pagos ni impresión. Solo sirve en loopback.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
const panel=readFileSync(new URL('../panel/index.html',import.meta.url),'utf8');
const funcion=(nombre,siguiente)=>panel.slice(panel.indexOf(`function ${nombre}(`),panel.indexOf(`function ${siguiente}(`));
const renderer=readFileSync(new URL('../panel/formulariosChat.js',import.meta.url),'utf8');
const funciones=funcion('contenidoBurbujaMensaje','contenidoTarjetaFormulario')
  +panel.slice(panel.indexOf('function contenidoTarjetaFormulario('),panel.indexOf('// El webhook llega antes'))
  +funcion('horaBurbuja','scrollChatAlFondo');
const mensajes=[{id:1,direccion:'saliente',origen:'bot',timestamp:new Date().toISOString(),texto:'*Tu carrito*\nAjusta tus platillos sin salir de la ventana.',
  estadoTransporte:{codigo:'read',titulo:'Leído',errorCodigo:null,aclaracion:'Lectura del mensaje; no acredita apertura del formulario.'},
  interaccion:{tipo:'formulario',titulo:'Formulario enviado',detalle:'Abrir carrito',seguimiento:{titulo:'Iniciado · sin actividad reciente',paso:'Carrito',ultimaActividad:new Date().toISOString(),sugerirAyuda:true,
    aclaracion:'Actividad recibida por el servidor; no indica que siga dentro ni que haya perdido interés.'},
    vistaEnviada:{alcance:'Platillos del pedido al enviar',totalProductos:2,productos:[{nombre:'Chilaquiles Mixtos',precio:205,grupos:[{nombre:'Salsa',minimo:1,maximo:2,opciones:[{nombre:'Roja',extra:0},{nombre:'Verde',extra:0}]}]},
      {nombre:'Taco de Barbacoa',precio:30,grupos:[]}],modalidades:['Recoger','Domicilio'],pagos:['Efectivo']}}},
  {id:2,direccion:'entrante',timestamp:new Date().toISOString(),interaccion:{tipo:'formulario',titulo:'Cambios guardados',detalle:'Xabor validó y guardó la respuesta. Esto no confirma ni cobra el pedido.',
    respuestaRecibida:{aclaracion:'Respuesta final recibida; separada del resultado aplicado.',lineas:[{cantidad:2,nombre:'Chilaquiles Mixtos',opciones:['Salsa: Roja, Verde'],nota:'Sin crema'}]},
    resumen:'*Tu pedido*\n\n*2 × Chilaquiles Mixtos*\nSalsa: Roja y Verde\nNota: Sin crema\n\n*Total: $410*\n¿Confirmas este pedido?'}}];
const css=[...panel.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
const html=`<!doctype html><meta charset="utf-8"><title>QA local · Chat WhatsApp</title><style>${css}
body{background:#f4f6f8;display:block;padding:16px}#prueba{width:900px;max-width:100%;margin:auto}#chat-mensajes{height:700px;background:#f7f8fa;border:1px solid #ddd;border-radius:12px;overflow:auto;padding:12px}.chat-burbuja{max-width:100%;overflow-wrap:anywhere}#controles{padding:12px}button{cursor:pointer;margin:4px}</style>
<div id="controles">Vista de prueba aislada <button onclick="document.getElementById('prueba').style.width='900px'">Escritorio</button><button onclick="document.getElementById('prueba').style.width='390px'">Móvil 390</button><button onclick="document.getElementById('prueba').style.width='320px'">Móvil 320</button><button onclick="actualizar()">Simular actualización</button><output id="resultado"></output></div>
<main id="prueba"><div id="chat-mensajes"></div></main><script>${renderer}
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const escaparHTML=esc;const etiquetaOrigen=m=>m.origen==='bot'?'Bot · ':'';
${funciones}
const mensajes=${JSON.stringify(mensajes)};const cont=document.getElementById('chat-mensajes');cont.innerHTML=mensajes.map(burbujaMensajeHTML).join('');
function actualizar(){for(const m of mensajes){const previo=cont.querySelector('[data-mensaje-id="'+m.id+'"]'),wrap=document.createElement('div');wrap.innerHTML=burbujaMensajeHTML(m);FormulariosChat.conservarAbiertos(previo,wrap);previo.replaceWith(wrap.firstElementChild);}document.getElementById('resultado').textContent='Actualizado sin cerrar detalles';}
</script>`;
createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);}).listen(55981,'127.0.0.1',()=>console.log('QA local http://127.0.0.1:55981'));
