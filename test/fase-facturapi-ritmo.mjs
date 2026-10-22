// Ritmo de las llamadas a Facturapi (src/services/facturapiRitmo.js).
//
// Facturapi suspendió la cuenta por «un bucle redundante de múltiples GET por
// segundo»: la reconciliación consultaba cada 5 minutos, sin pausa, los 50
// recibos abiertos más viejos, aunque ya hubieran vencido, y repetía los
// mismos cuando la consulta fallaba. Esta suite fija lo contrario, con el
// barrido real contra un Facturapi falso que registra cada petición y su hora:
//   A. presupuesto por corrida y espacio mínimo entre llamadas;
//   B. vencidos y viejos no se consultan; un abierto, una vez al día;
//   C. un intento fallido espera su intervalo;
//   D. 401/403 → pausa larga, 429 → Retry-After; una respuesta buena la quita;
//   E. lo que hace una persona no tiene presupuesto ni espera;
//   F. un barrido dentro de otro comparte el presupuesto; al cobrar se respeta la pausa.
import assert from 'node:assert/strict';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL requerida');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname), 'solo base local');
assert.ok(process.env.INTEGRATIONS_ENCRYPTION_KEY, 'INTEGRATIONS_ENCRYPTION_KEY requerida');
process.env.FACTURAPI_BARRIDO_MAX_LLAMADAS = '6';
process.env.FACTURAPI_BARRIDO_ESPACIO_MS = '150';

const { pool } = await import('../src/services/database.js');
const { guardarCredencialesFacturapi } = await import('../src/services/integracionesService.js');
const { reconciliarRecibosFacturacion, sincronizarRecibo } = await import('../src/services/facturacionService.js');
const ritmo = await import('../src/services/facturapiRitmo.js');
const { obtenerRecibo } = await import('../src/services/facturapi.js');

let pasadas = 0; const fallos = [];
async function t(nombre, fn) {
  ritmo._reiniciarRitmoFacturapi();
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallos.push(`${nombre}: ${e.message}`); }
}

// Facturapi falso. `respuesta` decide qué contesta; por omisión, recibo abierto.
const llamadas = [];
let respuesta = () => null;
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://www.facturapi.io/')) return fetchOriginal(url, init);
  const ruta = u.replace('https://www.facturapi.io/v2', '');
  const id = ruta.split('/receipts/')[1]?.split(/[/?]/)[0] || 'rec_nuevo';
  llamadas.push({ ruta: `${init.method || 'GET'} ${ruta}`, id, en: Date.now() });
  const r = respuesta({ ruta, id }) || { status: 200, body: { id, status: 'open', total: 150, key: `clave-${id}`,
    self_invoice_url: `https://factura.space/prueba/${id}`, expires_at: '2026-12-30T00:00:00.000Z' } };
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'Content-Type': 'application/json', ...(r.headers || {}) } });
};

const { rows: [neg] } = await pool.query('SELECT id FROM negocios WHERE slug IS NOT NULL ORDER BY created_at LIMIT 1');
const NEG = neg.id;
const PREFIJO = 'XAB-RITMO';
const { rows: previas } = await pool.query(
  `SELECT id, estado, activo FROM integraciones_canal WHERE canal='facturacion' AND proveedor='facturapi'`);
const { rows: [previaNeg] } = await pool.query(
  `SELECT id FROM integraciones_canal WHERE canal='facturacion' AND proveedor='facturapi' AND negocio_id=$1`, [NEG]);
const { rows: [cfgPrevia] } = await pool.query('SELECT iva_tasa, autoemitir_recibo FROM facturacion_configuracion WHERE negocio_id=$1', [NEG]);
const { rows: [moduloPrevio] } = await pool.query(`SELECT estado FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [NEG]);
// autoemitir_recibo es columna de facturacion_configuracion (con IVA, para que el recibo llegue a Facturapi).
const autoemitirRecibo = (v) => pool.query(
  `INSERT INTO facturacion_configuracion (negocio_id, iva_tasa, autoemitir_recibo) VALUES ($1, 0.16, $2)
   ON CONFLICT (negocio_id) DO UPDATE SET autoemitir_recibo=$2, iva_tasa=COALESCE(facturacion_configuracion.iva_tasa, 0.16)`, [NEG, v]);

const limpiar = () => pool.query(`DELETE FROM facturacion_recibos WHERE folio LIKE $1`, [`${PREFIJO}%`]);
// Recibo de prueba: `creado` y `revisado` en horas hacia atrás; `vence` en horas hacia adelante (negativo = vencido).
async function recibo(sufijo, { estado = 'abierto', creado = 2, revisado = 2, vence = 24 * 20, conRecibo = true } = {}) {
  const folio = `${PREFIJO}-${sufijo}`;
  await pool.query(
    `INSERT INTO facturacion_recibos (negocio_id, folio, recibo_id, estado, total, idempotency_key, expires_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,150,$5, NOW() + $6 * INTERVAL '1 hour', NOW() - $7 * INTERVAL '1 hour', NOW() - $8 * INTERVAL '1 hour')`,
    [NEG, folio, conRecibo ? `rec_${sufijo}` : null, estado, `${NEG}:${folio}`, vence, creado, revisado]);
  return `rec_${sufijo}`;
}
async function barrer() {
  const antes = llamadas.length;
  const r = await reconciliarRecibosFacturacion(200);
  return { hechas: llamadas.slice(antes), r };
}
const nuestras = (hechas) => hechas.filter((l) => l.id.startsWith('rec_') && !l.id.startsWith('rec_nuevo'));

try {
  await limpiar();
  // Solo el negocio de prueba con Facturapi activo; el barrido de ligas apagado.
  await pool.query(`UPDATE integraciones_canal SET estado='suspendido', activo=false
                     WHERE canal='facturacion' AND proveedor='facturapi' AND negocio_id<>$1`, [NEG]);
  await autoemitirRecibo(false);
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'facturacion','activo')
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [NEG]);
  await guardarCredencialesFacturapi(NEG, 'sk_test_ritmo_000000000000', null);

  await t('A1. un barrido no pasa de su presupuesto aunque haya más recibos pendientes', async () => {
    await limpiar();
    for (let i = 0; i < 10; i++) await recibo(`A${i}`, { revisado: 30 });
    const { hechas } = await barrer();
    // Cada recibo se reserva 2 llamadas (recibo y, si ya está facturado, la factura): con 6 caben 5.
    assert.ok(hechas.length >= 5 && hechas.length <= 6, `hizo ${hechas.length} llamadas con presupuesto de 6`);
  });

  await t('A2. entre una llamada y la siguiente del barrido hay al menos el espacio configurado', async () => {
    const ultimas = llamadas.slice(-6);
    const huecos = ultimas.slice(1).map((l, i) => l.en - ultimas[i].en);
    assert.ok(huecos.every((h) => h >= 140), `huecos de ${huecos.join(', ')} ms`);
  });

  await t('A3. el barrido siguiente sigue con los que faltaban, no repite los ya consultados', async () => {
    const consultados = new Set(nuestras(llamadas.slice(-6)).map((l) => l.id));
    const { hechas } = await barrer();
    const ahora = nuestras(hechas).map((l) => l.id);
    assert.ok(ahora.length >= 4, `solo consultó ${ahora.length}`);
    assert.ok(ahora.every((id) => !consultados.has(id)), `repitió: ${ahora.filter((id) => consultados.has(id)).join(', ')}`);
  });

  await t('A4. un recibo no empieza si no quedan las 2 llamadas que puede necesitar', async () => {
    await limpiar();
    for (let i = 0; i < 5; i++) await recibo(`R${i}`, { revisado: 30 });
    const antes = llamadas.length;
    // Presupuesto de 3: dos recibos abiertos gastan 1 cada uno y queda 1, que ya no alcanza.
    await ritmo.enBarridoFacturapi(() => reconciliarRecibosFacturacion(200), { llamadas: 3, espacioMs: 0 });
    assert.equal(llamadas.length - antes, 2);
  });

  await t('B1. no consulta recibos vencidos (más de un día) ni de más de 45 días', async () => {
    await limpiar();
    await recibo('VENCIDO', { vence: -48, revisado: 30 });
    await recibo('VIEJO', { creado: 24 * 50, vence: 24 * 30, revisado: 30 });
    await recibo('VIGENTE', { revisado: 30 });
    const ids = nuestras((await barrer()).hechas).map((l) => l.id);
    assert.deepEqual(ids, ['rec_VIGENTE']);
  });

  await t('B2. un recibo abierto revisado hace menos de 24 h no se vuelve a consultar', async () => {
    await limpiar();
    await recibo('RECIENTE', { revisado: 20 });
    await recibo('AYER', { revisado: 25 });
    const ids = nuestras((await barrer()).hechas).map((l) => l.id);
    assert.deepEqual(ids, ['rec_AYER']);
  });

  await t('C1. una consulta fallida no se repite en el barrido siguiente', async () => {
    await limpiar();
    await recibo('FALLA', { revisado: 30 });
    respuesta = ({ id }) => (id === 'rec_FALLA' ? { status: 500, body: { message: 'caído' } } : null);
    const primero = nuestras((await barrer()).hechas).map((l) => l.id);
    const segundo = nuestras((await barrer()).hechas).map((l) => l.id);
    respuesta = () => null;
    assert.deepEqual(primero, ['rec_FALLA']);
    assert.deepEqual(segundo, [], 'volvió a pedir el recibo que acababa de fallar');
  });

  await t('C2. un recibo en error de una venta reciente se reintenta a los 30 minutos, no antes', async () => {
    await limpiar();
    await recibo('ERRTEMPRANO', { estado: 'error', creado: 3, revisado: 0.2 });
    await recibo('ERRLISTO', { estado: 'error', creado: 3, revisado: 0.6 });
    const ids = nuestras((await barrer()).hechas).map((l) => l.id);
    assert.deepEqual(ids, ['rec_ERRLISTO']);
  });

  await t('D1. un 401 de cuenta suspendida detiene el barrido y los siguientes no llaman', async () => {
    await limpiar();
    for (let i = 0; i < 4; i++) await recibo(`S${i}`, { revisado: 30 });
    respuesta = () => ({ status: 401, body: { message: 'El usuario está suspendido. Contacta a soporte', code: 'user_suspended' } });
    const primero = (await barrer()).hechas;
    await pool.query(`UPDATE facturacion_recibos SET updated_at = NOW() - INTERVAL '30 hours' WHERE folio LIKE $1`, [`${PREFIJO}%`]);
    const segundo = (await barrer()).hechas;
    respuesta = () => null;
    assert.equal(primero.length, 1, `con la cuenta suspendida hizo ${primero.length} llamadas`);
    assert.equal(segundo.length, 0, `en pausa todavía hizo ${segundo.length} llamadas`);
    assert.ok(ritmo.pausaFacturapi(NEG)?.hasta > Date.now() + 5 * 60 * 60 * 1000, 'la pausa debía durar horas');
  });

  await t('D2. un 429 pausa lo que pide Retry-After', async () => {
    await limpiar();
    await recibo('LENTO', { revisado: 30 });
    respuesta = () => ({ status: 429, body: { message: 'Too many requests' }, headers: { 'Retry-After': '120' } });
    await barrer();
    respuesta = () => null;
    const p = ritmo.pausaFacturapi(NEG);
    assert.ok(p, 'no pausó');
    const resta = p.hasta - Date.now();
    assert.ok(resta > 100_000 && resta <= 120_000, `pausa de ${Math.round(resta / 1000)} s`);
  });

  await t('D3. una respuesta correcta (por ejemplo, alguien factura desde el panel) quita la pausa', async () => {
    ritmo.registrarRespuestaFacturapi(NEG, 401, { codigo: 'user_suspended' });
    assert.ok(ritmo.pausaFacturapi(NEG));
    await limpiar();
    const id = await recibo('MANUAL', { revisado: 30 });
    await sincronizarRecibo(NEG, `${PREFIJO}-MANUAL`);
    assert.equal(ritmo.pausaFacturapi(NEG), null, 'la pausa siguió tras una respuesta 200');
    assert.ok(llamadas.at(-1).id === id);
  });

  await t('E. fuera de un barrido no hay presupuesto ni espera', async () => {
    const antes = llamadas.length, inicio = Date.now();
    for (let i = 0; i < 12; i++) await obtenerRecibo(NEG, `rec_MANO${i}`);
    assert.equal(llamadas.length - antes, 12);
    assert.ok(Date.now() - inicio < 1500, `tardó ${Date.now() - inicio} ms: aplicó espera fuera de barrido`);
  });

  await t('F1. un barrido dentro de otro comparte el presupuesto del de afuera', async () => {
    const antes = llamadas.length;
    const error = await ritmo.enBarridoFacturapi(async () => {
      try {
        await ritmo.enBarridoFacturapi(async () => { for (let i = 0; i < 3; i++) await obtenerRecibo(NEG, `rec_ANIDADO${i}`); }, { llamadas: 50 });
        return null;
      } catch (e) { return e; }
    }, { llamadas: 2, espacioMs: 0 });
    assert.equal(llamadas.length - antes, 2);
    assert.equal(error?.codigo, 'FACTURAPI_RITMO');
  });

  await t('F2. al cobrar, con Facturapi en pausa no sale la llamada y el recibo queda para reintentar', async () => {
    const { asegurarLigaYReciboVenta } = await import('../src/services/ligasFacturaVenta.js');
    await autoemitirRecibo(true);
    const folio = `${PREFIJO}-COBRO`;
    await pool.query(`DELETE FROM pedidos_activos WHERE folio=$1`, [folio]);
    await pool.query(`INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, entregado_at) VALUES ($1,$2,'entregado',$3::jsonb, NOW())`,
      [NEG, folio, JSON.stringify({ total: 150, forma_pago: 'efectivo', pago_confirmado: true, modalidad: 'recoger en tienda',
        cliente: { nombre: 'Cliente ritmo', telefono: '5218780000777' }, items: [{ nombre: 'Combo', cantidad: 1, precio_unitario: 150 }] })]);
    try {
      ritmo.registrarRespuestaFacturapi(NEG, 401, { codigo: 'user_suspended' });
      const antes = llamadas.length;
      await asegurarLigaYReciboVenta(NEG, folio, 'venta');
      assert.equal(llamadas.length - antes, 0, 'salió la llamada a Facturapi con la cuenta en pausa');
      const { rows: [fila] } = await pool.query(`SELECT estado, error_codigo FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2`, [NEG, folio]);
      assert.equal(fila?.estado, 'error');
      assert.equal(fila?.error_codigo, 'FACTURAPI_EN_PAUSA');
    } finally {
      await autoemitirRecibo(false);
      await pool.query(`DELETE FROM facturacion_recibos WHERE folio=$1`, [folio]).catch(() => {});
      await pool.query(`DELETE FROM autofacturas WHERE folio=$1`, [folio]).catch(() => {});
      await pool.query(`DELETE FROM pedidos_activos WHERE folio=$1`, [folio]);
    }
  });
  await t('F3. con Facturapi en pausa el barrido de ligas prepara la liga de Xabor sin llamar a Facturapi', async () => {
    const { barrerVentasSinLiga, _olvidarEsperas } = await import('../src/services/ligasFacturaVenta.js');
    _olvidarEsperas();
    await autoemitirRecibo(true);
    const folio = `${PREFIJO}-LIGA`;
    await pool.query(`DELETE FROM pedidos_activos WHERE folio=$1`, [folio]);
    await pool.query(`INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, entregado_at, created_at)
      VALUES ($1,$2,'entregado',$3::jsonb, NOW(), NOW() - INTERVAL '10 minutes')`,
      [NEG, folio, JSON.stringify({ total: 150, forma_pago: 'efectivo', pago_confirmado: true, modalidad: 'recoger en tienda',
        cliente: { nombre: 'Cliente liga', telefono: '5218780000778' }, items: [{ nombre: 'Combo', cantidad: 1, precio_unitario: 150 }] })]);
    try {
      ritmo.registrarRespuestaFacturapi(NEG, 403, { codigo: 'user_suspended' });
      const antes = llamadas.length;
      await ritmo.enBarridoFacturapi(() => barrerVentasSinLiga(400));
      assert.equal(llamadas.length - antes, 0, 'llamó a Facturapi con la cuenta en pausa');
      const { rows: [liga] } = await pool.query(`SELECT 1 FROM autofacturas WHERE negocio_id=$1 AND folio=$2`, [NEG, folio]);
      assert.ok(liga, 'no preparó la liga de Xabor');
    } finally {
      await autoemitirRecibo(false);
      await pool.query(`DELETE FROM autofacturas WHERE folio=$1`, [folio]).catch(() => {});
      await pool.query(`DELETE FROM facturacion_recibos WHERE folio=$1`, [folio]).catch(() => {});
      await pool.query(`DELETE FROM pedidos_activos WHERE folio=$1`, [folio]);
    }
  });
} finally {
  globalThis.fetch = fetchOriginal;
  await limpiar().catch(() => {});
  for (const p of previas) {
    await pool.query(`UPDATE integraciones_canal SET estado=$2, activo=$3 WHERE id=$1`, [p.id, p.estado, p.activo]).catch(() => {});
  }
  if (!previaNeg) {
    await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN
      (SELECT id FROM integraciones_canal WHERE negocio_id=$1 AND canal='facturacion' AND proveedor='facturapi')`, [NEG]).catch(() => {});
    await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal='facturacion' AND proveedor='facturapi'`, [NEG]).catch(() => {});
  }
  if (cfgPrevia) await pool.query('UPDATE facturacion_configuracion SET iva_tasa=$2, autoemitir_recibo=$3 WHERE negocio_id=$1', [NEG, cfgPrevia.iva_tasa, cfgPrevia.autoemitir_recibo]).catch(() => {});
  else await pool.query('DELETE FROM facturacion_configuracion WHERE negocio_id=$1', [NEG]).catch(() => {});
  if (moduloPrevio) await pool.query(`UPDATE negocio_modulos SET estado=$2 WHERE negocio_id=$1 AND modulo='facturacion'`, [NEG, moduloPrevio.estado]).catch(() => {});
  else await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [NEG]).catch(() => {});
  await pool.end().catch(() => {});
}
console.log(`\nPASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
