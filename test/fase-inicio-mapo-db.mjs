import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pool,actualizarConfiguracion,obtenerConfiguracion,guardarMensaje,obtenerConversacion } from '../src/services/database.js';
import { prepararNegocioMixtos } from './lib-botones-local.mjs';
import { atenderConAgente } from '../src/mesero-agente/canalDelAgente.js';
import { entregarRespuesta,despacharRespuestasPendientes } from '../src/mesero-agente/entregaDeRespuestas.js';
import { leerEstadoVersionado } from '../src/mesero-agente/persistenciaDelTurno.js';
import { validarServicio,entradaMapo } from '../src/mesero-agente/inicioMapo.js';
import { flowsActivos } from '../src/mesero-agente/formularioAgrupado.js';
import { betaHibridaActiva } from '../src/mesero-agente/experienciaHibrida.js';
import { permiteReciboServicio } from '../src/mesero-agente/solicitudesServicio.js';
import { prepararEnvioInteractivo } from '../src/mesero-agente/transporteInteractivo.js';
import { crearContinuidad } from '../src/services/whatsappContinuidad.js';
process.env.MESERO_AGENTE_MODE='true';process.env.WHATSAPP_INTERACTIVOS='true';
let casos=0;
const caso=async(nombre,fn)=>{await fn();console.log(`OK Mapo ${++casos}: ${nombre}`);};
const factura={nombre:'Cliente de prueba',rfc:'AAA010101AAA',codigo_postal:'26000',regimen:'612',uso_cfdi:'G03',
  correo:'prueba@example.invalid',referencia:'Ticket de prueba 123'};
const evento={nombre:'Cliente local',tipo_evento:'Cumpleaños',fecha:'2026-10-15',hora:'14:30',personas:'50',
  ubicacion:'Lugar de prueba',detalles:'Servicio de taquiza'};
async function fixture() {
  const f=await prepararNegocioMixtos();f.estado.carrito.items=[];
  await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',
    [f.negocioId,`agente:${f.telefono}`,JSON.stringify(f.estado)]);
  const cfg={whatsapp_inicio_mapo_v1:'true',whatsapp_atencion_general_v1:'true',bot_whatsapp_solo_prueba:'false',
    mesero_agente_porcentaje:'100',mesero_agente_telefonos:'',whatsapp_flows_v1:'true',whatsapp_flows_telefonos:'',
    whatsapp_beta_hibrido_v1:'true',whatsapp_beta_telefonos:'',whatsapp_flow_facturacion_id:'44444444444',
    whatsapp_flow_evento_id:'55555555555',whatsapp_flow_productos_id:'11111111111',whatsapp_flow_configurar_id:'22222222222'};
  await actualizarConfiguracion(cfg,f.negocioId);
  const identidad=()=>({id:`wamid.mapo.${randomUUID()}`,from:f.telefono,timestamp:String(Math.floor(Date.now()/1000))});
  const texto=body=>({...identidad(),type:'text',text:{body}});
  const boton=(q,title)=>({...identidad(),type:'interactive',context:{id:q.wamid},interactive:{type:'list_reply',list_reply:{
    id:q.interactivo.action.sections[0].rows.find(r=>r.title===title).id,title:'No es autoridad'}}});
  const respuesta=(q,campos)=>({...identidad(),type:'interactive',context:{id:q.wamid},interactive:{type:'nfm_reply',nfm_reply:{
    response_json:JSON.stringify({flow_token:q.interactivo.action.parameters.flow_token,...campos})}}});
  let avisos=0;
  const humano=async()=>{avisos++;await pool.query(`UPDATE whatsapp_conversaciones SET requiere_revision=true,motivo=$3
    WHERE negocio_id=$1 AND telefono=$2`,[f.negocioId,f.telefono,'FACTURACION_REVISION_HUMANA']);return true;};
  const procesar=async(m,{enviar=true,handoff=true}={})=>{
    await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado') ON CONFLICT DO NOTHING",
      [f.negocioId,f.telefono,m.id,JSON.stringify({message:m})]);
    await guardarMensaje(f.telefono,'Prueba','entrante',m.text?.body || 'Formulario recibido',f.negocioId,'cliente',m.id);
    const r=await atenderConAgente({...f,mensaje:m.text?.body || '',wamids:[m.id],
      interaccion:m.type==='interactive'?{mensajes:[m],mixto:false}:null,
      escalarAHumano:handoff?async(n,t,motivo)=>{avisos++;await pool.query(`UPDATE whatsapp_conversaciones SET requiere_revision=true,motivo=$3
        WHERE negocio_id=$1 AND telefono=$2`,[n,t,motivo]);return true;}:null,
      llamarModelo:async()=>{throw Error('NO_MODELO');}});
    assert(r.ok,JSON.stringify(r));
    if(!r.outbox)return {r};
    const fila=(await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1',[r.outbox.clave])).rows[0];
    const wamid=`wamid.mapo.out.${randomUUID()}`;
    if(enviar && !r.yaEntregado)assert.equal((await entregarRespuesta({outboxClave:fila.evento_clave,
      enviar:async()=>({messages:[{id:wamid}]}),alHumano:humano})).estado,'entregado');
    return {r,fila,...fila.carga,wamid};
  };
  return {...f,cfg,texto,boton,respuesta,procesar,leer:()=>leerEstadoVersionado(f.negocioId,f.telefono),avisos:()=>avisos};
}
try {
  execFileSync(process.execPath,['scripts/predeploy-108-agente-servicios-mapo.mjs'],{stdio:'pipe'});
  await caso('quiero ordenar sale del evento, recupera el carrito y no duplica el turno',async()=>{
    for (const [conCarrito,eventoAgente] of [[false,false],[true,false],[false,true],[true,true]]) {
      const f=await fixture();
      const estado=await f.leer();
      if(conCarrito)estado.carrito.items=[{lid:'guardado',id:f.productoId,nombre:'Café americano',cantidad:2,modificadores:[],notas:''}];
      estado.carrito.datos.cliente.direccion='Calle Prueba 208A, Colonia Centro';
      estado.evento=eventoAgente?{nombre:'Cliente local'}:null;
      estado.pendiente={tipo:'formulario_servicio',servicio:'facturacion'};
      await pool.query('UPDATE conversacion_estado SET estado=$3,revision=revision+1 WHERE negocio_id=$1 AND session_id=$2',
        [f.negocioId,`agente:${f.telefono}`,JSON.stringify(estado)]);
      const m=f.texto('quiero ordenar'),q=await f.procesar(m);
      assert.equal(q.r.llamadasAlModelo,0);
      const despues=await f.leer();
      assert.equal(despues.evento,null);
      assert.equal(despues.folio,null);
      assert.deepEqual(despues.carrito,estado.carrito);
      assert.equal(despues.pendiente.tipo,conCarrito?'editar_pedido':'agregar_otro');
      if(!conCarrito)assert.equal(q.interactivo.action.parameters.flow_id,'11111111111');
      assert.doesNotMatch(q.texto,/personas|evento/i);
      await f.procesar(m);
      assert.deepEqual((await f.leer()).carrito,estado.carrito);
      assert.equal((await pool.query('SELECT count(*)::int n FROM agente_outbox WHERE negocio_id=$1',[f.negocioId])).rows[0].n,1);
    }
  });
  await caso('navegación aislada sale tras 500 ms, sin esperar seis segundos ni duplicarse',async()=>{
    for(const titulo of ['Ordenar','Facturación','Servicio para eventos']) {
      const f=await fixture(),q=await f.procesar(f.texto('hola')),m=f.boton(q,titulo);
      let llamadas=0;
      const c=crearContinuidad({pool,locks:pool,cargarSesion:async()=>{},leerSesion:async()=>({}),
        procesar:async(payloads)=>{llamadas++;return f.procesar(payloads[0].message);}});
      try {
        await c.recibir([{negocioId:f.negocioId,telefono:f.telefono,wamid:m.id,payload:{message:m}}]);
        await pool.query("UPDATE whatsapp_entradas SET recibido_at=now()+interval '1 second' WHERE negocio_id=$1 AND wamid=$2",[f.negocioId,m.id]);
        await c.ejecutar(f.negocioId,f.telefono);assert.equal(llamadas,0);
        await pool.query("UPDATE whatsapp_entradas SET recibido_at=now()-interval '1 second' WHERE negocio_id=$1 AND wamid=$2",[f.negocioId,m.id]);
        await Promise.all([c.ejecutar(f.negocioId,f.telefono),c.ejecutar(f.negocioId,f.telefono)]);
        assert.equal(llamadas,1);
        await c.ejecutar(f.negocioId,f.telefono);assert.equal(llamadas,1);
        assert.equal((await f.leer()).folio,null);
      } finally {await c.detener();}
    }
  });
  await caso('la ruta rápida no adelanta texto, lotes mixtos, captura ni atención humana',async()=>{
    for(const tipo of ['texto','mixto','humano','flow','confirmar','contexto','token','ciclo','pausa']) {
      const f=await fixture(),q=await f.procesar(f.texto('hola'));
      let mensajes=[f.boton(q,tipo==='humano'?'Otra duda':'Facturación')];
      if(tipo==='texto')mensajes=[f.texto('Confirmo')];
      if(tipo==='mixto')mensajes.push(f.texto('No, mejor ordenar'));
      if(tipo==='flow') {
        const form=await f.procesar(mensajes[0]);mensajes=[f.respuesta(form,factura)];
      }
      if(tipo==='confirmar')await pool.query("UPDATE agente_botones SET accion='confirmar' WHERE token=$1",[mensajes[0].interactive.list_reply.id]);
      if(tipo==='contexto')mensajes[0].context.id='wamid.ajeno';
      if(tipo==='token')mensajes[0].interactive.list_reply.id='xb1:AAAAAAAAAAAAAAAAAAAAAA';
      if(tipo==='ciclo')await pool.query("UPDATE agente_preguntas_interactivas SET ciclo='anterior' WHERE negocio_id=$1",[f.negocioId]);
      if(tipo==='pausa')await pool.query('UPDATE whatsapp_conversaciones SET requiere_revision=true WHERE negocio_id=$1',[f.negocioId]);
      let llamadas=0;
      const c=crearContinuidad({pool,locks:pool,cargarSesion:async()=>{},leerSesion:async()=>({}),procesar:async()=>{llamadas++;}});
      try {
        await c.recibir(mensajes.map(m=>({negocioId:f.negocioId,telefono:f.telefono,wamid:m.id,payload:{message:m}})));
        await pool.query("UPDATE whatsapp_entradas SET recibido_at=now()-interval '1 second' WHERE negocio_id=$1 AND estado='pendiente'",[f.negocioId]);
        await c.ejecutar(f.negocioId,f.telefono);assert.equal(llamadas,0,tipo);
      } finally {await c.detener();}
    }
  });
  await caso('general explícito, piloto conservado y cuatro rutas',async()=>{
    assert(!flowsActivos({whatsapp_flows_v1:'true',bot_whatsapp_solo_prueba:'false'},'528700000000'));
    const f=await fixture();assert(flowsActivos(f.cfg,f.telefono));assert(betaHibridaActiva(f.cfg,f.telefono));
    const q=await f.procesar(f.texto('Hola'));assert.equal(q.interactivo.type,'list');
    assert.deepEqual(q.interactivo.action.sections[0].rows.map(o=>o.title),['Ordenar','Facturación','Servicio para eventos','Otra duda']);
    assert.match(q.texto,/Mapo Bot/);assert.equal(q.r.llamadasAlModelo,0);
    const pedido=await f.procesar(f.boton(q,'Ordenar'));assert.equal(pedido.interactivo.type,'flow');
    assert.equal(pedido.interactivo.action.parameters.flow_id,'11111111111');
    assert.equal((await f.leer()).carrito.items.length,0);
  });
  await caso('volver al menú permite cambiar de servicio y reutilizar una opción sin crear solicitudes',async()=>{
    const f=await fixture(),q=await f.procesar(f.texto('hola'));
    assert.deepEqual(q.interactivo.action.sections[0].rows.map(o=>o.description),
      ['Elegir mis platillos','Enviar mis datos para facturar','Solicitar una cotización','Hablar con una persona']);
    const carrito=(await f.leer()).carrito;
    for(const [titulo,flowId] of [['Facturación','44444444444'],['Servicio para eventos','55555555555'],
      ['Facturación','44444444444'],['Ordenar','11111111111'],['Facturación','44444444444']]) {
      const r=await f.procesar(f.boton(q,titulo));
      assert.equal(r.interactivo?.action.parameters.flow_id,flowId);
      assert.equal(r.r.llamadasAlModelo,0);
      assert.deepEqual((await f.leer()).carrito,carrito);
    }
    assert.equal((await pool.query('SELECT count(*)::int n FROM agente_solicitudes_servicio WHERE negocio_id=$1',[f.negocioId])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos_activos WHERE negocio_id=$1',[f.negocioId])).rows[0].n,0);
  });
  await caso('un menú vencido no se reactiva por ser navegación',async()=>{
    const f=await fixture(),q=await f.procesar(f.texto('hola'));
    await pool.query("UPDATE agente_preguntas_interactivas SET created_at=now()-interval '31 minutes' WHERE negocio_id=$1",[f.negocioId]);
    const r=await f.procesar(f.boton(q,'Facturación'));
    assert.equal(r.interactivo?.type,'list');
    assert.equal((await f.leer()).pendiente.tipo,'inicio_mapo');
  });
  await caso('con whatsapp_flujos_caducan_v1, un evento y una factura de hace 40 min ya no gobiernan',async()=>{
    // 3-oct: «eshola» al día siguiente recibió «¿Para cuántas personas…?».
    const f=await fixture();
    const viejo=async()=>{
      const e=await f.leer();e.evento={nombre:'Cliente local'};e.pendiente={tipo:'formulario_servicio',servicio:'facturacion'};
      await pool.query(`UPDATE conversacion_estado SET estado=$3,revision=revision+1,actualizado_at=now()-interval '40 minutes'
        WHERE negocio_id=$1 AND session_id=$2`,[f.negocioId,`agente:${f.telefono}`,JSON.stringify(e)]);
    };
    await actualizarConfiguracion({whatsapp_flujos_caducan_v1:'true'},f.negocioId);
    await viejo();
    const q=await f.procesar(f.texto('hola'));
    assert.equal(q.interactivo?.type,'list','el saludo no volvió al menú de inicio');
    assert.equal((await f.leer()).evento ?? null,null);
    // Un toque también se atiende: la ficha vencida ya no lo silencia.
    await viejo();
    const t=await f.procesar(f.boton(q,'Ordenar'));
    assert.ok(t.texto || t.interactivo,'el toque se quedó sin respuesta');
    assert.equal((await f.leer()).evento ?? null,null);
    // Sin la bandera, la ficha de evento sigue mandando como hoy.
    await actualizarConfiguracion({whatsapp_flujos_caducan_v1:'false'},f.negocioId);
    await viejo();
    await f.procesar(f.texto('hola'),{enviar:false});
    assert.ok((await f.leer()).evento,'sin la bandera la ficha vieja ya no manda');
  });
  await caso('un menú vencido no pinta el menú encima de un carrito con platillos',async()=>{
    // Toque vencido de la lista Mapo con la factura pendiente: sin carrito
    // vuelve el menú; con carrito, aviso y su pedido actual (inicioMapo.js:21).
    const f=await fixture(),q=await f.procesar(f.texto('hola'));
    await f.procesar(f.boton(q,'Facturación'));
    const estado=await f.leer();
    estado.carrito.items=[{lid:'cafe-guardado',id:f.productoId,nombre:'Café americano',cantidad:1,modificadores:[],notas:''}];
    Object.assign(estado.carrito.datos,{modalidad:'recoger en tienda',forma_pago:'efectivo'});
    await pool.query('UPDATE conversacion_estado SET estado=$3,revision=revision+1 WHERE negocio_id=$1 AND session_id=$2',
      [f.negocioId,`agente:${f.telefono}`,JSON.stringify(estado)]);
    await pool.query("UPDATE agente_preguntas_interactivas SET created_at=now()-interval '31 minutes' WHERE negocio_id=$1",[f.negocioId]);
    const r=await f.procesar(f.boton(q,'Ordenar'));
    assert.notEqual(r.interactivo?.type,'list','el menú Mapo tapó el carrito');
    assert.match(r.texto,/no está vigente/);
    assert.notEqual((await f.leer()).pendiente?.tipo,'inicio_mapo');
    assert.deepEqual((await f.leer()).carrito.items.map(i=>i.nombre),['Café americano']);
  });
  await caso('cambiar de servicio conserva el borrador y sus datos; el formulario anterior no aplica',async()=>{
    const f=await fixture(),q=await f.procesar(f.texto('hola'));
    const estado=await f.leer();
    estado.carrito.items=[{lid:'cafe-guardado',id:f.productoId,nombre:'Café americano',cantidad:2,modificadores:[],notas:''}];
    estado.carrito.datos.cliente.direccion='Calle Prueba 208A, Colonia Centro';
    await pool.query('UPDATE conversacion_estado SET estado=$3,revision=revision+1 WHERE negocio_id=$1 AND session_id=$2',
      [f.negocioId,`agente:${f.telefono}`,JSON.stringify(estado)]);
    const facturaAnterior=await f.procesar(f.boton(q,'Facturación'));
    const eventoActual=await f.procesar(f.boton(q,'Servicio para eventos'));
    assert.equal(eventoActual.interactivo.action.parameters.flow_id,'55555555555');
    const rechazado=await f.procesar(f.respuesta(facturaAnterior,factura));
    assert.equal(rechazado.interactivo.action.parameters.flow_id,'55555555555');
    assert.deepEqual((await f.leer()).carrito,estado.carrito);
    assert.equal((await pool.query('SELECT count(*)::int n FROM agente_solicitudes_servicio WHERE negocio_id=$1',[f.negocioId])).rows[0].n,0);
  });
  await caso('incidente real: saludo expresivo y solicitud natural producen menú y formulario sin modelo',async()=>{
    const f=await fixture();
    const q=await f.procesar(f.texto('Buenos díasss'));
    assert.equal(q.interactivo.type,'list');assert.match(q.texto,/Soy \*Mapo Bot\*/);
    assert.equal(q.interactivo.action.sections[0].rows.length,4);
    assert.equal((q.texto.match(/buenos días|buenas tardes|buenas noches/g) || []).length,1);
    const m=f.texto('Me gustaría realizar una orden'),form=await f.procesar(m);
    assert.equal(form.interactivo.type,'flow');assert.equal(form.r.llamadasAlModelo,0);
    assert.equal(form.interactivo.action.parameters.flow_id,'11111111111');
    const antes=await f.leer();assert.equal(antes.carrito.items.length,0);assert.equal(antes.folio,null);
    await f.procesar(m);
    assert.deepEqual((await f.leer()).carrito,antes.carrito);
    assert.equal((await pool.query("SELECT count(*)::int n FROM agente_outbox WHERE negocio_id=$1 AND carga->'interactivo'->>'type'='flow'",[f.negocioId])).rows[0].n,1);
    const recuperado=await f.procesar(f.texto('Ya sé que ordenar'));
    assert.equal(recuperado.interactivo.type,'flow');assert.equal(recuperado.r.llamadasAlModelo,0);
  });
  await caso('saludo y pedido juntos abren categorías publicadas, sin menú intermedio ni venta',async()=>{
    const keys=['WHATSAPP_FLOW_ENDPOINT','WHATSAPP_FLOW_PRIVATE_KEY','META_APP_SECRET'];
    const previo=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
    try {
      Object.assign(process.env,{WHATSAPP_FLOW_ENDPOINT:'true',WHATSAPP_FLOW_PRIVATE_KEY:'solo-local',META_APP_SECRET:'solo-local'});
      const f=await fixture();await actualizarConfiguracion({whatsapp_flow_categorias_id:'66666666666'},f.negocioId);
      const q=await f.procesar(f.texto('Hola, buenos díasss. Me gustaría realizar una orden'));
      assert.equal(q.interactivo.type,'flow');assert.equal(q.interactivo.action.parameters.flow_id,'66666666666');
      assert.equal(q.interactivo.action.parameters.flow_action,'data_exchange');
      assert.equal(q.r.llamadasAlModelo,0);assert.equal((await f.leer()).carrito.items.length,0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos_activos WHERE negocio_id=$1',[f.negocioId])).rows[0].n,0);
    } finally {for(const k of keys)previo[k]===undefined?delete process.env[k]:process.env[k]=previo[k];}
  });
  await caso('saludo natural fuera de horario muestra servicios; ordenar no evade cierre',async()=>{
    const f=await fixture(),cfg=await obtenerConfiguracion(f.negocioId),reglas=JSON.parse(cfg.reglas_atencion);
    for(const horario of Object.values(reglas.horarios))horario.abierto=false;
    await actualizarConfiguracion({reglas_atencion:JSON.stringify(reglas)},f.negocioId);
    const q=await f.procesar(f.texto('Buenos díasss'));assert.equal(q.interactivo.type,'list');
    const r=await f.procesar(f.texto('Me gustaría realizar una orden'));
    assert.equal(r.r.fueraHorario,true);assert(!r.interactivo);assert.equal((await f.leer()).carrito.items.length,0);
  });
  await caso('factura: captura, pausa, historial y duplicado sin emisión',async()=>{
    const f=await fixture();let q=await f.procesar(f.texto('Buenos días'));
    q=await f.procesar(f.boton(q,'Facturación'));assert.equal(q.interactivo.action.parameters.flow_id,'44444444444');
    const m=f.respuesta(q,factura),recibo=await f.procesar(m);
    assert.match(recibo.texto,/aún no se ha emitido/);assert.equal(f.avisos(),1);
    assert.equal((await f.leer()).hechos.escalado,true);assert.equal((await f.leer()).folio,null);
    const s=(await pool.query('SELECT * FROM agente_solicitudes_servicio WHERE negocio_id=$1',[f.negocioId])).rows;
    assert.equal(s.length,1);assert.deepEqual(s[0].datos,factura);
    await f.procesar(m);await f.procesar(f.respuesta(q,factura));
    assert.equal((await pool.query('SELECT count(*)::int n FROM agente_solicitudes_servicio WHERE negocio_id=$1',[f.negocioId])).rows[0].n,1);
    const historia=await obtenerConversacion(f.telefono,f.negocioId);
    const entrada=historia.find(x=>x.message_id_externo===m.id);assert.match(entrada.interaccion.resumen,/AAA010101AAA/);
    assert(!JSON.stringify(historia).includes(q.interactivo.action.parameters.flow_token));
    await pool.query('UPDATE negocios SET bot_whatsapp_activo=false WHERE id=$1',[f.negocioId]);
    assert.equal(await permiteReciboServicio({db:pool,fila:recibo.fila}),false);
  });
  await caso('eventos se guardan para cotizar; ninguna reserva/pedido',async()=>{
    const f=await fixture();let q=await f.procesar(f.texto('Hola, buenos días'));
    q=await f.procesar(f.boton(q,'Servicio para eventos'));
    const r=await f.procesar(f.respuesta(q,evento));assert.match(r.texto,/Aún no hay una reserva/);
    const s=(await pool.query('SELECT datos FROM agente_solicitudes_servicio WHERE negocio_id=$1',[f.negocioId])).rows[0];
    assert.equal(s.datos.personas,50);assert.equal((await f.leer()).carrito.items.length,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos_activos WHERE negocio_id=$1',[f.negocioId])).rows[0].n,0);
  });
  await caso('otra duda pasa a persona y no abre formulario',async()=>{
    const f=await fixture();const q=await f.procesar(f.texto('hola'));
    const r=await f.procesar(f.boton(q,'Otra duda'));assert(!r.interactivo);assert.match(r.texto,/persona de Mapolato/);
    assert.equal(f.avisos(),1);assert.equal((await f.leer()).hechos.escalado,true);
  });
  await caso('validación cerrada y saludo no interrumpe un carrito',async()=>{
    assert.equal(validarServicio('flow_facturacion',{...factura,total:1}),null);
    assert.equal(validarServicio('flow_facturacion',{...factura,rfc:'invalido'}),null);
    assert.equal(validarServicio('flow_evento',{...evento,personas:'2.5'}),null);
    assert.equal(validarServicio('flow_evento',{...evento,fecha:'2026-02-30'}),null);
    assert(validarServicio('flow_evento',{...evento,detalles:'Taquiza\nCon opciones vegetarianas'}));
    const f=await fixture();f.estado.carrito.items=[{lid:'x'}];
    assert.equal(entradaMapo({cfg:f.cfg,estado:f.estado,mensaje:'hola'}),null);
    let q=await f.procesar(f.texto('hola'));q=await f.procesar(f.boton(q,'Facturación'));
    const r=await f.procesar(f.respuesta(q,{...factura,rfc:'x'}));
    assert.match(r.texto,/No pude guardar/);assert.equal(r.interactivo.type,'flow');
    assert.equal((await pool.query('SELECT count(*)::int n FROM agente_solicitudes_servicio WHERE negocio_id=$1',[f.negocioId])).rows[0].n,0);
  });
  await caso('pausa humana gana a un menú anterior',async()=>{
    const f=await fixture();const q=await f.procesar(f.texto('hola'));
    await pool.query('UPDATE whatsapp_conversaciones SET requiere_revision=true WHERE negocio_id=$1 AND telefono=$2',[f.negocioId,f.telefono]);
    assert.equal((await f.procesar(f.boton(q,'Ordenar'))).r.sinRespuesta,true);
  });
  await caso('caída tras guardar: solicitud y pausa durables; aviso se reintenta',async()=>{
    const f=await fixture();let q=await f.procesar(f.texto('hola'));q=await f.procesar(f.boton(q,'Facturación'));
    const r=await f.procesar(f.respuesta(q,factura),{handoff:false,enviar:false});
    assert(r.fila.humano_motivo);await pool.query("UPDATE agente_outbox SET disponible_at=now() WHERE evento_clave=$1",[r.fila.evento_clave]);
    let avisos=0;const envio=await despacharRespuestasPendientes({db:pool,enviar:async()=>({messages:[{id:'wamid.local.retry'}]}),
      alHumano:async({negocioId,telefono,motivo})=>{avisos++;await pool.query('UPDATE whatsapp_conversaciones SET requiere_revision=true,motivo=$3 WHERE negocio_id=$1 AND telefono=$2',[negocioId,telefono,motivo]);return true;}});
    assert(avisos>0);assert(envio.entregadas>0);
  });
  await caso('acuse fijo acotado: tenant, teléfono, texto, ventana y atención humana',async()=>{
    const f=await fixture();let q=await f.procesar(f.texto('hola'));q=await f.procesar(f.boton(q,'Facturación'));
    const r=await f.procesar(f.respuesta(q,factura),{handoff:false,enviar:false});
    const permite=fila=>permiteReciboServicio({db:pool,fila});assert(await permite(r.fila));
    assert(!await permite({...r.fila,negocio_id:randomUUID()}));
    assert(!await permite({...r.fila,carga:{...r.fila.carga,telefono:'528700000000'}}));
    assert(!await permite({...r.fila,carga:{...r.fila.carga,texto:'Otra respuesta'}}));
    await pool.query("UPDATE whatsapp_entradas SET recibido_at=now()-interval '25 hours' WHERE negocio_id=$1",[f.negocioId]);
    assert(!await permite(r.fila));
    await pool.query('UPDATE whatsapp_entradas SET recibido_at=now() WHERE negocio_id=$1',[f.negocioId]);
    assert(await permite(r.fila));
    await guardarMensaje(f.telefono,'Personal','saliente','Ya te atiendo',f.negocioId,'humano');
    assert(!await permite(r.fila));
    await pool.query("UPDATE agente_solicitudes_servicio SET created_at=now()-interval '3 minutes' WHERE negocio_id=$1",[f.negocioId]);
    assert(!await permite(r.fila));
  });
  await caso('interruptor de inicio gana a menú pendiente; migraciones repetibles con tokens nuevos',async()=>{
    const f=await fixture();const q=await f.procesar(f.texto('hola'),{enviar:false});
    await actualizarConfiguracion({whatsapp_inicio_mapo_v1:'false'},f.negocioId);
    assert.equal((await prepararEnvioInteractivo({db:pool,negocioId:f.negocioId,telefono:f.telefono,
      interactivo:q.interactivo,texto:q.texto})).permitido,false);
    for(const script of ['104-agente-elecciones','105-agente-edicion-interactiva','106-agente-flows','107-agente-flow-repetible','108-agente-servicios-mapo'])
      execFileSync(process.execPath,[`scripts/predeploy-${script}.mjs`],{stdio:'pipe'});
  });
  console.log(`Mapo DB ${casos}/${casos}`);
} finally {await pool.end();}
