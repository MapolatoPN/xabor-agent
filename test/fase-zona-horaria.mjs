// Suite: zona horaria del negocio y programación en la tienda.
//
// Pruebas puras -- sin DB, sin servidor. Cubren dos cosas:
//
//  1. `src/services/zonaHoraria.js`: convertir el texto sin zona que manda un
//     `<input type="datetime-local">` en un instante real, y hacerlo igual
//     corra el proceso donde corra.
//
//  2. `validarProgramacion`: que el checkout de la tienda ya no dependa de la
//     zona del contenedor. El caso 10 es la PRUEBA DE MORDIDA -- es
//     literalmente el defecto que encontró la auditoría del 2026-09-11, con
//     los parámetros reales de mapolato-obispado.
//
// Sobre `TZ`: esta suite NO fija la zona del proceso, a propósito. El punto
// entero es que el resultado no dependa de ella, así que pasa igual con
// `TZ=UTC` (producción), sin `TZ` (Windows local) o con cualquier otra. El
// caso 8 lo comprueba de frente.
import assert from 'assert';
import { readFileSync } from 'fs';
import {
  TZ_DEFAULT, ZONAS_MEXICO, ZONAS_CATALOGO, esZonaValida, zonasDisponibles,
  offsetEnZona, desdeHoraLocal, esHoraLocalSinZona, instanteDesdeEntrada, aHoraLocal,
} from '../src/services/zonaHoraria.js';
import { validarProgramacion, LIMITE_DIAS_PROGRAMADO } from '../src/services/tiendaCheckout.js';

let pasadas = 0, fallidas = 0;
const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const MTM = 'America/Matamoros';

// ─── 1-8. El módulo de zona horaria ────────────────────────────────────────

t('1. ida y vuelta: la hora que entra es la hora que sale', () => {
  for (const local of ['2026-09-15T20:00', '2026-01-15T20:00', '2026-06-30T00:00', '2026-12-31T23:59']) {
    const d = desdeHoraLocal(local, MTM);
    assert.ok(d instanceof Date, `no resolvió ${local}`);
    assert.strictEqual(aHoraLocal(d, MTM), local, `no volvió igual: ${local}`);
  }
});

t('2. el desfase de Matamoros cambia con el horario de verano', () => {
  // Frontera: sigue a Estados Unidos, así que sí adelanta en verano.
  assert.strictEqual(offsetEnZona(new Date('2026-01-15T18:00:00Z'), MTM), -6 * 3600000);
  assert.strictEqual(offsetEnZona(new Date('2026-07-15T18:00:00Z'), MTM), -5 * 3600000);
  // Monterrey está al lado y NO cambia desde 2022. Es justo la diferencia que
  // obliga a que la zona sea por negocio y no una constante del proyecto.
  assert.strictEqual(offsetEnZona(new Date('2026-01-15T18:00:00Z'), 'America/Monterrey'), -6 * 3600000);
  assert.strictEqual(offsetEnZona(new Date('2026-07-15T18:00:00Z'), 'America/Monterrey'), -6 * 3600000);
});

t('3. las 8 de la noche del 15 de septiembre son un instante concreto', () => {
  // Septiembre: Matamoros está en UTC-5, así que 20:00 local = 01:00Z del día
  // siguiente. Este número es el que antes salía mal.
  assert.strictEqual(desdeHoraLocal('2026-09-15T20:00', MTM).toISOString(), '2026-09-16T01:00:00.000Z');
  // Enero: UTC-6.
  assert.strictEqual(desdeHoraLocal('2026-01-15T20:00', MTM).toISOString(), '2026-01-16T02:00:00.000Z');
});

t('4. la hora que no existe (8 de marzo, el reloj salta de 2:00 a 3:00) se corre hacia adelante', () => {
  const d = desdeHoraLocal('2026-03-08T02:30', MTM);
  assert.strictEqual(aHoraLocal(d, MTM), '2026-03-08T03:30', 'debe resolverse hacia adelante, no hacia atrás');
  assert.strictEqual(d.toISOString(), '2026-03-08T08:30:00.000Z');
});

t('5. la hora repetida (1 de noviembre, el reloj vuelve de 2:00 a 1:00) toma la primera', () => {
  const d = desdeHoraLocal('2026-11-01T01:30', MTM);
  assert.strictEqual(aHoraLocal(d, MTM), '2026-11-01T01:30');
  // 06:30Z es la primera vuelta (todavía en horario de verano); 07:30Z sería
  // la segunda. Se toma la primera.
  assert.strictEqual(d.toISOString(), '2026-11-01T06:30:00.000Z');
});

t('6. una fecha CON zona se respeta tal cual; una sin zona se resuelve en la del negocio', () => {
  assert.strictEqual(esHoraLocalSinZona('2026-09-15T20:00'), true);
  assert.strictEqual(esHoraLocalSinZona('2026-09-15T20:00:00Z'), false);
  assert.strictEqual(esHoraLocalSinZona('2026-09-15T20:00:00-05:00'), false);
  // El ISO con Z es un instante: no se toca.
  assert.strictEqual(instanteDesdeEntrada('2026-09-16T01:00:00.000Z', MTM).toISOString(), '2026-09-16T01:00:00.000Z');
  // El texto sin zona pasa por la zona del negocio y da el MISMO instante.
  assert.strictEqual(instanteDesdeEntrada('2026-09-15T20:00', MTM).toISOString(), '2026-09-16T01:00:00.000Z');
});

t('7. basura dentro, null fuera (nunca una fecha inventada)', () => {
  const imposibles = ['', null, undefined, 'no-es-fecha', '15/09/2026',
    '2026-13-45T99:99',   // mes 13, dia 45, 99:99 -- Date.UTC los enrollaria en silencio
    '2026-02-31T12:00',   // 31 de febrero
    '2026-00-10T12:00',   // mes 0
    '2026-09-15T24:00'];  // las 24:00 no existen
  for (const malo of imposibles) {
    const r = instanteDesdeEntrada(malo, MTM);
    assert.ok(r === null || Number.isNaN(r.getTime()), `aceptó "${malo}"`);
  }
  assert.strictEqual(desdeHoraLocal('2026-09-15T20:00', 'America/Nowhere'), null, 'zona inexistente');
});

t('8. el resultado NO depende de la zona del proceso', () => {
  // Esto es lo que estaba roto: el contenedor corre en UTC porque el
  // Dockerfile no fija TZ, y el resultado cambiaba con él.
  const original = process.env.TZ;
  const vistos = new Set();
  try {
    for (const tz of ['UTC', 'America/Matamoros', 'Asia/Tokyo', 'Europe/Madrid']) {
      process.env.TZ = tz;
      vistos.add(desdeHoraLocal('2026-09-15T20:00', MTM).toISOString());
    }
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
  assert.strictEqual(vistos.size, 1, `dio ${vistos.size} resultados distintos según TZ: ${[...vistos].join(', ')}`);
});

// ─── 9. El catálogo del selector ───────────────────────────────────────────

t('9. el catálogo separa la frontera del resto, y el runtime reconoce todas sus zonas', () => {
  const frontera = ZONAS_MEXICO.find(g => g.cambiaHorario);
  const resto = ZONAS_MEXICO.find(g => !g.cambiaHorario);
  assert.ok(frontera && resto, 'faltan los dos grupos');
  // Las cuatro de frontera son exactamente las que siguen a Estados Unidos.
  assert.deepStrictEqual(frontera.zonas.map(z => z.zona).sort(),
    ['America/Ciudad_Juarez', 'America/Matamoros', 'America/Ojinaga', 'America/Tijuana']);
  // Y la propiedad que las agrupa es real, no una etiqueta: se comprueba
  // contra ICU, zona por zona.
  const cambia = (z) => offsetEnZona(new Date('2026-01-15T18:00:00Z'), z)
                     !== offsetEnZona(new Date('2026-07-15T18:00:00Z'), z);
  for (const g of ZONAS_MEXICO) {
    for (const { zona } of g.zonas) {
      if (!esZonaValida(zona)) continue; // un runtime viejo puede no traerla
      assert.strictEqual(cambia(zona), g.cambiaHorario, `${zona} está en el grupo equivocado`);
    }
  }
  assert.ok(esZonaValida(TZ_DEFAULT), 'la zona por defecto del proyecto no existe en este runtime');
  assert.strictEqual(esZonaValida('America/Nowhere'), false);
  assert.ok(ZONAS_CATALOGO.includes(TZ_DEFAULT));
  // zonasDisponibles filtra por lo que ICU conoce, así que nunca ofrece de más.
  const ofrecidas = zonasDisponibles().flatMap(g => g.zonas.map(z => z.zona));
  assert.ok(ofrecidas.every(esZonaValida), 'ofrece una zona que este runtime no reconoce');
});

// ─── 10-14. validarProgramacion ────────────────────────────────────────────

// Los parámetros REALES que publicaba https://xabor.mx/api/tienda/mapolato-obispado
// el 2026-09-11, para que el caso de mordida sea el caso de producción.
const TIENDA = { aceptaProgramados: true, anticipacionMinutos: 40 };
const REGLAS = {
  timezone: MTM,
  horarios: Object.fromEntries(
    ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']
      .map(d => [d, { abierto: true, apertura: '10:00', cierre: '22:00' }])),
};
// Martes 15 de septiembre, 13:00 en el local (septiembre = UTC-5).
const AHORA = new Date('2026-09-15T18:00:00Z');
const programar = (local) => validarProgramacion({ tienda: TIENDA, reglas: REGLAS, programadoPara: local, ahora: AHORA });

t('10. MORDIDA: "hoy a las 8 de la noche" se agenda a las 8 de la noche', () => {
  // El defecto original: el texto sin zona se leía en UTC (la zona del
  // contenedor) y este pedido quedaba agendado para las 15:00 -- cinco horas
  // antes, con la cocina preparándolo a destiempo y sin ningún error visible.
  const r = programar('2026-09-15T20:00');
  assert.strictEqual(r.programado, true);
  assert.strictEqual(aHoraLocal(new Date(r.para), MTM), '2026-09-15T20:00',
    'se agendó a una hora distinta de la que pidió el cliente');
});

t('11. MORDIDA: una hora válida dentro del horario ya no se rechaza', () => {
  // Antes: "hoy a las 3 de la tarde" (faltan 2 horas) moría con
  // ANTICIPACION_INSUFICIENTE, y "mañana a la 1" con FUERA_DE_HORARIO pese a
  // estar en pleno horario de servicio.
  assert.strictEqual(programar('2026-09-15T15:00').programado, true, 'hoy a las 15:00');
  assert.strictEqual(programar('2026-09-16T13:00').programado, true, 'mañana a las 13:00');
  assert.strictEqual(programar('2026-09-21T21:45').programado, true, 'la semana que entra, casi al cierre');
});

t('12. lo que SÍ debe rechazarse se sigue rechazando', () => {
  const rechaza = (local, codigo) => {
    assert.throws(() => programar(local), (e) => e.codigo === codigo,
      `se esperaba ${codigo} para ${local}`);
  };
  rechaza('2026-09-15T13:20', 'ANTICIPACION_INSUFICIENTE');  // 20 min < 40
  rechaza('2026-09-15T10:00', 'ANTICIPACION_INSUFICIENTE');  // ya pasó
  rechaza('2026-09-16T08:00', 'FUERA_DE_HORARIO');           // antes de abrir
  rechaza('2026-09-16T22:00', 'FUERA_DE_HORARIO');           // la hora de cierre NO se sirve
  rechaza('2026-12-01T13:00', 'FECHA_LEJANA');               // fuera de la ventana
  rechaza('no-es-fecha', 'FECHA_INVALIDA');
});

t('13. un día cerrado se rechaza como día cerrado', () => {
  const reglasConDomingoCerrado = {
    ...REGLAS,
    horarios: { ...REGLAS.horarios, domingo: { abierto: false } },
  };
  assert.throws(
    () => validarProgramacion({ tienda: TIENDA, reglas: reglasConDomingoCerrado, programadoPara: '2026-09-20T13:00', ahora: AHORA }),
    (e) => e.codigo === 'DIA_CERRADO');
});

t('14. el contrato viejo sigue en pie: sin programar, con la tienda apagada, y con ISO absoluto', () => {
  assert.deepStrictEqual(programar(null), { programado: false, para: null });
  assert.throws(
    () => validarProgramacion({ tienda: { ...TIENDA, aceptaProgramados: false }, reglas: REGLAS, programadoPara: '2026-09-15T20:00', ahora: AHORA }),
    (e) => e.codigo === 'PROGRAMADOS_NO_DISPONIBLES');
  // Un cliente de API que mande un instante absoluto se sigue respetando: es
  // lo que hacen las suites viejas y no puede romperse.
  const r = programar('2026-09-16T01:00:00.000Z');
  assert.strictEqual(r.programado, true);
  assert.strictEqual(r.para, '2026-09-16T01:00:00.000Z');
  assert.strictEqual(LIMITE_DIAS_PROGRAMADO, 14, 'la ventana que anuncia la tienda pública');
});

// ─── 15. La zona vive en un solo lugar ─────────────────────────────────────

t('15. tiendaOnline no redefine la zona por su cuenta', async () => {
  const fuente = await import('fs').then(fs =>
    fs.readFileSync(new URL('../src/services/tiendaOnline.js', import.meta.url), 'utf8'));
  assert.ok(!/TZ_DEFAULT\s*=\s*process\.env\.[A-Z_]+\s*\|\|\s*['"]America\//.test(fuente),
    'volvió a aparecer el literal de zona horaria en tiendaOnline.js: debe venir de zonaHoraria.js');
  assert.ok(/from '\.\/zonaHoraria\.js'/.test(fuente), 'tiendaOnline.js ya no importa la zona compartida');
});

// ─── 16-21. El selector de día y hora de la tienda ─────────────────────────
//
// Se ejecuta el código REAL de panel/tienda.html, no una copia: se recorta el
// bloque del selector del propio archivo y se evalúa con un `TIENDA` y un
// `CK` de mentira. Si alguien lo renombra o lo mueve, estas pruebas truenan
// en vez de seguir validando una copia que ya dejó de ser la que corre.
function cargarSelectorDeTienda(tienda, ck) {
  const html = readFileSync(new URL('../panel/tienda.html', import.meta.url), 'utf8');
  const desde = html.indexOf('const DIAS_TIENDA =');
  const hasta = html.indexOf('function selectorProgramado()');
  assert.ok(desde > 0 && hasta > desde, 'no se encontró el bloque del selector en tienda.html');
  const bloque = html.slice(desde, hasta);
  const fn = new Function('TIENDA', 'CK',
    bloque + '\nreturn { horasDe, diasProgramables, partesTienda, hhmm, aMinDia, zonaTienda };');
  return fn(tienda, ck);
}

const HORARIO_OBISPADO = Object.fromEntries(
  ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']
    .map(d => [d, { abierto: true, apertura: '10:00', cierre: '22:00' }]));
const TIENDA_UI = {
  timezone: MTM, anticipacionMinutos: 40, limiteDiasProgramado: 14, horarios: HORARIO_OBISPADO,
};

t('16. el selector cuenta las horas en la zona del NEGOCIO, no en la del navegador', () => {
  const S = cargarSelectorDeTienda(TIENDA_UI, {});
  assert.strictEqual(S.zonaTienda(), MTM);
  // 2026-09-15T18:00Z son las 13:00 en Matamoros. Si el selector leyera la
  // zona del navegador (aquí, UTC) creería que son las 18:00 y ofrecería
  // horas corridas cinco casillas.
  const p = S.partesTienda(new Date('2026-09-15T18:00:00Z'));
  assert.strictEqual(p.iso, '2026-09-15');
  assert.strictEqual(p.minutos, 13 * 60);
});

t('17. las horas ofrecidas caben dentro del horario de ese día', () => {
  const S = cargarSelectorDeTienda(TIENDA_UI, {});
  const manana = S.diasProgramables()[1];
  assert.ok(manana.horas.length, 'mañana no ofrece ninguna hora');
  assert.strictEqual(S.hhmm(manana.horas[0]), '10:00', 'la primera hora es la de apertura');
  assert.strictEqual(S.hhmm(manana.horas[manana.horas.length - 1]), '21:45',
    'la última debe quedar ANTES del cierre: a las 22:00 ya no se sirve');
  for (const m of manana.horas) {
    assert.ok(m >= 600 && m < 1320, S.hhmm(m) + ' cae fuera de 10:00-22:00');
    assert.strictEqual(m % 15, 0, S.hhmm(m) + ' no es un bloque de 15 minutos');
  }
});

t('18. un día cerrado no se puede elegir', () => {
  const cerrado = { ...TIENDA_UI, horarios: { ...HORARIO_OBISPADO, domingo: { abierto: false } } };
  const S = cargarSelectorDeTienda(cerrado, {});
  const dias = S.diasProgramables();
  for (const d of dias) {
    if (new Date(d.iso + 'T12:00:00Z').getUTCDay() === 0) {
      assert.strictEqual(d.horas.length, 0, d.iso + ' es domingo y ofrece horas');
    }
  }
  assert.ok(dias.some(d => d.horas.length), 'ningún día quedó disponible');
});

t('19. la ventana ofrecida es la misma que el servidor acepta', () => {
  const S = cargarSelectorDeTienda(TIENDA_UI, {});
  assert.strictEqual(S.diasProgramables().length, LIMITE_DIAS_PROGRAMADO,
    'el selector ofrece más o menos días de los que el servidor va a aceptar');
});

t('20. lo que el cliente toca es lo que la cocina recibe', () => {
  const S = cargarSelectorDeTienda(TIENDA_UI, {});
  const dia = S.diasProgramables().find(d => d.horas.length);
  const valor = dia.iso + 'T' + S.hhmm(dia.horas[0]);   // lo que arma sincronizarProgramado
  assert.ok(esHoraLocalSinZona(valor), '"' + valor + '" no tiene la forma que espera el servidor');
  const r = validarProgramacion({
    tienda: { aceptaProgramados: true, anticipacionMinutos: TIENDA_UI.anticipacionMinutos },
    reglas: { timezone: MTM, horarios: HORARIO_OBISPADO },
    programadoPara: valor,
  });
  assert.strictEqual(r.programado, true, 'el servidor rechazó una hora que el selector ofreció');
  assert.strictEqual(aHoraLocal(new Date(r.para), MTM), valor,
    'se agendó a una hora distinta de la que el cliente eligió');
});

t('21. el campo crudo de fecha y hora ya no existe en la tienda', () => {
  const html = readFileSync(new URL('../panel/tienda.html', import.meta.url), 'utf8');
  assert.ok(!/type="datetime-local"/.test(html),
    'volvió el <input type="datetime-local">: mandaba hora sin zona a un servidor que la leía en la suya');
  assert.ok(/class="dias"/.test(html) && /class="horas"/.test(html), 'falta el selector de día y hora');
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas > 0) {
  console.log('\nFallos:');
  fallos.forEach(f => console.log(' - ' + f));
  process.exitCode = 1;
}
