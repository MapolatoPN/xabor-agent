// Facturación, fase 2 (plan aprobado por Mario el 23-oct):
//   A. plazo por negocio: fin del mes de la venta (en la zona del negocio) o
//      N días; las ventas anteriores a la global de Xabor son del contador;
//   B. estado real de cada venta en lugar del «Pendiente» genérico;
//   C. bloqueos: fuera de plazo o en una global no se factura por separado,
//      ni desde el panel ni desde el portal, y sin llamar a Facturapi; lo ya
//      facturado sigue devolviendo su CFDI;
//   D. configuración del plazo;
//   E. panel y portal muestran los estados y los mensajes.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL requerida');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname), 'solo base local');
assert.ok(process.env.INTEGRATIONS_ENCRYPTION_KEY, 'INTEGRATIONS_ENCRYPTION_KEY requerida');
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const leer = (r) => readFileSync(join(RAIZ, r), 'utf8');

const express = (await import('express')).default;
const { pool } = await import('../src/services/database.js');
const { guardarCredencialesFacturapi } = await import('../src/services/integracionesService.js');
const fs = await import('../src/services/facturacionService.js');
const plazoMod = await import('../src/services/plazoFacturacion.js');
const { crearOObtenerAutofactura } = await import('../src/services/autofacturaService.js');
const rutas = await import('../src/services/autofacturaRutas.js');

let pasadas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallos.push(`${nombre}: ${e.message}`); }
}

// Facturapi falso: ningún bloqueo debe llegar hasta aquí.
const llamadas = [];
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://www.facturapi.io/')) return fetchOriginal(url, init);
  llamadas.push(`${init.method || 'GET'} ${u.replace('https://www.facturapi.io/v2', '')}`);
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const { rows: [neg] } = await pool.query('SELECT id, slug FROM negocios WHERE slug IS NOT NULL ORDER BY created_at LIMIT 1');
const NEG = neg.id;
const PREFIJO = 'XAB-F2';
const { rows: [cfgPrevia] } = await pool.query(
  `SELECT *, to_char(global_desde, 'YYYY-MM-DD') AS global_desde_txt FROM facturacion_configuracion WHERE negocio_id=$1`, [NEG]);
const { rows: [moduloPrevio] } = await pool.query(`SELECT estado FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [NEG]);
const { rows: integPrevias } = await pool.query(`SELECT id, estado, activo FROM integraciones_canal WHERE canal='facturacion' AND proveedor='facturapi'`);
const { rows: [previaNeg] } = await pool.query(`SELECT id FROM integraciones_canal WHERE canal='facturacion' AND proveedor='facturapi' AND negocio_id=$1`, [NEG]);

async function limpiar() {
  await pool.query(`DELETE FROM autofacturas WHERE folio LIKE $1`, [`${PREFIJO}%`]);
  await pool.query(`DELETE FROM facturacion_recibos WHERE folio LIKE $1`, [`${PREFIJO}%`]);
  await pool.query(`DELETE FROM facturas_pedido WHERE folio LIKE $1`, [`${PREFIJO}%`]);
  await pool.query(`DELETE FROM pedidos_activos WHERE folio LIKE $1`, [`${PREFIJO}%`]);
}
// Venta pagada; `diasAtras` en días (40 = mes anterior, siempre fuera de plazo).
async function venta(sufijo, { diasAtras = 0, total = 245 } = {}) {
  const folio = `${PREFIJO}-${sufijo}`;
  await pool.query(
    `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, created_at)
     VALUES ($1,$2,'entregado',$3::jsonb, (NOW() AT TIME ZONE 'UTC') - $4 * INTERVAL '1 day')`,
    [NEG, folio, JSON.stringify({ total, forma_pago: 'efectivo', pago_confirmado: true, modalidad: 'recoger en tienda' }), diasAtras]);
  return folio;
}
const recibo = (folio, estado, facturaId = null) => pool.query(
  `INSERT INTO facturacion_recibos (negocio_id, folio, recibo_id, estado, total, idempotency_key, factura_id)
   VALUES ($1,$2,$3,$4,245,$5,$6)`, [NEG, folio, `rec_${folio}`, estado, `${NEG}:${folio}`, facturaId]);
const fila = async (folio) => (await fs.listarRecibosFacturacion(NEG, { busqueda: folio, limite: 100 })).recibos.find((r) => r.folio === folio);
const ponerConfig = (campos) => pool.query(
  `UPDATE facturacion_configuracion SET plazo_tipo=$2, plazo_dias=$3, global_desde=$4::date WHERE negocio_id=$1`,
  [NEG, campos.tipo || 'fin_de_mes', campos.dias ?? null, campos.globalDesde || '2026-11-01']);
const DATOS = { rfc: 'EKU9003173C9', nombre_fiscal: 'ESCUELA KEMPER URGATE', regimen: '601', uso_cfdi: 'G03', cp: '26080' };

try {
  await limpiar();
  await pool.query(`INSERT INTO facturacion_configuracion (negocio_id, iva_tasa, autoemitir_recibo) VALUES ($1, 0.08, false)
                    ON CONFLICT (negocio_id) DO UPDATE SET iva_tasa=0.08, autoemitir_recibo=false`, [NEG]);
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'facturacion','activo')
                    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [NEG]);
  await guardarCredencialesFacturapi(NEG, 'sk_test_fase2_00000000000', null);
  await ponerConfig({});

  // ── A. Plazo ─────────────────────────────────────────────────────────────
  await t('A1. el límite de fin de mes respeta la zona del negocio en el borde del mes', async () => {
    const limite = plazoMod.sqlLimitePlazo('$1::timestamptz', { tz: "'America/Matamoros'", tipo: "'fin_de_mes'", dias: 'NULL' });
    const ultimo = async (iso) => (await pool.query(`SELECT to_char(${limite} - interval '1 microsecond', 'YYYY-MM-DD') AS d`, [iso])).rows[0].d;
    // 23:30 del 31-oct en Matamoros (UTC-5) ya es 1-nov en UTC: sigue siendo de octubre.
    assert.equal(await ultimo('2026-11-01T04:30:00Z'), '2026-10-31');
    assert.equal(await ultimo('2026-11-01T05:30:00Z'), '2026-11-30');
    assert.equal(await ultimo('2026-12-31T23:00:00Z'), '2026-12-31');
  });

  await t('A2. una venta de este mes está en plazo; una de hace 40 días, no', async () => {
    const hoy = await venta('A2HOY');
    const vieja = await venta('A2VIEJA', { diasAtras: 40 });
    assert.equal((await plazoMod.plazoDeVenta(NEG, hoy)).vencido, false);
    const p = await plazoMod.plazoDeVenta(NEG, vieja);
    assert.equal(p.vencido, true);
    assert.match(p.ultimoDia, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(await plazoMod.plazoDeVenta(NEG, `${PREFIJO}-NO-EXISTE`), null);
  });

  await t('A3. con plazo en días cuenta los días desde la venta', async () => {
    await ponerConfig({ tipo: 'dias', dias: 3 });
    try {
      const reciente = await venta('A3REC', { diasAtras: 1 });
      const pasada = await venta('A3PAS', { diasAtras: 5 });
      assert.equal((await plazoMod.plazoDeVenta(NEG, reciente)).vencido, false);
      assert.equal((await plazoMod.plazoDeVenta(NEG, pasada)).vencido, true);
    } finally { await ponerConfig({}); }
  });

  await t('A4. una venta anterior a la global de Xabor es del contador', async () => {
    const vieja = await venta('A4', { diasAtras: 40 });
    await ponerConfig({ globalDesde: '2099-01-01' });
    assert.equal((await plazoMod.plazoDeVenta(NEG, vieja)).antesDeGlobalXabor, true);
    await ponerConfig({ globalDesde: '2000-01-01' });
    assert.equal((await plazoMod.plazoDeVenta(NEG, vieja)).antesDeGlobalXabor, false);
    await ponerConfig({});
  });

  await t('A5. el mensaje dice la fecha en español', async () => {
    assert.equal(plazoMod.fechaLarga('2026-10-31'), '31 de octubre de 2026');
    assert.match(plazoMod.mensajePlazoVencido('2026-10-31'), /venció el 31 de octubre de 2026/);
  });

  // ── B. Estado real ───────────────────────────────────────────────────────
  await t('B1. estadoRealVenta cubre cada caso, en orden de precedencia', async () => {
    const e = fs.estadoRealVenta;
    assert.equal(e({ estado: 'facturado', plazo_vencido: true }), 'timbrada');
    assert.equal(e({ estado: 'cancelado' }), 'cancelada');
    assert.equal(e({ estado: 'global' }), 'en_global');
    assert.equal(e({ estado: 'error', plazo_vencido: true }), 'requiere_atencion');
    assert.equal(e({ estado: 'abierto', autofactura_estado: 'emitiendo', plazo_vencido: true }), 'solicitada');
    assert.equal(e({ estado: 'abierto', autofactura_estado: 'vigente', autofactura_intentada: true }), 'solicitada');
    assert.equal(e({ estado: 'abierto', autofactura_estado: 'vigente' }), 'sin_facturar');
    assert.equal(e({ estado: 'abierto', plazo_vencido: true, antes_global_xabor: false }), 'fuera_de_plazo');
    assert.equal(e({ estado: 'abierto', plazo_vencido: true, antes_global_xabor: true }), 'global_contador');
    assert.equal(e({ estado: 'creando' }), 'sin_facturar');
  });

  await t('B2. el listado trae estado_real calculado con el plazo y la global de Xabor', async () => {
    await ponerConfig({ globalDesde: '2000-01-01' });
    try {
      const nueva = await venta('B2NUEVA'); await recibo(nueva, 'abierto');
      const vieja = await venta('B2VIEJA', { diasAtras: 40 }); await recibo(vieja, 'abierto');
      const fallida = await venta('B2ERR'); await recibo(fallida, 'error');
      assert.equal((await fila(nueva)).estado_real, 'sin_facturar');
      const v = await fila(vieja);
      assert.equal(v.estado_real, 'fuera_de_plazo');
      assert.match(v.plazo_ultimo_dia, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal((await fila(fallida)).estado_real, 'requiere_atencion');
      await ponerConfig({ globalDesde: '2099-01-01' });
      assert.equal((await fila(vieja)).estado_real, 'global_contador');
    } finally { await ponerConfig({}); }
  });

  await t('B3. una venta con su liga emitiendo sale como solicitada', async () => {
    const f = await venta('B3'); await recibo(f, 'abierto');
    await crearOObtenerAutofactura(NEG, f);
    await pool.query(`UPDATE autofacturas SET estado='emitiendo' WHERE negocio_id=$1 AND folio=$2`, [NEG, f]);
    assert.equal((await fila(f)).estado_real, 'solicitada');
  });

  // ── C. Bloqueos ──────────────────────────────────────────────────────────
  await t('C1. el panel no factura una venta fuera de plazo, y no llama a Facturapi', async () => {
    const f = await venta('C1', { diasAtras: 40 });
    const n = llamadas.length;
    const e = await fs.emitirFacturaPedido(NEG, f, DATOS).catch((x) => x);
    assert.equal(e?.codigo, 'FUERA_DE_PLAZO');
    assert.equal(e?.status, 409);
    assert.match(e.message, /venció el \d{1,2} de [a-z]+ de \d{4}/);
    assert.deepEqual(llamadas.slice(n), []);
  });

  await t('C2. el panel no factura una venta que ya va en una global', async () => {
    const f = await venta('C2'); await recibo(f, 'global');
    const n = llamadas.length;
    const e = await fs.emitirFacturaPedido(NEG, f, DATOS).catch((x) => x);
    assert.equal(e?.codigo, 'VENTA_EN_FACTURA_GLOBAL');
    assert.deepEqual(llamadas.slice(n), []);
  });

  await t('C3. una venta ya facturada fuera de plazo sigue devolviendo su CFDI', async () => {
    const f = await venta('C3', { diasAtras: 40 }); await recibo(f, 'facturado', 'fact_f2_c3');
    const r = await fs.emitirFacturaPedido(NEG, f, DATOS);
    assert.equal(r.yaEmitida, true);
    assert.equal(r.factura_id, 'fact_f2_c3');
  });

  let tokenVieja = null, tokenNueva = null;
  await t('C4. el portal avisa «fuera de plazo» antes de que el cliente capture datos; en plazo, no', async () => {
    const vieja = await venta('C4VIEJA', { diasAtras: 40 });
    const nueva = await venta('C4NUEVA');
    // La liga vieja se creó cuando la venta estaba en plazo.
    tokenVieja = (await crearOObtenerAutofactura(NEG, vieja)).token;
    tokenNueva = (await crearOObtenerAutofactura(NEG, nueva)).token;
    const r = await rutas.consultarAutofacturaPublica(tokenVieja);
    assert.equal(r.status, 200);
    assert.equal(r.body.estado, 'fuera_de_plazo');
    assert.match(r.body.error, /venció el/);
    assert.match(r.body.plazo_vencio, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal((await rutas.consultarAutofacturaPublica(tokenNueva)).body.estado, 'vigente');
  });

  await t('C5. validar y emitir en el portal rechazan la venta fuera de plazo sin llamar a Facturapi', async () => {
    const datos = { rfc: DATOS.rfc, razon_social: DATOS.nombre_fiscal, regimen_fiscal: '601', uso_cfdi: 'G03', cp_fiscal: '26080', email: 'cliente@ejemplo.mx' };
    const n = llamadas.length;
    const v = await rutas.validarAutofacturaPublica(tokenVieja, datos);
    assert.equal(v.status, 409); assert.equal(v.body.codigo, 'FUERA_DE_PLAZO');
    const e = await rutas.emitirAutofacturaPublica(tokenVieja, datos);
    assert.equal(e.status, 409); assert.equal(e.body.codigo, 'FUERA_DE_PLAZO'); assert.equal(e.body.estado, 'fuera_de_plazo');
    assert.deepEqual(llamadas.slice(n), []);
  });

  await t('C6. el portal por folio no entrega liga de una venta fuera de plazo', async () => {
    const vieja = await venta('C6', { diasAtras: 40, total: 312.5 });
    const app = express();
    rutas.registrarRutasAutofactura(app);
    const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    try {
      const resp = await fetchOriginal(`http://127.0.0.1:${s.address().port}/api/autofactura/portal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: neg.slug, folio: vieja, total: '312.50' }) });
      const d = await resp.json();
      assert.equal(resp.status, 409, JSON.stringify(d));
      assert.equal(d.codigo, 'FUERA_DE_PLAZO');
      assert.equal((await pool.query('SELECT count(*)::int n FROM autofacturas WHERE folio=$1', [vieja])).rows[0].n, 0, 'creó la liga');
    } finally { s.close(); }
  });

  // ── D. Configuración ─────────────────────────────────────────────────────
  await t('D1. el plazo se guarda, se valida y, si no se manda, se conserva', async () => {
    const c = await fs.guardarConfiguracionFacturacion(NEG, { ivaTasa: 0.08, autoemitirRecibo: false, plazoTipo: 'dias', plazoDias: 10 });
    assert.equal(c.plazo_tipo, 'dias'); assert.equal(c.plazo_dias, 10);
    const sin = await fs.guardarConfiguracionFacturacion(NEG, { ivaTasa: 0.08, autoemitirRecibo: false });
    assert.equal(sin.plazo_tipo, 'dias', 'sin plazo en la petición se perdió el que había');
    for (const malo of [0, 400, 'x']) {
      const e = await fs.guardarConfiguracionFacturacion(NEG, { ivaTasa: 0.08, plazoTipo: 'dias', plazoDias: malo }).catch((x) => x);
      assert.equal(e?.codigo, 'PLAZO_INVALIDO', `aceptó ${malo} días`);
    }
    const f = await fs.guardarConfiguracionFacturacion(NEG, { ivaTasa: 0.08, autoemitirRecibo: false, plazoTipo: 'fin_de_mes' });
    assert.equal(f.plazo_tipo, 'fin_de_mes'); assert.equal(f.plazo_dias, null);
    assert.equal((await fs.obtenerConfiguracionFacturacion(NEG)).global_desde, '2026-11-01');
    // Lo que recibe cada negocio al migrar y cada alta nueva: el valor por omisión.
    const { rows: [d] } = await pool.query(`SELECT pg_get_expr(ad.adbin, ad.adrelid) AS def
      FROM pg_attrdef ad JOIN pg_attribute a ON a.attrelid=ad.adrelid AND a.attnum=ad.adnum
      WHERE ad.adrelid='facturacion_configuracion'::regclass AND a.attname='global_desde'`);
    assert.match(d?.def || '', /'2026-11-01'::date/, `global_desde por omisión: ${d?.def}`);
  });

  // ── E. Panel y portal ────────────────────────────────────────────────────
  await t('E1. el panel cuenta cada estado real y deja fuera la global del contador', async () => {
    const panel = leer('panel/index.html');
    const codigo = panel.slice(panel.indexOf('async function cargarPaginasFacturacion'), panel.indexOf('function facturacionFiltrarEstado'));
    const el = new Map();
    const get = (id) => { if (!el.has(id)) el.set(id, { value: '', innerHTML: '', textContent: '' }); return el.get(id); };
    const base = { total: 100, created_at: '2026-10-02T15:00:00Z' };
    const recibos = [
      { ...base, folio: 'XAB-1', estado: 'abierto', estado_real: 'sin_facturar' },
      { ...base, folio: 'XAB-2', estado: 'abierto', estado_real: 'fuera_de_plazo', plazo_ultimo_dia: '2026-09-30' },
      { ...base, folio: 'XAB-3', estado: 'abierto', estado_real: 'global_contador' },
      { ...base, folio: 'XAB-4', estado: 'facturado', estado_real: 'timbrada', factura_id: 'f4' },
      { ...base, folio: 'XAB-5', estado: 'error', estado_real: 'requiere_atencion' },
    ];
    const ctx = vm.createContext({ document: { getElementById: get }, PUEDE_FACTURAR: true, esc: String,
      estadoServicioUI: () => ['Timbrada', '', ''], estadoReciboUI: () => ['X', '', ''], esReciboPruebaUI: () => false,
      apiFetch: async (ruta) => ({ ok: true, json: async () => (ruta.includes('/recibos') ? { recibos, paginacion: { total: recibos.length } } : { servicios: [], paginacion: { total: 0 } }) }) });
    vm.runInContext(codigo, ctx);
    await vm.runInContext('cargarCentroFacturacion()', ctx);
    assert.equal(get('facturacion-kpi-sin-facturar').textContent, '1');
    assert.equal(get('facturacion-kpi-fuera-plazo').textContent, '1');
    assert.equal(get('facturacion-kpi-facturadas').textContent, '1');
    assert.equal(get('facturacion-kpi-atencion').textContent, '1');
    const html = get('facturacion-recibos-lista').innerHTML;
    assert.match(html, /Fuera de plazo \(venció el 30\/09\/2026\)/);
    assert.match(html, /Global del contador/);
    // XAB-2 (fuera de plazo) no ofrece «Facturar ahora»; XAB-1 sí.
    const filaDe = (folio) => html.split('<tr').find((x) => x.includes(`<b>${folio}</b>`)) || '';
    assert.match(filaDe('XAB-1'), /Facturar ahora/);
    assert.doesNotMatch(filaDe('XAB-2'), /Facturar ahora|Copiar enlace/);
    get('facturacion-recibos-estado').value = 'fuera_de_plazo';
    await vm.runInContext('cargarCentroFacturacion()', ctx);
    assert.match(get('facturacion-recibos-lista').innerHTML, /XAB-2/);
    assert.doesNotMatch(get('facturacion-recibos-lista').innerHTML, /XAB-1</);
  });

  await t('E2. el portal muestra el mensaje del servidor para fuera de plazo', async () => {
    const af = leer('panel/autofactura.html');
    assert.match(af, /fuera_de_plazo: \['expirada',/);
    assert.match(af, /const texto = d\.estado === 'fuera_de_plazo' && d\.error \? d\.error : textoBase;/);
    const panel = leer('panel/index.html');
    assert.match(panel, /id="fc-plazo-tipo"/);
    assert.match(panel, /plazo_tipo: plazoTipo, plazo_dias:/);
  });
} finally {
  globalThis.fetch = fetchOriginal;
  await limpiar().catch((e) => console.log('limpieza:', e.message));
  if (cfgPrevia) {
    await pool.query(`UPDATE facturacion_configuracion SET iva_tasa=$2, autoemitir_recibo=$3, plazo_tipo=$4, plazo_dias=$5, global_desde=$6 WHERE negocio_id=$1`,
      [NEG, cfgPrevia.iva_tasa, cfgPrevia.autoemitir_recibo, cfgPrevia.plazo_tipo || 'fin_de_mes', cfgPrevia.plazo_dias ?? null, cfgPrevia.global_desde_txt || '2026-11-01']).catch(() => {});
  } else await pool.query('DELETE FROM facturacion_configuracion WHERE negocio_id=$1', [NEG]).catch(() => {});
  if (moduloPrevio) await pool.query(`UPDATE negocio_modulos SET estado=$2 WHERE negocio_id=$1 AND modulo='facturacion'`, [NEG, moduloPrevio.estado]).catch(() => {});
  else await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [NEG]).catch(() => {});
  for (const p of integPrevias) await pool.query(`UPDATE integraciones_canal SET estado=$2, activo=$3 WHERE id=$1`, [p.id, p.estado, p.activo]).catch(() => {});
  if (!previaNeg) {
    await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN
      (SELECT id FROM integraciones_canal WHERE negocio_id=$1 AND canal='facturacion' AND proveedor='facturapi')`, [NEG]).catch(() => {});
    await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal='facturacion' AND proveedor='facturapi'`, [NEG]).catch(() => {});
  }
  await pool.end().catch(() => {});
}
console.log(`\nPASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
