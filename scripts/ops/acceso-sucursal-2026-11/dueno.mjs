// Deja UNA cuenta con correo como administradora de varias sucursales (la del
// dueño), para que al entrar elija sucursal y dentro del panel la cambie con el
// botón de la cabecera. Las cuentas de cada sucursal (las encargadas) no se
// tocan aquí: para quitarle a una cuenta una sucursal que se le dio con
// acceso.mjs, se usa `acceso.mjs revertir --desde=<su respaldo>`.
//
//   node scripts/ops/acceso-sucursal-2026-11/dueno.mjs estado --correos=<correo>,<correo>,...
//   node scripts/ops/acceso-sucursal-2026-11/dueno.mjs dar --correo=<correo> --sucursales=<slug>,<slug>            (simulacro)
//   node scripts/ops/acceso-sucursal-2026-11/dueno.mjs dar --correo=<correo> --sucursales=<slug>,<slug> --aplicar
//   node scripts/ops/acceso-sucursal-2026-11/dueno.mjs revertir --desde=<respaldo.json> [--aplicar]
//
// Si la cuenta todavía no existe, `dar` se niega, salvo con
//   --crear --nombre="<nombre>" --autoriza=<correo de un administrador de la primera sucursal>
// que la crea SIN contraseña y deja una invitación de 24 h: con --aplicar
// imprime UNA vez la liga /crear-password?token=… para que el dueño elija su
// contraseña (la misma pantalla de las invitaciones de Superadmin). La liga no
// se guarda en ningún archivo: si se pierde o caduca, se revierte y se repite.
//
// SIMULACRO por omisión (la transacción termina en ROLLBACK). Con --aplicar se
// escribe ANTES del COMMIT un respaldo en --respaldo=<dir> (por omisión
// C:/xabor-respaldos/acceso-sucursal-2026-11) con el estado anterior de cada
// membresía, y `revertir --desde=` deja exactamente eso: borra las membresías
// que no existían, regresa rol y estado a las que sí, y una cuenta que creó
// este guion la borra (o la apaga, si ya tiene historia que la referencia).
import pg from 'pg';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const valor = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3).trim();
const comando = argv.find((a) => !a.startsWith('--')) || 'estado';
const aplicar = argv.includes('--aplicar');
const crear = argv.includes('--crear');
const respaldoDir = valor('respaldo') || 'C:/xabor-respaldos/acceso-sucursal-2026-11';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const lista = (k) => valor(k).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

if (!['estado', 'dar', 'revertir'].includes(comando)) {
  console.error(`Comando desconocido: ${comando}. Usa estado | dar | revertir`);
  process.exit(2);
}
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL requerida'); process.exit(2); }

const host = new URL(process.env.DATABASE_URL).hostname;
const local = ['localhost', '127.0.0.1', '::1'].includes(host);
console.log(`[dueno] base: ${host}${local ? ' (local)' : ''} · ${comando}${aplicar ? ' --aplicar' : comando === 'estado' ? '' : ' (SIMULACRO)'}`);
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });
await c.connect();

const cuentaPorCorreo = async (correo) => (await c.query(
  `SELECT u.id, u.nombre, u.email, u.activo, (u.password_hash IS NOT NULL) AS con_password,
          (to_jsonb(u) ->> 'pin_autorizacion_hash') IS NOT NULL AS con_pin, n.nombre AS base
     FROM usuarios u LEFT JOIN negocios n ON n.id = u.negocio_id
    WHERE lower(u.email) = lower($1)`, [correo])).rows[0] || null;

const membresias = async (usuarioId) => (await c.query(
  `SELECT n.id, n.nombre, n.slug, n.activo AS negocio_activo, un.rol, un.activo
     FROM usuario_negocios un JOIN negocios n ON n.id = un.negocio_id
    WHERE un.usuario_id = $1 ORDER BY n.nombre`, [usuarioId])).rows;

// La misma regla que el botón de cambio de sucursal (services/cambioSucursal.js).
const puedeEntrarA = async (usuarioId) => (await c.query(
  `SELECT n.nombre, un.rol FROM usuario_negocios un
     JOIN negocios n ON n.id = un.negocio_id JOIN usuarios u ON u.id = un.usuario_id
    WHERE un.usuario_id = $1 AND un.activo AND n.activo AND u.activo AND un.rol IN ('admin','staff')
    ORDER BY n.nombre`, [usuarioId])).rows.map((r) => `${r.nombre} (${r.rol})`);

async function imprimirCuenta(correo) {
  const u = await cuentaPorCorreo(correo);
  if (!u) { console.log(`\n${correo}: NO EXISTE`); return; }
  console.log(`\n${u.email} · «${u.nombre}» · ${u.activo ? 'activa' : 'APAGADA'} · ${u.con_password ? 'con contraseña' : 'SIN contraseña'}${u.con_pin ? ' · con clave de autorización' : ''} · creada en ${u.base || '—'} · id ${u.id.slice(0, 8)}`);
  const ms = await membresias(u.id);
  if (!ms.length) console.log('    (sin membresías)');
  for (const m of ms) console.log(`    - ${m.nombre} [${m.slug}]: ${m.rol}${m.activo ? '' : ' (membresía apagada)'}${m.negocio_activo ? '' : ' (sucursal apagada)'}`);
  const entra = await puedeEntrarA(u.id);
  console.log(`    Al entrar: ${entra.length > 1 ? `elige entre ${entra.join(', ')} y ve el botón de cambio` : entra.length === 1 ? `entra directo a ${entra[0]} (sin botón)` : 'no puede entrar al panel'}`);
}

let salida = 0;
try {
  if (comando === 'estado') {
    const correos = lista('correos');
    if (!correos.length || correos.some((x) => !EMAIL.test(x))) throw new Error('--correos=<correo>,<correo> requerido');
    await c.query('BEGIN READ ONLY');
    for (const correo of correos) await imprimirCuenta(correo);
    await c.query('ROLLBACK');
  } else if (comando === 'dar') {
    const correo = valor('correo').toLowerCase();
    const slugs = lista('sucursales');
    if (!EMAIL.test(correo)) throw new Error('--correo=<correo> requerido');
    if (!slugs.length || slugs.some((s) => !SLUG.test(s))) throw new Error('--sucursales=<slug>,<slug> requerido');
    await c.query('BEGIN');
    const sucursales = [];
    for (const slug of slugs) {
      const { rows: [n] } = await c.query(`SELECT id, nombre, slug, activo FROM negocios WHERE slug = $1`, [slug]);
      if (!n) throw new Error(`No existe la sucursal ${slug}`);
      if (!n.activo) throw new Error(`La sucursal ${n.nombre} está apagada`);
      sucursales.push(n);
    }
    let u = await cuentaPorCorreo(correo);
    let creada = false, ligaInvitacion = null;
    if (!u) {
      if (!crear) {
        throw new Error(`No existe una cuenta con ${correo}. Créala en el panel (Usuarios, con tu contraseña) y repite, `
          + 'o repite con --crear --nombre="<nombre>" --autoriza=<correo de un administrador de la primera sucursal>');
      }
      const nombre = valor('nombre');
      if (!nombre || nombre.length > 120) throw new Error('--nombre="<nombre>" requerido con --crear');
      const autoriza = await cuentaPorCorreo(valor('autoriza'));
      const esAdmin = autoriza && autoriza.activo && (await c.query(
        `SELECT 1 FROM usuario_negocios WHERE usuario_id = $1 AND negocio_id = $2 AND rol = 'admin' AND activo`,
        [autoriza.id, sucursales[0].id])).rowCount === 1;
      if (!esAdmin) throw new Error(`--autoriza debe ser un administrador activo de ${sucursales[0].nombre}`);
      const { rows: [nuevo] } = await c.query(
        `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1, $2, $3, NULL) RETURNING id`,
        [sucursales[0].id, nombre, correo]);
      // Invitación como las de Superadmin: solo se guarda el hash del token.
      const token = randomBytes(32).toString('base64url');
      await c.query(
        `INSERT INTO invitaciones_usuario (usuario_id, negocio_id, tipo, token_hash, expires_at, created_by)
         VALUES ($1, $2, 'crear_password_inicial', $3, NOW() + interval '24 hours', $4)`,
        [nuevo.id, sucursales[0].id, createHash('sha256').update(token).digest('hex'), autoriza.id]);
      ligaInvitacion = `${process.env.PUBLIC_URL || 'https://xabor.mx'}/crear-password?token=${token}`;
      creada = true;
      u = await cuentaPorCorreo(correo);
      console.log(`Cuenta NUEVA: ${correo} «${nombre}» (sin contraseña hasta usar la liga), autoriza ${autoriza.email}`);
    } else {
      console.log(`Cuenta: ${u.email} «${u.nombre}»${u.activo ? '' : ' (APAGADA)'}`);
      if (!u.activo) throw new Error('La cuenta está apagada: no se le da acceso');
      if (!u.con_password) console.log('Aviso: la cuenta todavía no tiene contraseña (invitación pendiente).');
    }
    console.log(`Puede entrar hoy a: ${(await puedeEntrarA(u.id)).join(', ') || '(ninguna)'}`);
    const cambios = [];
    for (const n of sucursales) {
      const { rows: [previa] } = await c.query(
        `SELECT rol, activo FROM usuario_negocios WHERE usuario_id = $1 AND negocio_id = $2`, [u.id, n.id]);
      if (previa && previa.rol === 'mesero') throw new Error(`En ${n.nombre} la cuenta es de mesero: no se convierte en administradora`);
      if (previa && previa.rol === 'admin' && previa.activo) { console.log(`  ${n.nombre}: ya es administradora`); continue; }
      await c.query(
        `INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1, $2, 'admin', true)
         ON CONFLICT (usuario_id, negocio_id) DO UPDATE SET rol = 'admin', activo = true`, [u.id, n.id]);
      console.log(`  ${n.nombre}: ${previa ? `${previa.rol}${previa.activo ? '' : ' (apagada)'}` : 'sin membresía'} → admin`);
      cambios.push({ negocio: n.id, nombre: n.nombre, antes: previa || null });
    }
    console.log(`Podrá entrar a: ${(await puedeEntrarA(u.id)).join(', ')}`);
    if (u.con_pin) console.log('Aviso: su clave de autorización valdrá en todas esas sucursales.');
    if (!cambios.length && !creada) {
      console.log('No hay nada que cambiar.');
      await c.query('ROLLBACK');
    } else if (aplicar) {
      mkdirSync(respaldoDir, { recursive: true });
      const archivo = join(respaldoDir, `dueno-${u.id.slice(0, 8)}-${Date.now()}.json`);
      // El respaldo se escribe ANTES del COMMIT: si no se puede guardar, no se cambia nada.
      writeFileSync(archivo, JSON.stringify({ usuario: u.id, correo: u.email, creada, cambios, en: new Date().toISOString() }, null, 2));
      await c.query('COMMIT');
      console.log(`APLICADO. Respaldo: ${archivo}`);
      if (ligaInvitacion) {
        console.log('\nLiga para elegir la contraseña (vale 24 h, un solo uso; no la compartas):');
        console.log(ligaInvitacion);
      }
    } else {
      await c.query('ROLLBACK');
      console.log('SIMULACRO: no se cambió nada. Para aplicarlo, repite con --aplicar.');
    }
  } else {
    const desde = valor('desde');
    if (!desde) throw new Error('revertir necesita --desde=<archivo de respaldo que dejó dar --aplicar>');
    const { usuario, correo, creada, cambios } = JSON.parse(readFileSync(desde, 'utf8'));
    if (!usuario || !Array.isArray(cambios)) throw new Error('El respaldo no es de este guion');
    await c.query('BEGIN');
    console.log(`Cuenta: ${correo} (${usuario.slice(0, 8)})`);
    for (const k of cambios) {
      if (!k.antes) {
        const r = await c.query(`DELETE FROM usuario_negocios WHERE usuario_id = $1 AND negocio_id = $2 AND rol = 'admin'`, [usuario, k.negocio]);
        console.log(`  ${k.nombre}: se quita la membresía (${r.rowCount} fila)`);
      } else {
        await c.query(`UPDATE usuario_negocios SET rol = $3, activo = $4 WHERE usuario_id = $1 AND negocio_id = $2`,
          [usuario, k.negocio, k.antes.rol, k.antes.activo]);
        console.log(`  ${k.nombre}: se regresa a ${k.antes.rol}${k.antes.activo ? '' : ' (apagada)'}`);
      }
    }
    if (creada) {
      // La cuenta la creó este guion: se borra; si ya la referencia algo
      // (bitácoras, pedidos que capturó), se apaga y se quitan sus membresías.
      await c.query('SAVEPOINT borrar_cuenta');
      try {
        await c.query(`DELETE FROM usuarios WHERE id = $1`, [usuario]);
        console.log('  La cuenta creada por el guion se borra.');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT borrar_cuenta');
        await c.query(`UPDATE usuarios SET activo = false WHERE id = $1`, [usuario]);
        await c.query(`UPDATE usuario_negocios SET activo = false WHERE usuario_id = $1`, [usuario]);
        console.log('  La cuenta ya tiene historia: se APAGA (no se borra).');
      }
    }
    await c.query(aplicar ? 'COMMIT' : 'ROLLBACK');
    console.log(aplicar ? 'REVERTIDO.' : 'SIMULACRO: no se cambió nada. Para revertir, repite con --aplicar.');
  }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`ERROR: ${e.message} (no se cambió nada)`);
  salida = 1;
} finally {
  await c.end();
}
process.exit(salida);
