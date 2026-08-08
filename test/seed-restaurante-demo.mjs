// Restaurante de demostración para probar la pantalla en un navegador real
// (no toca ningún negocio real). Deja el escenario del piloto: un menú con
// categorías, un producto con tres grupos de modificadores y un mesero con
// PIN para entrar por la estación.
//
//   node test/seed-restaurante-demo.mjs
//
// Imprime el slug, el PIN y las credenciales del administrador.
import { pool } from '../src/services/database.js';
import { hashPin, hashPassword } from '../src/services/password.js';

const SLUG = 'demo-restaurante-v2';
const PIN = '4821';
const EMAIL_ADMIN = 'admin@demo-restaurante-v2.test';
const PASS_ADMIN = 'Demo12345!';

async function limpiar() {
  const { rows } = await pool.query('SELECT id FROM negocios WHERE slug = $1', [SLUG]);
  if (!rows.length) return;
  const ids = rows.map(r => r.id);
  await pool.query(`DELETE FROM restaurante_cuenta_pagos WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`, [ids]);
  await pool.query(`DELETE FROM restaurante_cuenta_items WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`, [ids]);
  await pool.query('DELETE FROM restaurante_cuentas WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM pedidos_activos WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM menu_modificadores_opciones WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM menu_modificadores_grupos WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM menu_productos WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM menu_categorias WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM metodos_pago WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM negocio_modulos WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM configuracion WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM usuario_negocios WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM usuarios WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM negocios WHERE id = ANY($1)', [ids]);
}

await limpiar();

const { rows: [neg] } = await pool.query(
  `INSERT INTO negocios (nombre, slug) VALUES ('Cocina Demo Xabor', $1) RETURNING id`, [SLUG]);
for (const m of ['restaurante', 'menu', 'pos', 'usuarios', 'caja']) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
                    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [neg.id, m]);
}
for (const t of ['efectivo', 'terminal']) {
  await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,$2,TRUE,0)
                    ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [neg.id, t]);
}
await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'restaurante_num_mesas','12')
                  ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = '12'`, [neg.id]);

const { rows: [admin] } = await pool.query(
  `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,'Ana Admin',$2,$3) RETURNING id`,
  [neg.id, EMAIL_ADMIN, await hashPassword(PASS_ADMIN)]);
await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'admin')`, [admin.id, neg.id]);

const { rows: [mesero] } = await pool.query(
  `INSERT INTO usuarios (negocio_id, nombre, email, pin_hash) VALUES ($1,'Ángel',NULL,$2) RETURNING id`,
  [neg.id, await hashPin(PIN)]);
await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'mesero')`, [mesero.id, neg.id]);

const { rows: [mesera] } = await pool.query(
  `INSERT INTO usuarios (negocio_id, nombre, email, pin_hash) VALUES ($1,'María',NULL,$2) RETURNING id`,
  [neg.id, await hashPin('1357')]);
await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'mesero')`, [mesera.id, neg.id]);

let orden = 0;
const cat = async (nombre) => (await pool.query(
  `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,$3) RETURNING id`,
  [neg.id, nombre, orden++])).rows[0].id;
let cod = 0;
const prod = async (categoriaId, nombre, precio) => (await pool.query(
  `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, descripcion, precio, disponible, orden)
   VALUES ($1,$2,$3,$4,'',$5,TRUE,$6) RETURNING id`,
  [neg.id, categoriaId, 'D' + (++cod), nombre, precio, cod])).rows[0].id;
const grupo = async (productoId, nombre, requerido, minimo, maximo, ord) => (await pool.query(
  `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
   VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
  [neg.id, productoId, nombre, requerido, minimo, maximo, ord])).rows[0].id;
const opcion = async (grupoId, nombre, extra, ord) => pool.query(
  `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
   VALUES ($1,$2,$3,$4,TRUE,$5)`, [neg.id, grupoId, nombre, extra, ord]);

const cChilaquiles = await cat('Chilaquiles');
const cDesayunos = await cat('Desayunos');
const cBebidas = await cat('Bebidas');
const cPostres = await cat('Postres');

const chilaquiles = await prod(cChilaquiles, 'Chilaquiles', 195);
const gSalsa = await grupo(chilaquiles, 'Salsa', true, 1, 1, 0);
for (const [i, n] of ['Suiza', 'Chipotle', 'Verde', 'Roja', 'Mole'].entries()) await opcion(gSalsa, n, 0, i);
const gProte = await grupo(chilaquiles, 'Proteína', true, 1, 1, 1);
for (const [i, [n, e]] of [['Huevos estrellados', 0], ['Huevos revueltos', 0], ['Pechuga', 0], ['Chicharrón', 0], ['Bistec', 30]].entries()) await opcion(gProte, n, e, i);
const gGuarn = await grupo(chilaquiles, 'Guarniciones', false, 1, 2, 2);
for (const [i, n] of ['Frijoles', 'Papas', 'Chorizo'].entries()) await opcion(gGuarn, n, 0, i);

await prod(cChilaquiles, 'Chilaquiles verdes sencillos', 165);
await prod(cDesayunos, 'Huevos divorciados', 180);
await prod(cDesayunos, 'Enchiladas', 175);
await prod(cDesayunos, 'Molletes', 120);
await prod(cBebidas, 'Coca-Cola', 40);
await prod(cBebidas, 'Café americano', 45);
await prod(cBebidas, 'Jugo de naranja', 55);
await prod(cPostres, 'Flan', 70);

console.log(JSON.stringify({
  slug: SLUG, negocioId: neg.id, estacion: `/mesero/${SLUG}`,
  mesero: { nombre: 'Ángel', id: mesero.id, pin: PIN },
  mesera: { nombre: 'María', id: mesera.id, pin: '1357' },
  admin: { email: EMAIL_ADMIN, password: PASS_ADMIN },
}, null, 2));
await pool.end();
