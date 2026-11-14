// XECADOR · Horas y faltas de la semana — Parte B4 (datos).
//
// Junta lo que necesita horasChecador.js (que no toca la base): los turnos de
// la semana (los mismos del resumen por turno), la jornada que regía cada día
// y los ajustes del administrador (extra autorizada, faltas justificadas), y
// guarda esos ajustes (migración 138, de solo inserción).
//
// Entran a la semana: quien estaba activo en ella (aunque no haya checado:
// así salen sus faltas) y quien checó en ella aunque hoy esté de baja.
//
// Solo lo usa el administrador del negocio (las rutas llevan sus puertas).
import { pool } from './database.js';
import { PersonalError } from './personalService.js';
import { reporteRegistro } from './exportacionService.js';
import { turnosCrudos } from './exportacionFormato.js';
import { horasDeLaSemana, esLunes, sumarDias, maximoSemanalHoras, csvHoras } from './horasChecador.js';

const fallar = (mensaje, codigo, http) => { throw new PersonalError(mensaje, codigo, http); };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TIPOS_AJUSTE = ['extra', 'falta'];

function exigirNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !UUID_RE.test(negocioId.trim())) {
    fallar('No se pudo determinar el negocio de la sesión', 'TENANT_CONTEXT_REQUIRED', 500);
  }
  return negocioId.trim();
}
/** 'AAAA-MM-DD' de un día que existe, entre 2000 y 2100. */
const fechaValida = (f) => typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f) && sumarDias(f, 0) === f
  && f >= '2000-01-01' && f <= '2100-12-31';
function leerSemana(semana) {
  if (!esLunes(semana) || semana < '2000-01-01' || semana > '2100-12-31') {
    fallar('La semana va como la fecha de su lunes (AAAA-MM-DD)', 'SEMANA_INVALIDA');
  }
  return semana;
}
async function enTransaccion(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const publicaAjuste = (a) => ({
  id: Number(a.id), fecha: a.fecha, tipo: a.tipo, minutos: a.minutos === null ? null : Number(a.minutos),
  justificada: a.justificada, motivo: a.motivo, autor: a.autor ?? null, created_at: a.created_at,
});

/**
 * Las horas de la semana que empieza en `semana` (un lunes), de todos.
 *   { semana: { lunes, domingo }, generado, maximo_semanal_horas,
 *     empleados: [{ id, numero, nombre, sucursal, estatus, dias, totales, avisos }] }
 */
export async function horasDeSemana(negocioId, { semana } = {}) {
  const nid = exigirNegocio(negocioId);
  const lunes = leerSemana(semana);
  const domingo = sumarDias(lunes, 6);
  // Con contexto: lo de antes y después de la semana, para no partir un turno en la orilla.
  const reporte = await reporteRegistro(nid, { desde: lunes, hasta: domingo, conContexto: true });
  const conChecadas = new Map(reporte.empleados.map((e) => [e.id, e]));

  const { rows: empleados } = await pool.query(
    `SELECT e.id, e.numero_empleado, e.nombre, e.estatus, to_char(e.fecha_ingreso, 'YYYY-MM-DD') AS fecha_ingreso,
            to_char(e.baja_fecha, 'YYYY-MM-DD') AS baja_fecha, s.nombre AS sucursal
       FROM xecador_empleados e LEFT JOIN sucursales s ON s.id = e.sucursal_id AND s.negocio_id = e.negocio_id
      WHERE e.negocio_id = $1
        AND (e.id = ANY($4::uuid[])
             OR ((e.fecha_ingreso IS NULL OR e.fecha_ingreso <= $3::date)
                 AND (e.estatus = 'activo' OR (e.baja_fecha IS NOT NULL AND e.baja_fecha > $2::date))))
      ORDER BY e.numero_empleado`, [nid, lunes, domingo, [...conChecadas.keys()]]);
  const ids = empleados.map((e) => e.id);
  const [{ rows: jornadas }, { rows: ajustes }] = await Promise.all([
    pool.query(
      `SELECT j.id, j.empleado_id, j.tipo, to_char(j.vigente_desde, 'YYYY-MM-DD') AS vigente_desde,
              COALESCE(json_agg(json_build_object('dia', d.dia, 'entrada', to_char(d.entrada, 'HH24:MI'),
                                                  'salida', to_char(d.salida, 'HH24:MI')) ORDER BY d.dia)
                       FILTER (WHERE d.dia IS NOT NULL), '[]') AS dias
         FROM xecador_jornadas j LEFT JOIN xecador_jornada_dias d ON d.jornada_id = j.id
        WHERE j.negocio_id = $1 AND j.empleado_id = ANY($2::uuid[]) AND j.vigente_desde <= $3::date
        GROUP BY j.id
        ORDER BY j.empleado_id, j.vigente_desde, j.id`, [nid, ids, domingo]),
    pool.query(
      `SELECT a.id, a.empleado_id, to_char(a.fecha, 'YYYY-MM-DD') AS fecha, a.tipo, a.minutos, a.justificada, a.motivo,
              a.created_at, u.nombre AS autor
         FROM xecador_ajustes_dia a LEFT JOIN usuarios u ON u.id = a.creado_por
        WHERE a.negocio_id = $1 AND a.empleado_id = ANY($2::uuid[]) AND a.fecha BETWEEN $3::date AND $4::date
        ORDER BY a.id`, [nid, ids, lunes, domingo]),
  ]);

  return {
    semana: { lunes, domingo }, generado: reporte.generado.at, maximo_semanal_horas: maximoSemanalHoras(lunes),
    empleados: empleados.map((e) => {
      const emp = conChecadas.get(e.id);
      const h = horasDeLaSemana({
        lunes,
        turnos: emp ? turnosCrudos(emp, reporte) : [],
        jornadas: jornadas.filter((j) => j.empleado_id === e.id),
        ajustes: ajustes.filter((a) => a.empleado_id === e.id).map(publicaAjuste),
        fechaIngreso: e.fecha_ingreso, bajaFecha: e.baja_fecha, ahora: reporte.generado.at,
      });
      return { id: e.id, numero: e.numero_empleado, nombre: e.nombre, sucursal: e.sucursal, estatus: e.estatus, ...h };
    }),
  };
}

/** El CSV de la semana (con BOM para que Excel lea los acentos) y su nombre. */
export async function exportarHorasCsv(negocioId, { semana } = {}) {
  const reporte = await horasDeSemana(negocioId, { semana });
  return { nombre: `horas-semana_${reporte.semana.lunes}.csv`, contenido: String.fromCharCode(0xfeff) + csvHoras(reporte) };
}

function motivoValido(valor) {
  if (valor === undefined || valor === null || (typeof valor === 'string' && !valor.trim())) {
    fallar('Escribe el motivo', 'MOTIVO_REQUERIDO');
  }
  if (typeof valor !== 'string') fallar('El motivo debe ser texto', 'MOTIVO_INVALIDO');
  const t = valor.trim();
  if (t.length > 300) fallar('El motivo admite hasta 300 caracteres', 'MOTIVO_INVALIDO');
  // Sin caracteres de control (salvo tabulador y saltos de línea): la base no
  // acepta el NUL y los demás no se ven.
  if ([...t].some((c) => { const n = c.charCodeAt(0); return (n < 32 && n !== 9 && n !== 10 && n !== 13) || n === 127; })) {
    fallar('El motivo tiene caracteres no válidos', 'MOTIVO_INVALIDO');
  }
  return t;
}

/**
 * Guarda una decisión del administrador sobre un día de un empleado:
 *   { empleado_id, fecha, tipo: 'extra', minutos }      minutos de extra (0 = ninguno)
 *   { empleado_id, fecha, tipo: 'falta', justificada }  true = justificada, false = ya no
 * Siempre con `motivo`. `base`: el id del último ajuste de ese día y tipo que
 * vio la pantalla (null si no había): si otra persona cambió algo después,
 * 409 AJUSTE_CAMBIO en vez de pisarlo.
 */
export async function guardarAjusteDia(negocioId, datos, { actorId = null } = {}) {
  const nid = exigirNegocio(negocioId);
  if (typeof actorId !== 'string' || !UUID_RE.test(actorId)) fallar('No se pudo saber quién hace el cambio', 'AUTOR_REQUERIDO');
  const b = datos && typeof datos === 'object' ? datos : {};
  if (typeof b.empleado_id !== 'string' || !UUID_RE.test(b.empleado_id)) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
  const fecha = fechaValida(b.fecha) ? b.fecha : null;
  if (!fecha) fallar('La fecha va como AAAA-MM-DD', 'FECHA_INVALIDA');
  if (!TIPOS_AJUSTE.includes(b.tipo)) fallar('El ajuste es «extra» o «falta»', 'TIPO_INVALIDO');
  let minutos = null, justificada = null;
  if (b.tipo === 'extra') {
    if (!Number.isInteger(b.minutos) || b.minutos < 0 || b.minutos > 1440) fallar('Los minutos van de 0 a 1440', 'MINUTOS_INVALIDOS');
    minutos = b.minutos;
  } else {
    if (typeof b.justificada !== 'boolean') fallar('Indica si la falta queda justificada', 'JUSTIFICADA_INVALIDA');
    justificada = b.justificada;
  }
  const motivo = motivoValido(b.motivo);
  let base = null;
  if (b.base !== undefined && b.base !== null) {
    if (!Number.isSafeInteger(b.base) || b.base < 1) fallar('Referencia no válida', 'BASE_INVALIDA');
    base = b.base;
  }

  return enTransaccion(async (client) => {
    const empleadoId = b.empleado_id.toLowerCase();
    const { rows: [e] } = await client.query(`SELECT id FROM xecador_empleados WHERE id = $1 AND negocio_id = $2`, [empleadoId, nid]);
    if (!e) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
    // Dos personas sobre el mismo día y tipo: una espera a la otra.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`xecador-ajuste:${nid}:${empleadoId}:${fecha}:${b.tipo}`]);
    const { rows: [ultimo] } = await client.query(
      `SELECT id FROM xecador_ajustes_dia WHERE negocio_id = $1 AND empleado_id = $2 AND fecha = $3::date AND tipo = $4
        ORDER BY id DESC LIMIT 1`, [nid, empleadoId, fecha, b.tipo]);
    if ((ultimo ? Number(ultimo.id) : null) !== base) {
      fallar('Otra persona cambió este día mientras lo revisabas. Vuelve a cargar la semana para ver su cambio.', 'AJUSTE_CAMBIO', 409);
    }
    const { rows: [r] } = await client.query(
      `INSERT INTO xecador_ajustes_dia (negocio_id, empleado_id, fecha, tipo, minutos, justificada, motivo, creado_por)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)
       RETURNING id, to_char(fecha, 'YYYY-MM-DD') AS fecha, tipo, minutos, justificada, motivo, created_at,
                 (SELECT nombre FROM usuarios WHERE id = $8) AS autor`,
      [nid, empleadoId, fecha, b.tipo, minutos, justificada, motivo, actorId]);
    return publicaAjuste(r);
  });
}
