// XECADOR · Cara — PIN + cara, fase 1 (migración 134).
//
// Pedido del dueño el 10-nov-2026; los empleados firmaron el consentimiento de
// reconocimiento facial y datos biométricos. El empleado sigue checando con su
// PIN; la cara confirma que es él:
//
//   · Consentimiento: el administrador anota en el expediente la fecha en que
//     el empleado firmó. Sin ella no se registra su cara. Retirarlo borra la
//     cara; la baja retira las dos cosas (lo hace la base, con triggers).
//   · Registro: con el empleado presente, varias fotos de frente. Se guardan
//     cifrados los vectores y la mejor foto (para revisar a mano). Si la cara
//     se parece a la de otro empleado del negocio, el administrador lo tiene
//     que confirmar.
//   · Al checar (si el negocio lo encendió y el empleado tiene su cara): la
//     tablet manda fotos de frente y con un pequeño giro de la cabeza, y el
//     servidor compara. La checada se registra SIEMPRE. Si la cara no coincide
//     queda «para revisar» con aviso al administrador; si no se pudo comparar
//     (sin cámara, sin cara, sin giro, sin motor), «para revisar».
//
// Aislamiento: el negocio sale siempre de la sesión o del token de la tablet.
// Ningún error del motor tumba una checada: verificarEnChecada nunca lanza.
import { pool } from './database.js';
import { PersonalError } from './personalService.js';
import { estadoMotor, obtenerMotor } from './caraMotor.js';
import { evaluarChecada, evaluarRegistro, mejorSimilitud } from './caraGeometria.js';
import { bytesAVectores, cifrarCara, descifrarCara, huellaLlave, vectoresABytes } from './caraCifrado.js';

export const REGISTRO_MIN = 3;    // fotos buenas para registrar una cara
export const REGISTRO_MAX = 6;    // fotos que se aceptan en un registro
export const CHECADA_MAX = 6;     // fotos que se miran en una checada
export const IMAGEN_MAX_BYTES = 150 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOY_SQL = `(NOW() AT TIME ZONE 'America/Matamoros')::date`;
const fallar = (mensaje, codigo, http, extra) => {
  const e = new PersonalError(mensaje, codigo, http);
  if (extra) e.extra = extra;
  throw e;
};

function ids(negocioId, empleadoId) {
  if (typeof negocioId !== 'string' || !UUID_RE.test(negocioId.trim())) {
    fallar('No se pudo determinar el negocio de la sesión', 'TENANT_CONTEXT_REQUIRED', 500);
  }
  if (typeof empleadoId !== 'string' || !UUID_RE.test(empleadoId.trim())) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
  return [negocioId.trim().toLowerCase(), empleadoId.trim().toLowerCase()];
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

async function evento(q, nid, eid, tipo, cambios, { motivo = null, actorId = null } = {}) {
  await q.query(
    `INSERT INTO xecador_empleado_eventos (negocio_id, empleado_id, tipo, cambios, motivo, actor_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`, [nid, eid, tipo, JSON.stringify(cambios), motivo, actorId]);
}

/** Una foto JPEG o WebP de verdad y de tamaño razonable, o null. */
export function leerImagen(foto, max = IMAGEN_MAX_BYTES) {
  if (!foto || typeof foto !== 'object' || typeof foto.datos !== 'string' || foto.datos.length > max * 1.4) return null;
  let bytes;
  try { bytes = Buffer.from(foto.datos, 'base64'); } catch { return null; }
  if (!bytes.length || bytes.length > max) return null;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  if (jpeg) return { mime: 'image/jpeg', bytes };
  if (webp) return { mime: 'image/webp', bytes };
  return null;
}

/** ¿Este servidor puede usar la cara? Hace falta el motor y la llave. */
export function caraDisponible() {
  const m = estadoMotor();
  const huella = huellaLlave();
  return { disponible: m.disponible && !!huella, modelo: m.modelo, motivo: !m.disponible ? m.motivo : huella ? null : 'sin_llave' };
}

const vigente = (fila) => {
  const m = obtenerMotor();
  return !!(m && fila.modelo === m.id && fila.llave === huellaLlave());
};

/** Lo que el panel muestra del expediente. */
export async function estadoCaraEmpleado(negocioId, empleadoId, q = pool) {
  const [nid, eid] = ids(negocioId, empleadoId);
  const { rows: [e] } = await q.query(
    `SELECT e.estatus, e.version, to_char(e.consentimiento_cara_fecha, 'YYYY-MM-DD') AS consentimiento_cara_fecha,
            c.created_at AS cara_at, c.muestras, c.modelo, c.llave
       FROM xecador_empleados e
       LEFT JOIN xecador_caras c ON c.negocio_id = e.negocio_id AND c.empleado_id = e.id
      WHERE e.id = $1 AND e.negocio_id = $2`, [eid, nid]);
  if (!e) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
  return {
    consentimiento_cara_fecha: e.consentimiento_cara_fecha, version: e.version,
    cara: e.cara_at ? { registrada_at: e.cara_at, muestras: e.muestras, vigente: vigente(e) } : null,
  };
}

// ── Consentimiento ───────────────────────────────────────────────────────────
/**
 * { firmado: true, fecha: 'AAAA-MM-DD' } anota la firma; { firmado: false }
 * la retira y, con ella, la cara (lo hace la base). Las dos quedan en la
 * bitácora con su autor.
 */
export async function guardarConsentimiento(negocioId, empleadoId, datos, { actorId = null } = {}) {
  const [nid, eid] = ids(negocioId, empleadoId);
  const b = datos && typeof datos === 'object' ? datos : {};
  if (typeof b.firmado !== 'boolean') fallar('Indica si el empleado firmó el consentimiento', 'CONSENTIMIENTO_INVALIDO');
  let fecha = null;
  if (b.firmado) {
    fecha = typeof b.fecha === 'string' ? b.fecha.trim() : '';
    const f = /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? new Date(`${fecha}T12:00:00Z`) : null;
    if (!f || Number.isNaN(f.getTime()) || f.toISOString().slice(0, 10) !== fecha) {
      fallar('Escribe la fecha en que el empleado firmó (AAAA-MM-DD)', 'FECHA_CONSENTIMIENTO_INVALIDA');
    }
    if (fecha < '2020-01-01') fallar('Esa fecha de firma no es válida', 'FECHA_CONSENTIMIENTO_INVALIDA');
  }
  const motivo = typeof b.motivo === 'string' && b.motivo.trim() ? b.motivo.trim().slice(0, 200) : null;
  return enTransaccion(async (client) => {
    const { rows: [e] } = await client.query(
      `SELECT estatus, to_char(consentimiento_cara_fecha, 'YYYY-MM-DD') AS actual, to_char(${HOY_SQL}, 'YYYY-MM-DD') AS hoy
         FROM xecador_empleados WHERE id = $1 AND negocio_id = $2 FOR UPDATE`, [eid, nid]);
    if (!e) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
    if (b.firmado) {
      if (e.estatus !== 'activo') fallar('Ese empleado está dado de baja', 'EMPLEADO_DE_BAJA', 409);
      if (fecha > e.hoy) fallar('La fecha de firma no puede ser futura', 'FECHA_CONSENTIMIENTO_INVALIDA');
    }
    if (e.actual !== fecha) {
      // El evento del consentimiento va antes del UPDATE: si con él se borra
      // la cara, la bitácora lo cuenta en ese orden.
      await evento(client, nid, eid, 'consentimiento_cara',
        { consentimiento_cara_fecha: { antes: e.actual, despues: fecha } }, { motivo: b.firmado ? null : motivo, actorId });
      await client.query(
        `UPDATE xecador_empleados SET consentimiento_cara_fecha = $3::date, version = version + 1, updated_at = NOW()
          WHERE id = $1 AND negocio_id = $2`, [eid, nid, fecha]);
    }
    return estadoCaraEmpleado(nid, eid, client);
  });
}

// ── Registro de la cara ──────────────────────────────────────────────────────
function textoPocasFotos(conteo, total) {
  const partes = [];
  if (conteo.sin_cara) partes.push(`${conteo.sin_cara} sin una cara clara`);
  if (conteo.varias_caras) partes.push(`${conteo.varias_caras} con más de una cara`);
  if (conteo.de_lado) partes.push(`${conteo.de_lado} de lado`);
  return `Sirvieron ${conteo.buenas} de ${total} fotos${partes.length ? ` (${partes.join(', ')})` : ''}. `
    + `Hacen falta ${REGISTRO_MIN}: de frente, una sola cara, cerca de la cámara y con buena luz.`;
}

/**
 * Registra (o reemplaza) la cara de un empleado activo con consentimiento.
 * datos: { fotos: [{ datos: base64 }], confirmar_parecido?: true }
 */
export async function registrarCara(negocioId, empleadoId, datos, { actorId = null } = {}) {
  const [nid, eid] = ids(negocioId, empleadoId);
  const b = datos && typeof datos === 'object' ? datos : {};
  const disponible = caraDisponible();
  if (!disponible.disponible) fallar('El reconocimiento de cara no está disponible en este servidor.', 'CARA_NO_DISPONIBLE', 503);
  const motor = obtenerMotor();
  const huella = huellaLlave();
  if (!Array.isArray(b.fotos) || b.fotos.length < REGISTRO_MIN || b.fotos.length > REGISTRO_MAX) {
    fallar(`Manda de ${REGISTRO_MIN} a ${REGISTRO_MAX} fotos`, 'FOTOS_INVALIDAS');
  }
  const imagenes = b.fotos.map((f) => leerImagen(f));
  if (imagenes.some((i) => !i)) fallar('Una de las fotos no es JPEG o WebP, o pesa más de 150 KB', 'FOTO_INVALIDA');

  const { rows: [e] } = await pool.query(
    `SELECT estatus, consentimiento_cara_fecha FROM xecador_empleados WHERE id = $1 AND negocio_id = $2`, [eid, nid]);
  if (!e) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
  if (e.estatus !== 'activo') fallar('Ese empleado está dado de baja', 'EMPLEADO_DE_BAJA', 409);
  if (!e.consentimiento_cara_fecha) {
    fallar('Primero anota la fecha en que el empleado firmó el consentimiento.', 'SIN_CONSENTIMIENTO', 409);
  }

  let analisis;
  try {
    analisis = await Promise.all(imagenes.map((i) => motor.analizar(i.bytes)));
  } catch (err) {
    console.error(`[Cara] el motor no pudo revisar un registro: ${err.message}`);
    fallar('No se pudieron revisar las fotos. Inténtalo de nuevo.', 'CARA_FALLO_MOTOR', 503);
  }
  const r = evaluarRegistro({ analisis, minimo: REGISTRO_MIN, umbrales: motor.umbrales });
  if (r.error === 'POCAS_FOTOS') fallar(textoPocasFotos(r.conteo, imagenes.length), 'POCAS_FOTOS', 422, { conteo: r.conteo });
  if (r.error === 'NO_SON_LA_MISMA') fallar('Las fotos no parecen de la misma persona. Vuelve a tomarlas.', 'NO_SON_LA_MISMA', 422);

  // ¿Se parece a la cara de otro empleado del negocio? Una persona no debe
  // quedar registrada dos veces; el administrador lo confirma (hermanos, etc.).
  const { rows: otras } = await pool.query(
    `SELECT c.empleado_id, c.vectores, e.nombre, e.numero_empleado FROM xecador_caras c
       JOIN xecador_empleados e ON e.negocio_id = c.negocio_id AND e.id = c.empleado_id
      WHERE c.negocio_id = $1 AND c.empleado_id <> $2 AND c.modelo = $3 AND c.llave = $4`, [nid, eid, motor.id, huella]);
  let parecido = null, mayor = -1;
  for (const o of otras) {
    let suyos;
    try { suyos = bytesAVectores(descifrarCara(o.vectores, { negocioId: nid, empleadoId: o.empleado_id, campo: 'vectores' })); } catch { continue; }
    const s = Math.max(...r.vectores.map((v) => mejorSimilitud(v, suyos)));
    if (s >= motor.umbrales.coincide && s > mayor) { mayor = s; parecido = { nombre: o.nombre, numero: o.numero_empleado }; }
  }
  if (parecido && b.confirmar_parecido !== true) {
    fallar(`Esta cara se parece a la de ${parecido.nombre} (número ${parecido.numero}). Confirma que es otra persona.`,
      'CARA_PARECIDA', 409, { parecido });
  }

  const ref = imagenes[r.referencia];
  const vectores = cifrarCara(vectoresABytes(r.vectores), { negocioId: nid, empleadoId: eid, campo: 'vectores' });
  const foto = cifrarCara(ref.bytes, { negocioId: nid, empleadoId: eid, campo: 'foto' });
  try {
    return await enTransaccion(async (client) => {
      const { rows: [x] } = await client.query(
        `SELECT estatus, consentimiento_cara_fecha FROM xecador_empleados WHERE id = $1 AND negocio_id = $2 FOR UPDATE`, [eid, nid]);
      if (!x || x.estatus !== 'activo' || !x.consentimiento_cara_fecha) {
        fallar('El consentimiento o el expediente cambiaron mientras se revisaban las fotos. Vuelve a intentarlo.', 'SIN_CONSENTIMIENTO', 409);
      }
      const { rowCount: habia } = await client.query(`DELETE FROM xecador_caras WHERE negocio_id = $1 AND empleado_id = $2`, [nid, eid]);
      await client.query(
        `INSERT INTO xecador_caras (negocio_id, empleado_id, modelo, llave, vectores, muestras, foto, foto_mime, creado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [nid, eid, motor.id, huella, vectores, r.muestras, foto, ref.mime, actorId]);
      await evento(client, nid, eid, 'cara', { cara: { antes: habia > 0, despues: true }, muestras: r.muestras },
        { motivo: parecido ? `Se parece a la de ${parecido.nombre} (número ${parecido.numero}); confirmado por el administrador`.slice(0, 200) : null, actorId });
      return estadoCaraEmpleado(nid, eid, client);
    });
  } catch (err) {
    // El trigger de la base: sin consentimiento o de baja, no se guarda.
    if (err?.code === 'P0001' && /consentimiento/.test(err.message)) {
      fallar('Sin el consentimiento firmado no se registra la cara.', 'SIN_CONSENTIMIENTO', 409);
    }
    throw err;
  }
}

/** Borra la cara registrada (el consentimiento se queda). */
export async function borrarCara(negocioId, empleadoId, { actorId = null } = {}) {
  const [nid, eid] = ids(negocioId, empleadoId);
  return enTransaccion(async (client) => {
    const { rowCount: existe } = await client.query(
      `SELECT 1 FROM xecador_empleados WHERE id = $1 AND negocio_id = $2 FOR UPDATE`, [eid, nid]);
    if (!existe) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
    const { rowCount } = await client.query(`DELETE FROM xecador_caras WHERE negocio_id = $1 AND empleado_id = $2`, [nid, eid]);
    if (rowCount) await evento(client, nid, eid, 'cara', { cara: { antes: true, despues: false } }, { motivo: 'Borrada por el administrador', actorId });
    return estadoCaraEmpleado(nid, eid, client);
  });
}

/** La foto de referencia de la cara registrada, para revisar a mano. */
export async function fotoReferencia(negocioId, empleadoId) {
  const [nid, eid] = ids(negocioId, empleadoId);
  const { rows: [c] } = await pool.query(
    `SELECT foto, foto_mime FROM xecador_caras WHERE negocio_id = $1 AND empleado_id = $2`, [nid, eid]);
  if (!c) fallar('Ese empleado no tiene su cara registrada', 'SIN_CARA', 404);
  try {
    return { mime: c.foto_mime, datos: descifrarCara(c.foto, { negocioId: nid, empleadoId: eid, campo: 'foto' }) };
  } catch {
    fallar('La cara se registró con otra llave del servidor: vuelve a registrarla.', 'CARA_NO_VIGENTE', 409);
  }
}

// ── Al checar ────────────────────────────────────────────────────────────────
/** ¿La tablet debe tomar las fotos para este empleado? */
export async function pedirCaraAlChecar(nid, empleadoId, config) {
  if (config?.cara_al_checar !== 'confirmar' || !caraDisponible().disponible) return false;
  const { rows: [c] } = await pool.query(
    `SELECT modelo, llave FROM xecador_caras WHERE negocio_id = $1 AND empleado_id = $2`, [nid, empleadoId]);
  return !!c && vigente(c);
}

/**
 * Cómo salió la cara de una checada: { cara, detalle, similitud, foto }.
 * foto es la de frente (la que se guarda con la checada), o null. NUNCA
 * lanza: ante cualquier error, 'no_verificada' con detalle 'motor'.
 */
export async function verificarEnChecada(nid, empleadoId, fotos, config) {
  const base = { detalle: null, similitud: null, foto: null };
  if (config?.cara_al_checar !== 'confirmar') return { ...base, cara: 'no_requerida' };
  try {
    const { rows: [c] } = await pool.query(
      `SELECT c.modelo, c.llave, c.vectores FROM xecador_caras c
         JOIN xecador_empleados e ON e.negocio_id = c.negocio_id AND e.id = c.empleado_id
        WHERE c.negocio_id = $1 AND c.empleado_id = $2 AND e.estatus = 'activo'`, [nid, empleadoId]);
    if (!c) return { ...base, cara: 'sin_registro' };
    const motor = obtenerMotor();
    if (!motor || !huellaLlave()) return { ...base, cara: 'no_verificada', detalle: 'motor' };
    if (!vigente(c)) return { ...base, cara: 'sin_registro' };
    const registro = bytesAVectores(descifrarCara(c.vectores, { negocioId: nid, empleadoId, campo: 'vectores' }));
    const imagenes = (Array.isArray(fotos) ? fotos.slice(0, CHECADA_MAX) : []).map((f) => leerImagen(f)).filter(Boolean);
    if (!imagenes.length) return { ...base, cara: 'no_verificada', detalle: 'sin_camara' };
    const analisis = await Promise.all(imagenes.map((i) => motor.analizar(i.bytes)));
    const r = evaluarChecada({ analisis, registro, umbrales: motor.umbrales });
    return { cara: r.cara, detalle: r.detalle, similitud: r.similitud, foto: r.frente === null ? imagenes[0] : imagenes[r.frente] };
  } catch (err) {
    console.error(`[Cara] no se pudo comparar una checada: ${err.message}`);
    return { ...base, cara: 'no_verificada', detalle: 'motor' };
  }
}

/** Los motivos «para revisar» que deja la cara. */
export function motivoRevisionCara(cara) {
  if (cara === 'no_coincide') return 'cara_no_coincide';
  if (cara === 'no_verificada') return 'cara_no_verificada';
  return null;
}
