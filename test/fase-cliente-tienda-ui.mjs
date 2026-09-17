// ─── Cuenta del cliente en la tienda: recorrido en NAVEGADOR ──────────────
//
// La suite de API (fase-cliente-tienda.mjs) demuestra que el servidor hace lo
// correcto. Esta demuestra que una persona, con el dedo, puede hacerlo: entrar
// con su teléfono y un código, guardar una dirección, ver sus puntos y comprar
// eligiendo "Enviar a: Casa" sin escribir nada -- en un teléfono de 375px, en
// uno de 390, en una tablet y en escritorio. Y que el invitado sigue comprando
// como siempre.
//
// Deja capturas en test/.capturas-cuenta/ (ignoradas por git) para revisar a
// ojo lo que aquí se afirma con selectores.
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import puppeteer from 'puppeteer';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4773';
const CAPTURAS = process.env.CAPTURAS_DIR || join(__dirname, '.capturas-cuenta');
mkdirSync(CAPTURAS, { recursive: true });

const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const espera = (ms) => new Promise(r => setTimeout(r, ms));

const NEG = SEED.negocioA;
const SLUG = 'cta-ui-a';
const MARCA = 'Cat cuenta UI';
const suf = Date.now().toString().slice(-5);
const tel = n => `86${suf}${String(n).padStart(3, '0')}`;

// ── Fixture: una tienda con cuentas y Rewards encendidos ──
async function fijarModulo(modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [NEG, modulo, estado]);
}
for (const m of ['tienda_online', 'pos', 'menu', 'rewards']) await fijarModulo(m, 'activo');
await pool.query('DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre = $2', [NEG, MARCA]);
const { rows: [cat] } = await pool.query(
  `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,940) RETURNING id`, [NEG, MARCA]);
const { rows: [prod] } = await pool.query(
  `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, descripcion, precio, disponible, orden)
   VALUES ($1,$2,'Hamburguesa cuenta','Con papas',180,TRUE,1) RETURNING id`, [NEG, cat.id]);
await pool.query(`INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)
  ON CONFLICT (negocio_id, producto_id) DO UPDATE SET publicado = TRUE`, [NEG, prod.id]);
const reglas = {
  horarios: Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo']
    .map(d => [d, { abierto: true, apertura: '00:00', cierre: '23:59' }])),
  pedidos: {
    costo_envio: 40, pedido_minimo_entrega: 0, entrega_gratis_desde: 0,
    zonas_entrega: [{ nombre: 'Centro', costo: 30 }, { nombre: 'Lejos', costo: 80 }],
    tiempo_preparacion_minutos: 20, tiempo_entrega_min_minutos: 30, tiempo_entrega_max_minutos: 45,
  },
};
await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'reglas_atencion',$2)
  ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`, [NEG, JSON.stringify(reglas)]);
await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'tienda_metodos_pago','["efectivo"]')
  ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = '["efectivo"]'`, [NEG]);
await pool.query(
  `INSERT INTO tienda_config (negocio_id, estado, slug_publico, titular, modalidades, cuentas_clientes, color_primario)
   VALUES ($1,'publicada',$2,'Tienda Cuenta UI',$3,TRUE,'#C96220')
   ON CONFLICT (negocio_id) DO UPDATE SET estado='publicada', slug_publico=$2, titular='Tienda Cuenta UI', modalidades=$3, cuentas_clientes=TRUE, color_primario='#C96220'`,
  [NEG, SLUG, JSON.stringify(['recoger', 'domicilio'])]);
await pool.query(
  `INSERT INTO rewards_config (tenant_id, activo, monto_por_punto, puntos_por_peso, canje_minimo, canal_mostrador, canal_whatsapp, canal_telefono, canal_rappi, canal_tienda)
   VALUES ($1,TRUE,10,0.5,100,TRUE,TRUE,TRUE,FALSE,TRUE)
   ON CONFLICT (tenant_id) DO UPDATE SET activo=TRUE, monto_por_punto=10, puntos_por_peso=0.5, canje_minimo=100, canal_tienda=TRUE`, [NEG]);

const VISTAS = [['movil375', 375, 812], ['movil390', 390, 844], ['tablet768', 768, 1024], ['desktop', 1280, 900]];
const TELS = Object.fromEntries(VISTAS.map(([n], i) => [n, tel(i + 1)]));
// Cada "persona" de la suite ya tiene puntos de antes: eso es lo que debe ver.
for (const telefono of Object.values(TELS)) {
  await pool.query(`INSERT INTO clientes (telefono, nombre) VALUES ($1, NULL) ON CONFLICT (telefono) DO NOTHING`, [telefono]);
  await pool.query(
    `INSERT INTO rewards_accounts (telefono, tenant_id, negocio_id, puntos_balance, puntos_acumulados_total)
     VALUES ($1,$2,$3::uuid,300,300)
     ON CONFLICT (telefono, tenant_id) DO UPDATE SET puntos_balance=300, puntos_acumulados_total=300, cliente_id=NULL`,
    [telefono, NEG, NEG]);
  await pool.query('DELETE FROM clientes_negocio WHERE negocio_id=$1 AND telefono=$2', [NEG, telefono]);
}

const srv = await arrancarServidor({
  PORT: PUERTO, XABOR_OTP_DEV_EXPONER: 'true', XABOR_OTP_LIMITE_IP: '100000',
  XABOR_TIENDA_LIMITE_CHECKOUT: '100000', XABOR_TIENDA_LIMITE_COTIZAR: '100000', XABOR_TIENDA_LIMITE_LECTURA: '100000',
}, { timeoutMs: 40000, omitir: ['OTP_PROVEEDOR', 'NODE_ENV'] });
const URL_TIENDA = `${srv.base}/t/${SLUG}`;
const nav = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

const sinScrollH = (pag) => pag.evaluate(() => {
  const doc = document.documentElement.scrollWidth <= window.innerWidth + 1;
  const hojas = [...document.querySelectorAll('.hoja.on')].every(h => h.scrollWidth <= h.clientWidth + 1);
  return doc && hojas;
});
const texto = (pag, sel) => pag.$eval(sel, el => el.textContent.trim()).catch(() => '');
const captura = (pag, nombre) => pag.screenshot({ path: join(CAPTURAS, nombre + '.png') });

try {
  for (const [etiqueta, ancho, alto] of VISTAS) {
    const telefono = TELS[etiqueta];
    // Contexto propio por vista: cookies limpias, como un teléfono nuevo.
    const contexto = await nav.createBrowserContext();
    const pag = await contexto.newPage();
    const errs = [];
    pag.on('pageerror', e => errs.push(e.message));
    pag.on('dialog', d => d.accept().catch(() => {}));
    await pag.setViewport({ width: ancho, height: alto, isMobile: ancho < 768, hasTouch: ancho < 768 });

    await t(etiqueta, 'la tienda carga con el botón "Iniciar sesión" y sin scroll horizontal', async () => {
      await pag.goto(URL_TIENDA, { waitUntil: 'networkidle0' });
      await pag.waitForSelector('#btn-cuenta:not(.oculto)', { timeout: 8000 });
      assert.strictEqual(await texto(pag, '#btn-cuenta'), 'Iniciar sesión');
      assert.ok(await sinScrollH(pag), 'scroll horizontal en la portada');
      await captura(pag, `${etiqueta}-1-tienda`);
    });

    await t(etiqueta, 'entrar: teléfono → código → nombre → Mi cuenta', async () => {
      await pag.click('#btn-cuenta');
      await pag.waitForSelector('#hoja-cuenta.on #cta-tel', { visible: true });
      await pag.type('#cta-tel', telefono);
      await captura(pag, `${etiqueta}-2-login`);
      await pag.click('#cta-btn');
      await pag.waitForSelector('#cta-codigo', { visible: true });
      const codigo = await pag.evaluate(() => ctx.codigoDev);
      assert.match(String(codigo), /^\d{6}$/, 'el servidor de pruebas expone el código');
      await captura(pag, `${etiqueta}-3-codigo`);
      await pag.type('#cta-codigo', codigo);
      await pag.click('#cta-btn');
      // Cliente nuevo sin nombre: se le pregunta.
      await pag.waitForSelector('#cta-nombre', { visible: true });
      await pag.type('#cta-nombre', 'Persona ' + etiqueta);
      await pag.click('#cta-btn');
      await pag.waitForSelector('.item-menu', { visible: true });
      assert.ok((await pag.$$('.item-menu')).length >= 4, 'Perfil, direcciones, Rewards y pedidos');
      assert.ok((await texto(pag, '#btn-cuenta')).includes('Hola, Persona'));
      assert.ok(await sinScrollH(pag));
      await captura(pag, `${etiqueta}-4-mi-cuenta`);
    });

    await t(etiqueta, 'guardar la dirección "Casa" desde Mi cuenta', async () => {
      await pag.evaluate(() => irVista('direcciones'));
      await pag.waitForSelector('#cta-pie .btn', { visible: true });
      await pag.click('#cta-pie .btn'); // + Agregar dirección
      await pag.waitForSelector('#df-calle', { visible: true });
      await pag.type('#df-calle', 'Av. Siempre Viva');
      await pag.type('#df-ext', '742');
      await pag.select('#df-zona', 'Centro');
      await pag.type('#df-ref', 'Portón azul');
      await pag.type('#df-inst', 'Tocar dos veces');
      assert.ok(await sinScrollH(pag), 'scroll horizontal en el formulario');
      await captura(pag, `${etiqueta}-5-direccion`);
      await pag.click('#cta-btn');
      await pag.waitForSelector('.dir-card', { visible: true });
      const tarjeta = await texto(pag, '.dir-card');
      assert.ok(tarjeta.includes('Av. Siempre Viva 742') && tarjeta.includes('Predeterminada'), tarjeta);
      await captura(pag, `${etiqueta}-6-direcciones`);
    });

    await t(etiqueta, 'ver Rewards: el saldo previo (300 pts) y sus movimientos', async () => {
      await pag.evaluate(() => irVista('rewards'));
      await pag.waitForSelector('.saldo-num', { visible: true });
      assert.ok((await texto(pag, '.saldo-num')).startsWith('300'));
      await captura(pag, `${etiqueta}-7-rewards`);
      await pag.evaluate(() => cerrarTodo());
      await espera(350);
    });

    let folio;
    await t(etiqueta, 'comprar a domicilio eligiendo "Enviar a: Casa" sin escribir nada', async () => {
      await pag.click('.prod');
      await pag.waitForSelector('#hoja-prod.on #btn-agregar', { visible: true });
      await espera(300);
      await pag.click('#btn-agregar');
      await pag.waitForSelector('#barra:not(.oculto)', { visible: true });
      await espera(300);
      await pag.click('#btn-carrito');
      await pag.waitForSelector('#hoja-carrito.on #btn-ir-checkout', { visible: true });
      await espera(300);
      await pag.click('#btn-ir-checkout');
      await pag.waitForSelector('#hoja-checkout.on .opcion-grande', { visible: true });
      await espera(300);
      await pag.evaluate(() => elegirModalidad('domicilio'));
      await pag.click('#ck-pie .btn');
      // "¿Cuándo?" se salta solo (abierto y sin programados) → datos.
      await pag.waitForSelector('#ck-nombre', { visible: true });
      assert.ok((await texto(pag, '.tel-fijo')).includes('verificado'), 'el teléfono aparece verificado, no editable');
      const activa = await texto(pag, '.dir-card.on');
      assert.ok(activa.includes('Casa') && activa.includes('Av. Siempre Viva'), 'Casa viene preseleccionada: ' + activa);
      assert.strictEqual(await pag.$('#ck-dir'), null, 'no se pide escribir la dirección');
      assert.ok(await sinScrollH(pag));
      await captura(pag, `${etiqueta}-8-checkout-enviar-a`);
      await pag.click('#ck-pie .btn');
      await pag.waitForSelector('#hoja-checkout.on .opcion-grande', { visible: true }); // pago
      await pag.click('#ck-pie .btn');
      await pag.waitForSelector('#btn-confirmar', { visible: true, timeout: 15000 });
      const resumen = await texto(pag, '#ck-cuerpo');
      assert.ok(resumen.includes('Casa · Av. Siempre Viva 742'), 'el resumen muestra la dirección elegida');
      assert.ok(resumen.includes('Cambiar'), 'y deja cambiarla');
      assert.ok(resumen.includes('Tienes 300 pts'), 'ofrece los puntos del cliente: ' + resumen.slice(0, 300));
      assert.ok(resumen.includes('Envío · Centro'), 'el envío es el de la zona de Casa');
      await captura(pag, `${etiqueta}-9-resumen`);
      await pag.click('#btn-confirmar');
      await pag.waitForSelector('.exito-folio', { visible: true, timeout: 20000 });
      folio = (await texto(pag, '.exito-folio')).replace('#', '');
      assert.ok(folio, 'debe haber folio');
      await captura(pag, `${etiqueta}-10-exito`);
    });

    await t(etiqueta, 'el pedido quedó ligado al cliente y con la dirección copiada', async () => {
      const { rows: [p] } = await pool.query('SELECT cliente_id, datos FROM pedidos_activos WHERE folio=$1', [folio]);
      assert.ok(p, 'pedido en la base');
      const { rows: [c] } = await pool.query('SELECT id FROM clientes_negocio WHERE negocio_id=$1 AND telefono=$2', [NEG, telefono]);
      assert.strictEqual(p.cliente_id, c.id);
      assert.strictEqual(p.datos.cliente.telefono, telefono);
      assert.strictEqual(p.datos.cliente.calle, 'Av. Siempre Viva');
      assert.strictEqual(p.datos.cliente.numero_exterior, '742');
      assert.strictEqual(Number(p.datos.costo_envio), 30);
      assert.ok(String(p.datos.notas).includes('Tocar dos veces'));
    });

    await t(etiqueta, 'la sesión sobrevive a recargar la página, y cerrar sesión la termina', async () => {
      await pag.goto(URL_TIENDA, { waitUntil: 'networkidle0' });
      await pag.waitForFunction(() => document.getElementById('btn-cuenta')?.textContent.includes('Hola'), { timeout: 8000 });
      await pag.click('#btn-cuenta');
      await pag.waitForSelector('#hoja-cuenta.on #cta-pie .btn', { visible: true });
      await espera(400); // la hoja termina de subir (transición de 260 ms)
      await pag.click('#cta-pie .btn'); // Cerrar sesión
      await pag.waitForFunction(() => document.getElementById('btn-cuenta')?.textContent === 'Iniciar sesión', { timeout: 8000 });
      await pag.reload({ waitUntil: 'networkidle0' });
      await pag.waitForSelector('#btn-cuenta:not(.oculto)');
      assert.strictEqual(await texto(pag, '#btn-cuenta'), 'Iniciar sesión');
    });

    await t(etiqueta, 'cero errores de JavaScript en todo el recorrido', async () => {
      assert.deepStrictEqual(errs, []);
    });
    await contexto.close();
  }

  // ── El invitado: la tienda de siempre, más la invitación a entrar ──
  await t('invitado', 'sin sesión el checkout es el formulario de siempre, con la liga para entrar', async () => {
    const contexto = await nav.createBrowserContext();
    const pag = await contexto.newPage();
    pag.on('dialog', d => d.accept().catch(() => {}));
    await pag.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await pag.goto(URL_TIENDA, { waitUntil: 'networkidle0' });
    await pag.waitForSelector('.prod');
    await pag.click('.prod');
    await pag.waitForSelector('#hoja-prod.on #btn-agregar', { visible: true }); await espera(300);
    await pag.click('#btn-agregar');
    await pag.waitForSelector('#barra:not(.oculto)'); await espera(300);
    await pag.click('#btn-carrito');
    await pag.waitForSelector('#hoja-carrito.on #btn-ir-checkout', { visible: true }); await espera(300);
    await pag.click('#btn-ir-checkout');
    await pag.waitForSelector('#hoja-checkout.on .opcion-grande', { visible: true }); await espera(300);
    await pag.evaluate(() => elegirModalidad('recoger'));
    await pag.click('#ck-pie .btn');
    await pag.waitForSelector('#ck-tel', { visible: true });
    assert.ok((await texto(pag, '#ck-cuerpo')).includes('Inicia sesión'), 'invitación a entrar');
    await pag.type('#ck-nombre', 'Invitado UI');
    await pag.type('#ck-tel', tel(9));
    await captura(pag, 'invitado-datos');
    await pag.click('#ck-pie .btn');
    await pag.waitForSelector('#hoja-checkout.on .opcion-grande', { visible: true });
    await pag.click('#ck-pie .btn');
    await pag.waitForSelector('#btn-confirmar', { visible: true, timeout: 15000 });
    const resumen = await texto(pag, '#ck-cuerpo');
    assert.ok(resumen.includes('Inicia sesión') && resumen.includes('para usar tus puntos'), 'el bloque de puntos invita a entrar, no muestra saldos ajenos');
    await pag.click('#btn-confirmar');
    await pag.waitForSelector('.exito-folio', { visible: true, timeout: 20000 });
    const folio = (await texto(pag, '.exito-folio')).replace('#', '');
    const { rows: [p] } = await pool.query('SELECT cliente_id, datos FROM pedidos_activos WHERE folio=$1', [folio]);
    assert.strictEqual(p.cliente_id, null);
    assert.strictEqual(p.datos.cliente.telefono, tel(9));
    await captura(pag, 'invitado-exito');
    await contexto.close();
  });
} finally {
  await nav.close();
  console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
  if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
  if (fallidas) {
    const salida = srv.obtenerSalida().split('\n').filter(l => /error|Error|FALLO/i.test(l)).slice(-12).join('\n');
    if (salida) console.log('\nErrores del servidor:\n' + salida);
  }
  console.log(`Capturas en: ${CAPTURAS}`);
  await srv.detener();
  await pool.end();
  process.exitCode = fallidas > 0 ? 1 : 0;
}
