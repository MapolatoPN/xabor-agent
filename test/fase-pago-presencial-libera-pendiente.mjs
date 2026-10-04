// «Pasar a efectivo» un pedido que esperaba el pago con enlace (XAB-1130, 2-oct).
//
// Un pedido de WhatsApp en `pendiente_pago` (enlace de Clip) se pasó a
// efectivo con ✏️ Corregir forma de pago. La ruta solo reescribió la etiqueta:
// el pedido siguió esperando el pago, no salió comanda y el vencimiento del
// enlace lo canceló solo a los 30 min.
//
// Lo que esta suite exige:
//   · SIN bandera: la ruta ya no reetiqueta un pedido que espera el pago ni uno
//     cancelado; responde 409 diciendo qué hacer.
//   · CON `pago_presencial_libera_pendiente`: pasar a efectivo o terminal manda
//     el pedido a cocina una sola vez, bajo el lock de la obligación de pago,
//     vence el intento del enlace como 'vencido' y deja auditoría. No libera
//     si hay anticipo obligatorio, programado, pago en revisión, pago ya
//     asentado, tienda, o si el pendiente no lo causó el enlace.
//   · Después: el vencimiento ya no lo cancela, un enlace nuevo no se crea, y
//     el dinero en línea que entre por cualquier puerta se asienta como
//     pago_tardio, sin segunda comanda, y avisa al panel.
//
// Revisión del 3-oct (correcciones 1-4 y mejoras), también exigido aquí:
//   · Caja lista el dinero en línea por revisar (cobro tras pasar a efectivo y
//     pago de un pedido cancelado), en el recuadro que el panel ya pinta, en
//     el corte cerrado y en su ticket. No suma a ventas.
//   · Los textos no prometen lo que el panel no hace y dicen que se avise al
//     cliente que no pague el enlace. El del cancelado, solo si el pedido
//     tiene o tuvo uno (un cancelado del POS no habla de enlaces).
//   · Ya liberado, ✏️ solo entre efectivo y terminal, y cambia tipo y marca.
//   · Antes de liberar se reconsulta a Clip (mock local): si ya cobró, no se
//     libera; si no contesta a tiempo, se libera sin esperar; con la bandera
//     apagada no se le pregunta nada.
//
// Servidor y Postgres reales. Sin Meta. Clip es un mock local (CLIP_API_BASE_URL,
// override solo-pruebas); los demás cobros se simulan en la base y por la
// confirmación manual de transferencias.
//
// Uso: DATABASE_URL=... node test/fase-pago-presencial-libera-pendiente.mjs
import { createHmac, randomBytes } from 'crypto';
import { createServer } from 'http';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT_LIBERA_PENDIENTE || '4797';
const CLAVE_ADMIN = 'clave-de-prueba-libera';

// ═══════════ Mock de Clip (antes de importar: clip-api.js lee la URL al cargar) ═══════════
// GET /v2/checkout/{id} con la forma documentada. Cada prueba fija qué
// contesta para SU checkout; uno que no está fijado responde 404 (= Clip no
// sabe nada, igual que sin credenciales).
const respuestasClip = new Map();
const llamadasClip = [];
const clipMock = createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v2/checkout/')) {
    const id = decodeURIComponent(req.url.split('/').pop());
    llamadasClip.push(id);
    const r = respuestasClip.get(id);
    if (!r) { res.statusCode = 404; res.end('{}'); return; }
    setTimeout(() => {
      try {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          object_type: 'payment_link', payment_request_id: id, status: r.status,
          amount: Number(r.monto), currency: 'MXN', metadata: { external_reference: r.ref },
          payment_request_url: `https://pago.mock.clip/${id}`,
        }));
      } catch { /* la conexión ya se cerró */ }
    }, r.demoraMs || 0);
    return;
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise(r => clipMock.listen(0, '127.0.0.1', r));
process.env.CLIP_API_BASE_URL = `http://127.0.0.1:${clipMock.address().port}`;
// Las credenciales de Clip del negocio de prueba se cifran: sin clave de
// integraciones en el entorno se usa una desechable (el hijo la hereda).
if (!process.env.INTEGRATIONS_ENCRYPTION_KEY) process.env.INTEGRATIONS_ENCRYPTION_KEY = randomBytes(32).toString('base64');

const { pool, calcularVersionPedidoHash, asentarPagoRealVerificado, vencerEsperaDePago, marcarPagoConComprobanteEnRevision } =
  await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { expirarPagosVencidos } = await import('../src/services/webhookPagos.js');
const { crearEnlacePago } = await import('../src/services/pagosService.js');
const { guardarCredencialesClip } = await import('../src/services/integracionesService.js');
const {
  tipoPresencial, banderaEncendida, liberarPendientePagoAPresencialTx, corregirFormaDePedidoLiberadoTx,
  BANDERA_LIBERA_PENDIENTE, TEXTOS,
} = await import('../src/orders/liberarPagoPresencial.js');
const {
  setBroadcastAvisoCobroTrasPresencial, textoAvisoCobroTrasPresencial, ANOMALIA_COBRO_TRAS_PRESENCIAL,
} = await import('../src/services/avisoCobroTrasPresencial.js');
const {
  alertasDePagosEnLinea, avisoCajaDeAlertas, ticketCorte, zonaHorariaNegocio, fechaOperativaDe,
  ALERTA_COBRO_TRAS_PRESENCIAL, ALERTA_PAGO_TARDIO,
} = await import('../src/services/cortesCaja.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

// Lo que lee el equipo al tocar ✏️ en un pedido cancelado, escrito aquí
// completo (no armado con las constantes del módulo) para que cualquier
// cambio de redacción se vea.
const CANCELADO_CON_ENLACE = 'Este pedido está cancelado (si esperaba el pago con enlace, venció la espera): '
  + 'cambiar la forma de pago no lo revive. Si el cliente sí lo quiere, captúralo de nuevo en el POS y avísale al '
  + 'cliente que NO pague el enlace que ya tiene: sigue activo y se le cobraría dos veces. Si lo paga de todos '
  + 'modos, Caja lo marca en «Pagos en línea por revisar» para devolverlo.';
const CANCELADO_SIN_ENLACE = 'Este pedido está cancelado: cambiar la forma de pago no lo revive. '
  + 'Si el cliente sí lo quiere, captúralo de nuevo en el POS.';

// ═══════════ Puras ═══════════
await t('PURO', 'P1. solo efectivo y terminal se cobran en persona', async () => {
  const casos = {
    'efectivo': 'efectivo', ' Efectivo ': 'efectivo', 'terminal (tarjeta presente)': 'terminal', 'terminal': 'terminal',
    'rappi': null, 'enlace de pago': null, 'enlace_pago': null, 'transferencia': null, '': null, 'por_cobrar': null,
  };
  for (const [entrada, esperado] of Object.entries(casos)) {
    assert(tipoPresencial(entrada) === esperado, `${JSON.stringify(entrada)} → ${tipoPresencial(entrada)}`);
  }
  assert(tipoPresencial(undefined) === null && tipoPresencial(null) === null, 'vacío no es presencial');
});
await t('PURO', 'P2. la bandera solo se enciende con «true»', async () => {
  assert(banderaEncendida('true') && banderaEncendida(' TRUE ') && banderaEncendida(true), 'true no enciende');
  for (const v of ['false', '1', 'si', '', null, undefined]) assert(!banderaEncendida(v), `${v} enciende`);
});
await t('PURO', 'P3. los textos dicen qué hacer', async () => {
  assert(/captúralo de nuevo en el POS/.test(TEXTOS.esperaPagoBanderaApagada), 'la traba no dice qué hacer');
  assert(/No lo pases a «Preparando»/.test(TEXTOS.esperaPagoBanderaApagada), 'la traba no advierte el atajo de «Preparando»');
  // Verificación final: el texto del cancelado, palabra por palabra. Con
  // enlace avisa que no lo pague (antes acababa en «…dos veces anterior.»);
  // sin enlace (un cancelado del POS) no menciona ningún enlace.
  assert(TEXTOS.cancelado({ conEnlace: true }) === CANCELADO_CON_ENLACE, `cancelado con enlace: ${TEXTOS.cancelado({ conEnlace: true })}`);
  assert(TEXTOS.cancelado({ conEnlace: false }) === CANCELADO_SIN_ENLACE, `cancelado sin enlace: ${TEXTOS.cancelado({ conEnlace: false })}`);
  assert(TEXTOS.cancelado() === CANCELADO_CON_ENLACE, 'sin el dato, el cancelado no avisa del enlace');
  const aviso = textoAvisoCobroTrasPresencial({ folio: 'X-1', monto: 120, formaPresencial: 'efectivo' });
  assert(/No le cobren otra vez/.test(aviso) && /reembolsar/.test(aviso) && /\$120\.00/.test(aviso), aviso);
  // Corrección 2: cancelar no apaga el enlace; el texto tiene que decirlo.
  for (const [nombre, texto] of [['traba', TEXTOS.esperaPagoBanderaApagada], ['cancelado', TEXTOS.cancelado({ conEnlace: true })],
    ['anticipo', TEXTOS.anticipoObligatorio], ['programado', TEXTOS.programado]]) {
    assert(/NO pague el enlace/i.test(texto), `el texto «${nombre}» no dice que se avise al cliente que no pague el enlace: ${texto}`);
  }
  // Corrección 3: ningún texto promete confirmar o rechazar desde el panel.
  const revEnlace = TEXTOS.pagoEnRevision({ transferencia: false });
  const revTransf = TEXTOS.pagoEnRevision({ transferencia: true });
  for (const t of [revEnlace, revTransf]) assert(!/confírmalo o recházalo/i.test(t), `promete una acción imposible: ${t}`);
  assert(/Clip todavía no confirma/.test(revEnlace) && /NO pague el enlace/.test(revEnlace), revEnlace);
  assert(/soporte de Xabor/.test(revTransf) && /banco/.test(revTransf), revTransf);
});
await t('PURO', 'P4. Caja: alertas de pagos en línea, una por pago, con qué hacer', async () => {
  const al = alertasDePagosEnLinea([
    { pago_id: 'a', folio: 'X-1', monto: '120.5', proveedor: 'clip', paid_at: '2026-10-03T18:00:00Z',
      tras_presencial: true, forma_presencial: 'efectivo', pedido_estado: 'entregado' },
    { pago_id: 'a', folio: 'X-1', monto: '120.5', proveedor: 'clip', paid_at: '2026-10-03T18:00:00Z', tras_presencial: true },
    { pago_id: 'b', folio: 'X-2', monto: 80, proveedor: 'clip', paid_at: '2026-10-03T19:00:00Z',
      tras_presencial: null, forma_presencial: 'enlace_pago', pedido_estado: 'cancelado' },
    { pago_id: 'c', folio: 'X-3', monto: 90, proveedor: 'manual_transfer', tras_presencial: true,
      forma_presencial: 'terminal', pedido_estado: 'nuevo' },
  ]);
  assert(al.length === 3, `alertas: ${JSON.stringify(al)}`);
  assert(al[0].tipo === ALERTA_COBRO_TRAS_PRESENCIAL && al[0].monto === 120.5
    && /\$120\.50/.test(al[0].mensaje) && /No le cobren otra vez/.test(al[0].mensaje) && /en efectivo/.test(al[0].mensaje)
    && /no dejó efectivo en la caja/.test(al[0].mensaje), al[0].mensaje);
  assert(al[1].tipo === ALERTA_PAGO_TARDIO && /pedido cancelado/.test(al[1].mensaje) && /reembolsen/.test(al[1].mensaje), al[1].mensaje);
  assert(al[2].forma_presencial === 'terminal' && /con terminal/.test(al[2].mensaje) && /transferencia/.test(al[2].mensaje), al[2].mensaje);
  const aviso = avisoCajaDeAlertas(al);
  assert(/^⚠ PAGOS EN LÍNEA POR REVISAR \(3\)/.test(aviso) && ['X-1', 'X-2', 'X-3'].every(f => aviso.includes(f)), aviso);
  assert(avisoCajaDeAlertas([]) === null && alertasDePagosEnLinea([]).length === 0, 'sin pagos hay aviso');
});
await t('PURO', 'P5. el ticket del corte trae los pagos en línea por revisar (y sin ellos, nada)', async () => {
  const base = { folio: 'COR-000001', fecha_operativa: '2026-10-03', cerrado_at: '2026-10-04T04:00:00Z',
    pedidos_count: 0, cancelaciones_count: 0, diferencia: 0, efectivo_contado: null };
  const alertas = alertasDePagosEnLinea([
    { pago_id: 'a', folio: 'XAB-1130', monto: 250, proveedor: 'clip', tras_presencial: true, forma_presencial: 'efectivo' },
    { pago_id: 'b', folio: 'XAB-1131', monto: 99, proveedor: 'clip', tras_presencial: false, pedido_estado: 'cancelado' },
  ]);
  const con = ticketCorte({ ...base, snapshot_json: { alertas_pago: alertas } });
  assert(/PAGOS EN LINEA POR REVISAR:/.test(con) && con.includes('XAB-1130') && con.includes('XAB-1131')
    && /tras efectivo/.test(con) && /reembolsar/.test(con), con);
  assert(con.split('\n').every(l => l.length <= 32), 'una línea del ticket pasa de 32 columnas');
  const sin = ticketCorte({ ...base, snapshot_json: {} });
  assert(!/PAGOS EN LINEA/.test(sin), 'el ticket sin alertas cambió');
});

// ═══════════ Negocios de prueba (se reconstruyen en cada corrida) ═══════════
const SLUG = 'pago-presencial-libera';
const SLUG_OTRO = 'pago-presencial-libera-otro';
async function limpiar() {
  for (const slug of [SLUG, SLUG_OTRO]) {
    const { rows } = await pool.query(`SELECT id FROM negocios WHERE slug = $1`, [slug]);
    if (!rows.length) continue;
    const id = rows[0].id;
    const q = (sql) => pool.query(sql, [id]).catch(() => {});
    await q(`DELETE FROM auditoria_plataforma WHERE negocio_id = $1`);
    await q(`DELETE FROM auditoria_plataforma WHERE superadmin_id IN (SELECT id FROM usuarios WHERE negocio_id = $1)
              OR actor_usuario_id IN (SELECT id FROM usuarios WHERE negocio_id = $1)`);
    await q(`DELETE FROM tienda_promocion_usos WHERE negocio_id = $1`);
    await q(`DELETE FROM tienda_promociones WHERE negocio_id = $1`);
    await q(`DELETE FROM pagos WHERE negocio_id = $1`);
    await q(`DELETE FROM impresion_trabajos WHERE negocio_id = $1`);
    await q(`DELETE FROM pedido_emisiones WHERE negocio_id = $1`);
    await q(`DELETE FROM compras_reales WHERE negocio_id = $1`);
    await q(`DELETE FROM pedidos_activos WHERE negocio_id = $1`);
    await q(`DELETE FROM movimientos_caja WHERE negocio_id = $1`);
    await q(`DELETE FROM cortes_caja WHERE negocio_id = $1`);
    await q(`DELETE FROM caja_fondos WHERE negocio_id = $1`);
    await q(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN
              (SELECT id FROM integraciones_canal WHERE negocio_id = $1)`);
    await q(`DELETE FROM integraciones_canal WHERE negocio_id = $1`);
    await q(`DELETE FROM configuracion WHERE negocio_id = $1`);
    await q(`DELETE FROM negocio_modulos WHERE negocio_id = $1`);
    await q(`DELETE FROM sucursales WHERE negocio_id = $1`);
    await q(`DELETE FROM usuario_negocios WHERE negocio_id = $1`);
    await q(`DELETE FROM usuarios WHERE negocio_id = $1`);
    await q(`DELETE FROM negocios WHERE id = $1`);
  }
}
await limpiar();

async function crearNegocio(nombre, slug) {
  const { rows: [neg] } = await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ($1, $2) RETURNING id`, [nombre, slug]);
  for (const m of ['pos', 'caja']) {
    await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [neg.id, m]);
  }
  await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')`, [neg.id]);
  return neg.id;
}
const N = await crearNegocio('Libera Pendiente', SLUG);
const N2 = await crearNegocio('Libera Pendiente Otro', SLUG_OTRO);
async function persona(negocioId, nombre, rol) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,'x') RETURNING id`,
    [negocioId, nombre, `${SLUG}-${rol}-${randomBytes(4).toString('hex')}@test.local`]);
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,$3)`, [u.id, negocioId, rol]);
  return u.id;
}
const ADMIN = await persona(N, 'Ana Admin', 'admin');
const STAFF = await persona(N, 'Sara Staff', 'staff');

const RUN = randomBytes(3).toString('hex').toUpperCase().slice(0, 5);
let nFolio = 0;
const nuevoFolio = () => `LB${RUN}-${String(++nFolio).padStart(2, '0')}`;
const MODALIDAD = 'recoger en tienda';

// Un pedido como lo deja el Mesero al elegir «enlace de pago»: nace
// pendiente_pago con su intento de cobro vivo en `pagos`.
async function pedidoEsperandoEnlace({ negocioId = N, total = 150, extra = {}, conPago = true, estadoPago = 'pendiente' } = {}) {
  const folio = nuevoFolio();
  const datos = {
    id: folio, negocioId, canal: 'whatsapp', modalidad: MODALIDAD, estado: 'pendiente_pago',
    forma_pago: 'enlace_pago', forma_pago_tipo: 'enlace_pago', requierePagoAnticipado: true,
    pago_confirmado: false, subtotal: total, total, timestamp: new Date().toISOString(),
    cliente: { nombre: 'Cliente Enlace', telefono: '5550000000' },
    items: [{ nombre: 'Enchiladas', cantidad: 1, precio_unitario: total }],
    ...extra,
  };
  await pool.query(`INSERT INTO pedidos_activos (folio, estado, datos, negocio_id) VALUES ($1,'pendiente_pago',$2,$3)`,
    [folio, JSON.stringify(datos), negocioId]);
  let pagoId = null;
  if (conPago) {
    const { rows: [p] } = await pool.query(
      `INSERT INTO pagos (negocio_id, pedido_folio, proveedor, referencia_interna, tipo, monto, estado,
                          version_pedido_hash, url, referencia_externa, xabor_espera_hasta)
       VALUES ($1,$2,'clip',$3,'enlace_pago',$4,$5,$6,$7,$8, NOW() + interval '30 minutes') RETURNING id`,
      [negocioId, folio, `ref-${folio}`, total, estadoPago, calcularVersionPedidoHash(datos),
       `https://pago.mock.clip/${folio}`, `clip-${folio}`]);
    pagoId = p.id;
  }
  return { folio, pagoId, datos };
}

const fechaDeCaja = async (instante) => fechaOperativaDe(new Date(instante), await zonaHorariaNegocio(N));
const fila = async (folio, negocioId = N) =>
  (await pool.query(`SELECT estado, datos FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, negocioId])).rows[0];
const pagoDe = async (id) => (await pool.query(`SELECT * FROM pagos WHERE id = $1`, [id])).rows[0];
const cuenta = async (sql, params) => (await pool.query(sql, params)).rows[0].n;
const compras = (folio) => cuenta(`SELECT COUNT(*)::int AS n FROM compras_reales WHERE negocio_id = $1 AND folio = $2`, [N, folio]);
const emisiones = async (folio) => (await pool.query(
  `SELECT estado FROM pedido_emisiones WHERE negocio_id = $1 AND folio = $2`, [N, folio])).rows.map(r => r.estado);
async function bandera(valor) {
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $3`, [N, BANDERA_LIBERA_PENDIENTE, valor]);
}

// Un pedido que ya esperaba el enlace ANTES de arrancar: el servidor lo sube a
// su memoria. Los demás nacen con el servidor andando (no están en memoria).
const PRINCIPAL = await pedidoEsperandoEnlace();

// El tope de la reconsulta a Clip se acorta en pruebas (solo fuera de
// production; con NODE_ENV=production rige el de siempre, 6 s).
const TOPE_RECONSULTA_MS = 1500;
const srv = await arrancarServidor({
  PORT: PUERTO, ADMIN_PASSWORD: CLAVE_ADMIN, XABOR_TEST_TOPE_RECONSULTA_CLIP_MS: String(TOPE_RECONSULTA_MS),
}, { timeoutMs: 60000 });
const galleta = (id, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: id, negocioId: N, rol }))}`;
const cookieAdmin = galleta(ADMIN, 'admin');
const cookieStaff = galleta(STAFF, 'staff');
async function api(path, { cookie = cookieAdmin, method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(srv.base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
const cambiarPago = (folio, forma_pago, opts = {}) =>
  api(`/api/admin/pedido/${folio}/pago`, { method: 'PATCH', body: { forma_pago }, ...opts });

// Panel del negocio escuchando el WebSocket, como una tablet de la cocina.
const EVENTOS = [];
const ws = await new Promise((resolve, reject) => {
  const s = new WebSocket(srv.base.replace('http://', 'ws://') + '/ws/panel', { headers: { Cookie: cookieAdmin } });
  const to = setTimeout(() => reject(new Error('timeout abriendo WS panel')), 10000);
  s.on('open', () => { clearTimeout(to); resolve(s); });
  s.on('error', (e) => { clearTimeout(to); reject(e); });
  s.on('message', (raw) => { try { EVENTOS.push(JSON.parse(raw.toString())); } catch {} });
});
const enVivo = (tipo, folio) => EVENTOS.filter(e => e.tipo === tipo && !e.replay
  && (e.pedido?.id === folio || e.id === folio || e.pedidoId === folio));
async function esperarEvento(tipo, folio, ms = 5000) {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) {
    if (enVivo(tipo, folio).length) return enVivo(tipo, folio);
    await dormir(100);
  }
  return enVivo(tipo, folio);
}

try {
  // ═══════════ Traba SIN bandera ═══════════
  await t('TRABA', '1. bandera apagada: 409 con qué hacer, y la etiqueta, el estado y el enlace no cambian', async () => {
    const r = await cambiarPago(PRINCIPAL.folio, 'efectivo');
    assert(r.status === 409 && r.body?.codigo === 'PEDIDO_ESPERA_PAGO_EN_LINEA', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    assert(/captúralo de nuevo en el POS/.test(r.body.error), `el texto no dice qué hacer: ${r.body.error}`);
    assert(/NO pague el enlace/.test(r.body.error), `el texto no dice que se avise al cliente: ${r.body.error}`);
    const f = await fila(PRINCIPAL.folio);
    assert(f.estado === 'pendiente_pago' && f.datos.forma_pago === 'enlace_pago', `base: ${f.estado} ${f.datos.forma_pago}`);
    assert((await pagoDe(PRINCIPAL.pagoId)).estado === 'pendiente', 'el intento de pago cambió');
    assert((await emisiones(PRINCIPAL.folio)).length === 0, 'se creó deuda de comanda');
  });
  await t('TRABA', '2. un pedido cancelado no se reetiqueta: 409 PEDIDO_CANCELADO', async () => {
    // Como lo deja vencerEsperaDePago: el pedido cancelado y su enlace vencido
    // en Xabor (en Clip sigue cobrable).
    const { folio, pagoId } = await pedidoEsperandoEnlace();
    await pool.query(`UPDATE pedidos_activos SET estado = 'cancelado', datos = datos || '{"expirado_por_pago":true}'::jsonb
                       WHERE folio = $1`, [folio]);
    await pool.query(`UPDATE pagos SET estado = 'vencido' WHERE id = $1`, [pagoId]);
    const r = await cambiarPago(folio, 'efectivo');
    assert(r.status === 409 && r.body?.codigo === 'PEDIDO_CANCELADO', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    assert(r.body.error === CANCELADO_CON_ENLACE, `texto: ${r.body.error}`);
    const f = await fila(folio);
    assert(f.estado === 'cancelado' && f.datos.forma_pago === 'enlace_pago', `base: ${f.estado} ${f.datos.forma_pago}`);
  });
  await t('TRABA', '2b. cancelado del POS (nunca tuvo enlace): 409 sin mencionar ningún enlace', async () => {
    const folio = nuevoFolio();
    const datos = {
      id: folio, negocioId: N, canal: 'pos', modalidad: MODALIDAD, estado: 'cancelado',
      forma_pago: 'efectivo', forma_pago_tipo: 'efectivo', subtotal: 90, total: 90, timestamp: new Date().toISOString(),
      cliente: { nombre: 'Mostrador', telefono: '—' }, items: [{ nombre: 'Agua', cantidad: 1, precio_unitario: 90 }],
    };
    await pool.query(`INSERT INTO pedidos_activos (folio, estado, datos, negocio_id) VALUES ($1,'cancelado',$2,$3)`,
      [folio, JSON.stringify(datos), N]);
    const r = await cambiarPago(folio, 'terminal (tarjeta presente)');
    assert(r.status === 409 && r.body?.codigo === 'PEDIDO_CANCELADO', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    assert(r.body.error === CANCELADO_SIN_ENLACE, `texto: ${r.body.error}`);
    const f = await fila(folio);
    assert(f.estado === 'cancelado' && f.datos.forma_pago === 'efectivo', `base: ${f.estado} ${f.datos.forma_pago}`);
  });
  await t('TRABA', '2c. cancelado con enlace legacy (clip_link_id, sin fila en pagos): avisa del enlace', async () => {
    const { folio } = await pedidoEsperandoEnlace({
      conPago: false, extra: { forma_pago: 'efectivo', forma_pago_tipo: 'efectivo', clip_link_id: 'legacy-ck-1' } });
    await pool.query(`UPDATE pedidos_activos SET estado = 'cancelado' WHERE folio = $1`, [folio]);
    const r = await cambiarPago(folio, 'efectivo');
    assert(r.status === 409 && r.body?.codigo === 'PEDIDO_CANCELADO' && r.body.error === CANCELADO_CON_ENLACE,
      `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
  });
  await t('TRABA', '3. el personal no corrige formas de pago: 403', async () => {
    const r = await cambiarPago(PRINCIPAL.folio, 'efectivo', { cookie: cookieStaff });
    assert(r.status === 403, `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    assert((await fila(PRINCIPAL.folio)).estado === 'pendiente_pago', 'cambió el estado');
  });
  await t('TRABA', '4. el folio de otro negocio responde 404 y no se toca', async () => {
    const ajeno = await pedidoEsperandoEnlace({ negocioId: N2 });
    const r = await cambiarPago(ajeno.folio, 'efectivo');
    assert(r.status === 404, `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    const f = await fila(ajeno.folio, N2);
    assert(f.estado === 'pendiente_pago' && f.datos.forma_pago === 'enlace_pago', 'se tocó el pedido ajeno');
  });

  // ═══════════ Liberación CON bandera ═══════════
  const enciende = await api('/api/config', { method: 'PUT', body: { [BANDERA_LIBERA_PENDIENTE]: 'true' } });
  assert(enciende.status === 200, `no se pudo encender la bandera: ${enciende.status}`);

  await t('LIBERA', '5. a efectivo: sale a cocina una vez, el enlace vence y queda quién lo hizo', async () => {
    const r = await cambiarPago(PRINCIPAL.folio, 'efectivo');
    assert(r.status === 200 && r.body?.liberado === true && r.body?.comandaEmitida === true, `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    const f = await fila(PRINCIPAL.folio);
    const d = f.datos;
    assert(f.estado === 'nuevo', `estado ${f.estado}`);
    assert(d.forma_pago === 'efectivo' && d.forma_pago_tipo === 'efectivo' && d.requierePagoAnticipado === false,
      `datos: ${JSON.stringify({ f: d.forma_pago, t: d.forma_pago_tipo, a: d.requierePagoAnticipado })}`);
    assert(d.pago_confirmado !== true, 'quedó como pagado');
    const m = d.pago_cambiado_a_presencial;
    assert(m && m.por === ADMIN && m.forma_pago_anterior === 'enlace_pago' && m.pagos_vencidos?.[0] === PRINCIPAL.pagoId,
      `marca: ${JSON.stringify(m)}`);
    const p = await pagoDe(PRINCIPAL.pagoId);
    assert(p.estado === 'vencido', `el intento quedó '${p.estado}' (debe ser 'vencido', no 'invalidado')`);
    assert(p.metadata_sanitizada?.cambiado_a_presencial === true && p.metadata_sanitizada?.cambiado_a_presencial_por === ADMIN,
      `metadata: ${JSON.stringify(p.metadata_sanitizada)}`);
    assert(JSON.stringify(await emisiones(PRINCIPAL.folio)) === '["saldada"]', `emisiones: ${JSON.stringify(await emisiones(PRINCIPAL.folio))}`);
    assert(await compras(PRINCIPAL.folio) === 1, 'compra real distinta de 1');
    const vivos = await esperarEvento('nuevo_pedido', PRINCIPAL.folio);
    assert(vivos.length === 1 && vivos[0].pedido?.estado === 'nuevo', `nuevo_pedido en vivo: ${vivos.length}`);
    assert((await esperarEvento('actualizar_pago', PRINCIPAL.folio)).some(e => e.forma_pago === 'efectivo'), 'sin actualizar_pago');
    const { rows: aud } = await pool.query(
      `SELECT actor_usuario_id, contexto FROM auditoria_plataforma
        WHERE negocio_id = $1 AND accion = 'pedido_liberado_a_pago_presencial'`, [N]);
    assert(aud.length === 1 && aud[0].actor_usuario_id === ADMIN && aud[0].contexto?.folio === PRINCIPAL.folio,
      `auditoría: ${JSON.stringify(aud)}`);
  });
  await t('LIBERA', '6. repetir el cambio no saca otra comanda', async () => {
    // Ya liberado, la ruta lo manda al camino del pedido liberado (no al de
    // reetiquetar): la misma forma es idempotente y lo dice. Es también lo que
    // hace determinista la prueba 7 cuando la segunda pantalla llega tarde.
    const r = await cambiarPago(PRINCIPAL.folio, 'efectivo');
    assert(r.status === 200 && r.body?.yaLiberado === true, `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    await dormir(1200);
    assert(await compras(PRINCIPAL.folio) === 1, 'segunda compra real');
    assert(JSON.stringify(await emisiones(PRINCIPAL.folio)) === '["saldada"]', 'otra deuda de comanda');
    assert(enVivo('nuevo_pedido', PRINCIPAL.folio).length === 1, 'otro nuevo_pedido en vivo');
  });
  await t('LIBERA', '7. dos pantallas a la vez: una libera, la otra es idempotente, una sola comanda', async () => {
    const { folio } = await pedidoEsperandoEnlace();
    const [a, b] = await Promise.all([cambiarPago(folio, 'efectivo'), cambiarPago(folio, 'efectivo')]);
    assert(a.status === 200 && b.status === 200, `respuestas: ${a.status} ${b.status} ${JSON.stringify([a.body, b.body])}`);
    assert([a, b].filter(x => x.body?.yaLiberado === true).length === 1, `idempotencia: ${JSON.stringify([a.body, b.body])}`);
    assert(await compras(folio) === 1 && JSON.stringify(await emisiones(folio)) === '["saldada"]', 'más de una comanda');
  });
  await t('LIBERA', '8. ya liberado a efectivo, «terminal» por la transición no se traga en silencio', async () => {
    const r = await liberarPendientePagoAPresencialTx({
      negocioId: N, folio: PRINCIPAL.folio, formaPago: 'terminal (tarjeta presente)', actor: { usuarioId: ADMIN } });
    assert(r.ok === false && r.codigo === 'YA_LIBERADO_CON_OTRA_FORMA', `resultado: ${JSON.stringify(r)}`);
    const igual = await liberarPendientePagoAPresencialTx({
      negocioId: N, folio: PRINCIPAL.folio, formaPago: 'efectivo', actor: { usuarioId: ADMIN } });
    assert(igual.ok === true && igual.yaLiberado === true, `misma forma: ${JSON.stringify(igual)}`);
  });
  await t('LIBERA', '9. a terminal también libera, con su tipo', async () => {
    const { folio } = await pedidoEsperandoEnlace();
    const r = await cambiarPago(folio, 'terminal (tarjeta presente)');
    assert(r.status === 200 && r.body?.liberado, `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    const f = await fila(folio);
    assert(f.estado === 'nuevo' && f.datos.forma_pago_tipo === 'terminal', `base: ${f.estado} ${f.datos.forma_pago_tipo}`);
  });

  // ═══════════ Después de liberar ═══════════
  await t('DESPUES', '10. el vencimiento del enlace ya no cancela el pedido liberado', async () => {
    await pool.query(`UPDATE pagos SET xabor_espera_hasta = NOW() - interval '5 minutes' WHERE id = $1`, [PRINCIPAL.pagoId]);
    await expirarPagosVencidos();
    const v = await vencerEsperaDePago(PRINCIPAL.pagoId, N);
    assert(v.ok === false, `vencerEsperaDePago lo tocó: ${JSON.stringify(v)}`);
    assert((await fila(PRINCIPAL.folio)).estado === 'nuevo', 'el pedido se canceló');
  });
  await t('DESPUES', '11. «mándame el enlace» no crea un cobro nuevo sobre el pedido liberado', async () => {
    const antes = await cuenta(`SELECT COUNT(*)::int AS n FROM pagos WHERE negocio_id = $1 AND pedido_folio = $2`, [N, PRINCIPAL.folio]);
    let error = null;
    try { await crearEnlacePago({ negocioId: N, pedidoId: PRINCIPAL.folio }); } catch (e) { error = e; }
    assert(error?.code === 'PEDIDO_INVALIDO' && /se cobra en persona/.test(error.message), `sin rechazo: ${error?.code} ${error?.message}`);
    const despues = await cuenta(`SELECT COUNT(*)::int AS n FROM pagos WHERE negocio_id = $1 AND pedido_folio = $2`, [N, PRINCIPAL.folio]);
    assert(antes === despues, `se creó un intento: ${antes} → ${despues}`);
  });
  await t('DESPUES', '12. la clienta paga el enlace vencido: pago_tardio, sin pagado ni segunda comanda, y avisa', async () => {
    const avisos = [];
    setBroadcastAvisoCobroTrasPresencial((negocioId, evento) => avisos.push({ negocioId, evento }));
    try {
      const r = await asentarPagoRealVerificado({ pagoId: PRINCIPAL.pagoId, negocioId: N, referenciaExterna: `clip-${PRINCIPAL.folio}` });
      assert(r.ok === false && r.resultado === 'pago_tardio', `transición: ${JSON.stringify({ ok: r.ok, resultado: r.resultado })}`);
      const p = await pagoDe(PRINCIPAL.pagoId);
      assert(p.estado === 'pagado' && p.derivacion_pendiente === false, `pago: ${p.estado} deuda=${p.derivacion_pendiente}`);
      assert(p.metadata_sanitizada?.anomalia === 'pago_tardio' && p.metadata_sanitizada?.[ANOMALIA_COBRO_TRAS_PRESENCIAL] === true,
        `metadata: ${JSON.stringify(p.metadata_sanitizada)}`);
      const f = await fila(PRINCIPAL.folio);
      assert(f.estado === 'nuevo' && f.datos.pago_confirmado !== true, `pedido: ${f.estado} pagado=${f.datos.pago_confirmado}`);
      assert(await compras(PRINCIPAL.folio) === 1 && JSON.stringify(await emisiones(PRINCIPAL.folio)) === '["saldada"]', 'otra comanda');
      assert(avisos.length === 1 && avisos[0].negocioId === N && avisos[0].evento?.tipo === 'pago_anomalia'
        && avisos[0].evento?.anomalia === ANOMALIA_COBRO_TRAS_PRESENCIAL && avisos[0].evento?.pedidoId === PRINCIPAL.folio,
        `aviso: ${JSON.stringify(avisos)}`);
    } finally {
      setBroadcastAvisoCobroTrasPresencial(null);
    }
  });
  await t('DESPUES', '13. dinero por OTRA puerta (transferencia confirmada a mano): pago_tardio y el panel lo ve', async () => {
    const { folio, datos } = await pedidoEsperandoEnlace();
    const r = await cambiarPago(folio, 'efectivo');
    assert(r.status === 200 && r.body?.liberado, `liberar: ${r.status} ${JSON.stringify(r.body)}`);
    const { rows: [tr] } = await pool.query(
      `INSERT INTO pagos (negocio_id, pedido_folio, proveedor, referencia_interna, tipo, monto, estado, version_pedido_hash)
       VALUES ($1,$2,'manual_transfer',$3,'transferencia',$4,'requiere_revision',$5) RETURNING id`,
      [N, folio, `tr-${folio}`, datos.total, calcularVersionPedidoHash(datos)]);
    const c = await api(`/api/admin/pagos/${tr.id}/confirmar-manual`, { method: 'POST' });
    assert(c.status === 409 && c.body?.resultado === 'pago_tardio', `confirmar: ${c.status} ${JSON.stringify(c.body)}`);
    const f = await fila(folio);
    assert(f.datos.pago_confirmado !== true, 'el pedido liberado quedó pagado: doble cobro silencioso');
    const anomalias = await esperarEvento('pago_anomalia', folio);
    assert(anomalias.some(e => e.anomalia === ANOMALIA_COBRO_TRAS_PRESENCIAL && /No le cobren otra vez/.test(e.mensaje || '')),
      `el panel no recibió el aviso: ${JSON.stringify(anomalias)}`);
    assert(await compras(folio) === 1, 'otra compra real');
  });

  // ═══════════ Caja: el aviso que SÍ ve una persona (corrección 1) ═══════════
  // El panel de hoy no tiene manejador de `pago_anomalia`: lo que el
  // administrador ve es la Caja. El corte del día lista cada cobro en línea por
  // revisar y lo copia al recuadro de avisos que el panel ya pinta.
  await t('CAJA', '25. Caja lista el cobro en línea tras pasar a efectivo, con qué hacer, sin sumarlo a ventas', async () => {
    const fecha = await fechaDeCaja((await pagoDe(PRINCIPAL.pagoId)).paid_at);
    const r = await api(`/api/corte-caja?fecha=${fecha}`);
    assert(r.status === 200 && r.body?.cerrado === false, `corte: ${r.status} ${JSON.stringify(r.body)?.slice(0, 300)}`);
    const a = (r.body.alertas_pago || []).find(x => x.folio === PRINCIPAL.folio);
    assert(a && a.tipo === ALERTA_COBRO_TRAS_PRESENCIAL && a.pago_id === PRINCIPAL.pagoId && a.monto === 150
      && /No le cobren otra vez/.test(a.mensaje) && /reembolsen/.test(a.mensaje),
      `alerta: ${JSON.stringify(r.body.alertas_pago)}`);
    const avisos = r.body.reporte_financiero?.calidad?.avisos || [];
    assert(avisos[0] && /PAGOS EN LÍNEA POR REVISAR/.test(avisos[0]) && avisos[0].includes(PRINCIPAL.folio),
      `el recuadro visible no lo trae primero: ${JSON.stringify(avisos)}`);
    assert(Number(r.body.ventas_enlace) === 0, `el pago en línea por revisar se sumó a ventas: ${r.body.ventas_enlace}`);
  });
  await t('CAJA', '26. pedido cancelado cuyo enlace se paga después: Caja lo lista como pago tardío por devolver', async () => {
    // La salida que dan los textos con la bandera apagada: cancelar y
    // capturar de nuevo en el POS. Cancelar no apaga el enlace en Clip.
    const { folio, pagoId } = await pedidoEsperandoEnlace();
    const c = await api(`/api/admin/pedido/${folio}/cancelar`, { method: 'POST', body: { motivo: 'pagará en el POS' } });
    assert(c.status === 200, `cancelar: ${c.status} ${JSON.stringify(c.body)}`);
    const tr = await asentarPagoRealVerificado({ pagoId, negocioId: N, referenciaExterna: `clip-${folio}` });
    assert(tr.ok === false && tr.resultado === 'pago_tardio', `transición: ${tr.resultado}`);
    const fecha = await fechaDeCaja((await pagoDe(pagoId)).paid_at);
    const r = await api(`/api/corte-caja?fecha=${fecha}`);
    const a = (r.body?.alertas_pago || []).find(x => x.folio === folio);
    assert(a && a.tipo === ALERTA_PAGO_TARDIO && a.pedido_estado === 'cancelado'
      && /pedido cancelado/.test(a.mensaje) && /reembolsen/.test(a.mensaje),
      `alerta: ${JSON.stringify(r.body?.alertas_pago)}`);
    assert((r.body.reporte_financiero?.calidad?.avisos?.[0] || '').includes(folio), 'no está en el recuadro visible');
  });

  // ═══════════ Cuándo NO se libera ═══════════
  await t('NO', '14. forma que no se cobra en persona (rappi): 409 y nada cambia', async () => {
    const { folio, pagoId } = await pedidoEsperandoEnlace();
    const r = await cambiarPago(folio, 'rappi');
    assert(r.status === 409 && r.body?.codigo === 'PEDIDO_ESPERA_PAGO_EN_LINEA', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    const f = await fila(folio);
    assert(f.estado === 'pendiente_pago' && f.datos.forma_pago === 'enlace_pago' && (await pagoDe(pagoId)).estado === 'pendiente', 'cambió');
  });
  await t('NO', '15. negocio con anticipo obligatorio: 409 ANTICIPO_OBLIGATORIO', async () => {
    const { folio, pagoId } = await pedidoEsperandoEnlace();
    await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'pedido_requiere_anticipo','true')
                      ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = 'true'`, [N]);
    try {
      const r = await cambiarPago(folio, 'efectivo');
      assert(r.status === 409 && r.body?.codigo === 'ANTICIPO_OBLIGATORIO', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
      assert((await fila(folio)).estado === 'pendiente_pago' && (await pagoDe(pagoId)).estado === 'pendiente', 'cambió');
    } finally {
      await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'pedido_requiere_anticipo'`, [N]);
    }
  });
  await t('NO', '16. pedido programado: 409 PEDIDO_PROGRAMADO, sin deuda de comanda', async () => {
    const { folio } = await pedidoEsperandoEnlace({ extra: { programado_para: new Date(Date.now() + 5 * 3600e3).toISOString() } });
    const r = await cambiarPago(folio, 'efectivo');
    assert(r.status === 409 && r.body?.codigo === 'PEDIDO_PROGRAMADO', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    assert((await fila(folio)).estado === 'pendiente_pago' && (await emisiones(folio)).length === 0, 'cambió o dejó deuda');
  });
  await t('NO', '17. transferencia en revisión: 409 PAGO_EN_REVISION y la transferencia se sigue pudiendo asentar', async () => {
    const { folio, datos } = await pedidoEsperandoEnlace({ conPago: false });
    const { rows: [tr] } = await pool.query(
      `INSERT INTO pagos (negocio_id, pedido_folio, proveedor, referencia_interna, tipo, monto, estado, version_pedido_hash)
       VALUES ($1,$2,'manual_transfer',$3,'transferencia',$4,'requiere_revision',$5) RETURNING id`,
      [N, folio, `tr-${folio}`, datos.total, calcularVersionPedidoHash(datos)]);
    const r = await cambiarPago(folio, 'efectivo');
    assert(r.status === 409 && r.body?.codigo === 'PAGO_EN_REVISION', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    // Corrección 3: la transferencia no tiene botón en el panel; el texto dice
    // a quién pedírselo, no «confírmalo o recházalo».
    assert(/soporte de Xabor/.test(r.body.error) && !/confírmalo o recházalo/i.test(r.body.error),
      `texto: ${r.body.error}`);
    assert((await pagoDe(tr.id)).estado === 'requiere_revision', 'se venció la transferencia en revisión');
    const c = await api(`/api/admin/pagos/${tr.id}/confirmar-manual`, { method: 'POST' });
    assert(c.status === 200 && c.body?.transicion === 'confirmado', `confirmar: ${c.status} ${JSON.stringify(c.body)}`);
  });
  await t('NO', '27. comprobante del ENLACE en revisión: 409 PAGO_EN_REVISION sin prometer confirmar ni rechazar', async () => {
    // Corrección 3: confirmar y rechazar a mano solo aceptan transferencias;
    // un enlace de Clip en revisión solo se asienta cuando Clip lo confirma.
    const { folio, pagoId } = await pedidoEsperandoEnlace();
    const enRevision = await marcarPagoConComprobanteEnRevision(N, folio, null);
    assert(enRevision?.id === pagoId && enRevision.estado === 'requiere_revision', `revisión: ${JSON.stringify(enRevision)}`);
    const r = await cambiarPago(folio, 'efectivo');
    assert(r.status === 409 && r.body?.codigo === 'PAGO_EN_REVISION', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    assert(/Clip todavía no confirma/.test(r.body.error) && /NO pague el enlace/.test(r.body.error)
      && !/confírmalo o recházalo/i.test(r.body.error) && !/soporte/.test(r.body.error), `texto: ${r.body.error}`);
    assert((await fila(folio)).estado === 'pendiente_pago' && (await pagoDe(pagoId)).estado === 'requiere_revision', 'cambió');
  });
  await t('NO', '18. el enlace ya se pagó (dinero asentado): 409 YA_PAGADO_EN_LINEA y el pedido intacto', async () => {
    const { folio, pagoId } = await pedidoEsperandoEnlace();
    await pool.query(`UPDATE pagos SET estado = 'pagado', paid_at = NOW(), derivacion_pendiente = TRUE WHERE id = $1`, [pagoId]);
    const r = await cambiarPago(folio, 'efectivo');
    assert(r.status === 409 && r.body?.codigo === 'YA_PAGADO_EN_LINEA', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    const f = await fila(folio);
    assert(f.estado === 'pendiente_pago' && f.datos.forma_pago === 'enlace_pago' && !f.datos.pago_cambiado_a_presencial, 'cambió');
  });
  await t('NO', '19. el pendiente no lo causó el enlace: 409 PENDIENTE_NO_ES_ENLACE', async () => {
    const { folio } = await pedidoEsperandoEnlace({ conPago: false, extra: { forma_pago: 'efectivo', forma_pago_tipo: 'efectivo' } });
    const r = await cambiarPago(folio, 'efectivo');
    assert(r.status === 409 && r.body?.codigo === 'PENDIENTE_NO_ES_ENLACE', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    assert((await fila(folio)).estado === 'pendiente_pago', 'cambió');
  });
  await t('NO', '20. la tienda en línea solo entra a cocina pagada: 409 TIENDA_PAGO_EN_LINEA', async () => {
    const { folio } = await pedidoEsperandoEnlace({ extra: { canal: 'tienda_online' } });
    const r = await cambiarPago(folio, 'efectivo');
    assert(r.status === 409 && r.body?.codigo === 'TIENDA_PAGO_EN_LINEA', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    assert((await fila(folio)).estado === 'pendiente_pago', 'cambió');
  });
  await t('NO', '21. con la contraseña general (sin usuario) no se libera: 403 USUARIO_REQUERIDO', async () => {
    const { folio } = await pedidoEsperandoEnlace();
    const token = createHmac('sha256', process.env.PANEL_SECRET || 'xabor-secret-key').update(CLAVE_ADMIN).digest('hex');
    const r = await cambiarPago(folio, 'efectivo', { cookie: null, headers: { Authorization: `Bearer ${token}`, 'x-negocio-slug': SLUG } });
    assert(r.status === 403 && r.body?.codigo === 'USUARIO_REQUERIDO', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    assert((await fila(folio)).estado === 'pendiente_pago', 'cambió');
  });
  await t('NO', '22. mientras entra el dinero (lock de la obligación) la liberación espera, y luego no libera', async () => {
    const { folio, pagoId } = await pedidoEsperandoEnlace();
    const c = await pool.connect();
    let resuelta = false;
    let promesa = null;
    try {
      await c.query('BEGIN');
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, ['obligacion_pago', `${N}:${folio}`]);
      promesa = cambiarPago(folio, 'efectivo').then((r) => { resuelta = true; return r; });
      await dormir(1500);
      assert(!resuelta, 'la liberación no esperó al lock de la obligación de pago');
      assert((await fila(folio)).estado === 'pendiente_pago', 'liberó con el dinero entrando');
      await c.query(`UPDATE pagos SET estado = 'pagado', paid_at = NOW() WHERE id = $1`, [pagoId]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
      if (promesa) await promesa.catch(() => {});
    }
    const r = await promesa;
    assert(r.status === 409 && r.body?.codigo === 'YA_PAGADO_EN_LINEA', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    assert((await fila(folio)).estado === 'pendiente_pago', 'liberó tras el pago');
  });

  // ═══════════ Ya liberado: ✏️ solo entre efectivo y terminal (corrección 4) ═══════════
  await t('LIBERADO', '28. ya liberado: pasar a enlace o a Rappi responde 409 y no toca etiqueta, tipo ni marca', async () => {
    const { folio } = await pedidoEsperandoEnlace();
    const l = await cambiarPago(folio, 'efectivo');
    assert(l.status === 200 && l.body?.liberado, `liberar: ${l.status} ${JSON.stringify(l.body)}`);
    for (const forma of ['enlace_pago', 'rappi']) {
      const r = await cambiarPago(folio, forma);
      assert(r.status === 409 && r.body?.codigo === 'PAGO_PRESENCIAL_FIJO', `${forma}: ${r.status} ${JSON.stringify(r.body)}`);
      assert(/Efectivo/.test(r.body.error) && /Terminal/.test(r.body.error), `texto: ${r.body.error}`);
    }
    const d = (await fila(folio)).datos;
    assert(d.forma_pago === 'efectivo' && d.forma_pago_tipo === 'efectivo' && d.pago_cambiado_a_presencial?.forma_pago_tipo === 'efectivo',
      `datos: ${JSON.stringify({ f: d.forma_pago, t: d.forma_pago_tipo, m: d.pago_cambiado_a_presencial?.forma_pago_tipo })}`);
  });
  await t('LIBERADO', '29. ya liberado: de efectivo a terminal cambian etiqueta, tipo y marca, y el aviso de un cobro tardío dice «con terminal»', async () => {
    const { folio, pagoId } = await pedidoEsperandoEnlace();
    const l = await cambiarPago(folio, 'efectivo');
    assert(l.status === 200 && l.body?.liberado, `liberar: ${l.status} ${JSON.stringify(l.body)}`);
    const r = await cambiarPago(folio, 'terminal (tarjeta presente)');
    assert(r.status === 200 && r.body?.ok && r.body?.forma_pago === 'terminal (tarjeta presente)', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    const d = (await fila(folio)).datos;
    const m = d.pago_cambiado_a_presencial;
    assert(d.forma_pago === 'terminal (tarjeta presente)' && d.forma_pago_tipo === 'terminal'
      && m?.forma_pago_tipo === 'terminal' && m?.forma_pago === 'terminal (tarjeta presente)'
      && m?.correcciones?.at(-1)?.de === 'efectivo' && m?.correcciones?.at(-1)?.por === ADMIN,
      `datos: ${JSON.stringify({ f: d.forma_pago, t: d.forma_pago_tipo, m })}`);
    assert((await esperarEvento('actualizar_pago', folio)).some(e => e.forma_pago === 'terminal (tarjeta presente)'), 'sin actualizar_pago');
    const avisos = [];
    setBroadcastAvisoCobroTrasPresencial((negocioId, evento) => avisos.push(evento));
    try {
      const tr = await asentarPagoRealVerificado({ pagoId, negocioId: N, referenciaExterna: `clip-${folio}` });
      assert(tr.resultado === 'pago_tardio', `transición: ${tr.resultado}`);
      assert(avisos.length === 1 && /con terminal/.test(avisos[0].mensaje), `aviso: ${JSON.stringify(avisos)}`);
    } finally {
      setBroadcastAvisoCobroTrasPresencial(null);
    }
  });
  await t('LIBERADO', '35. liberado a efectivo y luego cancelado: la forma ya dice efectivo y aun así avisa del enlace', async () => {
    // El caso de XAB-1130: la etiqueta ya no dice «enlace», pero el cliente
    // conserva uno que en Clip sigue cobrable.
    const { folio } = await pedidoEsperandoEnlace();
    const l = await cambiarPago(folio, 'efectivo');
    assert(l.status === 200 && l.body?.liberado, `liberar: ${l.status} ${JSON.stringify(l.body)}`);
    const c = await api(`/api/admin/pedido/${folio}/cancelar`, { method: 'POST', body: { motivo: 'el cliente ya no lo quiso' } });
    assert(c.status === 200, `cancelar: ${c.status} ${JSON.stringify(c.body)}`);
    const r = await cambiarPago(folio, 'terminal (tarjeta presente)');
    assert(r.status === 409 && r.body?.codigo === 'PEDIDO_CANCELADO' && r.body.error === CANCELADO_CON_ENLACE,
      `ruta: ${r.status} ${JSON.stringify(r.body)}`);
    // La otra puerta: ✏️ sobre un liberado que se canceló entre la lectura de
    // la ruta y la transacción.
    const d = await corregirFormaDePedidoLiberadoTx({
      negocioId: N, folio, formaPago: 'terminal (tarjeta presente)', actor: { usuarioId: ADMIN } });
    assert(d.ok === false && d.codigo === 'PEDIDO_CANCELADO' && d.error === CANCELADO_CON_ENLACE,
      `corrección: ${JSON.stringify(d)}`);
  });

  // ═══════════ Promociones ═══════════
  const { rows: [promo] } = await pool.query(
    `INSERT INTO tienda_promociones (negocio_id, nombre, tipo, automatica, valor, usos, canales)
     VALUES ($1,'Promo libera','monto_fijo',TRUE,10,2,'["whatsapp"]') RETURNING id`, [N]);
  await t('PROMO', '23. la reserva de promoción se consume al liberar', async () => {
    const { folio, datos } = await pedidoEsperandoEnlace();
    await pool.query(`INSERT INTO tienda_promocion_usos (negocio_id, promocion_id, pedido_folio, estado, pedido_version, canal)
                      VALUES ($1,$2,$3,'reservada',$4,'whatsapp')`, [N, promo.id, folio, calcularVersionPedidoHash(datos)]);
    const r = await cambiarPago(folio, 'efectivo');
    assert(r.status === 200 && r.body?.liberado, `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    const { rows: [u] } = await pool.query(`SELECT estado FROM tienda_promocion_usos WHERE negocio_id = $1 AND pedido_folio = $2`, [N, folio]);
    assert(u?.estado === 'consumida', `reserva: ${u?.estado}`);
  });
  await t('PROMO', '24. reserva de otra versión del pedido: 409 PROMOCION_DESFASADA y nada cambia', async () => {
    const { folio, pagoId } = await pedidoEsperandoEnlace();
    await pool.query(`INSERT INTO tienda_promocion_usos (negocio_id, promocion_id, pedido_folio, estado, pedido_version, canal)
                      VALUES ($1,$2,$3,'reservada','version-vieja','whatsapp')`, [N, promo.id, folio]);
    const r = await cambiarPago(folio, 'efectivo');
    assert(r.status === 409 && r.body?.codigo === 'PROMOCION_DESFASADA', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    const { rows: [u] } = await pool.query(`SELECT estado FROM tienda_promocion_usos WHERE negocio_id = $1 AND pedido_folio = $2`, [N, folio]);
    assert(u?.estado === 'reservada' && (await fila(folio)).estado === 'pendiente_pago' && (await pagoDe(pagoId)).estado === 'pendiente',
      'cambió algo');
  });

  // ═══════════ Reconsulta a Clip antes de liberar (mejora de la revisión) ═══════════
  // Desde aquí el negocio tiene Clip configurado (contra el mock). Antes no:
  // sin credenciales, la reconsulta no tiene a quién preguntar y se libera.
  await guardarCredencialesClip(N, 'CLIP_KEY_LIBERA_TEST', 'CLIP_SECRET_LIBERA_TEST', ADMIN);

  await t('CLIP', '30. «ya pagué»: Clip ya tenía el cobro: no se libera, se asienta y sale a cocina PAGADO', async () => {
    const { folio, pagoId } = await pedidoEsperandoEnlace();
    respuestasClip.set(`clip-${folio}`, { status: 'CHECKOUT_COMPLETED', monto: 150, ref: pagoId });
    const r = await cambiarPago(folio, 'efectivo');
    assert(r.status === 409 && r.body?.codigo === 'YA_PAGADO_EN_LINEA' && /Clip acaba de confirmar/.test(r.body.error),
      `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    assert(llamadasClip.includes(`clip-${folio}`), 'no se le preguntó a Clip');
    const p = await pagoDe(pagoId);
    assert(p.estado === 'pagado' && !p.metadata_sanitizada?.pago_tardio, `pago: ${p.estado} ${JSON.stringify(p.metadata_sanitizada)}`);
    const f = await fila(folio);
    assert(f.estado === 'nuevo' && (f.datos.pago_confirmado === true || f.datos.pago_confirmado === 'true')
      && !f.datos.pago_cambiado_a_presencial && f.datos.forma_pago === 'enlace_pago',
      `pedido: ${f.estado} pagado=${f.datos.pago_confirmado} marca=${!!f.datos.pago_cambiado_a_presencial} forma=${f.datos.forma_pago}`);
    assert(await compras(folio) === 1 && JSON.stringify(await emisiones(folio)) === '["saldada"]',
      `comanda: compras=${await compras(folio)} emisiones=${JSON.stringify(await emisiones(folio))}`);
    assert((await esperarEvento('pago_confirmado', folio)).length >= 1, 'el panel no recibió pago_confirmado');
  });
  await t('CLIP', '31. Clip dice que el cobro sigue pendiente: se le preguntó y se libera como siempre', async () => {
    const { folio, pagoId } = await pedidoEsperandoEnlace();
    respuestasClip.set(`clip-${folio}`, { status: 'CHECKOUT_PENDING', monto: 150, ref: pagoId });
    const r = await cambiarPago(folio, 'efectivo');
    assert(r.status === 200 && r.body?.liberado === true, `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    assert(llamadasClip.includes(`clip-${folio}`), 'no se le preguntó a Clip');
    assert((await pagoDe(pagoId)).estado === 'vencido' && (await fila(folio)).estado === 'nuevo', 'no se liberó');
  });
  await t('CLIP', '32. Clip no contesta a tiempo: se libera sin esperarlo', async () => {
    const { folio, pagoId } = await pedidoEsperandoEnlace();
    respuestasClip.set(`clip-${folio}`, { status: 'CHECKOUT_PENDING', monto: 150, ref: pagoId, demoraMs: 12000 });
    const inicio = Date.now();
    const r = await cambiarPago(folio, 'efectivo');
    const ms = Date.now() - inicio;
    assert(r.status === 200 && r.body?.liberado === true, `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
    assert(ms < 9000, `esperó a Clip ${ms} ms`);
    assert(llamadasClip.includes(`clip-${folio}`), 'no se le preguntó a Clip');
  });
  await t('CLIP', '33. con la bandera apagada no se le pregunta nada a Clip', async () => {
    const { folio, pagoId } = await pedidoEsperandoEnlace();
    respuestasClip.set(`clip-${folio}`, { status: 'CHECKOUT_COMPLETED', monto: 150, ref: pagoId });
    await bandera('false');
    try {
      const r = await cambiarPago(folio, 'efectivo');
      assert(r.status === 409 && r.body?.codigo === 'PEDIDO_ESPERA_PAGO_EN_LINEA', `respuesta: ${r.status} ${JSON.stringify(r.body)}`);
      assert(!llamadasClip.includes(`clip-${folio}`), 'con la bandera apagada se le preguntó a Clip');
      assert((await pagoDe(pagoId)).estado === 'pendiente', 'cambió el pago');
    } finally {
      await bandera('true');
    }
  });

  // ═══════════ Cierre: el corte cerrado y su papel conservan las alertas ═══════════
  // Va al final: cerrar el corte de hoy congela lo que se vea después.
  await t('CAJA', '34. al cerrar el corte, el corte cerrado y su ticket conservan los pagos en línea por revisar', async () => {
    const fecha = await fechaDeCaja((await pagoDe(PRINCIPAL.pagoId)).paid_at);
    const c = await api('/api/corte-caja/cerrar', { method: 'POST', body: { fecha } });
    assert(c.status === 200 && c.body?.ok, `cerrar: ${c.status} ${JSON.stringify(c.body)?.slice(0, 300)}`);
    const r = await api(`/api/corte-caja?fecha=${fecha}`);
    assert(r.body?.cerrado === true && (r.body.alertas_pago || []).some(a => a.folio === PRINCIPAL.folio),
      `corte cerrado: ${JSON.stringify(r.body?.alertas_pago)}`);
    const tk = await api(`/api/corte-caja/${fecha}/ticket`);
    assert(tk.status === 200 && /PAGOS EN LINEA POR REVISAR/.test(tk.body?.ticket || '') && tk.body.ticket.includes(PRINCIPAL.folio),
      `ticket: ${tk.status} ${tk.body?.ticket}`);
  });
} finally {
  try { ws.close(); } catch {}
  srv.detener();
  try { clipMock.closeAllConnections?.(); clipMock.close(); } catch {}
  await pool.end();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
