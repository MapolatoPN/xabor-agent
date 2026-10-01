// La dirección de entrega, capturada sin el modelo (src/mesero-agente/direccionPorTexto.js).
// Incidente 1-oct-2026: el turno de la dirección falló en el proveedor y la
// dirección se perdió. Con la IA apagada, nadie la interpretaría. Aquí el
// pedido llega a «¿Cuál es la dirección completa para la entrega?» por el
// camino real y la dirección escrita se guarda SIN llamar al modelo.
// Base local test_botones_*, red solo local, modelo simulado. Sin mensajes ni pedidos reales.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool,actualizarConfiguracion } from '../src/services/database.js';
import { prepararNegocioBotones } from './lib-botones-local.mjs';
import { atenderConAgente } from '../src/mesero-agente/canalDelAgente.js';
import { leerEstadoVersionado } from '../src/mesero-agente/persistenciaDelTurno.js';
import { entregarRespuesta } from '../src/mesero-agente/entregaDeRespuestas.js';
Object.assign(process.env,{MESERO_AGENTE_MODE:'true',WHATSAPP_INTERACTIVOS:'true',WHATSAPP_FLOW_ENDPOINT:'true',
  WHATSAPP_FLOW_PRIVATE_KEY:'solo-local',META_APP_SECRET:'solo-local'});
const sinEfectos=async()=>{throw Error('NO_PEDIDOS_PAGOS_TICKETS');};
const PREGUNTA='¿Cuál es la dirección completa para la entrega?';
let n=0,fallidas=0;
async function caso(nombre,fn){
  try {await fn();console.log(`OK direccion-texto ${++n}: ${nombre}`);}
  catch(e) {
    fallidas++;
    const detalle=e?.code==='ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0,160)} · esperado=${JSON.stringify(e.expected)?.slice(0,80)}` : '';
    console.log(`FALLA direccion-texto: ${nombre}\n  ${String(e?.message || e).split('\n')[0]}${detalle}`);
  }
}

// Configuración de Mapolato Obispado en producción (atención general, Flows,
// beta híbrida) con sus zonas de envío. Un café en el carrito, pago en
// efectivo; el cliente pide domicilio y el pedido pregunta la dirección.
async function fixture({config={}}={}) {
  const f=await prepararNegocioBotones();
  const reglas={restaurante:'Prueba aislada',timezone:'America/Matamoros',
    horarios:Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo']
      .map(d=>[d,{abierto:true,apertura:'00:00',cierre:'24:00'}])),
    pedidos:{modalidades:['recoger en tienda','entrega a domicilio'],tiempo_preparacion_minutos:20,
      pedido_minimo_entrega:0,costo_envio:60,pago_aceptado:['efectivo'],zonas_entrega:[
        {nombre:'UTNC',costo:150},{nombre:'Cervecera',costo:150},{nombre:'Coca Cola',costo:120},
        {nombre:'Cartonera',costo:120},{nombre:'COMISION FEDERAL / CARBON 2',costo:200}]},
    cierres_especiales:[],promociones:[],politicas:[]};
  await actualizarConfiguracion({nombre:'Mapolato Obispado',reglas_atencion:JSON.stringify(reglas),
    whatsapp_inicio_mapo_v1:'true',whatsapp_atencion_general_v1:'true',bot_whatsapp_solo_prueba:'false',
    mesero_agente_porcentaje:'100',mesero_agente_telefonos:'',whatsapp_flows_v1:'true',whatsapp_flows_telefonos:'',
    whatsapp_beta_hibrido_v1:'true',whatsapp_beta_telefonos:'',whatsapp_carrito_unificado_v1:'true',
    whatsapp_interactivos_elecciones_v1:'true',whatsapp_flow_categorias_id:'11111111111',
    whatsapp_flow_carrito_id:'22222222222',whatsapp_flow_configurar_id:'44444444444',
    whatsapp_direccion_texto_v1:'true',...config},f.negocioId);
  const leer=()=>leerEstadoVersionado(f.negocioId,f.telefono);
  const texto=body=>({id:'wamid.direccion.'+randomUUID(),from:f.telefono,
    timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body}});
  const entrada=(m,estado)=>pool.query(`INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT (negocio_id,wamid) DO UPDATE SET estado=EXCLUDED.estado`,
  [f.negocioId,f.telefono,m.id,JSON.stringify({message:m}),estado]);
  // Sin modelo indicado, el turno NO debe llamarlo: se cuenta y se exige cero
  // (un error del simulado pasaría por falla del proveedor y ocultaría el caso).
  let llamadas=0;
  const procesar=async(m,{modelo=null}={})=>{
    let inesperadas=0;
    const llamar=modelo ? async(...a)=>{llamadas++;return modelo(...a);}
      : async()=>{inesperadas++;throw Error('NO_DEBE_LLAMAR_MODELO');};
    await entrada(m,'completado');
    const r=await atenderConAgente({...f,mensaje:m.text.body,wamids:[m.id],llamarModelo:llamar,
      registrar:sinEfectos,emitir:sinEfectos,guardar:sinEfectos,crearPago:sinEfectos});
    assert.equal(inesperadas,0,`el turno llamó al modelo sin esperarlo: ${m.text.body}`);
    assert.equal(r.ok,true,JSON.stringify(r));
    const {rows:[fila]}=await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1',[r.outbox.clave]);
    if(!r.yaEntregado)assert.equal((await entregarRespuesta({outboxClave:fila.evento_clave,
      enviar:async()=>({messages:[{id:'wamid.salida.'+randomUUID()}]}),alHumano:sinEfectos})).estado,'entregado');
    return {...fila.carga,r};
  };
  // El cliente pide domicilio: el modelo fija la modalidad y el pedido
  // pregunta la dirección con su texto fijo (continuidadDeterminista).
  const pedirDomicilio=async()=>{
    let vuelta=0;
    const q=await procesar(texto('Lo quiero a domicilio'),{modelo:async()=>vuelta++===0
      ? {content:[{type:'tool_use',id:'entrega-'+randomUUID(),name:'definir_entrega',
        input:{modalidad:'entrega a domicilio'}}],stop_reason:'tool_use'}
      : {content:[{type:'text',text:'Listo.'}],stop_reason:'end_turn'}});
    const e=await leer();
    assert.equal(e.pendiente?.tipo,'direccion','la pregunta de dirección quedó abierta');
    assert.match(q.texto,new RegExp(PREGUNTA.replace(/[?¿]/g,'.')));
    llamadas=0;
    return q;
  };
  return {...f,leer,texto,entrada,procesar,pedirDomicilio,modeloLlamado:()=>llamadas};
}

try {
  await caso('la dirección escrita se guarda sin el modelo y sale el resumen con sus botones',async()=>{
    const f=await fixture();
    await f.pedirDomicilio();
    const q=await f.procesar(f.texto('Calle Ficticia 123\nColonia Centro'));
    const e=await f.leer();
    assert.equal(e.carrito.datos.cliente?.direccion,'Calle Ficticia 123, Colonia Centro');
    assert.equal(Number(e.carrito.datos.costo_envio),60);
    assert.equal(e.pendiente?.tipo,'confirmar_resumen');
    assert.match(q.texto,/Revisa tu pedido/);
    assert.match(q.texto,/Dirección: Calle Ficticia 123, Colonia Centro\n/);
    assert.match(q.texto,/Envío: \$60/);
    assert.equal(q.interactivo?.type,'button','el resumen lleva sus botones de confirmar');
    assert.equal(e.folio,null,'guardar la dirección no confirma el pedido');
  });

  await caso('dirección en una zona: cobra la tarifa de la zona',async()=>{
    const f=await fixture();
    await f.pedirDomicilio();
    const q=await f.procesar(f.texto('UTNC edificio 3, cubículo 12'));
    const e=await f.leer();
    assert.equal(e.carrito.datos.cliente?.direccion,'UTNC edificio 3, cubículo 12');
    assert.equal(Number(e.carrito.datos.costo_envio),150);
    assert.match(q.texto,/Envío: \$150/);
  });

  // Una zona junto a una calle, o dos zonas, deciden la tarifa: lo lee el modelo
  // (revisión del 1-oct: «frente a la Comisión Federal» cobraba $200).
  await caso('una zona como referencia o dos zonas: lo lee el modelo, sin cobrar la tarifa de la zona',async()=>{
    for(const texto of ['Calle Ficticia 12 entre UTNC y Cartonera','Calle Ficticia 300, frente a la Cervecera']) {
      const f=await fixture();
      await f.pedirDomicilio();
      await f.procesar(f.texto(texto),{modelo:async()=>({content:[{type:'text',text:'Gracias.'}],stop_reason:'end_turn'})});
      const e=await f.leer();
      assert.equal(f.modeloLlamado(),1,texto);
      assert.equal(e.carrito.datos.cliente?.direccion,undefined,texto);
      assert.notEqual(Number(e.carrito.datos.costo_envio),150,texto);
    }
  });

  await caso('lo que no es una dirección sigue su camino de siempre (el modelo)',async()=>{
    const f=await fixture();
    await f.pedirDomicilio();
    await f.procesar(f.texto('Ahorita te la paso'),{modelo:async()=>({content:[{type:'text',
      text:'Claro, aquí espero tu dirección.'}],stop_reason:'end_turn'})});
    const e=await f.leer();
    assert.equal(f.modeloLlamado(),1,'el texto que no es dirección pasa al modelo');
    assert.equal(e.carrito.datos.cliente?.direccion,undefined);
    assert.equal(e.pendiente?.tipo,'direccion');
  });

  // Revisión adversarial del 1-oct: un platillo pedido junto con la dirección
  // se guardaba como parte de la dirección y nunca se agregaba.
  await caso('dirección con un platillo pedido en el mismo lote: lo atiende el modelo completo',async()=>{
    const f=await fixture();
    await f.pedirDomicilio();
    await f.procesar(f.texto('Calle Ficticia 123 col Centro\ny un café americano'),{modelo:async()=>({content:[
      {type:'text',text:'Claro.'}],stop_reason:'end_turn'})});
    const e=await f.leer();
    assert.equal(f.modeloLlamado(),1,'el lote completo va al modelo, que puede agregar el café');
    assert.equal(e.carrito.datos.cliente?.direccion,undefined,'el pedido no se guarda como parte de la dirección');
  });

  await caso('la zona «Coca Cola» también es refresco: el mensaje que la nombra lo atiende el modelo',async()=>{
    const f=await fixture();
    await f.pedirDomicilio();
    await f.procesar(f.texto('Coca cola de 600 bien fría'),{modelo:async()=>({content:[{type:'text',
      text:'Claro.'}],stop_reason:'end_turn'})});
    const e=await f.leer();
    assert.equal(f.modeloLlamado(),1);
    assert.equal(e.carrito.datos.cliente?.direccion,undefined);
    assert.equal(Number(e.carrito.datos.costo_envio ?? 60),60,'sin la tarifa de la zona Coca Cola');
  });

  await caso('sin la beta híbrida, la dirección sigue siendo del modelo',async()=>{
    const f=await fixture({config:{whatsapp_beta_hibrido_v1:'false'}});
    await f.pedirDomicilio();
    await f.procesar(f.texto('Calle Ficticia 123, Colonia Centro'),{modelo:async()=>({content:[{type:'text',
      text:'Gracias.'}],stop_reason:'end_turn'})});
    assert.equal(f.modeloLlamado(),1);
    assert.equal((await f.leer()).carrito.datos.cliente?.direccion,undefined);
  });

  // Apagada por omisión (decisión de Mario, 1-oct): sin la clave, como en producción.
  await caso('sin whatsapp_direccion_texto_v1=true, la dirección sigue siendo del modelo',async()=>{
    const f=await fixture({config:{whatsapp_direccion_texto_v1:''}});
    await f.pedirDomicilio();
    await f.procesar(f.texto('Calle Ficticia 123, Colonia Centro'),{modelo:async()=>({content:[{type:'text',
      text:'Gracias.'}],stop_reason:'end_turn'})});
    assert.equal(f.modeloLlamado(),1,'apagado, el turno es del modelo');
    assert.equal((await f.leer()).carrito.datos.cliente?.direccion,undefined);
  });

  await caso('si el cliente ya escribió otra cosa, el resumen sale sin botones que nacerían viejos',async()=>{
    const f=await fixture();
    await f.pedirDomicilio();
    const m=f.texto('Calle Ficticia 123');
    await f.entrada(m,'completado');
    await f.entrada(f.texto('Colonia Centro, casa azul'),'pendiente');
    const q=await f.procesar(m);
    assert.equal((await f.leer()).carrito.datos.cliente?.direccion,'Calle Ficticia 123');
    assert.match(q.texto,/Revisa tu pedido/);
    assert.equal(q.interactivo ?? null,null,'el siguiente turno publicará los suyos');
  });
} finally {
  await pool.end();
}
console.log(`direccion-texto: ${n} OK, ${fallidas} fallos`);
if(fallidas)process.exitCode=1;
