// ─── Alta y emparejamiento de dispositivos Xabor Edge ───────────────────────
//
// Un Edge es una fila de `terminales` (ver docs/impresion-actual-auditoria.md
// para por qué no se creó una entidad nueva). Este módulo gestiona su ciclo
// de vida: crearlo, emitirle una credencial propia y revocársela.
//
// Reglas de seguridad que se cumplen aquí:
//
//   * Cada Edge tiene su PROPIA credencial. Nunca PANEL_SECRET, nunca la
//     contraseña de un usuario, nunca el PIN de un mesero, nunca un secreto
//     compartido entre negocios.
//   * De la credencial solo se guarda el SHA-256. El token en claro existe
//     una sola vez, en la respuesta HTTP que lo emite; si se pierde, se
//     genera otro -- no se puede "recuperar".
//   * Revocar es poner `token_hash = NULL`: la próxima autenticación falla
//     con "sin credencial emitida" y las conexiones abiertas se cierran.
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { pool } from './database.js';

function errorCodigo(mensaje, code) {
  const e = new Error(mensaje);
  e.code = code;
  return e;
}

const hash = (v) => createHash('sha256').update(v).digest('hex');

// Minutos de vida del código de emparejamiento. Corto a propósito: es un
// código que alguien dicta en voz alta mientras está frente al equipo.
export const MINUTOS_EMPAREJAMIENTO = 15;

// Alfabeto sin caracteres que se confunden al dictarlos (0/O, 1/I/L).
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generarCodigo() {
  const bytes = randomBytes(8);
  let codigo = '';
  for (let i = 0; i < 8; i++) codigo += ALFABETO[bytes[i] % ALFABETO.length];
  return `${codigo.slice(0, 4)}-${codigo.slice(4)}`;
}

export async function listarEdges(negocioId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.nombre, t.codigo, t.activo, t.tipo, t.ultima_conexion, t.sucursal_id,
            (t.token_hash IS NOT NULL) AS tiene_credencial,
            (SELECT count(*)::int FROM impresoras i WHERE i.terminal_id = t.id) AS impresoras
       FROM terminales t
       JOIN sucursales s ON s.id = t.sucursal_id
      WHERE s.negocio_id = $1
      ORDER BY t.nombre`,
    [negocioId]
  );
  return rows;
}

export async function crearEdge(negocioId, { nombre, sucursalId = null }) {
  if (typeof nombre !== 'string' || !nombre.trim()) throw errorCodigo('El nombre del Edge es obligatorio', 'NOMBRE_REQUERIDO');

  const { rows: suc } = await pool.query(
    sucursalId
      ? `SELECT id FROM sucursales WHERE id = $2 AND negocio_id = $1 AND activo`
      : `SELECT id FROM sucursales WHERE negocio_id = $1 AND activo ORDER BY created_at LIMIT 1`,
    sucursalId ? [negocioId, sucursalId] : [negocioId]
  );
  if (!suc.length) throw errorCodigo('El negocio no tiene una sucursal activa donde instalar el Edge', 'SUCURSAL_NO_ENCONTRADA');

  // `codigo` es un identificador legible dentro de la sucursal, no un
  // secreto: aparece en la UI para distinguir "la PC de caja" de "la de la
  // oficina". El secreto es el token, que aquí todavía no existe.
  const codigo = `edge-${nombre.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'principal'}`;
  try {
    const { rows } = await pool.query(
      `INSERT INTO terminales (sucursal_id, nombre, codigo, tipo) VALUES ($1,$2,$3,'edge')
       RETURNING id, sucursal_id, nombre, codigo, activo, tipo`,
      [suc[0].id, nombre.trim(), codigo]
    );
    return rows[0];
  } catch (e) {
    if (e.code === '23505') throw errorCodigo('Ya existe un Edge con ese nombre en la sucursal', 'NOMBRE_DUPLICADO');
    throw e;
  }
}

// Genera el código que se teclea en el Edge. Devuelve el código EN CLARO una
// sola vez; en la base queda solo su hash.
export async function generarEmparejamiento(negocioId, terminalId, { usuarioId = null } = {}) {
  const { rows: term } = await pool.query(
    `SELECT t.id FROM terminales t JOIN sucursales s ON s.id = t.sucursal_id
      WHERE t.id = $1 AND s.negocio_id = $2 AND t.activo`,
    [terminalId, negocioId]
  );
  if (!term.length) throw errorCodigo('Edge no encontrado', 'EDGE_NO_ENCONTRADO');

  const codigo = generarCodigo();
  const expira = new Date(Date.now() + MINUTOS_EMPAREJAMIENTO * 60_000);

  // Generar uno nuevo cancela el anterior: el índice único parcial solo
  // admite un código sin usar por terminal, así que hay que retirar el viejo
  // explícitamente en vez de dejar que el INSERT choque.
  await pool.query(
    `UPDATE edge_emparejamientos SET usado_at = NOW()
      WHERE terminal_id = $1 AND usado_at IS NULL`, [terminalId]);

  await pool.query(
    `INSERT INTO edge_emparejamientos (negocio_id, terminal_id, codigo_hash, expira_at, creado_por)
     VALUES ($1,$2,$3,$4,$5)`,
    [negocioId, terminalId, hash(codigo), expira, usuarioId]
  );

  return { codigo, expiraAt: expira, minutos: MINUTOS_EMPAREJAMIENTO };
}

// Canje del código. Endpoint PÚBLICO (el Edge todavía no tiene credencial),
// y por eso es el que más cuidado necesita:
//
//   * el código se busca por HASH, nunca por comparación de texto;
//   * un solo uso, con `usado_at` marcado en la MISMA consulta que lo
//     encuentra, para que dos intentos simultáneos no lo canjeen dos veces;
//   * caducidad comprobada en SQL, no en JavaScript;
//   * la respuesta no distingue "no existe" de "ya usado" ni de "caducado":
//     todas son el mismo error, para no ayudar a adivinar códigos.
export async function canjearEmparejamiento(codigo) {
  if (typeof codigo !== 'string' || codigo.length > 64) throw errorCodigo('Código inválido', 'CODIGO_INVALIDO');
  const normalizado = codigo.trim().toUpperCase();

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    // El UPDATE ... RETURNING es lo que hace atómico el "un solo uso": si dos
    // peticiones llegan a la vez, solo una obtiene fila.
    const { rows } = await cliente.query(
      `UPDATE edge_emparejamientos
          SET usado_at = NOW()
        WHERE codigo_hash = $1 AND usado_at IS NULL AND expira_at > NOW()
        RETURNING terminal_id, negocio_id`,
      [hash(normalizado)]
    );
    if (!rows.length) {
      await cliente.query('ROLLBACK');
      throw errorCodigo('Código de emparejamiento inválido o vencido', 'EMPAREJAMIENTO_INVALIDO');
    }

    const { terminal_id: terminalId } = rows[0];
    const token = randomBytes(32).toString('hex');

    const { rows: term } = await cliente.query(
      `UPDATE terminales t SET token_hash = $2
         FROM sucursales s
        WHERE t.id = $1 AND s.id = t.sucursal_id AND t.activo AND s.activo
        RETURNING t.id, t.nombre, s.negocio_id, s.id AS sucursal_id`,
      [terminalId, hash(token)]
    );
    if (!term.length) {
      await cliente.query('ROLLBACK');
      throw errorCodigo('El Edge o su sucursal están desactivados', 'EDGE_INACTIVO');
    }

    await cliente.query('COMMIT');
    // El token viaja aquí y nunca más. No se loguea ni se puede recuperar.
    return { terminalId: term[0].id, token, nombre: term[0].nombre };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

// Revocar deja al Edge sin poder autenticarse. Se usa cuando se retira una
// PC, cuando alguien deja de trabajar en el local o si se sospecha que el
// token se filtró.
export async function revocarCredencial(negocioId, terminalId) {
  const { rows } = await pool.query(
    `UPDATE terminales t SET token_hash = NULL
       FROM sucursales s
      WHERE t.id = $1 AND s.id = t.sucursal_id AND s.negocio_id = $2
      RETURNING t.id`,
    [terminalId, negocioId]
  );
  if (!rows.length) throw errorCodigo('Edge no encontrado', 'EDGE_NO_ENCONTRADO');
  return { revocada: true };
}

export async function activarEdge(negocioId, terminalId, activo) {
  const { rows } = await pool.query(
    `UPDATE terminales t SET activo = $3
       FROM sucursales s
      WHERE t.id = $1 AND s.id = t.sucursal_id AND s.negocio_id = $2
      RETURNING t.id, t.activo`,
    [terminalId, negocioId, !!activo]
  );
  if (!rows.length) throw errorCodigo('Edge no encontrado', 'EDGE_NO_ENCONTRADO');
  return rows[0];
}

// Expuesto para las pruebas de autenticación: comprueba un token contra el
// hash guardado con comparación en tiempo constante, igual que hace el
// WebSocket. No lo usa ninguna ruta.
export function tokenCoincide(token, tokenHash) {
  if (!token || !tokenHash) return false;
  const a = Buffer.from(hash(token), 'hex');
  const b = Buffer.from(tokenHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
