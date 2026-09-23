// ─── Descuentos: UNA sola regla de autorización para POS y Restaurante ──────
//
// La regla nació en el POS (cobro de mostrador) y se aplicaba inline en la
// ruta de cobro. Restaurante la necesita idéntica, así que vive aquí y las
// dos rutas la llaman: si el límite cambia, cambia para todos a la vez.
//
//   · El descuento nunca es negativo ni mayor que el subtotal (el total no
//     puede quedar por debajo de cero).
//   · Con descuento, el motivo es obligatorio: queda auditado con quién y
//     cuándo.
//   · Staff: como máximo el 10 % del subtotal (medio centavo de tolerancia
//     por redondeo). Admin: sin límite.
//
// Es una función pura: quien la llama ya recalculó el subtotal en servidor.
export const LIMITE_DESCUENTO_STAFF = 0.10;

export const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function autorizarDescuento({ rol, subtotal, descuento, motivo }) {
  const sub = redondear(subtotal);
  const desc = redondear(descuento);
  if (!Number.isFinite(desc) || desc < 0 || desc > sub) {
    return { ok: false, status: 400, codigo: 'DESCUENTO_INVALIDO', mensaje: 'Descuento inválido' };
  }
  if (desc > 0 && !String(motivo || '').trim()) {
    return { ok: false, status: 400, codigo: 'MOTIVO_REQUERIDO', mensaje: 'El motivo del descuento es obligatorio' };
  }
  if (desc > 0 && rol !== 'admin' && desc > sub * LIMITE_DESCUENTO_STAFF + 0.005) {
    return {
      ok: false, status: 403, codigo: 'DESCUENTO_NO_AUTORIZADO',
      mensaje: `El descuento máximo para staff es ${Math.round(LIMITE_DESCUENTO_STAFF * 100)}% del subtotal`,
    };
  }
  return { ok: true, descuento: desc, motivo: desc > 0 ? String(motivo).trim() : null };
}

// De porcentaje o importe al monto en pesos, redondeado a centavos. No se
// acota al subtotal a propósito: un importe mayor que el subtotal debe
// rechazarse en autorizarDescuento (DESCUENTO_INVALIDO), no convertirse en
// silencio en un 100 %. El porcentaje se guarda como se capturó (15 = 15 %).
export function calcularMontoDescuento({ tipo, valor, subtotal }) {
  const sub = redondear(subtotal);
  const v = redondear(valor);
  if (tipo === 'porcentaje') return redondear(sub * v / 100);
  if (tipo === 'importe') return v;
  return 0;
}

// ─── Fase 2: bloque normalizado datos.descuentos ────────────────────────────
//
// Formato común para los cuatro canales que crean o cobran un pedido (POS,
// restaurante, WhatsApp/agente, tienda en línea). Cada uno guarda el
// descuento hoy con SU PROPIA forma dentro de `pedidos_activos.datos` (ver
// docs/fase2-normalizar-descuentos.md para el mapa completo) -- esta función
// no cambia esas formas legacy, solo construye el bloque adicional
// `datos.descuentos` a partir de lo que cada canal YA calculó.
//
// Es DELIBERADAMENTE una función pura: sin DB, sin awaits, sin leer
// `req`/`pool`. Cada llamador arma sus tres entradas (manual/promociones/
// rewards) con los datos que YA tiene en memoria en el momento en que los
// calcula -- nunca inventa un campo que su canal no tenga (ver invariante
// abajo). El shape de salida es siempre el mismo sin importar cuántas de las
// tres fuentes traiga el canal.
//
//   manual       { monto, tipo, motivo, autorizadoPor } | null -- null
//                significa "este canal no tiene concepto de descuento
//                manual" (WhatsApp, Mesero, tienda). tipo/motivo/
//                autorizadoPor son individualmente null cuando el canal que
//                SÍ tiene descuento manual no captura ese dato particular
//                (p. ej. el POS de mostrador no pide motivo).
//   promociones  [{ promocionId, nombre, monto, tipo, codigo }] -- acepta
//                también `descuento` como alias de `monto` porque así lo
//                nombra el motor de promociones (tiendaPromociones.js) en
//                los arreglos que ya persisten hoy; evita que cada canal
//                tenga que remapear el campo antes de llamar aquí.
//   rewards      { monto, puntos } | null -- null si el canal no tiene
//                Rewards conectado.
//
// INVARIANTE (verificada en test/fase-descuentos-normalizados.mjs):
//   total === dinero(manual.monto + sum(promociones[].monto) + rewards.monto)
// Los tres montos son ADITIVOS por construcción -- nunca se restan entre sí
// ni se descuentan dos veces: cada canal solo popula la fuente que
// EFECTIVAMENTE aplicó (ver mapa), así que nunca hay superposición real
// entre manual/promociones/rewards para un mismo pedido salvo los casos
// legítimos ya documentados (POS: manual + promoción a la vez).
export function construirDesgloseDescuentos({ manual = null, promociones = [], rewards = null } = {}) {
  const manualMonto = redondear(manual?.monto);
  const promosNormalizadas = (Array.isArray(promociones) ? promociones : []).map((p) => ({
    promocionId: p?.promocionId ?? p?.id ?? null,
    // Snapshot historico: la campaña puede cambiar antes de confirmar un pago
    // o antes de que el reconciliador repare la auditoria.
    campaniaId: p?.campaniaId ?? p?.campania_id ?? null,
    nombre: p?.nombre ?? null,
    monto: redondear(p?.monto ?? p?.descuento),
    tipo: p?.tipo ?? null,
    codigo: p?.codigo ?? null,
  }));
  const promoTotal = redondear(promosNormalizadas.reduce((s, p) => s + p.monto, 0));
  const rewardsMonto = redondear(rewards?.monto);
  const rewardsPuntos = Math.max(0, Math.trunc(Number(rewards?.puntos) || 0));
  const total = redondear(manualMonto + promoTotal + rewardsMonto);
  return {
    manual: {
      monto: manualMonto,
      tipo: manual?.tipo ?? null,
      motivo: manual?.motivo ?? null,
      autorizadoPor: manual?.autorizadoPor ?? null,
    },
    promociones: promosNormalizadas,
    rewards: { monto: rewardsMonto, puntos: rewardsPuntos },
    total,
  };
}
