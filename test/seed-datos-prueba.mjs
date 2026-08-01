// Siembra negocios/usuarios sintéticos reutilizados por las suites de
// Fase A y Fase B. Requiere que aplicar-migraciones.mjs ya haya corrido
// sobre el mismo DATABASE_URL. Escribe test/.datos-prueba.json (no se
// commitea -- ver .gitignore) con los IDs generados.
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool, crearUsuarioConPassword } from '../src/services/database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function upsertNegocio(nombre, slug) {
  const { rows } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1,$2)
     ON CONFLICT (slug) DO UPDATE SET nombre = $1
     RETURNING id`,
    [nombre, slug]
  );
  return rows[0].id;
}

async function upsertModulo(negocioId, modulo, estado) {
  await pool.query(
    `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
     ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`,
    [negocioId, modulo, estado]
  );
}

export async function sembrarDatosPrueba() {
  const negocioA = await upsertNegocio('Fase B Negocio A (whatsapp activo)', 'faseb-negocio-a');
  const negocioB = await upsertNegocio('Fase B Negocio B (whatsapp activo)', 'faseb-negocio-b');
  const negocioC = await upsertNegocio('Fase B Negocio C (whatsapp no contratado)', 'faseb-negocio-c');
  const negocioD = await upsertNegocio('Fase B Negocio D (whatsapp suspendido)', 'faseb-negocio-d');

  await upsertModulo(negocioA, 'whatsapp', 'activo');
  await upsertModulo(negocioB, 'whatsapp', 'activo');
  await upsertModulo(negocioC, 'whatsapp', 'no_contratado');
  await upsertModulo(negocioD, 'whatsapp', 'suspendido');

  const superadminUser = await crearUsuarioConPassword({
    negocioId: negocioA, nombre: 'Superadmin Prueba', email: 'superadmin-faseb@test.local',
    password: 'ClaveSuperadminPrueba123!', rol: 'admin',
  });
  await pool.query(
    `INSERT INTO administradores_plataforma (usuario_id) VALUES ($1) ON CONFLICT (usuario_id) DO NOTHING`,
    [superadminUser.id]
  );

  const adminNegocioA = await crearUsuarioConPassword({
    negocioId: negocioA, nombre: 'Admin Negocio A', email: 'admin-a-faseb@test.local',
    password: 'ClaveAdminAPrueba123!', rol: 'admin',
  });

  const staffNegocioA = await crearUsuarioConPassword({
    negocioId: negocioA, nombre: 'Staff Negocio A', email: 'staff-a-faseb@test.local',
    password: 'ClaveStaffAPrueba123!', rol: 'staff',
  });

  const { rows: [nonnaMaye] } = await pool.query(`SELECT id FROM negocios WHERE slug = 'nonna-maye'`);

  const datos = {
    negocioA, negocioB, negocioC, negocioD,
    nonnaMayeId: nonnaMaye?.id || null,
    superadminUsuarioId: superadminUser.id,
    adminNegocioAUsuarioId: adminNegocioA.id,
    staffNegocioAUsuarioId: staffNegocioA.id,
  };
  writeFileSync(join(__dirname, '.datos-prueba.json'), JSON.stringify(datos, null, 2));
  return datos;
}

import { pathToFileURL } from 'url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const datos = await sembrarDatosPrueba();
    console.log('OK seed:', JSON.stringify(datos, null, 2));
  } catch (e) {
    console.error('FALLO seed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
