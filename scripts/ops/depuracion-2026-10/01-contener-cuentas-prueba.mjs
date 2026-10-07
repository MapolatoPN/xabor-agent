// 01 — Contención: desactiva el superadmin de prueba y TODAS las cuentas
// @test.local. Sus contraseñas están escritas en el repositorio, que es
// público, y una de ellas tenía privilegio de superadmin en producción.
//
// No borra nada. sesiones_invalidas_antes = now() corta además las cookies ya
// emitidas. Reversa: 01-contener-cuentas-prueba-REVERTIR.sql con los ids del
// archivo de respaldo.
//
//   node scripts/ops/depuracion-2026-10/01-contener-cuentas-prueba.mjs            (simulacro)
//   node scripts/ops/depuracion-2026-10/01-contener-cuentas-prueba.mjs --aplicar
import { enTransaccion, guardar, sello, idSuperadmin, auditar, SUPERADMIN_EMAIL } from './comun.mjs';

await enTransaccion('01-contener', async (c, { aplicar, respaldo }) => {
  const mario = await idSuperadmin(c);
  const usuarios = (await c.query(
    `SELECT id::text, email, activo, sesiones_invalidas_antes::text FROM usuarios
     WHERE email ILIKE '%@test.local' ORDER BY email FOR UPDATE`)).rows;
  const supers = (await c.query(
    `SELECT ap.id::text, ap.usuario_id::text, ap.activo FROM administradores_plataforma ap
     JOIN usuarios u ON u.id = ap.usuario_id WHERE u.email ILIKE '%@test.local' FOR UPDATE OF ap`)).rows;
  console.log(`cuentas @test.local: ${usuarios.length} (${usuarios.filter(u => u.activo).length} activas); superadmins @test.local: ${supers.length}`);
  for (const u of usuarios) console.log('  ', u.email, u.activo ? 'activa' : 'ya inactiva');

  const antes = { tomado_en: new Date().toISOString(), usuarios, administradores_plataforma: supers };
  if (aplicar) console.log('respaldo:', guardar(respaldo, `01-contencion-ANTES-${sello()}.json`, antes));

  const r1 = await c.query(`UPDATE administradores_plataforma SET activo = false WHERE id = ANY($1::uuid[]) AND activo`, [supers.map(s => s.id)]);
  const r2 = await c.query(`UPDATE usuarios SET activo = false, sesiones_invalidas_antes = now() WHERE id = ANY($1::uuid[]) AND activo`, [usuarios.map(u => u.id)]);
  await auditar(c, mario, 'contener_cuentas_prueba_publicas', { antes,
    despues: { usuarios_desactivados: r2.rowCount, superadmins_desactivados: r1.rowCount },
    contexto: { motivo: 'contraseñas de prueba publicadas en el repositorio público' } });

  const { rows: [v] } = await c.query(
    `SELECT (SELECT count(*)::int FROM usuarios WHERE email ILIKE '%@test.local' AND activo) AS test_activas,
            (SELECT array_agg(u.email ORDER BY u.email) FROM administradores_plataforma ap JOIN usuarios u ON u.id = ap.usuario_id
              WHERE ap.activo AND u.activo) AS superadmins`);
  console.log(`desactivados: ${r1.rowCount} superadmin(s), ${r2.rowCount} cuenta(s). Después: @test.local activas = ${v.test_activas}; superadmins = ${v.superadmins}`);
  if (v.test_activas !== 0) throw new Error('quedan cuentas @test.local activas');
  if (JSON.stringify(v.superadmins) !== JSON.stringify([SUPERADMIN_EMAIL])) throw new Error(`los superadmins no quedaron solo en ${SUPERADMIN_EMAIL}`);
});
