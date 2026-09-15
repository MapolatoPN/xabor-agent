// La ronda pendiente de Mesa se comporta como un carrito.
//
// El mesero tocaba el producto equivocado y quedaba atrapado: quitarlo exigía
// `cancelarItem`, que es de ADMIN y pide motivo. En hora pico eso significa
// llamar a alguien para deshacer un toque. Tampoco había forma de corregir la
// cantidad: cada toque insertaba su propia línea.
//
// La línea que esta suite defiende es la que separa dos cosas que se parecen:
//
//   quitar    lo que NUNCA salió a cocina. No dejó rastro, se borra, y lo
//             puede hacer quien atiende la mesa.
//   cancelar  lo que la cocina YA tiene impreso. Admin, motivo y comanda de
//             cancelación, porque hay comida hecha.
//
// Si esa frontera se borra, un mesero puede hacer desaparecer sin rastro un
// platillo que ya se está cocinando.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4768';

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

const A = SEED.negocioA, B = SEED.negocioB;
const MARCA = 'Cat carrito mesa';

for (const n of [A, B]) {
  for (const m of ['pos', 'menu', 'restaurante']) {
    await pool.query(`INSERT INTO negocio_modulos (negocio_id,modulo,estado) VALUES ($1,$2,'activo')
      ON CONFLICT (negocio_id,modulo) DO UPDATE SET estado='activo'`, [n, m]);
  }
}
await pool.query('DELETE FROM menu_categorias WHERE nombre = $1 AND negocio_id = ANY($2)', [MARCA, [A, B]]);
await pool.query('DELETE FROM restaurante_cuentas WHERE negocio_id = ANY($1)', [[A, B]]);

const { rows: [cat] } = await pool.query(
  'INSERT INTO menu_categorias (negocio_id,nombre,activa,orden) VALUES ($1,$2,TRUE,0) RETURNING id', [A, MARCA]);
const { rows: [prod] } = await pool.query(
  `INSERT INTO menu_productos (negocio_id,categoria_id,codigo,nombre,descripcion,precio,disponible,orden)
   VALUES ($1,$2,$3,'Platillo carrito','',100,TRUE,0) RETURNING id`,
  [A, cat.id, 'CR' + Math.floor(Math.random() * 1e9).toString(36)]);

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const ck = (negocioId, usuarioId) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol: 'admin' }))}`;
const ckA = ck(A, SEED.adminNegocioAUsuarioId);
const api = async (ruta, { cookie = ckA, method = 'GET', body } = {}) => {
  const r = await fetch(srv.base + ruta, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};

let mesaSeq = 20;
async function mesaConPlatillo(cantidad = 1) {
  const ab = await api('/api/restaurante/mesas/abrir', { method: 'POST', body: { mesa: ++mesaSeq, personas: 2, meseroUsuarioId: null } });
  const cuentaId = ab.body?.cuenta?.id;
  const it = await api(`/api/restaurante/cuentas/${cuentaId}/items`, { method: 'POST', body: { items: [{ producto_id: prod.id, cantidad }] } });
  return { cuentaId, itemId: it.body?.items?.[0]?.id };
}
const cantidadDe = async (id) => (await pool.query('SELECT cantidad FROM restaurante_cuenta_items WHERE id=$1', [id])).rows[0]?.cantidad;
const existe = async (id) => (await pool.query('SELECT 1 FROM restaurante_cuenta_items WHERE id=$1', [id])).rows.length > 0;

await t('CARRITO', '1. subir y bajar la cantidad de un platillo pendiente', async () => {
  const { cuentaId, itemId } = await mesaConPlatillo(1);
  const sube = await api(`/api/restaurante/cuentas/${cuentaId}/items/${itemId}/cantidad`, { method: 'PATCH', body: { cantidad: 3 } });
  assert.strictEqual(sube.status, 200, JSON.stringify(sube.body));
  assert.strictEqual(await cantidadDe(itemId), 3);
  await api(`/api/restaurante/cuentas/${cuentaId}/items/${itemId}/cantidad`, { method: 'PATCH', body: { cantidad: 2 } });
  assert.strictEqual(await cantidadDe(itemId), 2);
});

await t('CARRITO', '2. quitar un platillo pendiente lo borra, sin pedir motivo ni admin', async () => {
  const { cuentaId, itemId } = await mesaConPlatillo();
  const r = await api(`/api/restaurante/cuentas/${cuentaId}/items/${itemId}`, { method: 'DELETE' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(await existe(itemId), false, 'nunca salió a cocina: se borra y ya');
});

await t('FRONTERA', '3. lo que YA salió a cocina no se puede quitar', async () => {
  const { cuentaId, itemId } = await mesaConPlatillo();
  await api(`/api/restaurante/cuentas/${cuentaId}/comanda`, { method: 'POST' });
  const r = await api(`/api/restaurante/cuentas/${cuentaId}/items/${itemId}`, { method: 'DELETE' });
  assert.notStrictEqual(r.status, 200, 'debe rechazarse: hay comida hecha');
  assert.strictEqual(r.body?.code, 'ITEM_NO_EDITABLE', JSON.stringify(r.body));
  assert.strictEqual(await existe(itemId), true, 'y el platillo sigue en la cuenta');
});

await t('FRONTERA', '4. lo que YA salió a cocina tampoco cambia de cantidad', async () => {
  const { cuentaId, itemId } = await mesaConPlatillo(2);
  await api(`/api/restaurante/cuentas/${cuentaId}/comanda`, { method: 'POST' });
  const r = await api(`/api/restaurante/cuentas/${cuentaId}/items/${itemId}/cantidad`, { method: 'PATCH', body: { cantidad: 9 } });
  assert.notStrictEqual(r.status, 200);
  assert.strictEqual(r.body?.code, 'ITEM_NO_EDITABLE');
  assert.strictEqual(await cantidadDe(itemId), 2, 'la cocina y la cuenta siguen diciendo lo mismo');
});

await t('CARRITO', '5. la cantidad tiene límites y no acepta basura', async () => {
  const { cuentaId, itemId } = await mesaConPlatillo();
  for (const mala of [0, -3, 100, 'x', null]) {
    const r = await api(`/api/restaurante/cuentas/${cuentaId}/items/${itemId}/cantidad`, { method: 'PATCH', body: { cantidad: mala } });
    assert.notStrictEqual(r.status, 200, `cantidad ${JSON.stringify(mala)} no debe aceptarse`);
    assert.strictEqual(r.body?.code, 'CANTIDAD_INVALIDA', `cantidad ${JSON.stringify(mala)}: ${JSON.stringify(r.body)}`);
  }
  assert.strictEqual(await cantidadDe(itemId), 1, 'la cantidad original no se tocó');
});

await t('CARRITO', '6. corregir la ronda cambia lo que sale impreso', async () => {
  const { cuentaId, itemId } = await mesaConPlatillo(1);
  await api(`/api/restaurante/cuentas/${cuentaId}/items/${itemId}/cantidad`, { method: 'PATCH', body: { cantidad: 4 } });
  const env = await api(`/api/restaurante/cuentas/${cuentaId}/comanda`, { method: 'POST' });
  assert.strictEqual(env.status, 200);
  const item = env.body.items.find(i => i.cantidad === 4);
  assert.ok(item, 'la comanda debe llevar la cantidad corregida: ' + JSON.stringify(env.body.items));
});

await t('SEGURIDAD', '7. un negocio no toca la ronda de otro', async () => {
  const { cuentaId, itemId } = await mesaConPlatillo();
  const { rows: [uB] } = await pool.query('SELECT id FROM usuarios WHERE negocio_id=$1 LIMIT 1', [B]);
  const ckB = ck(B, uB.id);
  const q = await api(`/api/restaurante/cuentas/${cuentaId}/items/${itemId}/cantidad`, { cookie: ckB, method: 'PATCH', body: { cantidad: 7 } });
  assert.notStrictEqual(q.status, 200);
  const d = await api(`/api/restaurante/cuentas/${cuentaId}/items/${itemId}`, { cookie: ckB, method: 'DELETE' });
  assert.notStrictEqual(d.status, 200);
  assert.strictEqual(await existe(itemId), true);
  assert.strictEqual(await cantidadDe(itemId), 1);
});

await t('SEGURIDAD', '8. sin sesión no se corrige nada', async () => {
  const { cuentaId, itemId } = await mesaConPlatillo();
  for (const [ruta, method] of [[`items/${itemId}/cantidad`, 'PATCH'], [`items/${itemId}`, 'DELETE']]) {
    const r = await fetch(`${srv.base}/api/restaurante/cuentas/${cuentaId}/${ruta}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cantidad: 5 }) });
    assert.ok([401, 403].includes(r.status), `${method} sin sesión dio ${r.status}`);
  }
});

await t('PANTALLA', '9. la cuenta ofrece corregir solo lo pendiente', async () => {
  const html = await (await fetch(srv.base + '/mesas.html')).text();
  assert.match(html, /const editable = i\.estado === 'pendiente' && !i\.comanda_num;/,
    'la frontera se decide en un solo lugar');
  assert.match(html, /editable[\s\S]{0,400}cambiarCantidad\(/, 'el ± depende de esa condición');
  assert.match(html, /editable \? `<button class="quitar" onclick="quitarItem\(/, 'el ✕ de quitar también');
  // Y cancelar sigue siendo lo OTRO: solo para lo ya enviado, y de admin.
  assert.match(html, /const cancelable = puedeCancelar\(\) && i\.estado !== 'cancelado' && !editable;/,
    'cancelar y quitar no pueden ofrecerse a la vez sobre la misma línea');
  assert.ok(html.includes('Enviar a cocina'), 'el botón dice lo que hace');
  assert.ok(!html.includes('Enviar comanda'), 'ya no queda la jerga del sistema');
});

await t('PANTALLA', '10. bajar de 1 quita, en vez de dejar una línea en cero', async () => {
  const html = await (await fetch(srv.base + '/mesas.html')).text();
  assert.match(html, /async function cambiarCantidad\(itemId, cantidad\) \{\s*\n\s*if \(cantidad < 1\) return quitarItem\(itemId\);/,
    'el − en 1 debe quitar la línea');
});

await pool.query('DELETE FROM restaurante_cuentas WHERE negocio_id = ANY($1)', [[A, B]]);
await pool.query('DELETE FROM menu_categorias WHERE nombre = $1 AND negocio_id = ANY($2)', [MARCA, [A, B]]);

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
