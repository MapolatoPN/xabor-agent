// ─── Ticket del cliente: una línea por promoción, el manual aparte ───────────
//
// El ticket decía «Descuento −$390» aunque el pedido llevara el «Miercoles de
// Chilaquiles», y si además había un descuento manual los dos salían sumados en
// una sola línea con el motivo del manual. Decisión de Mario (22-oct-2026): una
// línea por promoción con su nombre y el manual aparte con su motivo
// (panel/lineasDescuento.js, usado por ticketHTML).
//
//   U — la función pura: casos, fallback a la línea de siempre, nada que no sume.
//   P — index.html carga el módulo con su huella.
//   B — el panel real: ticketHTML y el ticket que sale solo al cobrar.
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import vm from 'vm';
import assert from 'assert';
import puppeteer from 'puppeteer';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_TICKET_LINEAS || '4735';
const FUENTE = readFileSync(join(__dirname, '..', 'panel', 'lineasDescuento.js'));
const PANEL = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════════════════════
// U — la función pura
// ════════════════════════════════════════════════════════════════════════════
const ctx = {};
vm.createContext(ctx);
new vm.Script(FUENTE.toString('utf8'), { filename: 'lineasDescuento.js' }).runInContext(ctx);
const lineas = (p) => JSON.parse(JSON.stringify(ctx.XaborLineasDescuento.lineas(p)));
const PROMO = (nombre, monto) => ({ nombre, monto, tipo: '2x1', promocionId: 'x' });

await t('U', '1. sin descuento no hay líneas', async () => {
  assert.deepStrictEqual(lineas({ descuento: 0 }), []);
  assert.deepStrictEqual(lineas({}), []);
});
await t('U', '2. solo la promoción: una línea con su nombre', async () => {
  assert.deepStrictEqual(lineas({ descuento: 390, descuentos: { promociones: [PROMO('Miercoles de Chilaquiles', 390)] } }),
    [{ etiqueta: 'Miercoles de Chilaquiles', monto: 390 }]);
});
await t('U', '3. promoción + manual: cada una en su línea, el manual con su motivo', async () => {
  assert.deepStrictEqual(lineas({ descuento: 215, motivo_descuento: 'cortesía',
    descuentos: { promociones: [PROMO('Miercoles de Chilaquiles', 195)] } }),
  [{ etiqueta: 'Miercoles de Chilaquiles', monto: 195 }, { etiqueta: 'Descuento (cortesía)', monto: 20 }]);
});
await t('U', '4. dos promociones, dos líneas', async () => {
  assert.deepStrictEqual(lineas({ descuento: 245, descuentos: { promociones: [PROMO('A', 195), PROMO('B', 50)] } }),
    [{ etiqueta: 'A', monto: 195 }, { etiqueta: 'B', monto: 50 }]);
});
await t('U', '5. sin desglose, usa las promociones del pedido', async () => {
  assert.deepStrictEqual(lineas({ descuento: 195, promociones: [{ nombre: 'Martes de Combitos', descuento: 195 }] }),
    [{ etiqueta: 'Martes de Combitos', monto: 195 }]);
});
await t('U', '6. sin promociones: la línea de siempre, con su motivo', async () => {
  assert.deepStrictEqual(lineas({ descuento: 30, motivo_descuento: 'queja', descuentos: { promociones: [] } }),
    [{ etiqueta: 'Descuento (queja)', monto: 30 }]);
  assert.deepStrictEqual(lineas({ descuento: 30 }), [{ etiqueta: 'Descuento', monto: 30 }]);
});
await t('U', '7. si las promociones suman más que el descuento, la línea de siempre', async () => {
  assert.deepStrictEqual(lineas({ descuento: 100, motivo_descuento: null, descuentos: { promociones: [PROMO('A', 195)] } }),
    [{ etiqueta: 'Descuento', monto: 100 }]);
});
await t('U', '8. un envío gratis (monto 0) no imprime línea', async () => {
  assert.deepStrictEqual(lineas({ descuento: 195, descuentos: { promociones: [PROMO('Envío gratis', 0), PROMO('A', 195)] } }),
    [{ etiqueta: 'A', monto: 195 }]);
});
await t('U', '9. las líneas siempre suman el descuento total', async () => {
  for (const p of [
    { descuento: 215, motivo_descuento: 'x', descuentos: { promociones: [PROMO('A', 195)] } },
    { descuento: 245.5, descuentos: { promociones: [PROMO('A', 195), PROMO('B', 50.5)] } },
    { descuento: 30, descuentos: { promociones: [] } },
  ]) {
    const suma = lineas(p).reduce((s, l) => s + l.monto, 0);
    assert.ok(Math.abs(suma - p.descuento) < 0.001, `${JSON.stringify(p)} suma ${suma}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// P — el panel carga el módulo
// ════════════════════════════════════════════════════════════════════════════
await t('P', '1. index.html carga lineasDescuento.js con la huella de su contenido', async () => {
  const huella = createHash('sha256').update(FUENTE).digest('hex').slice(0, 8);
  const m = PANEL.match(/<script src="\/lineasDescuento\.js\?v=([0-9a-f]{8})"><\/script>/);
  assert.ok(m, 'no se carga /lineasDescuento.js');
  assert.strictEqual(m[1], huella, `el ?v= dice "${m[1]}" pero el módulo tiene huella "${huella}". ` +
    `Si acabas de editar lineasDescuento.js, pon "${huella}" en el ?v= de index.html.`);
});

// ════════════════════════════════════════════════════════════════════════════
// B — el panel real
// ════════════════════════════════════════════════════════════════════════════
const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');
const NEG_A = SEED.negocioA;
const token = crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: NEG_A, rol: 'admin' });
const ADMIN_A = `xabor_sesion=${encodeURIComponent(token)}`;
for (const m of ['pos', 'caja', 'menu']) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [NEG_A, m]);
}
await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'mostrador_promos_automaticas'`, [NEG_A]);
const sufijo = Date.now().toString(36);
const NOMBRE_PROMO = `Miercoles de Chilaquiles ${sufijo}`;
let prodChila;
{
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,0) RETURNING id`, [NEG_A, `Ticket ${sufijo}`]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
     VALUES ($1,$2,$3,195,TRUE,FALSE,1) RETURNING id`, [NEG_A, cat.id, `Chila ${sufijo}`]);
  prodChila = p.id;
}

const srv = await arrancarServidor({ PORT: PUERTO, TZ: 'America/Matamoros' }, { timeoutMs: 90000 });
const api = (ruta, opts = {}) => fetch(srv.base + ruta, {
  ...opts, headers: { 'Content-Type': 'application/json', Cookie: ADMIN_A, ...(opts.headers || {}) },
});
let promoId, navegador;
try {
  const rp = await api('/api/admin/tienda/promociones', { method: 'POST', body: JSON.stringify({
    nombre: NOMBRE_PROMO, tipo: '2x1', automatica: true, canales: ['pos'], productos: [prodChila],
    cantidadRequerida: 2, cantidadBeneficiada: 1, activa: true, acumulable: true }) });
  promoId = (await rp.json()).id;
  assert.ok(promoId, 'no se creó la promo');

  navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const pagina = await navegador.newPage();
  const erroresJS = [];
  pagina.on('pageerror', e => erroresJS.push(e.message));
  pagina.on('dialog', d => d.accept().catch(() => {}));
  await pagina.setCookie({ name: 'xabor_sesion', value: encodeURIComponent(token), domain: 'localhost', path: '/' });
  await pagina.goto(srv.base + '/app', { waitUntil: 'networkidle0' });
  // Las ventanas de impresión se capturan en vez de abrirse.
  await pagina.evaluate(() => {
    window.__impresos = [];
    window.open = () => ({ document: { write: (h) => window.__impresos.push(h), close() {} }, print() {}, close() {}, set onload(f) {} });
  });
  const textoDe = (html) => pagina.evaluate((h) => {
    const d = new DOMParser().parseFromString(h, 'text/html');
    return [...d.querySelectorAll('tr')].map(tr =>
      [...tr.cells].map(c => c.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' '));
  }, html);

  await t('B', '1. ticketHTML imprime una línea por promoción y el manual aparte (y escapa el nombre)', async () => {
    const html = await pagina.evaluate(() => ticketHTML({
      id: 'XAB-9999', canal: 'presencial', modalidad: 'recoger en tienda', timestamp: new Date().toISOString(),
      cliente: { nombre: 'Prueba', telefono: '—' }, forma_pago: 'efectivo',
      items: [{ nombre: 'Chila', cantidad: 3, precio_unitario: 195 }],
      subtotal: 585, descuento: 215, motivo_descuento: 'cortesía', total: 370,
      descuentos: { promociones: [{ nombre: '2x1 <b>chila</b>', monto: 195 }] },
    }));
    const filas = await textoDe(html);
    assert.ok(filas.includes('2x1 <b>chila</b> -$195'), filas.join(' | '));
    assert.ok(filas.includes('Descuento (cortesía) -$20'), filas.join(' | '));
    assert.ok(!filas.some(f => f.includes('-$215')), 'quedó la línea sumada de antes');
    assert.ok(!html.includes('<b>chila</b>'), 'el nombre de la promo no se escapó');
  });

  await t('B', '2. un pedido sin promociones conserva la línea de siempre', async () => {
    const html = await pagina.evaluate(() => ticketHTML({
      id: 'XAB-9998', canal: 'presencial', modalidad: 'recoger en tienda', timestamp: new Date().toISOString(),
      cliente: { nombre: 'Prueba', telefono: '—' }, forma_pago: 'efectivo',
      items: [{ nombre: 'Agua', cantidad: 1, precio_unitario: 100 }], subtotal: 100, descuento: 10, motivo_descuento: 'queja', total: 90,
    }));
    assert.ok((await textoDe(html)).includes('Descuento (queja) -$10'));
  });

  await t('B', '3. el ticket que sale solo al cobrar dice la promo y el manual por separado', async () => {
    const r = await api('/api/pedido-presencial', { method: 'POST',
      body: JSON.stringify({ items: [{ producto_id: prodChila, cantidad: 2 }], nombre: 'Ticket con promo' }) });
    const alta = await r.json();
    assert.strictEqual(r.status, 200, JSON.stringify(alta));
    const folio = alta.pedido.id;
    await pagina.waitForFunction((f) => !!pedidos[f], { timeout: 8000 }, folio);
    await pagina.evaluate(() => { window.__impresos.length = 0; });
    await pagina.evaluate((f) => {
      abrirCobro(f);
      cobroSelPago(document.querySelector('[data-cobro-pago="efectivo"]'));
      document.getElementById('cobro-desc-val').value = '20';
      document.getElementById('cobro-desc-motivo').value = 'cortesía';
      cobroRender();
      confirmarCobro();
    }, folio);
    await pagina.waitForFunction(() => window.__impresos.some(h => h.includes('TICKET DE CLIENTE')), { timeout: 8000 });
    const html = await pagina.evaluate(() => window.__impresos.find(h => h.includes('TICKET DE CLIENTE')));
    const filas = await textoDe(html);
    assert.ok(filas.includes(`${NOMBRE_PROMO} -$195`), filas.join(' | '));
    assert.ok(filas.includes('Descuento (cortesía) -$20'), filas.join(' | '));
    assert.ok(html.includes('$175'), 'el total no es el cobrado');
  });

  await t('B', '4. ningún error de JavaScript', async () => {
    await esperar(300);
    assert.deepStrictEqual(erroresJS, []);
  });
} finally {
  if (navegador) await navegador.close().catch(() => {});
  srv.detener();
  if (promoId) {
    await pool.query(`DELETE FROM tienda_promocion_usos WHERE promocion_id = $1`, [promoId]).catch(() => {});
    await pool.query(`DELETE FROM tienda_promociones WHERE id = $1`, [promoId]).catch(() => {});
  }
  await pool.query(`UPDATE menu_productos SET disponible = FALSE WHERE id = $1`, [prodChila]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log(fallos.join('\n')); process.exit(1); }
process.exit(0);
