// «📦 Entregado» en la agenda de programados.
//
// El 19-oct había cuatro programados ya activados que seguían en «nuevo» días
// después (XAB-1401, XAB-1440, XAB-1734, XAB-1998). «En curso» oculta al
// recargar lo registrado un día antes, y a los de recoger en tienda no los
// lista ninguna otra vista: la agenda los mostraba sin forma de cerrarlos.
// Lo que esta suite protege:
//   · el botón sale SOLO para admin, y solo en un programado activado, abierto,
//     sin pago pendiente ni cancelado, cuya hora ya pasó;
//   · el clic pide confirmación y hace UN solo PATCH a la ruta de siempre
//     (la misma de Domicilio › «Sin cerrar de días anteriores»), sin imprimir;
//   · un error se avisa y deja reintentar;
//   · el panel REAL le pasa el rol y refresca la agenda al cerrar.
//
// Parte A: el módulo en una VM, sin red. Parte B: el panel real con Puppeteer
// contra un servidor de juguete que sirve panel/ (sin Postgres ni seed).
// Uso: node test/fase-programados-cerrar.mjs [--capturas]
//   --capturas escribe en PROGRAMADOS_QA_DIR (o test/) la vista de admin.
import http from 'node:http';
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = join(__dirname, '..', 'panel');
const codigo = readFileSync(join(PANEL_DIR, 'programados.js'), 'utf8');

let pasadas = 0, fallidas = 0;
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const esperar = (ms = 5) => new Promise(r => setTimeout(r, ms));

const AHORA = Date.parse('2026-10-19T14:00:00Z');
const base = {
  folio: 'XAB-1734', negocio_id: 'neg-prueba', programado_id: 'reserva-1734',
  programado_para: '2026-10-15T12:30:00.000Z', activado: true, estado_operativo: 'nuevo',
  estado_pago: 'pagado', pago_confirmado: true, cliente: 'Cliente de prueba',
  modalidad: 'recoger en tienda', total: 225, items: [{ cantidad: 1, nombre: 'Combito de Chilaquiles' }],
};
const ADMIN = { admin: true, ahora: AHORA };

// ── Parte A: el módulo, aislado ──────────────────────────────────────────────
const g = {};
vm.runInNewContext(codigo, { window: g, Intl, Date, Number, Object, Array, String });
const P = g.XaborProgramados;
const botonesCerrar = html => (html.match(/data-programado-cerrar=/g) || []).length;

console.log('A. Regla y acción del botón (módulo aislado)');
await t('A1. admin ve «📦 Entregado» en un programado activado, abierto, pagado y vencido', () => {
  const html = P.tarjeta(base, ADMIN);
  assert(botonesCerrar(html) === 1, `botones: ${botonesCerrar(html)}`);
  assert(html.includes('data-programado-cerrar="XAB-1734"') && html.includes('📦 Entregado'), html);
  assert(html.includes('data-programado-folio="XAB-1734"'), 'se perdió «Imprimir copia»');
});
await t('A2. staff no lo ve; tampoco sin opciones ni con admin que no sea true', () => {
  for (const op of [{ admin: false, ahora: AHORA }, { ahora: AHORA }, { admin: 'true', ahora: AHORA }, undefined])
    assert(botonesCerrar(P.tarjeta(base, op)) === 0, `salió con ${JSON.stringify(op)}`);
});
await t('A3. cada condición por sí sola lo quita', () => {
  const variantes = {
    'reserva sin activar': { activado: false },
    'hora futura': { programado_para: '2026-10-19T15:00:00.000Z' },
    'pago pendiente': { estado_pago: 'pendiente' },
    'cancelado': { estado_pago: 'cancelado' },
    'pendiente_pago': { estado_operativo: 'pendiente_pago' },
    'entregado': { estado_operativo: 'entregado' },
    'sin fecha': { programado_para: null },
    'fecha ilegible': { programado_para: 'mañana temprano' },
  };
  for (const [nombre, cambio] of Object.entries(variantes))
    assert(botonesCerrar(P.tarjeta({ ...base, ...cambio }, ADMIN)) === 0, `salió con ${nombre}`);
});
await t('A4. en preparación, listo, pago al recibir y por verificar sí se cierran', () => {
  for (const cambio of [{ estado_operativo: 'en_preparacion' }, { estado_operativo: 'listo' },
                        { estado_pago: 'al_recibir' }, { estado_pago: 'por_verificar' }])
    assert(botonesCerrar(P.tarjeta({ ...base, ...cambio }, ADMIN)) === 1, `no salió con ${JSON.stringify(cambio)}`);
});
await t('A5. un folio con HTML no se ejecuta en el botón', () => {
  const html = P.tarjeta({ ...base, folio: '" onclick=alert(1) x="' }, ADMIN);
  assert(!html.includes('data-programado-cerrar="" onclick='), html);
  assert(html.includes('data-programado-cerrar="&quot; onclick=alert(1) x=&quot;"'), html);
});

// Un grid y un botón de juguete con el mismo contrato que el DOM.
function montar(opciones) {
  let listener;
  const boton = { disabled: false, textContent: '📦 Entregado', dataset: { programadoCerrar: base.folio } };
  const grid = { dataset: {}, innerHTML: '', contains: b => b === boton, addEventListener: (_, fn) => { listener = fn; } };
  P.renderizar([base], grid, { style: {} }, opciones);
  const clic = () => listener({ target: { closest: s => (s === 'button[data-programado-cerrar]' ? boton : null) } });
  return { boton, grid, clic };
}
function espiar({ confirmar = true, respuesta = { ok: true, json: async () => ({}) } } = {}) {
  const e = { patch: [], get: 0, abiertos: 0, confirmaciones: 0, alertas: [], refrescos: 0, liberar: null };
  g.confirm = () => { e.confirmaciones++; return confirmar; };
  g.alert = m => e.alertas.push(m);
  g.open = () => { e.abiertos++; return null; };
  g.apiFetch = async (url, op = {}) => {
    if ((op.method || 'GET') === 'GET') { e.get++; return { ok: true, json: async () => [] }; }
    e.patch.push({ url, method: op.method, body: op.body });
    await new Promise(r => { e.liberar = r; });
    return typeof respuesta === 'function' ? respuesta() : respuesta;
  };
  return e;
}

await t('A6. cancelar la confirmación no manda nada', async () => {
  const e = espiar({ confirmar: false });
  const { clic, boton } = montar({ ...ADMIN, alCerrar: () => { e.refrescos++; } });
  try {
    clic(); await esperar();
    assert(e.confirmaciones === 1 && e.patch.length === 0 && !boton.disabled, JSON.stringify(e));
  } finally { e.liberar?.(); await esperar(); }
});
await t('A7. aceptar hace UN PATCH a la ruta de siempre, sin imprimir; el doble clic no repite', async () => {
  const e = espiar();
  const { clic, boton } = montar({ ...ADMIN, alCerrar: () => { e.refrescos++; } });
  // Si una aserción cae con la petición en vuelo, se libera igual: si no, el
  // folio queda marcado «cerrando» y arrastra a los casos siguientes.
  try {
    clic(); clic(); await esperar();
    assert(e.patch.length === 1, `PATCH: ${e.patch.length}`);
    assert(e.patch[0].url === '/pedidos/XAB-1734/estado' && e.patch[0].method === 'PATCH', JSON.stringify(e.patch[0]));
    assert(e.patch[0].body === JSON.stringify({ estado: 'entregado' }), e.patch[0].body);
    assert(boton.disabled && boton.textContent === 'Cerrando…', 'el botón no se bloqueó en vuelo');
    const repintada = P.tarjeta(base, ADMIN);
    assert(repintada.includes('Cerrando…') && /data-programado-cerrar="XAB-1734" disabled/.test(repintada), 'el repintado en vuelo reactivó el botón');
  } finally { e.liberar?.(); await esperar(); }
  assert(e.refrescos === 1, `refrescos: ${e.refrescos}`);
  assert(e.abiertos === 0 && e.get === 0, 'cerrar no debe abrir copia ni consultar');
  assert(P.tarjeta(base, ADMIN).includes('📦 Entregado'), 'tras el refresco el folio quedó marcado en vuelo');
});
await t('A8. un error del servidor se avisa, reactiva el botón y deja reintentar', async () => {
  const e = espiar({ respuesta: { ok: false, json: async () => ({ error: 'Pedido no encontrado' }) } });
  const { clic, boton } = montar({ ...ADMIN, alCerrar: () => { e.refrescos++; } });
  try {
    clic(); await esperar(); e.liberar(); await esperar();
    assert(e.alertas.length === 1 && e.alertas[0] === 'Pedido no encontrado', JSON.stringify(e.alertas));
    assert(!boton.disabled && boton.textContent === '📦 Entregado' && e.refrescos === 0, 'quedó bloqueado o refrescó');
    e.liberar = null;
    clic(); await esperar(); e.liberar?.(); await esperar();
    assert(e.patch.length === 2, `reintentos: ${e.patch.length}`);
  } finally { e.liberar?.(); await esperar(); }
});
await t('A9. con un botón forjado, staff no confirma ni manda nada', async () => {
  const e = espiar();
  const { clic } = montar({ admin: false, ahora: AHORA });
  clic(); await esperar();
  assert(e.confirmaciones === 0 && e.patch.length === 0, JSON.stringify(e));
});

// ── Parte B: el panel real ───────────────────────────────────────────────────
console.log('B. Panel real (Puppeteer + servidor de juguete)');
const estado = { rol: 'admin', lista: [], patch: [] };
const vencido = { ...base, programado_para: new Date(Date.now() - 4 * 864e5).toISOString() };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const servidor = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (cuerpo, extra = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(cuerpo)); };
  if (req.method === 'PATCH' && /^\/pedidos\/[^/]+\/estado$/.test(url)) {
    let cuerpo = ''; req.on('data', c => { cuerpo += c; });
    return req.on('end', () => {
      estado.patch.push({ url, body: cuerpo, tipo: req.headers['content-type'] });
      estado.lista = estado.lista.filter(p => `/pedidos/${encodeURIComponent(p.folio)}/estado` !== url);
      json({ ok: true });
    });
  }
  if (url === '/api/auth/me') return json({ rol: estado.rol, negocioId: 'neg-prueba', modulos: ['pos', 'whatsapp', 'menu'], whatsappConfigurado: true });
  if (url === '/api/pedidos-programados') return json(estado.lista, { 'X-Agenda-Programados': 'v1' });
  if (url === '/api/admin/checklist-activacion-bot') return json({ automaticos: {}, manuales: {}, listoParaActivar: false });
  if (url.startsWith('/api/')) return json({});
  const archivo = (url === '/' || url === '/app') ? join(PANEL_DIR, 'index.html') : join(PANEL_DIR, url.replace(/^\//, ''));
  if (archivo.startsWith(PANEL_DIR) && existsSync(archivo) && extname(archivo)) {
    res.writeHead(200, { 'content-type': MIME[extname(archivo)] || 'application/octet-stream' });
    return res.end(readFileSync(archivo));
  }
  res.writeHead(404); res.end('no');
});
await new Promise(r => servidor.listen(Number(process.env.TEST_PORT_PROG_CERRAR || 0), r));
const puerto = servidor.address().port;
const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });

async function abrirPanel(rol) {
  estado.rol = rol; estado.lista = [vencido, { ...vencido, folio: 'XAB-2001', programado_id: 'reserva-2001', activado: false, estado_pago: 'pendiente', programado_para: new Date(Date.now() + 864e5).toISOString() }];
  const page = await navegador.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`http://localhost:${puerto}/app#pedidos`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.querySelectorAll('#grid-programados article').length === 2, { timeout: 8000 });
  return page;
}
const contar = (page, sel) => page.$$eval(sel, els => els.length);

try {
  await t('B1. el panel carga programados.js con la versión de su contenido', async () => {
    const { createHash } = await import('node:crypto');
    const html = readFileSync(join(PANEL_DIR, 'index.html'), 'utf8');
    const v = createHash('sha256').update(codigo).digest('hex').slice(0, 8);
    assert(html.includes(`/programados.js?v=${v}`), `index.html no trae ?v=${v}: el navegador seguiría con el programados.js viejo`);
  });

  const admin = await abrirPanel('admin');
  await t('B2. admin: solo el programado vencido trae «📦 Entregado»; la reserva futura no', async () => {
    assert(await contar(admin, '#grid-programados button[data-programado-cerrar]') === 1, 'no hay exactamente un botón');
    assert(await contar(admin, '#grid-programados button[data-programado-cerrar="XAB-1734"]') === 1, 'no es el del vencido');
    assert(await contar(admin, '#grid-programados button[data-programado-folio]') === 2, 'se perdió «Imprimir copia»');
    const desbordes = await admin.$$eval('#grid-programados article', els => els.filter(e => e.scrollWidth > e.clientWidth + 1).length);
    assert(desbordes === 0, `${desbordes} tarjetas desbordan`);
  });
  if (process.argv.includes('--capturas')) {
    const dir = process.env.PROGRAMADOS_QA_DIR || __dirname;
    await (await admin.$('#programados-wrap')).screenshot({ path: join(dir, 'programados-cerrar-admin.png') });
  }
  await t('B3. el clic confirma, manda PATCH entregado y la tarjeta sale de la agenda', async () => {
    const dialogos = [];
    admin.on('dialog', d => { dialogos.push(d.message()); d.accept(); });
    await admin.click('#grid-programados button[data-programado-cerrar="XAB-1734"]');
    await admin.waitForFunction(() => document.querySelectorAll('#grid-programados article').length === 1, { timeout: 8000 });
    assert(dialogos.length === 1 && dialogos[0].includes('XAB-1734'), JSON.stringify(dialogos));
    assert(estado.patch.length === 1, `PATCH: ${estado.patch.length}`);
    assert(estado.patch[0].url === '/pedidos/XAB-1734/estado' && estado.patch[0].body === '{"estado":"entregado"}', JSON.stringify(estado.patch[0]));
    assert(/application\/json/.test(estado.patch[0].tipo || ''), `content-type: ${estado.patch[0].tipo}`);
    assert(await contar(admin, '#grid-programados button[data-programado-cerrar]') === 0, 'quedó un botón de cierre');
  });
  await admin.close();

  const staff = await abrirPanel('staff');
  await t('B4. staff ve la agenda y la copia, pero no el botón', async () => {
    assert(await contar(staff, '#grid-programados button[data-programado-folio]') === 2, 'staff perdió la agenda');
    assert(await contar(staff, '#grid-programados button[data-programado-cerrar]') === 0, 'staff ve «📦 Entregado»');
  });
  await staff.close();
} finally {
  await navegador.close();
  servidor.close();
}

console.log(`\nProgramados — cerrar desde la agenda: ${pasadas} pasadas, ${fallidas} fallidas`);
process.exit(fallidas ? 1 : 0);
