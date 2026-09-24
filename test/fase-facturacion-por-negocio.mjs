// ─── FACTURACIÓN: LA CUENTA ES DEL NEGOCIO ────────────────────────────────
//
// Clip se resolvía desde una cuenta GLOBAL y cobró con la cuenta de otro
// negocio (Incidente P0). Se corrigió sacando sus llaves del mapa de entorno
// y leyéndolas por negocio. **Facturación se quedó atrás**: `facturapi.js`
// resolvía la llave con
//
//     getIntegracion('facturapi_key') || process.env.FACTURAPI_KEY
//
// —un caché de proceso cargado de UN negocio hardcodeado, o una variable de
// entorno global—. Ninguna de las dos sabe de qué negocio es la venta.
//
// Y aquí duele más que en pagos: un cobro con la cuenta equivocada se
// devuelve; un CFDI timbrado con el RFC de otro contribuyente es un documento
// fiscal a nombre de quien no vendió.
//
// Esta suite fija que eso no pueda volver. Lo que prueba no es que «funcione»:
// prueba que **falle cerrado** cuando no hay credencial del negocio, aunque
// haya una llave global a mano.
//
// ── El modelo de recibo (autofactura) ────────────────────────────────────
//
// El camino productivo ya no es «RFC entra, CFDI sale» en una sola llamada.
// Es un recibo primero —una fila local, idempotente por (negocio, folio)—
// que el cliente puede llenar solo en una página de Facturapi, o que el
// panel puede facturar directamente. Esta suite también cubre esa forma:
// el gate de pago (`obtenerPedidoFacturable`), el reparto de intención por
// WhatsApp (`esSolicitudFactura`/`extraerFolioFactura`) y que ningún camino
// llegue a la red de Facturapi cuando el negocio no tiene cuenta.
//
// Uso: DATABASE_URL a un Postgres LOCAL (se niega con cualquier otro).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const HOST = new URL(process.env.DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(HOST)) {
  throw new Error('Esta prueba escribe fichas fiscales: solo acepta Postgres local');
}

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

const leer = (rel) => readFileSync(join(RAIZ, rel), 'utf8');

// El CÓDIGO, sin comentarios. Estos archivos explican en prosa el defecto
// que se corrigió —y esa prosa nombra `getIntegracion` y la variable de
// entorno—, así que buscar sobre el texto crudo daría por reincidencia lo
// que en realidad es la explicación de por qué no se puede reincidir.
const codigo = (rel) => leer(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')   // bloques /* ... */
  .replace(/(^|[^:])\/\/.*$/gm, '$1');  // línea // ... (sin tocar http://)

// ═══════════════════════════════════════════════════════════════════════════
// PARTE A — EL ORIGEN DE LA LLAVE, leído del código
// ═══════════════════════════════════════════════════════════════════════════

await t('F1 facturapi.js no importa nada de server.js', () => {
  // De ahí salía `getIntegracion`, el caché global. Además era un import
  // circular: timbrar obligaba a cargar el servidor entero.
  const src = codigo('src/services/facturapi.js');
  assert.ok(!/from\s+['"]\.\.\/server\.js['"]/.test(src),
    'volvió el import de server.js, y con él el caché global');
  assert.ok(!/getIntegracion/.test(src), 'volvió getIntegracion');
});

await t('F2 la llave ya no tiene respaldo de variable de entorno', () => {
  const src = codigo('src/services/facturapi.js');
  assert.ok(!/process\.env\.FACTURAPI_KEY/.test(src),
    'quedó un respaldo global: una venta sin credencial de negocio se timbraría con esa llave');
});

await t('F3 facturapi_key salió del mapa de entorno, como las de Clip', () => {
  // El mismo movimiento que cerró el Incidente P0. Mientras la clave siguiera
  // en ENV_MAP, `getIntegracion` podía volver a resolverla globalmente desde
  // cualquier otro llamador.
  const src = codigo('src/server.js');
  assert.ok(!/facturapi_key:\s*'FACTURAPI_KEY'/.test(src), 'facturapi_key sigue en ENV_MAP');
  assert.ok(!/^\s*'facturapi_key',\s*$/m.test(src), 'facturapi_key sigue en INT_CLAVES');
});

await t('F4 la ruta de emisión no exige la variable global', () => {
  const src = codigo('src/server.js');
  assert.ok(!/if \(!process\.env\.FACTURAPI_KEY\) return res\.status\(503\)/.test(src),
    'la ruta sigue exigiendo FACTURAPI_KEY: la llave guardada en el panel se ignoraría');
});

await t('F5 WhatsApp ya no se salta la factura en silencio', () => {
  const src = codigo('src/channels/whatsapp-meta.js');
  assert.ok(!/if \(resultado\.factura && process\.env\.FACTURAPI_KEY\)/.test(src),
    'sin la variable, el cliente pedía factura y no recibía ni factura ni explicación');
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE B — EL COMPORTAMIENTO, contra Postgres
// ═══════════════════════════════════════════════════════════════════════════

const { pool, guardarClienteFiscal, obtenerClienteFiscalPorRFC,
  obtenerClientesFiscalesPorTelefono, listarClientesFiscales,
  eliminarClienteFiscal, normalizarRFC } = await import('../src/services/database.js');
const { crearRecibo, puedeFacturar, FacturapiNoConfiguradoError } =
  await import('../src/services/facturapi.js');
const { TenantContextRequiredError, guardarCredencialesFacturapi, eliminarCredencialesFacturapi } =
  await import('../src/services/integracionesService.js');
const { obtenerPedidoFacturable, obtenerUltimoPedidoFacturablePorTelefono,
  pedidoPerteneceATelefono, normalizarFolioFactura, asegurarReciboPedido,
  guardarConfiguracionFacturacion, emitirFacturaPedido, listarRecibosFacturacion,
  FacturacionError } = await import('../src/services/facturacionService.js');
const { esSolicitudFactura, extraerFolioFactura, manejarFacturacionWhatsapp } =
  await import('../src/services/facturacionWhatsapp.js');

// Dos negocios: la mayoria de los casos solo necesita uno (NEG), pero la
// garantia multiempresa del reconocimiento por telefono (F32) exige DOS
// negocios reales para demostrar que uno no ve la ficha fiscal del otro.
const { rows: negocios } = await pool.query('SELECT id FROM negocios ORDER BY created_at LIMIT 2');
if (negocios.length < 2) throw new Error('La base local necesita al menos dos negocios de prueba');
const [NEG, NEG_B] = negocios.map((n) => n.id);
const RFC = 'XAXX010101000';
const TEL = '5281990088';
const TEL_CRUCE = `5281${Date.now().toString().slice(-8)}`;
const PEDIDO_PRUEBA = { folio: 'XAB-FACTEST', total: 100, forma_pago: 'efectivo' };

const limpiar = () => Promise.all([
  pool.query("DELETE FROM clientes_fiscales WHERE negocio_id = ANY($1) AND rfc LIKE 'XAXX%'", [[NEG, NEG_B]]),
  pool.query('DELETE FROM facturas_pedido WHERE negocio_id = ANY($1) AND folio LIKE $2', [[NEG, NEG_B], 'XAB-FACTEST%']),
  pool.query('DELETE FROM facturacion_recibos WHERE negocio_id = ANY($1) AND folio LIKE $2', [[NEG, NEG_B], 'XAB-FACTEST%']),
  pool.query('DELETE FROM facturacion_whatsapp_estado WHERE negocio_id = ANY($1) AND telefono = $2', [[NEG, NEG_B], TEL]),
  pool.query('DELETE FROM facturacion_whatsapp_estado WHERE negocio_id = ANY($1) AND telefono = $2', [[NEG, NEG_B], TEL_CRUCE]),
  pool.query('DELETE FROM pedidos_activos WHERE negocio_id = ANY($1) AND folio LIKE $2', [[NEG, NEG_B], 'XAB-FACTEST%']),
  pool.query('DELETE FROM pedidos_programados WHERE negocio_id = ANY($1) AND folio LIKE $2', [[NEG, NEG_B], 'XAB-FACTEST%']),
  pool.query('DELETE FROM facturacion_configuracion WHERE negocio_id = ANY($1)', [[NEG, NEG_B]]),
  eliminarCredencialesFacturapi(NEG, null),
  eliminarCredencialesFacturapi(NEG_B, null),
]).catch(() => {});
await limpiar();

/**
 * Deja a un negocio LISTO para "poder facturar" -- credencial de Facturapi
 * (una llave de mentira que NUNCA se usa de verdad, ver mas abajo) mas tasa
 * de IVA configurada. No hace ninguna llamada de red: `guardarCredencialesFacturapi`
 * solo cifra y guarda en Postgres.
 */
async function configurarFacturapiFalso(negocioId, ivaTasa = 0.16) {
  await guardarCredencialesFacturapi(negocioId, 'sk_test_nunca_se_debe_usar_de_verdad', null);
  await guardarConfiguracionFacturacion(negocioId, { ivaTasa, autoemitirRecibo: true });
}

/**
 * Pre-siembra un recibo YA ABIERTO en Facturapi, sin llamar a Facturapi.
 *
 * Esto es lo que hace posible probar el camino de EXITO completo
 * (asegurarReciboPedido -> recibo con url_autofactura -> mensaje de
 * WhatsApp) sin red: `asegurarReciboPedido` solo llama a `crearRecibo`
 * (la unica funcion que de verdad toca la red) cuando NO existe ya un
 * recibo con `recibo_id` en estado abierto/facturado/global -- ver el
 * `if (existente.recibo_id && [...]) return existente;` en
 * facturacionService.js. Con la fila ya sembrada, ese camino corto se
 * dispara y la llave falsa de `configurarFacturapiFalso` nunca llega a
 * usarse.
 */
async function prepararReciboAbierto(negocioId, folio, total) {
  await pool.query(
    `INSERT INTO facturacion_recibos
       (negocio_id, folio, total, idempotency_key, recibo_id, clave, url_autofactura, estado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'abierto')
     ON CONFLICT (negocio_id, folio) DO UPDATE SET
       recibo_id=EXCLUDED.recibo_id, clave=EXCLUDED.clave,
       url_autofactura=EXCLUDED.url_autofactura, estado='abierto', updated_at=NOW()`,
    [negocioId, folio, total, `xabor:${negocioId}:${folio}`,
      `rec_prueba_${folio}`, `clave-${folio}`, `https://facturapi.example/self/${folio}`]);
}

/** Un pedido pagado y entregado, listo para facturar, con el telefono dado. */
async function sembrarPedidoPagado(negocioId, folio, telefono, total = 100) {
  await pool.query(
    `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, entregado_at)
     VALUES ($1,$2,'entregado',$3::jsonb, NOW())
     ON CONFLICT (folio) DO UPDATE SET negocio_id=$1, estado='entregado', datos=$3::jsonb, entregado_at=NOW()`,
    [negocioId, folio, JSON.stringify({
      total, forma_pago: 'efectivo', pago_confirmado: true, telefono_conversacion: telefono,
    })]);
}

/** Reserva futura: todavía no existe en el tablero activo. */
async function sembrarPedidoProgramado(negocioId, folio, telefono, {
  total = 100, pagado = true, estado = 'nuevo', activado = false,
} = {}) {
  const programadoPara = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await pool.query(
    `INSERT INTO pedidos_programados
       (negocio_id, folio, datos, programado_para, activado)
     VALUES ($1,$2,$3::jsonb,$4,$5)
     ON CONFLICT (folio) DO UPDATE SET
       negocio_id=EXCLUDED.negocio_id, datos=EXCLUDED.datos,
       programado_para=EXCLUDED.programado_para, activado=EXCLUDED.activado`,
    [negocioId, folio, JSON.stringify({
      id: folio, total, forma_pago: 'enlace_pago', pago_confirmado: pagado,
      estado, programado_para: programadoPara, telefono_conversacion: telefono,
      cliente: { nombre: 'Cliente Programado', telefono },
    }), programadoPara, activado]);
}

try {

await t('F6 sin negocioId, crearRecibo LANZA — nunca elige una cuenta por su cuenta', async () => {
  // Es un bug del llamador, no un estado de negocio. Devolver null aquí fue
  // justo lo que dejó a Clip cobrar con la cuenta de otro.
  await assert.rejects(
    () => crearRecibo(null, PEDIDO_PRUEBA, { ivaTasa: 0.16 }),
    (e) => e instanceof TenantContextRequiredError,
    'sin negocio debería lanzar TenantContextRequiredError');
});

await t('F7 LA GARANTÍA: con una llave global a mano, un negocio sin cuenta NO timbra', async () => {
  // El corazón de la suite. Se pone una llave global —como la que existía en
  // Railway— y se intenta crear un recibo para un negocio que no tiene la
  // suya. Antes, esa llave se usaba y el CFDI salía con el RFC de otro
  // contribuyente. El fallo ocurre ANTES de tocar la red: `claveDe()` revisa
  // la credencial del negocio y lanza sin que `fetch` llegue a ejecutarse.
  const previa = process.env.FACTURAPI_KEY;
  process.env.FACTURAPI_KEY = 'sk_test_llave_global_de_otro_negocio';
  try {
    assert.equal(await puedeFacturar(NEG), false,
      'este negocio no debería poder facturar: no tiene credencial propia');
    await assert.rejects(
      () => crearRecibo(NEG, PEDIDO_PRUEBA, { ivaTasa: 0.16 }),
      (e) => e instanceof FacturapiNoConfiguradoError,
      'se timbró con la llave global: es el Incidente P0 otra vez, en fiscal');
  } finally {
    if (previa === undefined) delete process.env.FACTURAPI_KEY;
    else process.env.FACTURAPI_KEY = previa;
  }
});

await t('F7b lo mismo por la puerta productiva: asegurarReciboPedido tampoco cae a una cuenta global', async () => {
  // F6/F7 prueban la capa de bajo nivel (facturapi.js). Esta prueba el punto
  // de entrada que de verdad usan el panel y WhatsApp: `asegurarReciboPedido`.
  // Primero hace falta un pedido PAGADO y real, porque el gate de pago corre
  // antes que el gate de la cuenta — si no hay pedido, el error sería el
  // equivocado y esta prueba no demostraría nada sobre la cuenta.
  await pool.query(
    `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, created_at, entregado_at)
     VALUES ($1,$2,'entregado',$3::jsonb, NOW(), NOW())
     ON CONFLICT (folio) DO UPDATE SET estado='entregado', datos=$3::jsonb`,
    [NEG, PEDIDO_PRUEBA.folio, JSON.stringify({ total: 100, forma_pago: 'efectivo', pago_confirmado: true })]);

  const previa = process.env.FACTURAPI_KEY;
  process.env.FACTURAPI_KEY = 'sk_test_llave_global_de_otro_negocio';
  try {
    await assert.rejects(
      () => asegurarReciboPedido(NEG, PEDIDO_PRUEBA.folio),
      (e) => e instanceof FacturapiNoConfiguradoError,
      'asegurarReciboPedido timbró con la llave global de proceso');
  } finally {
    if (previa === undefined) delete process.env.FACTURAPI_KEY;
    else process.env.FACTURAPI_KEY = previa;
    await pool.query('DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2', [NEG, PEDIDO_PRUEBA.folio]);
  }
});

// ── El gate de pago: sin dinero confirmado no hay CFDI ───────────────────
//
// `obtenerPedidoFacturable` es puramente local (una consulta a
// `pedidos_activos`, sin tocar Facturapi), así que se puede probar entera
// sin cuenta ni red — y es la puerta que decide si una venta es facturable
// antes de que cualquier otra cosa se ejecute.

await t('F18 no se factura un pedido que no existe', async () => {
  await assert.rejects(
    () => obtenerPedidoFacturable(NEG, 'XAB-NOEXISTE-0000'),
    (e) => e instanceof FacturacionError && e.codigo === 'PEDIDO_NO_ENCONTRADO');
});

await t('F19 no se factura un pedido cancelado', async () => {
  const folio = 'XAB-FACTEST-CANC';
  await pool.query(
    `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos)
     VALUES ($1,$2,'cancelado',$3::jsonb)`,
    [NEG, folio, JSON.stringify({ total: 100 })]);
  try {
    await assert.rejects(
      () => obtenerPedidoFacturable(NEG, folio),
      (e) => e instanceof FacturacionError && e.codigo === 'PEDIDO_CANCELADO');
  } finally {
    await pool.query('DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2', [NEG, folio]);
  }
});

await t('F20 no se factura un pedido sin pago confirmado', async () => {
  const folio = 'XAB-FACTEST-SINPAGO';
  await pool.query(
    `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos)
     VALUES ($1,$2,'nuevo',$3::jsonb)`,
    [NEG, folio, JSON.stringify({ total: 100, forma_pago: 'por_cobrar' })]);
  try {
    await assert.rejects(
      () => obtenerPedidoFacturable(NEG, folio),
      (e) => e instanceof FacturacionError && e.codigo === 'PEDIDO_NO_PAGADO');
  } finally {
    await pool.query('DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2', [NEG, folio]);
  }
});

await t('F21 un pedido entregado y pagado SÍ es facturable', async () => {
  const folio = 'XAB-FACTEST-PAGADO';
  await pool.query(
    `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, entregado_at)
     VALUES ($1,$2,'entregado',$3::jsonb, NOW())`,
    [NEG, folio, JSON.stringify({ total: 150, forma_pago: 'efectivo', pago_confirmado: true,
      telefono_conversacion: TEL })]);
  try {
    const pedido = await obtenerPedidoFacturable(NEG, folio);
    assert.equal(pedido.folio, folio);
    assert.equal(Number(pedido.total), 150);
    assert.equal(pedidoPerteneceATelefono(pedido, TEL), true,
      'el pedido tenía que reconocer el teléfono que lo generó');
    assert.equal(pedidoPerteneceATelefono(pedido, '5289990000'), false,
      'un teléfono ajeno no puede reclamar un pedido que no es suyo');
  } finally {
    await pool.query('DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2', [NEG, folio]);
  }
});

await t('F21b un programado pagado es facturable antes de activarse, dentro de su negocio', async () => {
  const folio = 'XAB-FACTEST-PROG';
  const telefono = '5281990066';
  await sembrarPedidoProgramado(NEG, folio, telefono, { total: 275, pagado: true });
  try {
    assert.equal((await pool.query(
      'SELECT 1 FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2', [NEG, folio])).rowCount, 0,
    'el fixture dejó de representar la ventana anterior a -1 h');

    const pedido = await obtenerPedidoFacturable(NEG, folio);
    assert.equal(pedido.folio, folio);
    assert.equal(pedido._origen, 'programado');
    assert.equal(Number(pedido.total), 275);
    assert.equal(pedido.pago_confirmado, true);

    const ultimo = await obtenerUltimoPedidoFacturablePorTelefono(NEG, telefono);
    assert.equal(ultimo?.folio, folio,
      'la solicitud de factura sin folio no encontró la reserva pagada del teléfono');
    assert.equal(ultimo?._origen, 'programado');

    await assert.rejects(
      () => obtenerPedidoFacturable(NEG_B, folio),
      (e) => e instanceof FacturacionError && e.codigo === 'PEDIDO_NO_ENCONTRADO',
      'otro negocio pudo leer como facturable la reserva ajena');
  } finally {
    await pool.query('DELETE FROM pedidos_programados WHERE negocio_id=$1 AND folio=$2', [NEG, folio]);
  }
});

await t('F21c un programado impagado, cancelado o ya activado falla cerrado', async () => {
  const sinPago = 'XAB-FACTEST-P-NP';
  const cancelado = 'XAB-FACTEST-P-CAN';
  const yaActivado = 'XAB-FACTEST-P-ACT';
  await sembrarPedidoProgramado(NEG, sinPago, '5281990067', { pagado: false });
  await sembrarPedidoProgramado(NEG, cancelado, '5281990068', { pagado: true, estado: 'cancelado' });
  await sembrarPedidoProgramado(NEG, yaActivado, '5281990065', { pagado: true, activado: true });
  try {
    await assert.rejects(
      () => obtenerPedidoFacturable(NEG, sinPago),
      (e) => e instanceof FacturacionError && e.codigo === 'PEDIDO_NO_PAGADO');
    await assert.rejects(
      () => obtenerPedidoFacturable(NEG, cancelado),
      (e) => e instanceof FacturacionError && e.codigo === 'PEDIDO_CANCELADO');
    await assert.rejects(
      () => obtenerPedidoFacturable(NEG, yaActivado),
      (e) => e instanceof FacturacionError && e.codigo === 'PEDIDO_NO_ENCONTRADO',
      'una reserva ya activada sustituyó indebidamente a su fila activa ausente');
  } finally {
    await pool.query(
      'DELETE FROM pedidos_programados WHERE negocio_id=$1 AND folio = ANY($2)',
      [NEG, [sinPago, cancelado, yaActivado]]);
  }
});

await t('F22 normalizarFolioFactura acepta variantes y rechaza basura', () => {
  assert.equal(normalizarFolioFactura('xab21'), 'XAB-0021');
  assert.equal(normalizarFolioFactura('XAB-0021'), 'XAB-0021');
  assert.equal(normalizarFolioFactura('folio 21'), 'XAB-0021');
  assert.equal(normalizarFolioFactura('21'), 'XAB-0021');
  assert.equal(normalizarFolioFactura('XAB-FACTEST-F207'), 'XAB-FACTEST-F207',
    'un folio alfanumérico terminado en dígitos no debe convertirse en otro folio');
});

// ── El reparto de intención por WhatsApp — funciones puras, sin red ──────

await t('F23 esSolicitudFactura reconoce la intención sin ambigüedad', () => {
  assert.equal(esSolicitudFactura('quiero mi factura por favor'), true);
  assert.equal(esSolicitudFactura('necesito el cfdi de mi compra'), true);
  assert.equal(esSolicitudFactura('me mandas un comprobante fiscal'), true);
  assert.equal(esSolicitudFactura('quiero dos tacos'), false);
  assert.equal(esSolicitudFactura(''), false);
});

await t('F24 extraerFolioFactura lee el folio en las formas comunes', () => {
  assert.equal(extraerFolioFactura('mi folio es XAB-0458'), 'XAB-0458');
  assert.equal(extraerFolioFactura('factura 458'), 'XAB-0458');
  assert.equal(extraerFolioFactura('quiero facturar mi pedido'), null,
    'sin número no hay folio que extraer');
  assert.equal(extraerFolioFactura('458', { permitirSoloNumero: true }), 'XAB-0458');
  assert.equal(extraerFolioFactura('458'), null,
    'un número suelto solo cuenta cuando el bot ya lo estaba esperando');
});

await t('F25 el bot no confía en el folio que manda el cliente: valida el dueño', async () => {
  // Un folio real, pero de otro teléfono. La respuesta tiene que decir que
  // ese folio no es de esta conversación — nunca facturar a nombre de otro
  // ni revelar si el folio existe.
  // El folio tiene que seguir el patrón real (XAB-NNNN): es lo que el propio
  // parser de WhatsApp sabe leer de un mensaje. Un folio no numérico nunca
  // se extraería del texto, y la prueba estaría validando otra cosa.
  //
  // Y tiene que ser IMPREDECIBLE en cada corrida: `trg_barrera_folio_historico`
  // (migración 060) reclama para siempre cualquier folio con forma XAB-NNNN en
  // `folios_pedido_usados`, incluso después de borrar la fila de
  // `pedidos_activos` — ese es justamente el invariante «un folio nunca se
  // reutiliza». Un folio fijo aquí pasaba la primera vez y fallaba en
  // silencio (INSERT con `rowCount: 0`, sin excepción) en cualquier corrida
  // posterior sobre la misma base.
  const folio = `XAB-${900000 + Math.floor(Math.random() * 99999)}`;
  await pool.query(
    `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, entregado_at)
     VALUES ($1,$2,'entregado',$3::jsonb, NOW())`,
    [NEG, folio, JSON.stringify({ total: 90, forma_pago: 'efectivo', pago_confirmado: true,
      telefono_conversacion: '5289990000' })]);
  try {
    const r = await manejarFacturacionWhatsapp({ negocioId: NEG, telefono: TEL, texto: `factura ${folio}` });
    assert.equal(r.manejado, true);
    assert.match(r.mensaje, /no está asociado a este WhatsApp/);
  } finally {
    await pool.query('DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2', [NEG, folio]);
  }
});

await t('F26 un folio inexistente responde con claridad, sin escalar', async () => {
  const r = await manejarFacturacionWhatsapp({ negocioId: NEG, telefono: TEL, texto: 'factura XAB-9999' });
  assert.equal(r.manejado, true);
  assert.match(r.mensaje, /No encontré la venta/);
});

await t('F26b un fallo interno al consultar el folio no filtra SQL y exige revisión', async () => {
  const originalQuery = pool.query.bind(pool);
  const detalleInterno = 'relation "pedidos_programados" does not exist token=supersecret';
  pool.query = (sql, params) => {
    if (typeof sql === 'string' && sql.includes('WITH candidatos AS')) {
      throw new Error(detalleInterno);
    }
    return originalQuery(sql, params);
  };

  let r;
  try {
    r = await manejarFacturacionWhatsapp({
      negocioId: NEG, telefono: TEL, texto: 'factura XAB-0458',
    });
  } finally {
    pool.query = originalQuery;
  }

  assert.equal(r.manejado, true);
  assert.equal(r.escalar, true,
    'un fallo técnico quedó como respuesta normal y la conversación seguiría en el bot');
  assert.match(r.mensaje, /No pude consultar esa venta/);
  assert.doesNotMatch(r.mensaje, /pedidos_programados|supersecret|relation/i,
    'se expuso al cliente el detalle de Postgres');
  assert.equal(r.error?.message, detalleInterno,
    'se perdió el error real necesario para observabilidad y diagnóstico interno');
});

await t('F27 sin folio y sin pedido previo, el bot lo pide — no inventa ni escala', async () => {
  const r = await manejarFacturacionWhatsapp({ negocioId: NEG, telefono: '5281990099', texto: 'quiero mi factura' });
  assert.equal(r.manejado, true);
  assert.match(r.mensaje, /Envíame el folio/);
  const { rows } = await pool.query(
    "SELECT estado FROM facturacion_whatsapp_estado WHERE negocio_id=$1 AND telefono=$2",
    [NEG, '5281990099']);
  assert.equal(rows[0]?.estado, 'esperando_folio',
    'el bot tenía que recordar que está esperando el folio en el próximo mensaje');
  await pool.query('DELETE FROM facturacion_whatsapp_estado WHERE negocio_id=$1 AND telefono=$2',
    [NEG, '5281990099']);
});

async function fijarEsperaDeFolio() {
  await pool.query(
    `INSERT INTO facturacion_whatsapp_estado (negocio_id, telefono, estado, expires_at)
     VALUES ($1,$2,'esperando_folio',NOW()+INTERVAL '30 minutes')
     ON CONFLICT (negocio_id,telefono) DO UPDATE SET
       estado='esperando_folio', folio=NULL, expires_at=EXCLUDED.expires_at, updated_at=NOW()`,
    [NEG, TEL_CRUCE]);
}

async function estadoDeEspera() {
  const { rows: [fila] } = await pool.query(
    'SELECT estado FROM facturacion_whatsapp_estado WHERE negocio_id=$1 AND telefono=$2',
    [NEG, TEL_CRUCE]);
  return fila?.estado || null;
}

await t('CRUCE 1 espera de folio no consume conversación ordinaria sin número', async () => {
  await fijarEsperaDeFolio();
  const r = await manejarFacturacionWhatsapp({ negocioId: NEG, telefono: TEL_CRUCE, texto: 'hola, una pregunta' });
  assert.equal(r.manejado, false,
    'una espera implícita se apropió de un texto que no contiene folio');
  assert.equal(await estadoDeEspera(), 'esperando_folio',
    'una charla ordinaria no debe cancelar la posibilidad de mandar el folio después');
});

await t('CRUCE 2 catering explícito abandona la espera implícita de folio', async () => {
  await fijarEsperaDeFolio();
  const r = await manejarFacturacionWhatsapp({
    negocioId: NEG, telefono: TEL_CRUCE, texto: 'quiero catering para una boda',
  });
  assert.equal(r.manejado, false,
    'facturación secuestró una solicitud nueva y explícita de catering');
  assert.equal(await estadoDeEspera(), null,
    'la espera de folio sobrevivió y podría secuestrar el siguiente dato del evento');
});

await t('CRUCE 3 pedido para mañana abandona la espera implícita de folio', async () => {
  await fijarEsperaDeFolio();
  const r = await manejarFacturacionWhatsapp({
    negocioId: NEG, telefono: TEL_CRUCE, texto: 'quiero hacer un pedido para mañana',
  });
  assert.equal(r.manejado, false,
    'facturación secuestró una solicitud nueva y explícita de pedido programado');
  assert.equal(await estadoDeEspera(), null,
    'la espera de folio sobrevivió y podría secuestrar los datos del pedido programado');
});

await t('CRUCE 4 factura explícita conserva prioridad aunque mencione catering y mañana', async () => {
  await fijarEsperaDeFolio();
  const r = await manejarFacturacionWhatsapp({
    negocioId: NEG, telefono: TEL_CRUCE,
    texto: 'quiero facturar el pedido de catering de mañana',
  });
  assert.equal(r.manejado, true,
    'la intención fiscal explícita cedió ante palabras secundarias de catering/programación');
  assert.match(r.mensaje, /Envíame el folio/,
    'sin venta del teléfono debía continuar el diálogo de facturación');
  assert.equal(await estadoDeEspera(), 'esperando_folio');
});

await t('CRUCE 5 un número plausible sí lo consume la espera de folio', async () => {
  await fijarEsperaDeFolio();
  const folioInexistente = String(80000000 + Math.floor(Math.random() * 9999999));
  const r = await manejarFacturacionWhatsapp({
    negocioId: NEG, telefono: TEL_CRUCE, texto: folioInexistente,
  });
  assert.equal(r.manejado, true, 'un número desnudo plausible no llegó a facturación');
  assert.match(r.mensaje, /No encontré la venta/);
  assert.equal(await estadoDeEspera(), 'esperando_folio',
    'un folio inválido debe poder corregirse en el siguiente turno');
});

// ── La libreta de datos fiscales ─────────────────────────────────────────
//
// `regimen` y `uso_cfdi` YA NO TIENEN VALOR POR DEFECTO. Inventar un régimen
// fiscal es inventar un dato fiscal, y esta libreta existe justo para no
// inventar nada: toda llamada de aquí en adelante los manda explícitos.

await t('F8 el RFC se normaliza: un solo cliente, no dos fichas que compiten', async () => {
  assert.equal(normalizarRFC('xaxx-010101-000'), RFC);
  assert.equal(normalizarRFC(' XAXX 010101 000 '), RFC);
  const a = await guardarClienteFiscal({
    negocioId: NEG, rfc: 'xaxx-010101-000', razonSocial: 'Cliente Uno',
    regimen: '616', usoCfdi: 'S01', cp: '26000' });
  const b = await guardarClienteFiscal({
    negocioId: NEG, rfc: 'XAXX010101000', razonSocial: 'Cliente Uno Corregido',
    regimen: '616', usoCfdi: 'S01', cp: '26000' });
  assert.equal(a.id, b.id, 'el mismo RFC escrito distinto creó dos fichas');
  assert.equal(b.razon_social, 'CLIENTE UNO CORREGIDO', 'volver a capturar tiene que actualizar');
});

await t('F9 un campo opcional vacío NO borra el que ya estaba', async () => {
  // Quien factura desde el panel no suele traer el teléfono. Si eso lo
  // borrara, la búsqueda desde WhatsApp se rompería para siempre y nadie
  // sabría por qué.
  await guardarClienteFiscal({
    negocioId: NEG, rfc: RFC, razonSocial: 'Cliente Uno', regimen: '616', usoCfdi: 'S01', cp: '26000',
    telefono: '528781234567', email: 'cliente@correo.com' });
  await guardarClienteFiscal({
    negocioId: NEG, rfc: RFC, razonSocial: 'Cliente Uno', regimen: '616', usoCfdi: 'S01', cp: '26000' });
  const ficha = await obtenerClienteFiscalPorRFC(NEG, RFC);
  assert.equal(ficha.telefono, '528781234567', 'se perdió el teléfono');
  assert.equal(ficha.email, 'cliente@correo.com', 'se perdió el correo');
});

await t('F10 la ficha se encuentra por teléfono, aunque venga con otro formato', async () => {
  // La comparación es por los últimos 10 dígitos: el mismo cliente puede
  // haber quedado guardado como "8781234567" o llegar ahora como
  // "+52 878 123 4567" desde otra conversación.
  const fichas = await obtenerClientesFiscalesPorTelefono(NEG, '+52 878 123 4567');
  assert.equal(fichas.length >= 1, true, 'la conversación no puede encontrar los datos del cliente');
  assert.equal(fichas[0].rfc, RFC);
});

await t('F11 la validación rechaza lo que el SAT nunca aceptaría', async () => {
  const base = { negocioId: NEG, regimen: '616', usoCfdi: 'S01', cp: '26000', razonSocial: 'X' };
  assert.equal((await guardarClienteFiscal({ ...base, rfc: 'CORTO' })).error, 'RFC_INVALIDO');
  assert.equal((await guardarClienteFiscal({ ...base, rfc: 'XAXX010101001', razonSocial: '  ' })).error,
    'RAZON_SOCIAL_REQUERIDA');
  assert.equal((await guardarClienteFiscal({ ...base, rfc: 'XAXX010101001', cp: '123' })).error,
    'CP_INVALIDO');
  assert.equal((await guardarClienteFiscal({ ...base, rfc: 'XAXX010101001', email: 'no-es-correo' })).error,
    'EMAIL_INVALIDO');
});

await t('F11b sin régimen ni uso de CFDI, la ficha se rechaza — no se adivina', async () => {
  // Antes esta libreta tenía '626'/'G03' por defecto. Un régimen fiscal
  // inventado es un dato fiscal inventado, y por eso ya no hay omisión que
  // valga: si el operador no lo dijo, no se guarda.
  const base = { negocioId: NEG, rfc: 'XAXX010101002', razonSocial: 'X', cp: '26000' };
  assert.equal((await guardarClienteFiscal({ ...base, usoCfdi: 'S01' })).error, 'REGIMEN_REQUERIDO');
  assert.equal((await guardarClienteFiscal({ ...base, regimen: '616' })).error, 'USO_CFDI_REQUERIDO');
});

await t('F12 la libreta es POR NEGOCIO: sin negocioId no hay consulta global', async () => {
  // La misma regla que el resto del esquema. Un listado global expondría la
  // cartera fiscal de todos los negocios de la instalación.
  assert.deepEqual(await listarClientesFiscales(null), []);
  assert.deepEqual(await listarClientesFiscales(''), []);
  assert.deepEqual(await obtenerClientesFiscalesPorTelefono(null, '528781234567'), []);
  assert.equal(await obtenerClienteFiscalPorRFC(null, RFC), null);
  assert.equal(await eliminarClienteFiscal(null, 1), false);
});

await t('F13 la libreta lista y busca dentro del negocio', async () => {
  const todas = await listarClientesFiscales(NEG);
  assert.ok(todas.some((c) => c.rfc === RFC), 'la ficha guardada no aparece en la libreta');
  const porTexto = await listarClientesFiscales(NEG, { busqueda: 'Cliente Uno' });
  assert.ok(porTexto.some((c) => c.rfc === RFC), 'la búsqueda por razón social no la encuentra');
});

await t('F13b el centro de facturación lista, filtra y resume sólo el negocio de la sesión', async () => {
  const folioA = 'XAB-FACTEST-CENTROA';
  const folioB = 'XAB-FACTEST-CENTROB';
  const folioProgramado = 'XAB-FACTEST-CENTROP';
  const folioLegacy = 'XAB-FACTEST-CENTRO-LEGACY';
  const folioAjeno = 'XAB-FACTEST-CENTRO-AJENO';
  const antes = await listarRecibosFacturacion(NEG);
  try {
    await pool.query(
      `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, entregado_at)
       VALUES ($1,$2,'entregado',$3::jsonb,NOW())`,
      [NEG, folioA, JSON.stringify({ total: 125, pago_confirmado: true, cliente: { nombre: 'Cliente Centro' } })]);
    // Ventana real de activación: la fila activa ya existe y la reserva aún no
    // se marca activada. El centro debe preferir la activa y devolver un solo
    // documento, nunca hacer searchable el nombre viejo de la reserva.
    await sembrarPedidoProgramado(NEG, folioA, '5281990070', { total: 999, pagado: true });
    await sembrarPedidoProgramado(NEG, folioProgramado, '5281990069', { total: 175, pagado: true });
    const candidatoPreferido = await obtenerPedidoFacturable(NEG, folioA);
    assert.equal(candidatoPreferido._origen, 'activo');
    assert.equal(Number(candidatoPreferido.total), 125,
      'facturación eligió la fotografía programada vieja durante la activación');
    await pool.query(
      `INSERT INTO facturacion_recibos
         (negocio_id, folio, total, idempotency_key, recibo_id, url_autofactura, estado)
       VALUES
         ($1,$2,125,$3,'rec_centro_a','https://facturapi.example/self/centro-a','abierto'),
         ($1,$4,250,$5,'rec_centro_b',NULL,'facturado'),
         ($6,$7,999,$8,'rec_centro_ajeno',NULL,'error')`,
      [NEG, folioA, `xabor:${NEG}:${folioA}`, folioB, `xabor:${NEG}:${folioB}`,
        NEG_B, folioAjeno, `xabor:${NEG_B}:${folioAjeno}`]);
    await prepararReciboAbierto(NEG, folioProgramado, 175);
    await pool.query(
      `INSERT INTO facturas_pedido (negocio_id, folio, factura_id, uuid, total, fuente)
       VALUES ($1,$2,'fac_centro_legacy','11111111-2222-3333-4444-555555555556',75,'panel')`,
      [NEG, folioLegacy]);

    const centro = await listarRecibosFacturacion(NEG, { busqueda: 'CENTRO', limite: 500 });
    assert.deepEqual(new Set(centro.recibos.map((r) => r.folio)),
      new Set([folioA, folioB, folioProgramado, folioLegacy]));
    assert.ok(!centro.recibos.some((r) => r.folio === folioAjeno), 'se filtró un recibo de otro negocio');
    assert.equal(centro.resumen.total, antes.resumen.total + 4);
    assert.equal(centro.resumen.pendientes, antes.resumen.pendientes + 2);
    assert.equal(centro.resumen.facturadas, antes.resumen.facturadas + 2);
    assert.equal(centro.paginacion.limite, 100, 'el límite del panel no quedó acotado');

    const porCliente = await listarRecibosFacturacion(NEG, { busqueda: 'Cliente Centro' });
    assert.deepEqual(porCliente.recibos.map((r) => r.folio), [folioA]);
    const porClienteProgramado = await listarRecibosFacturacion(NEG, { busqueda: 'Cliente Programado' });
    assert.deepEqual(porClienteProgramado.recibos.map((r) => r.folio), [folioProgramado],
      'el centro perdió la prioridad del activo o no encontró la venta aún programada');
    const facturadas = await listarRecibosFacturacion(NEG, { estado: 'facturado' });
    assert.ok(facturadas.recibos.some((r) => r.folio === folioB));
    assert.ok(facturadas.recibos.some((r) => r.folio === folioLegacy),
      'las facturas anteriores al modelo de recibos desaparecieron del centro');
    assert.ok(facturadas.recibos.every((r) => r.estado === 'facturado'));
  } finally {
    await pool.query('DELETE FROM facturacion_recibos WHERE negocio_id = ANY($1) AND folio = ANY($2)',
      [[NEG, NEG_B], [folioA, folioB, folioProgramado, folioAjeno]]);
    await pool.query('DELETE FROM facturas_pedido WHERE negocio_id=$1 AND folio=$2', [NEG, folioLegacy]);
    await pool.query('DELETE FROM pedidos_programados WHERE negocio_id=$1 AND folio = ANY($2)',
      [NEG, [folioA, folioProgramado]]);
    await pool.query('DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2', [NEG, folioA]);
  }
});

await t('F13c el centro falla cerrado sin negocio y rechaza estados inventados', async () => {
  await assert.rejects(() => listarRecibosFacturacion(null), (e) => e?.codigo === 'NEGOCIO_REQUERIDO');
  await assert.rejects(() => listarRecibosFacturacion(NEG, { estado: 'todos-los-negocios' }),
    (e) => e?.codigo === 'ESTADO_INVALIDO');
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE C — LA INTERFAZ (panel)
// ═══════════════════════════════════════════════════════════════════════════

await t('F14 el botón de factura no se enseña sin cuenta vinculada', () => {
  // Ofrecer una acción que sólo puede acabar en «este negocio no tiene
  // Facturapi» es peor que no ofrecerla.
  const panel = leer('panel/index.html');
  // Desde la Fase 3.3 del menú el botón vive en una variable que comparten el
  // admin y el cajero; sigue dependiendo de la cuenta vinculada.
  assert.match(panel, /PUEDE_FACTURAR\s*\?\s*`<button class="btn-fila" onclick="abrirModalFactura/,
    'el botón de factura dejó de depender de que haya cuenta vinculada');
});

await t('F15 la interfaz de FACTURACIÓN usa icono de trazo, no emoji', () => {
  // Un emoji se dibuja distinto en cada sistema, no se puede teñir y no se
  // alinea con el texto. El panel ya tiene su lenguaje de iconos y la
  // facturación ahora lo usa.
  //
  // El alcance es DELIBERADO: quedan emojis en tickets, cotizaciones y
  // «pedido en curso», que son de otras pantallas y no se tocaron. Afirmar
  // aquí que el panel entero está libre de emoji sería falso.
  const panel = leer('panel/index.html');
  const boton = panel.slice(panel.indexOf('onclick="abrirModalFactura') - 120,
    panel.indexOf('onclick="abrirModalFactura') + 200);
  assert.ok(!/🧾/.test(boton), 'volvió el emoji al botón de factura');
  assert.match(panel, /factura:\s*'<path d="M4 2v20/,
    'el icono de recibo de trazo desapareció');

  const tituloModal = panel.slice(panel.indexOf('Generar factura (CFDI)') - 160,
    panel.indexOf('Generar factura (CFDI)') + 40);
  assert.ok(!/🧾/.test(tituloModal), 'volvió el emoji al título del modal');
});

await t('F16 Config mide EMITIR, no la e.firma', () => {
  // El defecto que trajo todo esto: el chip decía «✓ e.firma cargada» —que
  // sirve para DESCARGAR comprobantes ajenos— bajo un botón llamado
  // «Facturación», y la gente concluía que podía facturar.
  const panel = leer('panel/index.html');
  assert.match(panel, /chip\('facturacion'[\s\S]{0,400}?Falta vincular Facturapi/,
    'el chip de facturación volvió a medir la e.firma');
});

await t('F17 la llave nunca vuelve del servidor', () => {
  // Se manda una vez y se guarda cifrada. Si alguna ruta la devolviera,
  // bastaría una sesión de admin comprometida para llevársela.
  const src = codigo('src/server.js');
  // Lo que importa no es que la palabra aparezca —la ruta tiene que leerla
  // del cuerpo—, sino que no salga en ninguna RESPUESTA.
  const respuestas = [...src.matchAll(/res\.json\(([^;]*)\)/g)].map((m) => m[1]);
  const filtradas = respuestas.filter((r) => /api_?[kK]ey/.test(r));
  assert.deepEqual(filtradas, [],
    'una respuesta del servidor devuelve la llave de Facturapi');
});

await t('F28 el panel tiene dónde configurar la tasa de IVA', () => {
  // `configProveedor()` en facturacionService.js LANZA IVA_NO_CONFIGURADO si
  // esto falta. Sin esta sección, una cuenta vinculada no basta: el primer
  // recibo revienta y nadie en el panel sabe por qué.
  const panel = leer('panel/index.html');
  assert.match(panel, /id="fc-iva"/, 'falta el selector de tasa de IVA');
  assert.match(panel, /guardarConfigFacturacion/, 'falta la función que la guarda');
  assert.match(panel, /PUT.*\/api\/admin\/facturacion\/configuracion|facturacion\/configuracion.*PUT/s,
    'el panel no llama a la ruta de configuración');
});

await t('F28b Facturación ya es un centro operativo y no sólo configuración', () => {
  const panel = leer('panel/index.html');
  const servidor = leer('src/server.js');
  assert.match(panel, /id="facturacion-folio-directo"/, 'falta facturar directamente por folio');
  assert.match(panel, /id="facturacion-recibos-lista"/, 'falta el listado de recibos y CFDI');
  assert.match(panel, /\/api\/admin\/facturacion\/recibos\?/, 'el panel no consulta el centro');
  assert.match(panel, /\/api\/admin\/factura\/\$\{encodeURIComponent\(recibo\.factura_id\)\}\/pdf/,
    'las facturas emitidas no tienen acceso al PDF');
  // El cajero también factura (Fase 3.3 del menú, regla del dueño): la puerta
  // es la de admin o la de cajero, siempre por negocio. Qué rutas llevan la
  // de cajero lo vigila fase-permisos-cajero.
  assert.match(servidor,
    /app\.get\('\/api\/admin\/facturacion\/recibos'[\s\S]{0,100}?(?:requireAdminSeguro|requireCajeroSeguro)[\s\S]{0,100}?requireModulo\('facturacion'\)/,
    'el listado no está protegido como administración por negocio');
  assert.match(servidor,
    /app\.post\('\/api\/admin\/facturacion\/recibos\/:folio\/sincronizar'[\s\S]{0,100}?(?:requireAdminSeguro|requireCajeroSeguro)[\s\S]{0,100}?requireModulo\('facturacion'\)/,
    'la sincronización puntual perdió sus gates');
});

await t('F28c el modal no limita al cliente a cuatro regímenes ni tres usos CFDI', () => {
  const panel = leer('panel/index.html');
  const bloqueRegimen = panel.slice(panel.indexOf('id="factura-regimen"'), panel.indexOf('id="factura-uso"'));
  const bloqueUso = panel.slice(panel.indexOf('id="factura-uso"'), panel.indexOf('id="factura-cp"'));
  const regimenes = ['601','603','605','606','607','608','609','610','611','612','614','615','616','620','621','622','623','624','625','626','628','629','630'];
  const usos = ['G01','G02','G03','I01','I02','I03','I04','I05','I06','I07','I08','D01','D02','D03','D04','D05','D06','D07','D08','D09','D10','S01'];
  for (const codigoRegimen of regimenes) {
    assert.match(bloqueRegimen, new RegExp(`value="${codigoRegimen}"`), `falta el régimen ${codigoRegimen}`);
  }
  for (const codigoUso of usos) {
    assert.match(bloqueUso, new RegExp(`value="${codigoUso}"`), `falta el uso CFDI ${codigoUso}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE D — RECONOCIMIENTO DE CLIENTES FISCALES POR TELÉFONO (WhatsApp)
// ═══════════════════════════════════════════════════════════════════════════
//
// `obtenerClientesFiscalesPorTelefono` ya existía; lo que faltaba era usarlo
// en `manejarFacturacionWhatsapp`. El reconocimiento es PURAMENTE
// INFORMATIVO: nunca factura solo porque exista una ficha, nunca inventa
// RFC/régimen/uso de CFDI (solo repite lo que YA está guardado), y nunca
// cruza negocio ni teléfono.

await t('F29 reconocimiento: UNA ficha guardada se menciona en el mensaje', async () => {
  await configurarFacturapiFalso(NEG);
  const folio = 'XAB-FACTEST-RECONA';
  await sembrarPedidoPagado(NEG, folio, TEL);
  await prepararReciboAbierto(NEG, folio, 100);
  await guardarClienteFiscal({
    negocioId: NEG, rfc: RFC, razonSocial: 'Cliente Reconocido',
    regimen: '616', usoCfdi: 'S01', cp: '26000', telefono: TEL,
  });

  const r = await manejarFacturacionWhatsapp({ negocioId: NEG, telefono: TEL, texto: `factura ${folio}` });
  assert.equal(r.manejado, true);
  assert.doesNotMatch(r.mensaje, new RegExp(RFC), 'WhatsApp no es canal verificado: no debe exponer el RFC completo');
  assert.doesNotMatch(r.mensaje, /Cliente Reconocido/, 'no debe exponer la razón social guardada');
  assert.doesNotMatch(r.mensaje, /\b616\b/, 'no debe exponer el régimen fiscal guardado');
  assert.match(r.mensaje, /Encontramos datos fiscales utilizados anteriormente/,
    'el mensaje generico de reconocimiento no aparecio');
  assert.match(r.mensaje, /portal de facturación/,
    'el mensaje tiene que remitir al portal, no resolverlo aqui');

  // LA GARANTIA CENTRAL: reconocer no es facturar. El recibo sigue abierto;
  // nada aqui llamo a facturarRecibo ni cambio el estado.
  const { rows: [recibo] } = await pool.query(
    'SELECT estado FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2', [NEG, folio]);
  assert.equal(recibo.estado, 'abierto',
    'el reconocimiento factura automaticamente solo porque hay una ficha guardada');
});

await t('F30 sin ficha fiscal, el mensaje queda exactamente como sin reconocimiento', async () => {
  await configurarFacturapiFalso(NEG);
  const folio = 'XAB-FACTEST-RECONB';
  const telSinFicha = '5281990077';
  await sembrarPedidoPagado(NEG, folio, telSinFicha);
  await prepararReciboAbierto(NEG, folio, 100);

  const r = await manejarFacturacionWhatsapp({ negocioId: NEG, telefono: telSinFicha, texto: `factura ${folio}` });
  assert.equal(r.manejado, true);
  assert.doesNotMatch(r.mensaje, /RFC/, 'menciono un RFC que no existe para este telefono');
  assert.match(r.mensaje, /captura tus datos fiscales aquí/);
});

await t('F31 dos fichas para el mismo teléfono: avisa, no elige ni inventa cuál', async () => {
  await configurarFacturapiFalso(NEG);
  const folio = 'XAB-FACTEST-RECONC';
  const telDosFichas = '5281990066';
  await sembrarPedidoPagado(NEG, folio, telDosFichas);
  await prepararReciboAbierto(NEG, folio, 100);
  await guardarClienteFiscal({
    negocioId: NEG, rfc: 'XAXX010101001', razonSocial: 'Cliente Personal',
    regimen: '616', usoCfdi: 'S01', cp: '26000', telefono: telDosFichas,
  });
  await guardarClienteFiscal({
    negocioId: NEG, rfc: 'XAXX010101002', razonSocial: 'Cliente Empresa',
    regimen: '601', usoCfdi: 'G03', cp: '26000', telefono: telDosFichas,
  });

  const r = await manejarFacturacionWhatsapp({ negocioId: NEG, telefono: telDosFichas, texto: `factura ${folio}` });
  assert.match(r.mensaje, /Encontramos varias opciones de datos fiscales/,
    'el mensaje generico de multiples fichas no aparecio');
  assert.match(r.mensaje, /portal de facturación/);
  assert.doesNotMatch(r.mensaje, /XAXX010101001/, 'eligio un RFC entre los dos sin que el cliente lo dijera');
  assert.doesNotMatch(r.mensaje, /XAXX010101002/, 'eligio el otro RFC sin que el cliente lo dijera');
  assert.doesNotMatch(r.mensaje, /Cliente Personal|Cliente Empresa/, 'no debe exponer razon social alguna');

  await pool.query("DELETE FROM clientes_fiscales WHERE negocio_id=$1 AND telefono=$2", [NEG, telDosFichas]);
});

await t('F32 LA GARANTÍA MULTIEMPRESA: una ficha de OTRO negocio, mismo teléfono, nunca se menciona', async () => {
  // El escenario exacto que prohibe la tarea: un telefono que SI tiene una
  // ficha fiscal, pero registrada bajo NEG_B. Quien factura ahora es NEG.
  // El mensaje de NEG tiene que comportarse EXACTAMENTE como si no hubiera
  // ninguna ficha -- porque para NEG, no la hay.
  const telCompartido = '5281990055';
  await guardarClienteFiscal({
    negocioId: NEG_B, rfc: 'BBBB020202BBB', razonSocial: 'Cliente De Otro Negocio',
    regimen: '601', usoCfdi: 'G03', cp: '64000', telefono: telCompartido,
  });

  await configurarFacturapiFalso(NEG);
  const folio = 'XAB-FACTEST-RECOND';
  await sembrarPedidoPagado(NEG, folio, telCompartido);
  await prepararReciboAbierto(NEG, folio, 100);

  const r = await manejarFacturacionWhatsapp({ negocioId: NEG, telefono: telCompartido, texto: `factura ${folio}` });
  assert.equal(r.manejado, true);
  assert.doesNotMatch(r.mensaje, /BBBB020202BBB/,
    'el mensaje de NEG expuso el RFC de un cliente fiscal que pertenece a NEG_B');
  assert.doesNotMatch(r.mensaje, /Cliente De Otro Negocio/, 'expuso la razon social de un cliente de NEG_B');
  assert.doesNotMatch(r.mensaje, /Encontramos datos fiscales|Encontramos varias opciones/,
    'el mensaje se comporto como si NEG tuviera una ficha reconocida, y no la tiene');

  await pool.query("DELETE FROM clientes_fiscales WHERE negocio_id=$1 AND rfc=$2", [NEG_B, 'BBBB020202BBB']);
});

await t('F33 el reconocimiento encuentra la ficha aunque el teléfono llegue con otro formato', async () => {
  await configurarFacturapiFalso(NEG);
  const folio = 'XAB-FACTEST-RECONE';
  const telGuardado = '8781234599';
  const telFormatoDistinto = '+52 878 123 4599';
  await sembrarPedidoPagado(NEG, folio, telFormatoDistinto);
  await prepararReciboAbierto(NEG, folio, 100);
  await guardarClienteFiscal({
    negocioId: NEG, rfc: 'XAXX010101003', razonSocial: 'Cliente Formato Distinto',
    regimen: '616', usoCfdi: 'S01', cp: '26000', telefono: telGuardado,
  });

  const r = await manejarFacturacionWhatsapp({ negocioId: NEG, telefono: telFormatoDistinto, texto: `factura ${folio}` });
  assert.doesNotMatch(r.mensaje, /XAXX010101003/, 'WhatsApp no debe exponer el RFC completo aunque si reconozca la ficha');
  assert.match(r.mensaje, /Encontramos datos fiscales utilizados anteriormente/,
    'el reconocimiento no encontro la ficha guardada con otro formato de telefono');

  await pool.query("DELETE FROM clientes_fiscales WHERE negocio_id=$1 AND rfc=$2", [NEG, 'XAXX010101003']);
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE E — CASOS NEGATIVOS ESPECÍFICOS DE ESTA RONDA
// ═══════════════════════════════════════════════════════════════════════════
//
// Pedido inexistente (F18), cancelado (F19), no pagado (F20), folio de otro
// teléfono (F25), negocio sin Facturapi (F6/F7), RFC inválido (F11) y la
// libreta por negocio (F12) ya estaban cubiertos antes de esta ronda. Aquí
// se cierran los que faltaban: IVA sin configurar con cuenta YA vinculada,
// y la idempotencia del recibo ante un reintento.

await t('F34 negocio CON Facturapi pero SIN tasa de IVA: falla con el código correcto, sin tocar la red', async () => {
  // Solo la credencial, a propósito: sin fila en facturacion_configuracion,
  // iva_tasa vuelve null por el valor por defecto de
  // obtenerConfiguracionFacturacion. Se borra explícitamente cualquier
  // configuración previa de NEG (pruebas anteriores de esta misma ronda ya
  // le configuraron IVA) para que este caso no dependa del orden en que
  // corran las demás.
  await guardarCredencialesFacturapi(NEG, 'sk_test_nunca_se_debe_usar_de_verdad', null);
  await pool.query('DELETE FROM facturacion_configuracion WHERE negocio_id=$1', [NEG]);
  const folio = 'XAB-FACTEST-SINIVA';
  await sembrarPedidoPagado(NEG, folio, TEL);

  await assert.rejects(
    () => asegurarReciboPedido(NEG, folio),
    (e) => e instanceof FacturacionError && e.codigo === 'IVA_NO_CONFIGURADO',
    'no lanzo IVA_NO_CONFIGURADO con la cuenta vinculada pero sin tasa');

  // Y NINGÚN recibo remoto se creó: configProveedor() lanza ANTES de que
  // asegurarReciboPedido llegue a llamar a crearRecibo.
  const { rows } = await pool.query(
    'SELECT recibo_id FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2', [NEG, folio]);
  assert.equal(rows[0]?.recibo_id ?? null, null, 'se creó un recibo remoto sin tener IVA configurado');
});

await t('F35 idempotencia (nivel servicio): un recibo ya abierto se REUTILIZA, nunca se vuelve a pedir', async () => {
  await configurarFacturapiFalso(NEG);
  const folio = 'XAB-FACTEST-IDEMP';
  await sembrarPedidoPagado(NEG, folio, TEL, 250);
  await prepararReciboAbierto(NEG, folio, 250);

  // Si esto llamara a crearRecibo con la llave falsa, lanzaria (red
  // inalcanzable o rechazo de Facturapi) en vez de devolver limpio.
  const recibo = await asegurarReciboPedido(NEG, folio);
  assert.equal(recibo.estado, 'abierto');
  assert.equal(recibo.recibo_id, `rec_prueba_${folio}`,
    'no devolvio el recibo ya sembrado: intento crear uno nuevo');

  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2', [NEG, folio]);
  assert.equal(rows[0].n, 1, 'quedó más de un recibo local para el mismo pedido');
});

await t('F35b un programado pagado crea un solo recibo y el retry lo reutiliza antes de -1 h', async () => {
  await configurarFacturapiFalso(NEG);
  const folio = 'XAB-FACTEST-PIDEMP';
  const total = 275;
  await sembrarPedidoProgramado(NEG, folio, '5281990071', { total, pagado: true });

  const fetchOriginal = global.fetch;
  let llamadas = 0;
  global.fetch = async (url, opciones) => {
    llamadas += 1;
    assert.equal(String(url), 'https://www.facturapi.io/v2/receipts');
    assert.equal(opciones?.method, 'POST');
    const cuerpo = JSON.parse(opciones.body);
    assert.equal(cuerpo.external_id, folio);
    assert.equal(Number(cuerpo.items?.[0]?.product?.price), total);
    return {
      ok: true,
      status: 201,
      json: async () => ({
        id: `rec_programado_${folio}`,
        key: `clave-${folio}`,
        self_invoice_url: `https://facturapi.example/self/${folio}`,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        status: 'open',
        total,
      }),
    };
  };

  try {
    const primero = await asegurarReciboPedido(NEG, folio);
    const segundo = await asegurarReciboPedido(NEG, folio);
    assert.equal(primero.estado, 'abierto');
    assert.equal(segundo.recibo_id, primero.recibo_id);
    assert.equal(llamadas, 1, 'el retry pidió un segundo recibo remoto');

    const { rows: [conteo] } = await pool.query(
      'SELECT count(*)::int AS n FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2',
      [NEG, folio]);
    assert.equal(conteo.n, 1, 'el programado pagado dejó más de un recibo local');
  } finally {
    global.fetch = fetchOriginal;
    await pool.query('DELETE FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2', [NEG, folio]);
    await pool.query('DELETE FROM pedidos_programados WHERE negocio_id=$1 AND folio=$2', [NEG, folio]);
  }
});

await t('F36 idempotencia (nivel base): la restricción única de Postgres rechaza un segundo recibo', async () => {
  // La misma garantia que prueba F35, pero mirando el candado real: la
  // restriccion UNIQUE(negocio_id, folio) de la migracion 087, no la logica
  // de la aplicacion. Un reintento crudo -- sin el ON CONFLICT que usa
  // asegurarReciboPedido -- tiene que ser Postgres quien lo rechace.
  const folio = 'XAB-FACTEST-UNICO';
  await pool.query(
    `INSERT INTO facturacion_recibos (negocio_id, folio, total, idempotency_key)
     VALUES ($1,$2,$3,$4)`, [NEG, folio, 50, `xabor:${NEG}:${folio}:1`]);
  await assert.rejects(
    () => pool.query(
      `INSERT INTO facturacion_recibos (negocio_id, folio, total, idempotency_key)
       VALUES ($1,$2,$3,$4)`, [NEG, folio, 50, `xabor:${NEG}:${folio}:2`]),
    /duplicate key value violates unique constraint/,
    'la base permitio un segundo recibo para el mismo negocio+folio');
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE F — EL RECONOCIMIENTO FISCAL NUNCA ROMPE UN RECIBO YA CREADO
// ═══════════════════════════════════════════════════════════════════════════
//
// avisoDeReconocimiento corre DESPUES de que asegurarReciboPedido ya dejo
// listo el recibo con su url_autofactura. Si la consulta de clientes_fiscales
// revienta de forma inesperada (un hipo de la base, por ejemplo), eso no
// puede convertir una autofactura ya creada en un "no pude preparar la
// factura" para el cliente -- el recibo YA es real y YA tiene URL.
//
// pool.query se reemplaza por una version que solo hace explotar, de forma
// SINCRONA, la consulta contra clientes_fiscales (para saltarse el propio
// `.catch(() => ({rows: []}))` de obtenerClientesFiscalesPorTelefono, que ya
// ahoga los rechazos de promesa) y deja pasar cualquier otra consulta
// (estadoPendiente, asegurarReciboPedido, limpiarEstado) sin tocarla.

await t('F37 si la consulta de clientes fiscales revienta, el recibo ya creado se sigue entregando como éxito', async () => {
  await configurarFacturapiFalso(NEG);
  const folio = 'XAB-FACTEST-RECONF';
  const telExplota = '5281990044';
  await sembrarPedidoPagado(NEG, folio, telExplota);
  await prepararReciboAbierto(NEG, folio, 100);

  const originalQuery = pool.query.bind(pool);
  const advertencias = [];
  const originalWarn = console.warn;
  console.warn = (...args) => advertencias.push(args.join(' '));
  pool.query = (sql, params) => {
    if (typeof sql === 'string' && sql.includes('clientes_fiscales')) {
      throw new Error('conexión caída de prueba (simulación F37)');
    }
    return originalQuery(sql, params);
  };

  let r;
  try {
    r = await manejarFacturacionWhatsapp({ negocioId: NEG, telefono: telExplota, texto: `factura ${folio}` });
  } finally {
    pool.query = originalQuery;
    console.warn = originalWarn;
  }

  assert.equal(r.manejado, true);
  assert.notEqual(r.escalar, true,
    'una excepcion en el reconocimiento (que es solo informativo) escalo la conversacion');
  assert.match(r.mensaje, /captura tus datos fiscales aquí/,
    'el recibo ya creado no se entrego pese a que la falla fue solo del reconocimiento');
  assert.match(r.mensaje, /facturapi\.example\/self\//,
    'la URL de autofactura del recibo ya creado se perdio');
  assert.ok(advertencias.some((a) => a.includes('avisoDeReconocimiento')),
    'no se registro ninguna advertencia sobre la falla del reconocimiento');
});

await t('F38 si el CFDI ya se timbró pero falla la ficha, conserva factura y UUID en el error 207', async () => {
  await configurarFacturapiFalso(NEG);
  const folio = 'XAB-FACTEST-F207';
  const facturaId = 'fac_prueba_ficha_207';
  const uuid = '11111111-2222-3333-4444-555555555555';
  await sembrarPedidoPagado(NEG, folio, TEL);
  await prepararReciboAbierto(NEG, folio, 100);

  const fetchOriginal = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: facturaId, uuid }),
  });

  let error;
  try {
    await emitirFacturaPedido(NEG, folio, {
      // Facturapi está simulado y devuelve un CFDI emitido. El RFC inválido
      // hace fallar únicamente la libreta local, después del timbrado.
      rfc: 'RFC-INVALIDO', nombre_fiscal: 'Cliente Prueba',
      regimen: '616', uso_cfdi: 'S01', cp: '26000', telefono: TEL,
    });
  } catch (e) {
    error = e;
  } finally {
    global.fetch = fetchOriginal;
  }

  assert.equal(error?.codigo, 'FICHA_NO_GUARDADA');
  assert.equal(error?.status, 207);
  assert.equal(error?.facturaId, facturaId);
  assert.equal(error?.uuid, uuid);

  const { rows: [recibo] } = await pool.query(
    'SELECT estado, factura_id, uuid FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2',
    [NEG, folio]);
  assert.deepEqual(recibo, { estado: 'facturado', factura_id: facturaId, uuid },
    'la factura timbrada no quedó persistida antes de reportar la falla de la ficha');

  const { rows: [registro] } = await pool.query(
    'SELECT factura_id, uuid FROM facturas_pedido WHERE negocio_id=$1 AND folio=$2',
    [NEG, folio]);
  assert.deepEqual(registro, { factura_id: facturaId, uuid },
    'el vínculo pedido→CFDI se perdió pese a que el proveedor ya timbró');
});

} finally {
  await limpiar();
  await pool.end().catch(() => {});
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`PASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
