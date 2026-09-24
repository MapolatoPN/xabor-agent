// El panel del cajero, en un navegador de verdad contra el servidor real.
//
// Regla del dueño (2026-09-24, Fase 3.3 del menú): el cajero ve Pedidos
// (En curso e Historial), Mesas, Chats (Conversaciones), Cotizaciones y
// Facturación, crea pedidos y cotizaciones, y nunca ve totales de ventas. Al
// iniciar el día no entra al panel sin registrar el fondo de caja.
//
// Lo que solo esta suite comprueba (fase-permisos-cajero cubre las rutas una
// por una; fase-sidebar-plegable y la paridad del celular, el markup):
//   · que la ventana del fondo aparezca al entrar, tape el panel y, con el
//     fondo registrado, ya no vuelva a salir;
//   · que el cajero recorra TODAS sus pantallas sin que el servidor le
//     responda "permiso insuficiente" ni una sola vez (una pantalla suya que
//     pidiera algo de admin fallaría en silencio);
//   · que nunca se pidan los totales de ventas ni el corte;
//   · que en Facturación no vea la configuración ni el monto timbrado, y en
//     Chats no vea el Bot.
//
// Enciende para el negocio de prueba los módulos que recorre y al final los
// deja como estaban; lo mismo el fondo de hoy. Borra el cajero que crea.
//
// Uso: node test/fase-cajero-panel.mjs   (TEST_PORT_CAJERO_PANEL fija el puerto)
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import puppeteer from 'puppeteer';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_CAJERO_PANEL || '4798';
const A = SEED.negocioA;

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, crearUsuarioConPassword } = await import('../src/services/database.js');

// Módulos que recorre el cajero: se encienden y al final se restauran.
const MODULOS_PRUEBA = ['pos', 'caja', 'whatsapp', 'restaurante', 'cotizaciones', 'generador_cotizaciones', 'facturacion'];
const { rows: modulosAntes } = await pool.query(
  'SELECT modulo, estado FROM negocio_modulos WHERE negocio_id = $1 AND modulo = ANY($2)', [A, MODULOS_PRUEBA]);
for (const modulo of MODULOS_PRUEBA) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1, $2, 'activo')
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [A, modulo]);
}
// La tasa de IVA de las cotizaciones (se precarga al crear una): 16 durante
// la prueba, y al final como estaba.
const { rows: ivaAntes } = await pool.query("SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'iva_pct_default'", [A]);
await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, 'iva_pct_default', '16')
  ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = '16'`, [A]);
const cajero = await crearUsuarioConPassword({
  negocioId: A, nombre: 'Cajero navegador', email: `cajero-panel-${Date.now()}@xabor.test`,
  password: 'contrasena-de-prueba-5', rol: 'cajero',
});
const token = crearTokenSesion({ usuarioId: cajero.id, negocioId: A, rol: 'cajero' });

const srv = await arrancarServidor({ PORT: PUERTO });
const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
let fondoHoy = null, fondoAntes = null;
try {
  // Estado limpio del fondo de hoy (se restaura al final).
  const r0 = await fetch(srv.base + '/api/caja/fondo', { headers: { Cookie: `xabor_sesion=${encodeURIComponent(token)}` } });
  fondoHoy = (await r0.json()).fecha;
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(fondoHoy || ''), `no se supo qué día es hoy para el negocio (${r0.status})`);
  const { rows } = await pool.query('SELECT fondo FROM caja_fondos WHERE negocio_id = $1 AND fecha = $2', [A, fondoHoy]);
  fondoAntes = rows[0] ? rows[0].fondo : null;
  await pool.query('DELETE FROM caja_fondos WHERE negocio_id = $1 AND fecha = $2', [A, fondoHoy]);

  const page = await navegador.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.setCookie({ name: 'xabor_sesion', value: encodeURIComponent(token), domain: 'localhost', path: '/' });
  const prohibidas = [], pedidas = [], errores = [], dialogos = [];
  page.on('response', (r) => {
    const url = r.url().replace(srv.base, '');
    if (url.startsWith('/api/') || url.startsWith('/pedidos')) pedidas.push(url.split('?')[0]);
    if (r.status() === 403) prohibidas.push(`${r.request().method()} ${url}`);
  });
  page.on('pageerror', (e) => errores.push(e.message));
  page.on('dialog', (d) => { dialogos.push(d.message()); d.dismiss().catch(() => {}); });
  const vis = (sel) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || n.hidden) return false;
    }
    return true;
  }, sel);

  await t('1. al entrar, la ventana del fondo tapa el panel; con el fondo registrado se va', async () => {
    await page.goto(srv.base + '/app', { waitUntil: 'networkidle2' });
    await page.waitForSelector('#modal-fondo-dia', { visible: true, timeout: 10000 });
    const tapa = await page.evaluate(() => {
      const m = document.getElementById('modal-fondo-dia').getBoundingClientRect();
      const encima = document.elementFromPoint(innerWidth / 2, 20);
      return { ancho: Math.round(m.width), alto: Math.round(m.height), encima: !!encima?.closest('#modal-fondo-dia') };
    });
    assert.ok(tapa.ancho >= 1300 && tapa.alto >= 700 && tapa.encima, `la ventana no tapa el panel: ${JSON.stringify(tapa)}`);
    // Sin monto no se puede empezar.
    await page.click('#fondo-dia-btn');
    const error = await page.$eval('#fondo-dia-error', el => el.textContent.trim());
    assert.ok(error.length > 0 && await vis('#modal-fondo-dia'), 'sin monto dejó pasar');
    await page.type('#fondo-dia-monto', '1500');
    await page.click('#fondo-dia-btn');
    await page.waitForFunction(() => !document.getElementById('modal-fondo-dia'), { timeout: 10000 });
    const { rows: guardado } = await pool.query('SELECT fondo FROM caja_fondos WHERE negocio_id = $1 AND fecha = $2', [A, fondoHoy]);
    assert.strictEqual(Number(guardado[0]?.fondo), 1500, `el fondo no quedó en la base: ${JSON.stringify(guardado)}`);
    // Otra vez el mismo día: ya no se pide.
    await page.goto('about:blank');
    await page.goto(srv.base + '/app', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => typeof MODULOS !== 'undefined' && MODULOS.length > 0 && document.querySelector('.tab-btn.activo'));
    await new Promise(r => setTimeout(r, 800));
    assert.ok(!(await page.$('#modal-fondo-dia')), 'con el fondo ya registrado la ventana volvió a salir');
  });

  await t('2. en el menú ve Pedidos, Mesas, Chats, Cotizaciones y Facturación; nada más', async () => {
    const menu = await page.evaluate(() => [...document.querySelectorAll('#tabs-nav .tab-btn')]
      .filter(b => b.style.display !== 'none').map(b => b.id));
    assert.deepStrictEqual(menu, ['tab-comandas', 'tab-restaurante', 'tab-chats', 'tab-cotizaciones', 'tab-facturacion'],
      `menú del cajero: ${menu.join(', ')}`);
    assert.ok(await vis('.nav-nuevo-pedido') || await vis('#btn-nuevo-pedido') || await page.evaluate(() =>
      [...document.querySelectorAll('button')].some(b => /Nuevo pedido/.test(b.textContent) && b.offsetParent)),
      'el cajero no tiene "+ Nuevo pedido"');
  });

  await t('3. Pedidos: En curso e Historial (sin Domicilio); Chats: Conversaciones (sin el Bot)', async () => {
    await page.click('#tab-comandas');
    assert.ok(await vis('#pest-comandas') && await vis('#pest-historial') && !(await vis('#pest-repartidores')),
      'pestañas de Pedidos del cajero');
    await page.click('#pest-historial');
    await page.waitForFunction(() => !/Cargando/.test(document.getElementById('historial-lista')?.textContent || 'Cargando'), { timeout: 8000 });
    assert.ok(await vis('#vista-historial'), 'el Historial no se abrió');
    await page.click('#tab-chats');
    await new Promise(r => setTimeout(r, 800));
    assert.ok(await vis('#vista-chats'), 'Chats no se abrió');
    assert.ok(!(await vis('#pest-entrenamiento')), 'el cajero ve la pestaña del Bot');
    assert.ok(!(await vis('#chats-banner-bot')), 'el cajero ve la tarjeta del Bot');
    // El negocio de prueba no tiene credenciales de WhatsApp, y sin ellas el
    // panel no pide conversaciones. Se simula uno configurado para recorrer
    // lo que el cajero haría: la bandeja, el contador y una conversación.
    await page.evaluate(async () => {
      WHATSAPP_CONFIGURADO = true;
      await cargarConversaciones();
      refrescarSinResponder();
      await cargarBannerBotChats();
      await abrirConversacion('5218789990432', 'Cliente de prueba');
    });
    await new Promise(r => setTimeout(r, 1500));
  });

  await t('4. Mesas se abre dentro del panel; Cotizaciones deja crear', async () => {
    await page.click('#tab-restaurante');
    await page.waitForFunction(() => document.getElementById('marco-mesas')?.contentDocument?.readyState === 'complete', { timeout: 10000 });
    await new Promise(r => setTimeout(r, 1200));
    assert.ok(await vis('#vista-restaurante'), 'Mesas no se abrió');
    await page.evaluate(() => document.getElementById('tab-cotizaciones').click());
    await new Promise(r => setTimeout(r, 800));
    assert.ok(await vis('#vista-cotizaciones'), 'Cotizaciones no se abrió');
    assert.ok(await vis('#vista-cotizaciones [data-modulo="generador_cotizaciones"]'), 'el cajero no ve "+ Crear cotización"');
    // Al crear, el formulario precarga la tasa de IVA del negocio (antes la
    // leía de la configuración completa, que es solo del admin).
    await page.click('#vista-cotizaciones [data-modulo="generador_cotizaciones"]');
    await page.waitForFunction(() => document.getElementById('cot-iva-pct')?.value === '16', { timeout: 5000 })
      .catch(async () => { throw new Error(`IVA precargado: «${await page.$eval('#cot-iva-pct', el => el.value)}»`); });
    await page.evaluate(() => { document.getElementById('modal-cotizacion-overlay').style.display = 'none'; });
  });

  await t('5. Facturación sin la configuración ni el monto timbrado', async () => {
    await page.evaluate(() => document.getElementById('tab-facturacion').click());
    await new Promise(r => setTimeout(r, 1200));
    assert.ok(await vis('[data-facturacion-section="facturas"]'), 'Facturas no se abrió');
    assert.ok(!(await vis('[data-facturacion-pane="configuracion"]')), 'el cajero ve la pestaña de configuración');
    assert.ok(!(await vis('#facturacion-kpi-monto')), 'el cajero ve el monto timbrado');
    await page.evaluate(() => { location.hash = '#facturacion/configuracion'; });
    await new Promise(r => setTimeout(r, 600));
    assert.ok(!(await vis('[data-facturacion-section="configuracion"]')), 'por dirección llegó a la configuración de Facturación');
  });

  await t('6. en todo el recorrido el servidor nunca le dijo "permiso insuficiente", ni se pidieron totales', async () => {
    assert.deepStrictEqual(prohibidas, [], `respuestas 403: ${prohibidas.join(' | ')}`);
    assert.deepStrictEqual(dialogos, [], `avisos emergentes: ${dialogos.join(' | ')}`);
    const totales = pedidas.filter(u => /^\/api\/(ventas|corte-caja|admin\/reporte-diario|admin\/clientes\/v2\/resumen|rewards\/resumen)/.test(u));
    assert.deepStrictEqual(totales, [], `el panel del cajero pidió totales: ${totales.join(', ')}`);
    const recorrido = ['/api/conversaciones', '/api/conversacion/5218789990432', '/api/conversacion/5218789990432/estado-bot',
      '/api/historial', '/api/cotizaciones', '/api/restaurante/mesas', '/api/admin/facturacion/recibos', '/api/caja/fondo'];
    const faltan = recorrido.filter(u => !pedidas.includes(u));
    assert.deepStrictEqual(faltan, [], `el recorrido no pasó por sus pantallas (la prueba no probaría nada): faltó ${faltan.join(', ')}`);
    assert.ok(!pedidas.includes('/api/bot-whatsapp'), 'el panel del cajero pidió el estado del Bot (es del admin)');
    assert.deepStrictEqual(errores, [], `errores de JavaScript: ${errores.slice(0, 3).join(' | ')}`);
  });
} finally {
  await navegador.close().catch(() => {});
  srv.detener();
  if (fondoHoy) {
    await pool.query('DELETE FROM caja_fondos WHERE negocio_id = $1 AND fecha = $2', [A, fondoHoy]).catch(() => {});
    if (fondoAntes !== null) await pool.query('INSERT INTO caja_fondos (fecha, fondo, negocio_id) VALUES ($1, $2, $3)', [fondoHoy, fondoAntes, A]).catch(() => {});
  }
  if (ivaAntes[0]) await pool.query("UPDATE configuracion SET valor = $2 WHERE negocio_id = $1 AND clave = 'iva_pct_default'", [A, ivaAntes[0].valor]).catch(() => {});
  else await pool.query("DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'iva_pct_default'", [A]).catch(() => {});
  for (const modulo of MODULOS_PRUEBA) {
    const antes = modulosAntes.find(m => m.modulo === modulo);
    if (antes) await pool.query('UPDATE negocio_modulos SET estado = $3 WHERE negocio_id = $1 AND modulo = $2', [A, modulo, antes.estado]).catch(() => {});
    else await pool.query('DELETE FROM negocio_modulos WHERE negocio_id = $1 AND modulo = $2', [A, modulo]).catch(() => {});
  }
  await pool.query('DELETE FROM usuario_negocios WHERE usuario_id = $1', [cajero.id]).catch(() => {});
  await pool.query('DELETE FROM usuarios WHERE id = $1', [cajero.id]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
