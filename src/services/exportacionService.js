// XECADOR · Exportación del registro de jornada — Parte B6.
//
// Reporte por empleado (o de todos, en CSV) y por periodo, con TODOS los
// eventos: las checadas de la tablet (en línea y sin conexión), las agregadas
// por el administrador y cada corrección (motivo, autor y fecha), lo que quedó
// para revisar y su revisión, y la aceptación de cada semana.
//
// Este archivo junta los datos y arma el «reporte»; cómo se ve el archivo lo
// decide exportacionFormato.js (con versión), para cambiarlo cuando la STPS
// publique sus disposiciones sin tocar las consultas.
//
// Forma del reporte:
//   { generado: { at, por }, negocio: { nombre }, periodo: { desde, hasta },
//     soloEmpleado, empleados: [{ numero, nombre, puesto, estatus, fecha_ingreso,
//       baja_fecha, baja_tipo, sucursal, jornadas: [{ vigente_desde, tipo, dias }],
//       semanas: [{ lunes, domingo, aceptacion }],
//       eventos: [{ folio, fuente: 'tablet'|'agregada', original, efectivo,
//         hora_periodo, checada: { origen, sucursal, dispositivo, hora_dispositivo,
//         sincronizada_at, foto } | null, agregada: { motivo, autor, created_at } | null,
//         correcciones: [{ folio, accion, tipo, hora, motivo, autor, created_at }],
//         revisar: [motivo], revisada: { por, at, nota } | null, fuera_de_orden }],
//       contexto?: { antes: [{ tipo, hora }], despues: [{ tipo, hora }] } }] }
//
// `contexto` (solo con conContexto, para el resumen por turno): lo que cuenta
// en los 7 días antes del periodo y en los 2 días después, para no partir un
// turno de noche en las orillas.
//
// Solo lo usa el administrador del negocio (las rutas llevan sus puertas).
import { pool } from './database.js';
import { PersonalError } from './personalService.js';
import { lineaEfectiva, fueraDeOrden } from './correccionesService.js';
import * as FORMATO from './exportacionFormato.js';

const fallar = (mensaje, codigo, http) => { throw new PersonalError(mensaje, codigo, http); };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZONA = FORMATO.ZONA;
const DIA_MS = 864e5;

// Un año en CSV; tres meses en PDF (un PDF más largo pesa y tarda sin
// necesidad: para periodos largos, el CSV).
export const DIAS_MAX_CSV = 366;
export const DIAS_MAX_PDF = 93;

function exigirNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !UUID_RE.test(negocioId.trim())) {
    fallar('No se pudo determinar el negocio de la sesión', 'TENANT_CONTEXT_REQUIRED', 500);
  }
  return negocioId.trim();
}

/** 'AAAA-MM-DD' de un día que existe, o null. */
function dia(valor) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return null;
  const [a, m, d] = valor.split('-').map(Number);
  const f = new Date(Date.UTC(a, m - 1, d));
  return f.getUTCFullYear() === a && f.getUTCMonth() === m - 1 && f.getUTCDate() === d && a >= 2000 && a <= 2100 ? valor : null;
}

/** El periodo pedido (fechas en la hora de los negocios, «hasta» incluido). */
export function leerPeriodo({ desde, hasta } = {}, maxDias = DIAS_MAX_CSV) {
  const d = dia(desde), h = dia(hasta);
  if (!d || !h) fallar('Las fechas van como AAAA-MM-DD', 'FECHA_INVALIDA');
  if (d > h) fallar('La fecha inicial va antes que la final', 'PERIODO_INVALIDO');
  const dias = Math.round((Date.parse(`${h}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / DIA_MS) + 1;
  if (dias > maxDias) fallar(`El periodo puede ser de hasta ${maxDias} días`, 'PERIODO_DEMASIADO_LARGO');
  return { desde: d, hasta: h, dias };
}

/** Las semanas (de lunes a domingo) que toca el periodo. */
function semanasDe(periodo) {
  const semanas = [];
  for (let lunes = FORMATO.lunesDe(periodo.desde); lunes <= periodo.hasta;) {
    const f = new Date(`${lunes}T00:00:00Z`);
    const domingo = new Date(f.getTime() + 6 * DIA_MS).toISOString().slice(0, 10);
    // La aceptación semanal del empleado todavía no se pide (Parte B5).
    semanas.push({ lunes, domingo, aceptacion: 'no_solicitada' });
    lunes = new Date(f.getTime() + 7 * DIA_MS).toISOString().slice(0, 10);
  }
  return semanas;
}

/**
 * Arma el reporte. Con `empleadoId`, de esa persona (activa o de baja); sin
 * él, de todos los que tienen algo en el periodo.
 */
export async function reporteRegistro(negocioId, { desde, hasta, empleadoId = null, actorId = null, maxDias = DIAS_MAX_CSV, conContexto = false } = {}) {
  const nid = exigirNegocio(negocioId);
  const periodo = leerPeriodo({ desde, hasta }, maxDias);
  if (empleadoId !== null && (typeof empleadoId !== 'string' || !UUID_RE.test(empleadoId))) {
    fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
  }
  const { rows: [base] } = await pool.query(
    `SELECT ($2::date::timestamp AT TIME ZONE '${ZONA}') AS inicio, (($3::date + 1)::timestamp AT TIME ZONE '${ZONA}') AS fin,
            NOW() AS ahora, (SELECT nombre FROM negocios WHERE id = $1) AS negocio,
            (SELECT nombre FROM usuarios WHERE id = $4::uuid) AS autor`,
    [nid, periodo.desde, periodo.hasta, actorId && UUID_RE.test(actorId) ? actorId : null]);
  if (empleadoId) {
    const { rows: [e] } = await pool.query(`SELECT 1 FROM xecador_empleados WHERE id = $1 AND negocio_id = $2`, [empleadoId, nid]);
    if (!e) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
  }

  const linea = await lineaEfectiva(pool, nid, { empleadoId, desde: base.inicio, hasta: base.fin, incluirAnuladas: true, tambienPorOriginal: true });
  const ids = empleadoId ? [empleadoId] : [...new Set(linea.map((r) => r.empleado_id))];
  const checadaIds = linea.filter((r) => r.checada_id).map((r) => r.checada_id);

  const [{ rows: empleados }, { rows: checadas }, { rows: revisiones }, { rows: jornadas }] = await Promise.all([
    pool.query(
      `SELECT e.id, e.numero_empleado, e.nombre, e.puesto, e.estatus, to_char(e.fecha_ingreso, 'YYYY-MM-DD') AS fecha_ingreso,
              to_char(e.baja_fecha, 'YYYY-MM-DD') AS baja_fecha, e.baja_tipo, s.nombre AS sucursal
         FROM xecador_empleados e LEFT JOIN sucursales s ON s.id = e.sucursal_id AND s.negocio_id = e.negocio_id
        WHERE e.negocio_id = $1 AND e.id = ANY($2::uuid[])
        ORDER BY e.numero_empleado`, [nid, ids]),
    pool.query(
      `SELECT c.id, c.origen, c.revision, c.foto, c.hora_dispositivo, c.sincronizada_at, s.nombre AS sucursal, d.nombre AS dispositivo
         FROM xecador_checadas c
         LEFT JOIN sucursales s ON s.id = c.sucursal_id AND s.negocio_id = c.negocio_id
         LEFT JOIN xecador_dispositivos d ON d.id = c.dispositivo_id AND d.negocio_id = c.negocio_id
        WHERE c.negocio_id = $1 AND c.id = ANY($2::bigint[])`, [nid, checadaIds]),
    pool.query(
      `SELECT r.checada_id, r.nota, r.created_at, u.nombre AS por
         FROM xecador_revisiones r LEFT JOIN usuarios u ON u.id = r.revisada_por
        WHERE r.negocio_id = $1 AND r.checada_id = ANY($2::bigint[])`, [nid, checadaIds]),
    // La jornada que regía al empezar el periodo y los cambios dentro de él.
    pool.query(
      `SELECT j.id, j.empleado_id, j.tipo, to_char(j.vigente_desde, 'YYYY-MM-DD') AS vigente_desde,
              COALESCE(json_agg(json_build_object('dia', d.dia, 'entrada', to_char(d.entrada, 'HH24:MI'),
                                                  'salida', to_char(d.salida, 'HH24:MI')) ORDER BY d.dia)
                       FILTER (WHERE d.dia IS NOT NULL), '[]') AS dias
         FROM xecador_jornadas j LEFT JOIN xecador_jornada_dias d ON d.jornada_id = j.id
        WHERE j.negocio_id = $1 AND j.empleado_id = ANY($2::uuid[]) AND j.vigente_desde <= $3::date
        GROUP BY j.id
        ORDER BY j.empleado_id, j.vigente_desde, j.id`, [nid, ids, periodo.hasta]),
  ]);
  const checadaDe = new Map(checadas.map((c) => [Number(c.id), c]));
  const revisionDe = new Map(revisiones.map((r) => [Number(r.checada_id), r]));
  // Lo que cuenta justo después del periodo: solo para cerrar el turno que
  // empezó el último día (el resumen no muestra turnos que empiezan después).
  const despues = conContexto
    ? await lineaEfectiva(pool, nid, { empleadoId, desde: base.fin, hasta: new Date(base.fin.getTime() + 2 * DIA_MS) })
    : [];
  const loQueCuenta = (r) => ({ tipo: r.efectivo.tipo, hora: r.efectivo.hora });

  const semanas = semanasDe(periodo);
  const enPeriodo = (t) => new Date(t) >= base.inicio && new Date(t) < base.fin;
  const resultado = [];
  for (const emp of empleados) {
    const suyos = linea.filter((r) => r.empleado_id === emp.id);
    // Fuera de orden, con la misma regla que la vista del día: lo que contaba
    // justo antes del periodo y, dentro, solo lo que cuenta en el periodo.
    const antes = await lineaEfectiva(pool, nid, { empleadoId: emp.id, desde: new Date(base.inicio.getTime() - 7 * DIA_MS), hasta: base.inicio });
    const previa = antes.at(-1) ? { tipo: antes.at(-1).efectivo.tipo, hora_oficial: antes.at(-1).efectivo.hora } : null;
    const marcadas = fueraDeOrden(suyos.filter((r) => enPeriodo(r.efectivo.hora)), previa);

    const eventos = suyos.map((r) => {
      const esChecada = r.origen === 'tablet';
      const c = esChecada ? checadaDe.get(r.checada_id) : null;
      const rev = esChecada ? revisionDe.get(r.checada_id) : null;
      return {
        folio: esChecada ? `CH-${r.checada_id}` : `AG-${r.correccion_id}`,
        fuente: r.origen, original: r.original, efectivo: r.efectivo,
        hora_periodo: enPeriodo(r.efectivo.hora) ? r.efectivo.hora : r.original.hora,
        checada: c ? { origen: c.origen, sucursal: c.sucursal, dispositivo: c.dispositivo, hora_dispositivo: c.hora_dispositivo,
          sincronizada_at: c.sincronizada_at, foto: c.foto } : null,
        agregada: esChecada ? null : r.agregada,
        correcciones: r.correcciones.map((k) => ({ ...k, folio: `CO-${k.id}` })),
        // La red distinta es solo informativa (MOTIVOS_INFORMATIVOS del checador, 10-nov-2026).
        revisar: c ? [...c.revision.filter((m) => m !== 'ip_distinta'), ...(c.foto === 'no_disponible' ? ['sin_foto'] : [])] : [],
        revisada: rev ? { por: rev.por, at: rev.created_at, nota: rev.nota } : null,
        fuera_de_orden: marcadas.has(esChecada ? `c:${r.checada_id}` : `a:${r.correccion_id}`),
      };
    }).sort((x, y) => new Date(x.hora_periodo) - new Date(y.hora_periodo) || x.folio.localeCompare(y.folio));

    const suyas = jornadas.filter((j) => j.empleado_id === emp.id);
    const alEmpezar = suyas.filter((j) => j.vigente_desde <= periodo.desde).at(-1);
    const cambios = suyas.filter((j) => j.vigente_desde > periodo.desde);
    resultado.push({
      numero: emp.numero_empleado, nombre: emp.nombre, puesto: emp.puesto, estatus: emp.estatus,
      fecha_ingreso: emp.fecha_ingreso, baja_fecha: emp.baja_fecha, baja_tipo: emp.baja_tipo, sucursal: emp.sucursal,
      jornadas: [...(alEmpezar ? [alEmpezar] : []), ...cambios].map((j) => ({ vigente_desde: j.vigente_desde, tipo: j.tipo, dias: j.dias })),
      semanas, eventos,
      ...(conContexto ? { contexto: { antes: antes.map(loQueCuenta), despues: despues.filter((r) => r.empleado_id === emp.id).map(loQueCuenta) } } : {}),
    });
  }
  return {
    generado: { at: base.ahora, por: base.autor ?? null }, negocio: { nombre: base.negocio ?? '' },
    periodo: { desde: periodo.desde, hasta: periodo.hasta }, soloEmpleado: !!empleadoId, empleados: resultado,
  };
}

/**
 * El CSV (con BOM para que Excel lea los acentos) y su nombre de archivo.
 * `vista`: 'completo' (el registro, por omisi\u00f3n) o 'resumen' (un rengl\u00f3n por turno).
 */
export async function exportarCsv(negocioId, { vista, ...opciones } = {}) {
  const v = vista === undefined || vista === '' ? 'completo' : vista;
  if (v !== 'completo' && v !== 'resumen') fallar('La vista del CSV va como \u00abresumen\u00bb o \u00abcompleto\u00bb', 'VISTA_INVALIDA');
  const resumen = v === 'resumen';
  const reporte = await reporteRegistro(negocioId, { ...opciones, maxDias: DIAS_MAX_CSV, conContexto: resumen });
  return {
    nombre: FORMATO.nombreArchivo(reporte, 'csv', { resumen }),
    contenido: `\ufeff${resumen ? FORMATO.csvResumen(reporte) : FORMATO.csv(reporte)}`,
  };
}

/** El PDF de UN empleado y su nombre de archivo. */
export async function exportarPdf(negocioId, opciones = {}) {
  if (!opciones.empleadoId) fallar('Elige un empleado para el PDF (el CSV puede ser de todos)', 'EMPLEADO_REQUERIDO');
  const reporte = await reporteRegistro(negocioId, { ...opciones, maxDias: DIAS_MAX_PDF });
  return { nombre: FORMATO.nombreArchivo(reporte, 'pdf'), contenido: await htmlAPdf(FORMATO.html(reporte)) };
}

// ── HTML → PDF con Chromium ────────────────────────────────────────────────
// Como las cotizaciones (cotizacionPdf.js): puppeteer se carga solo al
// generar, un PDF a la vez y con tiempo máximo. Además, la página se imprime
// sin JavaScript y sin red (solo lo que viene en el HTML): un nombre o un
// motivo con etiquetas no puede ejecutar nada ni pedir otra dirección.
const TIEMPO_MAXIMO_MS = Number(process.env.XECADOR_PDF_TIMEOUT_MS) || 30000;
const TAMANO_MAXIMO_BYTES = 10 * 1024 * 1024;
let cola = Promise.resolve();
let _puppeteer;

async function htmlAPdfInterno(html) {
  if (!_puppeteer) _puppeteer = (await import('puppeteer')).default;
  const lanzamiento = _puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  let navegador;
  try {
    try {
      navegador = await Promise.race([lanzamiento,
        new Promise((_, mal) => setTimeout(() => mal(new Error('Chromium no arrancó a tiempo para generar el PDF')), TIEMPO_MAXIMO_MS))]);
    } catch (e) {
      lanzamiento.then((b) => b.close().catch(() => {})).catch(() => {});
      throw e;
    }
    const pagina = await navegador.newPage();
    await pagina.setJavaScriptEnabled(false);
    await pagina.setRequestInterception(true);
    pagina.on('request', (r) => (/^(data|about):/.test(r.url()) ? r.continue() : r.abort('blockedbyclient')));
    await pagina.setContent(html, { waitUntil: 'load', timeout: TIEMPO_MAXIMO_MS });
    const bytes = await pagina.pdf({
      format: FORMATO.PDF.formato, printBackground: true, margin: FORMATO.PDF.margen,
      displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: FORMATO.PDF.pie, timeout: TIEMPO_MAXIMO_MS,
    });
    const pdf = Buffer.from(bytes);
    if (pdf.length > TAMANO_MAXIMO_BYTES) fallar('El PDF salió demasiado grande: usa un periodo más corto o el CSV', 'PDF_DEMASIADO_GRANDE', 413);
    return pdf;
  } finally {
    if (navegador) await navegador.close().catch(() => {});
  }
}

/** Un PDF a la vez (la cola sigue aunque uno falle). */
export function htmlAPdf(html) {
  const r = cola.then(() => htmlAPdfInterno(html), () => htmlAPdfInterno(html));
  cola = r.catch(() => {});
  return r;
}
