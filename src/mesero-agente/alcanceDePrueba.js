import { pool } from '../services/database.js';
const numeroDePrueba = (valor) => {
  const d = String(valor || '').replace(/\D/g, '');
  if (/^521\d{10}$/.test(d)) return `52${d.slice(3)}`;
  if (/^\d{10}$/.test(d)) return `52${d}`;
  return /^\d{11,15}$/.test(d) ? d : null;
};

// El porcentaje del agente elige motor; NO es una barrera de atención.
// Esta bandera independiente deja a clientes fuera de la lista en manual,
// sin permitir que otro motor responda como fallback.
export function alcanceDePruebaPermite(config, telefono) {
  const valor = String(config?.bot_whatsapp_solo_prueba ?? 'false').trim().toLowerCase();
  if (valor === 'false' || valor === '') return true;
  if (valor !== 'true') return false;
  const lista = String(config?.mesero_agente_telefonos || '').split(/[,;\n]+/)
    .map(numeroDePrueba).filter(Boolean);
  const numero = numeroDePrueba(telefono);
  return !!numero && lista.includes(numero);
}

export async function permiteAtencionEnPrueba(negocioId, telefono, consultar = (sql, args) => pool.query(sql, args)) {
  try {
    const { rows } = await consultar(`SELECT clave,valor FROM configuracion
      WHERE negocio_id=$1 AND clave IN ('bot_whatsapp_solo_prueba','mesero_agente_telefonos')`, [negocioId]);
    return alcanceDePruebaPermite(Object.fromEntries(rows.map((r) => [r.clave, r.valor])), telefono);
  } catch {
    console.error('[AGENTE] No se pudo verificar el alcance de atención: turno reservado para atención manual.');
    return false;
  }
}
