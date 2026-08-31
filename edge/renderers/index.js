// Renderers: convierten el snapshot de un trabajo en los bytes que se mandan
// a la impresora.
//
// La frontera importa: el renderer NO sabe de sockets, ni de reintentos, ni
// de la nube. Recibe un objeto y devuelve un Buffer. Eso permite probar el
// formato del papel sin hardware y sin red -- basta comparar texto.
import {
  INIT, ALIGN_CENTER, ALIGN_LEFT, BOLD_ON, BOLD_OFF, SIZE_2H, SIZE_NORMAL,
  lf, linea, texto, columnas, bloque, encabezado, pie, horaLocal,
} from './escpos.js';

// ─── Comanda de cocina ──────────────────────────────────────────────────────
//
// Está pensada para leerse de un vistazo a un metro de distancia, con las
// manos ocupadas: cantidad y producto en grande, modificadores debajo con
// sangría, la nota destacada. Nada de precios: a la cocina no le importan y
// solo estorban.
export function renderComanda(payload, { ancho = 42 } = {}) {
  const partes = [INIT];

  partes.push(encabezado(String(payload.negocio || 'XABOR').toUpperCase(), ancho));

  const mesa = payload.mesa != null ? `MESA ${payload.mesa}` : (payload.destino || 'PARA LLEVAR');
  partes.push(ALIGN_CENTER, SIZE_2H, BOLD_ON, texto(mesa), BOLD_OFF, SIZE_NORMAL, ALIGN_LEFT);

  if (payload.mesero) partes.push(texto(String(payload.mesero).toUpperCase()));
  partes.push(columnas(horaLocal(payload.emitidoAt), payload.ronda != null ? `RONDA ${payload.ronda}` : '', ancho));
  if (payload.impresora) partes.push(texto(String(payload.impresora).toUpperCase()));
  partes.push(linea('=', ancho), lf(1));

  for (const item of payload.items || []) {
    partes.push(BOLD_ON, SIZE_2H);
    partes.push(bloque(`${item.cantidad}  ${String(item.producto || '').toUpperCase()}`, Math.floor(ancho / 2)));
    partes.push(SIZE_NORMAL, BOLD_OFF);

    for (const m of item.modificadores || []) {
      // Un modificador puede llegar como texto plano o como {grupo, opcion}.
      const linea1 = typeof m === 'string' ? m : [m.grupo, m.opcion].filter(Boolean).join(': ');
      if (linea1) partes.push(bloque(linea1, ancho, '   '));
    }
    if (item.notas) {
      partes.push(BOLD_ON, bloque(`NOTA: ${item.notas}`, ancho, '   '), BOLD_OFF);
    }
    partes.push(lf(1));
  }

  if (payload.reimpresion) {
    partes.push(ALIGN_CENTER, BOLD_ON, texto('*** REIMPRESION ***'), BOLD_OFF, ALIGN_LEFT);
  }
  partes.push(pie(ancho));
  return Buffer.concat(partes);
}

// ─── Cuenta del cliente ─────────────────────────────────────────────────────
//
// Aquí sí van los importes. No pretende ser un comprobante fiscal: es la
// cuenta que se lleva a la mesa. La facturación es otro asunto y no existe
// todavía en Xabor -- no se insinúa que exista.
export function renderCuenta(payload, { ancho = 42 } = {}) {
  const partes = [INIT];
  partes.push(encabezado(String(payload.negocio || 'XABOR').toUpperCase(), ancho));

  if (payload.mesa != null) partes.push(texto(`Mesa ${payload.mesa}`));
  if (payload.mesero) partes.push(texto(`Le atendió: ${payload.mesero}`));
  if (payload.folio) partes.push(texto(`Folio: ${payload.folio}`));
  partes.push(texto(horaLocal(payload.emitidoAt)), linea('-', ancho));

  const dinero = (n) => `$${Number(n || 0).toFixed(2)}`;
  for (const item of payload.items || []) {
    const importe = Number(item.cantidad || 0) * Number(item.precioUnitario ?? item.precio_unitario ?? 0);
    partes.push(columnas(`${item.cantidad} ${item.producto}`.slice(0, ancho - 12), dinero(importe), ancho));
    for (const m of item.modificadores || []) {
      const t = typeof m === 'string' ? m : [m.grupo, m.opcion].filter(Boolean).join(': ');
      if (t) partes.push(bloque(t, ancho, '    '));
    }
  }

  partes.push(linea('-', ancho));
  if (payload.subtotal != null) partes.push(columnas('Subtotal', dinero(payload.subtotal), ancho));
  // Descuento por promoción (si el pedido trae uno). El nombre de la promo,
  // cuando viene, ayuda a que el cliente vea qué se aplicó.
  if (Number(payload.descuento) > 0) {
    const etiqueta = payload.promocion ? `Descuento (${String(payload.promocion).slice(0, ancho - 14)})` : 'Descuento';
    partes.push(columnas(etiqueta, `-${dinero(payload.descuento)}`, ancho));
  }
  if (payload.propina) partes.push(columnas('Propina', dinero(payload.propina), ancho));
  partes.push(BOLD_ON, SIZE_2H, columnas('TOTAL', dinero(payload.total), Math.floor(ancho / 2)), SIZE_NORMAL, BOLD_OFF);

  for (const pago of payload.pagos || []) {
    partes.push(columnas(`  ${pago.metodo}`, dinero(pago.monto), ancho));
  }

  if (payload.reimpresion) {
    partes.push(lf(1), ALIGN_CENTER, BOLD_ON, texto('*** REIMPRESION ***'), BOLD_OFF, ALIGN_LEFT);
  }
  partes.push(lf(1), ALIGN_CENTER, texto('Gracias por su visita'), ALIGN_LEFT);
  partes.push(pie(ancho));
  return Buffer.concat(partes);
}

// ─── Cancelación ────────────────────────────────────────────────────────────
export function renderCancelacion(payload, { ancho = 42 } = {}) {
  const partes = [INIT];
  partes.push(ALIGN_CENTER, SIZE_2H, BOLD_ON, texto('*** CANCELADO ***'), BOLD_OFF, SIZE_NORMAL, ALIGN_LEFT);
  partes.push(linea('=', ancho));
  if (payload.mesa != null) partes.push(texto(`MESA ${payload.mesa}`));
  partes.push(texto(horaLocal(payload.emitidoAt)), linea('-', ancho));
  for (const item of payload.items || []) {
    partes.push(BOLD_ON, bloque(`${item.cantidad}  ${String(item.producto || '').toUpperCase()}`, ancho), BOLD_OFF);
  }
  if (payload.motivo) partes.push(lf(1), bloque(`MOTIVO: ${payload.motivo}`, ancho));
  partes.push(pie(ancho));
  return Buffer.concat(partes);
}

// ─── Prueba de impresora ────────────────────────────────────────────────────
//
// Sirve para el levantamiento en sitio: dice a qué impresora salió el papel y
// desde qué Edge, para poder pegarle una etiqueta al hardware sin adivinar.
export function renderPrueba(payload, { ancho = 42 } = {}) {
  const partes = [INIT];
  partes.push(encabezado('XABOR', ancho));
  partes.push(ALIGN_CENTER, BOLD_ON, texto('PRUEBA DE IMPRESORA'), BOLD_OFF, ALIGN_LEFT, lf(1));
  partes.push(columnas('Negocio', String(payload.negocio || '-').slice(0, ancho - 10), ancho));
  partes.push(columnas('Destino', String(payload.impresora || '-').slice(0, ancho - 10), ancho));
  partes.push(columnas('Edge', String(payload.terminal || '-').slice(0, ancho - 8), ancho));
  partes.push(columnas('Transporte', String(payload.transporte || '-'), ancho));
  partes.push(columnas('Ancho', `${ancho} columnas`, ancho));
  partes.push(columnas('Fecha', new Date(payload.emitidoAt || Date.now()).toLocaleString('es-MX'), ancho));
  if (payload.jobId) partes.push(columnas('Trabajo', String(payload.jobId).slice(0, 18), ancho));
  partes.push(lf(1), linea('-', ancho));
  // Regla de columnas: permite comprobar de un vistazo si el ancho
  // configurado coincide con el papel real.
  partes.push(texto('1234567890'.repeat(Math.ceil(ancho / 10)).slice(0, ancho)));
  partes.push(pie(ancho));
  return Buffer.concat(partes);
}

const POR_DOCUMENTO = {
  comanda: renderComanda,
  cuenta: renderCuenta,
  cancelacion: renderCancelacion,
  prueba: renderPrueba,
};

export function renderizar(documento, payload, opciones = {}) {
  const fn = POR_DOCUMENTO[documento];
  if (!fn) throw new Error(`No hay renderer para el documento "${documento}"`);
  return fn(payload, opciones);
}

export const documentosSoportados = Object.keys(POR_DOCUMENTO);
