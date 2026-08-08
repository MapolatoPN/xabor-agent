// Estación de meseros: acceso operativo por PIN.
//
// El mesero no tiene correo ni contraseña, así que no entra por el login
// administrativo (correo + password). Aquí se identifica con el slug de su
// negocio + su nombre + su PIN, y recibe una sesión marcada `est` que SOLO
// abre la operación de Restaurante: mesas, cuenta, consumo, modificadores y
// comandas. Todo lo demás del panel le responde 403.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4956';

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
// Cliente que conserva la cookie de sesión, como una tablet real.
function nuevaEstacion(base) {
  let cookie = null;
  return {
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    async pedir(path, { method = 'GET', body, cookieManual } = {}) {
      const h = { 'Content-Type': 'application/json' };
      const c = cookieManual !== undefined ? cookieManual : cookie;
      if (c) h['Cookie'] = c;
      const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
      const set = r.headers.get('set-cookie');
      if (set && cookieManual === undefined) {
        const val = set.split(';')[0];
        cookie = val.endsWith('=') ? null : val;
      }
      let json = null; try { json = await r.json(); } catch {}
      return { status: r.status, body: json, setCookie: set };
    },
  };
}
const fijarModulo = (negocioId, modulo, estado = 'activo') => pool.query(
  `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
   ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);

const SLUG_A = 'estacion-prueba-a', SLUG_B = 'estacion-prueba-b';
async function limpiar() {
  const { rows } = await pool.query(`SELECT id FROM negocios WHERE slug IN ($1,$2)`, [SLUG_A, SLUG_B]);
  const ids = rows.map(r => r.id);
  if (!ids.length) return;
  await pool.query(`DELETE FROM restaurante_cuenta_pagos WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`, [ids]);
  await pool.query(`DELETE FROM restaurante_cuenta_items WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`, [ids]);
  await pool.query(`DELETE FROM restaurante_cuentas WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM menu_modificadores_opciones WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM menu_modificadores_grupos WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM metodos_pago WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM configuracion WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM usuario_negocios WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM usuarios WHERE negocio_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM negocios WHERE id = ANY($1)`, [ids]);
}
await limpiar();

// Dos restaurantes con un "Juan Pérez" y el MISMO PIN: ambos válidos.
async function crearRestaurante(nombre, slug) {
  const { rows: [n] } = await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ($1,$2) RETURNING id`, [nombre, slug]);
  for (const m of ['restaurante', 'menu', 'pos', 'usuarios']) await fijarModulo(n.id, m);
  for (const [tipo, hab] of [['efectivo', true], ['terminal', true]]) {
    await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,$2,$3,0)
      ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = $3`, [n.id, tipo, hab]);
  }
  const { rows: [admin] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,'x') RETURNING id`,
    [n.id, `Admin ${nombre}`, `admin-${slug}-${Date.now()}@test.local`]);
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'admin')`, [admin.id, n.id]);
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'Cocina',TRUE,0) RETURNING id`, [n.id]);
  const { rows: [prod] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, descripcion, precio, disponible, orden)
     VALUES ($1,$2,$3,'Chilaquiles','',195,TRUE,0) RETURNING id`, [n.id, cat.id, 'CH' + Math.floor(Math.random() * 1e6).toString(36)]);
  const { rows: [g] } = await pool.query(
    `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
     VALUES ($1,$2,'Proteína',TRUE,1,1,0) RETURNING id`, [n.id, prod.id]);
  const opcion = async (nom, extra) => (await pool.query(
    `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
     VALUES ($1,$2,$3,$4,TRUE,0) RETURNING id`, [n.id, g.id, nom, extra])).rows[0].id;
  return { id: n.id, slug, admin: admin.id, producto: prod.id,
           opHuevos: await opcion('Huevos estrellados', 0), opBistec: await opcion('Bistec en Salsa', 30) };
}
const A = await crearRestaurante('Estación Prueba A', SLUG_A);
const B = await crearRestaurante('Estación Prueba B', SLUG_B);

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;
const adminCookie = (usuarioId, negocioId) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol: 'admin' }))}`;
const admin = nuevaEstacion(base);
async function crearMesero(negocio, nombre, pin) {
  const r = await admin.pedir('/api/admin/usuarios', { method: 'POST', body: { tipo: 'mesero', nombre, pin }, cookieManual: adminCookie(negocio.admin, negocio.id) });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}
const juanA = await crearMesero(A, 'Juan Pérez', '4821');
const mariaA = await crearMesero(A, 'María López', '7788');
const juanB = await crearMesero(B, 'Juan Pérez', '4821');

// ═════════ Pantalla y opciones ═════════
await t('PANTALLA', '1. /mesero/:slug se sirve y la lista de meseros solo trae los del negocio', async () => {
  const html = await (await fetch(base + '/mesero/' + SLUG_A)).text();
  assert.ok(html.includes('Acceso de meseros'), 'la estación se sirve');
  assert.ok(html.includes('/api/auth/mesero/login'), 'usa el login de meseros');
  const est = nuevaEstacion(base);
  const r = await est.pedir(`/api/auth/mesero/opciones?negocio=${SLUG_A}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.negocio, 'Estación Prueba A');
  const ids = r.body.meseros.map(m => m.id);
  assert.ok(ids.includes(juanA) && ids.includes(mariaA));
  assert.ok(!ids.includes(juanB), 'jamás meseros de otro negocio');
  assert.ok(!ids.includes(A.admin), 'los administradores no son meseros');
  const texto = JSON.stringify(r.body);
  assert.ok(!/pin|hash|email|@/i.test(texto), 'la lista no expone PIN, hash ni correos');
});
await t('PANTALLA', '2. un slug inexistente responde igual que un restaurante no disponible', async () => {
  const est = nuevaEstacion(base);
  const r = await est.pedir('/api/auth/mesero/opciones?negocio=no-existe-este-negocio');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.code, 'RESTAURANTE_NO_DISPONIBLE');
});

// ═════════ Login ═════════
const juan = nuevaEstacion(base);
await t('LOGIN', '3. mesero sin correo entra con su PIN y recibe sesión de estación', async () => {
  const r = await juan.pedir('/api/auth/mesero/login', { method: 'POST', body: { negocio: SLUG_A, meseroUsuarioId: juanA, pin: '4821' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.mesero.nombre, 'Juan Pérez');
  assert.ok(/HttpOnly/i.test(r.setCookie || ''), 'cookie HttpOnly');
  assert.ok(/SameSite=Lax/i.test(r.setCookie || ''), 'cookie SameSite');
  assert.ok(!/4821/.test(JSON.stringify(r.body)), 'el PIN no vuelve en la respuesta');
});
await t('LOGIN', '4. PIN incorrecto, mesero inexistente y mesero de otro negocio dan el MISMO 401', async () => {
  const casos = [
    { nombre: 'PIN incorrecto', body: { negocio: SLUG_A, meseroUsuarioId: juanA, pin: '0000' } },
    { nombre: 'usuario inexistente', body: { negocio: SLUG_A, meseroUsuarioId: '11111111-1111-4111-8111-111111111111', pin: '4821' } },
    { nombre: 'mesero de otro negocio', body: { negocio: SLUG_A, meseroUsuarioId: juanB, pin: '4821' } },
    { nombre: 'admin (no es mesero)', body: { negocio: SLUG_A, meseroUsuarioId: A.admin, pin: '4821' } },
  ];
  for (const c of casos) {
    const est = nuevaEstacion(base);
    const r = await est.pedir('/api/auth/mesero/login', { method: 'POST', body: c.body });
    assert.strictEqual(r.status, 401, `${c.nombre} debía dar 401`);
    assert.strictEqual(r.body.error, 'Mesero o PIN incorrecto', `${c.nombre}: mensaje genérico`);
    assert.strictEqual(est.cookie, null, `${c.nombre}: sin sesión`);
  }
});
await t('LOGIN', '5. el PIN NO sirve en el login administrativo', async () => {
  const est = nuevaEstacion(base);
  const r = await est.pedir('/api/auth/negocio/login', { method: 'POST', body: { email: null, password: '4821' } });
  assert.ok([400, 401].includes(r.status), `el login de correo no acepta meseros (dio ${r.status})`);
  assert.strictEqual(est.cookie, null);
});
await t('LOGIN', '6. restaurante apagado y negocio suspendido bloquean el acceso con mensaje operativo', async () => {
  await fijarModulo(A.id, 'restaurante', 'suspendido');
  const est = nuevaEstacion(base);
  const r = await est.pedir('/api/auth/mesero/login', { method: 'POST', body: { negocio: SLUG_A, meseroUsuarioId: juanA, pin: '4821' } });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.code, 'RESTAURANTE_NO_DISPONIBLE');
  await fijarModulo(A.id, 'restaurante', 'activo');

  await pool.query(`UPDATE negocios SET activo = FALSE WHERE id = $1`, [A.id]);
  const r2 = await nuevaEstacion(base).pedir('/api/auth/mesero/login', { method: 'POST', body: { negocio: SLUG_A, meseroUsuarioId: juanA, pin: '4821' } });
  assert.strictEqual(r2.status, 403, 'negocio inactivo bloquea el acceso operativo');
  await pool.query(`UPDATE negocios SET activo = TRUE WHERE id = $1`, [A.id]);
});
await t('LOGIN', '7. hay freno a la prueba de PINs (rate limit por IP y negocio)', async () => {
  // Se tantea contra un slug de prueba: el freno es por (IP, negocio), así que
  // así no se deja bloqueado a un restaurante que la suite sigue usando.
  let bloqueado = false;
  for (let i = 0; i < 25 && !bloqueado; i++) {
    const r = await nuevaEstacion(base).pedir('/api/auth/mesero/login', { method: 'POST', body: { negocio: 'estacion-tanteo-pin', meseroUsuarioId: juanB, pin: '0000' } });
    if (r.status === 429) bloqueado = true;
  }
  assert.ok(bloqueado, 'el tanteo repetido debe frenarse');
  // El freno es por negocio: otro restaurante sigue operando.
  const otro = await nuevaEstacion(base).pedir(`/api/auth/mesero/opciones?negocio=${SLUG_A}`);
  assert.strictEqual(otro.status, 200, 'un negocio no puede dejar sin servicio a otro');
});

// ═════════ Permisos ═════════
await t('PERMISOS', '8. la sesión de mesero opera mesas pero no toca administración', async () => {
  const mesas = await juan.pedir('/api/restaurante/mesas');
  assert.strictEqual(mesas.status, 200, JSON.stringify(mesas.body));
  assert.ok(Array.isArray(mesas.body.mesas));
  const menu = await juan.pedir('/api/menu');
  assert.strictEqual(menu.status, 200, 'necesita el menú para tomar la orden');

  for (const ruta of ['/api/admin/usuarios', '/api/config/pagos', '/api/admin/integraciones/pagos', '/api/superadmin/negocios', '/api/ventas']) {
    const r = await juan.pedir(ruta);
    assert.ok([401, 403].includes(r.status), `${ruta} debía cerrarse para un mesero (dio ${r.status})`);
  }
  const editarMenu = await juan.pedir('/api/admin/menu/categorias', { method: 'POST', body: { nombre: 'Hackeada' } });
  assert.ok([401, 403].includes(editarMenu.status), `un mesero no edita el menú (dio ${editarMenu.status})`);
});

// ═════════ Operación ═════════
let cuentaJuan = null;
await t('OPERACION', '9. abre mesa y queda asignada automáticamente al mesero autenticado', async () => {
  const r = await juan.pedir('/api/restaurante/mesas/abrir', { method: 'POST', body: { mesa: 1, personas: 2 } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  cuentaJuan = r.body.cuenta.id;
  const { rows } = await pool.query(`SELECT mesero_usuario_id, abierta_por, negocio_id FROM restaurante_cuentas WHERE id = $1`, [cuentaJuan]);
  assert.strictEqual(rows[0].mesero_usuario_id, juanA, 'sin volver a preguntar quién es');
  assert.strictEqual(rows[0].abierta_por, juanA);
  assert.strictEqual(rows[0].negocio_id, A.id);
});
await t('OPERACION', '10. no puede abrir a nombre de otro mesero aunque lo intente', async () => {
  const r = await juan.pedir('/api/restaurante/mesas/abrir', { method: 'POST', body: { mesa: 9, personas: 2, meseroUsuarioId: mariaA, pin: '7788' } });
  assert.strictEqual(r.status, 201, 'la mesa se abre…');
  const { rows } = await pool.query(`SELECT mesero_usuario_id FROM restaurante_cuentas WHERE id = $1`, [r.body.cuenta.id]);
  assert.strictEqual(rows[0].mesero_usuario_id, juanA, '…pero siempre a nombre de quien inició sesión');
});
await t('OPERACION', '11. agrega Chilaquiles con modificadores: el extra lo cobra el servidor', async () => {
  const r = await juan.pedir(`/api/restaurante/cuentas/${cuentaJuan}/items`, { method: 'POST', body: { items: [
    { producto_id: A.producto, cantidad: 1, precio_unitario: 1, modificadores: [A.opBistec] },
  ] } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const c = await juan.pedir(`/api/restaurante/cuentas/${cuentaJuan}`);
  assert.strictEqual(c.body.total, 225, '195 + 30 del bistec');
  assert.ok(c.body.items[0].modificadores.some(m => /Bistec en Salsa/.test(m)));
});
await t('OPERACION', '12. una selección inválida se rechaza igual que en el panel', async () => {
  const r = await juan.pedir(`/api/restaurante/cuentas/${cuentaJuan}/items`, { method: 'POST', body: { items: [{ producto_id: A.producto, cantidad: 1 }] } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'GRUPO_REQUERIDO');
});
await t('OPERACION', '13. envía la comanda y queda a nombre del mesero, con su selección', async () => {
  const r = await juan.pedir(`/api/restaurante/cuentas/${cuentaJuan}/comanda`, { method: 'POST' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.mesero, 'Juan Pérez');
  assert.strictEqual(r.body.mesa, 1);
  const texto = JSON.stringify(r.body.items);
  assert.match(texto, /Bistec en Salsa/);
});
await t('OPERACION', '14. el cobro y el cierre NO cambian de contrato: siguen fuera de la estación', async () => {
  const pago = await juan.pedir(`/api/restaurante/cuentas/${cuentaJuan}/pagos`, { method: 'POST', body: { metodo: 'efectivo', monto: 225 } });
  assert.ok([401, 403].includes(pago.status), `cobrar no es del mesero en este MVP (dio ${pago.status})`);
  const cerrar = await juan.pedir(`/api/restaurante/cuentas/${cuentaJuan}/cerrar`, { method: 'POST' });
  assert.ok([401, 403].includes(cerrar.status), `cerrar tampoco (dio ${cerrar.status})`);
  // Y el admin del negocio sí puede, como siempre.
  const admOk = await admin.pedir(`/api/restaurante/cuentas/${cuentaJuan}/pagos`, { method: 'POST', body: { metodo: 'efectivo', monto: 225 }, cookieManual: adminCookie(A.admin, A.id) });
  assert.strictEqual(admOk.status, 200, JSON.stringify(admOk.body));
});

// ═════════ Multi-tenant ═════════
await t('TENANT', '15. la sesión de A no ve ni toca nada de B', async () => {
  const juanEnB = nuevaEstacion(base);
  const login = await juanEnB.pedir('/api/auth/mesero/login', { method: 'POST', body: { negocio: SLUG_B, meseroUsuarioId: juanB, pin: '4821' } });
  assert.strictEqual(login.status, 200, 'el Juan de B entra con el mismo PIN');
  const mesaB = await juanEnB.pedir('/api/restaurante/mesas/abrir', { method: 'POST', body: { mesa: 1, personas: 2 } });
  assert.strictEqual(mesaB.status, 201);

  const cuentaAjena = await juan.pedir(`/api/restaurante/cuentas/${mesaB.body.cuenta.id}`);
  assert.strictEqual(cuentaAjena.status, 404, 'una cuenta de B no existe para la sesión de A');
  const itemsAjenos = await juan.pedir(`/api/restaurante/cuentas/${mesaB.body.cuenta.id}/items`, { method: 'POST', body: { items: [{ producto: 'X', cantidad: 1, precio_unitario: 10 }] } });
  assert.ok([403, 404].includes(itemsAjenos.status));
  const productoAjeno = await juan.pedir(`/api/restaurante/cuentas/${cuentaJuan}/items`, { method: 'POST', body: { items: [{ producto_id: B.producto, cantidad: 1, modificadores: [B.opHuevos] }] } });
  assert.strictEqual(productoAjeno.status, 400);
  assert.strictEqual(productoAjeno.body.code, 'PRODUCTO_AJENO');
  const { rows } = await pool.query(`SELECT COUNT(*)::int c FROM restaurante_cuentas WHERE negocio_id = $1 AND mesero_usuario_id = $2`, [B.id, juanA]);
  assert.strictEqual(rows[0].c, 0, 'ninguna cuenta de B quedó a nombre del mesero de A');
});

// ═════════ Tablet compartida ═════════
await t('TABLET', '16. Juan entra, opera y sale; María entra después sin heredar su sesión', async () => {
  const tablet = nuevaEstacion(base);
  await tablet.pedir('/api/auth/mesero/login', { method: 'POST', body: { negocio: SLUG_A, meseroUsuarioId: juanA, pin: '4821' } });
  const m3 = await tablet.pedir('/api/restaurante/mesas/abrir', { method: 'POST', body: { mesa: 3, personas: 2 } });
  assert.strictEqual(m3.status, 201);
  await tablet.pedir(`/api/restaurante/cuentas/${m3.body.cuenta.id}/items`, { method: 'POST', body: { items: [{ producto_id: A.producto, cantidad: 1, modificadores: [A.opHuevos] }] } });
  await tablet.pedir(`/api/restaurante/cuentas/${m3.body.cuenta.id}/comanda`, { method: 'POST' });

  const salida = await tablet.pedir('/api/auth/mesero/logout', { method: 'POST' });
  assert.strictEqual(salida.status, 200);
  const despues = await tablet.pedir('/api/restaurante/mesas');
  assert.ok([401, 403].includes(despues.status), `tras salir no queda acceso (dio ${despues.status})`);

  await tablet.pedir('/api/auth/mesero/login', { method: 'POST', body: { negocio: SLUG_A, meseroUsuarioId: mariaA, pin: '7788' } });
  const m4 = await tablet.pedir('/api/restaurante/mesas/abrir', { method: 'POST', body: { mesa: 4, personas: 3 } });
  assert.strictEqual(m4.status, 201);

  const { rows } = await pool.query(
    `SELECT mesa_numero, mesero_usuario_id FROM restaurante_cuentas WHERE negocio_id = $1 AND mesa_numero IN (3,4) ORDER BY mesa_numero`, [A.id]);
  assert.strictEqual(rows[0].mesero_usuario_id, juanA, 'Mesa 3 es de Juan');
  assert.strictEqual(rows[1].mesero_usuario_id, mariaA, 'Mesa 4 es de María, sin contaminación');
});

// ═════════ Revocación en caliente ═════════
await t('REVOCACION', '17. desactivar al mesero corta su sesión abierta en el siguiente request', async () => {
  const est = nuevaEstacion(base);
  await est.pedir('/api/auth/mesero/login', { method: 'POST', body: { negocio: SLUG_A, meseroUsuarioId: mariaA, pin: '7788' } });
  assert.strictEqual((await est.pedir('/api/restaurante/mesas')).status, 200);
  await pool.query(`UPDATE usuario_negocios SET activo = FALSE WHERE usuario_id = $1`, [mariaA]);
  const r = await est.pedir('/api/restaurante/mesas');
  assert.strictEqual(r.status, 403, 'la cookie sigue firmada, pero el mesero ya no está activo');
  assert.strictEqual(r.body.code, 'MESERO_NO_VIGENTE');
  await pool.query(`UPDATE usuario_negocios SET activo = TRUE WHERE usuario_id = $1`, [mariaA]);
});
await t('REVOCACION', '18. apagar Restaurante corta la operación de una sesión ya abierta', async () => {
  await fijarModulo(A.id, 'restaurante', 'suspendido');
  const r = await juan.pedir('/api/restaurante/mesas');
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.code, 'RESTAURANTE_NO_DISPONIBLE');
  await fijarModulo(A.id, 'restaurante', 'activo');
  assert.strictEqual((await juan.pedir('/api/restaurante/mesas')).status, 200, 'al reactivar vuelve a operar');
});

// ═════════ Panel y soporte intactos ═════════
await t('COMPATIBILIDAD', '19. el admin del negocio sigue operando con su sesión de siempre', async () => {
  const r = await admin.pedir('/api/restaurante/mesas', { cookieManual: adminCookie(A.admin, A.id) });
  assert.strictEqual(r.status, 200);
  const sel = await admin.pedir('/api/restaurante/meseros', { cookieManual: adminCookie(A.admin, A.id) });
  assert.strictEqual(sel.body.sesionMesero, false, 'el panel sigue eligiendo mesero explícitamente');
  assert.strictEqual(sel.body.sugerido, A.admin);
});
await t('COMPATIBILIDAD', '20. quien no pertenece al negocio no opera ni queda como mesero', async () => {
  const ajeno = await admin.pedir('/api/restaurante/mesas', { cookieManual: adminCookie(B.admin, A.id) });
  assert.strictEqual(ajeno.status, 403, 'un admin de B no opera A');
});
await t('COMPATIBILIDAD', '21. la UI de mesas se adapta a la sesión de estación sin duplicar lógica', async () => {
  const html = await (await fetch(base + '/mesas.html')).text();
  assert.ok(html.includes('sesionMesero'), 'reconoce la sesión de estación');
  assert.ok(html.includes('salirMesero'), 'ofrece cerrar turno');
  assert.ok(html.includes('modificadores.js'), 'mismo modal de modificadores que POS');
  assert.ok(html.includes('/api/restaurante/mesas'), 'mismas rutas de operación');
  const estacion = await (await fetch(base + '/mesero/' + SLUG_A)).text();
  assert.ok(estacion.includes('viewport'), 'la estación es usable en celular');
  assert.ok(!/panel|Superadmin|Configuración/i.test(estacion.replace(/\/panel\//g, '')), 'no ofrece navegación administrativa');
});
await t('SEGURIDAD', '22. ni el PIN ni su hash aparecen en ninguna respuesta de la estación', async () => {
  const respuestas = [
    await juan.pedir('/api/restaurante/mesas'),
    await juan.pedir(`/api/restaurante/cuentas/${cuentaJuan}`),
    await juan.pedir('/api/restaurante/meseros'),
    await nuevaEstacion(base).pedir(`/api/auth/mesero/opciones?negocio=${SLUG_A}`),
  ];
  for (const r of respuestas) {
    const texto = JSON.stringify(r.body || {});
    assert.ok(!/pin_hash/i.test(texto), 'no expone pin_hash');
    assert.ok(!/"pin"\s*:/i.test(texto), 'ninguna respuesta trae un campo pin');
    // Como valor propio, no como subcadena de un UUID cualquiera.
    assert.ok(!/"(4821|7788)"/.test(texto), 'no expone PINs');
  }
});

await limpiar();

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
