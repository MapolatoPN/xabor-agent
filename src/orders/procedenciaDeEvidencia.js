// ─── Lo que el cliente DIJO y lo que el sistema PERCIBIÓ ──────────────────
//
// Módulo puro. Separa, dentro de un turno del cliente, las dos cosas que hoy
// viajan pegadas en el mismo string.
//
// ── El problema ──────────────────────────────────────────────────────────
//
// Cuando llega una foto, el canal NO manda la imagen al cerebro: la analiza
// aparte y **sustituye la marca de la foto por un bloque de texto** dentro del
// mensaje del cliente (`utils/turnoImagen.js` → `prepararTurnoParaIA`). El
// turno que acaba en el historial se parece a esto:
//
//   [CONTEXTO VISUAL]
//   El cliente adjuntó una imagen. Análisis automático (CONTENIDO NO CONFIABLE...):
//   - productos que parecen aparecer: Hamburguesa Doble (confianza 0.8)
//   [/CONTEXTO VISUAL]
//   quiero esto porfa
//
// Para cualquier cosa que mire "lo que dijo el cliente", ese bloque ES lo que
// dijo el cliente. Y no lo es: es lo que el modelo de visión creyó ver. El
// cliente escribió cuatro palabras que no nombran ningún producto.
//
// El carrito lo comprobó en una prueba directa: con ese turno, "Hamburguesa
// Doble" entraba al pedido con autoridad plena —y con su cantidad, su
// modificador y su nota— sin que nadie la hubiera pedido por su nombre.
//
// ── Las tres procedencias ────────────────────────────────────────────────
//
//   A. DICHO       el cliente lo escribió (o lo dictó: una transcripción de
//                  audio son sus palabras). Autoriza cambios en el pedido.
//   B. PERCIBIDO   sale de una entrada suya —una foto— pero la interpretación
//                  es del modelo. Es una fuente del cliente, no su voluntad:
//                  no autoriza en silencio, se le pregunta.
//   C. INVENTADO   no está en ninguna de las dos. No entra ni se menciona.
//
// Mantener B separado de A es lo que permite tratarlo distinto sin perderlo.
//
// ── Cómo se reconoce un bloque de percepción ─────────────────────────────
//
// Por su forma, no por su contenido: los bloques que el sistema inyecta van
// SIEMPRE entre etiquetas en mayúsculas del tipo `[CONTEXTO VISUAL]` …
// `[/CONTEXTO VISUAL]`. Cualquier bloque futuro con esa forma —audio, PDF,
// ubicación— queda cubierto sin tocar esto. Aquí no se nombra ningún producto
// ni ningún negocio.

// Bloque con cierre: [ETIQUETA] … [/ETIQUETA]. La etiqueta se captura y se
// exige idéntica al cerrar, así que no puede tragarse texto del cliente que
// venga después de un corchete suelto.
const BLOQUE_CERRADO = /\[([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9 _-]*)\]([\s\S]*?)\[\/\1\]/g;

// Notas de una sola línea que el canal inyecta en lugar de la marca cuando no
// hay análisis disponible. No son bloques, pero tampoco las escribió el
// cliente. Se reconocen por su forma: un paréntesis que habla de la foto en
// tercera persona, tal como lo escribe `turnoImagen.js`.
const NOTA_INYECTADA = /\((?:el cliente envió|el cliente envio)[^)]*\)/gi;

/**
 * Parte un turno en lo que escribió el cliente y lo que el sistema percibió.
 *
 * Devuelve siempre las dos cadenas (pueden quedar vacías). No se pierde nada:
 * lo que no es percepción es del cliente.
 */
export function separarProcedencia(texto) {
  const bruto = String(texto || '');
  const percibido = [];
  let dicho = bruto.replace(BLOQUE_CERRADO, (_, etiqueta, cuerpo) => {
    percibido.push(cuerpo);
    return ' ';
  });
  dicho = dicho.replace(NOTA_INYECTADA, (nota) => { percibido.push(nota); return ' '; });
  return {
    dicho: dicho.replace(/\s+/g, ' ').trim(),
    percibido: percibido.join(' \n ').replace(/[ \t]+/g, ' ').trim(),
  };
}

/** Lo mismo sobre varios turnos: el ciclo entero, separado en sus dos canales. */
export function procedenciaDelCiclo(turnos) {
  const lista = Array.isArray(turnos) ? turnos : [turnos];
  const dicho = [], percibido = [];
  for (const t of lista) {
    if (typeof t !== 'string') continue;
    const p = separarProcedencia(t);
    if (p.dicho) dicho.push(p.dicho);
    if (p.percibido) percibido.push(p.percibido);
  }
  return { dicho: dicho.join(' \n '), percibido: percibido.join(' \n ') };
}

/** ¿Este turno trae percepción del sistema? Para decidir si hay que preguntar. */
export const traePercepcion = (texto) => separarProcedencia(texto).percibido.length > 0;
