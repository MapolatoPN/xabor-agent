// SOLO LECTURA -- ninguna sentencia de escritura en este script.
//
// Diagnostica sesiones_comerciales que quedaron atoradas por el bug
// corregido en el hotfix de la migración 031: el guardado del borrador
// fallaba (típicamente por una fecha en texto natural que nunca se pudo
// convertir a DATE) DESPUÉS de que el estado ya había cambiado a
// 'construyendo_borrador', y ningún código anterior sabía revertir ni
// avanzar ese estado -- la sesión quedaba viva (no en
// finalizada/abandonada) pero sin ninguna cotización vinculada y sin
// forma de que el mismo cliente reintentara con éxito.
//
// Firma exacta de una sesión atorada por ESTE bug específico:
//   estado = 'construyendo_borrador' AND cotizacion_id IS NULL
//
// (Cualquier sesión con cotizacion_id ya poblado terminó bien, sin
// importar en qué estado haya quedado después -- eso no es lo que este
// script busca.)
//
// Uso: DATABASE_URL=... node scripts/diagnostico-sesiones-comerciales-atoradas.mjs
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const { rows } = await pool.query(`
  SELECT sc.id, n.nombre AS negocio_nombre, n.slug AS negocio_slug, sc.telefono,
         sc.campos_capturados, sc.created_at, sc.updated_at
  FROM sesiones_comerciales sc
  JOIN negocios n ON n.id = sc.negocio_id
  WHERE sc.estado = 'construyendo_borrador' AND sc.cotizacion_id IS NULL
  ORDER BY sc.created_at ASC
`);

console.log(`Sesiones atoradas encontradas: ${rows.length}\n`);
for (const r of rows) {
  console.log(`- ${r.id} | ${r.negocio_nombre} (${r.negocio_slug}) | tel=${r.telefono} | creada=${r.created_at.toISOString()} | campos=${JSON.stringify(r.campos_capturados)}`);
}
console.log('\nEste script NO modifica nada. Para repararlas ver scripts/reparar-sesiones-comerciales-atoradas.mjs (requiere confirmación explícita antes de correr).');

await pool.end();
