// XECADOR · Personal — directorio de empleados con número.
//
// El expediente del módulo de asistencia dentro de Xabor: quién trabaja en el
// negocio, con qué número se identifica y, desde la Parte A (migración 128),
// su sucursal, fecha de ingreso, NSS, jornada con vigencia, PIN de checado
// (solo su hash) y el motivo de catálogo de su baja. El reloj checador
// (checadas, dispositivos, bloqueo de PIN) llega en la Parte B.
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
import { randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { pool } from './database.js';

const scrypt = promisify(scryptCallback);

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
// falta para administrar el directorio. Nunca el hash del PIN: solo si tiene.
// Las fechas salen como texto 'AAAA-MM-DD': un `date` convertido a Date de JS
// cae a medianoche local y en JSON se lee un día antes.
const COLUMNAS = `id, numero_empleado, nombre, puesto, telefono, estatus,
                  baja_at, baja_motivo, to_char(baja_fecha, 'YYYY-MM-DD') AS baja_fecha, baja_tipo,
                  sucursal_id, puede_checar_otras_sucursales,
                  to_char(fecha_ingreso, 'YYYY-MM-DD') AS fecha_ingreso, nss,
                  (pin_hash IS NOT NULL) AS tiene_pin, pin_actualizado_at,
                  CASE WHEN pin_bloqueado_hasta > NOW() THEN pin_bloqueado_hasta END AS pin_en_pausa_hasta, version,
                  created_at, updated_at`;

// Fecha de hoy en la zona de los negocios (America/Matamoros), para defaults y
// límites de fechas.
const HOY_SQL = `(NOW() AT TIME ZONE 'America/Matamoros')::date`;

export const TIPOS_BAJA = ['renuncia', 'despido', 'termino_contrato', 'otro'];
export const TIPOS_JORNADA = ['diurna', 'nocturna', 'mixta'];

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

/** 'AAAA-MM-DD' de un día que existe (entre 1950 y 2100), o null para vaciarlo. */
function fechaOpcional(valor, campo, codigo) {
  if (valor === undefined) return undefined;
  if (valor === null || valor === '') return null;
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor.trim())) fallar(`${campo}: usa el formato AAAA-MM-DD`, codigo);
  const t = valor.trim();
  const [a, m, d] = t.split('-').map(Number);
  const f = new Date(Date.UTC(a, m - 1, d));
  if (f.getUTCFullYear() !== a || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d || a < 1950 || a > 2100) {
    fallar(`${campo}: esa fecha no existe`, codigo);
  }
  return t;
}

/** NSS: 11 dígitos (se aceptan espacios o guiones al escribirlo), o null. */
function nssOpcional(valor) {
  if (valor === undefined) return undefined;
  if (valor === null || valor === '') return null;
  if (typeof valor !== 'string' && typeof valor !== 'number') fallar('NSS: debe ser texto', 'NSS_INVALIDO');
  const t = String(valor).replace(/[\s-]/g, '');
  if (!/^\d{11}$/.test(t)) fallar('El NSS lleva exactamente 11 dígitos', 'NSS_INVALIDO');
  return t;
}

/** El NSS en la bitácora (que no se borra) va enmascarado: solo los 4 últimos. */
const nssEnmascarado = (nss) => (nss ? `•••••••${String(nss).slice(-4)}` : null);

function booleano(valor, campo, codigo) {
  if (valor === undefined) return undefined;
  if (typeof valor !== 'boolean') fallar(`${campo}: debe ser sí o no`, codigo);
  return valor;
}

function uuidOpcional(valor, campo, codigo) {
  if (valor === undefined) return undefined;
  if (valor === null || valor === '') return null;
  if (typeof valor !== 'string' || !UUID_RE.test(valor)) fallar(`${campo}: no es válida`, codigo);
  return valor.toLowerCase();
}

/** La sucursal tiene que ser de ESTE negocio y estar activa. Devuelve su nombre. */
async function sucursalDelNegocio(client, nid, sucursalId) {
  const { rows: [s] } = await client.query(
    `SELECT id, nombre FROM sucursales WHERE id = $1 AND negocio_id = $2 AND activo`, [sucursalId, nid]);
  if (!s) fallar('Esa sucursal no es de este negocio o no está activa', 'SUCURSAL_INVALIDA');
  return s.nombre;
}

function validarDatos(d, { parcial = false } = {}) {
  const out = {};
  const sucursal = uuidOpcional(d.sucursal_id, 'Sucursal', 'SUCURSAL_INVALIDA');
  if (sucursal !== undefined) out.sucursal_id = sucursal;
  const otras = booleano(d.puede_checar_otras_sucursales, 'Puede checar en otras sucursales', 'OTRAS_SUCURSALES_INVALIDO');
  if (otras !== undefined) out.puede_checar_otras_sucursales = otras;
  const ingreso = fechaOpcional(d.fecha_ingreso, 'Fecha de ingreso', 'FECHA_INGRESO_INVALIDA');
  if (ingreso !== undefined) out.fecha_ingreso = ingreso;
  const nss = nssOpcional(d.nss);
  if (nss !== undefined) out.nss = nss;
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
const CAMPO_PUBLICO = {
  numero_empleado: 'numero', nombre: 'nombre', puesto: 'puesto', telefono: 'telefono',
  sucursal_id: 'sucursal', puede_checar_otras_sucursales: 'otras_sucursales',
  fecha_ingreso: 'fecha_ingreso', nss: 'nss',
};

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
      // Sucursal: la que mandaron (tiene que ser de este negocio) o, si no
      // mandaron ninguna y el negocio tiene una sola activa, esa.
      let sucursalId = d.sucursal_id ?? null, sucursalNombre = null;
      if (sucursalId) {
        sucursalNombre = await sucursalDelNegocio(client, nid, sucursalId);
      } else if (d.sucursal_id === undefined) {
        const { rows: activas } = await client.query(
          `SELECT id, nombre FROM sucursales WHERE negocio_id = $1 AND activo ORDER BY created_at LIMIT 2`, [nid]);
        if (activas.length === 1) [sucursalId, sucursalNombre] = [activas[0].id, activas[0].nombre];
      }
      // Primero se aparta el número (y con él, el id del empleado): si el número
      // ya se usó, no queda ningún expediente a medias.
      const id = await registrarNumero(client, nid, d.numero_empleado, null, actorId);
      try {
        const { rows } = await client.query(
          `INSERT INTO xecador_empleados (id, negocio_id, numero_empleado, nombre, puesto, telefono, creado_por, clave_alta,
                                          sucursal_id, puede_checar_otras_sucursales, fecha_ingreso, nss)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING ${COLUMNAS}`,
          [id, nid, d.numero_empleado, d.nombre, d.puesto ?? null, d.telefono ?? null, actorId, clave,
            sucursalId, d.puede_checar_otras_sucursales ?? false, d.fecha_ingreso ?? null, d.nss ?? null]);
        const iniciales = { numero: d.numero_empleado, nombre: d.nombre };
        if (d.puesto) iniciales.puesto = d.puesto;
        if (d.telefono) iniciales.telefono = d.telefono;
        if (sucursalNombre) iniciales.sucursal = sucursalNombre;
        if (d.puede_checar_otras_sucursales) iniciales.otras_sucursales = true;
        if (d.fecha_ingreso) iniciales.fecha_ingreso = d.fecha_ingreso;
        if (d.nss) iniciales.nss = nssEnmascarado(d.nss);
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

/** La versión que la pantalla tenía al abrir el expediente, o null si no la manda. */
function versionEsperada(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1) fallar('La versión del expediente no es válida: vuelve a abrirlo', 'VERSION_INVALIDA');
  return n;
}

const fallarExpedienteCambio = () => fallar(
  'Otra persona cambió este expediente mientras lo editabas. Vuelve a abrirlo para ver sus cambios antes de guardar.',
  'EXPEDIENTE_CAMBIO', 409);

/**
 * Edita los datos del expediente. Solo cambia lo que viene y es distinto de lo
 * que hay: mandar lo mismo no es un cambio ni sube la versión. Con `version`
 * (la que tenía la pantalla al abrirlo), si otra persona lo cambió entretanto,
 * 409 EXPEDIENTE_CAMBIO en vez de pisar su cambio. Un empleado dado de baja no
 * se edita: primero se reactiva (así nadie corrige por error a quien ya no está).
 */
export async function actualizarEmpleado(negocioId, empleadoId, datos, { actorId = null, version } = {}) {
  const nid = exigirNegocio(negocioId);
  const eid = exigirEmpleadoId(empleadoId);
  const d = validarDatos(datos || {}, { parcial: true });
  const esperada = versionEsperada(version);
  return enTransaccion(async (client) => {
    const { rows: [actual] } = await client.query(
      `SELECT e.id, e.numero_empleado, e.nombre, e.puesto, e.telefono, e.estatus, e.version,
              e.sucursal_id, e.puede_checar_otras_sucursales, to_char(e.fecha_ingreso, 'YYYY-MM-DD') AS fecha_ingreso,
              e.nss, s.nombre AS sucursal_nombre
         FROM xecador_empleados e LEFT JOIN sucursales s ON s.id = e.sucursal_id
        WHERE e.id = $1 AND e.negocio_id = $2 FOR UPDATE OF e`, [eid, nid]);
    if (!actual) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
    if (actual.estatus !== 'activo') fallar('Ese empleado está dado de baja: reactívalo para editarlo', 'EMPLEADO_DE_BAJA', 409);
    if (esperada !== null && actual.version !== esperada) fallarExpedienteCambio();

    // Solo lo que cambia de verdad.
    for (const c of Object.keys(d)) if ((actual[c] ?? null) === (d[c] ?? null)) delete d[c];
    const sucursalNueva = d.sucursal_id ? await sucursalDelNegocio(client, nid, d.sucursal_id) : null;

    if (d.numero_empleado !== undefined) {
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
        `UPDATE xecador_empleados SET ${set}, version = version + 1
          WHERE id = $1 AND negocio_id = $2
          RETURNING ${COLUMNAS}`,
        [eid, nid, ...campos.map((c) => d[c])]);
      // La bitácora habla en palabras: la sucursal por su nombre y el NSS
      // enmascarado (la bitácora no se borra).
      const cambiado = {};
      for (const c of campos) {
        if (c === 'sucursal_id') cambiado.sucursal = { antes: actual.sucursal_nombre ?? null, despues: sucursalNueva };
        else if (c === 'nss') cambiado.nss = { antes: nssEnmascarado(actual.nss), despues: nssEnmascarado(d.nss) };
        else cambiado[CAMPO_PUBLICO[c]] = { antes: actual[c] ?? null, despues: d[c] ?? null };
      }
      await registrarEvento(client, nid, actual.id, 'edicion', { cambios: cambiado, actorId });
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
export async function darDeBajaEmpleado(negocioId, empleadoId, { fecha, tipo, motivo = null, actorId = null } = {}) {
  const nid = exigirNegocio(negocioId);
  const eid = exigirEmpleadoId(empleadoId);
  const m = textoOpcional(motivo ?? null, 200, 'Motivo', 'MOTIVO_INVALIDO') ?? null;
  const f = fechaOpcional(fecha, 'Fecha de baja', 'FECHA_BAJA_INVALIDA');
  return enTransaccion(async (client) => {
    const { rows: [actual] } = await client.query(
      `SELECT estatus, to_char(fecha_ingreso, 'YYYY-MM-DD') AS fecha_ingreso, to_char(${HOY_SQL}, 'YYYY-MM-DD') AS hoy
         FROM xecador_empleados WHERE id = $1 AND negocio_id = $2 FOR UPDATE`, [eid, nid]);
    if (!actual) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
    if (actual.estatus !== 'activo') fallar('Ese empleado ya está dado de baja', 'EMPLEADO_YA_DE_BAJA', 409);
    // El motivo de catálogo y la fecha efectiva (hoy si no la mandan).
    if (tipo === undefined || tipo === null || tipo === '') fallar('Elige el motivo de la baja', 'TIPO_BAJA_REQUERIDO');
    if (!TIPOS_BAJA.includes(tipo)) fallar('Ese motivo de baja no existe', 'TIPO_BAJA_INVALIDO');
    if (tipo === 'otro' && !m) fallar('Con «Otro», escribe el motivo de la baja', 'MOTIVO_REQUERIDO');
    const efectiva = f ?? actual.hoy;
    if (efectiva > actual.hoy) fallar('La fecha de baja no puede ser futura', 'FECHA_BAJA_INVALIDA');
    if (actual.fecha_ingreso && efectiva < actual.fecha_ingreso) {
      fallar('La fecha de baja no puede ser anterior a la fecha de ingreso', 'FECHA_BAJA_INVALIDA');
    }
    const { rows } = await client.query(
      `UPDATE xecador_empleados
          SET estatus = 'baja', baja_at = NOW(), baja_motivo = $3, baja_por = $4,
              baja_fecha = $5, baja_tipo = $6, version = version + 1
        WHERE id = $1 AND negocio_id = $2
        RETURNING ${COLUMNAS}`,
      [eid, nid, m, actorId, efectiva, tipo]);
    // La baja queda en la bitácora con su fecha, motivo y autor: reactivar no
    // la borra.
    await registrarEvento(client, nid, rows[0].id, 'baja', { motivo: m, cambios: { fecha: efectiva, tipo }, actorId });
    return rows[0];
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
          SET estatus = 'activo', baja_at = NULL, baja_motivo = NULL, baja_por = NULL,
              baja_fecha = NULL, baja_tipo = NULL, version = version + 1
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

/**
 * El directorio. Cada expediente trae además el nombre de su sucursal, un
 * resumen de su jornada (la vigente hoy o, si todavía no empieza, la próxima) y
 * `faltantes`: lo que le falta para estar completo. Faltar no impide checar
 * (decisión del dueño): la pantalla solo avisa «expediente incompleto».
 */
export async function listarEmpleados(negocioId, { incluirBajas = false } = {}) {
  const nid = exigirNegocio(negocioId);
  const { rows } = await pool.query(
    `SELECT ${COLUMNAS} FROM xecador_empleados
      WHERE negocio_id = $1 AND ($2::boolean OR estatus = 'activo')
      ORDER BY (estatus = 'baja'), lower(nombre), numero_empleado`,
    [nid, incluirBajas === true]);
  if (!rows.length) return rows;
  const [{ rows: sucursales }, { rows: jornadas }] = await Promise.all([
    pool.query(`SELECT id, nombre FROM sucursales WHERE negocio_id = $1`, [nid]),
    pool.query(
      `SELECT DISTINCT ON (j.empleado_id) j.empleado_id, j.tipo, to_char(j.vigente_desde, 'YYYY-MM-DD') AS vigente_desde,
              (SELECT COUNT(*)::int FROM xecador_jornada_dias d WHERE d.jornada_id = j.id) AS dias
         FROM xecador_jornadas j
        WHERE j.negocio_id = $1
        ORDER BY j.empleado_id, (j.vigente_desde <= ${HOY_SQL}) DESC,
                 CASE WHEN j.vigente_desde <= ${HOY_SQL} THEN j.vigente_desde END DESC NULLS LAST,
                 j.vigente_desde ASC, j.id DESC`, [nid]),
  ]);
  const nombreSucursal = new Map(sucursales.map((s) => [s.id, s.nombre]));
  const jornadaDe = new Map(jornadas.map((j) => [j.empleado_id, { tipo: j.tipo, vigente_desde: j.vigente_desde, dias: j.dias }]));
  return rows.map((e) => {
    const jornada = jornadaDe.get(e.id) || null;
    const faltantes = [];
    if (e.estatus === 'activo') {
      if (!e.fecha_ingreso) faltantes.push('fecha de ingreso');
      if (!e.sucursal_id) faltantes.push('sucursal');
      if (!jornada) faltantes.push('jornada');
      if (!e.tiene_pin) faltantes.push('PIN');
    }
    return { ...e, sucursal_nombre: nombreSucursal.get(e.sucursal_id) ?? null, jornada, faltantes };
  });
}

/** Las sucursales activas del negocio, para elegir la del empleado. */
export async function listarSucursales(negocioId) {
  const nid = exigirNegocio(negocioId);
  const { rows } = await pool.query(
    `SELECT id, nombre FROM sucursales WHERE negocio_id = $1 AND activo ORDER BY created_at, nombre`, [nid]);
  return rows;
}

// ── Jornada asignada (con vigencia) ────────────────────────────────────────
// Cambiar la jornada AGREGA una versión con su «vigente desde»; las anteriores
// se conservan (la tabla es de solo inserción), así que las horas de una
// semana pasada se calculan siempre contra la jornada que regía entonces.
// Días ISO: 1 = lunes … 7 = domingo. Un día que no está es de descanso.
// Salida antes que entrada = el turno cruza la medianoche.
const HORA_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validarJornada(datos) {
  const j = datos && typeof datos === 'object' ? datos : {};
  if (!TIPOS_JORNADA.includes(j.tipo)) fallar('Elige el tipo de jornada: diurna, nocturna o mixta', 'TIPO_JORNADA_INVALIDO');
  const vigente = fechaOpcional(j.vigente_desde, 'Vigente desde', 'VIGENCIA_INVALIDA');
  if (!vigente) fallar('Indica desde qué fecha rige la jornada', 'VIGENCIA_INVALIDA');
  if (!Array.isArray(j.dias) || !j.dias.length || j.dias.length > 7) {
    fallar('La jornada necesita al menos un día laboral', 'DIAS_INVALIDOS');
  }
  const vistos = new Set();
  const dias = j.dias.map((d) => {
    const dia = Number(d?.dia);
    if (!Number.isInteger(dia) || dia < 1 || dia > 7) fallar('Día de la semana no válido', 'DIAS_INVALIDOS');
    if (vistos.has(dia)) fallar('Un día aparece dos veces en la jornada', 'DIAS_INVALIDOS');
    vistos.add(dia);
    const entrada = typeof d.entrada === 'string' ? d.entrada.trim() : '';
    const salida = typeof d.salida === 'string' ? d.salida.trim() : '';
    if (!HORA_RE.test(entrada) || !HORA_RE.test(salida)) fallar('Las horas van en formato HH:MM (24 h)', 'HORARIO_INVALIDO');
    if (entrada === salida) fallar('La salida no puede ser a la misma hora que la entrada', 'HORARIO_INVALIDO');
    return { dia, entrada, salida };
  }).sort((a, b) => a.dia - b.dia);
  return { tipo: j.tipo, vigente_desde: vigente, dias };
}

/** La jornada como la guarda la bitácora: { vigente_desde, tipo, dias: { "1": "09:00-17:00", … } }. */
const resumenJornada = (j) => j && ({
  vigente_desde: j.vigente_desde, tipo: j.tipo,
  dias: Object.fromEntries(j.dias.map((d) => [String(d.dia), `${d.entrada}-${d.salida}`])),
});

async function versionesJornada(q, nid, eid, limite = 20) {
  const { rows } = await q.query(
    `SELECT j.id, j.tipo, to_char(j.vigente_desde, 'YYYY-MM-DD') AS vigente_desde, j.created_at, u.nombre AS autor,
            COALESCE(json_agg(json_build_object('dia', d.dia, 'entrada', to_char(d.entrada, 'HH24:MI'),
                                                'salida', to_char(d.salida, 'HH24:MI')) ORDER BY d.dia)
                     FILTER (WHERE d.dia IS NOT NULL), '[]') AS dias
       FROM xecador_jornadas j
       LEFT JOIN xecador_jornada_dias d ON d.jornada_id = j.id
       LEFT JOIN usuarios u ON u.id = j.creado_por
      WHERE j.negocio_id = $1 AND j.empleado_id = $2
      GROUP BY j.id, u.nombre
      ORDER BY j.vigente_desde DESC, j.id DESC
      LIMIT $3`, [nid, eid, limite]);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/**
 * Asigna (o cambia) la jornada: agrega una versión y su evento en la bitácora.
 * La primera puede regir desde antes (se captura la de quien ya trabajaba); un
 * CAMBIO rige de hoy en adelante, para no reescribir la jornada contra la que
 * ya se midieron días pasados.
 */
export async function asignarJornada(negocioId, empleadoId, datos, { actorId = null } = {}) {
  const nid = exigirNegocio(negocioId);
  const eid = exigirEmpleadoId(empleadoId);
  const j = validarJornada(datos);
  return enTransaccion(async (client) => {
    const { rows: [e] } = await client.query(
      `SELECT estatus, to_char(${HOY_SQL}, 'YYYY-MM-DD') AS hoy
         FROM xecador_empleados WHERE id = $1 AND negocio_id = $2 FOR UPDATE`, [eid, nid]);
    if (!e) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
    if (e.estatus !== 'activo') fallar('Ese empleado está dado de baja: reactívalo para cambiar su jornada', 'EMPLEADO_DE_BAJA', 409);
    const [anterior] = await versionesJornada(client, nid, eid, 1);
    if (anterior && j.vigente_desde < e.hoy) {
      fallar('Un cambio de jornada rige de hoy en adelante: elige hoy o una fecha posterior', 'VIGENCIA_INVALIDA');
    }
    const { rows: [nueva] } = await client.query(
      `INSERT INTO xecador_jornadas (negocio_id, empleado_id, vigente_desde, tipo, creado_por)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`, [nid, eid, j.vigente_desde, j.tipo, actorId]);
    await client.query(
      `INSERT INTO xecador_jornada_dias (jornada_id, dia, entrada, salida)
       SELECT $1, d.dia, d.entrada::time, d.salida::time
         FROM json_to_recordset($2::json) AS d(dia smallint, entrada text, salida text)`,
      [nueva.id, JSON.stringify(j.dias)]);
    await registrarEvento(client, nid, eid, 'jornada', {
      cambios: { antes: anterior ? resumenJornada(anterior) : null, despues: resumenJornada(j) }, actorId });
    const [guardada] = await versionesJornada(client, nid, eid, 1);
    return guardada;
  });
}

/** La jornada que rige hoy (o la próxima, si ninguna empezó) y las versiones. */
export async function obtenerJornadas(negocioId, empleadoId) {
  const nid = exigirNegocio(negocioId);
  const eid = exigirEmpleadoId(empleadoId);
  const { rows: [e] } = await pool.query(
    `SELECT to_char(${HOY_SQL}, 'YYYY-MM-DD') AS hoy FROM xecador_empleados WHERE id = $1 AND negocio_id = $2`, [eid, nid]);
  if (!e) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
  const versiones = await versionesJornada(pool, nid, eid);
  // Vienen de la más reciente a la más antigua (y, en el mismo día, la última
  // capturada primero): la vigente es la primera que ya empezó; si ninguna, la
  // próxima en empezar. El mismo criterio que el resumen de listarEmpleados.
  const futuras = versiones.filter((v) => v.vigente_desde > e.hoy);
  const proxima = futuras.find((v) => v.vigente_desde === futuras.at(-1)?.vigente_desde) || null;
  const vigente = versiones.find((v) => v.vigente_desde <= e.hoy) || proxima;
  return { vigente, versiones };
}

// ── PIN de checado ─────────────────────────────────────────────────────────
// Personal (decisión del dueño, 6-nov-2026): lo genera el sistema, se muestra
// UNA vez al administrador para entregárselo al empleado y solo se guarda su
// hash (scrypt con sal propia; lento a propósito). Restablecerlo deja un
// evento 'pin' en la bitácora, nunca el PIN. El bloqueo temporal por intentos
// fallidos vive en el checador (Parte B).
const PIN_SCRYPT = { N: 16384, r: 8, p: 1, largo: 32 };

/** Un PIN que cualquiera adivinaría: todos iguales o una escalera (1234, 9876…). */
export function pinTrivial(pin) {
  if (/^(\d)\1+$/.test(pin)) return true;
  const sube = '01234567890123456789', baja = '98765432109876543210';
  return sube.includes(pin) || baja.includes(pin);
}

export async function hashPin(pin) {
  const sal = randomBytes(16);
  const { N, r, p, largo } = PIN_SCRYPT;
  const h = await scrypt(String(pin), sal, largo, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${sal.toString('base64')}$${h.toString('base64')}`;
}

/** ¿Este PIN es el de ese hash? (Comparación en tiempo constante.) */
export async function verificarPin(hashGuardado, pin) {
  const partes = String(hashGuardado || '').split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt' || typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) return false;
  const [, N, r, p, sal, hash] = partes;
  const esperado = Buffer.from(hash, 'base64');
  const h = await scrypt(pin, Buffer.from(sal, 'base64'), esperado.length, { N: Number(N), r: Number(r), p: Number(p) });
  return h.length === esperado.length && timingSafeEqual(h, esperado);
}

/**
 * Asigna o restablece el PIN (de 4 a 6 dígitos, 6 si no se dice). Devuelve el
 * PIN en claro SOLO en esta respuesta, para que el administrador lo entregue.
 */
export async function asignarPin(negocioId, empleadoId, { longitud = 6, actorId = null } = {}) {
  const nid = exigirNegocio(negocioId);
  const eid = exigirEmpleadoId(empleadoId);
  const n = Number(longitud);
  if (!Number.isInteger(n) || n < 4 || n > 6) fallar('El PIN lleva de 4 a 6 dígitos', 'PIN_LONGITUD_INVALIDA');
  let pin;
  do { pin = Array.from({ length: n }, () => randomInt(0, 10)).join(''); } while (pinTrivial(pin));
  const hash = await hashPin(pin);   // lento: fuera de la transacción
  const empleado = await enTransaccion(async (client) => {
    const { rows: [e] } = await client.query(
      `SELECT estatus, (pin_hash IS NOT NULL) AS tenia FROM xecador_empleados WHERE id = $1 AND negocio_id = $2 FOR UPDATE`,
      [eid, nid]);
    if (!e) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO', 404);
    if (e.estatus !== 'activo') fallar('Ese empleado está dado de baja: reactívalo para darle PIN', 'EMPLEADO_DE_BAJA', 409);
    // Sin subir la versión: el PIN no es un dato del expediente que alguien
    // esté editando, y subirla haría chocar en falso a quien lo tiene abierto.
    // Un PIN nuevo también quita la pausa por intentos fallidos (Parte B1).
    const { rows } = await client.query(
      `UPDATE xecador_empleados SET pin_hash = $3, pin_actualizado_at = NOW(),
              pin_fallos = 0, pin_ultimo_fallo_at = NULL, pin_bloqueado_hasta = NULL
        WHERE id = $1 AND negocio_id = $2 RETURNING ${COLUMNAS}`, [eid, nid, hash]);
    await registrarEvento(client, nid, eid, 'pin', { cambios: { accion: e.tenia ? 'restablecido' : 'asignado', longitud: n }, actorId });
    return rows[0];
  });
  return { empleado, pin };
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
