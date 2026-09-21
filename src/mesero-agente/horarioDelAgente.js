// ─── RESPUESTA DETERMINISTA FUERA DE HORARIO ─────────────────────────────
//
// El modelo no decide si el negocio está abierto ni redacta una promesa de
// pedido cuando ya cerró. Este módulo solo usa las reglas del negocio y la
// configuración real de su tienda publicada.

const DIAS = Object.freeze([
  'domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado',
]);

const NOMBRES_DIAS = Object.freeze({
  domingo: 'domingo', lunes: 'lunes', martes: 'martes', miercoles: 'miércoles',
  jueves: 'jueves', viernes: 'viernes', sabado: 'sábado',
});

const diaSinAcentos = (valor) => String(valor || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const fechaMasDias = (fechaIso, dias) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fechaIso || ''));
  if (!m) return null;
  const fecha = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + dias));
  if (Number.isNaN(fecha.getTime())) return null;
  return fecha.toISOString().slice(0, 10);
};

const cierreCompleto = (reglas, fecha) => (reglas?.cierres_especiales || [])
  .some((cierre) => cierre?.fecha === fecha && !cierre?.hora_cierre);

/** Próxima apertura declarada, respetando días cerrados y cierres completos. */
export function siguienteApertura(reglas, estadoRestaurante) {
  const actual = diaSinAcentos(estadoRestaurante?.diaActual);
  const indice = DIAS.indexOf(actual);
  if (indice < 0) return null;

  // Antes de abrir se informa la apertura de hoy. Después del cierre se
  // empieza mañana. Ocho intentos permiten saltar una semana completa y
  // encontrar la siguiente apertura del mismo día si solo abre una vez.
  const inicio = estadoRestaurante?.preApertura && !estadoRestaurante?.cierreEspecial ? 0 : 1;
  for (let diasHasta = inicio; diasHasta <= 7; diasHasta += 1) {
    const dia = DIAS[(indice + diasHasta) % DIAS.length];
    const horario = reglas?.horarios?.[dia];
    const fecha = fechaMasDias(estadoRestaurante?.fechaHoy, diasHasta);
    if (!horario?.abierto || !/^\d{1,2}:\d{2}$/.test(String(horario.apertura || ''))) continue;
    if (fecha && cierreCompleto(reglas, fecha)) continue;
    return {
      diasHasta,
      dia: NOMBRES_DIAS[dia],
      fecha,
      apertura: horario.apertura,
    };
  }
  return null;
}

/** "07:30" -> "7:30 a. m."; devuelve null si el horario no es válido. */
export function horaParaCliente(valor) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(valor || '').trim());
  if (!m) return null;
  const hora = Number(m[1]);
  const minuto = Number(m[2]);
  if (!Number.isInteger(hora) || hora < 0 || hora > 23 || minuto < 0 || minuto > 59) return null;
  const periodo = hora < 12 ? 'a. m.' : 'p. m.';
  const hora12 = hora % 12 || 12;
  return `${hora12}:${String(minuto).padStart(2, '0')} ${periodo}`;
}

export function enlaceDeTienda(configTienda, { baseUrl = process.env.PUBLIC_URL || 'https://xabor.mx' } = {}) {
  if (configTienda?.estado !== 'publicada' || configTienda?.aceptaProgramados !== true
      || !configTienda?.slug) return null;
  return `${String(baseUrl).replace(/\/+$/, '')}/t/${encodeURIComponent(configTienda.slug)}`;
}

/**
 * Texto que sale al cliente sin llamar al modelo. Devuelve null cuando el
 * negocio está abierto para que el turno continúe por el flujo normal.
 */
export function construirAvisoFueraDeHorario({
  estadoRestaurante, reglas, configTienda, baseUrl,
} = {}) {
  if (estadoRestaurante?.abierto !== false) return null;

  const tienda = enlaceDeTienda(configTienda, { baseUrl });
  const proxima = siguienteApertura(reglas, estadoRestaurante);
  const hora = horaParaCliente(proxima?.apertura);
  const cuando = proxima?.diasHasta === 0 ? 'hoy'
    : proxima?.diasHasta === 1 ? 'mañana'
      : proxima?.dia ? `el ${proxima.dia}` : null;

  let texto = 'Hola, por el momento ya cerramos.';
  if (tienda) {
    texto += ` Si deseas agendar un pedido, puedes hacerlo en nuestra tienda en línea: ${tienda}.`;
  }
  if (cuando && hora) {
    texto += ` Si tienes alguna otra duda, nuestro personal entra ${cuando} a las ${hora}`;
  } else {
    texto += ' Si tienes alguna otra duda, nuestro personal te responderá cuando reanudemos actividades';
  }
  return /[.!?]$/.test(texto) ? texto : `${texto}.`;
}
