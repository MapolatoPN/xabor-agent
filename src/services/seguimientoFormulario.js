// Vista de solo lectura. Una solicitud INIT no prueba que se dibujó la pantalla;
// un paso guardado tampoco acredita una compra ni presencia en vivo.
const ETAPAS={MENU:'Categorías',PLATILLO:'Personalización',TACOS:'Tacos por cantidad',
  ENTREGA:'Entrega y pago',CARRITO:'Carrito',EDITAR:'Edición de platillo',FINAL:'Envío final pendiente'};
const fecha=v=>{const n=v instanceof Date?v.getTime():Date.parse(v);return Number.isFinite(n)?n:null;};
const iso=v=>{const n=fecha(v);return n===null?null:new Date(n).toISOString();};

export function seguimientoFormulario(fila,{ahora=Date.now(),inactivoMinutos=10}={}) {
  const eventos=(fila.eventos || []).filter(e=>fecha(e.observado_at)!==null)
    .sort((a,b)=>fecha(a.observado_at)-fecha(b.observado_at));
  const apertura=eventos.find(e=>e.tipo==='apertura');
  const pasos=eventos.filter(e=>['apertura','paso','validacion','error_cliente'].includes(e.tipo));
  const ultimo=pasos.at(-1);
  const borrador=Number(fila.revision)>0 && fecha(fila.actualizado_at)!==null;
  // Un borrador pudo copiarse al retomar otra pregunta; actualizado_at por sí
  // solo no acredita una apertura/interacción nueva. Se muestra separado.
  const actividad=ultimo?.observado_at || null;
  const aplicada=fila.estado==='terminada' && fila.resultado?.formulario_aplicado===true && !fila.resultado?.avisada;
  const rechazada=fila.resultado?.formulario_aplicado===false || fila.resultado?.avisada===true;
  const recibida=!!fila.respuesta_recibida;
  const abierta=fila.estado==='disponible' && fila.vigente_dialogo!==false && !aplicada && !rechazada && !recibida;
  const vencida=abierta && fecha(fila.created_at)!==null && ahora-fecha(fila.created_at)>=30*60_000;
  const sinActividad=abierta && !vencida && actividad && ahora-fecha(actividad)>=inactivoMinutos*60_000;
  const codigo=aplicada?'aplicado':rechazada?'no_aplicado':fila.estado==='incierta'?'revision':recibida?'recibido'
    :vencida?'vencido':!abierta?'cerrado':actividad?'iniciado':borrador?'borrador':'sin_evidencia';
  const titulos={aplicado:'Cambios aplicados por Xabor',no_aplicado:'Respuesta no aplicada',recibido:'Respuesta recibida · validación pendiente',
    revision:'Requiere revisión',vencido:'Vigencia vencida · sin finalizar',cerrado:'Formulario sustituido o cerrado',
    iniciado:sinActividad?'Iniciado · sin actividad reciente':'Iniciado · pendiente de finalizar',
    borrador:'Borrador guardado · apertura no registrada',sin_evidencia:'Sin apertura observada'};
  return {codigo,titulo:titulos[codigo],aperturaObservada:iso(apertura?.observado_at),ultimaActividad:iso(actividad),
    paso:ETAPAS[ultimo?.paso] || null,borradorGuardado:!ultimo && borrador?iso(fila.actualizado_at):null,
    minutosSinActividad:actividad?Math.max(0,Math.floor((ahora-fecha(actividad))/60_000)):null,
    sugerirAyuda:!!(abierta && actividad && (sinActividad || vencida)),
    evidencia:ultimo?'endpoint':borrador?'borrador':'no_observada',
    aclaracion:aplicada?'Guardar cambios no confirma ni cobra el pedido.'
      :actividad?'Actividad recibida por el servidor; no indica que siga dentro ni que haya perdido interés.'
        :borrador?'Existe un borrador guardado. Su fecha no demuestra una apertura nueva ni presencia en vivo.'
        :'La falta de evidencia no demuestra que no lo haya abierto.',
    incidencias:eventos.filter(e=>['validacion','error_cliente','no_disponible','error_servidor'].includes(e.tipo)).length};
}

export function vistaFormularioEnviado(foto) {
  if(!foto || !['flow_productos','flow_configurar'].includes(foto.tipo))return null;
  // Proyección explícita: no propagar tokens, IDs de capacidades, notas,
  // domicilios ni datos fiscales. Los precios son los del snapshot enviado.
  const texto=(s,n=100)=>String(s ?? '').slice(0,n);
  const producto=p=>({nombre:texto(p.nombre),precio:Number.isFinite(Number(p.precio))?Number(p.precio):null,
    grupos:(p.grupos || []).slice(0,6).map(g=>({nombre:texto(g.nombre),minimo:g.minimo,maximo:g.maximo,
      opciones:(g.opciones || []).slice(0,30).map(o=>({nombre:texto(o.nombre),extra:Number(o.precio)||0}))}))});
  const lineas=Array.isArray(foto.lineas)?foto.lineas:[];
  const productos=(lineas.length?lineas.map(l=>l.ficha):foto.productos || []).filter(Boolean);
  return {version:texto(foto.version || 'agrupado',40),
    alcance:lineas.length?'Platillos del pedido al enviar':'Catálogo ofrecido al enviar',
    totalProductos:productos.length,productos:productos.slice(0,50).map(producto),
    modalidades:(foto.modalidades || []).map(m=>texto(m.titulo)),pagos:(foto.pagos || []).map(p=>texto(p.titulo))};
}

// Solo la respuesta FINAL recibida por webhook, nunca un borrador sin enviar.
// Los índices solo resuelven el snapshot inmutable de esa misma pregunta.
export function vistaRespuestaFormulario(foto,borrador) {
  if(borrador?.etapa!=='FINAL' || !['carrito_v1','repetible_v1'].includes(foto?.version))return null;
  const items=foto.version==='carrito_v1'?borrador.filas?.map(f=>f.item):borrador.items;
  if(!Array.isArray(items))return null;
  const lineas=items.slice(0,50).flatMap(item=>{
    const m=/^p(0|[1-9]\d*)$/.exec(item?.producto0 || ''),p=m && foto.productos?.[Number(m[1])];
    if(!p || !/^\d{1,3}$/.test(item.cantidad))return [];
    const opciones=(p.grupos || []).flatMap((g,gi)=>{
      const valor=item[`g${gi}_${g.maximo>1?'m':'s'}`],ids=Array.isArray(valor)?valor:[valor];
      const nombres=ids.flatMap(v=>{
        const mm=new RegExp(`^p${m[1]}g${gi}o(0|[1-9]\\d*)$`).exec(v || '');
        const o=mm && g.opciones?.[Number(mm[1])];return o?[String(o.nombre).slice(0,100)]:[];
      });
      return nombres.length?[`${String(g.nombre).slice(0,100)}: ${nombres.join(', ')}`]:[];
    });
    return [{nombre:String(p.nombre).slice(0,100),cantidad:Number(item.cantidad),opciones,
      nota:typeof item.observaciones==='string'?item.observaciones.slice(0,300):''}];
  });
  return {lineas,aclaracion:'Respuesta final recibida. Consulta el resultado de Xabor: recibirla no significa que se haya aplicado ni confirmado.'};
}
