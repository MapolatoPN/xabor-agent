// MÍNIMO Y MÁXIMO EDITABLES DESDE EL MENÚ, SIN PODER GUARDAR UN IMPOSIBLE.
//
// Caso real que lo motiva: el menú ofrece 2 guarniciones y hay clientes que
// quieren una sola. El panel solo preguntaba el MÁXIMO y deducía el mínimo de
// "¿es obligatorio?" (1 o 0), así que ni "elige exactamente 2" ni "elige 1 o 2"
// se podían configurar: el negocio no tenía forma de decirlo.
//
// Al abrir el mínimo aparece un riesgo que antes era inalcanzable: una
// cardinalidad contradictoria. `validarCardinalidadGrupos` marca `inconsistentes`
// un grupo con máx < mín y el producto DEJA DE PODERSE PEDIR -- el negocio
// rompería sus propias ventas con dos clics, sin enterarse. Por eso la garantía
// no vive en el formulario (que también avisa) sino en el escritor: nada que
// pase por `crearGrupoModificador` / `actualizarGrupoModificador` puede quedar
// guardado en un estado que el cliente no pueda satisfacer.
//
// Y un defecto que ya existía y aquí queda cubierto: desmarcar "¿es obligatorio?"
// en un grupo 2..2 guardaba `requerido=false` dejando `minimo` en 2, y
// `cardinalidadDeGrupo` seguía exigiendo DOS opciones. El negocio creía haberlo
// hecho opcional y el bot seguía pidiendo dos.
//
// Uso: DATABASE_URL=... node test/fase-cardinalidad-editable.mjs
import assert from 'assert';

const {
  pool, crearGrupoModificador, actualizarGrupoModificador, normalizarCardinalidadGrupo,
} = await import('../src/services/database.js');
const { cardinalidadDeGrupo, validarCardinalidadGrupos, cargarGruposDeProductos } =
  await import('../src/services/modificadores.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixture ─────────────────────────────────────────────────────────────────
const q1 = async (sql, params) => (await pool.query(sql, params)).rows[0];
const NEG = (await q1(
  `INSERT INTO negocios (nombre, slug) VALUES ('Cardinalidad Editable','cardinalidad-editable')
   ON CONFLICT (slug) DO UPDATE SET nombre='Cardinalidad Editable' RETURNING id`)).id;
const OTRO = (await q1(
  `INSERT INTO negocios (nombre, slug) VALUES ('Cardinalidad Ajena','cardinalidad-ajena')
   ON CONFLICT (slug) DO UPDATE SET nombre='Cardinalidad Ajena' RETURNING id`)).id;
for (const n of [NEG, OTRO]) {
  for (const tabla of ['menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
    await pool.query(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [n]).catch(() => {});
  }
}
const cat = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'GENERAL',0) RETURNING id`, [NEG])).id;
const PROD = (await q1(
  `INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio)
   VALUES ($1,$2,'Plato Con Guarniciones',120) RETURNING id`, [NEG, cat])).id;

const leer = async (id) => q1('SELECT nombre, requerido, minimo, maximo FROM menu_modificadores_grupos WHERE id=$1', [id]);
// Cada grupo nace con 3 opciones disponibles: así `inconsistentes` solo puede
// deberse a la cardinalidad, nunca a un catálogo vacío.
const nuevoGrupo = async (nombre, campos) => {
  const g = await crearGrupoModificador(PROD, { nombre, ...campos }, NEG);
  for (const o of ['A', 'B', 'C']) {
    await pool.query(
      `INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
       VALUES ($1,$2,$3,0,TRUE,0)`, [NEG, g.id, o]);
  }
  return g;
};

// ═══ La cardinalidad que el negocio pidió se guarda tal cual ════════════════
await t('N1. "elige exactamente 2" se puede guardar (era inexpresable en el panel)', async () => {
  const g = await nuevoGrupo('Guarnición Exacta', { requerido: true, minimo: 2, maximo: 2 });
  const fila = await leer(g.id);
  assert.strictEqual(fila.minimo, 2, 'el mínimo del negocio no se pisa');
  assert.strictEqual(fila.maximo, 2);
  assert.deepStrictEqual(cardinalidadDeGrupo(fila), { minimo: 2, maximo: 2 });
});

await t('N2. "elige 1 o 2" (el caso de las guarniciones) se guarda como rango', async () => {
  const g = await nuevoGrupo('Guarnición Flexible', { requerido: true, minimo: 1, maximo: 2 });
  const fila = await leer(g.id);
  assert.deepStrictEqual(cardinalidadDeGrupo(fila), { minimo: 1, maximo: 2 },
    'el cliente puede llevarse una sola sin que el grupo se lo impida');
});

await t('N3. máximo 0 sigue significando SIN LÍMITE, no se sube al mínimo', async () => {
  const g = await nuevoGrupo('Extras', { requerido: true, minimo: 2, maximo: 0 });
  const fila = await leer(g.id);
  assert.strictEqual(fila.maximo, 0, 'subirlo a 2 le pondría un techo que nadie pidió');
  assert.deepStrictEqual(cardinalidadDeGrupo(fila), { minimo: 2, maximo: Infinity });
});

// ═══ Un imposible NUNCA llega a la base ═════════════════════════════════════
await t('N4. crear con máximo por debajo del mínimo NO guarda un grupo imposible', async () => {
  const g = await nuevoGrupo('Imposible Al Crear', { requerido: true, minimo: 3, maximo: 1 });
  const fila = await leer(g.id);
  assert.ok(fila.maximo >= fila.minimo, `guardó máx ${fila.maximo} < mín ${fila.minimo}`);
  assert.strictEqual(fila.minimo, 3, 'se sube el máximo, no se afloja el mínimo');
  assert.strictEqual(fila.maximo, 3);
});

await t('N5. PATCH de solo el máximo se valida contra el mínimo YA guardado', async () => {
  const g = await nuevoGrupo('Baja Solo El Maximo', { requerido: true, minimo: 2, maximo: 2 });
  await actualizarGrupoModificador(g.id, { maximo: 1 }, NEG);
  const fila = await leer(g.id);
  assert.ok(fila.maximo >= fila.minimo, `quedó máx ${fila.maximo} < mín ${fila.minimo}: nadie puede pedirlo`);
});

await t('N6. lo guardado por estas funciones jamás sale `inconsistente`', async () => {
  const grupos = (await cargarGruposDeProductos(NEG, [PROD])).get(PROD) || [];
  assert.ok(grupos.length >= 5, 'el fixture debe traer los grupos creados arriba');
  const r = validarCardinalidadGrupos(grupos, []);
  assert.deepStrictEqual(r.inconsistentes, [],
    'un grupo inconsistente bloquea el producto entero para el cliente');
});

// ═══ `requerido` y `minimo` son la misma verdad ═════════════════════════════
await t('N7. quitar lo obligatorio en un grupo 2..2 lo hace opcional DE VERDAD', async () => {
  const g = await nuevoGrupo('Deja De Ser Obligatorio', { requerido: true, minimo: 2, maximo: 2 });
  await actualizarGrupoModificador(g.id, { requerido: false }, NEG);
  const fila = await leer(g.id);
  assert.strictEqual(cardinalidadDeGrupo(fila).minimo, 0,
    'guardaba requerido=false dejando minimo=2, y el bot seguía exigiendo dos');
});

await t('N8. marcar obligatorio un grupo opcional sube el mínimo a 1', async () => {
  const g = await nuevoGrupo('Se Vuelve Obligatorio', { requerido: false, minimo: 0, maximo: 2 });
  await actualizarGrupoModificador(g.id, { requerido: true }, NEG);
  const fila = await leer(g.id);
  assert.strictEqual(fila.minimo, 1);
  assert.strictEqual(cardinalidadDeGrupo(fila).minimo, 1);
});

await t('N9. un mínimo >= 1 marca el grupo requerido aunque digan lo contrario', async () => {
  const g = await nuevoGrupo('Opcional Contradictorio', { requerido: false, minimo: 2, maximo: 3 });
  const fila = await leer(g.id);
  assert.strictEqual(fila.requerido, true,
    '"opcional pero elige al menos 2" no existe: el mínimo manda');
});

// ═══ Controles negativos ════════════════════════════════════════════════════
await t('N10. renombrar NO toca la cardinalidad', async () => {
  const g = await nuevoGrupo('Nombre Viejo', { requerido: true, minimo: 2, maximo: 3 });
  await actualizarGrupoModificador(g.id, { nombre: 'Nombre Nuevo' }, NEG);
  const fila = await leer(g.id);
  assert.strictEqual(fila.nombre, 'Nombre Nuevo');
  assert.strictEqual(fila.minimo, 2, 'un PATCH de nombre no debe reescribir min/max');
  assert.strictEqual(fila.maximo, 3);
});

await t('N11. un PATCH de otro negocio no escribe nada', async () => {
  const g = await nuevoGrupo('Ajeno', { requerido: true, minimo: 2, maximo: 2 });
  await actualizarGrupoModificador(g.id, { minimo: 1, maximo: 5 }, OTRO);
  const fila = await leer(g.id);
  assert.strictEqual(fila.minimo, 2, 'aislamiento entre negocios');
  assert.strictEqual(fila.maximo, 2);
});

await t('N12. basura en los campos cae a valores sanos, no revienta ni guarda NaN', async () => {
  assert.deepStrictEqual(normalizarCardinalidadGrupo({ minimo: 'dos', maximo: null }),
    { requerido: false, minimo: 0, maximo: 0 });
  assert.deepStrictEqual(normalizarCardinalidadGrupo({ minimo: -3, maximo: -1 }),
    { requerido: false, minimo: 0, maximo: 0 });
  assert.deepStrictEqual(normalizarCardinalidadGrupo({ requerido: true, minimo: undefined, maximo: 2 }),
    { requerido: true, minimo: 1, maximo: 2 }, 'requerido sin mínimo explícito sigue siendo 1..2');
  const g = await nuevoGrupo('Basura', { requerido: true, minimo: 'x', maximo: 'y' });
  const fila = await leer(g.id);
  assert.strictEqual(fila.minimo, 1, 'requerido sin mínimo utilizable = al menos 1');
  assert.deepStrictEqual(cardinalidadDeGrupo(fila), { minimo: 1, maximo: Infinity },
    'un máximo ilegible cae a "sin límite": deja pedir de más, nunca bloquea el producto');
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
