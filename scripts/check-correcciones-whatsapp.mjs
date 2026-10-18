import assert from 'node:assert/strict';
import {decidirRecepcion,modoIA,esCierreTrasPersonal} from '../src/mesero-agente/recepcionista.js';
import {catalogoDeRespuestas} from '../src/mesero-agente/respuestasFijas.js';
import {estadoParaCliente} from '../src/orders/estadoParaCliente.js';
import {textoEstadoDePedido} from '../src/mesero-agente/estadoOperativoDelPedido.js';
import {esAyudaSobreFormulario} from '../src/services/asistenciaFormulario.js';
import {decidirRecordatorio} from '../src/services/seguimientoAtencion.js';
import {fraseTiempoEstimado} from '../src/mesero-agente/tiempoEstimado.js';
import {menuMencionaOtraSucursal} from '../src/mesero-agente/consultaDeSucursal.js';
import * as F from './fixture-tienda-plomeria.mjs';
Object.assign(process.env,{WHATSAPP_INTERACTIVOS:'true',MESERO_AGENTE_MODE:'true',WHATSAPP_FLOW_ENDPOINT:'true',WHATSAPP_FLOW_PRIVATE_KEY:'local',META_APP_SECRET:'local'});
const reglas={...F.reglas,horarios:Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo'].map(d=>[d,{abierto:d!=='domingo',apertura:'07:30',cierre:'14:00'}])),pedidos:{...F.reglas.pedidos,costo_envio:60,tiempo_entrega_min_minutos:45,tiempo_entrega_max_minutos:45},bot:{palabras_criticas:[],faqs:[]}};
const cfg={...F.cfgTienda('true'),whatsapp_interactivos_v1:'true',whatsapp_interactivos_elecciones_v1:'true',whatsapp_rescate_humano_v1:'true',whatsapp_beta_hibrido_v1:'true',whatsapp_eventos_formulario_v1:'true',whatsapp_flow_evento_id:'77777777777',whatsapp_ia_modo_v1:'formulario',whatsapp_ia_modo_alcance:'todos',timezone:'America/Matamoros',reglas_atencion:JSON.stringify(reglas),whatsapp_seguimiento_atencion_v1:'true',whatsapp_seguimiento_atencion_desde:'2026-10-12T00:00:00Z'};
const grupo={nombre:'Salsa',minimo:1,maximo:1,opciones:['Roja','Verde','Suiza'].map(nombre=>({nombre,disponible:true,precio_extra:0}))};
const carta=[{nombre:'Chilaquiles',productos:[{id:1,nombre:'Chilaquiles Sencillos',precio:195,disponible:true,descripcion:'Con salsa, proteína y guarniciones',modificadores:[grupo]},{id:2,nombre:'Chilaquiles Mixtos',precio:205,disponible:true,modificadores:[grupo]}]}];
let n=0;const caso=async(nombre,fn)=>{await fn();console.log(`OK fin de semana ${++n}: ${nombre}`);};
async function decidir(mensaje,{pedidos=[],abierto=true}={}){
  const estado=F.estado({pendiente:null});estado.carrito.items=[];
  const antes=JSON.stringify(estado);const estadoRestaurante={abierto};
  const {entradas}=catalogoDeRespuestas({reglas,cfg,metodosPago:F.metodosPago,modalidades:F.modalidades,estadoRestaurante});
  const d=await decidirRecepcion({ia:modoIA(cfg,F.TELEFONO),cfg,reglas,estado,mensaje,catalogo:carta,metodosPago:F.metodosPago,modalidades:F.modalidades,estadoRestaurante,entradas,
    lectores:{ultimoSaliente:async()=>null,pedidosActivos:async()=>pedidos,formularioReciente:async()=>false,formularioRescate:async()=>false}});
  assert.equal(JSON.stringify(estado),antes);assert.deepEqual(d.respuesta?.acciones||[],[]);return d;
}
  await caso('preguntas de servicio y horario no se buscan como platillos',async()=>{
    for(const t of ['Buenos dias, el dia de hoy tienen servicio','Están en servicio','Qué días tiene abierto el rest?']){
      const d=await decidir(t);assert.equal(d.tipo,'fija:horario',t);assert.match(d.respuesta.texto,/Horario/);
    }
  });
  await caso('variantes reales de solicitud abren el formulario',async()=>{
    for(const t of ['Para un pedido','Me pueden hacer un pedido','Un pedido a domicilio por favor','Puedo hacer un pedid','Quisiera un pedido','Para encargarle un pedido a domicilio']){
      const d=await decidir(t);assert.equal(d.ruta,'formulario',`${t}: ${d.tipo}`);
    }
  });
  await caso('salsas son opciones del catálogo y no una lista de platillos',async()=>{
    const d=await decidir('Qué salsas manejan en los chilaquiles?');
    assert.match(d.respuesta.texto,/Roja, Verde, Suiza/);assert.doesNotMatch(d.respuesta.texto,/Sí, en el menú tenemos/);
  });
  await caso('precio y cobertura reciben ambas respuestas configuradas',async()=>{
    const d=await decidir('Qué precio tienen los chilaquiles? Si traen a domicilio?');
    assert.match(d.respuesta.texto,/195/);assert.match(d.respuesta.texto,/60/);
  });
  await caso('reclamo por pedido que aparece entregado se atiende sin fallback',async()=>{
    const d=await decidir('Mi pedido aparece como entregado pero no ha sido entregado',{pedidos:[{folio:'XAB-1914',estado:'entregado',modalidad:'entrega a domicilio'}]});
    assert.equal(d.ruta,'persona');assert.match(d.tipo,/RETRASO|QUEJA/);assert.doesNotMatch(d.respuesta.texto,/no te entend/i);
  });
  await caso('asignar repartidor no acredita salida; cierre de venta no acredita recepción',()=>{
    assert.equal(estadoParaCliente({estado:'listo',datos:{modalidad:'entrega a domicilio',repartidor_id:'1'}}),'listo');
    assert.equal(estadoParaCliente({estado:'entregado',modalidad:'entrega a domicilio'}),'en_camino');
    assert.equal(estadoParaCliente({estado:'entregado',modalidad:'recoger en tienda'}),'entregado');
    assert.equal(estadoParaCliente({estado:'entregado',modalidad:'entrega a domicilio',entrega_estado:'entregado'}),'entregado');
    assert.match(textoEstadoDePedido({folio:'XAB-1914',estado:'entregado',modalidad:'entrega a domicilio'}),/en camino/);
  });
  await caso('ayuda automática limitada a saludos y preguntas de asistencia',()=>{
    for(const t of ['Hola buenas tardes','Pudo hacer su pedido? 🍎','Buen día pudo hacer su pedido?'])assert(esAyudaSobreFormulario(t),t);
    for(const t of ['Su pedido ya está preparado','$200, le mando el enlace','Sí, cómo serían?','Ya recibimos el pago'])assert(!esAyudaSobreFormulario(t),t);
  });
  await caso('se omiten agradecimientos atendidos y permanecen respuestas que requieren acción',()=>{
    const f={cfg,motivo:'RECEPCION_PEDIDO_ESCRITO',segundos:600,ultimo_humano_id:10};
    const ahora=new Date('2026-10-17T15:00:00Z');
    for(const t of ['Perfecto aquí lo esperamos muchas gracias','Ah okis super mil gracias','Graciass']){
      // Los cierres compuestos se verifican por el mismo clasificador de R0.
      assert(esCierreTrasPersonal(t),t);assert.equal(decidirRecordatorio({...f,texto:t},ahora),null);
    }
    assert.equal(decidirRecordatorio({...f,texto:'Gracias!!'},ahora),null);
    assert(decidirRecordatorio({...f,texto:'Sí'},ahora));
    assert(decidirRecordatorio({...f,texto:'Listo'},ahora));
    assert(decidirRecordatorio({...f,ultimo_humano_id:null,texto:'Gracias'},ahora));
    assert(decidirRecordatorio({...f,texto:'Gracias, pero no llega mi pedido'},ahora));
  });
  await caso('domingo cerrado conserva información sin abrir pedido inmediato',async()=>{
    const d=await decidir('Hoy tienen servicio?',{abierto:false});assert.notEqual(d.ruta,'formulario');assert.match(d.respuesta.texto,/cerrad|Horario/);
  });
  await caso('pedido grande no hereda la promesa fija y respeta umbral configurable',()=>{
    assert.match(fraseTiempoEstimado(reglas,'entrega a domicilio',{items:[{cantidad:20}]}),/tamaño de tu pedido/);
    assert.doesNotMatch(fraseTiempoEstimado(reglas,'entrega a domicilio',{items:[{cantidad:20}]}),/45 minutos/);
    assert.match(fraseTiempoEstimado(reglas,'entrega a domicilio',{items:[{cantidad:2}]}),/45 minutos/);
    assert.match(fraseTiempoEstimado({...reglas,pedidos:{...reglas.pedidos,umbral_pedido_grande:3}},'recoger en tienda',{items:[{cantidad:3}]}),/tamaño/);
  });
  await caso('menú de otra sucursal no se contesta con la carta local',()=>{
    const local={nombre:'Mapolato Obispado',ciudad:'Piedras Negras'};
    assert(menuMencionaOtraSucursal('Me pueden pasar el menú de Acuña?',local));
    assert(!menuMencionaOtraSucursal('Menú de Obispado por favor',local));
    assert(!menuMencionaOtraSucursal('Me pasa el menú de desayunos?',local));
  });
  console.log(`${n} casos de correcciones correctos`);
