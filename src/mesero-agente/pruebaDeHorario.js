// Excepción temporal únicamente para el chat piloto de WhatsApp. No cambia
// reglas, tienda, precios, calendario ni el estado de otras conversaciones.
export const CLAVE_PRUEBA_HORARIO = 'whatsapp_prueba_horario_v1';
export const MAX_PRUEBA_HORARIO_MS = 2 * 60 * 60 * 1000;
const numero = valor => {
  const t = String(valor ?? '').replace(/\D/g, '');
  return /^521\d{10}$/.test(t) ? `52${t.slice(3)}` : /^\d{10}$/.test(t) ? `52${t}` : t;
};

export function estadoParaPruebaDeHorario({ estadoRestaurante, cfg, ia,
  negocioId, telefono, canal, ahora = new Date() } = {}) {
  if (estadoRestaurante?.abierto !== false || canal !== 'whatsapp'
    || cfg?.bot_whatsapp_solo_prueba !== 'true'
    || ia?.modo !== 'formulario' || ia?.alcance !== 'prueba' || ia?.completo !== true) return estadoRestaurante;
  let prueba;
  try { prueba = JSON.parse(cfg?.[CLAVE_PRUEBA_HORARIO] || 'null'); } catch { return estadoRestaurante; }
  if (!prueba || prueba.negocioId !== negocioId || !/^52\d{10}$/.test(numero(prueba.telefono))
    || numero(prueba.telefono) !== numero(telefono)) return estadoRestaurante;
  const lista = String(cfg.mesero_agente_telefonos || '').split(/[,;\n]+/).map(numero);
  if (!lista.includes(numero(telefono))) return estadoRestaurante;
  const inicio = Date.parse(prueba.inicio), hasta = Date.parse(prueba.hasta), hoy = Number(ahora);
  if (![inicio, hasta, hoy].every(Number.isFinite) || hasta <= inicio
    || hasta - inicio > MAX_PRUEBA_HORARIO_MS || hoy < inicio || hoy >= hasta) return estadoRestaurante;
  return { ...estadoRestaurante, abierto: true, preApertura: false, pruebaHorario: true };
}
