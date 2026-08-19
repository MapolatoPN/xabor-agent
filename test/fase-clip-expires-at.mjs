// ─── CLIP expires_at: el checkout del proveedor tambien vence ───────────────
//
// Hasta este bloque, Xabor tenia UNA frontera durable (pagos.xabor_espera_hasta)
// pero el checkout creado en Clip viajaba SIN expiracion: Clip le aplicaba su
// default de 3 dias, y el enlace seguia cobrable dias despues de que Xabor ya
// habia vencido el pedido. La meta: XABOR VENCE y EL CHECKOUT DE CLIP TAMBIEN
// queda configurado para vencer, con UNA sola frontera temporal (T) calculada
// una vez, persistida, y derivada al proveedor.
//
// CONTRATO OFICIAL DE CLIP (auditado ANTES de escribir esta suite, fuentes:
// https://developer.clip.mx/reference/createnewpaymentlink y
// https://developer.clip.mx/reference/checkout-webhook):
//   · Campo request: `expires_at`, string, formato "YYYY-MM-DDTHH-MM-SSZ"
//     (UTC, maxLength 20 -- SEGUNDOS, sin milisegundos).
//   · Limites: "mayor a 00:01:00 minuto de la hora de creacion y menor a las
//     23:59:59 (hora de CDMX) del mismo dia de creacion". Default si se
//     omite: 3 dias.
//   · La creacion y la reconsulta devuelven `expired_at` (el efectivo).
//   · Estados de consulta: CHECKOUT_CREATED/PENDING/CANCELLED/EXPIRED/COMPLETED.
//   · Webhook oficial: resource=CHECKOUT, resource_status EXPIRED existe
//     ("se recibe cuando expira un link de pago"); tambien CREATED/CANCELED/
//     PENDING/COMPLETED. El webhook NO viene firmado: todo se re-verifica por
//     consulta con las credenciales del negocio.
//
// Ninguna prueba toca Clip real. Cero credenciales reales, cero dinero real.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { execFileSync } from 'child_process';
import assert from 'assert';
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
const PUERTO = Number(process.env.TEST_PORT_CEA || 4351);
const PUERTO_CLIP = Number(process.env.TEST_PORT_CEA_CLIP || 4352);
const PUERTO_MP = Number(process.env.TEST_PORT_CEA_MP || 4353);
const base = `http://localhost:${PUERTO}`;

process.env.CLIP_API_BASE_URL = `http://localhost:${PUERTO_CLIP}`;
process.env.XABOR_MP_API_BASE = `http://localhost:${PUERTO_MP}`;
process.env.XABOR_URL_PUBLICA = base;

// ── Mock de Clip v2 (forma DOCUMENTADA, extendida para expiracion) ──────────
//
// Comportamientos configurables por caso:
//   modo='normal'    -> eco: expired_at = expires_at recibido (o default 3d).
//   modo='ajusta'    -> el proveedor "corrige": expired_at = solicitado + 6h.
//   modo='adelanta'  -> expired_at = solicitado - 10min (mas temprana).
//   modo='rechaza'   -> 400 con code_message, NO crea nada.
//   modo='timeout'   -> destruye el socket sin responder (creacion ambigua).
let checkoutsClip = 0;
const CHECKOUTS = new Map();      // id -> { referencia, estado, monto, expiredAt }
const REQUESTS = [];              // cuerpos crudos de cada POST /v2/checkout
let modoClip = 'normal';
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => { cuerpo += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const body = JSON.parse(cuerpo || '{}');
      REQUESTS.push(body);
      if (modoClip === 'timeout') { req.socket.destroy(); return; }
      if (modoClip === 'rechaza') {
        res.statusCode = 400;
        res.end(JSON.stringify({ message: 'expires_at invalid', code_message: 'AI1300' }));
        return;
      }
      const id = `clip-cea-${++checkoutsClip}`;
      let expiredAt;
      const solicitado = body.expires_at ? Date.parse(body.expires_at) : null;
      if (modoClip === 'ajusta' && solicitado) expiredAt = new Date(solicitado + 6 * 3600e3).toISOString();
      else if (modoClip === 'adelanta' && solicitado) expiredAt = new Date(solicitado - 10 * 60e3).toISOString();
      else if (solicitado) expiredAt = new Date(solicitado).toISOString();
      else expiredAt = new Date(Date.now() + 3 * 24 * 3600e3).toISOString(); // default documentado: 3 dias
      CHECKOUTS.set(id, {
        referencia: body.metadata?.external_reference || null,
        estado: 'PENDING', monto: Number(body.amount), expiredAt,
      });
      res.end(JSON.stringify({
        payment_request_id: id, object_type: 'payment_link', status: 'CHECKOUT_CREATED',
        payment_request_url: `https://pago.mock.clip/${id}`,
        created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        expired_at: expiredAt,
      }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v2/checkout/')) {
      const id = decodeURIComponent(req.url.split('/').pop());
      const c = CHECKOUTS.get(id);
      if (!c) { res.statusCode = 404; res.end('{}'); return; }
      const status = c.estado === 'COMPLETED' ? 'CHECKOUT_COMPLETED'
        : c.estado === 'EXPIRED' ? 'CHECKOUT_EXPIRED'
        : c.estado === 'CANCELLED' ? 'CHECKOUT_CANCELLED' : 'CHECKOUT_PENDING';
      res.end(JSON.stringify({
        object_type: 'payment_link', payment_request_id: id, status,
        amount: c.monto ?? null, currency: 'MXN',
        metadata: { external_reference: c.referencia, customer_info: {} },
        payment_request_url: `https://completa-tu-pago.payclip.com/${id}`,
        created_at: '2026-08-19T00:00:00Z', expired_at: c.expiredAt || null,
        last_status_message: status,
      }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
});

// Mock minimo de Mercado Pago (caso 18: MP no sufre regresion).
let checkoutsMP = 0;
const PREFERENCIAS = new Map();
const mpMock = createServer((req, res) => {
  if (req.url.startsWith('/checkout/preferences')) {
    let cuerpo = '';
    req.on('data', c => { cuerpo += c; });
    req.on('end', () => {
      const p = JSON.parse(cuerpo || '{}');
      const id = `pref-cea-${++checkoutsMP}`;
      PREFERENCIAS.set(id, { external_reference: p.external_reference, body: p });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, init_point: `https://mp.test/checkout/${id}` }));
    });
    return;
  }
  res.writeHead(404); res.end('{}');
});

await new Promise(r => clipMock.listen(PUERTO_CLIP, r));
await new Promise(r => mpMock.listen(PUERTO_MP, r));

// ── Fixture (mismo patron que fase-pagos-expiracion.mjs) ───────────────────
async function conectarClip(negocioId = NEG) {
  const { guardarIntegracionPago, marcarProveedorPrincipal } =
    await import('../src/services/integracionesService.js');
  await guardarIntegracionPago(negocioId, 'clip',
    { apiKey: 'test-api-key-no-real', apiSecret: 'test-api-secret-no-real' },
    { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(negocioId, 'clip', SEED.superadminUsuarioId);
}
async function conectarMP(negocioId = NEG) {
  const { guardarIntegracionPago, marcarProveedorPrincipal } =
    await import('../src/services/integracionesService.js');
  await guardarIntegracionPago(negocioId, 'mercado_pago',
    { accessToken: 'token-cea', publicKey: 'pk-test', webhookSecret: 'secreto-cea' },
    { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(negocioId, 'mercado_pago', SEED.superadminUsuarioId);
}

async function pedido(folio, monto, { negocioId = NEG, estadoPedido = 'pendiente_pago' } = {}) {
  await pool.query(
    `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (folio) DO UPDATE SET estado=$3, datos=$4`,
    [folio, negocioId, estadoPedido, JSON.stringify({
      id: folio, negocioId, canal: 'tienda_online', total: monto, estado: estadoPedido,
      modalidad: 'recoger en tienda', forma_pago: 'enlace de pago', pago_confirmado: false,
      cliente: { nombre: 'Cliente expires_at', telefono: '8997600011' },
      items: [{ nombre: 'Producto', cantidad: 1, precio_unitario: monto }],
      timestamp: new Date().toISOString(),
    })]);
}

const crearEnlace = async (folio, negocioId = NEG) => {
  const { crearEnlacePago } = await import('../src/services/pagosService.js');
  return crearEnlacePago({ negocioId, pedidoId: folio, actor: SEED.superadminUsuarioId });
};

async function filas(folio, negocioId = NEG) {
  const { rows } = await pool.query(
    `SELECT * FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 ORDER BY created_at`, [negocioId, folio]);
  return rows;
}
async function pedidoDe(folio, negocioId = NEG) {
  const { rows: [r] } = await pool.query(
    `SELECT estado, datos FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, negocioId]);
  return r || null;
}
async function comandasDe(folio) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM impresion_trabajos
      WHERE negocio_id=$1 AND origen_tipo='pedido' AND origen_id=$2`, [NEG, folio]);
  return r.n;
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
async function esperarHasta(fn, { timeoutMs = 12000, intervaloMs = 150 } = {}) {
  const lim = Date.now() + timeoutMs;
  for (;;) { const r = await fn(); if (r) return r; if (Date.now() > lim) return null; await esperar(intervaloMs); }
}

async function webhookClip(cuerpo, { puerto = PUERTO } = {}) {
  const r = await fetch(`http://localhost:${puerto}/webhook/clip`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  return r.status;
}

const filaId = async (id) => (await pool.query(`SELECT * FROM pagos WHERE id=$1`, [id])).rows[0];
/** Empuja el deadline INTERNO al pasado. No toca `expires_at`: son otra cosa. */
const vencerYa = (pagoId) => pool.query(
  `UPDATE pagos SET xabor_espera_hasta = NOW() - interval '2 minutes' WHERE id=$1`, [pagoId]);

async function montarImpresion() {
  const { crearEdge } = await import('../src/services/edgeService.js');
  const { crearImpresora, crearRuta } = await import('../src/services/impresionService.js');
  const { DESTINOS } = await import('../src/services/impresionSelfService.js');
  await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [NEG]);
  const term = await crearEdge(NEG, { nombre: 'PC CEA' });
  const imp = await crearImpresora(NEG, {
    terminalId: term.id, nombre: 'Impresora cea', transporte: 'windows_spooler',
    anchoColumnas: 42, config: { spoolerNombre: 'Impresora cea' },
  });
  await crearRuta(NEG, { impresoraId: imp.id, ambito: 'documento', clave: DESTINOS.cocina.clave });
  return { term, imp };
}
async function desmontarImpresion() {
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM impresoras WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM edge_emparejamientos WHERE terminal_id IN
    (SELECT t.id FROM terminales t JOIN sucursales s ON s.id=t.sucursal_id WHERE s.negocio_id=$1 AND t.nombre='PC CEA')`, [NEG]);
  await pool.query(`DELETE FROM terminales WHERE nombre='PC CEA' AND sucursal_id IN
    (SELECT id FROM sucursales WHERE negocio_id=$1)`, [NEG]);
}

async function limpiar() {
  for (const n of [NEG, NEG_B]) {
    await pool.query(`DELETE FROM pagos WHERE negocio_id=$1 AND pedido_folio LIKE 'CEA-%'`, [n]);
    await pool.query(`DELETE FROM pedido_emisiones WHERE negocio_id=$1 AND folio LIKE 'CEA-%'`, [n]);
    await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio LIKE 'CEA-%'`, [n]);
    await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal='pagos'`, [n]);
    await pool.query(`DELETE FROM configuracion WHERE negocio_id=$1 AND clave='pago_online_espera_minutos'`, [n]);
  }
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id=$1 AND origen_id LIKE 'CEA-%'`, [NEG]);
}

let srv = null;
let seq = 0;
const folioNuevo = () => `CEA-${String(Date.now()).slice(-6)}${++seq}`;

try {
  await limpiar();
  await conectarClip();

  // ═══ 1. El request de creacion a Clip LLEVA expires_at ═══════════════════
  await t('1. el POST de creacion a Clip contiene expires_at en el formato oficial (UTC, segundos, 20 chars)', async () => {
    const folio = folioNuevo();
    await pedido(folio, 250);
    const antes = REQUESTS.length;
    const r = await crearEnlace(folio);
    assert.ok(r.url, 'no se creo el enlace');
    const req = REQUESTS[antes];
    assert.ok(req, 'el mock no capturo el POST de creacion');
    assert.ok(req.expires_at,
      `el POST de creacion a Clip NO lleva expires_at: el checkout queda con el default de 3 dias del proveedor, cobrable mucho despues de que Xabor ya vencio. Cuerpo capturado: ${JSON.stringify(Object.keys(req))}`);
    assert.match(String(req.expires_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      `expires_at no va en el formato oficial de Clip (YYYY-MM-DDTHH-MM-SSZ, UTC, sin milisegundos): ${req.expires_at}`);
  });

  // ═══ 2. expires_at ES el mismo instante que xabor_espera_hasta ═══════════
  await t('2. expires_at enviado == xabor_espera_hasta durable (mismo instante, un solo reloj)', async () => {
    const folio = folioNuevo();
    await pedido(folio, 260);
    const antes = REQUESTS.length;
    await crearEnlace(folio);
    const req = REQUESTS[antes];
    assert.ok(req?.expires_at, 'sin expires_at en el POST: no hay nada que comparar (ver caso 1)');
    const [fila] = await filas(folio);
    assert.ok(fila?.xabor_espera_hasta, 'la fila no tiene xabor_espera_hasta');
    const enviado = Date.parse(req.expires_at);
    const durable = new Date(fila.xabor_espera_hasta).getTime();
    // Clip trunca a SEGUNDOS (formato de 20 chars); la tolerancia es 1s por
    // ese truncado -- jamas minutos.
    const diff = Math.abs(enviado - durable);
    assert.ok(diff < 1000,
      `expires_at enviado a Clip (${req.expires_at}) y xabor_espera_hasta durable (${new Date(durable).toISOString()}) difieren ${Math.round(diff / 1000)}s: dos relojes que pueden divergir en vez de UNA frontera`);
    // Y la T durable existia ANTES de que el proveedor respondiera: quedo
    // fijada pre-POST (fijarEsperaDePago), no inventada despues.
    assert.ok(new Date(fila.xabor_espera_hasta).getTime() > Date.now(),
      'la frontera durable no quedo en el futuro');
  });

  // ═══ 3. TIMEZONE: dos zonas distintas -> el MISMO instante hacia Clip ═════
  await t('3. la construccion del payload bajo TZ=CDMX y TZ=Tokio produce EXACTAMENTE el mismo instante', async () => {
    // El instante T es fijo; lo unico que cambia es la zona del PROCESO. Si
    // el resultado difiere, alguien uso hora local sin zona -- el mismo tipo
    // de bug que ya costo dos incidentes reales en este proyecto (063).
    const T = new Date(Date.now() + 25 * 60e3).toISOString();
    const ahora = new Date().toISOString();
    const script = `
      import('file://' + ${JSON.stringify(join(__dirname, '..', 'src', 'services', 'clip-api.js').replace(/\\/g, '/'))})
        .then(m => { const r = m.prepararExpiracionClip(new Date(${JSON.stringify(T)}), new Date(${JSON.stringify(ahora)})); console.log(JSON.stringify(r)); });
    `;
    const enTZ = (tz) => JSON.parse(execFileSync(process.execPath, ['-e', script],
      { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim());
    const cdmx = enTZ('America/Mexico_City');
    const tokio = enTZ('Asia/Tokyo');
    const utc = enTZ('UTC');
    assert.strictEqual(cdmx.texto, tokio.texto,
      `el payload depende del timezone del proceso: CDMX=${cdmx.texto} vs Tokio=${tokio.texto}`);
    assert.strictEqual(cdmx.texto, utc.texto, `CDMX=${cdmx.texto} vs UTC=${utc.texto}`);
    assert.strictEqual(cdmx.epochMs, tokio.epochMs, 'los epochs difieren entre zonas');
    // Y el tope del dia CDMX tambien es el mismo instante desde cualquier zona.
    const scriptTope = `
      import('file://' + ${JSON.stringify(join(__dirname, '..', 'src', 'services', 'clip-api.js').replace(/\\/g, '/'))})
        .then(m => console.log(m.finDelDiaCDMXComoUTC(new Date(${JSON.stringify(ahora)}))));
    `;
    const topeCdmx = execFileSync(process.execPath, ['-e', scriptTope], { env: { ...process.env, TZ: 'America/Mexico_City' }, encoding: 'utf8' }).trim();
    const topeTokio = execFileSync(process.execPath, ['-e', scriptTope], { env: { ...process.env, TZ: 'Asia/Tokyo' }, encoding: 'utf8' }).trim();
    assert.strictEqual(topeCdmx, topeTokio, `el fin del dia CDMX depende de la zona del proceso: ${topeCdmx} vs ${topeTokio}`);
  });

  // ═══ 4. Clip rechaza / expiracion invalida ════════════════════════════════
  await t('4. Clip rechaza con 400 -> NO se reporta checkout creado; y un expiresAt invalido ni siquiera llega al POST', async () => {
    // 4a: el proveedor rechaza -> el intento NO queda como checkout creado.
    const folio = folioNuevo();
    await pedido(folio, 270);
    modoClip = 'rechaza';
    const antes = REQUESTS.length;
    let fallo = null;
    try { await crearEnlace(folio); } catch (e) { fallo = e; }
    modoClip = 'normal';
    assert.ok(fallo, 'crearEnlacePago debio fallar con el 400 del proveedor');
    const [fila] = await filas(folio);
    assert.ok(!fila.referencia_externa && !fila.url,
      'se reporto un checkout creado pese al 400 del proveedor');
    assert.strictEqual(REQUESTS.length, antes + 1, 'el POST rechazado no quedo capturado');

    // 4b (M10): el ADAPTADOR valida ANTES del POST -- un expiresAt invalido
    // jamas sale a la red.
    const { createPaymentLink } = await import('../src/services/providers/clipProvider.js');
    const antesB = REQUESTS.length;
    await assert.rejects(
      () => createPaymentLink({
        negocioId: NEG, pedidoId: folio, total: 100, descripcion: 'x',
        cliente: {}, referencia: 'ref-invalida-cea', expiresAt: new Date('no-es-fecha'),
      }),
      /ExpiracionInvalidaError/, 'un expiresAt invalido debio rechazarse antes del POST');
    await assert.rejects(
      () => createPaymentLink({
        negocioId: NEG, pedidoId: folio, total: 100, descripcion: 'x',
        cliente: {}, referencia: 'ref-pasada-cea', expiresAt: new Date(Date.now() - 60e3),
      }),
      /ExpiracionInvalidaError/, 'un expiresAt en el pasado debio rechazarse antes del POST');
    assert.strictEqual(REQUESTS.length, antesB,
      'el adaptador MANDO un POST con una expiracion que ya sabia invalida');
  });

  // ═══ 5. La respuesta del proveedor queda registrada, sanitizada ══════════
  await t('5. Clip devuelve el expires_at esperado -> requested/provider quedan en metadata y pagos.expires_at se puebla', async () => {
    const folio = folioNuevo();
    await pedido(folio, 280);
    const antes = REQUESTS.length;
    await crearEnlace(folio);
    const req = REQUESTS[antes];
    const [fila] = await filas(folio);
    const meta = fila.metadata_sanitizada || {};
    assert.strictEqual(meta.requested_expires_at, req.expires_at, 'requested_expires_at no coincide con lo enviado');
    assert.ok(meta.provider_expires_at, 'provider_expires_at no quedo registrado');
    assert.ok(fila.expires_at, 'pagos.expires_at (expiracion del PROVEEDOR) quedo NULL');
    assert.ok(Math.abs(new Date(fila.expires_at).getTime() - Date.parse(req.expires_at)) < 1000,
      'pagos.expires_at no refleja la expiracion efectiva devuelta');
    assert.ok(!meta.expiracion_divergente, 'marco divergencia donde no la hubo');
  });

  // ═══ 6. El proveedor devuelve una expiracion MAS TARDIA ══════════════════
  await t('6. Clip devuelve una expiracion 6h mas tardia -> Xabor NO amplia su autorizacion local', async () => {
    const folio = folioNuevo();
    await pedido(folio, 290);
    modoClip = 'ajusta';
    const antes = REQUESTS.length;
    await crearEnlace(folio);
    modoClip = 'normal';
    const req = REQUESTS[antes];
    const [fila] = await filas(folio);
    const solicitado = Date.parse(req.expires_at);
    const local = new Date(fila.xabor_espera_hasta).getTime();
    assert.ok(Math.abs(local - solicitado) < 1000,
      `xabor_espera_hasta se movio tras la respuesta del proveedor: local=${new Date(local).toISOString()} vs solicitado=${req.expires_at}`);
    const proveedor = new Date(fila.expires_at).getTime();
    assert.ok(Math.abs(proveedor - (solicitado + 6 * 3600e3)) < 1000,
      'pagos.expires_at no registro la frontera EFECTIVA (mas tardia) del proveedor');
    assert.strictEqual(fila.metadata_sanitizada?.expiracion_divergente, true,
      'la divergencia significativa no quedo marcada');
    // Y la frontera local sigue mandando: vencido a la hora de XABOR aunque
    // el link del proveedor siga vivo 6h mas.
    await vencerYa(fila.id);
    const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');
    assert.ok((await expirarPagosVencidos()) >= 1, 'el vencimiento local no corrio');
    assert.strictEqual((await filaId(fila.id)).estado, 'vencido',
      'el pago no vencio a la hora local: la ventana del proveedor amplio la autorizacion de Xabor');
  });

  // ═══ 7. El proveedor devuelve una expiracion MAS TEMPRANA ════════════════
  await t('7. Clip devuelve una expiracion 10min mas temprana -> la frontera efectiva queda conocida; la local no se toca', async () => {
    const folio = folioNuevo();
    await pedido(folio, 300);
    modoClip = 'adelanta';
    const antes = REQUESTS.length;
    await crearEnlace(folio);
    modoClip = 'normal';
    const req = REQUESTS[antes];
    const [fila] = await filas(folio);
    const solicitado = Date.parse(req.expires_at);
    assert.ok(Math.abs(new Date(fila.xabor_espera_hasta).getTime() - solicitado) < 1000,
      'la frontera local cambio por la respuesta del proveedor');
    assert.ok(Math.abs(new Date(fila.expires_at).getTime() - (solicitado - 10 * 60e3)) < 1000,
      'pagos.expires_at no registro la expiracion real (mas temprana) del proveedor');
    assert.strictEqual(fila.metadata_sanitizada?.expiracion_divergente, true,
      'una expiracion efectiva 10min mas corta no es ruido: debe quedar marcada');
    // Politica segura: el proveedor venciendo ANTES es legitimo ("igual o mas
    // estricta"); cuando el requery lo confirme EXPIRED, la transicion comun
    // vence (caso 11). Aqui basta que Xabor CONOZCA la frontera efectiva.
  });

  // ═══ Servidor real para los casos de webhook ═════════════════════════════
  srv = await arrancarServidor({ PORT: String(PUERTO) }, { timeoutMs: 90000 });

  // ═══ 8. Webhook EXPIRED oficial ═══════════════════════════════════════════
  let filaCaso8 = null, folioCaso8 = null;
  await t('8. webhook EXPIRED oficial -> el pago y el pedido vencen por la transicion comun (verificado por reconsulta)', async () => {
    const folio = folioCaso8 = folioNuevo();
    await pedido(folio, 310);
    const r = await crearEnlace(folio);
    const [fila] = await filas(folio);
    filaCaso8 = fila;

    // Primero un EXPIRED FALSO: el checkout sigue vivo en el proveedor. El
    // webhook no viene firmado -- sin la reconsulta, esto mataria un pago
    // valido de cualquiera que conozca la referencia.
    assert.strictEqual(await webhookClip({
      resource: 'CHECKOUT', resource_status: 'EXPIRED',
      me_reference_id: fila.referencia_interna, payment_request_id: r.referenciaExterna,
    }), 200);
    await new Promise(res => setTimeout(res, 800));
    assert.strictEqual((await filaId(fila.id)).estado, 'pendiente',
      'un webhook EXPIRED sin respaldo del proveedor VENCIO un checkout vivo');

    // Ahora el checkout SI esta vencido del lado del proveedor.
    CHECKOUTS.get(r.referenciaExterna).estado = 'EXPIRED';
    assert.strictEqual(await webhookClip({
      resource: 'CHECKOUT', resource_status: 'EXPIRED',
      me_reference_id: fila.referencia_interna, payment_request_id: r.referenciaExterna,
    }), 200);
    const vencida = await esperarHasta(async () => {
      const f = await filaId(fila.id);
      return f.estado === 'vencido' ? f : null;
    });
    assert.ok(vencida, 'el webhook EXPIRED verificado no vencio el pago');
    assert.strictEqual(vencida.metadata_sanitizada?.expirado_por_proveedor, true,
      'no quedo rastro de que el vencimiento lo declaro el proveedor');
    const p = await pedidoDe(folio);
    assert.strictEqual(p.estado, 'cancelado', 'el pedido siguio esperando indefinidamente tras el EXPIRED');
    assert.strictEqual(p.datos?.expirado_por_pago, true, 'el pedido no quedo marcado como expirado por pago');
  });

  // ═══ 9. Webhook EXPIRED duplicado -> idempotente ══════════════════════════
  await t('9. webhook EXPIRED duplicado -> mismo resultado, ninguna segunda transicion', async () => {
    assert.ok(filaCaso8, 'el caso 8 debio dejar su fixture');
    const antes = await filaId(filaCaso8.id);
    const pAntes = await pedidoDe(folioCaso8);
    assert.strictEqual(await webhookClip({
      resource: 'CHECKOUT', resource_status: 'EXPIRED',
      me_reference_id: filaCaso8.referencia_interna,
    }), 200);
    await new Promise(res => setTimeout(res, 800));
    const despues = await filaId(filaCaso8.id);
    const pDespues = await pedidoDe(folioCaso8);
    assert.strictEqual(despues.estado, 'vencido');
    assert.strictEqual(pDespues.estado, 'cancelado');
    assert.strictEqual(despues.metadata_sanitizada?.expirado_por_proveedor_at,
      antes.metadata_sanitizada?.expirado_por_proveedor_at,
      'el duplicado reescribio el rastro del vencimiento (no fue idempotente)');
    assert.strictEqual(pDespues.datos?.expirado_at, pAntes.datos?.expirado_at,
      'el duplicado volvio a expirar el pedido');
  });

  // ═══ 10. Sin webhook: el vencimiento LOCAL sigue mandando ════════════════
  await t('10. sin ningun webhook, xabor_espera_hasta vence localmente igual que siempre', async () => {
    const folio = folioNuevo();
    await pedido(folio, 320);
    await crearEnlace(folio);
    const [fila] = await filas(folio);
    await vencerYa(fila.id);
    const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');
    assert.ok((await expirarPagosVencidos()) >= 1);
    assert.strictEqual((await filaId(fila.id)).estado, 'vencido');
    assert.strictEqual((await pedidoDe(folio)).estado, 'cancelado');
  });

  // ═══ 11. Requery devuelve EXPIRED -> mapping correcto ════════════════════
  await t('11. requery con CHECKOUT_EXPIRED -> transicion comun a vencido; jamas pagado/fallido/cancelado arbitrario', async () => {
    const folio = folioNuevo();
    await pedido(folio, 330);
    const r = await crearEnlace(folio);
    const [fila] = await filas(folio);
    const { procesarExpiracionProveedorClip } = await import('../src/services/webhookPagos.js');

    // Con el checkout vivo, el requery-EXPIRED no hace nada.
    let res = await procesarExpiracionProveedorClip({ pago: await filaId(fila.id), checkoutId: r.referenciaExterna });
    assert.strictEqual(res.ok, false);
    assert.match(res.razon, /no_vencido_en_proveedor:CHECKOUT_PENDING/);

    CHECKOUTS.get(r.referenciaExterna).estado = 'EXPIRED';
    res = await procesarExpiracionProveedorClip({ pago: await filaId(fila.id), checkoutId: r.referenciaExterna });
    assert.strictEqual(res.ok, true, `no vencio: ${res.razon}`);
    const f = await filaId(fila.id);
    assert.strictEqual(f.estado, 'vencido',
      `EXPIRED se mapeo a '${f.estado}' -- debe ser exactamente 'vencido', nunca pagado/fallido/cancelado`);
    assert.strictEqual((await pedidoDe(folio)).estado, 'cancelado');

    // Y si el proveedor dijera COMPLETED, este camino NUNCA vence: el dinero manda.
    const folio2 = folioNuevo();
    await pedido(folio2, 331);
    const r2 = await crearEnlace(folio2);
    const [fila2] = await filas(folio2);
    CHECKOUTS.get(r2.referenciaExterna).estado = 'COMPLETED';
    res = await procesarExpiracionProveedorClip({ pago: await filaId(fila2.id), checkoutId: r2.referenciaExterna });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.razon, 'en_realidad_pagado', 'un checkout PAGADO estuvo a punto de vencerse');
    assert.notStrictEqual((await filaId(fila2.id)).estado, 'vencido');
  });

  // ═══ 12. Pago TARDIO tras vencido: dinero si, cocina no ══════════════════
  await t('12. COMPLETED tardio tras vencer -> el dinero se asienta como pago_tardio y la cocina NO se libera', async () => {
    const folio = folioNuevo();
    await pedido(folio, 340);
    const r = await crearEnlace(folio);
    const [fila] = await filas(folio);
    await vencerYa(fila.id);
    const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');
    await expirarPagosVencidos();
    assert.strictEqual((await filaId(fila.id)).estado, 'vencido');

    CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip({
      resource: 'CHECKOUT', resource_status: 'COMPLETED', me_reference_id: fila.referencia_interna,
    }), 200);
    const pagada = await esperarHasta(async () => {
      const f = await filaId(fila.id);
      return f.estado === 'pagado' ? f : null;
    });
    assert.ok(pagada, 'el dinero tardio NO quedo asentado: dinero real perdido de vista');
    assert.strictEqual(pagada.metadata_sanitizada?.anomalia, 'pago_tardio');
    assert.strictEqual(pagada.derivacion_pendiente, false, 'quedo deuda de derivacion: liberaria un pedido vencido');
    const p = await pedidoDe(folio);
    assert.strictEqual(p.estado, 'cancelado', 'el pago tardio RESUCITO el pedido');
    assert.strictEqual(await comandasDe(folio), 0, 'salio comanda de un pedido vencido');
  });

  // ═══ 13. Version desfasada + COMPLETED: dinero si, cocina no ═════════════
  await t('13. el pedido cambio de version y el checkout viejo cobra -> dinero registrado, cero cocina', async () => {
    const folio = folioNuevo();
    await pedido(folio, 350);
    const r = await crearEnlace(folio);
    const [fila] = await filas(folio);
    // El pedido cambia DESPUES de crear el checkout: la version del intento
    // queda obsoleta. expires_at NO sustituye versionado.
    await pool.query(
      `UPDATE pedidos_activos SET datos = datos || $3::jsonb WHERE folio=$1 AND negocio_id=$2`,
      [folio, NEG, JSON.stringify({ total: 415, items: [{ nombre: 'Producto XL', cantidad: 1, precio_unitario: 415 }] })]);

    CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip({
      resource: 'CHECKOUT', resource_status: 'COMPLETED', me_reference_id: fila.referencia_interna,
    }), 200);
    const pagada = await esperarHasta(async () => {
      const f = await filaId(fila.id);
      return f.estado === 'pagado' ? f : null;
    });
    assert.ok(pagada, 'el dinero de la version vieja no quedo registrado');
    const p = await pedidoDe(folio);
    assert.strictEqual(p.estado, 'pendiente_pago', 'una version desfasada LIBERO el pedido a cocina');
    assert.strictEqual(await comandasDe(folio), 0, 'salio comanda con una version desfasada');
  });

  // ═══ 14. COMPLETED justo antes del limite: autorizacion normal ═══════════
  await t('14. COMPLETED antes del limite con version vigente -> el pedido se libera a cocina normalmente', async () => {
    await montarImpresion();
    const folio = folioNuevo();
    await pedido(folio, 360);
    const r = await crearEnlace(folio);
    const [fila] = await filas(folio);
    assert.ok(new Date(fila.xabor_espera_hasta).getTime() > Date.now(), 'la ventana ya estaba vencida');

    CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip({
      resource: 'CHECKOUT', resource_status: 'COMPLETED', me_reference_id: fila.referencia_interna,
    }), 200);
    const liberado = await esperarHasta(async () => {
      const p = await pedidoDe(folio);
      return p?.estado === 'nuevo' ? p : null;
    });
    assert.ok(liberado, 'un pago valido dentro de la ventana no libero el pedido');
    assert.strictEqual((await filaId(fila.id)).estado, 'pagado');
    const conComanda = await esperarHasta(async () => (await comandasDe(folio)) === 1 ? true : null);
    assert.ok(conComanda, 'no salio la comanda del pedido pagado a tiempo');
  });

  // ═══ 15. CARRERA: vencimiento local vs COMPLETED concurrentes ════════════
  await t('15. carrera timer-local vs webhook COMPLETED -> una sola decision coherente, nunca un mundo mixto', async () => {
    const folio = folioNuevo();
    await pedido(folio, 370);
    const r = await crearEnlace(folio);
    const [fila] = await filas(folio);
    CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED';
    await vencerYa(fila.id);
    const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');
    await Promise.all([
      expirarPagosVencidos(),
      webhookClip({ resource: 'CHECKOUT', resource_status: 'COMPLETED', me_reference_id: fila.referencia_interna }),
    ]);
    await esperarHasta(async () => (await filaId(fila.id)).estado === 'pagado' ? true : null, { timeoutMs: 8000 });

    const f = await filaId(fila.id);
    const p = await pedidoDe(folio);
    const comandas = await comandasDe(folio);
    const cancelado = p.estado === 'cancelado';
    const tardio = f.metadata_sanitizada?.anomalia === 'pago_tardio';
    assert.strictEqual(f.estado, 'pagado', 'el dinero real no quedo asentado en ninguna de las dos ramas');
    assert.strictEqual(cancelado, tardio,
      `mundo incoherente: pedido cancelado=${cancelado} pero pago_tardio=${tardio}`);
    if (cancelado) {
      assert.strictEqual(comandas, 0, 'el vencimiento gano y AUN ASI salio comanda');
    } else {
      assert.strictEqual(p.estado, 'nuevo', `estado final incoherente: ${p.estado}`);
    }
  });

  // ═══ 16. Creacion ambigua por timeout: sin segundo checkout, T intacta ═══
  await t('16. timeout de creacion -> creacion ambigua, CERO segundo POST, y la T durable sigue asociada al mismo intento', async () => {
    const folio = folioNuevo();
    await pedido(folio, 380);
    modoClip = 'timeout';
    const antes = REQUESTS.length;
    let fallo = null;
    try { await crearEnlace(folio); } catch (e) { fallo = e; }
    modoClip = 'normal';
    assert.ok(fallo, 'el timeout debio propagarse');
    assert.strictEqual(REQUESTS.length, antes + 1, 'el POST del timeout no quedo capturado');
    const [fila] = await filas(folio);
    assert.ok(fila.xabor_espera_hasta,
      'la T durable se perdio con el timeout: quedo fijada ANTES del POST y debe sobrevivirlo');
    const tOriginal = new Date(fila.xabor_espera_hasta).getTime();

    // Reintento: Clip no permite buscar por referencia -> fail closed, CERO
    // segundo POST, y la MISMA T durable.
    let fallo2 = null;
    try { await crearEnlace(folio); } catch (e) { fallo2 = e; }
    assert.strictEqual(fallo2?.code, 'CREACION_AMBIGUA',
      `el reintento debio quedar en revision (obtenido: ${fallo2?.code || fallo2?.message})`);
    assert.strictEqual(REQUESTS.length, antes + 1,
      'el reintento mando un SEGUNDO POST de creacion: dos cobros reales posibles');
    const [fila2] = await filas(folio);
    assert.strictEqual(new Date(fila2.xabor_espera_hasta).getTime(), tOriginal,
      'el reintento reinvento la frontera durable: la expiracion debe viajar con el mismo intento');
  });

  // ═══ 17. Dos negocios: nada cruza tenant ═════════════════════════════════
  await t('17. dos negocios -> checkout y expiracion jamas cruzan de tenant', async () => {
    await conectarClip(NEG_B);
    const folioA = folioNuevo(), folioB = folioNuevo();
    await pedido(folioA, 390, { negocioId: NEG });
    await pedido(folioB, 395, { negocioId: NEG_B });
    const rA = await crearEnlace(folioA, NEG);
    const rB = await crearEnlace(folioB, NEG_B);
    assert.notStrictEqual(rA.referenciaExterna, rB.referenciaExterna);
    const [fA] = await filas(folioA, NEG);
    const [fB] = await filas(folioB, NEG_B);
    assert.ok(fA.xabor_espera_hasta && fB.xabor_espera_hasta);

    // El EXPIRED (verificado) del checkout de A no puede tocar la fila de B.
    CHECKOUTS.get(rA.referenciaExterna).estado = 'EXPIRED';
    const { procesarExpiracionProveedorClip } = await import('../src/services/webhookPagos.js');
    const res = await procesarExpiracionProveedorClip({ pago: await filaId(fA.id), checkoutId: rA.referenciaExterna });
    assert.strictEqual(res.ok, true);
    assert.strictEqual((await filaId(fA.id)).estado, 'vencido');
    assert.strictEqual((await filaId(fB.id)).estado, 'pendiente',
      'el vencimiento del checkout de A toco la fila de B');
    assert.strictEqual((await pedidoDe(folioB, NEG_B)).estado, 'pendiente_pago');
  });

  // ═══ 18. Mercado Pago: cero regresion ═════════════════════════════════════
  await t('18. Mercado Pago no cambia: crea igual, con su frontera local, sin campos de Clip', async () => {
    await conectarMP(NEG);
    const folio = folioNuevo();
    await pedido(folio, 400);
    const r = await crearEnlace(folio);
    assert.ok(r.url, 'MP no creo el enlace');
    const [fila] = await filas(folio);
    assert.strictEqual(fila.proveedor, 'mercado_pago');
    assert.ok(fila.xabor_espera_hasta, 'MP perdio su frontera local');
    // El payload que viajo a MP no gano ningun campo nuevo de este bloque.
    const pref = PREFERENCIAS.get(fila.preference_id) || [...PREFERENCIAS.values()].pop();
    assert.ok(pref, 'el mock de MP no capturo la preferencia');
    assert.strictEqual(pref.body.expires_at, undefined,
      'el adaptador de MP gano un expires_at estilo Clip: regresion de alcance');
    assert.ok(!fila.metadata_sanitizada?.requested_expires_at,
      'la fila de MP gano metadata de expiracion de Clip');
    // Restaurar Clip como principal para cualquier caso posterior.
    await conectarClip(NEG);
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL: ' + e.message);
} finally {
  try { if (srv) await srv.detener(); } catch { /* ya abajo */ }
  clipMock.close();
  mpMock.close();
  await desmontarImpresion().catch(() => {});
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-clip-expires-at: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
