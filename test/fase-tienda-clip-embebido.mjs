// ─── Tienda en línea: checkout embebido de Clip y verificación al regresar ──
//
// Fija, por las RUTAS reales y en un navegador real:
//
//   · El checkout embebido REUTILIZA el checkout de /v2/checkout: mismo
//     payment_request_id que la liga redireccionada, misma fila de pagos, y
//     ninguna presentación (abrir, cerrar, fallar, reintentar) crea otro.
//   · Se enciende por negocio (configuracion.tienda_clip_checkout_embebido) y
//     apagado todo queda como antes; encenderlo en A no toca a B.
//   · La verificación al regresar consulta a Clip con las credenciales del
//     negocio dueño, asienta por el camino verificado de siempre (webhook
//     retrasado → pago confirmado, UNA comanda), respeta su tope de frecuencia
//     y no confía en los parámetros de regreso.
//   · Nunca un cobro nuevo mientras el anterior es incierto.
//   · El cliente retoma su pedido pendiente después de cerrar o recargar, y la
//     referencia local se limpia cuando el pedido deja de ser recuperable.
//   · El componente de Clip en un navegador: carga, cierre, fallo (respaldo a
//     la liga de Clip del MISMO checkout), retorno sin pago, móvil y escritorio.
//
// El SDK de Clip que corre en el navegador es el OFICIAL
// (https://sdk.clip.mx/js/v1/checkout.js), descargado al iniciar la suite y
// servido tal cual. Si no hay red, se usa un doble que reproduce su contrato y
// la suite lo AVISA en la salida. El checkout dentro del iframe es falso
// (simula pago.clip.mx): cero Clip real, cero cobros, cero producción.
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import assert from 'assert';
import { randomBytes, randomUUID } from 'crypto';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG = SEED.negocioA;
const NEG_B = SEED.negocioB;
const SLUG = 'clip-emb-a';
const SLUG_B = 'clip-emb-b';
const CAT = 'ClipEmb (test)';
const TEL = '8997300001';
const PUERTO = String(process.env.TEST_PORT_CEM || 4781);
const PUERTO_CLIP = Number(process.env.TEST_PORT_CEM_CLIP || 4782);
// 127.0.0.1 y no localhost: el SDK de Clip rechaza una URL de regreso cuyo
// primer tramo antes de un punto pase de 100 caracteres, y
// http://localhost:PUERTO/seguimiento/<48 hex>… no tiene ningún punto.
const base = `http://127.0.0.1:${PUERTO}`;
const token = () => randomBytes(24).toString('hex');
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
async function esperarHasta(fn, { timeoutMs = 12000, intervaloMs = 150 } = {}) {
  const lim = Date.now() + timeoutMs;
  for (;;) { const r = await fn(); if (r) return r; if (Date.now() > lim) return null; await esperar(intervaloMs); }
}
const CAPTURAS = process.env.CEM_CAPTURAS || null;
if (CAPTURAS) mkdirSync(CAPTURAS, { recursive: true });

process.env.CLIP_API_BASE_URL = `http://127.0.0.1:${PUERTO_CLIP}`;
process.env.XABOR_URL_PUBLICA = base;

// ── Credenciales de prueba por negocio (jamás reales) ───────────────────────
const CRED = {
  A: { apiKey: 'emb-a-key-no-real', apiSecret: 'emb-a-secret-no-real' },
  B: { apiKey: 'emb-b-key-no-real', apiSecret: 'emb-b-secret-no-real' },
};
const authDe = c => 'Basic ' + Buffer.from(`${c.apiKey}:${c.apiSecret}`).toString('base64');
const AUTH = { A: authDe(CRED.A), B: authDe(CRED.B) };

// ── Mock de Clip v2: cada checkout pertenece a la cuenta que lo creó ─────────
const CHECKOUTS = new Map();   // id → { referencia, estado, monto, expiresAt, auth, redirection }
const LLAMADAS = [];           // { metodo: 'POST'|'GET', id, auth }
const CLIP = { caido: false, lentoMs: 0 };
// Checkouts cuya consulta Clip "acepta y nunca contesta": la conexión queda
// abierta, sin cabeceras ni error HTTP (hallazgo P1 de la revisión de Codex).
const COLGADOS = new Set();
const RETENIDAS = new Set();
const soltarColgados = () => { for (const res of RETENIDAS) { try { res.destroy(); } catch { /* ya cerrada */ } } };
const postsClip = () => LLAMADAS.filter(l => l.metodo === 'POST').length;
const getsClip = (id) => LLAMADAS.filter(l => l.metodo === 'GET' && (!id || l.id === id));
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => { cuerpo += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    const auth = req.headers.authorization || '';
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const body = JSON.parse(cuerpo || '{}');
      const id = randomUUID();
      LLAMADAS.push({ metodo: 'POST', id, auth, body });
      const expiresAt = body.expires_at
        ? new Date(Date.parse(body.expires_at)).toISOString()
        : new Date(Date.now() + 3 * 24 * 3600e3).toISOString();
      CHECKOUTS.set(id, {
        referencia: body.metadata?.external_reference || null, estado: 'PENDING',
        monto: Number(body.amount), expiresAt, auth, redirection: body.redirection_url,
      });
      res.end(JSON.stringify({
        payment_request_id: id, object_type: 'payment_link', status: 'CHECKOUT_CREATED',
        payment_request_url: `https://completa-tu-pago.payclip.com/${id}`,
        created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), expires_at: expiresAt,
      }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v2/checkout/')) {
      const id = decodeURIComponent(req.url.split('/').pop());
      LLAMADAS.push({ metodo: 'GET', id, auth });
      if (CLIP.caido) { res.statusCode = 503; res.end('{}'); return; }
      if (COLGADOS.has(id)) {
        RETENIDAS.add(res);
        res.on('close', () => RETENIDAS.delete(res));
        return;                                  // ni cabeceras, ni cuerpo, ni cierre
      }
      if (CLIP.lentoMs) { setTimeout(() => responderGet(res, id, auth), CLIP.lentoMs); return; }
      responderGet(res, id, auth);
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
});
function responderGet(res, id, auth) {
  const c = CHECKOUTS.get(id);
  // Como en Clip: un checkout solo existe para la cuenta que lo creó.
  if (!c || c.auth !== auth) { res.statusCode = 404; res.end('{}'); return; }
  const status = c.estado === 'COMPLETED' ? 'CHECKOUT_COMPLETED'
    : c.estado === 'EXPIRED' ? 'CHECKOUT_EXPIRED' : 'CHECKOUT_PENDING';
  const g = {
    object_type: 'payment_link', payment_request_id: id, status,
    amount: c.monto ?? null, currency: 'MXN',
    metadata: { external_reference: c.referencia, customer_info: {} },
    payment_request_url: `https://completa-tu-pago.payclip.com/${id}`,
    created_at: '2026-10-18T00:00:00Z', expires_at: c.expiresAt || null, last_status_message: status,
  };
  if (c.estado === 'EXPIRED') g.expired_at = c.expiresAt || null;
  res.end(JSON.stringify(g));
}
await new Promise(r => clipMock.listen(PUERTO_CLIP, '127.0.0.1', r));

// ── Helpers de rutas públicas ───────────────────────────────────────────────
const json = async r => ({ status: r.status, body: await r.json().catch(() => ({})), headers: r.headers });
const comprar = (slug, cuerpo) => fetch(`${base}/api/tienda/${slug}/checkout`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
}).then(json);
const rutaPago = tk => `${base}/api/tienda/seguimiento/${encodeURIComponent(tk)}/pago`;
const postPago = tk => fetch(rutaPago(tk), { method: 'POST' }).then(json);
const getPago = tk => fetch(rutaPago(tk)).then(json);
const verificar = tk => fetch(rutaPago(tk) + '/verificar', { method: 'POST' }).then(json);
const getPagar = tk => fetch(`${base}/pagar/${tk}`, { redirect: 'manual' })
  .then(async r => ({ status: r.status, location: r.headers.get('location'), headers: r.headers, html: await r.text() }));

const PRODUCTO = {};
const carrito = (letra, tk) => ({
  checkoutToken: tk, items: [{ productoId: PRODUCTO[letra], cantidad: 1 }],
  modalidad: 'recoger', cliente: { nombre: 'Cliente embebido', telefono: TEL }, metodoPago: 'enlace_pago',
});
async function pedidoDe(folio, negocio = NEG) {
  const { rows: [r] } = await pool.query(
    `SELECT estado, datos FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, negocio]);
  return r || null;
}
async function pagosDe(folio, negocio = NEG) {
  const { rows } = await pool.query(
    `SELECT * FROM pagos WHERE negocio_id = $1 AND pedido_folio = $2 ORDER BY created_at`, [negocio, folio]);
  return rows;
}
async function comandasDe(folio) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM impresion_trabajos
      WHERE negocio_id = $1 AND origen_tipo = 'pedido' AND origen_id = $2`, [NEG, folio]);
  return r.n;
}
async function bandera(negocio, valor) {
  if (valor === null) {
    await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'tienda_clip_checkout_embebido'`, [negocio]);
    return;
  }
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'tienda_clip_checkout_embebido',$2)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`, [negocio, valor]);
}

// Un pedido de la tienda A (o B) ya con su checkout creado.
async function pedidoConCheckout(letra = 'A') {
  const slug = letra === 'A' ? SLUG : SLUG_B;
  const negocio = letra === 'A' ? NEG : NEG_B;
  const tk = token();
  const r = await comprar(slug, carrito(letra, tk));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const p = await postPago(r.body.trackingToken);
  assert.strictEqual(p.status, 200, JSON.stringify(p.body));
  const [fila] = await pagosDe(r.body.folio, negocio);
  assert.ok(fila?.referencia_externa, 'no se creó el checkout');
  return { folio: r.body.folio, tracking: r.body.trackingToken, fila, pago: p.body };
}

// ── Fixture (mismo patrón que fase-tienda-pago-online-ui) ───────────────────
async function limpiar() {
  for (const n of [NEG, NEG_B]) {
    await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'pagos'`, [n]).catch(() => {});
    await pool.query(`DELETE FROM pagos WHERE negocio_id = $1`, [n]).catch(() => {});
    await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave IN
      ('tienda_metodos_pago','tienda_clip_checkout_embebido','tienda_pago_verificar_al_regresar')`, [n]).catch(() => {});
    await pool.query(`DELETE FROM tienda_pedidos WHERE negocio_id = $1`, [n]);
    await pool.query(`DELETE FROM compras_reales WHERE negocio_id = $1 AND cliente_telefono = $2`, [n, TEL]).catch(() => {});
    await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'canal' = 'tienda_online'`, [n]);
    await pool.query(`DELETE FROM tienda_productos WHERE negocio_id = $1`, [n]);
    await pool.query(`DELETE FROM tienda_config WHERE negocio_id = $1`, [n]);
    await pool.query(
      `DELETE FROM menu_productos WHERE categoria_id IN
        (SELECT id FROM menu_categorias WHERE negocio_id = $1 AND nombre = $2)`, [n, CAT]);
    await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre = $2`, [n, CAT]);
  }
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM impresoras WHERE negocio_id = $1`, [NEG]).catch(() => {});
  await pool.query(
    `DELETE FROM terminales WHERE sucursal_id IN (SELECT id FROM sucursales WHERE negocio_id = $1)`, [NEG]).catch(() => {});
}

async function montarImpresion() {
  const { crearEdge } = await import('../src/services/edgeService.js');
  const { crearImpresora, crearRuta } = await import('../src/services/impresionService.js');
  const { DESTINOS } = await import('../src/services/impresionSelfService.js');
  await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [NEG]);
  const term = await crearEdge(NEG, { nombre: 'PC CLIP EMB' });
  const imp = await crearImpresora(NEG, {
    terminalId: term.id, nombre: 'Impresora clip emb', transporte: 'windows_spooler',
    anchoColumnas: 42, config: { spoolerNombre: 'Impresora clip emb' },
  });
  await crearRuta(NEG, { impresoraId: imp.id, ambito: 'documento', clave: DESTINOS.cocina.clave });
}

async function prepararNegocio(negocio, letra, slug, titular) {
  for (const m of ['tienda_online', 'pos', 'menu']) {
    await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
      ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [negocio, m]);
  }
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,976) RETURNING id`, [negocio, CAT]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
     VALUES ($1,$2,'Chilaquiles de prueba',300,TRUE,1) RETURNING id`, [negocio, cat.id]);
  PRODUCTO[letra] = p.id;
  await pool.query(`INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)`, [negocio, p.id]);
  const reglas = {
    horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
      .map(d => [d, { abierto: true, apertura: '00:00', cierre: '23:59' }])),
    pedidos: { costo_envio: 0, pedido_minimo_entrega: 0, tiempo_preparacion_minutos: 10 },
  };
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'reglas_atencion',$2)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`, [negocio, JSON.stringify(reglas)]);
  await pool.query(`UPDATE metodos_pago SET habilitado = FALSE WHERE negocio_id = $1`, [negocio]);
  await pool.query(
    `INSERT INTO metodos_pago (negocio_id, tipo, habilitado) VALUES ($1,'enlace_pago',TRUE)
     ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [negocio]);
  await pool.query(
    `INSERT INTO tienda_config (negocio_id, estado, slug_publico, titular, modalidades)
     VALUES ($1,'publicada',$2,$3,$4)
     ON CONFLICT (negocio_id) DO UPDATE SET estado='publicada', slug_publico=$2, titular=$3, modalidades=$4`,
    [negocio, slug, titular, JSON.stringify(['recoger'])]);
  const { guardarIntegracionPago, marcarProveedorPrincipal } = await import('../src/services/integracionesService.js');
  await guardarIntegracionPago(negocio, 'clip', CRED[letra], { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(negocio, 'clip', SEED.superadminUsuarioId);
}

// ── SDK de Clip para el navegador ───────────────────────────────────────────
const SDK_URL = 'https://sdk.clip.mx/js/v1/checkout.js';
// Doble MÍNIMO con el mismo contrato que el SDK v1 (solo si no hay red).
const SDK_DOBLE = `document.addEventListener('DOMContentLoaded',()=>{
  const id=document.getElementById('checkoutClipPlugin').getAttribute('payment_request_id');
  const b=document.body.querySelector('.clipCheckoutButton');b.innerHTML='Pagar';
  const m=document.createElement('div');m.id='clipCheckout';
  m.innerHTML='<div id="clipCheckoutIframe"><span id="clipChecoutClose" tabindex="0"></span><iframe src="https://pago.clip.mx/v3/'+id+'"></iframe></div>';
  let red=null;
  b.addEventListener('click',()=>{document.body.appendChild(m);document.getElementById('clipChecoutClose').onclick=()=>{m.remove();if(red)location.href=red;};});
  window.addEventListener('message',e=>{if(typeof e.data==='string'&&/^https?:/.test(e.data)&&!red){red=e.data;setTimeout(()=>{m.remove();location.href=red;},3000);}});
});`;
let SDK = { cuerpo: SDK_DOBLE, real: false };
try {
  const r = await fetch(SDK_URL, { signal: AbortSignal.timeout(15000) });
  if (r.ok) SDK = { cuerpo: await r.text(), real: true };
} catch { /* sin red: doble */ }
console.log(SDK.real
  ? `[SDK] Se usa el SDK OFICIAL de Clip (${SDK.cuerpo.length} bytes, descargado de ${SDK_URL})`
  : '[SDK] AVISO: no se pudo descargar el SDK de Clip; los casos de navegador usan un DOBLE con su contrato');

// Checkout falso servido en https://pago.clip.mx/v3/<id> (el iframe del SDK).
function checkoutFalso(id) {
  const c = CHECKOUTS.get(id);
  if (!c) return '<!doctype html><title>404</title><p>No existe</p>';
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body style="font-family:sans-serif;padding:20px">
<h2>Checkout de prueba</h2><p id="ck">${id}</p><p>Monto: ${c.monto}</p>
<button id="pagar">Pagar</button> <button id="rechazar">Rechazar</button>
<script>
document.getElementById('pagar').onclick = async () => {
  await fetch('/v3/${id}/__pagar', { method: 'POST' });
  parent.postMessage(${JSON.stringify(c.redirection?.success || '')}, '*');
};
document.getElementById('rechazar').onclick = () => parent.postMessage(${JSON.stringify(c.redirection?.error || '')}, '*');
</script></body></html>`;
}

let puppeteer = null;
try { puppeteer = (await import('puppeteer')).default; } catch { /* abajo */ }

async function pestana(nav, { ancho = 390, alto = 800, bloquearSdk = false } = {}) {
  const ctx = await nav.createBrowserContext();
  const pagina = await ctx.newPage();
  await pagina.setViewport({ width: ancho, height: alto });
  const registro = { errores: [], navegaciones: [], externos: [] };
  pagina.on('pageerror', e => registro.errores.push(e.message));
  await pagina.setRequestInterception(true);
  pagina.on('request', r => {
    const u = r.url();
    if (u.startsWith(base)) return r.continue();
    if (u.startsWith(SDK_URL)) {
      registro.externos.push(u);
      if (bloquearSdk) return r.abort();
      return r.respond({ status: 200, contentType: 'application/javascript',
        headers: { 'Access-Control-Allow-Origin': '*' }, body: SDK.cuerpo });
    }
    const mPagar = u.match(/^https:\/\/pago\.clip\.mx\/v3\/([A-Za-z0-9-]+)\/__pagar$/);
    if (mPagar) {
      const c = CHECKOUTS.get(mPagar[1]);
      if (c) c.estado = 'COMPLETED';
      return r.respond({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    const mCk = u.match(/^https:\/\/pago\.clip\.mx\/v3\/([A-Za-z0-9-]+)$/);
    if (mCk) {
      registro.externos.push(u);
      return r.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: checkoutFalso(mCk[1]) });
    }
    if (u.startsWith('https://banco-prueba.example/')) {
      return r.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><p>Banco (prueba)</p>' });
    }
    if (u.startsWith('https://completa-tu-pago.payclip.com/')) {
      registro.navegaciones.push(u);
      return r.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><p>Página de Clip (prueba)</p>' });
    }
    registro.externos.push(u);
    return r.abort();
  });
  return { ctx, pagina, registro };
}
// En UNA sola evaluación: el seguimiento se repinta cuando termina la
// verificación con Clip, y buscar el nodo y leerlo en dos viajes podía leer un
// botón ya reemplazado.
const textoDe = (pagina, sel) => pagina.evaluate(s => document.querySelector(s)?.textContent.trim() ?? null, sel).catch(() => null);
const visible = (pagina, sel) => pagina.evaluate(s => {
  const e = document.querySelector(s);
  return !!e && !e.hidden && e.offsetParent !== null;
}, sel).catch(() => false);
async function captura(pagina, nombre) {
  if (CAPTURAS) await pagina.screenshot({ path: join(CAPTURAS, `${nombre}.png`), fullPage: false }).catch(() => {});
}
const clic = (pagina, sel) => pagina.$eval(sel, e => e.click());
// La ventana de Clip terminó de aparecer (el SDK la funde en 300 ms) y es lo
// que el cliente tiene ENCIMA: en el centro de la pantalla está su iframe.
async function ventanaClipEncima(pagina) {
  await pagina.waitForFunction(() => getComputedStyle(document.getElementById('clipCheckout')).opacity === '1', { timeout: 5000 });
  return pagina.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return !!el && el.tagName === 'IFRAME' && !!el.closest('#clipCheckout');
  });
}

let srv = null;
let nav = null;
try {
  await limpiar();
  await prepararNegocio(NEG, 'A', SLUG, 'Mapolato Prueba A');
  await prepararNegocio(NEG_B, 'B', SLUG_B, 'Mapolato Prueba B');
  await montarImpresion();
  srv = await arrancarServidor({
    PORT: PUERTO, XABOR_TIENDA_LIMITE_CHECKOUT: '500', XABOR_TIENDA_LIMITE_LECTURA: '500',
    XABOR_TIENDA_VERIFICACION_INTERVALO_MS: '2500',
    // Tiempo límite de cada consulta a Clip desde la tienda (P1). En
    // producción vale el valor por omisión; aquí se acorta para no esperar.
    XABOR_TIENDA_CLIP_TIMEOUT_MS: '2000',
  }, { timeoutMs: 90000 });

  // ═══ A. Bandera por negocio: apagada, todo como antes ═══════════════════
  await t('A1. bandera APAGADA: POST pago da la liga de Clip y embebido=null; /pagar manda al seguimiento', async () => {
    await bandera(NEG, null);
    const fx = await pedidoConCheckout('A');
    assert.ok(fx.pago.url?.startsWith('https://completa-tu-pago.payclip.com/'), `url: ${fx.pago.url}`);
    assert.strictEqual(fx.pago.embebido, null, `embebido con la bandera apagada: ${JSON.stringify(fx.pago.embebido)}`);
    assert.strictEqual(fx.pago.proveedorNombre, 'Clip');
    assert.strictEqual(fx.pago.total, 300);
    const g = await getPagar(fx.tracking);
    assert.strictEqual(g.status, 302);
    assert.strictEqual(g.location, `/seguimiento/${fx.tracking}`);
  });

  await t('A2. métodos de la tienda: nombran a Clip y dicen si se paga aquí mismo o en su página', async () => {
    await bandera(NEG, null);
    let m = await fetch(`${base}/api/tienda/${SLUG}/pagos?modalidad=recoger`).then(x => x.json());
    assert.deepStrictEqual(m.metodos.map(x => [x.id, x.proveedor, x.proveedorNombre]), [['enlace_pago', 'clip', 'Clip']]);
    assert.match(m.metodos[0].detalle, /página segura de Clip/);
    await bandera(NEG, 'true');
    m = await fetch(`${base}/api/tienda/${SLUG}/pagos?modalidad=recoger`).then(x => x.json());
    assert.match(m.metodos[0].detalle, /Pagas aquí mismo · Pago procesado por Clip/);
    // Un valor que no es exactamente 'true' NO enciende nada.
    await bandera(NEG, 'si');
    m = await fetch(`${base}/api/tienda/${SLUG}/pagos?modalidad=recoger`).then(x => x.json());
    assert.match(m.metodos[0].detalle, /página segura de Clip/);
  });

  // ═══ B. Embebido encendido: el MISMO checkout ═══════════════════════════
  await t('B1. bandera ENCENDIDA: POST pago ofrece /pagar/<token> y la liga de respaldo es del MISMO checkout', async () => {
    await bandera(NEG, 'true');
    const antes = postsClip();
    const fx = await pedidoConCheckout('A');
    assert.strictEqual(postsClip(), antes + 1, 'se esperaba exactamente un checkout');
    assert.deepStrictEqual(fx.pago.embebido, { pagina: `/pagar/${fx.tracking}` });
    assert.strictEqual(fx.pago.url, `https://completa-tu-pago.payclip.com/${fx.fila.referencia_externa}`,
      'la liga de respaldo no es la del checkout de la fila');
    // Repetir el POST (doble toque, reintento, respaldo) no crea nada.
    const otra = await postPago(fx.tracking);
    assert.strictEqual(otra.body.url, fx.pago.url);
    assert.deepStrictEqual(otra.body.embebido, fx.pago.embebido);
    assert.strictEqual(postsClip(), antes + 1, 'el segundo POST creó otro checkout');
    assert.strictEqual((await pagosDe(fx.folio)).length, 1);
  });

  let FX = null;
  await t('B2. GET /pagar escribe el payment_request_id del checkout vigente en el componente OFICIAL de Clip', async () => {
    await bandera(NEG, 'true');
    FX = await pedidoConCheckout('A');
    const g = await getPagar(FX.tracking);
    assert.strictEqual(g.status, 200, `status ${g.status} location ${g.location}`);
    assert.ok(g.html.includes(`payment_request_id="${FX.fila.referencia_externa}"`), 'el id del checkout no está en la página');
    assert.ok(g.html.includes('src="https://sdk.clip.mx/js/v1/checkout.js"'), 'no carga el SDK oficial');
    assert.ok(g.html.includes('id="checkoutClipPlugin"') && g.html.includes('class="clipCheckoutButton"'),
      'faltan las piezas que el SDK busca (script#checkoutClipPlugin y .clipCheckoutButton)');
    assert.ok(!g.html.includes('__XABOR_CLIP_PAYMENT_REQUEST_ID__'), 'quedó el marcador sin sustituir');
    // El filtro de mensajes tiene que registrarse ANTES de que cargue el SDK.
    assert.ok(g.html.indexOf('stopImmediatePropagation') < g.html.indexOf('id="checkoutClipPlugin"'),
      'el filtro de mensajes quedó después del SDK');
    assert.strictEqual(g.headers.get('cache-control'), 'no-store');
    assert.strictEqual(g.headers.get('x-frame-options'), 'DENY');
    assert.match(g.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    assert.strictEqual(g.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  });

  await t('B3. GET /pagar no crea nada: cinco lecturas, cero POST a Clip, cero filas nuevas', async () => {
    const antes = postsClip();
    for (let i = 0; i < 5; i++) assert.strictEqual((await getPagar(FX.tracking)).status, 200);
    assert.strictEqual(postsClip(), antes);
    assert.strictEqual((await pagosDe(FX.folio)).length, 1);
  });

  await t('B4. sin checkout todavía, con token inválido o inexistente: /pagar no crea y no revela nada', async () => {
    await bandera(NEG, 'true');
    const r = await comprar(SLUG, carrito('A', token()));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const antes = postsClip();
    const g = await getPagar(r.body.trackingToken);
    assert.strictEqual(g.status, 302);
    assert.strictEqual(g.location, `/seguimiento/${r.body.trackingToken}`);
    assert.strictEqual(postsClip(), antes, 'GET /pagar creó un checkout');
    assert.strictEqual((await getPagar('zzz')).status, 404);
    assert.strictEqual((await getPagar(token())).status, 404);
  });

  await t('B5. un id de checkout que podría romper el HTML jamás se escribe: manda al seguimiento', async () => {
    await bandera(NEG, 'true');
    const fx = await pedidoConCheckout('A');
    const original = fx.fila.referencia_externa;
    await pool.query(`UPDATE pagos SET referencia_externa = $2 WHERE id = $1`, [fx.fila.id, `x"><script>alert(1)</script>`]);
    try {
      const g = await getPagar(fx.tracking);
      assert.strictEqual(g.status, 302);
      assert.ok(!g.html.includes('<script>alert'), 'el id malicioso llegó al HTML');
      const p = await postPago(fx.tracking);
      assert.strictEqual(p.body.embebido, null, 'se ofreció embebido con un id inválido');
    } finally {
      await pool.query(`UPDATE pagos SET referencia_externa = $2 WHERE id = $1`, [fx.fila.id, original]);
    }
  });

  await t('B6. checkout de otra versión del pedido o a punto de vencer: no se embebe (el cliente sigue por el camino de siempre)', async () => {
    await bandera(NEG, 'true');
    const fx = await pedidoConCheckout('A');
    await pool.query(`UPDATE pagos SET xabor_espera_hasta = NOW() + interval '20 seconds' WHERE id = $1`, [fx.fila.id]);
    assert.strictEqual((await getPagar(fx.tracking)).status, 302, 'se embebió un checkout a segundos de vencer');
    await pool.query(`UPDATE pagos SET xabor_espera_hasta = NOW() + interval '20 minutes', version_pedido_hash = 'otra-version' WHERE id = $1`, [fx.fila.id]);
    assert.strictEqual((await getPagar(fx.tracking)).status, 302, 'se embebió un checkout de otra versión');
  });

  // ═══ C. Verificación al regresar: webhook retrasado ═════════════════════
  await t('C1. retorno sin pago: Clip dice PENDIENTE → sigue esperando, cero asiento, cero comanda', async () => {
    const fx = await pedidoConCheckout('A');
    const v = await verificar(fx.tracking);
    assert.strictEqual(v.status, 200, JSON.stringify(v.body));
    assert.strictEqual(v.body.consulta, 'pendiente');
    assert.strictEqual(v.body.esperandoPago, true);
    assert.strictEqual(v.body.pagoEstado, 'pendiente');
    assert.strictEqual(getsClip(fx.fila.referencia_externa).at(-1)?.auth, AUTH.A, 'no consultó con las credenciales de A');
    assert.strictEqual((await pedidoDe(fx.folio)).estado, 'pendiente_pago');
    await esperar(500);
    assert.strictEqual(await comandasDe(fx.folio), 0, 'salió comanda sin pago');
  });

  await t('C2. tope de frecuencia: una segunda verificación inmediata NO vuelve a consultar a Clip; pasado el intervalo, sí', async () => {
    const fx = await pedidoConCheckout('A');
    await verificar(fx.tracking);
    const n = getsClip(fx.fila.referencia_externa).length;
    const v2 = await verificar(fx.tracking);
    assert.strictEqual(v2.body.consulta, 'omitida');
    assert.strictEqual(getsClip(fx.fila.referencia_externa).length, n, 'consultó a Clip dentro del intervalo');
    await esperar(2700);
    const v3 = await verificar(fx.tracking);
    assert.strictEqual(v3.body.consulta, 'pendiente');
    assert.strictEqual(getsClip(fx.fila.referencia_externa).length, n + 1);
  });

  await t('C3. webhook RETRASADO: el cliente pagó, el aviso no llegó; al regresar se consulta a Clip y queda pagado con UNA comanda', async () => {
    const fx = await pedidoConCheckout('A');
    CHECKOUTS.get(fx.fila.referencia_externa).estado = 'COMPLETED';     // pagó; nadie avisó
    const g = await getPago(fx.tracking);
    assert.strictEqual(g.body.esperandoPago, true, 'el GET de solo lectura no debe asentar nada');
    const v = await verificar(fx.tracking);
    assert.strictEqual(v.body.consulta, 'pagado', JSON.stringify(v.body));
    assert.strictEqual(v.body.esperandoPago, false);
    assert.strictEqual(v.body.pagoEstado, 'pagado');
    assert.notStrictEqual((await pedidoDe(fx.folio)).estado, 'pendiente_pago');
    const n = await esperarHasta(async () => (await comandasDe(fx.folio)) >= 1 ? await comandasDe(fx.folio) : null);
    assert.strictEqual(n, 1, `comandas: ${n}`);
    // El webhook tardío llega después: no repite nada.
    const w = await fetch(`${base}/webhook/clip`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: fx.fila.referencia_externa, origin: 'checkout-api', event_type: 'UPDATE' }) });
    assert.strictEqual(w.status, 200);
    await esperar(700);
    assert.strictEqual(await comandasDe(fx.folio), 1, 'el webhook tardío duplicó la comanda');
    assert.strictEqual((await pagosDe(fx.folio)).filter(p => p.estado === 'pagado').length, 1);
  });

  await t('C4. cinco verificaciones simultáneas con dinero real: UNA consulta a Clip, un asiento, una emisión, una comanda', async () => {
    const fx = await pedidoConCheckout('A');
    CHECKOUTS.get(fx.fila.referencia_externa).estado = 'COMPLETED';
    // Clip lento: las cinco caen DURANTE la consulta en vuelo de la primera,
    // que es justo lo que la coalescencia y el tope deben absorber.
    CLIP.lentoMs = 600;
    let rs;
    try {
      rs = await Promise.all(Array.from({ length: 5 }, (_, i) => esperar(i * 60).then(() => verificar(fx.tracking))));
    } finally { CLIP.lentoMs = 0; }
    for (const r of rs) assert.strictEqual(r.status, 200);
    assert.ok(rs.some(r => r.body.consulta === 'pagado'), JSON.stringify(rs.map(r => r.body.consulta)));
    await esperar(800);
    const { rows: [em] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pedido_emisiones WHERE negocio_id = $1 AND folio = $2`, [NEG, fx.folio]);
    assert.strictEqual(em.n, 1, `emisiones: ${em.n}`);
    assert.strictEqual(await comandasDe(fx.folio), 1);
    assert.strictEqual(getsClip(fx.fila.referencia_externa).length, 1, 'las simultáneas consultaron a Clip más de una vez');
  });

  await t('C5. Clip sin respuesta: consulta sin_respuesta, nada cambia', async () => {
    const fx = await pedidoConCheckout('A');
    CLIP.caido = true;
    try {
      const v = await verificar(fx.tracking);
      assert.strictEqual(v.body.consulta, 'sin_respuesta');
      assert.strictEqual(v.body.esperandoPago, true);
      assert.strictEqual((await pagosDe(fx.folio))[0].estado, 'pendiente');
    } finally { CLIP.caido = false; }
  });

  await t('C6. Clip confirma que el checkout VENCIÓ: la fila vence con evidencia terminal y no sale comanda', async () => {
    const fx = await pedidoConCheckout('A');
    CHECKOUTS.get(fx.fila.referencia_externa).estado = 'EXPIRED';
    const v = await verificar(fx.tracking);
    assert.strictEqual(v.body.consulta, 'vencido', JSON.stringify(v.body));
    const [fila] = await pagosDe(fx.folio);
    assert.strictEqual(fila.estado, 'vencido');
    assert.strictEqual(fila.metadata_sanitizada?.provider_terminal_status, 'CHECKOUT_EXPIRED');
    assert.strictEqual(await comandasDe(fx.folio), 0);
  });

  await t('C7. los parámetros de regreso no autorizan nada: verificar no recibe ni usa `r`, y la bandera la apaga por negocio', async () => {
    const fx = await pedidoConCheckout('A');
    // Aunque el navegador "diga" éxito, sin dinero en Clip no hay pago.
    const v = await fetch(rutaPago(fx.tracking) + '/verificar?r=exito&retorno=pago', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ r: 'exito', pagado: true }),
    }).then(json);
    assert.strictEqual(v.body.consulta, 'pendiente');
    assert.strictEqual(v.body.esperandoPago, true);
    await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'tienda_pago_verificar_al_regresar','false')
      ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = 'false'`, [NEG]);
    try {
      await esperar(2700);
      const n = getsClip(fx.fila.referencia_externa).length;
      const v2 = await verificar(fx.tracking);
      assert.strictEqual(v2.body.consulta, 'desactivada');
      assert.strictEqual(getsClip(fx.fila.referencia_externa).length, n, 'consultó a Clip con la verificación apagada');
    } finally {
      await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'tienda_pago_verificar_al_regresar'`, [NEG]);
    }
  });

  // ═══ D. Ningún cobro nuevo sobre uno incierto ═══════════════════════════
  await t('D1. si pagosService fuera a abrir OTRO checkout y Clip no contesta por el anterior: no se abre nada', async () => {
    const fx = await pedidoConCheckout('A');
    // El pedido cambió (otra versión): pagosService invalidaría el checkout
    // vigente y crearía uno nuevo. El anterior sigue abierto en Clip.
    await pool.query(`UPDATE pedidos_activos SET datos = jsonb_set(datos, '{total}', '310'::jsonb) WHERE folio = $1 AND negocio_id = $2`, [fx.folio, NEG]);
    const antes = postsClip();
    CLIP.caido = true;
    try {
      const p = await postPago(fx.tracking);
      assert.strictEqual(p.status, 200, JSON.stringify(p.body));
      assert.strictEqual(p.body.url, null, 'se ofreció un cobro nuevo con el anterior incierto');
      assert.strictEqual(p.body.verificando, true);
      assert.strictEqual(postsClip(), antes, 'se mandó un POST de creación a Clip');
    } finally { CLIP.caido = false; }
    // Con Clip de vuelta y el anterior SIN pagar, sigue el comportamiento de
    // siempre: el anterior se invalida y nace uno para la versión nueva.
    await esperar(50);
    const p2 = await postPago(fx.tracking);
    assert.ok(p2.body.url, JSON.stringify(p2.body));
    assert.strictEqual(postsClip(), antes + 1);
  });

  await t('D2. si el checkout anterior SÍ cobró (vencido en Xabor, pagado en Clip): no se abre otro ni se ofrece pagar; el dinero queda asentado para revisión', async () => {
    const fx = await pedidoConCheckout('A');
    CHECKOUTS.get(fx.fila.referencia_externa).estado = 'COMPLETED';
    await pool.query(`UPDATE pagos SET estado = 'vencido' WHERE id = $1`, [fx.fila.id]);
    const antes = postsClip();
    const p = await postPago(fx.tracking);
    assert.strictEqual(p.status, 200, JSON.stringify(p.body));
    assert.strictEqual(p.body.url, null, 'se ofreció pagar con dinero ya cobrado');
    assert.strictEqual(postsClip(), antes, 'se creó otro checkout sobre un pago real');
    // Cobro TARDÍO (la espera de Xabor ya había vencido): el dinero se asienta
    // y el pedido NO sale a cocina por sí solo: lo revisa una persona.
    const [fila] = await pagosDe(fx.folio);
    assert.strictEqual(fila.estado, 'pagado');
    assert.strictEqual(fila.metadata_sanitizada?.anomalia, 'pago_tardio');
    assert.strictEqual(await comandasDe(fx.folio), 0, 'un cobro tardío liberó cocina');
    // Repetir no cambia nada: ni otro checkout ni la liga del ya cobrado.
    const p2 = await postPago(fx.tracking);
    assert.strictEqual(p2.body.url, null, `segundo POST: ${JSON.stringify(p2.body)}`);
    assert.strictEqual(p2.body.verificando, true);
    assert.strictEqual(postsClip(), antes);
    assert.strictEqual((await pagosDe(fx.folio)).length, 1);
  });

  await t('D3. con el dinero asentado y el pedido aún sin liberar, el POST de pago no devuelve la liga del checkout ya cobrado', async () => {
    const fx = await pedidoConCheckout('A');
    // Ventana real: el dinero entró al ledger y la derivación no ha corrido.
    await pool.query(`UPDATE pagos SET estado = 'pagado', paid_at = NOW() WHERE id = $1`, [fx.fila.id]);
    const p = await postPago(fx.tracking);
    assert.strictEqual(p.body.estado, 'pendiente_pago');
    assert.strictEqual(p.body.url, null, `se ofreció la liga de un checkout cobrado: ${p.body.url}`);
    assert.strictEqual(p.body.embebido, undefined);
    assert.strictEqual(p.body.verificando, true);
  });

  // ═══ E. Separación entre negocios ═══════════════════════════════════════
  await t('E1. la bandera de A no enciende a B: B sigue con la liga redireccionada y /pagar lo manda a su seguimiento', async () => {
    await bandera(NEG, 'true');
    await bandera(NEG_B, null);
    const fb = await pedidoConCheckout('B');
    assert.strictEqual(fb.pago.embebido, null);
    assert.strictEqual(LLAMADAS.find(l => l.metodo === 'POST' && l.id === fb.fila.referencia_externa)?.auth, AUTH.B,
      'el checkout de B no se creó con las credenciales de B');
    const g = await getPagar(fb.tracking);
    assert.strictEqual(g.status, 302);
    assert.strictEqual(g.location, `/seguimiento/${fb.tracking}`);
  });

  await t('E2. verificar un pedido de B consulta SOLO con las credenciales de B', async () => {
    const fb = await pedidoConCheckout('B');
    const v = await verificar(fb.tracking);
    assert.strictEqual(v.body.consulta, 'pendiente');
    const gets = getsClip(fb.fila.referencia_externa);
    assert.ok(gets.length >= 1);
    assert.ok(gets.every(l => l.auth === AUTH.B), 'el checkout de B se consultó con otra cuenta');
  });

  await t('E3. un token de B que apunte a un folio de A no verifica, no cobra ni revela nada de A', async () => {
    const fa = await pedidoConCheckout('A');
    const forjado = token();
    await pool.query(
      `INSERT INTO tienda_pedidos (negocio_id, checkout_token, tracking_token, estado, pedido_folio)
       VALUES ($1,$2,$3,'creado',$4)`, [NEG_B, token(), forjado, fa.folio]);
    const n = getsClip(fa.fila.referencia_externa).length;
    CHECKOUTS.get(fa.fila.referencia_externa).estado = 'COMPLETED';
    try {
      const v = await verificar(forjado);
      if (v.status === 200) {
        assert.notStrictEqual(v.body.consulta, 'pagado');
        assert.notStrictEqual(v.body.pagoEstado, 'pagado');
      }
      assert.strictEqual(getsClip(fa.fila.referencia_externa).length, n, 'el token de B consultó el checkout de A');
      assert.strictEqual((await pagosDe(fa.folio))[0].estado, 'pendiente', 'el token de B asentó el pago de A');
      const g = await getPagar(forjado);
      assert.ok(!g.html.includes(fa.fila.referencia_externa), 'el token de B vio el checkout de A');
    } finally {
      CHECKOUTS.get(fa.fila.referencia_externa).estado = 'PENDING';
    }
  });

  await t('E4. con la bandera encendida en los DOS, cada /pagar muestra solo el checkout de su negocio', async () => {
    await bandera(NEG, 'true');
    await bandera(NEG_B, 'true');
    try {
      const fa = await pedidoConCheckout('A');
      const fb = await pedidoConCheckout('B');
      const ga = await getPagar(fa.tracking);
      const gb = await getPagar(fb.tracking);
      assert.strictEqual(ga.status, 200);
      assert.strictEqual(gb.status, 200);
      assert.ok(ga.html.includes(fa.fila.referencia_externa) && !ga.html.includes(fb.fila.referencia_externa));
      assert.ok(gb.html.includes(fb.fila.referencia_externa) && !gb.html.includes(fa.fila.referencia_externa));
    } finally { await bandera(NEG_B, null); }
  });

  // ═══ F. Las páginas: textos y retorno ═══════════════════════════════════
  await t('F1. antes de pagar, la tienda no dice "¡Pedido recibido!" ni pinta palomita; dice "Tu pedido está listo para pagar"', () => {
    const html = readFileSync(join(__dirname, '..', 'panel', 'tienda.html'), 'utf8');
    const i = html.indexOf('async function mostrarExitoConPago');
    const bloque = html.slice(i, html.indexOf('\n}\n', i));
    assert.ok(i > 0, 'no existe mostrarExitoConPago');
    assert.ok(bloque.includes("'Tu pedido está listo para pagar'"));
    assert.ok(bloque.includes('Pago procesado por'));
    assert.ok(!bloque.includes('¡Pedido recibido!') && !bloque.includes('exito-ico') && !bloque.includes('✓'),
      'la pantalla previa al pago todavía celebra');
    const seg = readFileSync(join(__dirname, '..', 'panel', 'tienda-seguimiento.html'), 'utf8');
    assert.ok(seg.includes('Pago confirmado') && !seg.includes('¡Pedido confirmado!'));
  });

  await t('F2. Clip regresa al seguimiento por tres salidas distintas, todas propias', async () => {
    const fx = await pedidoConCheckout('A');
    const post = LLAMADAS.find(l => l.metodo === 'POST' && l.id === fx.fila.referencia_externa);
    const raiz = `${base}/seguimiento/${fx.tracking}?retorno=pago`;
    assert.deepStrictEqual(post.body.redirection_url,
      { success: `${raiz}&r=exito`, error: `${raiz}&r=error`, default: `${raiz}&r=salida` });
  });

  // ═══ I. Clip que acepta la conexión y no contesta (P1, revisión Codex) ══
  // Con un tope del lado del CLIENTE de la prueba: si la verificación queda
  // colgada, la prueba lo dice en vez de esperar los 5 min de undici.
  const verificarConTope = (tk, ms) => fetch(rutaPago(tk) + '/verificar', { method: 'POST', signal: AbortSignal.timeout(ms) })
    .then(json).catch(e => ({ colgado: true, error: e.name }));
  const postPagoConTope = (tk, ms) => fetch(rutaPago(tk), { method: 'POST', signal: AbortSignal.timeout(ms) })
    .then(json).catch(e => ({ colgado: true, error: e.name }));

  await t('I1. P1: Clip deja la consulta abierta → la verificación responde a tiempo con sin_respuesta y nada cambia', async () => {
    const fx = await pedidoConCheckout('A');
    COLGADOS.add(fx.fila.referencia_externa);
    try {
      const t0 = Date.now();
      const v = await verificarConTope(fx.tracking, 9000);
      assert.ok(!v.colgado, `la verificación quedó colgada (${Date.now() - t0} ms)`);
      assert.strictEqual(v.body.consulta, 'sin_respuesta', JSON.stringify(v.body));
      assert.ok(Date.now() - t0 < 6000, `tardó ${Date.now() - t0} ms con un límite de 2000`);
      assert.strictEqual(v.body.esperandoPago, true);
      assert.strictEqual((await pagosDe(fx.folio))[0].estado, 'pendiente');
    } finally { COLGADOS.delete(fx.fila.referencia_externa); soltarColgados(); }
  });

  await t('I2. P1: tres consultas colgadas no dejan sin cupo a otro pedido de OTRO negocio, y todas terminan', async () => {
    const colgados = [];
    for (let i = 0; i < 3; i++) {
      const fx = await pedidoConCheckout('A');
      COLGADOS.add(fx.fila.referencia_externa);
      colgados.push(fx);
    }
    const fb = await pedidoConCheckout('B');
    try {
      const enVuelo = colgados.map(fx => verificarConTope(fx.tracking, 9000));
      await esperar(300);                                    // los tres cupos ya están tomados
      const vb = await verificarConTope(fb.tracking, 9000);
      assert.ok(!vb.colgado, 'la verificación de B quedó esperando');
      assert.strictEqual(vb.body.consulta, 'pendiente', `B no llegó a consultar a Clip: ${vb.body.consulta}`);
      assert.ok(getsClip(fb.fila.referencia_externa).every(l => l.auth === AUTH.B));
      for (const r of await Promise.all(enVuelo)) {
        assert.ok(!r.colgado, 'una consulta colgada nunca terminó');
        assert.strictEqual(r.body.consulta, 'sin_respuesta');
      }
    } finally { for (const fx of colgados) COLGADOS.delete(fx.fila.referencia_externa); soltarColgados(); }
  });

  await t('I3. P1: reintento de pago con el checkout anterior colgado → responde a tiempo, sin cobro nuevo', async () => {
    const fx = await pedidoConCheckout('A');
    await pool.query(`UPDATE pedidos_activos SET datos = jsonb_set(datos, '{total}', '310'::jsonb) WHERE folio = $1 AND negocio_id = $2`, [fx.folio, NEG]);
    COLGADOS.add(fx.fila.referencia_externa);
    const antes = postsClip();
    try {
      const p = await postPagoConTope(fx.tracking, 9000);
      assert.ok(!p.colgado, 'el POST de pago quedó colgado esperando a Clip');
      assert.strictEqual(p.body.url, null);
      assert.strictEqual(p.body.verificando, true);
      assert.strictEqual(postsClip(), antes, 'se abrió otro cobro con el anterior incierto');
    } finally { COLGADOS.delete(fx.fila.referencia_externa); soltarColgados(); }
  });

  // ═══ G. En un navegador real ════════════════════════════════════════════
  if (!puppeteer) throw new Error('puppeteer no está disponible: los casos de navegador son obligatorios');
  nav = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  async function comprarEnTienda(pagina) {
    await pagina.goto(`${base}/t/${SLUG}`, { waitUntil: 'domcontentloaded' });
    await pagina.waitForSelector(`button.prod[onclick="abrirProducto(${PRODUCTO.A})"]`, { timeout: 10000 });
    await clic(pagina, `button.prod[onclick="abrirProducto(${PRODUCTO.A})"]`);
    await pagina.waitForSelector('#hoja-prod.on #btn-agregar');
    await clic(pagina, '#btn-agregar');
    await esperar(300);
    await clic(pagina, '#btn-carrito');
    await pagina.waitForSelector('#hoja-carrito.on #btn-ir-checkout');
    await clic(pagina, '#btn-ir-checkout');
    await pagina.waitForSelector(`#hoja-checkout.on button.opcion-grande[onclick="elegirModalidad('recoger')"]`);
    await clic(pagina, `button.opcion-grande[onclick="elegirModalidad('recoger')"]`);
    await clic(pagina, '#ck-pie .btn');
    await pagina.waitForSelector('#ck-nombre');
    await pagina.type('#ck-nombre', 'Juana Pérez');
    await pagina.type('#ck-tel', '899 730 0001');
    await clic(pagina, '#ck-pie .btn');
    await pagina.waitForSelector(`button.opcion-grande[onclick="elegirPago('enlace_pago')"]`);
    await clic(pagina, '#ck-pie .btn');
    await pagina.waitForSelector('#btn-confirmar');
  }
  const ultimoPedido = async () => (await pool.query(
    `SELECT tp.tracking_token, tp.pedido_folio FROM tienda_pedidos tp WHERE tp.negocio_id = $1 AND tp.pedido_folio IS NOT NULL
      ORDER BY tp.created_at DESC LIMIT 1`, [NEG])).rows[0];
  const iframeClip = pagina => pagina.frames().find(f => f.url().startsWith('https://pago.clip.mx/v3/'));

  await t('G1. recorrido completo (escritorio): "Pagar $300.00 con Clip" → componente de Clip → pago → regreso → "Pago confirmado"', async () => {
    await bandera(NEG, 'true');
    const { ctx, pagina, registro } = await pestana(nav, { ancho: 1280, alto: 860 });
    try {
      await comprarEnTienda(pagina);
      assert.strictEqual(await textoDe(pagina, '#btn-confirmar'), 'Pagar $300.00 con Clip');
      const antes = postsClip();
      await clic(pagina, '#btn-confirmar');
      assert.ok(await esperarHasta(() => pagina.url().includes('/pagar/'), { timeoutMs: 10000 }), `no llegó a /pagar: ${pagina.url()}`);
      const { tracking_token: tk, pedido_folio: folio } = await ultimoPedido();
      assert.ok(pagina.url().endsWith(`/pagar/${tk}?abrir=1`) || pagina.url().endsWith(`/pagar/${tk}`), pagina.url());
      // El acceso local quedó guardado, por negocio, sin nada del checkout.
      const ref = await pagina.evaluate(s => localStorage.getItem('xabor_pedido_pendiente_' + s), SLUG);
      const refObj = JSON.parse(ref || 'null');
      assert.strictEqual(refObj?.token, tk);
      assert.strictEqual(refObj?.folio, folio);
      const [fila] = await pagosDe(folio);
      assert.ok(!String(ref).includes(fila.referencia_externa), 'la referencia local guardó el id del checkout');
      // El SDK abre su ventana con ESE checkout.
      await pagina.waitForSelector('#clipCheckout iframe', { timeout: 12000 });
      const src = await pagina.$eval('#clipCheckout iframe', e => e.getAttribute('src'));
      assert.strictEqual(src, `https://pago.clip.mx/v3/${fila.referencia_externa}`);
      assert.strictEqual(await textoDe(pagina, '#titulo'), 'Tu pedido está listo para pagar');
      // La ventana puede abrirse antes de que la página termine de leer el
      // pedido (folio e importe llegan por API): se espera a que los pinte.
      await pagina.waitForFunction(f => document.getElementById('folio').textContent === '#' + f, { timeout: 5000 }, folio)
        .catch(() => {});
      assert.strictEqual(await textoDe(pagina, '#folio'), '#' + folio);
      assert.strictEqual(await textoDe(pagina, '#importe'), '$300.00');
      assert.ok(await ventanaClipEncima(pagina), 'la ventana de Clip no quedó encima de la página (escritorio)');
      await captura(pagina, 'g1-escritorio-componente-abierto');
      const caja = await pagina.$eval('#clipCheckoutIframe', e => e.getBoundingClientRect().width);
      assert.ok(caja <= 525.5, `ventana de Clip demasiado ancha en escritorio: ${caja}`);
      // Pago dentro del iframe (falso) → mensaje → el SDK regresa al seguimiento.
      const f = await esperarHasta(() => iframeClip(pagina), { timeoutMs: 8000 });
      await f.waitForSelector('#pagar');
      await f.click('#pagar');
      assert.ok(await esperarHasta(() => pagina.url().includes(`/seguimiento/${tk}?retorno=pago&r=exito`), { timeoutMs: 12000 }),
        `el SDK no regresó al seguimiento: ${pagina.url()}`);
      await pagina.waitForFunction(() => document.body.innerText.includes('Pago confirmado'), { timeout: 15000 });
      assert.strictEqual(postsClip(), antes + 1, 'el recorrido creó más de un checkout');
      assert.strictEqual(await esperarHasta(async () => (await comandasDe(folio)) === 1 ? 1 : null), 1);
      const ref2 = JSON.parse(await pagina.evaluate(s => localStorage.getItem('xabor_pedido_pendiente_' + s), SLUG) || 'null');
      assert.strictEqual(ref2?.pagado, true, 'la referencia local no se actualizó al confirmarse el pago');
      await captura(pagina, 'g1-escritorio-pago-confirmado');
      assert.deepStrictEqual(registro.errores, []);
    } finally { await ctx.close(); }
  });

  let FX_G2 = null;
  await t('G2. cerrar la ventana sin pagar (móvil 360 px): verifica con Clip, "No se completó el pago" y reabre el MISMO checkout', async () => {
    await bandera(NEG, 'true');
    FX_G2 = await pedidoConCheckout('A');
    const { ctx, pagina, registro } = await pestana(nav, { ancho: 360, alto: 740 });
    try {
      const antes = postsClip();
      await pagina.goto(`${base}/pagar/${FX_G2.tracking}?abrir=1`, { waitUntil: 'domcontentloaded' });
      await pagina.waitForSelector('#clipCheckout iframe', { timeout: 12000 });
      // Móvil: la ventana de Clip cabe en 360 px y no hay scroll horizontal.
      const medidas = await pagina.evaluate(() => ({
        caja: document.getElementById('clipCheckoutIframe').getBoundingClientRect().width,
        scroll: document.documentElement.scrollWidth, ancho: window.innerWidth,
      }));
      assert.ok(medidas.caja <= medidas.ancho + 0.5, `la ventana de Clip mide ${medidas.caja}px en ${medidas.ancho}px`);
      assert.ok(medidas.scroll <= medidas.ancho, `scroll horizontal: ${medidas.scroll} > ${medidas.ancho}`);
      assert.ok(await ventanaClipEncima(pagina), 'la ventana de Clip no quedó encima de la página (móvil)');
      await captura(pagina, 'g2-movil-componente-abierto');
      const getsAntes = getsClip(FX_G2.fila.referencia_externa).length;
      await clic(pagina, '#clipChecoutClose');
      await pagina.waitForFunction(() => document.getElementById('estado').innerText.includes('No se completó el pago'), { timeout: 10000 });
      assert.ok(getsClip(FX_G2.fila.referencia_externa).length > getsAntes, 'al cerrar no se consultó a Clip');
      assert.strictEqual(await textoDe(pagina, '#btn-pagar'), 'Volver a abrir el pago');
      await captura(pagina, 'g2-movil-cerrado-sin-pagar');
      await clic(pagina, '#btn-pagar');
      await pagina.waitForSelector('#clipCheckout iframe', { timeout: 8000 });
      const src = await pagina.$eval('#clipCheckout iframe', e => e.getAttribute('src'));
      assert.strictEqual(src, `https://pago.clip.mx/v3/${FX_G2.fila.referencia_externa}`);
      assert.strictEqual(postsClip(), antes, 'abrir/cerrar/reabrir creó otro checkout');
      assert.strictEqual((await pagosDe(FX_G2.folio)).length, 1);
      assert.deepStrictEqual(registro.errores, []);
    } finally { await ctx.close(); }
  });

  await t('G3. el componente de Clip NO carga: la página ofrece la liga de Clip del MISMO checkout, sin cobro nuevo', async () => {
    await bandera(NEG, 'true');
    const fx = await pedidoConCheckout('A');
    const { ctx, pagina, registro } = await pestana(nav, { ancho: 390, alto: 800, bloquearSdk: true });
    try {
      const antes = postsClip();
      await pagina.goto(`${base}/pagar/${fx.tracking}?abrir=1`, { waitUntil: 'domcontentloaded' });
      await pagina.waitForFunction(() => document.getElementById('estado').innerText.includes('No pudimos mostrar el pago aquí'), { timeout: 15000 });
      assert.ok(await visible(pagina, '#btn-redirigir'));
      assert.strictEqual(await visible(pagina, '#btn-pagar'), false, 'sigue ofreciendo el botón del componente caído');
      await captura(pagina, 'g3-componente-no-carga');
      await clic(pagina, '#btn-redirigir');
      assert.ok(await esperarHasta(() => registro.navegaciones.length > 0, { timeoutMs: 8000 }), 'no abrió la página de Clip');
      assert.strictEqual(registro.navegaciones[0], `https://completa-tu-pago.payclip.com/${fx.fila.referencia_externa}`);
      assert.strictEqual(postsClip(), antes, 'el respaldo creó otro checkout');
    } finally { await ctx.close(); }
  });

  await t('G4. un mensaje que NO viene de Clip no mueve al cliente de la página de pago', async () => {
    await bandera(NEG, 'true');
    const fx = await pedidoConCheckout('A');
    const { ctx, pagina } = await pestana(nav);
    try {
      await pagina.goto(`${base}/pagar/${fx.tracking}?abrir=1`, { waitUntil: 'domcontentloaded' });
      await pagina.waitForSelector('#clipCheckout iframe', { timeout: 12000 });
      await pagina.evaluate(() => window.postMessage('https://sitio-ajeno.example/robar', '*'));
      await esperar(4500);
      assert.ok(pagina.url().includes(`/pagar/${fx.tracking}`), `el mensaje ajeno navegó a ${pagina.url()}`);
      assert.ok(await pagina.$('#clipCheckout'), 'el mensaje ajeno cerró la ventana de Clip');
    } finally { await ctx.close(); }
  });

  await t('G5. retomar: tras cerrar y volver a la tienda aparece el pedido por pagar; recarga; y lleva a pagarlo', async () => {
    await bandera(NEG, 'true');
    const { ctx, pagina, registro } = await pestana(nav, { ancho: 390, alto: 800 });
    try {
      await comprarEnTienda(pagina);
      await clic(pagina, '#btn-confirmar');
      assert.ok(await esperarHasta(() => pagina.url().includes('/pagar/'), { timeoutMs: 10000 }));
      const { tracking_token: tk, pedido_folio: folio } = await ultimoPedido();
      // El cliente se va (cierra la pestaña o navega) y vuelve a la tienda.
      await pagina.goto(`${base}/t/${SLUG}`, { waitUntil: 'domcontentloaded' });
      await pagina.waitForFunction(f => document.getElementById('pedido-pendiente').innerText.includes('Tienes un pedido por pagar · #' + f),
        { timeout: 10000 }, folio);
      await pagina.reload({ waitUntil: 'domcontentloaded' });
      await pagina.waitForFunction(f => document.getElementById('pedido-pendiente').innerText.includes('#' + f), { timeout: 10000 }, folio);
      assert.strictEqual(await textoDe(pagina, '#btn-retomar'), 'Pagar $300.00 con Clip');
      await captura(pagina, 'g5-tienda-pedido-por-pagar');
      const antes = postsClip();
      await clic(pagina, '#btn-retomar');
      assert.ok(await esperarHasta(() => pagina.url().includes(`/pagar/${tk}`), { timeoutMs: 10000 }), pagina.url());
      assert.strictEqual(postsClip(), antes, 'retomar creó otro checkout');
      // Deja de ser recuperable (venció o se canceló): la tienda lo dice y
      // ofrece volver a pedirlo con el carrito de antes.
      await pool.query(`UPDATE pedidos_activos SET estado = 'cancelado' WHERE folio = $1 AND negocio_id = $2`, [folio, NEG]);
      await pagina.goto(`${base}/t/${SLUG}`, { waitUntil: 'domcontentloaded' });
      await pagina.waitForFunction(f => document.getElementById('pedido-pendiente').innerText.includes('Tu pedido #' + f + ' no se completó'),
        { timeout: 10000 }, folio);
      await clic(pagina, '#pedido-pendiente .btn');            // "Volver a pedirlo"
      await pagina.waitForSelector('#hoja-carrito.on');
      assert.strictEqual(await textoDe(pagina, '#carrito-n'), '1');
      assert.strictEqual(await pagina.evaluate(s => localStorage.getItem('xabor_pedido_pendiente_' + s), SLUG), null,
        'la referencia de un pedido no recuperable sigue guardada');
      assert.deepStrictEqual(registro.errores, []);
    } finally { await ctx.close(); }
  });

  await t('G6. regreso por SALIDA o ERROR sin pago: el seguimiento lo dice y ofrece reintentar de inmediato (sin ventana de espera)', async () => {
    const { ctx, pagina, registro } = await pestana(nav, { ancho: 390, alto: 800 });
    try {
      for (const [r, texto] of [['salida', 'No se completó el pago'], ['error', 'No se pudo completar el pago']]) {
        const fx = await pedidoConCheckout('A');
        await pagina.goto(`${base}/seguimiento/${fx.tracking}?retorno=pago&r=${r}`, { waitUntil: 'domcontentloaded' });
        await pagina.waitForFunction(x => document.body.innerText.includes(x), { timeout: 10000 }, texto);
        // El reintento se ofrece en cuanto se pinta, sin esperar a Clip…
        assert.ok(await visible(pagina, '#btn-pagar'), `con r=${r} no se ofrece reintentar`);
        assert.strictEqual(await textoDe(pagina, '#btn-pagar'), 'Pagar $300.00 con Clip');
        // …y sigue ahí cuando Clip contesta que el checkout está sin pagar.
        assert.ok(await esperarHasta(() => getsClip(fx.fila.referencia_externa).length >= 1, { timeoutMs: 8000 }),
          `con r=${r} no se consultó a Clip`);
        await esperar(600);
        assert.ok(await visible(pagina, '#btn-pagar'), `con r=${r} el reintento desapareció tras la consulta`);
        await captura(pagina, `g6-seguimiento-${r}`);
      }
      // Salir de Clip sin pagar no abre ninguna ventana de espera, aunque Clip
      // no conteste: el reintento es el MISMO checkout.
      const fSalida = await pedidoConCheckout('A');
      CLIP.caido = true;
      try {
        await pagina.goto(`${base}/seguimiento/${fSalida.tracking}?retorno=pago&r=salida`, { waitUntil: 'domcontentloaded' });
        await pagina.waitForFunction(() => document.body.innerText.includes('No se completó el pago'), { timeout: 10000 });
        assert.ok(await visible(pagina, '#btn-pagar'), 'tras salir sin pagar se escondió el reintento');
      } finally { CLIP.caido = false; }
      // Por ÉXITO, mientras Clip no confirma, no se invita a pagar otra vez.
      const fx = await pedidoConCheckout('A');
      CLIP.caido = true;
      try {
        await pagina.goto(`${base}/seguimiento/${fx.tracking}?retorno=pago&r=exito`, { waitUntil: 'domcontentloaded' });
        await pagina.waitForFunction(() => document.body.innerText.includes('Estamos verificando tu pago'), { timeout: 10000 });
        assert.strictEqual(await pagina.$('#btn-pagar'), null, 'durante la verificación se ofrece pagar otra vez');
      } finally { CLIP.caido = false; }
      // Y si Clip SÍ contesta que el checkout sigue sin pagar, la ventana deja
      // de esconder el reintento aunque el regreso haya sido por éxito.
      const fp = await pedidoConCheckout('A');
      await pagina.goto(`${base}/seguimiento/${fp.tracking}?retorno=pago&r=exito`, { waitUntil: 'domcontentloaded' });
      await pagina.waitForFunction(() => document.body.innerText.includes('No se completó el pago'), { timeout: 10000 });
      assert.ok(await visible(pagina, '#btn-pagar'), 'con Clip diciendo pendiente, la ventana siguió escondiendo el reintento');
      assert.deepStrictEqual(registro.errores, []);
    } finally { await ctx.close(); }
  });

  await t('G7. bandera APAGADA en el navegador: la tienda lleva a la liga de Clip de siempre (sin /pagar)', async () => {
    await bandera(NEG, null);
    const { ctx, pagina, registro } = await pestana(nav, { ancho: 390, alto: 800 });
    try {
      await comprarEnTienda(pagina);
      await clic(pagina, '#btn-confirmar');
      assert.ok(await esperarHasta(() => registro.navegaciones.length > 0, { timeoutMs: 10000 }), 'no navegó a la liga de Clip');
      const { pedido_folio: folio } = await ultimoPedido();
      const [fila] = await pagosDe(folio);
      assert.strictEqual(registro.navegaciones[0], `https://completa-tu-pago.payclip.com/${fila.referencia_externa}`);
      assert.ok(!registro.externos.some(u => u.startsWith(SDK_URL)), 'con la bandera apagada se cargó el SDK');
    } finally { await ctx.close(); }
  });

  await t('I4. P1: el seguimiento se pinta al instante aunque la consulta a Clip quede colgada', async () => {
    const fx = await pedidoConCheckout('A');
    COLGADOS.add(fx.fila.referencia_externa);
    const { ctx, pagina, registro } = await pestana(nav, { ancho: 390, alto: 800 });
    try {
      const t0 = Date.now();
      await pagina.goto(`${base}/seguimiento/${fx.tracking}?retorno=pago&r=exito`, { waitUntil: 'domcontentloaded' });
      // Muy por debajo del tiempo límite del servidor (2000 ms en esta suite):
      // si la página esperara a Clip para pintar, pintaría DESPUÉS de ese
      // límite, y el tiempo límite del servidor no taparía el defecto.
      await pagina.waitForSelector('.folio', { timeout: 1200 }).catch(() => null);
      assert.strictEqual(await textoDe(pagina, '.folio'), '#' + fx.folio,
        `el pedido no se pintó mientras Clip no contestaba (${Date.now() - t0} ms)`);
      assert.ok(await pagina.evaluate(() => document.body.innerText.includes('Estamos verificando tu pago')));
      assert.deepStrictEqual(registro.errores, []);
    } finally { COLGADOS.delete(fx.fila.referencia_externa); soltarColgados(); await ctx.close(); }
  });

  await t('I5. P1: cerrar la ventana con Clip colgado no deja la página de pago "Revisando…" para siempre', async () => {
    await bandera(NEG, 'true');
    const fx = await pedidoConCheckout('A');
    const { ctx, pagina, registro } = await pestana(nav, { ancho: 390, alto: 800 });
    try {
      await pagina.goto(`${base}/pagar/${fx.tracking}?abrir=1`, { waitUntil: 'domcontentloaded' });
      await pagina.waitForSelector('#clipCheckout iframe', { timeout: 12000 });
      COLGADOS.add(fx.fila.referencia_externa);
      await clic(pagina, '#clipChecoutClose');
      const ok = await pagina.waitForFunction(
        () => document.getElementById('estado').innerText.includes('Aún no podemos confirmar tu pago con Clip'),
        { timeout: 7000 }).then(() => true, () => false);
      assert.ok(ok, `la página quedó en: ${await textoDe(pagina, '#estado')}`);
      assert.ok(await visible(pagina, '#btn-verificar'), 'no se ofrece volver a verificar');
      assert.strictEqual(await textoDe(pagina, '#btn-pagar'), 'Volver a abrir el pago');
      assert.deepStrictEqual(registro.errores, []);
    } finally { COLGADOS.delete(fx.fila.referencia_externa); soltarColgados(); await ctx.close(); }
  });

  // ═══ J. Mensajes del checkout (P2, revisión Codex) ══════════════════════
  // Solo cuenta un mensaje que venga DEL iframe del checkout (ventana y
  // origen) y que nombre el seguimiento de ESTE pedido; aun así, a dónde se
  // va lo arma la página, no el mensaje.
  async function paginaDePago(fx) {
    const { ctx, pagina, registro } = await pestana(nav);
    await pagina.goto(`${base}/pagar/${fx.tracking}?abrir=1`, { waitUntil: 'domcontentloaded' });
    await pagina.waitForSelector('#clipCheckout iframe', { timeout: 12000 });
    const checkout = await esperarHasta(() => iframeClip(pagina), { timeoutMs: 8000 });
    await checkout.waitForSelector('#pagar');
    return { ctx, pagina, registro, checkout };
  }

  await t('J1. P2: origen de Clip pero desde OTRA ventana (no el iframe del checkout): ni destino externo ni el propio mueven al cliente', async () => {
    await bandera(NEG, 'true');
    const fx = await pedidoConCheckout('A');
    const { ctx, pagina } = await paginaDePago(fx);
    try {
      await pagina.evaluate(() => {
        const f = document.createElement('iframe');
        f.src = 'https://pago.clip.mx/v3/ventana-ajena-1';
        document.body.appendChild(f);
      });
      const ajena = await esperarHasta(() => pagina.frames().find(f => f.url().includes('ventana-ajena-1')), { timeoutMs: 8000 });
      assert.ok(ajena, 'no cargó la ventana ajena');
      await ajena.waitForSelector('body');
      await ajena.evaluate(() => parent.postMessage('https://sitio-ajeno.example/robar', '*'));
      await ajena.evaluate(u => parent.postMessage(u, '*'), `${base}/seguimiento/${fx.tracking}?retorno=pago&r=exito`);
      await esperar(4500);
      assert.ok(pagina.url().includes(`/pagar/${fx.tracking}`), `un mensaje de otra ventana navegó a ${pagina.url()}`);
    } finally { await ctx.close(); }
  });

  await t('J2. P2: desde el iframe del checkout, un destino EXTERNO no mueve al cliente', async () => {
    const fx = await pedidoConCheckout('A');
    const { ctx, pagina, checkout } = await paginaDePago(fx);
    try {
      await checkout.evaluate(() => parent.postMessage('https://sitio-ajeno.example/robar', '*'));
      // Misma ruta y parámetros que el regreso de este pedido, pero en OTRO sitio.
      await checkout.evaluate(u => parent.postMessage(u, '*'),
        `https://sitio-ajeno.example/seguimiento/${fx.tracking}?retorno=pago&r=exito`);
      await esperar(4500);
      assert.ok(pagina.url().includes(`/pagar/${fx.tracking}`), `el checkout mandó al cliente a ${pagina.url()}`);
    } finally { await ctx.close(); }
  });

  await t('J3. P2: desde el iframe del checkout, el seguimiento de OTRO pedido no mueve al cliente', async () => {
    const fx = await pedidoConCheckout('A');
    const otro = await pedidoConCheckout('A');
    const { ctx, pagina, checkout } = await paginaDePago(fx);
    try {
      await checkout.evaluate(u => parent.postMessage(u, '*'), `${base}/seguimiento/${otro.tracking}?retorno=pago&r=exito`);
      await esperar(4500);
      assert.ok(pagina.url().includes(`/pagar/${fx.tracking}`), `el cliente terminó en ${pagina.url()}`);
    } finally { await ctx.close(); }
  });

  await t('J4. P2: el regreso válido lleva al destino EXACTO de este pedido (lo arma la página, no el mensaje)', async () => {
    const fx = await pedidoConCheckout('A');
    const { ctx, pagina, checkout } = await paginaDePago(fx);
    try {
      await checkout.evaluate(u => parent.postMessage(u, '*'),
        `${base}/seguimiento/${fx.tracking}?retorno=pago&r=error&siguiente=https://sitio-ajeno.example`);
      const esperado = `${base}/seguimiento/${fx.tracking}?retorno=pago&r=error`;
      assert.ok(await esperarHasta(() => pagina.url() === esperado, { timeoutMs: 8000 }), `terminó en ${pagina.url()}`);
    } finally { await ctx.close(); }
  });

  await t('J5. P2: la MISMA ventana del checkout, ya en otro origen (p. ej. un banco), no puede pedir el regreso', async () => {
    const fx = await pedidoConCheckout('A');
    const { ctx, pagina, checkout } = await paginaDePago(fx);
    try {
      await checkout.evaluate(() => { location.href = 'https://banco-prueba.example/3ds'; });
      const banco = await esperarHasta(() => pagina.frames().find(f => f.url().startsWith('https://banco-prueba.example/')), { timeoutMs: 8000 });
      assert.ok(banco, 'el iframe no llegó a la página del banco de prueba');
      await banco.waitForSelector('p');
      await banco.evaluate(u => parent.postMessage(u, '*'), `${base}/seguimiento/${fx.tracking}?retorno=pago&r=exito`);
      await esperar(3000);
      assert.ok(pagina.url().includes(`/pagar/${fx.tracking}`), `un mensaje desde otro origen navegó a ${pagina.url()}`);
    } finally { await ctx.close(); }
  });

  if (SDK.real) {
    await t('H1. el SDK oficial de Clip sigue con el contrato del que depende la integración', () => {
      for (const pieza of ['getElementById("checkoutClipPlugin")', 'getAttribute("payment_request_id")',
        '.clipCheckoutButton', 'https://pago.clip.mx/v3/', 'addEventListener("message"', 'DOMContentLoaded',
        'clipChecoutClose', 'clipCheckout']) {
        assert.ok(SDK.cuerpo.includes(pieza), `el SDK de Clip cambió: ya no contiene ${pieza}. Revisar panel/tienda-pago.html`);
      }
    });
  }
} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL: ' + e.message);
} finally {
  try { if (nav) await nav.close(); } catch { /* abajo */ }
  try { if (srv) await srv.detener(); } catch { /* abajo */ }
  for (const res of RETENIDAS) { try { res.destroy(); } catch { /* ya cerrada */ } }
  clipMock.close();
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-tienda-clip-embebido: ${pasadas} pasadas, ${fallidas} fallidas (SDK ${SDK.real ? 'oficial' : 'DOBLE'}) ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
