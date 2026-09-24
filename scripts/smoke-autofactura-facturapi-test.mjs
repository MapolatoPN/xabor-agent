// SMOKE REAL CONTROLADO — autofactura nativa contra Facturapi TEST.
//
// Emite exactamente UNA autofactura con el motor de la fase 4A
// (emitirAutofactura) usando la Secret Test Key ya guardada por negocio en la
// base LOCAL. Guardas:
//   - DATABASE_URL debe ser local; NODE_ENV=production aborta;
//   - la credencial del negocio debe descifrarse con INTEGRATIONS_ENCRYPTION_KEY
//     del entorno (o de dev-local.env.cmd si no está) y empezar con sk_test_;
//     si no, se aborta SIN ningún request externo;
//   - el transporte se envuelve para contar los POST /v2/invoices y abortar
//     antes de enviar un segundo;
//   - nunca se imprimen llaves, cabeceras, snapshot, payload ni material
//     criptográfico; el RFC de prueba es el ficticio documentado por Facturapi.
//
// Uso (desde el worktree, con DATABASE_URL local en el entorno o Docker):
//   node scripts/smoke-autofactura-facturapi-test.mjs
// Temporal: no se agrega a git.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const RESUMEN = { smoke: 'FAIL', posts: 0 };
function salir(motivo) { RESUMEN.motivo = motivo; console.log('\n=== RESUMEN ===\n' + JSON.stringify(RESUMEN, null, 2)); process.exit(RESUMEN.smoke === 'FAIL' ? 1 : 0); }

// ── Entorno ───────────────────────────────────────────────────────────────
if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') salir('NODE_ENV=production: este smoke no corre en producción');
if (!process.env.DATABASE_URL) {
  const pass = execSync('docker exec pg-restv2 printenv POSTGRES_PASSWORD').toString().trim();
  process.env.DATABASE_URL = `postgresql://postgres:${pass}@localhost:55453/edged1_agrescate`;
}
if (!['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname)) salir('DATABASE_URL no es local');
if (!process.env.INTEGRATIONS_ENCRYPTION_KEY) {
  const f = 'C:/xabor-agent/dev-local.env.cmd';
  const m = existsSync(f) ? readFileSync(f, 'utf8').match(/^set INTEGRATIONS_ENCRYPTION_KEY=(.+)$/m) : null;
  if (!m) salir('INTEGRATIONS_ENCRYPTION_KEY no está en el entorno ni en dev-local.env.cmd');
  process.env.INTEGRATIONS_ENCRYPTION_KEY = m[1].trim();
  RESUMEN.llave_cifrado_origen = 'dev-local.env.cmd';
} else {
  RESUMEN.llave_cifrado_origen = 'entorno del proceso';
}
process.env.XABOR_URL_PUBLICA ||= 'http://localhost:3000';

const { pool } = await import('../src/services/database.js');
const { obtenerCredencialesFacturapiDescifradas } = await import('../src/services/integracionesService.js');
const { estadoFacturacionNegocio, obtenerConfiguracionFacturacion, obtenerPedidoFacturable } = await import('../src/services/facturacionService.js');
const { crearOObtenerAutofactura } = await import('../src/services/autofacturaService.js');
const { validarDatosFiscales } = await import('../src/services/autofacturaFiscal.js');
const { emitirAutofactura, reconciliarAutofacturaPendiente, construirPayloadCFDI } = await import('../src/services/autofacturaEmision.js');

// ── Transporte vigilado: cuenta POST /v2/invoices y aborta antes del segundo ──
const fetchOriginal = globalThis.fetch;
const proveedor = { posts: 0, gets: 0, ultimo: null };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://www.facturapi.io/')) return fetchOriginal(url, init);
  const method = (init.method || 'GET').toUpperCase();
  if (method === 'POST' && /\/v2\/invoices$/.test(u)) {
    if (proveedor.posts >= 1) throw new Error('GUARDA: se intentó un segundo POST /v2/invoices; abortado antes de enviar');
    proveedor.posts++;
  } else if (method === 'GET') { proveedor.gets++; }
  else throw new Error(`GUARDA: método ${method} no permitido en el smoke (${u.replace(/inv_[A-Za-z0-9]+/g, 'inv_…')})`);
  if (!/^https:\/\/www\.facturapi\.io\/v2\/invoices(\/[^/?]+)?$/.test(u)) throw new Error('GUARDA: ruta de Facturapi no permitida en el smoke');
  const resp = await fetchOriginal(url, init);
  const clon = resp.clone();
  let body = null; try { body = await clon.json(); } catch { /* sin JSON */ }
  proveedor.ultimo = {
    method, status: resp.status,
    proveedor_status: body?.status ?? null, livemode: body?.livemode ?? null, id: body?.id ?? null, uuid: body?.uuid ?? null,
    code: body?.code ?? null, message_sanitizado: typeof body?.message === 'string' ? body.message.replace(/[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}/g, '[RFC]').slice(0, 160) : null,
  };
  return resp;
};

try {
  // 1-5. Negocio con Facturapi y credencial sk_test_ descifrable.
  const { rows: candidatos } = await pool.query(
    `SELECT n.id, n.nombre, n.slug FROM integraciones_canal ic JOIN negocios n ON n.id=ic.negocio_id
      WHERE ic.canal='facturacion' AND ic.proveedor='facturapi' AND ic.estado='activo' AND n.activo
      ORDER BY (n.slug='faseb-negocio-a') DESC, ic.updated_at DESC`);
  if (!candidatos.length) salir('ningún negocio local tiene Facturapi configurado');
  let negocio = null;
  for (const c of candidatos) {
    let cred = null; try { cred = await obtenerCredencialesFacturapiDescifradas(c.id); } catch { cred = null; }
    const ok = !!cred?.apiKey && cred.apiKey.startsWith('sk_test_');
    console.log(`[smoke] negocio ${c.id} (${c.nombre}): credencial=${!!cred?.apiKey} sk_test=${ok}`);
    if (ok) { negocio = c; break; }
    if (cred?.apiKey) salir(`la credencial de ${c.nombre} NO es sk_test_: abortado sin request externo`);
  }
  if (!negocio) salir('no hay una credencial sk_test_ descifrable con la llave de cifrado disponible: abortado sin request externo');
  RESUMEN.negocio = { id: negocio.id, nombre: negocio.nombre };
  const estado = await estadoFacturacionNegocio(negocio.id);
  if (!estado.puedeFacturar) salir(`el negocio no puede facturar (proveedor=${estado.proveedorConfigurado}, iva=${estado.ivaConfigurado})`);
  const config = await obtenerConfiguracionFacturacion(negocio.id);
  RESUMEN.config = { iva_tasa: config.iva_tasa, serie: config.serie };

  // Fixture: venta sintética única, pagada y entregada, $116 efectivo.
  const folio = 'XAB-SMOKEAF-' + randomBytes(3).toString('hex').toUpperCase().replace(/[0-9]/g, (d) => 'GHJKLMNPQR'[Number(d)]);
  const tel = '5218' + Date.now().toString().slice(-6) + '000';
  await pool.query(
    `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, entregado_at) VALUES ($1,$2,'entregado',$3::jsonb, NOW())`,
    [negocio.id, folio, JSON.stringify({
      canal: 'pos', modalidad: 'recoger en tienda', forma_pago: 'efectivo', total: 116, pago_confirmado: true,
      telefono_conversacion: tel, timestamp: new Date().toISOString(),
      cliente: { nombre: 'SMOKE AUTOFACTURA FACTURAPI TEST', telefono: tel },
      items: [{ nombre: 'Consumo de prueba autofactura', cantidad: 1, precio_unitario: 116 }],
    })]);
  const liga = await crearOObtenerAutofactura(negocio.id, folio);
  RESUMEN.venta = { folio, total_congelado: liga.total, autofactura_id: liga.id, estado_inicial: liga.estado };
  if (liga.total !== 116) salir(`total congelado inesperado: ${liga.total}`);

  // Datos fiscales de prueba documentados por Facturapi (ambiente Test).
  const datosFiscales = { rfc: 'ABC101010111', nombre: 'Dunder Mifflin', regimen: '601', cp: '85900', uso_cfdi: 'G01', email: 'factura-test@xabor.mx' };
  const v = validarDatosFiscales(datosFiscales);
  if (!v.ok) salir(`nuestro validador rechazó los datos de prueba: ${JSON.stringify(v.errores)}`);
  const pedido = await obtenerPedidoFacturable(negocio.id, folio);
  const preview = construirPayloadCFDI({ autofactura: { ...liga, negocioId: negocio.id }, pedido, datos: v.datos, config, intentoKey: 'preview' });
  RESUMEN.payload_previo = { payment_form: preview.payment_form, payment_method: preview.payment_method, currency: preview.currency, precio: preview.items[0].product.price, series: preview.series ?? null, tipo_persona: v.datos.tipo_persona };
  if (preview.payment_form !== '01' || preview.payment_method !== 'PUE' || preview.items[0].product.price !== 116) salir('el payload previo no cumple 01/PUE/116');

  // REQUEST REAL: una sola vez, por el motor completo.
  const r = await emitirAutofactura({ token: liga.token, datosFiscales, fuente: 'portal' });
  RESUMEN.resultado_motor = r;
  RESUMEN.proveedor = proveedor.ultimo;
  RESUMEN.posts = proveedor.posts;

  const fila = async () => (await pool.query('SELECT * FROM autofacturas WHERE id=$1', [liga.id])).rows[0];
  let f = await fila();
  const ledger = async () => (await pool.query('SELECT factura_id, uuid, fuente, total FROM facturas_pedido WHERE negocio_id=$1 AND folio=$2', [negocio.id, folio])).rows;
  const enClaro = async (valor) => (await pool.query(`SELECT count(*)::int AS n FROM autofacturas WHERE id=$1 AND autofacturas::text ILIKE '%' || $2 || '%'`, [liga.id, valor])).rows[0].n;

  if (r.estado === 'procesando' && f.estado === 'emitiendo') {
    RESUMEN.smoke = 'PENDING';
    RESUMEN.xabor = { estado: f.estado, factura_id: f.factura_id, uuid: f.uuid, proveedor_status: f.proveedor_status, intento_key: f.intento_key };
    if (f.factura_id) {
      const rc = await reconciliarAutofacturaPendiente(liga.id);
      RESUMEN.reconciliacion = rc; f = await fila();
      RESUMEN.xabor_tras_reconciliar = { estado: f.estado, factura_id: f.factura_id, uuid: f.uuid, proveedor_status: f.proveedor_status };
      if (f.estado === 'facturada') RESUMEN.smoke = 'PASS';
    }
  }
  if (f.estado === 'facturada') {
    RESUMEN.smoke = 'PASS';
    const led = await ledger();
    RESUMEN.xabor = { estado: f.estado, factura_id: f.factura_id, uuid: f.uuid, proveedor_status: f.proveedor_status, emitida_at: f.emitida_at, fuente_emision: f.fuente_emision, intento_key: f.intento_key, intento_numero: f.intento_numero, total: Number(f.total) };
    RESUMEN.ledger = led.length ? { renglones: led.length, factura_id: led[0].factura_id, uuid: led[0].uuid, fuente: led[0].fuente, total: Number(led[0].total) } : null;
    RESUMEN.snapshot = { cifrado: !!f.snapshot_cifrado, iv: !!f.snapshot_iv, auth_tag: !!f.snapshot_auth_tag, version: f.snapshot_formato_version, sha256_presente: !!f.snapshot_sha256 };
    RESUMEN.plaintext = { rfc: await enClaro('ABC101010111'), nombre: await enClaro('Dunder Mifflin'), email: await enClaro('factura-test@xabor.mx') };
    // Idempotencia local: segunda llamada, mismo token, 0 POST adicionales.
    const postsAntes = proveedor.posts;
    const r2 = await emitirAutofactura({ token: liga.token, datosFiscales, fuente: 'portal' });
    RESUMEN.segundo_intento = { estado: r2.estado, yaEmitida: r2.yaEmitida === true, posts_adicionales: proveedor.posts - postsAntes };
    RESUMEN.posts = proveedor.posts;
  } else if (r.estado !== 'procesando') {
    RESUMEN.smoke = 'FAIL';
    RESUMEN.xabor = { estado: f.estado, error_codigo: f.error_codigo, proveedor_status: f.proveedor_status, intento_key: f.intento_key, reintentable: r.reintentable ?? null };
  }
  salir(RESUMEN.smoke === 'FAIL' ? 'ver resultado_motor / proveedor' : 'ok');
} catch (e) {
  RESUMEN.smoke = 'FAIL';
  RESUMEN.excepcion = { codigo: e.codigo || null, status: e.status || null, mensaje: String(e.message || e).replace(/[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}/g, '[RFC]').slice(0, 200) };
  RESUMEN.posts = proveedor.posts;
  salir('excepción');
} finally {
  globalThis.fetch = fetchOriginal;
  await pool.end().catch(() => {});
}
