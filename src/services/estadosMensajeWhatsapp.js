// Solo debe invocarse DESPUÉS de verificar la firma Meta y resolver el canal
// receptor a un negocio. Se guarda aun si el acuse precede al commit del outbox.
const ESTADOS=new Set(['sent','delivered','read','failed']);
export function telefonoTransporte(v) {
  const s=String(v ?? '').replace(/^\+/,'');
  return /^521\d{10}$/.test(s)?s.slice(0,2)+s.slice(3):s;
}
export function estadoMetaSeguro(s) {
  const destinatario=telefonoTransporte(s?.recipient_id),segundos=Number(s?.timestamp);
  if(!ESTADOS.has(s?.status) || typeof s?.id!=='string' || !s.id.length || s.id.length>512
    || !/^\d{8,15}$/.test(destinatario) || !Number.isSafeInteger(segundos) || segundos<=0)return null;
  const codigo=s.errors?.[0]?.code;
  return {wamid:s.id,destinatario,estado:s.status,segundos,
    errorCodigo:Number.isSafeInteger(codigo) && codigo>=0 && codigo<=2147483647?codigo:null};
}
export async function registrarEstadosMensaje(db,negocioId,statuses) {
  const {rows:[cfg]}=await db.query("SELECT valor FROM configuracion WHERE negocio_id=$1 AND clave='whatsapp_trazabilidad_formularios_v1'",[negocioId]);
  if(String(cfg?.valor)!=='true')return 0;
  let registrados=0;
  for(const raw of Array.isArray(statuses)?statuses:[]) {
    const s=estadoMetaSeguro(raw);if(!s)continue;
    const r=await db.query(`INSERT INTO whatsapp_estados_mensaje(negocio_id,wamid,destinatario,estado,ocurrido_at,error_codigo)
      SELECT $1,$2,$3,$4,to_timestamp($5),$6
      WHERE to_timestamp($5) BETWEEN clock_timestamp()-interval '30 days' AND clock_timestamp()+interval '5 minutes'
      ON CONFLICT DO NOTHING`,[negocioId,s.wamid,s.destinatario,s.estado,s.segundos,s.errorCodigo]);
    registrados+=r.rowCount;
  }
  return registrados;
}
export function vistaEstadoMensaje(eventos=[]) {
  // Un callback tardío 'sent' o 'failed' nunca rebaja una entrega/lectura.
  const fila=['read','delivered','failed','sent'].map(e=>eventos.find(s=>s.estado===e)).find(Boolean);
  if(!fila)return null;
  return {codigo:fila.estado,titulo:{read:'Leído',delivered:'Entregado',failed:'No entregado',sent:'Enviado'}[fila.estado],
    fecha:fila.ocurrido_at,errorCodigo:fila.estado==='failed'?fila.error_codigo ?? null:null,
    aclaracion: fila.estado==='read'?'Lectura del mensaje; no acredita apertura del formulario ni confirmación del pedido.'
      :fila.estado==='sent'?'Meta recibió el mensaje; todavía no hay acuse de entrega.':'Estado de transporte reportado por WhatsApp.'};
}
export async function estadosParaHistorial(db,negocioId,telefono,ids) {
  if(!ids.length)return new Map();
  try {
    const {rows}=await db.query(`SELECT wamid,estado,ocurrido_at,error_codigo FROM whatsapp_estados_mensaje
      WHERE negocio_id=$1 AND destinatario=$2 AND wamid=ANY($3::text[]) AND observado_at>now()-interval '30 days'`,
      [negocioId,telefonoTransporte(telefono),ids]);
    return new Map(ids.map(id=>[id,vistaEstadoMensaje(rows.filter(r=>r.wamid===id))]));
  } catch(e) {if(e.code==='42P01')return new Map();throw e;}
}
