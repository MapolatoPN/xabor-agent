// Contrato puro del módulo REAL. Sin base, transporte ni prototipo experiments/.
import assert from 'node:assert/strict';
import { construirBotones, leerBoton, reservarBotones, autorizarBotonReservado } from '../src/mesero-agente/interactivos.js';
import { autorizaConfirmacion } from '../src/mesero-agente/contratoConversacional.js';
const previa = process.env.WHATSAPP_INTERACTIVOS;
try {
  process.env.WHATSAPP_INTERACTIVOS='true';
  const estado={conversacionId:'ciclo-1',hechos:{},pendiente:{tipo:'confirmar_resumen',huella:'resumen-completo',dialogo_id:'d1'},
    dialogo:{id:'d1',tipo:'resumen',huella:'resumen-completo',ciclo:'ciclo-1',enviado:true,texto:'Resumen por $45. ¿Confirmas?'}};
  const pedido={huella:'resumen-completo',total:45,falta:[],aclaraciones:[]};
  const cfg={whatsapp_interactivos_v1:'true'};
  const crear=(extra={})=>construirBotones({estado,pedido,texto:'Resumen por $45. ¿Confirmas?',cfg,...extra});
  const a=crear(),b=crear();assert(a&&b);assert.notEqual(a.botones[0].token,b.botones[0].token);
  assert.notEqual(a.botones[0].token,a.botones[1].token);
  assert.deepEqual(a.carga.action.buttons.map(x=>x.reply.title),['Confirmar','Cambiar algo']);
  for(const extra of [{cfg:{}},{texto:'x'.repeat(1025)},{pedido:{...pedido,falta:['pago']}},
    {pedido:{...pedido,huella:'otra'}},{pedido:{...pedido,total:null}},{texto:'Pregunta distinta'},
    {estado:{...estado,folio:'XAB-1'}},{estado:{...estado,evento:{}}}]) assert.equal(crear(extra),null);
  const m={type:'interactive',id:'wamid.1',from:'528700000000',context:{id:'wamid.salida'},
    interactive:{type:'button_reply',button_reply:{id:a.botones[0].token,title:'NO_ES_AUTORIDAD'}}};
  assert.equal(leerBoton(m).token,a.botones[0].token);
  for(const invalido of [{...m,interactive:null},{...m,id:[]},{...m,context:null},{...m,type:'button'}]) assert.equal(leerBoton(invalido),null);
  assert.equal(autorizaConfirmacion({estado,mensaje:'',huella:pedido.huella}),false);
  const serializable={...estado,botonesReserva:{reservaId:'falso',ids:['falso']}};
  assert.equal(autorizaConfirmacion({estado:serializable,mensaje:'',huella:pedido.huella}),false);
  autorizarBotonReservado(estado,{accion:'confirmar',reservaId:'reservado',ids:['pregunta'],huella:pedido.huella});
  assert.equal(autorizaConfirmacion({estado,mensaje:'',huella:pedido.huella}),true);
  assert.equal(autorizaConfirmacion({estado:structuredClone(estado),mensaje:'',huella:pedido.huella}),false);
  assert.equal(autorizaConfirmacion({estado,mensaje:'',huella:'otra'}),false);
  assert.deepEqual(await reservarBotones({mensajes:[{type:'button',button:{text:'Confirmar'}}],telefono:m.from,
    db:{connect:()=>{throw Error('Un tipo ajeno no consulta ni ejecuta');}}}),{ignorar:true});
  delete process.env.WHATSAPP_INTERACTIVOS;assert.equal(crear(),null);
  console.log('OK botones WhatsApp: token opaco, bandera apagada, contrato/huella y autorización no serializable.');
} finally {
  if(previa===undefined)delete process.env.WHATSAPP_INTERACTIVOS;else process.env.WHATSAPP_INTERACTIVOS=previa;
}
