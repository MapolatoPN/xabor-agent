// ─── Precuentas de la cuenta dividida, de punta a punta ────────────────────
//
// Pedido de los meseros (15-oct-2026): una mesa de 8 que pide la cuenta
// dividida necesita un papel por persona con lo que consumió, para
// enseñárselo antes de cobrar. Esta suite usa el servidor y Postgres reales:
//   · el importe de la precuenta de una selección es EXACTAMENTE el que el
//     cobro por consumo acepta para esa selección (con descuento y mitades);
//   · «una por persona» sale en orden, suma lo que debe la mesa y, después
//     de cobrarle a alguien, ya no lo incluye;
//   · imprimir no cobra, no reserva ni cambia nada de la cuenta;
//   · con la impresora de Caja va por Edge solo a Caja (nunca a cocina), es
//     idempotente por solicitud, y sin ella vuelve al navegador;
//   · el mesero de tablet puede imprimirla; otro negocio no la ve;
//   · en Chrome: los dos botones y el diálogo de impresión con una hoja por
//     persona.
// Negocio propio (slug precuenta-division-*), se reconstruye en cada corrida.
//
// Uso: DATABASE_URL=... (y el resto de variables de las suites) node test/fase-precuenta-division.mjs
//      SALTAR_UI=1 omite Chrome.
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import assert from 'assert';
import { randomUUID } from 'crypto';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUERTO = process.env.TEST_PORT_PRECUENTA_DIV || '4989';
const CAPTURAS = process.env.CAPTURAS_DIR || join(__dirname, '.capturas-cuenta');
mkdirSync(CAPTURAS, { recursive: true });

const { pool } = await import('../src/services/database.js');
const {
  abrirMesa, agregarItems, enviarComanda, aplicarDescuentoCuenta, estadoDivision, cobrarConsumo, registrarPago, cerrarCuenta,
} = await import('../src/services/restauranteService.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { crearEdge } = await import('../src/services/edgeService.js');
const { crearImpresora, crearRuta } = await import('../src/services/impresionService.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// ── Negocios de prueba ──────────────────────────────────────────────────────
const SLUGS = ['precuenta-division-a', 'precuenta-division-b'];
async function limpiar() {
  const { rows } = await pool.query(`SELECT id FROM negocios WHERE slug = ANY($1)`, [SLUGS]);
  const ids = rows.map(r => r.id);
  if (!ids.length) return;
  const q = (sql) => pool.query(sql, [ids]).catch(() => {});
  await q(`DELETE FROM impresion_trabajos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM impresion_rutas WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM impresoras WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM edge_instalaciones WHERE terminal_id IN (SELECT t.id FROM terminales t JOIN sucursales s ON s.id = t.sucursal_id WHERE s.negocio_id = ANY($1))`);
  await q(`DELETE FROM terminales WHERE sucursal_id IN (SELECT id FROM sucursales WHERE negocio_id = ANY($1))`);
  await q(`DELETE FROM restaurante_item_eventos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM restaurante_cuenta_porciones WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`);
  await q(`DELETE FROM restaurante_cuenta_pagos WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`);
  await q(`DELETE FROM restaurante_cuenta_items WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`);
  await q(`DELETE FROM restaurante_cuentas WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM pedidos_activos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM pedido_emisiones WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM folios_pedido_usados WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM metodos_pago WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM negocio_modulos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM configuracion WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM sucursales WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM usuario_negocios WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM usuarios WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM negocios WHERE id = ANY($1)`);
}
await limpiar();

async function negocio(nombre, slug) {
  const { rows: [n] } = await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ($1, $2) RETURNING id`, [nombre, slug]);
  for (const m of ['restaurante', 'pos', 'usuarios', 'caja']) {
    await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
      ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [n.id, m]);
  }
  for (const [tipo, orden] of [['efectivo', 0], ['terminal', 1]]) {
    await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,$2,TRUE,$3)
      ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [n.id, tipo, orden]);
  }
  await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')`, [n.id]);
  // Las órdenes por persona están encendidas en Obispado y Acuña.
  await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'ordenes_por_persona','true')`, [n.id]);
  return n.id;
}
async function usuario(negocioId, nombre, rol) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,'x') RETURNING id`,
    [negocioId, nombre, `precuenta-div-${rol}-${Math.random().toString(36).slice(2)}@test.local`]);
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,$3)`, [u.id, negocioId, rol]);
  return u.id;
}
const A = await negocio('Precuenta División A', SLUGS[0]);
const B = await negocio('Precuenta División B', SLUGS[1]);
const ADMIN = await usuario(A, 'Admin División', 'admin');
const CAJA = await usuario(A, 'Caja División', 'staff');
const ADMIN_B = await usuario(B, 'Admin B', 'admin');

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 40000 });
const base = srv.base;
const sesion = (usuarioId, negocioId, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;
const cookieAdmin = sesion(ADMIN, A, 'admin');
const cookieCaja = sesion(CAJA, A, 'staff');
const cookieAdminB = sesion(ADMIN_B, B, 'admin');
async function api(path, { cookie = cookieCaja, method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(base + path, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, body: json, setCookie: r.headers.get('set-cookie') };
}
const imprimir = (cuenta, body, opts = {}) => api(`/api/restaurante/cuentas/${cuenta}/precuenta-division`, { method: 'POST', body, ...opts });

let mesa = 1;
const it = (producto, cantidad, precio, extra = {}) => ({ producto, cantidad, precio_unitario: precio, ...extra });
const persona = (numero, nombre = '') => ({ persona: { numero, nombre } });
async function nuevaCuenta(items) {
  const cta = await abrirMesa(A, { mesaNumero: mesa++, personas: 8, meseroUsuarioId: CAJA, abiertaPor: CAJA });
  await agregarItems(cta.id, A, items, CAJA);
  await enviarComanda(cta.id, A, CAJA);
  return cta.id;
}
const renglon = (e, nombre) => e.renglones.find(r => r.producto === nombre);
const centavos = (pesos) => Math.round(Number(pesos) * 100);
async function huella(cuenta) {
  const { rows: [r] } = await pool.query(
    `SELECT c.estado, c.updated_at, c.division_remanente,
            (SELECT count(*) FROM restaurante_cuenta_pagos p WHERE p.cuenta_id = c.id)::int AS pagos,
            (SELECT count(*) FROM restaurante_cuenta_porciones p WHERE p.cuenta_id = c.id)::int AS porciones,
            (SELECT count(*) FROM restaurante_cuenta_items i WHERE i.cuenta_id = c.id)::int AS items
       FROM restaurante_cuentas c WHERE c.id = $1`, [cuenta]);
  return JSON.stringify(r);
}
const MESA_DE_OCHO = () => [
  it('Ensalada César', 1, 150, persona(1, 'Ana')), it('Limonada', 1, 45, persona(1, 'Ana')),
  it('Hamburguesa', 1, 180, persona(2)), it('Refresco', 2, 39, persona(2)),
  it('Chilaquiles', 1, 225, { ...persona(3, 'Luis'), modificadores: ['Salsa: Verde'] }),
  it('Nachos para compartir', 1, 120),
];

try {
  // ═══════════ Una selección: lo que imprime es lo que cobra la caja ═══════════
  await t('SELECCION', '1. con 10 % de descuento y media orden: el total del papel es el importe que el cobro acepta, al centavo', async () => {
    // $225.10 con 10 % deja un neto impar: la media orden cae en medio
    // centavo, justo donde redondear en vez de truncar cobraría otra cifra.
    const cuenta = await nuevaCuenta([it('Protein Pancakes', 1, 169), it('Chilaquiles', 1, 225.10, { modificadores: ['Salsa: Mole'] }), it('Refresco', 4, 39), it('Café Americano', 1, 39)]);
    await aplicarDescuentoCuenta(cuenta, A, { tipo: 'porcentaje', valor: 10, motivo: 'Cliente frecuente' }, { usuarioId: ADMIN, rol: 'admin' });
    const e = await estadoDivision(cuenta, A);
    const seleccion = [
      { itemId: renglon(e, 'Protein Pancakes').id, numerador: 1, denominador: 1 },
      { itemId: renglon(e, 'Refresco').id, cantidad: 2 },
      { itemId: renglon(e, 'Chilaquiles').id, numerador: 1, denominador: 2 },
    ];
    const antes = await huella(cuenta);
    const r = await imprimir(cuenta, { modo: 'seleccion', seleccion });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.destino, 'navegador');
    assert.strictEqual(r.body.precuentas.length, 1);
    const p = r.body.precuentas[0];
    assert.strictEqual(p.precuenta, true);
    assert.strictEqual(p.leyenda, 'CUENTA DIVIDIDA - NO ES COMPROBANTE DE PAGO');
    assert.strictEqual(p.mesa, mesa - 1);
    assert.ok(p.descuento > 0 && p.descuentoMotivo === 'Cliente frecuente', JSON.stringify(p));
    assert.strictEqual(centavos(p.subtotal) - centavos(p.descuento), centavos(p.total));
    assert.ok(p.items.some(i => (i.modificadores || []).includes('Compartido: 1/2')), 'la media orden');
    assert.strictEqual(await huella(cuenta), antes, 'imprimir cambió la cuenta');
    // El mismo importe es el que acepta el cobro: si difiriera un centavo, MONTO_NO_COINCIDE.
    const c = await api(`/api/restaurante/cuentas/${cuenta}/cobros-consumo`, { method: 'POST', body: { seleccion, pagos: [{ metodo: 'terminal', monto: p.total }] } });
    assert.strictEqual(c.status, 201, JSON.stringify(c.body));
    assert.strictEqual(c.body.importe, p.total);
  });

  // ═══════════ Una por persona ═══════════
  let mesaOcho = null;
  await t('PERSONAS', '2. una precuenta por «Orden N» en orden, lo no asignado al final, y la suma es lo que debe la mesa', async () => {
    mesaOcho = await nuevaCuenta(MESA_DE_OCHO());
    const antes = await huella(mesaOcho);
    const r = await imprimir(mesaOcho, { modo: 'personas' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const ps = r.body.precuentas;
    assert.deepStrictEqual(ps.map(p => p.leyenda), [
      'ORDEN 1 - ANA - NO ES COMPROBANTE DE PAGO', 'ORDEN 2 - NO ES COMPROBANTE DE PAGO',
      'ORDEN 3 - LUIS - NO ES COMPROBANTE DE PAGO', 'SIN ASIGNAR - NO ES COMPROBANTE DE PAGO',
    ]);
    assert.deepStrictEqual(ps.map(p => p.total), [195, 258, 225, 120]);
    // Lo capturado en la misma ronda comparte created_at: el orden entre
    // renglones de una persona no es el de captura.
    assert.deepStrictEqual(ps[1].items.map(i => [i.cantidad, i.producto]).sort(), [[1, 'Hamburguesa'], [2, 'Refresco']]);
    const e = await estadoDivision(mesaOcho, A);
    assert.strictEqual(ps.reduce((s, p) => s + centavos(p.total), 0), centavos(e.saldo));
    assert.strictEqual(await huella(mesaOcho), antes, 'imprimir cambió la cuenta');
  });

  await t('PERSONAS', '3. después de cobrarle a la Orden 1, su papel ya no sale y los demás suman el nuevo saldo', async () => {
    const e = await estadoDivision(mesaOcho, A);
    const deAna = e.renglones.filter(r => r.persona?.numero === 1).map(r => ({ itemId: r.id, numerador: 1, denominador: 1 }));
    await cobrarConsumo(mesaOcho, A, { seleccion: deAna, pagos: [{ metodo: 'efectivo', monto: 195 }] }, CAJA);
    const r = await imprimir(mesaOcho, { modo: 'personas' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.precuentas.map(p => p.leyenda.split(' - ')[0]), ['ORDEN 2', 'ORDEN 3', 'SIN ASIGNAR']);
    const e2 = await estadoDivision(mesaOcho, A);
    assert.strictEqual(r.body.precuentas.reduce((s, p) => s + centavos(p.total), 0), centavos(e2.saldo));
  });

  // ═══════════ Quién puede y qué se rechaza ═══════════
  await t('PERMISOS', '4. el mesero de tablet la imprime; otro negocio recibe 404 como si no existiera', async () => {
    const meseroId = (await api('/api/admin/usuarios', { cookie: cookieAdmin, method: 'POST', body: { tipo: 'mesero', nombre: 'Mesero División', pin: '4826' } })).body?.id;
    assert.ok(meseroId, 'no se creó el mesero');
    const login = await api('/api/auth/mesero/login', { cookie: null, method: 'POST', body: { negocio: SLUGS[0], meseroUsuarioId: meseroId, pin: '4826' } });
    assert.strictEqual(login.status, 200, JSON.stringify(login.body));
    const cookieTablet = login.setCookie.split(';')[0];
    const r = await imprimir(mesaOcho, { modo: 'personas' }, { cookie: cookieTablet });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const ajeno = await imprimir(mesaOcho, { modo: 'personas' }, { cookie: cookieAdminB });
    assert.strictEqual(ajeno.status, 404, JSON.stringify(ajeno.body));
    const sinSesion = await imprimir(mesaOcho, { modo: 'personas' }, { cookie: null });
    assert.ok([401, 403].includes(sinSesion.status) || (sinSesion.status >= 300 && sinSesion.status < 400), `sin sesión: ${sinSesion.status}`);
  });

  await t('ERRORES', '5. modo inválido, selección vacía, más de lo pendiente y una cuenta sin personas', async () => {
    assert.strictEqual((await imprimir(mesaOcho, { modo: 'todo' })).body?.code, 'MODO_INVALIDO');
    const vacia = await imprimir(mesaOcho, { modo: 'seleccion', seleccion: [] });
    assert.deepStrictEqual([vacia.status, vacia.body?.code], [400, 'SELECCION_VACIA']);
    const e = await estadoDivision(mesaOcho, A);
    const pagada = await imprimir(mesaOcho, { modo: 'seleccion', seleccion: [{ itemId: renglon(e, 'Ensalada César').id, numerador: 1, denominador: 2 }] });
    assert.deepStrictEqual([pagada.status, pagada.body?.code], [409, 'CONSUMO_YA_PAGADO']);
    const sinPersonas = await nuevaCuenta([it('Tacos', 3, 25), it('Agua', 1, 30)]);
    const r = await imprimir(sinPersonas, { modo: 'personas' });
    assert.deepStrictEqual([r.status, r.body?.code], [409, 'SIN_PERSONAS']);
    // La selección sí funciona sin personas.
    const e2 = await estadoDivision(sinPersonas, A);
    const s = await imprimir(sinPersonas, { modo: 'seleccion', seleccion: [{ itemId: renglon(e2, 'Tacos').id, cantidad: 2 }] });
    assert.strictEqual(s.body?.precuentas?.[0]?.total, 50, JSON.stringify(s.body));
  });

  await t('ERRORES', '6. con el remanente en partes iguales o un abono suelto ya no se imprime por consumo; cerrada, tampoco', async () => {
    const conParte = await nuevaCuenta(MESA_DE_OCHO());
    const parte = await api(`/api/restaurante/cuentas/${conParte}/cobros-partes`, { method: 'POST', body: { partes: 3, pagos: [{ metodo: 'terminal', monto: (195 + 258 + 225 + 120) / 3 }] } });
    assert.strictEqual(parte.status, 201, JSON.stringify(parte.body));
    const r1 = await imprimir(conParte, { modo: 'personas' });
    assert.deepStrictEqual([r1.status, r1.body?.code], [409, 'REMANENTE_DIVIDIDO']);
    const conAbono = await nuevaCuenta(MESA_DE_OCHO());
    await registrarPago(conAbono, A, { metodo: 'efectivo', monto: 100 }, CAJA);
    const r2 = await imprimir(conAbono, { modo: 'personas' });
    assert.deepStrictEqual([r2.status, r2.body?.code], [409, 'REMANENTE_DIVIDIDO']);
    const cerrada = await nuevaCuenta([it('Café', 1, 39)]);
    await registrarPago(cerrada, A, { metodo: 'efectivo', monto: 39 }, CAJA);
    await cerrarCuenta(cerrada, A, CAJA);
    const r3 = await imprimir(cerrada, { modo: 'seleccion', seleccion: 'resto' });
    assert.deepStrictEqual([r3.status, r3.body?.code], [409, 'CUENTA_NO_ABIERTA']);
  });

  // ═══════════ Pantalla ═══════════
  if (process.env.SALTAR_UI) console.log('  --  [UI] omitida (SALTAR_UI)'); else await t('UI', '7. en Chrome: los dos botones, la precuenta de la selección y una hoja por persona en UN diálogo', async () => {
    const puppeteer = (await import('puppeteer')).default;
    const cuenta = await nuevaCuenta(MESA_DE_OCHO());
    const nav = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
      const pag = await nav.newPage();
      const errores = [];
      pag.on('pageerror', e => errores.push(e.message));
      await pag.setViewport({ width: 1024, height: 900 });
      await pag.setCookie({ name: 'xabor_sesion', value: encodeURIComponent(crearTokenSesion({ usuarioId: CAJA, negocioId: A, rol: 'staff' })), domain: 'localhost', path: '/' });
      await pag.goto(`${base}/restaurante`, { waitUntil: 'networkidle0', timeout: 60000 });
      await pag.waitForSelector('#grid .mesa', { timeout: 15000 });
      // Cada documento que se manda a imprimir queda registrado con lo que
      // midió la página: alto de la hoja más larga y el @page que fijó.
      await pag.evaluate(() => {
        window.__impresos = [];
        new MutationObserver(muts => {
          for (const m of muts) for (const n of m.addedNodes) {
            if (n.tagName !== 'IFRAME') continue;
            const reg = { html: n.srcdoc, pagina: null, hojasMm: [] };
            window.__impresos.push(reg);
            const espiar = setInterval(() => {
              const doc = n.contentDocument;
              const estilo = doc && [...doc.querySelectorAll('style')].map(s => s.textContent).find(s => s.startsWith('@page{size:80mm'));
              if (!estilo) return;
              reg.pagina = estilo;
              reg.hojasMm = [...doc.querySelectorAll('.hoja')].map(h => h.getBoundingClientRect().height * 25.4 / 96);
              clearInterval(espiar);
            }, 10);
          }
        }).observe(document.body, { childList: true });
      });
      await pag.evaluate((id) => abrirCuenta(id), cuenta);
      await pag.waitForFunction(() => document.getElementById('cu-secundarias')?.textContent.includes('Dividir cuenta'), { timeout: 15000 });
      await pag.evaluate(() => abrirDividir());
      await pag.waitForFunction(() => document.getElementById('dlg-dividir').open && document.querySelectorAll('#dv-cuerpo .dv-renglon').length === 6, { timeout: 15000 });
      assert.strictEqual(await pag.$eval('#dv-imprimir-sel', b => b.disabled), true, 'Imprimir selección sin nada elegido');
      assert.ok(await pag.$('#dv-imprimir-personas'), 'falta «Imprimir una por persona»');
      const tx = await pag.$eval('#dv-cuerpo', el => el.textContent.replace(/\s+/g, ' '));
      assert.ok(tx.includes('Orden 1 — Ana') && tx.includes('Orden 3 — Luis'), 'cada renglón dice de quién es');
      // Selección: la hamburguesa y un refresco de la Orden 2.
      await pag.evaluate(() => {
        const fila = (n) => [...document.querySelectorAll('.dv-renglon')].find(x => x.textContent.includes(n)).dataset.item;
        dvToggle(fila('Hamburguesa')); dvUnidades(fila('Refresco'), 1);
      });
      await pag.waitForFunction(() => document.getElementById('dv-sel-total')?.textContent === '$219.00', { timeout: 5000 });
      await pag.screenshot({ path: join(CAPTURAS, 'precuenta-division-1-botones.png') });
      await pag.click('#dv-imprimir-sel');
      await pag.waitForFunction(() => window.__impresos.length === 1 && window.__impresos[0].pagina, { timeout: 10000 });
      const sel = await pag.evaluate(() => window.__impresos[0]);
      assert.ok(sel.html.includes('PRECUENTA') && sel.html.includes('CUENTA DIVIDIDA - NO ES COMPROBANTE DE PAGO') && sel.html.includes('$219.00'), sel.html.slice(0, 400));
      assert.strictEqual((sel.html.match(/<section class="hoja">/g) || []).length, 1, 'la selección es UNA hoja');
      assert.ok(await pag.$eval('#dv-sel-total', el => el.textContent) === '$219.00', 'imprimir borró la selección');
      // Una por persona: un diálogo, cuatro hojas, la página mide la más larga.
      await pag.click('#dv-imprimir-personas');
      await pag.waitForFunction(() => window.__impresos.length === 2 && window.__impresos[1].pagina, { timeout: 10000 });
      const todas = await pag.evaluate(() => window.__impresos[1]);
      assert.strictEqual((todas.html.match(/<section class="hoja">/g) || []).length, 4, 'una hoja por persona');
      for (const l of ['ORDEN 1 - ANA', 'ORDEN 2 -', 'ORDEN 3 - LUIS', 'SIN ASIGNAR']) assert.ok(todas.html.includes(l), `falta ${l}`);
      const altoPagina = Number(todas.pagina.match(/size:80mm (\d+)mm/)[1]);
      assert.strictEqual(todas.hojasMm.length, 4);
      assert.ok(altoPagina >= Math.max(...todas.hojasMm), `la página (${altoPagina} mm) es más corta que la hoja más larga (${Math.max(...todas.hojasMm)} mm)`);
      assert.ok(altoPagina <= Math.max(...todas.hojasMm) + 10, 'la página mide más que la hoja más larga + margen');
      await pag.waitForFunction(() => (document.getElementById('msg')?.textContent || '').includes('4 precuentas'), { timeout: 5000 });
      await pag.screenshot({ path: join(CAPTURAS, 'precuenta-division-2-por-persona.png') });
      assert.deepStrictEqual(errores, [], 'errores de JavaScript en la pantalla');
    } finally { await nav.close(); }
  });

  // ═══════════ Con impresora de Caja: Edge, solo Caja, idempotente ═══════════
  await t('EDGE', '8. con Caja configurada va por Edge solo a Caja, nunca a cocina; la misma solicitud no duplica papel', async () => {
    const edge = await crearEdge(A, { nombre: 'PC Caja División' });
    const cocina = await crearImpresora(A, { terminalId: edge.id, nombre: 'COCINA', transporte: 'mock' });
    const caja = await crearImpresora(A, { terminalId: edge.id, nombre: 'CAJA', transporte: 'mock' });
    await crearRuta(A, { impresoraId: cocina.id, ambito: 'documento', clave: 'comanda' });
    await crearRuta(A, { impresoraId: caja.id, ambito: 'documento', clave: 'cuenta' });
    const cuenta = await nuevaCuenta(MESA_DE_OCHO());
    const solicitudId = randomUUID();
    const r = await imprimir(cuenta, { modo: 'personas', solicitudId });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.destino, r.body.documentos, r.body.enviados, r.body.creados, r.body.duplicados], ['edge', 4, 4, 4, 0]);
    assert.ok(!r.body.precuentas, 'por Edge no se devuelve nada que imprima el navegador');
    const trabajos = async () => (await pool.query(
      `SELECT impresora_nombre, documento, payload FROM impresion_trabajos
        WHERE negocio_id = $1 AND origen_tipo = 'restaurante_precuenta_division' AND origen_id LIKE $2 ORDER BY origen_id`,
      [A, `${cuenta}:%`])).rows;
    const filas = await trabajos();
    assert.strictEqual(filas.length, 4);
    assert.ok(filas.every(f => f.impresora_nombre === 'CAJA' && f.documento === 'cuenta'), JSON.stringify(filas.map(f => [f.impresora_nombre, f.documento])));
    assert.deepStrictEqual(filas.map(f => f.payload.leyenda.split(' - ')[0]), ['ORDEN 1', 'ORDEN 2', 'ORDEN 3', 'SIN ASIGNAR']);
    const otraVez = await imprimir(cuenta, { modo: 'personas', solicitudId });
    assert.deepStrictEqual([otraVez.body.creados, otraVez.body.duplicados], [0, 4]);
    assert.strictEqual((await trabajos()).length, 4, 'un reintento sacó papel de más');
    const nueva = await imprimir(cuenta, { modo: 'personas' });
    assert.strictEqual(nueva.body.creados, 4);
    assert.strictEqual((await trabajos()).length, 8, 'otro toque deliberado sí imprime otra vez');
    const { rows: [cocinaN] } = await pool.query(
      `SELECT count(*)::int AS n FROM impresion_trabajos WHERE negocio_id = $1 AND impresora_nombre = 'COCINA' AND origen_tipo = 'restaurante_precuenta_division'`, [A]);
    assert.strictEqual(cocinaN.n, 0, 'una precuenta llegó a cocina');
  });
} finally {
  console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
  if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
  srv.detener();
  await limpiar().catch(() => {});
  await pool.end();
  process.exitCode = fallidas > 0 ? 1 : 0;
}
