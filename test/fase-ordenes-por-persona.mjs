// Integración local: sin proveedores, sockets de impresión ni mensajes reales.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Script, runInNewContext } from 'node:vm';
import puppeteer from 'puppeteer';
import { arrancarServidor } from './lib-servidor.mjs';
import { pool } from '../src/services/database.js';
import { crearTokenSesion } from '../src/services/session.js';
import { normalizarPersona } from '../src/services/ordenesPorPersona.js';
import { obtenerCuenta, enviarComanda, cancelarItem } from '../src/services/restauranteService.js';
import { recalcularItemsDesdeMenu, construirOrdenPOS } from '../src/services/posEnvios.js';
import { crearEdge } from '../src/services/edgeService.js';
import { crearImpresora, crearRuta, crearTrabajosDeComanda, crearTrabajosDePedido, crearTrabajosDeCancelacion } from '../src/services/impresionService.js';
import { renderComanda, renderCancelacion } from '../edge/renderers/index.js';

const url = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && /test|prueba|^\/codex_personas_release$/.test(url.pathname),
  'Esta suite exige una base local de pruebas');
let servidor, navegador, pasadas = 0;
async function t(nombre, fn) { await fn(); console.log(`OK ${++pasadas}. ${nombre}`); }
const slug = 'personas-test-' + randomUUID().slice(0, 8);
const persona = numero => ({ numero, nombre: '' });
const q = async (sql, valores = []) => (await pool.query(sql, valores)).rows;

try {
  await t('sintaxis de scripts de mesas, tienda y panel', () => {
    for (const archivo of ['mesas.html', 'tienda.html', 'index.html']) {
      const html = readFileSync(new URL('../panel/' + archivo, import.meta.url), 'utf8');
      for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new Script(m[1]);
    }
  });
  await t('valida identidad y rechaza controles de impresora', () => {
    assert.equal(normalizarPersona(undefined), null);
    assert.deepEqual(normalizarPersona({ numero: 2, nombre: ' Ana ' }), { numero: 2, nombre: 'Ana' });
    for (const valor of [0, '1', [], { numero: 0 }, { numero: 100 }, { numero: 1.5 },
      { numero: 1, nombre: 'a\nESC' }, { numero: 1, nombre: 'a'.repeat(41) }]) {
      assert.throws(() => normalizarPersona(valor), { code: 'PERSONA_INVALIDA' });
    }
  });
  const [negocio] = await q('INSERT INTO negocios (nombre,slug) VALUES ($1,$2) RETURNING id', ['Personas prueba', slug]);
  const [otro] = await q('INSERT INTO negocios (nombre,slug) VALUES ($1,$2) RETURNING id', ['Otro prueba', slug + '-b']);
  const [usuario] = await q("INSERT INTO usuarios (negocio_id,nombre,email,password_hash) VALUES ($1,'Mesero prueba',$2,'x') RETURNING id", [negocio.id, slug + '@test.local']);
  await q("INSERT INTO usuario_negocios (usuario_id,negocio_id,rol) VALUES ($1,$2,'admin')", [usuario.id, negocio.id]);
  for (const modulo of ['restaurante', 'pos', 'menu', 'tienda_online']) {
    await q("INSERT INTO negocio_modulos (negocio_id,modulo,estado) VALUES ($1,$2,'activo')", [negocio.id, modulo]);
  }
  await q("INSERT INTO tienda_config (negocio_id,estado,slug_publico,modalidades) VALUES ($1,'publicada',$2,'[\"recoger\"]'::jsonb)", [negocio.id, slug]);
  const reglas = { horarios: Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo']
    .map(d => [d, { abierto: true, apertura: '00:00', cierre: '23:59' }])), pedidos: { costo_envio: 0, pedido_minimo_entrega: 0 } };
  await q("INSERT INTO configuracion (negocio_id,clave,valor) VALUES ($1,'reglas_atencion',$2)", [negocio.id, JSON.stringify(reglas)]);
  const [cat] = await q("INSERT INTO menu_categorias (negocio_id,nombre,activa) VALUES ($1,'Tacos',true) RETURNING id", [negocio.id]);
  const [taco] = await q("INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio,disponible) VALUES ($1,$2,'Taco',20,true) RETURNING id", [negocio.id, cat.id]);
  const [agua] = await q("INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio,disponible) VALUES ($1,$2,'Agua',10,true) RETURNING id", [negocio.id, cat.id]);
  for (const p of [taco, agua]) await q('INSERT INTO tienda_productos (negocio_id,producto_id,publicado) VALUES ($1,$2,true)', [negocio.id, p.id]);
  const [grupo] = await q("INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo) VALUES ($1,$2,'Guiso',true,1,1) RETURNING id", [negocio.id, taco.id]);
  const opciones = {};
  for (const nombre of ['Barbacoa','Frijoles','Huevo','Papas']) {
    const [o] = await q('INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible) VALUES ($1,$2,$3,0,true) RETURNING id', [negocio.id, grupo.id, nombre]);
    opciones[nombre] = o.id;
  }
  const items = [[1,'Barbacoa',2],[1,'Frijoles',1],[1,'Huevo',2],[2,'Barbacoa',3],[2,'Papas',3]]
    .map(([numero, guiso, cantidad]) => ({ producto_id: taco.id, cantidad, modificadores: [opciones[guiso]], persona: persona(numero) }));
  servidor = await arrancarServidor({ PORT: process.env.TEST_PORT || '4989' }, { timeoutMs: 30000 });
  const token = crearTokenSesion({ usuarioId: usuario.id, negocioId: negocio.id, rol: 'admin' });
  const cookie = 'xabor_sesion=' + encodeURIComponent(token);
  async function api(path, body, method = body ? 'POST' : 'GET') {
    const r = await fetch(servidor.base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  }
  let cuentaId;
  await t('desactivada por defecto y el servidor no acepta personas', async () => {
    assert.equal((await api('/api/restaurante/ordenes-persona')).body.habilitado, false);
    const ab = await api('/api/restaurante/mesas/abrir', { mesa: 1, personas: 2, meseroUsuarioId: usuario.id });
    assert.equal(ab.status, 201); cuentaId = ab.body.cuenta.id;
    const r = await api(`/api/restaurante/cuentas/${cuentaId}/items`, { items });
    assert.equal(r.status, 400); assert.equal(r.body.code, 'PERSONAS_DESHABILITADAS');
    assert.equal((await obtenerCuenta(cuentaId, negocio.id)).items.length, 0);
  });
  await t('activar por negocio y capturar el ejemplo sin confiar en precios del cliente', async () => {
    assert.equal((await api('/api/config', { ordenes_por_persona: true }, 'PUT')).status, 200);
    assert.equal((await api('/api/restaurante/ordenes-persona')).body.habilitado, true);
    assert.equal((await api('/api/config/operativa')).body.ordenes_por_persona, 'true');
    const r = await api(`/api/restaurante/cuentas/${cuentaId}/items`, { items: items.map(i => ({ ...i, precio_unitario: 1 })) });
    assert.equal(r.status, 200);
    const c = await obtenerCuenta(cuentaId, negocio.id);
    assert.equal(c.total, 220); assert.equal(c.items.reduce((s,i) => s + i.cantidad, 0), 11);
    assert.equal(c.items.filter(i => i.persona.numero === 1).reduce((s,i) => s + i.cantidad, 0), 5);
    assert.equal(c.items.filter(i => i.persona.numero === 2).reduce((s,i) => s + i.cantidad, 0), 6);
  });
  await t('personas inválidas y productos de otro negocio se rechazan', async () => {
    const r = await api(`/api/restaurante/cuentas/${cuentaId}/items`, { items: [{ ...items[0], persona: { numero: 100 } }] });
    assert.equal(r.status, 400); assert.equal(r.body.code, 'PERSONA_INVALIDA');
    assert.equal(await obtenerCuenta(cuentaId, otro.id), null);
    await assert.rejects(recalcularItemsDesdeMenu(otro.id, [{ ...items[0], persona: null }]), { codigo: 'PRODUCTO_AJENO' });
  });
  let ronda;
  let edgePrueba;
  await t('doble envío concurrente emite una sola ronda de 11 tacos', async () => {
    const resultados = await Promise.allSettled([enviarComanda(cuentaId, negocio.id, usuario.id), enviarComanda(cuentaId, negocio.id, usuario.id)]);
    assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(resultados.find(r => r.status === 'rejected').reason.code, 'SIN_ITEMS_PENDIENTES');
    ronda = resultados.find(r => r.status === 'fulfilled').value;
    assert.equal(ronda.items.reduce((s,i) => s + i.cantidad, 0), 11);
  });
  await t('snapshot Edge y reintento conservan personas sin duplicar trabajo', async () => {
    await q("INSERT INTO sucursales (negocio_id,nombre) VALUES ($1,'Principal')", [negocio.id]);
    const edge = await crearEdge(negocio.id, { nombre: 'Edge prueba sin conexión' });
    edgePrueba = edge;
    const imp = await crearImpresora(negocio.id, { terminalId: edge.id, nombre: 'Cocina simulada', transporte: 'windows_spooler', anchoColumnas: 42, config: { spoolerNombre: 'SIMULADA' } });
    await crearRuta(negocio.id, { impresoraId: imp.id, ambito: 'documento', clave: 'comanda' });
    const a = await crearTrabajosDeComanda({ negocioId: negocio.id, cuentaId, comanda: ronda });
    assert.equal(a.creados.length, 1); assert.equal(a.error, null);
    const snapshot = a.creados[0].payload;
    assert.deepEqual(snapshot.items.map(i => i.persona.numero).sort(), [1,1,1,2,2]);
    assert.ok(snapshot.items.every(i => i.persona_en_notas && i.notas.startsWith(`Orden ${i.persona.numero}`)));
    const anterior = new URL('../edge/renderers/.personas-previo.mjs', import.meta.url);
    writeFileSync(anterior, execFileSync('git', ['show', '48e4150:edge/renderers/index.js'], { encoding: 'utf8' }));
    try {
      const rendererAnterior = await import(anterior.href);
      const papelAnterior = rendererAnterior.renderComanda(snapshot).toString('latin1');
      assert.ok(papelAnterior.includes('NOTA: Orden 1') && papelAnterior.includes('NOTA: Orden 2'), 'El Edge instalado ya puede identificar cada persona');
    } finally { unlinkSync(anterior); }
    const b = await crearTrabajosDeComanda({ negocioId: negocio.id, cuentaId, comanda: ronda });
    assert.equal(b.creados.length, 0); assert.equal(b.duplicados.length, 1);
    for (const ancho of [32,42]) {
      const texto = renderComanda(snapshot, { ancho }).toString('latin1');
      assert.equal(texto.match(/ORDEN 1/g).length, 1); assert.equal(texto.match(/ORDEN 2/g).length, 1);
      assert.ok(texto.indexOf('ORDEN 1') < texto.indexOf('ORDEN 2'));
    }
  });
  await t('tienda traduce persona, recalcula 220 y conserva líneas iguales entre personas', async () => {
    const publico = await api('/api/tienda/' + slug);
    assert.equal(publico.body.ordenesPorPersona, true);
    const cot = await api('/api/tienda/' + slug + '/cotizar', { items: items.map(i => ({ ...i, productoId: i.producto_id })), modalidad: 'recoger' });
    assert.equal(cot.status, 200); assert.equal(cot.body.total, 220);
    const validado = await recalcularItemsDesdeMenu(negocio.id, items);
    const orden = construirOrdenPOS({ negocioId: negocio.id, tipo: 'recoger', ...validado, cliente: { nombre: 'Prueba', telefono: '8991110001' } });
    assert.deepEqual(orden.items.map(i => i.persona.numero), [1,1,1,2,2]);
    const { registrarPedido } = await import('../src/orders/orderManager.js');
    const guardado = await registrarPedido(orden, 'tienda_online'); // solo persiste; no emite
    const [persistido] = await q('SELECT datos FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2', [guardado.id, negocio.id]);
    assert.deepEqual(persistido.datos.items.map(i => i.persona.numero), [1,1,1,2,2]);
    const r = await crearTrabajosDePedido({ negocioId: negocio.id, pedido: { ...orden, id: 'TEST-' + randomUUID() } });
    assert.equal(r.creados.length, 1); assert.deepEqual(r.creados[0].payload.items.map(i => i.persona.numero), [1,1,1,2,2]);
  });
  await t('comanda del navegador agrupa y escapa el nombre de persona sin imprimir', () => {
    const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
    const funcion = nombre => {
      const inicio = html.indexOf(`function ${nombre}(`);
      const fin = html.indexOf('\nfunction ', inicio + 1);
      return html.slice(inicio, fin);
    };
    const contexto = { window: {}, negocio: { nombre_corto: 'PRUEBA' }, horaCST: () => '10:00', getNombre: () => 'Prueba' };
    runInNewContext(readFileSync(new URL('../panel/ordenes-persona.js', import.meta.url), 'utf8'), contexto);
    contexto.XaborPersonas = contexto.window.XaborPersonas;
    contexto.pedido = { id: 'XAB-1', items: ronda.items.map(i => ({ ...i, nombre: i.producto })) };
    const codigo = funcion('modsLineas') + '\n' + funcion('notaSinMods') + '\n' + funcion('esc') + '\n' + funcion('comandaHTML') + '\ncomandaHTML(pedido)';
    const papel = runInNewContext(codigo, contexto);
    assert.equal(papel.match(/Orden 1/g).length, 1); assert.equal(papel.match(/Orden 2/g).length, 1);
    contexto.pedido.items[0].persona = { numero: 1, nombre: '<script>' };
    assert.ok(runInNewContext(codigo, contexto).includes('&lt;script&gt;'));
  });
  await t('dos estaciones conservan la persona en cada fragmento de comanda', async () => {
    const imp = await crearImpresora(negocio.id, { terminalId: edgePrueba.id, nombre: 'Estación tacos simulada',
      transporte: 'windows_spooler', anchoColumnas: 32, config: { spoolerNombre: 'SIMULADA-TACOS' } });
    await crearRuta(negocio.id, { impresoraId: imp.id, ambito: 'producto', clave: 'Taco' });
    const dividido = await crearTrabajosDeComanda({ negocioId: negocio.id, cuentaId: randomUUID(), comanda: {
      ...ronda, items: [...ronda.items, { producto: 'Agua', cantidad: 1, persona: persona(2) }] } });
    assert.equal(dividido.creados.length, 2);
    const tacos = dividido.creados.find(t => t.payload.items.some(i => i.producto === 'Taco'));
    const bebidas = dividido.creados.find(t => t.payload.items.some(i => i.producto === 'Agua'));
    assert.deepEqual(tacos.payload.items.map(i => i.persona.numero).sort(), [1,1,1,2,2]);
    assert.equal(bebidas.payload.items[0].persona.numero, 2);
  });
  navegador = await puppeteer.launch({ headless: true });
  const errores = [];
  const tiendaPage = await navegador.newPage();
  tiendaPage.on('pageerror', e => errores.push(e.message));
  await tiendaPage.setRequestInterception(true);
  tiendaPage.on('request', r => r.url().startsWith(servidor.base) || r.url().startsWith('data:') ? r.continue() : r.abort());
  await t('navegador: tienda agrega guisos por persona, recarga y permite editar sin cambiar otra orden', async () => {
    await tiendaPage.setViewport({ width: 390, height: 844 });
    await tiendaPage.goto(servidor.base + '/t/' + slug);
    await tiendaPage.waitForSelector('#selector-persona:not(.oculto)');
    for (const [numero, guiso, cantidad] of [[1,'Barbacoa',2],[1,'Frijoles',1],[1,'Huevo',2],[2,'Barbacoa',3],[2,'Papas',3]]) {
      if (numero === 2 && !await tiendaPage.$('#orden-persona option[value="2"]')) {
        await tiendaPage.click('#selector-persona button');
      }
      await tiendaPage.select('#orden-persona', String(numero));
      await tiendaPage.click(`[onclick="abrirProducto(${taco.id})"]`);
      await tiendaPage.waitForSelector('#prod-persona');
      await tiendaPage.waitForFunction(() => document.getElementById('hoja-prod').classList.contains('on')
        && document.getElementById('hoja-prod').getAnimations().length === 0);
      await tiendaPage.locator(`#prod-cuerpo label:has(input[value="${opciones[guiso]}"])`).click();
      for (let n = 1; n < cantidad; n++) await tiendaPage.click('[onclick="cambiarCantidad(1)"]');
      await tiendaPage.click('#btn-agregar');
      await tiendaPage.waitForFunction(() => !document.getElementById('hoja-prod').classList.contains('on'));
      await tiendaPage.waitForFunction(() => document.getElementById('hoja-prod').getAnimations().length === 0);
    }
    assert.equal(await tiendaPage.evaluate(() => totalLocal()), 220);
    await tiendaPage.reload();
    await tiendaPage.waitForSelector('#selector-persona:not(.oculto)');
    await tiendaPage.click('#btn-carrito');
    await tiendaPage.waitForFunction(() => document.getElementById('hoja-carrito').getAnimations().length === 0);
    const titulos = await tiendaPage.$$eval('#carrito-cuerpo .persona-titulo', es => es.map(e => e.textContent));
    assert.deepEqual(titulos, ['Orden 1', 'Orden 2']);
    await tiendaPage.locator('[onclick="editarLinea(3)"]').click();
    await tiendaPage.waitForFunction(() => document.getElementById('hoja-prod').classList.contains('on')
      && document.getElementById('hoja-prod').getAnimations().length === 0);
    assert.equal(await tiendaPage.$eval('#prod-persona', e => e.value), '2');
    await tiendaPage.click('#btn-agregar');
    assert.equal(await tiendaPage.evaluate(() => CARRITO[0].cantidad), 2);
    await tiendaPage.evaluate(() => pintarResumen({ total: 220, subtotal: 220 }));
    assert.deepEqual(await tiendaPage.$$eval('#ck-cuerpo .persona-titulo', es => es.map(e => e.textContent)), ['Orden 1','Orden 2']);
    mkdirSync(new URL('.personas-qa/', import.meta.url), { recursive: true });
    await tiendaPage.evaluate(() => { cerrarTodo(); abrirCarrito(); });
    await tiendaPage.waitForFunction(() => document.getElementById('hoja-carrito').getAnimations().length === 0);
    await tiendaPage.screenshot({ path: new URL('.personas-qa/tienda-movil.png', import.meta.url).pathname.replace(/^\/(\w:)/, '$1') });
  });
  const mesaPage = await navegador.newPage();
  mesaPage.on('pageerror', e => errores.push(e.message));
  await mesaPage.setCookie({ name: 'xabor_sesion', value: token, url: servidor.base });
  await t('navegador: mesero conserva personas al recargar y agrega una ronda para Orden 2', async () => {
    await mesaPage.setViewport({ width: 1280, height: 900 });
    await mesaPage.goto(servidor.base + '/restaurante');
    await mesaPage.waitForSelector(`[onclick="abrirCuenta('${cuentaId}')"]`);
    await mesaPage.click(`[onclick="abrirCuenta('${cuentaId}')"]`);
    await mesaPage.waitForSelector('#selector-persona:not(.oculto)');
    await mesaPage.waitForSelector('#cu-lineas .persona-titulo');
    assert.deepEqual(await mesaPage.$$eval('#cu-lineas .persona-titulo', es => es.map(e => e.textContent)), ['Orden 1','Orden 2']);
    await mesaPage.select('#orden-persona', '2');
    await mesaPage.click(`[data-producto="${agua.id}"]`);
    await mesaPage.waitForFunction(() => document.getElementById('cu-lineas').textContent.includes('Agua'));
    const adicional = await enviarComanda(cuentaId, negocio.id, usuario.id);
    assert.equal(adicional.comanda, 2); assert.equal(adicional.items.length, 1);
    assert.equal(adicional.items[0].persona.numero, 2);
    await mesaPage.evaluate(() => refrescarCuenta());
    await mesaPage.screenshot({ path: new URL('.personas-qa/mesas.png', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
    const cancelado = await cancelarItem(adicional.items[0].id, cuentaId, negocio.id, usuario.id, 'Prueba', { motivoCodigo: 'otro', autorizadoPor: usuario.id });
    assert.equal(cancelado.persona.numero, 2);
    assert.ok(renderCancelacion({ items: [cancelado] }).toString('latin1').includes('Orden 2'));
  });
  await t('cancelación parcial conserva la persona del original y del aviso de cocina', async () => {
    const original = ronda.items.find(i => i.persona.numero === 2 && i.cantidad === 3);
    const cancelado = await cancelarItem(original.id, cuentaId, negocio.id, usuario.id, 'Prueba parcial',
      { motivoCodigo: 'otro', autorizadoPor: usuario.id, cantidad: 1 });
    assert.equal(cancelado.parcial, true); assert.equal(cancelado.persona.numero, 2);
    const cuenta = await obtenerCuenta(cuentaId, negocio.id);
    assert.equal(cuenta.items.find(i => i.id === original.id).cantidad, 2);
    assert.equal(cuenta.items.find(i => i.id === cancelado.id).persona.numero, 2);
    const aviso = await crearTrabajosDeCancelacion({ negocioId: negocio.id, cuentaId, eventoId: cancelado.eventoId,
      cancelacion: { mesa: 1, items: [cancelado], motivo: 'Orden 2: Prueba parcial' } });
    assert.equal(aviso.creados.length, 1);
    assert.equal(aviso.creados[0].payload.items[0].persona.numero, 2);
    assert.ok(renderCancelacion(aviso.creados[0].payload).toString('latin1').includes('Orden 2'));
  });
  await t('desactivar conserva historial y pedidos sin persona siguen funcionando', async () => {
    assert.equal((await api('/api/config', { ordenes_por_persona: false }, 'PUT')).status, 200);
    assert.equal((await api(`/api/restaurante/cuentas/${cuentaId}/items`, { items: [{ producto_id: agua.id, cantidad: 1 }] })).status, 200);
    assert.ok((await obtenerCuenta(cuentaId, negocio.id)).items.some(i => i.persona?.numero === 1));
    const r = await api('/api/tienda/' + slug + '/cotizar', { items, modalidad: 'recoger' });
    assert.equal(r.status, 400); assert.equal(r.body.codigo, 'PERSONAS_DESHABILITADAS');
    const anterior = renderComanda({ items: [{ producto: 'Agua', cantidad: 1 }] }).toString('latin1');
    assert.ok(!anterior.includes('ORDEN') && !anterior.includes('COMPARTIDO'));
    assert.deepEqual(errores, []);
  });
  console.log(`${pasadas} pruebas pasadas; sin impresión física ni proveedores externos.`);
} finally {
  await navegador?.close();
  servidor?.detener();
  await pool.end();
}
