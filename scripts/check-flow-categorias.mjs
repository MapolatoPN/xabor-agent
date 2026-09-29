import assert from 'node:assert/strict';
import { estadoNuevo,crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { fotoFormulario,aplicarFormulario,comandosFormulario } from '../src/mesero-agente/formularioAgrupado.js';
import { borradorCategorias,cambiarCategorias,respuestaCategorias } from '../src/mesero-agente/flowCategorias.js';
import { definicionFlowCategorias } from './definicion-flow-categorias.mjs';
import { categoriasFlow,loteTacos } from '../src/mesero-agente/catalogoFlowCategorias.js';
import { prepararEnvioInteractivo } from '../src/mesero-agente/transporteInteractivo.js';
const guardadas=Object.fromEntries(['WHATSAPP_FLOW_ENDPOINT','WHATSAPP_FLOW_PRIVATE_KEY','META_APP_SECRET','WHATSAPP_INTERACTIVOS','MESERO_AGENTE_MODE'].map(k=>[k,process.env[k]]));
try {
  Object.assign(process.env,{WHATSAPP_FLOW_ENDPOINT:'true',WHATSAPP_FLOW_PRIVATE_KEY:'solo-test',META_APP_SECRET:'solo-test',WHATSAPP_INTERACTIVOS:'true',MESERO_AGENTE_MODE:'true'});
  const telefono='528787899919',cfgEnvio={mesero_agente_v1:'true',mesero_agente_telefonos:telefono,
    bot_whatsapp_solo_prueba:'true',bot_whatsapp_telefonos_prueba:telefono,whatsapp_flows_telefonos:telefono,
    whatsapp_flows_v1:'true',whatsapp_interactivos_v1:'true',whatsapp_interactivos_elecciones_v1:'true',
    whatsapp_flow_repetible_id:'1111111111',whatsapp_flow_categorias_id:'2222222222'};
  const envio=async({cfg=cfgEnvio,activo=true,abierta=true,id='2222222222'}={})=>{
    const interactivo={type:'flow',body:{text:'Arma tu pedido'},action:{name:'flow',parameters:{flow_message_version:'3',
      flow_token:'xb1:aaaaaaaaaaaaaaaaaaaaaa',flow_id:id,flow_cta:'Elegir platillos',flow_action:'data_exchange'}}};
    const db={query:async sql=>({rows:[sql.includes('bot_whatsapp_activo')?{activo,cfg}:{abierta}]})};
    return prepararEnvioInteractivo({db,negocioId:'test',telefono,interactivo,texto:interactivo.body.text});
  };
  assert.equal((await envio()).interactivo.type,'flow');
  assert.equal((await envio({id:'3333333333'})).interactivo,null,'ID no configurado no sale');
  assert.equal((await envio({id:'1111111111'})).interactivo,null,'el formulario anterior no sale al activar categorías');
  assert.equal((await envio({activo:false})).permitido,false);
  assert.equal((await envio({abierta:false})).permitido,false);
  assert.equal((await envio({cfg:{...cfgEnvio,whatsapp_flows_telefonos:'528787899918'}})).interactivo,null);
  process.env.WHATSAPP_FLOW_ENDPOINT='false';assert.equal((await envio()).interactivo,null);
  process.env.WHATSAPP_FLOW_ENDPOINT='true';
  assert.equal((await envio({cfg:{...cfgEnvio,whatsapp_flow_categorias_id:''},id:'1111111111'})).interactivo.type,'flow','reversión conserva la versión previa');
  const tortilla={nombre:'Tortilla',requerido:true,minimo:1,maximo:1,opciones:[{nombre:'Harina',precio_extra:0},{nombre:'Maíz',precio_extra:0}]};
  const catalogo=[{id:1,nombre:'Chilaquiles',productos:[{id:1,nombre:'Chilaquiles',precio:195,modificadores:[{nombre:'Salsa',minimo:1,maximo:2,requerido:true,opciones:[{nombre:'Roja',precio_extra:0},{nombre:'Verde',precio_extra:0}]}]}]},
    {id:2,nombre:'TACOS',productos:[{id:2,nombre:'Taco de papa',precio:25,modificadores:[tortilla]},
      {id:3,nombre:'Taco de bistec',precio:30,modificadores:[{...tortilla,nombre:'tortilla',opciones:[{nombre:'maiz',precio_extra:0},{nombre:'harina',precio_extra:0}]}]},
      {id:4,nombre:'Taco especial',precio:25,modificadores:[tortilla,{nombre:'Frijoles',minimo:1,maximo:1,requerido:true,opciones:[{nombre:'Naturales',precio_extra:0}]}]}]},
    {id:3,nombre:'Bebidas',productos:[{id:5,nombre:'Café',precio:45,modificadores:[]}]}];
  const estado=estadoNuevo({negocioId:'categorias-test',conversacionId:'ciclo'}),ctx={estado,catalogo,
    cfg:{whatsapp_flow_repetible_id:'1111111111',whatsapp_flow_categorias_id:'2222222222'},modalidades:['recoger en tienda'],
    metodosPago:[{tipo:'efectivo',habilitado:true,disponible_para_bot:true}],requierePago:true};
  const foto=fotoFormulario(ctx,'flow_productos'),cats=categoriasFlow(foto);
  const desordenado=[...catalogo].reverse().map(c=>({...c,productos:[...c.productos].reverse()}));
  assert.deepEqual(fotoFormulario({...ctx,catalogo:desordenado},'flow_productos'),foto,'empates SQL no cambian tokens ni invalidan el formulario');
  assert.equal(foto.presentacion,'categorias_v1');assert.equal(foto.flowId,'2222222222');
  assert.equal(cats.length,3);assert.deepEqual(loteTacos(foto,cats[1]),[1,2],'taco con grupos extra conserva personalización individual');
  const paso=(b,operacion,extra={})=>cambiarCategorias(foto,b,{action:'data_exchange',screen:b.etapa,data:{revision:String(b.revision),operacion,...extra}});
  const vista=(b,error='',s)=>respuestaCategorias(foto,b,'token',error,s);
  let b=borradorCategorias();
  assert.equal(vista(b).screen,'MENU');assert(paso(b,'terminar').error);
  b=paso(b,'categoria',{categoria:'c1'}).borrador;assert.equal(b.etapa,'TACOS');
  const seleccion={tortilla:'maiz',t0_q:'2',t1_q:'3',t0_nota:'Sin cebolla',t1_nota:'Bien cocidos'};
  for(const malo of [{...seleccion,t0_q:'-1'},{...seleccion,t0_q:2},{...seleccion,t0_q:'2.5'},{...seleccion,t0_q:'21'},
    {...seleccion,t0_q:'02'},{...seleccion,t11_q:'1'},{...seleccion,tortilla:'otra'},{...seleccion,t0_nota:{}},{...seleccion,total:0}]) {
    const r=paso(b,'agregar',malo);assert(r.error);assert.deepEqual(r.borrador,b);
  }
  const rError=paso(b,'agregar',{...seleccion,tortilla:''});assert(rError.error);
  const restaurada=vista(b,rError.error,{...seleccion,tortilla:'',revision:String(b.revision)}).data;
  assert.equal(restaurada.t0_inicial,'2');assert.equal(restaurada.t0_nota,'Sin cebolla');
  assert.equal(restaurada.t0_cantidades[0]['on-select-action'].payload.t0_nota,'');
  b=paso(b,'agregar',seleccion).borrador;assert.equal(b.items.length,2);
  const atras=cambiarCategorias(foto,b,{action:'BACK',screen:'MENU'}).borrador;
  assert.equal(atras.etapa,'MENU');assert.equal(atras.revision,b.revision+1);assert.deepEqual(atras.items,b.items);
  const reentrada=paso(atras,'categoria',{categoria:'c1'}).borrador;
  assert.equal(reentrada.etapa,'TACOS');assert.deepEqual(reentrada.items,b.items);
  assert.equal(vista(b).data.t0_inicial,'0');assert.equal(vista(b).data.t0_nota,'');
  assert.deepEqual(b.items.map(i=>i.g0_s),['p1g0o1','p2g0o0'],'resuelve cada tortilla contra el catálogo, no un índice compartido');
  const repetido=cambiarCategorias(foto,b,{action:'data_exchange',screen:'TACOS',data:{revision:'1',operacion:'agregar',...seleccion}});
  assert(repetido.error);assert.deepEqual(repetido.borrador,b);
  b=paso(b,'categorias').borrador;b=paso(b,'categoria',{categoria:'c0'}).borrador;
  assert.deepEqual(vista(b).data.productos0.map(p=>p.id),['p0']);
  assert(paso(b,'agregar',{producto0:'p1',cantidad:'1',g0_s:'p1g0o0'}).error,'no cruzar categoría con producto');
  const plato={producto0:'p0',cantidad:'2',g0_m:['p0g0o0','p0g0o1'],observaciones:'Sin crema'};
  b=paso(b,'categorias',plato).borrador;assert.equal(b.items.length,3);assert.equal(b.etapa,'MENU');
  b=paso(b,'categoria',{categoria:'c1'}).borrador;b=paso(b,'individual').borrador;
  assert(vista(b).data.productos0.some(p=>p.id==='p3'));
  b=paso(b,'terminar',{producto0:'p3',cantidad:'1',g0_s:'p3g0o0',g1_s:'p3g1o0'}).borrador;
  assert.equal(b.etapa,'ENTREGA');b=paso(b,'revisar',{modalidad:'m0',pago:'p0'}).borrador;
  assert.equal(b.etapa,'FINAL');
  assert.deepEqual(vista(b).data.extension_message_response.params,{flow_token:'token',revision:String(b.revision)});
  assert.equal((await aplicarFormulario({accion:'flow_productos',datos:foto,respuestaFlow:{items:b.items,modalidad:b.modalidad,pago:b.pago}},ctx)).ok,true);
  assert.deepEqual(estado.carrito.items.map(i=>i.cantidad),[2,3,2,1]);
  assert.deepEqual(estado.carrito.items.map(i=>i.notas),['Sin cebolla','Bien cocidos','Sin crema','']);
  assert.equal(crearEjecutor({...ctx,mensaje:''}).vista().total,555);assert.equal(estado.folio,null);
  const vieja=fotoFormulario({...ctx,cfg:{whatsapp_flow_repetible_id:'1111111111'}},'flow_productos');
  assert(!vieja.presentacion);assert.equal(comandosFormulario(vieja,{items:[plato],modalidad:'m0',pago:'p0'}),null,'el contrato anterior no habilita cantidades');
  const def=definicionFlowCategorias();
  for(const etapa of ['MENU','TACOS','PLATILLO','ENTREGA']) {
    const borrador={...borradorCategorias(),etapa,categoria:etapa==='TACOS'?'c1':'c0'};
    const response=vista(borrador),s=def.screens.find(s=>s.id===etapa);
    assert.deepEqual(Object.keys(response.data).sort(),Object.keys(s.data).sort(),`datos declarados ${etapa}`);
    assert(s.layout.children[0].children.length<50);
  }
  console.log('OK categorías y cantidades: selección filtrada, lotes de tacos, opciones exactas, notas separadas, 8 unidades/$555, errores y contrato anterior protegidos.');
} finally {for(const [k,v] of Object.entries(guardadas))if(v===undefined)delete process.env[k];else process.env[k]=v;}
