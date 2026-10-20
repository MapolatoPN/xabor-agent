// ─── Opciones de diseño del papel, por negocio ──────────────────────────────
//
// Viven en `configuracion` (clave FORMATO_CLAVE, JSON) y las edita el dueño
// desde el panel. Todo lo que llega se pasa por normalizarFormato: un valor
// desconocido o mal escrito cae al de fábrica, nunca rompe el papel. Los
// valores de fábrica son la comanda que se aprobó el 20-oct-2026 (platillo
// en un renglón, modificadores grandes y en negritas, número de orden y tipo
// arriba) y el ticket de siempre con los datos del negocio.
export const FORMATO_CLAVE = 'impresion_formato';

export const FORMATO_POR_DEFECTO = Object.freeze({
  comanda: Object.freeze({
    // Encabezado: lo que se lee primero en la estación.
    negocio: true,          // nombre del negocio arriba
    tamOrden: 'doble',      // «#2077» o «MESA 7»: doble | alto
    cliente: true,          // nombre de quien recoge
    mesero: true,
    impresora: true,        // a qué estación salió («COCINA», «BEBIDAS»)
    // Platillos.
    producto: 'auto',       // auto (doble si cabe, si no alto) | doble | alto | normal
    modificadores: 'alto',  // alto | normal
    aire: 'auto',           // auto (2 con papel ancho) | 0 | 1 | 2
    mostrarGrupo: true,     // «Salsa: Verde» o solo «Verde»
    notaInvertida: false,   // nota en blanco sobre negro
  }),
  ticket: Object.freeze({
    negocio: true,
    direccion: true,
    rfc: true,
    telefono: true,
    whatsapp: true,
    modificadores: true,    // desglose de opciones bajo cada platillo
    totalGrande: true,
    pie: 'Gracias por su visita',
  }),
});

const UNO_DE = (valor, permitidos, porOmision) => (permitidos.includes(valor) ? valor : porOmision);
const SI_NO = (valor, porOmision) => (typeof valor === 'boolean' ? valor : porOmision);
const LIMITE_PIE = 160;

function textoLibre(valor, porOmision) {
  if (typeof valor !== 'string') return porOmision;
  // Una sola línea lógica; el maquetador envuelve. Sin controles.
  return valor.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITE_PIE);
}

// Acepta el objeto guardado (o su texto JSON) y devuelve SIEMPRE un formato
// completo y válido.
export function normalizarFormato(guardado) {
  let g = guardado;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { g = null; } }
  if (!g || typeof g !== 'object') g = {};
  const c = (g.comanda && typeof g.comanda === 'object') ? g.comanda : {};
  const t = (g.ticket && typeof g.ticket === 'object') ? g.ticket : {};
  const C = FORMATO_POR_DEFECTO.comanda;
  const T = FORMATO_POR_DEFECTO.ticket;
  return {
    comanda: {
      negocio: SI_NO(c.negocio, C.negocio),
      tamOrden: UNO_DE(c.tamOrden, ['doble', 'alto'], C.tamOrden),
      cliente: SI_NO(c.cliente, C.cliente),
      mesero: SI_NO(c.mesero, C.mesero),
      impresora: SI_NO(c.impresora, C.impresora),
      producto: UNO_DE(c.producto, ['auto', 'doble', 'alto', 'normal'], C.producto),
      modificadores: UNO_DE(c.modificadores, ['alto', 'normal'], C.modificadores),
      aire: UNO_DE(c.aire, ['auto', 0, 1, 2], C.aire),
      mostrarGrupo: SI_NO(c.mostrarGrupo, C.mostrarGrupo),
      notaInvertida: SI_NO(c.notaInvertida, C.notaInvertida),
    },
    ticket: {
      negocio: SI_NO(t.negocio, T.negocio),
      direccion: SI_NO(t.direccion, T.direccion),
      rfc: SI_NO(t.rfc, T.rfc),
      telefono: SI_NO(t.telefono, T.telefono),
      whatsapp: SI_NO(t.whatsapp, T.whatsapp),
      modificadores: SI_NO(t.modificadores, T.modificadores),
      totalGrande: SI_NO(t.totalGrande, T.totalGrande),
      pie: textoLibre(t.pie, T.pie),
    },
  };
}
