import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool,actualizarConfiguracion,guardarMensaje,obtenerConversacion} from '../src/services/database.js';
import {prepararNegocioBotones} from './lib-botones-local.mjs';
import {registrarEstadosMensaje,estadosParaHistorial} from '../src/services/estadosMensajeWhatsapp.js';
import {atenderConAgente} from '../src/mesero-agente/canalDelAgente.js';
import {entregarRespuesta} from '../src/mesero-agente/entregaDeRespuestas.js';
import {atenderFlowRepetible,FlowNoDisponible} from '../src/mesero-agente/flowRepetibleSql.js';
import {registrarIncidenciaFormulario,purgarTelemetriaFormularios} from '../src/mesero-agente/incidenciasFormulario.js';
import {leerEstadoVersionado} from '../src/mesero-agente/persistenciaDelTurno.js';
import {leerEstadoOperativo} from '../src/mesero-agente/estadoOperativoDelPedido.js';
import {medirLatencia} from '../scripts/medir-latencia-whatsapp.mjs';
Object.assign(process.env,{MESERO_AGENTE_MODE:'true',WHATSAPP_INTERACTIVOS:'true',WHATSAPP_FLOW_ENDPOINT:'true',WHATSAPP_FLOW_PRIVATE_KEY:'local',META_APP_SECRET:'local'});
const no=async()=>{throw Error('SIN_EFECTOS_EXTERNOS');};let n=0;
async function caso(t,fn){await fn();console.log(`OK cierre DB ${++n}: ${t}`);}
try {
  const f=await prepararNegocioBotones(),otro=await prepararNegocioBotones();
  const ts=String(Math.floor(Date.now()/1000)),id='wamid.cierre.'+randomUUID();
  const s=estado=>({id,status:estado,recipient_id:f.telefono,timestamp:ts});
  await caso('apagado por defecto y aislamiento negocio/destinatario',async()=>{
    assert.equal(await registrarEstadosMensaje(pool,f.negocioId,[s('read')]),0);
    await actualizarConfiguracion({whatsapp_trazabilidad_formularios_v1:'true'},f.negocioId);
    assert.equal(await registrarEstadosMensaje(pool,f.negocioId,[s('read')]),1);
    assert.equal((await estadosParaHistorial(pool,otro.negocioId,f.telefono,[id])).get(id),null);
    assert.equal((await estadosParaHistorial(pool,f.negocioId,otro.telefono,[id])).get(id),null);
  });
  await caso('status anticipado, concurrente y fuera de orden no retrocede ni muta pedido',async()=>{
    const previo=(await leerEstadoVersionado(f.negocioId,f.telefono)).carrito;
    await Promise.all([registrarEstadosMensaje(pool,f.negocioId,[s('sent'),s('read')]),registrarEstadosMensaje(pool,f.negocioId,[s('delivered'),s('read'),s('failed')])]);
    await guardarMensaje(f.telefono,'Local','saliente','Un mensaje',f.negocioId,'bot',id);
    const m=(await obtenerConversacion(f.telefono,f.negocioId,100)).find(m=>m.message_id_externo===id);
    assert.equal(m.estadoTransporte.codigo,'read');assert.deepEqual((await leerEstadoVersionado(f.negocioId,f.telefono)).carrito,previo);
    assert.equal((await pool.query('SELECT count(*)::int n FROM whatsapp_estados_mensaje WHERE negocio_id=$1 AND wamid=$2',[f.negocioId,id])).rows[0].n,4);
    for(const timestamp of [String(Number(ts)+86400),String(Number(ts)-86400*40)])assert.equal(await registrarEstadosMensaje(pool,f.negocioId,[{...s('sent'),id:randomUUID(),timestamp}]),0);
  });
  await actualizarConfiguracion({bot_whatsapp_solo_prueba:'false',whatsapp_atencion_general_v1:'true',whatsapp_beta_hibrido_v1:'true',
    whatsapp_interactivos_elecciones_v1:'true',whatsapp_flows_v1:'true',whatsapp_carrito_unificado_v1:'true',
    whatsapp_flow_categorias_id:'11111111111',whatsapp_flow_carrito_id:'22222222222',whatsapp_promociones_proactivas_v1:'true'},f.negocioId);
  const proceso=async texto=>{
    const wamid='wamid.local.'+randomUUID();
    await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')",[f.negocioId,f.telefono,wamid,JSON.stringify({message:{type:'text',text:{body:texto},timestamp:ts}})]);
    const r=await atenderConAgente({...f,mensaje:texto,wamids:[wamid],llamarModelo:no,registrar:no,emitir:no,crearPago:no,escalarAHumano:no});assert(r.ok,JSON.stringify(r));
    if(!r.outbox)return {r};
    const {rows:[q]}=await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1',[r.outbox.clave]);
    await entregarRespuesta({outboxClave:q.evento_clave,enviar:async()=>({messages:[{id:'wamid.salida.'+randomUUID()}]}),alHumano:no});
    return {r,q,token:q.carga.interactivo?.action?.parameters?.flow_token};
  };
  await caso('motor 2x1 propone sin agregar, no insiste en el mismo carrito y respeta baja de promoción',async()=>{
    const {rows:[promo]}=await pool.query("INSERT INTO tienda_promociones(negocio_id,nombre,tipo,automatica,canales,productos,cantidad_requerida,cantidad_beneficiada) VALUES($1,'Café dos por uno','2x1',true,'[\"whatsapp\"]',$2,2,1) RETURNING id",[f.negocioId,JSON.stringify([f.productoId])]);
    const primera=await proceso('Hola');assert.match(primera.q.carga.texto,/Promoción disponible/);
    assert.equal((await leerEstadoVersionado(f.negocioId,f.telefono)).carrito.items[0].cantidad,1);
    assert(!primera.r.confirmado);assert.match(primera.q.carga.texto,/Agregar otro/);
    const segunda=await proceso('Hola');assert.doesNotMatch(segunda.q.carga.texto,/Promoción disponible/);
    await pool.query('UPDATE tienda_promociones SET activa=false WHERE id=$1',[promo.id]);
    // Nueva conversación sintética para probar vigencia, no el guard de tres
    // saludos seguidos sin responder la misma confirmación.
    await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',[f.negocioId,`agente:${f.telefono}`,JSON.stringify(f.estado)]);
    const tercera=await proceso('Hola');assert.doesNotMatch(tercera.q.carga.texto,/Promoción disponible/);
  });
  let viejo,nuevo;
  await caso('formulario vencido: token viejo inválido y borrador compatible en uno nuevo',async()=>{
    viejo=await proceso('seguir pedido');assert(viejo.token);
    const abierto=await atenderFlowRepetible(pool,{version:'3.0',action:'INIT',flow_token:viejo.token});
    await atenderFlowRepetible(pool,{version:'3.0',action:'data_exchange',screen:'CARRITO',flow_token:viejo.token,
      data:{revision:abierto.data.revision,operacion:'editar',editar:'e0',q0:'3'}});
    await pool.query("UPDATE agente_preguntas_interactivas SET created_at=now()-interval '40 minutes' WHERE outbox_clave=$1",[viejo.q.evento_clave]);
    await assert.rejects(atenderFlowRepetible(pool,{version:'3.0',action:'INIT',flow_token:viejo.token}),FlowNoDisponible);
    nuevo=await proceso('seguir pedido');assert(nuevo.token && nuevo.token!==viejo.token);
    const b=(await pool.query('SELECT f.contenido FROM agente_flows_borradores f JOIN agente_preguntas_interactivas q ON q.id=f.pregunta_id WHERE q.outbox_clave=$1',[nuevo.q.evento_clave])).rows[0]?.contenido;
    assert.equal(b.filas[0].item.cantidad,'3');assert.equal((await leerEstadoVersionado(f.negocioId,f.telefono)).carrito.items[0].cantidad,1);
    await assert.rejects(atenderFlowRepetible(pool,{version:'3.0',action:'INIT',flow_token:viejo.token}),FlowNoDisponible);
  });
  await caso('incidencia no inventa apertura, deduplica y no registra tokens/contenido',async()=>{
    const sol={version:'3.0',action:'INIT',flow_token:nuevo.token,data:{nota:'NO_GUARDAR'}};
    await registrarIncidenciaFormulario(pool,sol,'error_servidor');await registrarIncidenciaFormulario(pool,sol,'error_servidor');
    const rows=(await pool.query('SELECT a.* FROM agente_actividad_formulario a JOIN agente_preguntas_interactivas q ON q.id=a.pregunta_id WHERE q.outbox_clave=$1',[nuevo.q.evento_clave])).rows;
    assert.equal(rows.filter(r=>r.tipo==='error_servidor').length,1);assert(!JSON.stringify(rows).includes(nuevo.token));assert(!JSON.stringify(rows).includes('NO_GUARDAR'));
  });
  await caso('catálogo cambiado no recupera borrador viejo',async()=>{
    await pool.query('UPDATE menu_productos SET precio=precio+1 WHERE negocio_id=$1 AND id=$2',[f.negocioId,f.productoId]);
    const otroFormulario=await proceso('seguir pedido');
    assert.equal((await pool.query('SELECT count(*)::int n FROM agente_flows_borradores f JOIN agente_preguntas_interactivas q ON q.id=f.pregunta_id WHERE q.outbox_clave=$1',[otroFormulario.q.evento_clave])).rows[0].n,0);
  });
  await caso('retención solo borra telemetría mayor a 30 días, conserva conversación/pedido',async()=>{
    const antes=(await pool.query('SELECT estado FROM conversacion_estado WHERE negocio_id=$1',[f.negocioId])).rows;
    await pool.query("UPDATE whatsapp_estados_mensaje SET observado_at=now()-interval '31 days' WHERE negocio_id=$1 AND estado='sent'",[f.negocioId]);
    await purgarTelemetriaFormularios(pool);
    assert.equal((await pool.query('SELECT count(*)::int n FROM whatsapp_estados_mensaje WHERE negocio_id=$1 AND wamid=$2',[f.negocioId,id])).rows[0].n,3);
    assert.deepEqual((await pool.query('SELECT estado FROM conversacion_estado WHERE negocio_id=$1',[f.negocioId])).rows,antes);
  });
  await caso('estado operativo por negocio, folio y dueño; diagnóstico de latencias solo agregado',async()=>{
    const folio='XAB-'+randomUUID().replaceAll('-','').slice(0,12);
    await pool.query("INSERT INTO pedidos_activos(negocio_id,folio,estado,datos) VALUES($1,$2,'listo',$3)",
      [f.negocioId,folio,JSON.stringify({cliente:{telefono:f.telefono},modalidad:'entrega a domicilio'})]);
    assert.equal((await leerEstadoOperativo(pool,{...f,folio})).estado,'listo');
    assert.equal(await leerEstadoOperativo(pool,{...f,folio,negocioId:otro.negocioId}),null);
    assert.equal(await leerEstadoOperativo(pool,{...f,folio,telefono:otro.telefono}),null);
    assert.equal(await leerEstadoOperativo(pool,{...f,folio:'XAB-NO-EXISTE'}),null);
    const metrica=await medirLatencia(pool,f.negocioId,24);assert(metrica.rutas.length);
    assert(!JSON.stringify(metrica).includes(f.telefono));assert(!JSON.stringify(metrica).includes(folio));
  });
  console.log(`Cierre WhatsApp DB: ${n}/${n}. Solo fixtures locales; ninguna salida real.`);
} finally {await pool.end();}
