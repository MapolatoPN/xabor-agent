// ─── Zona horaria del negocio ─────────────────────────────────────────────
//
// Módulo PURO a propósito: sin `pool`, sin `server.js`, sin nada que haya que
// levantar para probarlo (mismo criterio que `normalizarFecha.js`,
// `routingEngine.js` y `politicaCobro.js`). Quien necesite resolver la zona
// de UN negocio contra la base usa `zonaNegocio.js`, que envuelve a este.
//
// ── Por qué existe ────────────────────────────────────────────────────────
//
// Un `<input type="datetime-local">` manda texto SIN zona: "2026-09-15T20:00".
// `new Date(ese texto)` lo interpreta en la zona DEL PROCESO, y el contenedor
// de producción corre en UTC porque el Dockerfile no fija `TZ`. Resultado: un
// cliente que programaba su pedido para las 8 de la noche lo agendaba para
// las 3 de la tarde, y la validación de horario evaluaba la hora equivocada.
// `desdeHoraLocal` es la única forma autorizada de convertir esa clase de
// texto en un instante: siempre con la zona del negocio de por medio.
//
// ── Sobre México y la frontera ────────────────────────────────────────────
//
// Desde 2022 México dejó el horario de verano... salvo los municipios
// fronterizos, que lo conservan para no desfasarse de Estados Unidos. Por eso
// el catálogo NO se puede reducir a "hora del centro / del pacífico": Ojinaga
// y Ciudad Juárez están en Chihuahua y en zonas distintas entre sí y distintas
// de la capital del estado. La agrupación de abajo es por ese comportamiento,
// que es lo que de verdad cambia las cuentas.

/** Zona por defecto histórica del proyecto. Ver CLAUDE.md. */
export const TZ_DEFAULT = 'America/Matamoros';

/**
 * Catálogo para el selector. `cambiaHorario` es la propiedad que importa:
 * las zonas de frontera adelantan una hora de marzo a noviembre.
 */
export const ZONAS_MEXICO = Object.freeze([
  {
    grupo: 'Frontera — cambian de horario con Estados Unidos',
    cambiaHorario: true,
    zonas: Object.freeze([
      { zona: 'America/Tijuana',       invierno: 'UTC-8', verano: 'UTC-7', lugares: 'Tijuana, Mexicali, Ensenada' },
      { zona: 'America/Ciudad_Juarez', invierno: 'UTC-7', verano: 'UTC-6', lugares: 'Ciudad Juárez' },
      { zona: 'America/Ojinaga',       invierno: 'UTC-6', verano: 'UTC-5', lugares: 'Ojinaga' },
      { zona: 'America/Matamoros',     invierno: 'UTC-6', verano: 'UTC-5', lugares: 'Matamoros, Reynosa, Nuevo Laredo, Acuña, Piedras Negras' },
    ]),
  },
  {
    grupo: 'Resto del país — sin cambio de horario',
    cambiaHorario: false,
    zonas: Object.freeze([
      { zona: 'America/Cancun',          invierno: 'UTC-5', verano: 'UTC-5', lugares: 'Quintana Roo' },
      { zona: 'America/Mexico_City',     invierno: 'UTC-6', verano: 'UTC-6', lugares: 'Ciudad de México y centro del país' },
      { zona: 'America/Monterrey',       invierno: 'UTC-6', verano: 'UTC-6', lugares: 'Monterrey y el interior de NL, Coahuila y Tamaulipas' },
      { zona: 'America/Merida',          invierno: 'UTC-6', verano: 'UTC-6', lugares: 'Yucatán, Campeche' },
      { zona: 'America/Chihuahua',       invierno: 'UTC-6', verano: 'UTC-6', lugares: 'Chihuahua (interior del estado)' },
      { zona: 'America/Bahia_Banderas',  invierno: 'UTC-6', verano: 'UTC-6', lugares: 'Bahía de Banderas, costa de Nayarit' },
      { zona: 'America/Mazatlan',        invierno: 'UTC-7', verano: 'UTC-7', lugares: 'Sinaloa, Baja California Sur' },
      { zona: 'America/Hermosillo',      invierno: 'UTC-7', verano: 'UTC-7', lugares: 'Sonora' },
    ]),
  },
]);

/** Las zonas del catálogo, en una sola lista. */
export const ZONAS_CATALOGO = Object.freeze(
  ZONAS_MEXICO.flatMap(g => g.zonas.map(z => z.zona)));

/**
 * ¿El runtime conoce esta zona? Se pregunta a ICU, no a una lista nuestra:
 * `America/Ciudad_Juarez` solo existe desde tzdata 2022g, y una imagen vieja
 * podría no traerla. Más vale rechazarla al guardar que descubrirlo después,
 * dentro de `Intl`, con la tienda ya en la calle.
 */
export function esZonaValida(zona) {
  if (typeof zona !== 'string' || !zona.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zona.trim() });
    return true;
  } catch {
    return false;
  }
}

/** Las zonas del catálogo que ESTE runtime sí reconoce. */
export function zonasDisponibles() {
  return ZONAS_MEXICO
    .map(g => ({ ...g, zonas: g.zonas.filter(z => esZonaValida(z.zona)) }))
    .filter(g => g.zonas.length);
}

/**
 * Desfase de `zona` respecto a UTC en ese instante, en milisegundos
 * (positivo al este de Greenwich; México siempre da negativo). Se calcula
 * formateando el instante en la zona y leyendo de vuelta los componentes:
 * es la forma de preguntarle a ICU sin depender de que el proceso corra en
 * ninguna zona en particular.
 */
export function offsetEnZona(fecha, zona) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: zona, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(fecha).map(x => [x.type, x.value]));
  const comoSiFueraUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return comoSiFueraUTC - fecha.getTime();
}

// "2026-09-15T20:00", "2026-09-15T20:00:00", "2026-09-15 20:00". Lo que NO
// matchea es cualquier cosa con zona explícita ("...Z", "...-05:00"): eso ya
// es un instante y no hay nada que resolver.
const HORA_LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** ¿Es un texto de fecha y hora SIN zona horaria? */
export function esHoraLocalSinZona(texto) {
  return HORA_LOCAL.test(String(texto || '').trim());
}

/**
 * Convierte "2026-09-15T20:00" en el instante real en que son las 20:00 en
 * `zona`. Devuelve `null` si el texto no tiene esa forma.
 *
 * Se prueban los DOS desfases posibles alrededor de esa fecha (el de la
 * víspera y el del día siguiente) y se comprueba cuál de los dos instantes
 * resultantes de verdad se ve como la hora pedida. Se hace así, y no con una
 * aproximación iterativa, porque los dos días raros del año necesitan una
 * decisión explícita y no un resultado accidental:
 *
 *  - **La hora que no existe** (marzo: el reloj salta de 2:00 a 3:00). Ningún
 *    candidato coincide. Se toma el POSTERIOR, que en hora local son las 3:30
 *    — la misma convención que usa `new Date()` cuando el proceso corre en esa
 *    zona.
 *  - **La hora repetida** (noviembre: el reloj vuelve de 2:00 a 1:00). Los dos
 *    candidatos coinciden. Se toma el PRIMERO, que es el que todavía está en
 *    horario de verano.
 *
 * Ambas están fijadas en `test/fase-zona-horaria.mjs`: si alguna cambia de
 * comportamiento, la suite lo dice.
 */
export function desdeHoraLocal(texto, zona) {
  const m = HORA_LOCAL.exec(String(texto || '').trim());
  if (!m) return null;
  if (!esZonaValida(zona)) return null;
  const [, Y, Mo, D, H, Mi, S = '0'] = m;
  const comoUTC = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S);
  if (Number.isNaN(comoUTC)) return null;
  // `Date.UTC` no rechaza nada: enrolla en silencio. El mes 13 se vuelve enero
  // del año siguiente, el 31 de febrero se vuelve marzo y las 99:99 se vuelven
  // el día de al lado. Una fecha imposible tiene que salir como `null`, no
  // como otra fecha -- así que se comprueba que los componentes sobrevivan
  // intactos al viaje de ida y vuelta.
  const v = new Date(comoUTC);
  const intacta = v.getUTCFullYear() === +Y && v.getUTCMonth() === +Mo - 1 && v.getUTCDate() === +D
               && v.getUTCHours() === +H && v.getUTCMinutes() === +Mi && v.getUTCSeconds() === +S;
  if (!intacta) return null;

  const DIA = 86400000;
  const antes   = comoUTC - offsetEnZona(new Date(comoUTC - DIA), zona);
  const despues = comoUTC - offsetEnZona(new Date(comoUTC + DIA), zona);
  const pedida = `${Y}-${Mo}-${D}T${H}:${Mi}`;
  const coinciden = [antes, despues].filter(t => aHoraLocal(new Date(t), zona) === pedida);

  // Ninguno coincide -> hueco de primavera, se toma el posterior.
  // Los dos coinciden -> hora repetida de otoño, se toma el primero.
  const t = coinciden.length ? Math.min(...coinciden) : Math.max(antes, despues);
  const fecha = new Date(t);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/**
 * La forma segura de convertir CUALQUIER fecha que venga de la calle:
 * si trae zona se respeta tal cual; si no la trae, se resuelve en la del
 * negocio. Nunca se cae a la zona del proceso.
 */
export function instanteDesdeEntrada(texto, zona) {
  const crudo = String(texto || '').trim();
  if (!crudo) return null;
  if (esHoraLocalSinZona(crudo)) return desdeHoraLocal(crudo, zona);
  const d = new Date(crudo);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 'YYYY-MM-DD': el día de calendario que se está viviendo en `zona`. */
export function fechaHoyEn(zona, ahora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zona }).format(ahora);
}

/**
 * El instante real en que empezó (o empieza) el día de calendario de `ahora`
 * en `zona`. Es el corte que decide a qué día operativo pertenece una venta,
 * así que se calcula con `desdeHoraLocal` —la misma pieza que ya está
 * probada— en vez de con un ida y vuelta por `toLocaleString`.
 */
export function inicioDelDiaEn(zona, ahora = new Date()) {
  return desdeHoraLocal(`${fechaHoyEn(zona, ahora)}T00:00`, zona);
}

/** Minutos transcurridos del día en `zona` (0 = medianoche). */
export function minutosDelDiaEn(zona, ahora = new Date()) {
  const hm = aHoraLocal(ahora, zona).slice(11);
  return (+hm.slice(0, 2)) * 60 + (+hm.slice(3, 5));
}

/** "2026-09-15T20:00" — la hora de pared en `zona` para ese instante. */
export function aHoraLocal(fecha, zona) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: zona, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(fecha).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
