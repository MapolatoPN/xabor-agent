// Operación explícita del dueño (2-oct-2026): dejar el menú de un negocio igual
// al de otro (Mapolato Acuña igual a Obispado). Copia categorías, productos,
// grupos y opciones de modificadores, la carta de WhatsApp, los productos de la
// tienda, las promociones (con sus referencias traducidas) y el menú en imagen.
// El origen SOLO se lee. Las fotos se copian a archivos nuevos del destino: una
// clave compartida haría que borrar una foto en un negocio la borrara en el otro.
//
//   node scripts/clonar-menu-negocio.mjs inspeccionar <origen> <destino>
//   node scripts/clonar-menu-negocio.mjs aplicar <origen> <destino> <huellaOrigen> <huellaDestino>
//
// `aplicar` exige las huellas que imprimió `inspeccionar` (nadie cambió nada en
// medio), corre en una transacción y, antes de confirmar, comprueba que el
// destino quedó con la misma huella que el origen. Repetirlo no cambia nada.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ordenar = (a, b) => (a.orden ?? 0) - (b.orden ?? 0) || a.id - b.id;
const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const objeto = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Todo el menú de un negocio, tal como está en la base (con ids). */
export async function leerMenu(db, negocioId) {
  const q = async (sql) => (await db.query(sql, [negocioId])).rows;
  return {
    categorias: await q('SELECT id,nombre,orden,activa FROM menu_categorias WHERE negocio_id=$1'),
    productos: await q(`SELECT id,categoria_id,codigo,nombre,descripcion,precio::text AS precio,disponible,opciones,orden,agotado,destacado
      FROM menu_productos WHERE negocio_id=$1`),
    grupos: await q('SELECT id,producto_id,nombre,requerido,minimo,maximo,orden FROM menu_modificadores_grupos WHERE negocio_id=$1'),
    opciones: await q('SELECT id,grupo_id,nombre,precio_extra::text AS precio_extra,disponible,orden FROM menu_modificadores_opciones WHERE negocio_id=$1'),
    whatsapp: await q('SELECT producto_id,publicado,origen FROM whatsapp_productos WHERE negocio_id=$1'),
    tienda: await q(`SELECT producto_id,publicado,destacado,badge,descripcion_comercial,imagen_url,precio_tienda::text AS precio_tienda,orden
      FROM tienda_productos WHERE negocio_id=$1`),
    promociones: await q(`SELECT id,nombre,tipo,codigo,automatica,valor::text AS valor,minimo_compra::text AS minimo_compra,
      max_descuento::text AS max_descuento,vigencia_desde,vigencia_hasta,dias_semana,hora_inicio,hora_fin,limite_usos,limite_por_cliente,
      solo_primera_compra,canales,modalidades,productos,categorias,acumulable,prioridad,activa,cantidad_requerida,cantidad_beneficiada,
      max_aplicaciones,condiciones_modificadores FROM tienda_promociones WHERE negocio_id=$1`),
    menuAuto: (await q('SELECT activo,frases_disparadoras FROM whatsapp_menu_automatico WHERE negocio_id=$1'))[0] || null,
    menuImagenes: await q('SELECT id,storage_key,mime_type,nombre_archivo,tamano_bytes,orden FROM whatsapp_menu_imagenes WHERE negocio_id=$1'),
  };
}

/**
 * Rutas estables (sin ids) para cada elemento: c<i>, c<i>/p<j>, …/g<k>, …/o<l>.
 * Los productos sin categoría van bajo «s». Dos menús iguales tienen las mismas rutas.
 */
export function rutasDelMenu(menu) {
  const rutas = { categoria: new Map(), producto: new Map(), grupo: new Map(), opcion: new Map() };
  const cats = [...menu.categorias].sort(ordenar);
  cats.forEach((c, i) => rutas.categoria.set(c.id, `c${i}`));
  const porCategoria = new Map();
  for (const p of menu.productos) {
    const k = rutas.categoria.get(p.categoria_id) ?? 's';
    if (!porCategoria.has(k)) porCategoria.set(k, []);
    porCategoria.get(k).push(p);
  }
  for (const [k, lista] of porCategoria) lista.sort(ordenar).forEach((p, j) => rutas.producto.set(p.id, `${k}/p${j}`));
  const gruposDe = new Map();
  for (const g of menu.grupos) { if (!gruposDe.has(g.producto_id)) gruposDe.set(g.producto_id, []); gruposDe.get(g.producto_id).push(g); }
  for (const [pid, lista] of gruposDe) lista.sort(ordenar).forEach((g, k) => rutas.grupo.set(g.id, `${rutas.producto.get(pid)}/g${k}`));
  const opcionesDe = new Map();
  for (const o of menu.opciones) { if (!opcionesDe.has(o.grupo_id)) opcionesDe.set(o.grupo_id, []); opcionesDe.get(o.grupo_id).push(o); }
  for (const [gid, lista] of opcionesDe) lista.sort(ordenar).forEach((o, l) => rutas.opcion.set(o.id, `${rutas.grupo.get(gid)}/o${l}`));
  return rutas;
}

/** La foto se compara por su contenido declarado, nunca por la clave del archivo. */
const opcionesComparables = (opciones) => {
  if (!objeto(opciones) || !objeto(opciones.imagen)) return opciones ?? null;
  const { storage_key, ...imagen } = opciones.imagen;
  return { ...opciones, imagen: { ...imagen, tiene_archivo: !!storage_key } };
};

/** Referencias de una promoción escritas como rutas; lanza si alguna no existe. */
export function referenciasComoRutas(promo, rutas) {
  const ruta = (mapa, id, que) => {
    const r = mapa.get(Number(id));
    if (!r) throw new Error(`promoción «${promo.nombre}»: ${que} ${id} no existe en el menú`);
    return r;
  };
  return {
    productos: Array.isArray(promo.productos) ? promo.productos.map((id) => ruta(rutas.producto, id, 'producto')) : promo.productos ?? null,
    categorias: Array.isArray(promo.categorias) ? promo.categorias.map((id) => ruta(rutas.categoria, id, 'categoría')) : promo.categorias ?? null,
    condiciones_modificadores: Array.isArray(promo.condiciones_modificadores)
      ? promo.condiciones_modificadores.map((c) => ({ ...c,
        producto_id: c.producto_id == null ? c.producto_id : ruta(rutas.producto, c.producto_id, 'producto'),
        grupo_id: c.grupo_id == null ? c.grupo_id : ruta(rutas.grupo, c.grupo_id, 'grupo'),
        option_ids: Array.isArray(c.option_ids) ? c.option_ids.map((id) => ruta(rutas.opcion, id, 'opción')) : c.option_ids }))
      : promo.condiciones_modificadores ?? null,
  };
}

/** Huella canónica del menú, sin ids ni claves de archivo: igual en origen y en una copia fiel. */
export function huellaMenu(menu) {
  const rutas = rutasDelMenu(menu);
  const porRuta = (mapa, filas) => filas.map((f) => ({ ruta: mapa.get(f.id ?? f.producto_id) ?? null, f })).sort((a, b) => String(a.ruta).localeCompare(String(b.ruta)));
  const sinId = ({ id, categoria_id, producto_id, grupo_id, storage_key, ...resto }) => resto;
  const canon = {
    categorias: porRuta(rutas.categoria, menu.categorias).map(({ ruta, f }) => ({ ruta, ...sinId(f) })),
    productos: porRuta(rutas.producto, menu.productos).map(({ ruta, f }) => ({ ruta, ...sinId(f), opciones: opcionesComparables(f.opciones) })),
    grupos: porRuta(rutas.grupo, menu.grupos).map(({ ruta, f }) => ({ ruta, ...sinId(f) })),
    opciones: porRuta(rutas.opcion, menu.opciones).map(({ ruta, f }) => ({ ruta, ...sinId(f) })),
    whatsapp: menu.whatsapp.map((w) => ({ ruta: rutas.producto.get(w.producto_id) ?? null, publicado: w.publicado, origen: w.origen }))
      .sort((a, b) => String(a.ruta).localeCompare(String(b.ruta))),
    tienda: menu.tienda.map((t) => ({ ...sinId(t), ruta: rutas.producto.get(t.producto_id) ?? null })).sort((a, b) => String(a.ruta).localeCompare(String(b.ruta))),
    promociones: menu.promociones.map((p) => {
      let refs;
      try { refs = referenciasComoRutas(p, rutas); } catch (e) { refs = { error: e.message }; }
      return { ...sinId(p), ...refs };
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    menuAuto: menu.menuAuto,
    menuImagenes: [...menu.menuImagenes].sort(ordenar).map(sinId),
  };
  return sha(canon);
}

export const conteos = (m) => ({ categorias: m.categorias.length, productos: m.productos.length, grupos: m.grupos.length,
  opciones: m.opciones.length, whatsapp: m.whatsapp.length, whatsappPublicados: m.whatsapp.filter((w) => w.publicado).length,
  tienda: m.tienda.length, promociones: m.promociones.length, fotos: m.productos.filter((p) => p.opciones?.imagen?.storage_key).length,
  paginasMenu: m.menuImagenes.length, menuAutomatico: !!m.menuAuto });

const extension = (mime, nombre) => (String(nombre || '').match(/\.([a-z0-9]{2,5})$/i)?.[1]
  || { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime] || 'jpg').toLowerCase();

/**
 * Clona el menú de `origen` en `destino`. `archivos` = {copiar(key,{negocioId,categoria,mime,ext}) → nuevaKey,
 * eliminar(key)}. Devuelve {sinCambios} si el destino ya es igual, o {aplicado, conteos, archivosNuevos}.
 */
export async function clonarMenu(pool, { origen, destino, huellaOrigen, huellaDestino, archivos }) {
  assert.notEqual(origen, destino, 'origen y destino son el mismo negocio');
  const db = await pool.connect();
  const creados = [];
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL statement_timeout='120s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('clonar-menu:' || $1, 0))", [destino]);
    const mo = await leerMenu(db, origen);
    const hOrigen = huellaMenu(mo);
    assert.equal(hOrigen, huellaOrigen, 'El menú de origen cambió desde la inspección: vuelve a inspeccionar');
    const md = await leerMenu(db, destino);
    const hDestino = huellaMenu(md);
    if (hDestino === hOrigen) { await db.query('ROLLBACK'); return { sinCambios: true }; }
    assert.equal(hDestino, huellaDestino, 'El menú de destino cambió desde la inspección: vuelve a inspeccionar');
    const rutas = rutasDelMenu(mo);
    for (const p of mo.promociones) referenciasComoRutas(p, rutas); // lanza si una referencia cuelga

    // Archivos nuevos del destino (fotos y páginas del menú en imagen).
    const nuevaClave = new Map();
    for (const p of mo.productos) {
      const img = p.opciones?.imagen;
      if (!img?.storage_key) continue;
      const k = await archivos.copiar(img.storage_key, { negocioId: destino, categoria: 'producto', mime: img.mime, ext: extension(img.mime, img.storage_key) });
      assert(k && k !== img.storage_key, 'la foto copiada no puede compartir el archivo del origen');
      creados.push(k); nuevaClave.set(img.storage_key, k);
    }
    for (const i of mo.menuImagenes) {
      const k = await archivos.copiar(i.storage_key, { negocioId: destino, categoria: 'menu', mime: i.mime_type, ext: extension(i.mime_type, i.storage_key) });
      assert(k && k !== i.storage_key, 'la página copiada no puede compartir el archivo del origen');
      creados.push(k); nuevaClave.set(i.storage_key, k);
    }

    // Lo de prueba del destino se va; las cascadas limpian su carta y su tienda.
    await db.query('DELETE FROM tienda_promociones WHERE negocio_id=$1', [destino]);
    await db.query('DELETE FROM whatsapp_menu_imagenes WHERE negocio_id=$1', [destino]);
    await db.query('DELETE FROM menu_modificadores_opciones WHERE negocio_id=$1', [destino]);
    await db.query('DELETE FROM menu_modificadores_grupos WHERE negocio_id=$1', [destino]);
    await db.query('DELETE FROM menu_productos WHERE negocio_id=$1', [destino]);
    await db.query('DELETE FROM menu_categorias WHERE negocio_id=$1', [destino]);

    const mapa = { categoria: new Map(), producto: new Map(), grupo: new Map(), opcion: new Map() };
    for (const c of [...mo.categorias].sort(ordenar)) {
      const { rows: [r] } = await db.query('INSERT INTO menu_categorias(negocio_id,nombre,orden,activa) VALUES($1,$2,$3,$4) RETURNING id',
        [destino, c.nombre, c.orden, c.activa]);
      mapa.categoria.set(c.id, r.id);
    }
    for (const p of [...mo.productos].sort((a, b) => String(rutas.producto.get(a.id)).localeCompare(String(rutas.producto.get(b.id)), 'en', { numeric: true }))) {
      let opciones = p.opciones;
      if (objeto(opciones?.imagen) && opciones.imagen.storage_key) {
        opciones = { ...opciones, imagen: { ...opciones.imagen, storage_key: nuevaClave.get(opciones.imagen.storage_key) } };
        assert(opciones.imagen.storage_key, `sin archivo copiado para la foto de «${p.nombre}»`);
      }
      const { rows: [r] } = await db.query(`INSERT INTO menu_productos(negocio_id,categoria_id,codigo,nombre,descripcion,precio,disponible,opciones,orden,agotado,destacado)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [destino, p.categoria_id == null ? null : mapa.categoria.get(p.categoria_id), p.codigo, p.nombre, p.descripcion, p.precio,
          p.disponible, opciones == null ? null : JSON.stringify(opciones), p.orden, p.agotado, p.destacado]);
      mapa.producto.set(p.id, r.id);
    }
    for (const g of [...mo.grupos].sort(ordenar)) {
      const { rows: [r] } = await db.query(`INSERT INTO menu_modificadores_grupos(negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [destino, mapa.producto.get(g.producto_id), g.nombre, g.requerido, g.minimo, g.maximo, g.orden]);
      mapa.grupo.set(g.id, r.id);
    }
    for (const o of [...mo.opciones].sort(ordenar)) {
      const { rows: [r] } = await db.query(`INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [destino, mapa.grupo.get(o.grupo_id), o.nombre, o.precio_extra, o.disponible, o.orden]);
      mapa.opcion.set(o.id, r.id);
    }
    for (const w of mo.whatsapp) await db.query(`INSERT INTO whatsapp_productos(negocio_id,producto_id,publicado,origen) VALUES($1,$2,$3,$4)`,
      [destino, mapa.producto.get(w.producto_id), w.publicado, w.origen]);
    for (const t of mo.tienda) await db.query(`INSERT INTO tienda_productos(negocio_id,producto_id,publicado,destacado,badge,descripcion_comercial,
      imagen_url,precio_tienda,orden) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [destino, mapa.producto.get(t.producto_id), t.publicado, t.destacado,
      t.badge, t.descripcion_comercial, t.imagen_url, t.precio_tienda, t.orden]);
    const traducir = (m, id, que) => { const n = m.get(Number(id)); assert(n, `${que} ${id} sin equivalente en el destino`); return n; };
    for (const p of mo.promociones) {
      const productos = Array.isArray(p.productos) ? p.productos.map((id) => traducir(mapa.producto, id, 'producto')) : p.productos;
      const categorias = Array.isArray(p.categorias) ? p.categorias.map((id) => traducir(mapa.categoria, id, 'categoría')) : p.categorias;
      const condiciones = Array.isArray(p.condiciones_modificadores) ? p.condiciones_modificadores.map((c) => ({ ...c,
        producto_id: c.producto_id == null ? c.producto_id : traducir(mapa.producto, c.producto_id, 'producto'),
        grupo_id: c.grupo_id == null ? c.grupo_id : traducir(mapa.grupo, c.grupo_id, 'grupo'),
        option_ids: Array.isArray(c.option_ids) ? c.option_ids.map((id) => traducir(mapa.opcion, id, 'opción')) : c.option_ids })) : p.condiciones_modificadores;
      const json = (v) => (v == null ? null : JSON.stringify(v));
      await db.query(`INSERT INTO tienda_promociones(negocio_id,nombre,tipo,codigo,automatica,valor,minimo_compra,max_descuento,vigencia_desde,
        vigencia_hasta,dias_semana,hora_inicio,hora_fin,limite_usos,limite_por_cliente,usos,solo_primera_compra,canales,modalidades,productos,
        categorias,acumulable,prioridad,activa,cantidad_requerida,cantidad_beneficiada,max_aplicaciones,condiciones_modificadores)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
        [destino, p.nombre, p.tipo, p.codigo, p.automatica, p.valor, p.minimo_compra, p.max_descuento, p.vigencia_desde, p.vigencia_hasta,
          json(p.dias_semana), p.hora_inicio, p.hora_fin, p.limite_usos, p.limite_por_cliente, p.solo_primera_compra, json(p.canales),
          json(p.modalidades), json(productos), json(categorias), p.acumulable, p.prioridad, p.activa, p.cantidad_requerida,
          p.cantidad_beneficiada, p.max_aplicaciones, json(condiciones)]);
    }
    if (mo.menuAuto) {
      // La revisión del menú en imagen no se copia: su huella lleva los ids del
      // origen. El destino nace «nunca revisado» y manda el menú en texto hasta revisarlo.
      await db.query(`INSERT INTO whatsapp_menu_automatico(negocio_id,activo,frases_disparadoras) VALUES($1,$2,$3)
        ON CONFLICT (negocio_id) DO UPDATE SET activo=EXCLUDED.activo,frases_disparadoras=EXCLUDED.frases_disparadoras,storage_key=NULL,
          mime_type=NULL,nombre_archivo=NULL,tamano_bytes=NULL,revision_carta_huella=NULL,revision_imagenes_huella=NULL,revision_carta=NULL,
          revisado_at=NULL,revisado_por=NULL,actualizado_por=NULL`, [destino, mo.menuAuto.activo, mo.menuAuto.frases_disparadoras]);
    }
    for (const i of [...mo.menuImagenes].sort(ordenar)) await db.query(`INSERT INTO whatsapp_menu_imagenes(negocio_id,storage_key,mime_type,
      nombre_archivo,tamano_bytes,orden) VALUES($1,$2,$3,$4,$5,$6)`, [destino, nuevaClave.get(i.storage_key), i.mime_type, i.nombre_archivo,
      i.tamano_bytes, i.orden]);

    // Antes de confirmar: el destino es una copia fiel y no comparte nada con el origen.
    const final = await leerMenu(db, destino);
    assert.equal(huellaMenu(final), hOrigen, 'La copia no quedó igual al origen');
    assert.deepEqual(conteos(final), conteos(mo));
    const clavesOrigen = new Set([...mo.productos.map((p) => p.opciones?.imagen?.storage_key), ...mo.menuImagenes.map((i) => i.storage_key)].filter(Boolean));
    for (const k of [...final.productos.map((p) => p.opciones?.imagen?.storage_key), ...final.menuImagenes.map((i) => i.storage_key)].filter(Boolean))
      assert(!clavesOrigen.has(k), 'un archivo del destino es el del origen');
    const { rows: [cruces] } = await db.query(`SELECT
        (SELECT count(*) FROM menu_productos p JOIN menu_categorias c ON c.id=p.categoria_id WHERE p.negocio_id=$1 AND c.negocio_id<>$1)
      + (SELECT count(*) FROM menu_modificadores_grupos g JOIN menu_productos p ON p.id=g.producto_id WHERE g.negocio_id=$1 AND p.negocio_id<>$1)
      + (SELECT count(*) FROM menu_modificadores_opciones o JOIN menu_modificadores_grupos g ON g.id=o.grupo_id WHERE o.negocio_id=$1 AND g.negocio_id<>$1)
      AS n`, [destino]);
    assert.equal(Number(cruces.n), 0, 'hay referencias cruzadas entre negocios');
    await db.query('COMMIT');
    return { aplicado: true, conteos: conteos(final), archivosNuevos: creados.length };
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    for (const k of creados) await archivos.eliminar(k).catch(() => {});
    throw e;
  } finally { db.release(); }
}

/** Solo lectura: conteos y huellas para el paso `aplicar`. */
export async function inspeccionarMenus(pool, { origen, destino }) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const mo = await leerMenu(db, origen), md = await leerMenu(db, destino);
    const rutas = rutasDelMenu(mo);
    const colgantes = [];
    for (const p of mo.promociones) { try { referenciasComoRutas(p, rutas); } catch (e) { colgantes.push(e.message); } }
    return { origen: { conteos: conteos(mo), huella: huellaMenu(mo) }, destino: { conteos: conteos(md), huella: huellaMenu(md),
      productos: md.productos.map((p) => `${p.nombre} $${p.precio}`) }, promocionesColgantes: colgantes };
  } finally { await db.query('ROLLBACK').catch(() => {}); db.release(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [modo, origen, destino, huellaOrigen, huellaDestino] = process.argv.slice(2);
  assert(['inspeccionar', 'aplicar'].includes(modo), 'Modo: inspeccionar | aplicar');
  for (const id of [origen, destino]) assert.match(id || '', /^[0-9a-f-]{36}$/, 'negocio inválido');
  const { pool } = await import('../src/services/database.js');
  try {
    if (modo === 'inspeccionar') console.log(JSON.stringify(await inspeccionarMenus(pool, { origen, destino }), null, 1));
    else {
      assert.match(huellaOrigen || '', /^[a-f0-9]{64}$/); assert.match(huellaDestino || '', /^[a-f0-9]{64}$/);
      const { leerArchivo, guardarArchivo, eliminarArchivo } = await import('../src/services/almacenamiento.js');
      const archivos = {
        copiar: async (key, { negocioId, categoria, mime, ext }) => guardarArchivo(await leerArchivo(key), { negocioId, extension: ext, mimeType: mime, categoria }),
        eliminar: eliminarArchivo,
      };
      console.log(JSON.stringify(await clonarMenu(pool, { origen, destino, huellaOrigen, huellaDestino, archivos })));
    }
  } catch (e) { console.error('FALLA:', e.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
