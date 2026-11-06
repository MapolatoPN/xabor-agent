// XECADOR · Correcciones de checadas — Parte B2 (migración 130).
//
// Una corrección es un EVENTO NUEVO que apunta a lo que corrige, con motivo
// obligatorio, autor y fecha. La checada original no se toca nunca y los
// reportes muestran las dos.
//
//   agregar    una checada que faltó (la salida que nadie registró).
//   modificar  otro tipo u otra hora, para una checada o una agregada.
//   anular     ya no cuenta (un duplicado, un botón equivocado).
//   restaurar  deshace una anulación.
//
// Para cada checada (o agregada) manda la corrección más reciente; una
// corrección equivocada se arregla con otra. Si otra persona corrigió lo mismo
// mientras la pantalla lo mostraba, 409 en vez de pisarla (`base`).
//
// La «línea efectiva» es lo que cuenta después de las correcciones: con ella
// calcula la tablet qué le toca a cada empleado y, después, las horas (B4) y
// la exportación (B6).
//
// Solo el administrador del negocio corrige (las rutas llevan sus puertas).
import { pool } from './database.js';
import { PersonalError } from './personalService.js';
import { TIPOS_CHECADA, estadoTurno } from './turnoChecador.js';

const fallar = (mensaje, codigo, http) => { throw new PersonalError(mensaje, codigo, http); };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZONA = 'America/Matamoros';
export const ACCIONES_CORRECCION = ['agregar', 'modificar', 'anular', 'restaurar'];
const DIA_MS = 864e5;

function exigirNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !UUID_RE.test(negocioId.trim())) {
    fallar('No se pudo determinar el negocio de la sesión', 'TENANT_CONTEXT_REQUIRED', 500);
  }
  return negocioId.trim();
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

const idPositivo = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const mismaHora = (a, b) => Math.floor(new Date(a).getTime() / 60000) === Math.floor(new Date(b).getTime() / 60000);

// ── Lo que cuenta de una checada después de sus correcciones ───────────────
// `correcciones` son las que apuntan a ella, en el orden en que se hicieron.
export function efectivoDe(original, correcciones) {
  const ultima = correcciones.at(-1);
  if (!ultima) return { tipo: original.tipo, hora: original.hora, anulada: false, corregida: false };
  if (ultima.accion === 'modificar') return { tipo: ultima.tipo, hora: ultima.hora, anulada: false, corregida: true };
  if (ultima.accion === 'anular') return { tipo: original.tipo, hora: original.hora, anulada: true, corregida: true };
  return { tipo: original.tipo, hora: original.hora, anulada: false, corregida: true };   // restaurar
}

const publicaCorreccion = (r) => ({
  id: Number(r.id), accion: r.accion, tipo: r.tipo ?? null, hora: r.hora ?? null, motivo: r.motivo,
  autor: r.autor ?? null, created_at: r.created_at,
});

async function correccionesDe(q, nid, { checadas = [], agregadas = [] }) {
  if (!checadas.length && !agregadas.length) return [];
  const { rows } = await q.query(
    `SELECT r.id, r.accion, r.objetivo_checada_id, r.objetivo_correccion_id, r.tipo, r.hora, r.motivo, r.created_at,
            u.nombre AS autor
       FROM xecador_correcciones r LEFT JOIN usuarios u ON u.id = r.creado_por
      WHERE r.negocio_id = $1 AND (r.objetivo_checada_id = ANY($2::bigint[]) OR r.objetivo_correccion_id = ANY($3::bigint[]))
      ORDER BY r.id`, [nid, checadas, agregadas]);
  return rows;
}

/**
 * La línea efectiva entre `desde` y `hasta` (por la hora que cuenta), de un
 * empleado o de todo el negocio, en orden. Cada registro dice de dónde viene
 * (tablet o agregada), lo original, lo efectivo y sus correcciones. Las
 * anuladas solo salen con `incluirAnuladas`.
 */
export async function lineaEfectiva(q, negocioId, { empleadoId = null, desde, hasta, incluirAnuladas = false } = {}) {
  const nid = exigirNegocio(negocioId);
  const d = new Date(desde), h = new Date(hasta);
  const { rows: originales } = await q.query(
    `SELECT c.id, c.empleado_id, c.tipo, c.hora_oficial AS hora
       FROM xecador_checadas c
      WHERE c.negocio_id = $1 AND ($2::uuid IS NULL OR c.empleado_id = $2)
        AND ((c.hora_oficial >= $3 AND c.hora_oficial < $4)
             OR EXISTS (SELECT 1 FROM xecador_correcciones r
                         WHERE r.negocio_id = c.negocio_id AND r.objetivo_checada_id = c.id AND r.hora >= $3 AND r.hora < $4))`,
    [nid, empleadoId, d, h]);
  const { rows: agregadas } = await q.query(
    `SELECT a.id, a.empleado_id, a.tipo, a.hora, a.motivo, a.created_at, u.nombre AS autor
       FROM xecador_correcciones a LEFT JOIN usuarios u ON u.id = a.creado_por
      WHERE a.negocio_id = $1 AND a.accion = 'agregar' AND ($2::uuid IS NULL OR a.empleado_id = $2)
        AND ((a.hora >= $3 AND a.hora < $4)
             OR EXISTS (SELECT 1 FROM xecador_correcciones r
                         WHERE r.negocio_id = a.negocio_id AND r.objetivo_correccion_id = a.id AND r.hora >= $3 AND r.hora < $4))`,
    [nid, empleadoId, d, h]);
  const correcciones = await correccionesDe(q, nid, { checadas: originales.map((o) => o.id), agregadas: agregadas.map((a) => a.id) });
  const deChecada = new Map(), deAgregada = new Map();
  for (const r of correcciones) {
    const [mapa, clave] = r.objetivo_checada_id ? [deChecada, String(r.objetivo_checada_id)] : [deAgregada, String(r.objetivo_correccion_id)];
    if (!mapa.has(clave)) mapa.set(clave, []);
    mapa.get(clave).push(r);
  }
  const registros = [
    ...originales.map((o) => {
      const cs = deChecada.get(String(o.id)) || [];
      return { origen: 'tablet', checada_id: Number(o.id), correccion_id: null, empleado_id: o.empleado_id,
        original: { tipo: o.tipo, hora: o.hora }, efectivo: efectivoDe(o, cs), correcciones: cs.map(publicaCorreccion) };
    }),
    ...agregadas.map((a) => {
      const cs = deAgregada.get(String(a.id)) || [];
      return { origen: 'agregada', checada_id: null, correccion_id: Number(a.id), empleado_id: a.empleado_id,
        original: { tipo: a.tipo, hora: a.hora }, efectivo: efectivoDe(a, cs), correcciones: cs.map(publicaCorreccion),
        agregada: { motivo: a.motivo, autor: a.autor ?? null, created_at: a.created_at } };
    }),
  ];
  return registros
    .filter((r) => (incluirAnuladas || !r.efectivo.anulada) && new Date(r.efectivo.hora) >= d && new Date(r.efectivo.hora) < h)
    .sort((x, y) => new Date(x.efectivo.hora) - new Date(y.efectivo.hora)
      || (x.checada_id ?? Infinity) - (y.checada_id ?? Infinity) || (x.correccion_id ?? 0) - (y.correccion_id ?? 0));
}

/**
 * La última checada que cuenta de un empleado (del último mes: un turno que
 * quedó abierto hace más de una semana también se avisa), para decidir en la
 * tablet qué le toca. Con `q` dentro de la transacción del checador (que ya
 * bloqueó al empleado).
 */
export async function ultimaEfectiva(q, negocioId, empleadoId) {
  const { rows: [{ ahora }] } = await q.query('SELECT NOW() AS ahora');
  const linea = await lineaEfectiva(q, negocioId, {
    empleadoId, desde: new Date(ahora.getTime() - 31 * DIA_MS), hasta: new Date(ahora.getTime() + 60000) });
  const u = linea.at(-1);
  return { ahora, ultima: u ? { tipo: u.efectivo.tipo, hora_oficial: u.efectivo.hora } : null };
}

/**
 * Marca lo que quedó fuera de orden (dos entradas seguidas, una salida sin
 * entrada…) con la misma regla de la tablet. `previa` es la última que contó
 * antes del periodo. Devuelve el conjunto de claves 'c:<id>' / 'a:<id>'.
 */
export function fueraDeOrden(registros, previa = null) {
  const marcadas = new Set();
  let ultima = previa;
  for (const r of registros) {
    if (r.efectivo.anulada) continue;
    const { posibles } = estadoTurno(ultima, r.efectivo.hora);
    if (!posibles.includes(r.efectivo.tipo)) marcadas.add(r.checada_id ? `c:${r.checada_id}` : `a:${r.correccion_id}`);
    ultima = { tipo: r.efectivo.tipo, hora_oficial: r.efectivo.hora };
  }
  return marcadas;
}

/** El día (en la zona de los negocios) con sus correcciones y lo fuera de orden. */
export async function correccionesDelDia(negocioId, fecha, originales) {
  const nid = exigirNegocio(negocioId);
  const { rows: [v] } = await pool.query(
    `SELECT ($1::date::timestamp AT TIME ZONE '${ZONA}') AS desde, (($1::date + 1)::timestamp AT TIME ZONE '${ZONA}') AS hasta`, [fecha]);
  // Las correcciones de las checadas del día, y las agregadas de ese día.
  const correcciones = await correccionesDe(pool, nid, { checadas: originales.map((c) => c.id), agregadas: [] });
  const porChecada = new Map();
  for (const r of correcciones) {
    const k = String(r.objetivo_checada_id);
    if (!porChecada.has(k)) porChecada.set(k, []);
    porChecada.get(k).push(r);
  }
  const { rows: agregadasDia } = await pool.query(
    `SELECT a.id, a.empleado_id, a.tipo, a.hora, a.motivo, a.created_at, u.nombre AS autor,
            e.numero_empleado, e.nombre AS empleado
       FROM xecador_correcciones a
       JOIN xecador_empleados e ON e.id = a.empleado_id AND e.negocio_id = a.negocio_id
       LEFT JOIN usuarios u ON u.id = a.creado_por
      WHERE a.negocio_id = $1 AND a.accion = 'agregar' AND a.hora >= $2 AND a.hora < $3
      ORDER BY a.hora, a.id`, [nid, v.desde, v.hasta]);
  const deAgregadas = await correccionesDe(pool, nid, { checadas: [], agregadas: agregadasDia.map((a) => a.id) });
  const porAgregada = new Map();
  for (const r of deAgregadas) {
    const k = String(r.objetivo_correccion_id);
    if (!porAgregada.has(k)) porAgregada.set(k, []);
    porAgregada.get(k).push(r);
  }
  // Fuera de orden: por empleado, con lo que contaba justo antes del día.
  const empleados = [...new Set([...originales.map((c) => c.empleado_id), ...agregadasDia.map((a) => a.empleado_id)])];
  const marcadas = new Set();
  for (const eid of empleados) {
    const antes = await lineaEfectiva(pool, nid, { empleadoId: eid, desde: new Date(v.desde.getTime() - 7 * DIA_MS), hasta: v.desde });
    const previa = antes.at(-1) ? { tipo: antes.at(-1).efectivo.tipo, hora_oficial: antes.at(-1).efectivo.hora } : null;
    const delDia = await lineaEfectiva(pool, nid, { empleadoId: eid, desde: v.desde, hasta: v.hasta });
    for (const k of fueraDeOrden(delDia, previa)) marcadas.add(k);
  }
  return {
    checadas: originales.map((c) => {
      const cs = porChecada.get(String(c.id)) || [];
      return { ...c, efectivo: efectivoDe({ tipo: c.tipo, hora: c.hora_oficial }, cs), correcciones: cs.map(publicaCorreccion),
        ultima_correccion_id: cs.length ? Number(cs.at(-1).id) : null, fuera_de_orden: marcadas.has(`c:${c.id}`) };
    }),
    agregadas: agregadasDia.map((a) => {
      const cs = porAgregada.get(String(a.id)) || [];
      return { correccion_id: Number(a.id), empleado_id: a.empleado_id, numero_empleado: a.numero_empleado, empleado: a.empleado,
        tipo: a.tipo, hora: a.hora, motivo: a.motivo, autor: a.autor ?? null, created_at: a.created_at,
        efectivo: efectivoDe(a, cs), correcciones: cs.map(publicaCorreccion),
        ultima_correccion_id: cs.length ? Number(cs.at(-1).id) : null, fuera_de_orden: marcadas.has(`a:${a.id}`) };
    }),
  };
}

// ── Corregir ───────────────────────────────────────────────────────────────
/** 'AAAA-MM-DDTHH:MM' en la hora de los negocios → instante; no futura. */
async function horaLocal(q, valor) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(valor)) {
    fallar('La fecha y hora van como AAAA-MM-DD HH:MM', 'HORA_INVALIDA');
  }
  const [fecha, hm] = valor.split('T');
  const [a, m, d] = fecha.split('-').map(Number);
  const [hh, mm] = hm.split(':').map(Number);
  const f = new Date(Date.UTC(a, m - 1, d));
  if (f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d || a < 2020 || a > 2100 || hh > 23 || mm > 59) {
    fallar('Esa fecha u hora no existe', 'HORA_INVALIDA');
  }
  const { rows: [r] } = await q.query(
    `SELECT ($1::timestamp AT TIME ZONE '${ZONA}') AS hora, (($1::timestamp AT TIME ZONE '${ZONA}') > NOW() + interval '1 minute') AS futura`,
    [`${fecha} ${hm}:00`]);
  if (r.futura) fallar('No se puede registrar una hora que todavía no llega', 'HORA_FUTURA');
  return r.hora;
}

function motivoValido(valor) {
  if (valor === undefined || valor === null || (typeof valor === 'string' && !valor.trim())) {
    fallar('Escribe el motivo de la corrección', 'MOTIVO_REQUERIDO');
  }
  if (typeof valor !== 'string') fallar('El motivo debe ser texto', 'MOTIVO_INVALIDO');
  const t = valor.trim();
  if (t.length > 300) fallar('El motivo admite hasta 300 caracteres', 'MOTIVO_INVALIDO');
  return t;
}

/**
 * Registra una corrección. `datos`: { accion, checada_id | correccion_id
 * (lo que se corrige; la agregada se identifica por su corrección),
 * empleado_id (solo al agregar), tipo, hora ('AAAA-MM-DDTHH:MM' local),
 * motivo, base (la última corrección que vio la pantalla, o null) }.
 */
export async function corregir(negocioId, datos, { actorId = null } = {}) {
  const nid = exigirNegocio(negocioId);
  if (typeof actorId !== 'string' || !UUID_RE.test(actorId)) fallar('No se pudo saber quién corrige', 'AUTOR_REQUERIDO');
  const b = datos && typeof datos === 'object' ? datos : {};
  if (!ACCIONES_CORRECCION.includes(b.accion)) fallar('Esa corrección no existe', 'ACCION_INVALIDA');
  const motivo = motivoValido(b.motivo);
  const conTipo = b.accion === 'agregar' || b.accion === 'modificar';
  if (conTipo && !TIPOS_CHECADA.includes(b.tipo)) fallar('Elige el tipo: entrada, salida, inicio o fin de descanso', 'TIPO_INVALIDO');

  return enTransaccion(async (client) => {
    const hora = conTipo ? await horaLocal(client, b.hora) : null;
    let empleadoId, objetivoChecada = null, objetivoCorreccion = null;

    if (b.accion === 'agregar') {
      if (typeof b.empleado_id !== 'string' || !UUID_RE.test(b.empleado_id)) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
      const { rows: [e] } = await client.query(
        `SELECT id FROM xecador_empleados WHERE id = $1 AND negocio_id = $2`, [b.empleado_id.toLowerCase(), nid]);
      if (!e) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
      empleadoId = e.id;
    } else {
      const checadaId = idPositivo(b.checada_id), correccionId = idPositivo(b.correccion_id);
      if ((checadaId === null) === (correccionId === null)) fallar('Indica qué checada se corrige', 'OBJETIVO_REQUERIDO');
      // Dos personas corrigiendo lo mismo a la vez: una espera a la otra.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`xecador-correccion:${nid}:${checadaId ? 'c' : 'a'}:${checadaId || correccionId}`]);
      let original;
      if (checadaId) {
        const { rows: [c] } = await client.query(
          `SELECT id, empleado_id, tipo, hora_oficial AS hora FROM xecador_checadas WHERE id = $1 AND negocio_id = $2`, [checadaId, nid]);
        if (!c) fallar('Checada no encontrada', 'CHECADA_NO_ENCONTRADA', 404);
        original = c; objetivoChecada = checadaId;
      } else {
        const { rows: [a] } = await client.query(
          `SELECT id, empleado_id, accion, tipo, hora FROM xecador_correcciones WHERE id = $1 AND negocio_id = $2`, [correccionId, nid]);
        if (!a) fallar('Checada no encontrada', 'CHECADA_NO_ENCONTRADA', 404);
        if (a.accion !== 'agregar') fallar('Solo se corrige una checada o una checada agregada, no otra corrección', 'OBJETIVO_INVALIDO');
        original = a; objetivoCorreccion = correccionId;
      }
      empleadoId = original.empleado_id;
      const previas = await correccionesDe(client, nid, objetivoChecada ? { checadas: [objetivoChecada] } : { agregadas: [objetivoCorreccion] });
      const ultimaId = previas.length ? Number(previas.at(-1).id) : null;
      if (b.base !== undefined && (idPositivo(b.base) ?? null) !== ultimaId) {
        fallar('Otra persona corrigió esta checada mientras la revisabas. Vuelve a abrirla para ver su corrección.', 'CORRECCION_CAMBIO', 409);
      }
      const ahora = efectivoDe(original, previas);
      if (b.accion === 'anular' && ahora.anulada) fallar('Esa checada ya está anulada', 'YA_ANULADA', 409);
      if (b.accion === 'restaurar' && !ahora.anulada) fallar('Esa checada no está anulada', 'NO_ANULADA', 409);
      if (b.accion === 'modificar' && !ahora.anulada && b.tipo === ahora.tipo && mismaHora(hora, ahora.hora)) {
        fallar('No hay nada que cambiar: el tipo y la hora son los mismos', 'SIN_CAMBIOS');
      }
    }

    const { rows: [r] } = await client.query(
      `INSERT INTO xecador_correcciones (negocio_id, empleado_id, accion, objetivo_checada_id, objetivo_correccion_id, tipo, hora, motivo, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, accion, tipo, hora, motivo, created_at, (SELECT nombre FROM usuarios WHERE id = $9) AS autor`,
      [nid, empleadoId, b.accion, objetivoChecada, objetivoCorreccion, conTipo ? b.tipo : null, hora, motivo, actorId]);
    return publicaCorreccion(r);
  });
}
