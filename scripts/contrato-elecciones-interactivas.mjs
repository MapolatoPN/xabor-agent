// Contrato puro distribuido con la imagen: test/ se excluye del build.
import assert from 'node:assert/strict';
import { estadoNuevo, crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { fijarPendiente, sellarEstado } from '../src/mesero-agente/estadoCanonico.js';
import { guardarDialogo } from '../src/mesero-agente/contratoConversacional.js';
import { construirBotones, leerBoton } from '../src/mesero-agente/interactivos.js';
import { payloadInteractivoValido } from '../src/mesero-agente/transporteInteractivo.js';
import { opcionesInteractivas, respuestaDeEleccion, respuestaTextoGrupo, abrirGrupoDePregunta,
  asociacionVigente, textoDeElecciones } from '../src/mesero-agente/eleccionesInteractivas.js';
import { iniciarSeleccion } from '../src/mesero-agente/seleccionDeProducto.js';
import { esAccionInteractiva } from '../src/mesero-agente/autoridadInteractiva.js';

const banderaPrevia=process.env.WHATSAPP_INTERACTIVOS;
process.env.WHATSAPP_INTERACTIVOS='true';
const cfg = {whatsapp_interactivos_v1:'true',whatsapp_interactivos_elecciones_v1:'true'};
const grupo = (nombre,minimo,maximo,nombres) => ({nombre,requerido:minimo>0,minimo,maximo,
  opciones:nombres.map((nombre,i)=>({nombre,precio_extra:i===3?5:0,disponible:true}))});
const catalogo = [{nombre:'Desayunos',productos:[{id:1,nombre:'Chilaquiles Mixtos',precio:120,disponible:true,
  modificadores:[grupo('Salsa',1,2,['Roja','Verde','Suiza','Chipotle']),grupo('Proteína',1,1,['Pollo','Huevo']),
    grupo('Guarnición',2,2,['Frijoles','Papas a la mexicana','Arroz','Ensalada'])]},
  {id:2,nombre:'Café americano',precio:45,modificadores:[]},{id:3,nombre:'Café de olla',precio:40,modificadores:[]}]}];
const modalidades=['recoger en tienda','entrega a domicilio'];
const metodosPago=[{tipo:'efectivo',habilitado:true,disponible_para_bot:true},{tipo:'transferencia',habilitado:true,disponible_para_bot:true}];
let cuenta=0;
async function caso(n,f){await f();console.log(`OK ${++cuenta}: ${n}`);}
function fixture() {
  const estado=estadoNuevo({negocioId:'test',conversacionId:'ciclo'});
  estado.carrito.items=[{lid:'plato1',id:1,nombre:'Chilaquiles Mixtos',cantidad:1,modificadores:[],notas:''}];
  const ctx={estado,catalogo:structuredClone(catalogo),modalidades,metodosPago,promociones:[],requierePago:true};
  const vista=()=>crearEjecutor({...ctx,mensaje:''}).vista();
  const pregunta=(grupo='Salsa')=>{const g=ctx.catalogo[0].productos[0].modificadores.find(g=>g.nombre===grupo);
    fijarPendiente(estado,{tipo:'elegir_opcion',linea_id:'plato1',grupo,candidatos:g.opciones.filter(o=>o.disponible).map(o=>o.nombre),minimo:g.minimo,maximo:g.maximo});
    abrirGrupoDePregunta(estado,ctx.catalogo);};
  const aplicar=async respuestaDeSistema=>{
    const r=await atenderTurnoConHerramientas({...ctx,mensaje:'',modo:'sombra',turnoId:`t-${++estado.version}`,
      respuestaDeSistema,llamarModelo:async()=>{throw Error('NO_LLM');}});
    assert(!r.escalado,JSON.stringify(r));sellarEstado(estado,vista(),{modo:'sombra'});return r;
  };
  const elegir=async (accion,valor)=>{const o=opcionesInteractivas(ctx).find(o=>o.accion===accion&&(valor==null||o.datos.valor===valor));
    assert(o,`${accion}:${valor} no disponible`);return aplicar(respuestaDeEleccion(o,ctx));};
  pregunta();return {ctx,estado,vista,pregunta,aplicar,elegir};
}

try {
await caso('Roja + Verde conserva ambas y Listo es obligatorio aunque alcance el máximo',async()=>{
  const f=fixture();await f.elegir('agregar_a_grupo','Roja');
  assert.deepEqual(f.vista().lineas[0].opciones,[{grupo:'Salsa',opcion:'Roja'}]);
  assert.equal(f.vista().aclaraciones[0].tipo,'grupo_abierto');
  await f.elegir('agregar_a_grupo','Verde');
  assert.deepEqual(f.vista().lineas[0].opciones.map(o=>o.opcion),['Roja','Verde']);
  assert.deepEqual(opcionesInteractivas(f.ctx).map(o=>o.accion),['cerrar_grupo','editar_grupo']);
  assert.notEqual(f.estado.pendiente.tipo,'confirmar_resumen');
  await f.elegir('cerrar_grupo');assert.equal(f.estado.pendiente.grupo,'Proteína');
  await f.elegir('elegir_opcion','Pollo');assert.equal(f.estado.pendiente.grupo,'Guarnición');
  await f.elegir('agregar_a_grupo','Frijoles');
  assert(!opcionesInteractivas(f.ctx).some(o=>o.accion==='cerrar_grupo'));
  await f.elegir('agregar_a_grupo','Papas a la mexicana');await f.elegir('cerrar_grupo');
  await f.elegir('modalidad','recoger en tienda');await f.elegir('pago','efectivo');
  assert.equal(f.estado.pendiente.tipo,'confirmar_resumen');assert.equal(f.estado.carrito.items.length,1);
  assert.deepEqual(f.vista().lineas[0].opciones.map(o=>o.opcion),['Roja','Verde','Pollo','Frijoles','Papas a la mexicana']);
});
await caso('segunda salsa escrita suma; solo verde sustituye y cierra tras verificar resultado',async()=>{
  const f=fixture();await f.elegir('agregar_a_grupo','Roja');
  await f.aplicar(respuestaTextoGrupo({...f.ctx,mensaje:'agrega verde'}));
  assert.deepEqual(f.vista().lineas[0].opciones.map(o=>o.opcion),['Roja','Verde']);
  assert(f.estado.eleccionInteractiva);
  await f.aplicar(respuestaTextoGrupo({...f.ctx,mensaje:'solo verde'}));
  assert.deepEqual(f.vista().lineas[0].opciones.map(o=>o.opcion),['Verde']);assert(!f.estado.eleccionInteractiva);
});
await caso('una opción duplicada no suma precio, exceso y desconocidas conservan lo guardado',async()=>{
  const f=fixture();await f.elegir('agregar_a_grupo','Chipotle');
  await f.aplicar(respuestaTextoGrupo({...f.ctx,mensaje:'agrega chipotle'}));
  assert.equal(f.vista().lineas[0].precio_unitario,125);
  await f.aplicar(respuestaTextoGrupo({...f.ctx,mensaje:'agrega roja y verde'}));
  assert.deepEqual(f.vista().lineas[0].opciones.map(o=>o.opcion),['Chipotle']);
  await f.aplicar(respuestaTextoGrupo({...f.ctx,mensaje:'solo aguacate'}));assert(f.estado.eleccionInteractiva);
  assert.equal(respuestaTextoGrupo({...f.ctx,mensaje:'para llevar'}),null);assert(f.estado.eleccionInteractiva);
});
await caso('asociación invalida al cambiar precio, disponibilidad, cardinalidad o selección',async()=>{
  for(const mutar of [c=>c[0].productos[0].modificadores[0].opciones[0].precio_extra=8,
    c=>c[0].productos[0].modificadores[0].opciones[0].disponible=false,
    c=>c[0].productos[0].modificadores[0].maximo=1,c=>c[0].productos[0].precio=121]){
    const f=fixture(),o=opcionesInteractivas(f.ctx)[0];mutar(f.ctx.catalogo);assert.equal(asociacionVigente(o,f.ctx),false);
  }
});
await caso('oferta de producto sí agrega, no conserva el carrito y una capacidad copiada no autoriza',async()=>{
  const f=fixture();f.estado.carrito.items=[];
  fijarPendiente(f.estado,{tipo:'aceptar_producto',producto_id:'2',producto:'Café americano'});
  const o=opcionesInteractivas(f.ctx).find(o=>o.accion==='aceptar'),r=respuestaDeEleccion(o,f.ctx);
  const falso=structuredClone(r.acciones[0]);
  const no=await crearEjecutor({...f.ctx,mensaje:''}).ejecutar(falso.herramienta,falso.argumentos,{autorizacion:falso.autorizacion});
  assert.equal(no.aplicado,false);assert.equal(f.estado.carrito.items.length,0);
  await f.aplicar(respuestaDeEleccion(opcionesInteractivas(f.ctx).find(o=>o.accion==='rechazar'),f.ctx));
  assert.equal(f.estado.carrito.items.length,0);
  fijarPendiente(f.estado,{tipo:'aceptar_producto',producto_id:'2',producto:'Café americano'});
  await f.aplicar(respuestaDeEleccion(o,f.ctx));assert.equal(f.estado.carrito.items[0].nombre,'Café americano');
});
await caso('promoción autoriza cantidad exacta y cambiar condiciones la invalida',async()=>{
  const f=fixture();f.estado.carrito.items=[];
  f.ctx.promociones=[{id:'promo',nombre:'2x1',cantidadAceptacion:2,valor:50,participacion:{modo:'productos',nombres:['Café americano']}}];
  fijarPendiente(f.estado,{tipo:'aceptar_promocion',promocion_id:'promo',promocion:'2x1',producto_id:'2',producto:'Café americano',cantidad:2});
  const o=opcionesInteractivas(f.ctx)[0];f.ctx.promociones[0].valor=20;assert.equal(asociacionVigente(o,f.ctx),false);
  f.ctx.promociones[0].valor=50;await f.aplicar(respuestaDeEleccion(o,f.ctx));assert.equal(f.estado.carrito.items[0].cantidad,2);
});
await caso('elección de producto por identidad conserva cantidad de la solicitud',async()=>{
  const f=fixture();f.estado.carrito.items=[];
  const p=iniciarSeleccion({...f.ctx,mensaje:'quiero 2 cafes'});assert(p);fijarPendiente(f.estado,p);
  const o=opcionesInteractivas(f.ctx).find(o=>o.datos.producto_id==='3');assert(o);
  await f.aplicar(respuestaDeEleccion(o,f.ctx));assert.equal(f.estado.carrito.items[0].nombre,'Café de olla');
  assert.equal(f.estado.carrito.items[0].cantidad,2);
});
await caso('pago ofrecido y modalidades solo habilitados',async()=>{
  const f=fixture();fijarPendiente(f.estado,{tipo:'aceptar_pago_ofrecido',forma_pago:'efectivo'});
  await f.aplicar(respuestaDeEleccion(opcionesInteractivas(f.ctx)[0],f.ctx));assert.equal(f.estado.carrito.datos.forma_pago,'efectivo');
  fijarPendiente(f.estado,{tipo:'pago',opciones:['efectivo','enlace_pago']});assert.equal(opcionesInteractivas(f.ctx).length,1);
});
await caso('listas y botones usan tokens; no hay índices ni títulos como autoridad',async()=>{
  const f=fixture();const opciones=opcionesInteractivas(f.ctx);
  const texto=textoDeElecciones(f.estado,f.ctx.catalogo,opciones,'');guardarDialogo(f.estado,{mensaje:'',texto});
  const b=construirBotones({...f.ctx,pedido:f.vista(),texto,cfg});assert.equal(b.carga.type,'list');
  assert(payloadInteractivoValido(b.carga,texto));
  assert(leerBoton({type:'interactive',id:'wamid.in',from:'telefono',context:{id:'wamid.out'},
    interactive:{type:'list_reply',list_reply:{id:b.botones[0].token,title:'PAGADO'}}}));
  const copia=structuredClone(b.carga);copia.action.sections[0].rows.push(copia.action.sections[0].rows[0]);
  assert.equal(payloadInteractivoValido(copia,texto),false);
  assert.equal(construirBotones({...f.ctx,pedido:f.vista(),texto,cfg:{whatsapp_interactivos_v1:'true'}}),null);
});
await caso('JSONB con claves reordenadas conserva el vínculo exacto',async()=>{
  const f=fixture(), o=opcionesInteractivas(f.ctx)[0];
  const ordenar=v=>Array.isArray(v)?v.map(ordenar):v&&typeof v==='object'
    ?Object.fromEntries(Object.keys(v).reverse().map(k=>[k,ordenar(v[k])])):v;
  assert(asociacionVigente(ordenar(o),f.ctx));
  const ajena=ordenar(o);ajena.datos.linea_id='otro-plato';assert.equal(asociacionVigente(ajena,f.ctx),false);
});
await caso('líneas homónimas: el botón solo cambia el renglón asociado',async()=>{
  const f=fixture();f.estado.carrito.items.push({...structuredClone(f.estado.carrito.items[0]),lid:'plato2'});
  await f.elegir('agregar_a_grupo','Roja');
  assert.deepEqual(f.vista().lineas[0].opciones,[{grupo:'Salsa',opcion:'Roja'}]);
  assert.deepEqual(f.vista().lineas[1].opciones,[]);
});
await caso('mínimo pendiente, máximo y texto ambiguo nunca cierran ni confirman',async()=>{
  const f=fixture();f.pregunta('Guarnición');
  await f.aplicar(respuestaTextoGrupo({...f.ctx,mensaje:'listo'}));assert(f.estado.eleccionInteractiva);
  await f.aplicar(respuestaTextoGrupo({...f.ctx,mensaje:'frijoles o arroz'}));
  assert.deepEqual(f.vista().lineas[0].opciones,[]);assert(f.estado.eleccionInteractiva);
  const e=crearEjecutor({...f.ctx,mensaje:'Confirmo'});const r=await e.ejecutar('confirmar_pedido',{huella_resumen:f.vista().huella});
  assert.equal(r.aplicado,false);assert.equal(f.estado.folio,null);
});
await caso('capacidad vinculada a estado, ciclo y argumentos exactos',async()=>{
  const f=fixture(),o=opcionesInteractivas(f.ctx)[0];
  const a=respuestaDeEleccion(o,f.ctx).acciones[0];
  assert(esAccionInteractiva(a.autorizacion,a.herramienta,a.argumentos,f.estado));
  assert.equal(esAccionInteractiva(a.autorizacion,a.herramienta,a.argumentos,structuredClone(f.estado)),false);
  assert.equal(esAccionInteractiva(a.autorizacion,a.herramienta,{...a.argumentos,linea_id:'otro'},f.estado),false);
  f.estado.conversacionId='otro-ciclo';assert.equal(esAccionInteractiva(a.autorizacion,a.herramienta,a.argumentos,f.estado),false);
});
await caso('nombres largos distintos conservan identidad; más de diez opciones usa texto',async()=>{
  const f=fixture(),g=f.ctx.catalogo[0].productos[0].modificadores[0];
  g.opciones=['Una salsa de nombre extremadamente largo roja','Una salsa de nombre extremadamente largo verde']
    .map(nombre=>({nombre,precio_extra:0,disponible:true}));f.pregunta();
  const preparar=()=>{const texto=textoDeElecciones(f.estado,f.ctx.catalogo,opcionesInteractivas(f.ctx),'');
    guardarDialogo(f.estado,{mensaje:'',texto});return construirBotones({...f.ctx,pedido:f.vista(),texto,cfg});};
  const b=preparar();assert.equal(b.carga.type,'list');assert(payloadInteractivoValido(b.carga,b.carga.body.text));
  assert.deepEqual(b.botones.map(b=>b.datos.valor),g.opciones.map(o=>o.nombre));
  g.opciones=Array.from({length:11},(_,i)=>({nombre:`Salsa ${i+1}`,precio_extra:0,disponible:true}));f.pregunta();
  assert.equal(preparar(),null);assert(f.estado.eleccionInteractiva);
});
console.log(`Elecciones interactivas: ${cuenta}/${cuenta}.`);
} finally {if(banderaPrevia===undefined)delete process.env.WHATSAPP_INTERACTIVOS;else process.env.WHATSAPP_INTERACTIVOS=banderaPrevia;}
