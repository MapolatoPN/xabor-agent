// Incidente 1-oct-2026 en Mapolato Obispado, con los mensajes reales de la clienta:
//  · con el carrito abierto, cuatro preguntas sobre el pago recibieron solo «Tu carrito»;
//  · el carrito que tenía abierto se invalidó porque un mensaje suyo ya esperaba turno;
//  · el turno de su dirección falló en el proveedor y el formulario tapó el aviso;
//  · tres frases de entrada no abrieron ni el menú de Mapo ni el formulario.
// Base local test_botones_*, red solo local, modelo simulado. Sin mensajes ni pedidos reales.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool,actualizarConfiguracion } from '../src/services/database.js';
import { prepararNegocioMixtos } from './lib-botones-local.mjs';
import { atenderConAgente } from '../src/mesero-agente/canalDelAgente.js';
import { leerEstadoVersionado } from '../src/mesero-agente/persistenciaDelTurno.js';
import { entregarRespuesta } from '../src/mesero-agente/entregaDeRespuestas.js';
import { atenderFlowRepetible } from '../src/mesero-agente/flowRepetibleSql.js';
import { crearContinuidad } from '../src/services/whatsappContinuidad.js';
Object.assign(process.env,{MESERO_AGENTE_MODE:'true',WHATSAPP_INTERACTIVOS:'true',WHATSAPP_FLOW_ENDPOINT:'true',
  WHATSAPP_FLOW_PRIVATE_KEY:'solo-local',META_APP_SECRET:'solo-local'});
const noModelo=async()=>{throw Error('NO_DEBE_LLAMAR_MODELO');};
const sinEfectos=async()=>{throw Error('NO_PEDIDOS_PAGOS_TICKETS');};
const MUTACIONES=['agregar_producto','modificar_linea','quitar_linea','definir_pago','definir_entrega','confirmar_pedido'];
let n=0,fallidas=0;
async function caso(nombre,fn){
  try {await fn();console.log(`OK carrito-respuestas ${++n}: ${nombre}`);}
  catch(e) {fallidas++;console.log(`FALLA carrito-respuestas: ${nombre}\n  ${String(e?.message || e).split('\n')[0]}`);}
}

// La misma configuración que Mapolato Obispado tiene en producción (atención
// general). El carrito queda como el de la clienta: un platillo con opciones
// por elegir y sin forma de pago, así que la siguiente pregunta es el carrito.
async function fixture({vacio=false}={}) {
  const f=await prepararNegocioMixtos();
  if(vacio) {
    f.estado.carrito.items=[];
    await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',
      [f.negocioId,`agente:${f.telefono}`,JSON.stringify(f.estado)]);
  }
  await actualizarConfiguracion({nombre:'Mapolato Obispado',whatsapp_inicio_mapo_v1:'true',
    whatsapp_atencion_general_v1:'true',bot_whatsapp_solo_prueba:'false',mesero_agente_porcentaje:'100',
    mesero_agente_telefonos:'',whatsapp_flows_v1:'true',whatsapp_flows_telefonos:'',whatsapp_beta_hibrido_v1:'true',
    whatsapp_beta_telefonos:'',whatsapp_carrito_unificado_v1:'true',whatsapp_interactivos_elecciones_v1:'true',
    whatsapp_flow_categorias_id:'11111111111',whatsapp_flow_carrito_id:'22222222222',
    whatsapp_flow_configurar_id:'44444444444',whatsapp_flow_carrito_duplicar_v1:'true',
    whatsapp_flow_facturacion_id:'66666666666',whatsapp_flow_evento_id:'77777777777'},f.negocioId);
  const leer=()=>leerEstadoVersionado(f.negocioId,f.telefono);
  const identidad=()=>({id:'wamid.carrito.'+randomUUID(),from:f.telefono,timestamp:String(Math.floor(Date.now()/1000))});
  const texto=body=>({...identidad(),type:'text',text:{body}});
  // Un mensaje del cliente que llegó mientras se atendía el turno: la
  // continuidad lo deja pendiente para el siguiente lote.
  const encolar=async(m,telefono=f.telefono)=>{
    await pool.query('INSERT INTO whatsapp_conversaciones(negocio_id,telefono) VALUES($1,$2) ON CONFLICT DO NOTHING',[f.negocioId,telefono]);
    await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'pendiente')",
      [f.negocioId,telefono,m.id,JSON.stringify({message:m})]);
  };
  const pendiente=async m=>(await pool.query('SELECT estado FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=$2',[f.negocioId,m.id])).rows[0]?.estado;
  const procesar=async(m,{modelo=noModelo,enviar=true}={})=>{
    await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado') ON CONFLICT (negocio_id,wamid) DO UPDATE SET estado='completado'",
      [f.negocioId,f.telefono,m.id,JSON.stringify({message:m})]);
    const r=await atenderConAgente({...f,mensaje:m.text?.body || '',wamids:[m.id],llamarModelo:modelo,
      registrar:sinEfectos,emitir:sinEfectos,guardar:sinEfectos,crearPago:sinEfectos});
    assert.equal(r.ok,true,JSON.stringify(r));
    if(!r.outbox)return {r};
    const {rows:[fila]}=await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1',[r.outbox.clave]);
    const wamid='wamid.salida.'+randomUUID();
    if(enviar && !r.yaEntregado)assert.equal((await entregarRespuesta({outboxClave:fila.evento_clave,
      enviar:async()=>({messages:[{id:wamid}]}),alHumano:sinEfectos})).estado,'entregado');
    return {...fila.carga,r,fila,wamid};
  };
  const preguntas=async clave=>Number((await pool.query(
    'SELECT count(*) FROM agente_preguntas_interactivas WHERE outbox_clave=$1',[clave])).rows[0].count);
  return {...f,leer,texto,encolar,pendiente,procesar,preguntas};
}
const token=q=>q.interactivo.action.parameters.flow_token;
const abrir=q=>atenderFlowRepetible(pool,{action:'INIT',flow_token:token(q)});
const cantidad=e=>e.carrito.items.reduce((s,i)=>s+i.cantidad,0);
const agregaUnCafe=productoId=>{
  let vuelta=0;
  return async({tools})=>{
    assert(tools.some(t=>t.name==='agregar_producto'),'pedir otro café es una decisión, no una consulta');
    if(vuelta++===0)return {content:[{type:'tool_use',id:'alta-local-'+randomUUID(),name:'agregar_producto',
      input:{producto_id:String(productoId),cantidad:1}}],stop_reason:'tool_use'};
    return {content:[{type:'text',text:'Listo.'}],stop_reason:'end_turn'};
  };
};

try {
  await caso('cada pregunta del incidente recibe su respuesta y el carrito sigue a un toque',async()=>{
    for(const pregunta of ['Que tipo de pago es?','Que es el enlace de pago?',
      'Mm me podrían explicar por favor?','Me podrían apoyar con la info?']) {
      const f=await fixture();
      const abierto=await f.procesar(f.texto('seguir pedido'));
      assert.equal(abierto.interactivo?.type,'flow',pregunta);
      const antes=structuredClone((await f.leer()).carrito);
      const respuesta='El enlace de pago es un link seguro para pagar con tarjeta desde tu celular.';
      const ofrecidas=new Set();
      const q=await f.procesar(f.texto(pregunta),{modelo:async({tools})=>{
        for(const t of tools)ofrecidas.add(t.name);
        return {content:[{type:'text',text:respuesta}],stop_reason:'end_turn'};
      }});
      assert(q.texto.startsWith(respuesta),`la respuesta debe salir: ${pregunta} -> ${q.texto.slice(0,60)}`);
      for(const m of MUTACIONES)assert(!ofrecidas.has(m),`una consulta no recibe ${m}: ${pregunta}`);
      assert.doesNotMatch(q.texto,/^\*Tu carrito\*/,pregunta);
      assert.equal(q.interactivo?.type,'flow',`el carrito sigue disponible: ${pregunta}`);
      assert.equal(q.interactivo.body.text,q.texto);
      assert.equal(q.interactivo.action.parameters.flow_cta,'Continuar pedido');
      const e=await f.leer();
      assert.deepEqual(e.carrito,antes,`una pregunta no cambia el pedido: ${pregunta}`);
      assert.equal(e.folio,null);assert.notEqual(e.pendiente?.tipo,'confirmar_resumen');
      assert.equal((await abrir(q)).screen,'CARRITO','el formulario nuevo abre');
    }
  });

  await caso('una decisión escrita como pregunta sigue pasando por el pedido',async()=>{
    const f=await fixture();
    await f.procesar(f.texto('seguir pedido'));
    await f.procesar(f.texto('¿Me podrían ayudar a agregar otro café americano?'),{modelo:agregaUnCafe(f.productoId)});
    assert.equal(cantidad(await f.leer()),2,'la petición de cambio se aplicó por el ejecutor');
  });

  await caso('si el cliente ya escribió otra cosa, el turno no manda un carrito que nacería viejo',async()=>{
    // Control: el mismo turno, sin nada en espera, sí lleva el carrito.
    const control=await fixture();
    await control.procesar(control.texto('seguir pedido'));
    const c=await control.procesar(control.texto('Agrégame otro café americano'),{modelo:agregaUnCafe(control.productoId)});
    assert.equal(c.interactivo?.type,'flow','sin mensajes en espera el carrito sí sale');
    // Incidente: su dirección llegó mientras el modelo atendía el pedido.
    const f=await fixture();
    await f.procesar(f.texto('seguir pedido'));
    const direccion=f.texto('Calle Ficticia 123, Colonia Centro. Esa es la dirección');
    const alta=agregaUnCafe(f.productoId);let encolado=false;
    const q=await f.procesar(f.texto('Agrégame otro café americano'),{modelo:async(args)=>{
      if(!encolado){encolado=true;await f.encolar(direccion);}
      return alta(args);
    }});
    assert.equal(cantidad(await f.leer()),2,'el cambio del turno sí se guardó');
    assert.equal(q.interactivo,undefined,'no se manda un formulario que el siguiente turno invalidaría');
    assert.equal(await f.preguntas(q.fila.evento_clave),0,'ni se registra como pregunta abierta');
    assert(q.texto && !/^\*Tu carrito\*/.test(q.texto),q.texto);
    // Sin lista ni formulario, la pregunta se entiende sola: enumera las opciones.
    for(const opcion of ['Roja','Verde','Suiza','Chipotle'])assert(q.texto.includes(opcion),`falta ${opcion}: ${q.texto}`);
    // El siguiente turno (el mensaje que esperaba) sí lleva el carrito, y abre.
    const siguiente=await f.procesar(direccion,{modelo:async()=>({content:[{type:'text',text:'Gracias.'}],stop_reason:'end_turn'})});
    assert.equal(siguiente.interactivo?.type,'flow');
    assert.equal((await abrir(siguiente)).screen,'CARRITO');
  });

  await caso('solo cuentan mensajes del mismo cliente recibidos después del lote',async()=>{
    for(const ajeno of ['otro_telefono','anterior_al_lote']) {
      const f=await fixture();
      await f.procesar(f.texto('seguir pedido'));
      const otro=f.texto(ajeno==='otro_telefono' ? 'hola' : 'mensaje viejo');
      if(ajeno==='anterior_al_lote') {
        await f.encolar(otro);
        await pool.query("UPDATE whatsapp_entradas SET recibido_at=now()-interval '10 minutes' WHERE negocio_id=$1 AND wamid=$2",[f.negocioId,otro.id]);
      }
      const alta=agregaUnCafe(f.productoId);let encolado=false;
      const q=await f.procesar(f.texto('Agrégame otro café americano'),{modelo:async(args)=>{
        if(!encolado && ajeno==='otro_telefono'){encolado=true;await f.encolar(otro,'5287900000000');}
        return alta(args);
      }});
      // La condición de la prueba se cumplió de verdad: el mensaje ajeno sigue
      // pendiente y el turno aplicó su cambio (un error tragado no pasa).
      assert.equal(await f.pendiente(otro),'pendiente',`precondición ${ajeno}`);
      assert.equal(cantidad(await f.leer()),2,`el turno aplicó el cambio (${ajeno})`);
      assert.equal(q.interactivo?.type,'flow',`no suprime por ${ajeno}`);
    }
  });

  await caso('una respuesta del sistema conserva su formulario aunque haya mensajes en espera',async()=>{
    const f=await fixture();
    await f.encolar(f.texto('otra cosa'));
    await pool.query("UPDATE whatsapp_entradas SET recibido_at=now()+interval '1 second' WHERE negocio_id=$1 AND estado='pendiente'",[f.negocioId]);
    const q=await f.procesar(f.texto('seguir pedido'));
    assert.equal(q.interactivo?.type,'flow','«seguir pedido» sin formulario no tendría sentido');
  });

  await caso('la falla del proveedor conserva el aviso aunque salga el carrito',async()=>{
    const f=await fixture();
    await f.procesar(f.texto('seguir pedido'));
    const antes=structuredClone((await f.leer()).carrito);
    const q=await f.procesar(f.texto('EMPRESA DE PRUEBA, CALLE FICTICIA 123, COLONIA CENTRO. Esa es la dirección'),
      {modelo:async()=>{throw Object.assign(Error('proveedor saturado'),{status:529});}});
    assert.match(q.texto,/No pude completar tu último mensaje/,'el cliente debe saber que su mensaje no se aplicó');
    assert.equal(q.interactivo?.type,'flow');assert.equal(q.interactivo.body.text,q.texto);
    assert.deepEqual((await f.leer()).carrito,antes);
    assert.equal((await abrir(q)).screen,'CARRITO');
  });

  await caso('continuidad real: la dirección que llega durante el turno deja el carrito para el turno siguiente',async()=>{
    // El incidente completo por la tubería de producción: la continuidad marca
    // el lote en proceso, la dirección entra pendiente mientras el modelo
    // atiende el pedido, y cada lote sale por su propio turno.
    const f=await fixture();
    await f.procesar(f.texto('seguir pedido'));
    const pedido=f.texto('Agrégame otro café americano');
    const direccion=f.texto('Calle Ficticia 123, Colonia Centro. Esa es la dirección');
    const entrada=m=>({negocioId:f.negocioId,telefono:f.telefono,wamid:m.id,payload:{message:m}});
    const alta=agregaUnCafe(f.productoId),salidas=[];let c,encolado=false;
    const modelo=async(args)=>{
      if(!encolado){encolado=true;await c.recibir([entrada(direccion)]);return alta(args);}
      if(args.tools.some(t=>t.name==='agregar_producto') && salidas.length===0)return alta(args);
      return {content:[{type:'text',text:'Gracias.'}],stop_reason:'end_turn'};
    };
    c=crearContinuidad({pool,locks:pool,ventanaMs:0,cargarSesion:async()=>{},leerSesion:async()=>({}),
      procesar:async(payloads)=>{
        const r=await atenderConAgente({...f,mensaje:payloads.map(p=>p.message.text?.body || '').join('\n'),
          wamids:payloads.map(p=>p.message.id),llamarModelo:modelo,
          registrar:sinEfectos,emitir:sinEfectos,guardar:sinEfectos,crearPago:sinEfectos});
        assert.equal(r.ok,true,JSON.stringify(r));
        const {rows:[fila]}=await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1',[r.outbox.clave]);
        const wamid='wamid.salida.'+randomUUID();
        assert.equal((await entregarRespuesta({outboxClave:fila.evento_clave,
          enviar:async()=>({messages:[{id:wamid}]}),alHumano:sinEfectos})).estado,'entregado');
        salidas.push({...fila.carga,wamid});
        return r;
      }});
    try {
      await c.recibir([entrada(pedido)]);
      await c.ejecutar(f.negocioId,f.telefono);
      assert.equal(salidas.length,1,'primer lote: solo el pedido');
      await c.ejecutar(f.negocioId,f.telefono);
      assert.equal(salidas.length,2,'segundo lote: la dirección');
    } finally {await c.detener();}
    assert.equal(salidas[0].interactivo,undefined,'el primer turno no manda un carrito que nacería viejo');
    assert.equal(salidas[1].interactivo?.type,'flow','el turno de la dirección sí lo manda');
    assert.equal((await abrir(salidas[1])).screen,'CARRITO','y abre');
    assert.equal(cantidad(await f.leer()),2);
    const {rows}=await pool.query('SELECT estado FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=ANY($2)',[f.negocioId,[pedido.id,direccion.id]]);
    assert.deepEqual(rows.map(r=>r.estado),['completado','completado']);
  });

  await caso('frases reales de entrada abren el menú de Mapo o el formulario sin llamar al modelo',async()=>{
    const saludo=await fixture({vacio:true});
    const m=await saludo.procesar(saludo.texto('Buenos días \nHablo a mapolato obispado?'));
    assert.equal(m.interactivo?.type,'list');assert.equal(m.interactivo.action.sections[0].rows.length,4);
    assert.match(m.texto,/Mapo Bot/);
    for(const frase of ['Me gustaría ordenar un platillo','Le podría encargar un platillo de desayuno']) {
      const f=await fixture({vacio:true});
      const q=await f.procesar(f.texto(frase));
      assert.equal(q.interactivo?.type,'flow',frase);
      assert.equal(q.interactivo.action.parameters.flow_cta,'Elegir platillos',frase);
      assert.equal((await f.leer()).carrito.items.length,0,'abrir el formulario no agrega nada');
    }
    // Con un producto concreto o un propósito distinto conserva su ruta.
    const f=await fixture({vacio:true});let llamadas=0;
    await f.procesar(f.texto('Hablo a mapolato para pedir unos chilaquiles'),{modelo:async()=>{
      llamadas++;return {content:[{type:'text',text:'Con gusto, ¿cuáles chilaquiles?'}],stop_reason:'end_turn'};}});
    assert.equal(llamadas,1,'un pedido con producto no se convierte en saludo');
  });

  console.log(`Carrito y respuestas DB: ${n} pasadas, ${fallidas} fallidas. Sin red externa, mensajes, pedidos o pagos reales.`);
  if(fallidas)process.exitCode=1;
} finally {
  await pool.end();
}
