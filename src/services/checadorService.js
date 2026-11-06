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
//   · El empleado se identifica con su número y su PIN. Tras 5 fallos seguidos su
//     PIN queda en pausa 5 minutos (decisión del dueño: temporal, nunca todo el
//     turno) y el administrador recibe un aviso. Una tablet con demasiados
//     fallos en poco tiempo se pausa un minuto, también con aviso.
//   · Lo que le falte al expediente (fecha de ingreso, jornada…) NO impide
//     checar. Sin PIN sí: es como se identifica.
//   · Foto al checar: opcional por negocio. Si la cámara no está disponible la
//     checada se registra igual, marcada «sin foto»: nunca se deja a alguien sin
//     checar por la cámara.
//
// Aislamiento: el negocio sale SIEMPRE de la sesión del administrador o del
// token de la tablet, nunca del navegador.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { pool } from './database.js';
import { PersonalError, normalizarNumero, verificarPin } from './personalService.js';

const fallar = (mensaje, codigo, http, extra) => {
  const e = new PersonalError(mensaje, codigo, http);
  if (extra) e.extra = extra;
  throw e;
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (texto) => createHash('sha256').update(String(texto)).digest('hex');

export const TIPOS_CHECADA = ['entrada', 'salida', 'inicio_descanso', 'fin_descanso'];
export const PIN_INTENTOS = 5;          // fallos seguidos antes de la pausa
export const PIN_PAUSA_MIN = 5;         // minutos de pausa del PIN
const PIN_OLVIDO_MIN = 15;              // fallos más viejos que esto ya no cuentan
export const TABLET_FALLOS = 15;        // fallos de una tablet en la ventana
const TABLET_VENTANA_MS = 5 * 60 * 1000;
export const TABLET_PAUSA_MS = 60 * 1000;
export const TURNO_ABIERTO_HORAS = 16;  // una entrada más vieja que esto ya no es el turno de hoy
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
            e.numero_empleado, e.nombre AS empleado, d.nombre AS dispositivo
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
  const { rows: [c] } = await q.query(`SELECT foto_al_checar FROM xecador_config WHERE negocio_id = $1`, [nid]);
  return { foto_al_checar: c?.foto_al_checar === true };
}

export async function guardarConfig(negocioId, datos, { actorId = null } = {}) {
  const nid = exigirNegocio(negocioId);
  const foto = datos?.foto_al_checar;
  if (typeof foto !== 'boolean') fallar('«Pedir foto al checar» debe ser sí o no', 'CONFIG_INVALIDA');
  await pool.query(
    `INSERT INTO xecador_config (negocio_id, foto_al_checar, updated_at, updated_por) VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (negocio_id) DO UPDATE SET foto_al_checar = EXCLUDED.foto_al_checar, updated_at = NOW(), updated_por = EXCLUDED.updated_por`,
    [nid, foto, actorId]);
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
// Según su última checada. Una entrada (o descanso) de hace más de 16 h ya no
// es el turno de hoy: se le ofrece una entrada nueva y el administrador recibe
// un aviso de «turno sin cerrar» para corregirlo (Parte B2).
export function estadoTurno(ultima, ahora) {
  if (!ultima || ultima.tipo === 'salida') return { posibles: ['entrada'], sugerida: 'entrada', turnoSinCerrar: false };
  const horas = (new Date(ahora) - new Date(ultima.hora_oficial)) / 3.6e6;
  if (horas > TURNO_ABIERTO_HORAS) return { posibles: ['entrada'], sugerida: 'entrada', turnoSinCerrar: true };
  if (ultima.tipo === 'inicio_descanso') return { posibles: ['fin_descanso', 'salida'], sugerida: 'fin_descanso', turnoSinCerrar: false };
  return { posibles: ['salida', 'inicio_descanso'], sugerida: 'salida', turnoSinCerrar: false };
}

async function ultimaChecada(q, nid, eid) {
  const { rows: [r] } = await q.query(
    `SELECT NOW() AS ahora,
            (SELECT json_build_object('tipo', c.tipo, 'hora_oficial', c.hora_oficial)
               FROM xecador_checadas c WHERE c.negocio_id = $1 AND c.empleado_id = $2
              ORDER BY c.hora_oficial DESC, c.id DESC LIMIT 1) AS ultima`, [nid, eid]);
  return { ahora: r.ahora, ultima: r.ultima };
}

// ── El pase de 2 minutos entre «identificar» y «checar» ────────────────────
// Firmado por el servidor y atado a la tablet y al empleado: el PIN se
// escribe una vez y no vuelve a viajar al confirmar.
const SECRETO = process.env.SESSION_SECRET || 'xabor-session-secret-temporal';
const firmar = (datos) => createHmac('sha256', SECRETO).update(`xecador-pase|${datos}`).digest('base64url');
function emitirPase(d, empleadoId) {
  const datos = Buffer.from(JSON.stringify({ d: d.id, n: d.negocio_id, e: empleadoId, x: Date.now() + TICKET_SEGUNDOS * 1000 })).toString('base64url');
  return `${datos}.${firmar(datos)}`;
}
function leerPase(d, pase) {
  const [datos, firma] = String(pase || '').split('.');
  const esperada = datos ? firmar(datos) : '';
  const ok = datos && firma && firma.length === esperada.length && timingSafeEqual(Buffer.from(firma), Buffer.from(esperada));
  let p = null;
  if (ok) { try { p = JSON.parse(Buffer.from(datos, 'base64url').toString('utf8')); } catch { p = null; } }
  if (!p || p.d !== d.id || p.n !== d.negocio_id || !UUID_RE.test(p.e || '') || !(p.x > Date.now())) {
    fallar('Se acabó el tiempo para confirmar. Vuelve a escribir tu número y PIN.', 'PASE_INVALIDO', 401);
  }
  return p.e;
}

// Un hash de verdad para comparar cuando el número no existe: así tarda lo
// mismo que con un número real y no se puede adivinar quién trabaja aquí.
const HASH_FALSO = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const NUMERO_O_PIN = 'Número o PIN incorrecto.';

function puedeChecarAqui(e, d) {
  return !e.sucursal_id || e.sucursal_id === d.sucursal_id || e.puede_checar_otras_sucursales === true;
}

/**
 * Paso 1 en la tablet: número + PIN. Devuelve quién es, qué puede registrar
 * y un pase para confirmar. Cuenta los fallos del PIN y lo pausa si toca.
 */
export async function identificar(d, datos) {
  const espera = tabletEnPausa(d);
  if (espera) fallar(`Demasiados intentos en esta tablet. Espera ${espera} segundos.`, 'TABLET_EN_PAUSA', 429, { segundos: espera });
  const b = datos && typeof datos === 'object' ? datos : {};
  const numero = normalizarNumero(b.numero);
  const pin = typeof b.pin === 'string' ? b.pin : '';
  if (!/^\d{4,6}$/.test(pin)) fallar('El PIN lleva de 4 a 6 dígitos', 'PIN_INVALIDO');

  let aviso = null;
  const r = await enTransaccion(async (client) => {
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
        aviso = 'El PIN de un empleado quedó en pausa 5 minutos por intentos fallidos. Revisa Empleados › Checador.';
        return { error: 'bloqueado', minutos: PIN_PAUSA_MIN };
      }
      await client.query(`UPDATE xecador_empleados SET pin_fallos = $2, pin_ultimo_fallo_at = NOW() WHERE id = $1`, [e.id, fallos]);
      return { error: 'credenciales' };
    }
    if (e.pin_fallos || e.pin_ultimo_fallo_at || e.pin_bloqueado_hasta) {
      await client.query(`UPDATE xecador_empleados SET pin_fallos = 0, pin_ultimo_fallo_at = NULL, pin_bloqueado_hasta = NULL WHERE id = $1`, [e.id]);
    }
    if (!puedeChecarAqui(e, d)) return { error: 'otra_sucursal', sucursal: e.sucursal };
    const { ahora, ultima } = await ultimaChecada(client, d.negocio_id, e.id);
    return { e, ahora, ultima };
  });
  if (aviso) notificar(d.negocio_id, aviso);
  if (r.error === 'credenciales') { registrarFalloTablet(d); fallar(NUMERO_O_PIN, 'CREDENCIALES', 401); }
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
  return {
    empleado: { nombre: r.e.nombre, numero: r.e.numero_empleado },
    posibles, sugerida, ultima: r.ultima, foto_al_checar: config.foto_al_checar,
    pase: emitirPase(d, r.e.id), pase_segundos: TICKET_SEGUNDOS,
  };
}

/** La foto que manda la tablet: JPEG o WebP de verdad y de tamaño razonable; si no, ninguna. */
function leerFoto(foto) {
  if (!foto || typeof foto !== 'object' || typeof foto.datos !== 'string' || foto.datos.length > FOTO_MAX_BYTES * 1.4) return null;
  let bytes;
  try { bytes = Buffer.from(foto.datos, 'base64'); } catch { return null; }
  if (!bytes.length || bytes.length > FOTO_MAX_BYTES) return null;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  if (jpeg) return { mime: 'image/jpeg', bytes };
  if (webp) return { mime: 'image/webp', bytes };
  return null;
}

/** La hora del dispositivo, solo como referencia: si no se entiende, no se guarda. */
function leerHoraDispositivo(valor) {
  if (typeof valor !== 'string' || valor.length > 40) return null;
  const f = new Date(valor);
  const y = f.getUTCFullYear();
  return Number.isNaN(f.getTime()) || y < 2020 || y > 2100 ? null : f.toISOString();
}

const publicaChecada = (c) => ({ id: Number(c.id), tipo: c.tipo, hora_oficial: c.hora_oficial, foto: c.foto });

/**
 * Paso 2 en la tablet: registra la checada. La hora oficial es la del
 * servidor. La misma clave devuelve la misma checada (repetida: true).
 */
export async function checar(d, datos) {
  const b = datos && typeof datos === 'object' ? datos : {};
  const empleadoId = leerPase(d, b.pase);
  if (!TIPOS_CHECADA.includes(b.tipo)) fallar('Esa acción no existe', 'TIPO_INVALIDO');
  if (typeof b.clave !== 'string' || !UUID_RE.test(b.clave)) fallar('Falta la clave de la checada: recarga la pantalla', 'CLAVE_INVALIDA');
  const clave = b.clave.toLowerCase();
  const horaDispositivo = leerHoraDispositivo(b.hora_dispositivo);
  const foto = leerFoto(b.foto);
  const nid = d.negocio_id;

  const previa = async (q) => {
    const { rows: [c] } = await q.query(
      `SELECT id, tipo, hora_oficial, foto, empleado_id FROM xecador_checadas WHERE negocio_id = $1 AND clave = $2`, [nid, clave]);
    if (!c) return null;
    if (c.empleado_id !== empleadoId) fallar('Esa clave ya se usó para otra checada: recarga la pantalla', 'CLAVE_USADA', 409);
    return c;
  };

  let avisoSinCerrar = false;
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
        fallar('Esa acción ya no corresponde: vuelve a escribir tu número y PIN.', 'ACCION_NO_VALIDA', 409, { posibles: turno.posibles });
      }
      const config = await obtenerConfig(nid, client);
      const estadoFoto = !config.foto_al_checar ? 'no_requerida' : foto ? 'tomada' : 'no_disponible';
      const { rows: [c] } = await client.query(
        `INSERT INTO xecador_checadas (negocio_id, empleado_id, sucursal_id, dispositivo_id, tipo, hora_dispositivo, clave, foto)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, tipo, hora_oficial, foto`,
        [nid, e.id, d.sucursal_id, d.id, b.tipo, horaDispositivo, clave, estadoFoto]);
      if (estadoFoto === 'tomada') {
        await client.query(`INSERT INTO xecador_checada_fotos (checada_id, negocio_id, mime, datos) VALUES ($1, $2, $3, $4)`,
          [c.id, nid, foto.mime, foto.bytes]);
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
    return { checada: publicaChecada(r.checada), empleado: r.empleado ?? null, repetida: r.repetida };
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
/** Las checadas de un día (en la zona de los negocios), en orden. */
export async function listarChecadas(negocioId, { fecha } = {}) {
  const nid = exigirNegocio(negocioId);
  if (fecha !== undefined && fecha !== null && fecha !== '' && (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)
      || Number.isNaN(new Date(`${fecha}T00:00:00Z`).getTime()))) {
    fallar('La fecha va como AAAA-MM-DD', 'FECHA_INVALIDA');
  }
  const { rows } = await pool.query(
    `SELECT c.id, c.tipo, c.hora_oficial, c.hora_dispositivo, c.foto,
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
  return { fecha: h.fecha, checadas: rows.map(({ fecha: _f, ...c }) => ({ ...c, id: Number(c.id) })) };
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
