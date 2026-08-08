// Microfase readiness Restaurante: el módulo existía completo en backend
// pero era invisible en Superadmin porque la lista MODULOS del frontend
// estaba hardcodeada sin 'restaurante'. Esta suite cubre:
//   - fuente única: GET /api/superadmin/modulos-disponibles incluye
//     restaurante con su etiqueta, y el HTML servido lo trae en el fallback
//   - activar/desactivar restaurante vía el PATCH existente (idempotente)
//   - requireModulo('restaurante'): 403 inactivo, 200 activo
//   - número de mesas: PUT con validación estricta 1-500 (0, >500 y
//     decimales rechazados), persistido en configuracion
//   - readiness: CONFIGURACION_PENDIENTE sin productos → LISTO con módulo
//     activo + usuario + producto
//   - seguridad: solo superadmin; admin normal y sin sesión bloqueados
// Requiere aplicar-migraciones.mjs y seed-datos-prueba.mjs ya corridos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4945';

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
async function api(base, path, { cookie, method = 'GET', body } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (cookie) h['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

const A = SEED.negocioA;
const cookieSuperadmin = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.superadminUsuarioId, negocioId: A, rol: 'admin' }))}`;
const cookieAdminA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: A, rol: 'admin' }))}`;

// Estado limpio re-ejecutable: sin fila de restaurante ni num_mesas en A.
await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id = $1 AND modulo = 'restaurante'`, [A]);
await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'restaurante_num_mesas'`, [A]);
await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre = 'Cat readiness rest'`, [A]);

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;

// ═══════════ 1-3) Fuente única + UI ═══════════
await t('FUENTE', 'GET /modulos-disponibles incluye restaurante con etiqueta, solo superadmin', async () => {
  const r = await api(base, '/api/superadmin/modulos-disponibles', { cookie: cookieSuperadmin });
  assert.strictEqual(r.status, 200);
  const rest = r.body.modulos.find(m => m.clave === 'restaurante');
  assert.ok(rest, 'restaurante debe estar en la lista');
  assert.strictEqual(rest.nombre, 'Restaurante (mesas y meseros)');
  const admin = await api(base, '/api/superadmin/modulos-disponibles', { cookie: cookieAdminA });
  assert.ok([401, 403].includes(admin.status), 'admin normal no puede leer la lista superadmin');
});
await t('UI', 'el HTML servido de superadmin trae restaurante en el fallback y el consumo de la fuente única', async () => {
  const r = await fetch(base + '/superadmin.html');
  const html = await r.text();
  assert.ok(html.includes("'restaurante'"), 'MODULOS fallback incluye restaurante');
  assert.ok(html.includes('Restaurante (mesas y meseros)'), 'etiqueta presente');
  assert.ok(html.includes('modulos-disponibles'), 'la UI consume la fuente única del backend');
  assert.ok(html.includes('dt-restaurante') && html.includes('restaurante-readiness'), 'tarjeta de readiness presente');
});

// ═══════════ 4-6) Activar / desactivar / idempotencia ═══════════
await t('ACTIVAR', 'PATCH módulos acepta restaurante=activo (fixture, dos veces = idempotente)', async () => {
  const r1 = await api(base, `/api/superadmin/negocios/${A}/modulos`, { cookie: cookieSuperadmin, method: 'PATCH', body: { modulos: { restaurante: 'activo' } } });
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
  const r2 = await api(base, `/api/superadmin/negocios/${A}/modulos`, { cookie: cookieSuperadmin, method: 'PATCH', body: { modulos: { restaurante: 'activo' } } });
  assert.strictEqual(r2.status, 200, 'activar dos veces es idempotente');
  const { rows } = await pool.query(`SELECT COUNT(*)::int c, MAX(estado) estado FROM negocio_modulos WHERE negocio_id = $1 AND modulo = 'restaurante'`, [A]);
  assert.strictEqual(rows[0].c, 1, 'una sola fila');
  assert.strictEqual(rows[0].estado, 'activo');
});
await t('MODULO', 'con restaurante ACTIVO, /api/restaurante/mesas responde 200 para el negocio', async () => {
  const r = await api(base, '/api/restaurante/mesas', { cookie: cookieAdminA });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.numMesas, 12, 'sin configurar usa el default 12');
});
await t('DESACTIVAR', 'suspendido dos veces (idempotente) y requireModulo vuelve a 403', async () => {
  // Desactivar exige que no queden mesas abiertas (guard de desactivación
  // segura). Esta prueba es sobre estados del módulo, no sobre cuentas, así
  // que se parte de un negocio sin cuentas abiertas sin importar qué haya
  // dejado otra suite antes.
  await pool.query(`DELETE FROM restaurante_cuentas WHERE negocio_id = $1 AND estado = 'abierta'`, [A]);
  for (let i = 0; i < 2; i++) {
    const r = await api(base, `/api/superadmin/negocios/${A}/modulos`, { cookie: cookieSuperadmin, method: 'PATCH', body: { modulos: { restaurante: 'suspendido' } } });
    assert.strictEqual(r.status, 200);
  }
  const bloqueado = await api(base, '/api/restaurante/mesas', { cookie: cookieAdminA });
  assert.strictEqual(bloqueado.status, 403, 'módulo suspendido debe dar 403');
  // Reactivar para el resto de la suite.
  await api(base, `/api/superadmin/negocios/${A}/modulos`, { cookie: cookieSuperadmin, method: 'PATCH', body: { modulos: { restaurante: 'activo' } } });
});
await t('VALIDA', 'módulo inexistente rechazado por el PATCH', async () => {
  const r = await api(base, `/api/superadmin/negocios/${A}/modulos`, { cookie: cookieSuperadmin, method: 'PATCH', body: { modulos: { discoteca: 'activo' } } });
  assert.strictEqual(r.status, 400);
});

// ═══════════ 9-14) Número de mesas ═══════════
await t('MESAS', 'PUT acepta 1, 12 y 500; persiste en configuracion', async () => {
  for (const n of [1, 12, 500]) {
    const r = await api(base, `/api/superadmin/negocios/${A}/restaurante-config`, { cookie: cookieSuperadmin, method: 'PUT', body: { numMesas: n } });
    assert.strictEqual(r.status, 200, `numMesas=${n}: ${JSON.stringify(r.body)}`);
  }
  const { rows } = await pool.query(`SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'restaurante_num_mesas'`, [A]);
  assert.strictEqual(rows[0].valor, '500');
  const mesas = await api(base, '/api/restaurante/mesas', { cookie: cookieAdminA });
  assert.strictEqual(mesas.body.numMesas, 500, 'listarMesas lee el valor configurado');
});
await t('MESAS', '0, 501 y decimales rechazados con 400; el valor no cambia', async () => {
  for (const n of [0, 501, 12.5, '12.5', -3, 'doce']) {
    const r = await api(base, `/api/superadmin/negocios/${A}/restaurante-config`, { cookie: cookieSuperadmin, method: 'PUT', body: { numMesas: n } });
    assert.strictEqual(r.status, 400, `numMesas=${n} debía rechazarse`);
  }
  const { rows } = await pool.query(`SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'restaurante_num_mesas'`, [A]);
  assert.strictEqual(rows[0].valor, '500', 'el valor válido anterior se conserva');
});

// ═══════════ 15-16) Readiness ═══════════
await t('READINESS', 'sin productos → CONFIGURACION_PENDIENTE con conteos correctos', async () => {
  await pool.query(`UPDATE menu_productos SET disponible = FALSE WHERE negocio_id = $1`, [A]);
  const r = await api(base, `/api/superadmin/negocios/${A}/restaurante-readiness`, { cookie: cookieSuperadmin });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.moduloEstado, 'activo');
  assert.strictEqual(r.body.productosActivos, 0);
  assert.strictEqual(r.body.estado, 'CONFIGURACION_PENDIENTE');
  assert.strictEqual(r.body.usandoDefault, false);
  assert.strictEqual(r.body.numMesas, 500);
});
await t('READINESS', 'con módulo activo + usuario + producto → LISTO; y usandoDefault se reporta al quitar la config', async () => {
  const { rows: [cat] } = await pool.query(`INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'Cat readiness rest',TRUE,0) RETURNING id`, [A]);
  await pool.query(`INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, descripcion, precio, disponible, orden) VALUES ($1,$2,'RRDY1','Producto de prueba A','',99,TRUE,0)`, [A, cat.id]);
  const listo = await api(base, `/api/superadmin/negocios/${A}/restaurante-readiness`, { cookie: cookieSuperadmin });
  assert.strictEqual(listo.body.estado, 'LISTO');
  assert.ok(listo.body.usuariosActivos >= 1);
  assert.strictEqual(listo.body.productosActivos, 1);

  await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'restaurante_num_mesas'`, [A]);
  const def = await api(base, `/api/superadmin/negocios/${A}/restaurante-readiness`, { cookie: cookieSuperadmin });
  assert.strictEqual(def.body.usandoDefault, true, 'sin configuración debe reportar default');
  assert.strictEqual(def.body.numMesas, 12);
  assert.strictEqual(def.body.estado, 'LISTO', 'el default de 12 mesas nunca bloquea el readiness');
});

// ═══════════ 7-8) Seguridad ═══════════
await t('SEGURIDAD', 'admin normal y sin sesión bloqueados en modulos / readiness / config', async () => {
  for (const [method, path, body] of [
    ['PATCH', `/api/superadmin/negocios/${A}/modulos`, { modulos: { restaurante: 'activo' } }],
    ['GET', `/api/superadmin/negocios/${A}/restaurante-readiness`, undefined],
    ['PUT', `/api/superadmin/negocios/${A}/restaurante-config`, { numMesas: 10 }],
  ]) {
    const admin = await api(base, path, { cookie: cookieAdminA, method, body });
    assert.ok([401, 403].includes(admin.status), `${method} ${path} admin normal: ${admin.status}`);
    const anon = await api(base, path, { method, body });
    assert.ok([401, 403].includes(anon.status), `${method} ${path} sin sesión: ${anon.status}`);
  }
});
await t('SEGURIDAD', 'negocio inexistente → 404 en readiness y config', async () => {
  const uuid = '00000000-0000-4000-8000-000000000000';
  const r1 = await api(base, `/api/superadmin/negocios/${uuid}/restaurante-readiness`, { cookie: cookieSuperadmin });
  assert.strictEqual(r1.status, 404);
  const r2 = await api(base, `/api/superadmin/negocios/${uuid}/restaurante-config`, { cookie: cookieSuperadmin, method: 'PUT', body: { numMesas: 10 } });
  assert.strictEqual(r2.status, 404);
});

// Limpieza: dejar A sin restaurante (como estaba) y restaurar productos.
await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id = $1 AND modulo = 'restaurante'`, [A]);
await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'restaurante_num_mesas'`, [A]);
await pool.query(`DELETE FROM menu_productos WHERE negocio_id = $1 AND codigo = 'RRDY1'`, [A]);
await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre = 'Cat readiness rest'`, [A]);
await pool.query(`UPDATE menu_productos SET disponible = TRUE WHERE negocio_id = $1`, [A]);

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
