// ─── Opciones de Rappi como datos (Fase 2.2, 23-nov-2026) ───────────────────
//
// mapearOrdenRappi (rappi.js) guarda las opciones de cada producto como texto
// en `notas` («Pechuga de pollo: 1»): es lo que se imprime y eso no cambia.
// Esto agrega a cada línea lo que mandó Rappi, como datos, para emparejar
// cada opción con su grupo del menú (services/lineasEstructuradas.js):
//   · `sku_rappi`: el SKU del producto (Xabor publica `XB-<id>` o el código
//     propio del producto);
//   · `toppings_rappi`: cada opción con su SKU (`XB-op-<id>` si la publicó
//     Xabor), nombre, unidades, precio y categoría.
// Acotado en tamaño y NUNCA lanza: si mapearOrdenRappi lanzara, la orden de
// Rappi se rechazaría. Ante un payload raro, devuelve {} y la orden sigue.
const MAX_TOPPINGS_RAPPI = 40;
const textoCorto = (v, n = 120) => (v === null || v === undefined ? '' : String(v)).trim().slice(0, n);
const numero = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function datosEstructuradosRappi(item) {
  try {
    const crudos = item?.toppings || item?.sub_items || item?.subitems || [];
    const toppings = (Array.isArray(crudos) ? crudos : []).slice(0, MAX_TOPPINGS_RAPPI)
      .filter((t) => t && typeof t === 'object')
      .map((t) => ({
        sku: textoCorto(t.sku ?? t.id, 60) || null,
        nombre: textoCorto(t.name ?? t.topping_name),
        unidades: numero(t.units ?? t.quantity) ?? 1,
        precio: numero(t.unit_price ?? t.price ?? t.unit_price_with_discount),
        categoria: textoCorto(t.category ?? t.category_name ?? t.topping_category?.name) || null,
      }))
      .filter((t) => t.nombre);
    return {
      sku_rappi: textoCorto(item?.sku ?? item?.id, 60) || null,
      toppings_rappi: toppings,
    };
  } catch {
    return {};
  }
}
