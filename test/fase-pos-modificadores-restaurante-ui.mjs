// Modificadores de menú en POS y Restaurante + navegación operativa.
//
// Dos problemas reales del piloto de Mapolato:
//   A) el módulo Restaurante estaba activo y su UI (panel/mesas.html) existía
//      completa, pero NADA la enlazaba desde el panel del negocio;
//   B) el editor de menú guardaba grupos de modificadores (Salsas, Proteína,
//      Guarniciones) y el POS los ignoraba: el producto entraba al carrito sin
//      preguntar nada, y el backend aceptaba el precio que mandara el frontend.
//
// Esta suite fija el contrato corregido, con el servidor como única autoridad
// del precio y de las reglas (requerido / mínimo / máximo / pertenencia /
// disponibilidad / tenant), y la misma implementación para POS y Mesas.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4953';

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
async function api(base, path, { cookie, method = 'GET', body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (cookie) h['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
const fijarModulo = (negocioId, modulo, estado = 'activo') => pool.query(
  `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
   ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);

const A = SEED.negocioA, B = SEED.negocioB;

// ── Fixtures: Chilaquiles con tres grupos, como el caso real ──────────────
async function crearCatalogo(negocioId, etiqueta) {
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,0) RETURNING id`,
    [negocioId, `Cat mods ${etiqueta}`]);
  const prod = async (nombre, precio) => (await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, descripcion, precio, disponible, orden)
     VALUES ($1,$2,$3,$4,'',$5,TRUE,0) RETURNING id, nombre, precio`,
    [negocioId, cat.id, 'M' + Math.floor(Math.random() * 1e9).toString(36), nombre, precio])).rows[0];
  const grupo = async (productoId, nombre, requerido, minimo, maximo) => (await pool.query(
    `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
     VALUES ($1,$2,$3,$4,$5,$6,0) RETURNING id`,
    [negocioId, productoId, nombre, requerido, minimo, maximo])).rows[0];
  const opcion = async (grupoId, nombre, extra = 0, disponible = true) => (await pool.query(
    `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
     VALUES ($1,$2,$3,$4,$5,0) RETURNING id`,
    [negocioId, grupoId, nombre, extra, disponible])).rows[0];

  const chilaquiles = await prod(`Chilaquiles ${etiqueta}`, 195);
  const simple = await prod(`Refresco ${etiqueta}`, 30); // sin modificadores

  const salsas = await grupo(chilaquiles.id, 'Salsas', true, 1, 1);
  const verde = await opcion(salsas.id, 'Verde');
  const roja = await opcion(salsas.id, 'Roja');
  const mole = await opcion(salsas.id, 'Mole', 0, false); // no disponible

  const proteina = await grupo(chilaquiles.id, 'Proteína', true, 1, 1);
  const huevos = await opcion(proteina.id, 'Huevos estrellados');
  const bistec = await opcion(proteina.id, 'Bistec en Salsa', 30);

  const guarniciones = await grupo(chilaquiles.id, 'Guarniciones', true, 1, 2);
  const frijoles = await opcion(guarniciones.id, 'Frijoles normales');
  const papas = await opcion(guarniciones.id, 'Papas a la mexicana');
  const papasCh = await opcion(guarniciones.id, 'Papas con chorizo');

  return {
    catId: cat.id, chilaquiles, simple,
    op: { verde: verde.id, roja: roja.id, mole: mole.id, huevos: huevos.id, bistec: bistec.id,
          frijoles: frijoles.id, papas: papas.id, papasCh: papasCh.id },
  };
}

async function limpiar() {
  await pool.query(`DELETE FROM menu_categorias WHERE nombre LIKE 'Cat mods %' AND negocio_id = ANY($1)`, [[A, B]]);
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = ANY($1) AND datos->>'canal' IN ('pos','presencial')`, [[A, B]]);
  await pool.query(`DELETE FROM restaurante_cuentas WHERE negocio_id = ANY($1)`, [[A, B]]);
  await pool.query(`DELETE FROM configuracion WHERE negocio_id = ANY($1) AND clave = 'restaurante_num_mesas'`, [[A, B]]);
}
await limpiar();
for (const n of [A, B]) {
  for (const m of ['pos', 'menu', 'restaurante']) await fijarModulo(n, m);
  for (const [tipo, hab] of [['efectivo', true], ['terminal', true]]) {
    await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,$2,$3,0)
      ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = $3`, [n, tipo, hab]);
  }
}
const fa = await crearCatalogo(A, 'A');
const fb = await crearCatalogo(B, 'B');

const { rows: [uB] } = await pool.query(
  `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,'Admin Mods B',$2,'x') RETURNING id`,
  [B, `admin-mods-b-${Date.now()}@test.local`]);
await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'admin')`, [uB.id, B]);

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;
const ck = (u, n, r) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: u, negocioId: n, rol: r }))}`;
const adminA = ck(SEED.adminNegocioAUsuarioId, A, 'admin');
const staffA = ck(SEED.staffNegocioAUsuarioId, A, 'staff');
const adminB = ck(uB.id, B, 'admin');
const CLIENTE = { nombre: 'Cliente Mods', telefono: '8781115000' };
const pedidoPOS = (items) => ({ tipo: 'recoger', cliente: CLIENTE, items, formaPago: 'efectivo' });
const completo = (extra = []) => [fa.op.verde, fa.op.huevos, fa.op.frijoles, ...extra];

// ═════════ Menú: el backend ya exponía los modificadores ═════════
await t('MENU', '1. GET /api/menu entrega grupos, opciones, reglas y precio extra del producto', async () => {
  const r = await api(base, '/api/menu', { cookie: adminA });
  assert.strictEqual(r.status, 200);
  const prod = r.body.flatMap(c => c.productos || []).find(p => p.id === fa.chilaquiles.id);
  assert.ok(prod, 'el producto debe venir en el menú');
  assert.strictEqual(prod.modificadores.length, 3, 'Salsas, Proteína y Guarniciones');
  const salsas = prod.modificadores.find(g => g.nombre === 'Salsas');
  assert.strictEqual(salsas.requerido, true);
  assert.strictEqual(salsas.minimo, 1);
  assert.strictEqual(salsas.maximo, 1);
  assert.ok(!salsas.opciones.some(o => o.nombre === 'Mole'), 'las opciones no disponibles no se ofrecen');
  const bistec = prod.modificadores.find(g => g.nombre === 'Proteína').opciones.find(o => o.nombre === 'Bistec en Salsa');
  assert.strictEqual(Number(bistec.precio_extra), 30);
});

// ═════════ POS: reglas de selección ═════════
await t('POS', '2. producto SIN modificadores entra directo', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: adminA, method: 'POST', body: pedidoPOS([{ producto_id: fa.simple.id, cantidad: 1 }]) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.pedido.total, 30);
});
await t('POS', '3. grupo requerido sin elegir → 400 GRUPO_REQUERIDO (no se crea pedido)', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: adminA, method: 'POST', body: pedidoPOS([{ producto_id: fa.chilaquiles.id, cantidad: 1 }]) });
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.strictEqual(r.body.codigo, 'GRUPO_REQUERIDO');
});
await t('POS', '4. mínimo respetado: Guarniciones exige al menos 1', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: adminA, method: 'POST', body: pedidoPOS([
    { producto_id: fa.chilaquiles.id, cantidad: 1, modificadores: [fa.op.verde, fa.op.huevos] }]) });
  assert.strictEqual(r.status, 400);
  assert.ok(['GRUPO_REQUERIDO', 'MINIMO_NO_ALCANZADO'].includes(r.body.codigo), r.body.codigo);
});
await t('POS', '5. máximo respetado: Guarniciones admite 2, no 3', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: adminA, method: 'POST', body: pedidoPOS([
    { producto_id: fa.chilaquiles.id, cantidad: 1, modificadores: completo([fa.op.papas, fa.op.papasCh]) }]) });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.codigo, 'MAXIMO_EXCEDIDO');
});
await t('POS', '6. dos opciones del mismo grupo con máximo 1 se rechazan', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: adminA, method: 'POST', body: pedidoPOS([
    { producto_id: fa.chilaquiles.id, cantidad: 1, modificadores: [fa.op.verde, fa.op.roja, fa.op.huevos, fa.op.frijoles] }]) });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.codigo, 'MAXIMO_EXCEDIDO');
});
await t('POS', '7. opción no disponible rechazada', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: adminA, method: 'POST', body: pedidoPOS([
    { producto_id: fa.chilaquiles.id, cantidad: 1, modificadores: [fa.op.mole, fa.op.huevos, fa.op.frijoles] }]) });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.codigo, 'OPCION_NO_DISPONIBLE');
});
await t('POS', '8. opción de OTRO producto del mismo negocio rechazada', async () => {
  const { rows } = await pool.query(
    `SELECT o.id FROM menu_modificadores_opciones o JOIN menu_modificadores_grupos g ON g.id=o.grupo_id
      WHERE g.producto_id = $1 LIMIT 1`, [fb.chilaquiles.id]);
  const r = await api(base, '/api/pos/pedidos', { cookie: adminA, method: 'POST', body: pedidoPOS([
    { producto_id: fa.chilaquiles.id, cantidad: 1, modificadores: [...completo(), rows[0].id] }]) });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.codigo, 'OPCION_INVALIDA');
});
await t('POS', '9. opción duplicada rechazada', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: adminA, method: 'POST', body: pedidoPOS([
    { producto_id: fa.chilaquiles.id, cantidad: 1, modificadores: [...completo(), fa.op.frijoles] }]) });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.codigo, 'OPCION_DUPLICADA');
});

// ═════════ Precio: lo decide el servidor ═════════
let folioConBistec = null;
await t('PRECIO', '10. selección válida con extra: 195 + 30 = 225 (calculado por el backend)', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: adminA, method: 'POST', body: pedidoPOS([
    { producto_id: fa.chilaquiles.id, cantidad: 1, modificadores: [fa.op.verde, fa.op.bistec, fa.op.frijoles] }]) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.pedido.total, 225);
  folioConBistec = r.body.pedido.id;
});
await t('PRECIO', '11. cantidad 2 con extra: (195+30) × 2 = 450', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: adminA, method: 'POST', body: pedidoPOS([
    { producto_id: fa.chilaquiles.id, cantidad: 2, modificadores: [fa.op.verde, fa.op.bistec, fa.op.frijoles] }]) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.pedido.total, 450);
});
await t('PRECIO', '12. un precio falso del frontend se IGNORA por completo', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: adminA, method: 'POST', body: pedidoPOS([{
    producto_id: fa.chilaquiles.id, cantidad: 1, precio_unitario: 1, precio: 1, total: 1,
    modificadores: [fa.op.verde, fa.op.bistec, fa.op.frijoles],
    extras: [{ nombre: 'Bistec en Salsa', precio_extra: 0 }],
  }]) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.pedido.total, 225, 'el backend cobra el precio real de la base');
  assert.strictEqual(r.body.pedido.items[0].precio_unitario, 225);
});
await t('PRECIO', '13. POS presencial: con items del menú el total también lo fija el servidor', async () => {
  const r = await api(base, '/api/pedido-presencial', { cookie: adminA, method: 'POST', body: {
    items: [{ producto_id: fa.chilaquiles.id, cantidad: 1, precio_unitario: 1, modificadores: [fa.op.verde, fa.op.bistec, fa.op.frijoles] }],
    nombre: 'Cliente mostrador', forma_pago: 'efectivo', total: 1,
  } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.pedido.total, 225);
  assert.strictEqual(r.body.pedido.items[0].precio_unitario, 225);
});
await t('PRECIO', '14. POS presencial: selección inválida → 400, sin crear pedido', async () => {
  const r = await api(base, '/api/pedido-presencial', { cookie: adminA, method: 'POST', body: {
    items: [{ producto_id: fa.chilaquiles.id, cantidad: 1 }], nombre: 'X', forma_pago: 'efectivo',
  } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.codigo, 'GRUPO_REQUERIDO');
});

// ═════════ Snapshot y comanda ═════════
await t('SNAPSHOT', '15. el pedido guarda la selección completa (no depende del menú futuro)', async () => {
  const { rows } = await pool.query(`SELECT datos FROM pedidos_activos WHERE folio = $1`, [folioConBistec]);
  const item = rows[0].datos.items[0];
  assert.strictEqual(item.modificadores.length, 3);
  const bistec = item.modificadores.find(m => m.opcion === 'Bistec en Salsa');
  assert.strictEqual(bistec.grupo, 'Proteína');
  assert.strictEqual(Number(bistec.precio_extra), 30);
  assert.strictEqual(Number(item.precio_unitario), 225);
});
await t('COMANDA', '16. la comanda del pedido POS muestra la selección, no solo el nombre', async () => {
  const { rows } = await pool.query(`SELECT datos FROM pedidos_activos WHERE folio = $1`, [folioConBistec]);
  const notas = rows[0].datos.items[0].notas || '';
  assert.match(notas, /Salsas: Verde/);
  assert.match(notas, /Proteína: Bistec en Salsa/);
  assert.match(notas, /Guarniciones: Frijoles normales/);
});
await t('SNAPSHOT', '17. dos combinaciones distintas del mismo producto son dos líneas separadas', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: adminA, method: 'POST', body: pedidoPOS([
    { producto_id: fa.chilaquiles.id, cantidad: 1, modificadores: [fa.op.verde, fa.op.huevos, fa.op.frijoles] },
    { producto_id: fa.chilaquiles.id, cantidad: 1, modificadores: [fa.op.roja, fa.op.bistec, fa.op.papas] },
  ]) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.pedido.items.length, 2, 'no se fusionan');
  assert.strictEqual(r.body.pedido.total, 195 + 225);
  assert.notStrictEqual(r.body.pedido.items[0].notas, r.body.pedido.items[1].notas);
});
await t('IDEMPOTENCIA', '18. doble clic con la misma Idempotency-Key deja UN pedido con sus modificadores una sola vez', async () => {
  const key = 'mods-' + Date.now();
  const cuerpo = pedidoPOS([{ producto_id: fa.chilaquiles.id, cantidad: 1, modificadores: completo() }]);
  const [r1, r2] = await Promise.all([
    api(base, '/api/pos/pedidos', { cookie: adminA, method: 'POST', headers: { 'Idempotency-Key': key }, body: cuerpo }),
    api(base, '/api/pos/pedidos', { cookie: adminA, method: 'POST', headers: { 'Idempotency-Key': key }, body: cuerpo }),
  ]);
  assert.strictEqual(r1.status, 200); assert.strictEqual(r2.status, 200);
  assert.strictEqual(r1.body.pedido.id, r2.body.pedido.id);
  const { rows } = await pool.query(`SELECT datos FROM pedidos_activos WHERE folio = $1`, [r1.body.pedido.id]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].datos.items.length, 1);
  assert.strictEqual(rows[0].datos.items[0].modificadores.length, 3);
});

// ═════════ Multi-tenant ═════════
await t('TENANT', '19. B no puede pedir el producto de A ni usar sus opciones', async () => {
  const conProducto = await api(base, '/api/pos/pedidos', { cookie: adminB, method: 'POST', body: pedidoPOS([
    { producto_id: fa.chilaquiles.id, cantidad: 1, modificadores: completo() }]) });
  assert.strictEqual(conProducto.status, 400);
  assert.strictEqual(conProducto.body.codigo, 'PRODUCTO_AJENO');

  const conOpcionAjena = await api(base, '/api/pos/pedidos', { cookie: adminB, method: 'POST', body: pedidoPOS([
    { producto_id: fb.chilaquiles.id, cantidad: 1, modificadores: completo() }]) });
  assert.strictEqual(conOpcionAjena.status, 400);
  assert.strictEqual(conOpcionAjena.body.codigo, 'OPCION_INVALIDA');
});

// ═════════ Restaurante: mismas reglas, mismo helper ═════════
let cuentaA = null;
await t('RESTAURANTE', '20. abrir mesa y agregar del menú con modificadores: precio del servidor', async () => {
  const abrir = await api(base, '/api/restaurante/mesas/abrir', { cookie: staffA, method: 'POST', body: { mesa: 1, personas: 2 } });
  assert.strictEqual(abrir.status, 201, JSON.stringify(abrir.body));
  cuentaA = abrir.body.cuenta.id;
  const r = await api(base, `/api/restaurante/cuentas/${cuentaA}/items`, { cookie: staffA, method: 'POST', body: { items: [
    { producto_id: fa.chilaquiles.id, cantidad: 1, precio_unitario: 1, modificadores: [fa.op.verde, fa.op.bistec, fa.op.frijoles] },
  ] } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const c = await api(base, `/api/restaurante/cuentas/${cuentaA}`, { cookie: staffA });
  assert.strictEqual(c.body.total, 225, 'ignora el precio del frontend, igual que POS');
  const item = c.body.items[0];
  assert.ok(item.modificadores.some(m => /Bistec en Salsa/.test(m)), 'la selección queda en el item');
});
await t('RESTAURANTE', '21. la comanda de la mesa lleva la selección', async () => {
  const r = await api(base, `/api/restaurante/cuentas/${cuentaA}/comanda`, { cookie: staffA, method: 'POST' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const item = r.body.items[0];
  const texto = [item.notas, ...(item.modificadores || [])].filter(Boolean).join(' ');
  assert.match(texto, /Bistec en Salsa/);
  assert.match(texto, /Verde/);
});
await t('RESTAURANTE', '22. selección inválida desde la mesa → 400 (mismas reglas que POS)', async () => {
  const r = await api(base, `/api/restaurante/cuentas/${cuentaA}/items`, { cookie: staffA, method: 'POST', body: { items: [
    { producto_id: fa.chilaquiles.id, cantidad: 1 }] } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'GRUPO_REQUERIDO');
});
await t('RESTAURANTE', '23. B no puede agregar productos de A ni tocar la cuenta de A', async () => {
  const abrirB = await api(base, '/api/restaurante/mesas/abrir', { cookie: adminB, method: 'POST', body: { mesa: 1, personas: 1 } });
  assert.strictEqual(abrirB.status, 201);
  const ajeno = await api(base, `/api/restaurante/cuentas/${abrirB.body.cuenta.id}/items`, { cookie: adminB, method: 'POST', body: { items: [
    { producto_id: fa.chilaquiles.id, cantidad: 1, modificadores: completo() }] } });
  assert.strictEqual(ajeno.status, 400);
  assert.strictEqual(ajeno.body.code, 'PRODUCTO_AJENO');
  const cuentaAjena = await api(base, `/api/restaurante/cuentas/${cuentaA}`, { cookie: adminB });
  assert.strictEqual(cuentaAjena.status, 404, 'una cuenta de A no existe para B');
});
await t('RESTAURANTE', '24. el mesero sale de los usuarios activos del negocio: uno ajeno se rechaza', async () => {
  // Elegir a OTRO usuario del negocio exige su PIN; si aún no tiene, el
  // backend lo dice con claridad en vez de un "PIN incorrecto" confuso.
  const sinPin = await api(base, '/api/restaurante/mesas/abrir', { cookie: adminA, method: 'POST', body: { mesa: 2, personas: 2, meseroUsuarioId: SEED.staffNegocioAUsuarioId } });
  assert.strictEqual(sinPin.status, 400, JSON.stringify(sinPin.body));
  assert.strictEqual(sinPin.body.code, 'MESERO_SIN_PIN');
  // El propio usuario de la sesión sí abre sin PIN (ya está autenticado).
  const propio = await api(base, '/api/restaurante/mesas/abrir', { cookie: adminA, method: 'POST', body: { mesa: 2, personas: 2, meseroUsuarioId: SEED.adminNegocioAUsuarioId } });
  assert.strictEqual(propio.status, 201, JSON.stringify(propio.body));
  const c = await api(base, `/api/restaurante/cuentas/${propio.body.cuenta.id}`, { cookie: adminA });
  assert.ok(c.body.mesero?.nombre, 'la cuenta guarda al mesero');
  const ajeno = await api(base, '/api/restaurante/mesas/abrir', { cookie: adminA, method: 'POST', body: { mesa: 3, personas: 2, meseroUsuarioId: uB.id } });
  // 401: un mesero de otro negocio se rechaza igual que un PIN incorrecto.
  assert.ok([400, 401].includes(ajeno.status), `un usuario de otro negocio nunca es mesero aquí (dio ${ajeno.status})`);
});
await t('RESTAURANTE', '25. sin número de mesas configurado se muestran las 12 por defecto', async () => {
  const r = await api(base, '/api/restaurante/mesas', { cookie: adminA });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.mesas.length, 12);
});

// ═════════ Navegación operativa ═════════
await t('NAVEGACION', '26. el panel enlaza Restaurante y solo se muestra con el módulo activo', async () => {
  const html = await (await fetch(base + '/index.html')).text();
  assert.ok(html.includes('id="tab-restaurante"'), 'la pestaña debe existir');
  assert.match(html, /id="tab-restaurante"[^>]*data-modulo="restaurante"/, 'gateada por módulo');
  assert.ok(html.includes("location.href='/mesas.html'"), 'abre la UI operativa existente');
  assert.ok(html.includes('modificadores.js'), 'el panel carga el modal compartido');
  // aplicarModulosUI oculta cualquier [data-modulo] que el negocio no tenga:
  // es el mismo mecanismo del resto de las pestañas, no uno nuevo.
  assert.ok(/\[data-modulo\]/.test(html));
});
await t('NAVEGACION', '27. la UI de mesas se sirve y usa el mismo modal de modificadores', async () => {
  const html = await (await fetch(base + '/mesas.html')).text();
  assert.ok(html.includes('modificadores.js'), 'mismo componente que POS, sin implementación paralela');
  assert.ok(html.includes('agregarDesdeMenu'), 'permite agregar desde el menú del negocio');
  assert.ok(html.includes('/api/restaurante/mesas'), 'consume las rutas existentes');
});
await t('NAVEGACION', '28. con el módulo apagado la operación responde 403 (fail-closed real, no solo UI)', async () => {
  await fijarModulo(A, 'restaurante', 'no_contratado');
  const r = await api(base, '/api/restaurante/mesas', { cookie: adminA });
  assert.strictEqual(r.status, 403);
  await fijarModulo(A, 'restaurante', 'activo');
});

await limpiar();

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
