// Enrutamiento de atención; no concede autoridad para cambiar pedidos o pagos.
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export function esMalaExperienciaAlimentos(mensaje) {
  const t = norm(mensaje)
    .replace(/\bno (?:tuve|tuvimos|tengo|tenemos|hay|hubo) (?:intoxicacion|moho)\b/g,'')
    .replace(/\bno (?:olia[n]?|huele[n]?|sabe[n]?|sabia[n]?) (?:mal|feo|fea|rancio|rancia)\b/g,'')
    .replace(/\bno (?:estaba[n]?|esta[n]?|estuvo|llego|vino) (?:en mal estado|podrid[oa]s?|echad[oa]s? a perder)\b/g,'');
  // No confundir «sin pescado», «olor a café» o «¿tienen leche sin lactosa?»
  // con un incidente. Hace falta una descripción concreta del problema.
  return /\b(?:olia[n]?|huele[n]?|ol[i]?o|olor|sabe[n]?|sabia[n]?|sabor) (?:muy |bien |demasiado |a |como a |como )?(?:feo|fea|mal|rancio|rancia|podrido|podrida|echado a perder|pescado)\b/.test(t)
    || /\b(?:comida|alimento|platillo|pedido|hotcakes|waffles|pollo|huevo|leche)\b.{0,60}\b(?:echad[oa]s? a perder|en mal estado|caducad[oa]s?|podrid[oa]s?|(?:con|tiene[n]?) moho)\b/.test(t)
    || /\b(?:me|nos) (?:enfermo|intoxico|hizo dano|cayo mal)\b/.test(t)
    || /\b(?:intoxicacion|intoxicad[oa]|encontre (?:un |una )?(?:insecto|cucaracha|vidrio))\b/.test(t);
}

export const pideAyudaAgregar = mensaje => /\b(?:como (?:puedo )?(?:agregar|anadir)|no (?:se|supe) como (?:agregar|anadir)|no (?:pude|puedo) (?:agregar|anadir))\b/.test(norm(mensaje));

export const sonDatosTrasFormulario = mensaje => /^(?:a nombre de\b|mi nombre es\b|(?:seria|es) a nombre de\b|(?:paso|pasaria|voy a pasar) (?:a|por|para) (?:recoger|recogerlo|el)\b|(?:mi )?(?:direccion|telefono|celular)\b)/.test(norm(mensaje));

export function prioridadDeAtencion(motivo, mensaje = '') {
  if (esMalaExperienciaAlimentos(mensaje)) return 'urgente';
  if (/(?:PAGO|INCIERT|CONFIRMADO)/.test(String(motivo))) return 'alta';
  if (/(?:QUEJA|RETRASO)/.test(String(motivo))) return 'urgente';
  return 'normal';
}

export function instruccionesDeAtencion(motivo, { fueraHorario = false, prioridad = 'normal' } = {}) {
  const cuando = fueraHorario ? 'Atender a primera hora al regresar el personal.' : 'Tomar la conversación cuanto antes.';
  const pedido = /PAGO|INCIERT/.test(String(motivo))
    ? ' Revisar el folio y los pagos registrados antes de actuar. Conservar el pedido; no cancelarlo ni capturarlo de nuevo para resolver el pago.' : '';
  return (prioridad === 'urgente' ? 'URGENTE: ' : '') + cuando + pedido;
}
