// Reinicia el segundo factor (TOTP) de un superadmin: teléfono perdido o app
// borrada. Borra su fila de superadmin_totp; la versión desaparece con ella,
// así que toda sesión ya verificada deja de valer en el acto. En su próximo
// ingreso a /superadmin le pedirá contraseña y un QR nuevo.
//
// Es la ÚNICA forma de cambiar un TOTP confirmado: la web no lo permite, para
// que quien sepa la contraseña no pueda reemplazar el segundo factor.
//
//   node scripts/superadmin-2fa-reiniciar.mjs <email>            (simulacro)
//   node scripts/superadmin-2fa-reiniciar.mjs <email> --aplicar
import pg from 'pg';
const [email, flag] = process.argv.slice(2);
if (!email || !process.env.DATABASE_URL) { console.error('Uso: DATABASE_URL=… node scripts/superadmin-2fa-reiniciar.mjs <email> [--aplicar]'); process.exit(1); }
const host = new URL(process.env.DATABASE_URL).hostname;
const c = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });
await c.connect();
try {
  await c.query('BEGIN');
  const { rows: [u] } = await c.query(
    `SELECT u.id FROM usuarios u JOIN administradores_plataforma ap ON ap.usuario_id = u.id WHERE u.email = $1`, [email]);
  if (!u) throw new Error(`${email} no es superadmin`);
  const { rowCount } = await c.query('DELETE FROM superadmin_totp WHERE usuario_id = $1', [u.id]);
  await c.query(
    `INSERT INTO auditoria_plataforma (superadmin_id, accion, usuario_id, contexto) VALUES ($1, 'superadmin_2fa_reiniciado', $1, $2)`,
    [u.id, JSON.stringify({ via: 'script', habia_totp: rowCount > 0 })]);
  await c.query(flag === '--aplicar' ? 'COMMIT' : 'ROLLBACK');
  console.log(rowCount ? 'TOTP borrado.' : 'No tenía TOTP.', flag === '--aplicar' ? 'APLICADO.' : 'SIMULACRO: repite con --aplicar.');
} catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('ABORTADO:', e.message); process.exitCode = 1; }
finally { await c.end(); }
