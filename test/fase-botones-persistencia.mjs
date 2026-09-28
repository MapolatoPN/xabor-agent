import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/services/database.js';
import { prepararNegocioBotones } from './lib-botones-local.mjs';
import { atenderConAgente } from '../src/mesero-agente/canalDelAgente.js';
import { leerEstadoVersionado, confirmarTurno } from '../src/mesero-agente/persistenciaDelTurno.js';
import { entregarRespuesta, acusarDialogoEnviado } from '../src/mesero-agente/entregaDeRespuestas.js';
import { crearContinuidad } from '../src/services/whatsappContinuidad.js';
import { reservarBotones, leerBoton, construirBotones, conciliarReservaBotones, descartarToquesMixtos } from '../src/mesero-agente/interactivos.js';
import { prepararEnvioInteractivo } from '../src/mesero-agente/transporteInteractivo.js';

process.env.MESERO_AGENTE_MODE='true';process.env.WHATSAPP_INTERACTIVOS='true';
let cuenta=0;
const modeloProhibido=async()=>{throw Error('MODELO_PROHIBIDO_EN_BOTONES');};
async function fixture({entregar=true}={}) {
  const f=await prepararNegocioBotones();
  const entrada=async m=>pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')",
    [f.negocioId,f.telefono,m.id,JSON.stringify({message:m})]);
  const saludar=async()=>{
    const id=`wamid.SALUDO-${randomUUID()}`;
    await entrada({id,from:f.telefono,type:'text',text:{body:'Hola'},timestamp:String(Math.floor(Date.now()/1000))});
    const r=await atenderConAgente({...f,mensaje:'Hola',nombre:'Cliente local',wamids:[id],llamarModelo:modeloProhibido});
    assert(r.ok&&r.outbox?.clave,JSON.stringify(r));return r;
  };
  const r=await saludar();
  const {rows:[o]}=await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1',[r.outbox.clave]);
  assert(o.carga.interactivo,'el canal debe construir los botones');
  const wamidSalida=`wamid.SALIDA-${randomUUID()}`;
  if(entregar) assert.equal((await entregarRespuesta({outboxClave:o.evento_clave,
    enviar:async()=>({messages:[{id:wamidSalida}]}),alHumano:async()=>true})).estado,'entregado');
  const m={id:`wamid.TOQUE-${randomUUID()}`,from:f.telefono,type:'interactive',context:{id:wamidSalida},
    interactive:{type:'button_reply',button_reply:{id:o.carga.interactivo.action.buttons[0].reply.id,title:'IGNORAR_TITULO'}}};
  await entrada(m);
  const estado=await leerEstadoVersionado(f.negocioId,f.telefono);
  const pedido={huella:estado.pendiente.huella,falta:[],aclaraciones:[]};
  const reservar=(op={})=>reservarBotones({db:pool,...f,estado,pedido,mensajes:[m],mixto:false,turnoClave:m.id,...op});
  const envio=(op={})=>prepararEnvioInteractivo({db:pool,...f,texto:o.carga.texto,interactivo:o.carga.interactivo,...op});
  return {...f,estado,pedido,m,o,entrada,saludar,reservar,envio};
}
async function caso(nombre,fn){await fn();console.log(`OK ${++cuenta}: ${nombre}`);}
try {
  await caso('parser rechaza tipos/IDs vacíos y no usa títulos',async()=>{
    for(const m of [null,{}, {type:'interactive'}, {type:'interactive',interactive:{type:'button_reply',button_reply:{id:{}}}},
      {type:'button',button:{text:'Confirmar',payload:'Confirmar'}}]) assert.equal(leerBoton(m),null);
    const f=await fixture();assert(leerBoton(f.m));
    assert.equal(leerBoton({...f.m,id:{}}),null);assert.equal(leerBoton({...f.m,context:{}}),null);
  });
  for(const [nombre,mutar] of [
    ['contexto ajeno',f=>{f.m.context.id='otro';}],
    ['cliente ajeno',f=>{f.m.from='528700000000';}],
    ['token inexistente',f=>{f.m.interactive.button_reply.id=`xb1:${'X'.repeat(22)}`;}],
    ['ciclo anterior',f=>{f.estado.conversacionId='otro-ciclo';}],
    ['pedido terminal',f=>{f.estado.hechos.confirmado=true;f.estado.folio='TEST-TERMINAL';}],
    ['catering',f=>{f.estado.evento={tipo_servicio:'catering'};}],
  ]) await caso(`${nombre}: sin efecto ni consumo`,async()=>{
    const f=await fixture();mutar(f);assert.equal((await f.reservar()).ignorar,true);
    assert.equal((await pool.query('SELECT estado FROM agente_preguntas_interactivas WHERE outbox_clave=$1',[f.o.evento_clave])).rows[0].estado,'disponible');
  });
  for(const [nombre,sql] of [
    ['bot apagado','UPDATE negocios SET bot_whatsapp_activo=false WHERE id=$1'],
    ['pausa humana',"INSERT INTO conversaciones_control(negocio_id,telefono,bot_pausado) VALUES($1,$2,true)"],
    ['takeover humano',"INSERT INTO clientes(negocio_id,telefono,human_takeover_until) VALUES($1,$2,now()+interval '1 hour') ON CONFLICT(telefono) DO UPDATE SET human_takeover_until=EXCLUDED.human_takeover_until"],
    ['revisión activa',"INSERT INTO whatsapp_conversaciones(negocio_id,telefono,requiere_revision) VALUES($1,$2,true) ON CONFLICT(negocio_id,telefono) DO UPDATE SET requiere_revision=true"],
    ['integración apagada',"UPDATE integraciones_canal SET activo=false WHERE negocio_id=$1"],
    ['fuera de canario',"UPDATE configuracion SET valor='528700000000' WHERE negocio_id=$1 AND clave='mesero_agente_telefonos'"],
  ]) await caso(`${nombre}: reserva y envío bloqueados`,async()=>{
    const f=await fixture();await pool.query(sql,sql.includes('$2')?[f.negocioId,f.telefono]:[f.negocioId]);
    assert.equal((await f.reservar()).ignorar,true);assert.equal((await f.envio()).permitido,false);
  });
  await caso('otra empresa no resuelve el token',async()=>{
    const f=await fixture(),g=await fixture();
    assert.equal((await g.reservar({mensajes:[{...f.m,from:g.telefono}]})).ignorar,true);
  });
  await caso('bandera apagada: texto al enviar, aviso al tocar',async()=>{
    const f=await fixture();await pool.query("UPDATE configuracion SET valor='false' WHERE negocio_id=$1 AND clave='whatsapp_interactivos_v1'",[f.negocioId]);
    assert.deepEqual(await f.envio(),{permitido:true,interactivo:null});assert.equal((await f.reservar()).accion,'aviso');
  });
  await caso('ventana de 24h se revisa con hora real del cliente',async()=>{
    const f=await fixture();
    await pool.query("UPDATE whatsapp_entradas SET recibido_at=now()-interval '25 hours',payload=jsonb_set(payload,'{message,timestamp}',to_jsonb((extract(epoch from now()-interval '25 hours')::bigint)::text)) WHERE negocio_id=$1",[f.negocioId]);
    assert.equal((await f.envio()).permitido,false);
    // Reentrega recibida ahora de un mensaje viejo tampoco abre la ventana.
    await pool.query('UPDATE whatsapp_entradas SET recibido_at=now() WHERE negocio_id=$1',[f.negocioId]);
    assert.equal((await f.envio()).permitido,false);
    await pool.query("UPDATE whatsapp_entradas SET payload=jsonb_set(payload,'{message,timestamp}',to_jsonb((extract(epoch from now()+interval '1 hour')::bigint)::text)) WHERE negocio_id=$1",[f.negocioId]);
    assert.equal((await f.envio()).permitido,false,'un reloj futuro no abre la ventana');
    await pool.query("UPDATE whatsapp_entradas SET payload=payload #- '{message,timestamp}' WHERE negocio_id=$1",[f.negocioId]);
    assert.equal((await f.envio()).permitido,false,'sin timestamp no se supone ventana abierta');
  });
  await caso('sin acuse: retención durable y vencimiento de dos minutos',async()=>{
    const f=await fixture({entregar:false});assert.equal((await f.reservar()).retenerBotones,true);
    assert.equal((await leerEstadoVersionado(f.negocioId,f.telefono)).botonesReserva,undefined);
    await pool.query("UPDATE whatsapp_entradas SET recibido_at=now()-interval '121 seconds' WHERE negocio_id=$1 AND wamid=$2",[f.negocioId,f.m.id]);
    assert.equal((await f.reservar()).accion,'aviso');
  });
  await caso('pregunta y huella obsoletas no confirman',async()=>{
    const f=await fixture();assert.equal((await f.reservar({pedido:{...f.pedido,huella:'otra'}})).accion,'aviso');
    const g=await fixture();g.estado.pendiente.dialogo_id='otro';assert.equal((await g.reservar()).accion,'aviso');
  });
  await caso('texto previo manejado por otro atajo también invalida el botón',async()=>{
    const f=await fixture();
    await f.entrada({id:`wamid.ATAJO-${randomUUID()}`,from:f.telefono,type:'text',text:{body:'Ver menú'}});
    const m={...f.m,id:`wamid.DESPUES-ATAJO-${randomUUID()}`};await f.entrada(m);
    assert.equal((await f.reservar({mensajes:[m]})).accion,'aviso');
  });
  await caso('acuse tardío no altera la revisión de una reserva en ejecución',async()=>{
    const f=await fixture({entregar:false});
    await pool.query("UPDATE agente_outbox SET estado='entregado',wamid_salida=$2,entregado_at=now() WHERE evento_clave=$1",[f.o.evento_clave,f.m.context.id]);
    const estado=await leerEstadoVersionado(f.negocioId,f.telefono);
    assert.equal(estado.dialogo.enviado,true);await f.reservar({estado});
    const antes=(await leerEstadoVersionado(f.negocioId,f.telefono))._revision;
    await acusarDialogoEnviado({...f,dialogoId:estado.dialogo.id,texto:estado.dialogo.texto,wamidSalida:f.m.context.id});
    assert.equal((await leerEstadoVersionado(f.negocioId,f.telefono))._revision,antes);
  });
  await caso('worker retiene sin ejecutar y otro worker recupera el pendiente',async()=>{
    const f=await fixture({entregar:false});let veces=0;
    const crear=procesar=>crearContinuidad({pool,locks:pool,ventanaMs:0,cargarSesion:async()=>{},leerSesion:async()=>({}),procesar});
    const primero=crear(async()=>{veces++;return {retenerBotones:true};});
    const segundo=crear(async()=>{veces++;});
    const m={...f.m,id:`wamid.RETENIDO-${randomUUID()}`};
    try {
      await primero.recibir([{negocioId:f.negocioId,telefono:f.telefono,wamid:m.id,payload:{message:m,value:{}}}]);
      await primero.ejecutar(f.negocioId,f.telefono);await primero.detener();
      assert.equal((await pool.query('SELECT estado FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=$2',[f.negocioId,m.id])).rows[0].estado,'pendiente');
      await segundo.ejecutar(f.negocioId,f.telefono);assert.equal(veces,2);
      assert.equal((await pool.query('SELECT estado FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=$2',[f.negocioId,m.id])).rows[0].estado,'completado');
    } finally {await primero.detener();await segundo.detener();}
  });
  await caso('dos conexiones compiten por UNA reserva',async()=>{
    const f=await fixture(),otro=await leerEstadoVersionado(f.negocioId,f.telefono);
    const r=await Promise.allSettled([f.reservar(),f.reservar({estado:otro})]);
    assert.equal(r.filter(x=>x.status==='fulfilled'&&x.value.accion==='confirmar').length,1);
    assert.equal(r.filter(x=>x.status==='rejected'&&/BOTON_CONFLICTO_REVISION/.test(x.reason.message)).length,1);
    const recargado=await leerEstadoVersionado(f.negocioId,f.telefono);assert(recargado.botonesReserva);
    await assert.rejects(f.reservar({estado:recargado}),/BOTON_RESERVA_PENDIENTE/);
    await conciliarReservaBotones(pool,f.negocioId,recargado);
    assert.equal((await pool.query('SELECT estado FROM agente_preguntas_interactivas WHERE outbox_clave=$1',[f.o.evento_clave])).rows[0].estado,'incierta');
  });
  await caso('texto mixto descarta todos los toques, incluso sin ruta del agente',async()=>{
    const f=await fixture();await descartarToquesMixtos({db:pool,...f,mensajes:[f.m,f.m]});
    assert.equal((await f.reservar()).ignorar,true);
    assert.equal((await leerEstadoVersionado(f.negocioId,f.telefono)).botonesReserva,undefined);
  });
  await caso('fallo al persistir botones revierte estado, outbox y preguntas',async()=>{
    const f=await fixture(),estado=await leerEstadoVersionado(f.negocioId,f.telefono);
    const preparado=construirBotones({estado,pedido:{...f.pedido,total:45},texto:estado.dialogo.texto,cfg:{whatsapp_interactivos_v1:'true'}});
    assert(preparado); // provoca violación UNIQUE dentro del mismo commit
    preparado.botones[1].token=preparado.botones[0].token;
    const antes=await pool.query('SELECT revision FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2',[f.negocioId,`agente:${f.telefono}`]);
    // Nueva identidad para alcanzar el fallo de token, no el UNIQUE del diálogo.
    preparado.dialogoId=randomUUID();
    await assert.rejects(confirmarTurno({db:pool,...f,estado,pedido:{...f.pedido,lineas:[{producto:'Café americano',cantidad:1}]},
      turnoClave:'test-rollback',respuesta:{texto:estado.dialogo.texto},botones:preparado}),e=>e.code==='23505');
    const despues=await pool.query('SELECT revision FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2',[f.negocioId,`agente:${f.telefono}`]);
    assert.deepEqual(despues.rows,antes.rows);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agente_outbox WHERE negocio_id=$1 AND turno_clave=$2',[f.negocioId,'test-rollback'])).rows[0].n,0);
  });
  for(const precio of [35,55]) await caso(`precio cambió a $${precio}: no registra, vuelve a pedir confirmación`,async()=>{
    const f=await fixture();await pool.query('UPDATE menu_productos SET precio=$2 WHERE id=$1',[f.productoId,precio]);
    const r=await atenderConAgente({...f,nombre:'Cliente local',mensaje:'',wamids:[f.m.id],interaccion:{mensajes:[f.m],mixto:false},llamarModelo:modeloProhibido});
    assert(r.ok,JSON.stringify(r));assert.equal((await leerEstadoVersionado(f.negocioId,f.telefono)).folio,null);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pedidos_activos WHERE negocio_id=$1',[f.negocioId])).rows[0].n,0);
    assert.match(r.texto,/Confirmas este pedido/);
  });
  await caso('fallo después de registrar pedido: reserva incierta con folio; nunca repite',async()=>{
    const f=await fixture();let llamadasHumanas=0;
    const dbConFallo={query:(...args)=>pool.query(...args),connect:async()=>{
      const c=await pool.connect();return {release:()=>c.release(),query:(sql,args)=>{
        if(sql.includes('INSERT INTO agente_turnos'))throw Error('FALLO_LOCAL_DESPUES_DEL_EFECTO');
        return c.query(sql,args);
      }};
    }};
    const args={...f,nombre:'Cliente local',mensaje:'',wamids:[f.m.id],interaccion:{mensajes:[f.m],mixto:false},
      llamarModelo:modeloProhibido,escalarAHumano:async()=>{llamadasHumanas++;return true;}};
    const r=await atenderConAgente({...args,db:dbConFallo});assert.equal(r.motivo,'boton_reserva_incierta');
    const pedidos=await pool.query('SELECT folio FROM pedidos_activos WHERE negocio_id=$1',[f.negocioId]);assert.equal(pedidos.rows.length,1);
    const q=(await pool.query('SELECT estado,resultado FROM agente_preguntas_interactivas WHERE outbox_clave=$1',[f.o.evento_clave])).rows[0];
    assert.equal(q.estado,'incierta');assert.equal(q.resultado.folio,pedidos.rows[0].folio);
    assert.equal((await atenderConAgente(args)).motivo,'boton_reserva_incierta');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pedidos_activos WHERE negocio_id=$1',[f.negocioId])).rows[0].n,1);
    assert(llamadasHumanas>=1);
  });
  console.log(`Botones persistencia: ${cuenta}/${cuenta}, solo base local.`);
} finally {await pool.end();}
