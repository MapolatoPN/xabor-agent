import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {pool,actualizarConfiguracion,setBotPausado} from '../src/services/database.js';
import {crearContinuidad} from '../src/services/whatsappContinuidad.js';
import {prepararNegocioBotones,prepararNegocioMixtos} from './lib-botones-local.mjs';
import {atenderConAgente} from '../src/mesero-agente/canalDelAgente.js';
import {leerEstadoVersionado} from '../src/mesero-agente/persistenciaDelTurno.js';
import {entregarRespuesta,despacharRespuestasPendientes as despacharRespuestas} from '../src/mesero-agente/entregaDeRespuestas.js';
import {manejarFacturacionWhatsapp} from '../src/services/facturacionWhatsapp.js';
Object.assign(process.env,{MESERO_AGENTE_MODE:'true',WHATSAPP_INTERACTIVOS:'true'});
const no=async()=>{throw Error('EFECTO_NO_AUTORIZADO_EN_PRUEBA');};
const respuestaModelo=(name,input={})=>({content:[{type:'tool_use',id:randomUUID(),name,input}],stop_reason:'tool_use'});
let casos=0;
async function caso(nombre,fn){await fn();console.log('OK incidente '+(++casos)+': '+nombre);}
async function fixture({mixtos=false,conCarrito=false}={}) {
  const f=await (mixtos?prepararNegocioMixtos():prepararNegocioBotones());
  if(!mixtos && !conCarrito) {
    f.estado.carrito.items=[];
    await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',
      [f.negocioId,`agente:${f.telefono}`,JSON.stringify(f.estado)]);
  }
  await actualizarConfiguracion({bot_whatsapp_solo_prueba:'false',whatsapp_atencion_general_v1:'true',
    whatsapp_beta_hibrido_v1:'true',mesero_agente_porcentaje:'100',mesero_agente_telefonos:'',
    whatsapp_inicio_mapo_v1:'true',whatsapp_interactivos_elecciones_v1:'true',whatsapp_flows_v1:'true',
    whatsapp_flow_productos_id:'11111111111',whatsapp_flow_configurar_id:'22222222222',
    whatsapp_flow_facturacion_id:'44444444444'},f.negocioId);
  const continuidad=crearContinuidad({pool,locks:pool,procesar:no,cargarSesion:no,leerSesion:no,
    alRevision:(n,t)=>setBotPausado(t,true,n)});
  const humano=async(n,t,motivo)=>(await continuidad.enviarARevision(n,t,motivo)) || continuidad.revisionActiva(n,t);
  const procesar=async(mensaje,extra={})=>{
    const wamid='wamid.incidente.'+randomUUID(),msg={id:wamid,from:f.telefono,timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:mensaje}};
    await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')",
      [f.negocioId,f.telefono,wamid,JSON.stringify({message:msg})]);
    const r=await atenderConAgente({...f,mensaje,wamids:[wamid],llamarModelo:no,registrar:no,emitir:no,guardar:no,crearPago:no,
      enviarMenu:no,escalarAHumano:humano,...extra});
    assert(r.ok,JSON.stringify(r));
    const fila=r.outbox?(await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1',[r.outbox.clave])).rows[0]:null;
    return {r,fila};
  };
  // Entrega la respuesta (como Meta) para que sus botones queden vigentes.
  const entregar=async q=>{const wamid='wamid.salida.'+randomUUID();
    assert.equal((await entregarRespuesta({outboxClave:q.fila.evento_clave,enviar:async()=>({messages:[{id:wamid}]}),alHumano:no})).estado,'entregado');
    return wamid;};
  const tocar=async(wamidOrigen,token,extra={})=>{
    const wamid='wamid.toque.'+randomUUID(),msg={id:wamid,from:f.telefono,timestamp:String(Math.floor(Date.now()/1000)),
      type:'interactive',context:{id:wamidOrigen},interactive:{type:'button_reply',button_reply:{id:token,title:'No es autoridad'}}};
    await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')",
      [f.negocioId,f.telefono,wamid,JSON.stringify({message:msg})]);
    const r=await atenderConAgente({...f,mensaje:'',wamids:[wamid],interaccion:{mensajes:[msg],mixto:false},llamarModelo:no,registrar:no,
      emitir:no,guardar:no,crearPago:no,enviarMenu:no,escalarAHumano:humano,...extra});
    assert(r.ok,JSON.stringify(r));
    const fila=r.outbox?(await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1',[r.outbox.clave])).rows[0]:null;
    return {r,fila};
  };
  return {...f,procesar,entregar,tocar,leer:()=>leerEstadoVersionado(f.negocioId,f.telefono)};
}
const enviar=async()=>({messages:[{id:'wamid.entrega.'+randomUUID()}]});
try {
  await caso('Cecy: typo y petición juntos generan formulario sin modelo',async()=>{
    const f=await fixture(),q=await f.procesar('buentas tardes\npara hacer un pedido');
    assert.equal(q.fila.carga.interactivo.type,'flow');assert.equal(q.r.llamadasAlModelo,0);
    assert.equal((await f.leer()).carrito.items.length,0);
  });
  await caso('Nancy: foto ambigua pregunta antes de enviar imágenes',async()=>{
    const f=await fixture(),q=await f.procesar('Un favor tu crees que me puedas apoyar con una foto xfis');
    assert.match(q.fila.carga.texto,/de qué necesitas la foto/);assert(!q.fila.carga.interactivo);
    assert.equal(q.r.llamadasAlModelo,0);assert.equal(q.r.operaciones.length,0);
  });
  await caso('Sarahi: solicitud, duda por folio y foto conservan ruta fiscal',async()=>{
    const f=await fixture();
    for(const [texto,archivoFiscal] of [['Me podrian apoyar con la factura porfavor',false],
      ['En donde dice el folio?',false],['[Imagen adjunta]',true]]) {
      const fiscal=await manejarFacturacionWhatsapp({...f,texto,formularioDisponible:true,archivoFiscal});
      assert.equal(fiscal.formulario.servicio,'facturacion');
      const q=await f.procesar(texto,{servicioSolicitado:fiscal.formulario});
      assert.equal(q.fila.carga.interactivo.action.parameters.flow_id,'44444444444');
      assert.equal(q.r.llamadasAlModelo,0);
      if(texto.includes('folio'))assert.match(q.fila.carga.texto,/Referencia de compra/);
      if(archivoFiscal)assert.match(q.fila.carga.texto,/No lo he validado/);
    }
    assert.equal((await f.leer()).carrito.items.length,0);
    const fallback=await manejarFacturacionWhatsapp({...f,texto:'¿Dónde está el folio?'});
    assert.match(fallback.mensaje,/referencia de tu compra/);
    const ajeno=await manejarFacturacionWhatsapp({...f,texto:'necesito una factura folio 98765432',formularioDisponible:true});
    assert(!ajeno.formulario);assert.match(ajeno.mensaje,/No encontré/);
    const otra=await manejarFacturacionWhatsapp({...f,texto:'quiero ordenar a domicilio',formularioDisponible:true});
    assert.equal(otra.manejado,false);
    assert.equal((await pool.query('SELECT 1 FROM facturacion_whatsapp_estado WHERE negocio_id=$1 AND telefono=$2',[f.negocioId,f.telefono])).rowCount,0);
    const folio='XAB-'+randomInt(10000000,90000000);
    await pool.query("INSERT INTO pedidos_activos(negocio_id,folio,estado,datos) VALUES($1,$2,'entregado',$3)",
      [f.negocioId,folio,JSON.stringify({total:100,pago_confirmado:true,forma_pago:'efectivo',telefono_conversacion:'520000000000'})]);
    const ajenoReal=await manejarFacturacionWhatsapp({...f,texto:'factura '+folio,formularioDisponible:true});
    assert(!ajenoReal.formulario);assert.match(ajenoReal.mensaje,/no está asociado a este WhatsApp/);
    const otroNegocio=await fixture();
    const cruzado=await manejarFacturacionWhatsapp({...otroNegocio,texto:'factura '+folio,formularioDisponible:true});
    assert(!cruzado.formulario);assert.match(cruzado.mensaje,/No encontré/);
  });
  await caso('Mario 2-oct: «Cambiar algo» de un resumen viejo no reabre el formulario de factura',async()=>{
    // 06:41 resumen con botones → 06:42 «Para facturar ?» (Flow de factura) →
    // 09:43 toca «Cambiar algo» del resumen viejo. En producción el bot volvió
    // a mandar el Flow de factura con «No pude guardar esa respuesta».
    const f=await fixture({conCarrito:true});
    const resumen=await f.procesar('Hola');
    assert.equal(resumen.fila.carga.interactivo.type,'button');
    const wResumen=await f.entregar(resumen);
    const cambiar=resumen.fila.carga.interactivo.action.buttons.find(b=>b.reply.title==='Cambiar algo').reply.id;
    const fiscal=await manejarFacturacionWhatsapp({...f,texto:'Para facturar ?',formularioDisponible:true});
    const factura=await f.procesar('Para facturar ?',{servicioSolicitado:fiscal.formulario});
    assert.equal(factura.fila.carga.interactivo.action.parameters.flow_id,'44444444444');
    await f.entregar(factura);
    assert.equal((await f.leer()).pendiente.tipo,'formulario_servicio');
    const antes=structuredClone((await f.leer()).carrito);
    const t=await f.tocar(wResumen,cambiar);
    const carga=t.fila.carga;
    assert.doesNotMatch(carga.texto,/No pude guardar/);
    assert.match(carga.texto,/no está vigente/);
    assert.notEqual(carga.interactivo?.type,'flow','un toque al resumen reabrió un formulario');
    assert.deepEqual(carga.interactivo.action.buttons.map(b=>b.reply.title),['Confirmar','Cambiar algo','Agregar otro']);
    const despues=await f.leer();
    assert.equal(despues.pendiente.tipo,'confirmar_resumen');assert.equal(despues.folio,null);
    assert.deepEqual(despues.carrito,antes);
    assert.equal((await pool.query('SELECT count(*)::int n FROM agente_solicitudes_servicio WHERE negocio_id=$1',[f.negocioId])).rows[0].n,0);
  });
  await caso('un formulario de factura vencido sí se reabre: es su misma clase',async()=>{
    const f=await fixture({conCarrito:true});
    const fiscal=await manejarFacturacionWhatsapp({...f,texto:'Para facturar ?',formularioDisponible:true});
    const factura=await f.procesar('Para facturar ?',{servicioSolicitado:fiscal.formulario});
    const wFactura=await f.entregar(factura);
    await pool.query("UPDATE agente_preguntas_interactivas SET created_at=now()-interval '31 minutes' WHERE negocio_id=$1",[f.negocioId]);
    const token=factura.fila.carga.interactivo.action.parameters.flow_token;
    const wamid='wamid.nfm.'+randomUUID(),msg={id:wamid,from:f.telefono,timestamp:String(Math.floor(Date.now()/1000)),type:'interactive',
      context:{id:wFactura},interactive:{type:'nfm_reply',nfm_reply:{response_json:JSON.stringify({flow_token:token,nombre:'Cliente de prueba',
        rfc:'AAA010101AAA',codigo_postal:'26000',regimen:'612',uso_cfdi:'G03',correo:'prueba@example.invalid',referencia:'Ticket 123'})}}};
    await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')",[f.negocioId,f.telefono,wamid,JSON.stringify({message:msg})]);
    const r=await atenderConAgente({...f,mensaje:'',wamids:[wamid],interaccion:{mensajes:[msg],mixto:false},llamarModelo:no,registrar:no,emitir:no,guardar:no,crearPago:no,enviarMenu:no});
    const carga=(await pool.query('SELECT carga FROM agente_outbox WHERE evento_clave=$1',[r.outbox.clave])).rows[0].carga;
    assert.match(carga.texto,/No pude guardar esa respuesta/);
    assert.equal(carga.interactivo.action.parameters.flow_id,'44444444444');
  });
  await caso('Wendy: opción no verificable pide completar, sin adivinar ni agotar el modelo',async()=>{
    const f=await fixture({mixtos:true});let llamadas=0;
    const q=await f.procesar('Me preparas unos chilaquiles salza suisa',{llamarModelo:async()=>{
      llamadas++;if(llamadas>1)throw Error('NO_REPETIR_LA_OPCION_SIN_EVIDENCIA');
      return respuestaModelo('modificar_linea',{linea_id:'mixtos-1',opciones:[{grupo:'Salsa',opcion:'Suiza'}]});
    }});
    assert.equal(q.r.recuperacion,'eleccion_sin_evidencia_pedir_aclaracion');
    assert.equal(llamadas,1);assert.equal((await f.leer()).hechos.escalado,false);
    assert.equal((await f.leer()).carrito.items[0].modificadores.length,0);
    assert.equal(q.fila.carga.interactivo.type,'flow');
  });
  await caso('Handoff automático: acuse único aunque la conversación ya esté pausada',async()=>{
    const f=await fixture(),q=await f.procesar('Tengo una consulta especial',{
      llamarModelo:async()=>respuestaModelo('pedir_humano',{motivo:'necesita una persona'})});
    assert(q.fila.carga.recibo_handoff,'acuse vinculado al handoff, no una excepción global');
    let enviados=0;const emitir=async()=>{enviados++;return enviar();};
    const resultados=await Promise.all([1,2].map(()=>entregarRespuesta({outboxClave:q.fila.evento_clave,enviar:emitir,alHumano:no})));
    assert.equal(resultados.filter(r=>r.estado==='entregado').length,1);assert.equal(enviados,1);
    assert.equal((await f.leer()).hechos.escalado,true);
    assert.equal((await pool.query('SELECT bot_pausado FROM conversaciones_control WHERE negocio_id=$1 AND telefono=$2',[f.negocioId,f.telefono])).rows[0].bot_pausado,true);
  });
  for(const barrera of ['maestro','pausa_posterior','revision_posterior','humano','takeover','ventana','vencido','beta']) {
    await caso('acuse no evade '+barrera,async()=>{
      const f=await fixture(),q=await f.procesar('Consulta especial',{llamarModelo:async()=>respuestaModelo('pedir_humano',{motivo:'prueba local'})});
      assert(q.fila.carga.recibo_handoff);
      if(barrera==='maestro')await pool.query('UPDATE negocios SET bot_whatsapp_activo=false WHERE id=$1',[f.negocioId]);
      if(barrera==='pausa_posterior')await pool.query("UPDATE conversaciones_control SET updated_at=updated_at+interval '1 second' WHERE negocio_id=$1",[f.negocioId]);
      if(barrera==='revision_posterior')await pool.query("UPDATE whatsapp_conversaciones SET motivo='SOLICITUD_CLIENTE',actualizado_at=clock_timestamp() WHERE negocio_id=$1",[f.negocioId]);
      if(barrera==='humano')await pool.query("INSERT INTO mensajes(negocio_id,telefono,direccion,origen,texto,timestamp) VALUES($1,$2,'saliente','humano','Ya te atiendo',clock_timestamp())",[f.negocioId,f.telefono]);
      if(barrera==='takeover')await pool.query("UPDATE clientes SET human_takeover_until=now()+interval '1 hour' WHERE negocio_id=$1",[f.negocioId]);
      if(barrera==='ventana')await pool.query("UPDATE whatsapp_entradas SET recibido_at=now()-interval '25 hours' WHERE negocio_id=$1",[f.negocioId]);
      if(barrera==='vencido')await pool.query("UPDATE agente_outbox SET created_at=now()-interval '3 minutes' WHERE id=$1",[q.fila.id]);
      if(barrera==='beta')await actualizarConfiguracion({whatsapp_beta_hibrido_v1:'false'},f.negocioId);
      assert.equal((await entregarRespuesta({outboxClave:q.fila.evento_clave,enviar:no,alHumano:no})).estado,'descartado');
    });
  }
  await caso('despachador tras caída entrega el mismo acuse, sin reactivar la conversación',async()=>{
    const f=await fixture(),q=await f.procesar('Consulta especial',{llamarModelo:async()=>respuestaModelo('pedir_humano',{motivo:'prueba local'})});
    await pool.query('UPDATE agente_outbox SET disponible_at=now() WHERE id=$1',[q.fila.id]);
    let entregados=0;
    await despacharRespuestas({enviar:async({telefono})=>{if(telefono===f.telefono)entregados++;return enviar();},alHumano:async()=>true});
    assert.equal(entregados,1);
    assert.equal((await pool.query('SELECT estado FROM agente_outbox WHERE id=$1',[q.fila.id])).rows[0].estado,'entregado');
  });
  console.log(`Incidentes DB: ${casos}/${casos}; sin servicios externos.`);
} finally {await pool.end();}
