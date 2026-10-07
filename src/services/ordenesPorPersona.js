// Identidad de preparación; no modifica precios ni divide pagos.
export function normalizarPersona(valor) {
  if (valor == null) return null;
  if (typeof valor !== 'object' || Array.isArray(valor)
      || !Number.isInteger(valor.numero) || valor.numero < 1 || valor.numero > 99
      || (valor.nombre != null && typeof valor.nombre !== 'string')) {
    const e = new Error('Persona inválida: usa un número del 1 al 99 y un nombre opcional');
    e.code = e.codigo = 'PERSONA_INVALIDA';
    throw e;
  }
  const nombre = String(valor.nombre || '').trim();
  if (nombre.length > 40 || /[\x00-\x1f\x7f]/.test(nombre)) {
    const e = new Error('El nombre de la persona admite hasta 40 caracteres sin saltos de línea');
    e.code = e.codigo = 'PERSONA_INVALIDA';
    throw e;
  }
  return { numero: valor.numero, nombre };
}

export async function ordenesPorPersonaHabilitadas(negocioId, db) {
  const { rows } = await db.query(
    "SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'ordenes_por_persona'",
    [negocioId]);
  return rows[0]?.valor === 'true';
}

export async function validarPersonasDeItems(items, negocioId, db) {
  const personas = items.map(i => normalizarPersona(i?.persona));
  if (!personas.some(Boolean)) return personas;
  if (!await ordenesPorPersonaHabilitadas(negocioId, db)) {
    const e = new Error('Las órdenes por persona no están habilitadas en este negocio');
    e.code = e.codigo = 'PERSONAS_DESHABILITADAS';
    throw e;
  }
  return personas;
}
