// Landing de xabor.mx — v2.
//
// La landing anterior vendía "un bot de WhatsApp" y el producto ya no es eso:
// hay POS, restaurante con mesas y comandas, entregas y pagos. Esta suite
// existe para que la página no vuelva a quedarse corta sin que nadie se dé
// cuenta: comprueba que las cuatro patas del producto estén presentes, que el
// precio publicado siga siendo el real, que el formulario siga apuntando al
// endpoint que guarda el prospecto y que no haya assets rotos.
//
// Todo se pide al servidor: es lo que recibiría un visitante.
import assert from 'assert';
import vm from 'vm';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT || '4962';
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;
const traer = async (ruta) => { const r = await fetch(base + ruta); return { status: r.status, tipo: r.headers.get('content-type') || '', texto: await r.text() }; };
const pesar = async (ruta) => { const r = await fetch(base + ruta); return { status: r.status, bytes: (await r.arrayBuffer()).byteLength }; };

const { texto: html } = await traer('/');
const soloTexto = html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ');

// ── 1-3. El mensaje principal ──────────────────────────────────────────────
await t('MENSAJE', '1. el H1 habla de la operación completa, no solo de WhatsApp', async () => {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  assert.ok(h1, 'debe existir un H1');
  const texto = h1[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  assert.ok(texto.length > 12, 'el H1 no puede estar vacío');
  assert.ok(!/^convierte tus mensajes de whatsapp/i.test(texto), 'el H1 anterior posicionaba a Xabor solo como bot');
  assert.ok(/pedido|negocio|operaci/i.test(texto), `el H1 debe hablar del negocio y sus pedidos: "${texto}"`);
});

await t('MENSAJE', '2. WhatsApp aparece como UN módulo, no como toda la historia', async () => {
  const enH1 = /<h1[^>]*>[\s\S]*?whatsapp[\s\S]*?<\/h1>/i.test(html);
  assert.ok(!enH1, 'WhatsApp no debe ser el titular');
  assert.ok(/whatsapp/i.test(soloTexto), 'pero sí debe estar presente: sigue siendo una fortaleza');
});

await t('MENSAJE', '3. las cuatro patas del producto están nombradas', async () => {
  for (const [que, patron] of [
    ['WhatsApp', /whatsapp/i],
    ['POS', /\bPOS\b/],
    ['Restaurante', /restaurante/i],
    ['Mesas', /mesas?/i],
    ['Comandas', /comandas?/i],
    ['Entregas', /entrega|repartidor/i],
    ['Pagos', /pagos?/i],
  ]) {
    assert.ok(patron.test(soloTexto), `falta ${que} en la landing`);
  }
});

// ── 4-8. Estructura ────────────────────────────────────────────────────────
await t('SECCIONES', '4. existen las secciones que la navegación promete', async () => {
  for (const id of ['producto', 'como-funciona', 'para-quien', 'precio', 'faq', 'demo']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `falta la sección #${id}`);
  }
  // Y cada enlace del menú apunta a algo que existe en la página.
  const anclas = [...html.matchAll(/href="#([a-z-]+)"/g)].map(m => m[1]);
  const rotas = [...new Set(anclas)].filter(a => a !== 'top' && !new RegExp(`id="${a}"`).test(html));
  assert.deepStrictEqual(rotas, [], 'anclas del menú que no llevan a ninguna sección');
});

await t('SECCIONES', '5. el flujo "así funciona" explica el recorrido en cuatro pasos', async () => {
  const seccion = html.slice(html.indexOf('id="como-funciona"'), html.indexOf('id="como-funciona"') + 3500);
  assert.strictEqual((seccion.match(/class="paso"/g) || []).length, 4, 'deben ser cuatro pasos');
  assert.ok(/entra el pedido/i.test(seccion), 'paso 1: de dónde entra');
  assert.ok(/organiza/i.test(seccion), 'paso 2: cómo se estructura');
  assert.ok(/equipo/i.test(seccion), 'paso 3: quién opera');
});

await t('SECCIONES', '6. el producto se muestra por pestañas que controla la persona', async () => {
  assert.ok(/role="tablist"/.test(html), 'hay pestañas accesibles');
  for (const id of ['p-pedidos', 'p-restaurante', 'p-pos', 'p-entregas']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `falta el panel ${id}`);
  }
  assert.ok(!/setInterval|carousel|autoplay/i.test(html), 'nada debe cambiar de pestaña solo');
});

await t('SECCIONES', '7. Restaurante tiene protagonismo con su UI real', async () => {
  assert.ok(/tablero/i.test(html) || /mesa-mini/.test(html), 'se muestra el tablero de mesas');
  assert.ok(/Por enviar/i.test(soloTexto), 'con el estado real "Por enviar"');
  assert.ok(/Ronda 1/i.test(soloTexto), 'y una comanda por ronda');
  assert.ok(/Modificador|Salsa|Prote/i.test(soloTexto), 'con modificadores');
});

await t('SECCIONES', '8. hay segmentos concretos, no "para todos los negocios"', async () => {
  assert.ok(!/para todo tipo de negocio|cualquier negocio/i.test(soloTexto), 'no se promete servir a todos');
  const segmentos = ['restaurante', 'cafeter', 'cocina', 'reposter'];
  for (const s of segmentos) assert.ok(new RegExp(s, 'i').test(soloTexto), `falta el segmento ${s}`);
});

// ── 9-11. Llamados a la acción y demostración ──────────────────────────────
await t('ACCION', '9. el CTA principal es consistente en toda la página', async () => {
  const ctas = [...soloTexto.matchAll(/Solicitar (una )?demostraci[oó]n/gi)];
  assert.ok(ctas.length >= 3, `el CTA debe repetirse en la página (encontrados: ${ctas.length})`);
  for (const prohibido of [/prueba gratis/i, /empieza gratis/i, /agenda ahora/i, /hablar con ventas/i]) {
    assert.ok(!prohibido.test(soloTexto), `no debe existir un CTA de un flujo que no existe: ${prohibido}`);
  }
});

await t('ACCION', '10. "Iniciar sesión" lleva al login real y la página responde', async () => {
  assert.ok(/href="\/login"/.test(html), 'debe haber acceso a la sesión');
  const r = await traer('/login');
  assert.strictEqual(r.status, 200);
});

await t('ACCION', '11. el formulario de demostración sigue apuntando al endpoint que guarda', async () => {
  assert.ok(/id="lead-form"/.test(html), 'el formulario existe');
  assert.ok(html.includes("fetch('/api/public/prospectos'"), 'envía al endpoint real, no es decorativo');
  for (const campo of ['f-nombre', 'f-negocio', 'f-ciudad', 'f-telefono', 'f-tipo', 'f-consentimiento']) {
    assert.ok(new RegExp(`id="${campo}"`).test(html), `falta el campo ${campo}`);
  }
  assert.ok(/empresa-web/.test(html), 'conserva el honeypot antispam');
  // El endpoint sigue vivo y rechazando lo inválido (no se crea nada).
  const r = await fetch(base + '/api/public/prospectos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.ok(r.status === 400 || r.status === 429, `el endpoint debe validar y respondió ${r.status}`);
});

// ── 12-13. Precio y legal ──────────────────────────────────────────────────
await t('PRECIO', '12. el precio regular publicado es el real y no aparece comisión por pedido', async () => {
  const regular = html.match(/<div class="tarjeta-precio">[\s\S]*?<\/div>\s*<div class="tarjeta-promo"/)?.[0] || '';
  const textoRegular = regular.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.ok(/precio regular/i.test(textoRegular), 'la tarjeta permanente se identifica como el precio regular');
  assert.ok(/\$990\s*MXN \/ mes/.test(textoRegular), 'mensualidad regular de $990 MXN al mes');
  assert.ok(/\$2,500\s*MXN/.test(textoRegular), 'instalación regular de $2,500 MXN');
  assert.ok(/sin comisi[oó]n/i.test(soloTexto), 'se dice explícitamente que no hay comisión por pedido');
  assert.ok(!/enterprise/i.test(soloTexto), 'no se inventan planes que no existen');
});

// La promoción se prestaba a leerse como "$990 en agosto y otros $990 en
// septiembre". Estos casos vigilan justo esa lectura.
await t('PROMO', '12b. la promoción cubre agosto Y septiembre por $990 en total', async () => {
  const promo = html.match(/<div class="tarjeta-promo">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)?.[0];
  assert.ok(promo, 'existe la tarjeta promocional');
  const texto = promo.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  assert.ok(/promoci[oó]n temporal/i.test(texto), 'se marca como promoción temporal, no como el precio de siempre');
  assert.ok(/agosto\s*\+\s*septiembre/i.test(texto), 'nombra los dos meses que cubre');
  assert.ok(/\$990/.test(texto), 'el monto promocional es $990');

  // Lo importante: que diga TOTAL por los dos meses juntos.
  assert.ok(/total por los dos meses/i.test(texto),
    'debe decir que $990 es el total de los dos meses, no la mensualidad de cada uno');
  assert.ok(!/\$990\s*MXN al mes/i.test(texto),
    'la tarjeta promocional no debe decir "mensualidad $990 al mes": es lo que causaba la confusión');
  assert.ok(!/s[ií] aplica/i.test(texto), 'fuera la etiqueta "Sí aplica" que sugería pago mensual');

  assert.ok(/instalaci[oó]n/i.test(texto) && /sin costo/i.test(texto), 'la instalación promocional es sin costo');
  assert.ok(/despu[eé]s de septiembre/i.test(texto) && /\$990 MXN \/ mes/.test(texto),
    'después de septiembre arranca la mensualidad de $990');
  assert.ok(/agosto de 2026/i.test(texto), 'la vigencia declarada es agosto de 2026');
  assert.ok(!/5 negocios|cinco negocios/i.test(texto), 'el cupo de 5 negocios se retiró: la promoción es por tiempo');
});

await t('PROMO', '12c. el monto promocional domina visualmente y el CTA es el de siempre', async () => {
  const promo = html.match(/<div class="tarjeta-promo">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)[0];
  assert.ok(/class="promo-monto">\$990/.test(promo), 'el $990 va en el elemento destacado de la tarjeta');

  // El destacado debe ser tipográficamente mayor que el precio regular.
  const css = (await traer('/public/landing/styles.css')).texto;
  const promoMonto = css.match(/\.promo-monto\s*{[^}]*font-size:\s*clamp\(([\d.]+)rem/)?.[1];
  const precioMonto = css.match(/\.precio-monto\s*{[^}]*font-size:\s*([\d.]+)rem/)?.[1];
  assert.ok(promoMonto && precioMonto, 'ambos montos declaran tamaño');
  assert.ok(Number(promoMonto) > Number(precioMonto),
    `el monto promocional (${promoMonto}rem) debe dominar sobre el regular (${precioMonto}rem)`);

  const cta = promo.match(/id="promo-btn"[^>]*>([^<]+)</)?.[1].trim();
  assert.strictEqual(cta, 'Solicitar una demostración', 'el CTA promocional es el mismo de la landing');
  assert.ok(/href="#demo"/.test(promo), 'y lleva al formulario');
});

await t('LEGAL', '13. el aviso de privacidad sigue enlazado y se sirve', async () => {
  assert.ok(/href="\/aviso-privacidad\.html"/.test(html), 'enlazado desde la landing');
  const r = await traer('/aviso-privacidad.html');
  assert.strictEqual(r.status, 200);
  assert.ok(/xabor/i.test(r.texto));
});

// ── 14-16. Marca, SEO y social ─────────────────────────────────────────────
await t('MARCA', '14. la landing usa el isotipo canónico y el color de marca', async () => {
  assert.ok(/<link rel="icon"[^>]*xabor-icono\.svg\?v=\d+/.test(html), 'favicon versionado');
  assert.ok(/<meta name="theme-color" content="#FF6B35">/.test(html), 'theme-color de marca');
  assert.ok(/\/public\/brand\/xabor-icono\.svg/.test(html), 'el logotipo sale de /public/brand');
  const css = await traer('/public/landing/styles.css');
  assert.ok(/--marca:\s*#FF6B35/.test(css.texto), 'la hoja usa el naranja de marca');
});

await t('SEO', '15. title, description, canonical y Open Graph describen el producto completo', async () => {
  const title = (html.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
  assert.ok(/xabor/i.test(title) && /pos|restaurante|pedidos/i.test(title), `title corto de miras: "${title}"`);
  const desc = (html.match(/<meta name="description" content="([^"]+)"/) || [])[1] || '';
  assert.ok(desc.length > 80 && desc.length < 200, `description fuera de rango (${desc.length})`);
  assert.ok(/<link rel="canonical" href="https:\/\/xabor\.mx\/">/.test(html), 'canonical');
  assert.ok(/<meta property="og:image" content="https:\/\/xabor\.mx\/public\/brand\/xabor-social\.png">/.test(html), 'og:image');
  assert.ok(/summary_large_image/.test(html), 'twitter card grande');
  const social = await pesar('/public/brand/xabor-social.png');
  assert.strictEqual(social.status, 200);
});

await t('SEO', '16. la jerarquía de encabezados es sensata', async () => {
  assert.strictEqual((html.match(/<h1\b/g) || []).length, 1, 'un solo H1');
  assert.ok((html.match(/<h2\b/g) || []).length >= 6, 'las secciones usan H2');
});

// ── 17-19. Integridad y accesibilidad ──────────────────────────────────────
await t('INTEGRIDAD', '17. ningún asset referenciado responde 404', async () => {
  const refs = [...new Set([...html.matchAll(/(?:href|src)="(\/[^"]+\.(?:css|js|svg|png|ico|webmanifest)(?:\?[^"]*)?)"/g)].map(m => m[1]))];
  assert.ok(refs.length >= 3, 'la página debe referenciar sus assets');
  const rotos = [];
  for (const ref of refs) {
    const r = await pesar(ref);
    if (r.status !== 200) rotos.push(`${ref} -> ${r.status}`);
  }
  assert.deepStrictEqual(rotos, [], 'assets rotos');
});

await t('INTEGRIDAD', '18. el HTML no está roto y su JavaScript compila', async () => {
  const limpio = html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
  const abre = /<script\b([^>]*)>/gi;
  let m, inline = 0;
  while ((m = abre.exec(limpio)) !== null) {
    const ini = abre.lastIndex;
    const fin = limpio.indexOf('</script>', ini);
    assert.notStrictEqual(fin, -1, 'hay un <script> sin cerrar');
    if (!/\bsrc\s*=/i.test(m[1] || '')) { new vm.Script(limpio.slice(ini, fin), { filename: 'landing' }); inline++; }
    abre.lastIndex = fin + '</script>'.length;
  }
  assert.ok(inline >= 1, 'debe haber JavaScript propio');
  assert.ok(!/document\.getElementById\(|=>\s*\{/.test(soloTexto), 'no debe pintarse código como texto');
  const etiquetas = ['main', 'header', 'footer'];
  for (const e of etiquetas) {
    assert.strictEqual((html.match(new RegExp(`<${e}\\b`, 'g')) || []).length,
      (html.match(new RegExp(`</${e}>`, 'g')) || []).length, `<${e}> sin cerrar`);
  }
});

await t('ACCESIBILIDAD', '19. imágenes con alt, botones reales y menú móvil declarado', async () => {
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map(m => m[0]);
  const sinAlt = imgs.filter(i => !/\salt=/.test(i));
  assert.deepStrictEqual(sinAlt, [], 'toda imagen necesita alt (vacío si es decorativa)');
  assert.ok(/id="nav-abrir"[^>]*aria-expanded/.test(html), 'el botón de menú declara su estado');
  assert.ok(/aria-controls="menu-movil"/.test(html), 'y qué controla');
  assert.ok(/<button class="faq-q" aria-expanded/.test(html), 'las preguntas son botones, no divs');
  assert.ok(/:focus-visible/.test((await traer('/public/landing/styles.css')).texto), 'hay foco visible para teclado');
});

// ── 20. Peso y responsive declarado ────────────────────────────────────────
await t('RENDIMIENTO', '20. sin framework nuevo, sin fuentes remotas y con reglas para cada tamaño', async () => {
  assert.ok(!/<script[^>]+src="https?:/i.test(html), 'no se carga JavaScript de terceros');
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/i.test(html), 'no se cargan fuentes remotas');
  // Se busca la ENTREGA de un framework (archivo o import), no la palabra:
  // "vuelve" contiene "vue" y no significa nada.
  assert.ok(!/(react|vue|angular|jquery|tailwind)[\w.-]*\.js/i.test(html), 'no se introduce un framework');
  assert.ok(!/from\s+['"](react|vue|@angular)/i.test(html), 'ni se importa uno');
  const css = (await traer('/public/landing/styles.css')).texto;
  for (const bp of ['1080px', '860px', '680px']) {
    assert.ok(new RegExp(`max-width:\\s*${bp}`).test(css), `falta el punto de quiebre ${bp}`);
  }
  assert.ok(/overflow-x:\s*hidden/.test(css), 'el cuerpo no scrollea de lado');
  assert.ok(css.length < 60000, `la hoja creció demasiado (${css.length} bytes)`);
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
