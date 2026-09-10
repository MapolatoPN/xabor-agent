// LA FOTO DEL CATÁLOGO QUE EL EDGE SE LLEVA PARA OPERAR SIN ENLACE.
//
// Dos cosas que proteger, y son de naturaleza distinta:
//
// 1. QUE SIRVA. Sin productos ni meseros no se puede capturar nada, y una foto
//    vacía reemplazando a una buena dejaría al restaurante sin poder trabajar
//    justo durante el corte. Por eso `catalogoUtilizable` se comprueba ANTES
//    de guardar.
// 2. QUE NO SE LLEVE DE MÁS. La foto viaja a una PC del local: no puede
//    contener credenciales administrativas ni datos de otro negocio.
//
// Uso: DATABASE_URL=... node test/fase-catalogo-edge.mjs
import assert from 'assert';

const { pool } = await import('../src/services/database.js');
const { construirCatalogoParaEdge, catalogoUtilizable, VERSION_CATALOGO } =
  await import('../src/services/catalogoParaEdge.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixture ─────────────────────────────────────────────────────────────────
const q1 = async (sql, params) => (await pool.query(sql, params)).rows[0];
const NEG = (await q1(`INSERT INTO negocios (nombre, slug) VALUES ('Catalogo Edge','catalogo-edge')
   ON CONFLICT (slug) DO UPDATE SET nombre='Catalogo Edge' RETURNING id`)).id;
const OTRO = (await q1(`INSERT INTO negocios (nombre, slug) VALUES ('Catalogo Edge Ajeno','catalogo-edge-ajeno')
   ON CONFLICT (slug) DO UPDATE SET nombre='Catalogo Edge Ajeno' RETURNING id`)).id;

for (const n of [NEG, OTRO]) {
  for (const tb of ['menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
    await pool.query(`DELETE FROM ${tb} WHERE negocio_id=$1`, [n]).catch(() => {});
  }
  await pool.query(`DELETE FROM usuario_negocios WHERE negocio_id=$1`, [n]).catch(() => {});
  await pool.query(`DELETE FROM usuarios WHERE negocio_id=$1`, [n]).catch(() => {});
  await pool.query(`DELETE FROM configuracion WHERE negocio_id=$1 AND clave='restaurante_num_mesas'`, [n]).catch(() => {});
}

const cat = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,activa,orden) VALUES ($1,'FUERTES',TRUE,0) RETURNING id`, [NEG])).id;
const PROD = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Chilaquiles',195) RETURNING id`, [NEG, cat])).id;
await pool.query(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio,agotado) VALUES ($1,$2,'Agotado',100,TRUE)`, [NEG, cat]);
const gGuarn = (await q1(`INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
   VALUES ($1,$2,'Guarniciones',TRUE,1,2,0) RETURNING id`, [NEG, PROD])).id;
await pool.query(`INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
   VALUES ($1,$2,'Frijolitos naturales',0,TRUE,0)`, [NEG, gGuarn]);
await pool.query(`INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
   VALUES ($1,$2,'Opcion agotada',0,FALSE,1)`, [NEG, gGuarn]);
await pool.query(`INSERT INTO configuracion (negocio_id,clave,valor) VALUES ($1,'restaurante_num_mesas','5')
   ON CONFLICT (negocio_id,clave) DO UPDATE SET valor='5'`, [NEG]);

const usuario = async (negocio, nombre, { conPin = true, activo = true, admin = false } = {}) => {
  const u = await q1(
    `INSERT INTO usuarios (negocio_id,nombre,activo,pin_hash,email,password_hash)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [negocio, nombre, activo, conPin ? 'salt:hashfalso' : null,
      admin ? `${nombre.replace(/\s/g, '')}@ejemplo.mx` : null, admin ? 'hash-de-contrasena' : null]);
  await pool.query(`INSERT INTO usuario_negocios (usuario_id,negocio_id,rol,activo) VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING`, [u.id, negocio, admin ? 'admin' : 'mesero', activo]);
  return u.id;
};
const MESERO = await usuario(NEG, 'Ana Mesera');
const BAJA = await usuario(NEG, 'Luis Dado De Baja', { activo: false });
const ADMIN = await usuario(NEG, 'Dueno', { admin: true });
await usuario(OTRO, 'Mesero Ajeno');

// ═══ A. Que sirva para operar ══════════════════════════════════════════════
await t('A1. la foto trae menú, modificadores, meseros y número de mesas', async () => {
  const c = await construirCatalogoParaEdge(NEG);
  assert.strictEqual(c.version, VERSION_CATALOGO);
  assert.strictEqual(c.negocioId, NEG);
  assert.strictEqual(c.numMesas, 5, 'el tablero necesita saber cuántas mesas pintar');
  const prod = c.menu[0].productos.find((p) => p.nombre === 'Chilaquiles');
  assert.ok(prod, 'el producto está');
  assert.strictEqual(prod.precio, 195);
  assert.strictEqual(prod.modificadores[0].nombre, 'Guarniciones');
  assert.strictEqual(prod.modificadores[0].minimo, 1, 'la cardinalidad viaja: offline se exige lo mismo');
  assert.strictEqual(prod.modificadores[0].maximo, 2);
  const util = catalogoUtilizable(c);
  assert.strictEqual(util.ok, true, JSON.stringify(util));
});

await t('A2. lo agotado NO viaja: no se puede vender sin enlace lo que no hay', async () => {
  const c = await construirCatalogoParaEdge(NEG);
  const nombres = c.menu.flatMap((cat) => cat.productos.map((p) => p.nombre));
  assert.ok(!nombres.includes('Agotado'), 'un producto agotado no debe poder capturarse offline');
  const opciones = c.menu[0].productos[0].modificadores[0].opciones.map((o) => o.nombre);
  assert.deepStrictEqual(opciones, ['Frijolitos naturales'], 'ni una opción no disponible');
});

await t('A3. solo meseros ACTIVOS de este negocio', async () => {
  const c = await construirCatalogoParaEdge(NEG);
  const ids = c.meseros.map((m) => m.id);
  assert.ok(ids.includes(MESERO), 'la mesera activa está');
  assert.ok(!ids.includes(BAJA), 'quien se dio de baja no puede abrir mesas durante el corte');
});

// ═══ B. Que no se lleve de más ═════════════════════════════════════════════
await t('B1. la foto NUNCA lleva credenciales administrativas', async () => {
  const c = await construirCatalogoParaEdge(NEG);
  const crudo = JSON.stringify(c);
  assert.ok(!crudo.includes('hash-de-contrasena'), 'ningún password_hash puede salir del servidor');
  assert.ok(!crudo.includes('@ejemplo.mx'), 'ni los correos de las cuentas administrativas');
  const admin = c.meseros.find((m) => m.id === ADMIN);
  if (admin) assert.ok(!('password_hash' in admin) && !('email' in admin));
});

await t('B2. el PIN viaja como hash, y se puede dejar fuera si se decide', async () => {
  const con = await construirCatalogoParaEdge(NEG);
  assert.ok(con.meseros[0].pin_hash, 'con pines, el Edge puede validar sin enlace');
  assert.ok(!String(con.meseros[0].pin_hash).match(/^\d{4,6}$/), 'jamás el PIN en claro');
  const sin = await construirCatalogoParaEdge(NEG, { incluirPines: false });
  assert.ok(sin.meseros.every((m) => !('pin_hash' in m)), 'y se puede optar por no exportarlos');
});

await t('B3. nunca se mezclan dos negocios', async () => {
  const c = await construirCatalogoParaEdge(NEG);
  assert.ok(c.meseros.every((m) => m.id !== undefined));
  assert.ok(!JSON.stringify(c).includes('Mesero Ajeno'));
  const otro = await construirCatalogoParaEdge(OTRO);
  assert.strictEqual(otro.menu.length, 0, 'el otro negocio no hereda el menú de este');
});

await t('B4. sin negocio no se construye nada', async () => {
  await assert.rejects(() => construirCatalogoParaEdge(''), (e) => e.code === 'TENANT_CONTEXT_REQUIRED');
  await assert.rejects(() => construirCatalogoParaEdge(null), (e) => e.code === 'TENANT_CONTEXT_REQUIRED');
});

// ═══ C. La guarda antes de guardar ═════════════════════════════════════════
await t('C1. una foto inservible se detecta ANTES de reemplazar a la buena', async () => {
  assert.strictEqual(catalogoUtilizable(null).ok, false);
  assert.strictEqual(catalogoUtilizable({ version: 99 }).motivo, 'version_desconocida');
  assert.strictEqual(catalogoUtilizable({ version: VERSION_CATALOGO }).motivo, 'sin_negocio');
  assert.strictEqual(
    catalogoUtilizable({ version: VERSION_CATALOGO, negocioId: 'x', menu: [], meseros: [] }).motivo,
    'sin_productos', 'un menú vacío dejaría al restaurante sin poder capturar');
  assert.strictEqual(
    catalogoUtilizable({ version: VERSION_CATALOGO, negocioId: 'x', menu: [{ productos: [{ id: 1 }] }], meseros: [] }).motivo,
    'sin_meseros', 'sin meseros no hay quien abra una mesa');
});

await t('C2. el negocio sin menú se marca inservible, no se entrega a medias', async () => {
  const otro = await construirCatalogoParaEdge(OTRO);
  const util = catalogoUtilizable(otro);
  assert.strictEqual(util.ok, false, 'ese negocio no está listo para operar sin enlace');
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
