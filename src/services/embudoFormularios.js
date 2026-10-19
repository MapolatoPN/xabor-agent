import { validarPeriodo } from './embudoConversaciones.js';

// Una unidad = ciclo de compra al que se entregó al menos un formulario.
// Reenviarlo/retomarlo no aumenta el denominador. El resultado no lleva PII.
export function resumirFormularios(filas=[]) {
  const ciclos=new Map();
  for(const f of filas){
    const k=JSON.stringify([f.session_id,f.ciclo]);
    if(!ciclos.has(k))ciclos.set(k,[]);ciclos.get(k).push(f);
  }
  const r={ciclosOfrecidos:ciclos.size,formulariosEntregados:filas.length,conActividadObservada:0,
    sinAperturaObservada:0,finalizadosEnEndpoint:0,respuestasAplicadas:0,pedidosRegistrados:0,
    pagosConfirmados:0,conAtencionHumana:0,conPedidoManualPosterior:0,incidencias:0,pendientesPorPantalla:{}};
  for(const formularios of ciclos.values()){
    const eventos=formularios.flatMap(f=>f.eventos || []).sort((a,b)=>Date.parse(a.observado_at)-Date.parse(b.observado_at));
    const actividad=eventos.some(e=>['apertura','paso','validacion','error_cliente'].includes(e.tipo));
    if(actividad)r.conActividadObservada++;else r.sinAperturaObservada++;
    const aplicada=formularios.some(f=>f.estado==='terminada' && f.resultado?.formulario_aplicado===true && !f.resultado?.avisada);
    if(eventos.some(e=>e.paso==='FINAL'))r.finalizadosEnEndpoint++;
    if(aplicada)r.respuestasAplicadas++;
    // Un pedido debe tener identidad canónica de ESTE ciclo, no una frase del
    // chat. Pago confirmado es la marca durable del servidor, nunca una imagen.
    const registrado=formularios.some(f=>f.registrado===true);
    if(aplicada && registrado)r.pedidosRegistrados++;
    if(aplicada && registrado && formularios.some(f=>f.pagado===true))r.pagosConfirmados++;
    if(formularios.some(f=>f.humano===true))r.conAtencionHumana++;
    if(formularios.some(f=>f.manual_posterior===true))r.conPedidoManualPosterior++;
    r.incidencias+=eventos.filter(e=>['validacion','error_cliente','no_disponible','error_servidor'].includes(e.tipo)).length;
    if(!aplicada && actividad){
      const ultimo=eventos.filter(e=>['apertura','paso','validacion','error_cliente'].includes(e.tipo)).at(-1);
      const pantalla=ultimo?.pantalla || ultimo?.paso || 'SIN_DETALLE';
      r.pendientesPorPantalla[pantalla]=(r.pendientesPorPantalla[pantalla] || 0)+1;
    }
  }
  r.conversionPorcentaje=r.ciclosOfrecidos?Math.round(r.pedidosRegistrados/r.ciclosOfrecidos*1000)/10:null;
  return r;
}

export async function consultarEmbudoFormularios(db,{slug,desde,hasta}) {
  validarPeriodo(desde,hasta);if(!slug)throw Error('Negocio requerido');
  await db.query('BEGIN READ ONLY');
  try {
    await db.query("SET LOCAL statement_timeout='20s'");
    const {rows:[n]}=await db.query(`SELECT n.id,n.nombre,c.valor AS zona,
      COALESCE((SELECT valor='true' FROM configuracion WHERE negocio_id=n.id AND clave='whatsapp_trazabilidad_formularios_v1'),false) AS trazabilidad
      FROM negocios n JOIN configuracion c ON c.negocio_id=n.id AND c.clave='timezone' WHERE n.slug=$1`,[slug]);
    if(!n)throw Error('Negocio o zona horaria no encontrado');
    const {rows}=await db.query(`SELECT q.session_id,q.ciclo,q.estado,q.resultado,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('tipo',a.tipo,'paso',a.paso,'pantalla',to_jsonb(a)->>'pantalla','observado_at',a.observado_at) ORDER BY a.observado_at)
        FROM agente_actividad_formulario a WHERE a.pregunta_id=q.id AND a.observado_at<($3::date::timestamp AT TIME ZONE $4)),'[]') AS eventos,
      EXISTS(SELECT 1 FROM pedidos_activos p WHERE p.negocio_id=q.negocio_id
        AND p.datos->'origen_agente'->>'conversacion_id'=q.ciclo AND p.estado<>'cancelado'
        AND p.created_at<(($3::date::timestamp AT TIME ZONE $4) AT TIME ZONE 'UTC')) AS registrado,
      EXISTS(SELECT 1 FROM pedidos_activos p WHERE p.negocio_id=q.negocio_id
        AND p.datos->'origen_agente'->>'conversacion_id'=q.ciclo AND p.estado<>'cancelado'
        AND p.datos->>'pago_confirmado'='true'
        AND p.created_at<(($3::date::timestamp AT TIME ZONE $4) AT TIME ZONE 'UTC')) AS pagado,
      EXISTS(SELECT 1 FROM mensajes m WHERE m.negocio_id=q.negocio_id AND m.telefono=o.carga->>'telefono'
        AND m.origen='humano' AND m.direccion='saliente' AND m.timestamp>=(o.entregado_at AT TIME ZONE 'UTC')
        AND m.timestamp<(($3::date::timestamp AT TIME ZONE $4) AT TIME ZONE 'UTC')) AS humano,
      EXISTS(SELECT 1 FROM pedidos_activos p WHERE p.negocio_id=q.negocio_id AND p.datos->>'origen'='manual'
        AND p.datos->'cliente'->>'telefono'=o.carga->>'telefono' AND p.estado<>'cancelado'
        AND p.created_at>=(o.entregado_at AT TIME ZONE 'UTC')
        AND p.created_at<(($3::date::timestamp AT TIME ZONE $4) AT TIME ZONE 'UTC')) AS manual_posterior
      FROM agente_preguntas_interactivas q JOIN agente_outbox o ON o.negocio_id=q.negocio_id AND o.evento_clave=q.outbox_clave
      WHERE q.negocio_id=$1 AND o.estado='entregado' AND o.wamid_salida IS NOT NULL
        AND q.session_id='agente:' || (o.carga->>'telefono')
        AND o.carga->'interactivo'->>'type'='flow'
        AND EXISTS(SELECT 1 FROM agente_botones b WHERE b.pregunta_id=q.id AND b.accion IN ('flow_productos','flow_configurar'))
        AND o.entregado_at>=($2::date::timestamp AT TIME ZONE $4) AND o.entregado_at<($3::date::timestamp AT TIME ZONE $4)`,[n.id,desde,hasta,n.zona]);
    return {negocio:n.nombre,zona:n.zona,desde,hastaExclusivo:hasta,trazabilidadActiva:n.trazabilidad,
      unidad:'Ciclo de compra con formulario entregado; reenvíos del mismo ciclo cuentan una vez.',
      aclaracion:'Actividad del servidor no prueba presencia ni abandono. Pedido manual posterior es una coincidencia por teléfono y periodo, no atribución causal. Pagos usa la marca durable actual; el informe no reconstruye cambios posteriores al periodo.',
      ...resumirFormularios(rows)};
  } finally {await db.query('ROLLBACK');}
}
