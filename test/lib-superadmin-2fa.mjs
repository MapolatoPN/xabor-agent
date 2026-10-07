// Sesión de Superadmin CON el segundo factor ya verificado, para las suites
// (migración 116). Desde la 116, /api/superadmin/* y /ws/superadmin piden,
// además de la cookie de sesión, la cookie xabor_sa2fa atada a esa sesión y
// a la versión vigente del TOTP del usuario.
//
// Deja una fila CONFIRMADA en superadmin_totp sin secreto real (estas suites
// prueban otra cosa, nunca teclean un código) y acuña las dos cookies con el
// mismo SESSION_SECRET que el servidor de prueba. La suite que prueba el
// segundo factor de verdad es fase-superadmin-2fa.mjs.
//
// Imports perezosos a propósito: este archivo se importa estáticamente desde
// la cabecera de las suites, y varias fijan variables de entorno en su cuerpo
// ANTES de cargar database.js / session.js. Un import estático aquí cargaría
// esos módulos antes, con el entorno todavía sin fijar.
export async function cookieSuperadminCon2fa({ usuarioId, negocioId, rol = 'admin' }) {
  const { pool } = await import('../src/services/database.js');
  const { crearTokenSesion } = await import('../src/services/session.js');
  const { crearCookie2fa } = await import('../src/services/superadmin2fa.js');
  const { rows: [fila] } = await pool.query(
    `INSERT INTO superadmin_totp (usuario_id, estado, secreto_cifrado, secreto_iv, secreto_tag, secreto_formato, confirmado_at)
     VALUES ($1, 'confirmado', 'prueba-sin-secreto', '-', '-', 1, now())
     ON CONFLICT (usuario_id) DO UPDATE
       SET estado = 'confirmado', confirmado_at = COALESCE(superadmin_totp.confirmado_at, now())
     RETURNING version`, [usuarioId]);
  const token = crearTokenSesion({ usuarioId, negocioId, rol });
  const { valor } = crearCookie2fa({ usuarioId, tokenSesion: token, version: fila.version });
  return `xabor_sesion=${encodeURIComponent(token)}; xabor_sa2fa=${valor}`;
}
