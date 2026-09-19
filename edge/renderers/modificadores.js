// Modificadores en la comanda: una LISTA, no un párrafo.
//
// Un modificador llega de tres formas distintas según por dónde entró el
// pedido, y las tres terminan en el mismo papel:
//   · objeto {grupo, opcion}      — POS, tienda en línea, WhatsApp;
//   · texto "Salsa: Mole"         — Restaurante (mesas), ya formateado;
//   · texto suelto "Sin cebolla"  — pedidos viejos.
// `lineasDeModificadores` los reduce a UNA línea por opción, que es como se
// leen en la estación: qué lleva y qué no, sin buscar dentro de un renglón
// corrido.
//
// El otro problema que resuelve este módulo es una repetición real: varios
// flujos (POS, tienda, envíos) pegan el texto de los modificadores DENTRO de
// `notas` para que se vieran en papeles que no sabían de modificadores. En
// una comanda que ya los imprime como lista, esa nota los repite en un
// párrafo envuelto — justo lo que se lee mal. `notaSinModificadores` quita
// del texto de la nota únicamente lo que es repetición literal de los
// modificadores, y deja intacto lo que el cliente o el mesero escribieron.
// Si algo no calza exactamente, la nota se conserva entera: perder una nota
// de cocina sería mucho peor que imprimirla dos veces.
//
// Vive en edge/ porque el Edge se instala solo (el instalador copia edge/*,
// nunca src/) y el servidor lo importa desde aquí: así existe UNA sola
// implementación. Si se duplicara, el papel y el payload acabarían diciendo
// cosas distintas.

// Una opción, ya lista para el papel.
export function lineaDeModificador(m) {
  if (m === null || m === undefined) return '';
  if (typeof m === 'string') return m.trim();
  if (typeof m !== 'object') return String(m).trim();
  const opcion = String(m.opcion ?? m.nombre ?? '').trim();
  const grupo = String(m.grupo ?? '').trim();
  if (!opcion) return grupo;
  return grupo ? `${grupo}: ${opcion}` : opcion;
}

// Una línea por opción, en el orden en que se eligieron.
export function lineasDeModificadores(modificadores) {
  if (!Array.isArray(modificadores)) return [];
  return modificadores.map(lineaDeModificador).filter(Boolean);
}

// "Salsa: Mole" → { grupo: 'Salsa', opcion: 'Mole' }. Solo se usa para
// reconocer repeticiones: si parte mal, lo único que pasa es que la nota se
// conserva tal cual.
function partir(linea) {
  const i = linea.indexOf(': ');
  return i > 0 ? { grupo: linea.slice(0, i), opcion: linea.slice(i + 2) } : { grupo: '', opcion: linea };
}

// Todas las formas en que los MISMOS modificadores aparecen pegados en una
// nota: una por una, agrupadas por grupo (`textoModificadores` del servidor)
// y el bloque completo con cualquiera de los dos separadores en uso.
function formasConocidas(modificadores) {
  const lineas = lineasDeModificadores(modificadores);
  if (!lineas.length) return [];
  const porGrupo = new Map();
  for (const l of lineas) {
    const { grupo, opcion } = partir(l);
    if (!porGrupo.has(grupo)) porGrupo.set(grupo, []);
    porGrupo.get(grupo).push(opcion);
  }
  const agrupadas = [...porGrupo.entries()].map(([g, ops]) => (g ? `${g}: ${ops.join(', ')}` : ops.join(', ')));
  const formas = new Set([
    ...lineas, ...agrupadas,
    agrupadas.join(' · '), agrupadas.join(', '),
    lineas.join(' · '), lineas.join(', '),
  ]);
  // Las más largas primero: quitar "Salsa: Mole, Verde" antes que "Salsa: Mole".
  return [...formas].filter(Boolean).sort((a, b) => b.length - a.length);
}

// La nota sin la repetición de los modificadores, o null si no queda nada
// propio. Solo recorta repeticiones literales pegadas al principio o al
// final con los separadores que usan los flujos ( " · " y ", " ).
export function notaSinModificadores(notas, modificadores) {
  let resto = String(notas ?? '').trim();
  if (!resto) return null;
  const formas = formasConocidas(modificadores);
  if (!formas.length) return resto;

  let cambio = true;
  while (cambio && resto) {
    cambio = false;
    for (const forma of formas) {
      if (resto === forma) { resto = ''; cambio = true; break; }
      for (const sep of [' · ', ', ']) {
        if (resto.startsWith(forma + sep)) { resto = resto.slice(forma.length + sep.length).trim(); cambio = true; }
        if (resto.endsWith(sep + forma)) { resto = resto.slice(0, resto.length - forma.length - sep.length).trim(); cambio = true; }
      }
      if (cambio) break;
    }
  }
  return resto || null;
}
