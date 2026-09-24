// ─── Tab Clientes (CRM) en el panel: recorrido en NAVEGADOR ────────────────
//
// La suite de API demuestra que /api/admin/clientes/v2 aísla y calcula bien.
// Esta demuestra que el dueño, desde el panel, ve a su gente: entra al tab
// Clientes, ve las tarjetas, busca, filtra por origen, abre la ficha con
// Rewards, direcciones, pedidos, marketing y cuenta, y las campañas siguen
// donde estaban. Escritorio y tablet. Deja capturas en test/.capturas-cuenta/.
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import puppeteer from 'puppeteer';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4792';
const CAPTURAS = process.env.CAPTURAS_DIR || join(__dirname, '.capturas-cuenta');
mkdirSync(CAPTURAS, { recursive: true });

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { guardarDireccion, registrarConsentimiento, vincularRewards } = await import('../src/services/clientesNegocio.js');
const { crearSesion } = await import('../src/services/clienteAuth.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const espera = (ms) => new Promise(r => setTimeout(r, ms));

const A = SEED.negocioA;
const TEL = '8791000001';
const dias = (n) => new Date(Date.now() - n * 86400000).toISOString();

// ── Fixture: una persona completa en A ──
await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = $1 AND folio LIKE 'CRMUI-%'`, [A]);
await pool.query(`DELETE FROM clientes_negocio WHERE negocio_id = $1 AND telefono = $2`, [A, TEL]);
await pool.query(`DELETE FROM rewards_accounts WHERE tenant_id = $1 AND telefono = $2`, [A, TEL]);
await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'rewards','activo') ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [A]);
await pool.query(`INSERT INTO rewards_config (tenant_id, activo, monto_por_punto, puntos_por_peso, canje_minimo, canal_tienda) VALUES ($1,TRUE,10,0.5,100,TRUE) ON CONFLICT (tenant_id) DO UPDATE SET activo=TRUE`, [A]);
const { rows: [cli] } = await pool.query(
  `INSERT INTO clientes_negocio (negocio_id, telefono, nombre, email, origen) VALUES ($1,$2,'CRMUI Persona Uno','uno@crmui.test','tienda') RETURNING *`, [A, TEL]);
await crearSesion({ negocioId: A, clienteId: cli.id, ip: '127.0.0.1', userAgent: 'suite' });
await guardarDireccion(A, cli.id, { alias: 'Casa', calle: 'Av. CRMUI', numeroExterior: '10', colonia: 'Centro', referencia: 'Portón verde' });
await registrarConsentimiento(A, cli.id, { canal: 'whatsapp', otorgado: true, fuente: 'mi_cuenta' });
await pool.query(`INSERT INTO clientes (telefono) VALUES ($1) ON CONFLICT (telefono) DO NOTHING`, [TEL]);
await pool.query(`INSERT INTO rewards_accounts (telefono, tenant_id, negocio_id, puntos_balance, puntos_acumulados_total) VALUES ($1,$2,$3::uuid,250,250)
  ON CONFLICT (telefono, tenant_id) DO UPDATE SET puntos_balance=250, puntos_acumulados_total=250, cliente_id=NULL`, [TEL, A, A]);
await vincularRewards({ id: cli.id, negocio_id: A, telefono: TEL });
const pedido = (folio, tel, canal, total, hace) => pool.query(
  `INSERT INTO pedidos_activos (folio, estado, datos, created_at, updated_at, negocio_id) VALUES ($1,'entregado',$2,$3,$3,$4)`,
  [folio, JSON.stringify({ canal, modalidad: 'entrega a domicilio', total, forma_pago: 'efectivo', cliente: { nombre: 'CRMUI Persona Uno', telefono: tel }, items: [{ nombre: 'Producto', cantidad: 1, precio: total }] }), dias(hace), A]);
await pedido('CRMUI-A-1', '521' + TEL, 'whatsapp', 180, 12);
await pedido('CRMUI-A-2', TEL, 'tienda_online', 220, 3);

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 40000 });
const token = crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: A, rol: 'admin' });
const nav = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const texto = (pag, sel) => pag.$eval(sel, el => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
const captura = (pag, nombre) => pag.screenshot({ path: join(CAPTURAS, nombre + '.png') });

try {
  for (const [etiqueta, ancho, alto] of [['desktop', 1280, 900], ['tablet', 768, 1024]]) {
    const contexto = await nav.createBrowserContext();
    const pag = await contexto.newPage();
    const errs = [];
    pag.on('pageerror', e => errs.push(e.message));
    pag.on('dialog', d => d.accept().catch(() => {}));
    await pag.setViewport({ width: ancho, height: alto });
    await pag.setCookie({ name: 'xabor_sesion', value: encodeURIComponent(token), domain: 'localhost', path: '/' });

    await t(etiqueta, 'el tab Clientes sigue en el sidebar y abre el CRM con sus tarjetas y su lista', async () => {
      await pag.goto(srv.base + '/app', { waitUntil: 'networkidle0' });
      await pag.waitForSelector('#tab-clientes', { timeout: 10000 });
      assert.strictEqual(await texto(pag, '#tab-clientes'), 'Clientes');
      await pag.evaluate(() => mostrarTab('clientes'));
      await pag.waitForSelector('#vista-clientes[style*="display: block"], #vista-clientes:not([style*="display: none"])', { timeout: 8000 });
      await pag.waitForFunction(() => document.querySelectorAll('#cli-tarjetas > div').length >= 6, { timeout: 10000 });
      await pag.waitForFunction(() => /de \d+/.test(document.getElementById('cli-paginacion')?.textContent || '') || /Sin resultados/.test(document.getElementById('cli-lista')?.textContent || ''), { timeout: 10000 });
      const tarjetas = await texto(pag, '#cli-tarjetas');
      for (const l of ['Clientes', 'Con cuenta en la tienda', 'Compraron · 30 días', 'Con Rewards', 'Aceptan promos por WhatsApp']) assert.ok(tarjetas.includes(l), 'falta tarjeta: ' + l);
      const cab = await texto(pag, '#cli-lista thead');
      for (const c of ['Cliente', 'Contacto', 'Origen', 'Alta', 'Última compra', 'Pedidos', 'Ticket', 'Total', 'Puntos', 'Promos']) assert.ok(cab.includes(c), 'falta columna: ' + c);
      assert.ok(!(await pag.$('#cli-resumen')), 'los chips viejos de segmento ya no existen');
      assert.ok(await pag.$('details#cli-whatsapp:not([open])'), 'la actividad de WhatsApp va plegada');
      await captura(pag, `crm-${etiqueta}-1-lista`);
    });

    await t(etiqueta, 'buscar por nombre trae a la persona con su origen, cuenta, puntos y consentimiento', async () => {
      await pag.click('#cli-buscar', { clickCount: 3 });
      await pag.type('#cli-buscar', 'CRMUI');
      await pag.waitForFunction(() => document.querySelectorAll('#cli-lista tbody tr').length === 1, { timeout: 10000 });
      const fila = await texto(pag, '#cli-lista tbody tr');
      assert.ok(fila.includes('CRMUI Persona Uno'), fila);
      assert.ok(fila.includes('879 100 0001') && fila.includes('uno@crmui.test'), 'contacto');
      assert.ok(fila.includes('Tienda'), 'origen Tienda');
      assert.ok(fila.includes('● cuenta'), 'tiene cuenta en la tienda');
      assert.ok(fila.includes('250'), 'puntos');
      assert.ok(fila.includes('WA ✓'), 'consentimiento WhatsApp');
      assert.ok(fila.includes('$400') && fila.includes('$200'), 'total $400 y ticket $200: ' + fila);
      assert.ok((await texto(pag, '#cli-paginacion')).includes('1–1 de 1'));
      await captura(pag, `crm-${etiqueta}-2-busqueda`);
    });

    await t(etiqueta, 'el filtro de origen se aplica en el servidor', async () => {
      await pag.select('#cli-origen', 'rewards');
      await pag.waitForFunction(() => /Sin resultados/.test(document.getElementById('cli-lista').textContent), { timeout: 10000 });
      await pag.select('#cli-origen', '');
      await pag.waitForFunction(() => document.querySelectorAll('#cli-lista tbody tr').length === 1, { timeout: 10000 });
    });

    await t(etiqueta, 'la ficha muestra resumen, Rewards, direcciones, pedidos, marketing y cuenta', async () => {
      await pag.click('#cli-lista tbody tr');
      await pag.waitForFunction(() => /Cuenta en la tienda/.test(document.getElementById('cli-ficha-contenido').textContent), { timeout: 10000 });
      const f = await texto(pag, '#cli-ficha-contenido');
      for (const s of ['Rewards', 'Direcciones', 'Pedidos', 'Marketing', 'Cuenta en la tienda']) assert.ok(f.includes(s), 'falta sección ' + s);
      assert.ok(f.includes('Cliente desde') && f.includes('Primera compra') && f.includes('Última compra'));
      assert.ok(f.includes('250 pts'), 'saldo Rewards');
      assert.ok(f.includes('Casa') && f.includes('Av. CRMUI 10 Centro') && f.includes('Predeterminada'), 'dirección');
      assert.ok(f.includes('#CRMUI-A-1') && f.includes('#CRMUI-A-2') && f.includes('whatsapp') && f.includes('Entregado'), 'pedidos');
      assert.ok(f.includes('Promociones por WhatsApp: sí') && f.includes('Promociones por correo: no'), 'marketing');
      assert.ok(f.includes('sesiones activas: 1'), 'cuenta');
      assert.ok(f.includes('Escribir por WhatsApp'));
      await captura(pag, `crm-${etiqueta}-3-ficha`);
      await pag.click('#cli-modal button');
      await pag.waitForFunction(() => document.getElementById('cli-modal').style.display === 'none', { timeout: 5000 });
    });

    // Desde la Fase 2.3 del menú, las campañas tienen su propia pestaña
    // (Clientes › Campañas): mismo botón, mismo historial, mismo formulario.
    await t(etiqueta, 'las campañas viven en su pestaña de Clientes y no hay errores de JavaScript', async () => {
      assert.ok(await pag.$('#campana-modal'), 'modal de campañas');
      assert.ok(await pag.$('#cli-campanas'), 'historial de campañas');
      assert.ok((await texto(pag, '#vista-campanas')).includes('Historial de campañas'));
      assert.ok(await pag.$('#pestanas-clientes #pest-campanas'), 'falta la pestaña Campañas en Clientes');
      assert.deepStrictEqual(errs, []);
    });
    await contexto.close();
  }
} finally {
  await nav.close();
  console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
  if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
  console.log(`Capturas en: ${CAPTURAS}`);
  await srv.detener();
  await pool.end();
  process.exitCode = fallidas > 0 ? 1 : 0;
}
