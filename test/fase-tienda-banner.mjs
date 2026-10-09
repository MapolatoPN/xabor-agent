// Banner promocional de la tienda en línea (Tienda → Banner).
//
// Lo que protege, en orden de importancia:
//   a) que un negocio SIN banner vea la portada de siempre, idéntica;
//   b) que lo que viaja por la API pública esté limpio: listas blancas,
//      topes de largo, ligas solo https, y fechas por día LOCAL del negocio
//      (no medianoche UTC, ver vigenciaPromos.js);
//   c) que una foto solo se sirva o se borre si es de la carpeta de tienda
//      del MISMO negocio, aunque alguien escriba la fila a mano por
//      PUT /api/config;
//   d) que solo un administrador cambie el banner;
//   e) que el carrusel mueva su pista y nunca la página, y que el panel
//      cargue el editor con la huella correcta (caché, ver modificadores.js).
//
// Parte A y B sin base. Parte C levanta el servidor con dos negocios propios
// (slugs irrepetibles): no toca al negocio A del seed que comparten las
// demás suites de tienda.
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
//      TEST_PORT_BANNER (4731 por omisión). SOLO_PURAS=1 salta la parte C.
import assert from 'assert';
import { readFileSync, existsSync } from 'fs';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  normalizarBanner, validarDiapositivas, bannerParaCliente, urlFotoValida, fechaValida,
  claveDeTiendaDelNegocio, vigenteHoy, MAX_DIAPOSITIVAS, LARGOS,
} from '../src/services/tiendaBanner.js';
import { fechaDeVigencia } from '../src/services/vigenciaPromos.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const leer = r => readFileSync(join(RAIZ, r), 'utf8').replace(/\r\n/g, '\n');
const TIENDA_HTML = leer('panel/tienda.html');
const TIENDA_JS = TIENDA_HTML.slice(TIENDA_HTML.indexOf('<script>'), TIENDA_HTML.lastIndexOf('</script>'));
const PANEL = leer('panel/index.html');
const EDITOR = readFileSync(join(RAIZ, 'panel/tienda-banner.js'));
const RUTAS = leer('src/services/tiendaRutasCore.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}
const lanza = (fn, codigo) => assert.throws(fn, e => e.codigo === codigo, `esperaba ${codigo}`);
const dia = (o = {}) => ({ titulo: 'Pozole rojo', ...o });

// ══ A) Normalización y validación (puras) ═══════════════════════════════════
await t('A1. sin configuración o con basura: banner vacío', () => {
  for (const v of [undefined, null, '', 'no-json', '[]', '{}', 42, '{"diapositivas":"x"}', { diapositivas: [{}] }]) {
    assert.deepStrictEqual(normalizarBanner(v), { diapositivas: [], fotos: {} }, `valor ${JSON.stringify(v)}`);
  }
});

await t('A2. lo guardado se lee desde texto JSON (como vive en configuracion.valor)', () => {
  const b = normalizarBanner(JSON.stringify({ diapositivas: [dia({ ceja: 'Temporada', desde: '2026-09-01', hasta: '2026-09-30' })] }));
  assert.strictEqual(b.diapositivas.length, 1);
  const d = b.diapositivas[0];
  assert.deepStrictEqual([d.titulo, d.ceja, d.desde, d.hasta, d.activo], ['Pozole rojo', 'Temporada', '2026-09-01', '2026-09-30', true]);
  assert.deepStrictEqual(d.destino, { tipo: 'menu' });
});

await t('A3. textos: sin caracteres de control, topes de largo, título de máximo dos renglones', () => {
  const b = normalizarBanner({ diapositivas: [dia({
    titulo: 'Uno\r\ndos\ntres‮', ceja: 'a\u0000b\nc', texto: 'x'.repeat(500), boton: 'y'.repeat(99) })] });
  const d = b.diapositivas[0];
  assert.strictEqual(d.titulo, 'Uno\ndos tres');
  assert.strictEqual(d.ceja, 'ab c');
  assert.strictEqual(d.texto.length, LARGOS.texto);
  assert.strictEqual(d.boton.length, LARGOS.boton);
});

await t('A4. ligas de foto: solo https o una foto de producto de Xabor', () => {
  assert.ok(urlFotoValida('https://lh3.googleusercontent.com/d/abc'));
  assert.strictEqual(urlFotoValida('/img/producto/288?v=2cf07dd5jpg'), '/img/producto/288?v=2cf07dd5jpg');
  for (const mala of ['http://x.com/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '//x.com/a.jpg',
    '/img/producto/../../etc', '/admin', ' ', 'https://' + 'a'.repeat(700)]) {
    assert.strictEqual(urlFotoValida(mala), null, mala);
  }
});

await t('A5. fechas: días reales y nada más', () => {
  assert.strictEqual(fechaValida('2026-10-09'), '2026-10-09');
  for (const mala of ['2026-02-30', '2026-13-01', '9/10/2026', '2026-10-09T00:00', '', null]) {
    assert.strictEqual(fechaValida(mala), null, String(mala));
  }
});

await t('A6. guardar: el dueño recibe el error que necesita para corregir', () => {
  lanza(() => validarDiapositivas('x', {}), 'BANNER_INVALIDO');
  lanza(() => validarDiapositivas(Array.from({ length: MAX_DIAPOSITIVAS + 1 }, () => dia()), {}), 'BANNER_DEMASIADAS');
  lanza(() => validarDiapositivas([dia({ titulo: '  \n ' })], {}), 'BANNER_SIN_TITULO');
  lanza(() => validarDiapositivas([dia({ foto: { tipo: 'url', url: 'javascript:alert(1)' } })], {}), 'BANNER_FOTO_INVALIDA');
  lanza(() => validarDiapositivas([dia({ foto: { tipo: 'subida', id: 'a'.repeat(16) } })], {}), 'BANNER_FOTO_PERDIDA');
  lanza(() => validarDiapositivas([dia({ desde: '2026-02-30' })], {}), 'BANNER_FECHA_INVALIDA');
  lanza(() => validarDiapositivas([dia({ desde: '2026-10-10', hasta: '2026-10-09' })], {}), 'BANNER_FECHAS_AL_REVES');
  lanza(() => validarDiapositivas([dia({ destino: { tipo: 'producto', productoId: 'abc' } })], {}), 'BANNER_DESTINO_INVALIDO');
  const ok = validarDiapositivas([dia({ destino: { tipo: 'producto', productoId: '12' }, desde: '2026-10-09', hasta: '2026-10-09' })], {});
  assert.deepStrictEqual(ok[0].destino, { tipo: 'producto', productoId: 12 });
});

await t('A7. una foto subida solo vale si está en el banner de ese negocio', () => {
  const fotos = { abcdef0123456789: { storage_key: 'k', mime: 'image/jpeg' } };
  const [d] = validarDiapositivas([dia({ foto: { tipo: 'subida', id: 'abcdef0123456789' } })], fotos);
  assert.deepStrictEqual(d.foto, { tipo: 'subida', id: 'abcdef0123456789' });
  // Leído con otro pool de fotos (p. ej. la fila copiada a otro negocio), se cae.
  const b = normalizarBanner({ diapositivas: [d], fotos: {} });
  assert.strictEqual(b.diapositivas[0].foto, null);
});

await t('A8. la clave de almacenamiento tiene que ser de la carpeta de tienda de ESE negocio', () => {
  const neg = '6f1c1d2e-0000-4000-8000-000000000001';
  const uuid = '0123abcd-0000-4000-8000-0000000000ff';
  assert.ok(claveDeTiendaDelNegocio(neg, `production/negocios/${neg}/tienda/${uuid}.jpg`));
  for (const mala of [
    `production/negocios/6f1c1d2e-0000-4000-8000-000000000002/tienda/${uuid}.jpg`,  // otro negocio
    `production/negocios/${neg}/chats/5218780000000/${uuid}.jpg`,                  // chat privado
    `production/negocios/${neg}/productos/${uuid}.jpg`,
    `production/negocios/${neg}/tienda/../../x/${uuid}.jpg`,
    `${neg}/${uuid}.pdf`, `production/negocios/${neg}/tienda/${uuid}.svg`, '', null,
  ]) assert.strictEqual(claveDeTiendaDelNegocio(neg, mala), false, String(mala));
});

await t('A9. «hasta el 9» dura todo el 9 en Matamoros, no hasta las 7 de la noche del 8', () => {
  const d = normalizarBanner({ diapositivas: [dia({ hasta: '2026-10-09' })] }).diapositivas[0];
  const zona = 'America/Matamoros';
  // 22:00 del 9 en Matamoros (UTC-5) = 03:00Z del 10.
  assert.strictEqual(vigenteHoy(d, fechaDeVigencia(new Date('2026-10-10T03:00:00Z'), zona)), true);
  // 00:30 del 10 en Matamoros = 05:30Z del 10.
  assert.strictEqual(vigenteHoy(d, fechaDeVigencia(new Date('2026-10-10T05:30:00Z'), zona)), false);
  const futura = normalizarBanner({ diapositivas: [dia({ desde: '2026-10-10' })] }).diapositivas[0];
  assert.strictEqual(vigenteHoy(futura, '2026-10-09'), false);
  assert.strictEqual(vigenteHoy({ ...futura, activo: false }, '2026-10-11'), false);
});

await t('A10. al cliente: solo lo vigente, botón por omisión, y nada interno', () => {
  const fotos = { abcdef0123456789: { storage_key: 'production/negocios/x/tienda/y.jpg', mime: 'image/jpeg' } };
  const b = normalizarBanner({ fotos, diapositivas: [
    dia({ foto: { tipo: 'subida', id: 'abcdef0123456789' }, destino: { tipo: 'producto', productoId: 7 } }),
    dia({ titulo: 'Pausada', activo: false }),
    dia({ titulo: 'Liga', foto: { tipo: 'url', url: 'https://x.com/a.jpg' }, boton: 'Ver' }),
  ] });
  const c = bannerParaCliente(b, { slug: 'mi-tienda', hoy: '2026-10-09' });
  assert.deepStrictEqual(c.map(d => d.titulo), ['Pozole rojo', 'Liga']);
  assert.deepStrictEqual(c[0], { ceja: '', titulo: 'Pozole rojo', texto: '', boton: 'Ordenar', productoId: 7,
    foto: '/img/tienda/mi-tienda/abcdef0123456789' });
  assert.deepStrictEqual([c[1].boton, c[1].productoId, c[1].foto], ['Ver', null, 'https://x.com/a.jpg']);
  assert.ok(!JSON.stringify(c).includes('storage_key') && !JSON.stringify(c).includes('production/'), 'se filtró una clave interna');
});

// ══ B) Tienda y panel (estáticas) ═══════════════════════════════════════════
await t('B1. sin banner, la portada de siempre con el mismo texto y la misma foto', () => {
  assert.match(TIENDA_JS, /const propias = \(Array\.isArray\(TIENDA\.banner\) \? TIENDA\.banner : \[\]\)\.filter\(d => d && d\.titulo\);\n\s+if \(propias\.length\) return propias;/);
  for (const texto of ["ceja: 'Hecho para disfrutar'", "titulo: 'Tu mañana,\\na tu gusto.'",
    "texto: 'Elige tu desayuno favorito y prepáralo a tu manera.'", "boton: 'Explorar el menú'",
    'foto: TIENDA.portada || null', 'alt: `Una mesa de desayunos de ${TIENDA.negocio}`']) {
    assert.ok(TIENDA_JS.includes(texto), `falta ${texto}`);
  }
  // Una sola diapositiva = la portada suelta, sin carrusel ni puntos.
  assert.match(TIENDA_JS, /partes\.unshift\(diapositivas\.length === 1 \? portadaV2\(diapositivas\[0\], 0\) :/);
});

await t('B2. todo lo del negocio se escapa al pintarse', () => {
  const portada = TIENDA_JS.slice(TIENDA_JS.indexOf('function portadaV2('), TIENDA_JS.indexOf('function accionBannerV2('));
  assert.ok(portada.length > 200, 'no se encontró portadaV2');
  assert.ok(portada.includes('const foto = d.foto;'), 'la foto ya no sale de la diapositiva');
  for (const campo of ['d.ceja', 'd.texto', "d.boton || 'Explorar el menú'", 'foto', "d.alt || ''"]) {
    assert.ok(portada.includes(`esc(${campo})`), `${campo} sin escapar`);
  }
  assert.ok(portada.includes(".split('\\n').map(esc).join('<br>')"), 'el título no se escapa renglón por renglón');
  assert.ok(portada.includes('accionBannerV2(${Number(d.productoId) || 0})'), 'el id del platillo no se fuerza a número');
});

await t('B3. el carrusel mueve SU pista y nunca la página', () => {
  const carrusel = TIENDA_JS.slice(TIENDA_JS.indexOf('function iniciarBannerV2('), TIENDA_JS.indexOf('function bloqueEventosV2('));
  assert.ok(carrusel.includes('pista.scrollTo({ left:'), 'la pista no se mueve con scrollTo');
  assert.ok(!/scrollIntoView|window\.scroll|document\.(documentElement|body)\.scroll/.test(carrusel), 'el carrusel mueve la página');
  // «Reducir movimiento»: el CSS apaga el desplazamiento suave y el JS lo lee
  // de ahí (sin matchMedia, que fase-tienda-desktop prohíbe en la tienda).
  assert.ok(carrusel.includes("const quieto = getComputedStyle(pista).scrollBehavior !== 'smooth';"), 'no respeta «menos movimiento»');
  assert.ok(carrusel.includes('if (quieto) return;'), 'con «menos movimiento» sigue avanzando solo');
  assert.ok(TIENDA_HTML.includes('@media(prefers-reduced-motion:reduce){.v2-banner-pista{scroll-behavior:auto}}'));
  assert.ok(!/matchMedia/.test(TIENDA_JS), 'la tienda volvió a usar matchMedia');
  assert.ok(carrusel.includes('document.hidden'), 'avanza con la pestaña oculta');
  assert.ok(carrusel.includes('if (bannerV2) clearInterval(bannerV2.reloj);'), 'repintar apila relojes');
});

await t('B4. la API pública manda el banner solo con el diseño v2', () => {
  assert.match(RUTAS, /banner: diseno\.tema === 'v2'\n\s+\? await bannerPublico\(tienda\.negocioId, \{ slug: tienda\.slug, zona: reglas\.timezone \}\)\n\s+: \[\],/);
});

await t('B5. el panel carga el editor con la huella sha256 del archivo', () => {
  const huella = createHash('sha256').update(EDITOR).digest('hex').slice(0, 8);
  const m = PANEL.match(/<script src="\/tienda-banner\.js\?v=([0-9a-f]+)"><\/script>/);
  assert.ok(m, 'no se encontró la etiqueta del editor');
  assert.strictEqual(m[1], huella, `actualiza la etiqueta a ?v=${huella}`);
});

await t('B6. el editor solo deja un nombre global y el panel lo engancha en Tienda', () => {
  const src = EDITOR.toString('utf8').replace(/\r\n/g, '\n');
  const cuerpo = src.replace(/^(\/\/[^\n]*\n)+/, '');
  assert.ok(cuerpo.startsWith('(function () {') && cuerpo.trimEnd().endsWith('})();'), 'el editor no está en una IIFE');
  assert.deepStrictEqual([...src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]), ['XaborBannerTienda']);
  assert.ok(!/\sonclick=/.test(src), 'onclick en línea: necesitaría nombres globales');
  assert.ok(PANEL.includes(`data-sec="banner"      data-modulo="tienda_online" onclick="tndIr('banner')">Banner</button>`));
  assert.ok(PANEL.includes('<div id="tnd-sec-banner"      class="tnd-sec" style="display:none;"></div>'));
  assert.ok(PANEL.includes('banner: () => window.XaborBannerTienda?.abrir(el) })[sec]?.();'));
  assert.ok(!/function XaborBannerTienda|const XaborBannerTienda|let XaborBannerTienda/.test(PANEL), 'el panel ya declara ese nombre');
});

// ══ C) Servidor real ════════════════════════════════════════════════════════
if (process.env.SOLO_PURAS === '1') {
  console.log('\n(SOLO_PURAS=1: se omite la parte C)');
} else {
  const { arrancarServidor } = await import('./lib-servidor.mjs');
  const { crearTokenSesion } = await import('../src/services/session.js');
  const { pool } = await import('../src/services/database.js');
  const sharp = (await import('sharp')).default;
  const PUERTO = process.env.TEST_PORT_BANNER || '4731';
  const base = `http://localhost:${PUERTO}`;
  const SUF = randomBytes(4).toString('hex');
  const NEG = {};   // a, b: { id, slug, admin, staff, producto }

  const pedir = async (ruta, { cookie, metodo = 'GET', cuerpo } = {}) => {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers: { ...(cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    const tipo = r.headers.get('content-type') || '';
    return { status: r.status, tipo, body: tipo.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  const sesion = (usuarioId, negocioId, rol) =>
    `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;

  async function alta(letra, { tema = 'v2' } = {}) {
    const id = randomUUID(), slug = `banner-${letra}-${SUF}`;
    await pool.query(`INSERT INTO negocios (id, nombre, slug, activo) VALUES ($1,$2,$3,TRUE)`, [id, `Banner ${letra} ${SUF}`, slug]);
    const usuarios = {};
    for (const rol of ['admin', 'staff']) {
      const { rows: [u] } = await pool.query(
        `INSERT INTO usuarios (negocio_id, nombre, email, activo) VALUES ($1,$2,$3,TRUE) RETURNING id`,
        [id, `${rol} ${letra}`, `${rol}-${letra}-${SUF}@banner.local`]);
      await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,$3,TRUE)`, [u.id, id, rol]);
      usuarios[rol] = sesion(u.id, id, rol);
    }
    for (const m of ['tienda_online', 'menu']) {
      await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [id, m]);
    }
    await pool.query(`INSERT INTO tienda_config (negocio_id, estado) VALUES ($1,'publicada')`, [id]);
    if (tema) {
      await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'tienda_diseno',$2)`,
        [id, JSON.stringify({ tema })]);
    }
    const { rows: [c] } = await pool.query(
      `INSERT INTO menu_categorias (negocio_id, nombre) VALUES ($1,'Temporada') RETURNING id`, [id]);
    const { rows: [p] } = await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio) VALUES ($1,$2,'Pozole',120) RETURNING id`, [id, c.id]);
    await pool.query(`INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)`, [id, p.id]);
    NEG[letra] = { id, slug, ...usuarios, producto: p.id };
  }

  async function limpiar() {
    for (const n of Object.values(NEG)) {
      for (const sql of [
        'DELETE FROM tienda_productos WHERE negocio_id = $1', 'DELETE FROM tienda_config WHERE negocio_id = $1',
        'DELETE FROM menu_productos WHERE negocio_id = $1', 'DELETE FROM menu_categorias WHERE negocio_id = $1',
        'DELETE FROM configuracion WHERE negocio_id = $1', 'DELETE FROM negocio_modulos WHERE negocio_id = $1',
        'DELETE FROM usuario_negocios WHERE negocio_id = $1', 'DELETE FROM usuarios WHERE negocio_id = $1',
        'DELETE FROM negocios WHERE id = $1',
      ]) await pool.query(sql, [n.id]).catch(e => console.log(`  (limpieza) ${e.message}`));
    }
  }

  const fotoPng = async (color) => (await sharp({ create: { width: 64, height: 36, channels: 3, background: color } })
    .png().toBuffer()).toString('base64');
  const banner = async (letra) => JSON.parse((await pool.query(
    `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'tienda_banner'`, [NEG[letra].id])).rows[0]?.valor || '{}');
  const rutaLocal = clave => join(RAIZ, 'storage', 'documentos', clave);

  let servidor;
  try {
    await alta('a');
    await alta('b');
    await alta('c', { tema: null });
    servidor = await arrancarServidor({ PORT: PUERTO, STORAGE_DRIVER: 'local' }, { timeoutMs: 90000 });

    await t('C1. sin banner, la API pública manda la lista vacía (portada de siempre)', async () => {
      const r = await pedir(`/api/tienda/${NEG.a.slug}`);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.banner, []);
      assert.strictEqual(r.body.diseno.tema, 'v2');
    });

    await t('C2. un operador (staff) no puede ver, guardar ni subir', async () => {
      for (const [metodo, ruta, cuerpo] of [['GET', '/api/admin/tienda/banner'],
        ['PUT', '/api/admin/tienda/banner', { diapositivas: [dia()] }],
        ['POST', '/api/admin/tienda/banner/foto', { base64: await fotoPng('#c00') }]]) {
        const r = await pedir(ruta, { cookie: NEG.a.staff, metodo, cuerpo });
        assert.strictEqual(r.status, 403, `${metodo} ${ruta} -> ${r.status}`);
      }
      assert.deepStrictEqual(await banner('a'), {}, 'el operador dejó algo escrito');
      const sinSesion = await pedir('/api/admin/tienda/banner');
      assert.strictEqual(sinSesion.status, 401);
    });

    let fotoA;
    await t('C3. el admin sube una foto real y la tienda la sirve', async () => {
      const r = await pedir('/api/admin/tienda/banner/foto', { cookie: NEG.a.admin, metodo: 'POST', cuerpo: { base64: await fotoPng('#c00') } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.match(r.body.id, /^[a-f0-9]{16}$/);
      assert.strictEqual(r.body.url, `/img/tienda/${NEG.a.slug}/${r.body.id}`);
      fotoA = r.body.id;
      const img = await pedir(r.body.url);
      assert.strictEqual(img.status, 200);
      assert.match(img.tipo, /^image\/(png|jpeg)$/);
      assert.ok(img.body.length > 50);
      const guardado = await banner('a');
      assert.ok(claveDeTiendaDelNegocio(NEG.a.id, guardado.fotos[fotoA].storage_key), guardado.fotos[fotoA].storage_key);
    });

    await t('C4. un archivo que no es imagen se rechaza con un mensaje claro', async () => {
      const r = await pedir('/api/admin/tienda/banner/foto', { cookie: NEG.a.admin, metodo: 'POST',
        cuerpo: { base64: Buffer.from('<svg onload=alert(1)>').toString('base64') } });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.error, 'Sube una imagen JPG, PNG o WEBP');
    });

    await t('C5. guardar dos diapositivas: el cliente ve solo la vigente hoy', async () => {
      const r = await pedir('/api/admin/tienda/banner', { cookie: NEG.a.admin, metodo: 'PUT', cuerpo: { diapositivas: [
        dia({ ceja: 'De temporada', titulo: 'Pozole rojo\nsolo en octubre', foto: { tipo: 'subida', id: fotoA },
          destino: { tipo: 'producto', productoId: NEG.a.producto } }),
        dia({ titulo: 'Rosca de reyes', desde: '2099-01-01', foto: { tipo: 'url', url: 'https://x.com/rosca.jpg' } }),
      ] } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.diapositivas.length, 2);
      assert.strictEqual(r.body.diapositivas[0].fotoUrl, `/img/tienda/${NEG.a.slug}/${fotoA}`);
      const pub = await pedir(`/api/tienda/${NEG.a.slug}`);
      assert.deepStrictEqual(pub.body.banner, [{ ceja: 'De temporada', titulo: 'Pozole rojo\nsolo en octubre', texto: '',
        boton: 'Ordenar', productoId: NEG.a.producto, foto: `/img/tienda/${NEG.a.slug}/${fotoA}` }]);
    });

    await t('C6. un error de validación no toca lo guardado', async () => {
      const antes = await banner('a');
      const r = await pedir('/api/admin/tienda/banner', { cookie: NEG.a.admin, metodo: 'PUT',
        cuerpo: { diapositivas: [dia({ desde: '2026-10-10', hasta: '2026-10-01' })] } });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.codigo, 'BANNER_FECHAS_AL_REVES');
      assert.deepStrictEqual(await banner('a'), antes);
    });

    await t('C7. la foto de un negocio no se sirve por la tienda de otro ni se puede tomar prestada', async () => {
      const ajena = await pedir(`/img/tienda/${NEG.b.slug}/${fotoA}`);
      assert.strictEqual(ajena.status, 404);
      const r = await pedir('/api/admin/tienda/banner', { cookie: NEG.b.admin, metodo: 'PUT',
        cuerpo: { diapositivas: [dia({ foto: { tipo: 'subida', id: fotoA } })] } });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.codigo, 'BANNER_FOTO_PERDIDA');
    });

    await t('C8. una fila escrita a mano con la clave de OTRO negocio no se sirve ni se borra', async () => {
      const claveA = (await banner('a')).fotos[fotoA].storage_key;
      const falsa = 'fedcba9876543210';
      await pool.query(
        `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'tienda_banner',$2)
         ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = EXCLUDED.valor`,
        [NEG.b.id, JSON.stringify({ diapositivas: [dia({ foto: { tipo: 'subida', id: falsa } })],
          fotos: { [falsa]: { storage_key: claveA, mime: 'image/png', subida_at: '2020-01-01T00:00:00Z' } } })]);
      const img = await pedir(`/img/tienda/${NEG.b.slug}/${falsa}`);
      assert.strictEqual(img.status, 404, 'sirvió el archivo de otro negocio');
      // Quitarla al guardar (vieja, sin gracia) NO puede borrar el archivo de A.
      const r = await pedir('/api/admin/tienda/banner', { cookie: NEG.b.admin, metodo: 'PUT', cuerpo: { diapositivas: [] } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      await new Promise(res => setTimeout(res, 300));
      assert.ok(existsSync(rutaLocal(claveA)), 'borró el archivo de otro negocio');
      assert.strictEqual((await pedir(`/img/tienda/${NEG.a.slug}/${fotoA}`)).status, 200);
    });

    await t('C9. quitar la foto de una diapositiva borra el archivo cuando ya pasó la gracia', async () => {
      const claveA = (await banner('a')).fotos[fotoA].storage_key;
      // Recién subida, sobrevive al guardado (otra pestaña podría estar usándola).
      let r = await pedir('/api/admin/tienda/banner', { cookie: NEG.a.admin, metodo: 'PUT', cuerpo: { diapositivas: [dia()] } });
      assert.strictEqual(r.status, 200);
      assert.ok((await banner('a')).fotos[fotoA], 'borró una foto suelta recién subida');
      assert.ok(existsSync(rutaLocal(claveA)));
      // Envejecida más allá de la gracia, el siguiente guardado la borra.
      const v = await banner('a');
      v.fotos[fotoA].subida_at = new Date(Date.now() - 7 * 3600e3).toISOString();
      await pool.query(`UPDATE configuracion SET valor = $2 WHERE negocio_id = $1 AND clave = 'tienda_banner'`,
        [NEG.a.id, JSON.stringify(v)]);
      r = await pedir('/api/admin/tienda/banner', { cookie: NEG.a.admin, metodo: 'PUT', cuerpo: { diapositivas: [dia()] } });
      assert.strictEqual(r.status, 200);
      await new Promise(res => setTimeout(res, 300));
      assert.strictEqual((await banner('a')).fotos[fotoA], undefined);
      assert.ok(!existsSync(rutaLocal(claveA)), 'el archivo sigue en el almacenamiento');
      assert.strictEqual((await pedir(`/img/tienda/${NEG.a.slug}/${fotoA}`)).status, 404);
    });

    await t('C10. con el diseño clásico la API no manda el banner aunque exista', async () => {
      const r = await pedir('/api/admin/tienda/banner', { cookie: NEG.c.admin, metodo: 'PUT', cuerpo: { diapositivas: [dia()] } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const ed = await pedir('/api/admin/tienda/banner', { cookie: NEG.c.admin });
      assert.strictEqual(ed.body.tema, 'clasico');
      assert.strictEqual(ed.body.diapositivas.length, 1);
      const pub = await pedir(`/api/tienda/${NEG.c.slug}`);
      assert.deepStrictEqual(pub.body.banner, []);
    });

    await t('C12. la lectura pública cuenta el día en la zona del negocio, no en UTC', async () => {
      const { bannerPublico } = await import('../src/services/tiendaBanner.js');
      const r = await pedir('/api/admin/tienda/banner', { cookie: NEG.a.admin, metodo: 'PUT',
        cuerpo: { diapositivas: [dia({ titulo: 'Hasta el 9', hasta: '2026-10-09' })] } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const leer = ahora => bannerPublico(NEG.a.id, { slug: NEG.a.slug, zona: 'America/Matamoros', ahora: new Date(ahora) });
      // 22:00 del 9 en Matamoros = 03:00Z del 10: en UTC ya sería el 10.
      assert.deepStrictEqual((await leer('2026-10-10T03:00:00Z')).map(d => d.titulo), ['Hasta el 9']);
      assert.deepStrictEqual(await leer('2026-10-10T05:30:00Z'), []);
    });

    await t('C11. una liga http o javascript: no se guarda', async () => {
      for (const url of ['http://x.com/a.jpg', 'javascript:alert(1)']) {
        const r = await pedir('/api/admin/tienda/banner', { cookie: NEG.a.admin, metodo: 'PUT',
          cuerpo: { diapositivas: [dia({ foto: { tipo: 'url', url } })] } });
        assert.strictEqual(r.status, 400, url);
        assert.strictEqual(r.body.codigo, 'BANNER_FOTO_INVALIDA');
      }
    });
  } catch (e) {
    console.log(`FALLO preparación: ${e.message}`);
    fallidas++;
    if (servidor) console.log(servidor.obtenerSalida().slice(-1500));
  } finally {
    servidor?.detener();
    await limpiar();
    await pool.end().catch(() => {});
  }
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) console.log('Fallaron:\n  ' + fallos.join('\n  '));
process.exit(fallidas ? 1 : 0);
