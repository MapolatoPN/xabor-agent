// Da a una cuenta que ya administra una sucursal el rol de administrador en
// otra sucursal del mismo dueño, sin despliegue (y lo revierte).
//
//   node scripts/ops/acceso-sucursal-2026-11/acceso.mjs estado --usuario=<uuid>
//   node scripts/ops/acceso-sucursal-2026-11/acceso.mjs dar --usuario=<uuid> --negocio=<uuid>            (simulacro)
//   node scripts/ops/acceso-sucursal-2026-11/acceso.mjs dar --usuario=<uuid> --negocio=<uuid> --aplicar
//   node scripts/ops/acceso-sucursal-2026-11/acceso.mjs revertir --desde=<respaldo.json> [--aplicar]
//
// Para qué: /temporada junta los pedidos de las sucursales que ADMINISTRA la
// misma cuenta. Una persona con una cuenta por sucursal no ve la lista junta
// hasta que una de sus cuentas sea administradora de las dos. Al entrar con
// esa cuenta, el login pregunta a qué sucursal (ya existía para quien tiene
// varias); su clave de autorización, si tiene, vale también en la otra.
//
// Solo extiende a quien YA es administrador activo de otra sucursal activa:
// no convierte en administrador a un cajero ni a una cuenta apagada.
//
// SIMULACRO por omisión (la transacción termina en ROLLBACK). Con --aplicar,
// `dar` guarda antes la membresía anterior (o que no existía) en
// --respaldo=<dir> (por omisión C:/xabor-respaldos/acceso-sucursal-2026-11), y
// `revertir --desde=` deja exactamente eso: borra la membresía si no existía o
// le regresa su rol y su estado si ya existía.
import pg from 'pg';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const valor = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3).trim();
const comando = argv.find((a) => !a.startsWith('--')) || 'estado';
const aplicar = argv.includes('--aplicar');
const respaldoDir = valor('respaldo') || 'C:/xabor-respaldos/acceso-sucursal-2026-11';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!['estado', 'dar', 'revertir'].includes(comando)) {
  console.error(`Comando desconocido: ${comando}. Usa estado | dar | revertir`);
  process.exit(2);
}
let usuario = valor('usuario'), negocio = valor('negocio'), antes;
const desde = valor('desde');
if (comando === 'revertir') {
  if (!desde) { console.error('revertir necesita --desde=<archivo de respaldo que dejó dar --aplicar>'); process.exit(2); }
  ({ usuario, negocio, antes } = JSON.parse(readFileSync(desde, 'utf8')));
}
if (!UUID.test(usuario)) { console.error('--usuario=<uuid> requerido'); process.exit(2); }
if (comando !== 'estado' && !UUID.test(negocio)) { console.error('--negocio=<uuid> requerido'); process.exit(2); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL requerida'); process.exit(2); }

const host = new URL(process.env.DATABASE_URL).hostname;
const local = ['localhost', '127.0.0.1', '::1'].includes(host);
console.log(`[acceso-sucursal] base: ${host}${local ? ' (local)' : ''} · ${comando}${aplicar ? ' --aplicar' : comando === 'estado' ? '' : ' (SIMULACRO)'}`);
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });
await c.connect();

// La misma regla que /temporada (sucursalesDelAdmin): admin, membresía,
// usuario y negocio activos.
const SQL_ADMINISTRA = `
  SELECT n.nombre FROM usuario_negocios un
    JOIN negocios n ON n.id = un.negocio_id JOIN usuarios u ON u.id = un.usuario_id
   WHERE un.usuario_id = $1 AND un.rol = 'admin' AND un.activo = true AND n.activo = true AND u.activo = true
   ORDER BY n.nombre`;
const administra = async () => (await c.query(SQL_ADMINISTRA, [usuario])).rows.map((r) => r.nombre);
const membresia = async () => (await c.query(
  `SELECT rol, activo FROM usuario_negocios WHERE usuario_id = $1 AND negocio_id = $2`, [usuario, negocio])).rows[0] || null;

let salida = 0;
try {
  const { rows: [u] } = await c.query(
    `SELECT u.nombre, u.activo, n.nombre AS base, (to_jsonb(u) ->> 'pin_autorizacion_hash') IS NOT NULL AS con_pin
       FROM usuarios u LEFT JOIN negocios n ON n.id = u.negocio_id WHERE u.id = $1`, [usuario]);
  if (!u) throw new Error('No existe esa cuenta');
  console.log(`Cuenta: ${u.nombre}${u.activo ? '' : ' (APAGADA)'} · creada en ${u.base || '—'}`);
  console.log(`Administra hoy: ${(await administra()).join(', ') || '(ninguna)'}`);
  if (comando === 'estado') {
    salida = 0;
  } else {
    const { rows: [n] } = await c.query(`SELECT nombre, activo FROM negocios WHERE id = $1`, [negocio]);
    if (!n) throw new Error('No existe esa sucursal');
    console.log(`Sucursal: ${n.nombre}${n.activo ? '' : ' (APAGADA)'}`);
    await c.query('BEGIN');
    const previa = await membresia();
    console.log(`Membresía en ${n.nombre} antes: ${previa ? `${previa.rol}${previa.activo ? '' : ' (apagada)'}` : 'no existe'}`);
    if (comando === 'dar') {
      if (!u.activo) throw new Error('La cuenta está apagada: no se le da acceso');
      if (!n.activo) throw new Error('La sucursal está apagada');
      const otras = (await c.query(
        `SELECT count(*)::int AS k FROM usuario_negocios un JOIN negocios x ON x.id = un.negocio_id
          WHERE un.usuario_id = $1 AND un.negocio_id <> $2 AND un.rol = 'admin' AND un.activo AND x.activo`,
        [usuario, negocio])).rows[0].k;
      if (!otras) throw new Error('La cuenta no administra ninguna otra sucursal activa: este guion solo extiende a un administrador');
      if (previa && previa.rol === 'admin' && previa.activo) {
        console.log('Ya es administradora de esa sucursal: no hay nada que cambiar.');
        await c.query('ROLLBACK');
      } else {
        await c.query(
          `INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1, $2, 'admin', true)
           ON CONFLICT (usuario_id, negocio_id) DO UPDATE SET rol = 'admin', activo = true`, [usuario, negocio]);
        console.log(`Administrará: ${(await administra()).join(', ')}`);
        if (u.con_pin) console.log(`Aviso: su clave de autorización también valdrá en ${n.nombre}.`);
        if (aplicar) {
          mkdirSync(respaldoDir, { recursive: true });
          const archivo = join(respaldoDir, `acceso-${usuario.slice(0, 8)}-${negocio.slice(0, 8)}-${Date.now()}.json`);
          // El respaldo se escribe ANTES del COMMIT: si no se puede guardar, no se cambia nada.
          writeFileSync(archivo, JSON.stringify({ usuario, negocio, antes: previa, en: new Date().toISOString() }, null, 2));
          await c.query('COMMIT');
          console.log(`APLICADO. Respaldo: ${archivo}`);
        } else {
          await c.query('ROLLBACK');
          console.log('SIMULACRO: no se cambió nada. Para aplicarlo, repite con --aplicar.');
        }
      }
    } else {
      // revertir: deja la membresía como estaba antes de `dar`.
      if (antes === null || antes === undefined) {
        const r = await c.query(`DELETE FROM usuario_negocios WHERE usuario_id = $1 AND negocio_id = $2 AND rol = 'admin'`, [usuario, negocio]);
        console.log(`Se quita la membresía de administrador (${r.rowCount} fila).`);
      } else {
        await c.query(`UPDATE usuario_negocios SET rol = $3, activo = $4 WHERE usuario_id = $1 AND negocio_id = $2`,
          [usuario, negocio, antes.rol, antes.activo]);
        console.log(`Se regresa a ${antes.rol}${antes.activo ? '' : ' (apagada)'}.`);
      }
      console.log(`Administrará: ${(await administra()).join(', ') || '(ninguna)'}`);
      await c.query(aplicar ? 'COMMIT' : 'ROLLBACK');
      console.log(aplicar ? 'REVERTIDO.' : 'SIMULACRO: no se cambió nada. Para revertir, repite con --aplicar.');
    }
  }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`ERROR: ${e.message} (no se cambió nada)`);
  salida = 1;
} finally {
  await c.end();
}
process.exit(salida);
