import assert from 'node:assert/strict';
import { decidirRecepcion,modoIA,FRASES,esQueja } from '../src/mesero-agente/recepcionista.js';
import { textosDelRecibo } from '../src/mesero-agente/reciboHandoff.js';
import { fotoFormulario } from '../src/mesero-agente/formularioAgrupado.js';
import { esMalaExperienciaAlimentos,pideAyudaAgregar,prioridadDeAtencion } from '../src/mesero-agente/incidenciasAtencion.js';
import { decidirRecordatorio,revisarAtencionPendiente } from '../src/services/seguimientoAtencion.js';
import { analizarEmbudo,validarPeriodo } from '../src/services/embudoConversaciones.js';
import { textoDeAvisoHandoff } from '../src/services/avisoRescateHumano.js';
import * as F from '../scripts/fixture-tienda-plomeria.mjs';
Object.assign(process.env,{WHATSAPP_INTERACTIVOS:'true',MESERO_AGENTE_MODE:'true',WHATSAPP_FLOW_ENDPOINT:'true',
  WHATSAPP_FLOW_PRIVATE_KEY:'local',META_APP_SECRET:'local'});
const reglas = { ...F.reglas, horarios:Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo']
  .map(d=>[d,{abierto:true,apertura:'07:30',cierre:d==='domingo'?'14:00':'14:30'}])) };
const cfg = {...F.cfgTienda('true'),whatsapp_interactivos_v1:'true',whatsapp_interactivos_elecciones_v1:'true',
  whatsapp_rescate_humano_v1:'true',whatsapp_beta_hibrido_v1:'true',whatsapp_eventos_formulario_v1:'true',
  whatsapp_flow_evento_id:'77777777777',whatsapp_ia_modo_v1:'formulario',whatsapp_ia_modo_alcance:'todos',
  timezone:'America/Matamoros',reglas_atencion:JSON.stringify(reglas),whatsapp_seguimiento_atencion_v1:'true',
  whatsapp_seguimiento_atencion_desde:'2026-10-12T00:00:00Z'};
let pasadas=0;
const caso=async(nombre,fn)=>{await fn();pasadas++;console.log(`OK ${nombre}`);};
async function decidir(mensaje,{estado=F.estado({pendiente:null}),abierto=true,reciente=false,ultimo=null}={}) {
  const copia=JSON.stringify(estado);
  const r=await decidirRecepcion({ia:modoIA(cfg,F.TELEFONO),cfg,reglas,estado,mensaje,catalogo:F.carta(),
    modalidades:F.modalidades,metodosPago:F.metodosPago,estadoRestaurante:{abierto},
    lectores:{formularioReciente:async()=>reciente,ultimoSaliente:async()=>ultimo}});
  assert.equal(JSON.stringify(estado),copia,'el enrutamiento no cambia el pedido');
  assert.deepEqual(r.respuesta?.acciones||[],[],'ninguna autoridad financiera por texto');
  return r;
}
await caso('queja real por olor fuera de horario recibe empatía y atención a primera hora',async()=>{
  const r=await decidir('Los hotcakes olían feo como a pescado',{abierto:false});
  assert.equal(r.ruta,'persona'); assert.equal(r.tipo,'RECEPCION_QUEJA');
  assert.equal(r.persona.texto,FRASES.PERSONA_QUEJA_CERRADO);
  assert(textosDelRecibo(true).includes(r.persona.texto));
  assert(!textosDelRecibo(false).includes(r.persona.texto));
});
for(const s of ['El pollo estaba en mal estado','Los waffles tienen moho','Me hizo daño la comida','Encontré una cucaracha'])
  await caso(`incidencia de alimentos: ${s}`,()=>assert(esQueja(s)));
for(const s of ['Sin pescado por favor','¿Huele a café el local?','No olía mal','No tuve intoxicación','El pollo no estaba en mal estado'])
  await caso(`no alerta por una frase sin incidente: ${s}`,()=>assert.equal(esMalaExperienciaAlimentos(s),false));
await caso('abierto conserva disculpa sin aviso de cerrado',async()=>assert.equal((await decidir('Los hotcakes olían feo')).persona.texto,FRASES.PERSONA_QUEJA));
await caso('silencio tras el personal se respeta incluso ante una queja',async()=>{
  assert.equal((await decidir('Los hotcakes olían feo',{ultimo:{origen:'humano',minutos:1}})).ruta,'silencio');
});
await caso('nombre enviado tras formulario recibe ayuda conservando el texto',async()=>{
  assert.equal((await decidir('A nombre de Ricardo Alonso',{reciente:true})).persona.motivo,'RECEPCION_PEDIDO_ESCRITO');
});
await caso('ayuda para bebida antes de confirmar vuelve al mismo formulario',async()=>{
  assert(pideAyudaAgregar('No supe cómo agregar otra bebida'));
  const r=await decidir('¿Cómo puedo agregar una bebida?',{estado:F.estado({items:'dos',pendiente:null}),reciente:true});
  assert.equal(r.ruta,'respuesta'); assert.equal(r.respuesta.pendiente.tipo,'editar_pedido');
  assert.match(r.formulario.cuerpo,/Seguir pidiendo/);
});
await caso('después de confirmar la bebida la resuelve el equipo sin crear otro pedido',async()=>{
  const estado=F.estado({items:'dos',pendiente:null}); estado.folio='XAB-1550';estado.hechos.confirmado=true;
  const r=await decidir('No supe cómo agregar otra bebida',{estado});
  assert.equal(r.persona.texto,FRASES.PERSONA_CONFIRMADO);
});
await caso('problema de pago conserva pedido y usa aviso fuera de horario',async()=>{
  const r=await decidir('Estoy teniendo problemas con el pago',{abierto:false});
  assert.equal(r.persona.texto,FRASES.PERSONA_PAGO_CERRADO);
  assert.match(textoDeAvisoHandoff({motivo:r.tipo}),/no cancelarlo ni capturarlo de nuevo/);
});
await caso('inventario vigente excluye producto agotado y opción no disponible del formulario',()=>{
  const carta=F.carta();
  carta[0].productos[1].agotado=true;
  carta[0].productos[0].modificadores[1].opciones.find(o=>o.nombre==='Pollo').disponible=false;
  const foto=fotoFormulario({estado:F.estado(),catalogo:carta,modalidades:F.modalidades,metodosPago:F.metodosPago,
    cfg,reglas,telefono:F.TELEFONO},'flow_productos');
  assert(foto);assert(!foto.productos.some(p=>p.id==='2'));
  assert(!JSON.stringify(foto.productos[0].grupos).includes('Pollo'));
});
const fila={negocio_id:'local',telefono:'5218780000000',mensaje_id:100,motivo:'RECEPCION_PIDE_PERSONA',
  texto:'Los hotcakes olían feo como a pescado',segundos:10,cfg};
await caso('queja llegada con bot pausado avisa de noche y vuelve a avisar al abrir',()=>{
  assert.deepEqual([decidirRecordatorio(fila,new Date('2026-10-12T03:00:00Z')).fase,
    decidirRecordatorio(fila,new Date('2026-10-12T12:30:00Z')).fase],['cerrado','abierto']);
});
await caso('normal espera a apertura y 5 minutos; apagado o sin fecha no hace nada',()=>{
  const n={...fila,texto:'Hola',segundos:301};
  assert.equal(decidirRecordatorio(n,new Date('2026-10-12T03:00:00Z')),null);
  assert.equal(decidirRecordatorio({...n,segundos:299},new Date('2026-10-12T12:30:00Z')),null);
  assert.equal(decidirRecordatorio(n,new Date('2026-10-12T12:30:00Z')).prioridad,'normal');
  assert.equal(decidirRecordatorio({...n,cfg:{}},new Date('2026-10-12T12:30:00Z')),null);
});
await caso('incidente de alimentos es urgente; dificultad de pago tiene prioridad alta',()=>{
  assert.equal(prioridadDeAtencion('RECEPCION_QUEJA_PAGO','No acepta la tarjeta'),'alta');
  assert.equal(prioridadDeAtencion('RECEPCION_PIDE_PERSONA','Los hotcakes olían feo'),'urgente');
});
await caso('zona inválida o horario inválido no supone que hay personal',()=>{
  for(const extra of [{timezone:'no/existe'},{reglas_atencion:'{}'},{reglas_atencion:'mal json'}])
    assert.equal(decidirRecordatorio({...fila,cfg:{...cfg,...extra}}),null);
});
await caso('recordatorio revisa vigencia, respeta negocio y no expone texto ni teléfono',async()=>{
  const eventos=[];const consultas=[];
  await revisarAtencionPendiente({db:{query:async(...a)=>{consultas.push(a);}},buscar:async()=>[fila],
    reclamar:async()=>1,vigente:async()=>true,ahora:new Date('2026-10-12T12:30:00Z'),broadcastPanel:async(n,d)=>eventos.push({n,d})});
  assert.equal(eventos[0].n,'local');assert.equal(eventos[0].d.prioridad,'urgente');
  assert(!JSON.stringify(eventos).includes(fila.telefono));assert(!JSON.stringify(eventos).includes('hotcakes'));
  assert.match(consultas[0][0],/enviado_at/);
});
await caso('si el personal ya atendió no sale el recordatorio',async()=>{
  const n=await revisarAtencionPendiente({db:{query:async()=>{}},buscar:async()=>[fila],reclamar:async()=>1,
    vigente:async()=>false,ahora:new Date('2026-10-12T12:30:00Z'),broadcastPanel:()=>assert.fail('aviso de un caso atendido')});
  assert.equal(n,0);
});
await caso('embudo separa formularios, atención mixta, cancelado recuperado y tienda',()=>{
  const m=(t,origen,texto,direccion=origen==='cliente'?'entrante':'saliente')=>({telefono:t,origen,texto,direccion});
  const mensajes=[m('5218781111111','cliente','Formulario recibido'),m('5218781111111','bot','Tu pedido XAB-1 quedó registrado'),
    m('5218781111111','humano','Lo revisamos'),m('5218782222222','humano','Listo'),m('5218783333333','cliente','Consulta')];
  const pedidos=[{telefono:'8781111111',folio:'XAB-1',canal:'whatsapp',estado:'cancelado',creado:'2026-10-11 10:00'},
    {telefono:'8781111111',folio:'XAB-2',origen:'manual',estado:'entregado',creado:'2026-10-11 10:01'},
    {telefono:'8783333333',folio:'XAB-3',canal:'tienda_online',estado:'entregado'},
    {telefono:'8784444444',folio:'XAB-4',canal:'tienda_online',estado:'entregado'}];
  const r=analizarEmbudo({mensajes,pedidos});
  assert.equal(r.formulariosConfirmados,1);assert.equal(r.formularioRecuperadoManual,1);
  assert.equal(r.formularioYHumano,1);assert.equal(r.atencionHumanaSinFormulario,1);
  assert.equal(r.tiendaEntregadaConConversacion,1);assert.equal(r.tiendaEntregadaSinConversacion,1);
});
await caso('periodos inválidos no llegan a SQL',()=>{
  validarPeriodo('2026-10-10','2026-10-12');
  assert.throws(()=>validarPeriodo('2026-02-30','2026-03-01'));
  assert.throws(()=>validarPeriodo('2026-10-12','2026-10-10'));
});
console.log(`MEJORAS OBISPADO: ${pasadas} pruebas correctas`);
