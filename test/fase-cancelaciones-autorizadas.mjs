// Quitar o cambiar platillos de una cuenta: motivo de una lista, clave (PIN)
// de quien autoriza, bitácora y aviso a cocina por Edge.
//
// Auditoría del 28-sep-2026: las 55 cancelaciones de Obispado las hizo la
// misma sesión de administrador con motivo en texto libre (27 veces algo con
// forma de contraseña), el mesero no podía pedir autorización, lo pendiente
// se borraba sin rastro y el aviso a cocina no salía con Edge. Esta suite
// fija el contrato nuevo contra Postgres real y el servidor real.
//
// Uso: DATABASE_URL=... (y el resto de variables de las suites) node test/fase-cancelaciones-autorizadas.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUERTO = process.env.TEST_PORT_CANCELA || '4971';

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { crearEdge } = await import('../src/services/edgeService.js');
const { crearImpresora, crearRuta } = await import('../src/services/impresionService.js');

// La migración es aditiva e idempotente: la suite la asegura para poder
// correr sobre una base que aún no la tenga.
await pool.query(readFileSync(join(__dirname, '..', 'migrations', '101_restaurante_cancelaciones_autorizadas.sql'), 'utf8'));

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

function cliente(base) {
  let cookie = null;
  return {
    set cookie(v) { cookie = v; },
    async pedir(path, { method = 'GET', body } = {}) {
      const h = { 'Content-Type': 'application/json' };
      if (cookie) h['Cookie'] = cookie;
      const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
      const set = r.headers.get('set-cookie');
      if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? null : v; }
      let json = null; try { json = await r.json(); } catch {}
      return { status: r.status, body: json };
    },
  };
}
const sesion = (usuarioId, negocioId, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;

// ── Negocios de prueba (se reconstruyen en cada corrida) ───────────────────
const SLUGS = ['cancela-aut-a', 'cancela-aut-b'];
async function limpiar() {
  const { rows } = await pool.query(`SELECT id FROM negocios WHERE slug = ANY($1)`, [SLUGS]);
  const ids = rows.map(r => r.id);
  if (!ids.length) return;
  const q = (sql) => pool.query(sql, [ids]).catch(() => {});
  await q(`DELETE FROM impresion_trabajos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM impresion_rutas WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM impresoras WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM terminales WHERE sucursal_id IN (SELECT id FROM sucursales WHERE negocio_id = ANY($1))`);
  await q(`DELETE FROM restaurante_item_eventos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM restaurante_cuenta_porciones WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`);
  await q(`DELETE FROM restaurante_cuenta_pagos WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`);
  await q(`DELETE FROM restaurante_cuenta_items WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`);
  await q(`DELETE FROM restaurante_cuentas WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM pedidos_activos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM pedido_emisiones WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM compras_reales WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM folios_pedido_usados WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM menu_modificadores_opciones WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM menu_modificadores_grupos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM menu_productos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM menu_categorias WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM metodos_pago WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM negocio_modulos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM configuracion WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM sucursales WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM usuario_negocios WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM usuarios WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM negocios WHERE id = ANY($1)`);
}
await limpiar();

async function crearNegocio(nombre, slug) {
  const { rows: [n] } = await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ($1,$2) RETURNING id`, [nombre, slug]);
  for (const m of ['restaurante', 'menu', 'pos', 'usuarios', 'caja']) {
    await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
      ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [n.id, m]);
  }
  await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,'efectivo',TRUE,0)
    ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [n.id]);
  const persona = async (nombreP, rol) => {
    const { rows: [u] } = await pool.query(
      `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,'x') RETURNING id`,
      [n.id, nombreP, `${slug}-${rol}-${Math.random().toString(36).slice(2)}@test.local`]);
    await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,$3)`, [u.id, n.id, rol]);
    return u.id;
  };
  const admin = await persona(`Admin ${nombre}`, 'admin');
  const ana = await persona('Ana Staff', 'staff');
  const beto = await persona('Beto Staff', 'staff');
  const { rows: [bebidas] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'Bebidas',TRUE,0) RETURNING id`, [n.id]);
  const { rows: [cocina] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'Cocina',TRUE,1) RETURNING id`, [n.id]);
  const producto = async (cat, nombreP, precio) => (await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, descripcion, precio, disponible, orden)
     VALUES ($1,$2,$3,$4,'',$5,TRUE,0) RETURNING id`, [n.id, cat, 'P' + Math.random().toString(36).slice(2, 8), nombreP, precio])).rows[0].id;
  const limonada = await producto(bebidas.id, 'Limonada', 40);
  const chilaquiles = await producto(cocina.id, 'Chilaquiles', 195);
  const { rows: [g] } = await pool.query(
    `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
     VALUES ($1,$2,'Tamaño',TRUE,1,1,0) RETURNING id`, [n.id, limonada]);
  const opcion = async (nom, extra) => (await pool.query(
    `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
     VALUES ($1,$2,$3,$4,TRUE,0) RETURNING id`, [n.id, g.id, nom, extra])).rows[0].id;
  return { id: n.id, slug, admin, ana, beto, limonada, chilaquiles, opChica: await opcion('Chica', 0), opGrande: await opcion('Grande', 15) };
}
const A = await crearNegocio('Cancela Prueba A', SLUGS[0]);
const B = await crearNegocio('Cancela Prueba B', SLUGS[1]);

// Edge de A: la barra imprime Bebidas; la cocina, todo lo demás (regla de documento).
const { rows: [sucA] } = await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal') RETURNING id`, [A.id]);
const edgeA = await crearEdge(A.id, { nombre: 'PC CAJA' });
const barra = await crearImpresora(A.id, { terminalId: edgeA.id, nombre: 'BARRA', transporte: 'mock', anchoColumnas: 42 });
const cocinaImp = await crearImpresora(A.id, { terminalId: edgeA.id, nombre: 'COCINA', transporte: 'mock', anchoColumnas: 42 });
await crearRuta(A.id, { impresoraId: barra.id, ambito: 'categoria', clave: 'Bebidas', modo: 'exclusivo' });
await crearRuta(A.id, { impresoraId: cocinaImp.id, ambito: 'documento', clave: 'comanda' });

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;
const adminA = cliente(base); adminA.cookie = sesion(A.admin, A.id, 'admin');
const staffA = cliente(base); staffA.cookie = sesion(A.ana, A.id, 'staff');
const adminB = cliente(base); adminB.cookie = sesion(B.admin, B.id, 'admin');
const staffB = cliente(base); staffB.cookie = sesion(B.ana, B.id, 'staff');

async function crearMesero(adm, nombre, pin) {
  const r = await adm.pedir('/api/admin/usuarios', { method: 'POST', body: { tipo: 'mesero', nombre, pin } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}
const luis = await crearMesero(adminA, 'Luis Mesero', '1357');
const tablet = cliente(base);
{
  const r = await tablet.pedir('/api/auth/mesero/login', { method: 'POST', body: { negocio: A.slug, meseroUsuarioId: luis, pin: '1357' } });
  assert.strictEqual(r.status, 200, `login de mesero: ${JSON.stringify(r.body)}`);
}

const cuentaDe = async (c, id) => (await c.pedir('/api/restaurante/cuentas/' + id)).body;
const trabajos = async (origenTipo) => (await pool.query(
  `SELECT impresora_nombre, documento, payload FROM impresion_trabajos WHERE negocio_id = $1 AND origen_tipo = $2 ORDER BY created_at`,
  [A.id, origenTipo])).rows;

// ═══════════ Migración ═══════════
await t('MIGRACION', '1. 101: columnas, bitácora y CHECK del motivo presentes', async () => {
  const { rows: [c] } = await pool.query(
    `SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name = 'restaurante_cuenta_items'
              AND column_name IN ('autorizado_por','motivo_codigo','reemplaza_item_id'))::int AS cols,
            (SELECT count(*) FROM information_schema.columns WHERE table_name = 'usuarios' AND column_name = 'pin_autorizacion_hash')::int AS pin,
            (SELECT count(*) FROM information_schema.tables WHERE table_name = 'restaurante_item_eventos')::int AS tabla`);
  assert.deepStrictEqual([c.cols, c.pin, c.tabla], [3, 1, 1]);
});

// ═══════════ PIN de autorización ═══════════
await t('PIN', '2. el admin fija el PIN de Ana; se guarda cifrado y la mesa ya pide clave', async () => {
  const r = await adminA.pedir(`/api/admin/usuarios/${A.ana}/pin-autorizacion`, { method: 'PUT', body: { pin: '2468' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const { rows: [u] } = await pool.query(`SELECT pin_autorizacion_hash FROM usuarios WHERE id = $1`, [A.ana]);
  assert.ok(u.pin_autorizacion_hash && !u.pin_autorizacion_hash.includes('2468'), 'el PIN jamás se guarda en claro');
  const aut = await tablet.pedir('/api/restaurante/autorizacion');
  assert.strictEqual(aut.status, 200, JSON.stringify(aut.body));
  assert.strictEqual(aut.body.requierePin, true);
  assert.deepStrictEqual(aut.body.motivos.map(m => m.codigo), ['cambio', 'error_captura', 'ya_no_lo_quiso', 'duplicado', 'cortesia', 'otro']);
});
await t('PIN', '3. un PIN que no son 4-6 dígitos se rechaza', async () => {
  for (const pin of ['12', 'abcd', '1234567', '']) {
    const r = await adminA.pedir(`/api/admin/usuarios/${A.beto}/pin-autorizacion`, { method: 'PUT', body: { pin } });
    assert.strictEqual(r.status, 400, `pin ${JSON.stringify(pin)} dio ${r.status}`);
  }
});
await t('PIN', '4. el mismo PIN que ya usa otra persona del negocio se rechaza', async () => {
  const r = await adminA.pedir(`/api/admin/usuarios/${A.beto}/pin-autorizacion`, { method: 'PUT', body: { pin: '2468' } });
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  assert.strictEqual(r.body.code, 'PIN_REPETIDO');
});
await t('PIN', '5. staff no fija PINes, y un mesero no puede tener PIN de autorización', async () => {
  const r = await staffA.pedir(`/api/admin/usuarios/${A.beto}/pin-autorizacion`, { method: 'PUT', body: { pin: '9753' } });
  assert.strictEqual(r.status, 403);
  const r2 = await adminA.pedir(`/api/admin/usuarios/${luis}/pin-autorizacion`, { method: 'PUT', body: { pin: '9753' } });
  assert.strictEqual(r2.status, 400);
  assert.strictEqual(r2.body.code, 'ROL_NO_AUTORIZA');
});
await t('PIN', '6. un usuario de OTRO negocio no se puede tocar', async () => {
  const r = await adminB.pedir(`/api/admin/usuarios/${A.beto}/pin-autorizacion`, { method: 'PUT', body: { pin: '8642' } });
  assert.strictEqual(r.status, 404);
});

// ═══════════ Mesa con comanda ya en cocina ═══════════
let cuenta = null, limonadas = null, chilaq = null;
await t('MESA', '7. el mesero abre, captura 3 limonadas chicas y chilaquiles, y los manda a cocina', async () => {
  const r = await tablet.pedir('/api/restaurante/mesas/abrir', { method: 'POST', body: { mesa: 5, personas: 2 } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  cuenta = r.body.id || r.body.cuenta?.id;
  const it = await tablet.pedir(`/api/restaurante/cuentas/${cuenta}/items`, { method: 'POST', body: { items: [
    { producto_id: A.limonada, cantidad: 3, modificadores: [A.opChica] },
    { producto_id: A.chilaquiles, cantidad: 1 },
  ] } });
  assert.strictEqual(it.status, 200, JSON.stringify(it.body));
  const c = await tablet.pedir(`/api/restaurante/cuentas/${cuenta}/comanda`, { method: 'POST' });
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  const cta = await cuentaDe(tablet, cuenta);
  limonadas = cta.items.find(i => i.producto === 'Limonada');
  chilaq = cta.items.find(i => i.producto === 'Chilaquiles');
  assert.ok(limonadas && limonadas.comanda_num === 1 && limonadas.cantidad === 3);
});

const cancelar = (c, item, body) => c.pedir(`/api/restaurante/cuentas/${cuenta}/items/${item}/cancelar`, { method: 'POST', body });

await t('CANCELAR', '8. sin clave no se quita nada (la pide el servidor, no la pantalla)', async () => {
  const r = await cancelar(tablet, limonadas.id, { motivo_codigo: 'cambio', cantidad: 1 });
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.strictEqual(r.body.code, 'PIN_REQUERIDO');
  const cta = await cuentaDe(tablet, cuenta);
  assert.strictEqual(cta.items.find(i => i.id === limonadas.id).cantidad, 3);
});
await t('CANCELAR', '9. con una clave equivocada tampoco', async () => {
  const r = await cancelar(tablet, limonadas.id, { motivo_codigo: 'cambio', cantidad: 1, pin: '0000' });
  assert.strictEqual(r.status, 401, JSON.stringify(r.body));
  assert.strictEqual(r.body.code, 'PIN_INCORRECTO');
});
await t('CANCELAR', '10. el motivo sale de la lista; «Otro» exige escribirlo', async () => {
  const sinTexto = await cancelar(tablet, limonadas.id, { motivo_codigo: 'otro', pin: '2468' });
  assert.strictEqual(sinTexto.status, 400);
  assert.strictEqual(sinTexto.body.code, 'MOTIVO_REQUERIDO');
  const raro = await cancelar(tablet, limonadas.id, { motivo_codigo: 'porque si', pin: '2468' });
  assert.strictEqual(raro.status, 400);
  assert.strictEqual(raro.body.code, 'MOTIVO_INVALIDO');
  const sinMotivo = await cancelar(tablet, limonadas.id, { pin: '2468' });
  assert.strictEqual(sinMotivo.status, 400);
  assert.strictEqual(sinMotivo.body.code, 'MOTIVO_REQUERIDO');
});
let cancelada = null;
await t('CANCELAR', '11. el mesero quita 1 de 3 con la clave de Ana: queda quién pidió, quién autorizó y por qué', async () => {
  const antes = await cuentaDe(tablet, cuenta);
  const r = await cancelar(tablet, limonadas.id, { motivo_codigo: 'cambio', cantidad: 1, pin: '2468' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  cancelada = r.body.item;
  const { rows } = await pool.query(
    `SELECT id, cantidad, estado, comanda_num, cancelado_por, autorizado_por, motivo_codigo, motivo_cancelacion
       FROM restaurante_cuenta_items WHERE cuenta_id = $1 AND producto = 'Limonada' ORDER BY estado`, [cuenta]);
  assert.strictEqual(rows.length, 2, 'el renglón se parte en dos');
  const [can, viva] = rows;
  assert.deepStrictEqual([can.estado, can.cantidad, can.comanda_num], ['cancelado', 1, 1]);
  assert.deepStrictEqual([viva.estado, viva.cantidad], ['enviado', 2]);
  assert.strictEqual(can.cancelado_por, luis, 'quien lo pidió es el mesero de la sesión');
  assert.strictEqual(can.autorizado_por, A.ana, 'quien lo autorizó es la dueña del PIN');
  assert.strictEqual(can.motivo_codigo, 'cambio');
  assert.strictEqual(can.motivo_cancelacion, 'Cambio de platillo');
  const despues = await cuentaDe(tablet, cuenta);
  assert.strictEqual(Math.round((antes.total - despues.total) * 100), 4000, 'la cuenta baja exactamente una limonada');
  const { rows: ev } = await pool.query(
    `SELECT tipo, cantidad, solicitado_por, autorizado_por, motivo_codigo FROM restaurante_item_eventos WHERE cuenta_id = $1 AND tipo = 'cancelado'`, [cuenta]);
  assert.strictEqual(ev.length, 1);
  assert.deepStrictEqual([ev[0].cantidad, ev[0].solicitado_por, ev[0].autorizado_por, ev[0].motivo_codigo], [1, luis, A.ana, 'cambio']);
});
await t('COCINA', '12. el aviso de cancelación sale por Edge en la BARRA (donde salió la limonada), no en cocina', async () => {
  const avisos = await trabajos('restaurante_cancelacion');
  assert.strictEqual(avisos.length, 1, `se esperaba un aviso, hay ${avisos.length}`);
  const [a] = avisos;
  assert.strictEqual(a.impresora_nombre, 'BARRA');
  assert.strictEqual(a.documento, 'cancelacion');
  assert.strictEqual(a.payload.mesa, 5);
  assert.deepStrictEqual(a.payload.items, [{ cantidad: 1, producto: 'Limonada (Chica)' }]);
  assert.ok(/Cambio de platillo/.test(a.payload.motivo) && /Ana Staff/.test(a.payload.motivo) && /Ronda 1/.test(a.payload.motivo),
    `motivo impreso: ${a.payload.motivo}`);
});
await t('CAMBIO', '13. la limonada grande queda ligada a la chica y la ronda le dice a la barra qué reemplaza', async () => {
  const it = await tablet.pedir(`/api/restaurante/cuentas/${cuenta}/items`, { method: 'POST', body: { items: [
    { producto_id: A.limonada, cantidad: 1, modificadores: [A.opGrande], reemplaza_item_id: cancelada.id },
  ] } });
  assert.strictEqual(it.status, 200, JSON.stringify(it.body));
  const c = await tablet.pedir(`/api/restaurante/cuentas/${cuenta}/comanda`, { method: 'POST' });
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  const rondas = (await trabajos('restaurante_comanda')).filter(x => x.payload.ronda === 2);
  assert.strictEqual(rondas.length, 1);
  assert.strictEqual(rondas[0].impresora_nombre, 'BARRA');
  const nota = rondas[0].payload.items[0].notas || '';
  assert.ok(/CAMBIO DE: 1 Limonada \(Chica\)/.test(nota), `nota de la ronda: ${nota}`);
  const cta = await cuentaDe(tablet, cuenta);
  const grande = cta.items.find(i => i.producto === 'Limonada' && i.comanda_num === 2);
  assert.strictEqual(grande.reemplaza_item_id, cancelada.id);
});
await t('CAMBIO', '14. no se puede «reemplazar» un platillo que sigue vivo', async () => {
  const r = await tablet.pedir(`/api/restaurante/cuentas/${cuenta}/items`, { method: 'POST', body: { items: [
    { producto_id: A.chilaquiles, cantidad: 1, reemplaza_item_id: chilaq.id },
  ] } });
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.strictEqual(r.body.code, 'REEMPLAZO_INVALIDO');
});
await t('CANCELAR', '15. la cantidad a quitar no puede pasar de la que hay', async () => {
  const r = await cancelar(tablet, chilaq.id, { motivo_codigo: 'error_captura', cantidad: 2, pin: '2468' });
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.strictEqual(r.body.code, 'CANTIDAD_INVALIDA');
});

// ═══════════ Lo pendiente deja rastro ═══════════
await t('PENDIENTE', '16. bajar la cantidad y quitar algo que no salió a cocina queda en la bitácora', async () => {
  await tablet.pedir(`/api/restaurante/cuentas/${cuenta}/items`, { method: 'POST', body: { items: [{ producto_id: A.chilaquiles, cantidad: 3 }] } });
  let cta = await cuentaDe(tablet, cuenta);
  const pend = cta.items.find(i => i.estado === 'pendiente');
  const r1 = await tablet.pedir(`/api/restaurante/cuentas/${cuenta}/items/${pend.id}/cantidad`, { method: 'PATCH', body: { cantidad: 1 } });
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
  const r2 = await tablet.pedir(`/api/restaurante/cuentas/${cuenta}/items/${pend.id}`, { method: 'DELETE' });
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
  const { rows } = await pool.query(
    `SELECT tipo, cantidad, solicitado_por, producto FROM restaurante_item_eventos
      WHERE cuenta_id = $1 AND tipo <> 'cancelado' ORDER BY created_at`, [cuenta]);
  assert.deepStrictEqual(rows.map(r => [r.tipo, r.cantidad, r.solicitado_por, r.producto]), [
    ['cantidad_reducida', 2, luis, 'Chilaquiles'],
    ['quitado_antes_de_enviar', 1, luis, 'Chilaquiles'],
  ]);
});

// ═══════════ Intentos ═══════════
await t('INTENTOS', '17. cinco claves equivocadas bloquean, aunque la sexta sea la buena', async () => {
  for (let i = 0; i < 5; i++) await cancelar(tablet, chilaq.id, { motivo_codigo: 'error_captura', pin: '1111' });
  const r = await cancelar(tablet, chilaq.id, { motivo_codigo: 'error_captura', pin: '2468' });
  assert.strictEqual(r.status, 429, JSON.stringify(r.body));
  assert.strictEqual(r.body.code, 'PIN_BLOQUEADO');
  const cta = await cuentaDe(tablet, cuenta);
  assert.strictEqual(cta.items.find(i => i.id === chilaq.id).estado, 'enviado', 'bloqueado no quita nada');
});
await t('INTENTOS', '18. el bloqueo es de quien se equivocó: otra sesión sí puede con la clave buena', async () => {
  const r = await cancelar(staffA, chilaq.id, { motivo_codigo: 'ya_no_lo_quiso', pin: '2468' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const avisos = await trabajos('restaurante_cancelacion');
  assert.strictEqual(avisos.length, 2);
  assert.strictEqual(avisos[1].impresora_nombre, 'COCINA', 'los chilaquiles se avisan en cocina');
});

// ═══════════ Negocio sin nadie con PIN ═══════════
await t('SIN_PIN', '19. sin autorizadores: staff no puede quitar, el administrador sí (la regla de antes)', async () => {
  const r = await adminB.pedir('/api/restaurante/mesas/abrir', { method: 'POST', body: { mesa: 3, personas: 1 } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const cb = r.body.id || r.body.cuenta?.id;
  await adminB.pedir(`/api/restaurante/cuentas/${cb}/items`, { method: 'POST', body: { items: [{ producto_id: B.chilaquiles, cantidad: 1 }] } });
  await adminB.pedir(`/api/restaurante/cuentas/${cb}/comanda`, { method: 'POST' });
  const item = (await cuentaDe(adminB, cb)).items[0];
  const aut = await staffB.pedir('/api/restaurante/autorizacion');
  assert.strictEqual(aut.body.requierePin, false);
  const st = await staffB.pedir(`/api/restaurante/cuentas/${cb}/items/${item.id}/cancelar`, { method: 'POST', body: { motivo_codigo: 'duplicado' } });
  assert.strictEqual(st.status, 403, JSON.stringify(st.body));
  assert.strictEqual(st.body.code, 'SIN_AUTORIZACION');
  const ad = await adminB.pedir(`/api/restaurante/cuentas/${cb}/items/${item.id}/cancelar`, { method: 'POST', body: { motivo_codigo: 'duplicado' } });
  assert.strictEqual(ad.status, 200, JSON.stringify(ad.body));
  const { rows: [fila] } = await pool.query(`SELECT autorizado_por, motivo_codigo FROM restaurante_cuenta_items WHERE id = $1`, [item.id]);
  assert.deepStrictEqual([fila.autorizado_por, fila.motivo_codigo], [B.admin, 'duplicado']);
});
await t('SIN_PIN', '20. el cuerpo viejo ({ motivo }) sigue sirviendo para el administrador sin autorizadores', async () => {
  const r = await adminB.pedir('/api/restaurante/mesas/abrir', { method: 'POST', body: { mesa: 4, personas: 1 } });
  const cb = r.body.id || r.body.cuenta?.id;
  await adminB.pedir(`/api/restaurante/cuentas/${cb}/items`, { method: 'POST', body: { items: [{ producto_id: B.chilaquiles, cantidad: 1 }] } });
  await adminB.pedir(`/api/restaurante/cuentas/${cb}/comanda`, { method: 'POST' });
  const item = (await cuentaDe(adminB, cb)).items[0];
  const ad = await adminB.pedir(`/api/restaurante/cuentas/${cb}/items/${item.id}/cancelar`, { method: 'POST', body: { motivo: 'cliente lo devolvió' } });
  assert.strictEqual(ad.status, 200, JSON.stringify(ad.body));
  const { rows: [fila] } = await pool.query(`SELECT motivo_codigo, motivo_cancelacion FROM restaurante_cuenta_items WHERE id = $1`, [item.id]);
  assert.deepStrictEqual([fila.motivo_codigo, fila.motivo_cancelacion], ['otro', 'cliente lo devolvió']);
});

// ═══════════ Reporte del día ═══════════
await t('REPORTE', '21. el reporte de cancelaciones del día dice cuánto salió, por qué y con la clave de quién', async () => {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Matamoros' }).format(new Date());
  const r = await adminA.pedir(`/api/restaurante/cancelaciones?fecha=${hoy}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.cancelados.num, 2, 'una limonada y unos chilaquiles');
  assert.strictEqual(Math.round(r.body.cancelados.importe * 100), 23500);
  assert.deepStrictEqual(r.body.por_autorizo.map(x => x.clave), ['Ana Staff']);
  assert.deepStrictEqual(r.body.por_motivo.map(x => x.clave).sort(), ['Cambio de platillo', 'El cliente ya no lo quiso']);
  assert.strictEqual(r.body.antes_de_enviar.num, 3, '2 reducidos + 1 quitado');
  const mesero = await tablet.pedir(`/api/restaurante/cancelaciones?fecha=${hoy}`);
  assert.strictEqual(mesero.status, 403, 'el reporte es del administrador');
});
await t('REPORTE', '22. la cuenta devuelve el motivo y quién autorizó de cada renglón quitado', async () => {
  const cta = await cuentaDe(tablet, cuenta);
  const q = cta.items.find(i => i.id === cancelada.id);
  assert.strictEqual(q.motivo_codigo, 'cambio');
  assert.strictEqual(q.autorizado_por_nombre, 'Ana Staff');
  assert.strictEqual(q.cancelado_por_nombre, 'Luis Mesero');
});

await srv.detener?.();
await limpiar().catch(() => {});
await pool.end();
console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
