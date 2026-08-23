// Precio por canal en Rappi: el negocio decide cómo se calcula el precio
// que se publica, y el precio base de Xabor NUNCA cambia.
//
// El riesgo real que fija esta suite es financiero en los dos sentidos: un
// ajuste que se filtre al precio base cobraría de más en mostrador, y un
// ajuste que no se aplique deja al negocio absorbiendo la comisión de Rappi
// sin saberlo. Aquí se prueba que el ajuste vive SOLO en el payload de Rappi.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
// Se normalizan los saltos de línea: en Windows git materializa el panel con
// CRLF, y esta suite lo lee buscando estructura (dónde empieza y termina una
// función), no bytes. Sin normalizar, la misma prueba pasa o falla según cómo
// esté configurado el checkout -- que es la peor clase de prueba que existe.
const PANEL = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

const { pool, obtenerConfiguracionCanal, guardarConfiguracionCanal } = await import('../src/services/database.js');
const { construirCatalogoRappi } = await import('../src/services/rappi-api.js');
const {
  calcularPrecioRappi, normalizarPricingRappi, validarPricingRappi,
  describirPricingRappi, PORCENTAJE_MAXIMO,
} = await import('../src/services/rappiPricing.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const suf = Date.now().toString().slice(-6);
const STORE_A = `PC_A_${suf}`;
const STORE_B = `PC_B_${suf}`;
const PREFIJO = `PC ${suf}`;
const LOUISIANA = `${PREFIJO} Louisiana`;

const PRODUCTOS_A = [
  { nombre: LOUISIANA, precio: 180, codigo: `PCPAN1${suf}`, cat: 'Paninis' },
  { nombre: `${PREFIJO} Parm`, precio: 195, codigo: null, cat: 'Paninis', conGrupo: true },
  { nombre: `${PREFIJO} Envio`, precio: 60, codigo: null, cat: 'Logistica', opciones: { tipo_item: 'envio' } },
];

async function del(sql, params) {
  try { await pool.query(sql, params); } catch (e) { console.warn('[limpieza] paso omitido:', e.message.slice(0, 80)); }
}
async function limpiar() {
  for (const neg of [NEG_A, NEG_B]) {
    await del(`DELETE FROM menu_modificadores_opciones WHERE negocio_id = $1 AND nombre LIKE 'PC %'`, [neg]);
    await del(`DELETE FROM menu_modificadores_grupos WHERE negocio_id = $1 AND nombre LIKE 'PC %'`, [neg]);
    await del(`DELETE FROM menu_productos WHERE negocio_id = $1 AND nombre LIKE 'PC %'`, [neg]);
    await del(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre LIKE 'PC %'`, [neg]);
    await del(`DELETE FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'rappi'`, [neg]);
  }
}

try {
  await limpiar();

  const catIds = {};
  for (const [i, nombre] of ['Paninis', 'Logistica'].entries()) {
    const { rows: [c] } = await pool.query(
      `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,$3) RETURNING id`,
      [NEG_A, `PC ${nombre} ${suf}`, 950 + i]);
    catIds[nombre] = c.id;
  }
  for (const [i, p] of PRODUCTOS_A.entries()) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, descripcion, precio, disponible, agotado, orden, opciones)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,FALSE,$7,$8) RETURNING id`,
      [NEG_A, catIds[p.cat], p.codigo, p.nombre, `Desc ${p.nombre}`, p.precio, i + 1,
       p.opciones ? JSON.stringify(p.opciones) : null]);
    if (p.conGrupo) {
      const { rows: [g] } = await pool.query(
        `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
         VALUES ($1,$2,$3,FALSE,0,2,1) RETURNING id`, [NEG_A, row.id, `PC Extras ${suf}`]);
      for (const [j, o] of [['PC Tocino', 40], ['PC Sin costo', 0]].entries()) {
        await pool.query(
          `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
           VALUES ($1,$2,$3,$4,TRUE,$5)`, [NEG_A, g.id, `${o[0]} ${suf}`, o[1], j + 1]);
      }
    }
  }
  const { rows: [catB] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,951) RETURNING id`,
    [NEG_B, `PC Otros ${suf}`]);
  await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
     VALUES ($1,$2,$3,180,TRUE,FALSE,1)`, [NEG_B, catB.id, `PC Ajeno ${suf}`]);
  for (const [neg, store] of [[NEG_A, STORE_A], [NEG_B, STORE_B]]) {
    await pool.query(
      `INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, estado, activo)
       VALUES ($1,'rappi',$2,'PC test','activo',TRUE)`, [neg, store]);
  }

  const precioDe = (cat, nombre) => cat.items.find(i => i.name === nombre)?.price;

  await t('1. sin configuración de precios, el catálogo sale al precio base', async () => {
    const cfg = await obtenerConfiguracionCanal(NEG_A, 'rappi');
    assert.strictEqual(cfg.rappi_pricing, undefined, 'el fixture no debería traer configuración');
    const cat = await construirCatalogoRappi(NEG_A, { storeId: STORE_A });
    assert.strictEqual(precioDe(cat, LOUISIANA), 180);
  });

  await t('2. estrategia precio_base publica el precio base tal cual', async () => {
    await guardarConfiguracionCanal(NEG_A, 'rappi', { rappi_pricing: { estrategia: 'precio_base', porcentaje: 0 } });
    const cat = await construirCatalogoRappi(NEG_A, { storeId: STORE_A });
    assert.strictEqual(precioDe(cat, LOUISIANA), 180);
  });

  await t('3. sumar 25% convierte 180 en 225 (y 195 en 244)', async () => {
    await guardarConfiguracionCanal(NEG_A, 'rappi', { rappi_pricing: { estrategia: 'sumar_porcentaje', porcentaje: 25 } });
    const cat = await construirCatalogoRappi(NEG_A, { storeId: STORE_A });
    assert.strictEqual(precioDe(cat, LOUISIANA), 225);
    assert.strictEqual(precioDe(cat, `${PREFIJO} Parm`), 244);   // 195*1.25 = 243.75 -> peso entero
  });

  await t('4. recuperar comisión 25% convierte 180 en 240 y conserva el neto', async () => {
    await guardarConfiguracionCanal(NEG_A, 'rappi', { rappi_pricing: { estrategia: 'recuperar_comision', porcentaje: 25 } });
    const cat = await construirCatalogoRappi(NEG_A, { storeId: STORE_A });
    assert.strictEqual(precioDe(cat, LOUISIANA), 240);
    // La razón de ser de la estrategia: tras la comisión queda el precio base.
    assert.strictEqual(Math.round(240 * 0.75), 180);
    // Y la alternativa NO lo conserva -- por eso existen las dos opciones.
    assert.ok(Math.round(225 * 0.75) < 180, 'sumar_porcentaje no debería conservar el neto');
  });

  await t('5. aislamiento: el ajuste de A no toca el catálogo de B', async () => {
    await guardarConfiguracionCanal(NEG_A, 'rappi', { rappi_pricing: { estrategia: 'recuperar_comision', porcentaje: 25 } });
    await guardarConfiguracionCanal(NEG_B, 'rappi', { rappi_pricing: { estrategia: 'precio_base', porcentaje: 0 } });
    const catA = await construirCatalogoRappi(NEG_A, { storeId: STORE_A });
    const catB = await construirCatalogoRappi(NEG_B, { storeId: STORE_B });
    assert.strictEqual(precioDe(catA, LOUISIANA), 240);
    assert.strictEqual(precioDe(catB, `PC Ajeno ${suf}`), 180, 'B (sin ajuste) heredó el ajuste de A');
    const cfgA = await obtenerConfiguracionCanal(NEG_A, 'rappi');
    const cfgB = await obtenerConfiguracionCanal(NEG_B, 'rappi');
    assert.strictEqual(cfgA.rappi_pricing.estrategia, 'recuperar_comision');
    assert.strictEqual(cfgB.rappi_pricing.estrategia, 'precio_base');
  });

  await t('6. el precio en la base NUNCA cambia por publicar con ajuste', async () => {
    await guardarConfiguracionCanal(NEG_A, 'rappi', { rappi_pricing: { estrategia: 'recuperar_comision', porcentaje: 40 } });
    await construirCatalogoRappi(NEG_A, { storeId: STORE_A });
    const { rows } = await pool.query(
      `SELECT nombre, precio FROM menu_productos WHERE negocio_id = $1 AND nombre LIKE 'PC %' ORDER BY nombre`, [NEG_A]);
    const enBase = Object.fromEntries(rows.map(r => [r.nombre, Number(r.precio)]));
    assert.strictEqual(enBase[LOUISIANA], 180, 'el precio base fue modificado: falla financiera');
    assert.strictEqual(enBase[`${PREFIJO} Parm`], 195);
    assert.strictEqual(enBase[`${PREFIJO} Envio`], 60);
    const { rows: extras } = await pool.query(
      `SELECT nombre, precio_extra FROM menu_modificadores_opciones WHERE negocio_id = $1 AND nombre LIKE 'PC Tocino%'`, [NEG_A]);
    assert.strictEqual(Number(extras[0].precio_extra), 40);
  });

  await t('7. el cargo de envío sigue excluido, tenga el ajuste que tenga', async () => {
    for (const estrategia of ['precio_base', 'sumar_porcentaje', 'recuperar_comision']) {
      await guardarConfiguracionCanal(NEG_A, 'rappi', { rappi_pricing: { estrategia, porcentaje: 30 } });
      const cat = await construirCatalogoRappi(NEG_A, { storeId: STORE_A });
      assert.ok(!cat.items.some(i => i.name === `${PREFIJO} Envio`),
        `el cargo de envío se publicó con estrategia ${estrategia}`);
    }
  });

  await t('8. el SKU no cambia al cambiar el precio', async () => {
    await guardarConfiguracionCanal(NEG_A, 'rappi', { rappi_pricing: { estrategia: 'precio_base', porcentaje: 0 } });
    const skuBase = (await construirCatalogoRappi(NEG_A, { storeId: STORE_A })).items.find(i => i.name === LOUISIANA).sku;
    await guardarConfiguracionCanal(NEG_A, 'rappi', { rappi_pricing: { estrategia: 'recuperar_comision', porcentaje: 25 } });
    const conAjuste = (await construirCatalogoRappi(NEG_A, { storeId: STORE_A })).items.find(i => i.name === LOUISIANA);
    assert.strictEqual(conAjuste.sku, skuBase, 'el SKU cambió: Rappi lo vería como otro producto');
    assert.strictEqual(conAjuste.sku, `PCPAN1${suf}`);
  });

  await t('9. configuración corrupta jamás produce NaN, negativos ni excepción', async () => {
    const basuras = [
      null, undefined, 'no-es-json', 42, [], {},
      { estrategia: 'inventada', porcentaje: 25 },
      { estrategia: 'sumar_porcentaje', porcentaje: 'abc' },
      { estrategia: 'sumar_porcentaje', porcentaje: NaN },
      { estrategia: 'sumar_porcentaje', porcentaje: Infinity },
      { estrategia: 'recuperar_comision', porcentaje: -10 },
      { estrategia: 'recuperar_comision', porcentaje: 100 },
      { estrategia: 'recuperar_comision', porcentaje: 999 },
    ];
    for (const basura of basuras) {
      const p = calcularPrecioRappi(180, basura);
      assert.ok(Number.isFinite(p) && p > 0, `basura ${JSON.stringify(basura)} produjo ${p}`);
      assert.strictEqual(p, 180, `basura ${JSON.stringify(basura)} no cayó a precio base`);
    }
    await pool.query(
      `UPDATE integraciones_canal SET configuracion = $2::jsonb WHERE negocio_id = $1 AND canal = 'rappi'`,
      [NEG_A, JSON.stringify({ rappi_pricing: { estrategia: 'recuperar_comision', porcentaje: 100 } })]);
    const cat = await construirCatalogoRappi(NEG_A, { storeId: STORE_A });
    assert.strictEqual(precioDe(cat, LOUISIANA), 180, 'una configuración imposible debe caer a precio base');
  });

  await t('10. la escritura rechaza 100% y todo lo que no sea razonable', async () => {
    assert.strictEqual(validarPricingRappi({ estrategia: 'recuperar_comision', porcentaje: 100 }).ok, false);
    assert.strictEqual(validarPricingRappi({ estrategia: 'recuperar_comision', porcentaje: 99 }).ok, false); // tope 80
    assert.strictEqual(validarPricingRappi({ estrategia: 'sumar_porcentaje', porcentaje: -1 }).ok, false);
    assert.strictEqual(validarPricingRappi({ estrategia: 'sumar_porcentaje', porcentaje: 'x' }).ok, false);
    assert.strictEqual(validarPricingRappi({ estrategia: 'otra', porcentaje: 10 }).ok, false);
    assert.strictEqual(validarPricingRappi(null).ok, false);
    assert.strictEqual(validarPricingRappi({ estrategia: 'sumar_porcentaje', porcentaje: PORCENTAJE_MAXIMO }).ok, true);
    assert.strictEqual(validarPricingRappi({ estrategia: 'precio_base' }).ok, true,
      'precio_base no debería exigir porcentaje');
    assert.deepStrictEqual(validarPricingRappi({ estrategia: 'precio_base', porcentaje: 33 }).valor,
      { estrategia: 'precio_base', porcentaje: 0 });
  });

  await t('11. la vista previa del panel coincide con el cálculo del backend', async () => {
    const m = PANEL.match(/const RP_PORCENTAJE_MAXIMO[\s\S]*?\n}\n\nfunction rappiPreciosCambio/);
    assert.ok(m, 'no se encontró la función de vista previa en el panel');
    const fuente = m[0].replace(/\nfunction rappiPreciosCambio/, '');
    const previewPanel = new Function(`${fuente}; return precioRappiPreview;`)();
    let comparaciones = 0;
    for (const estrategia of ['precio_base', 'sumar_porcentaje', 'recuperar_comision']) {
      for (const pct of [0, 1, 5, 25, 33.3, 50, 80, 81, 100, -5, NaN]) {
        for (const base of [180, 195, 179, 225, 35, 0, 1234.56]) {
          assert.strictEqual(
            previewPanel(base, estrategia, pct),
            calcularPrecioRappi(base, { estrategia, porcentaje: pct }),
            `divergencia en ${estrategia} ${pct}% sobre ${base}`);
          comparaciones++;
        }
      }
    }
    assert.ok(comparaciones >= 200, 'la matriz de comparación quedó demasiado chica');
  });

  await t('12. el catálogo conserva el contrato que Rappi ya aceptó', async () => {
    await guardarConfiguracionCanal(NEG_A, 'rappi', { rappi_pricing: { estrategia: 'sumar_porcentaje', porcentaje: 25 } });
    const cat = await construirCatalogoRappi(NEG_A, { storeId: STORE_A });
    assert.strictEqual(cat.storeId, STORE_A);
    for (const item of cat.items) {
      for (const campo of ['sku', 'name', 'type', 'price', 'category', 'children', 'imageUrl', 'maxLimit', 'sortingPosition', 'description']) {
        assert.ok(campo in item, `falta ${campo} en ${item.name}`);
      }
      assert.strictEqual(item.type, 'PRODUCT');
      assert.strictEqual(typeof item.price, 'number');
      assert.ok(Number.isFinite(item.price) && item.price >= 0, `precio inválido en ${item.name}`);
      assert.ok(Number.isInteger(item.price), `precio con centavos en ${item.name}: ${item.price}`);
      for (const hijo of item.children) {
        assert.strictEqual(hijo.type, 'TOPPING');
        assert.ok(Number.isInteger(hijo.price), `topping con centavos: ${hijo.name}`);
      }
    }
    // El extra de $40 también lleva el ajuste (paga comisión igual que el plato).
    const parm = cat.items.find(i => i.name === `${PREFIJO} Parm`);
    const tocino = parm.children.find(c => /Tocino/.test(c.name));
    assert.strictEqual(tocino.price, 50, '40 * 1.25 = 50');
    const gratis = parm.children.find(c => /Sin costo/.test(c.name));
    assert.strictEqual(gratis.price, 0, 'un extra sin costo debe seguir en 0');
  });

  await t('13. la configuración de precios convive con otros metadatos del canal', async () => {
    await pool.query(
      `UPDATE integraciones_canal SET configuracion = $2::jsonb WHERE negocio_id = $1 AND canal = 'rappi'`,
      [NEG_A, JSON.stringify({ cooking_time: 20, nombre_visible: 'Sucursal centro' })]);
    await guardarConfiguracionCanal(NEG_A, 'rappi', { rappi_pricing: { estrategia: 'sumar_porcentaje', porcentaje: 10 } });
    const cfg = await obtenerConfiguracionCanal(NEG_A, 'rappi');
    assert.strictEqual(cfg.cooking_time, 20, 'guardar precios borró otro metadato del canal');
    assert.strictEqual(cfg.nombre_visible, 'Sucursal centro');
    assert.strictEqual(cfg.rappi_pricing.porcentaje, 10);
    assert.strictEqual(describirPricingRappi(cfg.rappi_pricing), 'precio de Xabor +10%');
  });

  await t('14. normalizar es idempotente y nunca lanza', async () => {
    const entradas = [undefined, null, '{}', '{"estrategia":"sumar_porcentaje","porcentaje":"25"}', { estrategia: 'precio_base' }];
    for (const entrada of entradas) {
      const una = normalizarPricingRappi(entrada);
      const dos = normalizarPricingRappi(una);
      assert.deepStrictEqual(dos, una);
      assert.ok(['precio_base', 'sumar_porcentaje', 'recuperar_comision'].includes(una.estrategia));
      assert.ok(Number.isFinite(una.porcentaje));
    }
    // Un porcentaje que llega como texto numérico sí se acepta (los formularios
    // mandan strings) -- eso es normalización, no permisividad.
    assert.strictEqual(normalizarPricingRappi({ estrategia: 'sumar_porcentaje', porcentaje: '25' }).porcentaje, 25);
  });

  await t('15. guardar precios en un negocio sin integración de Rappi no crea nada', async () => {
    await del(`DELETE FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'rappi'`, [NEG_B]);
    const r = await guardarConfiguracionCanal(NEG_B, 'rappi', { rappi_pricing: { estrategia: 'sumar_porcentaje', porcentaje: 15 } });
    assert.strictEqual(r, null, 'debería devolver null en vez de dar de alta el canal por su cuenta');
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'rappi'`, [NEG_B]);
    assert.strictEqual(rows[0].n, 0, 'se creó una integración de Rappi como efecto colateral');
  });

} catch (e) {
  console.error('ERROR FATAL EN LA SUITE:', e);
  fallidas++; fallos.push(`fatal: ${e.message}`);
} finally {
  await limpiar();
  await pool.end();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
