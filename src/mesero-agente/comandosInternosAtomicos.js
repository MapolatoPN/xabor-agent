import { accionInteractiva } from './autoridadInteractiva.js';

// Solo para adaptadores que YA verificaron la selección estructurada. No es
// una herramienta del modelo ni una ruta HTTP. No admite efectos externos.
export async function aplicarComandosInternos(comandos,ctx,{motivo='formulario_verificado',cerrarEleccion=false}={}) {
  const internas=new Set(['agregar_producto','modificar_linea','quitar_linea','definir_entrega','definir_pago']);
  if(!Array.isArray(comandos) || comandos.length>450 || comandos.some(c=>!internas.has(c.herramienta)))return {ok:false};
  const {crearEjecutor}=await import('./ejecutorDeHerramientas.js');
  const copia=structuredClone(ctx.estado);
  const ejecutor=crearEjecutor({...ctx,estado:copia,mensaje:'',efectos:null});
  const operaciones=[];
  let nuevaLinea=null;
  for(const c of comandos) {
    const argumentos=c.lineaNueva ? {...c.argumentos,linea_id:nuevaLinea} : c.argumentos;
    if(c.lineaNueva && !nuevaLinea)return {ok:false};
    const anteriores=new Set(copia.carrito.items.map(i=>i.lid));
    const a=accionInteractiva(c.herramienta,argumentos,copia);
    const r=await ejecutor.ejecutar(c.herramienta,argumentos,{autorizacion:a.autorizacion});
    if(!r?.aplicado || r.parcial)return {ok:false};
    if(c.herramienta==='agregar_producto') {
      const nuevas=copia.carrito.items.filter(i=>!anteriores.has(i.lid));
      if(nuevas.length!==1)return {ok:false};
      nuevaLinea=nuevas[0].lid;
    }
    operaciones.push({...c,argumentos,resultado:r,origen:'determinista',motivo});
  }
  if(cerrarEleccion) {delete copia.eleccionInteractiva;delete ctx.estado.eleccionInteractiva;}
  Object.assign(ctx.estado,copia);
  return {ok:true,operaciones};
}
