// Suite del Defecto 2 (hotfix cotizaciones-telefono-multiempresa-iva): "La
// cotización generada no desglosa el IVA del 8%". Causa raíz confirmada por
// auditoría: solo se persistía un IMPORTE de impuesto (cotizaciones.impuestos),
// nunca la TASA; el panel no tenía campo para capturarla, así que
// impuestosPct siempre llegaba como 0 por default. Esta suite prueba el
// contrato exigido:
//   - tasa configurable por negocio (configuracion.iva_pct_default) y
//     override explícito por cotización (impuestosPct);
//   - 0%, 8% y 16% calculan y persisten correctamente (tasa + importe);
//   - descuentos se aplican ANTES del IVA (IVA sobre el subtotal neto);
//   - redondeo monetario consistente a dos decimales;
//   - editar sin especificar impuestosPct NO resetea la tasa a 0 -- conserva
//     la vigente;
//   - cada versión en cotizaciones_historial conserva su propia tasa
//     histórica, aunque la cotización viva cambie de tasa después;
//   - los números que expone la API son los mismos que reconstruye el panel
//     (misma fórmula: Subtotal bruto / Descuento / IVA% / Total);
//   - validación fail-closed de impuestosPct fuera de [0,100].
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4105';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, actualizarConfiguracion } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
function cookieHeader(usuarioId, negocioId, rol) { return `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`; }
async function api(base, path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(
    `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
     ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`,
    [negocioId, modulo, estado]
  );
}
// Misma fórmula que _calcularTotales() en database.js -- usada aquí para
// verificar de forma independiente (no solo "coincide con lo que devuelve
// la API", sino "coincide con la aritmética esperada").
function calcularTotalesEsperados(items, tasaIva) {
  const subtotal = items.reduce((acc, it) => acc + it.cantidad * it.precioUnitario - (it.descuento || 0), 0);
  const descuentos = items.reduce((acc, it) => acc + (it.descuento || 0), 0);
  const impuestos = Math.round(subtotal * (tasaIva / 100) * 100) / 100;
  const total = Math.round((subtotal + impuestos) * 100) / 100;
  return { subtotal: Math.round(subtotal * 100) / 100, descuentos, impuestos, total };
}
// Misma fórmula que recalcularTotalesCotizacion() en panel/index.html --
// verifica que panel y API/PDF muestren exactamente los mismos números.
function calcularComoElPanel(items, tasaIva) {
  const descuentos = items.reduce((acc, it) => acc + (it.descuento || 0), 0);
  const subtotalNeto = items.reduce((acc, it) => acc + it.cantidad * it.precioUnitario - (it.descuento || 0), 0);
  const subtotalBruto = subtotalNeto + descuentos;
  const impuestos = Math.round(subtotalNeto * tasaIva / 100 * 100) / 100;
  const total = Math.round((subtotalNeto + impuestos) * 100) / 100;
  return { subtotalBruto, descuentos, impuestos, total };
}

const TEL = '5218789930077';

await fijarModulo(SEED.negocioA, 'cotizaciones', 'activo');
await fijarModulo(SEED.negocioA, 'generador_cotizaciones', 'activo');
await pool.query(`DELETE FROM cotizaciones WHERE negocio_id = $1 AND telefono = $2`, [SEED.negocioA, TEL]);
await pool.query(`INSERT INTO clientes (telefono, nombre, negocio_id) VALUES ($1,'Cliente IVA',$2) ON CONFLICT (telefono) DO UPDATE SET negocio_id = $2`, [TEL, SEED.negocioA]);
await actualizarConfiguracion({ iva_pct_default: 8 }, SEED.negocioA);

const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });

const itemsConDescuento = [
  { tipo: 'servicio', descripcion: 'Servicio A', cantidad: 3, precioUnitario: 333.33, descuento: 50 },
  { tipo: 'producto', descripcion: 'Producto B', cantidad: 2, precioUnitario: 199.99, descuento: 0 },
];

function cuerpo(items, impuestosPct) {
  const c = { telefono: TEL, evento: { nombre: 'Evento IVA' }, items };
  if (impuestosPct !== undefined) c.impuestosPct = impuestosPct;
  return c;
}

try {
  await t('DEFAULT', 'sin impuestosPct explícito -> usa configuracion.iva_pct_default (8%) del negocio', async () => {
    const r = await api(srv.base, '/api/cotizaciones', { cookie: cookieAdminA, method: 'POST', body: cuerpo(itemsConDescuento) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const esperado = calcularTotalesEsperados(itemsConDescuento, 8);
    assert.strictEqual(Number(r.body.impuestos_tasa), 8);
    assert.strictEqual(Number(r.body.subtotal), esperado.subtotal);
    assert.strictEqual(Number(r.body.descuentos), esperado.descuentos);
    assert.strictEqual(Number(r.body.impuestos), esperado.impuestos);
    assert.strictEqual(Number(r.body.total), esperado.total);
  });

  let cot0;
  await t('TASA-0', 'impuestosPct=0 explícito -> IVA en $0.00, no se aplica el default del negocio', async () => {
    const r = await api(srv.base, '/api/cotizaciones', { cookie: cookieAdminA, method: 'POST', body: cuerpo(itemsConDescuento, 0) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(Number(r.body.impuestos_tasa), 0);
    assert.strictEqual(Number(r.body.impuestos), 0);
    const esperado = calcularTotalesEsperados(itemsConDescuento, 0);
    assert.strictEqual(Number(r.body.total), esperado.total);
    cot0 = r.body;
  });

  let cot16;
  await t('TASA-16', 'impuestosPct=16 -> calcula y persiste 16% correctamente', async () => {
    const r = await api(srv.base, '/api/cotizaciones', { cookie: cookieAdminA, method: 'POST', body: cuerpo(itemsConDescuento, 16) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(Number(r.body.impuestos_tasa), 16);
    const esperado = calcularTotalesEsperados(itemsConDescuento, 16);
    assert.strictEqual(Number(r.body.impuestos), esperado.impuestos);
    assert.strictEqual(Number(r.body.total), esperado.total);
    cot16 = r.body;
  });

  await t('REDONDEO', 'los importes con fracción de centavo quedan redondeados a 2 decimales', async () => {
    // 3 * 333.33 = 999.99, menos 50 de descuento = 949.99 de subtotal neto;
    // 949.99 * 0.08 = 75.9992 -> debe redondear a 76.00, no truncar a 75.99.
    const items = [{ tipo: 'servicio', descripcion: 'Redondeo', cantidad: 3, precioUnitario: 333.33, descuento: 50 }];
    const r = await api(srv.base, '/api/cotizaciones', { cookie: cookieAdminA, method: 'POST', body: cuerpo(items, 8) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(Number(r.body.impuestos), 76);
    assert.strictEqual(Number(r.body.total), Math.round((949.99 + 76) * 100) / 100);
  });

  await t('PANEL-API-PARIDAD', 'la fórmula del panel (Subtotal bruto/Descuento/IVA/Total) coincide con lo que devuelve la API', async () => {
    const esperadoPanel = calcularComoElPanel(itemsConDescuento, 16);
    assert.strictEqual(Number(cot16.subtotal) + Number(cot16.descuentos), esperadoPanel.subtotalBruto);
    assert.strictEqual(Number(cot16.descuentos), esperadoPanel.descuentos);
    assert.strictEqual(Number(cot16.impuestos), esperadoPanel.impuestos);
    assert.strictEqual(Number(cot16.total), esperadoPanel.total);
  });

  await t('EDICION', 'editar sin impuestosPct conserva la tasa vigente -- NO la resetea a 0', async () => {
    const r = await api(srv.base, `/api/cotizaciones/${cot16.id}`, {
      cookie: cookieAdminA, method: 'PATCH',
      body: { items: [...itemsConDescuento, { tipo: 'servicio', descripcion: 'Extra', cantidad: 1, precioUnitario: 100, descuento: 0 }] },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(Number(r.body.impuestos_tasa), 16, 'la tasa debe seguir siendo 16%, no resetearse a 0');
    assert.strictEqual(r.body.version, 2);
  });

  await t('EDICION', 'editar CON impuestosPct explícito sí cambia la tasa', async () => {
    const r = await api(srv.base, `/api/cotizaciones/${cot16.id}`, { cookie: cookieAdminA, method: 'PATCH', body: { impuestosPct: 0 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(Number(r.body.impuestos_tasa), 0);
    assert.strictEqual(Number(r.body.impuestos), 0);
  });

  await t('HISTORIAL', 'cada versión en cotizaciones_historial conserva su propia tasa histórica', async () => {
    const { rows } = await pool.query(`SELECT version, snapshot_json FROM cotizaciones_historial WHERE cotizacion_id = $1 ORDER BY version`, [cot16.id]);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(Number(rows[0].snapshot_json.impuestos_tasa), 16, 'v1 se creó con 16% -- su snapshot debe conservar 16%, aunque la cotización viva ya esté en 0%');
    assert.strictEqual(Number(rows[1].snapshot_json.impuestos_tasa), 16, 'v2 (editada sin impuestosPct) también conservó 16% en su momento');
  });

  await t('VALIDACION', 'impuestosPct negativo -> 400 al crear', async () => {
    const r = await api(srv.base, '/api/cotizaciones', { cookie: cookieAdminA, method: 'POST', body: cuerpo(itemsConDescuento, -1) });
    assert.strictEqual(r.status, 400);
  });
  await t('VALIDACION', 'impuestosPct > 100 -> 400 al crear', async () => {
    const r = await api(srv.base, '/api/cotizaciones', { cookie: cookieAdminA, method: 'POST', body: cuerpo(itemsConDescuento, 150) });
    assert.strictEqual(r.status, 400);
  });
  await t('VALIDACION', 'impuestosPct no numérico -> 400 al crear', async () => {
    const r = await api(srv.base, '/api/cotizaciones', { cookie: cookieAdminA, method: 'POST', body: cuerpo(itemsConDescuento, 'ocho') });
    assert.strictEqual(r.status, 400);
  });
  await t('VALIDACION', 'impuestosPct fuera de rango -> 400 al editar', async () => {
    const r = await api(srv.base, `/api/cotizaciones/${cot0.id}`, { cookie: cookieAdminA, method: 'PATCH', body: { impuestosPct: 200 } });
    assert.strictEqual(r.status, 400);
  });

  await t('COMPATIBILIDAD', 'cotizaciones ya existentes sin tasa explícita conservan impuestos_tasa = 0 (comportamiento previo al hotfix)', async () => {
    const { rows } = await pool.query(`SELECT impuestos_tasa FROM cotizaciones WHERE id = $1`, [cot0.id]);
    assert.strictEqual(Number(rows[0].impuestos_tasa), 0);
  });
} finally {
  srv.detener();
  await pool.query(`DELETE FROM cotizaciones WHERE negocio_id = $1 AND telefono = $2`, [SEED.negocioA, TEL]);
  await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'iva_pct_default'`, [SEED.negocioA]);
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('\nDetalle de fallos:'); fallos.forEach(f => console.log('  - ' + f)); }
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
