// XECADOR · Formato de la exportación del registro de jornada (Parte B6).
//
// La STPS todavía no publica las disposiciones generales del registro
// electrónico de jornada. Por eso TODO lo que decide cómo se ve el archivo
// vive aquí y solo aquí: los textos, las columnas del CSV y el diseño del PDF.
// Cambiar el formato es cambiar este archivo y subir VERSION; el servicio
// (exportacionService.js) solo junta los datos y no sabe de columnas.
//
// Este módulo no toca la base: recibe el «reporte» ya armado (ver la forma en
// exportacionService.js) y lo convierte en texto. Así se prueba sin servidor.

export const VERSION = 'xecador-registro-1';
export const ZONA = 'America/Matamoros';

// ── Textos ──────────────────────────────────────────────────────────────────
export const TEXTOS = {
  tipo: { entrada: 'Entrada', salida: 'Salida', inicio_descanso: 'Inicio de descanso', fin_descanso: 'Fin de descanso' },
  registro: { checada: 'Checada', agregada: 'Agregada', correccion: 'Corrección' },
  accion: { modificar: 'Modificar', anular: 'Anular', restaurar: 'Restaurar' },
  origen: { en_linea: 'Tablet en línea', sin_conexion: 'Tablet sin conexión', administrador: 'Administrador' },
  foto: { tomada: 'Tomada', no_disponible: 'No disponible', no_requerida: 'No requerida' },
  motivo: {
    reloj_desfasado: 'Reloj de la tablet desfasado', sin_referencia: 'Sin hora del servidor', pin_no_valido: 'PIN no válido',
    otra_sucursal: 'Otra sucursal', empleado_de_baja: 'Empleado de baja', ip_distinta: 'IP distinta', sin_foto: 'Sin foto',
  },
  // La aceptación semanal del empleado llega después (Parte B5). Mientras no se
  // pida, cada semana dice «No solicitada»; nunca «Aceptada» sin que la acepte.
  aceptacion: {
    no_solicitada: 'No solicitada', sin_respuesta: 'Sin respuesta', aceptada: 'Aceptada',
    senalada: 'Señalada como incorrecta', requiere_nueva: 'Requiere nueva aceptación',
  },
  estatus: { activo: 'Activo', baja: 'Baja' },
  baja: { renuncia: 'Renuncia', despido: 'Despido', termino_contrato: 'Término de contrato', otro: 'Otro' },
  jornada: { diurna: 'Diurna', nocturna: 'Nocturna', mixta: 'Mixta' },
  dia: { 1: 'Lun', 2: 'Mar', 3: 'Mié', 4: 'Jue', 5: 'Vie', 6: 'Sáb', 7: 'Dom' },
  estado: { cuenta: 'Cuenta', anulada: 'Anulada' },
};
const t = (grupo, clave) => (clave === null || clave === undefined ? '' : TEXTOS[grupo][clave] ?? String(clave));

// ── Fechas en la hora de los negocios ───────────────────────────────────────
const PARTES = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
/** { fecha: 'AAAA-MM-DD', hora: 'HH:MM:SS' } en America/Matamoros, o null. */
export function local(valor) {
  if (valor === null || valor === undefined) return null;
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(PARTES.formatToParts(d).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}:${p.second}` };
}
const fechaLocal = (v) => local(v)?.fecha ?? '';
const horaLocal = (v) => local(v)?.hora ?? '';
const fechaHoraLocal = (v) => { const l = local(v); return l ? `${l.fecha} ${l.hora}` : ''; };
const horaCorta = (v) => horaLocal(v).slice(0, 5);
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** '2026-11-03' → 'mar 3 nov 2026' (día de la semana, día, mes y año). */
function fechaLarga(iso) {
  if (!iso) return '';
  const [a, m, d] = iso.split('-').map(Number);
  const dia = new Date(Date.UTC(a, m - 1, d)).getUTCDay() || 7;
  return `${t('dia', dia).toLowerCase()} ${d} ${MESES[m - 1]} ${a}`;
}

// ── Las filas del registro (una por checada, agregada o corrección) ─────────
// En orden: cada checada (o agregada) seguida de sus correcciones, en el orden
// en que se hicieron. Así se ven las dos: lo original y lo que cuenta.
export function filasDelRegistro(reporte) {
  const filas = [];
  for (const emp of reporte.empleados) {
    const aceptacionDe = new Map((emp.semanas || []).map((s) => [s.lunes, s.aceptacion]));
    for (const ev of emp.eventos) {
      const esChecada = ev.fuente === 'tablet';
      filas.push({
        emp, ev, registro: esChecada ? 'checada' : 'agregada', folio: ev.folio, corrige: null, accion: null,
        hora: ev.original.hora, tipo: ev.original.tipo,
        origen: esChecada ? ev.checada.origen : 'administrador',
        sucursal: esChecada ? ev.checada.sucursal : null, tablet: esChecada ? ev.checada.dispositivo : null,
        hora_tablet: esChecada ? ev.checada.hora_dispositivo : null, foto: esChecada ? ev.checada.foto : null,
        motivo: esChecada ? null : ev.agregada.motivo, hecho_por: esChecada ? null : ev.agregada.autor,
        registrado_el: esChecada ? (ev.checada.sincronizada_at || ev.original.hora) : ev.agregada.created_at,
        evento: true, aceptacion: aceptacionDe.get(lunesDe(fechaLocal(ev.hora_periodo))) ?? 'no_solicitada',
      });
      for (const c of ev.correcciones) {
        filas.push({
          emp, ev, registro: 'correccion', folio: c.folio, corrige: ev.folio, accion: c.accion,
          hora: c.accion === 'modificar' ? c.hora : null, tipo: c.accion === 'modificar' ? c.tipo : null,
          origen: 'administrador', motivo: c.motivo, hecho_por: c.autor, registrado_el: c.created_at, evento: false,
        });
      }
    }
  }
  return filas;
}

/** El lunes (AAAA-MM-DD) de la semana de una fecha AAAA-MM-DD. */
export function lunesDe(iso) {
  if (!iso) return null;
  const [a, m, d] = iso.split('-').map(Number);
  const f = new Date(Date.UTC(a, m - 1, d));
  f.setUTCDate(f.getUTCDate() - ((f.getUTCDay() || 7) - 1));
  return f.toISOString().slice(0, 10);
}

// ── CSV ─────────────────────────────────────────────────────────────────────
// `texto: true` = lo que escribió una persona (nombres, motivos, notas): si
// empieza con = + - @ (o tabulador / retorno), una hoja de cálculo lo tomaría
// como fórmula; se le antepone un apóstrofo para que se lea como texto.
const soloEvento = (fn) => (f) => (f.evento ? fn(f) : '');
export const COLUMNAS_CSV = [
  { titulo: 'Formato', valor: () => VERSION },
  { titulo: 'Número de empleado', valor: (f) => f.emp.numero },
  { titulo: 'Empleado', valor: (f) => f.emp.nombre, texto: true },
  { titulo: 'Registro', valor: (f) => t('registro', f.registro) },
  { titulo: 'Folio', valor: (f) => f.folio },
  { titulo: 'Corrige a', valor: (f) => f.corrige ?? '' },
  { titulo: 'Acción', valor: (f) => t('accion', f.accion) },
  { titulo: `Fecha (${ZONA})`, valor: (f) => fechaLocal(f.hora) },
  { titulo: `Hora (${ZONA})`, valor: (f) => horaLocal(f.hora) },
  { titulo: 'Tipo', valor: (f) => t('tipo', f.tipo) },
  { titulo: 'Origen', valor: (f) => t('origen', f.origen) },
  { titulo: 'Sucursal', valor: (f) => f.sucursal ?? '', texto: true },
  { titulo: 'Tablet', valor: (f) => f.tablet ?? '', texto: true },
  { titulo: 'Hora del reloj de la tablet', valor: (f) => fechaHoraLocal(f.hora_tablet) },
  { titulo: 'Foto', valor: (f) => t('foto', f.foto) },
  { titulo: 'Motivo', valor: (f) => f.motivo ?? '', texto: true },
  { titulo: 'Hecho por', valor: (f) => f.hecho_por ?? '', texto: true },
  { titulo: 'Registrado el', valor: (f) => fechaHoraLocal(f.registrado_el) },
  { titulo: 'Cuenta como: fecha', valor: soloEvento((f) => fechaLocal(f.ev.efectivo.hora)) },
  { titulo: 'Cuenta como: hora', valor: soloEvento((f) => horaLocal(f.ev.efectivo.hora)) },
  { titulo: 'Cuenta como: tipo', valor: soloEvento((f) => t('tipo', f.ev.efectivo.tipo)) },
  { titulo: 'Estado', valor: soloEvento((f) => t('estado', f.ev.efectivo.anulada ? 'anulada' : 'cuenta')) },
  { titulo: 'Fuera de orden', valor: soloEvento((f) => (f.ev.fuera_de_orden ? 'Sí' : 'No')) },
  { titulo: 'Para revisar', valor: soloEvento((f) => f.ev.revisar.map((m) => t('motivo', m)).join('; ')) },
  { titulo: 'Revisada por', valor: soloEvento((f) => f.ev.revisada?.por ?? ''), texto: true },
  { titulo: 'Revisada el', valor: soloEvento((f) => fechaHoraLocal(f.ev.revisada?.at)) },
  { titulo: 'Nota de la revisión', valor: soloEvento((f) => f.ev.revisada?.nota ?? ''), texto: true },
  { titulo: 'Aceptación de la semana', valor: soloEvento((f) => t('aceptacion', f.aceptacion)) },
];

/** Una celda del CSV (RFC 4180), sin que una hoja de cálculo la tome como fórmula. */
export function celdaCsv(valor, { texto = false } = {}) {
  let s = valor === null || valor === undefined ? '' : String(valor);
  if (texto && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** El CSV completo, con encabezado y fin de línea CRLF (sin BOM: lo pone la ruta). */
export function csv(reporte) {
  const lineas = [COLUMNAS_CSV.map((c) => celdaCsv(c.titulo)).join(',')];
  for (const f of filasDelRegistro(reporte)) lineas.push(COLUMNAS_CSV.map((c) => celdaCsv(c.valor(f), c)).join(','));
  return lineas.join('\r\n') + '\r\n';
}

// ── PDF (HTML que se imprime con Chromium) ──────────────────────────────────
export const PDF = {
  formato: 'A4',
  margen: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
  // El pie lo pone Chromium (no la página): número de página en cada hoja.
  pie: `<div style="font-family:'Liberation Sans',Arial,sans-serif;font-size:7px;color:#555;width:100%;padding:0 12mm;display:flex;justify-content:space-between;">`
    + `<span>Registro de jornada · formato ${VERSION}</span><span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>`,
};

export function escaparHtml(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const e = escaparHtml;

function textoJornada(j) {
  const dias = (j.dias || []).map((d) => `${t('dia', d.dia)} ${d.entrada}–${d.salida}`).join(', ');
  return `Desde ${fechaLarga(j.vigente_desde)} · ${t('jornada', j.tipo)}${dias ? ` · ${dias}` : ''}`;
}

/** Lo que se dice de un evento en la columna «Observaciones» del PDF. */
function observaciones(ev) {
  const partes = [];
  if (ev.fuente === 'agregada') {
    partes.push(`Agregada por ${e(ev.agregada.autor || '—')} el ${e(fechaHoraLocal(ev.agregada.created_at))}. Motivo: «${e(ev.agregada.motivo)}».`);
  }
  for (const c of ev.correcciones) {
    const que = c.accion === 'modificar' ? `cambió a ${e(t('tipo', c.tipo))} ${e(fechaLocal(c.hora))} ${e(horaLocal(c.hora))}`
      : c.accion === 'anular' ? 'la anuló' : 'la restauró';
    partes.push(`${e(c.autor || '—')} ${que} el ${e(fechaHoraLocal(c.created_at))}. Motivo: «${e(c.motivo)}». (${e(c.folio)})`);
  }
  if (ev.efectivo.corregida && ev.fuente === 'tablet') {
    partes.unshift(`Original de la tablet: ${e(t('tipo', ev.original.tipo))} ${e(fechaLocal(ev.original.hora))} ${e(horaLocal(ev.original.hora))}.`);
  }
  if (ev.checada?.origen === 'sin_conexion') {
    partes.push(`Registrada sin conexión; llegó al servidor el ${e(fechaHoraLocal(ev.checada.sincronizada_at))}.`);
  }
  if (ev.checada?.hora_dispositivo) partes.push(`Reloj de la tablet: ${e(fechaHoraLocal(ev.checada.hora_dispositivo))}.`);
  if (ev.revisar.length) partes.push(`Para revisar: ${e(ev.revisar.map((m) => t('motivo', m)).join(', '))}.`);
  if (ev.revisada) {
    partes.push(`Revisada por ${e(ev.revisada.por || '—')} el ${e(fechaHoraLocal(ev.revisada.at))}${ev.revisada.nota ? `: «${e(ev.revisada.nota)}»` : ''}.`);
  }
  if (ev.fuera_de_orden) partes.push('Fuera de orden.');
  return partes.map((p) => `<div>${p}</div>`).join('');
}

function htmlEmpleado(reporte, emp) {
  const p = reporte.periodo;
  // «Estatus: Baja desde sáb 7 nov 2026 (Renuncia)».
  const baja = emp.estatus === 'baja'
    ? `${emp.baja_fecha ? ` desde ${e(fechaLarga(emp.baja_fecha))}` : ''}${emp.baja_tipo ? ` (${e(t('baja', emp.baja_tipo))})` : ''}` : '';
  const jornadas = emp.jornadas.length
    ? emp.jornadas.map((j) => `<div>${e(textoJornada(j))}</div>`).join('') : '<div>Sin jornada asignada.</div>';
  const porSemana = new Map((emp.semanas || []).map((s) => [s.lunes, { ...s, eventos: [] }]));
  for (const ev of emp.eventos) porSemana.get(lunesDe(fechaLocal(ev.hora_periodo)))?.eventos.push(ev);
  const semanas = [...porSemana.values()].map((s) => {
    const filas = s.eventos.length ? s.eventos.map((ev) => {
      const anulada = ev.efectivo.anulada;
      const registro = ev.fuente === 'agregada' ? 'Agregada por el administrador'
        : `${e(t('origen', ev.checada.origen))}${ev.checada.dispositivo ? ` «${e(ev.checada.dispositivo)}»` : ''}${ev.checada.sucursal ? `, ${e(ev.checada.sucursal)}` : ''}`;
      return `<tr class="${anulada ? 'anulada' : ''}">
        <td class="nw">${e(fechaLarga(fechaLocal(ev.efectivo.hora)))}</td>
        <td class="nw"><span class="hora">${e(horaCorta(ev.efectivo.hora))}</span></td>
        <td class="nw">${e(t('tipo', ev.efectivo.tipo))}${anulada ? '<div class="marca">ANULADA</div>' : ev.efectivo.corregida ? '<div class="marca">Corregida</div>' : ''}</td>
        <td>${registro}<div class="folio">${e(ev.folio)}</div></td>
        <td class="obs">${observaciones(ev)}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" class="vacio">Sin checadas esta semana.</td></tr>';
    return `<h3>Semana del ${e(fechaLarga(s.lunes))} al ${e(fechaLarga(s.domingo))} · Aceptación del empleado: ${e(t('aceptacion', s.aceptacion))}</h3>
      <table><thead><tr><th>Fecha</th><th>Hora</th><th>Tipo</th><th>Registro</th><th>Observaciones</th></tr></thead><tbody>${filas}</tbody></table>`;
  }).join('');
  return `<section class="empleado">
    <header>
      <div class="titulo">Registro de jornada</div>
      <div class="negocio">${e(reporte.negocio.nombre)}</div>
    </header>
    <div class="datos">
      <div><b>Empleado:</b> #${e(emp.numero)} ${e(emp.nombre)}${emp.puesto ? ` · ${e(emp.puesto)}` : ''}</div>
      <div><b>Estatus:</b> ${e(t('estatus', emp.estatus))}${baja}${emp.fecha_ingreso ? ` · <b>Ingreso:</b> ${e(fechaLarga(emp.fecha_ingreso))}` : ''}${emp.sucursal ? ` · <b>Sucursal:</b> ${e(emp.sucursal)}` : ''}</div>
      <div><b>Periodo:</b> del ${e(fechaLarga(p.desde))} al ${e(fechaLarga(p.hasta))} · horas de ${e(ZONA)}</div>
      <div><b>Generado:</b> ${e(fechaHoraLocal(reporte.generado.at))}${reporte.generado.por ? ` por ${e(reporte.generado.por)}` : ''} · formato ${e(VERSION)}</div>
    </div>
    <h2>Jornada asignada</h2>
    <div class="jornada">${jornadas}</div>
    <h2>Checadas</h2>
    ${semanas}
    <p class="nota">Las checadas no se modifican ni se borran: cada corrección es un registro aparte, con motivo, autor y fecha, y aquí se muestran las dos. «Hora» es la que cuenta; la original se indica en las observaciones.</p>
  </section>`;
}

/** El HTML del PDF: una sección por empleado (cada una empieza en hoja nueva). */
export function html(reporte) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Registro de jornada</title><style>
    body { font-family: 'Liberation Sans', Arial, Helvetica, sans-serif; color: #111; font-size: 9px; margin: 0; }
    .empleado + .empleado { break-before: page; }
    header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #f97316; padding-bottom: 6px; margin-bottom: 8px; }
    .titulo { font-size: 15px; font-weight: 700; }
    .negocio { font-size: 11px; font-weight: 700; color: #c2410c; }
    .datos div { margin: 2px 0; font-size: 9.5px; }
    h2 { font-size: 11px; margin: 12px 0 4px; }
    h3 { font-size: 9.5px; margin: 10px 0 3px; color: #333; break-after: avoid; }
    .jornada div { margin: 1px 0; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f3f4f6; text-align: left; padding: 3px 4px; font-size: 8.5px; border-bottom: 1px solid #d1d5db; }
    td { padding: 3px 4px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
    tr { break-inside: avoid; }
    .nw { white-space: nowrap; }
    .hora { font-weight: 700; font-size: 10px; }
    .marca { font-size: 7.5px; font-weight: 700; color: #c2410c; }
    tr.anulada .hora { text-decoration: line-through; color: #6b7280; }
    .folio { font-size: 7px; color: #6b7280; }
    .obs div { margin-bottom: 1px; }
    .vacio { color: #6b7280; font-style: italic; }
    .nota { margin-top: 10px; font-size: 7.5px; color: #555; }
  </style></head><body>${reporte.empleados.map((emp) => htmlEmpleado(reporte, emp)).join('')}</body></html>`;
}

/** Nombre del archivo, solo con letras sin acento, números y guiones. */
export function nombreArchivo(reporte, extension) {
  const quien = reporte.empleados.length === 1 && reporte.soloEmpleado ? `empleado-${reporte.empleados[0].numero}` : 'todos';
  return `registro-jornada_${reporte.periodo.desde}_${reporte.periodo.hasta}_${quien}.${extension}`;
}
