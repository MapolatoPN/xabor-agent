import { normalizarTipoModalidad } from './modalidadesDelPedido.js';

/** Calcula el envío con las mismas reglas que usa la validación final. */
export function calcularCostoEnvio({
  reglas = null, modalidad = null, subtotal = 0, costoSolicitado = null,
  promocionesActivas = [],
} = {}) {
  if (normalizarTipoModalidad(modalidad) !== 'domicilio') return 0;

  const base = Number(reglas?.pedidos?.costo_envio) || 0;
  const zonas = Array.isArray(reglas?.pedidos?.zonas_entrega)
    ? reglas.pedidos.zonas_entrega.map((z) => Number(z.costo)).filter(Number.isFinite)
    : [];
  const umbralGratis = Number(reglas?.pedidos?.entrega_gratis_desde) || 0;
  const permitidos = new Set([base, ...zonas]);
  if (umbralGratis > 0 && Number(subtotal) >= umbralGratis) permitidos.add(0);
  if (promocionesActivas?.some((p) => p?.condicion === 'min_3_focaccias')) permitidos.add(0);

  const pedido = Number(costoSolicitado);
  return Number.isFinite(pedido) && permitidos.has(pedido) ? pedido : base;
}
