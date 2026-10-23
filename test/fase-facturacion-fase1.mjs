// Facturación, fase 1 (plan aprobado por Mario el 23-oct):
//   A. la columna Fecha es la de la venta (venta_at), no la del registro del
//      recibo, y el día se cuenta en hora de Matamoros;
//   B. un CFDI se descarga o se reenvía solo si es de ESTE negocio;
//   C. reenviar por correo valida el correo y deja bitácora sin el correo;
//   D. editar una ficha fiscal por id corrige la misma ficha, también el RFC;
//   E. cancelar el CFDI de una venta la saca de «Timbradas» (ledger y recibo),
//      también para las cancelaciones anteriores a la migración 122;
//   F. timbrar es solo del admin, también desde Mesas; la bitácora queda;
//   G. textos y acciones del panel.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL requerida');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname), 'solo base local');
assert.ok(process.env.INTEGRATIONS_ENCRYPTION_KEY, 'INTEGRATIONS_ENCRYPTION_KEY requerida');
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const leer = (r) => readFileSync(join(RAIZ, r), 'utf8');

const { pool, actualizarClienteFiscal, guardarClienteFiscal } = await import('../src/services/database.js');
const { guardarCredencialesFacturapi } = await import('../src/services/integracionesService.js');
const { listarRecibosFacturacion } = await import('../src/services/facturacionService.js');
const docs = await import('../src/services/facturacionDocumentos.js');
const { solicitarCancelacionCfdi } = await import('../src/services/cancelacionCfdi.js');

let pasadas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallos.push(`${nombre}: ${e.message}`); }
}

// Facturapi falso: registra cada llamada.
const llamadas = [];
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://www.facturapi.io/')) return fetchOriginal(url, init);
  const ruta = u.replace('https://www.facturapi.io/v2', '');
  const metodo = init.method || 'GET';
  llamadas.push({ ruta: `${metodo} ${ruta}`, body: init.body });
  if (/\/(pdf|xml)$/.test(ruta)) return new Response(Buffer.from(`archivo ${ruta}`), { status: 200 });
  if (metodo === 'DELETE' && ruta.startsWith('/invoices/')) {
    return new Response(JSON.stringify({ id: ruta.split('/')[2].split('?')[0], status: 'canceled', cancellation_status: 'accepted' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const desde = (n) => llamadas.slice(n).map((l) => l.ruta);

const { rows: negs } = await pool.query('SELECT id FROM negocios WHERE slug IS NOT NULL ORDER BY created_at LIMIT 2');
const A = negs[0].id, B = negs[1].id;
const PREFIJO = 'XAB-F1';
const { rows: integPrevias } = await pool.query(
  `SELECT id, negocio_id, estado, activo FROM integraciones_canal WHERE canal='facturacion' AND proveedor='facturapi'`);

async function limpiar() {
  await pool.query(`DELETE FROM facturacion_cancelaciones WHERE referencia LIKE $1 OR factura_id LIKE 'fact_f1_%'`, [`${PREFIJO}%`]);
  await pool.query(`DELETE FROM facturacion_recibos WHERE folio LIKE $1`, [`${PREFIJO}%`]);
  await pool.query(`DELETE FROM facturas_pedido WHERE folio LIKE $1`, [`${PREFIJO}%`]);
  await pool.query(`DELETE FROM pedidos_activos WHERE folio LIKE $1`, [`${PREFIJO}%`]);
  await pool.query(`DELETE FROM clientes_fiscales WHERE notas = 'fase1-prueba'`);
  await pool.query(`DELETE FROM facturacion_bitacora WHERE negocio_id = ANY($1) AND (folio LIKE $2 OR factura_id LIKE 'fact_f1_%' OR accion='prueba_f1')`, [[A, B], `${PREFIJO}%`]);
}
async function venta(sufijo, { negocio = A, horasAtras = 24 * 10 } = {}) {
  const folio = `${PREFIJO}-${sufijo}`;
  await pool.query(
    `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, created_at)
     VALUES ($1,$2,'entregado',$3::jsonb, (NOW() AT TIME ZONE 'UTC') - $4 * INTERVAL '1 hour')`,
    [negocio, folio, JSON.stringify({ total: 150, forma_pago: 'efectivo', pago_confirmado: true }), horasAtras]);
  return folio;
}
async function recibo(folio, { negocio = A, estado = 'abierto', facturaId = null } = {}) {
  await pool.query(
    `INSERT INTO facturacion_recibos (negocio_id, folio, recibo_id, estado, total, idempotency_key, factura_id)
     VALUES ($1,$2,$3,$4,150,$5,$6)`, [negocio, folio, `rec_${folio}`, estado, `${negocio}:${folio}`, facturaId]);
}
const ledger = (folio, facturaId, { negocio = A } = {}) => pool.query(
  `INSERT INTO facturas_pedido (negocio_id, folio, factura_id, uuid, total, fuente) VALUES ($1,$2,$3,$4,150,'panel')`,
  [negocio, folio, facturaId, `UUID-${facturaId}`]);
const fila = async (folio) => (await listarRecibosFacturacion(A, { busqueda: folio, limite: 100 })).recibos.find((r) => r.folio === folio);

try {
  await limpiar();
  await pool.query(`UPDATE integraciones_canal SET estado='suspendido', activo=false
                     WHERE canal='facturacion' AND proveedor='facturapi' AND negocio_id NOT IN ($1,$2)`, [A, B]);
  await guardarCredencialesFacturapi(A, 'sk_test_fase1_0000000000', null);
  await guardarCredencialesFacturapi(B, 'sk_test_fase1_0000000000', null);

  // ── A. Fechas ────────────────────────────────────────────────────────────
  await t('A1. el listado trae la fecha de la venta aunque el recibo se registre días después', async () => {
    const folio = await venta('A1', { horasAtras: 24 * 11 });
    await recibo(folio); // registrado hoy
    const r = await fila(folio);
    assert.ok(r, 'no está en el listado');
    const dias = (Date.now() - new Date(r.venta_at)) / 864e5;
    assert.ok(dias > 10.9 && dias < 11.1, `venta_at a ${dias.toFixed(2)} días`);
    assert.ok((Date.now() - new Date(r.created_at)) / 864e5 < 0.1, 'created_at debía ser el registro de hoy');
  });

  await t('A2. timbrada_at sale del ledger; un CFDI cancelado no cuenta', async () => {
    const folio = await venta('A2');
    await recibo(folio, { estado: 'facturado', facturaId: 'fact_f1_a2' });
    await ledger(folio, 'fact_f1_a2');
    assert.ok((await fila(folio)).timbrada_at, 'sin fecha de timbrado');
    await pool.query(`UPDATE facturas_pedido SET cancelada_at=now() WHERE factura_id='fact_f1_a2'`);
    assert.equal((await fila(folio)).timbrada_at, null);
  });

  await t('A3. el panel cuenta el día en hora de Matamoros y usa venta_at', async () => {
    const panel = leer('panel/index.html');
    const zona = panel.match(/const ZONA_FACTURACION = '[^']+';/)?.[0];
    const fn = panel.match(/function diaFacturacion\(v\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(zona && fn, 'no encontré diaFacturacion en el panel');
    const diaFacturacion = new Function(`${zona}\n${fn}\nreturn diaFacturacion;`)();
    assert.equal(diaFacturacion('2026-10-23T02:30:00Z'), '2026-10-22', 'una venta de las 9:30 p. m. local cayó en el día siguiente');
    assert.equal(diaFacturacion('2026-10-22T15:00:00Z'), '2026-10-22');
    assert.match(panel, /fecha: r\.venta_at \|\| r\.created_at/);
    assert.match(panel, /const dia = diaFacturacion;/);
  });

  // ── B. CFDI del negocio ──────────────────────────────────────────────────
  await t('B1. un negocio no descarga el PDF ni el XML de un CFDI de otro', async () => {
    const folio = await venta('B1');
    await ledger(folio, 'fact_f1_b1');
    const n = llamadas.length;
    for (const formato of ['pdf', 'xml']) {
      const e = await docs.descargarCfdiDelNegocio(B, 'fact_f1_b1', formato).catch((x) => x);
      assert.equal(e?.status, 404, `${formato}: debía rechazar el CFDI ajeno`);
    }
    assert.deepEqual(desde(n), [], 'llamó a Facturapi con un CFDI ajeno');
  });

  await t('B2. el dueño sí descarga PDF y XML de su CFDI', async () => {
    const n = llamadas.length;
    const pdf = await docs.descargarCfdiDelNegocio(A, 'fact_f1_b1', 'pdf');
    const xml = await docs.descargarCfdiDelNegocio(A, 'fact_f1_b1', 'xml');
    assert.deepEqual(desde(n), ['GET /invoices/fact_f1_b1/pdf', 'GET /invoices/fact_f1_b1/xml']);
    assert.ok(Buffer.from(pdf).length > 0 && Buffer.from(xml).length > 0);
  });

  await t('B3. también cuentan los CFDI de recibos, servicios y autofacturas; un id raro no consulta nada', async () => {
    const folio = await venta('B3');
    await recibo(folio, { estado: 'facturado', facturaId: 'fact_f1_b3' });
    assert.equal(await docs.cfdiDelNegocio(A, 'fact_f1_b3'), true);
    assert.equal(await docs.cfdiDelNegocio(B, 'fact_f1_b3'), false);
    assert.equal(await docs.cfdiDelNegocio(A, "x' OR 1=1 --"), false);
  });

  await t('B4. las rutas de PDF pasan por la comprobación (server.js ya no descarga directo)', async () => {
    const server = leer('src/server.js');
    assert.doesNotMatch(server, /descargarFacturaPDF\(req\.negocioId/);
    assert.match(server, /registrarRutasDocumentosFactura\(app,/);
  });

  // ── C. Reenvío por correo ────────────────────────────────────────────────
  await t('C1. reenviar valida el correo y el negocio antes de llamar a Facturapi', async () => {
    const n = llamadas.length;
    assert.equal((await docs.reenviarCfdiPorCorreo(A, 'fact_f1_b1', 'no-es-correo').catch((e) => e))?.codigo, 'EMAIL_INVALIDO');
    assert.equal((await docs.reenviarCfdiPorCorreo(B, 'fact_f1_b1', 'cliente@ejemplo.mx').catch((e) => e))?.status, 404);
    assert.deepEqual(desde(n), []);
  });

  await t('C2. reenviar manda el correo a Facturapi y deja bitácora sin el correo completo', async () => {
    const n = llamadas.length;
    await docs.reenviarCfdiPorCorreo(A, 'fact_f1_b1', 'Cliente@Ejemplo.mx', { usuarioId: 'u-1', rol: 'admin' });
    const hechas = llamadas.slice(n);
    assert.deepEqual(hechas.map((l) => l.ruta), ['POST /invoices/fact_f1_b1/email']);
    assert.equal(JSON.parse(hechas[0].body).email, 'cliente@ejemplo.mx');
    const { rows: [b] } = await pool.query(`SELECT * FROM facturacion_bitacora WHERE negocio_id=$1 AND factura_id='fact_f1_b1' AND accion='reenviar_correo'`, [A]);
    assert.ok(b, 'sin bitácora');
    assert.equal(b.usuario_id, 'u-1');
    assert.deepEqual(b.detalle, { dominio: 'ejemplo.mx' });
  });

  // ── D. Fichas fiscales ───────────────────────────────────────────────────
  await t('D1. editar por id cambia el RFC de la misma ficha, sin crear otra', async () => {
    const f = await guardarClienteFiscal({ negocioId: A, rfc: 'XEXA010101AB1', razonSocial: 'Prueba Fase Uno', regimen: '601', usoCfdi: 'G03', cp: '26080', email: 'a@b.mx', notas: 'fase1-prueba' });
    const antes = (await pool.query('SELECT count(*)::int n FROM clientes_fiscales WHERE negocio_id=$1', [A])).rows[0].n;
    const r = await actualizarClienteFiscal(A, f.id, { rfc: 'XEXA010101AB2', razonSocial: 'Prueba Fase Uno', regimen: '601', usoCfdi: 'G03', cp: '26080', email: '' });
    assert.equal(String(r.id), String(f.id));
    assert.equal(r.rfc, 'XEXA010101AB2');
    assert.equal(r.email, null, 'un correo borrado al editar debe quedar vacío');
    assert.equal((await pool.query('SELECT count(*)::int n FROM clientes_fiscales WHERE negocio_id=$1', [A])).rows[0].n, antes);
  });

  await t('D2. no se edita una ficha de otro negocio, ni a un RFC que ya existe, ni con datos inválidos', async () => {
    const f1 = await guardarClienteFiscal({ negocioId: A, rfc: 'XEXA010101AC1', razonSocial: 'Uno', regimen: '601', usoCfdi: 'G03', cp: '26080', notas: 'fase1-prueba' });
    const f2 = await guardarClienteFiscal({ negocioId: A, rfc: 'XEXA010101AC2', razonSocial: 'Dos', regimen: '601', usoCfdi: 'G03', cp: '26080', notas: 'fase1-prueba' });
    const datos = { razonSocial: 'X', regimen: '601', usoCfdi: 'G03', cp: '26080' };
    assert.equal(await actualizarClienteFiscal(B, f1.id, { ...datos, rfc: 'XEXA010101AC9' }), null, 'editó la ficha de otro negocio');
    assert.equal((await actualizarClienteFiscal(A, f1.id, { ...datos, rfc: f2.rfc }))?.error, 'RFC_DUPLICADO');
    assert.equal((await actualizarClienteFiscal(A, f1.id, { ...datos, rfc: 'MAL' }))?.error, 'RFC_INVALIDO');
    assert.equal(await actualizarClienteFiscal(A, 'abc', { ...datos, rfc: 'XEXA010101AC9' }), null);
  });

  // ── E. Cancelación de CFDI de venta ──────────────────────────────────────
  await t('E1. cancelar el CFDI de una venta lo marca en el ledger y el recibo deja de estar timbrado', async () => {
    const folio = await venta('E1');
    await recibo(folio, { estado: 'facturado', facturaId: 'fact_f1_e1' });
    await ledger(folio, 'fact_f1_e1');
    const antes = (await listarRecibosFacturacion(A, { limite: 100 })).resumen.facturadas;
    const r = await solicitarCancelacionCfdi(A, 'fact_f1_e1', { motivo: '02' });
    assert.equal(r.estado, 'cancelada');
    const { rows: [f] } = await pool.query(`SELECT cancelada_at FROM facturas_pedido WHERE factura_id='fact_f1_e1'`);
    assert.ok(f.cancelada_at, 'el ledger no quedó marcado');
    assert.equal((await fila(folio)).estado, 'cancelado');
    assert.equal((await listarRecibosFacturacion(A, { limite: 100 })).resumen.facturadas, antes - 1, 'siguió contando como timbrada');
  });

  await t('E2. una venta sin recibo con su CFDI cancelado sale como cancelada', async () => {
    const folio = await venta('E2');
    await ledger(folio, 'fact_f1_e2');
    await solicitarCancelacionCfdi(A, 'fact_f1_e2', { motivo: '03' });
    assert.equal((await fila(folio)).estado, 'cancelado');
  });

  await t('E3. la migración 122 rellena las cancelaciones de venta anteriores', async () => {
    const folio = await venta('E3');
    await recibo(folio, { estado: 'facturado', facturaId: 'fact_f1_e3' });
    await ledger(folio, 'fact_f1_e3');
    await pool.query(
      `INSERT INTO facturacion_cancelaciones (negocio_id, factura_id, uuid, origen, referencia, motivo, estado)
       VALUES ($1,'fact_f1_e3','UUID-fact_f1_e3','venta',$2,'02','cancelada')`, [A, folio]);
    await pool.query(leer('migrations/122_facturacion_bitacora_cancelada.sql'));
    const { rows: [f] } = await pool.query(`SELECT cancelada_at FROM facturas_pedido WHERE factura_id='fact_f1_e3'`);
    assert.ok(f.cancelada_at);
    assert.equal((await fila(folio)).estado, 'cancelado');
  });

  // ── F. Permisos y bitácora ───────────────────────────────────────────────
  await t('F1. timbrar una venta es solo del admin, también desde Mesas', async () => {
    const server = leer('src/server.js');
    assert.match(server, /app\.post\('\/api\/facturacion\/pedidos\/:folio\/emitir', requireAdminSeguro,/);
    const mesas = leer('panel/mesas.html');
    assert.match(mesas, /\$\('ce-emitir-factura'\)\.hidden = ROL !== 'admin';/);
    assert.match(mesas, /function abrirFacturaRestaurante\(\) \{\n  if \(ROL !== 'admin'\)/);
  });

  await t('F2. la bitácora se escribe en cada acción de facturación', async () => {
    const server = leer('src/server.js');
    for (const accion of ['timbrar_venta', 'timbrar_servicio', 'vincular_facturapi', 'desvincular_facturapi', 'configuracion', 'editar_cliente_fiscal', 'eliminar_cliente_fiscal']) {
      assert.match(server, new RegExp(`accion: '${accion}'`), `falta la bitácora de ${accion}`);
    }
    assert.match(leer('src/services/cancelacionCfdi.js'), /accion: 'solicitar_cancelacion'/);
    assert.match(leer('src/services/autofacturaEmision.js'), /accion: 'timbrar_autofactura'/);
    assert.equal(await docs.registrarBitacoraFacturacion({ negocioId: A, accion: 'prueba_f1', detalle: { x: 1 } }), true);
    assert.equal((await docs.listarBitacoraFacturacion(A)).some((b) => b.accion === 'prueba_f1'), true);
  });

  await t('F3. si la bitácora falla, la acción no falla', async () => {
    const r = await docs.registrarBitacoraFacturacion({ negocioId: 'no-es-uuid', accion: 'prueba_f1' });
    assert.equal(r, false);
  });

  // ── G. Panel ─────────────────────────────────────────────────────────────
  await t('G1. la casilla dice lo que hace: prepara la liga, no timbra', async () => {
    const panel = leer('panel/index.html');
    assert.doesNotMatch(panel, /Crear factura al cerrar\/cobrar/);
    assert.match(panel, /Preparar liga de autofactura al cobrar/);
    assert.match(panel, /No timbra facturas\./);
  });

  await t('G2. el menú de una factura timbrada trae XML y reenviar por correo; editar ficha usa PUT', async () => {
    const panel = leer('panel/index.html');
    assert.match(panel, /\/api\/admin\/factura\/\$\{encodeURIComponent\(doc\.factura_id\)\}\/xml/);
    assert.match(panel, /reenviarFacturaCorreoUI\(/);
    assert.match(panel, /method: editando == null \? 'POST' : 'PUT'/);
    assert.match(panel, /alert\(d\.error \|\| 'No se pudo eliminar la ficha\.'\)/);
  });
} finally {
  globalThis.fetch = fetchOriginal;
  await limpiar().catch((e) => console.log('limpieza:', e.message));
  for (const p of integPrevias) {
    await pool.query(`UPDATE integraciones_canal SET estado=$2, activo=$3 WHERE id=$1`, [p.id, p.estado, p.activo]).catch(() => {});
  }
  for (const n of [A, B]) {
    if (!integPrevias.some((p) => p.negocio_id === n)) {
      await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN
        (SELECT id FROM integraciones_canal WHERE negocio_id=$1 AND canal='facturacion' AND proveedor='facturapi')`, [n]).catch(() => {});
      await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal='facturacion' AND proveedor='facturapi'`, [n]).catch(() => {});
    }
  }
  await pool.end().catch(() => {});
}
console.log(`\nPASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
