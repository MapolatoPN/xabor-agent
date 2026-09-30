// Puente de catálogo Meta -> borrador Xabor. No sincroniza ni publica activos.
// El mapa es configuración DEL NEGOCIO; nunca se infiere un ID de un nombre,
// del retailer_id, del modelo ni de una posición en una lista regenerada.
import { betaHibridaActiva } from './experienciaHibrida.js';
import { fichaPorId } from './vistaDelPedido.js';
import { aplicarComandosInternos } from './comandosInternosAtomicos.js';
import { validarOpciones } from './ejecutorDeHerramientas.js';
const obj=v=>v && typeof v==='object' && !Array.isArray(v);
const dinero=v=>/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(String(v)) ? Math.round(Number(v)*100) : null;
export const catalogoNativoActivo=(cfg,t)=>betaHibridaActiva(cfg,t) && cfg?.whatsapp_catalogo_nativo_v1==='true';

export function resolverCarritoNativo({mensajes,telefono,cfg,catalogo,estado}) {
  const no=(motivo,texto)=>({ok:false,motivo,texto,comandos:[]});
  if(!catalogoNativoActivo(cfg,telefono))return no('apagado','');
  if(estado.folio || estado.evento || estado.programacionRequerida || estado.confirmacionIncierta
    || Object.values(estado.hechos || {}).some(Boolean))return no('no_editable','Este pedido no puede modificarse desde el catálogo. Pide ayuda al equipo.');
  if(estado.carrito?.items?.length)return no('carrito_existente','Tu pedido guardado ya tiene platillos. No sumé otro carrito para evitar duplicados. Escribe «seguir pedido» para editarlo.');
  if(!Array.isArray(mensajes) || mensajes.length!==1)return no('lote_multiple','Recibí más de una selección junta. No agregué platillos; envía un solo carrito para continuar.');
  const m=mensajes[0],o=m?.order;
  if(m?.type!=='order' || m.from!==telefono || typeof m.id!=='string' || !m.id || m.id.length>512 || !obj(o)
    || typeof o.catalog_id!=='string' || !/^\d{5,30}$/.test(o.catalog_id) || o.catalog_id!==cfg.whatsapp_catalogo_meta_id)
    return no('catalogo_ajeno','No pude verificar este catálogo para el restaurante. No agregué platillos; podemos usar el formulario del pedido.');
  if(o.text && (typeof o.text!=='string' || o.text.trim()))return no('nota_sin_asignar','La selección incluye una nota. Para asignarla al platillo correcto, usa el formulario con observaciones; no agregué este carrito.');
  let mapa;
  try {mapa=JSON.parse(cfg.whatsapp_catalogo_meta_mapa || 'null');} catch {return no('mapa_invalido','El catálogo necesita una revisión. Puedes ordenar con el formulario.');}
  if(!Array.isArray(mapa) || !mapa.length || mapa.length>200 || mapa.some(x=>!obj(x)
    || typeof x.retailer_id!=='string' || !x.retailer_id || x.retailer_id.length>100 || !/^\d+$/.test(String(x.producto_id))
    || !Array.isArray(x.opciones) || x.opciones.length>30)
    || new Set(mapa.map(x=>x.retailer_id)).size!==mapa.length)return no('mapa_invalido','El catálogo necesita una revisión. Puedes ordenar con el formulario.');
  if(!Array.isArray(o.product_items) || !o.product_items.length || o.product_items.length>50)
    return no('limite','Envía entre 1 y 50 renglones; puedes elegir de 1 a 20 piezas por renglón.');
  const comandos=[],vistos=new Set();
  for(const item of o.product_items) {
    const cantidad=/^(?:[1-9]|1\d|20)$/.test(String(item?.quantity))?Number(item.quantity):null;
    if(!obj(item) || !cantidad || typeof item.product_retailer_id!=='string' || vistos.has(item.product_retailer_id)
      || item.currency!=='MXN' || dinero(item.item_price)===null)return no('item_invalido','No pude validar todas las cantidades y precios. No agregué platillos; revisa el carrito.');
    vistos.add(item.product_retailer_id);
    const vinculada=mapa.find(p=>p.retailer_id===item.product_retailer_id),f=vinculada && fichaPorId(catalogo,vinculada.producto_id);
    if(!f || vinculada.opciones.some(e=>!obj(e) || typeof e.grupo!=='string' || typeof e.opcion!=='string')
      || new Set(vinculada.opciones.map(e=>JSON.stringify([e.grupo,e.opcion]))).size!==vinculada.opciones.length
      || !validarOpciones(f,vinculada.opciones).ok)return no('no_disponible','Uno de los productos u opciones ya no está disponible. No agregué el carrito; revisa el menú actualizado.');
    const base=dinero(f.precio),extras=vinculada.opciones.map(e=>{
      const real=f.grupos.find(g=>g.nombre===e.grupo)?.opciones.find(v=>v.nombre===e.opcion);
      return real?dinero(real.precio_extra ?? 0):null;
    });
    if(base===null || extras.includes(null) || dinero(item.item_price)!==base+extras.reduce((a,b)=>a+b,0))
      return no('precio_cambio','El precio del catálogo no coincide con el precio vigente. No agregué platillos; usa el formulario para revisar el precio actualizado.');
    comandos.push({herramienta:'agregar_producto',argumentos:{producto_id:String(f.id),cantidad}});
    if(vinculada.opciones.length)comandos.push({herramienta:'modificar_linea',argumentos:{opciones:vinculada.opciones},lineaNueva:true});
  }
  return {ok:true,comandos};
}

export async function aplicarCarritoNativo(ctx) {
  const seleccion=resolverCarritoNativo(ctx);
  if(!seleccion.ok)return seleccion;
  const aplicada=await aplicarComandosInternos(seleccion.comandos,ctx,{motivo:'catalogo_nativo_verificado',cerrarEleccion:true});
  return aplicada.ok?aplicada:{ok:false,motivo:'rechazo_canonico',texto:'No pude guardar esa selección completa. Tu pedido no cambió; podemos usar el formulario.'};
}
