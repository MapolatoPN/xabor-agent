import { createHash } from 'node:crypto';
import { pool } from './database.js';
import { barrerasDeBotones } from '../mesero-agente/interactivos.js';
import { entregarRespuesta } from '../mesero-agente/entregaDeRespuestas.js';
import { referenciaDeConversacion } from './avisoRescateHumano.js';
import { telefonoEnmascarado } from './rescateConversaciones.js';
import { TZ_DEFAULT } from './zonaHoraria.js';
import { ACUSE_COMPROBANTE, BANDERA_COMPROBANTES, SCHEMA_COMPROBANTE, PROMPT_COMPROBANTE,
  validarLecturaComprobante, compararComprobante, declaraComprobante } from '../mesero-agente/compararComprobante.js';

const contrato={nombre:'comprobante-v1',schema:SCHEMA_COMPROBANTE,prompt:PROMPT_COMPROBANTE,validar:validarLecturaComprobante};
const etiquetas={lectura_no_disponible:'no se pudo leer la imagen',imagen_no_corresponde:'la imagen no parece un recibo de pago',
  folio_no_corresponde:'el folio visible no corresponde',varios_folios_visibles:'aparecen varios folios en la imagen',pedido_no_identificado:'no se identificó un pedido',
  varios_pedidos_posibles:'hay varios pedidos posibles',lectura_insuficiente:'imagen ilegible o lectura poco confiable',
  importe_no_visible:'importe no visible',moneda_no_identificada:'moneda no identificada',fecha_no_visible:'fecha no visible',
  operacion_no_concluida:'el recibo no muestra una operación concluida',importe_diferente:'el importe no coincide',
  moneda_diferente:'la moneda no coincide',fecha_diferente:'la fecha no coincide',pedido_cancelado:'el pedido está cancelado'};
async function leerImagen(negocioId,documentoId) {
  const { analizarDocumentoConContrato }=await import('../agent/vision.js');
  return analizarDocumentoConContrato(negocioId,documentoId,contrato);
}

// Se revalida en el emisor Y en el despachador. No es un recibo que pueda
// atravesar una pausa: la persona, el interruptor maestro y el piloto ganan.
export async function permiteAcuseComprobante({db,fila}) {
  const c=fila?.carga || {}, ids=c.comprobante_documentos;
  if(c.texto!==ACUSE_COMPROBANTE || !Array.isArray(ids) || !ids.length || ids.length>2) return false;
  const b=await barrerasDeBotones(db,fila.negocio_id,c.telefono);
  if(!b.activo || b.cfg[BANDERA_COMPROBANTES]!=='true')return false;
  const {rows:[r]}=await db.query(`SELECT count(*)::int cantidad FROM comprobantes_lecturas l
    JOIN documentos d ON d.id=l.documento_id AND d.negocio_id=l.negocio_id
    WHERE l.negocio_id=$1 AND l.telefono=$2 AND l.documento_id=ANY($3::uuid[])
    AND d.telefono=$2 AND d.direccion='entrante' AND d.categoria='imagen'
    AND l.estado='listo' AND l.comparacion->>'acuse'='true'
    AND l.acuse_clave=$4 AND d.created_at>now()-interval '24 hours'`,[fila.negocio_id,c.telefono,ids,fila.evento_clave]);
  return r?.cantidad===new Set(ids).size;
}

export async function consultarPedidosParaComprobante(db,negocioId,telefono,zona,folios=[]) {
  const {rows}=await db.query(`SELECT p.folio,p.estado,p.datos->>'total' total,
    COALESCE(p.datos->>'moneda','MXN') moneda,
    to_char((p.created_at AT TIME ZONE 'UTC') AT TIME ZONE $3,'YYYY-MM-DD') fecha
    FROM pedidos_activos p WHERE p.negocio_id=$1
    AND length(regexp_replace($2,'\\D','','g'))>=10
    AND (right(regexp_replace(COALESCE(p.datos->'cliente'->>'telefono',''),'\\D','','g'),10)=right(regexp_replace($2,'\\D','','g'),10)
      OR right(regexp_replace(COALESCE(p.datos->>'telefono_conversacion',''),'\\D','','g'),10)=right(regexp_replace($2,'\\D','','g'),10))
    AND (p.created_at>=now() AT TIME ZONE 'UTC'-interval '7 days' OR p.folio=ANY($4::text[]))
    ORDER BY p.created_at DESC`,[negocioId,telefono,zona,folios]);
  return rows;
}

// No importa el servidor ni los proveedores de pagos. Solo escribe su lectura,
// el acuse en el outbox y la constancia de revisión humana si hay diferencias.
export async function procesarComprobantesWhatsapp({db=pool,negocioId,telefono,documentoIds=[],texto='',
  analizar=leerImagen,enviar,registrarHistorial,alHumano,broadcastPanel}={}) {
  const declarado=declaraComprobante(texto);
  if(!documentoIds.length && !declarado)return {habilitado:false,atendida:false};
  const b=await barrerasDeBotones(db,negocioId,telefono);
  if(b.cfg[BANDERA_COMPROBANTES]!=='true')return {habilitado:false,atendida:false};
  if(!b.activo)return {habilitado:true,atendida:true,sinRespuesta:true};
  let ids=[...new Set(documentoIds)].slice(0,2);
  // Foto y «es un comprobante» pueden caer en lotes distintos. Recuperar la
  // imagen del mismo remitente no vuelve a enviar un acuse ya comprometido.
  if(!ids.length && declarado) {
    const {rows}=await db.query(`SELECT id FROM documentos WHERE negocio_id=$1 AND telefono=$2
      AND direccion='entrante' AND categoria='imagen' AND created_at>now()-interval '10 minutes'
      ORDER BY created_at DESC LIMIT 1`,[negocioId,telefono]);
    ids=rows.map(d=>d.id);
  }
  const resultados=[];
  for(const id of ids) {
    const {rows:[doc]}=await db.query(`SELECT id,caption FROM documentos WHERE id=$1 AND negocio_id=$2
      AND telefono=$3 AND direccion='entrante' AND categoria='imagen'`,[id,negocioId,telefono]);
    if(!doc)continue;
    const {rows:[existente]}=await db.query('SELECT * FROM comprobantes_lecturas WHERE negocio_id=$1 AND documento_id=$2',[negocioId,id]);
    let comparacion=existente?.comparacion;
    if(existente?.estado!=='listo' || declarado && !comparacion?.acuse) {
      const {rows:[claim]}=await db.query(`INSERT INTO comprobantes_lecturas
        (negocio_id,documento_id,telefono,estado,lease_hasta)
        VALUES($1,$2,$3,'procesando',now()+interval '3 minutes')
        ON CONFLICT(negocio_id,documento_id) DO UPDATE SET estado='procesando',lease_hasta=now()+interval '3 minutes'
        WHERE (comprobantes_lecturas.estado='procesando' AND comprobantes_lecturas.lease_hasta<now())
          OR (comprobantes_lecturas.estado='listo' AND $4::boolean AND comprobantes_lecturas.comparacion->>'acuse' IS DISTINCT FROM 'true')
        RETURNING documento_id`,[negocioId,id,telefono,declarado]);
      if(!claim)return {habilitado:true,atendida:true,sinRespuesta:true};
      let lectura=validarLecturaComprobante(existente?.analisis);
      if(!lectura) {
        try {const r=await analizar(negocioId,id); lectura=r?.ok ? validarLecturaComprobante(r.analisis) : null;}
        catch {lectura=null;}
      }
      const acuse=lectura?.es_comprobante===true || declarado || declaraComprobante(doc.caption);
      let pedidos=[];
      if(acuse)pedidos=await consultarPedidosParaComprobante(db,negocioId,telefono,b.cfg.timezone || TZ_DEFAULT,lectura?.folios || []);
      comparacion={...compararComprobante(lectura,pedidos),acuse};
      if(acuse && lectura?.es_comprobante===false)comparacion={folio:null,coincide:false,revisar:true,motivos:['imagen_no_corresponde'],acuse:true};
      await db.query(`UPDATE comprobantes_lecturas SET estado='listo',analisis=$3::jsonb,
        comparacion=$4::jsonb,folio=$5,updated_at=now() WHERE negocio_id=$1 AND documento_id=$2`,
        [negocioId,id,JSON.stringify(lectura),JSON.stringify(comparacion),comparacion.folio]);
    }
    if(comparacion?.acuse)resultados.push({id,comparacion,acuseClave:existente?.acuse_clave,revisionConfirmada:existente?.revision_confirmada_at});
  }
  if(!resultados.length)return {habilitado:true,atendida:false};
  // Una imagen enviada nuevamente con el mismo wamid/documento no crea otra
  // respuesta. Dos imágenes del mismo lote producen un solo mensaje.
  let clave=resultados[0].acuseClave;
  if(resultados.some(r=>!r.acuseClave)) {
    const tx=await db.connect();
    try {
      await tx.query('BEGIN');
      const {rows:actuales}=await tx.query(`SELECT documento_id,acuse_clave FROM comprobantes_lecturas
        WHERE negocio_id=$1 AND documento_id=ANY($2::uuid[]) ORDER BY documento_id FOR UPDATE`,[negocioId,resultados.map(r=>r.id)]);
      const nuevos=actuales.filter(r=>!r.acuse_clave).map(r=>r.documento_id);
      if(nuevos.length) {
        clave=createHash('sha256').update(`comprobante:${negocioId}:${nuevos.sort().join(':')}`).digest('hex');
        const carga={telefono,texto:ACUSE_COMPROBANTE,comprobante_documentos:nuevos};
        await tx.query(`INSERT INTO agente_outbox(negocio_id,evento_clave,tipo,carga,conversacion_id,turno_clave,disponible_at)
          VALUES($1,$2,'respuesta_cliente',$3::jsonb,$4,$2,now()+interval '30 seconds')
          ON CONFLICT(evento_clave) DO NOTHING`,[negocioId,clave,JSON.stringify(carga),`comprobante:${telefono}`]);
        await tx.query(`UPDATE comprobantes_lecturas SET acuse_clave=$3 WHERE negocio_id=$1
          AND documento_id=ANY($2::uuid[]) AND acuse_clave IS NULL`,[negocioId,nuevos,clave]);
      } else clave=actuales[0].acuse_clave;
      await tx.query('COMMIT');
    } catch(e) {await tx.query('ROLLBACK').catch(()=>{});throw e;}
    finally {tx.release();}
  }
  const entrega=await entregarRespuesta({db,outboxClave:clave,enviar,registrarHistorial,alHumano,politicaRechazo:'no_reintentar'});
  const revision=resultados.filter(r=>r.comparacion.revisar && !r.revisionConfirmada);
  if(revision.length && (await barrerasDeBotones(db,negocioId,telefono)).cfg[BANDERA_COMPROBANTES]==='true') {
    if(typeof alHumano!=='function' || (await alHumano({negocioId,telefono,motivo:'PAGO_COMPROBANTE_REVISION'}))!==true)
      throw Error('COMPROBANTE_REVISION_NO_CONFIRMADA');
    await db.query(`UPDATE comprobantes_lecturas SET revision_confirmada_at=now()
      WHERE negocio_id=$1 AND documento_id=ANY($2::uuid[])`,[negocioId,revision.map(r=>r.id)]);
    if(typeof broadcastPanel==='function') {
      const folios=[...new Set(revision.map(r=>r.comparacion.folio).filter(Boolean))];
      await broadcastPanel(negocioId,{tipo:'rescate_humano',telefono:telefonoEnmascarado(telefono),
        ref:referenciaDeConversacion(negocioId,telefono),motivo:'PAGO_COMPROBANTE_REVISION',prioridad:'alta',
        razon:`Revisar comprobante${folios.length?` de ${folios.join(', ')}`:''}: ${[...new Set(revision.flatMap(r=>r.comparacion.motivos))].map(m=>etiquetas[m] || 'comparación pendiente').join(', ')}. Conservar el pedido y verificar el pago registrado.`});
    }
  }
  return {habilitado:true,atendida:true,entrega:entrega.estado,comparaciones:resultados.map(r=>r.comparacion)};
}
