const text=(name,label,max,helper,type='text')=>({type:'TextInput',name,label,required:true,
  'input-type':type,'max-chars':max,...(helper?{'helper-text':helper}:{})});
export function definicionFlowServicio(servicio) {
  if(!['facturacion','evento'].includes(servicio))throw Error('Servicio desconocido');
  const factura=servicio==='facturacion';
  const campos=factura ? [
    text('nombre','Nombre o razón social',150,'Como aparece en tu constancia fiscal.'),
    text('rfc','RFC',13,'12 o 13 caracteres, sin espacios.'),
    text('codigo_postal','Código postal fiscal',5,'Cinco dígitos. No es la dirección de entrega.','number'),
    text('regimen','Régimen fiscal',120,'Código o nombre de tu régimen fiscal.'),
    text('uso_cfdi','Uso de CFDI',100,'Código o nombre del uso solicitado.'),
    text('correo','Correo electrónico',150,'Aquí deseas recibir la factura.','email'),
    text('referencia','Referencia de compra',120,'Folio del ticket; si no lo tienes, indica fecha y monto.'),
  ] : [
    text('nombre','Tu nombre',100),text('tipo_evento','Tipo de evento',100,'Por ejemplo: cumpleaños o reunión de trabajo.'),
    {type:'DatePicker',name:'fecha',label:'Fecha del evento',required:true},
    text('hora','Hora del evento',5,'Formato 24 horas, por ejemplo 14:30.'),
    text('personas','Número de personas',4,'Cantidad estimada, entre 1 y 9999.','number'),
    text('ubicacion','Lugar del evento',200,'Ciudad, zona o dirección donde necesitas el servicio.'),
    {type:'TextArea',name:'detalles',label:'Servicio que necesitas',required:true,'max-length':500,
      'helper-text':'Comida, tipo de servicio y cualquier detalle importante.'},
  ];
  return {version:'7.3',screens:[{id:'SERVICIO',title:factura?'Datos de facturación':'Servicio para eventos',terminal:true,success:true,data:{},
    layout:{type:'SingleColumnLayout',children:[{type:'Form',name:'servicio',children:[
      {type:'TextBody',text:factura
        ? 'Usaremos estos datos para revisar tu solicitud de factura. No compartas contraseñas ni archivos de e.firma. Enviar no emite una factura.'
        : 'Usaremos estos datos para atender tu evento por este chat. El equipo revisará disponibilidad y cotización. Enviar no confirma una reserva.'},
      ...campos,{type:'Footer',label:'Enviar al personal','on-click-action':{name:'complete',
        payload:Object.fromEntries(campos.map(c=>[c.name,'${form.'+c.name+'}']))}},
    ]}]}}]};
}
