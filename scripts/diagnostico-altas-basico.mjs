// Diagnóstico de registros previos antes de abrir Xabor Básico.
// SOLO SELECT, NO escribe datos ni contacta personas. Nunca imprime correos,
// teléfonos, contraseñas ni datos de un prospecto individual.
// Ejecutar: DATABASE_URL=<base-autorizada> node scripts/diagnostico-altas-basico.mjs
import 'dotenv/config';
import { pool } from '../src/services/database.js';

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL. No se intentó ninguna conexión.');
  process.exit(2);
}
const reportar = (nombre, rows) => {
  console.log('\n' + nombre);
  for (const fila of rows) console.log(JSON.stringify(fila));
};
try {
  const [negocios, prospectos, coincidencias] = await Promise.all([
    pool.query(`SELECT estado, plan, COUNT(*)::int AS total
      FROM negocios GROUP BY estado, plan ORDER BY estado, plan`),
    pool.query(`SELECT estado, COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE email IS NOT NULL AND trim(email) <> '')::int AS con_email,
       COUNT(*) FILTER (WHERE email IS NULL OR trim(email) = '')::int AS sin_email
      FROM prospectos_comerciales GROUP BY estado ORDER BY estado`),
    pool.query(`SELECT
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM usuarios u WHERE lower(u.email) = lower(p.email)
       ))::int AS prospectos_con_cuenta,
       COUNT(*) FILTER (WHERE p.email IS NOT NULL AND trim(p.email) <> '' AND NOT EXISTS (
         SELECT 1 FROM usuarios u WHERE lower(u.email) = lower(p.email)
       ))::int AS prospectos_con_email_sin_cuenta
      FROM prospectos_comerciales p`),
  ]);
  reportar('Negocios registrados por estado y plan', negocios.rows);
  reportar('Prospectos de la landing por estado', prospectos.rows);
  reportar('Cruce agregado, sin datos personales', coincidencias.rows);
  console.log('\nSolo diagnóstico. No se modificaron registros ni se enviaron mensajes.');
} catch (e) {
  console.error('No pudo generarse el diagnóstico (sin cambios):', e.code || e.message);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
