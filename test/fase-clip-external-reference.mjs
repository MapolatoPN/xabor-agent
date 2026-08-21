// ─── CLIP external_reference: cumplir el limite de 36 caracteres ────────────
//
// DEFECTO (incidente XAB-0161): el contrato oficial de Clip Checkout v2
// documenta metadata.external_reference como String de MAXIMO 36 caracteres.
// pagosService mandaba la referencia interna completa
// ("negocioId:folio:versionHash:proveedor:rand", ~76 chars): violacion
// contractual objetiva. El fix: para NUEVOS checkouts Clip viaja pagos.id
// (UUID, exactamente 36), identidad durable de la fila que existe ANTES del
// POST. La referencia interna larga se CONSERVA intacta (no viaja a Clip) y
// JAMAS se trunca.
//
// POLITICA DE MATCH (compatibilidad historica): una referencia autenticada
// pertenece a una fila SOLO si es igual EXACTA a pagos.id (contrato nuevo) o a
// pagos.referencia_interna (checkouts historicos). Nada parcial, nada
// heuristico; referencia de otra fila = fail closed.
//
// Ninguna prueba toca Clip real. Cero credenciales reales, cero dinero real.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
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
const PUERTO = Number(process.env.TEST_PORT_CER || 4361);
const PUERTO_CLIP = Number(process.env.TEST_PORT_CER_CLIP || 4362);
const PUERTO_MP = Number(process.env.TEST_PORT_CER_MP || 4363);
const base = `http://localhost:${PUERTO}`;

process.env.CLIP_API_BASE_URL = `http://localhost:${PUERTO_CLIP}`;
process.env.XABOR_MP_API_BASE = `http://localhost:${PUERTO_MP}`;
process.env.XABOR_URL_PUBLICA = base;

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Mock de Clip v2 (forma DOCUMENTADA; el GET refleja external_reference) ──
let checkoutsClip = 0;
const CHECKOUTS = new Map();      // id -> { referencia, estado, monto }
const REQUESTS = [];              // cuerpos crudos de cada POST /v2/checkout
const GETS = [];                  // ids consultados por GET /v2/checkout/:id
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', c => { cuerpo += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const body = JSON.parse(cuerpo || '{}');
      REQUESTS.push(body);
      const id = `clip-cer-${++checkoutsClip}`;
      const expiresAt = body.expires_at
        ? new Date(Date.parse(body.expires_at)).toISOString()
        : new Date(Date.now() + 3 * 24 * 3600e3).toISOString();
      CHECKOUTS.set(id, {
        referencia: body.metadata?.external_reference || null,
        estado: 'PENDING', monto: Number(body.amount), expiresAt,
      });
      res.end(JSON.stringify({
        payment_request_id: id, object_type: 'payment_link', status: 'CHECKOUT_CREATED',
        payment_request_url: `https://pago.mock.clip/${id}`,
        created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        expires_at: expiresAt,
      }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v2/checkout/')) {
      const id = decodeURIComponent(req.url.split('/').pop());
      GETS.push(id);
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
        expires_at: c.expiresAt || null,
        last_status_message: status,
      };
      if (c.estado === 'EXPIRED') cuerpoGet.expired_at = c.expiresAt || null;
      res.end(JSON.stringify(cuerpoGet));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
});

// Mock minimo de Mercado Pago (caso 9: MP conserva su contrato de referencia).
let checkoutsMP = 0;
const PREFERENCIAS = new Map();
const mpMock = createServer((req, res) => {
  if (req.url.startsWith('/checkout/preferences')) {
    let cuerpo = '';
    req.on('data', c => { cuerpo += c; });
    req.on('end', () => {
      const p = JSON.parse(cuerpo || '{}');
      const id = `pref-cer-${++checkoutsMP}`;
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

// ── Fixture (mismo patron que fase-clip-expires-at.mjs) ─────────────────────
async function conectarClip(negocioId = NEG) {
  const { guardarIntegracionPago, marcarProveedorPrincipal } =
    await import('../src/services/integracionesService.js');
  await guardarIntegracionPago(negocioId, 'clip',
    { apiKey: 'test-api-key-no-real', apiSecret: 'test-api-secret-no-real' },
    { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(negocioId, 'clip', SEED.superadminUsuarioId);
}
async function conectarMP(negocioId) {
  const { guardarIntegracionPago, marcarProveedorPrincipal } =
    await import('../src/services/integracionesService.js');
  await guardarIntegracionPago(negocioId, 'mercado_pago',
    { accessToken: 'token-cer', publicKey: 'pk-test', webhookSecret: 'secreto-cer' },
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
      cliente: { nombre: 'Cliente external_reference', telefono: '8997600022' },
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
async function comandasDe(folio, negocioId = NEG) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM impresion_trabajos
      WHERE negocio_id=$1 AND origen_tipo='pedido' AND origen_id=$2`, [negocioId, folio]);
  return r.n;
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
async function esperarHasta(fn, { timeoutMs = 12000, intervaloMs = 150 } = {}) {
  const lim = Date.now() + timeoutMs;
  for (;;) { const r = await fn(); if (r) return r; if (Date.now() > lim) return null; await esperar(intervaloMs); }
}
async function webhookClip(cuerpo) {
  const r = await fetch(`${base}/webhook/clip`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  return r.status;
}
const filaId = async (id) => (await pool.query(`SELECT * FROM pagos WHERE id=$1`, [id])).rows[0];

async function montarImpresion() {
  const { crearEdge } = await import('../src/services/edgeService.js');
  const { crearImpresora, crearRuta } = await import('../src/services/impresionService.js');
  const { DESTINOS } = await import('../src/services/impresionSelfService.js');
  await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [NEG]);
  const term = await crearEdge(NEG, { nombre: 'PC CER' });
  const imp = await crearImpresora(NEG, {
    terminalId: term.id, nombre: 'Impresora cer', transporte: 'windows_spooler',
    anchoColumnas: 42, config: { spoolerNombre: 'Impresora cer' },
  });
  await crearRuta(NEG, { impresoraId: imp.id, ambito: 'documento', clave: DESTINOS.cocina.clave });
}
async function desmontarImpresion() {
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM impresoras WHERE negocio_id=$1 AND nombre='Impresora cer'`, [NEG]);
  await pool.query(`DELETE FROM edge_emparejamientos WHERE terminal_id IN
    (SELECT t.id FROM terminales t JOIN sucursales s ON s.id=t.sucursal_id WHERE s.negocio_id=$1 AND t.nombre='PC CER')`, [NEG]);
  await pool.query(`DELETE FROM terminales WHERE nombre='PC CER' AND sucursal_id IN
    (SELECT id FROM sucursales WHERE negocio_id=$1)`, [NEG]);
}

async function limpiar() {
  for (const n of [NEG, NEG_B]) {
    await pool.query(`DELETE FROM pagos WHERE negocio_id=$1 AND pedido_folio LIKE 'CER-%'`, [n]);
    await pool.query(`DELETE FROM pedido_emisiones WHERE negocio_id=$1 AND folio LIKE 'CER-%'`, [n]);
    await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio LIKE 'CER-%'`, [n]);
    await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal='pagos'`, [n]);
    await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id=$1 AND origen_id LIKE 'CER-%'`, [n]);
  }
}

let srv = null;
let seq = 0;
const folioNuevo = () => `CER-${String(Date.now()).slice(-6)}${++seq}`;

try {
  await limpiar();
  await conectarClip(NEG);
  await conectarClip(NEG_B);
  await montarImpresion();

  // ═══ 1. NUEVO CHECKOUT: external_reference = pagos.id (UUID, 36 exactos) ══
  await t('1. el POST a Clip lleva external_reference = pagos.id (UUID de 36), NUNCA la referencia interna larga', async () => {
    const folio = folioNuevo();
    await pedido(folio, 250);
    const antes = REQUESTS.length;
    const r = await crearEnlace(folio);
    assert.ok(r.url, 'no se creo el enlace');
    const req = REQUESTS[antes];
    assert.ok(req, 'el mock no capturo el POST de creacion');
    const [fila] = await filas(folio);
    const enviado = req.metadata?.external_reference;
    assert.strictEqual(enviado, String(fila.id),
      `external_reference enviado (${enviado}) no es pagos.id (${fila.id})`);
    assert.strictEqual(String(enviado).length, 36,
      `external_reference mide ${String(enviado).length} chars, el limite oficial de Clip es 36`);
    assert.match(String(enviado), RE_UUID, 'external_reference no es un UUID completo');
    assert.ok(fila.referencia_interna.length > 36,
      'el fixture no reproduce la referencia interna larga (>36) del incidente');
    assert.notStrictEqual(enviado, fila.referencia_interna,
      'sigue viajando la referencia interna larga a Clip');
    // La referencia interna durable se conserva INTACTA (no se acorto).
    assert.match(fila.referencia_interna, /^.+:.+:.+:clip:.+$/,
      'pagos.referencia_interna perdio su formato durable');
  });

  // ═══ 2. NO TRUNCAMIENTO ═══════════════════════════════════════════════════
  await t('2. lo enviado NO es un recorte (slice/substring) de la referencia interna: es identidad durable propia', async () => {
    const folio = folioNuevo();
    await pedido(folio, 260);
    const antes = REQUESTS.length;
    await crearEnlace(folio);
    const req = REQUESTS[antes];
    const [fila] = await filas(folio);
    const enviado = String(req.metadata?.external_reference || '');
    assert.ok(!fila.referencia_interna.includes(enviado),
      'lo enviado es un fragmento de la referencia interna: un truncado destruye unicidad');
    assert.ok(!enviado.startsWith(fila.negocio_id),
      'lo enviado parece un prefijo de la referencia interna (negocioId:...)');
    assert.strictEqual(enviado, String(fila.id), 'la identidad enviada no es la durable de la fila');
  });

  // ═══ 3. IDEMPOTENCIA: repetido/concurrente -> UN solo POST, UNA fila ══════
  await t('3. dos llamadas concurrentes + una repetida -> un solo POST, una fila, mismo checkout y misma external_reference', async () => {
    const folio = folioNuevo();
    await pedido(folio, 270);
    const antes = REQUESTS.length;
    const [r1, r2] = await Promise.all([crearEnlace(folio), crearEnlace(folio)]);
    const r3 = await crearEnlace(folio);
    assert.strictEqual(REQUESTS.length, antes + 1,
      `hubo ${REQUESTS.length - antes} POSTs de creacion para el mismo pedido`);
    const lasFilas = await filas(folio);
    assert.strictEqual(lasFilas.length, 1, `hay ${lasFilas.length} filas para un solo intento`);
    const ids = new Set([r1.pagoId, r2.pagoId, r3.pagoId]);
    const urls = new Set([r1.url, r2.url, r3.url]);
    assert.strictEqual(ids.size, 1, 'las llamadas devolvieron filas distintas');
    assert.strictEqual(urls.size, 1, 'las llamadas devolvieron URLs distintas');
    assert.strictEqual(REQUESTS[antes].metadata?.external_reference, String(lasFilas[0].id),
      'el unico POST no llevo pagos.id como external_reference');
  });

  // ═══ 4. GET / RECONCILIACION NUEVA: COMPLETED con pago.id -> asienta UNA vez ══
  let filaCaso4 = null, checkoutCaso4 = null, folioCaso4 = null;
  await t('4. COMPLETED autenticado con external_reference = pago.id -> fila exacta, monto/moneda validados, un solo asiento, nadie mas tocado', async () => {
    const folio = folioCaso4 = folioNuevo();
    const folioTestigo = folioNuevo();
    await pedido(folio, 280);
    await pedido(folioTestigo, 285);
    const r = await crearEnlace(folio);
    await crearEnlace(folioTestigo);
    const [fila] = await filas(folio);
    filaCaso4 = fila; checkoutCaso4 = r.referenciaExterna;
    assert.strictEqual(CHECKOUTS.get(checkoutCaso4).referencia, String(fila.id),
      'el mock no guardo pago.id: el fixture no representa el contrato nuevo');
    CHECKOUTS.get(checkoutCaso4).estado = 'COMPLETED';
    const { verificarYAsentarClip } = await import('../src/services/webhookPagos.js');
    const res = await verificarYAsentarClip({ pago: fila, checkoutId: checkoutCaso4 });
    assert.ok(res.ok, `no se asento: ${res.razon}`);
    const f = await filaId(fila.id);
    assert.strictEqual(f.estado, 'pagado', 'la fila no quedo pagada');
    assert.strictEqual((await filas(folio)).length, 1, 'aparecio una segunda fila de pago');
    // El testigo (otro pedido, otro checkout) no fue tocado.
    const [testigo] = await filas(folioTestigo);
    assert.strictEqual(testigo.estado, 'pendiente', 'el asiento toco OTRO pedido');
  });

  // ═══ 11. DOBLE SETTLEMENT: una sola confirmacion monetaria ════════════════
  await t('11. dos verificaciones del mismo checkout completado -> una sola confirmacion, sin segunda fila ni regresion de estado', async () => {
    assert.ok(filaCaso4, 'el caso 4 debio dejar su fixture');
    const { verificarYAsentarClip } = await import('../src/services/webhookPagos.js');
    const res2 = await verificarYAsentarClip({ pago: await filaId(filaCaso4.id), checkoutId: checkoutCaso4 });
    assert.ok(res2.ok, `la repeticion idempotente fallo: ${res2.razon}`);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 AND estado='pagado'`,
      [NEG, folioCaso4]);
    assert.strictEqual(rows[0].n, 1, `hay ${rows[0].n} filas pagadas para el mismo cobro`);
  });

  // ═══ Servidor real para los casos de webhook ══════════════════════════════
  srv = await arrancarServidor({ PORT: String(PUERTO) }, { timeoutMs: 90000 });

  // ═══ 5. WEBHOOK NUEVO: me_reference_id = pago.id (UUID) ═══════════════════
  await t('5. webhook con me_reference_id = pago.id -> resuelve la fila exacta y confirma SOLO tras la reconsulta autenticada', async () => {
    const folio = folioNuevo();
    await pedido(folio, 300);
    const r = await crearEnlace(folio);
    const [fila] = await filas(folio);
    CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED';
    const getsAntes = GETS.filter(g => g === r.referenciaExterna).length;
    assert.strictEqual(await webhookClip({
      resource: 'CHECKOUT', resource_status: 'COMPLETED',
      me_reference_id: String(fila.id), payment_request_id: r.referenciaExterna,
    }), 200);
    const pagada = await esperarHasta(async () => {
      const f = await filaId(fila.id);
      return f.estado === 'pagado' ? f : null;
    });
    assert.ok(pagada, `el webhook UUID no asento el pago (estado: ${(await filaId(fila.id)).estado})`);
    assert.ok(GETS.filter(g => g === r.referenciaExterna).length > getsAntes,
      'se confirmo SIN reconsulta autenticada: el webhook no firmado decidio solo');
    const p = await esperarHasta(async () => {
      const x = await pedidoDe(folio);
      return x?.datos?.pago_confirmado === true ? x : null;
    });
    assert.ok(p, 'el pedido no quedo con pago confirmado tras el asiento');
  });

  // ═══ 6. COMPATIBILIDAD HISTORICA: external_reference = referencia_interna ══
  await t('6. checkout historico cuyo external_reference es la referencia interna larga -> sigue reconciliando igual', async () => {
    const folio = folioNuevo();
    await pedido(folio, 310);
    const r = await crearEnlace(folio);
    const [fila] = await filas(folio);
    // Fixture historico: el checkout viajo (en su epoca) con la referencia
    // interna completa. Se simula reescribiendo lo que el proveedor guardo.
    CHECKOUTS.get(r.referenciaExterna).referencia = fila.referencia_interna;
    CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED';
    // Y el webhook historico tambien nombra la referencia interna.
    assert.strictEqual(await webhookClip({
      resource: 'CHECKOUT', resource_status: 'COMPLETED',
      me_reference_id: fila.referencia_interna, payment_request_id: r.referenciaExterna,
    }), 200);
    const pagada = await esperarHasta(async () => {
      const f = await filaId(fila.id);
      return f.estado === 'pagado' ? f : null;
    });
    assert.ok(pagada,
      `el checkout historico dejo de reconciliarse (estado: ${(await filaId(fila.id)).estado}): compatibilidad rota`);
  });

  // ═══ 7. REFERENCIA AJENA: fail closed, cero cocina ════════════════════════
  await t('7. COMPLETED cuyo external_reference autenticado es de OTRA fila -> nadie asienta, anomalia durable, cero cocina', async () => {
    const folioA = folioNuevo();
    const folioB = folioNuevo();
    await pedido(folioA, 320);
    await pedido(folioB, 325);
    const rA = await crearEnlace(folioA);
    await crearEnlace(folioB);
    const [filaA] = await filas(folioA);
    const [filaB] = await filas(folioB);
    // El checkout de A reporta COMPLETED... pero su external_reference
    // autenticado es el id de la fila B.
    CHECKOUTS.get(rA.referenciaExterna).referencia = String(filaB.id);
    CHECKOUTS.get(rA.referenciaExterna).estado = 'COMPLETED';
    assert.strictEqual(await webhookClip({
      resource: 'CHECKOUT', resource_status: 'COMPLETED',
      me_reference_id: filaA.referencia_interna, payment_request_id: rA.referenciaExterna,
    }), 200);
    const anomala = await esperarHasta(async () => {
      const f = await filaId(filaA.id);
      return f.metadata_sanitizada?.anomalia === 'referencia_no_coincide' ? f : null;
    });
    assert.ok(anomala, 'no quedo anomalia durable referencia_no_coincide en A');
    assert.notStrictEqual((await filaId(filaA.id)).estado, 'pagado', 'A se asento con dinero ajeno');
    assert.notStrictEqual((await filaId(filaB.id)).estado, 'pagado', 'B se asento por accidente');
    assert.strictEqual((await pedidoDe(folioA))?.datos?.pago_confirmado, false,
      'el pedido A quedo confirmado con referencia ajena');
    assert.strictEqual(await comandasDe(folioA), 0, 'una referencia ajena libero cocina');
    // Variante: la referencia ajena es la referencia INTERNA de B (historica).
    const { verificarYAsentarClip } = await import('../src/services/webhookPagos.js');
    CHECKOUTS.get(rA.referenciaExterna).referencia = filaB.referencia_interna;
    const res = await verificarYAsentarClip({ pago: await filaId(filaA.id), checkoutId: rA.referenciaExterna });
    assert.strictEqual(res.razon, 'referencia_no_coincide',
      `la referencia interna de OTRA fila fue aceptada: ${res.razon}`);
  });

  // ═══ 8. REFERENCIA DESCONOCIDA: fail closed ═══════════════════════════════
  await t('8. UUID inexistente (webhook y GET) -> fail closed, nada se crea ni se asienta', async () => {
    const fantasma = '11111111-2222-4333-8444-555555555555';
    const { rows: antes } = await pool.query(`SELECT COUNT(*)::int n FROM pagos WHERE negocio_id=$1`, [NEG]);
    assert.strictEqual(await webhookClip({
      resource: 'CHECKOUT', resource_status: 'COMPLETED',
      me_reference_id: fantasma, payment_request_id: 'clip-cer-fantasma',
    }), 200);
    await esperar(600);
    const { rows: despues } = await pool.query(`SELECT COUNT(*)::int n FROM pagos WHERE negocio_id=$1`, [NEG]);
    assert.strictEqual(despues[0].n, antes[0].n, 'un UUID inexistente creo o toco filas');
    // Y por el camino del GET: un checkout cuyo external_reference es un UUID
    // que no existe en pagos tampoco se atribuye a la fila consultada.
    const folio = folioNuevo();
    await pedido(folio, 330);
    const r = await crearEnlace(folio);
    const [fila] = await filas(folio);
    CHECKOUTS.get(r.referenciaExterna).referencia = fantasma;
    CHECKOUTS.get(r.referenciaExterna).estado = 'COMPLETED';
    const { verificarYAsentarClip } = await import('../src/services/webhookPagos.js');
    const res = await verificarYAsentarClip({ pago: fila, checkoutId: r.referenciaExterna });
    assert.strictEqual(res.razon, 'referencia_no_coincide',
      `un UUID desconocido no fallo cerrado: ${res.razon}`);
    assert.notStrictEqual((await filaId(fila.id)).estado, 'pagado');
  });

  // ═══ 12. IDENTIDAD MULTIEMPRESA ═══════════════════════════════════════════
  await t('12. la referencia UUID de un pago del negocio A jamas confirma un pago del negocio B (y viceversa)', async () => {
    const folioA = folioNuevo();
    const folioB = folioNuevo();
    await pedido(folioA, 340, { negocioId: NEG });
    await pedido(folioB, 345, { negocioId: NEG_B });
    const rA = await crearEnlace(folioA, NEG);
    const rB = await crearEnlace(folioB, NEG_B);
    const [filaA] = await filas(folioA, NEG);
    const [filaB] = await filas(folioB, NEG_B);
    // El checkout de A (negocio A) reporta COMPLETED con el id del pago de B.
    CHECKOUTS.get(rA.referenciaExterna).referencia = String(filaB.id);
    CHECKOUTS.get(rA.referenciaExterna).estado = 'COMPLETED';
    const { verificarYAsentarClip } = await import('../src/services/webhookPagos.js');
    const res = await verificarYAsentarClip({ pago: filaA, checkoutId: rA.referenciaExterna });
    assert.strictEqual(res.razon, 'referencia_no_coincide', `cruce de tenants aceptado: ${res.razon}`);
    assert.notStrictEqual((await filaId(filaA.id)).estado, 'pagado');
    assert.notStrictEqual((await filaId(filaB.id)).estado, 'pagado');
    // Webhook cruzado: nombra el pago de B pero con el checkout de A. La fila
    // B ya tiene SU identidad externa: el candidato ajeno no la toca.
    assert.strictEqual(await webhookClip({
      resource: 'CHECKOUT', resource_status: 'COMPLETED',
      me_reference_id: String(filaB.id), payment_request_id: rA.referenciaExterna,
    }), 200);
    const anomalaB = await esperarHasta(async () => {
      const f = await filaId(filaB.id);
      return f.metadata_sanitizada?.anomalia === 'checkout_ajeno' ? f : null;
    });
    assert.ok(anomalaB, 'el checkout ajeno no quedo registrado como anomalia en B');
    assert.notStrictEqual((await filaId(filaB.id)).estado, 'pagado', 'B se confirmo con el checkout de A');
    assert.strictEqual((await pedidoDe(folioB, NEG_B))?.datos?.pago_confirmado, false);
  });

  // ═══ 9. MERCADO PAGO: su contrato de referencia NO cambia ═════════════════
  await t('9. Mercado Pago sigue mandando la referencia interna como external_reference (cero regresion)', async () => {
    await conectarMP(NEG_B);
    const folio = folioNuevo();
    await pedido(folio, 350, { negocioId: NEG_B });
    const antes = checkoutsMP;
    const r = await crearEnlace(folio, NEG_B);
    assert.ok(r.url, 'no se creo la preferencia MP');
    assert.strictEqual(checkoutsMP, antes + 1, 'no hubo POST de preferencia MP');
    const [fila] = await filas(folio, NEG_B);
    const pref = PREFERENCIAS.get(`pref-cer-${checkoutsMP}`);
    assert.strictEqual(pref.external_reference, fila.referencia_interna,
      `MP dejo de mandar la referencia interna: mando ${pref.external_reference}`);
    assert.notStrictEqual(pref.external_reference, String(fila.id),
      'MP fue convertido a pagos.id: regresion de contrato');
  });

  // ═══ 10. EXPIRACION: el POST sigue llevando expires_at intacto ════════════
  await t('10. el fix no toco expires_at: el POST de creacion sigue llevando la frontera en el formato oficial', async () => {
    const folio = folioNuevo();
    await pedido(folio, 360);
    const antes = REQUESTS.length;
    await crearEnlace(folio);
    const req = REQUESTS[antes];
    assert.ok(req?.expires_at, 'el POST perdio expires_at: regresion del bloque CLIP');
    assert.match(String(req.expires_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      `expires_at ya no va en el formato oficial: ${req.expires_at}`);
    const [fila] = await filas(folio);
    assert.ok(fila.xabor_espera_hasta, 'la frontera durable desaparecio');
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

console.log(`\n═══ fase-clip-external-reference: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
