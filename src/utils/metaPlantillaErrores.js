// Clasificador de errores de plantilla de la Graph API de Meta (puro, sin
// I/O) -- alimenta el JSON de auditoría del fallback v2→v1 del primer
// mensaje a repartidores (ver notificarRepartidoresPorWA). Códigos
// documentados por Meta:
//   132001 = la plantilla no existe en ese idioma o no está aprobada
//            (cubre INEXISTENTE, PENDING y REJECTED: el error de envío no
//            los distingue -- el estado exacto se ve en WhatsApp Manager)
//   132000 = el número de variables no coincide con la plantilla aprobada
//   132015 = plantilla pausada (PAUSED)
//   132016 = plantilla deshabilitada (DISABLED)
// Nunca incluye datos del mensaje: solo el código/clasificación.
export function clasificarErrorPlantillaMeta(mensajeError) {
  const m = String(mensajeError || '');
  const codigo = (() => {
    try {
      const json = JSON.parse(m.slice(m.indexOf('{')));
      return json?.error?.code ?? json?.code ?? null;
    } catch { return null; }
  })();
  if (codigo === 132001 || /does not exist|not approved/i.test(m)) return 'template_not_approved_or_missing';
  if (codigo === 132000 || /number of parameters|param/i.test(m)) return 'template_param_mismatch';
  if (codigo === 132015 || /paused/i.test(m)) return 'template_paused';
  if (codigo === 132016 || /disabled/i.test(m)) return 'template_disabled';
  return codigo ? `error_meta_${codigo}` : 'error_desconocido';
}
