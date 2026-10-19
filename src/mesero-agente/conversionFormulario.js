// Interruptor por negocio. Ausencia = comportamiento anterior. No levanta
// ninguna barrera de agente, canario, horario o atención humana.
export const conversionFormularioActiva = cfg => cfg?.whatsapp_formulario_conversion_v1 === 'true';
export const normalizar = s => String(s ?? '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ]+/g, ' ').trim();
export const pideRepetir = s => /^(?:(?:quiero|quisiera) )?repetir (?:mi |el |mi ultimo |el ultimo )?pedido[.! ]*$/i.test(normalizar(s));

// Solo una renuncia explícita a un EXTRA, única, gratuita. No elige leche,
// salsa, proteína, endulzante, tamaño ni ninguna opción de pago.
export function seleccionSinExtras(grupos = [], seleccion = {}) {
  const r = structuredClone(seleccion);
  grupos.forEach((g, gi) => {
    if (r[gi]?.length || Number(g.minimo) > 1) return;
    const nombre = normalizar(g.nombre);
    if (!/\b(?:extras?|complementos?|flores|fruta extra)\b/.test(nombre)) return;
    const neutras = (g.opciones || []).flatMap((o, oi) => Number(o.precio ?? o.precio_extra) === 0
      && /^(?:sin (?:extras?|complementos?|flores|fruta extra)|no(?: flores)?)$/.test(normalizar(o.nombre)) ? [oi] : []);
    if (neutras.length === 1) r[gi] = neutras;
  });
  return r;
}
