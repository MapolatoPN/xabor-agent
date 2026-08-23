// Un pedido YA PAGADO no puede bloquear la siguiente compra del cliente.
//
// Incidente real (23-ago, durante el smoke de Clip): XAB-0179 estaba pagado
// pero seguía "activo" (nadie lo marcó entregado). El atajo determinista de
// "solicitud de enlace de pago" veía activos>0 y sinPagar==0, respondía
// "Tu pedido XAB-0179 ya está pagado ✔" y CORTABA el mensaje -- así que
// "una coca cola y paso por ella, pago con enlace de pago" ni siquiera
// llegaba al agente. El cliente recurrente quedaba sin poder comprar.
//
// Regla que fija esta suite: el atajo SOLO interviene cuando hay algo ACTUAL
// que cobrar (un pedido activo sin pagar). Si no lo hay, el canal no se
// adjudica la intención y el mensaje sigue su curso normal.
//
// La protección de doble cobro NO vive aquí: vive en la capa de pagos
// (crearEnlacePago -> PedidoInvalidoError sobre un pedido pagado). Esta
// suite lo prueba explícitamente para que nadie confunda las dos cosas.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import assert from 'assert';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

const metaMock = await arrancarMetaMock();
process.env.META_GRAPH_BASE_URL = metaMock.baseUrl;

// Mock del modelo: responde algo neutro. Lo que importa NO es el texto del
// agente, sino que el mensaje LLEGUE hasta él (el canal dejó de secuestrarlo).
let llamadasAlModelo = 0;
let ultimoPromptUsuario = '';
const anthropicMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    llamadasAlModelo++;
    try {
      const b = JSON.parse(cuerpo || '{}');
      const ultimo = (b.messages || []).filter((m) => m.role === 'user').pop();
      ultimoPromptUsuario = typeof ultimo?.content === 'string'
        ? ultimo.content
        : (ultimo?.content || []).map((x) => x.text || '').join(' ');
    } catch { /* cuerpo no interpretable */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_mock_' + Date.now(), type: 'message', role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: 'Con gusto, ¿algo más?' }],
      stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
    }));
  });
});
await new Promise((r) => anthropicMock.listen(0, r));
const ANTHROPIC_URL = `http://localhost:${anthropicMock.address().port}`;

const { pool } = await import('../src/services/database.js');
const { detectarSolicitudEnlacePago } = await import('../src/utils/intencionEnlacePago.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperarHasta(fn, { timeoutMs = 15000, intervaloMs = 250 } = {}) {
  const lim = Date.now() + timeoutMs;
  for (;;) { const r = await fn(); if (r) return r; if (Date.now() > lim) return null; await esperar(intervaloMs); }
}

const NEG = SEED.negocioA;
const NEG_B = SEED.negocioB;
const suf = Date.now().toString().slice(-6);
const PUERTO = String(4900 + (Number(suf) % 80));
const PUERTO_CLIP = Number(PUERTO) + 60;
const TEL = `52899790${suf.slice(-4)}`;
const TEL_OTRO = `52899791${suf.slice(-4)}`;
const PNID = `PNIDBPP${suf}`;
const WABA = `WABABPP${suf}`;
const PROD = `BPP Coca ${suf}`;
process.env.CLIP_API_BASE_URL = `http://localhost:${PUERTO_CLIP}`;

// Mock de Clip (solo para crear checkouts reales de la orden A/B)
let nCk = 0;
const CHECKOUTS = new Map();
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const body = JSON.parse(cuerpo || '{}');
      const id = `clip-bpp-${suf}-${++nCk}`;
      const expiresAt = body.expires_at
        ? new Date(Date.parse(body.expires_at)).toISOString()
        : new Date(Date.now() + 3600e3).toISOString();
      CHECKOUTS.set(id, { referencia: body.metadata?.external_reference || null, monto: Number(body.amount), expiresAt });
      res.end(JSON.stringify({
        payment_request_id: id, object_type: 'payment_link', status: 'CHECKOUT_CREATED',
        payment_request_url: `https://pago.mock.clip/${id}`,
        created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), expires_at: expiresAt,
      }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => clipMock.listen(PUERTO_CLIP, r));

const salientes = (tel) => metaMock.obtenerMensajesEnviados()
  .filter((m) => m.to === tel).map((m) => m.text?.body || '');
const contarYaPagado = (tel) => salientes(tel).filter((x) => /ya est. pagado/i.test(x)).length;
const contarEnlaces = (tel) => salientes(tel).filter((x) => /pago\.mock\.clip/i.test(x)).length;

const pagosDe = async (folio) => (await pool.query(
  `SELECT id, estado, monto FROM pagos WHERE negocio_id = $1 AND pedido_folio = $2`, [NEG, folio])).rows;
const pedidosDelTel = async (tel) => (await pool.query(
  `SELECT folio, estado, datos->>'pago_confirmado' AS pc FROM pedidos_activos
    WHERE negocio_id = $1 AND datos->>'telefono_conversacion' = $2 ORDER BY created_at`, [NEG, tel])).rows;

// Limpieza TOLERANTE: cada paso con su propio catch. Con un solo catch
// global, un DELETE que falla por FK aborta los siguientes en silencio y
// deja residuo que rompe la SIGUIENTE suite (pasó de verdad).
async function del(sql, params) {
  try { await pool.query(sql, params); } catch (e) { console.warn('[limpieza] paso omitido:', e.message.slice(0, 80)); }
}

async function limpiar() {
  for (const tel of [TEL, TEL_OTRO]) {
    await del(`DELETE FROM pagos WHERE pedido_folio IN (SELECT folio FROM pedidos_activos WHERE datos->>'telefono_conversacion' = $1)`, [tel]);
    await del(`DELETE FROM pedido_emisiones WHERE folio IN (SELECT folio FROM pedidos_activos WHERE datos->>'telefono_conversacion' = $1)`, [tel]);
    await del(`DELETE FROM pedidos_activos WHERE datos->>'telefono_conversacion' = $1`, [tel]);
    await del(`DELETE FROM mensajes WHERE telefono = $1`, [tel]);
    await del(`DELETE FROM clientes WHERE telefono = $1`, [tel]);
  }
  await del(`DELETE FROM menu_productos WHERE negocio_id = ANY($1) AND nombre LIKE 'BPP %'`, [[NEG, NEG_B]]);
  await del(`DELETE FROM menu_categorias WHERE negocio_id = ANY($1) AND nombre LIKE 'BPP %'`, [[NEG, NEG_B]]);
  await del(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp')`, [NEG]);
  await del(`DELETE FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp'`, [NEG]);
  await del(`DELETE FROM pagos WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'pagos')`, [NEG]);
  await del(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'pagos' AND proveedor = 'clip')`, [NEG]);
  await del(`DELETE FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'pagos' AND proveedor = 'clip'`, [NEG]);
}

let srv = null;
let botOriginal = null;
try {
  await limpiar();

  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'BPP Cat (test)',TRUE,994) RETURNING id`, [NEG]);
  await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
     VALUES ($1,$2,$3,35,TRUE,FALSE,1)`, [NEG, cat.id, PROD]);
  await pool.query(
    `INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden, disponible_para_bot)
     VALUES ($1,'enlace_pago',TRUE,1,TRUE) ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE, disponible_para_bot = TRUE`, [NEG]);
  const { guardarCredencialesClip, marcarProveedorPrincipal, guardarCredencialesCifradas, actualizarEstadoIntegracion } =
    await import('../src/services/integracionesService.js');
  await guardarCredencialesClip(NEG, `BPPKEY${suf}`, `BPPSECRET${suf}`, SEED.superadminUsuarioId);
  await marcarProveedorPrincipal(NEG, 'clip', SEED.superadminUsuarioId);
  await pool.query(
    `INSERT INTO integraciones_canal (negocio_id, canal, proveedor, identificador, nombre, estado, activo, waba_id)
     VALUES ($1,'whatsapp','meta',$2,'BPP prueba','activo',TRUE,$3)`, [NEG, PNID, WABA]);
  await guardarCredencialesCifradas(NEG, 'whatsapp', 'meta',
    { phoneNumberId: PNID, wabaId: WABA, accessToken: 'TOKEN-BPP' }, SEED.superadminUsuarioId);
  await actualizarEstadoIntegracion(NEG, 'whatsapp', 'meta', 'activo', SEED.superadminUsuarioId);
  const { rows: [b] } = await pool.query(`SELECT bot_whatsapp_activo FROM negocios WHERE id = $1`, [NEG]);
  botOriginal = b?.bot_whatsapp_activo ?? null;
  await pool.query(`UPDATE negocios SET bot_whatsapp_activo = TRUE WHERE id = $1`, [NEG]);

  // ── Orden A: registrada y PAGADA, pero todavía "activa" (nadie la entregó)
  const { registrarPedido } = await import('../src/orders/orderManager.js');
  const { crearEnlacePago } = await import('../src/services/pagosService.js');
  const ordenA = await registrarPedido({
    cliente: { nombre: 'Cliente BPP', telefono: TEL },
    telefono_conversacion: TEL,
    modalidad: 'recoger en tienda',
    items: [{ nombre: PROD, cantidad: 1, precio_unitario: 35 }],
    subtotal: 35, costo_envio: 0, descuento: 0, total: 35,
    forma_pago: 'enlace_pago', forma_pago_tipo: 'enlace_pago',
    canal: 'whatsapp', negocioId: NEG,
  }, 'whatsapp');
  const FOLIO_A = ordenA.id;
  await crearEnlacePago({ negocioId: NEG, pedidoId: FOLIO_A, actor: null });
  // Se marca pagado por la MISMA vía que el asiento real (jsonb del pedido).
  await pool.query(
    `UPDATE pedidos_activos SET datos = datos || '{"pago_confirmado": true}'::jsonb WHERE folio = $1 AND negocio_id = $2`,
    [FOLIO_A, NEG]);
  await pool.query(`UPDATE pagos SET estado = 'pagado', paid_at = NOW() WHERE negocio_id = $1 AND pedido_folio = $2`, [NEG, FOLIO_A]);

  srv = await arrancarServidor({
    PORT: PUERTO, META_GRAPH_BASE_URL: metaMock.baseUrl,
    ANTHROPIC_BASE_URL: ANTHROPIC_URL, ANTHROPIC_API_KEY: 'sk-ant-test-bpp',
    CLIP_API_BASE_URL: `http://localhost:${PUERTO_CLIP}`,
  }, { timeoutMs: 60000 });

  let n = 0;
  const enviar = (texto, tel = TEL) => fetch(`${srv.base}/webhook/whatsapp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: WABA, changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
        contacts: [{ profile: { name: 'Cliente BPP' }, wa_id: tel }],
        messages: [{ from: tel, id: `wamid.bpp.${suf}.${++n}`, timestamp: `${Math.floor(Date.now() / 1000)}`, type: 'text', text: { body: texto } }],
      } }] }],
    }),
  });
  const esperarModelo = async (base) => esperarHasta(async () => llamadasAlModelo > base);

  await t('1. A pagado + "dame otra vez el enlace": el canal NO responde "ya pagado" y NO crea checkout nuevo', async () => {
    const ckAntes = nCk;
    const enlacesAntes = contarEnlaces(TEL);
    const modeloAntes = llamadasAlModelo;
    await enviar('dame otra vez el enlace de pago');
    const llego = await esperarModelo(modeloAntes);
    assert.ok(llego, 'el mensaje no llegó al agente (el canal lo secuestró)');
    await esperar(800);
    assert.strictEqual(contarYaPagado(TEL), 0, 'el canal siguió respondiendo "ya está pagado"');
    assert.strictEqual(nCk, ckAntes, 'se creó un checkout nuevo para la orden ya pagada');
    assert.strictEqual(contarEnlaces(TEL), enlacesAntes, 'se reenvió un enlace de cobro de un pedido pagado');
    assert.strictEqual((await pagosDe(FOLIO_A)).length, 1, 'se duplicó la fila de pagos de A');
  });

  await t('2. A pagado + "quiero hacer un pedido": llega al agente', async () => {
    const modeloAntes = llamadasAlModelo;
    await enviar('Quiero hacer un pedido');
    assert.ok(await esperarModelo(modeloAntes), 'no llegó al agente');
    assert.strictEqual(contarYaPagado(TEL), 0);
  });

  await t('3. A pagado + "una coca y paso por ella pagar con enlace": llega COMPLETO al agente (el caso real)', async () => {
    const texto = `Una ${PROD} y paso por ella, pagar con enlace de pago`;
    assert.strictEqual(detectarSolicitudEnlacePago(texto), true,
      'fixture inválido: la frase debe activar el detector, es justo el caso que se secuestraba');
    const modeloAntes = llamadasAlModelo;
    await enviar(texto);
    assert.ok(await esperarModelo(modeloAntes), 'el mensaje no llegó al agente');
    assert.ok(ultimoPromptUsuario.includes(PROD),
      `el agente no recibió el texto completo: ${ultimoPromptUsuario.slice(0, 120)}`);
    assert.strictEqual(contarYaPagado(TEL), 0, 'volvió a responder "ya está pagado"');
  });

  await t('4. la orden A jamás se reutiliza: sigue pagada, intacta y sin pagos nuevos', async () => {
    const filas = await pagosDe(FOLIO_A);
    assert.strictEqual(filas.length, 1, 'aparecieron pagos extra para A');
    assert.strictEqual(filas[0].estado, 'pagado');
    const { rows: [pa] } = await pool.query(
      `SELECT datos->>'pago_confirmado' AS pc, estado FROM pedidos_activos WHERE folio = $1`, [FOLIO_A]);
    assert.strictEqual(pa.pc, 'true');
    assert.strictEqual(pa.estado, 'nuevo', 'el estado de A cambió solo');
  });

  await t('5. una orden B nueva del mismo cliente nace aparte, con su propia obligación y checkout', async () => {
    const ordenB = await registrarPedido({
      cliente: { nombre: 'Cliente BPP', telefono: TEL },
      telefono_conversacion: TEL,
      modalidad: 'recoger en tienda',
      items: [{ nombre: PROD, cantidad: 1, precio_unitario: 35 }],
      subtotal: 35, costo_envio: 0, descuento: 0, total: 35,
      forma_pago: 'enlace_pago', forma_pago_tipo: 'enlace_pago',
      canal: 'whatsapp', negocioId: NEG,
    }, 'whatsapp');
    assert.notStrictEqual(ordenB.id, FOLIO_A, 'reutilizó el folio de A');
    const ckAntes = nCk;
    const enlaceB = await crearEnlacePago({ negocioId: NEG, pedidoId: ordenB.id, actor: null });
    assert.ok(enlaceB?.url, 'B no obtuvo enlace propio');
    assert.strictEqual(nCk, ckAntes + 1, 'B no generó su propio checkout');
    const pagosB = await pagosDe(ordenB.id);
    assert.strictEqual(pagosB.length, 1, 'B no tiene exactamente una obligación');
    assert.notStrictEqual(pagosB[0].id, (await pagosDe(FOLIO_A))[0].id, 'B comparte obligación con A');
    const pedidos = await pedidosDelTel(TEL);
    assert.strictEqual(pedidos.length, 2, `pedidos del cliente: ${pedidos.length} (deben ser A y B)`);
  });

  await t('6. cobrar A otra vez sigue BLOQUEADO por la capa de pagos (no por el canal)', async () => {
    const ckAntes = nCk;
    let error = null;
    try { await crearEnlacePago({ negocioId: NEG, pedidoId: FOLIO_A, actor: null }); }
    catch (e) { error = e; }
    assert.ok(error, 'crearEnlacePago aceptó cobrar un pedido ya pagado');
    assert.ok(/ya est. pagado/i.test(error.message), `error inesperado: ${error.message}`);
    assert.strictEqual(nCk, ckAntes, 'llegó a crear checkout antes de rechazar');
  });

  await t('7. el atajo original sigue vivo: pedido SIN pagar + "mándame el enlace" => enlace determinista', async () => {
    // Se deja a B como único pedido sin pagar del cliente.
    const enlacesAntes = contarEnlaces(TEL);
    await enviar('mándame el enlace de pago');
    const ok = await esperarHasta(async () => contarEnlaces(TEL) > enlacesAntes);
    assert.ok(ok, `el atajo dejó de enviar el enlace: ${JSON.stringify(salientes(TEL).slice(-3))}`);
  });

  await t('8. aislamiento: otro teléfono del mismo negocio no hereda pedidos ajenos', async () => {
    const modeloAntes = llamadasAlModelo;
    await enviar('dame el enlace de pago', TEL_OTRO);
    assert.ok(await esperarModelo(modeloAntes), 'el mensaje del otro cliente no llegó al agente');
    assert.strictEqual(contarEnlaces(TEL_OTRO), 0, 'le mandó a otro cliente el enlace de un pedido ajeno');
    assert.strictEqual(contarYaPagado(TEL_OTRO), 0);
    assert.strictEqual((await pedidosDelTel(TEL_OTRO)).length, 0, 'se le atribuyeron pedidos a otro teléfono');
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL: ' + e.message);
} finally {
  try {
    if (srv) { srv.detener(); await new Promise((r) => { srv.proc.once('exit', r); setTimeout(r, 3000); }); }
  } catch { /* abajo */ }
  clipMock.close();
  anthropicMock.close();
  metaMock.detener();
  if (botOriginal !== null) {
    await pool.query(`UPDATE negocios SET bot_whatsapp_activo = $2 WHERE id = $1`, [NEG, botOriginal]).catch(() => {});
  }
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-bot-pedido-tras-pago: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
