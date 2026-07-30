// ─── Registrar superadmin de plataforma (Fase 6) ────────────────────────────
// Script MANUAL — nunca se ejecuta automáticamente. NO crea usuarios, NO
// toca contraseñas, NO toca usuario_negocios (la membresía de negocio del
// usuario queda exactamente igual que antes). Únicamente inserta (o
// reactiva) la fila en administradores_plataforma para un usuario que ya
// debe existir.
//
// Uso:
//   SUPERADMIN_EMAIL=mario@xabor.mx \
//   DATABASE_URL='postgresql://...' \
//   node scripts/registrar-superadmin.js
//
// Salvaguarda: misma que crear-admin-local.js -- se niega a correr contra un
// host que parezca Railway/producción salvo PERMITIR_HOST_REMOTO=si.
// Idempotente: correrlo dos veces con el mismo correo no duplica nada y
// deja activo=true si estaba desactivado; nunca falla por "ya existe".

import 'dotenv/config';
import { pool } from '../src/services/database.js';

const email = process.env.SUPERADMIN_EMAIL;
const dbUrl = process.env.DATABASE_URL;
const permitirHostRemoto = process.env.PERMITIR_HOST_REMOTO === 'si';

function abortar(msg) {
  console.error(`[registrar-superadmin] ❌ ${msg}`);
  process.exit(1);
}

if (!email) abortar('Falta la variable de entorno SUPERADMIN_EMAIL.');
if (!dbUrl) abortar('Falta DATABASE_URL.');
const pareceProduccion = /railway\.app|rlwy\.net|proxy\.rlwy/i.test(dbUrl);
if (pareceProduccion && !permitirHostRemoto) {
  abortar(
    'DATABASE_URL parece apuntar a un host de Railway/producción. ' +
    'Vuelve a ejecutar con PERMITIR_HOST_REMOTO=si si de verdad quieres continuar ahí.'
  );
}

try {
  // Buscar el usuario existente -- nunca se crea uno nuevo aquí. email es
  // único globalmente desde la migración 006, así que a lo sumo una fila.
  const { rows: usuarios } = await pool.query(
    'SELECT id, nombre, email FROM usuarios WHERE email = $1',
    [email]
  );
  const usuario = usuarios[0];
  if (!usuario) {
    abortar(`No existe ningún usuario con el correo '${email}'. No se creó nada -- este script nunca inventa un usuario.`);
  }

  // ON CONFLICT (usuario_id) -- la tabla ya tiene UNIQUE(usuario_id) desde
  // la migración 011. Si la fila ya existe, solo se asegura activo=true
  // (reactivación segura); si no existe, se inserta. Nunca toca
  // usuario_negocios, password_hash ni ninguna otra tabla.
  const { rows: resultado } = await pool.query(
    `INSERT INTO administradores_plataforma (usuario_id, activo)
     VALUES ($1, true)
     ON CONFLICT (usuario_id) DO UPDATE SET activo = true
     RETURNING id, activo, created_at, (xmax = 0) AS fue_insertado`,
    [usuario.id]
  );
  const fila = resultado[0];

  console.log(`[registrar-superadmin] ✅ ${fila.fue_insertado ? 'Registrado' : 'Ya existía -- confirmado activo'}: ${email} (usuarioId=${usuario.id}, administradorPlataformaId=${fila.id})`);
  console.log('[registrar-superadmin] La membresía de negocio de este usuario no se modificó.');
} catch (e) {
  abortar(e.message);
} finally {
  await pool.end();
}
