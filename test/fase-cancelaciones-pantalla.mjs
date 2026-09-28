// Quitar o cambiar un platillo desde las PANTALLAS (auditoría del 28-sep-2026).
//
// fase-cancelaciones-autorizadas fija el contrato del servidor. Esta suite
// abre las pantallas reales con Puppeteer contra el servidor y Postgres
// reales: la tablet del mesero cambia una limonada chica por una grande con
// la clave de Ana (el ejemplo de Mario), quita algo que aún no salía a
// cocina, y el administrador da y quita claves en Usuarios y ve en Caja qué
// se quitó, por qué y con la clave de quién.
//
// Uso: DATABASE_URL=... (y el resto de variables de las suites) node test/fase-cancelaciones-pantalla.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUERTO = process.env.TEST_PORT_CANCELA_PANTALLA || '4973';

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');

// La migración es aditiva e idempotente: la suite la asegura.
await pool.query(readFileSync(join(__dirname, '..', 'migrations', '101_restaurante_cancelaciones_autorizadas.sql'), 'utf8'));

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ── Negocio de prueba (se reconstruye en cada corrida) ──────────────────────
const SLUG = 'cancela-pantalla-a';
async function limpiar() {
  const { rows } = await pool.query(`SELECT id FROM negocios WHERE slug = $1`, [SLUG]);
  const ids = rows.map(r => r.id);
  if (!ids.length) return;
  const q = (sql) => pool.query(sql, [ids]).catch(() => {});
  await q(`DELETE FROM impresion_trabajos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM restaurante_item_eventos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM restaurante_cuenta_porciones WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`);
  await q(`DELETE FROM restaurante_cuenta_pagos WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`);
  await q(`DELETE FROM restaurante_cuenta_items WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`);
  await q(`DELETE FROM restaurante_cuentas WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM pedidos_activos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM pedido_emisiones WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM folios_pedido_usados WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM menu_modificadores_opciones WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM menu_modificadores_grupos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM menu_productos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM menu_categorias WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM metodos_pago WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM negocio_modulos WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM configuracion WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM sucursales WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM usuario_negocios WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM usuarios WHERE negocio_id = ANY($1)`);
  await q(`DELETE FROM negocios WHERE id = ANY($1)`);
}
await limpiar();

const { rows: [neg] } = await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ('Cancela Pantalla', $1) RETURNING id`, [SLUG]);
const N = neg.id;
for (const m of ['restaurante', 'menu', 'pos', 'usuarios', 'caja']) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [N, m]);
}
await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,'efectivo',TRUE,0)
  ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [N]);
await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')`, [N]);
async function persona(nombre, rol) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,'x') RETURNING id`,
    [N, nombre, `${SLUG}-${rol}-${Math.random().toString(36).slice(2)}@test.local`]);
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,$3)`, [u.id, N, rol]);
  return u.id;
}
const admin = await persona('Admin Pantalla', 'admin');
const ana = await persona('Ana Staff', 'staff');
const beto = await persona('Beto Staff', 'staff');
const categoria = async (nombre, orden) => (await pool.query(
  `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,$3) RETURNING id`, [N, nombre, orden])).rows[0].id;
const producto = async (cat, nombre, precio) => (await pool.query(
  `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, descripcion, precio, disponible, orden)
   VALUES ($1,$2,$3,$4,'',$5,TRUE,0) RETURNING id`, [N, cat, 'P' + Math.random().toString(36).slice(2, 8), nombre, precio])).rows[0].id;
const bebidas = await categoria('Bebidas', 0);
const cocina = await categoria('Cocina', 1);
const limonada = await producto(bebidas, 'Limonada', 40);
const chilaquiles = await producto(cocina, 'Chilaquiles', 195);
const { rows: [grupo] } = await pool.query(
  `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
   VALUES ($1,$2,'Tamaño',TRUE,1,1,0) RETURNING id`, [N, limonada]);
const opcion = async (nombre, extra, orden) => (await pool.query(
  `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
   VALUES ($1,$2,$3,$4,TRUE,$5) RETURNING id`, [N, grupo.id, nombre, extra, orden])).rows[0].id;
const opChica = await opcion('Chica', 0, 0);
await opcion('Grande', 15, 1);

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;
const sesion = (usuarioId, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId: N, rol }))}`;
const cookieAdmin = sesion(admin, 'admin');
const cookieAna = sesion(ana, 'staff');
async function pedir(cookie, path, { method = 'GET', body } = {}) {
  const r = await fetch(base + path, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json, setCookie: r.headers.get('set-cookie') };
}

// Ana autoriza (su clave la da el administrador); Luis es mesero de tablet.
{
  const r = await pedir(cookieAdmin, `/api/admin/usuarios/${ana}/pin-autorizacion`, { method: 'PUT', body: { pin: '2468' } });
  assert(r.status === 200, `clave de Ana: ${JSON.stringify(r.body)}`);
}
const luis = (await pedir(cookieAdmin, '/api/admin/usuarios', { method: 'POST', body: { tipo: 'mesero', nombre: 'Luis Mesero', pin: '1357' } })).body?.id;
assert(luis, 'no se creó el mesero');
const login = await pedir(null, '/api/auth/mesero/login', { method: 'POST', body: { negocio: SLUG, meseroUsuarioId: luis, pin: '1357' } });
assert(login.status === 200 && login.setCookie, `login de mesero: ${login.status}`);
const cookieTablet = login.setCookie.split(';')[0];

// Mesa 7: dos limonadas chicas y unos chilaquiles ya en cocina (ronda 1), y
// otros chilaquiles capturados que todavía no se mandan.
const abierta = await pedir(cookieTablet, '/api/restaurante/mesas/abrir', { method: 'POST', body: { mesa: 7, personas: 2 } });
assert(abierta.status === 201, `abrir mesa: ${JSON.stringify(abierta.body)}`);
const cuenta = abierta.body.id || abierta.body.cuenta?.id;
await pedir(cookieTablet, `/api/restaurante/cuentas/${cuenta}/items`, { method: 'POST', body: { items: [
  { producto_id: limonada, cantidad: 2, modificadores: [opChica] },
  { producto_id: chilaquiles, cantidad: 1 },
] } });
const ronda = await pedir(cookieTablet, `/api/restaurante/cuentas/${cuenta}/comanda`, { method: 'POST' });
assert(ronda.status === 200, `ronda 1: ${JSON.stringify(ronda.body)}`);
await pedir(cookieTablet, `/api/restaurante/cuentas/${cuenta}/items`, { method: 'POST', body: { items: [{ producto_id: chilaquiles, cantidad: 1 }] } });

const renglones = async () => (await pool.query(
  `SELECT id, producto, cantidad, estado, comanda_num, modificadores, motivo_codigo, cancelado_por, autorizado_por, reemplaza_item_id
     FROM restaurante_cuenta_items WHERE cuenta_id = $1 ORDER BY created_at, estado`, [cuenta])).rows;

// ── Navegador: cada sesión en su propio contexto (la cookie es la misma) ─────
const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ERRORES = [];
async function paginaCon(cookie, etiqueta, ancho = 1200, alto = 900) {
  const ctx = await navegador.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: ancho, height: alto });
  const i = cookie.indexOf('=');
  await page.setCookie({ name: cookie.slice(0, i), value: cookie.slice(i + 1), url: base });
  page.on('dialog', d => d.accept().catch(() => {}));
  page.on('pageerror', e => ERRORES.push(`${etiqueta}: ${e.message || e}`));
  return page;
}
const texto = (page, sel) => page.$eval(sel, el => el.innerText.replace(/\s+/g, ' ').trim());
const lineas = (page) => page.evaluate(() => [...document.querySelectorAll('#cu-lineas .linea')].map(l => ({
  texto: l.innerText.replace(/\s+/g, ' ').trim(),
  cancelada: l.classList.contains('cancelada'),
  cancelar: !!l.querySelector('.cancelar-env'),
  quitar: !!l.querySelector('button.quitar'),
  cambio: !!l.querySelector('.tag-cambio'),
})));
const PETICIONES_CANCELAR = [];

try {
  const tab = await paginaCon(cookieTablet, 'tablet', 1100, 820);
  tab.on('request', r => { if (/\/items\/[^/]+\/cancelar$/.test(r.url())) PETICIONES_CANCELAR.push(r.postData()); });
  await tab.goto(base + '/mesas.html', { waitUntil: 'networkidle2' });

  await t('MESA', '1. en la tablet, lo que ya salió a cocina lleva «Quitar o cambiar»; lo pendiente se corrige como carrito', async () => {
    await tab.waitForSelector('button.mesa[aria-label^="Mesa 7,"]', { timeout: 10000 });
    await tab.click('button.mesa[aria-label^="Mesa 7,"]');
    await tab.waitForFunction(() => document.querySelectorAll('#cu-lineas .linea').length >= 3, { timeout: 10000 });
    const ls = await lineas(tab);
    const lim = ls.find(l => /Limonada/.test(l.texto));
    assert(lim && lim.cancelar && !lim.quitar, `limonada: ${JSON.stringify(lim)}`);
    const pend = ls.filter(l => /Chilaquiles/.test(l.texto));
    assert(pend.some(l => l.quitar && !l.cancelar), `chilaquiles pendientes: ${JSON.stringify(pend)}`);
    assert(pend.some(l => l.cancelar && !l.quitar), `chilaquiles enviados: ${JSON.stringify(pend)}`);
  });

  const abrirDialogo = async (producto) => {
    await tab.evaluate((p) => {
      const l = [...document.querySelectorAll('#cu-lineas .linea')].find(x => x.innerText.includes(p) && x.querySelector('.cancelar-env'));
      l.querySelector('.cancelar-env').click();
    }, producto);
    await tab.waitForFunction(() => document.getElementById('dlg-cancelar').open, { timeout: 5000 });
  };

  await t('DIALOGO', '2. el diálogo dice qué platillo, qué ronda, ofrece los 6 motivos y pide la clave', async () => {
    await abrirDialogo('Limonada');
    const d = await tab.evaluate(() => ({
      producto: document.getElementById('ca-producto').textContent,
      detalle: document.getElementById('ca-detalle').textContent,
      motivos: [...document.querySelectorAll('#ca-motivos .chip')].map(b => b.textContent.trim()),
      pin: !document.getElementById('ca-pin-bloque').classList.contains('oculto'),
      cantidad: !document.getElementById('ca-cantidad-bloque').classList.contains('oculto'),
      boton: document.getElementById('ca-confirmar').textContent,
    }));
    assert(d.producto === '2× Limonada (Tamaño: Chica)', `producto: ${d.producto}`);
    assert(/Mesa 7 · Ronda 1 · ya en cocina/.test(d.detalle), `detalle: ${d.detalle}`);
    assert(d.motivos.join('|') === 'Cambio de platillo|Error de captura|El cliente ya no lo quiso|Duplicado|Cortesía|Otro', `motivos: ${d.motivos}`);
    assert(d.pin && d.cantidad, `clave visible ${d.pin}, cantidad visible ${d.cantidad}`);
  });

  await t('DIALOGO', '3. sin motivo, o «Otro» sin escribirlo, no sale nada al servidor', async () => {
    await tab.click('#ca-confirmar');
    const a1 = await texto(tab, '#ca-aviso');
    await tab.click('#ca-motivos .chip[data-motivo="otro"]');
    const otroVisible = await tab.$eval('#ca-otro', el => !el.classList.contains('oculto'));
    await tab.click('#ca-confirmar');
    const a2 = await texto(tab, '#ca-aviso');
    assert(a1 === 'Elige el motivo.' && a2 === 'Escribe el motivo.', `avisos: ${a1} / ${a2}`);
    assert(otroVisible, '«Otro» debe mostrar dónde escribir');
    assert(PETICIONES_CANCELAR.length === 0, `salieron ${PETICIONES_CANCELAR.length} peticiones`);
  });

  await t('CLAVE', '4. con una clave equivocada el servidor lo rechaza: el diálogo sigue abierto y nada cambia', async () => {
    await tab.click('#ca-motivos .chip[data-motivo="cambio"]');
    const boton = await texto(tab, '#ca-confirmar');
    assert(boton === 'Quitar y elegir el nuevo', `botón: ${boton}`);
    await tab.type('#ca-pin', '9999');
    await tab.click('#ca-confirmar');
    await tab.waitForFunction(() => document.getElementById('ca-aviso').textContent === 'Clave incorrecta', { timeout: 5000 });
    const sigue = await tab.evaluate(() => document.getElementById('dlg-cancelar').open && document.getElementById('ca-pin').value === '');
    assert(sigue, 'el diálogo debe seguir abierto y con la clave vacía');
    const rs = await renglones();
    assert(!rs.some(r => r.estado === 'cancelado'), 'no debe haber nada cancelado');
    assert(PETICIONES_CANCELAR.length === 1 && JSON.parse(PETICIONES_CANCELAR[0]).motivo_codigo === 'cambio', `petición: ${PETICIONES_CANCELAR[0]}`);
  });

  let quitada = null;
  await t('CAMBIO', '5. quita 1 de 2 con la clave de Ana: la ronda lo muestra quitado, con motivo y quién autorizó, y pide el platillo nuevo', async () => {
    await tab.click('#ca-cantidad-bloque button[aria-label="Uno menos"]');
    const cant = await texto(tab, '#ca-cantidad');
    assert(cant === '1', `cantidad a quitar: ${cant}`);
    await tab.type('#ca-pin', '2468');
    await tab.click('#ca-confirmar');
    await tab.waitForFunction(() => !document.getElementById('dlg-cancelar').open, { timeout: 5000 });
    await tab.waitForFunction(() => document.querySelector('#cu-lineas .linea.cancelada'), { timeout: 5000 });
    const ls = await lineas(tab);
    const can = ls.find(l => l.cancelada && /Limonada/.test(l.texto));
    const viva = ls.find(l => !l.cancelada && /Limonada/.test(l.texto));
    assert(can && /^1× Limonada/.test(can.texto) && /Quitado · Cambio de platillo · autorizó Ana Staff/.test(can.texto), `quitada: ${can?.texto}`);
    assert(!can.cancelar, 'lo ya quitado no se vuelve a quitar');
    assert(viva && /^1× Limonada/.test(viva.texto), `sigue: ${viva?.texto}`);
    const aviso = await tab.evaluate(() => ({
      visible: !document.getElementById('reemplazo-aviso').classList.contains('oculto'),
      texto: document.getElementById('reemplazo-texto').textContent,
    }));
    assert(aviso.visible && aviso.texto === 'Cambio de 1× Limonada (Tamaño: Chica): elige el platillo nuevo', `aviso: ${JSON.stringify(aviso)}`);
    const rs = await renglones();
    quitada = rs.find(r => r.estado === 'cancelado');
    assert(quitada && quitada.cantidad === 1 && quitada.motivo_codigo === 'cambio', `renglón: ${JSON.stringify(quitada)}`);
    assert(quitada.autorizado_por === ana && quitada.cancelado_por === luis, 'autorizó Ana, pidió Luis');
  });

  await t('CAMBIO', '6. la grande se elige en el menú y queda ligada a la chica: la línea dice «cambio» y el aviso se va', async () => {
    await tab.evaluate((id) => document.querySelector(`button.prod[data-producto="${id}"]`).click(), String(limonada));
    await tab.waitForSelector('#xb-wiz-body .xb-wiz-op', { timeout: 5000 });
    await tab.evaluate(() => [...document.querySelectorAll('#xb-wiz-body .xb-wiz-op')].find(b => b.textContent.includes('Grande')).click());
    await tab.waitForFunction(() => document.getElementById('xb-wiz-seguir').textContent === 'Agregar a la mesa', { timeout: 5000 });
    await tab.click('#xb-wiz-seguir');
    await tab.waitForFunction(() => document.getElementById('reemplazo-aviso').classList.contains('oculto'), { timeout: 5000 });
    await tab.waitForFunction(() => document.querySelector('#cu-lineas .tag-cambio'), { timeout: 5000 });
    const rs = await renglones();
    const grande = rs.find(r => r.reemplaza_item_id);
    assert(grande && grande.producto === 'Limonada' && grande.estado === 'pendiente', `nuevo: ${JSON.stringify(grande)}`);
    assert(grande.reemplaza_item_id === quitada.id, 'la grande apunta al renglón quitado');
    assert(JSON.stringify(grande.modificadores).includes('Grande'), `modificadores: ${JSON.stringify(grande.modificadores)}`);
    const ls = await lineas(tab);
    assert(ls.some(l => l.cambio && /Limonada/.test(l.texto) && /Grande/.test(l.texto)), 'la línea nueva lleva la marca «cambio»');
  });

  await t('PENDIENTE', '7. lo que aún no sale a cocina se quita sin clave y queda en la bitácora', async () => {
    await tab.evaluate(() => {
      const l = [...document.querySelectorAll('#cu-lineas .linea')].find(x => x.innerText.includes('Chilaquiles') && x.querySelector('button.quitar'));
      l.querySelector('button.quitar').click();
    });
    await tab.waitForFunction(() => ![...document.querySelectorAll('#cu-lineas .linea')].some(x => x.innerText.includes('Chilaquiles') && x.querySelector('button.quitar')), { timeout: 5000 });
    const { rows } = await pool.query(
      `SELECT tipo, producto, cantidad, solicitado_por FROM restaurante_item_eventos WHERE cuenta_id = $1 AND tipo = 'quitado_antes_de_enviar'`, [cuenta]);
    assert(rows.length === 1 && rows[0].producto === 'Chilaquiles' && rows[0].solicitado_por === luis, `bitácora: ${JSON.stringify(rows)}`);
    assert(PETICIONES_CANCELAR.length === 2, 'quitar lo pendiente no pasa por la autorización');
  });

  await t('CAMBIO', '8. al mandar la ronda, la cocina recibe en la grande qué reemplaza', async () => {
    const respuesta = tab.waitForResponse(r => /\/comanda$/.test(r.url()) && r.request().method() === 'POST', { timeout: 5000 });
    await tab.click('#btn-comanda');
    const j = await (await respuesta).json();
    const grande = (j.items || []).find(i => i.reemplaza_item_id);
    assert(grande && /Limonada/.test(grande.en_lugar_de || '') && /Chica/.test(grande.en_lugar_de || ''), `ronda: ${JSON.stringify(j.items)}`);
    assert(j.items.length === 1, `la ronda 2 solo lleva la grande: ${j.items.length}`);
  });

  // ── Panel del administrador ────────────────────────────────────────────────
  const adm = await paginaCon(cookieAdmin, 'admin', 1300, 900);
  await adm.goto(base + '/app', { waitUntil: 'networkidle2' });
  await adm.waitForFunction(() => typeof cargarUsuarios === 'function' && typeof cargarCorte === 'function', { timeout: 10000 });
  const filasUsuarios = () => adm.evaluate(() => [...document.querySelectorAll('#usr-lista > div')].map(d => ({
    texto: d.innerText.replace(/\s+/g, ' ').trim(),
    botones: [...d.querySelectorAll('button')].map(b => b.textContent.trim()),
  })));
  const filaDe = async (nombre) => (await filasUsuarios()).find(f => f.texto.startsWith(nombre));
  const clicEnFila = (nombre, boton) => adm.evaluate((n, b) => {
    const fila = [...document.querySelectorAll('#usr-lista > div')].find(d => d.innerText.trim().startsWith(n));
    [...fila.querySelectorAll('button')].find(x => x.textContent.trim() === b).click();
  }, nombre, boton);

  await t('USUARIOS', '9. Usuarios dice quién puede autorizar; el mesero no lleva botones de clave', async () => {
    await adm.evaluate(() => mostrarTab('usuarios'));
    await adm.waitForFunction(() => /Beto Staff/.test(document.getElementById('usr-lista').innerText), { timeout: 10000 });
    const a = await filaDe('Ana Staff');
    const b = await filaDe('Beto Staff');
    const l = await filaDe('Luis Mesero');
    const yo = await filaDe('Admin Pantalla');
    assert(/Puede autorizar quitar o cambiar platillos/.test(a.texto) && a.botones.includes('Cambiar clave') && a.botones.includes('Quitar clave'), `Ana: ${JSON.stringify(a)}`);
    assert(/Sin clave para autorizar/.test(b.texto) && b.botones.includes('Dar clave') && !b.botones.includes('Quitar clave'), `Beto: ${JSON.stringify(b)}`);
    assert(!l.botones.some(x => /clave/i.test(x)) && !/autorizar/i.test(l.texto), `Luis: ${JSON.stringify(l)}`);
    assert(/Administrador/.test(yo.texto) && yo.botones.includes('Dar clave'), `admin: ${JSON.stringify(yo)}`);
  });

  const escribirClaves = async (c1, c2) => {
    await adm.$eval('#usr-pinaut', el => { el.value = ''; });
    await adm.$eval('#usr-pinaut2', el => { el.value = ''; });
    await adm.type('#usr-pinaut', c1);
    await adm.type('#usr-pinaut2', c2);
    const escritas = await adm.evaluate(() => [document.getElementById('usr-pinaut').value, document.getElementById('usr-pinaut2').value]);
    assert(escritas[0] === c1 && escritas[1] === c2, `se escribió ${JSON.stringify(escritas)} en vez de ${c1}/${c2}`);
    await adm.evaluate(() => { document.getElementById('usr-pinaut-fb').textContent = ''; });
    await adm.evaluate(() => [...document.querySelectorAll('#usr-pin-modal button')].find(b => b.textContent.trim() === 'Guardar clave').click());
    await adm.waitForFunction(() => {
      const t = document.getElementById('usr-pinaut-fb').textContent;
      return t && t !== 'Guardando...';
    }, { timeout: 5000 });
    return texto(adm, '#usr-pinaut-fb');
  };

  await t('USUARIOS', '10. dar clave a Beto: si no coinciden o es la de Ana no se guarda; con una propia sí', async () => {
    await clicEnFila('Beto Staff', 'Dar clave');
    await adm.waitForFunction(() => document.getElementById('usr-pin-modal').style.display === 'flex', { timeout: 5000 });
    // La ventana deja el cursor en la clave: se puede escribir de inmediato.
    const foco = await adm.evaluate(() => document.activeElement?.id);
    assert(foco === 'usr-pinaut', `el foco quedó en ${foco}`);
    const nombre = await texto(adm, '#usr-pin-nombre');
    assert(nombre === 'Beto Staff', `modal de: ${nombre}`);
    const f1 = await escribirClaves('1111', '1112');
    assert(f1 === 'Las claves no coinciden', `no coinciden: ${f1}`);
    const f2 = await escribirClaves('2468', '2468');
    assert(f2 === 'Esa clave ya la usa otra persona del negocio: elige otra', `repetida: ${f2}`);
    const f3 = await escribirClaves('8642', '8642');
    assert(f3 === '✓ Clave guardada', `guardada: ${f3}`);
    await adm.waitForFunction(() => {
      const fila = [...document.querySelectorAll('#usr-lista > div')].find(d => d.innerText.trim().startsWith('Beto Staff'));
      return fila && /Puede autorizar/.test(fila.innerText);
    }, { timeout: 5000 });
    const { rows: [u] } = await pool.query(`SELECT pin_autorizacion_hash FROM usuarios WHERE id = $1`, [beto]);
    assert(u.pin_autorizacion_hash && !u.pin_autorizacion_hash.includes('8642'), 'se guarda cifrada');
  });

  await t('USUARIOS', '11. quitar la clave de Beto lo regresa a «Sin clave»', async () => {
    await clicEnFila('Beto Staff', 'Quitar clave');
    await adm.waitForFunction(() => {
      const fila = [...document.querySelectorAll('#usr-lista > div')].find(d => d.innerText.trim().startsWith('Beto Staff'));
      return fila && /Sin clave para autorizar/.test(fila.innerText);
    }, { timeout: 5000 });
    const { rows: [u] } = await pool.query(`SELECT pin_autorizacion_hash FROM usuarios WHERE id = $1`, [beto]);
    assert(u.pin_autorizacion_hash === null, 'la clave se borra');
  });

  await t('CAJA', '12. Caja: lo quitado del día, después de cocina ($40, cambio, pidió Luis, autorizó Ana) y antes de enviar ($195)', async () => {
    await adm.evaluate(() => mostrarTab('corte'));
    await adm.waitForFunction(() => /Después de ir a cocina/.test(document.getElementById('corte-cancelaciones').innerText), { timeout: 10000 });
    const txt = await texto(adm, '#corte-cancelaciones');
    assert(/Después de ir a cocina \$40\.00 1 platillo sin cobrar/.test(txt), `resumen: ${txt}`);
    assert(/Antes de enviar a cocina \$195\.00 1 platillo · sin costo/.test(txt), `antes: ${txt}`);
    assert(/Cambio de platillo · 1 \$40\.00/.test(txt) && /Ana Staff · 1 \$40\.00/.test(txt), `grupos: ${txt}`);
    const filas = await adm.evaluate(() => [...document.querySelectorAll('#corte-cancelaciones .canc-tabla tbody tr')]
      .map(tr => ({ clase: tr.className, celdas: [...tr.children].map(td => td.innerText.trim()) })));
    const despues = filas.find(f => /canc-despues/.test(f.clase));
    const antes = filas.find(f => /canc-antes/.test(f.clase));
    assert(despues && despues.celdas.slice(1).join(' | ') === 'Mesa 7 | 1× Limonada (Chica) | $40.00 | Ronda 1 | Cambio de platillo | Luis Mesero | Ana Staff', `después: ${JSON.stringify(despues)}`);
    assert(antes && antes.celdas.slice(1).join(' | ') === 'Mesa 7 | 1× Chilaquiles | $195.00 | Antes de enviar | — | Luis Mesero | —', `antes: ${JSON.stringify(antes)}`);
  });

  await t('CAJA', '12b. el platillo de captura libre y el motivo escrito a mano se pintan como texto, no como HTML', async () => {
    const m8 = await pedir(cookieTablet, '/api/restaurante/mesas/abrir', { method: 'POST', body: { mesa: 8, personas: 1 } });
    const c8 = m8.body.id || m8.body.cuenta?.id;
    await pedir(cookieTablet, `/api/restaurante/cuentas/${c8}/items`, { method: 'POST', body: { items: [
      { producto: '<img src=x onerror="window.__xss=1">Agua', cantidad: 1, precio_unitario: 20 },
    ] } });
    await pedir(cookieTablet, `/api/restaurante/cuentas/${c8}/comanda`, { method: 'POST' });
    const agua = (await pool.query(`SELECT id FROM restaurante_cuenta_items WHERE cuenta_id = $1`, [c8])).rows[0].id;
    const r = await pedir(cookieTablet, `/api/restaurante/cuentas/${c8}/items/${agua}/cancelar`, { method: 'POST',
      body: { motivo_codigo: 'otro', motivo: '<b>se cayó</b>', pin: '2468' } });
    assert(r.status === 200, `cancelar: ${JSON.stringify(r.body)}`);
    await adm.evaluate(() => cargarCorte());
    await adm.waitForFunction(() => /Mesa 8/.test(document.getElementById('corte-cancelaciones').innerText), { timeout: 10000 });
    const x = await adm.evaluate(() => {
      const cont = document.getElementById('corte-cancelaciones');
      return { img: cont.querySelectorAll('img').length, b: cont.querySelectorAll('td b').length, xss: window.__xss, txt: cont.innerText };
    });
    assert(x.img === 0 && x.b === 0 && x.xss === undefined, `se insertó HTML: ${JSON.stringify({ img: x.img, b: x.b, xss: x.xss })}`);
    assert(x.txt.includes('1× <img src=x onerror="window.__xss=1">Agua') && x.txt.includes('<b>se cayó</b>'), 'el texto debe verse literal');
  });

  await t('CAJA', '13. un día sin nada quitado lo dice, en vez de esconder la sección', async () => {
    await adm.evaluate(() => corteDia(-1));
    await adm.waitForFunction(() => {
      const cont = document.getElementById('corte-cancelaciones');
      return cont.style.display !== 'none' && /Ningún platillo quitado este día/.test(cont.innerText);
    }, { timeout: 10000 });
  });

  await t('CAJA', '14. para el personal (Ana, staff) la sección no aparece: el reporte es del administrador', async () => {
    const st = await paginaCon(cookieAna, 'staff', 1300, 900);
    await st.goto(base + '/app', { waitUntil: 'networkidle2' });
    await st.waitForFunction(() => typeof cargarCancelacionesCorte === 'function', { timeout: 10000 });
    const r = await st.evaluate(async () => {
      const cont = document.getElementById('corte-cancelaciones');
      cont.style.display = '';
      cont.innerHTML = 'x';
      CORTE_FECHA = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Matamoros' }).format(new Date());
      await cargarCancelacionesCorte(CORTE_FECHA, 'America/Matamoros');
      return { display: cont.style.display, html: cont.innerHTML };
    });
    assert(r.display === 'none' && r.html === '', `staff: ${JSON.stringify(r)}`);
  });

  await t('PANTALLAS', '15. ninguna pantalla lanzó errores de JavaScript', async () => {
    assert(ERRORES.length === 0, ERRORES.join(' | '));
  });
} finally {
  await navegador.close().catch(() => {});
  await srv.detener?.();
  await limpiar().catch(() => {});
  await pool.end();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
