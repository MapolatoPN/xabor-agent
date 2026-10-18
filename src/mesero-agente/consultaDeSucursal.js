const normalizar=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
  .replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();

// No resuelve teléfonos de otra empresa ni adivina a qué sucursal pertenece
// una carta. Una petición explícita de otro lugar requiere orientación.
export function menuMencionaOtraSucursal(mensaje,{nombre='',ciudad=''}={}) {
  const t=normalizar(mensaje);
  const m=/\b(?:menu|carta) (?:de|en) (?:la )?(?:sucursal (?:de|en) )?(.+)/.exec(t);
  if(!m)return false;
  const lugar=m[1].replace(/\b(?:por favor|porfa|porfis|gracias)\b.*$/,'').trim();
  if(!lugar || /^(?:hoy|manana|desayunos?|comidas?|bebidas?|tacos|chilaquiles|combitos?|ninos|infantil|postres?)(?: |$)/.test(lugar))return false;
  const actual=normalizar(`${nombre} ${ciudad}`);
  return !!actual && !actual.includes(lugar);
}
