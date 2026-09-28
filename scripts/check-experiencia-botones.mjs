// Regresión del intercambio real: lenguaje natural, presentación y edición.
// Sin red, base, proveedor ni efectos reales. También se distribuye en el gate.
import assert from 'node:assert/strict';
import { estadoNuevo, crearEjecutor } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { fijarPendiente, sellarEstado } from '../src/mesero-agente/estadoCanonico.js';
import { guardarDialogo } from '../src/mesero-agente/contratoConversacional.js';
import { iniciarSeleccion } from '../src/mesero-agente/seleccionDeProducto.js';
import { construirBotones } from '../src/mesero-agente/interactivos.js';
import { payloadInteractivoValido } from '../src/mesero-agente/transporteInteractivo.js';
import { abrirGrupoDePregunta, opcionesInteractivas, textoDeElecciones, respuestaDeEleccion,
  adicionDeListaVigente } from '../src/mesero-agente/eleccionesInteractivas.js';

const catalogo=[{nombre:'Desayunos',productos:[
  {id:1,nombre:'Chilaquiles Sencillos',precio:195,disponible:true,modificadores:[]},
  {id:2,nombre:'Chilaquiles Mixtos',precio:205,disponible:true,modificadores:[
    {nombre:'Salsa',requerido:true,minimo:1,maximo:2,opciones:['Roja','Verde','Suiza','Mole','Chipotle']
      .map(nombre=>({nombre,precio_extra:nombre==='Chipotle'?5:0,disponible:true}))}]}]}];
const cfg={whatsapp_interactivos_v1:'true',whatsapp_interactivos_elecciones_v1:'true'};
const anterior=process.env.WHATSAPP_INTERACTIVOS;
process.env.WHATSAPP_INTERACTIVOS='true';
let n=0,turno=0;
const caso=async(nombre,fn)=>{await fn();console.log(`OK experiencia ${++n}: ${nombre}`);};
const nuevo=()=>estadoNuevo({negocioId:'local',conversacionId:'experiencia'});
const noModelo=async()=>{throw Error('NO_MODELO');};
function fixture() {
  const estado=nuevo(),ctx={estado,catalogo:structuredClone(catalogo),modalidades:['recoger en tienda'],metodosPago:['efectivo']};
  estado.carrito.items=[{lid:'plato',id:2,nombre:'Chilaquiles Mixtos',cantidad:1,modificadores:[],notas:''}];
  const preguntar=()=>{
    fijarPendiente(estado,{tipo:'elegir_opcion',linea_id:'plato',grupo:'Salsa',minimo:1,maximo:2,candidatos:['Roja','Verde','Suiza','Mole','Chipotle']});
    abrirGrupoDePregunta(estado,ctx.catalogo);
  };
  preguntar();
  const aplicar=async opcion=>{
    const r=await atenderTurnoConHerramientas({...ctx,mensaje:'',turnoId:`ux-${++turno}`,
      respuestaDeSistema:respuestaDeEleccion(opcion,ctx),llamarModelo:noModelo});
    assert.equal(r.escalado,false,r.texto);sellarEstado(estado,r.pedido);return r;
  };
  const vista=()=>crearEjecutor({...ctx,mensaje:''}).vista();
  const preparar=()=>{
    const texto=textoDeElecciones(estado,ctx.catalogo,opcionesInteractivas(ctx),'',{compacto:true});
    guardarDialogo(estado,{mensaje:'',texto});
    return construirBotones({...ctx,pedido:vista(),texto,cfg});
  };
  return {ctx,estado,preguntar,aplicar,vista,preparar};
}
try {
  for(const mensaje of ['Quiero unos chilaquiles','Quiero ordenar unos chilaquiles','Hola\nQuiero ordenar unos chilaquiles','Chilaquiles'])
    await caso(`familia natural: ${mensaje.replaceAll('\n',' / ')}`,async()=>{
      const estado=nuevo();const r=await atenderTurnoConHerramientas({estado,catalogo,mensaje,turnoId:`ux-${++turno}`,llamarModelo:noModelo});
      assert.equal(estado.pendiente?.tipo,'elegir_producto');assert.equal(estado.carrito.items.length,0);
      assert.equal(r.llamadasAlModelo,0);assert.doesNotMatch(r.texto,/Qué te gustaría pedir/);
    });
  await caso('agregar otro conserva carrito y rompe la repetición del resumen',async()=>{
    const f=fixture();f.estado.carrito.datos={modalidad:'recoger en tienda',forma_pago:'efectivo'};
    const antes=structuredClone(f.estado.carrito);
    const r=await atenderTurnoConHerramientas({...f.ctx,mensaje:'Quiero agregar otro',turnoId:`ux-${++turno}`,llamarModelo:noModelo});
    assert.equal(f.estado.pendiente.tipo,'agregar_otro');assert.match(r.texto,/Qué te gustaría agregar/);
    assert.deepEqual(f.estado.carrito,antes);assert.equal(r.llamadasAlModelo,0);
    const p=iniciarSeleccion({...f.ctx,mensaje:'Chilaquiles'});assert(p);fijarPendiente(f.estado,p);sellarEstado(f.estado,f.vista());
    await f.aplicar(opcionesInteractivas(f.ctx).find(o=>o.datos.producto_id==='1'));
    assert.equal(f.estado.carrito.items.length,2);assert.equal(f.estado.carrito.items[0].lid,'plato');
  });
  await caso('sin nombres duplicados, párrafos saturados ni cargos ocultos',async()=>{
    const f=fixture(),b=f.preparar(),p=b.carga;
    assert(p.body.text.length<200);assert.doesNotMatch(p.body.text,/sin cargo extra|sin seleccionar|Cada elección/);
    assert.equal(p.action.button,'Ver Salsa');
    for(const row of p.action.sections[0].rows) assert.notEqual(row.description,row.title);
    assert.equal(p.action.sections[0].rows.find(r=>r.title==='Chipotle').description,'+$5');
    assert(payloadInteractivoValido(p,p.body.text));assert.match(b.textoFallback,/Chipotle \(\+\$5\)/);
  });
  await caso('aceptar o rechazar no muestra el precio como cargo del botón',()=>{
    const f=fixture();f.estado.carrito.items=[];
    fijarPendiente(f.estado,{tipo:'aceptar_producto',producto_id:'1',producto:'Chilaquiles Sencillos'});
    const p=f.preparar().carga;
    assert.equal(p.type,'button');
    assert.deepEqual(p.action.buttons.map(b=>b.reply.title),['Sí, agrégalo','No, gracias']);
    assert.match(p.body.text,/Precio base: \$195/);
  });
  await caso('segunda opción desde lista original suma; tercera no desborda',async()=>{
    const f=fixture(),original=opcionesInteractivas(f.ctx);
    await f.aplicar(original.find(o=>o.datos.valor==='Verde'));
    await f.aplicar(original.find(o=>o.datos.valor==='Roja'));
    assert.deepEqual(f.vista().lineas[0].opciones.map(o=>o.opcion),['Verde','Roja']);
    const r=await f.aplicar(original.find(o=>o.datos.valor==='Suiza'));
    assert.match(r.texto,/hasta 2 opciones/);assert.equal(f.vista().lineas[0].opciones.length,2);
    const p=f.preparar().carga;assert.match(p.body.text,/Selección completa/);assert.doesNotMatch(p.body.text,/Elige de/);
    assert.deepEqual(p.action.buttons.map(b=>b.reply.title),['Continuar','Cambiar selección']);
  });
  await caso('dos toques del mismo lote se aplican en una mutación',async()=>{
    const f=fixture(),opciones=opcionesInteractivas(f.ctx).filter(o=>['Roja','Verde'].includes(o.datos.valor));
    const r=await f.aplicar({...opciones[0],elecciones:opciones});
    assert.equal(r.operaciones.filter(o=>o.resultado?.aplicado).length,1);
    assert.equal(f.vista().lineas[0].opciones.length,2);
  });
  await caso('cambiar selección no borra hasta elegir; lista anterior queda invalidada',async()=>{
    const f=fixture(),original=opcionesInteractivas(f.ctx);
    await f.aplicar(original[0]);await f.aplicar(opcionesInteractivas(f.ctx).find(o=>o.accion==='editar_grupo'));
    assert.equal(f.vista().lineas[0].opciones.length,1);assert.equal(adicionDeListaVigente(original[1],f.ctx),null);
    assert.match(f.preparar().carga.body.text,/Reemplazará/);
    await f.aplicar(opcionesInteractivas(f.ctx).find(o=>o.datos.valor==='Suiza'));
    assert.deepEqual(f.vista().lineas[0].opciones.map(o=>o.opcion),['Suiza']);
    assert.equal(f.estado.eleccionInteractiva.editando,false);
  });
  await caso('precio, límites, producto o identidad nuevos invalidan la lista',()=>{
    for(const mutar of [f=>f.ctx.catalogo[0].productos[1].precio=999,
      f=>f.ctx.catalogo[0].productos[1].modificadores[0].maximo=1,
      f=>f.ctx.catalogo[0].productos[1].modificadores[0].opciones[0].precio_extra=12,
      f=>f.ctx.catalogo[0].productos[1].modificadores[0].opciones[0].disponible=false,
      f=>f.estado.eleccionInteractiva.id='otra',f=>f.estado.pendiente.linea_id='otro']){
      const f=fixture(),o=opcionesInteractivas(f.ctx)[0];mutar(f);assert.equal(adicionDeListaVigente(o,f.ctx),null);
    }
  });
  console.log(`Experiencia botones: ${n}/${n}.`);
} finally {if(anterior===undefined)delete process.env.WHATSAPP_INTERACTIVOS;else process.env.WHATSAPP_INTERACTIVOS=anterior;}
