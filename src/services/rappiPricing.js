/**
 * rappiPricing.js — Precio por canal para Rappi.
 *
 * El problema comercial: Rappi cobra una comisión sobre cada venta. Si el
 * negocio publica en Rappi el mismo precio que cobra en su mostrador, el
 * ingreso neto por ese platillo es menor que el de una venta directa. Este
 * módulo permite que cada negocio decida CÓMO se calcula el precio que sale
 * a Rappi, sin tocar jamás el precio base de Xabor.
 *
 * INVARIANTE CENTRAL: `menu_productos.precio` es la única fuente de verdad
 * interna. El ajuste de canal se aplica SOLO al armar el payload de Rappi
 * (rappi-api.js). POS, WhatsApp, tienda web, Clip y Mercado Pago siguen
 * viendo y cobrando el precio base -- este archivo no los toca ni los importa.
 *
 * Las tres estrategias, con precio base 180 y porcentaje 25:
 *
 *   precio_base          precioRappi = 180                  (sin ajuste)
 *   sumar_porcentaje     precioRappi = 180 * 1.25 = 225     (margen bruto)
 *   recuperar_comision   precioRappi = 180 / 0.75 = 240     (margen NETO)
 *
 * La diferencia entre las dos últimas es el punto del módulo: si Rappi se
 * queda con el 25% de 225, al negocio le llegan $168.75 -- MENOS que los
 * $180 del mostrador. Con 240, Rappi se queda con 60 y llegan exactamente
 * $180. "Recuperar comisión" es la única que conserva el ingreso neto.
 *
 * REDONDEO (decisión comercial, deliberadamente simple): siempre al peso
 * entero más cercano. Xabor opera hoy en pesos enteros en todo el catálogo
 * y un precio de $239.99 en Rappi no aporta nada y sí ensucia el ticket.
 * Se prefirió una regla fija a una configurable: una opción más que el
 * dueño tiene que entender, para una diferencia de a lo sumo 50 centavos.
 */

export const ESTRATEGIAS_RAPPI = Object.freeze(['precio_base', 'sumar_porcentaje', 'recuperar_comision']);

/**
 * Tope de seguridad. No es un límite matemático (recuperar_comision solo
 * necesita porcentaje < 100): es una barrera contra el dedo equivocado.
 * Un 90% tecleado por error convertiría un panini de $180 en $1,800 en la
 * app de Rappi, visible para cualquier cliente, sin que nadie lo note hasta
 * que alguien se queje.
 */
export const PORCENTAJE_MAXIMO = 80;

export const PRICING_POR_DEFECTO = Object.freeze({ estrategia: 'precio_base', porcentaje: 0 });

function esNumeroUsable(v) {
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * LECTURA (fail-safe). Cualquier configuración ausente, corrupta, con
 * estrategia desconocida o porcentaje imposible cae a precio base. Nunca
 * lanza: una configuración mal escrita no puede impedir que el negocio
 * publique su catálogo -- publicar al precio base es un error recuperable,
 * no poder publicar no lo es.
 */
export function normalizarPricingRappi(raw) {
  let cfg = raw;
  if (typeof cfg === 'string') {
    try { cfg = JSON.parse(cfg); } catch { return { ...PRICING_POR_DEFECTO }; }
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ...PRICING_POR_DEFECTO };

  const estrategia = ESTRATEGIAS_RAPPI.includes(cfg.estrategia) ? cfg.estrategia : 'precio_base';
  const porcentaje = esNumeroUsable(cfg.porcentaje);
  if (estrategia === 'precio_base') return { estrategia: 'precio_base', porcentaje: 0 };
  if (porcentaje === null || porcentaje < 0 || porcentaje > PORCENTAJE_MAXIMO) {
    return { ...PRICING_POR_DEFECTO };
  }
  return { estrategia, porcentaje };
}

/**
 * ESCRITURA (fail-closed). Lo que llega del panel se valida con dureza y
 * se rechaza con un motivo entendible: guardar en silencio una intención
 * mal expresada es peor que un 400, porque el precio equivocado se publica
 * y nadie se entera.
 */
export function validarPricingRappi(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Configuración de precios inválida' };
  }
  if (!ESTRATEGIAS_RAPPI.includes(raw.estrategia)) {
    return { ok: false, error: `Estrategia inválida. Opciones: ${ESTRATEGIAS_RAPPI.join(', ')}` };
  }
  if (raw.estrategia === 'precio_base') {
    return { ok: true, valor: { estrategia: 'precio_base', porcentaje: 0 } };
  }
  const porcentaje = esNumeroUsable(raw.porcentaje);
  if (porcentaje === null) return { ok: false, error: 'El porcentaje debe ser un número' };
  if (porcentaje < 0) return { ok: false, error: 'El porcentaje no puede ser negativo' };
  if (raw.estrategia === 'recuperar_comision' && porcentaje >= 100) {
    return { ok: false, error: 'Con 100% o más la comisión no se puede recuperar: el precio sería infinito' };
  }
  if (porcentaje > PORCENTAJE_MAXIMO) {
    return { ok: false, error: `El porcentaje máximo permitido es ${PORCENTAJE_MAXIMO}%` };
  }
  return { ok: true, valor: { estrategia: raw.estrategia, porcentaje } };
}

/**
 * Calcula el precio que sale a Rappi. `config` puede venir cruda de la
 * base: se normaliza aquí (fail-safe). Un precio base que no sea un número
 * usable devuelve 0 -- el mismo valor que produciría el catálogo sin este
 * módulo, nunca NaN ni un negativo.
 */
export function calcularPrecioRappi(precioBase, config) {
  const base = esNumeroUsable(precioBase);
  if (base === null || base < 0) return 0;

  const { estrategia, porcentaje } = normalizarPricingRappi(config);
  if (estrategia === 'precio_base' || porcentaje === 0) return Math.round(base);

  let ajustado;
  if (estrategia === 'sumar_porcentaje') {
    ajustado = base * (1 + porcentaje / 100);
  } else {
    const divisor = 1 - porcentaje / 100;
    if (!(divisor > 0)) return Math.round(base);   // inalcanzable tras normalizar; defensa en profundidad
    ajustado = base / divisor;
  }
  if (!Number.isFinite(ajustado) || ajustado < 0) return Math.round(base);
  return Math.round(ajustado);
}

/**
 * Texto de una línea para el panel y para los logs de publicación: deja
 * asentado en el historial CON QUÉ REGLA se publicó un catálogo.
 */
export function describirPricingRappi(config) {
  const { estrategia, porcentaje } = normalizarPricingRappi(config);
  if (estrategia === 'precio_base') return 'mismo precio que en Xabor';
  if (estrategia === 'sumar_porcentaje') return `precio de Xabor +${porcentaje}%`;
  return `recuperando ${porcentaje}% de comisión`;
}
