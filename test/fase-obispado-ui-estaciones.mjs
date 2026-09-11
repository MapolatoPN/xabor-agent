// OBISPADO — LA OPERACIÓN, POR LA INTERFAZ Y CON TRES ESTACIONES A LA VEZ.
//
// Todo lo demás del modo sin conexión se prueba por HTTP. Esto NO: aquí se
// pulsan botones. Existe porque dos cosas solo fallan en el navegador -- un
// botón que no dispara su handler, y dos sesiones que se pisan el
// almacenamiento -- y ninguna suite de las otras las vería.
//
// Tres CONTEXTOS de navegador independientes, que es lo que replica tres
// computadoras: cookies, localStorage y sesión separados, todos contra el
// MISMO Edge.
//
//   · CAJA      -> cobra y cierra. Nadie más.
//   · MESERO 1  -> captura y manda a cocina.
//   · MESERO 2  -> captura en otra mesa, a la vez.
//
// El Edge se levanta en el propio proceso, sin nube: es el corte de internet.
//
// Uso: node test/fase-obispado-ui-estaciones.mjs
import assert from 'assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import puppeteer from 'puppeteer';

const { crearEdge } = await import('../edge/index.js');
const { hashPin } = await import('../src/services/password.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── El Edge, con catálogo sintético ────────────────────────────────────────
const NEG = randomUUID();
const MESERO1 = randomUUID(), MESERO2 = randomUUID(), CAJA = randomUUID();
const carpeta = mkdtempSync(join(tmpdir(), 'edge-ui-'));

const catalogo = {
  version: 1, negocioId: NEG, negocioNombre: 'Negocio de Prueba',
  generadoAt: new Date().toISOString(), numMesas: 6,
  metodosPago: ['efectivo', 'terminal'], cuentasAbiertas: [],
  meseros: [
    { id: MESERO1, nombre: 'Mesero Uno', rol: 'mesero', pin_hash: hashPin('1111') },
    { id: MESERO2, nombre: 'Mesero Dos', rol: 'mesero', pin_hash: hashPin('2222') },
    { id: CAJA, nombre: 'Caja Principal', rol: 'cajero', pin_hash: hashPin('3333') },
  ],
  menu: [{ id: 1, nombre: 'FUERTES', orden: 0, productos: [
    { id: 10, nombre: 'Chilaquiles', precio: 195, categoria_id: 1, disponible: true, modificadores: [
      { id: 100, nombre: 'Guarniciones', requerido: true, minimo: 1, maximo: 2, opciones: [
        { id: 1000, nombre: 'Frijolitos naturales', precio_extra: 0 },
        { id: 1001, nombre: 'Papas a la mexicana', precio_extra: 0 },
      ] }] },
    { id: 11, nombre: 'Refresco', precio: 45, categoria_id: 1, disponible: true, modificadores: [] },
  ] }],
};

const edge = crearEdge({
  config: {
    wsUrl: 'wss://ejemplo.invalido/ws/print-agent', terminalId: randomUUID(), terminalToken: 'ui',
    rutaDatos: carpeta, almacen: 'auto', nivelLog: 'error',
    heartbeatMs: 60000, timeoutImpresoraMs: 500, puertoSala: 0,
  },
  transportes: {},
});
await edge.iniciar({ conectar: false });
edge.aplicarCatalogo(catalogo);
const BASE = `http://127.0.0.1:${edge.servidorSala.puerto}`;

// ── Navegador ──────────────────────────────────────────────────────────────
// Sin banderas que aflojen la seguridad: `localhost` ya es un origen seguro
// para el navegador, así que no hace falta desactivar nada para probar esto.
const navegador = await puppeteer.launch({ headless: 'new' });

/** Una estación: su propio contexto, sus propias cookies y su localStorage. */
async function abrirEstacion(nombre) {
  const ctx = await navegador.createBrowserContext();
  const page = await ctx.newPage();
  // Pantallas de verdad. A 800x600 --el tamaño por defecto-- la pantalla de
  // mesas colapsa el panel de la cuenta detrás de un botón "Ver cuenta", y los
  // botones de cobro quedan en el DOM pero fuera de la vista. Eso fue lo que
  // hizo fallar D5 durante toda una madrugada: el contrato estaba bien y lo
  // que no modelaba la realidad era la prueba.
  await page.setViewport({ width: 1366, height: 768 });
  page.setDefaultTimeout(15000);
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e.message)));
  // Cerrar una cuenta pide confirmación con un diálogo nativo. Sin atenderlo,
  // la página se queda bloqueada y el navegador deja de responder -- que es lo
  // que parecía "el botón no funciona". Se acepta, que es lo que hace la
  // cajera.
  page.on('dialog', (d) => d.accept().catch(() => {}));
  return { nombre, ctx, page, errores };
}

/** Entra con PIN pulsando el botón, como una persona. */
async function entrar(est, usuarioId, pin, destino = '/restaurante') {
  await est.page.goto(`${BASE}/login-negocio.html?redirect=${encodeURIComponent(destino)}`,
    { waitUntil: 'domcontentloaded' });
  // El formulario aparece cuando el Edge contesta quién puede entrar. Se
  // espera al SELECT y a que tenga opciones: un `<option>` no tiene caja, así
  // que pedirlo "visible" no se cumple nunca.
  await est.page.waitForSelector('#quien', { visible: true });
  await est.page.waitForFunction(() => document.querySelectorAll('#quien option').length > 0);
  await est.page.select('#quien', usuarioId);
  await est.page.click('#pin');
  await est.page.type('#pin', pin);
  await Promise.all([
    est.page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    est.page.click('#btn'),
  ]);
  return est.page.url();
}

const textoDe = (page, sel) => page.$eval(sel, (el) => el.textContent.trim()).catch(() => null);

// ═══ A. El botón "Entrar" ══════════════════════════════════════════════════
// Se pulsa DIEZ veces en contextos limpios. Si el handler fuera intermitente
// -- lo que se vio conduciendo el navegador a mano -- aquí saldría.
await t('A1. "Entrar" funciona pulsándolo, diez veces seguidas', async () => {
  for (let i = 0; i < 10; i++) {
    const est = await abrirEstacion(`prueba-${i}`);
    const url = await entrar(est, MESERO1, '1111');
    assert.ok(url.endsWith('/restaurante'), `intento ${i + 1}: quedó en ${url}`);
    assert.deepStrictEqual(est.errores, [], `intento ${i + 1}: la página lanzó ${est.errores[0]}`);
    await est.ctx.close();
  }
});

await t('A2. un PIN equivocado NO entra, y lo dice', async () => {
  const est = await abrirEstacion('pin-malo');
  await est.page.goto(`${BASE}/login-negocio.html`, { waitUntil: 'domcontentloaded' });
  await est.page.waitForSelector('#quien', { visible: true });
  await est.page.waitForFunction(() => document.querySelectorAll('#quien option').length > 0);
  await est.page.select('#quien', MESERO1);
  await est.page.type('#pin', '9999');
  await est.page.click('#btn');
  await est.page.waitForFunction(() => document.getElementById('err').textContent.trim().length > 0);
  assert.match(await textoDe(est.page, '#err'), /incorrecto/i);
  assert.ok(est.page.url().includes('login'), 'no debe navegar a ningún lado');
  await est.ctx.close();
});

// ═══ B. Tres estaciones a la vez, aisladas ════════════════════════════════
const caja = await abrirEstacion('CAJA');
const m1 = await abrirEstacion('MESERO 1');
const m2 = await abrirEstacion('MESERO 2');

await t('B1. las tres entran a la vez, cada una con su sesión', async () => {
  const [uCaja, u1, u2] = await Promise.all([
    entrar(caja, CAJA, '3333'),
    entrar(m1, MESERO1, '1111'),
    entrar(m2, MESERO2, '2222'),
  ]);
  for (const u of [uCaja, u1, u2]) assert.ok(u.endsWith('/restaurante'), u);
});

await t('B2. el almacenamiento NO se comparte entre contextos', async () => {
  const tokenDe = (p) => p.evaluate(() => localStorage.getItem('xabor_edge_token'));
  const [tc, t1, t2] = await Promise.all([tokenDe(caja.page), tokenDe(m1.page), tokenDe(m2.page)]);
  assert.ok(tc && t1 && t2, 'las tres guardaron su token');
  assert.strictEqual(new Set([tc, t1, t2]).size, 3,
    'tres tokens distintos: si se compartieran, una estación operaría como otra');
});

await t('B3. cada estación opera con SU identidad, no con la de otra', async () => {
  // Se pregunta al servidor quién cree que es cada contexto: es la prueba de
  // aislamiento que importa. El texto de la barra depende del rol (la caja no
  // es sesión de estación) y no sirve para comparar.
  // Un mesero NO tiene sesión de panel (igual que en la nube): su identidad
  // se consulta por el camino de estación.
  const yoEstacion = (p) => p.evaluate(async () => {
    const r = await fetch('/api/restaurante/meseros', { credentials: 'same-origin' });
    return r.ok ? (await r.json()).yo?.nombre : null;
  });
  const yoPanel = (p) => p.evaluate(async () => {
    const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
    return r.ok ? (await r.json()).nombre : null;
  });
  assert.strictEqual(await yoEstacion(m1.page), 'Mesero Uno');
  assert.strictEqual(await yoEstacion(m2.page), 'Mesero Dos');
  assert.strictEqual(await yoPanel(m1.page), null, 'un mesero no es sesión de panel');
  assert.strictEqual(await yoPanel(caja.page), 'Caja Principal', 'la caja sí');
});

// ═══ C. El botón "Abrir mesa" ═════════════════════════════════════════════
const abrirMesaPorUI = async (est, numero) => {
  await est.page.goto(`${BASE}/restaurante`, { waitUntil: 'networkidle2' });
  await est.page.waitForSelector('.mesa');
  const botones = await est.page.$$('.mesa');
  await botones[numero - 1].click();
  // `<dialog>`: se espera a que esté ABIERTO, se pulsa su botón por texto (no
  // tiene id) y se espera a que se cierre.
  await est.page.waitForFunction(() => document.querySelector('#dlg-abrir')?.open === true);
  const abrir = await est.page.evaluateHandle(() =>
    [...document.querySelectorAll('#dlg-abrir button')].find((b) => /abrir mesa/i.test(b.textContent)));
  await abrir.asElement().click();
  await est.page.waitForFunction(() => document.querySelector('#dlg-abrir')?.open !== true, { timeout: 15000 });
};

await t('C1. MESERO 1 abre la Mesa 1 pulsando "Abrir mesa"', async () => {
  await abrirMesaPorUI(m1, 1);
  await m1.page.waitForFunction(() => document.body.innerText.includes('Mesa 1'));
  const estado = await m1.page.evaluate(async () => {
    const r = await fetch('/local/salud'); return (await r.json()).mesasAbiertas;
  });
  assert.strictEqual(estado, 1, 'la mesa tiene que quedar abierta de verdad');
});

await t('C2. MESERO 2 abre OTRA mesa mientras tanto', async () => {
  await abrirMesaPorUI(m2, 3);
  const abiertas = await m2.page.evaluate(async () => {
    const r = await fetch('/local/salud'); return (await r.json()).mesasAbiertas;
  });
  assert.strictEqual(abiertas, 2, 'dos estaciones, dos mesas, sin pisarse');
});

// ═══ D. El recorrido completo, por la interfaz ════════════════════════════
/**
 * Pulsa el primer botón cuyo texto case, ESPERANDO a que exista.
 *
 * La espera no es un adorno: esta pantalla se repinta entera después de cada
 * cambio, así que un botón capturado antes del repintado ya no está en el
 * documento y el clic se pierde en silencio. Eso es exactamente lo que hacía
 * parecer intermitentes a "Entrar" y "Abrir mesa" cuando conduje el navegador
 * a mano -- no era el producto, era pulsar sin esperar.
 */
async function clicPorTexto(page, texto, dentro = 'body') {
  await page.waitForFunction((t, sel) => {
    const raiz = document.querySelector(sel);
    return !!raiz && [...raiz.querySelectorAll('button')]
      .some((b) => !b.disabled && b.textContent.trim().toLowerCase().includes(t.toLowerCase()));
  }, { timeout: 15000 }, texto, dentro);
  const h = await page.evaluateHandle((t, sel) =>
    [...document.querySelector(sel).querySelectorAll('button')]
      .find((b) => !b.disabled && b.textContent.trim().toLowerCase().includes(t.toLowerCase())),
  texto, dentro);
  const el = h.asElement();
  await el.evaluate((b) => b.scrollIntoView({ block: 'center' }));
  // Si el botón queda fuera de la ventana del navegador sin cabeza, el clic
  // por coordenadas no llega. Se recurre al clic del propio elemento: sigue
  // siendo el botón el que dispara su handler, no una función interna.
  try { await el.click(); } catch { await el.evaluate((b) => b.click()); }
}
const cuentaAbiertaDe = (page, mesa) => page.evaluate(async (m) => {
  const r = await fetch('/api/restaurante/mesas', { credentials: 'same-origin' });
  return (await r.json()).mesas.find((x) => x.mesa === m);
}, mesa);

await t('D1. MESERO 1 captura un producto CON modificadores, desde la pantalla', async () => {
  await m1.page.goto(`${BASE}/restaurante`, { waitUntil: 'networkidle2' });
  const mesas = await m1.page.$$('.mesa');
  await mesas[0].click();                        // Mesa 1, ya abierta
  await m1.page.waitForFunction(() => document.body.innerText.includes('Chilaquiles'));
  await clicPorTexto(m1.page, 'Chilaquiles');
  // Asistente de modificadores: guarnición y continuar.
  await m1.page.waitForFunction(() => document.body.innerText.includes('Frijolitos naturales'));
  await clicPorTexto(m1.page, 'Frijolitos naturales');
  await clicPorTexto(m1.page, 'Continuar');
  await m1.page.waitForFunction(() => document.body.innerText.includes('Agregar a la mesa'));
  await clicPorTexto(m1.page, 'Agregar a la mesa');
  await m1.page.waitForFunction(() => /195/.test(document.body.innerText));
  const c = await cuentaAbiertaDe(m1.page, 1);
  assert.strictEqual(c.total, 195, 'el precio lo resuelve el servidor contra el menú');
});

await t('D2. MESERO 1 manda la comanda a cocina', async () => {
  await clicPorTexto(m1.page, 'Enviar comanda');
  await m1.page.waitForFunction(async () => {
    const r = await fetch('/api/restaurante/mesas', { credentials: 'same-origin' });
    const m = (await r.json()).mesas.find((x) => x.mesa === 1);
    return m && m.pendientes === 0;
  }, { timeout: 15000 });
  const c = await cuentaAbiertaDe(m1.page, 1);
  assert.strictEqual(c.pendientes, 0, 'no queda nada por mandar');
});

await t('D3. a MESERO 1 la pantalla NO le ofrece cobrar', async () => {
  // Se mira el DOM, no el texto visible: un botón puede existir y estar fuera
  // de la vista. Lo que importa es que NO EXISTA para un mesero.
  const acciones = await m1.page.$eval('#cu-secundarias', (el) => el.innerHTML);
  assert.ok(!/abrirPago|cerrarCuenta|dlg-libre/.test(acciones),
    `un mesero no debe tener siquiera el botón: ${acciones.slice(0, 200)}`);
  assert.match(acciones, /dividirIguales|abrirMover/, 'pero sí lo que sí le toca');
});

await t('D4. y si lo intentara, el servidor lo rechaza igual', async () => {
  // El servidor manda, no la pantalla: se comprueba que el guard existe aunque
  // alguien llegue por otro camino.
  const r = await m1.page.evaluate(async () => {
    const mesas = await (await fetch('/api/restaurante/mesas', { credentials: 'same-origin' })).json();
    const id = mesas.mesas.find((x) => x.mesa === 1).cuentaId;
    const res = await fetch(`/api/restaurante/cuentas/${id}/pagos`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metodo: 'efectivo', monto: 195 }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.codigo, 'ROL_NO_AUTORIZADO');
});

await t('D5. LA CAJA cobra y cierra la Mesa 1, desde la pantalla', async () => {
  await caja.page.goto(`${BASE}/restaurante`, { waitUntil: 'networkidle2' });
  // El tablero abre en "Mis mesas" y la caja no tiene mesas propias: hay que
  // pasar a "Todas" y buscar la Mesa 1 por su texto, no por posición.
  await clicPorTexto(caja.page, 'Todas');
  await caja.page.waitForFunction(() =>
    [...document.querySelectorAll('.mesa')].some((b) => /Mesa 1\b/.test(b.textContent)));
  const mesa1 = await caja.page.evaluateHandle(() =>
    [...document.querySelectorAll('.mesa')].find((b) => /Mesa 1\b/.test(b.textContent)));
  await mesa1.asElement().click();
  // El botón se llama "Registrar pago". El panel ya lo oculta a los meseros
  // con `puedeCobrar() = !SESION_MESERO` (mesas.html:318): la caja entra sin
  // sesión de estación, así que sí lo ve.
  await caja.page.waitForFunction(() =>
    /abrirPago/.test(document.getElementById('cu-secundarias')?.innerHTML || ''));
  await clicPorTexto(caja.page, 'Registrar pago', '#cu-secundarias');
  await caja.page.waitForFunction(() => document.querySelector('#dlg-pago')?.open === true);
  await caja.page.select('#pg-metodo', 'efectivo');
  await caja.page.click('#pg-monto');
  await caja.page.type('#pg-monto', '195');
  await clicPorTexto(caja.page, 'Registrar', '#dlg-pago');
  await caja.page.waitForFunction(() => document.querySelector('#dlg-pago')?.open !== true);

  await caja.page.waitForFunction(() =>
    /cerrarCuenta/.test(document.getElementById('cu-secundarias')?.innerHTML || ''));
  await clicPorTexto(caja.page, 'Cerrar cuenta', '#cu-secundarias');
  await caja.page.waitForFunction(async () => {
    const r = await fetch('/local/salud');
    return (await r.json()).mesasAbiertas === 1;   // queda solo la del mesero 2
  }, { timeout: 15000 });
});

await t('D6. la Mesa 1 queda cerrada con folio, y la del otro mesero sigue viva', async () => {
  const estado = await caja.page.evaluate(async () => (await (await fetch('/local/salud')).json()));
  assert.strictEqual(estado.mesasAbiertas, 1, 'se cerró la 1; la 3 del Mesero 2 no se toca');
  assert.ok(estado.pendientesDeSincronizar > 0, 'todo lo del corte queda en cola para subir');
  // El folio se deriva del UUID de la cuenta y se imprime en el ticket: se
  // comprueba que exista y tenga la forma definitiva.
  const folio = edge.sala.serializar().cuentas
    .find((c) => c.mesa_numero === 1 && c.estado === 'cerrada')?.venta_folio;
  assert.match(String(folio), /^RM-[0-9A-F]{8}-0$/, `folio inesperado: ${folio}`);
});

await t('D7. tras RECARGAR, el cobro sigue siendo uno solo y el folio no cambia', async () => {
  const antes = edge.sala.serializar().cuentas.find((c) => c.mesa_numero === 1 && c.estado === 'cerrada');
  assert.strictEqual(antes.pagos.length, 1, 'un cobro, no dos');

  // F5 en la caja: es donde una interfaz mal hecha reenvía el último POST.
  await caja.page.reload({ waitUntil: 'networkidle2' });
  await caja.page.waitForSelector('.mesa');
  await clicPorTexto(caja.page, 'Todas');
  await caja.page.waitForFunction(() =>
    [...document.querySelectorAll('.mesa')].some((b) => /Mesa 1\b/.test(b.textContent)));

  const despues = edge.sala.serializar().cuentas.find((c) => c.id === antes.id);
  assert.strictEqual(despues.pagos.length, 1, 'recargar no puede volver a cobrar');
  assert.strictEqual(despues.venta_folio, antes.venta_folio, 'ni cambiar el folio ya impreso');
  assert.strictEqual(despues.estado, 'cerrada');

  // Y la Mesa 1 vuelve a estar libre en el tablero, sin rastro de la anterior.
  const libre = await caja.page.evaluate(() =>
    [...document.querySelectorAll('.mesa')]
      .find((b) => /Mesa 1\b/.test(b.textContent)).textContent.toLowerCase());
  assert.match(libre, /disponible/, 'la mesa cobrada queda libre');
});

await t('D8. la sesión de la caja sobrevive a la recarga', async () => {
  const quien = await caja.page.evaluate(async () => {
    const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
    return r.ok ? (await r.json()).nombre : null;
  });
  assert.strictEqual(quien, 'Caja Principal', 'no debe mandarla al login tras un F5');
});

await navegador.close();
await edge.detener().catch(() => {});
try { rmSync(carpeta, { recursive: true, force: true }); } catch {}

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas === 0 ? 0 : 1);
