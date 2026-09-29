// Diagnóstico de lectura. No expone teléfonos, credenciales ni cambia alcance.
const verdadero=v=>String(v).trim().toLowerCase()==='true';
export function resumirEstadoBotPanel(activo,cfg) {
  const prueba=verdadero(cfg.bot_whatsapp_solo_prueba);
  const numeros=String(cfg.mesero_agente_telefonos || '').split(/[,;\n]+/).map(t=>t.replace(/\D/g,'')).filter(t=>/^\d{10,15}$/.test(t));
  const unicos=new Set(numeros.map(t=>/^521\d{10}$/.test(t)?'52'+t.slice(3):/^\d{10}$/.test(t)?'52'+t:t));
  return {botWhatsappActivo:activo===true,soloPrueba:prueba,telefonosPrueba:prueba?unicos.size:null,
    alcance:prueba?'piloto':'configurado',titulo:!activo?'Atención automática pausada':prueba?'Piloto activo':'Atención automática habilitada',
    detalle:!activo?'Los mensajes llegan; la atención es manual.':prueba
      ? `Solo números autorizados para pruebas (${unicos.size}). Las pausas y la atención humana tienen prioridad.`
      : 'La respuesta depende del alcance configurado y del estado de cada conversación.'};
}
export async function leerEstadoBotPanel(db,negocioId) {
  const {rows:[r]}=await db.query(`SELECT bot_whatsapp_activo AS activo,
    COALESCE((SELECT jsonb_object_agg(clave,valor) FROM configuracion WHERE negocio_id=n.id
      AND clave IN ('bot_whatsapp_solo_prueba','mesero_agente_telefonos')),'{}'::jsonb) AS cfg
    FROM negocios n WHERE id=$1`,[negocioId]);
  if(!r)throw Error('NEGOCIO_NO_DISPONIBLE');
  return resumirEstadoBotPanel(r.activo,r.cfg);
}
