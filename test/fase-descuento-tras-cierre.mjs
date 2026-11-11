// ─── DESCUENTO TRAS CIERRE: LA REGLA, SIN BASE ─────────────────────────────
//
// Decisión de Mario (10-nov-2026): quien escribió en el horario habitual un
// día que estuvimos cerrados recibe, al abrir, un código para la tienda en
// línea. Aquí la política pura (descuentoTrasCierrePolitica.js): qué cuenta
// como «horario habitual con el negocio cerrado», quién lo recibe y el texto.
// Horario de Acuña: lunes a sábado 7:30–14:00, domingo cerrado.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  codigoConfigurado, cuandoFue, decidirEnvio, horarioHabitual, llegoCerradoEnHorarioHabitual,
  textoDelDescuento, MARGEN_VENTANA_MIN,
} from '../src/services/descuentoTrasCierrePolitica.js';

let n = 0; let fallidas = 0;
function caso(nombre, fn) {
  try { fn(); n++; console.log(`OK ${nombre}`); }
  catch (e) { fallidas++; console.log(`FALLA ${nombre.split(' ')[0]} ${nombre}\n  ${String(e?.message || e).split('\n')[0]}`); }
}

const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const reglasAcuna = (extra = {}) => ({
  timezone: 'America/Matamoros',
  horarios: { ...Object.fromEntries(DIAS.map((d) => [d, { abierto: true, apertura: '07:30', cierre: '14:00' }])),
    domingo: { abierto: false, apertura: null, cierre: null } },
  cierres_especiales: [], ...extra,
});
const hm = (h, m = 0) => h * 60 + m;
// 15-nov-2026 es domingo; 16 lunes; 14 sábado.
const DOM = '2026-11-15', LUN = '2026-11-16', SAB = '2026-11-14';
// Instantes en milisegundos (CST, UTC-6 en noviembre).
const ms = (fecha, h, m = 0) => Date.parse(`${fecha}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-06:00`);
const msg = (fecha, h, m = 0) => ({ at: ms(fecha, h, m), fecha, minuto: hm(h, m) });
const TEL = '5218770000001';
const LUNES_731 = ms(LUN, 7, 31);
const base = (extra = {}) => ({ telefono: TEL, entrantes: [msg(DOM, 10)], humanoDespues: false, pedidoDespues: false,
  pausado: false, enRevision: false, yaEnviado: false, ...extra });
const decide = (extra, { reglas = reglasAcuna(), ahoraMs = LUNES_731 } = {}) => decidirEnvio(base(extra), { reglas, ahoraMs });

// ── P: qué es «horario habitual con el negocio cerrado» ─────────────────────
caso('P1 el domingo de Acuña: el horario habitual es el de los días que abren (7:30–14:00)', () => {
  assert.deepEqual(horarioHabitual(reglasAcuna(), DOM), { inicio: hm(7, 30), fin: hm(14) });
});
caso('P2 un domingo a las 10:00 cuenta; 7:29, 14:00 y 18:00 no', () => {
  assert.equal(llegoCerradoEnHorarioHabitual(reglasAcuna(), DOM, hm(10)), true);
  assert.equal(llegoCerradoEnHorarioHabitual(reglasAcuna(), DOM, hm(7, 30)), true);
  assert.equal(llegoCerradoEnHorarioHabitual(reglasAcuna(), DOM, hm(13, 59)), true);
  assert.equal(llegoCerradoEnHorarioHabitual(reglasAcuna(), DOM, hm(7, 29)), false);
  assert.equal(llegoCerradoEnHorarioHabitual(reglasAcuna(), DOM, hm(14)), false);
  assert.equal(llegoCerradoEnHorarioHabitual(reglasAcuna(), DOM, hm(18)), false);
});
caso('P3 un día que abre: ni abierto (lunes 10:00) ni después de cerrar (sábado 15:00) ni antes de abrir (lunes 7:00)', () => {
  assert.equal(llegoCerradoEnHorarioHabitual(reglasAcuna(), LUN, hm(10)), false);
  assert.equal(llegoCerradoEnHorarioHabitual(reglasAcuna(), SAB, hm(15)), false);
  assert.equal(llegoCerradoEnHorarioHabitual(reglasAcuna(), LUN, hm(7)), false);
});
caso('P4 un cierre especial: el día completo cuenta; uno que cierra a las 12:00 cuenta desde las 12:00', () => {
  const feriado = reglasAcuna({ cierres_especiales: [{ fecha: LUN, motivo: 'feriado' }] });
  assert.equal(llegoCerradoEnHorarioHabitual(feriado, LUN, hm(10)), true);
  const temprano = reglasAcuna({ cierres_especiales: [{ fecha: LUN, hora_cierre: '12:00' }] });
  assert.equal(llegoCerradoEnHorarioHabitual(temprano, LUN, hm(11)), false);
  assert.equal(llegoCerradoEnHorarioHabitual(temprano, LUN, hm(12, 30)), true);
});
caso('P6 un día que abre con su propio horario (sábado 8:00–13:00) y estuvo cerrado se mide con SU horario', () => {
  const corto = reglasAcuna({ cierres_especiales: [{ fecha: SAB, motivo: 'feriado' }] });
  corto.horarios.sabado = { abierto: true, apertura: '08:00', cierre: '13:00' };
  assert.deepEqual(horarioHabitual(corto, SAB), { inicio: hm(8), fin: hm(13) });
  assert.equal(llegoCerradoEnHorarioHabitual(corto, SAB, hm(12, 30)), true);
  assert.equal(llegoCerradoEnHorarioHabitual(corto, SAB, hm(13, 30)), false);
  assert.equal(llegoCerradoEnHorarioHabitual(corto, SAB, hm(7, 45)), false);
});
caso('P5 una jornada que cruza la medianoche no tiene horario habitual: no cuenta nada', () => {
  const nocturno = reglasAcuna();
  nocturno.horarios.viernes = { abierto: true, apertura: '18:00', cierre: '02:00' };
  assert.equal(horarioHabitual(nocturno, DOM), null);
  assert.equal(llegoCerradoEnHorarioHabitual(nocturno, DOM, hm(10)), false);
});

// ── D: a quién se le manda ──────────────────────────────────────────────────
caso('D1 escribió el domingo a las 10:00 y nadie lo atendió: el lunes a las 7:31 se le manda', () => {
  const d = decide({});
  assert.equal(d.razon, 'enviar'); assert.equal(d.enviar, true);
  assert.equal(d.primero.minuto, hm(10));
});
caso('D2 un teléfono técnico o vacío no recibe nada', () => {
  assert.equal(decide({ telefono: '—' }).razon, 'telefono_tecnico');
  assert.equal(decide({ telefono: 'rappi-123' }).razon, 'telefono_tecnico');
});
caso('D3 una sola vez por cliente', () => assert.equal(decide({ yaEnviado: true }).razon, 'ya_enviado'));
caso('D4 sin un mensaje en horario habitual del día cerrado no hay descuento', () => {
  assert.equal(decide({ entrantes: [msg(SAB, 15), msg(DOM, 6), msg(DOM, 18)] }).razon, 'sin_mensaje_en_cierre');
});
caso('D5 si volvió a escribir con el negocio abierto, ya lo están atendiendo', () => {
  assert.equal(decide({ entrantes: [msg(DOM, 10), msg(LUN, 7, 30)] }).razon, 'ya_escribio_abierto');
});
caso('D6 otro mensaje con el negocio cerrado (domingo 18:00) no lo impide y alarga su ventana', () => {
  const d = decide({ entrantes: [msg(DOM, 7, 35), msg(DOM, 18)] });
  assert.equal(d.razon, 'enviar');
  assert.equal(d.primero.minuto, hm(7, 35));
});
caso('D7 si el personal ya le contestó, si ya pidió o si la conversación la tiene el personal, no', () => {
  assert.equal(decide({ humanoDespues: true }).razon, 'ya_lo_atendio_el_personal');
  assert.equal(decide({ pedidoDespues: true }).razon, 'ya_pidio');
  assert.equal(decide({ pausado: true }).razon, 'conversacion_con_el_personal');
  assert.equal(decide({ enRevision: true }).razon, 'conversacion_con_el_personal');
});
caso(`D8 a su ventana de 24 h le quedan menos de ${MARGEN_VENTANA_MIN} min: no se manda`, () => {
  // Domingo 7:35 → la ventana cierra el lunes 7:35; a las 7:31 quedan 4 min.
  assert.equal(decide({ entrantes: [msg(DOM, 7, 35)] }).razon, 'ventana_vencida');
  // A las 7:25 quedaban 10 min: sí.
  assert.equal(decide({ entrantes: [msg(DOM, 7, 35)] }, { ahoraMs: ms(LUN, 7, 25) }).razon, 'enviar');
  // Un día después ya no hay nada que hacer.
  assert.equal(decide({}, { ahoraMs: ms('2026-11-17', 7, 31) }).razon, 'ventana_vencida');
});

// ── T: el texto ─────────────────────────────────────────────────────────────
const ENLACE = 'https://xabor.mx/t/mapolato-acuna';
caso('T1 el texto de Mario, con el código, el porcentaje y el enlace directo a la tienda', () => {
  const t = textoDelDescuento({ codigo: 'DOMINGO15', tipo: 'porcentaje', valor: '15.00', enlace: ENLACE, cuando: 'ayer' });
  assert.equal(t, '¡Hola! 👋 Lamentamos no haberte atendido ayer: estábamos cerrados. '
    + 'Para compensarte, aquí tienes un descuento de 15 % en nuestra tienda en línea con el código DOMINGO15:\n'
    + 'https://xabor.mx/t/mapolato-acuna\n\n¡Ya estamos en servicio! ☀️');
});
caso('T2 un monto fijo se dice en pesos; uno con centavos, con dos decimales', () => {
  assert.match(textoDelDescuento({ codigo: 'X50', tipo: 'monto_fijo', valor: 50, enlace: ENLACE }), /descuento de \$50 en/);
  assert.match(textoDelDescuento({ codigo: 'X12', tipo: 'porcentaje', valor: 12.5, enlace: ENLACE }), /descuento de 12\.50 %/);
});
caso('T3 sin algo que decir con un número, sin código o sin enlace, no hay texto', () => {
  assert.equal(textoDelDescuento({ codigo: 'X', tipo: '2x1', valor: 0, enlace: ENLACE }), null);
  assert.equal(textoDelDescuento({ codigo: 'X', tipo: 'porcentaje', valor: 0, enlace: ENLACE }), null);
  assert.equal(textoDelDescuento({ codigo: null, tipo: 'porcentaje', valor: 15, enlace: ENLACE }), null);
  assert.equal(textoDelDescuento({ codigo: 'X', tipo: 'porcentaje', valor: 15, enlace: null }), null);
});
caso('T4 «ayer», «hace un rato» o el nombre del día', () => {
  assert.equal(cuandoFue(DOM, LUN), 'ayer');
  assert.equal(cuandoFue(LUN, LUN), 'hace un rato');
  assert.equal(cuandoFue(SAB, LUN), 'el sábado');
});
caso('T5 el código de la configuración: en mayúsculas y con el formato de las promociones; si no, apagado', () => {
  assert.equal(codigoConfigurado({ cerrado_descuento_codigo: ' domingo15 ' }), 'DOMINGO15');
  assert.equal(codigoConfigurado({ cerrado_descuento_codigo: '' }), null);
  assert.equal(codigoConfigurado({}), null);
  assert.equal(codigoConfigurado({ cerrado_descuento_codigo: 'A' }), null);
  assert.equal(codigoConfigurado({ cerrado_descuento_codigo: 'DOS PALABRAS' }), null);
});

// La migración nació como 133 y tuvo que pasar a 136: mientras esperaba
// publicarse, la 133 del Xecador y la 135 de Thanksgiving llegaron antes a
// producción (y la 134 la tiene apartada feat/xecador-cara). Si se publica
// con un número repetido, el runner aplica una y la otra nunca llega.
caso('R1 el predeploy aplica la 136 una vez, después de la 135, y nadie más usa el 136', () => {
  const raiz = new URL('../', import.meta.url);
  const runner = readFileSync(new URL('scripts/predeploy-run-032-033.mjs', raiz), 'utf8');
  const lista = runner.slice(runner.indexOf('const SCRIPTS = ['), runner.indexOf('];', runner.indexOf('const SCRIPTS = [')));
  const i135 = lista.indexOf("'135-pedidos-temporada'");
  const i136 = lista.indexOf("'136-descuento-tras-cierre'");
  assert.ok(i135 > 0 && i136 > i135, 'la 136 no está en SCRIPTS o va antes de la 135');
  assert.equal(lista.split("'136-descuento-tras-cierre'").length, 2, 'una sola vez');
  assert.equal(lista.split("'136-").length, 2, 'ningún otro script del runner usa el 136');
  assert.ok(existsSync(new URL('scripts/predeploy-136-descuento-tras-cierre.mjs', raiz)), 'falta el script del predeploy');
  const mismas = readdirSync(new URL('migrations/', raiz)).filter((f) => /^136_/.test(f)).sort();
  assert.deepEqual(mismas, ['136_descuento_tras_cierre.sql', '136_descuento_tras_cierre_down.sql']);
  const predeploys = readdirSync(new URL('scripts/', raiz)).filter((f) => /^predeploy-136-/.test(f));
  assert.deepEqual(predeploys, ['predeploy-136-descuento-tras-cierre.mjs']);
});

console.log(`Descuento tras cierre: ${n} pasadas, ${fallidas} fallidas.`);
if (fallidas) process.exitCode = 1;
