// Autofactura nativa de Xabor — fase 2: portal público de consulta por token.
//
// Servidor REAL (lib-servidor.mjs) contra Postgres local. Sin Facturapi, sin
// Meta, sin sesión: el token en la URL es la única autorización. Demuestra
// que /f/<token> y /api/autofactura/<token> exponen solo los datos públicos
// de la venta, que el negocio y el folio salen del token (nunca del
// navegador), y que un negocio inactivo o sin módulo de facturación no
// expone nada.
import assert from 'node:assert/strict';
import { arrancarServidor } from './lib-servidor.mjs';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL requerida');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname), 'solo base local');
assert.ok(process.env.INTEGRATIONS_ENCRYPTION_KEY, 'INTEGRATIONS_ENCRYPTION_KEY requerida');

const PUERTO = process.env.TEST_PORT || '4199';
const { pool, actualizarConfiguracion } = await import('../src/services/database.js');
const { crearOObtenerAutofactura, revocarAutofactura } = await import('../src/services/autofacturaService.js');

let pasadas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallos.push(`${nombre}: ${e.message}`); }
}

const { rows: negocios } = await pool.query('SELECT id FROM negocios ORDER BY created_at LIMIT 2');
if (negocios.length < 2) throw new Error('La base local necesita al menos dos negocios de prueba');
const [NEG, NEG_B] = negocios.map((n) => n.id);
const PREFIJO = 'XAB-AFPUB';
const F = (s) => `${PREFIJO}-${s}`;
const FECHA_VENTA = '2026-09-20T18:30:00.000Z';
const NOMBRE_A = 'Negocio Autofactura Pública';
const LOGO_A = 'https://ejemplo.test/logo-autofactura.png';
const NOMBRE_B = 'Otro Negocio Autofactura';

// ═══ Estado previo de los dos negocios: se restaura EXACTAMENTE en finally ═══
const filaUnica = async (sql, p) => (await pool.query(sql, p)).rows[0] || null;
const previo = {};
for (const n of [NEG, NEG_B]) {
  previo[n] = {
    activo: (await filaUnica('SELECT activo FROM negocios WHERE id=$1', [n])).activo,
    modulo: (await filaUnica(`SELECT estado FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [n]))?.estado ?? null,
    config: Object.fromEntries((await pool.query(
      `SELECT clave, valor FROM configuracion WHERE negocio_id=$1 AND clave IN ('nombre','logo_url')`, [n])).rows.map((r) => [r.clave, r.valor])),
  };
}
async function fijarModulo(negocioId, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'facturacion',$2)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado=$2`, [negocioId, estado]);
}
async function sembrarPedido(negocioId, folio, { total = 150 } = {}) {
  await pool.query(
    `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, entregado_at)
     VALUES ($1,$2,'entregado',$3::jsonb, NOW())
     ON CONFLICT (folio) DO UPDATE SET negocio_id=$1, estado='entregado', datos=$3::jsonb, entregado_at=NOW()`,
    [negocioId, folio, JSON.stringify({
      total, forma_pago: 'efectivo', pago_confirmado: true, modalidad: 'recoger en tienda', timestamp: FECHA_VENTA,
      cliente: { nombre: 'Cliente Público', telefono: '5218780000002' },
    })]);
}
const limpiar = () => Promise.all([
  pool.query('DELETE FROM autofacturas WHERE folio LIKE $1', [`${PREFIJO}%`]),
  pool.query('DELETE FROM pedidos_activos WHERE folio LIKE $1', [`${PREFIJO}%`]),
]);
await limpiar();
await pool.query('UPDATE negocios SET activo=TRUE WHERE id = ANY($1)', [[NEG, NEG_B]]);
await fijarModulo(NEG, 'activo'); await fijarModulo(NEG_B, 'activo');
await actualizarConfiguracion({ nombre: NOMBRE_A, logo_url: LOGO_A }, NEG);
await actualizarConfiguracion({ nombre: NOMBRE_B, logo_url: '' }, NEG_B);

const srv = await arrancarServidor({ PORT: PUERTO, XABOR_AUTOFACTURA_LIMITE_LECTURA: '500' }, { timeoutMs: 30000 });
const base = srv.base;
const api = async (token, sufijo = '') => {
  const r = await fetch(`${base}/api/autofactura/${token}${sufijo}`);
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch { /* no JSON */ }
  return { status: r.status, json, texto, tipo: r.headers.get('content-type') || '' };
};
const CAMPOS_PUBLICOS = ['negocio', 'folio', 'fecha', 'total', 'estado', 'expires_at'];

let liga, ligaB;
try {

await t('1. GET /api/autofactura/<token> de una venta pagada responde 200', async () => {
  await sembrarPedido(NEG, F('OK'));
  liga = await crearOObtenerAutofactura(NEG, F('OK'));
  const r = await api(liga.token);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.folio, F('OK'));
  assert.equal(r.json.estado, 'vigente');
  assert.equal(r.json.total, 150);
  assert.equal(r.json.fecha, FECHA_VENTA, 'la fecha es la de la VENTA (timestamp del pedido), no la de la liga');
  assert.equal(r.json.negocio.nombre, NOMBRE_A);
  assert.equal(r.json.negocio.logo_url, LOGO_A);
  assert.ok(r.json.expires_at && new Date(r.json.expires_at) > new Date());
  assert.match(r.tipo, /application\/json/);
});

await t('2. solo devuelve los campos públicos permitidos', async () => {
  const r = await api(liga.token);
  assert.deepEqual(Object.keys(r.json).sort(), [...CAMPOS_PUBLICOS].sort());
  assert.deepEqual(Object.keys(r.json.negocio).sort(), ['logo_url', 'nombre']);
});

await t('3. no filtra negocio_id ni ids internos', async () => {
  const r = await api(liga.token);
  assert.ok(!r.texto.includes(NEG), 'el negocio_id viajó al navegador');
  assert.ok(!r.texto.includes(liga.id), 'el id interno de la autofactura viajó al navegador');
  assert.ok(!/negocio_?id|"id"/i.test(r.texto));
});

await t('4. no filtra token, hash, material cifrado ni intento_key', async () => {
  const r = await api(liga.token);
  const { rows: [db] } = await pool.query('SELECT * FROM autofacturas WHERE negocio_id=$1 AND folio=$2', [NEG, F('OK')]);
  for (const v of [liga.token, db.token_hash, db.token_cifrado, db.token_iv, db.token_auth_tag]) {
    assert.ok(!r.texto.includes(v), 'un secreto de la liga viajó al navegador');
  }
  assert.ok(!/token|hash|cifrad|auth_tag|intento_key|error_detalle/i.test(r.texto));
});

await t('5. token inventado (formato válido) → 404 genérico', async () => {
  const inventado = Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i)).toString('base64url');
  const r = await api(inventado);
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { error: 'No encontramos esta liga de facturación.' });
});

await t('6. token malformado → 404 controlado, mismo cuerpo que el inexistente', async () => {
  for (const malo of ['XAB-0001', encodeURIComponent("' OR 1=1 --"), 'A'.repeat(500), encodeURIComponent('../../etc/passwd'), '%00']) {
    const r = await api(malo);
    assert.equal(r.status, 404, `token malformado ${malo.slice(0, 20)} no dio 404`);
    assert.deepEqual(r.json, { error: 'No encontramos esta liga de facturación.' });
  }
  const sinToken = await fetch(`${base}/api/autofactura/`);
  assert.ok([404].includes(sinToken.status), 'sin token debe ser 404');
});

await t('7. liga expirada → estado expirada (respuesta controlada)', async () => {
  await sembrarPedido(NEG, F('EXP'));
  const l = await crearOObtenerAutofactura(NEG, F('EXP'));
  await pool.query(`UPDATE autofacturas SET expires_at = now() - interval '1 day' WHERE negocio_id=$1 AND folio=$2`, [NEG, F('EXP')]);
  const r = await api(l.token);
  assert.equal(r.status, 200); assert.equal(r.json.estado, 'expirada'); assert.equal(r.json.folio, F('EXP'));
});

await t('8. liga revocada → estado revocada', async () => {
  await sembrarPedido(NEG, F('REV'));
  const l = await crearOObtenerAutofactura(NEG, F('REV'));
  await revocarAutofactura(NEG, F('REV'));
  const r = await api(l.token);
  assert.equal(r.status, 200); assert.equal(r.json.estado, 'revocada');
});

await t('9. liga facturada → estado facturada, sin PDF/XML ni datos fiscales', async () => {
  await sembrarPedido(NEG, F('FAC'));
  const l = await crearOObtenerAutofactura(NEG, F('FAC'));
  await pool.query(`UPDATE autofacturas SET estado='facturada', factura_id='inv_pub_prueba', uuid='22222222-3333-4444-5555-666666666666',
    emitida_at=now(), fuente_emision='portal' WHERE negocio_id=$1 AND folio=$2`, [NEG, F('FAC')]);
  const r = await api(l.token);
  assert.equal(r.status, 200); assert.equal(r.json.estado, 'facturada');
  assert.deepEqual(Object.keys(r.json).sort(), [...CAMPOS_PUBLICOS].sort());
  assert.ok(!/inv_pub_prueba|22222222-3333|pdf|xml|uuid/i.test(r.texto), 'la fase 2 no expone factura_id/uuid/pdf/xml');
});

await t('10. el negocio y el folio salen del token: los parámetros del navegador se ignoran', async () => {
  await sembrarPedido(NEG_B, F('AJENA'));
  ligaB = await crearOObtenerAutofactura(NEG_B, F('AJENA'));
  const limpio = await api(liga.token);
  const conParametros = await api(liga.token, `?negocio_id=${NEG_B}&negocioId=${NEG_B}&folio=${F('AJENA')}`);
  assert.deepEqual(conParametros.json, limpio.json, 'los query params cambiaron la respuesta');
  const deB = await api(ligaB.token);
  assert.equal(deB.json.negocio.nombre, NOMBRE_B);
  assert.equal(deB.json.negocio.logo_url, null);
  assert.equal(deB.json.folio, F('AJENA'));
  const post = await fetch(`${base}/api/autofactura/${liga.token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ negocio_id: NEG_B, folio: F('AJENA') }) });
  assert.equal(post.status, 404, 'no hay POST público en la fase 2');
});

await t('11. negocio inactivo no expone la venta', async () => {
  await pool.query('UPDATE negocios SET activo=FALSE WHERE id=$1', [NEG_B]);
  try {
    const r = await api(ligaB.token);
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: 'No encontramos esta liga de facturación.' });
  } finally {
    await pool.query('UPDATE negocios SET activo=TRUE WHERE id=$1', [NEG_B]);
  }
  assert.equal((await api(ligaB.token)).status, 200, 'al reactivar vuelve a verse');
});

await t('12. módulo de facturación deshabilitado no expone la venta', async () => {
  await fijarModulo(NEG_B, 'suspendido');
  try {
    const r = await api(ligaB.token);
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: 'No encontramos esta liga de facturación.' });
  } finally {
    await fijarModulo(NEG_B, 'activo');
  }
  await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [NEG_B]);
  try {
    assert.equal((await api(ligaB.token)).status, 404, 'sin fila de módulo tampoco se expone');
  } finally {
    await fijarModulo(NEG_B, 'activo');
  }
});

let html = '';
await t('13. GET /f/<token> sirve autofactura.html sin sesión', async () => {
  const r = await fetch(`${base}/f/${liga.token}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  html = await r.text();
  assert.match(html, /Factura tu consumo/);
  assert.match(html, /location\.pathname/);
  assert.match(html, /\/api\/autofactura\//);
  const inventado = await fetch(`${base}/f/${'B'.repeat(43)}`);
  assert.equal(inventado.status, 200, 'la plantilla es la misma para cualquier token: el servidor no revela nada al servirla');
});

await t('14. el HTML no embebe datos de la venta ni secretos ni datos fiscales', async () => {
  for (const v of [liga.token, F('OK'), NOMBRE_A, NEG, '150.00']) assert.ok(!html.includes(v), `el HTML embebe "${v}"`);
  assert.ok(!/sk_(test|live)|token_hash|token_cifrado|INTEGRATIONS_ENCRYPTION_KEY|DATABASE_URL|api_key/i.test(html));
  assert.ok(!/<form|<input|\bRFC\b|raz[oó]n social|r[eé]gimen|uso de? CFDI/i.test(html), 'la fase 2 no captura datos fiscales');
});

await t('15. E2E en navegador real: la página carga la venta usando solo el token de la URL', async () => {
  const puppeteer = (await import('puppeteer')).default;
  const browser = await puppeteer.launch({ headless: true, protocolTimeout: 20000 });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.setRequestInterception(true);
    page.on('request', (req) => (req.url().startsWith(base) ? req.continue() : req.abort()));
    await page.goto(`${base}/f/${liga.token}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((folio) => document.body.textContent.includes(folio), {}, F('OK'));
    const texto = await page.evaluate(() => document.body.textContent);
    assert.ok(texto.includes(NOMBRE_A));
    assert.ok(texto.includes('$150.00'));
    assert.ok(texto.includes('Tu ticket está disponible para facturación.'));
    assert.ok(!texto.includes(liga.token));

    await page.goto(`${base}/f/${'C'.repeat(43)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.textContent.includes('No encontramos esta liga de facturación.'));
  } finally {
    await browser.close();
  }
});

} finally {
  srv.detener();
  await limpiar();
  for (const n of [NEG, NEG_B]) {
    const p = previo[n];
    await pool.query('UPDATE negocios SET activo=$2 WHERE id=$1', [n, p.activo]);
    if (p.modulo === null) await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [n]);
    else await fijarModulo(n, p.modulo);
    for (const clave of ['nombre', 'logo_url']) {
      if (clave in p.config) await pool.query('UPDATE configuracion SET valor=$3 WHERE negocio_id=$1 AND clave=$2', [n, clave, p.config[clave]]);
      else await pool.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2', [n, clave]);
    }
  }
  await pool.end().catch(() => {});
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`PASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
