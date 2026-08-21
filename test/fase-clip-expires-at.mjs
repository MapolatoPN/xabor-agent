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
//   · Campo request: `expires_at`, string, formato "YYYY-MM-DDTHH:MM:SSZ"
//     (UTC, maxLength 20 -- SEGUNDOS, sin milisegundos).
//   · Limites: "mayor a 00:01:00 minuto de la hora de creacion y menor a las
//     23:59:59 (hora de CDMX) del mismo dia de creacion". Default si se
//     omite: 3 dias.
//   · CLIP-D: el objeto checkout v2 (creacion y GET) lleva `expires_at`
//     (frontera PROGRAMADA, ejemplo oficial "2024-10-26T13:17:00Z");
//     `expired_at` es OTRO campo (webhook / checkout YA vencido: instante en
//     que efectivamente expiro). Los schemas de referencia viejos aun listan
//     `expired_at` en creacion/GET -- inconsistencia documentada, sin alias.
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
const GETS = [];                  // ids consultados por GET /v2/checkout/:id
const GET_CAIDO = new Set();      // ids cuyo GET se cae (socket destruido)
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
      // CLIP-D: el objeto checkout v2 documenta `expires_at` (frontera
      // PROGRAMADA, ejemplo oficial "2024-10-26T13:17:00Z" en la intro de
      // Clip Checkout). `expired_at` es OTRO campo (webhook: instante en que
      // YA expiro). Un checkout VIVO jamas trae expired_at aqui.
      let expiresAt;
      const solicitado = body.expires_at ? Date.parse(body.expires_at) : null;
      if (modoClip === 'ajusta' && solicitado) expiresAt = new Date(solicitado + 6 * 3600e3).toISOString();
      else if (modoClip === 'ajusta999ms' && solicitado) expiresAt = new Date(solicitado + 999).toISOString();
      else if (modoClip === 'ajusta1000ms' && solicitado) expiresAt = new Date(solicitado + 1000).toISOString();
      else if (modoClip === 'ajusta1001ms' && solicitado) expiresAt = new Date(solicitado + 1001).toISOString();
      else if (modoClip === 'ajusta2s' && solicitado) expiresAt = new Date(solicitado + 2000).toISOString();
      else if (modoClip === 'adelanta1s' && solicitado) expiresAt = new Date(solicitado - 1000).toISOString();
      else if (modoClip === 'adelanta' && solicitado) expiresAt = new Date(solicitado - 10 * 60e3).toISOString();
      else if (solicitado) expiresAt = new Date(solicitado).toISOString();
      else expiresAt = new Date(Date.now() + 3 * 24 * 3600e3).toISOString(); // default documentado: 3 dias
      CHECKOUTS.set(id, {
        referencia: body.metadata?.external_reference || null,
        estado: 'PENDING', monto: Number(body.amount),
        // 'sin_expiracion_nunca': ni la creacion ni el GET traen expires_at.
        expiresAt: modoClip === 'sin_expiracion_nunca' ? null : expiresAt,
        expiredAt: null, // instante REAL de expiracion: solo cuando ocurra
      });
      const respuesta = {
        payment_request_id: id, object_type: 'payment_link', status: 'CHECKOUT_CREATED',
        payment_request_url: `https://pago.mock.clip/${id}`,
        created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        expires_at: expiresAt,
      };
      // 'con_expired_null': algunas respuestas reales pueden traer AMBOS
      // campos con expired_at:null mientras el checkout vive -- null NUNCA
      // debe leerse como "no verificable".
      if (modoClip === 'con_expired_null') respuesta.expired_at = null;
      // 'sin_expiracion': la RESPUESTA DE CREACION omite expires_at, pero el
      // GET si lo trae (se verifica por reconsulta antes de exponer).
      if (modoClip === 'sin_expiracion' || modoClip === 'sin_expiracion_nunca') delete respuesta.expires_at;
      res.end(JSON.stringify(respuesta));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v2/checkout/')) {
      const id = decodeURIComponent(req.url.split('/').pop());
      GETS.push(id);
      if (GET_CAIDO.has(id)) { req.socket.destroy(); return; }
      const c = CHECKOUTS.get(id);
      if (!c) { res.statusCode = 404; res.end('{}'); return; }
      const status = c.estado === 'COMPLETED' ? 'CHECKOUT_COMPLETED'
        : c.estado === 'EXPIRED' ? 'CHECKOUT_EXPIRED'
        : c.estado === 'CANCELLED' ? 'CHECKOUT_CANCELLED' : 'CHECKOUT_PENDING';
      const cuerpoGet = {
        object_type: 'payment_link', payment_request_id: id, status,
        amount: c.monto ?? null, currency: 'MXN',
        metadata: { external_reference: c.referencia, customer_info: {} },
        payment_request_url: `https://completa-tu-pago.payclip.com/${id}`,
        created_at: '2026-08-19T00:00:00Z',
        // v2: la frontera PROGRAMADA viaja como expires_at tambien en el GET.
        expires_at: c.expiresAt || null,
        last_status_message: status,
      };
      // Solo un checkout que YA expiro lleva el instante real del evento.
      if (c.estado === 'EXPIRED') cuerpoGet.expired_at = c.expiredAt || c.expiresAt || null;
      res.end(JSON.stringify(cuerpoGet));
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
      `expires_at no va en el formato oficial de Clip (YYYY-MM-DDTHH:MM:SSZ, UTC, sin milisegundos): ${req.expires_at}`);
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
    // Determinismo de fin de dia: si esta suite corre cerca de la medianoche
    // CDMX, T puede cruzar el dia y el codigo la ACOTA (legitimamente) al
    // tope 23:59:00 CDMX. Lo que se exige entonces es que lo enviado sea
    // exactamente min(T, tope) -- nunca un tercer valor. La tolerancia es 1s
    // por el truncado a SEGUNDOS de Clip -- jamas minutos.
    const { finDelDiaCDMXComoUTC } = await import('../src/services/clip-api.js');
    const esperado = Math.min(durable, finDelDiaCDMXComoUTC(new Date()));
    const diff = Math.abs(enviado - esperado);
    assert.ok(diff < 1000,
      `expires_at enviado a Clip (${req.expires_at}) y la frontera esperada min(T, tope CDMX) (${new Date(esperado).toISOString()}) difieren ${Math.round(diff / 1000)}s: dos relojes que pueden divergir en vez de UNA frontera`);
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
    // Contrato del adaptador tras el fix external_reference<=36: exige pagoId
    // (pagos.id viaja como external_reference). El invariante probado aqui no
    // cambia: la expiracion invalida se rechaza ANTES de cualquier POST.
    await assert.rejects(
      () => createPaymentLink({
        negocioId: NEG, pedidoId: folio, total: 100, descripcion: 'x',
        cliente: {}, pagoId: '00000000-0000-4000-8000-0000000cea04', expiresAt: new Date('no-es-fecha'),
      }),
      /ExpiracionInvalidaError/, 'un expiresAt invalido debio rechazarse antes del POST');
    await assert.rejects(
      () => createPaymentLink({
        negocioId: NEG, pedidoId: folio, total: 100, descripcion: 'x',
        cliente: {}, pagoId: '00000000-0000-4000-8000-0000000cea04', expiresAt: new Date(Date.now() - 60e3),
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
  await t('6. CLIP-C: expiracion del proveedor 6h mas tardia -> identidad durable SI, URL al cliente NO, revision, retry sin segundo POST', async () => {
    const folio = folioNuevo();
    await pedido(folio, 290);
    modoClip = 'ajusta';
    const antes = REQUESTS.length;
    const r = await crearEnlace(folio);
    modoClip = 'normal';
    const req = REQUESTS[antes];
    const [fila] = await filas(folio);

    // El POST YA ocurrio: la identidad externa se conserva DURABLE (impide
    // un segundo checkout) junto con ambas fronteras.
    assert.ok(fila.referencia_externa, 'se perdio la identidad externa del checkout ya creado');
    assert.ok(fila.url, 'la URL debe conservarse en la fila (identidad), aunque jamas se ofrezca');
    assert.ok(fila.metadata_sanitizada?.requested_expires_at && fila.metadata_sanitizada?.provider_expires_at,
      'no quedaron durables las dos fronteras (solicitada y del proveedor)');
    assert.strictEqual(fila.metadata_sanitizada?.expiracion_proveedor_mas_larga, true,
      'la anomalia expiracion_proveedor_mas_larga no quedo marcada');

    // Pero un enlace que acepta dinero 6h despues de la frontera local NO se
    // entrega al cliente: fail closed, requiere revision.
    assert.ok(!r.url,
      `crearEnlacePago devolvio una URL utilizable (${r.url}) con una expiracion del proveedor 6h MAS LARGA que la solicitada: ese enlace acepta dinero fuera de la ventana de Xabor`);
    assert.strictEqual(r.requiereRevision, true, 'el resultado no quedo marcado como requiere revision');
    assert.strictEqual(fila.estado, 'requiere_revision',
      `la fila debe quedar fail-closed en requiere_revision -- obtenido ${fila.estado}`);

    // La frontera local NO se amplio.
    const solicitado = Date.parse(req.expires_at);
    const local = new Date(fila.xabor_espera_hasta).getTime();
    assert.ok(Math.abs(local - solicitado) < 1000,
      `xabor_espera_hasta se movio tras la respuesta del proveedor: local=${new Date(local).toISOString()} vs solicitado=${req.expires_at}`);
    const proveedor = new Date(fila.expires_at).getTime();
    assert.ok(Math.abs(proveedor - (solicitado + 6 * 3600e3)) < 1000,
      'pagos.expires_at no registro la frontera EFECTIVA (mas tardia) del proveedor');

    // Retry: CERO segundo POST, y tampoco entrega la URL peligrosa en silencio.
    const antesRetry = REQUESTS.length;
    const r2 = await crearEnlace(folio);
    assert.strictEqual(REQUESTS.length, antesRetry,
      'el reintento mando un SEGUNDO POST con el checkout A todavia cobrable');
    assert.ok(!r2.url,
      'el reintento devolvio en silencio la URL peligrosa que la primera llamada se nego a entregar');
    assert.strictEqual(r2.requiereRevision, true, 'el reintento no aviso que la fila requiere revision');
  });

  // ═══ 7. El proveedor devuelve una expiracion MAS TEMPRANA ════════════════
  await t('7. Clip devuelve una expiracion 10min mas temprana -> la frontera efectiva queda conocida; la local no se toca', async () => {
    const folio = folioNuevo();
    await pedido(folio, 300);
    modoClip = 'adelanta';
    const antes = REQUESTS.length;
    const r = await crearEnlace(folio);
    modoClip = 'normal';
    const req = REQUESTS[antes];
    const [fila] = await filas(folio);
    // "Igual o mas estricta" ES aceptable: el enlace SI se entrega.
    assert.ok(r.url, 'una expiracion del proveedor MAS CORTA es legitima y el enlace debio entregarse');
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
    // El rastro (expirado_por_proveedor) se anota en un UPDATE separado
    // DESPUES del COMMIT de la transicion comun -- perder ese anexo en un
    // crash solo pierde la anotacion informativa, nunca el vencimiento.
    // Leerlo con una sola consulta en cuanto aparece estado='vencido' es una
    // carrera de LECTURA del test (cazada de verdad en el gate): se espera
    // acotado a que AMBAS escrituras aterricen.
    const vencida = await esperarHasta(async () => {
      const f = await filaId(fila.id);
      return (f.estado === 'vencido' && f.metadata_sanitizada?.expirado_por_proveedor === true) ? f : null;
    });
    assert.ok(vencida, `el webhook EXPIRED verificado no vencio el pago con su rastro (obtenido: ${JSON.stringify((await filaId(fila.id)).estado)})`);
    // CLIP-D: los dos campos no se confunden -- provider_expires_at es la
    // frontera PROGRAMADA (expires_at del GET) y provider_expired_at, si
    // existe, es el instante REAL en que expiro (expired_at del checkout ya
    // vencido). La decision vino del GET autenticado, nunca del webhook.
    assert.ok(vencida.metadata_sanitizada?.provider_expires_at,
      'no quedo la frontera programada declarada por el proveedor (provider_expires_at)');
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

  // ═══ 19. CLIP-A: sin ventana valida -> CERO POST (reloj determinista) ════
  //
  // Contrato oficial: expires_at debe ser simultaneamente > creacion + 1 min
  // y < 23:59:59 CDMX del mismo dia. En el ultimo minuto del dia CDMX no
  // existe NINGUN valor que cumpla ambas. La salida correcta es fallar
  // tipado ANTES del POST -- jamas omitir el campo y dejar que Clip cree un
  // checkout con su default de 3 DIAS (eso reproduce el bug original), ni
  // esperar a que Clip devuelva 400. Reloj inyectado (XABOR_TEST_CLIP_AHORA):
  // nunca depende de la hora real a la que corra la suite.
  await t('19. CLIP-A: creacion en el ultimo minuto del dia CDMX -> ExpiracionInvalidaError y CERO POST (nunca un checkout de 3 dias)', async () => {
    const { prepararExpiracionClip } = await import('../src/services/clip-api.js');
    // 2026-08-19T05:58:30Z == 2026-08-18 23:58:30 CDMX (UTC-6): el tope
    // (23:59:00 CDMX) queda a 30s, menos del minimo de 61s de Clip.
    const sinVentana = '2026-08-19T05:58:30.000Z';
    // Unit, con fechas fijas: debe LANZAR, nunca devolver "omitir".
    assert.throws(
      () => prepararExpiracionClip(new Date(Date.now() + 30 * 60e3), new Date(sinVentana)),
      /ExpiracionInvalidaError/,
      'sin ventana valida de Clip, prepararExpiracionClip debio lanzar tipado -- devolvio otra cosa (¿omitir?)');

    // Flujo productivo completo, mismo reloj inyectado.
    const folio = folioNuevo();
    await pedido(folio, 410);
    process.env.XABOR_TEST_CLIP_AHORA = sinVentana;
    const antes = REQUESTS.length;
    let fallo = null;
    try { await crearEnlace(folio); } catch (e) { fallo = e; }
    delete process.env.XABOR_TEST_CLIP_AHORA;
    assert.strictEqual(fallo?.code, 'EXPIRACION_INVALIDA',
      `crearEnlacePago debio fallar tipado sin ventana valida (obtenido: ${fallo?.code || fallo?.message || 'exito'})`);
    assert.strictEqual(REQUESTS.length, antes,
      `SALIO UN POST sin ventana valida: expires_at=${JSON.stringify(REQUESTS[REQUESTS.length - 1]?.expires_at)} -- un checkout con default de 3 dias del proveedor`);
    const [fila] = await filas(folio);
    assert.ok(!fila?.referencia_externa && !fila?.url, 'quedo un checkout creado pese a no existir ventana valida');
  });

  // ═══ 20. Relojes deterministas: mediodia, cerca del limite, cruce de dia ═
  await t('20. relojes fijos: mediodia -> T intacta; 23:50+5min -> valido sin ajuste; T cruza medianoche -> clamp al tope CDMX', async () => {
    const { prepararExpiracionClip, formatearExpiracionClip, finDelDiaCDMXComoUTC } =
      await import('../src/services/clip-api.js');
    // A) mediodia CDMX (18:00Z = 12:00 CDMX): T = +30min cabe entera.
    const mediodia = new Date('2026-08-19T18:00:00.000Z');
    const tA = new Date(mediodia.getTime() + 30 * 60e3);
    const a = prepararExpiracionClip(tA, mediodia);
    assert.strictEqual(a.texto, formatearExpiracionClip(tA), 'a mediodia el instante enviado debe ser T exacta');
    assert.strictEqual(a.ajustadaPorLimite, false);
    // B) 23:50 CDMX (05:50Z del dia siguiente UTC), T = +5min (23:55 CDMX):
    // todavia valida, sin ajuste.
    const tarde = new Date('2026-08-19T05:50:00.000Z'); // 2026-08-18 23:50 CDMX
    const tB = new Date(tarde.getTime() + 5 * 60e3);
    const b = prepararExpiracionClip(tB, tarde);
    assert.strictEqual(b.texto, formatearExpiracionClip(tB), 'cerca del limite pero valida: debe viajar T exacta');
    assert.strictEqual(b.ajustadaPorLimite, false);
    // D) 23:00 CDMX, T = +90min (cruza medianoche): politica explicita --
    // se ACOTA al tope 23:59:00 CDMX del dia de creacion (la ventana del
    // proveedor queda MAS estricta que T, nunca mas laxa) y queda marcada.
    const noche = new Date('2026-08-19T05:00:00.000Z'); // 2026-08-18 23:00 CDMX
    const tD = new Date(noche.getTime() + 90 * 60e3);
    const d = prepararExpiracionClip(tD, noche);
    assert.strictEqual(d.ajustadaPorLimite, true, 'un T que cruza medianoche CDMX debe quedar acotado y marcado');
    assert.strictEqual(d.epochMs, finDelDiaCDMXComoUTC(noche), 'el clamp no cayo exactamente en el tope del dia CDMX');
    assert.ok(d.epochMs < tD.getTime(), 'el clamp debe ser MAS estricto que T, jamas mas laxo');
  });

  // ═══ 21. CLIP-B: sin T durable -> CERO POST ══════════════════════════════
  await t('21. CLIP-B: si la frontera durable no pudo fijarse, NO hay POST al proveedor (fail closed, no un warn)', async () => {
    const folio = folioNuevo();
    await pedido(folio, 420);
    process.env.XABOR_PAGOS_FALLA_EN = 'fijar_espera_sin_t';
    const antes = REQUESTS.length;
    let fallo = null;
    try { await crearEnlace(folio); } catch (e) { fallo = e; }
    delete process.env.XABOR_PAGOS_FALLA_EN;
    assert.ok(fallo, 'crearEnlacePago debio fallar sin frontera durable');
    assert.strictEqual(fallo?.code, 'SIN_FRONTERA_DURABLE',
      `el fallo debe ser tipado SIN_FRONTERA_DURABLE (obtenido: ${fallo?.code || fallo?.message})`);
    assert.strictEqual(REQUESTS.length, antes,
      'SALIO UN POST sin frontera durable: un checkout sin ninguna expiracion atada a T');
    const [fila] = await filas(folio);
    assert.ok(!fila?.referencia_externa && !fila?.url, 'quedo un checkout creado sin frontera durable');
  });

  // ═══ 22. expired_at ausente en la creacion -> verificar antes de exponer ═
  await t('22. la creacion no trae expires_at -> se reconsulta antes de exponer; si tampoco el GET lo trae, cero URL y revision', async () => {
    // La documentacion oficial LISTA expired_at en la respuesta de creacion
    // pero no lo garantiza como no-nulo; el GET de estado si lo documenta.
    // Politica: sin expiracion efectiva VERIFICADA no se expone el enlace.
    // 22a: la creacion lo omite, el GET lo trae -> se verifica y se entrega.
    const folioA = folioNuevo();
    await pedido(folioA, 430);
    modoClip = 'sin_expiracion';
    const rA = await crearEnlace(folioA);
    modoClip = 'normal';
    assert.ok(rA.url, 'con la expiracion verificada por reconsulta, el enlace debio entregarse');
    const [fA] = await filas(folioA);
    assert.ok(fA.expires_at, 'pagos.expires_at debio poblarse con el valor verificado por el GET');
    assert.strictEqual(fA.metadata_sanitizada?.expiracion_verificada_por_reconsulta, true,
      'no quedo rastro de que la expiracion se verifico por reconsulta');

    // 22b: ni la creacion ni el GET la traen -> identidad durable, cero URL.
    const folioB = folioNuevo();
    await pedido(folioB, 431);
    modoClip = 'sin_expiracion_nunca';
    const rB = await crearEnlace(folioB);
    modoClip = 'normal';
    assert.ok(!rB.url,
      'se entrego una URL cuya expiracion efectiva NADIE pudo verificar');
    assert.strictEqual(rB.requiereRevision, true);
    const [fB] = await filas(folioB);
    assert.ok(fB.referencia_externa, 'la identidad del checkout creado debe conservarse');
    assert.strictEqual(fB.estado, 'requiere_revision');
    assert.strictEqual(fB.metadata_sanitizada?.expiracion_proveedor_no_verificable, true);
    // Retry: cero POST nuevo y sin URL.
    const antesRetry = REQUESTS.length;
    const rB2 = await crearEnlace(folioB);
    assert.strictEqual(REQUESTS.length, antesRetry, 'el reintento creo un segundo checkout');
    assert.ok(!rB2.url, 'el reintento entrego la URL no verificable');
  });

  // ═══ 23. CLIP-D: checkout vivo con expires_at=T y expired_at=null ════════
  await t('23. CLIP-D: la respuesta viva trae expires_at=T y expired_at=null -> se usa T; expired_at null JAMAS significa "no verificable"', async () => {
    const folio = folioNuevo();
    await pedido(folio, 440);
    modoClip = 'con_expired_null';
    const antes = REQUESTS.length;
    const r = await crearEnlace(folio);
    modoClip = 'normal';
    const req = REQUESTS[antes];
    assert.ok(r.url, 'un checkout vivo con expires_at valido y expired_at:null se trato como no verificable y se oculto la URL');
    assert.ok(!r.requiereRevision, 'quedo marcado para revision sin motivo');
    const [fila] = await filas(folio);
    assert.strictEqual(fila.estado, 'pendiente');
    assert.ok(Math.abs(new Date(fila.expires_at).getTime() - Date.parse(req.expires_at)) < 1000,
      'pagos.expires_at no uso la frontera PROGRAMADA (expires_at) que el proveedor declaro');
    assert.ok(fila.metadata_sanitizada?.provider_expires_at
      && Math.abs(Date.parse(fila.metadata_sanitizada.provider_expires_at) - Date.parse(req.expires_at)) < 1000,
      'provider_expires_at no registro la frontera programada');
    assert.ok(!fila.metadata_sanitizada?.expiracion_proveedor_no_verificable,
      'expired_at:null se leyo como expiracion no verificable');
    assert.ok(!fila.metadata_sanitizada?.provider_expired_at,
      'se guardo una fecha PROGRAMADA bajo el nombre provider_expired_at (semantica en pasado falsa)');
  });

  // ═══ CLIP-E: expires_at NO es prueba de "no hubo pago" ═══════════════════
  // El servidor compartido de los casos 8-15 se detiene aqui: cada caso E
  // arranca su PROPIO servidor fresco para que el reconciliador PRODUCTIVO
  // real (reconciliarPagosPendientes corre al arrancar, server.js) sea quien
  // haga el trabajo -- jamas una llamada directa de settlement del test.
  if (srv) { await srv.detener(); srv = null; await esperar(500); }

  const moverFronterasAlPasado = (pagoId) => pool.query(
    `UPDATE pagos SET expires_at = NOW() - interval '2 minutes',
                      xabor_espera_hasta = NOW() - interval '2 minutes'
      WHERE id=$1`, [pagoId]);
  const getsDe = (id) => GETS.filter(g => g === id).length;

  await t('24. CLIP-E: COMPLETED justo antes de expires_at + webhook perdido + reconciliador despues del limite -> el dinero se recupera', async () => {
    const folio = folioNuevo();
    await pedido(folio, 450);
    const r = await crearEnlace(folio);
    const [fila] = await filas(folio);
    // El cliente PAGO dentro de la ventana; el webhook se pierde (nunca se manda).
    CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED';
    // Reloj determinista: ambas fronteras quedan en el pasado EN LA BASE --
    // nunca depender de la hora real a la que corra la suite.
    await moverFronterasAlPasado(fila.id);

    const getsAntes = getsDe(r.referenciaExterna);
    const srvE = await arrancarServidor({ PORT: String(PUERTO) }, { timeoutMs: 90000 });
    try {
      const pagada = await esperarHasta(async () => {
        const f = await filaId(fila.id);
        return f.estado === 'pagado' ? f : null;
      }, { timeoutMs: 15000 });
      const getsNuevos = getsDe(r.referenciaExterna) - getsAntes;
      assert.ok(getsNuevos > 0,
        `CLIP-E: la fila con expires_at ya pasado salio del barrido y NUNCA se reconsulto al proveedor (GETs nuevos=${getsNuevos}) -- un webhook perdido se volvio dinero perdido del ledger`);
      assert.ok(pagada, 'el COMPLETED previo al limite no se asento: dinero real invisible para Xabor');
    } finally { await srvE.detener(); await esperar(400); }
  });

  await t('25. CLIP-E: mismo rescate pero el pedido YA vencio localmente -> pagado + pago_tardio + cero cocina', async () => {
    const folio = folioNuevo();
    await pedido(folio, 455);
    const r = await crearEnlace(folio);
    const [fila] = await filas(folio);
    CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED';
    await moverFronterasAlPasado(fila.id);
    // El expirador LOCAL corre primero (job real): pedido cancelado, fila vencida.
    const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');
    await expirarPagosVencidos();
    assert.strictEqual((await filaId(fila.id)).estado, 'vencido');
    assert.strictEqual((await pedidoDe(folio)).estado, 'cancelado');

    const srvE = await arrancarServidor({ PORT: String(PUERTO) }, { timeoutMs: 90000 });
    try {
      const pagada = await esperarHasta(async () => {
        const f = await filaId(fila.id);
        return f.estado === 'pagado' ? f : null;
      }, { timeoutMs: 15000 });
      assert.ok(pagada, 'el dinero del COMPLETED previo al limite no se recupero tras vencer localmente');
      assert.strictEqual(pagada.metadata_sanitizada?.anomalia, 'pago_tardio', 'el rescate tardio no quedo marcado');
      assert.strictEqual((await pedidoDe(folio)).estado, 'cancelado', 'el rescate tardio RESUCITO el pedido');
      assert.strictEqual(await comandasDe(folio), 0, 'salio comanda de un pedido vencido');
    } finally { await srvE.detener(); await esperar(400); }
  });

  let filaE3 = null, checkoutE3 = null;
  await t('26. CLIP-E: tras expires_at el GET devuelve CHECKOUT_EXPIRED -> terminal verificado DURABLE', async () => {
    const folio = folioNuevo();
    await pedido(folio, 460);
    const r = await crearEnlace(folio);
    const [fila] = await filas(folio);
    filaE3 = fila; checkoutE3 = r.referenciaExterna;
    CHECKOUTS.get(r.referenciaExterna).estado = 'EXPIRED';
    await moverFronterasAlPasado(fila.id);

    const srvE = await arrancarServidor({ PORT: String(PUERTO) }, { timeoutMs: 90000 });
    try {
      const terminal = await esperarHasta(async () => {
        const f = await filaId(fila.id);
        return f.metadata_sanitizada?.provider_terminal_status === 'CHECKOUT_EXPIRED' ? f : null;
      }, { timeoutMs: 15000 });
      assert.ok(terminal, 'la evidencia terminal autenticada no quedo durable');
      assert.ok(terminal.metadata_sanitizada?.provider_terminal_verified_at, 'sin instante de verificacion terminal');
      assert.strictEqual(terminal.estado, 'vencido', 'la transicion comun no vencio la fila');
    } finally { await srvE.detener(); await esperar(400); }
  });

  await t('27. CLIP-E: con el terminal EXPIRED verificado, la siguiente ronda NO vuelve a golpear al proveedor', async () => {
    assert.ok(filaE3 && checkoutE3, 'el caso 26 debio dejar su fixture');
    const { pagosReconciliablesDeProveedor } = await import('../src/services/database.js');
    const cola = (await pagosReconciliablesDeProveedor('clip', 200)).map(p => p.id);
    assert.ok(!cola.includes(filaE3.id),
      'una fila con terminal EXPIRED verificado sigue ocupando el barrido para siempre');
    const getsAntes = getsDe(checkoutE3);
    const srvE = await arrancarServidor({ PORT: String(PUERTO) }, { timeoutMs: 90000 });
    try {
      await esperar(3500); // margen para la pasada de arranque completa
      assert.strictEqual(getsDe(checkoutE3), getsAntes,
        'la ronda posterior al terminal verificado volvio a consultar el checkout');
    } finally { await srvE.detener(); await esperar(400); }
  });

  await t('28. CLIP-E: el GET falla despues de expires_at -> la fila SIGUE reconciliable, jamas "seguro no hubo dinero"', async () => {
    const folio = folioNuevo();
    await pedido(folio, 465);
    const r = await crearEnlace(folio);
    const [fila] = await filas(folio);
    CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED'; // hay dinero... pero el GET se cae
    await moverFronterasAlPasado(fila.id);
    GET_CAIDO.add(r.referenciaExterna);
    const srvE = await arrancarServidor({ PORT: String(PUERTO) }, { timeoutMs: 90000 });
    try {
      await esperarHasta(async () => getsDe(r.referenciaExterna) > 0 ? true : null, { timeoutMs: 10000 });
      await esperar(800);
      const f = await filaId(fila.id);
      assert.notStrictEqual(f.estado, 'pagado', 'se asento dinero sin respuesta del proveedor');
      assert.ok(!f.metadata_sanitizada?.provider_terminal_status,
        'un GET caido se convirtio en evidencia terminal: "no pude preguntar" NUNCA es "seguro no hubo dinero"');
    } finally {
      GET_CAIDO.delete(r.referenciaExterna);
      await srvE.detener(); await esperar(400);
    }
    const { pagosReconciliablesDeProveedor } = await import('../src/services/database.js');
    const cola = (await pagosReconciliablesDeProveedor('clip', 200)).map(p => p.id);
    assert.ok(cola.includes(fila.id), 'la fila con GET caido salio del barrido');
    // Y cuando el proveedor vuelve, el dinero se recupera (sin webhook). El
    // expirador local del arranque ya pudo haber vencido el pedido mientras
    // el GET estaba caido: entonces el rescate es un pago TARDIO -- dinero
    // SI, cocina NO -- que es exactamente el invariante.
    const { verificarYAsentarClip } = await import('../src/services/webhookPagos.js');
    const rec = await verificarYAsentarClip({ pago: await filaId(fila.id), checkoutId: r.referenciaExterna });
    assert.ok(rec.ok === true || rec.razon === 'transicion_pago_tardio',
      `al volver el proveedor no se recupero: ${rec.razon}`);
    assert.strictEqual((await filaId(fila.id)).estado, 'pagado', 'el dinero siguio sin asentarse al volver el GET');
    assert.strictEqual(await comandasDe(folio), 0, 'un rescate tras vencer localmente libero cocina');
  });

  await t('29. CLIP-E: dos instancias reconsultan a la vez tras el limite -> UNA sola transicion financiera', async () => {
    const folio = folioNuevo();
    await pedido(folio, 470);
    const r = await crearEnlace(folio);
    const [fila] = await filas(folio);
    CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED';
    await moverFronterasAlPasado(fila.id);
    // El MISMO camino compartido que usan el webhook y el reconciliador, en
    // dos "instancias" concurrentes.
    const { verificarYAsentarClip } = await import('../src/services/webhookPagos.js');
    const pagoFresco = await filaId(fila.id);
    const [ra, rb] = await Promise.all([
      verificarYAsentarClip({ pago: pagoFresco, checkoutId: r.referenciaExterna }),
      verificarYAsentarClip({ pago: pagoFresco, checkoutId: r.referenciaExterna }),
    ]);
    assert.strictEqual((await filaId(fila.id)).estado, 'pagado', 'el dinero no quedo asentado');
    const resultados = [ra, rb].map(x => `${x.ok}:${x.razon}`).sort();
    // Ambas terminan bien, pero el ledger tiene UNA sola compra real.
    const { rows: compras } = await pool.query(
      `SELECT * FROM compras_reales WHERE negocio_id=$1 AND folio=$2`, [NEG, folio]);
    assert.ok(compras.length <= 1,
      `dos reconsultas concurrentes dejaron ${compras.length} compras reales (resultados: ${resultados.join(' | ')})`);
    const { rows: [pagados] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 AND estado='pagado'`, [NEG, folio]);
    assert.strictEqual(pagados.n, 1, 'mas de una fila quedo pagada para el mismo cobro');
  });

  await t('30. CLIP-E: version desfasada completada antes del limite y recuperada despues -> dinero SI, cocina NO', async () => {
    const folio = folioNuevo();
    await pedido(folio, 475);
    const r = await crearEnlace(folio);
    const [fila] = await filas(folio);
    // El pedido cambia DESPUES del checkout: la version pagada queda obsoleta.
    await pool.query(
      `UPDATE pedidos_activos SET datos = datos || $3::jsonb WHERE folio=$1 AND negocio_id=$2`,
      [folio, NEG, JSON.stringify({ total: 520, items: [{ nombre: 'Producto XL', cantidad: 1, precio_unitario: 520 }] })]);
    CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED';
    // SOLO la frontera del proveedor pasa al pasado: asi el expirador LOCAL
    // no interfiere y el caso aisla exactamente "stale version recuperada
    // despues de expires_at" (si tambien venciera lo local, el asiento seria
    // ademas pago_tardio -- ese mundo ya lo cubren los casos 25 y 28).
    await pool.query(`UPDATE pagos SET expires_at = NOW() - interval '2 minutes' WHERE id=$1`, [fila.id]);

    const srvE = await arrancarServidor({ PORT: String(PUERTO) }, { timeoutMs: 90000 });
    try {
      const pagada = await esperarHasta(async () => {
        const f = await filaId(fila.id);
        return f.estado === 'pagado' ? f : null;
      }, { timeoutMs: 15000 });
      assert.ok(pagada, 'el dinero de la version vieja no se recupero tras el limite');
      assert.strictEqual(pagada.metadata_sanitizada?.anomalia, 'version_desfasada');
      // Margen DELIBERADO tras el asiento: la parte 2 (camino legacy por
      // clip_link_id) corre DESPUES de la parte 1 en la misma pasada. El
      // fail-open real cazado aqui era exactamente esa parte 2 liberando el
      // pedido sin gate de version milisegundos despues del asiento --
      // asertar sin este margen convertia el bug en intermitente.
      await esperar(2500);
      const pFinal = await pedidoDe(folio);
      assert.strictEqual(pFinal.estado, 'pendiente_pago',
        `una version desfasada LIBERO el pedido (estado=${pFinal.estado}, pago_confirmado=${pFinal.datos?.pago_confirmado} -- el camino legacy por clip_link_id se salto los gates del ledger)`);
      assert.strictEqual(await comandasDe(folio), 0, 'salio comanda con una version desfasada');
    } finally { await srvE.detener(); await esperar(400); }
  });

  // ═══ CLIP-F: la tolerancia es la precision del contrato (1s), no 60s ═════
  await t('31. CLIP-F: proveedor devuelve solicitada+2s -> NO URL y revision; -1s y == -> validos', async () => {
    // +2s: por encima de la precision de segundos del contrato -> peligrosa.
    const folioA = folioNuevo();
    await pedido(folioA, 480);
    modoClip = 'ajusta2s';
    const rA = await crearEnlace(folioA);
    modoClip = 'normal';
    assert.ok(!rA.url, 'una expiracion del proveedor 2s MAS LARGA entrego la URL: acepta dinero cuando Xabor ya decidio cancelar');
    assert.strictEqual(rA.requiereRevision, true, 'no quedo en revision');
    const [fA] = await filas(folioA);
    assert.strictEqual(fA.metadata_sanitizada?.expiracion_proveedor_mas_larga, true);

    // -1s: mas estricta -> legitima.
    const folioB = folioNuevo();
    await pedido(folioB, 485);
    modoClip = 'adelanta1s';
    const rB = await crearEnlace(folioB);
    modoClip = 'normal';
    assert.ok(rB.url, 'una expiracion 1s MAS CORTA es legitima y el enlace debio entregarse');

    // == exacto -> legitimo (ya cubierto por caso 5; se reafirma aqui).
    const folioC = folioNuevo();
    await pedido(folioC, 490);
    const rC = await crearEnlace(folioC);
    assert.ok(rC.url, 'el eco exacto debio entregarse');
    const [fC] = await filas(folioC);
    assert.ok(!fC.metadata_sanitizada?.expiracion_proveedor_mas_larga);
  });

  // ═══ CLIP-G: dientes de la auditoria adversarial ═════════════════════════

  await t('32. CLIP-G1: webhook perdido HORAS despues del arranque -> un ciclo NORMAL del reconciliador lo recupera, sin reiniciar nada', async () => {
    // Servidor YA VIVO con el intervalo de pruebas acelerado (candado
    // NODE_ENV; en produccion es SIEMPRE 5 min). El checkout nace y se paga
    // DESPUES de que el barrido de arranque ya corrio: solo el ciclo
    // periodico puede recuperarlo.
    const srvG = await arrancarServidor({ PORT: String(PUERTO), XABOR_PAGOS_RECONCILIACION_INTERVALO_MS: '2500' }, { timeoutMs: 90000 });
    try {
      await esperar(3000); // el barrido de ARRANQUE ya corrio y termino
      const folio = folioNuevo();
      await pedido(folio, 495);
      const r = await crearEnlace(folio);
      const [fila] = await filas(folio);
      CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED'; // paga; webhook perdido
      const pagada = await esperarHasta(async () => {
        const f = await filaId(fila.id);
        return f.estado === 'pagado' ? f : null;
      }, { timeoutMs: 15000 });
      assert.ok(pagada,
        'el ciclo periodico del reconciliador NO recupero un webhook perdido despues del arranque: solo un restart lo habria salvado');
    } finally { await srvG.detener(); await esperar(400); }
  });

  await t('33. CLIP-G2: 55 filas viejas eternamente PENDING no pueden matar de hambre a un COMPLETED reciente (rotacion real)', async () => {
    // 55 filas de ledger viejas, todas apuntando a checkouts PENDING del
    // mock: mas que el LIMIT de 50 del barrido. Sin rotacion, ocupaban los
    // primeros 50 lugares por created_at para siempre.
    const viejasIds = [];
    for (let i = 0; i < 55; i++) {
      const idCk = `clip-cea-viejo-${i}`;
      CHECKOUTS.set(idCk, { referencia: `ref-vieja-${i}`, estado: 'PENDING', monto: 100, expiresAt: null, expiredAt: null });
      const { rows: [v] } = await pool.query(
        `INSERT INTO pagos (negocio_id, pedido_folio, proveedor, referencia_interna, referencia_externa,
                            tipo, moneda, monto, estado, version_pedido_hash, created_at)
         VALUES ($1, $2, 'clip', $3, $4, 'enlace_pago', 'MXN', 100, 'pendiente', 'v-vieja', NOW() - interval '30 days')
         RETURNING id`,
        [NEG, `CEA-V${String(i).padStart(3, '0')}`, `ref-vieja-${i}`, idCk]);
      viejasIds.push(v.id);
    }
    try {
      const folio = folioNuevo();
      await pedido(folio, 500);
      const r = await crearEnlace(folio);
      const [fila] = await filas(folio);
      CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED';

      const srvG = await arrancarServidor({ PORT: String(PUERTO), XABOR_PAGOS_RECONCILIACION_INTERVALO_MS: '2000' }, { timeoutMs: 90000 });
      try {
        const pagada = await esperarHasta(async () => {
          const f = await filaId(fila.id);
          return f.estado === 'pagado' ? f : null;
        }, { timeoutMs: 20000 });
        assert.ok(pagada,
          'STARVATION: 55 filas viejas PENDING monopolizaron el ORDER BY/LIMIT y el COMPLETED reciente jamas se consulto');
        // Y la rotacion de verdad avanza: las 55 viejas quedaron estampadas.
        const { rows: [{ n }] } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM pagos WHERE id = ANY($1)
            AND metadata_sanitizada->>'ultima_reconsulta_at' IS NOT NULL`, [viejasIds]);
        assert.ok(n >= 50, `la rotacion no estampo a las viejas consultadas (estampadas=${n})`);
      } finally { await srvG.detener(); await esperar(400); }
    } finally {
      await pool.query(`DELETE FROM pagos WHERE id = ANY($1)`, [viejasIds]);
      await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio LIKE 'CEA-V%'`, [NEG]);
    }
  });

  await t('34. CLIP-G3: carrera TOCTOU legacy-vs-moderno -> el re-chequeo bajo el lock gana; cero liberacion indebida', async () => {
    // Pedido con enlace LEGACY (clip_link_id, sin fila de ledger) y dinero
    // real en ese checkout.
    const folio = folioNuevo();
    await pedido(folio, 505);
    const idL1 = 'clip-cea-legacy-g3';
    CHECKOUTS.set(idL1, { referencia: folio, estado: 'COMPLETED', monto: 505, expiresAt: null, expiredAt: null });
    await pool.query(
      `UPDATE pedidos_activos SET datos = datos || $3::jsonb WHERE folio=$1 AND negocio_id=$2`,
      [folio, NEG, JSON.stringify({ clip_link_id: idL1 })]);

    // El sweep legacy arranca y se PAUSA en la ventana TOCTOU exacta (entre
    // el pre-chequeo sin lock y el lock).
    const { reconciliarLegacyClip } = await import('../src/services/webhookPagos.js');
    process.env.XABOR_PAGOS_LEGACY_PAUSA_MS = '2500';
    const legacyEnVuelo = reconciliarLegacyClip();

    // Durante la pausa, el camino MODERNO crea y asienta una fila con
    // VERSION DESFASADA (que NO libera cocina).
    await esperar(600);
    const rB = await crearEnlace(folio);
    await pool.query(
      `UPDATE pedidos_activos SET datos = datos || $3::jsonb WHERE folio=$1 AND negocio_id=$2`,
      [folio, NEG, JSON.stringify({ total: 610, items: [{ nombre: 'Producto XXL', cantidad: 1, precio_unitario: 610 }] })]);
    CHECKOUTS.get(rB.referenciaExterna).estado = 'COMPLETED';
    const { verificarYAsentarClip } = await import('../src/services/webhookPagos.js');
    const [filaB] = (await filas(folio)).filter(f => f.referencia_externa === rB.referenciaExterna);
    const asiento = await verificarYAsentarClip({ pago: filaB, checkoutId: rB.referenciaExterna });
    assert.strictEqual(asiento.razon, 'transicion_version_desfasada', `el fixture no dejo la version desfasada: ${asiento.razon}`);

    await legacyEnVuelo;
    delete process.env.XABOR_PAGOS_LEGACY_PAUSA_MS;

    // Con el re-chequeo bajo el lock: el legacy ve que el folio YA es del
    // ledger; el dinero de L1 queda registrado con anomalia (no en
    // silencio) y la cocina JAMAS se libera por el camino sin gates.
    const p = await pedidoDe(folio);
    assert.strictEqual(p.estado, 'pendiente_pago',
      `TOCTOU: el camino legacy libero cocina pese al asiento moderno con version desfasada (estado=${p.estado})`);
    assert.strictEqual(await comandasDe(folio), 0, 'salio comanda por la carrera legacy/moderno');
  });

  await t('35. CLIP-G4: dinero en un checkout legacy de un folio que YA tiene ledger -> visible con anomalia, cero cocina, cero silencio', async () => {
    const folio = folioNuevo();
    await pedido(folio, 510);
    // Primero nace el intento MODERNO (fila de ledger, checkout L2, sin pagar).
    const rB = await crearEnlace(folio);
    const [filaB] = await filas(folio);
    assert.ok(filaB.referencia_externa && filaB.referencia_externa === rB.referenciaExterna);
    // Y el pedido arrastra un enlace LEGACY DISTINTO (L1) con dinero real.
    const idL1 = 'clip-cea-legacy-g4';
    CHECKOUTS.set(idL1, { referencia: folio, estado: 'COMPLETED', monto: 510, expiresAt: null, expiredAt: null });
    await pool.query(
      `UPDATE pedidos_activos SET datos = datos || $3::jsonb WHERE folio=$1 AND negocio_id=$2`,
      [folio, NEG, JSON.stringify({ clip_link_id: idL1 })]);

    const { reconciliarLegacyClip } = await import('../src/services/webhookPagos.js');
    await reconciliarLegacyClip();

    const p = await pedidoDe(folio);
    assert.strictEqual(p.datos?.pago_confirmado, true,
      'el dinero del checkout legacy quedo INVISIBLE: la existencia del ledger lo silencio');
    assert.strictEqual(p.estado, 'pendiente_pago', 'el camino legacy sin gates libero cocina');
    assert.strictEqual(await comandasDe(folio), 0);
    const filaBTras = await filaId(filaB.id);
    assert.strictEqual(filaBTras.metadata_sanitizada?.anomalia, 'dinero_en_checkout_legacy_fuera_del_ledger',
      'no quedo anomalia durable: el dinero fuera del ledger paso sin ruido');
    // CLIP-H: el dinero de L1 EXISTE EN EL LEDGER como hecho financiero
    // durable (fila puente 'pagado' con la identidad de L1), y L2 queda
    // invalidado operacionalmente SIN perder su identidad.
    const { rows: [puente] } = await pool.query(
      `SELECT * FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 AND referencia_externa=$3`,
      [NEG, folio, idL1]);
    assert.ok(puente, 'CLIP-H: el dinero de L1 NO existe en el ledger -- pagoRealDelPedido y la proteccion de doble cobro siguen ciegas');
    assert.strictEqual(puente.estado, 'pagado', `el puente no quedo asentado (${puente?.estado})`);
    assert.strictEqual(puente.metadata_sanitizada?.legacy_checkout_fuera_del_ledger, true);
    assert.strictEqual(puente.derivacion_pendiente, false, 'el puente dejo deuda de derivacion: liberaria cocina sin garantias de version');
    assert.strictEqual(filaBTras.estado, 'invalidado', 'L2 debio quedar invalidado operacionalmente');
    assert.strictEqual(filaBTras.referencia_externa, rB.referenciaExterna, 'L2 perdio su identidad al invalidarse');
  });

  await t('39. CLIP-H: L1 legacy paga -> puente en el ledger; DESPUES L2 tambien paga -> doble_cobro_real, cero cocina, ninguna referencia se pierde', async () => {
    const folio = folioNuevo();
    await pedido(folio, 530);
    // Intento MODERNO primero (fila L2, checkout pendiente).
    const rB = await crearEnlace(folio);
    const [filaB] = await filas(folio);
    // Enlace LEGACY L1 distinto, con dinero real.
    const idL1 = 'clip-cea-legacy-g4b';
    CHECKOUTS.set(idL1, { referencia: folio, estado: 'COMPLETED', monto: 530, expiresAt: null, expiredAt: null });
    await pool.query(
      `UPDATE pedidos_activos SET datos = datos || $3::jsonb WHERE folio=$1 AND negocio_id=$2`,
      [folio, NEG, JSON.stringify({ clip_link_id: idL1 })]);

    const { reconciliarLegacyClip, verificarYAsentarClip } = await import('../src/services/webhookPagos.js');
    await reconciliarLegacyClip();

    // FASE 1: L1 es un hecho financiero durable; L2 conserva identidad.
    const { rows: [puente] } = await pool.query(
      `SELECT * FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 AND referencia_externa=$3`,
      [NEG, folio, idL1]);
    assert.ok(puente, 'el puente de L1 no existe en el ledger');
    assert.strictEqual(puente.estado, 'pagado');
    assert.strictEqual(puente.referencia_externa, idL1, 'L1 no conservo su checkout');
    assert.strictEqual(await comandasDe(folio), 0, 'la fase 1 libero cocina');
    let l2 = await filaId(filaB.id);
    assert.strictEqual(l2.estado, 'invalidado');
    assert.strictEqual(l2.referencia_externa, rB.referenciaExterna, 'L2 perdio su identidad');

    // FASE 2: el cliente TAMBIEN paga L2 (el checkout del proveedor sigue
    // vivo: invalidar en Xabor no cancela en Clip). La reconciliacion
    // moderna sigue vigilando filas invalidadas.
    CHECKOUTS.get(rB.referenciaExterna).estado = 'COMPLETED';
    const rec = await verificarYAsentarClip({ pago: await filaId(filaB.id), checkoutId: rB.referenciaExterna });
    assert.strictEqual(rec.razon, 'transicion_doble_cobro',
      `el segundo cobro NO cayo en doble_cobro_real: se interpreto como primer dinero (${rec.razon})`);

    const l1Final = (await pool.query(`SELECT * FROM pagos WHERE id=$1`, [puente.id])).rows[0];
    l2 = await filaId(filaB.id);
    assert.strictEqual(l1Final.estado, 'pagado', 'la evidencia financiera de L1 se perdio');
    assert.strictEqual(l2.estado, 'pagado', 'el dinero real de L2 no quedo asentado');
    assert.strictEqual(l2.metadata_sanitizada?.anomalia, 'doble_cobro_real', 'el doble cobro no quedo durable en L2');
    assert.strictEqual(l1Final.metadata_sanitizada?.anomalia, 'doble_cobro_real', 'el doble cobro no quedo durable en L1');
    assert.strictEqual(l2.derivacion_pendiente, false, 'el segundo cobro dejo deuda de derivacion: liberaria cocina');
    assert.strictEqual(l1Final.referencia_externa, idL1, 'se perdio la referencia de L1');
    assert.strictEqual(l2.referencia_externa, rB.referenciaExterna, 'se perdio la referencia de L2');
    assert.strictEqual((await pedidoDe(folio)).estado, 'pendiente_pago', 'el doble cobro libero el pedido');
    assert.strictEqual(await comandasDe(folio), 0, 'salio comanda por el segundo cobro');
  });

  // ═══ CLIP-H2: el dinero autenticado debe PERTENECER al folio ═════════════
  //
  // clip_link_id es un dato ALMACENADO -- potencialmente corrupto (dato
  // historico, carrera vieja, bug). La prueba autoritativa de pertenencia es
  // el GET autenticado y su metadata.external_reference (que para los
  // enlaces legacy es el folio). Un checkout COMPLETED cuyo
  // external_reference pertenece a OTRO pedido es dinero AUTENTICO... de
  // otro: atribuirselo al pedido actual seria robarle el cobro a B y liberar
  // la cocina de A gratis.
  await t('40. CLIP-H2: un checkout ajeno (external_reference de OTRO folio) jamas se atribuye al pedido actual', async () => {
    // ── 40A: folio CON ledger ────────────────────────────────────────────
    const folioA = folioNuevo();
    const folioB = folioNuevo(); // el dueño REAL del dinero
    await pedido(folioA, 540);
    const rL2 = await crearEnlace(folioA);
    const [filaL2] = await filas(folioA);
    const refL2 = filaL2.referencia_externa;
    // Checkout legacy L1 COMPLETADO... pero su external_reference autenticado
    // es el folio B, no A. clip_link_id de A esta corrupto a proposito.
    const idAjeno = 'clip-cea-ajeno-h2a';
    CHECKOUTS.set(idAjeno, { referencia: folioB, estado: 'COMPLETED', monto: 540, expiresAt: null, expiredAt: null });
    await pool.query(
      `UPDATE pedidos_activos SET datos = datos || $3::jsonb WHERE folio=$1 AND negocio_id=$2`,
      [folioA, NEG, JSON.stringify({ clip_link_id: idAjeno })]);

    const { reconciliarLegacyClip } = await import('../src/services/webhookPagos.js');
    const broadcasts = [];
    await reconciliarLegacyClip({ broadcast: (neg, msg) => broadcasts.push({ neg, msg }) });

    const { rows: puentesA } = await pool.query(
      `SELECT * FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 AND referencia_externa=$3`,
      [NEG, folioA, idAjeno]);
    assert.strictEqual(puentesA.length, 0,
      'se creo un puente financiero con dinero cuyo external_reference pertenece a otro pedido');
    const pA = await pedidoDe(folioA);
    assert.notStrictEqual(pA.datos?.pago_confirmado, true,
      'checkout autenticado de otro folio fue atribuido al pedido A (pago_confirmado)');
    assert.strictEqual(pA.estado, 'pendiente_pago', 'el dinero ajeno libero el pedido A');
    assert.strictEqual(await comandasDe(folioA), 0, 'salio comanda con dinero ajeno');
    const l2Tras = await filaId(filaL2.id);
    assert.notStrictEqual(l2Tras.estado, 'invalidado', 'el dinero ajeno invalido a L2');
    assert.strictEqual(l2Tras.referencia_externa, refL2, 'L2 perdio su identidad por dinero ajeno');
    assert.strictEqual(l2Tras.metadata_sanitizada?.anomalia, 'referencia_no_coincide',
      'no quedo ruido durable de la referencia ajena (anomalia referencia_no_coincide)');
    assert.strictEqual(broadcasts.filter(b => b.msg?.pedidoId === folioA).length, 0,
      'se emitio pago_confirmado con dinero ajeno');

    // ── 40B: legacy PURO (sin ninguna fila de ledger) -- el mas peligroso ─
    const folioC = folioNuevo();
    await pedido(folioC, 545);
    const idAjenoB = 'clip-cea-ajeno-h2b';
    CHECKOUTS.set(idAjenoB, { referencia: folioB, estado: 'COMPLETED', monto: 545, expiresAt: null, expiredAt: null });
    await pool.query(
      `UPDATE pedidos_activos SET datos = datos || $3::jsonb WHERE folio=$1 AND negocio_id=$2`,
      [folioC, NEG, JSON.stringify({ clip_link_id: idAjenoB })]);

    const broadcastsB = [];
    await reconciliarLegacyClip({ broadcast: (neg, msg) => broadcastsB.push({ neg, msg }) });

    const pC = await pedidoDe(folioC);
    assert.notStrictEqual(pC.datos?.pago_confirmado, true,
      'legacy puro: checkout autenticado de otro folio fue atribuido al pedido (pago_confirmado)');
    assert.strictEqual(pC.estado, 'pendiente_pago',
      'legacy puro: el dinero ajeno LIBERO el pedido directo a cocina');
    assert.strictEqual(await comandasDe(folioC), 0, 'legacy puro: salio comanda con dinero ajeno');
    assert.strictEqual(broadcastsB.filter(b => b.msg?.pedidoId === folioC).length, 0,
      'legacy puro: se emitio pago_confirmado con dinero ajeno');
    const { rows: filasC } = await pool.query(
      `SELECT * FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2`, [NEG, folioC]);
    assert.strictEqual(filasC.length, 0,
      'legacy puro: quedo una fila financiera del dinero de B registrada bajo C');
    // Ruido durable SIN inventar una fila financiera: anotado en el pedido.
    const pC2 = await pedidoDe(folioC);
    assert.ok(pC2.datos?.clip_legacy_referencia_no_coincide,
      'legacy puro: no quedo ruido durable de la referencia ajena');
  });

  await t('41. CLIP-H2 (P2): un COMPLETED sin monto financiero valido JAMAS se vuelve un hecho pagado de $0', async () => {
    const folio = folioNuevo();
    await pedido(folio, 550);
    const rL2 = await crearEnlace(folio);
    const [filaL2] = await filas(folio);
    // Checkout legacy del PROPIO folio (pertenencia correcta)... pero el GET
    // autenticado no trae un monto numerico.
    const idL1 = 'clip-cea-sinmonto-h2c';
    CHECKOUTS.set(idL1, { referencia: folio, estado: 'COMPLETED', monto: null, expiresAt: null, expiredAt: null });
    await pool.query(
      `UPDATE pedidos_activos SET datos = datos || $3::jsonb WHERE folio=$1 AND negocio_id=$2`,
      [folio, NEG, JSON.stringify({ clip_link_id: idL1 })]);

    const { reconciliarLegacyClip } = await import('../src/services/webhookPagos.js');
    await reconciliarLegacyClip();

    const { rows: puentes } = await pool.query(
      `SELECT * FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 AND referencia_externa=$3`,
      [NEG, folio, idL1]);
    assert.strictEqual(puentes.length, 0,
      `se invento un hecho financiero sin monto valido (monto=${puentes[0]?.monto})`);
    const p = await pedidoDe(folio);
    assert.notStrictEqual(p.datos?.pago_confirmado, true, 'se marco pagado sin monto financiero valido');
    assert.strictEqual(await comandasDe(folio), 0);
    const l2 = await filaId(filaL2.id);
    assert.notStrictEqual(l2.estado, 'invalidado', 'se invalido L2 sin un hecho financiero valido');
    assert.strictEqual(l2.metadata_sanitizada?.anomalia, 'dinero_en_checkout_legacy_fuera_del_ledger',
      'no quedo ruido durable del COMPLETED sin monto');
    void rL2;
  });

  await t('36. CLIP-G5: llegar a la ventana de 90 dias sin terminal autenticada deja RUIDO DURABLE, nunca silencio', async () => {
    const idCk = 'clip-cea-viejo-g5';
    CHECKOUTS.set(idCk, { referencia: 'ref-g5', estado: 'PENDING', monto: 100, expiresAt: null, expiredAt: null });
    const { rows: [v] } = await pool.query(
      `INSERT INTO pagos (negocio_id, pedido_folio, proveedor, referencia_interna, referencia_externa,
                          tipo, moneda, monto, estado, version_pedido_hash, created_at)
       VALUES ($1, 'CEA-G5', 'clip', 'ref-g5', $2, 'enlace_pago', 'MXN', 100, 'pendiente', 'v-g5', NOW() - interval '91 days')
       RETURNING id`, [NEG, idCk]);
    // Y una hermana IGUAL de vieja pero con terminal verificado: NO se marca.
    const { rows: [conTerminal] } = await pool.query(
      `INSERT INTO pagos (negocio_id, pedido_folio, proveedor, referencia_interna, referencia_externa,
                          tipo, moneda, monto, estado, version_pedido_hash, created_at, metadata_sanitizada)
       VALUES ($1, 'CEA-G5T', 'clip', 'ref-g5t', 'clip-cea-viejo-g5t', 'enlace_pago', 'MXN', 100, 'vencido', 'v-g5t',
               NOW() - interval '91 days', '{"provider_terminal_status":"CHECKOUT_EXPIRED"}'::jsonb)
       RETURNING id`, [NEG]);
    try {
      const { marcarEnvejecidosSinTerminalClip } = await import('../src/services/webhookPagos.js');
      const marcadas = await marcarEnvejecidosSinTerminalClip();
      assert.ok(marcadas >= 1, 'ninguna fila envejecida quedo marcada');
      const f = await filaId(v.id);
      assert.strictEqual(f.metadata_sanitizada?.anomalia, 'envejecido_sin_terminal_proveedor',
        'la fila salio de la ventana automatica SIN ruido durable');
      assert.strictEqual(f.estado, 'requiere_revision',
        'una pendiente envejecida debio pasar al vocabulario de revision humana');
      const t2 = await filaId(conTerminal.id);
      assert.ok(!t2.metadata_sanitizada?.anomalia, 'una fila CON terminal verificado fue marcada como envejecida');
      // Idempotente: la segunda pasada no re-marca.
      const otraVez = await marcarEnvejecidosSinTerminalClip();
      const f2 = await filaId(v.id);
      assert.strictEqual(f2.metadata_sanitizada?.envejecido_sin_terminal_at, f.metadata_sanitizada?.envejecido_sin_terminal_at,
        `la segunda pasada re-marco la fila (marcadas=${otraVez})`);
    } finally {
      await pool.query(`DELETE FROM pagos WHERE id = ANY($1)`, [[v.id, conTerminal.id]]);
    }
  });

  await t('37. CLIP-G6: la frontera es EXACTAMENTE la precision del contrato -- +999ms valido, +1000ms valido, +1001ms bloqueado', async () => {
    // La justificacion del segundo es la precision del contrato (fechas
    // truncadas a segundos): el desfase maximo por redondeo es <1s. La
    // prueba demuestra LA FRONTERA, no solo un ejemplo lejano.
    for (const [modo, esperadoUrl] of [['ajusta999ms', true], ['ajusta1000ms', true], ['ajusta1001ms', false]]) {
      const folio = folioNuevo();
      await pedido(folio, 515);
      modoClip = modo;
      const r = await crearEnlace(folio);
      modoClip = 'normal';
      if (esperadoUrl) {
        assert.ok(r.url, `${modo}: un desfase dentro de la precision del contrato debio entregarse`);
      } else {
        assert.ok(!r.url, `${modo}: un desfase POR ENCIMA de la precision entrego la URL laxa`);
        assert.strictEqual(r.requiereRevision, true, `${modo}: no quedo en revision`);
      }
    }
  });

  await t('38. CLIP-G7: un COMPLETED autenticado DESPUES del terminal EXPIRED no desaparece en silencio -- dinero asentado + contradiccion durable', async () => {
    const folio = folioNuevo();
    await pedido(folio, 520);
    const r = await crearEnlace(folio);
    const [fila] = await filas(folio);
    // Terminal EXPIRED verificado (evidencia autenticada, durable).
    CHECKOUTS.get(r.referenciaExterna).estado = 'EXPIRED';
    const { procesarExpiracionProveedorClip, verificarYAsentarClip } = await import('../src/services/webhookPagos.js');
    const rExp = await procesarExpiracionProveedorClip({ pago: await filaId(fila.id), checkoutId: r.referenciaExterna });
    assert.ok(rExp.ok, `no quedo el terminal: ${rExp.razon}`);
    assert.strictEqual((await filaId(fila.id)).metadata_sanitizada?.provider_terminal_status, 'CHECKOUT_EXPIRED');

    // "Imposible": el proveedor ahora reporta COMPLETED. El dinero manda.
    CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED';
    const rec = await verificarYAsentarClip({ pago: await filaId(fila.id), checkoutId: r.referenciaExterna });
    assert.ok(rec.ok === true || rec.razon === 'transicion_pago_tardio',
      `el COMPLETED posterior al terminal fue ignorado: ${rec.razon}`);
    const f = await filaId(fila.id);
    assert.strictEqual(f.estado, 'pagado', 'el dinero desaparecio en silencio por la marca terminal');
    assert.strictEqual(f.metadata_sanitizada?.terminal_contradicho_por_pago, true,
      'la contradiccion del terminal no quedo durable: silencio operativo');
    assert.strictEqual(await comandasDe(folio), 0, 'un pago tras terminal/vencimiento libero cocina');
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
