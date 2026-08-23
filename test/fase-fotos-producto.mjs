// Foto principal de un producto: subir desde el panel, verla en el POS y en
// la tienda en línea.
//
// Dos cosas se prueban aquí y las dos importan por razones distintas:
//
//   SEGURIDAD. Un endpoint que recibe archivos es superficie nueva. Se
//   valida el tipo REAL por magic bytes (un .jpg que en realidad es un SVG
//   -- vector de XSS conocido -- se rechaza), y escribir o borrar va siempre
//   filtrado por negocio: el negocio B jamás puede tocar la foto de A.
//
//   NO ROMPER NADA. La referencia vive en menu_productos.opciones, el mismo
//   JSONB donde viven las opciones comerciales que el bot imprime en el
//   menú de WhatsApp. Meter ahí una clave técnica sin registrarla ya tumbó
//   el bot una vez (tipo_item). Esta suite exige que la foto NUNCA aparezca
//   en el menú del prompt y que los precios no se muevan.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const TIENDA_HTML = readFileSync(join(__dirname, '..', 'panel', 'tienda.html'), 'utf8');
const PANEL_HTML = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');

const { pool, obtenerMenuCompleto } = await import('../src/services/database.js');
const { catalogoPublico } = await import('../src/services/tiendaOnline.js');
const {
  guardarImagenProducto, eliminarImagenProducto, leerImagenProducto,
  urlImagenProducto, imagenDeProducto,
} = await import('../src/services/imagenesProducto.js');
const { CLAVES_OPCIONES_TECNICAS } = await import('../src/agent/prompts.js');
const { leerArchivo } = await import('../src/services/almacenamiento.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const suf = Date.now().toString().slice(-6);

// Imágenes REALES generadas al vuelo (no bytes inventados): así la
// validación por magic bytes y la compresión con sharp se ejercitan de
// verdad, igual que con la foto que subiría un dueño.
const imagenJpeg = async (w = 400, h = 300) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 90, b: 40 } } }).jpeg().toBuffer();
const imagenPng = async () => sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 30, g: 120, b: 90, alpha: 1 } } }).png().toBuffer();
const imagenWebp = async () => sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 10, g: 10, b: 200 } } }).webp().toBuffer();

async function del(sql, params) {
  try { await pool.query(sql, params); } catch (e) { console.warn('[limpieza] paso omitido:', e.message.slice(0, 80)); }
}
async function limpiar() {
  for (const neg of [NEG_A, NEG_B]) {
    await del(`DELETE FROM tienda_productos WHERE negocio_id = $1 AND producto_id IN
                 (SELECT id FROM menu_productos WHERE negocio_id = $1 AND nombre LIKE 'FP %')`, [neg]);
    await del(`DELETE FROM menu_productos WHERE negocio_id = $1 AND nombre LIKE 'FP %'`, [neg]);
    await del(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre LIKE 'FP %'`, [neg]);
  }
}

const ids = {};
try {
  await limpiar();

  const { rows: [catA] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,970) RETURNING id`,
    [NEG_A, `FP Paninis ${suf}`]);
  for (const [nombre, precio] of [['FP Louisiana', 180], ['FP Parm', 195], ['FP SinFoto', 179]]) {
    const { rows: [p] } = await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, descripcion, precio, disponible, agotado, orden)
       VALUES ($1,$2,$3,$4,$5,TRUE,FALSE,1) RETURNING id`,
      [NEG_A, catA.id, `${nombre} ${suf}`, `Desc de ${nombre}`, precio]);
    ids[nombre] = p.id;
  }
  // Producto con opciones COMERCIALES legadas: la foto no puede pisarlas.
  await pool.query(
    `UPDATE menu_productos SET opciones = $2::jsonb WHERE id = $1`,
    [ids['FP Parm'], JSON.stringify({ Tamano: ['Chico', 'Grande'], tipo_item: 'normal' })]);

  const { rows: [catB] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,971) RETURNING id`,
    [NEG_B, `FP Otros ${suf}`]);
  const { rows: [pB] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
     VALUES ($1,$2,$3,99,TRUE,FALSE,1) RETURNING id`, [NEG_B, catB.id, `FP Ajeno ${suf}`]);
  ids['FP Ajeno'] = pB.id;

  await t('1. subir una imagen válida deja al producto con foto', async () => {
    const r = await guardarImagenProducto(NEG_A, ids['FP Louisiana'], await imagenJpeg(), 'louisiana.jpg');
    assert.strictEqual(r.ok, true, r.error);
    assert.match(r.url, new RegExp(`^/img/producto/${ids['FP Louisiana']}\\?v=`));
    const img = imagenDeProducto(r.producto);
    assert.ok(img.storage_key, 'no quedó clave de almacenamiento');
    assert.strictEqual(img.mime, 'image/jpeg');
    assert.ok(img.bytes > 0);
    // El binario NUNCA se guarda en la base: en opciones solo va la referencia.
    assert.ok(!/base64|data:image/.test(JSON.stringify(r.producto.opciones)),
      'se guardó el binario dentro del JSONB');
    // Y el archivo existe de verdad en el almacenamiento.
    const bytes = await leerArchivo(img.storage_key);
    assert.ok(bytes.length > 0);
  });

  await t('2. JPEG, PNG y WEBP se aceptan', async () => {
    for (const [nombre, hacer, mimeEsperado] of [
      ['jpeg', imagenJpeg, 'image/jpeg'],
      ['png', imagenPng, 'image/png'],
      ['webp', imagenWebp, 'image/webp'],
    ]) {
      const r = await guardarImagenProducto(NEG_A, ids['FP Parm'], await hacer(), `foto.${nombre}`);
      assert.strictEqual(r.ok, true, `${nombre}: ${r.error}`);
      assert.strictEqual(imagenDeProducto(r.producto).mime, mimeEsperado, `${nombre} cambió de formato`);
    }
  });

  await t('3. un archivo que NO es imagen se rechaza, aunque diga .jpg', async () => {
    const basuras = [
      ['texto plano', Buffer.from('esto no es una imagen')],
      ['SVG (vector de XSS)', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ['PDF', Buffer.from('%PDF-1.4\n%aaa\n')],
      ['JPEG truncado', (await imagenJpeg()).subarray(0, 40)],
      ['vacío', Buffer.alloc(0)],
    ];
    for (const [etiqueta, buffer] of basuras) {
      const r = await guardarImagenProducto(NEG_A, ids['FP SinFoto'], buffer, 'trampa.jpg');
      assert.strictEqual(r.ok, false, `se aceptó ${etiqueta}`);
    }
    // Y el producto sigue sin foto: un rechazo no deja basura a medias.
    const { rows } = await pool.query(`SELECT opciones FROM menu_productos WHERE id = $1`, [ids['FP SinFoto']]);
    assert.strictEqual(imagenDeProducto(rows[0]), null);
  });

  await t('4. un archivo demasiado grande se rechaza antes de procesarlo', async () => {
    const enorme = Buffer.alloc(Number(process.env.MEDIA_MAX_IMAGE_MB || 8) * 1024 * 1024 + 1024, 0xff);
    const r = await guardarImagenProducto(NEG_A, ids['FP SinFoto'], enorme, 'enorme.jpg');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.codigo, 413);
  });

  await t('5. un producto sin foto sigue funcionando igual', async () => {
    const menu = await obtenerMenuCompleto(NEG_A);
    const sinFoto = menu.flatMap(c => c.productos).find(p => p.id === ids['FP SinFoto']);
    assert.ok(sinFoto, 'el producto sin foto desapareció del menú');
    assert.strictEqual(sinFoto.imagen, null, 'un producto sin foto debe traer imagen null, no undefined ni una URL rota');
    assert.strictEqual(Number(sinFoto.precio), 179);
    assert.strictEqual(urlImagenProducto({ id: 1, opciones: null }), null);
    assert.strictEqual(urlImagenProducto({ id: 1, opciones: { tipo_item: 'envio' } }), null);
  });

  await t('6. reemplazar la foto cambia la URL y borra el archivo anterior', async () => {
    const primera = await guardarImagenProducto(NEG_A, ids['FP Louisiana'], await imagenJpeg(), 'a.jpg');
    const claveVieja = imagenDeProducto(primera.producto).storage_key;
    const segunda = await guardarImagenProducto(NEG_A, ids['FP Louisiana'], await imagenPng(), 'b.png');
    const claveNueva = imagenDeProducto(segunda.producto).storage_key;
    assert.notStrictEqual(claveNueva, claveVieja, 'se reutilizó la clave: un caché seguiría sirviendo la foto vieja');
    assert.notStrictEqual(segunda.url, primera.url, 'la URL no cambió al cambiar la foto');
    await assert.rejects(() => leerArchivo(claveVieja), 'el archivo anterior quedó huérfano en el almacenamiento');
    // Y la foto que se sirve es la nueva.
    const servida = await leerImagenProducto(ids['FP Louisiana']);
    assert.strictEqual(servida.mimeType, 'image/png');
  });

  await t('7. eliminar la foto suelta la referencia y el archivo', async () => {
    await guardarImagenProducto(NEG_A, ids['FP SinFoto'], await imagenJpeg(), 'temporal.jpg');
    const { rows: [antes] } = await pool.query(`SELECT opciones FROM menu_productos WHERE id = $1`, [ids['FP SinFoto']]);
    const clave = imagenDeProducto(antes).storage_key;
    const r = await eliminarImagenProducto(NEG_A, ids['FP SinFoto']);
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(imagenDeProducto(r.producto), null, 'la referencia sigue ahí');
    await assert.rejects(() => leerArchivo(clave), 'el archivo no se borró');
    assert.strictEqual(await leerImagenProducto(ids['FP SinFoto']), null);
  });

  await t('8. aislamiento: un negocio no puede tocar la foto de otro', async () => {
    // B intenta subirle foto a un producto de A.
    const subida = await guardarImagenProducto(NEG_B, ids['FP Louisiana'], await imagenJpeg(), 'robo.jpg');
    assert.strictEqual(subida.ok, false, 'el negocio B pudo cambiarle la foto a un producto del negocio A');
    assert.strictEqual(subida.codigo, 404);
    // B intenta borrar la foto de A.
    const borrado = await eliminarImagenProducto(NEG_B, ids['FP Louisiana']);
    assert.strictEqual(borrado.ok, false, 'el negocio B pudo borrarle la foto a un producto del negocio A');
    // Y la foto de A sigue intacta.
    assert.ok(await leerImagenProducto(ids['FP Louisiana']), 'la foto de A se perdió en el intento');
    // A tampoco puede tocar lo de B.
    assert.strictEqual((await guardarImagenProducto(NEG_A, ids['FP Ajeno'], await imagenJpeg(), 'x.jpg')).ok, false);
    assert.strictEqual((await eliminarImagenProducto(NEG_A, ids['FP Ajeno'])).ok, false);
  });

  await t('9. el archivo se guarda bajo la ruta del negocio dueño', async () => {
    const { rows: [row] } = await pool.query(`SELECT opciones FROM menu_productos WHERE id = $1`, [ids['FP Louisiana']]);
    const clave = imagenDeProducto(row).storage_key;
    assert.ok(clave.includes(`/negocios/${NEG_A.replace(/[^a-zA-Z0-9_-]/g, '')}/productos/`),
      `la clave no está bajo el negocio dueño: ${clave}`);
    assert.ok(!clave.includes(NEG_B), 'la ruta menciona a otro negocio');
    // La clave nunca reutiliza el nombre original del archivo.
    assert.ok(!/louisiana|robo|trampa/i.test(clave), 'la clave filtra el nombre del archivo subido');
  });

  await t('10. el POS recibe la URL de la foto lista para pintar', async () => {
    const menu = await obtenerMenuCompleto(NEG_A);
    const conFoto = menu.flatMap(c => c.productos).find(p => p.id === ids['FP Louisiana']);
    assert.match(conFoto.imagen, new RegExp(`^/img/producto/${ids['FP Louisiana']}\\?v=[a-zA-Z0-9]+$`));
    // El POS solo pinta la miniatura si hay foto: sin ella, la tarjeta de siempre.
    assert.match(PANEL_HTML, /\$\{p\.imagen \? `<img class="pos-prod-img"[^`]*loading="lazy">` : ''\}/);
    assert.match(PANEL_HTML, /\.pos-prod-img \{/);
  });

  await t('11. la tienda en línea muestra la misma foto', async () => {
    await pool.query(
      `INSERT INTO tienda_productos (negocio_id, producto_id, publicado, orden) VALUES ($1,$2,TRUE,1)
       ON CONFLICT DO NOTHING`, [NEG_A, ids['FP Louisiana']]);
    await pool.query(
      `INSERT INTO tienda_productos (negocio_id, producto_id, publicado, orden) VALUES ($1,$2,TRUE,2)
       ON CONFLICT DO NOTHING`, [NEG_A, ids['FP SinFoto']]);
    const catalogo = await catalogoPublico(NEG_A);
    const productos = catalogo.flatMap(c => c.productos);
    const conFoto = productos.find(p => p.id === ids['FP Louisiana']);
    const sinFoto = productos.find(p => p.id === ids['FP SinFoto']);
    assert.match(conFoto.imagen, /^\/img\/producto\//, 'la tienda no ve la foto subida');
    assert.strictEqual(sinFoto.imagen, null);
    // Una URL escrita a mano en la tienda sigue ganando (override explícito).
    await pool.query(`UPDATE tienda_productos SET imagen_url = $3 WHERE negocio_id = $1 AND producto_id = $2`,
      [NEG_A, ids['FP Louisiana'], 'https://ejemplo.mx/propia.jpg']);
    const conOverride = (await catalogoPublico(NEG_A)).flatMap(c => c.productos).find(p => p.id === ids['FP Louisiana']);
    assert.strictEqual(conOverride.imagen, 'https://ejemplo.mx/propia.jpg');
    await pool.query(`UPDATE tienda_productos SET imagen_url = NULL WHERE negocio_id = $1 AND producto_id = $2`,
      [NEG_A, ids['FP Louisiana']]);
  });

  await t('12. la tienda carga las fotos en diferido y con proporción fija', async () => {
    assert.match(TIENDA_HTML, /class="prod-img" src="\$\{esc\(p\.imagen\)\}" alt="" loading="lazy"/);
    assert.match(TIENDA_HTML, /\.prod-img\{[^}]*object-fit:cover/);
    // El marcador de "sin foto" solo aparece si ALGÚN producto tiene foto:
    // en una tienda sin fotos, nada cambia respecto de hoy.
    assert.match(TIENDA_HTML, /function hayFotosEnCatalogo\(\)/);
    assert.match(TIENDA_HTML, /hayFotosEnCatalogo\(\) \? '<div class="prod-img prod-img-vacia"/);
  });

  await t('13. las fotos no mueven ningún precio', async () => {
    const { rows } = await pool.query(
      `SELECT nombre, precio FROM menu_productos WHERE negocio_id = $1 AND nombre LIKE 'FP %' ORDER BY nombre`, [NEG_A]);
    const precios = Object.fromEntries(rows.map(r => [r.nombre.split(' ')[1], Number(r.precio)]));
    assert.strictEqual(precios.Louisiana, 180);
    assert.strictEqual(precios.Parm, 195);
    assert.strictEqual(precios.SinFoto, 179);
  });

  await t('14. la foto JAMÁS aparece en el menú que lee el cliente por WhatsApp', async () => {
    assert.ok(CLAVES_OPCIONES_TECNICAS.has('imagen'),
      'la clave `imagen` no está registrada como técnica: terminaría impresa en el menú del bot');
    assert.ok(CLAVES_OPCIONES_TECNICAS.has('tipo_item'), 'se perdió el registro anterior');
    // El formateador real, con un producto que tiene foto Y opciones comerciales.
    const { construirSystemPrompt } = await import('../src/agent/prompts.js');
    const prompt = await construirSystemPrompt(null, 'whatsapp', NEG_A);
    assert.ok(!/storage_key|image\/jpeg|image\/png|img\/producto/.test(prompt),
      'la foto se filtró al prompt del bot');
    assert.ok(!/\bimagen\s*:/i.test(prompt.split('## MENÚ ACTUAL')[1] || ''),
      'la clave imagen aparece en el menú del prompt');
    // Y las opciones COMERCIALES del mismo producto siguen visibles.
    assert.ok(/Chico/.test(prompt) && /Grande/.test(prompt),
      'agregar la foto se llevó por delante las opciones comerciales del producto');
  });

  await t('15. una referencia rota no rompe el catálogo, solo no muestra foto', async () => {
    await pool.query(
      `UPDATE menu_productos
          SET opciones = COALESCE(opciones,'{}'::jsonb) || jsonb_build_object('imagen',
              jsonb_build_object('storage_key','no/existe/jamas.jpg','mime','image/jpeg','bytes',10))
        WHERE id = $1 AND negocio_id = $2`, [ids['FP SinFoto'], NEG_A]);
    // Servirla devuelve null (404), no una excepción.
    assert.strictEqual(await leerImagenProducto(ids['FP SinFoto']), null);
    // Y el menú y la tienda se construyen igual.
    const menu = await obtenerMenuCompleto(NEG_A);
    assert.ok(menu.flatMap(c => c.productos).some(p => p.id === ids['FP SinFoto']));
    const catalogo = await catalogoPublico(NEG_A);
    assert.ok(catalogo.flatMap(c => c.productos).length > 0, 'el catálogo se cayó por una referencia rota');
  });

  await t('16. opciones corruptas o de formatos viejos no producen URLs inválidas', async () => {
    const entradas = [null, undefined, 'no-es-json', 42, [], { imagen: 'texto' }, { imagen: {} },
      { imagen: { storage_key: '' } }, { imagen: { storage_key: 123 } }];
    for (const opciones of entradas) {
      assert.strictEqual(urlImagenProducto({ id: 7, opciones }), null, `${JSON.stringify(opciones)} produjo URL`);
      assert.strictEqual(imagenDeProducto(opciones), null);
    }
    // Y el formato en texto (JSON como string) sí se entiende.
    const comoTexto = JSON.stringify({ imagen: { storage_key: 'dev/negocios/x/productos/abc.jpg', mime: 'image/webp' } });
    assert.match(urlImagenProducto({ id: 7, opciones: comoTexto }), /^\/img\/producto\/7\?v=/);
  });

} catch (e) {
  console.error('ERROR FATAL EN LA SUITE:', e);
  fallidas++; fallos.push(`fatal: ${e.message}`);
} finally {
  // Se sueltan las fotos que quedaron para no dejar archivos huérfanos.
  for (const id of Object.values(ids)) {
    await eliminarImagenProducto(NEG_A, id).catch(() => {});
    await eliminarImagenProducto(NEG_B, id).catch(() => {});
  }
  await limpiar();
  await pool.end();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
