const esVerdadero = v => String(v ?? '').trim().toLowerCase() === 'true';
const procesoActivo = () => esVerdadero(process.env.MESERO_AGENTE_MODE);

// El interruptor de atención nunca selecciona un motor antiguo ni amplía el piloto.
export function disponibilidadAsistente(cfg = {}, habilitado = procesoActivo()) {
  const bandera = esVerdadero(cfg.mesero_agente_v1);
  const numeros = String(cfg.mesero_agente_telefonos || '').split(/[,;\n]+/).map(t => t.replace(/\D/g, '')).filter(Boolean);
  const telefonos = [...new Set(numeros.filter(t => /^\d{10,15}$/.test(t)))];
  const porcentaje = Number(cfg.mesero_agente_porcentaje || 0);
  // La lista tiene prioridad sobre el porcentaje, igual que modoDelPedido.
  const alcance = numeros.length ? telefonos.length > 0 && telefonos.length === new Set(numeros).size
    : Number.isFinite(porcentaje) && porcentaje > 0 && porcentaje <= 100 && !esVerdadero(cfg.bot_whatsapp_solo_prueba);
  const listo = habilitado && bandera && alcance;
  return { motor: 'agente_herramientas', listo, telefonosPrueba: telefonos.length,
    alcance: numeros.length ? 'lista' : 'porcentaje', porcentaje: numeros.length ? null : porcentaje,
    motivo: !habilitado ? 'AGENTE_PROCESO_APAGADO' : !bandera ? 'AGENTE_NEGOCIO_APAGADO' : !alcance ? 'AGENTE_SIN_ALCANCE' : null };
}

export async function exigirAsistenteDisponible(db, negocioId) {
  const { rows } = await db.query(`SELECT clave,valor FROM configuracion WHERE negocio_id=$1
    AND clave IN ('mesero_agente_v1','mesero_agente_telefonos','mesero_agente_porcentaje','bot_whatsapp_solo_prueba') FOR SHARE`, [negocioId]);
  const estado = disponibilidadAsistente(Object.fromEntries(rows.map(r => [r.clave, r.valor])));
  if (!estado.listo) throw Object.assign(new Error('El agente nuevo no está disponible. Revisa su activación y alcance; la atención permanece sin cambios.'),
    { codigo: 'ASISTENTE_NO_DISPONIBLE', motivo: estado.motivo });
  return estado;
}

export function motivoSinAgente(modo) {
  return modo?.agente === true ? null : 'AGENTE_FUERA_DE_ALCANCE';
}
