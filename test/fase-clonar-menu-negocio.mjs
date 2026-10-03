// Clonar el menú de un negocio a otro (scripts/clonar-menu-negocio.mjs): copia
// fiel, ids traducidos, archivos propios del destino, origen intacto, idempotente
// y todo o nada. Base local test_botones_*; archivos simulados, sin R2.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/services/database.js';
import { clonarMenu, inspeccionarMenus, leerMenu, huellaMenu } from '../scripts/clonar-menu-negocio.mjs';

let n = 0, fallidas = 0;
async function caso(nombre, fn) {
  try { await fn(); console.log(`OK clonar-menu ${++n}: ${nombre}`); }
  catch (e) { fallidas++; console.log(`FALLA clonar-menu: ${nombre}\n  ${String(e?.message || e).split('\n')[0]}`); }
}
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

async function negocio(nombre) {
  const [r] = await q('INSERT INTO negocios(nombre,slug) VALUES($1,$2) RETURNING id', [nombre, `clonar-${randomUUID().slice(0, 8)}`]);
  return r.id;
}
const slugDe = async (id) => (await q('SELECT slug FROM negocios WHERE id=$1', [id]))[0].slug;
// Origen: dos categorías, foto, variante, grupos con opciones (una no disponible),
// carta de WhatsApp, tienda, dos promociones con referencias y menú en imagen.
async function origenCompleto() {
  const o = await negocio('Origen clon');
  const [c1] = await q('INSERT INTO menu_categorias(negocio_id,nombre,orden) VALUES($1,$2,1) RETURNING id', [o, 'DESAYUNOS']);
  const [c2] = await q('INSERT INTO menu_categorias(negocio_id,nombre,orden) VALUES($1,$2,1) RETURNING id', [o, 'BEBIDAS']);
  const foto = { mime: 'image/jpeg', bytes: 10, nombre: 'f.jpg', storage_key: `production/negocios/${o}/productos/a.jpg`, actualizado_at: '2026-09-30T00:00:00Z' };
  const [p1] = await q(`INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio,opciones,orden,destacado) VALUES($1,$2,'Chilaquiles',195,$3,1,true) RETURNING id`, [o, c1.id, JSON.stringify({ imagen: foto })]);
  const [p2] = await q(`INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio,opciones,orden) VALUES($1,$2,'Hotcakes',179,$3,1) RETURNING id`, [o, c1.id, JSON.stringify({ variante: 'grande' })]);
  const [p3] = await q(`INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio,orden,agotado) VALUES($1,$2,'Café',45,0,true) RETURNING id`, [o, c2.id]);
  const [g1] = await q(`INSERT INTO menu_modificadores_grupos(negocio_id,producto_id,nombre,requerido,minimo,maximo,orden) VALUES($1,$2,'Salsa',true,1,1,1) RETURNING id`, [o, p1.id]);
  const [g2] = await q(`INSERT INTO menu_modificadores_grupos(negocio_id,producto_id,nombre,requerido,minimo,maximo,orden) VALUES($1,$2,'Proteína',false,0,2,2) RETURNING id`, [o, p1.id]);
  const [o1] = await q(`INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,orden) VALUES($1,$2,'Roja',0,1) RETURNING id`, [o, g1.id]);
  await q(`INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,orden) VALUES($1,$2,'Verde',0,2)`, [o, g1.id]);
  const [o3] = await q(`INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,orden,disponible) VALUES($1,$2,'Pollo',35,1,false) RETURNING id`, [o, g2.id]);
  await q(`INSERT INTO whatsapp_productos(negocio_id,producto_id,publicado,origen) VALUES($1,$2,true,'panel'),($1,$3,true,'panel'),($1,$4,false,'panel')`, [o, p1.id, p2.id, p3.id]);
  await q(`INSERT INTO tienda_productos(negocio_id,producto_id,badge,precio_tienda,orden) VALUES($1,$2,'Nuevo',190,1)`, [o, p1.id]);
  await q(`INSERT INTO tienda_promociones(negocio_id,nombre,tipo,valor,canales,productos,condiciones_modificadores,usos,activa,automatica)
    VALUES($1,'Miércoles 2x1','2x1',0,'["pos","whatsapp"]',$2,$3,7,true,true)`, [o, JSON.stringify([p1.id]),
    JSON.stringify([{ producto_id: p1.id, grupo_id: g1.id, operador: 'una_de', option_ids: [o1.id] }, { producto_id: p1.id, grupo_id: g2.id, operador: 'una_de', option_ids: [o3.id] }])]);
  await q(`INSERT INTO tienda_promociones(negocio_id,nombre,tipo,valor,canales,categorias,activa,codigo) VALUES($1,'Bebidas -10','porcentaje',10,'["pos"]',$2,false,'BEB10')`,
    [o, JSON.stringify([c2.id])]);
  await q(`INSERT INTO whatsapp_menu_automatico(negocio_id,activo,frases_disparadoras,revision_carta_huella,revisado_at) VALUES($1,true,$2,'h',now())`,
    [o, ['me mandas el menu?', 'menú']]);
  for (const [orden, k] of [[1, 'm1'], [2, 'm2']]) await q(`INSERT INTO whatsapp_menu_imagenes(negocio_id,storage_key,mime_type,nombre_archivo,tamano_bytes,orden)
    VALUES($1,$2,'image/jpeg',$3,100,$4)`, [o, `production/negocios/${o}/menu/${k}.jpg`, `${k}.jpg`, orden]);
  return o;
}
// Destino: el menú de prueba (una categoría, un producto con su grupo).
async function destinoDePrueba() {
  const d = await negocio('Destino clon');
  const [c] = await q(`INSERT INTO menu_categorias(negocio_id,nombre) VALUES($1,'Chilaquiles') RETURNING id`, [d]);
  const [p] = await q(`INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio) VALUES($1,$2,'Chilaquiles',195) RETURNING id`, [d, c.id]);
  const [g] = await q(`INSERT INTO menu_modificadores_grupos(negocio_id,producto_id,nombre) VALUES($1,$2,'Salsa') RETURNING id`, [d, p.id]);
  await q(`INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre) VALUES($1,$2,'Roja')`, [d, g.id]);
  return d;
}
// Archivos simulados: cada copia es una clave nueva del destino; se registra todo.
function archivosFalsos({ fallarEn = 0 } = {}) {
  const r = { copiados: [], eliminados: [], llamadas: 0 };
  r.copiar = async (key, { negocioId, categoria, ext }) => {
    r.llamadas++;
    if (fallarEn && r.llamadas === fallarEn) throw new Error('falla simulada de almacenamiento');
    const nueva = `production/negocios/${negocioId}/${categoria === 'menu' ? 'menu' : 'productos'}/${randomUUID()}.${ext}`;
    r.copiados.push([key, nueva]); return nueva;
  };
  r.eliminar = async (key) => { r.eliminados.push(key); };
  return r;
}

try {
  await caso('copia fiel: misma huella, ids del destino, archivos propios, promociones traducidas y el origen intacto', async () => {
    const o = await origenCompleto(), d = await destinoDePrueba();
    const ins = await inspeccionarMenus(pool, { origen: o, destino: d });
    assert.deepEqual(ins.destino.productos, ['Chilaquiles $195.00']);
    assert.deepEqual(ins.promocionesColgantes, []);
    const archivos = archivosFalsos();
    const r = await clonarMenu(pool, { origen: o, destino: d, slugDestino: await slugDe(d), huellaOrigen: ins.origen.huella, huellaDestino: ins.destino.huella, archivos });
    assert.equal(r.aplicado, true); assert.equal(r.archivosNuevos, 3);
    const mo = await leerMenu(pool, o), md = await leerMenu(pool, d);
    assert.equal(huellaMenu(md), huellaMenu(mo)); assert.equal(huellaMenu(mo), ins.origen.huella, 'el origen no cambió');
    assert.equal(md.productos.length, 3); assert.equal(md.grupos.length, 2); assert.equal(md.opciones.length, 3);
    assert.equal(md.whatsapp.filter((w) => w.publicado).length, 2); assert.equal(md.tienda.length, 1);
    // Ningún id del origen en el destino, ni archivo compartido.
    const idsO = new Set([...mo.productos, ...mo.grupos, ...mo.opciones, ...mo.categorias].map((x) => x.id));
    for (const x of [...md.productos, ...md.grupos, ...md.opciones, ...md.categorias]) assert(!idsO.has(x.id));
    const foto = md.productos.find((p) => p.nombre === 'Chilaquiles').opciones.imagen;
    assert.match(foto.storage_key, new RegExp(`/negocios/${d}/productos/`)); assert.equal(foto.nombre, 'f.jpg');
    for (const i of md.menuImagenes) assert.match(i.storage_key, new RegExp(`/negocios/${d}/menu/`));
    // Promociones: referencias del destino y usos en cero.
    const promo = md.promociones.find((p) => p.nombre === 'Miércoles 2x1');
    const pid = md.productos.find((p) => p.nombre === 'Chilaquiles').id;
    assert.deepEqual(promo.productos, [pid]);
    const gruposD = new Set(md.grupos.map((g) => g.id)), opcionesD = new Set(md.opciones.map((x) => x.id));
    for (const c of promo.condiciones_modificadores) { assert.equal(c.producto_id, pid); assert(gruposD.has(c.grupo_id)); for (const id of c.option_ids) assert(opcionesD.has(id)); }
    assert.deepEqual(md.promociones.find((p) => p.nombre === 'Bebidas -10').categorias, [md.categorias.find((c) => c.nombre === 'BEBIDAS').id]);
    const [{ usos }] = await q(`SELECT usos FROM tienda_promociones WHERE negocio_id=$1 AND nombre='Miércoles 2x1'`, [d]);
    assert.equal(usos, 0);
    // El menú en imagen nace sin revisión (su huella llevaría ids del origen).
    const [auto] = await q('SELECT activo, revision_carta_huella, revisado_at FROM whatsapp_menu_automatico WHERE negocio_id=$1', [d]);
    assert.equal(auto.activo, true); assert.equal(auto.revision_carta_huella, null); assert.equal(auto.revisado_at, null);
    // Repetir: sin cambios.
    const otra = await clonarMenu(pool, { origen: o, destino: d, slugDestino: await slugDe(d), huellaOrigen: ins.origen.huella, huellaDestino: ins.destino.huella, archivos: archivosFalsos() });
    assert.equal(otra.sinCambios, true);
  });

  await caso('si alguien cambió el origen o el destino después de inspeccionar, no escribe nada', async () => {
    const o = await origenCompleto(), d = await destinoDePrueba();
    const ins = await inspeccionarMenus(pool, { origen: o, destino: d });
    const antes = huellaMenu(await leerMenu(pool, d));
    await assert.rejects(clonarMenu(pool, { origen: o, destino: d, slugDestino: await slugDe(d), huellaOrigen: '0'.repeat(64), huellaDestino: ins.destino.huella, archivos: archivosFalsos() }), /origen cambió/);
    await assert.rejects(clonarMenu(pool, { origen: o, destino: d, slugDestino: await slugDe(d), huellaOrigen: ins.origen.huella, huellaDestino: '0'.repeat(64), archivos: archivosFalsos() }), /destino cambió/);
    assert.equal(huellaMenu(await leerMenu(pool, d)), antes);
  });

  await caso('una falla a mitad deshace todo y borra los archivos que alcanzó a copiar', async () => {
    const o = await origenCompleto(), d = await destinoDePrueba();
    const ins = await inspeccionarMenus(pool, { origen: o, destino: d });
    const archivos = archivosFalsos({ fallarEn: 3 });
    await assert.rejects(clonarMenu(pool, { origen: o, destino: d, slugDestino: await slugDe(d), huellaOrigen: ins.origen.huella, huellaDestino: ins.destino.huella, archivos }), /falla simulada/);
    assert.equal(huellaMenu(await leerMenu(pool, d)), ins.destino.huella, 'el destino quedó como estaba');
    assert.deepEqual(archivos.eliminados.sort(), archivos.copiados.map(([, k]) => k).sort());
    assert.equal(archivos.copiados.length, 2);
  });

  await caso('una promoción con una referencia que no existe en el origen detiene el clon', async () => {
    const o = await origenCompleto(), d = await destinoDePrueba();
    await q(`INSERT INTO tienda_promociones(negocio_id,nombre,tipo,valor,productos,automatica) VALUES($1,'Colgante','2x1',0,'[999999999]',true)`, [o]);
    const ins = await inspeccionarMenus(pool, { origen: o, destino: d });
    assert.equal(ins.promocionesColgantes.length, 1);
    const archivos = archivosFalsos();
    await assert.rejects(clonarMenu(pool, { origen: o, destino: d, slugDestino: await slugDe(d), huellaOrigen: ins.origen.huella, huellaDestino: ins.destino.huella, archivos }), /no existe en el menú/);
    assert.equal(archivos.copiados.length, 0, 'no copió archivos antes de detenerse');
    assert.equal(huellaMenu(await leerMenu(pool, d)), ins.destino.huella);
  });

  await caso('candado: argumentos invertidos (destino con el bot encendido) o slug que no es el del destino: no escribe nada', async () => {
    const o = await origenCompleto(), d = await destinoDePrueba();
    await q('UPDATE negocios SET bot_whatsapp_activo=true WHERE id=$1', [o]);
    const huellaO = huellaMenu(await leerMenu(pool, o)), huellaD = huellaMenu(await leerMenu(pool, d));
    // Invertidos: el «destino» sería el negocio que está atendiendo.
    await assert.rejects(clonarMenu(pool, { origen: d, destino: o, slugDestino: await slugDe(o), huellaOrigen: huellaD, huellaDestino: huellaO,
      archivos: archivosFalsos() }), /bot encendido/);
    await assert.rejects(clonarMenu(pool, { origen: o, destino: d, slugDestino: await slugDe(o), huellaOrigen: huellaO, huellaDestino: huellaD,
      archivos: archivosFalsos() }), /revisa el orden/);
    assert.equal(huellaMenu(await leerMenu(pool, o)), huellaO, 'el negocio que atiende quedó intacto');
    assert.equal(huellaMenu(await leerMenu(pool, d)), huellaD);
  });

  await caso('origen y destino iguales: se niega', async () => {
    const o = await origenCompleto();
    await assert.rejects(clonarMenu(pool, { origen: o, destino: o, huellaOrigen: 'x', huellaDestino: 'x', archivos: archivosFalsos() }), /mismo negocio/);
  });
} finally { await pool.end(); }
console.log(`clonar-menu: ${n} OK, ${fallidas} fallos`);
if (fallidas) process.exitCode = 1;
