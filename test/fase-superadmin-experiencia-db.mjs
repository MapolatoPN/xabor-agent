import './entorno-superadmin-local.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES_NEGOCIOS_CONOCIDOS } from '../src/services/revisionDatosNegocios.js';
import { pool, obtenerDashboardSuperadmin, crearUsuarioConPassword } from '../src/services/database.js';
import { listarNegociosCentral, obtenerFichaNegocio } from '../src/services/centralOperaciones.js';
import { sembrarDatosPrueba } from './seed-datos-prueba.mjs';
import { cookieSuperadminCon2fa } from './lib-superadmin-2fa.mjs';
import { crearTokenSesion } from '../src/services/session.js';
import { arrancarServidor } from './lib-servidor.mjs';

let seed, srv, cookie, comercial, piloto, snapshot;
const leerDatos = async () => ({
  negocios: (await pool.query('SELECT id, nombre, slug, estado, activo, plan, checklist, implementacion FROM negocios ORDER BY id')).rows,
  permisos: (await pool.query('SELECT usuario_id, negocio_id, rol, activo FROM usuario_negocios ORDER BY usuario_id, negocio_id')).rows,
  modulos: (await pool.query('SELECT negocio_id, modulo, estado FROM negocio_modulos ORDER BY negocio_id, modulo')).rows,
  usuarios: (await pool.query('SELECT id, activo FROM usuarios ORDER BY id')).rows,
});

before(async () => {
  // Reejecutable en la misma base desechable sin duplicar usuarios globales.
  const { rows } = await pool.query(`SELECT id, slug FROM negocios WHERE slug IN ('faseb-negocio-a','faseb-negocio-b','faseb-negocio-c','faseb-negocio-d')`);
  const usuarios = (await pool.query(`SELECT id, email FROM usuarios WHERE email IN ('superadmin-faseb@test.local','admin-a-faseb@test.local','staff-a-faseb@test.local')`)).rows;
  seed = rows.length === 4 && usuarios.length === 3 ? {
    ...Object.fromEntries(rows.map(n => ['negocio' + n.slug.at(-1).toUpperCase(), n.id])),
    superadminUsuarioId: usuarios.find(u => u.email === 'superadmin-faseb@test.local').id,
    adminNegocioAUsuarioId: usuarios.find(u => u.email === 'admin-a-faseb@test.local').id,
    staffNegocioAUsuarioId: usuarios.find(u => u.email === 'staff-a-faseb@test.local').id,
  } : await sembrarDatosPrueba();
  for (const f of FIXTURES_NEGOCIOS_CONOCIDOS) await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET nombre=$1`, [f.nombre, f.slug]);
  ({ rows: [comercial] } = await pool.query(`INSERT INTO negocios (nombre,slug,plan) VALUES ('Café Demo de un cliente','qa-cafe-comercial','prueba') ON CONFLICT (slug) DO UPDATE SET nombre=EXCLUDED.nombre RETURNING id`));
  ({ rows: [piloto] } = await pool.query(`INSERT INTO negocios (nombre,slug,plan) VALUES ('Xabor Piloto Mario','xabor-piloto-mario-f896222eefe4','prueba') ON CONFLICT (slug) DO UPDATE SET nombre=EXCLUDED.nombre RETURNING id`));
  let inactivo = (await pool.query(`SELECT id FROM usuarios WHERE email = 'superadmin-ux-inactivo@ejemplo.invalid'`)).rows[0];
  if (!inactivo) inactivo = await crearUsuarioConPassword({ negocioId: comercial.id, nombre: 'Administrador inactivo QA', email: 'superadmin-ux-inactivo@ejemplo.invalid', password: 'Solo-Local-Sin-Acceso-2026!', rol: 'admin' });
  await pool.query('UPDATE usuarios SET activo=false WHERE id=$1', [inactivo.id]);
  cookie = await cookieSuperadminCon2fa({ usuarioId: seed.superadminUsuarioId, negocioId: seed.negocioA });
  srv = await arrancarServidor({ PORT: '4938', XABOR_CONCILIACION_AUTOMATICA: 'false' });
  snapshot = await leerDatos();
});
after(async () => { srv?.detener(); await pool.end(); });

test('el resumen separa las 16 pruebas, el piloto y los registros sin coincidencia', async () => {
  const d = await obtenerDashboardSuperadmin();
  assert.equal(d.resumenDatos.pruebas, 16);
  assert.equal(d.resumenDatos.pilotos, 1);
  assert.equal(d.resumenDatos.sinSenales + 17, d.totalNegocios);
  assert.equal(d.resumenDatos.accesosPruebaPlataforma, 1);
  assert(d.recientes.every(n => !FIXTURES_NEGOCIOS_CONOCIDOS.some(f => f.slug === n.slug)));
  assert(d.sinMenu.some(n => n.id === comercial.id));
  assert(!d.sinAdministrador.some(n => n.id === piloto.id));
});

test('el listado inicial mantiene todos los registros y el filtro se aplica antes de paginar', async () => {
  const todo = await listarNegociosCentral({ limit: 100 });
  assert.equal(todo.negocios.length, snapshot.negocios.length);
  const a = await listarNegociosCentral({ revision: 'prueba_tecnica', limit: 3, offset: 0 });
  const b = await listarNegociosCentral({ revision: 'prueba_tecnica', limit: 3, offset: 3 });
  assert.equal(a.total, 16);
  assert.equal(a.negocios.length, 3);
  assert(!a.negocios.some(n => b.negocios.some(o => o.id === n.id)));
  assert(a.negocios.every(n => n.revision_datos.tipo === 'prueba_tecnica'));
});

test('sin señales no oculta al cliente con plan prueba ni le cambia el plan', async () => {
  const pagina = await listarNegociosCentral({ revision: 'sin_senales', plan: 'prueba' });
  assert(pagina.negocios.some(n => n.id === comercial.id && n.plan === 'prueba'));
  assert(pagina.negocios.every(n => n.revision_datos.tipo === 'sin_senales'));
});

test('la página fuera de rango conserva el total para que la interfaz pueda volver a la última', async () => {
  const pagina = await listarNegociosCentral({ revision: 'prueba_tecnica', offset: 900 });
  assert.equal(pagina.total, 16);
  assert.deepEqual(pagina.negocios, []);
});

test('los límites y órdenes se acotan y una búsqueda no se interpreta como SQL', async () => {
  assert((await listarNegociosCentral({ limit: 9999 })).negocios.length <= 100);
  assert.equal((await listarNegociosCentral({ limit: 'Infinity', offset: 'Infinity' })).total, snapshot.negocios.length);
  assert.equal((await listarNegociosCentral({ buscar: "' OR 1=1 --", orden: 'nombre;DELETE FROM negocios' })).total, 0);
});

test('los filtros de atención y estado son acumulativos', async () => {
  const pagina = await listarNegociosCentral({ revision: 'sin_senales', atencion: 'sin_administrador', buscar: 'qa-cafe-comercial', estado: 'activo' });
  assert.equal(pagina.total, 1);
  assert.equal(pagina.negocios[0].id, comercial.id);
  assert.equal(pagina.negocios[0].admin_con_acceso, false);
  assert.equal((await obtenerFichaNegocio(comercial.id)).cuenta.admin_principal, null, 'un usuario desactivado no se muestra como administrador con acceso');
});

test('ficha y listado comparten evidencia y no exponen secretos', async () => {
  const f = await obtenerFichaNegocio(seed.negocioA);
  assert.equal(f.general.revision_datos.tipo, 'prueba_tecnica');
  assert.match(f.general.revision_datos.evidencia, /seed-datos-prueba/);
  assert.equal((await obtenerFichaNegocio(piloto.id)).general.revision_datos.tipo, 'piloto');
  for (const prohibido of ['password_hash', 'token_hash', 'secreto_cifrado']) assert(!JSON.stringify(f).includes(prohibido));
});

test('los filtros por HTTP siguen reservados al superadmin con segundo factor', async () => {
  const url = srv.base + '/api/superadmin/central/negocios?revision=prueba_tecnica&limit=2';
  assert.equal((await fetch(url)).status, 401);
  const admin = crearTokenSesion({ usuarioId: seed.adminNegocioAUsuarioId, negocioId: seed.negocioA, rol: 'admin' });
  assert.equal((await fetch(url, { headers: { Cookie: 'xabor_sesion=' + encodeURIComponent(admin) } })).status, 403);
  const superSin2fa = crearTokenSesion({ usuarioId: seed.superadminUsuarioId, negocioId: seed.negocioA, rol: 'admin' });
  assert.equal((await fetch(url, { headers: { Cookie: 'xabor_sesion=' + encodeURIComponent(superSin2fa) } })).status, 403);
  const r = await fetch(url, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  const j = await r.json(); assert.equal(j.total, 16); assert.equal(j.negocios.length, 2);
});

test('consultar resúmenes, fichas y filtros no cambia estados, permisos ni datos de los negocios', async () => {
  assert.deepEqual(await leerDatos(), snapshot);
});
