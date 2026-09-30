import assert from 'node:assert/strict';
import { estadoNuevo,crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { fotoFormulario,formularioVigente,entradaFormulario,aplicarFormulario } from '../src/mesero-agente/formularioAgrupado.js';
import { borradorCarrito,cambiarCarrito,respuestaCarrito } from '../src/mesero-agente/flowCarrito.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
const keys=['WHATSAPP_FLOW_ENDPOINT','WHATSAPP_FLOW_PRIVATE_KEY','META_APP_SECRET'];
const prev=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
Object.assign(process.env,{WHATSAPP_FLOW_ENDPOINT:'true',WHATSAPP_FLOW_PRIVATE_KEY:'solo-local',META_APP_SECRET:'solo-local'});
const cfg={whatsapp_carrito_unificado_v1:'true',whatsapp_flow_categorias_id:'11111111111',whatsapp_flow_carrito_id:'22222222222',
  whatsapp_flows_v1:'true',whatsapp_atencion_general_v1:'true',bot_whatsapp_solo_prueba:'false'};
const catalogo=[{id:1,nombre:'Desayunos',productos:[{id:1,nombre:'Chilaquiles',precio:195,disponible:true,
  modificadores:[{nombre:'Salsa',minimo:1,maximo:1,requerido:true,opciones:[{nombre:'Roja',precio_extra:0},{nombre:'Verde',precio_extra:0}]}]}]}];
try {
  for(const n of [1,3,5,8]) {
    const estado=estadoNuevo({negocioId:'local',conversacionId:'carrito-unificado'});
    estado.carrito.items=Array.from({length:n},(_,i)=>({id:1,lid:`linea-${i}`,nombre:'Chilaquiles',cantidad:i+1,
      notas:`Sin crema ${i}`,modificadores:i%2?[{grupo:'Salsa',opciones:['Verde']}]:[]}));
    estado.pendiente={tipo:'elegir_opcion'};
    const ctx={estado,cfg,catalogo,modalidades:['recoger en tienda','entrega a domicilio'],requierePago:true,
      metodosPago:[{tipo:'efectivo',habilitado:true,disponible_para_bot:true}]};
    const antes=structuredClone(estado),foto=fotoFormulario(ctx,'flow_configurar');
    assert.equal(foto.version,'carrito_v1');assert.equal(foto.lineas.length,n);
    const legacy=fotoFormulario({...ctx,cfg:{...cfg,whatsapp_carrito_unificado_v1:'false'}},'flow_configurar');
    assert(formularioVigente({accion:'flow_configurar',datos:legacy},ctx),'el formulario agrupado anterior sigue siendo compatible');
    let b=borradorCarrito(foto);assert.equal(b.modalidad,-1);assert.equal(b.pago,-1);
    assert.match(respuestaCarrito(foto,b,'token').data.r0_detalle,/Falta completar: Salsa/);
    for(let i=0;i<n;i++) {
      const x=cambiarCarrito(foto,b,{action:'data_exchange',screen:'CARRITO',data:{revision:String(b.revision),operacion:'editar',editar:`e${i}`}});
      assert(!x.error);b=x.borrador;
      const y=cambiarCarrito(foto,b,{action:'data_exchange',screen:'EDITAR',data:{revision:String(b.revision),operacion:'aplicar_opciones',
        cantidad:String(i+1),observaciones:`Sin crema ${i}`,g0_s:'l0g0o1'}});
      assert(!y.error,JSON.stringify(y));b=y.borrador;
    }
    assert.equal(b.modalidad,-1,'personalizar no inventa entrega');assert.equal(b.pago,-1,'personalizar no inventa pago');
    assert.deepEqual(estado,antes,'navegación no aplica cambios comerciales');
    assert(cambiarCarrito(foto,b,{action:'data_exchange',screen:'CARRITO',data:{revision:String(b.revision),operacion:'guardar'}}).error);
    const final=cambiarCarrito(foto,b,{action:'data_exchange',screen:'CARRITO',data:{revision:String(b.revision),operacion:'guardar',modalidad:'m0',pago:'p0'}});
    assert(!final.error);b=final.borrador;assert.equal(b.etapa,'FINAL');
    const r=await aplicarFormulario({accion:'flow_configurar',datos:foto,respuestaFlow:{filas:b.filas,modalidad:b.modalidad,pago:b.pago}},ctx);
    assert.equal(r.ok,true,JSON.stringify(r));assert.equal(estado.carrito.items.length,n);
    assert.equal(estado.folio,null);assert(!estado.hechos.confirmado);
    assert.equal(crearEjecutor({...ctx,mensaje:''}).vista().subtotal,195*n*(n+1)/2);
    console.log(`OK carrito unificado: ${n} renglones, misma ventana, notas/cantidades y entrega/pago sin inventar.`);
  }
  for(const [mensaje,esperada] of [['Buen día, quiero hacer un pedido a domicilio','entrega a domicilio'],
    ['Hola, quiero ordenar para recoger','recoger en tienda']]) {
    const estado=estadoNuevo({negocioId:'local',conversacionId:'entrada'}),ctx={estado,cfg,mensaje};
    const sistema=entradaFormulario(ctx);assert(sistema);assert.equal(sistema.acciones.length,1);
    const r=await atenderTurnoConHerramientas({...ctx,catalogo,modalidades:['recoger en tienda','entrega a domicilio'],
      respuestaDeSistema:sistema,llamarModelo:async()=>{throw Error('sin modelo');}});
    assert.equal(r.llamadasAlModelo,0);assert.equal(estado.carrito.datos.modalidad,esperada);assert.equal(estado.folio,null);
  }
  for(const mensaje of ['Quiero pedir dos tacos a domicilio','No quiero ordenar a domicilio','Quiero ordenar a domicilio mañana',
    'Quiero ordenar para recoger pero sin crema','Quiero ordenar para un evento','Quiero saber si puedo ordenar a domicilio'])
    assert.equal(entradaFormulario({estado:estadoNuevo({}),cfg,mensaje}),null,mensaje);
  console.log('OK entrada con modalidad: conserva intención validada; no consume productos, consultas ni negaciones.');
} finally {for(const k of keys)prev[k]===undefined?delete process.env[k]:process.env[k]=prev[k];}
