// Editor de borrador: ninguna navegación toca el pedido comercial. Solamente
// el recibo final, validado en SQL, se traduce al ejecutor canónico.
import { isDeepStrictEqual } from 'node:util';
import { comandosFormulario, datosPantallaEdicion } from './formularioAgrupado.js';
import { borradorCategorias, cambiarCategorias, respuestaCategorias } from './flowCategorias.js';
import { cantidadFlow } from './catalogoFlowCategorias.js';
import { cambiarDireccion, sinDireccion } from './flowCategorias.js';
import { respuestaBorrador } from './flowRepetible.js';
import { CONTRATO_DIRECCION,cierreConDireccion,datosPantallaDireccion,esDomicilio,sinContratoDireccion } from './direccionFormulario.js';
import { CONTRATO_NOTA,ERROR_NOTA_PEDIDO,cierreConNota,leerNotaPedido,notaInicialEntrega,sinContratoNota } from './notaDelPedido.js';

export const FILAS_PAGINA_CARRITO = 8;
const iguales=(a,b)=>isDeepStrictEqual(a,b);
const compraFoto=f=>({...sinContrato(f),tipo:'flow_productos',version:'repetible_v1',presentacion:'categorias_v1'});
// Validar platillos, entrega y pago sin exigir todavía la dirección ni la nota
// (la compra de platillos no tiene «Entrega y pago»; la nota es del carrito).
const sinContrato=f=>sinContratoNota(sinContratoDireccion(f));
export const codigo=(v,p)=>typeof v==='string' && new RegExp(`^${p}(0|[1-9]\\d*)$`).test(v)?Number(v.slice(p.length)):-1;
export function itemDeLinea(foto,l) {
  const pi=foto.productos.findIndex(p=>p.id===l.ficha.id);
  const item={producto0:`p${pi}`,cantidad:String(l.cantidad),observaciones:l.nota || ''};
  l.ficha.grupos.forEach((g,gi)=>{
    const ids=l.seleccion.filter(o=>o.grupo===g.nombre).map(o=>g.opciones.findIndex(v=>v.nombre===o.opcion));
    item[`g${gi}_${g.maximo>1?'m':'s'}`]=g.maximo>1?ids.map(i=>`p${pi}g${gi}o${i}`):ids.length?`p${pi}g${gi}o${ids[0]}`:'';
  });
  return item;
}
// «Escribir dirección» (fotos anteriores al 4-oct con abrir=DIRECCION): el borrador nace en DIRECCION y el INIT lo lleva al carrito.
const abreEnDireccion=foto=>foto.contrato===CONTRATO_DIRECCION && foto.abrir==='DIRECCION' && esDomicilio(foto.modalidad) && !!foto.pago;
export function borradorCarrito(foto) {
  return {revision:0,etapa:abreEnDireccion(foto)?'DIRECCION':'CARRITO',pagina:0,siguiente:0,
    filas:foto.lineas.map((l,i)=>({key:`e${i}`,item:itemDeLinea(foto,l)})),deshacer:[],
    modalidad:foto.modalidades.findIndex(m=>m.valor===foto.modalidad),pago:foto.pagos.findIndex(p=>p.valor===foto.pago)};
}
const modo=b=>Number.isInteger(b.modalidad)?b.modalidad<0?'':`m${b.modalidad}`:b.modalidad;
const pago=b=>Number.isInteger(b.pago)?b.pago<0?'':`p${b.pago}`:b.pago;
const unir=l=>l.length<2?l.join(''):`${l.slice(0,-1).join(', ')} y ${l.at(-1)}`;

// Qué falta para guardar, con nombres. Incidente 1-oct-2026: cuatro clientes
// tocaron «Guardar» y solo leyeron «Revisa las opciones, entrega y pago»;
// les faltaba la salsa, la tortilla o las listas de Entrega y Forma de pago.
export function faltantesCarrito(foto,b) {
  const platillos=[];
  for(const f of b.filas || []) {
    const l=lineaVista(foto,f);
    const grupos=l.ficha.grupos.filter(g=>l.seleccion.filter(o=>o.grupo===g.nombre).length<g.minimo).map(g=>g.nombre);
    if(grupos.length)platillos.push({nombre:l.ficha.nombre,grupos});
  }
  return {platillos,entrega:!modo(b),pago:!pago(b)};
}
export function textoFaltantesCarrito({platillos=[],entrega=false,pago:sinPago=false,verbo='guardar'}={}) {
  const partes=[];
  const mismos=platillos.length>1 && platillos.every(p=>p.grupos.join('|')===platillos[0].grupos.join('|'));
  if(platillos.length===1)partes.push(`${unir(platillos[0].grupos)} en ${platillos[0].nombre} (ábrelo en «Preparación y notas»)`);
  else if(platillos.length>1)partes.push(`${mismos?unir(platillos[0].grupos):'opciones'} en ${platillos.length} platillos (ábrelos uno por uno en «Preparación y notas»)`);
  const final=[entrega?'Entrega':null,sinPago?'Forma de pago':null].filter(Boolean);
  if(final.length)partes.push(`${unir(final)} (al final de esta pantalla)`);
  return partes.length?`Para ${verbo} falta elegir: ${partes.join('; ')}.`:'';
}
const normalizarItem=i=>Object.fromEntries(Object.entries(i).filter(([,v])=>v!==undefined && v!==null && v!=='' && (!Array.isArray(v)||v.length)).sort(([a],[b])=>a.localeCompare(b)));

export function comandosCarrito(foto,r) {
  const claves=['flow_token','filas','modalidad','pago',...(foto.contrato===CONTRATO_DIRECCION?['direccion']:[]),
    ...(foto.contrato_nota===CONTRATO_NOTA?['nota']:[])];
  if(!r || Object.keys(r).some(k=>!claves.includes(k)) || !Array.isArray(r.filas) || r.filas.length>50)return null;
  const vistas=new Set(),acciones=[];
  for(const fila of r.filas) {
    if(!fila || Object.keys(fila).some(k=>!['key','item'].includes(k)) || vistas.has(fila.key))return null;
    vistas.add(fila.key);
    const ei=codigo(fila.key,'e'),ni=codigo(fila.key,'n'),item=fila.item;
    if(ei<0 && ni<0 || !item || !cantidadFlow(item.cantidad))return null;
    const validadas=comandosFormulario(compraFoto(foto),{items:[item],modalidad:r.modalidad,pago:r.pago});
    if(!validadas)return null;
    if(ei>=0) {
      const l=foto.lineas[ei];if(!l)return null;
      const anterior=itemDeLinea(foto,l);
      if(item.producto0!==anterior.producto0)return null;
      if(iguales(normalizarItem(item),normalizarItem(anterior)))continue;
      const respuesta={linea:`l${ei}`,operacion:'editar',cantidad:item.cantidad,observaciones:item.observaciones ?? '',modalidad:r.modalidad,pago:r.pago};
      for(let g=0;g<6;g++)for(const t of ['s','m']) {
        const v=item[`g${g}_${t}`],prefijo=`${item.producto0}g${g}`;
        if(v!==undefined)respuesta[`g${g}_${t}`]=Array.isArray(v)?v.map(s=>s.replace(prefijo,`l${ei}g${g}`)):v.replace(prefijo,`l${ei}g${g}`);
      }
      const cmds=comandosFormulario({...foto,version:'edicion_v1'},respuesta);
      if(!cmds)return null;acciones.push(...cmds.filter(c=>!['definir_entrega','definir_pago'].includes(c.herramienta)));
    } else acciones.push(...validadas.filter(c=>!['definir_entrega','definir_pago'].includes(c.herramienta)));
  }
  // Identidad estable de cada renglón de la foto, nunca su índice en la lista
  // filtrada ni su nombre. Primero quitar, después editar/agregar.
  const quitar=foto.lineas.flatMap((l,i)=>vistas.has(`e${i}`)?[]:[{herramienta:'quitar_linea',argumentos:{linea_id:l.linea_id}}]);
  // Sin platillos no hay entrega: ni dirección ni nota viajan en el recibo.
  const entrega=r.filas.length?cierreConNota(foto,cierreConDireccion(foto,comandosFormulario({...foto,version:undefined,tipo:'flow_configurar',lineas:[]},
    {modalidad:r.modalidad,pago:r.pago}),r.direccion),r.nota):r.direccion===undefined && r.nota===undefined?[]:null;
  return entrega?[...quitar,...acciones,...entrega]:null;
}

export function cambiarCarrito(foto,anterior,s) {
  const b=structuredClone(anterior),d=s.data;
  // El aviso «Listo: agregamos…» se dibuja una sola vez: cualquier escritura lo borra.
  delete b.aviso_agregado;
  const fallo=error=>({borrador:structuredClone(anterior),error});
  // [M] 4-oct: toda apertura (INIT) es el CARRITO, la primera pantalla; el
  // teléfono rechaza un INIT que abre otra («invalid-screen-transition»; uno de
  // categorias_v1 que abría en ENTREGA dio aviso). Reabierto o retomado a medias
  // (menú, tacos, platillo, edición, entrega o dirección) y «Escribir dirección»
  // vuelven al carrito: filas, entrega, pago, dirección y nota se conservan.
  if(s.action==='INIT' && !['CARRITO','FINAL'].includes(b.etapa)) {
    b.etapa='CARRITO';delete b.compra;delete b.editando;b.revision++;return {borrador:b};
  }
  if(s.action==='INIT' || b.etapa==='FINAL')return {borrador:b};
  if(s.action==='BACK') {
    if(s.screen!==b.etapa)return {borrador:b};
    if(b.etapa==='EDITAR' || b.etapa==='MENU' || b.etapa==='ENTREGA') {b.etapa='CARRITO';delete b.compra;b.revision++;}
    // A la dirección se llega desde «Entrega y pago» (contrato direccion_v1).
    else if(b.etapa==='DIRECCION') {b.etapa='ENTREGA';b.revision++;}
    else if(['PLATILLO','TACOS'].includes(b.etapa)) {
      const r=cambiarCategorias(compraFoto(foto),b.compra,s);b.compra=r.borrador;b.etapa=b.compra.etapa;b.revision++;
      b.compra.revision=b.revision;
    }
    return {borrador:b};
  }
  if(s.action!=='data_exchange' || !d || Array.isArray(d) || typeof d!=='object'
    || d.revision!==String(b.revision) || s.screen!==b.etapa)return fallo('La ventana cambió. Revisa el carrito actual.');
  const recordar=()=>{b.deshacer=[...(b.deshacer || []),{filas:structuredClone(anterior.filas),modalidad:anterior.modalidad,pago:anterior.pago}].slice(-10);};
  if(b.etapa==='CARRITO') {
    // Con el contrato direccion_v1 la entrega y el pago no están en esta pantalla.
    const permitidos=new Set(['revision','operacion','pagina','editar',...(foto.duplicar?['duplicar']:[]),
      ...(foto.contrato===CONTRATO_DIRECCION?[]:['modalidad','pago']),...Array.from({length:FILAS_PAGINA_CARRITO},(_,i)=>`q${i}`)]);
    if(Object.keys(d).some(k=>!permitidos.has(k)))return fallo('Selección no disponible.');
    if(d.operacion==='deshacer') {
      const previo=b.deshacer.pop();if(!previo)return fallo('No hay cambios guardados en esta ventana para deshacer.');
      // Con el contrato direccion_v1 la entrega y el pago se eligen en su propia
      // pantalla: deshacer en el carrito solo devuelve los platillos.
      Object.assign(b,foto.contrato===CONTRATO_DIRECCION?{filas:previo.filas}:previo);
    } else {
      const pagina=b.filas.slice(b.pagina*FILAS_PAGINA_CARRITO,(b.pagina+1)*FILAS_PAGINA_CARRITO),quitar=new Set();
      for(let i=0;i<FILAS_PAGINA_CARRITO;i++) {
        const q=d[`q${i}`];
        if(!pagina[i]) {if(![undefined,null,''].includes(q))return fallo('El carrito cambió.');continue;}
        if(q===undefined)continue;
        if(q==='0')quitar.add(pagina[i].key);
        else if(cantidadFlow(q))pagina[i].item.cantidad=q;
        else return fallo('Elige una cantidad o «0 · Quitar».');
      }
      b.filas=b.filas.filter(f=>!quitar.has(f.key));
      for(const [key,prefix,lista] of [['modalidad','m',foto.modalidades],['pago','p',foto.pagos]])if(d[key]!==undefined) {
        if(!lista[codigo(d[key],prefix)])return fallo('Revisa entrega y pago.');b[key]=d[key];
      }
      if(!iguales(anterior.filas,b.filas) || anterior.modalidad!==b.modalidad || anterior.pago!==b.pago)recordar();
      if(d.operacion==='guardar' && foto.contrato===CONTRATO_DIRECCION) {
        // Contrato direccion_v1 («Continuar»): aquí solo los platillos. La
        // entrega y el pago se eligen en su pantalla, obligatorios; los índices
        // m0/p0 solo satisfacen la validación pura y nunca se guardan.
        if(b.filas.length && !comandosCarrito(sinContrato(foto),{filas:b.filas,modalidad:'m0',pago:'p0'}))
          return fallo(textoFaltantesCarrito({platillos:faltantesCarrito(foto,b).platillos,verbo:'continuar'})
            || 'Revisa las opciones de tus platillos antes de continuar.');
        b.modalidad=modo(b);b.pago=pago(b);
        // Carrito vacío: se guarda como hoy, sin entrega ni dirección.
        b.etapa=b.filas.length?'ENTREGA':'FINAL';
        if(b.etapa==='FINAL')sinDireccion(b);
      } else if(d.operacion==='guardar') {
        if(!comandosCarrito(sinContrato(foto),{filas:b.filas,modalidad:modo(b),pago:pago(b)}))
          return fallo(textoFaltantesCarrito(faltantesCarrito(foto,b)) || 'Revisa las opciones, entrega y pago antes de guardar.');
        b.modalidad=modo(b);b.pago=pago(b);b.etapa='FINAL';
      } else if(d.operacion==='agregar') {
        if(b.filas.length>=50)return fallo('El carrito admite hasta 50 renglones. Puedes aumentar cantidades.');
        b.compra=borradorCategorias();b.compra.revision=b.revision+1;b.etapa='MENU';
      } else if(d.operacion==='pagina') {
        const n=codigo(d.pagina,'p');if(n<0 || n>=Math.ceil(Math.max(1,b.filas.length)/FILAS_PAGINA_CARRITO))return fallo('Página no disponible.');b.pagina=n;
      } else if(d.operacion==='editar') {
        if(!b.filas.some(f=>f.key===d.editar))return fallo(foto.contrato===CONTRATO_DIRECCION
          ?'Ese platillo se quitó. Toca «Continuar» o deshaz el cambio.':'Ese platillo se quitó. Guarda el carrito o deshaz el cambio.');
        b.editando=d.editar;b.etapa='EDITAR';
      } else if(d.operacion==='duplicar' && foto.duplicar===true) {
        const origen=b.filas.find(f=>f.key===d.duplicar);
        if(!origen)return fallo('Ese platillo ya no está en el carrito.');
        if(b.filas.length>=50)return fallo('El carrito admite hasta 50 renglones. Puedes aumentar cantidades.');
        // Copia UNA unidad, no un lote entero. Se puede personalizar por
        // separado; no hereda identidad de línea ni precio del cliente.
        if(iguales(anterior.filas,b.filas) && anterior.modalidad===b.modalidad && anterior.pago===b.pago)recordar();
        b.filas.push({key:`n${b.siguiente++}`,item:{...structuredClone(origen.item),cantidad:'1'}});
        b.pagina=Math.floor((b.filas.length-1)/FILAS_PAGINA_CARRITO);
      } else return fallo('Acción no disponible.');
    }
  } else if(b.etapa==='EDITAR') {
    const fila=b.filas.find(f=>f.key===b.editando),pi=codigo(fila?.item.producto0,'p');
    if(!fila || d.operacion!=='aplicar_opciones' || Object.keys(d).some(k=>!['revision','operacion','cantidad','observaciones',...Array.from({length:6},(_,i)=>[`g${i}_s`,`g${i}_m`]).flat()].includes(k)))return fallo('Selección no disponible.');
    const item={producto0:`p${pi}`,...Object.fromEntries(Object.entries(d).filter(([k])=>!['revision','operacion'].includes(k)))};
    for(let g=0;g<6;g++)for(const t of ['s','m']) {
      const v=item[`g${g}_${t}`];
      const convertir=id=>typeof id==='string' && /^l0g[0-5]o\d+$/.test(id)?id.replace(/^l0/,`p${pi}`):id;
      if(v!==undefined)item[`g${g}_${t}`]=Array.isArray(v)?v.map(convertir):convertir(v);
    }
    // Validar el platillo no exige haber elegido entrega/pago todavía. Estos
    // índices solo satisfacen la validación pura y nunca se guardan/aplican;
    // la finalización sigue exigiendo las elecciones reales del cliente.
    if(!comandosFormulario(compraFoto(foto),{items:[item],modalidad:'m0',pago:'p0'}))return fallo('Completa las opciones del platillo.');
    recordar();fila.item=item;b.etapa='CARRITO';
  } else if(b.etapa==='ENTREGA') {
    // «Entrega y pago» (contrato direccion_v1): las dos listas son obligatorias.
    // Con el contrato nota_v1 también llega la nota del pedido (opcional).
    const conNota=foto.contrato_nota===CONTRATO_NOTA;
    if(foto.contrato!==CONTRATO_DIRECCION || d.operacion!=='revisar'
      || Object.keys(d).some(k=>!['revision','operacion','modalidad','pago',...(conNota?['nota']:[])].includes(k)))return fallo('Selección no disponible.');
    const nota=conNota?leerNotaPedido(d.nota):undefined;
    if(nota===null)return fallo(ERROR_NOTA_PEDIDO);
    if(!foto.modalidades[codigo(d.modalidad,'m')] || !foto.pagos[codigo(d.pago,'p')])return fallo('Elige la entrega y la forma de pago.');
    if(!comandosCarrito(sinContrato(foto),{filas:b.filas,modalidad:d.modalidad,pago:d.pago}))return fallo('Revisa el carrito antes de continuar.');
    b.modalidad=d.modalidad;b.pago=d.pago;
    // Se guarda ya saneada; Atrás desde la dirección la vuelve a mostrar.
    if(conNota)b.nota=nota;
    b.etapa=esDomicilio(foto.modalidades[codigo(d.modalidad,'m')]?.valor)?'DIRECCION':'FINAL';
    // Sin domicilio no viaja dirección: la de un aviso anterior rechazaría el recibo entero.
    if(b.etapa==='FINAL')sinDireccion(b);
  } else if(b.etapa==='DIRECCION') {
    // La entrega y el pago se guardaron al pasar por aquí, o venían del pedido
    // cuando el formulario abrió directo en la dirección.
    b.modalidad=modo(b);b.pago=pago(b);
    if(!comandosCarrito(sinContrato(foto),{filas:b.filas,modalidad:b.modalidad,pago:b.pago})
      || !esDomicilio(foto.modalidades[codigo(b.modalidad,'m')]?.valor))return fallo('Revisa el carrito antes de escribir la dirección.');
    const paso=cambiarDireccion(foto,b,d);
    if(paso.error)return paso.borrador.revision===anterior.revision?fallo(paso.error):paso;
    return paso;
  } else {
    if(b.etapa==='MENU' && d.operacion==='terminar' && Object.keys(d).every(k=>['revision','operacion'].includes(k))) {
      b.etapa='CARRITO';delete b.compra;b.revision++;return {borrador:b};
    }
    const paso=cambiarCategorias(compraFoto(foto),b.compra,s);
    if(paso.error)return fallo(paso.error);
    b.compra=paso.borrador;b.etapa=b.compra.etapa;
    const agregados=b.compra.items;
    if(agregados.length) {
      if(b.filas.length+agregados.length>50)return fallo('El carrito admite hasta 50 renglones.');
      recordar();b.filas.push(...agregados.map(item=>({key:`n${b.siguiente++}`,item})));b.compra.items=[];
    }
    // «Agregar al carrito» y «Agregar más» regresan al MENU, la pantalla de antes,
    // con el aviso de lo agregado; «Ver carrito» lleva al carrito. [M] 4-oct: del
    // platillo o los tacos al CARRITO (no vecinas) el teléfono daba error, 3 de 3
    // veces con clientes reales, aunque el platillo sí quedaba agregado.
    if(b.etapa==='ENTREGA' || ['agregar','terminar'].includes(d.operacion)) {b.etapa='MENU';b.compra=borradorCategorias();}
    if(agregados.length && b.etapa==='MENU')b.aviso_agregado=avisoAgregado(foto,b,agregados);
  }
  b.pagina=Math.min(b.pagina,Math.max(0,Math.ceil(b.filas.length/FILAS_PAGINA_CARRITO)-1));
  b.revision++;if(b.compra)b.compra.revision=b.revision;
  return {borrador:b};
}

/** «Listo: agregamos 2 × Taco de Pastor y 1 × Café americano.» (con más de tres, «… y N más»). */
function avisoAgregado(foto,b,items) {
  const nombres=items.map(i=>`${i.cantidad} × ${foto.productos[codigo(i.producto0,'p')]?.nombre || 'platillo'}`);
  return `Listo: agregamos ${nombres.length>3?`${nombres.slice(0,2).join(', ')} y ${nombres.length-2} más`:unir(nombres)}.`;
}

export function lineaVista(foto,fila) {
  const p=foto.productos[codigo(fila.item.producto0,'p')],seleccion=[];
  p.grupos.forEach((g,gi)=>{
    const v=fila.item[`g${gi}_${g.maximo>1?'m':'s'}`];
    for(const id of Array.isArray(v)?v:v?[v]:[]) {
      const o=g.opciones[codigo(id,`${fila.item.producto0}g${gi}o`)];if(o)seleccion.push({grupo:g.nombre,opcion:o.nombre,precio:o.precio});
    }
  });
  return {ficha:p,cantidad:Number(fila.item.cantidad),seleccion,nota:fila.item.observaciones || ''};
}
export function respuestaCarrito(foto,b,token,error='',seleccion=null) {
  if(b.etapa==='FINAL')return {screen:'SUCCESS',data:{extension_message_response:{params:{flow_token:token,revision:String(b.revision)}}}};
  if(b.etapa==='DIRECCION')return {screen:'DIRECCION',data:datosPantallaDireccion(foto,{revision:b.revision,
    resumen:'Escribe dónde entregamos tu pedido.',error,guardada:b.direccion,aviso:b.aviso_direccion,
    intento:error && seleccion?.revision===String(b.revision)?seleccion:null})};
  const intento=error && seleccion?.revision===String(b.revision)?seleccion:null;
  if(b.etapa==='ENTREGA') {
    // La misma pantalla y los mismos datos que «Entrega y pago» de «Arma tu pedido».
    const r=respuestaBorrador(compraFoto(foto),{etapa:'ENTREGA',revision:b.revision,items:[],modalidad:modo(b),pago:pago(b)},token,error);
    const unidades=b.filas.reduce((n,f)=>n+Number(f.item.cantidad),0);
    r.data.resumen=`Tu carrito: ${unidades} pieza${unidades===1?'':'s'}. Elige cómo lo recibes y cómo pagas.`;
    // Un intento rechazado conserva lo que eligió en esa pantalla.
    if(foto.modalidades[codigo(intento?.modalidad,'m')])r.data.modalidad_inicial=intento.modalidad;
    if(foto.pagos[codigo(intento?.pago,'p')])r.data.pago_inicial=intento.pago;
    // Solo el Flow con la nota la declara: sin el contrato no se manda.
    if(foto.contrato_nota===CONTRATO_NOTA)r.data.nota_inicial=notaInicialEntrega(foto,b,intento);
    return r;
  }
  if(!['CARRITO','EDITAR'].includes(b.etapa)) {
    const r=respuestaCategorias(compraFoto(foto),b.compra,token,error,seleccion);
    if(r.screen==='MENU') {
      // El MENU del carrito dice cuánto lleva y cómo seguir (su lista de compra siempre está vacía).
      const piezas=b.filas.reduce((n,f)=>n+Number(f.item.cantidad),0);
      if(piezas)r.data.resumen=`Tu carrito: ${piezas} pieza${piezas===1?'':'s'}. Toca «Ver carrito» o elige una categoría.`;
      // Tras agregar, qué se agregó (en el TextBody del error, que el MENU ya declara).
      if(!error && b.aviso_agregado) {r.data.error=b.aviso_agregado;r.data.error_visible=true;}
    }
    return r;
  }
  const comunes={revision:String(b.revision),error,error_visible:!!error};
  if(b.etapa==='EDITAR') {
    const fila=b.filas.find(f=>f.key===b.editando),l=lineaVista(foto,fila);
    const d=datosPantallaEdicion({...foto,version:'edicion_v1',lineas:[l]});
    const {lineas,...base}=d;
    const data={...base,...lineas[0]['on-select-action'].payload,...comunes};
    if(intento) {
      if(cantidadFlow(intento.cantidad))data.cantidad_inicial=intento.cantidad;
      if(typeof intento.observaciones==='string' && intento.observaciones.length<=300)data.observaciones_inicial=intento.observaciones;
      for(let g=0;g<6;g++) {
        const ids=new Set(data[`g${g}_opciones`].map(o=>o.id));
        if(data[`g${g}_simple`] && ids.has(intento[`g${g}_s`]))data[`g${g}_inicial_s`]=intento[`g${g}_s`];
        if(data[`g${g}_multiple`] && Array.isArray(intento[`g${g}_m`]))data[`g${g}_inicial_m`]=[...new Set(intento[`g${g}_m`].filter(id=>ids.has(id)))].slice(0,data[`g${g}_max`]);
      }
    }
    return {screen:'EDITAR',data};
  }
  const unidades=b.filas.reduce((n,f)=>n+Number(f.item.cantidad),0);
  const data={...comunes,resumen:b.filas.length?`${b.filas.length} renglones · ${unidades} piezas`:'Tu carrito está vacío',
    pagina_inicial:`p${b.pagina}`,paginas:Array.from({length:Math.max(1,Math.ceil(b.filas.length/FILAS_PAGINA_CARRITO))},(_,i)=>({id:`p${i}`,title:`Página ${i+1}`})),
    editar:b.filas.map((f,i)=>({id:f.key,title:`${i+1}. ${lineaVista(foto,f).ficha.nombre}`.slice(0,30)})),
    hay_items:!!b.filas.length,puede_deshacer:!!b.deshacer.length,puede_agregar:b.filas.length<50,
    modalidades:foto.modalidades.map((m,i)=>({id:`m${i}`,title:m.titulo})),pagos:foto.pagos.map((p,i)=>({id:`p${i}`,title:p.titulo})),
    // Un «Guardar» rechazado no borra la entrega y el pago que el cliente ya
    // eligió en ese intento: el borrador vuelve atrás, sus listas no.
    modalidad_inicial:foto.modalidades[codigo(intento?.modalidad,'m')]?intento.modalidad:modo(b),
    pago_inicial:foto.pagos[codigo(intento?.pago,'p')]?intento.pago:pago(b)};
  if(foto.duplicar)data.puede_duplicar=!!b.filas.length && b.filas.length<50;
  let subtotal=0;
  b.filas.forEach(f=>{const l=lineaVista(foto,f);subtotal+=Math.round((l.ficha.precio+l.seleccion.reduce((n,o)=>n+o.precio,0))*100)*l.cantidad;});
  const faltaElegir=[!data.modalidad_inicial?'Entrega':null,!data.pago_inicial?'Forma de pago':null].filter(Boolean);
  data.importe=(faltaElegir.length?`Para guardar elige ${unir(faltaElegir)} aquí arriba. `:'')
    +`Productos: $${(subtotal/100).toFixed(2)}. Envío y promociones se recalculan al guardar; no es el total final.`;
  if(foto.contrato===CONTRATO_DIRECCION) {
    // La entrega y el pago tienen su pantalla: aquí ni se piden ni se declaran.
    for(const k of ['modalidades','pagos','modalidad_inicial','pago_inicial'])delete data[k];
    data.importe=`Productos: $${(subtotal/100).toFixed(2)}. Envío y promociones se calculan al revisar el pedido; no es el total final.`;
  }
  for(let i=0;i<FILAS_PAGINA_CARRITO;i++) {
    const fila=b.filas[b.pagina*FILAS_PAGINA_CARRITO+i],l=fila?lineaVista(foto,fila):null;
    data[`r${i}_visible`]=!!fila;data[`r${i}_titulo`]=l?l.ficha.nombre:'Platillo';
    const faltantes=l?l.ficha.grupos.filter(g=>l.seleccion.filter(o=>o.grupo===g.nombre).length<g.minimo).map(g=>g.nombre):[];
    data[`r${i}_detalle`]=l?[...l.seleccion.map(o=>o.opcion),l.nota,
      faltantes.length?`Falta completar: ${faltantes.join(', ')}. Abre Preparación y notas.`:''].filter(Boolean).join(' · '):'';
    data[`q${i}_inicial`]=fila && intento && (intento[`q${i}`]==='0' || cantidadFlow(intento[`q${i}`]))?intento[`q${i}`]:fila?.item.cantidad || '';
  }
  return {screen:'CARRITO',data};
}
