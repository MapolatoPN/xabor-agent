// 02 — Mueve a mario@xabor.mx a mapolato-obispado como admin.
//
// · Da (o reactiva) la membresía admin en Obispado y apaga la de Nonna Maye:
//   el login lo deja entrar directo a Obispado, sin selector.
// · usuarios.negocio_id (negocio "de origen", legado) pasa a Obispado.
// · La contraseña NO se toca (password_hash, pin_hash y la sesión quedan igual).
// · El privilegio de superadmin vive en administradores_plataforma, atado al
//   USUARIO: no cambia. El script aborta si, además de él, hay otro
//   superadmin activo (p. ej. obispado@mapolato.com o una cuenta de prueba):
//   correr antes el 01.
//
//   node scripts/ops/depuracion-2026-10/02-mover-superadmin-a-obispado.mjs            (simulacro)
//   node scripts/ops/depuracion-2026-10/02-mover-superadmin-a-obispado.mjs --aplicar
import { enTransaccion, guardar, sello, idSuperadmin, auditar, SUPERADMIN_EMAIL } from './comun.mjs';

await enTransaccion('02-mover', async (c, { aplicar, respaldo }) => {
  const mario = await idSuperadmin(c);
  const { rows: [obispado] } = await c.query(`SELECT id, activo FROM negocios WHERE slug = 'mapolato-obispado'`);
  const { rows: [nonna] } = await c.query(`SELECT id FROM negocios WHERE slug = 'nonna-maye'`);
  if (!obispado?.activo) throw new Error('mapolato-obispado no existe o no está activo');

  const supers = (await c.query(
    `SELECT u.email FROM administradores_plataforma ap JOIN usuarios u ON u.id = ap.usuario_id
     WHERE ap.activo AND u.activo ORDER BY 1`)).rows.map(r => r.email);
  if (JSON.stringify(supers) !== JSON.stringify([SUPERADMIN_EMAIL])) {
    throw new Error(`superadmins activos: ${supers.join(', ')} — debe ser solo ${SUPERADMIN_EMAIL}; corre antes el 01`);
  }

  const usuario = (await c.query(
    `SELECT id::text, negocio_id::text, md5(password_hash) AS huella_password FROM usuarios WHERE id = $1 FOR UPDATE`, [mario])).rows[0];
  const membresias = (await c.query(
    `SELECT un.id::text, n.slug, un.rol, un.activo FROM usuario_negocios un JOIN negocios n ON n.id = un.negocio_id
     WHERE un.usuario_id = $1 FOR UPDATE OF un`, [mario])).rows;
  const antes = { tomado_en: new Date().toISOString(), usuario: { id: usuario.id, negocio_id: usuario.negocio_id }, membresias };
  console.log('antes:', JSON.stringify(antes.membresias));
  if (aplicar) console.log('respaldo:', guardar(respaldo, `02-mover-superadmin-ANTES-${sello()}.json`, antes));

  await c.query(
    `INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1, $2, 'admin', true)
     ON CONFLICT (usuario_id, negocio_id) DO UPDATE SET rol = 'admin', activo = true`, [mario, obispado.id]);
  if (nonna) await c.query(`UPDATE usuario_negocios SET activo = false WHERE usuario_id = $1 AND negocio_id = $2`, [mario, nonna.id]);
  await c.query(`UPDATE usuarios SET negocio_id = $2 WHERE id = $1`, [mario, obispado.id]);

  const despues = (await c.query(
    `SELECT n.slug, un.rol FROM usuario_negocios un JOIN negocios n ON n.id = un.negocio_id
     WHERE un.usuario_id = $1 AND un.activo AND n.activo ORDER BY 1`, [mario])).rows;
  const { rows: [pw] } = await c.query(`SELECT md5(password_hash) AS h FROM usuarios WHERE id = $1`, [mario]);
  const { rows: [sa] } = await c.query(
    `SELECT array_agg(u.email ORDER BY u.email) AS quien FROM administradores_plataforma ap JOIN usuarios u ON u.id = ap.usuario_id
     JOIN usuario_negocios un ON un.usuario_id = u.id JOIN negocios n ON n.id = un.negocio_id
     WHERE ap.activo AND u.activo AND n.slug LIKE 'mapolato-%'`);
  console.log('después, negocios con acceso:', JSON.stringify(despues));
  console.log('superadmins con membresía en Mapolato:', JSON.stringify(sa.quien));
  if (JSON.stringify(despues) !== JSON.stringify([{ slug: 'mapolato-obispado', rol: 'admin' }])) throw new Error('la membresía final no es solo Obispado/admin');
  if (pw.h !== usuario.huella_password) throw new Error('la contraseña cambió');
  if (JSON.stringify(sa.quien) !== JSON.stringify([SUPERADMIN_EMAIL])) throw new Error('hay otro superadmin en Mapolato');

  // Impresión: si Obispado no imprime por Edge, abrir su panel (/app) en tu
  // navegador también imprimiría comandas. Solo se informa.
  // SAVEPOINT: una consulta informativa que falle no puede abortar la
  // transacción (un .catch solo no basta: Postgres ya la dio por perdida).
  await c.query('SAVEPOINT edge_info');
  let edge = {};
  try {
    ({ rows: [edge] } = await c.query(
      `SELECT count(*)::int AS n, max(e.ultima_vista)::text AS ultima
       FROM edge_instalaciones e JOIN terminales t ON t.id = e.terminal_id
       JOIN sucursales s ON s.id = t.sucursal_id WHERE s.negocio_id = $1`, [obispado.id]));
    await c.query('RELEASE SAVEPOINT edge_info');
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT edge_info');
    console.log(`(no se pudo leer el Edge: ${e.message})`);
  }
  console.log(`Edge de Obispado: ${edge.n ?? '?'} instalación(es), última vista ${edge.ultima ?? '—'}`);

  await auditar(c, mario, 'mover_superadmin_a_negocio', { negocioId: obispado.id, usuarioId: mario,
    antes, despues: { membresias: despues, negocio_id: obispado.id } });
});
