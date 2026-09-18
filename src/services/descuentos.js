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

const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;

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

// De porcentaje o importe al monto en pesos, redondeado a centavos y acotado
// al subtotal. El porcentaje se guarda como se capturó (15 = 15 %).
export function calcularMontoDescuento({ tipo, valor, subtotal }) {
  const sub = redondear(subtotal);
  const v = redondear(valor);
  if (tipo === 'porcentaje') return Math.min(sub, redondear(sub * v / 100));
  if (tipo === 'importe') return Math.min(sub, v);
  return 0;
}
