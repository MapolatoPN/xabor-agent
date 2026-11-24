// XECADOR · Parte B4: horas y faltas de la semana (14-nov-2026, pedido de Mario).
//
// Lo que protege (reglas de Mario):
//   1. Cuenta la jornada de cada quien, la que regía ESE día. Lo checado
//      antes de su entrada o después de su salida, y un turno en su día de
//      descanso, queda «fuera de jornada» y solo suma si el administrador lo
//      autoriza como extra (con motivo; nunca más de lo checado).
//   2. El descanso se paga: no se descuenta.
//   3. Sin tolerancia: 7:01 con jornada de 7:00 es retardo; 7:00:59 no.
//   4. Semana de lunes a domingo. Falta = día de su jornada, ya terminado, sin
//      ningún turno, siendo empleado; se justifica con motivo. Los días de
//      descanso obligatorio (LFT 74) no son falta.
//   5. Extra: dobles hasta 9 h a la semana y triples después; avisos de más de
//      3 h en un día o extra en más de 3 días (LFT 66–68).
//   6. Lo que decide el administrador es de solo inserción, con autor y
//      motivo; manda el último; `base` evita pisar el cambio de otra persona.
//   7. Solo el administrador del negocio (ni staff, ni otro negocio, ni el
//      Superadmin).
//
// Base LOCAL desechable (test_*) con la 138. Servidor hijo y navegador real.
// Variables opcionales: TEST_PORT_XECADOR_HORAS (4786), CASOS=A,B,C.
import assert from 'assert';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { arrancarServidor } from './lib-servidor.mjs';
import { cookie2faDe } from './lib-superadmin-2fa.mjs';

const URL_DB = new URL(process.env.DATABASE_URL || 'postgresql://x@nadie/nada');
if (!['localhost', '127.0.0.1', '::1'].includes(URL_DB.hostname) || !URL_DB.pathname.slice(1).startsWith('test')) {
  console.error('ABORTO: esta suite solo corre contra una base local cuyo nombre empiece con "test".');
  process.exit(2);
}
const PUERTO = process.env.TEST_PORT_XECADOR_HORAS || '4786';
const PARTES = new Set((process.env.CASOS || 'A,B,C').split(',').map((s) => s.trim().toUpperCase()));
if (PARTES.has('C')) PARTES.add('B');   // C sigue sobre lo que dejó B (la extra del jueves, el viernes justificado)
const CAPTURAS = process.env.XECADOR_CAPTURAS || tmpdir();

const H = await import('../src/services/horasChecador.js');

/** CSV (RFC 4180) → filas de celdas. */
function leerCsv(texto) {
  const filas = []; let fila = [], celda = '', comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { celda += '"'; i++; }
      else if (c === '"') comillas = false;
      else celda += c;
    } else if (c === '"') comillas = true;
    else if (c === ',') { fila.push(celda); celda = ''; }
    else if (c === '\r' && texto[i + 1] === '\n') { fila.push(celda); filas.push(fila); fila = []; celda = ''; i++; }
    else celda += c;
  }
  if (celda || fila.length) { fila.push(celda); filas.push(fila); }
  return filas;
}

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// Las horas de prueba con su desfase escrito a mano (no con la función que se
// prueba): noviembre en Matamoros es UTC-6; septiembre, UTC-5 (horario de verano).
const L = (fecha, hora, off = '-06:00') => Date.parse(`${fecha}T${hora.length === 5 ? `${hora}:00` : hora}${off}`);
const turno = (fecha, entrada, salida, descansos = [], { off = '-06:00', fechaSalida = fecha, notas = [] } = {}) => ({
  inicio: L(fecha, entrada, off), entrada: L(fecha, entrada, off), salida: salida ? L(fechaSalida, salida, off) : null,
  descansos: descansos.map(([a, b]) => ({ desde: L(fecha, a, off), hasta: L(fecha, b, off) })), notas: new Set(notas), eventos: [],
});
const lunASab = (entrada, salida) => [1, 2, 3, 4, 5, 6].map((dia) => ({ dia, entrada, salida }));
const JORNADA_7_15 = [{ vigente_desde: '2026-10-01', tipo: 'diurna', dias: lunASab('07:00', '15:00') }];
const W = '2026-11-02';   // lunes; la semana entera ya pasó
const resumen = (r) => r.dias.map((d) => `${d.fecha.slice(8)}:${d.dentro}/${d.fuera}/${d.autorizado}/r${d.retardo}${d.falta ? (d.justificada ? '/J' : '/F') : ''}`);

// ═══ A. El cálculo, sin base ═══════════════════════════════════════════════
if (PARTES.has('A')) {
  console.log('\n── A. Horas de la semana (puras)');

  await t('A1. hora de pared de Matamoros → instante, con y sin horario de verano (también el día del cambio)', () => {
    assert.strictEqual(H.msLocal('2026-11-02', '07:00'), L('2026-11-02', '07:00', '-06:00'));
    assert.strictEqual(H.msLocal('2026-07-01', '07:00'), L('2026-07-01', '07:00', '-05:00'));
    assert.strictEqual(H.msLocal('2026-03-08', '01:30'), L('2026-03-08', '01:30', '-06:00'));
    assert.strictEqual(H.msLocal('2026-03-08', '03:30'), L('2026-03-08', '03:30', '-05:00'));
    assert.strictEqual(H.msLocal('2026-11-01', '00:30'), L('2026-11-01', '00:30', '-05:00'));
    assert.ok(H.esLunes('2026-11-02') && !H.esLunes('2026-11-03') && !H.esLunes('2026-02-30') && !H.esLunes('2026-11-2'));
  });

  await t('A2. días de descanso obligatorio (LFT 74): fijos, lunes móviles y el 1 de octubre de cada seis años', () => {
    const si = ['2026-01-01', '2026-02-02', '2026-03-16', '2026-05-01', '2026-09-16', '2026-11-16', '2026-12-25',
      '2027-02-01', '2027-03-15', '2027-11-15', '2030-10-01'];
    const no = ['2026-11-02', '2026-11-17', '2026-10-01', '2026-02-09', '2027-11-22', '2026-12-01'];
    assert.deepStrictEqual(si.filter((f) => !H.descansoObligatorio(f)), []);
    assert.deepStrictEqual(no.filter((f) => H.descansoObligatorio(f)), []);
  });

  await t('A3. la semana de una persona: jornada, fuera de jornada, retardo, falta, descanso pagado, día de descanso trabajado', () => {
    const r = H.horasDeLaSemana({
      lunes: W, jornadas: JORNADA_7_15, ahora: '2026-11-14T18:00:00Z',
      turnos: [
        turno('2026-11-02', '06:58', '15:00', [['08:15', '08:33']]),
        turno('2026-11-03', '07:01', '15:13'),
        turno('2026-11-05', '07:00', '17:30', [['08:00', '08:30']]),
        turno('2026-11-07', '06:55', '15:02', [['08:30', '09:00']]),
        turno('2026-11-08', '08:00', '12:00'),
      ],
    });
    // dentro/fuera/autorizado/retardo, por día (el descanso NO se descuenta).
    assert.deepStrictEqual(resumen(r),
      ['02:480/2/0/r0', '03:479/13/0/r1', '04:0/0/0/r0/F', '05:480/150/0/r0', '06:0/0/0/r0/F', '07:480/7/0/r0', '08:0/240/0/r0']);
    assert.deepStrictEqual(r.dias[1].notas, ['sin_descanso'], 'martes: 8 h 12 min sin descanso');
    assert.deepStrictEqual(r.dias[0].notas, [], 'lunes sí descansó');
    assert.deepStrictEqual(r.dias[6].notas, ['descanso_trabajado']);
    assert.strictEqual(r.dias[6].jornada, null);
    assert.deepStrictEqual(r.dias[0].jornada, { tipo: 'diurna', entrada: '07:00', salida: '15:00' });
    assert.strictEqual(r.dias[1].salida_antes, 0);
    assert.deepStrictEqual(r.totales, {
      programado: 2880, dentro: 1919, fuera: 412, autorizado: 0, trabajado: 1919, extra_dobles: 0, extra_triples: 0,
      retardos: 1, minutos_retardo: 1, faltas: 2, justificadas: 0, incompletos: 0,
    });
    assert.deepStrictEqual(r.avisos, []);
    assert.strictEqual(r.maximo_semanal_horas, 48);
  });

  await t('A4. retardo sin tolerancia: 7:00:59 no, 7:01:00 sí (1 min); salir antes se anota', () => {
    const de = (entrada, salida = '15:00') => H.horasDeLaSemana({ lunes: W, jornadas: JORNADA_7_15, ahora: '2026-11-14T18:00:00Z',
      turnos: [turno('2026-11-02', entrada, salida)] }).dias[0];
    assert.strictEqual(de('07:00:59').retardo, 0);
    assert.strictEqual(de('07:01:00').retardo, 1);
    assert.strictEqual(de('07:16:30').retardo, 16);
    assert.strictEqual(de('07:00', '14:40').salida_antes, 20);
    assert.strictEqual(de('07:00', '14:40').dentro, 460);
  });

  await t('A5. extra: solo lo autorizado, nunca más de lo checado fuera; manda el último ajuste (0 lo retira)', () => {
    const turnos = [turno('2026-11-05', '07:00', '17:30')];
    const base = { lunes: W, jornadas: JORNADA_7_15, ahora: '2026-11-14T18:00:00Z', turnos };
    const jue = (ajustes) => H.horasDeLaSemana({ ...base, ajustes }).dias[3];
    assert.strictEqual(jue([]).autorizado, 0);
    assert.strictEqual(jue([{ id: 1, fecha: '2026-11-05', tipo: 'extra', minutos: 120 }]).trabajado, 600);
    assert.strictEqual(jue([{ id: 1, fecha: '2026-11-05', tipo: 'extra', minutos: 200 }]).autorizado, 150, 'tope: lo checado fuera');
    assert.strictEqual(jue([{ id: 1, fecha: '2026-11-05', tipo: 'extra', minutos: 120 }, { id: 2, fecha: '2026-11-05', tipo: 'extra', minutos: 0 }]).autorizado, 0);
    assert.strictEqual(jue([{ id: 1, fecha: '2026-11-04', tipo: 'extra', minutos: 120 }]).autorizado, 0, 'el de otro día no cuenta');
  });

  await t('A6. extra de la semana: dobles hasta 9 h, triples después; avisos de más de 3 h en un día y de más de 3 días', () => {
    const fechas = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
    const r = H.horasDeLaSemana({
      lunes: W, jornadas: JORNADA_7_15, ahora: '2026-11-14T18:00:00Z',
      turnos: fechas.map((f, i) => turno(f, '07:00', i === 0 ? '19:00' : '17:00', [['09:00', '09:30']])),
      ajustes: fechas.map((f, i) => ({ id: i + 1, fecha: f, tipo: 'extra', minutos: i === 0 ? 240 : 120 })),
    });
    assert.strictEqual(r.totales.autorizado, 720);
    assert.deepStrictEqual([r.totales.extra_dobles, r.totales.extra_triples], [540, 180]);
    assert.deepStrictEqual(r.avisos, ['extra_mas_de_3_h', 'extra_mas_de_3_dias']);
    const tres = H.horasDeLaSemana({ lunes: W, jornadas: JORNADA_7_15, ahora: '2026-11-14T18:00:00Z',
      turnos: fechas.slice(0, 3).map((f) => turno(f, '07:00', '18:00')),
      ajustes: fechas.slice(0, 3).map((f, i) => ({ id: i + 1, fecha: f, tipo: 'extra', minutos: 180 })) });
    assert.deepStrictEqual(tres.avisos, [], '3 h justas en 3 días: dentro de la ley');
  });

  await t('A7. jornada nocturna que cruza la medianoche; la jornada que regía ESE día; jornada de la semana sobre el máximo', () => {
    const noche = [{ vigente_desde: '2026-10-01', tipo: 'nocturna', dias: [1, 2, 3, 4, 5].map((dia) => ({ dia, entrada: '22:00', salida: '05:00' })) }];
    const r = H.horasDeLaSemana({ lunes: W, jornadas: noche, ahora: '2026-11-14T18:00:00Z',
      turnos: [turno('2026-11-02', '22:05', '05:30', [], { fechaSalida: '2026-11-03' })] });
    assert.deepStrictEqual([r.dias[0].dentro, r.dias[0].fuera, r.dias[0].retardo, r.dias[0].programado], [415, 30, 5, 420]);
    assert.strictEqual(r.dias[1].falta, true, 'el martes es otro día de su jornada');
    // Cambio de jornada desde el jueves: 9 a 17. El jueves a las 9 no es retardo.
    const cambio = [...JORNADA_7_15, { vigente_desde: '2026-11-05', tipo: 'diurna', dias: lunASab('09:00', '17:00') }];
    const c = H.horasDeLaSemana({ lunes: W, jornadas: cambio, ahora: '2026-11-14T18:00:00Z',
      turnos: [turno('2026-11-02', '07:00', '15:00'), turno('2026-11-05', '09:00', '17:00')] });
    assert.deepStrictEqual([c.dias[0].retardo, c.dias[3].retardo, c.dias[3].dentro, c.dias[3].fuera], [0, 0, 480, 0]);
    assert.deepStrictEqual(c.dias[3].jornada, { tipo: 'diurna', entrada: '09:00', salida: '17:00' });
    const siete = [{ vigente_desde: '2026-10-01', tipo: 'diurna', dias: [1, 2, 3, 4, 5, 6, 7].map((dia) => ({ dia, entrada: '07:00', salida: '15:00' })) }];
    assert.ok(H.horasDeLaSemana({ lunes: W, jornadas: siete, ahora: '2026-11-14T18:00:00Z' }).avisos.includes('jornada_sobre_maximo'));
  });

  await t('A8. faltas: no antes del ingreso ni desde la baja; un día de descanso obligatorio no es falta; justificada; hoy: «sin entrada todavía»', () => {
    const r = H.horasDeLaSemana({ lunes: W, jornadas: JORNADA_7_15, ahora: '2026-11-14T18:00:00Z', fechaIngreso: '2026-11-04', bajaFecha: '2026-11-07',
      ajustes: [{ id: 1, fecha: '2026-11-05', tipo: 'falta', justificada: true, motivo: 'Permiso' }] });
    assert.deepStrictEqual(r.dias.map((d) => (d.falta ? (d.justificada ? 'J' : 'F') : '-')).join(''), '--FJF--');
    assert.deepStrictEqual([r.totales.faltas, r.totales.justificadas], [2, 1]);
    // Justificada y luego retirada: vuelve a ser falta.
    const ret = H.horasDeLaSemana({ lunes: W, jornadas: JORNADA_7_15, ahora: '2026-11-14T18:00:00Z',
      ajustes: [{ id: 1, fecha: '2026-11-02', tipo: 'falta', justificada: true, motivo: 'a' }, { id: 2, fecha: '2026-11-02', tipo: 'falta', justificada: false, motivo: 'b' }] });
    assert.deepStrictEqual([ret.dias[0].falta, ret.dias[0].justificada], [true, false]);
    // Semana del 16 de noviembre (lunes de descanso obligatorio).
    const fest = H.horasDeLaSemana({ lunes: '2026-11-16', jornadas: JORNADA_7_15, ahora: '2026-11-23T18:00:00Z',
      turnos: [turno('2026-11-17', '07:00', '15:00')] });
    assert.deepStrictEqual([fest.dias[0].festivo, fest.dias[0].falta, fest.dias[0].programado], [true, false, 0]);
    assert.strictEqual(fest.totales.programado, 5 * 480);
    const trabajado = H.horasDeLaSemana({ lunes: '2026-11-16', jornadas: JORNADA_7_15, ahora: '2026-11-23T18:00:00Z',
      turnos: [turno('2026-11-16', '07:00', '15:00', [['10:00', '10:30']])] });
    assert.deepStrictEqual([trabajado.dias[0].dentro, trabajado.dias[0].notas], [480, ['festivo_trabajado']]);
    // Hoy (lunes 2-nov a las 8:00): sin checar todavía no es falta; en turno no es incompleto.
    const hoy = H.horasDeLaSemana({ lunes: W, jornadas: JORNADA_7_15, ahora: '2026-11-02T14:00:00Z' });
    assert.deepStrictEqual([hoy.dias[0].falta, hoy.dias[0].sin_llegar, hoy.dias[1].falta, hoy.dias[1].sin_llegar], [false, true, false, false]);
    const enTurno = H.horasDeLaSemana({ lunes: W, jornadas: JORNADA_7_15, ahora: '2026-11-02T14:00:00Z',
      turnos: [turno('2026-11-02', '06:59', null, [], { notas: ['en_turno'] })] });
    assert.deepStrictEqual([enTurno.dias[0].en_curso, enTurno.dias[0].incompletos, enTurno.dias[0].falta], [true, 0, false]);
  });

  await t('A9. sin jornada capturada: todo es fuera de jornada y la semana lo avisa; un turno sin salida es incompleto', () => {
    const r = H.horasDeLaSemana({ lunes: W, ahora: '2026-11-14T18:00:00Z',
      turnos: [turno('2026-11-02', '07:00', '15:00', [['10:00', '10:30']]), turno('2026-11-03', '07:00', null, [], { notas: ['sin_salida'] })] });
    assert.deepStrictEqual([r.dias[0].dentro, r.dias[0].fuera, r.dias[0].notas], [0, 480, ['sin_jornada']]);
    assert.deepStrictEqual([r.dias[1].incompletos, r.dias[1].notas], [1, ['incompleto', 'sin_jornada']]);
    assert.deepStrictEqual(r.avisos, ['sin_jornada']);
    assert.strictEqual(r.totales.faltas, 0, 'sin jornada no hay faltas');
  });

  await t('A10. el CSV: un renglón por día y uno de total, con las columnas acordadas', () => {
    const h = H.horasDeLaSemana({
      lunes: W, jornadas: JORNADA_7_15, ahora: '2026-11-14T18:00:00Z',
      turnos: [turno('2026-11-02', '07:01', '15:00'), turno('2026-11-05', '07:00', '17:30', [['12:00', '12:30']]), turno('2026-11-08', '08:00', '12:00')],
      ajustes: [{ id: 1, fecha: '2026-11-05', tipo: 'extra', minutos: 120, motivo: 'Inventario' },
        { id: 2, fecha: '2026-11-06', tipo: 'falta', justificada: true, motivo: '=Permiso' }],
    });
    const filas = leerCsv(H.csvHoras({ semana: { lunes: W, domingo: '2026-11-08' }, empleados: [{ numero: 7, nombre: 'Prueba Siete', ...h }] }));
    assert.deepStrictEqual(filas[0], H.COLUMNAS_HORAS);
    assert.strictEqual(filas.length, 1 + 7 + 1);
    assert.deepStrictEqual(filas[1], ['02/11/2026', 'lunes', '7', 'Prueba Siete', '07:00-15:00', '07:01', '15:00', '7:59', '', '', '7:59', '1', '', 'Más de 6 h sin descanso']);
    assert.deepStrictEqual(filas[4].slice(7, 14), ['8:00', '2:30', '2:00', '10:00', '', '', 'Extra: Inventario']);
    assert.strictEqual(filas[5][12], 'Justificada: =Permiso');
    assert.deepStrictEqual(filas[7].slice(4, 14), ['Descanso', '08:00', '12:00', '0:00', '4:00', '', '0:00', '', '', 'Trabajó en su día de descanso']);
    assert.deepStrictEqual(filas[8], ['02/11/2026 a 08/11/2026', 'Total', '7', 'Prueba Siete', '48:00 programadas', '', '', '15:59', '6:30', '2:00',
      '17:59', '1 (1 min)', '3 y 1 justificada(s)', 'Extra: 2:00 dobles, 0:00 triples']);
  });
}

// ═══ Fixture con base ══════════════════════════════════════════════════════
if (!PARTES.has('B') && !PARTES.has('C')) {
  console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
  process.exit(fallidas ? 1 : 0);
}
const { pool } = await import('../src/services/database.js');
const P = await import('../src/services/personalService.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];

const SUF = randomUUID().slice(0, 8);
const negocio = async (nombre) => (await q1(
  `INSERT INTO negocios (nombre, slug, activo, estado) VALUES ($1, $2, true, 'activo') RETURNING id`,
  [nombre, `horas-${nombre.toLowerCase().replace(/[^a-z]+/g, '-')}-${SUF}`])).id;
const sucursal = async (neg, nombre) => (await q1(
  `INSERT INTO sucursales (negocio_id, nombre, activo) VALUES ($1, $2, true) RETURNING id`, [neg, nombre])).id;
const persona = async (neg, nombre, rol) => {
  const id = (await q1(`INSERT INTO usuarios (negocio_id, nombre, email, activo) VALUES ($1, $2, $3, true) RETURNING id`,
    [neg, nombre, `${rol}-${randomUUID().slice(0, 8)}@horas.test.local`])).id;
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1, $2, $3, true)`, [id, neg, rol]);
  return id;
};
const sesion = (usuarioId, negocioId, rol) => crearTokenSesion({ usuarioId, negocioId, rol });

const N = await negocio('Negocio N');
const M = await negocio('Negocio M');
const PLATAFORMA = await negocio('Plataforma');
const MATRIZ = await sucursal(N, 'Matriz');
const UNICA_M = await sucursal(M, 'Única M');
const ADMIN_N = await persona(N, 'Admin N', 'admin');
const STAFF_N = await persona(N, 'Cajero N', 'staff');
const ADMIN_M = await persona(M, 'Admin M', 'admin');
const SUPER = await persona(PLATAFORMA, 'Superadmin', 'admin');
await pool.query(`INSERT INTO administradores_plataforma (usuario_id, activo) VALUES ($1, true)`, [SUPER]);
const COOKIES = {
  adminN: sesion(ADMIN_N, N, 'admin'), staffN: sesion(STAFF_N, N, 'staff'),
  adminM: sesion(ADMIN_M, M, 'admin'), super: sesion(SUPER, PLATAFORMA, 'admin'),
};
// Desde la 144 la consola de Superadmin pide también el segundo factor.
const SA2FA = await cookie2faDe({ usuarioId: SUPER, tokenSesion: COOKIES.super });
const alta = (numero, nombre, extra = {}) => P.crearEmpleado(N, { numero, nombre, sucursal_id: MATRIZ, ...extra }, { actorId: ADMIN_N });
async function jornada(emp, vigente, tipo, dias, neg = N) {
  const j = await q1(`INSERT INTO xecador_jornadas (negocio_id, empleado_id, vigente_desde, tipo) VALUES ($1, $2, $3, $4) RETURNING id`,
    [neg, emp.id, vigente, tipo]);
  for (const d of dias) {
    await pool.query(`INSERT INTO xecador_jornada_dias (jornada_id, dia, entrada, salida) VALUES ($1, $2, $3, $4)`, [j.id, d.dia, d.entrada, d.salida]);
  }
}
const T_SQL = (await q1(`INSERT INTO xecador_dispositivos (negocio_id, sucursal_id, nombre) VALUES ($1, $2, 'Tablet histórica') RETURNING id`, [N, MATRIZ])).id;
async function checada(emp, tipo, ms) {
  return Number((await q1(
    `INSERT INTO xecador_checadas (negocio_id, empleado_id, sucursal_id, dispositivo_id, tipo, hora_oficial, clave, foto)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'no_requerida') RETURNING id`,
    [N, emp.id, MATRIZ, T_SQL, tipo, new Date(ms), randomUUID()])).id);
}
async function turnoSql(emp, fecha, entrada, salida, descansos = [], { off = '-06:00', fechaSalida = fecha } = {}) {
  if (entrada) await checada(emp, 'entrada', L(fecha, entrada, off));
  for (const [a, b] of descansos) { await checada(emp, 'inicio_descanso', L(fecha, a, off)); await checada(emp, 'fin_descanso', L(fecha, b, off)); }
  if (salida) await checada(emp, 'salida', L(fechaSalida, salida, off));
}

// Semana W (2 al 8 de noviembre de 2026), ya terminada.
const ANA = await alta(1, 'Ana Semana');            // jornada L–S 7 a 15: la semana de A3
const BETO = await alta(2, 'Beto Sin Jornada');     // no tiene jornada
const CIRO = await alta(3, 'Ciro Noche');           // nocturna 22 a 5
const DINA = await alta(4, 'Dina Ingresa', { fecha_ingreso: '2026-11-05' });
const EVA = await alta(5, 'Eva Sin Salida');        // el lunes no salió
const GABO = await alta(6, 'Gabo Cambia');          // jornada nueva desde el jueves
const FEDE = await alta(7, 'Fede Festivo');         // semana del 16 de septiembre
await P.crearEmpleado(M, { numero: 1, nombre: 'Empleado de M', sucursal_id: UNICA_M }, { actorId: ADMIN_M });
for (const e of [ANA, CIRO, DINA, EVA]) await jornada(e, '2026-10-01', 'diurna', lunASab('07:00', '15:00'));
const CIRO_J = [1, 2, 3, 4, 5].map((dia) => ({ dia, entrada: '22:00', salida: '05:00' }));
await jornada(GABO, '2026-10-01', 'diurna', lunASab('07:00', '15:00'));
await jornada(GABO, '2026-11-05', 'diurna', lunASab('09:00', '17:00'));
await jornada(FEDE, '2026-09-01', 'diurna', lunASab('07:00', '15:00'));
// Ciro: nocturna (la de diurna de arriba se reemplaza con una versión posterior).
await jornada(CIRO, '2026-10-02', 'nocturna', CIRO_J);

await turnoSql(ANA, '2026-11-02', '06:58', '15:00', [['08:15', '08:33']]);
await turnoSql(ANA, '2026-11-03', '07:01', '15:13');
await turnoSql(ANA, '2026-11-05', '07:00', '17:30', [['08:00', '08:30']]);
await turnoSql(ANA, '2026-11-07', '06:55', '15:02', [['08:30', '09:00']]);
await turnoSql(ANA, '2026-11-08', '08:00', '12:00');
await turnoSql(BETO, '2026-11-02', '07:00', '15:00');
await turnoSql(CIRO, '2026-11-02', '22:05', '05:30', [], { fechaSalida: '2026-11-03' });
for (const f of ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']) {
  await turnoSql(CIRO, f, '22:00', '05:00', [], { fechaSalida: H.sumarDias(f, 1) });
}
for (const f of ['2026-11-05', '2026-11-06', '2026-11-07']) await turnoSql(DINA, f, '07:00', '15:00');
await turnoSql(EVA, '2026-11-02', '07:00', null);
for (const f of ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']) await turnoSql(EVA, f, '07:00', '15:00');
await turnoSql(GABO, '2026-11-02', '07:00', '15:00');
await turnoSql(GABO, '2026-11-05', '09:00', '17:00');
await turnoSql(FEDE, '2026-09-16', '07:00', '15:00', [['10:00', '10:30']], { off: '-05:00' });

// ═══ B. Servidor real ══════════════════════════════════════════════════════
let servidor = null;
async function http(metodo, ruta, { cookie, cuerpo } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = `xabor_sesion=${encodeURIComponent(cookie)}` + (cookie === COOKIES.super ? `; ${SA2FA}` : '');
  if (cuerpo !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(servidor.base + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)) });
  // ignoreBOM: true para VER el BOM del CSV (por omisión el decodificador lo quita).
  const texto = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer());
  let datos = null; try { datos = JSON.parse(texto); } catch { /* nada */ }
  return { status: r.status, datos, texto, headers: r.headers };
}
const modulo = (neg, estado) => http('PATCH', `/api/superadmin/negocios/${neg}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: estado } } });
const CHK = '/api/personal/checador';
const semana = async (lunes = W, cookie = COOKIES.adminN) => {
  const r = await http('GET', `${CHK}/horas?semana=${lunes}`, { cookie });
  assert.strictEqual(r.status, 200, JSON.stringify(r.datos));
  return r.datos;
};
const de = (s, emp) => s.empleados.find((e) => e.id === emp.id);
const ajuste = (cuerpo, cookie = COOKIES.adminN) => http('POST', `${CHK}/ajustes-dia`, { cookie, cuerpo: { motivo: 'Prueba', ...cuerpo } });

servidor = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 120000 });
for (const neg of [N, M]) assert.strictEqual((await modulo(neg, 'activo')).status, 200, 'precondición: módulo encendido');

if (PARTES.has('B')) {
  console.log('\n── B. Servidor real');

  await t('B1. la semana de todos: cada quien contra la jornada que regía ese día (nocturna, cambio de jornada, ingreso, sin salida, sin jornada)', async () => {
    const s = await semana();
    assert.deepStrictEqual(s.semana, { lunes: W, domingo: '2026-11-08' });
    assert.strictEqual(s.maximo_semanal_horas, 48);
    assert.deepStrictEqual(s.empleados.map((e) => e.numero), [1, 2, 3, 4, 5, 6, 7], 'los de N, en orden; nadie de M');
    const ana = de(s, ANA);
    assert.deepStrictEqual(resumen(ana),
      ['02:480/2/0/r0', '03:479/13/0/r1', '04:0/0/0/r0/F', '05:480/150/0/r0', '06:0/0/0/r0/F', '07:480/7/0/r0', '08:0/240/0/r0']);
    assert.deepStrictEqual([ana.totales.programado, ana.totales.trabajado, ana.totales.faltas], [2880, 1919, 2]);
    assert.match(ana.dias[0].turnos[0].entrada, /^2026-11-02T12:58:00/, 'las horas van como instantes');
    const beto = de(s, BETO);
    assert.deepStrictEqual([beto.avisos, beto.dias[0].fuera, beto.totales.trabajado], [['sin_jornada'], 480, 0]);
    const ciro = de(s, CIRO);
    assert.deepStrictEqual(resumen(ciro).slice(0, 5), ['02:415/30/0/r5', '03:420/0/0/r0', '04:420/0/0/r0', '05:420/0/0/r0', '06:420/0/0/r0']);
    assert.strictEqual(ciro.dias[0].jornada.tipo, 'nocturna');
    const dina = de(s, DINA);
    assert.deepStrictEqual([dina.totales.faltas, dina.totales.trabajado], [0, 3 * 480], 'antes de su ingreso no son faltas');
    const eva = de(s, EVA);
    assert.deepStrictEqual([eva.dias[0].incompletos, eva.dias[0].notas, eva.totales.incompletos, eva.totales.faltas], [1, ['incompleto'], 1, 0]);
    const gabo = de(s, GABO);
    assert.deepStrictEqual([gabo.dias[3].retardo, gabo.dias[3].jornada.entrada, gabo.dias[3].dentro], [0, '09:00', 480]);
    const fede = de(s, FEDE);
    assert.strictEqual(fede.totales.faltas, 6, 'Fede no checó esa semana');
  });

  await t('B2. extra autorizada y falta justificada: con autor y motivo; manda el último; `base` evita pisar a otra persona; tope en lo checado', async () => {
    const jue = '2026-11-05';
    const r1 = await ajuste({ empleado_id: ANA.id, fecha: jue, tipo: 'extra', minutos: 200, motivo: 'Inventario de fin de mes', base: null });
    assert.strictEqual(r1.status, 201, JSON.stringify(r1.datos));
    assert.deepStrictEqual([r1.datos.ajuste.minutos, r1.datos.ajuste.autor, r1.datos.ajuste.motivo], [200, 'Admin N', 'Inventario de fin de mes']);
    let d = de(await semana(), ANA).dias[3];
    assert.deepStrictEqual([d.autorizado, d.trabajado], [150, 630], 'nunca más de lo checado fuera (150)');
    const viejo = await ajuste({ empleado_id: ANA.id, fecha: jue, tipo: 'extra', minutos: 60, base: null });
    assert.deepStrictEqual([viejo.status, viejo.datos.codigo], [409, 'AJUSTE_CAMBIO']);
    const r2 = await ajuste({ empleado_id: ANA.id, fecha: jue, tipo: 'extra', minutos: 120, motivo: 'Solo hasta las 17:00', base: r1.datos.ajuste.id });
    assert.strictEqual(r2.status, 201, JSON.stringify(r2.datos));
    d = de(await semana(), ANA).dias[3];
    assert.deepStrictEqual([d.autorizado, d.trabajado, d.ajustes.extra.id, d.ajustes.extra.motivo], [120, 600, r2.datos.ajuste.id, 'Solo hasta las 17:00']);
    const vie = await ajuste({ empleado_id: ANA.id, fecha: '2026-11-06', tipo: 'falta', justificada: true, motivo: 'Permiso por cita médica' });
    assert.strictEqual(vie.status, 201, JSON.stringify(vie.datos));
    const s = de(await semana(), ANA);
    assert.deepStrictEqual([s.dias[4].falta, s.dias[4].justificada, s.totales.faltas, s.totales.justificadas], [true, true, 1, 1]);
    assert.deepStrictEqual([s.totales.autorizado, s.totales.trabajado, s.totales.extra_dobles], [120, 2039, 120]);
    const filas = (await pool.query(`SELECT tipo, minutos, justificada, creado_por FROM xecador_ajustes_dia WHERE empleado_id = $1 ORDER BY id`, [ANA.id])).rows;
    assert.deepStrictEqual(filas.map((f) => [f.tipo, f.minutos, f.justificada, f.creado_por]),
      [['extra', 200, null, ADMIN_N], ['extra', 120, null, ADMIN_N], ['falta', null, true, ADMIN_N]], 'el anterior se conserva');
  });

  await t('B3. lo que no es válido no se guarda (400/404) y la tabla es de solo inserción', async () => {
    const malos = [
      [{ empleado_id: ANA.id, fecha: '2026-11-05', tipo: 'extra', minutos: 1441 }, 'MINUTOS_INVALIDOS'],
      [{ empleado_id: ANA.id, fecha: '2026-11-05', tipo: 'extra', minutos: 30.5 }, 'MINUTOS_INVALIDOS'],
      [{ empleado_id: ANA.id, fecha: '2026-11-05', tipo: 'extra', minutos: '30' }, 'MINUTOS_INVALIDOS'],
      [{ empleado_id: ANA.id, fecha: '2026-11-04', tipo: 'falta', justificada: 'si' }, 'JUSTIFICADA_INVALIDA'],
      [{ empleado_id: ANA.id, fecha: '2026-11-04', tipo: 'falta', justificada: true, motivo: '   ' }, 'MOTIVO_REQUERIDO'],
      [{ empleado_id: ANA.id, fecha: '2026-11-04', tipo: 'falta', justificada: true, motivo: `a${String.fromCharCode(0)}b` }, 'MOTIVO_INVALIDO'],
      [{ empleado_id: ANA.id, fecha: '2026-11-04', tipo: 'falta', justificada: true, motivo: 'x'.repeat(301) }, 'MOTIVO_INVALIDO'],
      [{ empleado_id: ANA.id, fecha: '2026-02-30', tipo: 'falta', justificada: true }, 'FECHA_INVALIDA'],
      [{ empleado_id: ANA.id, fecha: '2026-11-04', tipo: 'bono', minutos: 5 }, 'TIPO_INVALIDO'],
      [{ empleado_id: ANA.id, fecha: '2026-11-04', tipo: 'falta', justificada: true, base: 'x' }, 'BASE_INVALIDA'],
    ];
    for (const [cuerpo, codigo] of malos) {
      const r = await ajuste(cuerpo);
      assert.deepStrictEqual([r.status, r.datos?.codigo], [400, codigo], JSON.stringify(cuerpo).slice(0, 80));
    }
    const ajeno = (await q1(`SELECT id FROM xecador_empleados WHERE negocio_id = $1`, [M])).id;
    const r = await ajuste({ empleado_id: ajeno, fecha: '2026-11-04', tipo: 'falta', justificada: true });
    assert.deepStrictEqual([r.status, r.datos.codigo], [404, 'EMPLEADO_NO_ENCONTRADO']);
    for (const s of ['2026-11-03', '2026-11-2', 'hoy', '']) {
      const g = await http('GET', `${CHK}/horas?semana=${s}`, { cookie: COOKIES.adminN });
      assert.deepStrictEqual([g.status, g.datos?.codigo], [400, 'SEMANA_INVALIDA'], s);
    }
    for (const sql of [`UPDATE xecador_ajustes_dia SET minutos = 1 WHERE empleado_id = '${ANA.id}'`,
      `DELETE FROM xecador_ajustes_dia WHERE empleado_id = '${ANA.id}'`, 'TRUNCATE xecador_ajustes_dia']) {
      await assert.rejects(pool.query(sql), /solo inserción/, sql);
    }
  });

  await t('B4. solo el administrador del negocio: staff, otro negocio y el Superadmin no ven ni cambian', async () => {
    for (const [cookie, quien] of [[COOKIES.staffN, 'staff'], [COOKIES.super, 'superadmin']]) {
      const g = await http('GET', `${CHK}/horas?semana=${W}`, { cookie });
      assert.strictEqual(g.status, 403, `${quien} GET`);
      const p = await ajuste({ empleado_id: ANA.id, fecha: '2026-11-04', tipo: 'falta', justificada: true }, cookie);
      assert.strictEqual(p.status, 403, `${quien} POST`);
      const c = await http('GET', `${CHK}/horas.csv?semana=${W}`, { cookie });
      assert.strictEqual(c.status, 403, `${quien} CSV`);
    }
    assert.strictEqual((await http('GET', `${CHK}/horas?semana=${W}`)).status, 401, 'sin sesión');
    const m = await semana(W, COOKIES.adminM);
    assert.deepStrictEqual(m.empleados.map((e) => e.nombre), ['Empleado de M']);
    const p = await ajuste({ empleado_id: ANA.id, fecha: '2026-11-04', tipo: 'falta', justificada: true }, COOKIES.adminM);
    assert.deepStrictEqual([p.status, p.datos.codigo], [404, 'EMPLEADO_NO_ENCONTRADO']);
    assert.strictEqual(Number((await q1(`SELECT COUNT(*) FROM xecador_ajustes_dia WHERE fecha = '2026-11-04'`)).count), 0);
  });

  await t('B5. el CSV de la semana: con BOM, nombre con la fecha y lo mismo que la pantalla', async () => {
    const r = await http('GET', `${CHK}/horas.csv?semana=${W}`, { cookie: COOKIES.adminN });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/csv; charset=utf-8/);
    assert.strictEqual(r.headers.get('content-disposition'), `attachment; filename="horas-semana_${W}.csv"`);
    assert.strictEqual(r.texto.charCodeAt(0), 0xfeff);
    const filas = leerCsv(r.texto.slice(1));
    assert.deepStrictEqual(filas[0], H.COLUMNAS_HORAS);
    const ana = filas.filter((f) => f[3] === 'Ana Semana');
    assert.strictEqual(ana.length, 8);
    assert.deepStrictEqual(ana[3].slice(7, 11), ['8:00', '2:30', '2:00', '10:00']);
    assert.strictEqual(ana[4][12], 'Justificada: Permiso por cita médica');
    assert.deepStrictEqual(ana[7].slice(1, 2).concat(ana[7].slice(10, 13)), ['Total', '33:59', '1 (1 min)', '1 y 1 justificada(s)']);
    assert.strictEqual(filas.filter((f) => f[1] === 'Total').length, 7);
  });

  await t('B6. la semana del 16 de septiembre: el día de descanso obligatorio no es falta y, trabajado, se marca', async () => {
    const fede = de(await semana('2026-09-14'), FEDE);
    const mie = fede.dias[2];
    assert.deepStrictEqual([mie.fecha, mie.festivo, mie.dentro, mie.notas, mie.programado], ['2026-09-16', true, 480, ['festivo_trabajado'], 0]);
    assert.deepStrictEqual([fede.totales.faltas, fede.totales.programado], [5, 5 * 480]);
    assert.match(mie.turnos[0].entrada, /^2026-09-16T12:00:00/, 'septiembre es UTC-5');
  });
}

// ═══ C. Navegador: el panel ════════════════════════════════════════════════
if (PARTES.has('C')) {
  console.log('\n── C. Navegador');
  const { default: puppeteer } = await import('puppeteer');
  const navegador = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const ESPERA = { timeout: 15000 };

  await t('C1. a 390 px: la semana por empleado; sus días al tocarlo; «Justificar» con motivo; «Autorizar extra» con minutos', async () => {
    const ctx = await navegador.createBrowserContext();
    const pagina = await ctx.newPage();
    await pagina.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await pagina.setCookie({ name: 'xabor_sesion', value: COOKIES.adminN, url: servidor.base });
    await pagina.goto(servidor.base + '/personal', { waitUntil: 'networkidle0' });
    await pagina.waitForSelector('#directorio:not(.oculto)', ESPERA);
    await pagina.click('#tab-checador');
    await pagina.waitForSelector('#hs-lista details', ESPERA);
    // Hacia atrás, semana por semana, hasta la del 2 de noviembre.
    // El título cambia al pulsar; la tarjeta, cuando llegan los datos: se espera la respuesta.
    for (let i = 0; i < 60; i++) {
      const texto = await pagina.$eval('#hs-semana', (el) => el.textContent);
      if (texto.startsWith('2 nov 2026')) break;
      const llega = pagina.waitForResponse((r) => r.url().includes('/horas?semana='), ESPERA);
      await pagina.click('#hs-anterior');
      await llega;
    }
    await pagina.waitForNetworkIdle({ idleTime: 300, timeout: 15000 });
    const tarjeta = `#hs-lista details[data-empleado="${ANA.id}"]`;
    const resumenAna = await pagina.$eval(`${tarjeta} summary`, (el) => el.textContent);
    assert.match(resumenAna, /Ana Semana/);
    assert.match(resumenAna, /33:59 h de 48:00/);
    assert.match(resumenAna, /1 falta/);
    assert.match(resumenAna, /1 retardo · 1 min/);
    assert.match(resumenAna, /Extra 2:00/);
    await pagina.click(`${tarjeta} summary`);
    const miercoles = `${tarjeta} .fila[data-fecha="2026-11-04"]`;
    await pagina.waitForSelector(miercoles, { ...ESPERA, visible: true });
    assert.match(await pagina.$eval(miercoles, (el) => el.textContent), /Falta/);
    assert.match(await pagina.$eval(`${tarjeta} .fila[data-fecha="2026-11-03"]`, (el) => el.textContent), /Retardo 1 min/);
    const ancho = await pagina.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(ancho <= 390, `sin scroll horizontal (${ancho})`);
    await pagina.$eval(tarjeta, (el) => el.scrollIntoView());
    await pagina.screenshot({ path: join(CAPTURAS, 'xecador-horas-semana.png'), fullPage: true });
    // Justificar el miércoles.
    await pagina.$$eval(`${miercoles} button`, (bs) => bs.find((b) => b.textContent === 'Justificar').click());
    await pagina.waitForSelector('#dlg-ajuste[open]', ESPERA);
    assert.match(await pagina.$eval('#aj-texto', (el) => el.textContent), /Ana Semana · miércoles 4 nov 2026: no checó/);
    await pagina.click('#aj-confirmar');
    assert.strictEqual(await pagina.$eval('#aj-error', (el) => el.textContent), 'Escribe el motivo.');
    await pagina.type('#aj-motivo', 'Vacaciones');
    await pagina.click('#aj-confirmar');
    await pagina.waitForFunction((sel) => document.querySelector(sel)?.textContent.includes('Falta justificada'), ESPERA, miercoles);
    assert.match(await pagina.$eval(`${tarjeta} summary`, (el) => el.textContent), /33:59 h de 48:00/);
    assert.strictEqual(await pagina.$eval(tarjeta, (el) => el.open), true, 'al recargar sigue abierta');
    assert.ok(!/\bfalta\b/i.test((await pagina.$eval(`${tarjeta} summary`, (el) => el.textContent)).replace('Falta justificada', '')), 'ya sin faltas');
    // Autorizar extra el martes (13 min fuera): 10 min.
    const martes = `${tarjeta} .fila[data-fecha="2026-11-03"]`;
    await pagina.$$eval(`${martes} button`, (bs) => bs.find((b) => b.textContent === 'Autorizar extra').click());
    await pagina.waitForSelector('#dlg-ajuste[open]', ESPERA);
    assert.strictEqual(await pagina.$eval('#aj-minutos', (el) => el.value), '13', 'propone lo checado fuera');
    await pagina.$eval('#aj-minutos', (el) => { el.value = '14'; });
    await pagina.type('#aj-motivo', 'Cierre de caja');
    await pagina.click('#aj-confirmar');
    assert.strictEqual(await pagina.$eval('#aj-error', (el) => el.textContent), 'Escribe minutos enteros, de 0 a 13.');
    await pagina.$eval('#aj-minutos', (el) => { el.value = '10'; });
    await pagina.click('#aj-confirmar');
    await pagina.waitForFunction((sel) => document.querySelector(sel)?.textContent.includes('Extra 0:10'), ESPERA, martes);
    assert.match(await pagina.$eval(`${tarjeta} summary`, (el) => el.textContent), /34:09 h de 48:00/);
    // Cambiarla: el diálogo trae lo autorizado y manda la referencia del último ajuste (si no, 409).
    await pagina.$$eval(`${martes} button`, (bs) => bs.find((b) => b.textContent === 'Cambiar extra').click());
    await pagina.waitForSelector('#dlg-ajuste[open]', ESPERA);
    assert.strictEqual(await pagina.$eval('#aj-minutos', (el) => el.value), '10');
    await pagina.$eval('#aj-minutos', (el) => { el.value = '5'; });
    await pagina.type('#aj-motivo', 'Solo el cierre');
    await pagina.click('#aj-confirmar');
    await pagina.waitForFunction((sel) => document.querySelector(sel)?.textContent.includes('Extra 0:05'), ESPERA, martes);
    assert.match(await pagina.$eval(`${tarjeta} summary`, (el) => el.textContent), /34:04 h de 48:00/);
    const filas =(await pool.query(`SELECT fecha::text, tipo, minutos, justificada, motivo FROM xecador_ajustes_dia WHERE empleado_id = $1 AND fecha IN ('2026-11-03', '2026-11-04') ORDER BY id`, [ANA.id])).rows;
    assert.deepStrictEqual(filas.map((f) => [f.fecha, f.tipo, f.minutos, f.justificada, f.motivo]),
      [['2026-11-04', 'falta', null, true, 'Vacaciones'], ['2026-11-03', 'extra', 10, null, 'Cierre de caja'],
        ['2026-11-03', 'extra', 5, null, 'Solo el cierre']]);
    await pagina.screenshot({ path: join(CAPTURAS, 'xecador-horas-ajustes.png'), fullPage: true });
    await ctx.close();
  });
  await navegador.close();
}

await servidor?.detener?.().catch?.(() => {});
await pool.end().catch(() => {});
console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('\nFallos:'); fallos.forEach((f) => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
