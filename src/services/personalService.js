// XECADOR · Personal — directorio de empleados con número.
//
// Primer entregable del módulo de asistencia dentro de Xabor. Aquí solo vive
// quién trabaja en el negocio y con qué número se identifica. No hay horarios,
// reloj, PIN, huella, fotos ni sucursales: llegan en sus propias etapas.
//
// Portado de la rama local `personal/mvp` (personalService.js, a773ee8 /
// 89f0a39) y recortado a alta, edición, listado y baja lógica, más el número
// de empleado que esa rama no tenía.
//
// ── Un empleado no es un usuario ───────────────────────────────────────────
// Un usuario es una credencial de acceso; un empleado es una persona que
// trabaja aquí. Dar de alta a alguien de cocina no crea ninguna cuenta.
//
// ── El número de empleado no pasa de una persona a otra ────────────────────
// Cada número que el negocio asigna queda registrado A NOMBRE de un empleado
// en `xecador_numeros_empleado`, que es de solo inserción (migración 127).
// Dar de baja a alguien no libera su número, y corregirle el número a alguien
// tampoco: el anterior queda apartado a su nombre para siempre. Nadie más
// puede usarlo; esa misma persona sí puede recuperarlo (decisión del dueño,
// 4-nov-2026), porque nunca se asignó a nadie más. Así, cuando el checador
// identifique por número, un número viejo nunca apuntará a otra persona.
//
// ── Bitácora del expediente ────────────────────────────────────────────────
// Regla del dueño (4-nov-2026): corregir el nombre se permite, pero cada
// cambio guarda quién, cuándo, el valor anterior y el nuevo. Alta, edición,
// baja y reactivación escriben su evento en `xecador_empleado_eventos` (solo
// inserción) DENTRO de la misma transacción que el cambio: o quedan los dos o
// ninguno. La baja conserva fecha, motivo y autor en la bitácora aunque la
// persona se reactive; la reactivación es otro evento. Una persona nueva
// recibe otro expediente y otro número: si alguien le cambia el nombre a un
// expediente, queda escrito.
//
// ── Aislamiento ────────────────────────────────────────────────────────────
// Toda función recibe el negocio de la sesión (req.negocioId) y filtra por él
// en cada consulta. Ninguna acepta un negocio que venga del navegador.
import { pool } from './database.js';

export class PersonalError extends Error {
  constructor(mensaje, codigo, http = 400) {
    super(mensaje);
    this.name = 'PersonalError';
    this.codigo = codigo;
    this.http = http;
  }
}
const fallar = (mensaje, codigo, http) => { throw new PersonalError(mensaje, codigo, http); };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const NUMERO_MAXIMO = 999999999;

// Lo que sale hacia la pantalla. Sin negocio_id ni quién lo creó: no hacen
// falta para administrar el directorio.
const COLUMNAS = `id, numero_empleado, nombre, puesto, telefono, estatus,
                  baja_at, baja_motivo, created_at, updated_at`;

function exigirNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !UUID_RE.test(negocioId.trim())) {
    fallar('No se pudo determinar el negocio de la sesión', 'TENANT_CONTEXT_REQUIRED', 500);
  }
  return negocioId.trim();
}

/** Un id que no es UUID no existe: se contesta 404, no un 500 de Postgres. */
function exigirEmpleadoId(empleadoId) {
  if (typeof empleadoId !== 'string' || !UUID_RE.test(empleadoId)) {
    fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
  }
  return empleadoId;
}

/**
 * El número que se teclea en el checador: solo dígitos, mayor que cero.
 * "007" y "7" son el mismo número; se guarda como entero para que no puedan
 * convivir dos empleados que en el teclado se escriben igual.
 */
export function normalizarNumero(valor) {
  if (valor === undefined || valor === null || (typeof valor === 'string' && valor.trim() === '')) {
    fallar('El número de empleado es obligatorio', 'NUMERO_REQUERIDO');
  }
  // Texto o número; una lista o un objeto no es un número de empleado.
  if (typeof valor !== 'string' && typeof valor !== 'number') {
    fallar('El número de empleado lleva solo dígitos (hasta 9)', 'NUMERO_INVALIDO');
  }
  const texto = String(valor).trim();
  if (!/^\d{1,9}$/.test(texto)) {
    fallar('El número de empleado lleva solo dígitos (hasta 9)', 'NUMERO_INVALIDO');
  }
  const n = Number(texto);
  if (!Number.isInteger(n) || n < 1 || n > NUMERO_MAXIMO) {
    fallar('El número de empleado debe ser mayor que cero', 'NUMERO_INVALIDO');
  }
  return n;
}

/**
 * Un campo de texto opcional. Solo acepta texto (o null para vaciarlo): un
 * objeto o una lista no se convierte a "[object Object]", se rechaza.
 */
function textoOpcional(valor, max, campo, codigo) {
  if (valor === undefined) return undefined;
  if (valor === null) return null;
  if (typeof valor !== 'string') fallar(`${campo}: debe ser texto`, codigo);
  const t = valor.trim();
  if (!t) return null;
  if (t.length > max) fallar(`${campo}: máximo ${max} caracteres`, codigo);
  return t;
}

function validarDatos(d, { parcial = false } = {}) {
  const out = {};
  if (!parcial || d.nombre !== undefined) {
    if (d.nombre !== undefined && d.nombre !== null && typeof d.nombre !== 'string') {
      fallar('Nombre: debe ser texto', 'NOMBRE_INVALIDO');
    }
    const nombre = String(d.nombre ?? '').trim();
    if (!nombre) fallar('El empleado necesita un nombre', 'NOMBRE_REQUERIDO');
    if (nombre.length > 120) fallar('Nombre: máximo 120 caracteres', 'NOMBRE_INVALIDO');
    out.nombre = nombre;
  }
  if (!parcial || d.numero !== undefined) out.numero_empleado = normalizarNumero(d.numero);
  const puesto = textoOpcional(d.puesto, 80, 'Puesto', 'PUESTO_INVALIDO');
  if (puesto !== undefined) out.puesto = puesto;
  const telefono = textoOpcional(d.telefono, 30, 'Teléfono', 'TELEFONO_INVALIDO');
  if (telefono !== undefined) out.telefono = telefono;
  return out;
}

function fallarNumeroUsado(numero) {
  fallar(`El número ${numero} ya lo tiene o lo tuvo otra persona en este negocio. Los números no se reutilizan entre personas.`,
    'NUMERO_YA_USADO', 409);
}

/** 23505 sobre el número → mensaje claro; cualquier otro error sigue su camino. */
function traducirChoque(e, numero) {
  if (e?.code === '23505' && ['xecador_numeros_empleado_pkey', 'xecador_empleados_numero_unico'].includes(e.constraint)) {
    fallarNumeroUsado(numero);
  }
  throw e;
}

async function enTransaccion(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await fn(client);
    await client.query('COMMIT');
    return resultado;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Aparta el número para este empleado. Si ya se usó alguna vez, 409. */
async function registrarNumero(client, nid, numero, empleadoId, actorId) {
  try {
    const { rows } = await client.query(
      `INSERT INTO xecador_numeros_empleado (negocio_id, numero, empleado_id, creado_por)
       VALUES ($1, $2, COALESCE($3::uuid, gen_random_uuid()), $4)
       RETURNING empleado_id`,
      [nid, numero, empleadoId, actorId]);
    return rows[0].empleado_id;
  } catch (e) {
    // La transacción entera se revierte en enTransaccion.
    return traducirChoque(e, numero);
  }
}

/** Escribe un evento en la bitácora del expediente (misma transacción). */
async function registrarEvento(client, nid, empleadoId, tipo, { cambios = {}, motivo = null, actorId = null } = {}) {
  await client.query(
    `INSERT INTO xecador_empleado_eventos (negocio_id, empleado_id, tipo, cambios, motivo, actor_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [nid, empleadoId, tipo, JSON.stringify(cambios), motivo, actorId]);
}

// Nombre del campo hacia fuera (la pantalla y la bitácora hablan de "numero").
const CAMPO_PUBLICO = { numero_empleado: 'numero', nombre: 'nombre', puesto: 'puesto', telefono: 'telefono' };

// ── Alta y edición ─────────────────────────────────────────────────────────

// ── Alta idempotente ──────────────────────────────────────────────────────
// La pantalla manda una clave (UUID) por cada alta y la REPITE si reintenta:
// una respuesta que tardó más de 15 s y la pantalla dio por perdida aunque el
// servidor sí la hizo, un doble envío. Con la misma clave, el alta devuelve el
// expediente que ya existe (repetida: true) en vez de crear otro y apartar
// otro número para la misma persona.
//   · La clave es única POR NEGOCIO (xecador_empleados_clave_alta_unica) y se
//     busca siempre con el negocio de la sesión: la de un negocio no encuentra
//     ni bloquea nada en otro.
//   · Dos envíos simultáneos con la misma clave: los dos intentan; la llave
//     única (o la del número, si mandaron el mismo) hace esperar al segundo
//     hasta que el primero confirma, y el segundo se revierte ENTERO (también
//     el número que hubiera apartado) y contesta con el expediente del primero.
//   · El reintento puede traer otros datos (corrigieron el número tras el
//     error): manda lo que ya quedó. Corregirlo después es una edición, con su
//     evento en la bitácora; un reintento nunca aparta un segundo número.

/** null si no viene; la clave en minúsculas si es un UUID; si no, 400. */
export function normalizarClaveAlta(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  if (typeof valor !== 'string' || !UUID_RE.test(valor.trim())) {
    fallar('La clave del alta no es válida: recarga la página e inténtalo de nuevo', 'CLAVE_ALTA_INVALIDA');
  }
  return valor.trim().toLowerCase();
}

async function altaPorClave(nid, clave) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNAS} FROM xecador_empleados WHERE negocio_id = $1 AND clave_alta = $2`, [nid, clave]);
  return rows[0] || null;
}

const esChoqueDeClave = (e) => e?.code === '23505' && e.constraint === 'xecador_empleados_clave_alta_unica';

/**
 * Da de alta a un empleado. Devuelve { empleado, repetida }: repetida = true
 * cuando la clave ya había dado de alta a alguien en este negocio.
 */
export async function darDeAltaEmpleado(negocioId, datos, { actorId = null, claveAlta = null } = {}) {
  const nid = exigirNegocio(negocioId);
  const clave = normalizarClaveAlta(claveAlta);
  const d = validarDatos(datos || {});
  if (clave) {
    const previo = await altaPorClave(nid, clave);
    if (previo) return { empleado: previo, repetida: true };
  }
  try {
    const empleado = await enTransaccion(async (client) => {
      // Primero se aparta el número (y con él, el id del empleado): si el número
      // ya se usó, no queda ningún expediente a medias.
      const id = await registrarNumero(client, nid, d.numero_empleado, null, actorId);
      try {
        const { rows } = await client.query(
          `INSERT INTO xecador_empleados (id, negocio_id, numero_empleado, nombre, puesto, telefono, creado_por, clave_alta)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${COLUMNAS}`,
          [id, nid, d.numero_empleado, d.nombre, d.puesto ?? null, d.telefono ?? null, actorId, clave]);
        const iniciales = { numero: d.numero_empleado, nombre: d.nombre };
        if (d.puesto) iniciales.puesto = d.puesto;
        if (d.telefono) iniciales.telefono = d.telefono;
        await registrarEvento(client, nid, id, 'alta', { cambios: iniciales, actorId });
        return rows[0];
      } catch (e) {
        return traducirChoque(e, d.numero_empleado);
      }
    });
    return { empleado, repetida: false };
  } catch (e) {
    // Otro envío con la MISMA clave ganó mientras este corría: chocó con su
    // clave o con el número que apartó. Esta transacción ya se revirtió
    // completa; se contesta con el expediente que quedó.
    if (clave && (esChoqueDeClave(e) || (e instanceof PersonalError && e.codigo === 'NUMERO_YA_USADO'))) {
      const previo = await altaPorClave(nid, clave);
      if (previo) return { empleado: previo, repetida: true };
    }
    throw e;
  }
}

/** Alta que devuelve solo el expediente (servicio y pruebas). */
export async function crearEmpleado(negocioId, datos, opciones = {}) {
  return (await darDeAltaEmpleado(negocioId, datos, opciones)).empleado;
}

/**
 * Edita nombre, puesto, teléfono o número. Un empleado dado de baja no se
 * edita: primero se reactiva (así nadie corrige por error a quien ya no está).
 */
export async function actualizarEmpleado(negocioId, empleadoId, datos, { actorId = null } = {}) {
  const nid = exigirNegocio(negocioId);
  const eid = exigirEmpleadoId(empleadoId);
  const d = validarDatos(datos || {}, { parcial: true });
  return enTransaccion(async (client) => {
    const { rows: [actual] } = await client.query(
      `SELECT id, numero_empleado, nombre, puesto, telefono, estatus FROM xecador_empleados
        WHERE id = $1 AND negocio_id = $2 FOR UPDATE`, [eid, nid]);
    if (!actual) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
    if (actual.estatus !== 'activo') fallar('Ese empleado está dado de baja: reactívalo para editarlo', 'EMPLEADO_DE_BAJA', 409);

    if (d.numero_empleado !== undefined && d.numero_empleado !== actual.numero_empleado) {
      // ¿A nombre de quién quedó ese número? El registro lo dice para siempre.
      const { rows: [registrado] } = await client.query(
        `SELECT empleado_id FROM xecador_numeros_empleado WHERE negocio_id = $1 AND numero = $2`,
        [nid, d.numero_empleado]);
      if (!registrado) {
        // Nunca se usó: se aparta a nombre de ESTE empleado. El anterior sigue
        // registrado a su nombre. (Si otra alta lo toma al mismo tiempo, la
        // llave del registro hace que una de las dos reciba 409.)
        await registrarNumero(client, nid, d.numero_empleado, actual.id, actorId);
      } else if (registrado.empleado_id !== actual.id) {
        // Lo tiene o lo tuvo otra persona: no pasa de una persona a otra.
        fallarNumeroUsado(d.numero_empleado);
      }
      // Si ya era suyo, lo recupera sin registrarlo otra vez: nadie más pudo
      // tenerlo, porque el registro no repite (negocio, número).
    } else {
      delete d.numero_empleado;
    }

    const campos = Object.keys(d);
    if (!campos.length) {
      const { rows } = await client.query(
        `SELECT ${COLUMNAS} FROM xecador_empleados WHERE id = $1 AND negocio_id = $2`, [eid, nid]);
      return rows[0];
    }
    const set = campos.map((c, i) => `${c} = $${i + 3}`).join(', ');
    try {
      const { rows } = await client.query(
        `UPDATE xecador_empleados SET ${set}
          WHERE id = $1 AND negocio_id = $2
          RETURNING ${COLUMNAS}`,
        [eid, nid, ...campos.map((c) => d[c])]);
      // Solo lo que cambió de verdad: mandar el mismo nombre no es un cambio.
      const cambiado = {};
      for (const c of campos) {
        const antes = actual[c] ?? null, despues = d[c] ?? null;
        if (antes !== despues) cambiado[CAMPO_PUBLICO[c]] = { antes, despues };
      }
      if (Object.keys(cambiado).length) {
        await registrarEvento(client, nid, actual.id, 'edicion', { cambios: cambiado, actorId });
      }
      return rows[0];
    } catch (e) {
      return traducirChoque(e, d.numero_empleado);
    }
  });
}

/**
 * Baja LÓGICA. Nunca borrado físico: las checadas y prenóminas futuras
 * apuntarán a esta fila. El número sigue apartado.
 */
export async function darDeBajaEmpleado(negocioId, empleadoId, { motivo = null, actorId = null } = {}) {
  const nid = exigirNegocio(negocioId);
  const eid = exigirEmpleadoId(empleadoId);
  const m = textoOpcional(motivo ?? null, 200, 'Motivo', 'MOTIVO_INVALIDO') ?? null;
  return enTransaccion(async (client) => {
    const { rows } = await client.query(
      `UPDATE xecador_empleados
          SET estatus = 'baja', baja_at = NOW(), baja_motivo = $3, baja_por = $4
        WHERE id = $1 AND negocio_id = $2 AND estatus = 'activo'
        RETURNING ${COLUMNAS}`,
      [eid, nid, m, actorId]);
    if (rows.length) {
      // La baja queda en la bitácora con su fecha, motivo y autor: reactivar no
      // la borra.
      await registrarEvento(client, nid, rows[0].id, 'baja', { motivo: m, actorId });
      return rows[0];
    }
    const { rowCount } = await client.query(
      `SELECT 1 FROM xecador_empleados WHERE id = $1 AND negocio_id = $2`, [eid, nid]);
    if (!rowCount) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
    fallar('Ese empleado ya está dado de baja', 'EMPLEADO_YA_DE_BAJA', 409);
  });
}

/**
 * Deshace una baja: la MISMA persona vuelve con el MISMO expediente y número.
 * La fila vuelve a "activo" (su estado actual); la baja sigue escrita en la
 * bitácora y la reactivación se registra como otro evento. Cambiarle el nombre
 * es otra operación (actualizarEmpleado), que también queda en la bitácora.
 */
export async function reactivarEmpleado(negocioId, empleadoId, { actorId = null } = {}) {
  const nid = exigirNegocio(negocioId);
  const eid = exigirEmpleadoId(empleadoId);
  return enTransaccion(async (client) => {
    const { rows } = await client.query(
      `UPDATE xecador_empleados
          SET estatus = 'activo', baja_at = NULL, baja_motivo = NULL, baja_por = NULL
        WHERE id = $1 AND negocio_id = $2 AND estatus = 'baja'
        RETURNING ${COLUMNAS}`,
      [eid, nid]);
    if (rows.length) {
      await registrarEvento(client, nid, rows[0].id, 'reactivacion', { actorId });
      return rows[0];
    }
    const { rowCount } = await client.query(
      `SELECT 1 FROM xecador_empleados WHERE id = $1 AND negocio_id = $2`, [eid, nid]);
    if (!rowCount) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
    fallar('Ese empleado ya está activo', 'EMPLEADO_YA_ACTIVO', 409);
  });
}

/**
 * La historia de un expediente, de la más antigua a la más reciente. Un id
 * que no es de este negocio contesta 404, igual que si no existiera.
 */
export async function historialEmpleado(negocioId, empleadoId) {
  const nid = exigirNegocio(negocioId);
  const eid = exigirEmpleadoId(empleadoId);
  const { rowCount } = await pool.query(
    `SELECT 1 FROM xecador_empleados WHERE id = $1 AND negocio_id = $2`, [eid, nid]);
  if (!rowCount) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
  const { rows } = await pool.query(
    `SELECT v.id, v.tipo, v.cambios, v.motivo, v.created_at, u.nombre AS actor
       FROM xecador_empleado_eventos v
       LEFT JOIN usuarios u ON u.id = v.actor_id
      WHERE v.negocio_id = $1 AND v.empleado_id = $2
      ORDER BY v.id`,
    [nid, eid]);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

// ── Quién NO administra empleados ──────────────────────────────────────────
/**
 * ¿Es Superadmin de Xabor (administradores_plataforma, activo)? Decisión del
 * dueño (5-nov-2026): el Superadmin no administra empleados de Xecador. A
 * diferencia de esSuperadmin() de database.js, que devuelve false si la base
 * falla, esta LANZA: la ruta convierte el error en 503 en vez de dejar pasar.
 */
export async function usuarioEsSuperadmin(usuarioId) {
  // Sin un usuario de sesión válido no se puede saber: tampoco se deja pasar.
  if (typeof usuarioId !== 'string' || !UUID_RE.test(usuarioId)) throw new Error('usuario de sesión no verificable');
  const { rowCount } = await pool.query(
    `SELECT 1 FROM administradores_plataforma WHERE usuario_id = $1 AND activo = true`, [usuarioId]);
  return rowCount > 0;
}

// ── Consulta ───────────────────────────────────────────────────────────────

export async function listarEmpleados(negocioId, { incluirBajas = false } = {}) {
  const nid = exigirNegocio(negocioId);
  const { rows } = await pool.query(
    `SELECT ${COLUMNAS} FROM xecador_empleados
      WHERE negocio_id = $1 AND ($2::boolean OR estatus = 'activo')
      ORDER BY (estatus = 'baja'), lower(nombre), numero_empleado`,
    [nid, incluirBajas === true]);
  return rows;
}

/**
 * El número que la pantalla propone al dar de alta: el siguiente al mayor que
 * el negocio haya usado nunca (también los de bajas y los corregidos). Es solo
 * una sugerencia: quien da de alta puede escribir otro.
 */
export async function siguienteNumeroSugerido(negocioId) {
  const nid = exigirNegocio(negocioId);
  const { rows: [r] } = await pool.query(
    `SELECT COALESCE(MAX(numero), 0)::bigint + 1 AS siguiente
       FROM xecador_numeros_empleado WHERE negocio_id = $1`, [nid]);
  const n = Number(r.siguiente);
  return n <= NUMERO_MAXIMO ? n : null;
}
