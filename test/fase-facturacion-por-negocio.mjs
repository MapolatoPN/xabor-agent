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
const { TenantContextRequiredError } = await import('../src/services/integracionesService.js');
const { obtenerPedidoFacturable, obtenerUltimoPedidoFacturablePorTelefono,
  pedidoPerteneceATelefono, normalizarFolioFactura, asegurarReciboPedido,
  FacturacionError } = await import('../src/services/facturacionService.js');
const { esSolicitudFactura, extraerFolioFactura, manejarFacturacionWhatsapp } =
  await import('../src/services/facturacionWhatsapp.js');

const { rows: [neg] } = await pool.query('SELECT id FROM negocios ORDER BY created_at LIMIT 1');
if (!neg) throw new Error('La base local no tiene un negocio de prueba');
const NEG = neg.id;
const RFC = 'XAXX010101000';
const TEL = '5281990088';
const PEDIDO_PRUEBA = { folio: 'XAB-FACTEST', total: 100, forma_pago: 'efectivo' };

const limpiar = () => Promise.all([
  pool.query("DELETE FROM clientes_fiscales WHERE negocio_id = $1 AND rfc LIKE 'XAXX%'", [NEG]),
  pool.query('DELETE FROM facturacion_recibos WHERE negocio_id = $1 AND folio LIKE $2', [NEG, 'XAB-FACTEST%']),
  pool.query('DELETE FROM facturacion_whatsapp_estado WHERE negocio_id = $1 AND telefono = $2', [NEG, TEL]),
  pool.query('DELETE FROM pedidos_activos WHERE negocio_id = $1 AND folio LIKE $2', [NEG, 'XAB-FACTEST%']),
]).catch(() => {});
await limpiar();

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

await t('F22 normalizarFolioFactura acepta variantes y rechaza basura', () => {
  assert.equal(normalizarFolioFactura('xab21'), 'XAB-0021');
  assert.equal(normalizarFolioFactura('XAB-0021'), 'XAB-0021');
  assert.equal(normalizarFolioFactura('folio 21'), 'XAB-0021');
  assert.equal(normalizarFolioFactura('21'), 'XAB-0021');
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

// ═══════════════════════════════════════════════════════════════════════════
// PARTE C — LA INTERFAZ (panel)
// ═══════════════════════════════════════════════════════════════════════════

await t('F14 el botón de factura no se enseña sin cuenta vinculada', () => {
  // Ofrecer una acción que sólo puede acabar en «este negocio no tiene
  // Facturapi» es peor que no ofrecerla.
  const panel = leer('panel/index.html');
  assert.match(panel, /\$\{PUEDE_FACTURAR\?`<button class="btn-fila" onclick="abrirModalFactura/,
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

} finally {
  await limpiar();
  await pool.end().catch(() => {});
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`PASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
