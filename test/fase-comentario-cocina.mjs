// Comentario del mesero para la cocina.
//
// El mesero necesita decirle algo a la plancha sobre UN platillo: «sin
// cebolla», «término tres cuartos», «aparte». El camino ya existía casi
// entero —la columna `notas`, el guardado al agregar, y `enviarComanda` que
// las une a los modificadores para el ticket— pero al producto del MENÚ no
// había forma de ponérselas: `elegirProducto` mandaba producto, cantidad y
// modificadores y nada más. Solo el item libre podía llevar nota.
//
// Lo que esta suite fija de verdad no es que se guarde un texto: es CUÁNDO se
// puede escribir. Una nota sobre algo que la cocina ya tiene impreso haría que
// el papel y la pantalla dijeran cosas distintas sin que nadie se entere.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4767';

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

const A = SEED.negocioA, B = SEED.negocioB;
const MARCA = 'Cat comentario cocina';

for (const n of [A, B]) {
  for (const m of ['pos', 'menu', 'restaurante']) {
    await pool.query(`INSERT INTO negocio_modulos (negocio_id,modulo,estado) VALUES ($1,$2,'activo')
      ON CONFLICT (negocio_id,modulo) DO UPDATE SET estado='activo'`, [n, m]);
  }
}
await pool.query('DELETE FROM menu_categorias WHERE nombre = $1 AND negocio_id = ANY($2)', [MARCA, [A, B]]);
await pool.query('DELETE FROM restaurante_cuentas WHERE negocio_id = ANY($1)', [[A, B]]);

async function producto(negocioId) {
  const { rows: [cat] } = await pool.query(
    'INSERT INTO menu_categorias (negocio_id,nombre,activa,orden) VALUES ($1,$2,TRUE,0) RETURNING id', [negocioId, MARCA]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id,categoria_id,codigo,nombre,descripcion,precio,disponible,orden)
     VALUES ($1,$2,$3,'Platillo comentado','',100,TRUE,0) RETURNING id`,
    [negocioId, cat.id, 'CM' + Math.floor(Math.random() * 1e9).toString(36)]);
  return p.id;
}
const prodA = await producto(A);
const prodB = await producto(B);

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const cookie = (negocioId, usuarioId) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol: 'admin' }))}`;
const ckA = cookie(A, SEED.adminNegocioAUsuarioId);
const api = async (ruta, { ck = ckA, method = 'GET', body } = {}) => {
  const r = await fetch(srv.base + ruta, {
    method, headers: { 'Content-Type': 'application/json', Cookie: ck },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};

async function mesaConPlatillo(numero = 5, ck = ckA, pid = prodA) {
  const ab = await api('/api/restaurante/mesas/abrir', { ck, method: 'POST', body: { mesa: numero, personas: 2, meseroUsuarioId: null } });
  const cuentaId = ab.body?.cuenta?.id;
  const it = await api(`/api/restaurante/cuentas/${cuentaId}/items`, { ck, method: 'POST', body: { items: [{ producto_id: pid, cantidad: 1 }] } });
  return { cuentaId, itemId: it.body?.items?.[0]?.id, alta: it };
}

const NOTA = 'sin cebolla, término tres cuartos';

await t('COMENTARIO', '1. se puede comentar un platillo que aún no sale a cocina', async () => {
  const { cuentaId, itemId } = await mesaConPlatillo(5);
  assert.ok(itemId, 'el platillo debe existir');
  const r = await api(`/api/restaurante/cuentas/${cuentaId}/items/${itemId}/notas`, { method: 'PATCH', body: { notas: NOTA } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.item.notas, NOTA);
  const { rows } = await pool.query('SELECT notas FROM restaurante_cuenta_items WHERE id = $1', [itemId]);
  assert.strictEqual(rows[0].notas, NOTA, 'queda guardado');
});

await t('COMENTARIO', '2. el comentario llega a la comanda junto a los modificadores', async () => {
  const { cuentaId, itemId } = await mesaConPlatillo(6);
  await api(`/api/restaurante/cuentas/${cuentaId}/items/${itemId}/notas`, { method: 'PATCH', body: { notas: NOTA } });
  const env = await api(`/api/restaurante/cuentas/${cuentaId}/comanda`, { method: 'POST' });
  assert.strictEqual(env.status, 200, JSON.stringify(env.body));
  // La comanda es lo que se imprime: si el comentario no está aquí, el mesero
  // escribió para nadie.
  const texto = JSON.stringify(env.body);
  assert.ok(texto.includes('sin cebolla'), 'el comentario debe viajar en la comanda: ' + texto.slice(0, 400));
});

await t('COMENTARIO', '3. lo que YA salió a cocina no se puede comentar', async () => {
  const { cuentaId, itemId } = await mesaConPlatillo(7);
  await api(`/api/restaurante/cuentas/${cuentaId}/comanda`, { method: 'POST' });   // sale a cocina
  const r = await api(`/api/restaurante/cuentas/${cuentaId}/items/${itemId}/notas`, { method: 'PATCH', body: { notas: 'tarde' } });
  assert.notStrictEqual(r.status, 200, 'debe rechazarse: el papel ya está impreso');
  assert.strictEqual(r.body?.code, 'ITEM_NO_COMENTABLE', JSON.stringify(r.body));
  const { rows } = await pool.query('SELECT notas FROM restaurante_cuenta_items WHERE id = $1', [itemId]);
  assert.notStrictEqual(rows[0].notas, 'tarde', 'y la nota NO se escribió');
});

await t('COMENTARIO', '4. un comentario vacío lo borra, no guarda espacios', async () => {
  const { cuentaId, itemId } = await mesaConPlatillo(8);
  await api(`/api/restaurante/cuentas/${cuentaId}/items/${itemId}/notas`, { method: 'PATCH', body: { notas: NOTA } });
  const r = await api(`/api/restaurante/cuentas/${cuentaId}/items/${itemId}/notas`, { method: 'PATCH', body: { notas: '   ' } });
  assert.strictEqual(r.status, 200);
  const { rows } = await pool.query('SELECT notas FROM restaurante_cuenta_items WHERE id = $1', [itemId]);
  assert.strictEqual(rows[0].notas, null, 'queda en null, no en cadena de espacios');
});

await t('COMENTARIO', '5. el largo se recorta igual que al crear el platillo (300)', async () => {
  const { cuentaId, itemId } = await mesaConPlatillo(9);
  const r = await api(`/api/restaurante/cuentas/${cuentaId}/items/${itemId}/notas`, { method: 'PATCH', body: { notas: 'x'.repeat(900) } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.item.notas.length, 300);
});

await t('SEGURIDAD', '6. un negocio no puede comentar el platillo de otro', async () => {
  const { cuentaId, itemId } = await mesaConPlatillo(10);
  const { rows: [adminB] } = await pool.query('SELECT id FROM usuarios WHERE negocio_id=$1 LIMIT 1', [B]);
  const ckB = cookie(B, adminB.id);
  const r = await api(`/api/restaurante/cuentas/${cuentaId}/items/${itemId}/notas`, { ck: ckB, method: 'PATCH', body: { notas: 'ajeno' } });
  assert.notStrictEqual(r.status, 200, 'debe rechazarse');
  const { rows } = await pool.query('SELECT notas FROM restaurante_cuenta_items WHERE id = $1', [itemId]);
  assert.notStrictEqual(rows[0].notas, 'ajeno');
});

await t('SEGURIDAD', '7. sin sesión no se comenta nada', async () => {
  const { cuentaId, itemId } = await mesaConPlatillo(11);
  const r = await fetch(`${srv.base}/api/restaurante/cuentas/${cuentaId}/items/${itemId}/notas`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notas: 'x' }) });
  assert.ok([401, 403].includes(r.status), `esperaba 401/403, dio ${r.status}`);
});

await t('PANTALLA', '8. la cuenta ofrece comentar solo lo pendiente', async () => {
  const html = await (await fetch(srv.base + '/mesas.html')).text();
  assert.ok(html.includes('abrirComentario('), 'la línea debe poder abrir el comentario');
  assert.ok(html.includes('id="dlg-comentario"'), 'existe el diálogo');
  assert.match(html, /const comentable = i\.estado === 'pendiente' && !i\.comanda_num;/,
    'la pantalla solo ofrece comentar lo que no salió a cocina');
  assert.match(html, /comentable \?[\s\S]{0,200}abrirComentario/, 'el botón depende de esa condición');
  // Y el mismo tope que el servidor, para no dejar escribir lo que se recorta.
  assert.ok(html.includes('id="co-texto" maxlength="300"'), 'el campo lleva el tope de 300');
});

await pool.query('DELETE FROM restaurante_cuentas WHERE negocio_id = ANY($1)', [[A, B]]);
await pool.query('DELETE FROM menu_categorias WHERE nombre = $1 AND negocio_id = ANY($2)', [MARCA, [A, B]]);

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
