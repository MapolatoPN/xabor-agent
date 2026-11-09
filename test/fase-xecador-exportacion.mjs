// XECADOR · exportación del registro de jornada (Parte B6).
//
// Lo que protege:
//   1. El registro sale COMPLETO: cada checada (en línea y sin conexión), cada
//      agregada y cada corrección con su motivo, autor y fecha; lo original y
//      lo que cuenta, las dos; lo anulado sigue apareciendo, marcado.
//   2. Las horas salen en la hora de los negocios (America/Matamoros), con el
//      cambio de horario bien hecho, y el periodo es de días locales completos:
//      ni una checada de más en las orillas ni una de menos.
//   3. Lo que una corrección sacó del periodo también sale (por su original).
//   4. Solo el administrador del negocio, y solo de SU negocio; un CSV no se
//      abre como fórmula en Excel y un PDF no ejecuta nada ni pide nada a la red.
//   5. El formato vive en un módulo con versión (la STPS no publica aún).
//   6. El RESUMEN por turno (para leerlo) usa lo que cuenta: entrada, descansos,
//      salida y horas con tiempo real; lo que falta lo dice en vez de inventar
//      horas; un turno de noche no se parte en las orillas del periodo.
//
// Base LOCAL desechable (test_*) con la 131. Servidor hijo y navegador real.
// Variables opcionales: TEST_PORT_XECADOR_EXPORTACION (4784), CASOS=A,B,C.
import assert from 'assert';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { arrancarServidor } from './lib-servidor.mjs';

const URL_DB = new URL(process.env.DATABASE_URL || 'postgresql://x@nadie/nada');
if (!['localhost', '127.0.0.1', '::1'].includes(URL_DB.hostname) || !URL_DB.pathname.slice(1).startsWith('test')) {
  console.error('ABORTO: esta suite solo corre contra una base local cuyo nombre empiece con "test".');
  process.exit(2);
}
const PUERTO = process.env.TEST_PORT_XECADOR_EXPORTACION || '4784';
const PARTES = new Set((process.env.CASOS || 'A,B,C').split(',').map((s) => s.trim().toUpperCase()));
const CAPTURAS = process.env.XECADOR_CAPTURAS || tmpdir();

const { pool } = await import('../src/services/database.js');
const P = await import('../src/services/personalService.js');
const F = await import('../src/services/exportacionFormato.js');
const X = await import('../src/services/exportacionService.js');
const { corregir } = await import('../src/services/correccionesService.js');
const { marcarRevisada } = await import('../src/services/checadorService.js');
const { extraerTextoPorPagina } = await import('../src/services/pdfTexto.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];
const lanza = async (fn, codigo) => {
  try { await fn(); } catch (e) { assert.strictEqual(e.codigo, codigo, `esperaba ${codigo} y vino ${e.codigo}: ${e.message}`); return e; }
  assert.fail(`no rechazó (${codigo})`);
};

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
/** Las filas del CSV como objetos por título de columna. */
function objetosCsv(texto) {
  const [cab, ...resto] = leerCsv(texto);
  return resto.map((f) => Object.fromEntries(cab.map((c, i) => [c, f[i]])));
}

// ── Fixture ─────────────────────────────────────────────────────────────────
// Periodo: lun 26 oct – mié 4 nov 2026. El domingo 1 de noviembre Matamoros
// regresa al horario de invierno (de UTC-5 a UTC-6).
const DESDE = '2026-10-26', HASTA = '2026-11-04';
const SUF = randomUUID().slice(0, 8);
const negocio = async (nombre) => (await q1(
  `INSERT INTO negocios (nombre, slug, activo, estado) VALUES ($1, $2, true, 'activo') RETURNING id`,
  [nombre, `export-${nombre.toLowerCase().replace(/[^a-z]+/g, '-')}-${SUF}`])).id;
const sucursal = async (neg, nombre) => (await q1(
  `INSERT INTO sucursales (negocio_id, nombre, activo) VALUES ($1, $2, true) RETURNING id`, [neg, nombre])).id;
const persona = async (neg, nombre, rol) => {
  const id = (await q1(`INSERT INTO usuarios (negocio_id, nombre, email, activo) VALUES ($1, $2, $3, true) RETURNING id`,
    [neg, nombre, `${rol}-${randomUUID().slice(0, 8)}@export.test.local`])).id;
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1, $2, $3, true)`, [id, neg, rol]);
  return id;
};
const sesion = (usuarioId, negocioId, rol) => crearTokenSesion({ usuarioId, negocioId, rol });

const N = await negocio('Tacos Exporta');
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
const ANA = await P.crearEmpleado(N, { numero: 1, nombre: 'Ana Exporta', puesto: 'Cocina', sucursal_id: MATRIZ, fecha_ingreso: '2026-01-15' }, { actorId: ADMIN_N });
const BETO = await P.crearEmpleado(N, { numero: 2, nombre: 'Beto Orillas', sucursal_id: MATRIZ }, { actorId: ADMIN_N });
const BAJA = await P.crearEmpleado(N, { numero: 3, nombre: 'Ceci de Baja', sucursal_id: MATRIZ }, { actorId: ADMIN_N });
const SINREG = await P.crearEmpleado(N, { numero: 4, nombre: 'Dani Sin Checadas', sucursal_id: MATRIZ }, { actorId: ADMIN_N });
// Un nombre con etiquetas: debe salir como texto, nunca como HTML.
const RARO = await P.crearEmpleado(N, { numero: 5, nombre: '<img src="http://127.0.0.1:9/x"> Eva', sucursal_id: MATRIZ }, { actorId: ADMIN_N });
const DE_M = await P.crearEmpleado(M, { numero: 1, nombre: 'Empleado de M', sucursal_id: UNICA_M }, { actorId: ADMIN_M });
await P.asignarJornada(N, ANA.id, { vigente_desde: '2026-10-01', tipo: 'diurna',
  dias: [1, 2, 3, 4, 5].map((dia) => ({ dia, entrada: '09:00', salida: '17:00' })) }, { actorId: ADMIN_N });
await P.asignarJornada(N, BETO.id, { vigente_desde: '2026-10-30', tipo: 'mixta', dias: [{ dia: 6, entrada: '14:00', salida: '22:00' }] }, { actorId: ADMIN_N });

const tablet = async (neg, suc, nombre) => (await q1(
  `INSERT INTO xecador_dispositivos (negocio_id, sucursal_id, nombre) VALUES ($1, $2, $3) RETURNING id`, [neg, suc, nombre])).id;
const T_N = await tablet(N, MATRIZ, 'Tablet Entrada');
const T_M = await tablet(M, UNICA_M, 'Tablet M');
/** Una checada con su hora oficial exacta (instante UTC). */
async function checada(emp, tipo, hora, extra = {}) {
  const neg = extra.negocio || N;
  const r = await q1(
    `INSERT INTO xecador_checadas (negocio_id, empleado_id, sucursal_id, dispositivo_id, tipo, hora_oficial, hora_dispositivo, clave,
                                   foto, origen, revision, sincronizada_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [neg, emp.id, extra.sucursal || MATRIZ, extra.tablet || T_N, tipo, hora, extra.hora_dispositivo || null, randomUUID(),
      extra.foto || 'no_requerida', extra.origen || 'en_linea', extra.revision || [], extra.sincronizada_at || null]);
  return Number(r.id);
}
const corrige = (datos) => corregir(N, { motivo: 'Ajuste de prueba', ...datos }, { actorId: ADMIN_N });

// Ana: una semana con de todo.
const ANA_E1 = await checada(ANA, 'entrada', '2026-10-27T14:00:00Z');           // mar 27 09:00 (UTC-5)
const ANA_S1 = await checada(ANA, 'salida', '2026-10-27T22:00:00Z', { foto: 'tomada' });   // 17:00 → se corrige a 17:30
const COR_S1 = await corrige({ accion: 'modificar', checada_id: ANA_S1, tipo: 'salida', hora: '2026-10-27T17:30', motivo: 'Salió más tarde, lo confirmó el gerente' });
const ANA_E2 = await checada(ANA, 'entrada', '2026-10-28T14:00:00Z');           // mié 28: se anula
const COR_E2 = await corrige({ accion: 'anular', checada_id: ANA_E2, motivo: 'Checó por error, no le tocaba' });
const ANA_SR = await checada(ANA, 'entrada', '2026-10-31T13:00:00Z', {            // sáb 31 08:00, sin conexión
  origen: 'sin_conexion', revision: ['reloj_desfasado'], foto: 'no_disponible',
  hora_dispositivo: '2026-10-31T13:10:00Z', sincronizada_at: '2026-10-31T15:00:00Z' });
await marcarRevisada(N, ANA_SR, { nota: 'Revisado con la gerente', actorId: ADMIN_N });
const ANA_E3 = await checada(ANA, 'entrada', '2026-10-31T17:00:00Z');           // sáb 31 12:00: dos entradas seguidas
const ANA_E4 = await checada(ANA, 'entrada', '2026-11-02T15:00:00Z');           // lun 2 09:00 (ya UTC-6)
const AG_S4 = await corrige({ accion: 'agregar', empleado_id: ANA.id, tipo: 'salida', hora: '2026-11-02T18:00',
  motivo: '=HYPERLINK("http://ejemplo.invalid","clic")' });                    // texto que una hoja tomaría por fórmula
void ANA_E1; void ANA_E3; void ANA_E4;

// Beto: las orillas del periodo y lo que una corrección mete o saca.
const B_ANTES = await checada(BETO, 'entrada', '2026-10-26T04:59:00Z');         // dom 25 23:59 local: fuera
const B_INICIO = await checada(BETO, 'salida', '2026-10-26T05:00:00Z');         // lun 26 00:00 local: dentro
const B_FIN = await checada(BETO, 'entrada', '2026-11-05T05:59:00Z');           // mié 4 23:59 local: dentro
const B_DESPUES = await checada(BETO, 'salida', '2026-11-05T06:00:00Z');        // jue 5 00:00 local: fuera
const B_SACADA = await checada(BETO, 'entrada', '2026-11-03T16:00:00Z');        // mar 3 10:00 → se mueve al vie 6
await corrige({ accion: 'modificar', checada_id: B_SACADA, tipo: 'entrada', hora: '2026-11-06T10:00', motivo: 'Era del viernes' });
const B_METIDA = await checada(BETO, 'salida', '2026-11-06T20:00:00Z');         // vie 6 14:00 → se mueve al mar 3
await corrige({ accion: 'modificar', checada_id: B_METIDA, tipo: 'salida', hora: '2026-11-03T18:00', motivo: 'Era del martes' });

// Ceci: con checadas en el periodo y después de baja.
const C_E = await checada(BAJA, 'entrada', '2026-10-29T14:00:00Z');
await P.darDeBajaEmpleado(N, BAJA.id, { tipo: 'renuncia', actorId: ADMIN_N });
await checada(RARO, 'entrada', '2026-10-29T15:00:00Z');
// Del otro negocio, en el mismo periodo.
await checada(DE_M, 'entrada', '2026-10-29T14:00:00Z', { negocio: M, sucursal: UNICA_M, tablet: T_M });

// ═══ A. El formato, sin servidor ════════════════════════════════════════════
if (PARTES.has('A')) {
  console.log('\n── A. Formato');

  await t('A1. CSV: comillas, comas y saltos de línea van entre comillas; lo escrito por una persona no se abre como fórmula', () => {
    assert.strictEqual(F.celdaCsv('Ana, "la jefa"'), '"Ana, ""la jefa"""');
    assert.strictEqual(F.celdaCsv('dos\r\nlíneas'), '"dos\r\nlíneas"');
    for (const peligro of ['=1+1', '+52 878', '-2', '@SUMA(A1)', '\tx', '\rx']) {
      assert.ok(F.celdaCsv(peligro, { texto: true }).replace(/^"/, '').startsWith("'"), `«${JSON.stringify(peligro)}» se neutraliza`);
    }
    assert.strictEqual(F.celdaCsv('-2'), '-2', 'un dato que no escribió nadie (número) no se toca');
    assert.strictEqual(F.celdaCsv(null), '');
    assert.strictEqual(F.celdaCsv(7), '7');
  });

  await t('A2. horas en America/Matamoros con el cambio de horario (1 nov 2026), sin depender de la zona de la máquina', () => {
    assert.deepStrictEqual(F.local('2026-07-01T15:00:00Z'), { fecha: '2026-07-01', hora: '10:00:00' }, 'verano: UTC-5');
    assert.deepStrictEqual(F.local('2026-12-01T15:00:00Z'), { fecha: '2026-12-01', hora: '09:00:00' }, 'invierno: UTC-6');
    assert.deepStrictEqual(F.local('2026-11-01T06:30:00Z'), { fecha: '2026-11-01', hora: '01:30:00' }, 'la 1:30 de horario de verano');
    assert.deepStrictEqual(F.local('2026-11-01T07:30:00Z'), { fecha: '2026-11-01', hora: '01:30:00' }, 'y la 1:30 que se repite');
    assert.deepStrictEqual(F.local('2026-10-27T04:59:59Z'), { fecha: '2026-10-26', hora: '23:59:59' }, 'el día lo pone la zona, no UTC');
    assert.strictEqual(F.local(null), null);
    assert.strictEqual(F.lunesDe('2026-11-01'), '2026-10-26', 'el domingo es de la semana que empezó el lunes');
    assert.strictEqual(F.lunesDe('2026-11-02'), '2026-11-02');
  });

  await t('A3. el formato tiene versión y cada fila la lleva; los textos de aceptación no inventan «Aceptada»', () => {
    assert.match(F.VERSION, /^xecador-registro-\d+$/);
    assert.strictEqual(F.COLUMNAS_CSV[0].titulo, 'Formato');
    const reporte = { generado: { at: new Date(), por: 'X' }, negocio: { nombre: 'N' }, periodo: { desde: DESDE, hasta: HASTA }, soloEmpleado: true,
      empleados: [{ numero: 9, nombre: 'Prueba', estatus: 'activo', jornadas: [], semanas: [{ lunes: '2026-10-26', domingo: '2026-11-01', aceptacion: 'no_solicitada' }],
        eventos: [{ folio: 'AG-1', fuente: 'agregada', original: { tipo: 'entrada', hora: '2026-10-27T14:00:00Z' },
          efectivo: { tipo: 'entrada', hora: '2026-10-27T14:00:00Z', anulada: false, corregida: false }, hora_periodo: '2026-10-27T14:00:00Z',
          checada: null, agregada: { motivo: 'm', autor: 'A', created_at: new Date() }, correcciones: [], revisar: [], revisada: null, fuera_de_orden: false }] }] };
    const filas = objetosCsv(F.csv(reporte));
    assert.strictEqual(filas.length, 1);
    assert.strictEqual(filas[0].Formato, F.VERSION);
    assert.strictEqual(filas[0]['Aceptación de la semana'], 'No solicitada');
    assert.strictEqual(F.nombreArchivo(reporte, 'csv'), 'registro-jornada_2026-10-26_2026-11-04_empleado-9.csv');
    assert.ok(F.csv(reporte).endsWith('\r\n') && !F.csv(reporte).startsWith('\ufeff'), 'CRLF; el BOM lo pone la ruta');
  });

  await t('A4. el HTML del PDF escapa todo lo que escribió una persona', () => {
    assert.strictEqual(F.escaparHtml(`<b a="1">'&`), '&lt;b a=&quot;1&quot;&gt;&#39;&amp;');
    const html = F.html({ generado: { at: new Date(), por: '<script>x()</script>' }, negocio: { nombre: '<i>N</i>' }, periodo: { desde: DESDE, hasta: HASTA },
      soloEmpleado: true, empleados: [{ numero: 1, nombre: '<img src=x onerror=alert(1)>', puesto: '"><svg>', estatus: 'activo', jornadas: [],
        semanas: [{ lunes: '2026-10-26', domingo: '2026-11-01', aceptacion: 'no_solicitada' }],
        eventos: [{ folio: 'AG-1', fuente: 'agregada', original: { tipo: 'entrada', hora: '2026-10-27T14:00:00Z' },
          efectivo: { tipo: 'entrada', hora: '2026-10-27T14:00:00Z', anulada: false, corregida: false }, hora_periodo: '2026-10-27T14:00:00Z',
          checada: null, agregada: { motivo: '</td><script>y()</script>', autor: '<u>A</u>', created_at: new Date() }, correcciones: [],
          revisar: [], revisada: null, fuera_de_orden: false }] }] });
    const cuerpo = html.slice(html.indexOf('<body>'));
    for (const crudo of ['<img', '<script', '<svg', '<i>', '<u>', '</td><script']) assert.ok(!cuerpo.includes(crudo), `sin «${crudo}» crudo`);
    assert.ok(cuerpo.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });

  await t('A5. el periodo: fechas que existen, en orden y con tope', async () => {
    assert.deepStrictEqual(X.leerPeriodo({ desde: DESDE, hasta: HASTA }), { desde: DESDE, hasta: HASTA, dias: 10 });
    assert.strictEqual(X.leerPeriodo({ desde: '2026-01-01', hasta: '2027-01-01' }).dias, 366);
    await lanza(() => X.leerPeriodo({ desde: '2026-01-01', hasta: '2027-01-02' }), 'PERIODO_DEMASIADO_LARGO');
    await lanza(() => X.leerPeriodo({ desde: '2026-02-30', hasta: '2026-03-01' }), 'FECHA_INVALIDA');
    await lanza(() => X.leerPeriodo({ desde: '26-10-2026', hasta: HASTA }), 'FECHA_INVALIDA');
    await lanza(() => X.leerPeriodo({ desde: HASTA, hasta: DESDE }), 'PERIODO_INVALIDO');
    await lanza(() => X.leerPeriodo({}), 'FECHA_INVALIDA');
    await lanza(() => X.leerPeriodo({ desde: '2026-01-01', hasta: '2026-04-04' }, X.DIAS_MAX_PDF), 'PERIODO_DEMASIADO_LARGO');
  });

  // El resumen por turno con reportes armados a mano. Noviembre 2026 ya es
  // horario de invierno: 09:00 en Matamoros = 15:00 UTC.
  const evR = (tipo, hora, extra = {}) => ({
    folio: 'CH-0', fuente: extra.fuente || 'tablet', original: { tipo, hora: extra.original || hora },
    efectivo: { tipo, hora, anulada: !!extra.anulada, corregida: !!extra.corregida }, hora_periodo: hora,
    checada: null, agregada: null, correcciones: [], revisar: extra.revisar || [], revisada: extra.revisada || null, fuera_de_orden: false });
  const repR = (eventos, { desde = '2026-11-02', hasta = '2026-11-08', ahora = '2026-11-20T00:00:00Z', contexto, nombre = 'Prueba' } = {}) => ({
    generado: { at: new Date(ahora), por: 'X' }, negocio: { nombre: 'N' }, periodo: { desde, hasta }, soloEmpleado: true,
    empleados: [{ numero: 7, nombre, estatus: 'activo', jornadas: [], semanas: [], eventos, ...(contexto ? { contexto } : {}) }] });
  // [fecha, día, entrada, descanso, salida, horas, observaciones] de cada renglón.
  const resumen = (eventos, opciones) => F.filasDelResumen(repR(eventos, opciones))
    .map((r) => [r.fecha, r.dia, r.entrada, r.descanso, r.salida, r.horas, r.observaciones]);

  await t('A6. resumen: un turno por renglón con sus descansos y las horas trabajadas (salida − entrada − descansos)', () => {
    assert.deepStrictEqual(resumen([evR('entrada', '2026-11-03T15:00:00Z'), evR('inicio_descanso', '2026-11-03T19:00:00Z'),
      evR('fin_descanso', '2026-11-03T19:30:00Z'), evR('salida', '2026-11-03T23:00:00Z')]),
    [['03/11/2026', 'martes', '09:00', '13:00 a 13:30 (30 min)', '17:00', '7:30', '']]);
    assert.deepStrictEqual(resumen([evR('entrada', '2026-11-03T15:00:42Z'), evR('inicio_descanso', '2026-11-03T18:00:00Z'),
      evR('fin_descanso', '2026-11-03T19:15:00Z'), evR('inicio_descanso', '2026-11-03T21:00:00Z'), evR('fin_descanso', '2026-11-03T21:10:00Z'),
      evR('salida', '2026-11-04T00:30:10Z')]),
    [['03/11/2026', 'martes', '09:00', '12:00 a 13:15 (1 h 15 min); 15:00 a 15:10 (10 min)', '18:30', '8:04', '']],
    'dos descansos; los segundos no cambian la hora que se ve y se redondea al minuto');
  });

  await t('A7. resumen: un turno de noche sale el día de su entrada y cuenta el tiempo real el día del cambio de horario', () => {
    // Sáb 31 oct 22:00 (UTC-5) → dom 1 nov 06:00 (UTC-6): 8 h en el reloj, 9 h de verdad.
    assert.deepStrictEqual(resumen([evR('entrada', '2026-11-01T03:00:00Z'), evR('salida', '2026-11-01T12:00:00Z')], { desde: '2026-10-26', hasta: '2026-11-01' }),
      [['31/10/2026', 'sábado', '22:00', '', '06:00 (día siguiente)', '9:00', '']]);
  });

  await t('A8. resumen: lo que falta se dice, sin inventar horas (16 h de la tablet, en turno, descansos sin cerrar)', () => {
    assert.deepStrictEqual(resumen([evR('salida', '2026-11-03T23:00:00Z')]), [['03/11/2026', 'martes', '', '', '17:00', '', 'Sin entrada']]);
    assert.deepStrictEqual(resumen([evR('entrada', '2026-11-03T15:00:00Z'), evR('entrada', '2026-11-04T15:00:00Z'), evR('salida', '2026-11-04T23:00:00Z')]), [
      ['03/11/2026', 'martes', '09:00', '', '', '', 'Sin salida'],
      ['04/11/2026', 'miércoles', '09:00', '', '17:00', '8:00', '']]);
    assert.deepStrictEqual(resumen([evR('entrada', '2026-11-03T15:00:00Z'), evR('salida', '2026-11-05T00:00:00Z')]), [
      ['03/11/2026', 'martes', '09:00', '', '', '', 'Sin salida'],
      ['04/11/2026', 'miércoles', '', '', '18:00', '', 'Sin entrada']], 'una salida 33 h después ya no es de ese turno');
    assert.deepStrictEqual(resumen([evR('entrada', '2026-11-03T15:00:00Z'), evR('inicio_descanso', '2026-11-03T19:00:00Z'), evR('salida', '2026-11-03T23:00:00Z')]),
      [['03/11/2026', 'martes', '09:00', 'desde 13:00', '17:00', '4:00', 'No registró el regreso del descanso']], 'salió estando en descanso');
    assert.deepStrictEqual(resumen([evR('entrada', '2026-11-03T15:00:00Z'), evR('fin_descanso', '2026-11-03T19:30:00Z'), evR('salida', '2026-11-03T23:00:00Z')]),
      [['03/11/2026', 'martes', '09:00', 'hasta 13:30', '17:00', '', 'Fin de descanso sin inicio']]);
    const ahora = '2026-11-03T20:00:00Z';
    assert.deepStrictEqual(resumen([evR('entrada', '2026-11-03T15:00:00Z')], { ahora }), [['03/11/2026', 'martes', '09:00', '', '', '', 'En turno']]);
    assert.deepStrictEqual(resumen([evR('entrada', '2026-11-03T15:00:00Z'), evR('inicio_descanso', '2026-11-03T19:00:00Z')], { ahora }),
      [['03/11/2026', 'martes', '09:00', 'desde 13:00', '', '', 'En descanso']]);
    assert.deepStrictEqual(resumen([evR('entrada', '2026-11-02T15:00:00Z')], { ahora }), [['02/11/2026', 'lunes', '09:00', '', '', '', 'Sin salida']],
      'abierto desde hace más de 16 h ya no está «en turno»');
  });

  await t('A9. resumen: lo que cuenta (sin lo anulado, con lo corregido), quién lo cambió, lo pendiente de revisar y el CSV', () => {
    assert.deepStrictEqual(resumen([
      evR('entrada', '2026-11-03T15:00:00Z', { corregida: true, original: '2026-11-03T14:00:00Z' }),
      evR('entrada', '2026-11-03T16:00:00Z', { anulada: true }),
      evR('salida', '2026-11-03T23:00:00Z', { fuente: 'agregada' })]),
    [['03/11/2026', 'martes', '09:00', '', '17:00', '8:00', 'Checada agregada por el administrador; Corregida por el administrador']]);
    assert.deepStrictEqual(resumen([evR('entrada', '2026-11-03T15:00:00Z', { revisar: ['reloj_desfasado', 'sin_foto'] }), evR('salida', '2026-11-03T23:00:00Z')])[0][6],
      'Para revisar: Reloj de la tablet desfasado, Sin foto');
    assert.deepStrictEqual(resumen([evR('entrada', '2026-11-03T15:00:00Z', { revisar: ['reloj_desfasado'], revisada: { por: 'A', at: new Date() } }),
      evR('salida', '2026-11-03T23:00:00Z')])[0][6], '', 'lo ya revisado no se repite');
    const rep = repR([evR('entrada', '2026-11-03T15:00:00Z'), evR('salida', '2026-11-03T23:00:00Z')], { nombre: '=HYPERLINK("x")' });
    const texto = F.csvResumen(rep);
    assert.strictEqual(texto.split('\r\n')[0], 'Fecha,Día,Núm.,Empleado,Entrada,Descanso,Salida,Horas trabajadas,Observaciones');
    assert.deepStrictEqual(leerCsv(texto)[1], ['03/11/2026', 'martes', '7', `'=HYPERLINK("x")`, '09:00', '', '17:00', '8:00', '']);
    assert.ok(texto.endsWith('\r\n') && !texto.startsWith('\ufeff'));
    assert.strictEqual(F.nombreArchivo(rep, 'csv', { resumen: true }), 'resumen-jornada_2026-11-02_2026-11-08_empleado-7.csv');
  });

  await t('A10. resumen: el turno que empezó antes del periodo no sale; el que empezó el último día sale con su salida', () => {
    const contexto = {
      antes: [{ tipo: 'entrada', hora: '2026-11-03T04:00:00Z' }],                              // lun 2, 22:00
      despues: [{ tipo: 'salida', hora: '2026-11-05T12:00:00Z' }, { tipo: 'entrada', hora: '2026-11-05T15:00:00Z' }],   // jue 5
    };
    const eventos = [evR('salida', '2026-11-03T12:00:00Z'), evR('entrada', '2026-11-05T04:00:00Z')];   // mar 3 06:00; mié 4 22:00
    assert.deepStrictEqual(resumen(eventos, { desde: '2026-11-03', hasta: '2026-11-04', contexto }),
      [['04/11/2026', 'miércoles', '22:00', '', '06:00 (día siguiente)', '8:00', '']]);
  });
}

// ═══ B. Servidor real ══════════════════════════════════════════════════════
let servidor = null;
const CHK = '/api/personal/checador';
async function bajar(ruta, cookie) {
  const headers = cookie ? { Cookie: `xabor_sesion=${encodeURIComponent(cookie)}` } : {};
  const r = await fetch(servidor.base + ruta, { headers });
  const buf = Buffer.from(await r.arrayBuffer());
  let datos = null; try { datos = JSON.parse(buf.toString('utf8')); } catch { /* binario */ }
  return { status: r.status, h: r.headers, buf, datos, texto: buf.toString('utf8') };
}
const http = async (metodo, ruta, { cookie, cuerpo } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = `xabor_sesion=${encodeURIComponent(cookie)}`;
  const r = await fetch(servidor.base + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  return { status: r.status, datos: await r.json().catch(() => null) };
};
const modulo = (neg, estado) => http('PATCH', `/api/superadmin/negocios/${neg}/modulos`, { cookie: COOKIES.super, cuerpo: { modulos: { personal: estado } } });
const ruta = (formato, { desde = DESDE, hasta = HASTA, empleado } = {}) =>
  `${CHK}/exportar.${formato}?desde=${desde}&hasta=${hasta}${empleado ? `&empleado_id=${empleado}` : ''}`;
const textoPdf = async (buf) => (await extraerTextoPorPagina(buf)).paginas.map((p) => p.texto).join('\n').replace(/\s+/g, ' ');

if (PARTES.has('B') || PARTES.has('C')) {
  servidor = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 120000 });
  for (const neg of [N, M]) assert.strictEqual((await modulo(neg, 'activo')).status, 200, 'precondición: módulo encendido');
}

if (PARTES.has('B')) {
  console.log('\n── B. Servidor real');
  let csvAna = null;

  await t('B1. CSV de un empleado: descarga privada con BOM, nombre ASCII, versión en cada fila y todas sus checadas', async () => {
    const r = await bajar(ruta('csv', { empleado: ANA.id }), COOKIES.adminN);
    assert.strictEqual(r.status, 200, r.texto.slice(0, 200));
    assert.match(r.h.get('content-type'), /^text\/csv; charset=utf-8/i);
    assert.strictEqual(r.h.get('content-disposition'), 'attachment; filename="registro-jornada_2026-10-26_2026-11-04_empleado-1.csv"');
    assert.strictEqual(r.h.get('cache-control'), 'private, no-store');
    assert.strictEqual(r.h.get('x-content-type-options'), 'nosniff');
    assert.ok(r.texto.startsWith('\ufeff'), 'con BOM, para que Excel lea los acentos');
    csvAna = objetosCsv(r.texto.slice(1));
    assert.ok(csvAna.every((f) => f.Formato === F.VERSION && f['Número de empleado'] === '1' && f.Empleado === 'Ana Exporta'));
    const folios = csvAna.map((f) => f.Folio);
    for (const id of [ANA_E1, ANA_S1, ANA_E2, ANA_SR, ANA_E3, ANA_E4]) assert.ok(folios.includes(`CH-${id}`), `CH-${id}`);
    assert.ok(folios.includes(`AG-${AG_S4.id}`), 'la agregada');
    assert.strictEqual(csvAna.filter((f) => f.Registro === 'Checada').length, 6);
  });

  await t('B2. lo original y lo corregido, las dos: la checada intacta y, debajo, su corrección con motivo, autor y fecha', () => {
    const i = csvAna.findIndex((f) => f.Folio === `CH-${ANA_S1}`);
    const [orig, cor] = [csvAna[i], csvAna[i + 1]];
    assert.deepStrictEqual([orig.Registro, orig['Fecha (America/Matamoros)'], orig['Hora (America/Matamoros)'], orig.Tipo, orig.Origen, orig.Foto],
      ['Checada', '2026-10-27', '17:00:00', 'Salida', 'Tablet en línea', 'Tomada']);
    assert.deepStrictEqual([orig['Cuenta como: fecha'], orig['Cuenta como: hora'], orig.Estado], ['2026-10-27', '17:30:00', 'Cuenta']);
    assert.deepStrictEqual([orig.Sucursal, orig.Tablet], ['Matriz', 'Tablet Entrada']);
    assert.deepStrictEqual([cor.Registro, cor.Folio, cor['Corrige a'], cor['Acción'], cor['Hora (America/Matamoros)'], cor.Motivo, cor['Hecho por']],
      ['Corrección', `CO-${COR_S1.id}`, `CH-${ANA_S1}`, 'Modificar', '17:30:00', 'Salió más tarde, lo confirmó el gerente', 'Admin N']);
    assert.match(cor['Registrado el'], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.strictEqual(cor['Cuenta como: hora'], '', 'la fila de corrección no repite lo que cuenta');
    // La anulada sigue en el registro, marcada, con su corrección.
    const j = csvAna.findIndex((f) => f.Folio === `CH-${ANA_E2}`);
    assert.strictEqual(csvAna[j].Estado, 'Anulada');
    assert.deepStrictEqual([csvAna[j + 1]['Acción'], csvAna[j + 1].Folio, csvAna[j + 1].Motivo], ['Anular', `CO-${COR_E2.id}`, 'Checó por error, no le tocaba']);
  });

  await t('B3. horas locales con el cambio de horario; sin conexión, para revisar, revisada y fuera de orden', () => {
    const de = (id) => csvAna.find((f) => f.Folio === id);
    assert.deepStrictEqual([de(`CH-${ANA_E1}`)['Hora (America/Matamoros)'], de(`CH-${ANA_E4}`)['Hora (America/Matamoros)']], ['09:00:00', '09:00:00'],
      'las 9 de la mañana antes y después del 1 de noviembre (14:00 y 15:00 UTC)');
    const sr = de(`CH-${ANA_SR}`);
    assert.deepStrictEqual([sr.Origen, sr['Hora del reloj de la tablet'], sr.Foto, sr['Para revisar'], sr['Revisada por'], sr['Nota de la revisión']],
      ['Tablet sin conexión', '2026-10-31 08:10:00', 'No disponible', 'Reloj de la tablet desfasado; Sin foto', 'Admin N', 'Revisado con la gerente']);
    assert.strictEqual(sr['Registrado el'], '2026-10-31 10:00:00', 'llegó al servidor al sincronizar');
    assert.strictEqual(de(`CH-${ANA_E3}`)['Fuera de orden'], 'Sí', 'dos entradas seguidas');
    assert.strictEqual(de(`CH-${ANA_E1}`)['Fuera de orden'], 'No');
    assert.ok(csvAna.filter((f) => f.Registro !== 'Corrección').every((f) => f['Aceptación de la semana'] === 'No solicitada'),
      'sin aceptación semanal todavía (Parte B5): nunca «Aceptada»');
  });

  await t('B4. la agregada: del administrador, con su motivo… y sin abrirse como fórmula en una hoja de cálculo', () => {
    const ag = csvAna.find((f) => f.Folio === `AG-${AG_S4.id}`);
    assert.deepStrictEqual([ag.Registro, ag.Origen, ag['Hecho por'], ag['Fecha (America/Matamoros)'], ag['Hora (America/Matamoros)'], ag.Tipo],
      ['Agregada', 'Administrador', 'Admin N', '2026-11-02', '18:00:00', 'Salida']);
    assert.strictEqual(ag.Motivo, `'=HYPERLINK("http://ejemplo.invalid","clic")`);
  });

  await t('B5. el periodo son días locales completos; lo que una corrección sacó o metió también sale', async () => {
    const r = await bajar(ruta('csv', { empleado: BETO.id }), COOKIES.adminN);
    const filas = objetosCsv(r.texto.slice(1));
    const folios = new Set(filas.map((f) => f.Folio));
    assert.ok(folios.has(`CH-${B_INICIO}`), 'lun 26 00:00 local entra');
    assert.ok(folios.has(`CH-${B_FIN}`), 'mié 4 23:59 local entra');
    assert.ok(!folios.has(`CH-${B_ANTES}`), 'dom 25 23:59 local no entra');
    assert.ok(!folios.has(`CH-${B_DESPUES}`), 'jue 5 00:00 local no entra');
    const sacada = filas.find((f) => f.Folio === `CH-${B_SACADA}`);
    assert.deepStrictEqual([sacada['Fecha (America/Matamoros)'], sacada['Cuenta como: fecha']], ['2026-11-03', '2026-11-06'], 'sale por su original');
    const metida = filas.find((f) => f.Folio === `CH-${B_METIDA}`);
    assert.deepStrictEqual([metida['Fecha (America/Matamoros)'], metida['Cuenta como: fecha'], metida['Cuenta como: hora']], ['2026-11-06', '2026-11-03', '18:00:00']);
  });

  await t('B6. CSV de todos: los de este negocio con algo en el periodo (bajas incluidas), nada de otro negocio', async () => {
    const r = await bajar(ruta('csv'), COOKIES.adminN);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.h.get('content-disposition'), 'attachment; filename="registro-jornada_2026-10-26_2026-11-04_todos.csv"');
    const filas = objetosCsv(r.texto.slice(1));
    const numeros = [...new Set(filas.map((f) => f['Número de empleado']))];
    assert.deepStrictEqual(numeros, ['1', '2', '3', '5'], 'en orden de número; sin el que no checó');
    assert.ok(!r.texto.includes('Empleado de M') && !r.texto.includes('Tablet M'), 'nada de M');
    assert.strictEqual(filas.find((f) => f.Folio === `CH-${C_E}`).Empleado, 'Ceci de Baja');
    // El de M baja el suyo, y nada de N.
    const m = await bajar(ruta('csv'), COOKIES.adminM);
    const deM = objetosCsv(m.texto.slice(1));
    assert.deepStrictEqual([...new Set(deM.map((f) => f.Empleado))], ['Empleado de M']);
    assert.ok(!m.texto.includes('Ana Exporta'));
  });

  await t('B7. PDF de un empleado: datos, jornada, semanas con su aceptación, lo anulado y las correcciones, con número de página', async () => {
    const r = await bajar(ruta('pdf', { empleado: ANA.id }), COOKIES.adminN);
    assert.strictEqual(r.status, 200, r.texto.slice(0, 200));
    assert.strictEqual(r.h.get('content-type'), 'application/pdf');
    assert.strictEqual(r.h.get('content-disposition'), 'attachment; filename="registro-jornada_2026-10-26_2026-11-04_empleado-1.pdf"');
    assert.strictEqual(r.h.get('cache-control'), 'private, no-store');
    assert.strictEqual(r.buf.subarray(0, 5).toString(), '%PDF-');
    writeFileSync(join(CAPTURAS, 'xecador-registro-ana.pdf'), r.buf);
    const texto = await textoPdf(r.buf);
    for (const esperado of ['Registro de jornada', 'Tacos Exporta', '#1 Ana Exporta', 'Cocina', 'Ingreso: jue 15 ene 2026',
      'Periodo: del lun 26 oct 2026 al mié 4 nov 2026', 'Generado:', 'por Admin N', F.VERSION, 'Desde jue 1 oct 2026 · Diurna',
      'Semana del lun 26 oct 2026 al dom 1 nov 2026 · Aceptación del empleado: No solicitada',
      'Semana del lun 2 nov 2026 al dom 8 nov 2026', 'ANULADA', 'Checó por error, no le tocaba', 'Corregida',
      'Original de la tablet: Salida 2026-10-27 17:00:00', 'Salió más tarde, lo confirmó el gerente', `CO-${COR_S1.id}`,
      'Registrada sin conexión', 'Reloj de la tablet: 2026-10-31 08:10:00', 'Para revisar: Reloj de la tablet desfasado, Sin foto',
      'Revisada por Admin N', 'Fuera de orden', 'Agregada por Admin N', 'Página 1 de']) {
      assert.ok(texto.includes(esperado), `falta «${esperado}» en el PDF`);
    }
  });

  await t('B8. PDF de una baja y de quien no checó; un nombre con etiquetas sale como texto', async () => {
    const baja = await textoPdf((await bajar(ruta('pdf', { empleado: BAJA.id }), COOKIES.adminN)).buf);
    assert.match(baja, /Estatus: Baja desde .*\(Renuncia\)/);
    const nada = await bajar(ruta('pdf', { empleado: SINREG.id }), COOKIES.adminN);
    assert.strictEqual(nada.status, 200);
    const t0 = await textoPdf(nada.buf);
    assert.ok(t0.includes('Sin checadas esta semana') && t0.includes('Sin jornada asignada'));
    const raro = await textoPdf((await bajar(ruta('pdf', { empleado: RARO.id }), COOKIES.adminN)).buf);
    assert.ok(raro.includes('<img src="http://127.0.0.1:9/x"> Eva'), 'el nombre tal cual, como texto');
  });

  await t('B9. al imprimir el PDF no corre JavaScript ni se pide nada a la red (defensa además del escape)', async () => {
    let pedidos = 0;
    const espia = createServer((req, res) => { pedidos++; res.end('x'); });
    await new Promise((ok) => espia.listen(0, '127.0.0.1', ok));
    const u = `http://127.0.0.1:${espia.address().port}`;
    try {
      const pdf = await X.htmlAPdf(`<!DOCTYPE html><html><head><link rel="stylesheet" href="${u}/css"></head><body>
        <p id="p">contenido original</p><img src="${u}/img"><iframe src="${u}/marco"></iframe>
        <script>document.getElementById('p').textContent = 'EJECUTADO'; fetch('${u}/js');</script></body></html>`);
      const texto = await textoPdf(pdf);
      assert.ok(texto.includes('contenido original') && !texto.includes('EJECUTADO'), 'sin JavaScript');
      await new Promise((ok) => setTimeout(ok, 300));
      assert.strictEqual(pedidos, 0, 'ni una petición a la red');
    } finally {
      espia.close();
    }
  });

  await t('B10. lo que se pide mal se rechaza con un motivo claro', async () => {
    const casos = [
      [ruta('csv', { desde: '' }), 400, 'FECHA_INVALIDA'],
      [ruta('csv', { desde: '2026-02-30' }), 400, 'FECHA_INVALIDA'],
      [ruta('csv', { desde: HASTA, hasta: DESDE }), 400, 'PERIODO_INVALIDO'],
      [ruta('csv', { desde: '2025-01-01', hasta: '2026-01-02' }), 400, 'PERIODO_DEMASIADO_LARGO'],
      [ruta('pdf', { desde: '2026-01-01', hasta: '2026-04-04', empleado: ANA.id }), 400, 'PERIODO_DEMASIADO_LARGO'],
      [ruta('pdf'), 400, 'EMPLEADO_REQUERIDO'],
      [ruta('csv', { empleado: 'no-es-uuid' }), 404, 'EMPLEADO_NO_ENCONTRADO'],
      [ruta('csv', { empleado: DE_M.id }), 404, 'EMPLEADO_NO_ENCONTRADO'],
      [ruta('pdf', { empleado: DE_M.id }), 404, 'EMPLEADO_NO_ENCONTRADO'],
      [ruta('csv', { empleado: randomUUID() }), 404, 'EMPLEADO_NO_ENCONTRADO'],
    ];
    for (const [r, status, codigo] of casos) {
      const x = await bajar(r, COOKIES.adminN);
      assert.deepStrictEqual([x.status, x.datos?.codigo], [status, codigo], r);
      assert.ok(!x.h.get('content-disposition'), 'un error no es una descarga');
    }
    // Tampoco con el parámetro repetido (Express lo vuelve arreglo).
    const doble = await bajar(`${ruta('csv')}&desde=2026-10-01`, COOKIES.adminN);
    assert.deepStrictEqual([doble.status, doble.datos?.codigo], [400, 'FECHA_INVALIDA']);
  });

  await t('B11. solo el administrador del negocio: sin sesión 401, staff 403, Superadmin 403, módulo suspendido 403', async () => {
    for (const formato of ['csv', 'pdf']) {
      const r = ruta(formato, { empleado: ANA.id });
      assert.strictEqual((await bajar(r)).status, 401, `${formato} sin sesión`);
      assert.strictEqual((await bajar(r, COOKIES.staffN)).status, 403, `${formato} staff`);
      const s = await bajar(r, COOKIES.super);
      assert.deepStrictEqual([s.status, s.datos?.codigo], [403, 'superadmin_sin_acceso_personal'], `${formato} superadmin`);
    }
    assert.strictEqual((await modulo(N, 'suspendido')).status, 200);
    try {
      const r = await bajar(ruta('csv'), COOKIES.adminN);
      assert.deepStrictEqual([r.status, r.datos?.codigo], [403, 'modulo_suspendido']);
    } finally {
      await modulo(N, 'activo');
    }
    assert.strictEqual((await bajar(ruta('csv'), COOKIES.adminN)).status, 200, 'de vuelta');
  });

  await t('B12. exportar no escribe nada: checadas, correcciones y revisiones quedan igual', async () => {
    const cuenta = async () => (await q1(`SELECT (SELECT COUNT(*) FROM xecador_checadas)::int c, (SELECT COUNT(*) FROM xecador_correcciones)::int k,
      (SELECT COUNT(*) FROM xecador_revisiones)::int r, (SELECT COUNT(*) FROM xecador_empleado_eventos)::int b`));
    const antes = await cuenta();
    await bajar(ruta('csv'), COOKIES.adminN);
    await bajar(ruta('pdf', { empleado: ANA.id }), COOKIES.adminN);
    await bajar(`${ruta('csv')}&vista=resumen`, COOKIES.adminN);
    assert.deepStrictEqual(await cuenta(), antes);
  });

  // [fecha, día, núm., empleado, entrada, descanso, salida, horas, observaciones]
  const filasResumen = (texto) => leerCsv(texto.slice(1)).slice(1);

  await t('B13. resumen de un empleado: un renglón por turno con lo que cuenta (corregido, agregado, sin lo anulado)', async () => {
    const r = await bajar(`${ruta('csv', { empleado: ANA.id })}&vista=resumen`, COOKIES.adminN);
    assert.strictEqual(r.status, 200, r.texto.slice(0, 200));
    assert.strictEqual(r.h.get('content-disposition'), 'attachment; filename="resumen-jornada_2026-10-26_2026-11-04_empleado-1.csv"');
    assert.match(r.h.get('content-type'), /^text\/csv; charset=utf-8/i);
    assert.strictEqual(r.h.get('cache-control'), 'private, no-store');
    assert.ok(r.texto.startsWith('\ufeffFecha,Día,Núm.,Empleado,Entrada,Descanso,Salida,Horas trabajadas,Observaciones\r\n'));
    assert.deepStrictEqual(filasResumen(r.texto), [
      ['27/10/2026', 'martes', '1', 'Ana Exporta', '09:00', '', '17:30', '8:30', 'Corregida por el administrador'],
      ['31/10/2026', 'sábado', '1', 'Ana Exporta', '08:00', '', '', '', 'Sin salida'],
      ['31/10/2026', 'sábado', '1', 'Ana Exporta', '12:00', '', '', '', 'Sin salida'],
      ['02/11/2026', 'lunes', '1', 'Ana Exporta', '09:00', '', '18:00', '9:00', 'Checada agregada por el administrador'],
    ], 'la del 28 se anuló; la sin conexión ya se revisó; la salida corregida cuenta a las 17:30');
  });

  await t('B14. resumen en las orillas: el turno que empezó antes no sale; el del último día sale con su salida de después', async () => {
    const r = await bajar(`${ruta('csv', { empleado: BETO.id })}&vista=resumen`, COOKIES.adminN);
    assert.deepStrictEqual(filasResumen(r.texto), [
      ['03/11/2026', 'martes', '2', 'Beto Orillas', '', '', '18:00', '', 'Sin entrada; Corregida por el administrador'],
      ['04/11/2026', 'miércoles', '2', 'Beto Orillas', '23:59', '', '00:00 (día siguiente)', '0:01', ''],
    ], 'la salida del lun 26 00:00 es del turno del dom 25; la entrada que se movió al vie 6 no es de este periodo');
  });

  await t('B15. resumen de todos (solo de este negocio); vista inválida o repetida se rechaza; sin sesión 401, staff 403', async () => {
    const r = await bajar(`${ruta('csv')}&vista=resumen`, COOKIES.adminN);
    assert.strictEqual(r.h.get('content-disposition'), 'attachment; filename="resumen-jornada_2026-10-26_2026-11-04_todos.csv"');
    const filas = filasResumen(r.texto);
    assert.deepStrictEqual(filas.map((f) => f[2]), ['1', '1', '1', '1', '2', '2', '3', '5']);
    assert.deepStrictEqual(filas.find((f) => f[2] === '3'), ['29/10/2026', 'jueves', '3', 'Ceci de Baja', '09:00', '', '', '', 'Sin salida']);
    assert.strictEqual(filas.find((f) => f[2] === '5')[3], '<img src="http://127.0.0.1:9/x"> Eva');
    assert.ok(!r.texto.includes('Empleado de M'));
    const completo = await bajar(`${ruta('csv')}&vista=completo`, COOKIES.adminN);
    assert.strictEqual(completo.h.get('content-disposition'), 'attachment; filename="registro-jornada_2026-10-26_2026-11-04_todos.csv"');
    for (const malo of ['&vista=otra', '&vista=resumen&vista=resumen']) {
      const x = await bajar(`${ruta('csv')}${malo}`, COOKIES.adminN);
      assert.deepStrictEqual([x.status, x.datos?.codigo], [400, 'VISTA_INVALIDA'], malo);
      assert.ok(!x.h.get('content-disposition'));
    }
    assert.strictEqual((await bajar(`${ruta('csv')}&vista=resumen`)).status, 401);
    assert.strictEqual((await bajar(`${ruta('csv')}&vista=resumen`, COOKIES.staffN)).status, 403);
    const m = await bajar(`${ruta('csv')}&vista=resumen`, COOKIES.adminM);
    assert.deepStrictEqual([...new Set(filasResumen(m.texto).map((f) => f[3]))], ['Empleado de M']);
  });
}

// ═══ C. Navegador: el administrador descarga desde su celular ═══════════════
if (PARTES.has('C')) {
  console.log('\n── C. Navegador');
  const { default: puppeteer } = await import('puppeteer');
  const navegador = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const ESPERA = { timeout: 15000 };

  await t('C1. a 390 px: elige empleado y periodo, descarga CSV y PDF; con «Todos» solo CSV; un error se explica ahí mismo', async () => {
    const ctx = await navegador.createBrowserContext();
    const pagina = await ctx.newPage();
    await pagina.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    // Lo que se descarga se lee en la página (el archivo real lo guarda el navegador).
    await pagina.evaluateOnNewDocument(() => {
      window.__descargas = [];
      const original = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (!this.download) return original.call(this);
        const nombre = this.download;
        fetch(this.href).then((r) => r.arrayBuffer()).then((b) => window.__descargas.push({
          // ignoreBOM: true para VER el BOM (por omisión el decodificador lo quita).
          nombre, bytes: b.byteLength, inicio: new TextDecoder('utf-8', { ignoreBOM: true }).decode(b.slice(0, 600)) }));
      };
    });
    await pagina.setCookie({ name: 'xabor_sesion', value: COOKIES.adminN, url: servidor.base });
    await pagina.goto(servidor.base + '/personal', { waitUntil: 'networkidle0' });
    await pagina.waitForSelector('#directorio:not(.oculto)', ESPERA);
    await pagina.click('#tab-checador');
    await pagina.waitForFunction(() => document.querySelectorAll('#ex-empleado option').length > 1, ESPERA);
    const opciones = await pagina.$$eval('#ex-empleado option', (os) => os.map((o) => o.textContent));
    assert.strictEqual(opciones[0], 'Todos (solo CSV)');
    assert.ok(opciones.includes('#3 Ceci de Baja (baja)'), 'las bajas también');
    assert.ok(await pagina.$eval('#ex-pdf', (b) => b.disabled), 'con «Todos» el PDF no se puede');
    const fijar = (sel, valor) => pagina.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('change')); }, valor);
    await fijar('#ex-desde', DESDE);
    await fijar('#ex-hasta', HASTA);
    assert.ok(!(await pagina.$eval('#ex-resumen', (b) => b.disabled)), 'el resumen sí, también de todos');
    await pagina.click('#ex-resumen');
    await pagina.waitForFunction(() => window.__descargas.length === 1, ESPERA);
    let [d] = await pagina.evaluate(() => window.__descargas);
    assert.strictEqual(d.nombre, 'resumen-jornada_2026-10-26_2026-11-04_todos.csv');
    assert.ok(d.inicio.charCodeAt(0) === 0xfeff && d.inicio.slice(1).startsWith('Fecha,Día,Núm.,Empleado,Entrada'), d.inicio.slice(0, 60));
    await pagina.click('#ex-csv');
    await pagina.waitForFunction(() => window.__descargas.length === 2, ESPERA);
    d = (await pagina.evaluate(() => window.__descargas))[1];
    assert.strictEqual(d.nombre, 'registro-jornada_2026-10-26_2026-11-04_todos.csv');
    assert.ok(d.inicio.startsWith('\ufeffFormato,Número de empleado'), d.inicio.slice(0, 60));
    await pagina.select('#ex-empleado', ANA.id);
    assert.ok(!(await pagina.$eval('#ex-pdf', (b) => b.disabled)));
    await pagina.click('#ex-pdf');
    await pagina.waitForFunction(() => window.__descargas.length === 3, { timeout: 60000 });
    d = (await pagina.evaluate(() => window.__descargas))[2];
    assert.strictEqual(d.nombre, 'registro-jornada_2026-10-26_2026-11-04_empleado-1.pdf');
    assert.ok(d.inicio.startsWith('%PDF-') && d.bytes > 5000);
    assert.ok(!(await pagina.$eval('#ex-pdf', (b) => b.disabled)), 'el botón vuelve');
    // Un periodo de más de tres meses en PDF: lo dice el servidor, ahí mismo.
    await fijar('#ex-desde', '2026-01-01');
    await pagina.click('#ex-pdf');
    await pagina.waitForFunction(() => document.getElementById('ex-error').textContent.trim(), ESPERA);
    assert.match(await pagina.$eval('#ex-error', (e) => e.textContent), /hasta 93 días/);
    await fijar('#ex-desde', '2026-11-05');
    await pagina.click('#ex-csv');
    assert.match(await pagina.$eval('#ex-error', (e) => e.textContent), /«Desde» va antes que «Hasta»/);
    assert.strictEqual((await pagina.evaluate(() => window.__descargas)).length, 3, 'un error no descarga nada');
    assert.ok(await pagina.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'sin scroll horizontal a 390 px');
    await pagina.$eval('#ch-exportar-bloque', (el) => el.scrollIntoView());
    await pagina.screenshot({ path: join(CAPTURAS, 'xecador-exportar.png') });
    await ctx.close();
  });

  await navegador.close();
}

if (servidor) servidor.detener();
await pool.end();
console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('\nFallos:'); fallos.forEach((f) => console.log(' - ' + f)); }
writeFileSync(join(CAPTURAS, 'xecador-exportacion-resultado.txt'), `${pasadas} ${fallidas}\n`);
process.exit(fallidas ? 1 : 0);
