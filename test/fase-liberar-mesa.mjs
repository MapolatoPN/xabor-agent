// Liberar una mesa sin consumo, sin registrar una venta de $0.
//
// Auditoría del 28-sep-2026 (Mapolato Obispado): 60 de 274 cuentas cerradas
// quedaron como venta de $0 (45 sin un solo platillo, 11 con todo
// cancelado). La única salida de una mesa era «Cerrar cuenta» y cerrar
// siempre registra venta. Ahora: la pantalla no puede cerrar una cuenta sin
// consumo y ofrece «Liberar mesa», que deja la cuenta cancelada con motivo,
// quién y cuándo, sin venta. La cortesía (100 % de descuento) sí se cierra.
//
// Uso: DATABASE_URL=... (y el resto de variables de las suites) node test/fase-liberar-mesa.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import puppeteer from 'puppeteer';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUERTO = process.env.TEST_PORT_LIBERAR || '4977';
const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
for (const m of ['101_restaurante_cancelaciones_autorizadas.sql', '102_restaurante_liberar_mesa.sql']) {
  await pool.query(readFileSync(join(__dirname, '..', 'migrations', m), 'utf8'));
}

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

const SLUG = 'liberar-mesa-prueba';
async function limpiar() {
  const { rows } = await pool.query(`SELECT id FROM negocios WHERE slug = $1`, [SLUG]);
  if (!rows.length) return;
  const id = rows[0].id;
  const q = (sql) => pool.query(sql, [id]).catch(() => {});
  await q(`DELETE FROM restaurante_item_eventos WHERE negocio_id = $1`);
  await q(`DELETE FROM restaurante_cuenta_porciones WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = $1)`);
  await q(`DELETE FROM restaurante_cuenta_pagos WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = $1)`);
  await q(`DELETE FROM restaurante_cuenta_items WHERE negocio_id = $1`);
  await q(`DELETE FROM restaurante_cuentas WHERE negocio_id = $1`);
  await q(`DELETE FROM pedidos_activos WHERE negocio_id = $1`);
  await q(`DELETE FROM pedido_emisiones WHERE negocio_id = $1`);
  await q(`DELETE FROM compras_reales WHERE negocio_id = $1`);
  await q(`DELETE FROM metodos_pago WHERE negocio_id = $1`);
  await q(`DELETE FROM negocio_modulos WHERE negocio_id = $1`);
  await q(`DELETE FROM usuario_negocios WHERE negocio_id = $1`);
  await q(`DELETE FROM usuarios WHERE negocio_id = $1`);
  await q(`DELETE FROM negocios WHERE id = $1`);
}
await limpiar();

const { rows: [neg] } = await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ('Liberar Prueba', $1) RETURNING id`, [SLUG]);
const N = neg.id;
for (const m of ['restaurante', 'pos', 'caja', 'usuarios']) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [N, m]);
}
await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,'efectivo',TRUE,0)`, [N]);
const persona = async (nombre, rol) => {
  const { rows: [u] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,'x') RETURNING id`,
    [N, nombre, `liberar-${rol}-${Math.random().toString(36).slice(2)}@test.local`]);
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,$3)`, [u.id, N, rol]);
  return u.id;
};
const ADMIN = await persona('Ana Admin', 'admin');
const STAFF = await persona('Sara Staff', 'staff');

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const galleta = (id, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: id, negocioId: N, rol }))}`;
async function api(path, { cookie = galleta(ADMIN, 'admin'), method = 'GET', body } = {}) {
  const r = await fetch(srv.base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
async function abrir(mesa) {
  const r = await api('/api/restaurante/mesas/abrir', { method: 'POST', body: { mesa, personas: 2 } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.id || r.body.cuenta?.id;
}
const ventasDe = async (cuentaId) => (await pool.query(
  `SELECT count(*)::int AS n FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'cuenta_id' = $2`, [N, cuentaId])).rows[0].n;
const cuentaBD = async (id) => (await pool.query(
  `SELECT estado, cerrada_por, cerrada_at, venta_folio, liberada_motivo_codigo, liberada_motivo FROM restaurante_cuentas WHERE id = $1`, [id])).rows[0];

await t('CERRAR', '1. la pantalla ya no puede cerrar una cuenta sin consumo (no nace la venta de $0)', async () => {
  const c = await abrir(3);
  const r = await api(`/api/restaurante/cuentas/${c}/cerrar`, { method: 'POST' });
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  assert.strictEqual(r.body.code, 'CUENTA_SIN_CONSUMO');
  assert.strictEqual(await ventasDe(c), 0, 'no se registró venta');
  assert.strictEqual((await cuentaBD(c)).estado, 'abierta');
});
await t('LIBERAR', '2. «Liberar mesa» deja la cuenta cancelada con motivo, quién y cuándo, sin venta, y la mesa libre', async () => {
  const { rows: [c] } = await pool.query(`SELECT id FROM restaurante_cuentas WHERE negocio_id = $1 AND mesa_numero = 3 AND estado = 'abierta'`, [N]);
  const r = await api(`/api/restaurante/cuentas/${c.id}/liberar`, { method: 'POST', body: { motivo_codigo: 'abierta_por_error' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const fila = await cuentaBD(c.id);
  assert.strictEqual(fila.estado, 'cancelada');
  assert.strictEqual(fila.cerrada_por, ADMIN);
  assert.ok(fila.cerrada_at, 'cuándo');
  assert.deepStrictEqual([fila.liberada_motivo_codigo, fila.liberada_motivo], ['abierta_por_error', 'Mesa abierta por error']);
  assert.strictEqual(fila.venta_folio, null);
  assert.strictEqual(await ventasDe(c.id), 0);
  const mesas = (await api('/api/restaurante/mesas')).body.mesas;
  assert.strictEqual(mesas.find(m => m.mesa === 3).ocupada, false, 'la mesa 3 vuelve a estar libre');
});
await t('LIBERAR', '3. con un platillo vivo no se libera: se cobra o se quita primero', async () => {
  const c = await abrir(4);
  await api(`/api/restaurante/cuentas/${c}/items`, { method: 'POST', body: { items: [{ producto: 'Café', cantidad: 1, precio_unitario: 35 }] } });
  const r = await api(`/api/restaurante/cuentas/${c}/liberar`, { method: 'POST', body: { motivo_codigo: 'se_fueron' } });
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  assert.strictEqual(r.body.code, 'CUENTA_CON_CONSUMO');
  assert.strictEqual((await cuentaBD(c)).estado, 'abierta');
});
await t('LIBERAR', '4. si todo se canceló, se libera con «Se canceló todo»', async () => {
  const { rows: [c] } = await pool.query(`SELECT id FROM restaurante_cuentas WHERE negocio_id = $1 AND mesa_numero = 4 AND estado = 'abierta'`, [N]);
  await api(`/api/restaurante/cuentas/${c.id}/comanda`, { method: 'POST' });
  const item = (await api(`/api/restaurante/cuentas/${c.id}`)).body.items[0];
  const can = await api(`/api/restaurante/cuentas/${c.id}/items/${item.id}/cancelar`, { method: 'POST', body: { motivo_codigo: 'ya_no_lo_quiso' } });
  assert.strictEqual(can.status, 200, JSON.stringify(can.body));
  // Con todo cancelado tampoco se «cierra»: sería otra venta de $0.
  const cerrar = await api(`/api/restaurante/cuentas/${c.id}/cerrar`, { method: 'POST' });
  assert.strictEqual(cerrar.status, 409, JSON.stringify(cerrar.body));
  assert.strictEqual(cerrar.body.code, 'CUENTA_SIN_CONSUMO');
  const r = await api(`/api/restaurante/cuentas/${c.id}/liberar`, { method: 'POST', body: { motivo_codigo: 'todo_cancelado' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual((await cuentaBD(c.id)).liberada_motivo, 'Se canceló todo');
});
await t('LIBERAR', '5. con dinero recibido no se libera: primero se revierte el cobro', async () => {
  const c = await abrir(5);
  await api(`/api/restaurante/cuentas/${c}/items`, { method: 'POST', body: { items: [{ producto: 'Jugo', cantidad: 1, precio_unitario: 40 }] } });
  const pago = await api(`/api/restaurante/cuentas/${c}/pagos`, { method: 'POST', body: { metodo: 'efectivo', monto: 20 } });
  assert.strictEqual(pago.status, 200, JSON.stringify(pago.body));
  await api(`/api/restaurante/cuentas/${c}/comanda`, { method: 'POST' });
  const item = (await api(`/api/restaurante/cuentas/${c}`)).body.items[0];
  await api(`/api/restaurante/cuentas/${c}/items/${item.id}/cancelar`, { method: 'POST', body: { motivo_codigo: 'error_captura' } });
  const r = await api(`/api/restaurante/cuentas/${c}/liberar`, { method: 'POST', body: { motivo_codigo: 'todo_cancelado' } });
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  assert.strictEqual(r.body.code, 'CUENTA_CON_PAGOS');
});
await t('LIBERAR', '6. el motivo sale de la lista; «Otro» exige escribirlo', async () => {
  const c = await abrir(6);
  const sin = await api(`/api/restaurante/cuentas/${c}/liberar`, { method: 'POST', body: {} });
  assert.strictEqual(sin.status, 400);
  const raro = await api(`/api/restaurante/cuentas/${c}/liberar`, { method: 'POST', body: { motivo_codigo: 'porque si' } });
  assert.strictEqual(raro.status, 400);
  const otro = await api(`/api/restaurante/cuentas/${c}/liberar`, { method: 'POST', body: { motivo_codigo: 'otro' } });
  assert.strictEqual(otro.status, 400);
  const ok = await api(`/api/restaurante/cuentas/${c}/liberar`, { method: 'POST', body: { motivo_codigo: 'otro', motivo: 'se equivocaron de mesa' } });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.strictEqual((await cuentaBD(c)).liberada_motivo, 'se equivocaron de mesa');
});
await t('LIBERAR', '7. staff también libera (es operar la mesa); queda su nombre', async () => {
  const c = await abrir(7);
  const r = await api(`/api/restaurante/cuentas/${c}/liberar`, { method: 'POST', body: { motivo_codigo: 'se_fueron' }, cookie: galleta(STAFF, 'staff') });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual((await cuentaBD(c)).cerrada_por, STAFF);
});
await t('CERRAR', '8. la cortesía (descuento del 100 %) sí se cierra: se sirvió', async () => {
  const c = await abrir(8);
  await api(`/api/restaurante/cuentas/${c}/items`, { method: 'POST', body: { items: [{ producto: 'Pastel', cantidad: 1, precio_unitario: 209 }] } });
  const d = await api(`/api/restaurante/cuentas/${c}/descuento`, { method: 'POST', body: { tipo: 'porcentaje', valor: 100, motivo: 'Cumpleaños' } });
  assert.strictEqual(d.status, 200, JSON.stringify(d.body));
  const r = await api(`/api/restaurante/cuentas/${c}/cerrar`, { method: 'POST' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(await ventasDe(c), 1, 'la cortesía sí es venta (con su descuento)');
});
await t('HISTORIAL', '9. el historial muestra las mesas liberadas en «sin venta», con motivo y quién', async () => {
  // Una liberada hace dos días no es de «hoy».
  const vieja = await abrir(11);
  const lib = await api(`/api/restaurante/cuentas/${vieja}/liberar`, { method: 'POST', body: { motivo_codigo: 'se_fueron' } });
  assert.strictEqual(lib.status, 200, JSON.stringify(lib.body));
  await pool.query(`UPDATE restaurante_cuentas SET abierta_at = abierta_at - interval '2 days', cerrada_at = cerrada_at - interval '2 days' WHERE id = $1`, [vieja]);
  const r = await api('/api/historial?periodo=hoy');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const liberadas = r.body.filter(p => p._estado === 'liberada');
  assert.strictEqual(liberadas.length, 4, `liberadas en el historial: ${liberadas.length}`);
  const tres = liberadas.find(p => p.mesa === 3);
  assert.strictEqual(tres.liberada_motivo, 'Mesa abierta por error');
  assert.strictEqual(tres._liberada_por_nombre, 'Ana Admin');
  assert.strictEqual(tres.total, 0);
  assert.ok(tres._creado_at, 'con la hora en que se liberó');
});
await t('CAJA', '10. en Caja la mesa liberada dice por qué', async () => {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Matamoros' }).format(new Date());
  const r = await api(`/api/corte-caja?fecha=${hoy}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const filas = [...(r.body.pedidos || []), ...(r.body.cuentas_mesa || [])];
  const tres = filas.find(f => f.mesa === 3 && f.estado_cuenta === 'cancelada');
  assert.ok(tres, `la mesa 3 no está en Caja: ${JSON.stringify(Object.keys(r.body))}`);
  assert.ok(/Mesa abierta por error/.test(tres.detalle_cuenta || ''), `detalle: ${tres.detalle_cuenta}`);
});

// ═══════════ Pantallas reales (Puppeteer) ═══════════
const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ERRORES = [];
try {
  const ctx = await navegador.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1200, height: 860 });
  const g = galleta(ADMIN, 'admin');
  await page.setCookie({ name: 'xabor_sesion', value: g.slice(g.indexOf('=') + 1), url: srv.base });
  page.on('dialog', d => d.accept().catch(() => {}));
  page.on('pageerror', e => ERRORES.push(String(e.message || e)));
  const botones = () => page.$$eval('#cu-secundarias button', bs => bs.map(b => b.textContent.trim()));
  const abrirEnPantalla = async (cuentaId) => {
    await page.evaluate((id) => abrirCuenta(id), cuentaId);
    await page.waitForFunction(() => document.getElementById('cu-titulo').textContent.startsWith('Mesa'), { timeout: 8000 });
  };

  const m9 = await abrir(9);
  const m10 = await abrir(10);
  await api(`/api/restaurante/cuentas/${m10}/items`, { method: 'POST', body: { items: [{ producto: 'Café', cantidad: 1, precio_unitario: 35 }] } });
  await page.goto(srv.base + '/mesas.html', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof abrirCuenta === 'function' && typeof abrirLiberar === 'function', { timeout: 10000 });

  await t('PANTALLA', '11. una cuenta sin consumo ofrece «Liberar mesa» y no «Cerrar cuenta»; con consumo, al revés', async () => {
    await abrirEnPantalla(m9);
    const vacia = await botones();
    assert.ok(vacia.includes('Liberar mesa') && !vacia.includes('Cerrar cuenta'), `mesa 9: ${vacia}`);
    await abrirEnPantalla(m10);
    const conCafe = await botones();
    assert.ok(conCafe.includes('Cerrar cuenta') && !conCafe.includes('Liberar mesa'), `mesa 10: ${conCafe}`);
  });
  await t('PANTALLA', '12. liberar pide el motivo; con él, la cuenta queda cancelada sin venta y la pantalla vuelve al tablero', async () => {
    await abrirEnPantalla(m9);
    await page.evaluate(() => [...document.querySelectorAll('#cu-secundarias button')].find(b => b.textContent.trim() === 'Liberar mesa').click());
    await page.waitForFunction(() => document.getElementById('dlg-liberar').open, { timeout: 5000 });
    const motivos = await page.$$eval('#lb-motivos .chip', bs => bs.map(b => b.textContent.trim()));
    assert.deepStrictEqual(motivos, ['Mesa abierta por error', 'Los clientes se fueron', 'Se canceló todo', 'Otro']);
    await page.click('#lb-confirmar');
    assert.strictEqual(await page.$eval('#lb-aviso', el => el.textContent), 'Elige el motivo.');
    await page.click('#lb-motivos .chip[data-motivo="otro"]');
    await page.click('#lb-confirmar');
    assert.strictEqual(await page.$eval('#lb-aviso', el => el.textContent), 'Escribe el motivo.');
    assert.strictEqual((await cuentaBD(m9)).estado, 'abierta', 'nada salió al servidor');
    await page.click('#lb-motivos .chip[data-motivo="se_fueron"]');
    await page.click('#lb-confirmar');
    await page.waitForFunction(() => !document.getElementById('dlg-liberar').open
      && !document.getElementById('v-tablero').classList.contains('oculto'), { timeout: 5000 });
    const fila = await cuentaBD(m9);
    assert.deepStrictEqual([fila.estado, fila.liberada_motivo, fila.cerrada_por, fila.venta_folio],
      ['cancelada', 'Los clientes se fueron', ADMIN, null]);
    assert.strictEqual(await ventasDe(m9), 0);
    assert.ok(/Mesa 9 liberada, sin venta/.test(await page.$eval('#msg', el => el.textContent)), 'avisa que no hubo venta');
  });
  await t('PANTALLA', '13. con dinero recibido, la pantalla dice lo que falta y no libera', async () => {
    const { rows: [c5] } = await pool.query(`SELECT id FROM restaurante_cuentas WHERE negocio_id = $1 AND mesa_numero = 5 AND estado = 'abierta'`, [N]);
    await abrirEnPantalla(c5.id);
    await page.evaluate(() => [...document.querySelectorAll('#cu-secundarias button')].find(b => b.textContent.trim() === 'Liberar mesa').click());
    await page.waitForFunction(() => document.getElementById('dlg-liberar').open, { timeout: 5000 });
    const primero = await page.$eval('#lb-motivos .chip', b => b.textContent.trim());
    assert.strictEqual(primero, 'Se canceló todo', 'con platillos quitados, el motivo probable va primero');
    await page.click('#lb-motivos .chip[data-motivo="todo_cancelado"]');
    await page.click('#lb-confirmar');
    await page.waitForFunction(() => /cobros/.test(document.getElementById('lb-aviso').textContent), { timeout: 5000 });
    assert.ok(await page.$eval('#dlg-liberar', d => d.open), 'el diálogo sigue abierto');
    assert.strictEqual((await cuentaBD(c5.id)).estado, 'abierta');
    await page.evaluate(() => document.getElementById('dlg-liberar').close());
  });

  const adm = await ctx.newPage();
  await adm.setViewport({ width: 1300, height: 900 });
  adm.on('pageerror', e => ERRORES.push(String(e.message || e)));
  await adm.goto(srv.base + '/app', { waitUntil: 'networkidle2' });
  await adm.waitForFunction(() => typeof cargarHistorial === 'function' && typeof cargarCorte === 'function', { timeout: 10000 });

  await t('PANTALLA', '14. Historial: la mesa liberada va en «Canceladas y sin venta» con motivo y quién, no en ventas', async () => {
    await adm.evaluate(() => mostrarTab('historial'));
    await adm.waitForFunction(() => document.querySelectorAll('#hist-chips .corte-chip').length === 5, { timeout: 10000 });
    await adm.evaluate(() => histFiltrar('todas'));
    const ventas = await adm.$$eval('#historial-lista > div', ds => ds.map(d => d.innerText.replace(/\s+/g, ' ')));
    assert.ok(!ventas.some(v => /Mesa 3\b/.test(v)), 'una mesa liberada no es venta');
    await adm.evaluate(() => histFiltrar('no_venta'));
    const filas = await adm.$$eval('#historial-lista > div', ds => ds.map(d => d.innerText.replace(/\s+/g, ' ')));
    const tres = filas.find(f => /Mesa 3\b/.test(f)) || '';
    assert.ok(/Mesa liberada/.test(tres) && /Mesa abierta por error/.test(tres) && /liberó Ana Admin/.test(tres), `mesa 3: ${tres}`);
    const cuatro = filas.find(f => /Mesa 4\b/.test(f)) || '';
    assert.ok(/Se canceló todo/.test(cuatro) && /1 producto/.test(cuatro), `mesa 4: ${cuatro}`);
  });
  await t('PANTALLA', '15. Caja: la mesa liberada dice «Liberada» y por qué', async () => {
    await adm.evaluate(() => mostrarTab('corte'));
    await adm.waitForFunction(() => /Mesa 3/.test(document.getElementById('corte-lista').innerText), { timeout: 10000 });
    const fila = await adm.$$eval('#corte-lista .corte-fila', fs => fs.map(f => ({
      texto: f.innerText.replace(/\s+/g, ' '),
      insignia: f.querySelector('.corte-badge')?.textContent.trim(),
    })).find(x => /Mesa 3\b/.test(x.texto)) || {});
    // La insignia misma, no el texto: la nota también dice «Liberada: …».
    assert.strictEqual(fila.insignia, 'Liberada', `insignia: ${fila.insignia}`);
    assert.ok(/Mesa abierta por error/.test(fila.texto || ''), `Caja: ${fila.texto}`);
  });
  await t('PANTALLA', '16. ninguna pantalla lanzó errores de JavaScript', async () => {
    assert.deepStrictEqual(ERRORES, []);
  });
} finally {
  await navegador.close().catch(() => {});
}

srv.detener();
await limpiar().catch(() => {});
await pool.end();
console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
