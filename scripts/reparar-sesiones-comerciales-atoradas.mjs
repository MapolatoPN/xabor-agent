// NO EJECUTAR contra producción sin autorización explícita del dueño.
// Requiere la migración 031 ya aplicada (columnas ultimo_error_codigo/
// ultimo_error_at/intentos_fallidos + estado 'error_recuperable').
//
// Repara EXCLUSIVAMENTE las sesiones con la firma exacta diagnosticada
// por scripts/diagnostico-sesiones-comerciales-atoradas.mjs:
//   estado = 'construyendo_borrador' AND cotizacion_id IS NULL
//
// Acción: transiciona esas filas a 'error_recuperable', registra
// ultimo_error_codigo='reparacion_hotfix_031' y ultimo_error_at=NOW().
// NUNCA toca campos_capturados (los datos que el cliente ya dio se
// conservan intactos) ni cotizacion_id (sigue NULL -- no se inventa
// ninguna cotización). NUNCA toca sesiones sanas: cualquier fila con
// cotizacion_id ya poblado, o en cualquier otro estado, queda intacta.
//
// Efecto para el cliente: la próxima vez que escriba, obtenerSesionActiva
// encuentra esta MISMA sesión (error_recuperable sigue contando como
// activa) con sus datos ya capturados, y el flujo corregido puede
// reintentar crear el borrador de verdad -- sin duplicar nada, porque
// generarBorradorDesdeSesion solo se salta como "yaExistia" cuando
// cotizacion_id YA está poblado.
//
// Uso (dos pasos deliberados, para no correr por accidente):
//   DATABASE_URL=... node scripts/reparar-sesiones-comerciales-atoradas.mjs --dry-run
//   DATABASE_URL=... node scripts/reparar-sesiones-comerciales-atoradas.mjs --confirmar
import pkg from 'pg';
const { Pool } = pkg;

const modo = process.argv[2];
if (modo !== '--dry-run' && modo !== '--confirmar') {
  console.error('Uso: node reparar-sesiones-comerciales-atoradas.mjs --dry-run | --confirmar');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const { rows: afectadas } = await pool.query(`
  SELECT sc.id, n.nombre AS negocio_nombre, sc.telefono
  FROM sesiones_comerciales sc
  JOIN negocios n ON n.id = sc.negocio_id
  WHERE sc.estado = 'construyendo_borrador' AND sc.cotizacion_id IS NULL
`);

console.log(`Sesiones que serían reparadas: ${afectadas.length}`);
for (const r of afectadas) console.log(`- ${r.id} | ${r.negocio_nombre} | tel=${r.telefono}`);

if (modo === '--dry-run') {
  console.log('\n--dry-run: no se modificó nada. Corre con --confirmar para aplicar.');
  await pool.end();
  process.exit(0);
}

if (afectadas.length === 0) {
  console.log('\nNada que reparar.');
  await pool.end();
  process.exit(0);
}

const { rowCount } = await pool.query(`
  UPDATE sesiones_comerciales
  SET estado = 'error_recuperable',
      ultimo_error_codigo = 'reparacion_hotfix_031',
      ultimo_error_at = NOW(),
      intentos_fallidos = intentos_fallidos + 1
  WHERE estado = 'construyendo_borrador' AND cotizacion_id IS NULL
`);

console.log(`\nReparadas: ${rowCount} sesión(es). campos_capturados y cotizacion_id no se tocaron.`);
await pool.end();
