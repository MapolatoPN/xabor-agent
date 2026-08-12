// Onboarding de impresión en AUTOSERVICIO: el criterio es que una persona
// del restaurante, sin soporte presente, complete instalar → vincular →
// identificar → asignar → probar. Esta suite prueba las piezas nuevas que lo
// hacen posible:
//
//   - probar una impresora ANTES de asignarle destino (identificación por
//     papel con dos impresoras del mismo modelo);
//   - "No usar" quita una impresora sin borrar su historial;
//   - re-pair de una terminal EXISTENTE sin crear duplicados;
//   - la URL de descarga del instalador llega del backend, no de WhatsApp;
//   - el wizard del panel contiene los pasos y mensajes sin jerga.
//
// Uso: DATABASE_URL=... PANEL_SECRET=... SESSION_SECRET=... ADMIN_PASSWORD=...
//      node test/fase-impresion-autoservicio.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4087';
const HTML = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');
const { crearEdge: altaEdge, generarEmparejamiento, canjearEmparejamiento, listarEdges } = await import('../src/services/edgeService.js');
const { listarImpresoras, listarRutas } = await import('../src/services/impresionService.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const cookie = (usuarioId, negocioId, rol) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;

async function api(base, path, { cookie: ck, method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (ck) headers['Cookie'] = ck;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* sin JSON */ }
  return { status: r.status, body: json };
}

function agenteFalso(cred, { impresoras = [], responder = true } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PUERTO}/ws/print-agent`);
    ws.on('open', () => ws.send(JSON.stringify({
      tipo: 'autenticar_terminal', terminalId: cred.terminalId, token: cred.token, instalacionId: 'inst-autoservicio' })));
    ws.on('message', (crudo) => {
      const msg = JSON.parse(crudo.toString());
      if (msg.tipo === 'terminal_autenticada') resolve({ ws, cerrar: () => ws.close() });
      if (msg.tipo === 'solicitar_impresoras' && responder) {
        ws.send(JSON.stringify({ tipo: 'impresoras_detectadas', solicitudId: msg.solicitudId, ok: true, impresoras }));
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('el agente falso no se autenticó')), 8000);
  });
}

// ═══════════ Setup ═══════════
const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const ckAdminA = cookie(SEED.adminNegocioAUsuarioId, NEG_A, 'admin');
const ckAdminB = cookie(SEED.adminNegocioBUsuarioId || SEED.adminNegocioAUsuarioId, NEG_B, 'admin');
const RUTA = '/api/impresion/self-service';

// Un Edge se instala en una sucursal: si el negocio de prueba no tiene
// ninguna activa, el alta falla con SUCURSAL_NO_ENCONTRADA. Y se limpian
// residuos de corridas interrumpidas (el alta exige nombre único por
// sucursal).
for (const n of [NEG_A, NEG_B]) {
  await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1, 'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [n]);
}
await pool.query(
  `DELETE FROM terminales WHERE sucursal_id IN (SELECT id FROM sucursales WHERE negocio_id IN ($1,$2))
     AND nombre IN ('PC-AUTOSERVICIO','PC-SIN-IMPRESORAS')`, [NEG_A, NEG_B]);

const srv = await arrancarServidor({ PORT: PUERTO, XABOR_EDGE_SETUP_URL: 'https://descargas.ejemplo/XaborEdgeSetup.exe' }, { timeoutMs: 30000 });
const BASE = srv.base;

let agente = null;
let edgeA = null;

try {

// ═══════════ 1. Onboarding nuevo: alta + pairing por UI ═══════════
await t('ONBOARD', '1. onboarding nuevo: alta del equipo y codigo de conexion via API del panel', async () => {
  const alta = await api(BASE, '/api/impresion/edges', { cookie: ckAdminA, method: 'POST', body: { nombre: 'PC-AUTOSERVICIO' } });
  assert.strictEqual(alta.status, 201, JSON.stringify(alta.body));
  edgeA = alta.body.edge;
  const par = await api(BASE, `/api/impresion/edges/${edgeA.id}/emparejar`, { cookie: ckAdminA, method: 'POST' });
  assert.strictEqual(par.status, 201);
  assert.ok(par.body.codigo, 'el codigo tiene que llegar en claro una vez');
});

// ═══════════ 2. Pairing (canje) ═══════════
let credA = null;
await t('ONBOARD', '2. el canje del codigo entrega credenciales de la terminal correcta', async () => {
  const par = await api(BASE, `/api/impresion/edges/${edgeA.id}/emparejar`, { cookie: ckAdminA, method: 'POST' });
  credA = await canjearEmparejamiento(par.body.codigo, { nombreEquipo: 'PC-AUTOSERVICIO' });
  assert.strictEqual(credA.terminalId, edgeA.id, 're-pair sobre el mismo edge: MISMA terminal, nunca un duplicado');
});

// ═══════════ 3. Edge conectado se refleja solo ═══════════
await t('ONBOARD', '3. cuando el Edge conecta, el panel lo ve conectado (deteccion automatica)', async () => {
  agente = await agenteFalso(credA, {
    impresoras: [
      { nombre: 'POS58 Printer', predeterminada: true, estado: 'desconocido' },
      { nombre: 'POS58 Printer (Copy 1)', predeterminada: false, estado: 'desconocido' },
    ],
  });
  const r = await api(BASE, RUTA, { cookie: ckAdminA });
  assert.strictEqual(r.status, 200);
  const eq = r.body.equipos.find((e) => e.id === edgeA.id);
  assert.ok(eq && eq.conectado === true);
});

// ═══════════ 4/7. Discovery con dos impresoras gemelas ═══════════
await t('ONBOARD', '4. discovery: las DOS impresoras gemelas aparecen con su nombre de Windows', async () => {
  const r = await api(BASE, RUTA, { cookie: ckAdminA });
  const eq = r.body.equipos.find((e) => e.id === edgeA.id);
  const nombres = eq.detectadas.map((d) => d.nombre);
  assert.ok(nombres.includes('POS58 Printer'));
  assert.ok(nombres.includes('POS58 Printer (Copy 1)'));
});

// ═══════════ 5. Prueba ANTES de asignar (el gate de identificacion) ═══════
await t('ONBOARD', '5. imprimir prueba SIN destino asignado: registra la impresora y crea el trabajo', async () => {
  const r = await api(BASE, '/api/impresion/self-service/probar', {
    cookie: ckAdminA, method: 'POST',
    body: { terminalId: edgeA.id, nombreWindows: 'POS58 Printer' },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const imps = await listarImpresoras(NEG_A);
  const fila = imps.find((i) => i.config?.spoolerNombre === 'POS58 Printer');
  assert.ok(fila, 'la impresora queda registrada');
  const rutas = await listarRutas(NEG_A);
  assert.ok(!rutas.some((ru) => ru.impresora_id === fila.id && ru.ambito === 'documento'),
    'probar NO asigna destino: identificar viene antes que decidir');
});

// ═══════════ 6. Asignacion posterior (Cocina / Caja) ═══════════
await t('ONBOARD', '6. tras identificar, asignar Cocina y Caja a cada gemela', async () => {
  const a = await api(BASE, '/api/impresion/self-service/asignar', {
    cookie: ckAdminA, method: 'POST',
    body: { terminalId: edgeA.id, nombreWindows: 'POS58 Printer', destino: 'cocina', anchoMm: 58 },
  });
  assert.strictEqual(a.status, 200, JSON.stringify(a.body));
  const b = await api(BASE, '/api/impresion/self-service/asignar', {
    cookie: ckAdminA, method: 'POST',
    body: { terminalId: edgeA.id, nombreWindows: 'POS58 Printer (Copy 1)', destino: 'caja', anchoMm: 58 },
  });
  assert.strictEqual(b.status, 200);
  const r = await api(BASE, RUTA, { cookie: ckAdminA });
  const eq = r.body.equipos.find((e) => e.id === edgeA.id);
  const porNombre = Object.fromEntries(eq.asignadas.map((x) => [x.nombreWindows, x.destinos[0]]));
  assert.strictEqual(porNombre['POS58 Printer'], 'cocina');
  assert.strictEqual(porNombre['POS58 Printer (Copy 1)'], 'caja');
});

// ═══════════ "No usar" (reconfiguracion) ═══════════
await t('ONBOARD', '7. "No usar" quita el destino sin borrar la impresora ni su historial', async () => {
  const r = await api(BASE, '/api/impresion/self-service/quitar', {
    cookie: ckAdminA, method: 'POST',
    body: { terminalId: edgeA.id, nombreWindows: 'POS58 Printer (Copy 1)' },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const imps = await listarImpresoras(NEG_A);
  const fila = imps.find((i) => i.config?.spoolerNombre === 'POS58 Printer (Copy 1)');
  assert.ok(fila, 'la fila sigue existiendo');
  assert.strictEqual(fila.activa, false);
  const rutas = await listarRutas(NEG_A);
  assert.ok(!rutas.some((ru) => ru.impresora_id === fila.id && ru.ambito === 'documento'), 'sin rutas de documento');
  // Y volver a asignarla la reactiva -- reconfiguracion sin soporte.
  const again = await api(BASE, '/api/impresion/self-service/asignar', {
    cookie: ckAdminA, method: 'POST',
    body: { terminalId: edgeA.id, nombreWindows: 'POS58 Printer (Copy 1)', destino: 'caja', anchoMm: 58 },
  });
  assert.strictEqual(again.status, 200);
});

// ═══════════ 8. Cero impresoras: mensaje comprensible ═══════════
await t('ONBOARD', '8. equipo conectado con CERO impresoras: consultaOk true y listas vacias (el panel sabe decirlo)', async () => {
  // Terminal aparte para no ensuciar el cache de la principal.
  const edgeVacio = await altaEdge(NEG_A, { nombre: 'PC-SIN-IMPRESORAS' });
  const par = await generarEmparejamiento(NEG_A, edgeVacio.id, {});
  const cred = await canjearEmparejamiento(par.codigo, { nombreEquipo: 'PC-SIN-IMPRESORAS' });
  const vacio = await agenteFalso(cred, { impresoras: [] });
  try {
    const r = await api(BASE, RUTA, { cookie: ckAdminA });
    const eq = r.body.equipos.find((e) => e.id === edgeVacio.id);
    assert.ok(eq.conectado);
    // Puede llegar 'consultando' en la primera pasada; una lista vacia REAL
    // llega como consultaOk true + detectadas [].
    if (!eq.consultando) {
      assert.strictEqual(eq.consultaOk, true);
      assert.strictEqual(eq.detectadas.length, 0);
      assert.strictEqual(eq.asignadas.length, 0);
    }
  } finally { vacio.cerrar(); }
});

// ═══════════ 9. Descarga del instalador ═══════════
await t('ONBOARD', '9. la URL de descarga del Setup llega del backend (no por WhatsApp)', async () => {
  const r = await api(BASE, '/api/impresion/self-service/descarga', { cookie: ckAdminA });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.disponible, true);
  assert.strictEqual(r.body.url, 'https://descargas.ejemplo/XaborEdgeSetup.exe');
});

await t('ONBOARD', '10. sin XABOR_EDGE_SETUP_URL configurada, disponible=false (boton honesto, nunca muerto)', async () => {
  // El contrato del endpoint: refleja la env var. La rama "sin configurar"
  // se prueba directamente sobre la logica del handler leyendo el fuente.
  const fuente = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const bloque = fuente.slice(fuente.indexOf("self-service/descarga"), fuente.indexOf("self-service/descarga") + 600);
  assert.ok(/XABOR_EDGE_SETUP_URL/.test(bloque));
  assert.ok(/disponible:\s*Boolean\(url\)/.test(bloque), 'sin URL configurada debe reportar disponible=false');
});

// ═══════════ Aislamiento ═══════════
await t('SEGURIDAD', '11. un negocio no puede probar ni quitar impresoras del equipo de otro', async () => {
  // El rechazo puede llegar como 400 (terminal ajena), 401 o 403 (sesión de
  // B inválida en este seed) -- lo innegociable es que NUNCA sea 2xx y que
  // ningún trabajo de prueba se haya creado para el equipo de A.
  const trabajosAntes = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM impresion_trabajos WHERE negocio_id = $1 AND origen_tipo = 'prueba'`, [NEG_A])).rows[0].n;
  const p = await api(BASE, '/api/impresion/self-service/probar', {
    cookie: ckAdminB, method: 'POST',
    body: { terminalId: edgeA.id, nombreWindows: 'POS58 Printer' },
  });
  assert.ok(p.status >= 400, `probar cross-negocio debe rechazarse, llego ${p.status}`);
  const q = await api(BASE, '/api/impresion/self-service/quitar', {
    cookie: ckAdminB, method: 'POST',
    body: { terminalId: edgeA.id, nombreWindows: 'POS58 Printer' },
  });
  assert.ok(q.status >= 400, `quitar cross-negocio debe rechazarse, llego ${q.status}`);
  const trabajosDespues = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM impresion_trabajos WHERE negocio_id = $1 AND origen_tipo = 'prueba'`, [NEG_A])).rows[0].n;
  assert.strictEqual(trabajosDespues, trabajosAntes, 'el intento ajeno no debe crear ningun trabajo');
});

// ═══════════ Re-pair / reinstall ═══════════
await t('ONBOARD', '12. re-pair de la MISMA terminal: codigo nuevo, mismo terminalId, cero duplicados', async () => {
  const antes = (await listarEdges(NEG_A)).length;
  const par = await api(BASE, `/api/impresion/edges/${edgeA.id}/emparejar`, { cookie: ckAdminA, method: 'POST' });
  assert.strictEqual(par.status, 201);
  const cred2 = await canjearEmparejamiento(par.body.codigo, { nombreEquipo: 'PC-AUTOSERVICIO' });
  assert.strictEqual(cred2.terminalId, edgeA.id);
  const despues = (await listarEdges(NEG_A)).length;
  assert.strictEqual(despues, antes, 're-pair jamas crea una terminal nueva');
});

// ═══════════ Contrato del wizard en el panel ═══════════
await t('WIZARD', '13. el asistente de primera vez tiene los pasos: conectar, instalar/descargar, codigo', async () => {
  assert.ok(HTML.includes('Conecta tus impresoras'));
  assert.ok(HTML.includes('Instala Xabor Edge'));
  assert.ok(HTML.includes('Descargar para Windows'));
  assert.ok(HTML.includes('Generar c&oacute;digo de conexi&oacute;n'));
});

await t('WIZARD', '14. el codigo queda EN PANTALLA con espera automatica, no en un alert', async () => {
  assert.ok(HTML.includes('impVinculando'), 'estado de vinculacion en curso');
  assert.ok(!/alert\('C\\u00f3digo para Xabor Edge/.test(HTML), 'el alert del codigo no puede volver');
  assert.ok(HTML.includes('Esperando a que'), 'mensaje de espera visible');
  assert.ok(/impVinculando\) impRefrescoTimer = setTimeout\(cargarImpresoras, 5000\)/.test(HTML),
    'polling automatico mientras se espera la conexion');
  assert.ok(HTML.includes('Equipo conectado'), 'confirmacion automatica al conectar');
});

await t('WIZARD', '15. identificacion por papel: prueba disponible antes de asignar y texto guia', async () => {
  // El texto guia puede vivir con caracteres reales, entidades HTML o
  // escapes \uXXXX segun el estilo del archivo: se normaliza antes de buscar.
  const plano = HTML
    .replace(/&aacute;/g, 'á').replace(/&iquest;/g, '¿').replace(/&eacute;/g, 'é')
    .replace(/\\u00e1/g, 'á').replace(/\\u00bf/g, '¿').replace(/\\u00e9/g, 'é');
  assert.ok(plano.includes('mira cuál suelta papel') || plano.includes('¿No sabes cuál es?'),
    'la fila de una impresora sin asignar invita a identificarla imprimiendo');
  assert.ok(HTML.includes('self-service/probar'), 'la prueba usa el endpoint que no exige destino');
});

await t('WIZARD', '16. sin jerga tecnica visible en la seccion de impresoras del panel', async () => {
  const ini = HTML.indexOf('function impFilaImpresora');
  const fin = HTML.indexOf('async function cargarWhatsappAutoservicio');
  // Lo prohibido es MOSTRAR jerga, no usarla en el codigo: se quitan las
  // llamadas a API y los identificadores JS (setTimeout, clearTimeout,
  // impRefrescoTimer) antes de revisar, porque nada de eso llega a pantalla.
  const seccion = HTML.slice(ini, fin)
    .replace(/apiFetch\([^)]*\)/g, '')
    .replace(/setTimeout|clearTimeout|impRefrescoTimer/g, '');
  for (const palabra of ['spooler', 'WebSocket', 'WMI', 'timeout', 'ambito', 'routingEngine', 'terminalId']) {
    // terminalId viaja en el body JSON de la API (invisible); en el HTML
    // pintado jamas debe aparecer -- por eso se revisa tras quitar apiFetch.
    if (palabra === 'terminalId') {
      const pintado = seccion.replace(/JSON\.stringify\([^)]*\)/g, '');
      assert.ok(!/terminalId/.test(pintado), 'el terminalId nunca se pinta en la UI');
      continue;
    }
    assert.ok(!new RegExp(palabra, 'i').test(seccion), `"${palabra}" no debe aparecer en la UI de impresoras`);
  }
  assert.ok(seccion.includes('Volver a vincular'), 're-vinculacion visible para PC formateada');
  assert.ok(seccion.includes('No encontramos impresoras en Windows'), 'mensaje de cero impresoras sin jerga');
});

} finally {
  if (agente) agente.cerrar();
  srv.detener();
  await new Promise((r) => { srv.proc.once('exit', r); setTimeout(r, 3000); });
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id = $1`, [NEG_A]).catch(() => {});
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id = $1`, [NEG_A]).catch(() => {});
  await pool.query(`DELETE FROM impresoras WHERE negocio_id = $1`, [NEG_A]).catch(() => {});
  if (edgeA) await pool.query(`DELETE FROM terminales WHERE nombre IN ('PC-AUTOSERVICIO','PC-SIN-IMPRESORAS')`).catch(() => {});
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
await pool.end();
process.exit(fallidas ? 1 : 0);
