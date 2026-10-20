// Renderers: convierten el snapshot de un trabajo en los bytes que se mandan
// a la impresora.
//
// La frontera importa: el renderer NO sabe de sockets, ni de reintentos, ni
// de la nube. Recibe un objeto y devuelve un Buffer. Eso permite probar el
// formato del papel sin hardware y sin red -- basta comparar texto.
import {
  INIT, ALIGN_CENTER, ALIGN_LEFT, BOLD_ON, BOLD_OFF, SIZE_2H, SIZE_2X, SIZE_NORMAL,
  lf, linea, texto, columnas, bloque, encabezado, pie, horaLocal, imagenQr,
  espacioLetras, columnasConEspacio,
} from './escpos.js';
import { lineasDeModificadores, notaSinModificadores } from './modificadores.js';
import { agruparPorPersona, tituloPersona, quitarEtiquetaPersona } from './personas.js';
import { esFormatoValido, interpretarFormato } from './formato.js';

// Letras por renglón que necesita el producto para ir en letra doble (ancho y
// alto). 24 es lo que da una térmica de 80 mm configurada a 48 columnas.
export const COLUMNAS_PRODUCTO_DOBLE = 24;

// Aire entre letras de modificadores y nota, en puntos, cuando el papel está
// a 48 columnas. El doble alto deja las letras altas y apretadas; con 2 puntos
// caben 41 por renglón, y el modificador más largo de la comanda del 20-oct
// («  > Guarniciones: Frijolitos con chorizo») ocupa 40. Con 3 se partiría.
export const ESPACIO_LETRAS_MODIFICADORES = 2;

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

  const separados = (payload.items || []).some(i => i.persona);
  for (const grupo of agruparPorPersona(payload.items)) {
    if (separados) partes.push(BOLD_ON, bloque(tituloPersona(grupo.persona).toUpperCase(), ancho), BOLD_OFF, linea('-', ancho));
    for (const item of grupo.items) {
      // El producto, en el tamaño más grande que no lo parta. SIZE_2H (GS ! 1)
      // solo duplica la altura: cada letra ocupa una columna y caben `ancho`.
      // SIZE_2X duplica también el ancho: caben `ancho / 2`. Con 48 columnas
      // (80 mm a todo el cabezal) son 24, suficientes para casi cualquier
      // platillo; con 42 serían 21 y partiría «1 CHILAQUILES SENCILLOS» en dos
      // renglones con medio papel vacío, que es justo lo que se quería quitar.
      const productoDoble = Math.floor(ancho / 2) >= COLUMNAS_PRODUCTO_DOBLE;
      partes.push(BOLD_ON, productoDoble ? SIZE_2X : SIZE_2H);
      partes.push(bloque(`${item.cantidad}  ${String(item.producto || '').toUpperCase()}`, productoDoble ? Math.floor(ancho / 2) : ancho));
      partes.push(SIZE_NORMAL, BOLD_OFF);

      // Con 48 columnas también sobra para dar aire entre las letras de
      // modificadores y nota. Con 42 no: un solo punto ya partiría los
      // modificadores largos. El aire se apaga en cuanto termina el bloque:
      // un renglón de ancho completo (el `=====` del pie) con aire se pasaría
      // del papel.
      const aire = productoDoble ? ESPACIO_LETRAS_MODIFICADORES : 0;
      const anchoConAire = columnasConEspacio(ancho, aire);

      // Modificadores: una línea por opción, con viñeta, en DOBLE ALTO y en
      // NEGRITAS. Antes salían en tamaño normal -- la mitad de alto que el
      // producto -- y los que llegaban pegados en un solo texto se leían como
      // párrafo. Sin negritas, el trazo de un punto de la térmica los deja
      // grises junto al producto. La cocina los lee de pie y a un metro.
      const mods = lineasDeModificadores(item.modificadores);
      if (mods.length) {
        partes.push(BOLD_ON, SIZE_2H);
        if (aire) partes.push(espacioLetras(aire));
        // Sangría de dos, no de tres: el doble alto ya ocupa más papel y la
        // viñeta marca el nivel mejor que el espacio.
        for (const m of mods) partes.push(bloque(`> ${m}`, anchoConAire, '  '));
        if (aire) partes.push(espacioLetras(0));
        partes.push(SIZE_NORMAL, BOLD_OFF);
      }
      // La nota, sin la repetición de los modificadores que algunos flujos le
      // pegan (ver modificadores.js). Doble alto y negritas: es lo que cambia
      // el platillo respecto de como viene en la carta.
      const nota = quitarEtiquetaPersona(notaSinModificadores(item.notas, item.modificadores), item);
      if (nota) {
        partes.push(BOLD_ON, SIZE_2H);
        if (aire) partes.push(espacioLetras(aire));
        partes.push(bloque(`NOTA: ${nota}`, anchoConAire, '  '));
        if (aire) partes.push(espacioLetras(0));
        partes.push(SIZE_NORMAL, BOLD_OFF);
      }
      partes.push(lf(1));
    }
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

  if (payload.precuenta) {
    partes.push(
      ALIGN_CENTER, SIZE_2H, BOLD_ON, texto('PRECUENTA'),
      SIZE_NORMAL, texto(String(payload.leyenda || 'NO ES COMPROBANTE DE PAGO')),
      BOLD_OFF, ALIGN_LEFT, lf(1)
    );
  } else if (payload.ticketPagado) {
    // El ticket de la cuenta ya cobrada: lo primero que se lee es PAGADO.
    partes.push(ALIGN_CENTER, SIZE_2H, BOLD_ON, texto('PAGADO'), SIZE_NORMAL, BOLD_OFF, ALIGN_LEFT, lf(1));
  }

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
    if (item.notas) partes.push(bloque(`NOTA: ${item.notas}`, ancho, '    '));
  }

  partes.push(linea('-', ancho));
  if (payload.subtotal != null) partes.push(columnas('Subtotal', dinero(payload.subtotal), ancho));
  // Descuento por promoción (si el pedido trae uno). El nombre de la promo,
  // cuando viene, ayuda a que el cliente vea qué se aplicó.
  if (Number(payload.descuento) > 0) {
    // El motivo del descuento (o el nombre de la promoción) va junto al
    // importe, para que el cliente vea qué se aplicó.
    const motivo = payload.descuentoMotivo || payload.promocion;
    const etiqueta = motivo ? `Descuento (${String(motivo).slice(0, ancho - 14)})` : 'Descuento';
    partes.push(columnas(etiqueta, `-${dinero(payload.descuento)}`, ancho));
  }
  if (payload.propina) partes.push(columnas('Propina', dinero(payload.propina), ancho));
  if (payload.precuenta && Number(payload.pagado) > 0) {
    partes.push(columnas('Pagado', dinero(payload.pagado), ancho));
    partes.push(columnas('Saldo', dinero(payload.saldo), ancho));
  }
  partes.push(BOLD_ON, SIZE_2H, columnas('TOTAL', dinero(payload.total), Math.floor(ancho / 2)), SIZE_NORMAL, BOLD_OFF);

  for (const pago of payload.pagos || []) {
    partes.push(columnas(`  ${pago.metodo}`, dinero(pago.monto), ancho));
  }
  // Efectivo recibido y cambio: informativos, nunca parte de la venta.
  if (Number(payload.efectivoRecibido) > 0) {
    partes.push(columnas('Efectivo recibido', dinero(payload.efectivoRecibido), ancho));
    partes.push(columnas('Cambio', dinero(payload.cambio || 0), ancho));
  }

  if (payload.autofacturaQr && payload.autofacturaUrl) {
    const qr = imagenQr(payload.autofacturaQr, { modulo: ancho <= 32 ? 3 : 4, margen: 4 });
    if (qr) {
      partes.push(lf(1), ALIGN_CENTER, BOLD_ON, texto('ESCANEA PARA FACTURAR'), BOLD_OFF, qr,
        texto('Autofactura Xabor'), ALIGN_LEFT);
    }
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
    if (item.persona) partes.push(bloque(tituloPersona(item.persona), ancho));
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
  // Y la tabla de caracteres: si algún acento sale como otro símbolo, la
  // impresora no tomó la tabla que elige INIT.
  partes.push(texto('Acentos: áéíóú ÁÉÍÓÚ ñÑ ü ¿? ¡! ·'));
  partes.push(pie(ancho));
  return Buffer.concat(partes);
}

const POR_DOCUMENTO = {
  comanda: renderComanda,
  cuenta: renderCuenta,
  cancelacion: renderCancelacion,
  prueba: renderPrueba,
};

// Desde la versión con formato: si el servidor mandó el papel ya armado
// (payload.formato, ver ./formato.js), se imprime eso. Si no viene, o si
// interpretarlo fallara, sale el diseño de siempre de este archivo: un
// servidor viejo y un formato raro nunca dejan a la cocina sin papel.
export function renderizar(documento, payload, opciones = {}) {
  // La revisión también va dentro: un formato tan raro que hasta revisarlo
  // falla debe caer al diseño de siempre, no tumbar la impresión.
  try {
    if (esFormatoValido(payload?.formato)) return interpretarFormato(payload.formato, opciones);
  } catch { /* cae al diseño de siempre */ }
  const fn = POR_DOCUMENTO[documento];
  if (!fn) throw new Error(`No hay renderer para el documento "${documento}"`);
  return fn(payload, opciones);
}

export const documentosSoportados = Object.keys(POR_DOCUMENTO);
