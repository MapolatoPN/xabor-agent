// ─── Crear administrador inicial (Fase 3) ───────────────────────────────────
// Script MANUAL — nunca se ejecuta automáticamente en el arranque del
// servidor ni en ninguna migración. Lee credenciales desde variables de
// entorno (nunca hardcodeadas) y crea un usuario admin para un negocio ya
// existente.
//
// Uso:
//   ADMIN_EMAIL=admin@negocio.com \
//   ADMIN_PASSWORD_INICIAL='una-contraseña-de-al-menos-8-caracteres' \
//   ADMIN_NEGOCIO_SLUG=negocio-test \
//   DATABASE_URL='postgresql://...' \
//   node scripts/crear-admin-local.js
//
// Salvaguarda: se niega a correr si DATABASE_URL parece apuntar a un host
// de producción típico (Railway) a menos que se pase explícitamente
// PERMITIR_HOST_REMOTO=si. Está pensado para bases locales/efímeras.

import 'dotenv/config';
import { pool, obtenerNegocioIdPorSlug, crearUsuarioConPassword } from '../src/services/database.js';

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD_INICIAL;
const negocioSlug = process.env.ADMIN_NEGOCIO_SLUG;
const nombre = process.env.ADMIN_NOMBRE || 'Administrador';
const dbUrl = process.env.DATABASE_URL;
const permitirHostRemoto = process.env.PERMITIR_HOST_REMOTO === 'si';

function abortar(msg) {
  console.error(`[crear-admin-local] ❌ ${msg}`);
  process.exit(1);
}

if (!email || !password || !negocioSlug) {
  abortar('Faltan variables de entorno: ADMIN_EMAIL, ADMIN_PASSWORD_INICIAL y ADMIN_NEGOCIO_SLUG son obligatorias.');
}
if (!dbUrl) {
  abortar('Falta DATABASE_URL.');
}
const pareceProduccion = /railway\.app|rlwy\.net|proxy\.rlwy/i.test(dbUrl);
if (pareceProduccion && !permitirHostRemoto) {
  abortar(
    'DATABASE_URL parece apuntar a un host de Railway/producción. ' +
    'Este script no está pensado para correr ahí. Si de verdad quieres continuar, ' +
    'vuelve a ejecutar con PERMITIR_HOST_REMOTO=si (bajo tu propio riesgo).'
  );
}

try {
  const negocioId = await obtenerNegocioIdPorSlug(negocioSlug);
  if (!negocioId) abortar(`No existe ningún negocio con slug '${negocioSlug}'.`);

  const { rows: existentes } = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
  if (existentes[0]) abortar(`Ya existe un usuario con el correo '${email}'.`);

  // crearUsuarioConPassword hashea la contraseña internamente (nunca acepta
  // un hash ya calculado) y valida la longitud mínima — ver database.js.
  const usuario = await crearUsuarioConPassword({ negocioId, nombre, email, password, rol: 'admin' });
  console.log(`[crear-admin-local] ✅ Administrador creado: ${email} — negocio "${negocioSlug}" — usuarioId=${usuario.id}`);
} catch (e) {
  abortar(e.message);
} finally {
  await pool.end();
}
