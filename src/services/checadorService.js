// XECADOR · Checador — Parte B1 (migración 129).
//
// Lo que pasa en la tablet de la sucursal y lo que el administrador ve de ella:
//
//   · Tablets autorizadas. El administrador genera un código de un solo uso; la
//     tablet lo canjea por un token propio. De los dos solo se guarda el hash.
//     Cada tablet checa para UNA sucursal de su negocio; revocarla la deja fuera.
//   · Checadas de solo inserción (la base lo impone con triggers). La hora
//     oficial la pone el servidor; la del dispositivo se guarda aparte, solo como
//     referencia. Cada checada lleva una clave: un reintento no la duplica.
//   · El empleado se identifica solo con su PIN (decisión del dueño, 7-nov-2026;
//     migración 132): cada PIN es único en el negocio y está lejos de los
//     demás, así que un dedazo da «PIN incorrecto», nunca a otro empleado. Un
//     PIN equivocado no es de nadie: lo frena la tablet, que con demasiados
//     fallos en poco tiempo se pausa un minuto, con aviso al administrador.
//     Una tablet con la página anterior aún puede mandar número + PIN: ahí,
//     tras 5 fallos seguidos ese PIN queda en pausa 5 minutos, con aviso.
//   · Lo que le falte al expediente (fecha de ingreso, jornada…) NO impide
//     checar. Sin PIN sí: es como se identifica.
//   · Foto al checar: opcional por negocio. Si la cámara no está disponible la
//     checada se registra igual, marcada «sin foto»: nunca se deja a alguien sin
//     checar por la cámara.
//   · PIN + cara (migración 134, caraService.js): opcional por negocio. Si el
//     empleado tiene su cara registrada, la tablet manda fotos y el servidor
//     compara. La checada se registra siempre; si la cara no coincide o no se
//     pudo verificar, queda «para revisar».
//
// Aislamiento: el negocio sale SIEMPRE de la sesión del administrador o del
// token de la tablet, nunca del navegador.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { pool } from './database.js';
import { PersonalError, normalizarNumero, verificarPin } from './personalService.js';
import { TIPOS_CHECADA, TURNO_ABIERTO_HORAS, estadoTurno } from './turnoChecador.js';
import { ultimaEfectiva, correccionesDelDia } from './correccionesService.js';
import { LLAVE_PUBLICA, descifrarPin, firmarReferencia, leerReferencia } from './sinConexionCripto.js';
import { HUELLA, indicePin } from './pinIndice.js';
import { caraDisponible, leerImagen, motivoRevisionCara, pedirCaraAlChecar, verificarEnChecada } from './caraService.js';
import { isIP } from 'node:net';

export { TIPOS_CHECADA, TURNO_ABIERTO_HORAS, estadoTurno, LLAVE_PUBLICA, firmarReferencia };

const fallar = (mensaje, codigo, http, extra) => {
  const e = new PersonalError(mensaje, codigo, http);
  if (extra) e.extra = extra;
  throw e;
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (texto) => createHash('sha256').update(String(texto)).digest('hex');

export const PIN_INTENTOS = 5;          // fallos seguidos antes de la pausa
export const PIN_PAUSA_MIN = 5;         // minutos de pausa del PIN
const PIN_OLVIDO_MIN = 15;              // fallos más viejos que esto ya no cuentan
export const TABLET_FALLOS = 15;        // fallos de una tablet en la ventana
const TABLET_VENTANA_MS = 5 * 60 * 1000;
export const TABLET_PAUSA_MS = 60 * 1000;
const CODIGO_VIGENCIA_MIN = 30;
const TICKET_SEGUNDOS = 120;
const FOTO_MAX_BYTES = 150 * 1024;
const ZONA = 'America/Matamoros';
const HOY_SQL = `(NOW() AT TIME ZONE '${ZONA}')::date`;

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

// ── Avisos al administrador ────────────────────────────────────────────────
// Se guardan en la base (los ve el administrador en Empleados › Checador) y,
// además, se avisa por push al panel del negocio. El push es de mejor esfuerzo:
// nunca en el camino de la respuesta a la tablet ni con datos del empleado
// (las suscripciones del panel no distinguen administrador de cajero).
let notificador = null;
export function configurarNotificador(fn) { notificador = typeof fn === 'function' ? fn : null; }
function notificar(negocioId, cuerpo) {
  if (!notificador) return;
  setImmediate(() => {
    Promise.resolve()
      .then(() => notificador(negocioId, 'Checador', cuerpo))
      .catch((e) => console.error(`[Checador] no se pudo avisar por push: ${e.message}`));
  });
}

async function crearAviso(q, negocioId, tipo, { empleadoId = null, dispositivoId = null, detalle = {} } = {}) {
  const { rows: [a] } = await q.query(
    `INSERT INTO xecador_avisos (negocio_id, tipo, empleado_id, dispositivo_id, detalle)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
    [negocioId, tipo, empleadoId, dispositivoId, JSON.stringify(detalle)]);
  return Number(a.id);
}

export async function listarAvisos(negocioId, { pendientes = true } = {}) {
  const nid = exigirNegocio(negocioId);
  const { rows } = await pool.query(
    `SELECT a.id, a.tipo, a.detalle, a.created_at, a.atendido_at, u.nombre AS atendido_por,
            a.empleado_id, e.numero_empleado, e.nombre AS empleado, d.nombre AS dispositivo
       FROM xecador_avisos a
       LEFT JOIN xecador_empleados e ON e.id = a.empleado_id AND e.negocio_id = a.negocio_id
       LEFT JOIN xecador_dispositivos d ON d.id = a.dispositivo_id AND d.negocio_id = a.negocio_id
       LEFT JOIN usuarios u ON u.id = a.atendido_por
      WHERE a.negocio_id = $1 AND (NOT $2::boolean OR a.atendido_at IS NULL)
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT 100`, [nid, pendientes === true]);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export async function atenderAviso(negocioId, avisoId, { actorId = null } = {}) {
  const nid = exigirNegocio(negocioId);
  const id = Number(avisoId);
  if (!Number.isInteger(id) || id < 1) fallar('Aviso no encontrado', 'AVISO_NO_ENCONTRADO', 404);
  const { rows } = await pool.query(
    `UPDATE xecador_avisos SET atendido_at = COALESCE(atendido_at, NOW()), atendido_por = COALESCE(atendido_por, $3)
      WHERE id = $1 AND negocio_id = $2 RETURNING id, atendido_at`, [id, nid, actorId]);
  if (!rows.length) fallar('Aviso no encontrado', 'AVISO_NO_ENCONTRADO', 404);
  return { id, atendido_at: rows[0].atendido_at };
}

// ── Configuración ──────────────────────────────────────────────────────────
export async function obtenerConfig(negocioId, q = pool) {
  const nid = exigirNegocio(negocioId);
  const { rows: [c] } = await q.query(`SELECT foto_al_checar, cara_al_checar FROM xecador_config WHERE negocio_id = $1`, [nid]);
  return { foto_al_checar: c?.foto_al_checar === true, cara_al_checar: c?.cara_al_checar === 'confirmar' ? 'confirmar' : 'apagado' };
}

export const MODOS_CARA = ['apagado', 'confirmar'];

/**
 * Cambia lo que venga: foto_al_checar (sí/no) y cara_al_checar ('apagado' o
 * 'confirmar'). Encender la cara pide que este servidor tenga con qué
 * compararla (motor y llave); apagarla se puede siempre.
 */
export async function guardarConfig(negocioId, datos, { actorId = null } = {}) {
  const nid = exigirNegocio(negocioId);
  const b = datos && typeof datos === 'object' ? datos : {};
  const foto = b.foto_al_checar;
  const cara = b.cara_al_checar;
  if (foto === undefined && cara === undefined) fallar('«Pedir foto al checar» debe ser sí o no', 'CONFIG_INVALIDA');
  if (foto !== undefined && typeof foto !== 'boolean') fallar('«Pedir foto al checar» debe ser sí o no', 'CONFIG_INVALIDA');
  if (cara !== undefined && !MODOS_CARA.includes(cara)) fallar('«Cara al checar» debe ser «apagado» o «confirmar»', 'CONFIG_INVALIDA');
  if (cara === 'confirmar' && !caraDisponible().disponible) {
    fallar('El reconocimiento de cara no está disponible en este servidor: no se puede encender.', 'CARA_NO_DISPONIBLE', 409);
  }
  await pool.query(
    `INSERT INTO xecador_config (negocio_id, foto_al_checar, cara_al_checar, updated_at, updated_por)
     VALUES ($1, COALESCE($2::boolean, false), COALESCE($3::text, 'apagado'), NOW(), $4)
     ON CONFLICT (negocio_id) DO UPDATE SET foto_al_checar = COALESCE($2::boolean, xecador_config.foto_al_checar),
            cara_al_checar = COALESCE($3::text, xecador_config.cara_al_checar), updated_at = NOW(), updated_por = EXCLUDED.updated_por`,
    [nid, foto ?? null, cara ?? null, actorId]);
  return obtenerConfig(nid);
}

// ── Tablets autorizadas ────────────────────────────────────────────────────
// Código para escribir a mano: sin 0/O ni 1/I/L, en dos grupos de cuatro.
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function nuevoCodigo() {
  let c = '';
  for (let i = 0; i < 8; i++) c += ALFABETO[randomInt(0, ALFABETO.length)];
  return c;
}
const codigoVisible = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
function normalizarCodigo(valor) {
  const c = String(valor ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 8 || [...c].some((x) => !ALFABETO.includes(x))) {
    fallar('Ese código no es válido: son 8 letras y números, como ABCD-2345', 'CODIGO_INVALIDO');
  }
  return c;
}

const estadoDispositivo = (d) => (d.revocado_at ? 'revocada'
  : d.vinculado_at ? 'activa'
    : (d.codigo_expira_at && new Date(d.codigo_expira_at) > new Date()) ? 'pendiente' : 'codigo_vencido');

const publicoDispositivo = (d) => ({
  id: d.id, nombre: d.nombre, sucursal_id: d.sucursal_id, sucursal: d.sucursal ?? null,
  created_at: d.created_at, vinculado_at: d.vinculado_at, ultimo_uso_at: d.ultimo_uso_at,
  revocado_at: d.revocado_at, codigo_expira_at: d.vinculado_at || d.revocado_at ? null : d.codigo_expira_at,
  estado: estadoDispositivo(d),
});

export async function listarDispositivos(negocioId) {
  const nid = exigirNegocio(negocioId);
  const { rows } = await pool.query(
    `SELECT d.id, d.nombre, d.sucursal_id, s.nombre AS sucursal, d.created_at, d.vinculado_at, d.ultimo_uso_at,
            d.revocado_at, d.codigo_expira_at
       FROM xecador_dispositivos d JOIN sucursales s ON s.id = d.sucursal_id AND s.negocio_id = d.negocio_id
      WHERE d.negocio_id = $1
      ORDER BY (d.revocado_at IS NOT NULL), d.created_at DESC`, [nid]);
  return rows.map(publicoDispositivo);
}

/** Autoriza una tablet nueva: devuelve el código de un solo uso, UNA vez. */
export async function crearDispositivo(negocioId, datos, { actorId = null } = {}) {
  const nid = exigirNegocio(negocioId);
  const d = datos && typeof datos === 'object' ? datos : {};
  if (typeof d.nombre !== 'string' || !d.nombre.trim()) fallar('Ponle un nombre a la tablet (por ejemplo, «Caja»)', 'NOMBRE_REQUERIDO');
  const nombre = d.nombre.trim();
  if (nombre.length > 60) fallar('Nombre: máximo 60 caracteres', 'NOMBRE_INVALIDO');
  if (typeof d.sucursal_id !== 'string' || !UUID_RE.test(d.sucursal_id)) fallar('Elige la sucursal de la tablet', 'SUCURSAL_INVALIDA');
  const { rows: [s] } = await pool.query(
    `SELECT id, nombre FROM sucursales WHERE id = $1 AND negocio_id = $2 AND activo`, [d.sucursal_id.toLowerCase(), nid]);
  if (!s) fallar('Esa sucursal no es de este negocio o no está activa', 'SUCURSAL_INVALIDA');
  const codigo = nuevoCodigo();
  const { rows: [fila] } = await pool.query(
    `INSERT INTO xecador_dispositivos (negocio_id, sucursal_id, nombre, codigo_hash, codigo_expira_at, creado_por)
     VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5), $6)
     RETURNING id, nombre, sucursal_id, created_at, vinculado_at, ultimo_uso_at, revocado_at, codigo_expira_at`,
    [nid, s.id, nombre, sha256(codigo), CODIGO_VIGENCIA_MIN, actorId]);
  return { dispositivo: publicoDispositivo({ ...fila, sucursal: s.nombre }), codigo: codigoVisible(codigo), expira_at: fila.codigo_expira_at };
}

export async function revocarDispositivo(negocioId, dispositivoId, { actorId = null } = {}) {
  const nid = exigirNegocio(negocioId);
  if (typeof dispositivoId !== 'string' || !UUID_RE.test(dispositivoId)) fallar('Tablet no encontrada', 'DISPOSITIVO_NO_ENCONTRADO', 404);
  // Sin token ni código: aunque alguien tuviera una copia, ya no abre nada.
  const { rows } = await pool.query(
    `UPDATE xecador_dispositivos
        SET revocado_at = COALESCE(revocado_at, NOW()), revocado_por = COALESCE(revocado_por, $3),
            token_hash = NULL, codigo_hash = NULL, codigo_expira_at = NULL
      WHERE id = $1 AND negocio_id = $2
      RETURNING id, nombre, sucursal_id, created_at, vinculado_at, ultimo_uso_at, revocado_at, codigo_expira_at`,
    [dispositivoId.toLowerCase(), nid, actorId]);
  if (!rows.length) fallar('Tablet no encontrada', 'DISPOSITIVO_NO_ENCONTRADO', 404);
  return publicoDispositivo(rows[0]);
}

/** La tablet canjea el código por su token (que solo ella conoce). */
export async function vincularDispositivo(codigoEscrito) {
  const codigo = normalizarCodigo(codigoEscrito);
  return enTransaccion(async (client) => {
    const { rows: [d] } = await client.query(
      `SELECT d.id, d.negocio_id, d.nombre, s.nombre AS sucursal, n.nombre AS negocio
         FROM xecador_dispositivos d
         JOIN sucursales s ON s.id = d.sucursal_id AND s.negocio_id = d.negocio_id
         JOIN negocios n ON n.id = d.negocio_id
        WHERE d.codigo_hash = $1 AND d.codigo_expira_at > NOW() AND d.revocado_at IS NULL AND d.vinculado_at IS NULL
        FOR UPDATE OF d`, [sha256(codigo)]);
    if (!d) fallar('Ese código no existe, ya se usó o venció. Pide uno nuevo al administrador.', 'CODIGO_INVALIDO');
    const token = randomBytes(32).toString('base64url');
    await client.query(
      `UPDATE xecador_dispositivos SET token_hash = $2, vinculado_at = NOW(), ultimo_uso_at = NOW(),
              codigo_hash = NULL, codigo_expira_at = NULL
        WHERE id = $1`, [d.id, sha256(token)]);
    return { token, dispositivo: { nombre: d.nombre, sucursal: d.sucursal, negocio: d.negocio } };
  });
}

/**
 * La tablet de este token, o null. Solo tablets vinculadas y no revocadas. La
 * sucursal inactiva se informa aparte (la tablet no pierde su token por eso).
 */
export async function autenticarDispositivo(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const { rows: [d] } = await pool.query(
    `SELECT d.id, d.negocio_id, d.sucursal_id, d.nombre, d.ultimo_uso_at, s.nombre AS sucursal, s.activo AS sucursal_activa,
            n.nombre AS negocio
       FROM xecador_dispositivos d
       JOIN sucursales s ON s.id = d.sucursal_id AND s.negocio_id = d.negocio_id
       JOIN negocios n ON n.id = d.negocio_id
      WHERE d.token_hash = $1 AND d.revocado_at IS NULL AND d.vinculado_at IS NOT NULL`, [sha256(token)]);
  if (!d) return null;
  if (!d.ultimo_uso_at || Date.now() - new Date(d.ultimo_uso_at).getTime() > 5 * 60 * 1000) {
    pool.query(`UPDATE xecador_dispositivos SET ultimo_uso_at = NOW() WHERE id = $1`, [d.id]).catch(() => {});
  }
  return d;
}

// ── Pausa de la tablet por muchos fallos ───────────────────────────────────
// En memoria del proceso (hay una sola instancia). Si el servidor reinicia, la
// cuenta empieza de cero: es un freno, no la garantía; la garantía es la pausa
// del PIN de cada empleado, que vive en la base.
const fallosTablet = new Map();   // dispositivoId → [ms]
const pausaTablet = new Map();    // dispositivoId → ms hasta
function tabletEnPausa(d) {
  const hasta = pausaTablet.get(d.id) || 0;
  if (hasta > Date.now()) return Math.ceil((hasta - Date.now()) / 1000);
  if (hasta) pausaTablet.delete(d.id);
  return 0;
}
function registrarFalloTablet(d) {
  const ahora = Date.now();
  const lista = (fallosTablet.get(d.id) || []).filter((t) => ahora - t < TABLET_VENTANA_MS);
  lista.push(ahora);
  if (lista.length < TABLET_FALLOS) { fallosTablet.set(d.id, lista); return; }
  fallosTablet.delete(d.id);
  pausaTablet.set(d.id, ahora + TABLET_PAUSA_MS);
  crearAviso(pool, d.negocio_id, 'dispositivo_pausado', {
    dispositivoId: d.id, detalle: { dispositivo: d.nombre, fallos: lista.length, segundos: TABLET_PAUSA_MS / 1000 } })
    .then(() => notificar(d.negocio_id, `La tablet «${d.nombre}» se pausó un minuto por muchos intentos fallidos de PIN.`))
    .catch((e) => console.error(`[Checador] aviso de tablet en pausa: ${e.message}`));
}

// ── Qué le toca registrar a un empleado ────────────────────────────────────
// La regla vive en turnoChecador.js. La última checada es la que CUENTA
// después de las correcciones (Parte B2): si el administrador anuló una
// salida equivocada, el empleado sigue en turno; si agregó la salida que
// faltó, ya no tiene un turno sin cerrar.
const ultimaChecada = (q, nid, eid) => ultimaEfectiva(q, nid, eid);

// ── El pase de 2 minutos entre «identificar» y «checar» ────────────────────
// Firmado por el servidor y atado a la tablet y al empleado: el PIN se
// escribe una vez y no vuelve a viajar al confirmar.
const SECRETO = process.env.SESSION_SECRET || 'xabor-session-secret-temporal';
const firmar = (datos) => createHmac('sha256', SECRETO).update(`xecador-pase|${datos}`).digest('base64url');
function emitirPase(d, empleadoId) {
  const datos = Buffer.from(JSON.stringify({ d: d.id, n: d.negocio_id, e: empleadoId, x: Date.now() + TICKET_SEGUNDOS * 1000 })).toString('base64url');
  return `${datos}.${firmar(datos)}`;
}
/** El pase si lo firmó el servidor para ESTA tablet (vencido o no), o null. */
function abrirPase(d, pase) {
  const [datos, firma] = String(pase || '').split('.');
  const esperada = datos ? firmar(datos) : '';
  const ok = datos && firma && firma.length === esperada.length && timingSafeEqual(Buffer.from(firma), Buffer.from(esperada));
  let p = null;
  if (ok) { try { p = JSON.parse(Buffer.from(datos, 'base64url').toString('utf8')); } catch { p = null; } }
  return p && p.d === d.id && p.n === d.negocio_id && UUID_RE.test(p.e || '') && Number.isFinite(p.x) ? p : null;
}
/**
 * El pase de una checada sin conexión. Firmado para esta tablet → verificado.
 * Si la firma no cuadra (el secreto del servidor cambió, o la tablet se volvió
 * a vincular y es otro dispositivo) pero dice un empleado de este negocio, la
 * checada NO se descarta: llega como «PIN no válido», igual que un PIN que no
 * es (decisión del dueño, 6-nov-2026). Ilegible o de otro negocio → null.
 */
function paseSinConexion(d, pase) {
  const firmado = abrirPase(d, pase);
  if (firmado) return { ...firmado, verificado: true };
  let p = null;
  try { p = JSON.parse(Buffer.from(String(pase || '').split('.')[0], 'base64url').toString('utf8')); } catch { p = null; }
  return p && typeof p === 'object' && p.n === d.negocio_id && UUID_RE.test(p.e || '') ? { e: p.e, verificado: false } : null;
}
function leerPase(d, pase) {
  const p = abrirPase(d, pase);
  if (!p || !(p.x > Date.now())) {
    fallar('Se acabó el tiempo para confirmar. Vuelve a escribir tu PIN.', 'PASE_INVALIDO', 401);
  }
  return p.e;
}

// Un hash de verdad para comparar cuando el número no existe: así tarda lo
// mismo que con un número real y no se puede adivinar quién trabaja aquí.
const HASH_FALSO = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const NUMERO_O_PIN = 'Número o PIN incorrecto.';
const PIN_INCORRECTO = 'PIN incorrecto.';

function puedeChecarAqui(e, d) {
  return !e.sucursal_id || e.sucursal_id === d.sucursal_id || e.puede_checar_otras_sucursales === true;
}

// ¿La tablet mandó número? Las de la página anterior (en caché) y las checadas
// que ya estaban en su cola lo traen; la tablet de hoy manda solo el PIN.
const traeNumero = (b) => b.numero !== undefined && b.numero !== null && b.numero !== '';

/**
 * Checar solo con el PIN (migración 132): de quién es este PIN en el negocio.
 * Primero por su índice. Si no, entre los PIN «anteriores» (generados antes
 * de la 132, o con otra llave del servidor), comparando con su hash; al
 * encontrar el suyo le pone su índice, así que la búsqueda lenta se hace una
 * sola vez por empleado. Devuelve { id, pin_hash }, 'repetido' si el PIN es de
 * dos empleados (solo puede pasar con PIN anteriores), o null.
 */
async function empleadoPorPin(nid, pin) {
  const indice = indicePin(nid, pin);
  const { rows: [e] } = await pool.query(
    `SELECT id, pin_hash FROM xecador_empleados WHERE negocio_id = $1 AND pin_indice = $2`, [nid, indice]);
  if (e) return e;
  const { rows: anteriores } = await pool.query(
    `SELECT id, pin_hash FROM xecador_empleados
      WHERE negocio_id = $1 AND estatus = 'activo' AND pin_hash IS NOT NULL
        AND (pin_indice IS NULL OR left(pin_indice, 9) <> $2)
      ORDER BY id`, [nid, `${HUELLA}.`]);
  const suyos = [];
  for (let i = 0; i < anteriores.length; i += 4) {
    const lote = anteriores.slice(i, i + 4);
    const ok = await Promise.all(lote.map((a) => verificarPin(a.pin_hash, pin)));
    lote.forEach((a, j) => { if (ok[j]) suyos.push(a); });
  }
  if (suyos.length > 1) return 'repetido';
  if (!suyos.length) return null;
  const [a] = suyos;
  try {
    await pool.query(
      `UPDATE xecador_empleados SET pin_indice = $3 WHERE id = $1 AND negocio_id = $2 AND pin_hash = $4`,
      [a.id, nid, indice, a.pin_hash]);
  } catch (err) {
    // Otro empleado acaba de quedarse con el mismo PIN: es de los dos.
    if (err?.code === '23505' && err.constraint === 'xecador_empleados_pin_indice_unico') return 'repetido';
    throw err;
  }
  return a;
}

// Lo que sigue a un PIN correcto, venga con número o solo: limpia los fallos,
// revisa la sucursal y lee qué le toca registrar.
async function pinCorrecto(client, d, e) {
  if (e.pin_fallos || e.pin_ultimo_fallo_at || e.pin_bloqueado_hasta) {
    await client.query(`UPDATE xecador_empleados SET pin_fallos = 0, pin_ultimo_fallo_at = NULL, pin_bloqueado_hasta = NULL WHERE id = $1`, [e.id]);
  }
  if (!puedeChecarAqui(e, d)) return { error: 'otra_sucursal', sucursal: e.sucursal };
  const { ahora, ultima } = await ultimaChecada(client, d.negocio_id, e.id);
  return { e, ahora, ultima };
}

/**
 * Paso 1 en la tablet: el PIN (o número + PIN, de una tablet con la página
 * anterior). Devuelve quién es, qué puede registrar y un pase para confirmar.
 * Con número, cuenta los fallos de ese PIN y lo pausa si toca. Solo con el
 * PIN, un PIN equivocado no es de nadie: lo frena la pausa de la tablet.
 */
export async function identificar(d, datos) {
  const espera = tabletEnPausa(d);
  if (espera) fallar(`Demasiados intentos en esta tablet. Espera ${espera} segundos.`, 'TABLET_EN_PAUSA', 429, { segundos: espera });
  const b = datos && typeof datos === 'object' ? datos : {};
  const conNumero = traeNumero(b);
  const pin = typeof b.pin === 'string' ? b.pin : '';
  if (!/^\d{4,6}$/.test(pin)) fallar('El PIN lleva de 4 a 6 dígitos', 'PIN_INVALIDO');

  let aviso = null;
  const r = conNumero ? await identificarConNumero(d, normalizarNumero(b.numero), pin, (texto) => { aviso = texto; })
    : await identificarSoloPin(d, pin);
  if (aviso) notificar(d.negocio_id, aviso);
  if (r.error === 'credenciales') { registrarFalloTablet(d); fallar(conNumero ? NUMERO_O_PIN : PIN_INCORRECTO, 'CREDENCIALES', 401); }
  if (r.error === 'repetido') {
    fallar('Tu PIN coincide con el de otra persona. Pide al administrador que te genere uno nuevo.', 'PIN_REPETIDO', 409);
  }
  if (r.error === 'bloqueado') {
    if (aviso) registrarFalloTablet(d);
    fallar(`Por seguridad, tu PIN está en pausa ${r.minutos} minuto${r.minutos === 1 ? '' : 's'} por varios intentos fallidos. Vuelve a intentarlo después.`,
      'PIN_EN_PAUSA', 423, { minutos: r.minutos });
  }
  if (r.error === 'sin_pin') fallar('Todavía no tienes PIN. Pídeselo al administrador.', 'SIN_PIN', 409);
  if (r.error === 'otra_sucursal') {
    fallar(`Tu sucursal es «${r.sucursal}»: en esta no puedes checar. Pide al administrador que te autorice.`, 'OTRA_SUCURSAL', 403);
  }
  const { posibles, sugerida } = estadoTurno(r.ultima, r.ahora);
  const config = await obtenerConfig(d.negocio_id);
  // cara: la tablet toma las fotos para compararlas (el negocio lo pide y
  // este empleado tiene su cara registrada).
  return {
    empleado: { nombre: r.e.nombre, numero: r.e.numero_empleado },
    posibles, sugerida, ultima: r.ultima, foto_al_checar: config.foto_al_checar,
    cara: await pedirCaraAlChecar(d.negocio_id, r.e.id, config),
    pase: emitirPase(d, r.e.id), pase_segundos: TICKET_SEGUNDOS, ref: firmarReferencia(d.id),
  };
}

const COLUMNAS_IDENTIFICAR = `e.id, e.numero_empleado, e.nombre, e.estatus, e.pin_hash, e.sucursal_id, e.puede_checar_otras_sucursales,
              e.pin_fallos, e.pin_ultimo_fallo_at, e.pin_bloqueado_hasta, s.nombre AS sucursal,
              (e.pin_bloqueado_hasta > NOW()) AS bloqueado,
              CEIL(EXTRACT(EPOCH FROM (e.pin_bloqueado_hasta - NOW())) / 60)::int AS minutos`;

/** Solo con el PIN: el PIN dice de quién es. Los fallos no se cuentan por empleado. */
async function identificarSoloPin(d, pin) {
  const quien = await empleadoPorPin(d.negocio_id, pin);   // lento con PIN anteriores: fuera de la transacción
  if (quien === 'repetido') return { error: 'repetido' };
  if (!quien) return { error: 'credenciales' };
  return enTransaccion(async (client) => {
    // Con el mismo hash: si el administrador le cambió el PIN en este instante, ya no es.
    const { rows: [e] } = await client.query(
      `SELECT ${COLUMNAS_IDENTIFICAR}
         FROM xecador_empleados e LEFT JOIN sucursales s ON s.id = e.sucursal_id
        WHERE e.id = $1 AND e.negocio_id = $2 AND e.pin_hash = $3
        FOR UPDATE OF e`, [quien.id, d.negocio_id, quien.pin_hash]);
    if (!e || e.estatus !== 'activo') return { error: 'credenciales' };
    if (e.bloqueado) return { error: 'bloqueado', minutos: Math.max(1, e.minutos) };
    return pinCorrecto(client, d, e);
  });
}

/** Número + PIN (tablets con la página anterior): igual que antes de la 132. */
async function identificarConNumero(d, numero, pin, avisar) {
  return enTransaccion(async (client) => {
    const { rows: [e] } = await client.query(
      `SELECT e.id, e.numero_empleado, e.nombre, e.pin_hash, e.sucursal_id, e.puede_checar_otras_sucursales,
              e.pin_fallos, e.pin_ultimo_fallo_at, e.pin_bloqueado_hasta, s.nombre AS sucursal,
              (e.pin_bloqueado_hasta > NOW()) AS bloqueado,
              CEIL(EXTRACT(EPOCH FROM (e.pin_bloqueado_hasta - NOW())) / 60)::int AS minutos,
              (e.pin_ultimo_fallo_at IS NULL OR e.pin_ultimo_fallo_at < NOW() - make_interval(mins => $3)) AS fallos_viejos
         FROM xecador_empleados e LEFT JOIN sucursales s ON s.id = e.sucursal_id
        WHERE e.negocio_id = $1 AND e.numero_empleado = $2 AND e.estatus = 'activo'
        FOR UPDATE OF e`, [d.negocio_id, numero, PIN_OLVIDO_MIN]);
    if (!e) { await verificarPin(HASH_FALSO, pin); return { error: 'credenciales' }; }
    if (!e.pin_hash) return { error: 'sin_pin' };
    if (e.bloqueado) return { error: 'bloqueado', minutos: Math.max(1, e.minutos) };
    if (!(await verificarPin(e.pin_hash, pin))) {
      const fallos = (e.fallos_viejos ? 0 : e.pin_fallos) + 1;
      if (fallos >= PIN_INTENTOS) {
        await client.query(
          `UPDATE xecador_empleados SET pin_fallos = 0, pin_ultimo_fallo_at = NOW(),
                  pin_bloqueado_hasta = NOW() + make_interval(mins => $2) WHERE id = $1`, [e.id, PIN_PAUSA_MIN]);
        await crearAviso(client, d.negocio_id, 'pin_bloqueado', {
          empleadoId: e.id, dispositivoId: d.id,
          detalle: { numero: e.numero_empleado, empleado: e.nombre, dispositivo: d.nombre, intentos: fallos, minutos: PIN_PAUSA_MIN } });
        avisar('El PIN de un empleado quedó en pausa 5 minutos por intentos fallidos. Revisa Empleados › Checador.');
        return { error: 'bloqueado', minutos: PIN_PAUSA_MIN };
      }
      await client.query(`UPDATE xecador_empleados SET pin_fallos = $2, pin_ultimo_fallo_at = NOW() WHERE id = $1`, [e.id, fallos]);
      return { error: 'credenciales' };
    }
    return pinCorrecto(client, d, e);
  });
}

/** La foto que manda la tablet: JPEG o WebP de verdad y de tamaño razonable; si no, ninguna. */
const leerFoto = (foto) => leerImagen(foto, FOTO_MAX_BYTES);

/**
 * Lo que la cara le pone a una checada. La foto que se guarda: la que pidió
 * el negocio o, si no, la de frente de la cara (para revisar a mano). Con la
 * cara encendida, que falte la foto no la marca además «sin foto»: ya la
 * marca la cara.
 */
function conCara(config, foto, cara) {
  const fotoChecada = foto || cara.foto;
  const estadoFoto = config.foto_al_checar ? (fotoChecada ? 'tomada' : 'no_disponible')
    : (cara.foto && motivoRevisionCara(cara.cara) ? 'tomada' : 'no_requerida');
  return { estadoFoto, fotoChecada: estadoFoto === 'tomada' ? fotoChecada : null, motivo: motivoRevisionCara(cara.cara) };
}

async function avisoCara(client, nid, d, e, tipo, horaIso, cara) {
  await crearAviso(client, nid, 'cara_no_coincide', {
    empleadoId: e.id, dispositivoId: d.id,
    detalle: { numero: e.numero_empleado, empleado: e.nombre, dispositivo: d.nombre, tipo, hora: horaIso, similitud: cara.similitud } });
}

/** La hora del dispositivo, solo como referencia: si no se entiende, no se guarda. */
function leerHoraDispositivo(valor) {
  if (typeof valor !== 'string' || valor.length > 40) return null;
  const f = new Date(valor);
  const y = f.getUTCFullYear();
  return Number.isNaN(f.getTime()) || y < 2020 || y > 2100 ? null : f.toISOString();
}

// cara: cómo salió la cara ('no_requerida' si el negocio no la pide).
const publicaChecada = (c) => ({ id: Number(c.id), tipo: c.tipo, hora_oficial: c.hora_oficial, foto: c.foto, cara: c.cara ?? 'no_requerida' });

// ── IP de cada checada (Parte B3) ──────────────────────────────────────────
// Se guarda desde dónde llegó cada checada. La «IP habitual» de una sucursal
// se aprende sola: la más frecuente de sus checadas de los últimos 14 días,
// cuando ya hay al menos 5. Una checada desde otra IP se marca para revisar;
// NO se bloquea (las IP de los proveedores de internet cambian).
export const IP_MUESTRAS_MIN = 5;
export function normalizarIp(ip) {
  if (typeof ip !== 'string') return null;
  const limpia = ip.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  return isIP(limpia) ? limpia : null;
}
async function ipDistinta(q, nid, sucursalId, ip) {
  if (!ip) return false;
  const { rows: [h] } = await q.query(
    `WITH h AS (SELECT ip, COUNT(*)::int AS n FROM xecador_checadas
                WHERE negocio_id = $1 AND sucursal_id = $2 AND ip IS NOT NULL AND hora_oficial > NOW() - interval '14 days'
                GROUP BY ip ORDER BY COUNT(*) DESC, MAX(hora_oficial) DESC LIMIT 1)
     SELECT (n >= $4 AND ip <> $3::inet) AS distinta FROM h`, [nid, sucursalId, ip, IP_MUESTRAS_MIN]);
  return h?.distinta === true;
}

/**
 * Paso 2 en la tablet: registra la checada. La hora oficial es la del
 * servidor. La misma clave devuelve la misma checada (repetida: true).
 */
export async function checar(d, datos, { ip = null } = {}) {
  const b = datos && typeof datos === 'object' ? datos : {};
  const ipLimpia = normalizarIp(ip);
  const empleadoId = leerPase(d, b.pase);
  if (!TIPOS_CHECADA.includes(b.tipo)) fallar('Esa acción no existe', 'TIPO_INVALIDO');
  if (typeof b.clave !== 'string' || !UUID_RE.test(b.clave)) fallar('Falta la clave de la checada: recarga la pantalla', 'CLAVE_INVALIDA');
  const clave = b.clave.toLowerCase();
  const horaDispositivo = leerHoraDispositivo(b.hora_dispositivo);
  const foto = leerFoto(b.foto);
  const nid = d.negocio_id;

  const previa = async (q) => {
    const { rows: [c] } = await q.query(
      `SELECT id, tipo, hora_oficial, foto, cara, empleado_id FROM xecador_checadas WHERE negocio_id = $1 AND clave = $2`, [nid, clave]);
    if (!c) return null;
    if (c.empleado_id !== empleadoId) fallar('Esa clave ya se usó para otra checada: recarga la pantalla', 'CLAVE_USADA', 409);
    return c;
  };

  // La cara se compara antes de la transacción (el motor tarda). Un reintento
  // de una checada que ya quedó no la vuelve a mirar.
  const yaEstaba = await previa(pool);
  if (yaEstaba) return { checada: publicaChecada(yaEstaba), empleado: null, repetida: true, ref: firmarReferencia(d.id) };
  const config = await obtenerConfig(nid);
  const cara = await verificarEnChecada(nid, empleadoId, b.cara, config);

  let avisoSinCerrar = false, avisoCaraNoCoincide = false;
  try {
    const r = await enTransaccion(async (client) => {
      const ya = await previa(client);
      if (ya) return { checada: ya, repetida: true };
      const { rows: [e] } = await client.query(
        `SELECT id, numero_empleado, nombre, estatus, sucursal_id, puede_checar_otras_sucursales
           FROM xecador_empleados WHERE id = $1 AND negocio_id = $2 FOR UPDATE`, [empleadoId, nid]);
      if (!e || e.estatus !== 'activo') fallar('Este empleado ya no está activo.', 'EMPLEADO_DE_BAJA', 409);
      if (!puedeChecarAqui(e, d)) fallar('En esta sucursal no puedes checar. Pide al administrador que te autorice.', 'OTRA_SUCURSAL', 403);
      const { ahora, ultima } = await ultimaChecada(client, nid, e.id);
      const turno = estadoTurno(ultima, ahora);
      if (!turno.posibles.includes(b.tipo)) {
        fallar('Esa acción ya no corresponde: vuelve a escribir tu PIN.', 'ACCION_NO_VALIDA', 409, { posibles: turno.posibles });
      }
      const { estadoFoto, fotoChecada, motivo } = conCara(config, foto, cara);
      const revision = (await ipDistinta(client, nid, d.sucursal_id, ipLimpia)) ? ['ip_distinta'] : [];
      if (motivo) revision.push(motivo);
      const { rows: [c] } = await client.query(
        `INSERT INTO xecador_checadas (negocio_id, empleado_id, sucursal_id, dispositivo_id, tipo, hora_dispositivo, clave, foto, ip, revision,
                                       cara, cara_detalle, cara_similitud)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::inet, $10::text[], $11, $12, $13) RETURNING id, tipo, hora_oficial, foto, cara`,
        [nid, e.id, d.sucursal_id, d.id, b.tipo, horaDispositivo, clave, estadoFoto, ipLimpia, revision,
          cara.cara, cara.detalle, cara.similitud]);
      if (estadoFoto === 'tomada') {
        await client.query(`INSERT INTO xecador_checada_fotos (checada_id, negocio_id, mime, datos) VALUES ($1, $2, $3, $4)`,
          [c.id, nid, fotoChecada.mime, fotoChecada.bytes]);
      }
      if (cara.cara === 'no_coincide') {
        await avisoCara(client, nid, d, e, b.tipo, new Date(c.hora_oficial).toISOString(), cara);
        avisoCaraNoCoincide = true;
      }
      if (turno.turnoSinCerrar && b.tipo === 'entrada') {
        await crearAviso(client, nid, 'turno_sin_cerrar', {
          empleadoId: e.id, dispositivoId: d.id,
          detalle: { numero: e.numero_empleado, empleado: e.nombre, ultima: ultima?.tipo ?? null, ultima_hora: ultima?.hora_oficial ?? null } });
        avisoSinCerrar = true;
      }
      return { checada: c, empleado: { nombre: e.nombre, numero: e.numero_empleado }, repetida: false };
    });
    if (avisoSinCerrar) notificar(nid, 'Un empleado registró su entrada con un turno anterior sin salida. Revisa Empleados › Checador.');
    if (avisoCaraNoCoincide) notificar(nid, 'Una checada con PIN correcto no coincidió con la cara registrada. Revisa Empleados › Checador.');
    return { checada: publicaChecada(r.checada), empleado: r.empleado ?? null, repetida: r.repetida, ref: firmarReferencia(d.id) };
  } catch (e) {
    // Dos envíos a la vez con la misma clave: el segundo choca con la llave
    // única y contesta con la checada que quedó.
    if (e?.code === '23505' && e.constraint === 'xecador_checadas_clave_unica') {
      const ya = await previa(pool);
      if (ya) return { checada: publicaChecada(ya), empleado: null, repetida: true };
    }
    throw e;
  }
}

// ── Lo que ve el administrador ─────────────────────────────────────────────
/** 'AAAA-MM-DD' de un día que existe (un 30 de febrero no llega a la base). */
function diaValido(fecha) {
  if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
  const [a, m, d] = fecha.split('-').map(Number);
  const f = new Date(Date.UTC(a, m - 1, d));
  return f.getUTCFullYear() === a && f.getUTCMonth() === m - 1 && f.getUTCDate() === d && a >= 2000 && a <= 2100;
}

/**
 * Las checadas de un día (en la zona de los negocios), en orden, cada una con
 * sus correcciones y lo que cuenta de ella; además las agregadas por el
 * administrador ese día y lo que quedó fuera de orden (Parte B2).
 */
export async function listarChecadas(negocioId, { fecha } = {}) {
  const nid = exigirNegocio(negocioId);
  if (fecha !== undefined && fecha !== null && fecha !== '' && !diaValido(fecha)) {
    fallar('La fecha va como AAAA-MM-DD', 'FECHA_INVALIDA');
  }
  const { rows } = await pool.query(
    `SELECT c.id, c.tipo, c.hora_oficial, c.hora_dispositivo, c.foto, c.origen, c.revision, host(c.ip) AS ip, c.sincronizada_at,
            c.cara, c.cara_detalle, c.cara_similitud,
            ROUND(EXTRACT(EPOCH FROM (c.hora_dispositivo - c.hora_oficial)))::int AS desfase_segundos,
            e.id AS empleado_id, e.numero_empleado, e.nombre AS empleado, s.nombre AS sucursal, d.nombre AS dispositivo,
            to_char(COALESCE($2::date, ${HOY_SQL}), 'YYYY-MM-DD') AS fecha
       FROM xecador_checadas c
       JOIN xecador_empleados e ON e.id = c.empleado_id AND e.negocio_id = c.negocio_id
       JOIN sucursales s ON s.id = c.sucursal_id AND s.negocio_id = c.negocio_id
       JOIN xecador_dispositivos d ON d.id = c.dispositivo_id AND d.negocio_id = c.negocio_id
      WHERE c.negocio_id = $1 AND (c.hora_oficial AT TIME ZONE '${ZONA}')::date = COALESCE($2::date, ${HOY_SQL})
      ORDER BY c.hora_oficial, c.id`, [nid, fecha || null]);
  const { rows: [h] } = await pool.query(`SELECT to_char(COALESCE($1::date, ${HOY_SQL}), 'YYYY-MM-DD') AS fecha`, [fecha || null]);
  const originales = rows.map(({ fecha: _f, ...c }) => ({ ...c, id: Number(c.id) }));
  const { checadas, agregadas } = await correccionesDelDia(nid, h.fecha, originales);
  return { fecha: h.fecha, checadas, agregadas };
}

export async function obtenerFoto(negocioId, checadaId) {
  const nid = exigirNegocio(negocioId);
  const id = Number(checadaId);
  if (!Number.isInteger(id) || id < 1) fallar('Foto no encontrada', 'FOTO_NO_ENCONTRADA', 404);
  const { rows: [f] } = await pool.query(
    `SELECT mime, datos FROM xecador_checada_fotos WHERE checada_id = $1 AND negocio_id = $2`, [id, nid]);
  if (!f) fallar('Foto no encontrada', 'FOTO_NO_ENCONTRADA', 404);
  return f;
}

// ── Sin conexión: sincronizar (Parte B3) ───────────────────────────────────
// La tablet guardó checadas sin internet y ahora las manda. NUNCA se pierde
// una: lo dudoso se registra igual y se marca para revisar.
//   · Hora: la referencia firmada del servidor + el tiempo transcurrido del
//     reloj monotónico. Si la hora del reloj de la tablet difiere más de 2
//     minutos, «reloj desfasado». Sin referencia válida (la tablet se reinició
//     sin internet), la de la tablet y «sin referencia».
//   · Quién: con el pase (el PIN ya se verificó en línea y se cayó el internet
//     antes de confirmar) o con el PIN cifrado, que se verifica aquí.
//     Solo el PIN (la tablet de hoy): el PIN dice de quién es. Si no es de
//     nadie → no hay a quién registrarla: aviso, sin checada.
//     Número + PIN (checadas que la página anterior dejó en la cola): PIN no
//     válido → se registra con «PIN no válido» y aviso; número que no existe
//     → aviso, sin checada.
//     Un pase que ya no se puede verificar (cambió el secreto del servidor, se
//     volvió a vincular la tablet) → se registra con «PIN no válido» y aviso.
//   · La respuesta dice lo mismo («recibida») con PIN válido o no, para que la
//     cola sin conexión no sirva para adivinar PINs.
//   · No se exige el orden del turno (pudo haber checadas en otras tablets
//     mientras tanto); la vista del día marca lo que quedó fuera de orden.
export const SINCRONIZAR_MAX = 20;
export const SINCRONIZAR_POR_HORA = 300;
const DESFASE_MAX_MS = 2 * 60 * 1000;
const sincronizadasPorTablet = new Map();

export async function sincronizar(d, datos, { ip = null } = {}) {
  const lista = Array.isArray(datos?.checadas) ? datos.checadas : null;
  if (!lista || !lista.length) fallar('No hay checadas que sincronizar', 'SIN_CHECADAS');
  if (lista.length > SINCRONIZAR_MAX) fallar(`Se mandan hasta ${SINCRONIZAR_MAX} checadas a la vez`, 'DEMASIADAS_CHECADAS');
  const ahora = Date.now();
  const recientes = (sincronizadasPorTablet.get(d.id) || []).filter((t) => ahora - t < 3600e3);
  if (recientes.length + lista.length > SINCRONIZAR_POR_HORA) {
    fallar('Demasiadas checadas sin conexión en una hora: se volverá a intentar más tarde.', 'SINCRONIZACION_EN_PAUSA', 429);
  }
  sincronizadasPorTablet.set(d.id, [...recientes, ...lista.map(() => ahora)]);
  const ipLimpia = normalizarIp(ip);
  const avisos = [];
  const resultados = [];
  for (const item of lista) {
    const clave = typeof item?.clave === 'string' ? item.clave.toLowerCase() : null;
    try {
      resultados.push(await sincronizarUna(d, item, ipLimpia, avisos));
    } catch (e) {
      if (!(e instanceof PersonalError)) throw e;
      resultados.push({ clave, estado: 'invalida', codigo: e.codigo });
    }
  }
  if (avisos.length) notificar(d.negocio_id, 'Llegaron checadas sin conexión que hay que revisar. Revisa Empleados › Checador.');
  return { resultados, ref: firmarReferencia(d.id) };
}

async function sincronizarUna(d, item, ip, avisos) {
  const b = item && typeof item === 'object' ? item : {};
  if (typeof b.clave !== 'string' || !UUID_RE.test(b.clave)) fallar('Clave inválida', 'CLAVE_INVALIDA');
  const clave = b.clave.toLowerCase();
  if (!TIPOS_CHECADA.includes(b.tipo)) fallar('Esa acción no existe', 'TIPO_INVALIDO');
  const nid = d.negocio_id;
  const revision = new Set();

  // La hora oficial: referencia del servidor + transcurrido (monotónico).
  const ahoraMs = Date.now();
  const refMs = leerReferencia(d.id, b.ref);
  const transcurrido = Number.isSafeInteger(b.transcurrido_ms) && b.transcurrido_ms >= 0 ? b.transcurrido_ms : null;
  const horaDispositivo = leerHoraDispositivo(b.hora_dispositivo);
  const dispositivoMs = horaDispositivo ? new Date(horaDispositivo).getTime() : null;
  let horaMs;
  if (refMs !== null && transcurrido !== null) {
    horaMs = refMs + transcurrido;
    // Un transcurrido que llega al futuro no es de un reloj monotónico.
    if (horaMs > ahoraMs + 60000) { horaMs = ahoraMs; revision.add('reloj_desfasado'); }
    if (dispositivoMs !== null && Math.abs(dispositivoMs - horaMs) > DESFASE_MAX_MS) revision.add('reloj_desfasado');
  } else {
    revision.add('sin_referencia');
    horaMs = dispositivoMs !== null ? Math.min(dispositivoMs, ahoraMs) : ahoraMs;
  }

  // Quién: con el pase, con el PIN cifrado, o con número + PIN cifrado.
  let empleadoId, pinValido = true, numero = null, via = 'pin';
  if (b.pase !== undefined) {
    const p = paseSinConexion(d, b.pase);
    if (!p) fallar('El pase no es válido', 'PASE_INVALIDO');
    via = 'pase';
    if (p.verificado) {
      // Se checó mientras el pase servía: si la hora cae fuera, se ajusta y se marca.
      const desde = p.x - TICKET_SEGUNDOS * 1000;
      if (horaMs < desde || horaMs > p.x + 60000) { horaMs = Math.min(Math.max(horaMs, desde), p.x); revision.add('reloj_desfasado'); }
    } else {
      pinValido = false;
    }
    empleadoId = p.e;
  } else if (!traeNumero(b)) {
    // Solo el PIN (migración 132): el PIN dice de quién es. Si no es de nadie
    // (mal escrito sin internet) o no se puede abrir, no hay a quién ponerle
    // la checada: aviso al administrador, que la agrega con una corrección.
    const pin = descifrarPin(b.pin_cifrado, clave);
    const quien = pin ? await empleadoPorPin(nid, pin) : null;
    if (!quien || quien === 'repetido') {
      await crearAviso(pool, nid, 'checada_sin_empleado', {
        dispositivoId: d.id,
        detalle: { tipo: b.tipo, hora: new Date(horaMs).toISOString(), dispositivo: d.nombre, motivo: quien === 'repetido' ? 'pin_repetido' : 'pin_sin_dueno' } });
      avisos.push('checada_sin_empleado');
      return { clave, estado: 'recibida' };
    }
    empleadoId = quien.id;
  } else {
    numero = normalizarNumero(b.numero);
    const { rows: [e] } = await pool.query(
      `SELECT id, pin_hash FROM xecador_empleados WHERE negocio_id = $1 AND numero_empleado = $2`, [nid, numero]);
    if (!e) {
      await crearAviso(pool, nid, 'checada_sin_empleado', {
        dispositivoId: d.id, detalle: { numero, tipo: b.tipo, hora: new Date(horaMs).toISOString(), dispositivo: d.nombre } });
      avisos.push('checada_sin_empleado');
      return { clave, estado: 'recibida' };
    }
    const pin = descifrarPin(b.pin_cifrado, clave);
    pinValido = !!(pin && e.pin_hash && await verificarPin(e.pin_hash, pin));
    empleadoId = e.id;
  }
  const foto = leerFoto(b.foto);
  // La cara, con las fotos que guardó la tablet (antes de la transacción: el
  // motor tarda). Una que ya llegó no se vuelve a mirar.
  const { rows: [antes] } = await pool.query(
    `SELECT empleado_id FROM xecador_checadas WHERE negocio_id = $1 AND clave = $2`, [nid, clave]);
  if (antes) return { clave, estado: antes.empleado_id === empleadoId ? 'repetida' : 'invalida' };
  const config = await obtenerConfig(nid);
  const cara = await verificarEnChecada(nid, empleadoId, b.cara, config);

  try {
    return await enTransaccion(async (client) => {
      const { rows: [ya] } = await client.query(
        `SELECT empleado_id FROM xecador_checadas WHERE negocio_id = $1 AND clave = $2`, [nid, clave]);
      if (ya) return { clave, estado: ya.empleado_id === empleadoId ? 'repetida' : 'invalida' };
      const { rows: [e] } = await client.query(
        `SELECT id, numero_empleado, nombre, estatus, sucursal_id, puede_checar_otras_sucursales
           FROM xecador_empleados WHERE id = $1 AND negocio_id = $2 FOR UPDATE`, [empleadoId, nid]);
      if (!e) fallar('Empleado no encontrado', 'EMPLEADO_NO_ENCONTRADO');
      if (!pinValido) revision.add('pin_no_valido');
      if (e.estatus !== 'activo') revision.add('empleado_de_baja');
      if (!puedeChecarAqui(e, d)) revision.add('otra_sucursal');
      if (await ipDistinta(client, nid, d.sucursal_id, ip)) revision.add('ip_distinta');
      const { estadoFoto, fotoChecada, motivo } = conCara(config, foto, cara);
      if (motivo) revision.add(motivo);
      const { rows: [c] } = await client.query(
        `INSERT INTO xecador_checadas (negocio_id, empleado_id, sucursal_id, dispositivo_id, tipo, hora_oficial, hora_dispositivo,
                                       clave, foto, origen, revision, ip, sincronizada_at, ref_servidor, transcurrido_ms,
                                       cara, cara_detalle, cara_similitud)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6::double precision / 1000), $7, $8, $9, 'sin_conexion', $10::text[], $11::inet, NOW(),
                 CASE WHEN $12::double precision IS NULL THEN NULL ELSE to_timestamp($12::double precision / 1000) END, $13,
                 $14, $15, $16)
         RETURNING id`,
        [nid, e.id, d.sucursal_id, d.id, b.tipo, horaMs, horaDispositivo, clave, estadoFoto, [...revision], ip,
          refMs, refMs !== null ? transcurrido : null, cara.cara, cara.detalle, cara.similitud]);
      if (estadoFoto === 'tomada') {
        await client.query(`INSERT INTO xecador_checada_fotos (checada_id, negocio_id, mime, datos) VALUES ($1, $2, $3, $4)`,
          [c.id, nid, fotoChecada.mime, fotoChecada.bytes]);
      }
      if (cara.cara === 'no_coincide') {
        await avisoCara(client, nid, d, e, b.tipo, new Date(horaMs).toISOString(), cara);
        avisos.push('cara_no_coincide');
      }
      if (!pinValido) {
        await crearAviso(client, nid, 'pin_no_valido', {
          empleadoId: e.id, dispositivoId: d.id,
          detalle: { numero: e.numero_empleado, empleado: e.nombre, dispositivo: d.nombre, tipo: b.tipo, hora: new Date(horaMs).toISOString(), via } });
        avisos.push('pin_no_valido');
      }
      return { clave, estado: 'recibida' };
    });
  } catch (e) {
    if (e?.code === '23505' && e.constraint === 'xecador_checadas_clave_unica') return { clave, estado: 'repetida' };
    throw e;
  }
}

// ── «Para revisar» y «Revisada» (Parte B3) ─────────────────────────────────
export const MOTIVOS_REVISION = ['reloj_desfasado', 'sin_referencia', 'pin_no_valido', 'otra_sucursal', 'empleado_de_baja', 'ip_distinta',
  'cara_no_coincide', 'cara_no_verificada'];

/** Lo que hay que revisar de los últimos días (por omisión 31), aún sin marcar «revisada». */
export async function listarParaRevisar(negocioId, { dias = 31 } = {}) {
  const nid = exigirNegocio(negocioId);
  const n = Number(dias);
  if (!Number.isInteger(n) || n < 1 || n > 366) fallar('Los días van de 1 a 366', 'DIAS_INVALIDOS');
  const { rows } = await pool.query(
    `SELECT c.id, c.tipo, c.hora_oficial, c.hora_dispositivo, c.origen, c.revision, c.foto, host(c.ip) AS ip, c.sincronizada_at,
            c.cara, c.cara_detalle, c.cara_similitud, e.id AS empleado_id,
            EXISTS (SELECT 1 FROM xecador_caras x WHERE x.negocio_id = c.negocio_id AND x.empleado_id = c.empleado_id) AS cara_registrada,
            e.numero_empleado, e.nombre AS empleado, s.nombre AS sucursal, d.nombre AS dispositivo,
            to_char(c.hora_oficial AT TIME ZONE '${ZONA}', 'YYYY-MM-DD') AS fecha
       FROM xecador_checadas c
       JOIN xecador_empleados e ON e.id = c.empleado_id AND e.negocio_id = c.negocio_id
       JOIN sucursales s ON s.id = c.sucursal_id AND s.negocio_id = c.negocio_id
       JOIN xecador_dispositivos d ON d.id = c.dispositivo_id AND d.negocio_id = c.negocio_id
      WHERE c.negocio_id = $1 AND c.hora_oficial > NOW() - make_interval(days => $2)
        AND (cardinality(c.revision) > 0 OR c.foto = 'no_disponible')
        AND NOT EXISTS (SELECT 1 FROM xecador_revisiones r WHERE r.negocio_id = c.negocio_id AND r.checada_id = c.id)
      ORDER BY c.hora_oficial DESC, c.id DESC
      LIMIT 200`, [nid, n]);
  return rows.map((r) => ({ ...r, id: Number(r.id), motivos: [...r.revision, ...(r.foto === 'no_disponible' ? ['sin_foto'] : [])] }));
}

/** «Revisada»: quién, cuándo y una nota. Una sola vez por checada. */
export async function marcarRevisada(negocioId, checadaId, { nota = null, actorId = null } = {}) {
  const nid = exigirNegocio(negocioId);
  const id = Number(checadaId);
  if (!Number.isInteger(id) || id < 1) fallar('Checada no encontrada', 'CHECADA_NO_ENCONTRADA', 404);
  if (typeof actorId !== 'string' || !UUID_RE.test(actorId)) fallar('No se pudo saber quién revisa', 'AUTOR_REQUERIDO');
  if (nota !== null && nota !== undefined && typeof nota !== 'string') fallar('La nota debe ser texto', 'NOTA_INVALIDA');
  const texto = typeof nota === 'string' && nota.trim() ? nota.trim() : null;
  if (texto && texto.length > 300) fallar('La nota admite hasta 300 caracteres', 'NOTA_INVALIDA');
  const { rows: [c] } = await pool.query(`SELECT id FROM xecador_checadas WHERE id = $1 AND negocio_id = $2`, [id, nid]);
  if (!c) fallar('Checada no encontrada', 'CHECADA_NO_ENCONTRADA', 404);
  try {
    const { rows: [r] } = await pool.query(
      `INSERT INTO xecador_revisiones (negocio_id, checada_id, revisada_por, nota) VALUES ($1, $2, $3, $4)
       RETURNING id, created_at, (SELECT nombre FROM usuarios WHERE id = $3) AS autor`, [nid, id, actorId, texto]);
    return { id: Number(r.id), checada_id: id, nota: texto, autor: r.autor, created_at: r.created_at };
  } catch (e) {
    if (e?.code === '23505' && e.constraint === 'xecador_revisiones_checada_unica') fallar('Esa checada ya se marcó como revisada', 'YA_REVISADA', 409);
    throw e;
  }
}
