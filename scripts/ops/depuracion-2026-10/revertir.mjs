// Reversa de los pasos 01 y 02 a partir del JSON de respaldo que dejó cada uno.
//
//   node scripts/ops/depuracion-2026-10/revertir.mjs <archivo-ANTES.json>            (simulacro)
//   node scripts/ops/depuracion-2026-10/revertir.mjs <archivo-ANTES.json> --aplicar
//
// 01 (contención): devuelve activo y sesiones_invalidas_antes de cada cuenta y
//    activo de cada fila de administradores_plataforma. OJO: reactiva cuentas
//    cuyas contraseñas son públicas.
// 02 (mover): restaura usuarios.negocio_id y el rol/activo de cada membresía;
//    borra la membresía de Obispado si antes no existía.
import { readFileSync } from 'node:fs';
import { enTransaccion, idSuperadmin, auditar } from './comun.mjs';

const archivo = process.argv[2];
if (!archivo || archivo.startsWith('--')) { console.error('Falta el archivo de respaldo'); process.exit(1); }
const antes = JSON.parse(readFileSync(archivo, 'utf8'));

await enTransaccion('revertir', async (c) => {
  const mario = await idSuperadmin(c);
  if (antes.administradores_plataforma) {
    for (const s of antes.administradores_plataforma) {
      await c.query('UPDATE administradores_plataforma SET activo = $2 WHERE id = $1', [s.id, s.activo]);
    }
    for (const u of antes.usuarios) {
      await c.query('UPDATE usuarios SET activo = $2, sesiones_invalidas_antes = $3 WHERE id = $1',
        [u.id, u.activo, u.sesiones_invalidas_antes]);
    }
    console.log(`restaurados ${antes.usuarios.length} usuarios y ${antes.administradores_plataforma.length} superadmin(s)`);
    await auditar(c, mario, 'revertir_contencion_cuentas_prueba', { contexto: { archivo } });
  } else if (antes.membresias) {
    await c.query('UPDATE usuarios SET negocio_id = $2 WHERE id = $1', [antes.usuario.id, antes.usuario.negocio_id]);
    const ids = antes.membresias.map(m => m.id);
    for (const m of antes.membresias) {
      await c.query('UPDATE usuario_negocios SET rol = $2, activo = $3 WHERE id = $1', [m.id, m.rol, m.activo]);
    }
    const { rowCount } = await c.query(
      'DELETE FROM usuario_negocios WHERE usuario_id = $1 AND NOT (id = ANY($2::uuid[]))', [antes.usuario.id, ids]);
    console.log(`restauradas ${ids.length} membresías; borradas ${rowCount} creadas por el 02`);
    await auditar(c, mario, 'revertir_mover_superadmin', { usuarioId: antes.usuario.id, contexto: { archivo } });
  } else {
    throw new Error('el archivo no es un respaldo del 01 ni del 02');
  }
});
