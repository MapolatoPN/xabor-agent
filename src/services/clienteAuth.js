// ─── Autenticación del cliente de la tienda: OTP + sesión ─────────────────
//
// Sin contraseña. El cliente escribe su teléfono, recibe un código de 6
// dígitos y con él abre una sesión larga (90 días). Es la única forma de
// demostrar que un teléfono es suyo, y por eso es también lo que cierra el
// hueco de Rewards en la tienda: nadie canjea puntos de un número que no
// verificó.
//
// EL CÓDIGO:
//   · aleatorio (crypto), 6 dígitos, vence a los 5 minutos;
//   · en la base va SOLO su hash (con pimienta del servidor): leer la tabla
//     no sirve para entrar;
//   · un solo uso; 5 intentos y se quema; pedir otro revoca el anterior;
//   · rate limit por teléfono (3 / 15 min) y por IP (20 / 15 min), con el
//     mismo `rateLimit` en memoria que usa el resto del sistema.
//
// LA SESIÓN:
//   · token de 256 bits en cookie httpOnly; en la base va su hash;
//   · del lado del servidor: cerrar sesión la revoca DE VERDAD (a
//     diferencia de las sesiones firmadas del panel);
//   · amarrada al negocio: una sesión de la tienda A no existe para la B,
//     aunque compartan dominio y cookie. La resolución siempre recibe el
//     negocio de la URL y filtra por él.
//
// RESPUESTAS SIN ENUMERACIÓN: pedir un código responde igual exista o no la
// cuenta (la cuenta se crea al verificar). Un código incorrecto y uno
// vencido responden con el mismo status y un texto que no distingue.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { pool } from './database.js';
import { permitir } from './rateLimit.js';
import { TiendaError } from './tiendaOnline.js';
import { normalizarTelefonoCliente, obtenerOCrearCliente, limpiar } from './clientesNegocio.js';
import { canalDisponible, enviarCodigo } from './otpProveedores.js';

const PIMIENTA = process.env.SESSION_SECRET || 'xabor-session-secret-temporal';
const OTP_VIGENCIA_MS = 5 * 60 * 1000;
const OTP_MAX_INTENTOS = 5;
const OTP_LARGO = 6;
// Topes de solicitud, configurables por el mismo motivo que los de la tienda:
// una IP no siempre es una persona (NAT de operador móvil, wifi de plaza).
const tope = (env, omision) => { const n = parseInt(process.env[env], 10); return Number.isFinite(n) && n > 0 ? n : omision; };
const OTP_LIMITE_TELEFONO = tope('XABOR_OTP_LIMITE_TELEFONO', 3);   // por teléfono cada 15 min
const OTP_LIMITE_IP = tope('XABOR_OTP_LIMITE_IP', 20);              // por IP cada 15 min
const SESION_DIAS = 90;
const SESION_MS = SESION_DIAS * 24 * 60 * 60 * 1000;
export const COOKIE_CLIENTE = 'xabor_cliente';

const hashCodigo = (negocioId, telefono, codigo) =>
  createHash('sha256').update(`${PIMIENTA}|${negocioId}|${telefono}|${codigo}`).digest('hex');
const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');
const iguales = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const generico = () => new TiendaError('Código incorrecto o vencido', 'CODIGO_INVALIDO', 401);

// ── Pedir un código ───────────────────────────────────────────────────────
export async function solicitarCodigo({ negocioId, nombreNegocio, telefono, ip }) {
  const tel = normalizarTelefonoCliente(telefono);
  if (!tel) throw new TiendaError('Escribe tu teléfono a 10 dígitos', 'TELEFONO_INVALIDO');

  // El límite por teléfono es el que protege a la persona (que no le llenen
  // el celular de códigos); el de IP frena la avalancha sin dejar sin
  // servicio a otros negocios.
  if (!permitir(`otp-tel:${negocioId}:${tel}`, OTP_LIMITE_TELEFONO, 15 * 60 * 1000)) {
    throw new TiendaError('Ya te enviamos varios códigos. Espera unos minutos e inténtalo de nuevo.', 'OTP_DEMASIADOS', 429);
  }
  if (!permitir(`otp-ip:${ip || 'sin-ip'}`, OTP_LIMITE_IP, 15 * 60 * 1000)) {
    throw new TiendaError('Demasiados intentos. Espera un momento.', 'OTP_DEMASIADOS', 429);
  }

  const canal = canalDisponible();
  if (!canal) {
    throw new TiendaError('El inicio de sesión no está disponible por el momento', 'OTP_NO_DISPONIBLE', 503);
  }

  const codigo = String(randomInt(0, 10 ** OTP_LARGO)).padStart(OTP_LARGO, '0');
  const client = await pool.connect();
  let filaId = null;
  try {
    await client.query('BEGIN');
    // El código nuevo es el único válido: los anteriores se revocan.
    await client.query(
      `UPDATE cliente_otp SET revocado_at = NOW()
        WHERE negocio_id = $1 AND telefono = $2 AND usado_at IS NULL AND revocado_at IS NULL`, [negocioId, tel]);
    const { rows: [f] } = await client.query(
      `INSERT INTO cliente_otp (negocio_id, telefono, codigo_hash, canal, expires_at, ip)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' milliseconds')::interval, $6) RETURNING id`,
      [negocioId, tel, hashCodigo(negocioId, tel, codigo), canal, String(OTP_VIGENCIA_MS), limpiar(ip, 60) || null]);
    filaId = f.id;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }

  try {
    await enviarCodigo({ canal, negocioId, telefono: tel, codigo, nombreNegocio });
  } catch (e) {
    // Si no salió, no puede quedar un código vivo que nadie recibió.
    await pool.query('UPDATE cliente_otp SET revocado_at = NOW() WHERE id = $1', [filaId]).catch(() => {});
    console.error(`[OTP] No se pudo enviar el código por ${canal}: ${e.message}`);
    throw new TiendaError('No pudimos enviarte el código. Inténtalo de nuevo en un momento.', 'OTP_ENVIO_FALLIDO', 502);
  }

  const salida = { ok: true, canal, expiraEn: OTP_VIGENCIA_MS / 1000, telefono: tel };
  // SOLO fuera de producción y SOLO con la variable puesta: las suites
  // necesitan leer el código sin un teléfono real. `canalDisponible` ya
  // impide 'dev' en producción, y aquí se vuelve a comprobar.
  if (canal === 'dev' && process.env.XABOR_OTP_DEV_EXPONER === 'true' && process.env.NODE_ENV !== 'production') {
    salida.codigoDev = codigo;
  }
  return salida;
}

// ── Verificar el código y abrir sesión ────────────────────────────────────
export async function verificarCodigo({ negocioId, telefono, codigo, nombre, ip, userAgent }) {
  const tel = normalizarTelefonoCliente(telefono);
  if (!tel) throw new TiendaError('Escribe tu teléfono a 10 dígitos', 'TELEFONO_INVALIDO');
  const cod = String(codigo == null ? '' : codigo).replace(/\D/g, '');
  if (cod.length !== OTP_LARGO) throw generico();
  if (!permitir(`otp-verif:${negocioId}:${tel}`, 15, 15 * 60 * 1000)) {
    throw new TiendaError('Demasiados intentos. Pide un código nuevo en unos minutos.', 'OTP_DEMASIADOS', 429);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE: dos verificaciones simultáneas del mismo código se
    // serializan; la segunda ya lo encuentra usado.
    const { rows: [otp] } = await client.query(
      `SELECT * FROM cliente_otp
        WHERE negocio_id = $1 AND telefono = $2 AND usado_at IS NULL AND revocado_at IS NULL
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [negocioId, tel]);
    if (!otp) { await client.query('COMMIT'); throw generico(); }
    if (new Date(otp.expires_at).getTime() < Date.now()) {
      await client.query('UPDATE cliente_otp SET revocado_at = NOW() WHERE id = $1', [otp.id]);
      await client.query('COMMIT');
      throw generico();
    }
    if (!iguales(otp.codigo_hash, hashCodigo(negocioId, tel, cod))) {
      const intentos = (otp.intentos || 0) + 1;
      // Casts explícitos: Postgres no puede deducir el tipo de un parámetro
      // que aparece en el SET y dentro del CASE a la vez.
      await client.query(
        `UPDATE cliente_otp SET intentos = $2::int,
                revocado_at = CASE WHEN $2::int >= $3::int THEN NOW() ELSE revocado_at END
          WHERE id = $1::bigint`,
        [otp.id, intentos, OTP_MAX_INTENTOS]);
      await client.query('COMMIT');
      throw generico();
    }
    await client.query('UPDATE cliente_otp SET usado_at = NOW() WHERE id = $1', [otp.id]);

    const cliente = await obtenerOCrearCliente(
      { negocioId, telefono: tel, nombre, origen: 'tienda', telefonoOriginal: telefono }, client);
    const token = await crearSesion({ negocioId, clienteId: cliente.id, ip, userAgent }, client);
    await client.query('COMMIT');
    return { token, cliente, nuevo: cliente.nuevo === true };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

// ── Sesiones ──────────────────────────────────────────────────────────────
export async function crearSesion({ negocioId, clienteId, ip, userAgent }, ejecutor = pool) {
  const token = randomBytes(32).toString('base64url');
  await ejecutor.query(
    `INSERT INTO cliente_sesiones (negocio_id, cliente_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' milliseconds')::interval)`,
    [negocioId, clienteId, hashToken(token), limpiar(userAgent, 200) || null, limpiar(ip, 60) || null, String(SESION_MS)]);
  return token;
}

/**
 * Resuelve la sesión SOLO si pertenece a este negocio y sigue viva. La cookie
 * es una sola por dominio, así que la sesión de otra tienda se ignora aquí
 * exactamente igual que una inexistente.
 */
export async function sesionDeToken(token, negocioId) {
  if (!token || typeof token !== 'string' || token.length < 20 || token.length > 200 || !negocioId) return null;
  const { rows: [s] } = await pool.query(
    `SELECT s.id AS sesion_id, s.ultimo_uso_at, c.*
       FROM cliente_sesiones s
       JOIN clientes_negocio c ON c.id = s.cliente_id AND c.negocio_id = s.negocio_id
      WHERE s.token_hash = $1 AND s.negocio_id = $2 AND s.revocada_at IS NULL AND s.expires_at > NOW()`,
    [hashToken(token), negocioId]);
  if (!s) return null;
  // Último uso, a lo sumo una vez por hora: para poder ver sesiones vivas y
  // limpiar las abandonadas, sin escribir en cada request.
  if (Date.now() - new Date(s.ultimo_uso_at).getTime() > 60 * 60 * 1000) {
    pool.query('UPDATE cliente_sesiones SET ultimo_uso_at = NOW() WHERE id = $1', [s.sesion_id]).catch(() => {});
  }
  const { sesion_id: sesionId, ultimo_uso_at: _u, ...cliente } = s;
  return { sesionId, cliente };
}

export async function cerrarSesion(token) {
  if (!token) return false;
  const { rowCount } = await pool.query(
    'UPDATE cliente_sesiones SET revocada_at = NOW() WHERE token_hash = $1 AND revocada_at IS NULL', [hashToken(token)]);
  return rowCount > 0;
}

export async function cerrarTodasLasSesiones(negocioId, clienteId) {
  await pool.query(
    'UPDATE cliente_sesiones SET revocada_at = NOW() WHERE negocio_id = $1 AND cliente_id = $2 AND revocada_at IS NULL',
    [negocioId, clienteId]);
}

// ── Cookie ────────────────────────────────────────────────────────────────
// Mismo parseo manual que la cookie del panel (sin cookie-parser). httpOnly:
// el JavaScript de la tienda nunca ve el token. SameSite=Lax: un POST desde
// otro sitio no la lleva, que es la defensa CSRF junto con el JSON.
export function leerCookieCliente(req) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const par of header.split(';')) {
    const idx = par.indexOf('=');
    if (idx === -1) continue;
    if (par.slice(0, idx).trim() === COOKIE_CLIENTE) {
      try { return decodeURIComponent(par.slice(idx + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

function cookieBase(valor, maxAge) {
  const partes = [`${COOKIE_CLIENTE}=${encodeURIComponent(valor)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (process.env.NODE_ENV === 'production') partes.push('Secure');
  return partes.join('; ');
}

// Se AGREGA a Set-Cookie en vez de sustituirla: una respuesta podría llevar
// también la cookie del panel y no hay que pisarla.
function agregarSetCookie(res, valor) {
  const previas = res.getHeader('Set-Cookie');
  const lista = previas ? (Array.isArray(previas) ? previas : [previas]) : [];
  res.setHeader('Set-Cookie', [...lista, valor]);
}
export function setCookieCliente(res, token) { agregarSetCookie(res, cookieBase(token, SESION_DIAS * 24 * 60 * 60)); }
export function limpiarCookieCliente(res) { agregarSetCookie(res, cookieBase('', 0)); }

// La sesión del cliente para ESTA tienda, o null. Nunca lanza.
export async function clienteDeRequest(req, negocioId) {
  try {
    return await sesionDeToken(leerCookieCliente(req), negocioId);
  } catch (e) {
    console.error('[ClienteAuth] No se pudo resolver la sesión:', e.message);
    return null;
  }
}
