// El cajero: lo del operador (pedidos y mesas) más Chats, Historial,
// Facturación (sin su configuración), Cotizaciones y el fondo de caja del
// día. Nunca totales de ventas.
//
// Regla del dueño (2026-09-24, Fase 3.3 del menú). Lo que esta suite protege:
//   A. (estático) que la puerta de cajero (requireCajeroSeguro) la usen
//      EXACTAMENTE las rutas de la lista de abajo: una ruta nueva no se abre
//      al cajero sin decidirlo, y lo que es de admin no se le abre por error.
//   B. (servidor real) que el cajero entre a lo suyo; que reciba "permiso
//      insuficiente" en lo que no es suyo, totales de ventas incluidos; y que
//      el operador siga sin entrar a lo del cajero.
//   C. el fondo de caja: el cajero registra el de HOY una sola vez, el
//      segundo recibe "ya registrado", otro día no, y el admin lo corrige.
//   D. Usuarios: el admin da de alta cajeros y cambia Operador ↔ Cajero; esa
//      ruta no fabrica admins ni la usa nadie más.
//   E. (WebSocket real) al cajero le llegan los chats y los pedidos nuevos.
//
// Los módulos que ejercita (caja, usuarios, pos) se encienden para el negocio
// de prueba y al final se dejan como estaban; lo mismo el fondo de hoy.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import assert from 'assert';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_PERMISOS_CAJERO || '4797';
const SERVER = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf8');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// ─── A. Qué rutas tiene el cajero además de las del operador ────────────────
const ABIERTAS_AL_CAJERO = new Set(`
  GET /api/admin/facturacion/estado
  GET /api/admin/facturacion/recibos
  POST /api/admin/facturacion/recibos/:folio/sincronizar
  POST /api/admin/facturacion/autofacturas/:folio
  GET /api/admin/facturacion/servicios
  POST /api/admin/facturacion/servicios
  POST /api/admin/facturacion/servicios/:id/reanudar
  POST /api/admin/facturacion/servicios/:id/sincronizar
  GET /api/admin/clientes-fiscales
  GET /api/admin/clientes-fiscales/por-telefono/:telefono
  POST /api/admin/clientes-fiscales
  POST /api/admin/pedido/:folio/factura
  GET /api/admin/factura/:facturaId/pdf
  GET /api/conversaciones
  GET /api/conversacion/:telefono
  POST /api/send-message
  POST /api/conversacion/:telefono/pausar
  POST /api/conversacion/:telefono/reactivar
  GET /api/conversacion/:telefono/estado-bot
  POST /api/documentos/enviar
  GET /api/documentos/:id
  GET /api/documentos/:id/archivo
  POST /api/imagenes/enviar
  GET /api/imagenes/:id
  GET /api/imagenes/:id/archivo
  GET /api/historial
  GET /api/cotizaciones
  GET /api/cotizaciones/:id
  POST /api/cotizaciones
  PATCH /api/cotizaciones/:id
  GET /api/cotizaciones/:id/pdf
  POST /api/cotizaciones/:id/enviar
  GET /api/caja/fondo
  POST /api/caja/fondo
`.trim().split('\n').map(s => s.trim()));

function rutasConPuertaDeCajero(src) {
  const rutas = [];
  for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2([^\n]*)/g)) {
    const inicioLinea = src.lastIndexOf('\n', m.index) + 1;
    if (src.slice(inicioLinea, m.index).includes('//')) continue;   // ejemplo dentro de un comentario
    if (/\brequireCajeroSeguro\b/.test(m[4])) rutas.push(`${m[1].toUpperCase()} ${m[3]}`);
  }
  return rutas;
}

await t('RUTAS', 'la puerta de cajero la usan exactamente las rutas de la lista', () => {
  const conPuerta = rutasConPuertaDeCajero(SERVER);
  const sobran = conPuerta.filter(r => !ABIERTAS_AL_CAJERO.has(r));
  const faltan = [...ABIERTAS_AL_CAJERO].filter(r => !conPuerta.includes(r));
  assert.deepStrictEqual(sobran, [], `rutas abiertas al cajero fuera de la lista (¿debían ser requireAdminSeguro?): ${sobran.join(', ')}`);
  assert.deepStrictEqual(faltan, [], `rutas de la lista que ya no tienen la puerta de cajero: ${faltan.join(', ')}`);
});

await t('RUTAS', 'la jerarquía pone al cajero entre el operador y el admin; el legado no pasa la puerta de cajero', () => {
  const m = SERVER.match(/const JERARQUIA_ROLES = \{([^}]*)\}/);
  assert.ok(m, 'no se encontró JERARQUIA_ROLES');
  const nivel = Object.fromEntries([...m[1].matchAll(/(\w+):\s*(\d+)/g)].map(x => [x[1], Number(x[2])]));
  assert.ok(nivel.staff < nivel.cajero && nivel.cajero < nivel.admin, `jerarquía: ${JSON.stringify(nivel)}`);
  assert.match(SERVER, /if \(\(rolMinimo === 'admin' \|\| rolMinimo === 'cajero'\) && role !== 'admin'\)/,
    'un token legado de operador pasaría la puerta de cajero');
});

await t('RUTAS', 'los avisos "solo admin" del WebSocket no llegan al cajero; los de chat sí', () => {
  assert.match(SERVER, /if \(opciones\.soloAdmin && client\.rol !== 'admin'\) return;/,
    'los avisos soloAdmin (red de repartidores) llegarían al cajero');
  assert.match(SERVER, /if \(client\.rol === 'staff' && EVENTOS_WS_SOLO_ADMIN\.has\(data\?\.tipo\)\) return;/,
    'el filtro de chats debe seguir siendo solo para el operador');
});

// ─── B-E. Con el servidor real ──────────────────────────────────────────────
const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, guardarMensaje, crearUsuarioConPassword } = await import('../src/services/database.js');
const cookie = (usuarioId, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId: SEED.negocioA, rol }))}`;
const ADMIN = cookie(SEED.adminNegocioAUsuarioId, 'admin');
const OPERADOR = cookie(SEED.staffNegocioAUsuarioId, 'staff');

async function api(base, metodo, ruta, galleta, body) {
  const r = await fetch(base + ruta, {
    method: metodo, headers: { 'Content-Type': 'application/json', Cookie: galleta },
    body: metodo === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  let json = null; try { json = await r.json(); } catch { /* binario o vacío */ }
  return { status: r.status, body: json };
}
// La puerta de rol responde 403 SIN `codigo`; la de módulo responde 403 CON
// `codigo`. Así no depende de qué módulos tenga el negocio de prueba.
const rechazoPorRol = (r) => r.status === 403 && !(r.body && r.body.codigo);

const TEL = '5218789990431';
const UUID = randomUUID();
const FOLIO = 'XAB-999931';
// Lo del cajero, con cuerpos vacíos o ids que no existen: la puerta decide
// antes que cualquier efecto (nada se envía, timbra ni guarda).
const DEL_CAJERO = [
  ['GET', '/api/admin/facturacion/estado'], ['GET', '/api/admin/facturacion/recibos'],
  ['POST', `/api/admin/facturacion/recibos/${FOLIO}/sincronizar`], ['POST', `/api/admin/facturacion/autofacturas/${FOLIO}`],
  ['GET', '/api/admin/facturacion/servicios'], ['POST', '/api/admin/facturacion/servicios'],
  ['POST', `/api/admin/facturacion/servicios/${UUID}/reanudar`], ['POST', `/api/admin/facturacion/servicios/${UUID}/sincronizar`],
  ['GET', '/api/admin/clientes-fiscales'], ['GET', `/api/admin/clientes-fiscales/por-telefono/${TEL}`],
  ['POST', '/api/admin/clientes-fiscales'], ['POST', `/api/admin/pedido/${FOLIO}/factura`],
  ['GET', `/api/admin/factura/${UUID}/pdf`],
  ['GET', '/api/conversaciones'], ['GET', `/api/conversacion/${TEL}`], ['POST', '/api/send-message'],
  ['GET', `/api/conversacion/${TEL}/estado-bot`],
  ['POST', '/api/documentos/enviar'], ['GET', `/api/documentos/${UUID}`], ['GET', `/api/documentos/${UUID}/archivo`],
  ['POST', '/api/imagenes/enviar'], ['GET', `/api/imagenes/${UUID}`], ['GET', `/api/imagenes/${UUID}/archivo`],
  ['GET', '/api/historial'],
  ['GET', '/api/cotizaciones'], ['GET', `/api/cotizaciones/${UUID}`], ['POST', '/api/cotizaciones'],
  ['PATCH', `/api/cotizaciones/${UUID}`], ['GET', `/api/cotizaciones/${UUID}/pdf`], ['POST', `/api/cotizaciones/${UUID}/enviar`],
  ['GET', '/api/caja/fondo'],
  // Lo del operador también es del cajero.
  ['GET', '/pedidos'], ['GET', '/api/pedidos-programados'], ['GET', '/api/menu'], ['GET', '/api/restaurante/mesas'],
  ['GET', '/api/pos/envios'], ['GET', '/api/auth/me'],
];
// Lo que sigue siendo solo del admin. El cajero solo toca estas rutas con la
// puerta por delante: se rechaza antes de cualquier efecto.
const TOTALES_DE_VENTAS = [
  ['GET', '/api/ventas'], ['GET', '/api/ventas/resumen'],
  ['GET', '/api/corte-caja'], ['GET', '/api/corte-caja/historial'], ['GET', '/api/corte-caja/2026-09-01/ticket'],
  ['POST', '/api/admin/reporte-diario/enviar'],
  ['GET', '/api/admin/clientes/v2/resumen'], ['GET', '/api/rewards/resumen'], ['GET', '/api/admin/compras/resumen'],
];
const SOLO_ADMIN = [
  // Configuración de Facturación y e.firma
  ['PUT', '/api/admin/facturacion/credenciales'], ['DELETE', '/api/admin/facturacion/credenciales'],
  ['PUT', '/api/admin/facturacion/configuracion'], ['GET', '/api/admin/sat/credenciales/info'],
  ['POST', '/api/admin/sat/credenciales'], ['DELETE', '/api/admin/sat/credenciales'],
  ['DELETE', `/api/admin/clientes-fiscales/${UUID}`],
  // El Bot y los adjuntos (borrar)
  ['GET', '/api/bot-whatsapp'], ['DELETE', `/api/documentos/${UUID}`],
  // Caja y corte (el fondo sí es suyo, abajo)
  ['POST', '/api/corte-caja/movimientos'], ['POST', '/api/corte-caja/cerrar'], ['POST', '/api/corte-caja/2026-09-01/imprimir'],
  // Correcciones de pedidos ya cobrados
  ['PATCH', `/api/admin/pedido/${FOLIO}/pago`], ['POST', `/api/admin/pedido/${FOLIO}/cancelar`],
  ['POST', `/api/admin/pedido/${FOLIO}/devolucion`], ['POST', `/api/pedidos/${FOLIO}/reenviar-cocina`],
  // Llamadas, clientes, Rewards, Usuarios, Configuración
  ['GET', '/api/llamadas'], ['GET', '/api/admin/clientes/oportunidades'], ['GET', '/api/rewards/clientes'],
  ['GET', '/api/admin/usuarios'], ['PATCH', `/api/admin/usuarios/${UUID}/rol`], ['GET', '/api/config'],
];

// Módulos que se encienden durante la prueba y se restauran al final.
const MODULOS_PRUEBA = ['caja', 'usuarios', 'pos'];
const { rows: modulosAntes } = await pool.query(
  'SELECT modulo, estado FROM negocio_modulos WHERE negocio_id = $1 AND modulo = ANY($2)', [SEED.negocioA, MODULOS_PRUEBA]);
for (const modulo of MODULOS_PRUEBA) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1, $2, 'activo')
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [SEED.negocioA, modulo]);
}
// Un cajero de prueba del negocio A.
const creados = [];
const cajero = await crearUsuarioConPassword({
  negocioId: SEED.negocioA, nombre: 'Cajero de prueba', email: `cajero-prueba-${Date.now()}@xabor.test`,
  password: 'contrasena-de-prueba-1', rol: 'cajero',
});
creados.push(cajero.id);
const CAJERO = cookie(cajero.id, 'cajero');
let fondoHoy = null, fondoAntes = null;

const srv = await arrancarServidor({ PORT: PUERTO });
const sockets = [];
try {
  await t('HTTP', `el cajero entra a sus ${DEL_CAJERO.length} rutas (Chats, Historial, Facturación, Cotizaciones, fondo y lo del operador)`, async () => {
    const rechazadas = [];
    for (const [metodo, ruta] of DEL_CAJERO) {
      const r = await api(srv.base, metodo, ruta, CAJERO);
      if (rechazoPorRol(r) || r.status === 401) rechazadas.push(`${metodo} ${ruta} → ${r.status}`);
    }
    assert.deepStrictEqual(rechazadas, [], `al cajero lo rechazó la puerta: ${rechazadas.join(' | ')}`);
  });

  await t('HTTP', 'el total de ventas no lo ve el cajero (regla del dueño)', async () => {
    const pasan = [];
    for (const [metodo, ruta] of TOTALES_DE_VENTAS) {
      const r = await api(srv.base, metodo, ruta, CAJERO);
      if (!rechazoPorRol(r)) pasan.push(`${metodo} ${ruta} → ${r.status}`);
    }
    assert.deepStrictEqual(pasan, [], `el cajero llegó a totales de ventas: ${pasan.join(' | ')}`);
  });

  await t('HTTP', `el cajero recibe "permiso insuficiente" en las ${SOLO_ADMIN.length} rutas que siguen siendo del admin`, async () => {
    const pasan = [];
    for (const [metodo, ruta] of SOLO_ADMIN) {
      const r = await api(srv.base, metodo, ruta, CAJERO);
      if (!rechazoPorRol(r)) pasan.push(`${metodo} ${ruta} → ${r.status}`);
    }
    assert.deepStrictEqual(pasan, [], `el cajero pasó: ${pasan.join(' | ')}`);
    const compras = await api(srv.base, 'GET', '/api/admin/compras/contexto', CAJERO);
    assert.strictEqual(compras.status, 403, 'el cajero entró a Compras');
  });

  await t('HTTP', 'el operador sigue sin entrar a lo del cajero', async () => {
    const pasan = [];
    for (const [metodo, ruta] of DEL_CAJERO.filter(([, ruta]) => ruta.startsWith('/api/') && ![
      '/api/pedidos-programados', '/api/menu', '/api/restaurante/mesas', '/api/pos/envios', '/api/auth/me'].includes(ruta))) {
      const r = await api(srv.base, metodo, ruta, OPERADOR);
      if (!rechazoPorRol(r)) pasan.push(`${metodo} ${ruta} → ${r.status}`);
    }
    assert.deepStrictEqual(pasan, [], `el operador pasó: ${pasan.join(' | ')}`);
  });

  // ── C. Fondo de caja ──
  await t('FONDO', 'el cajero registra el fondo de hoy una sola vez; otro día no; el admin lo corrige', async () => {
    fondoHoy = (await api(srv.base, 'GET', '/api/caja/fondo', CAJERO)).body?.fecha;
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(fondoHoy || ''), `no se supo qué día es hoy para el negocio: ${fondoHoy}`);
    const { rows } = await pool.query('SELECT fondo FROM caja_fondos WHERE negocio_id = $1 AND fecha = $2', [SEED.negocioA, fondoHoy]);
    fondoAntes = rows[0] ? rows[0].fondo : null;
    await pool.query('DELETE FROM caja_fondos WHERE negocio_id = $1 AND fecha = $2', [SEED.negocioA, fondoHoy]);

    let r = await api(srv.base, 'GET', '/api/caja/fondo', CAJERO);
    assert.strictEqual(r.body?.fondo, null, `sin registrar, el fondo debía ser null: ${JSON.stringify(r.body)}`);
    r = await api(srv.base, 'POST', '/api/caja/fondo', CAJERO, { monto: 500 });
    assert.strictEqual(r.status, 200, `el cajero no pudo registrar el fondo: ${r.status} ${JSON.stringify(r.body)}`);
    r = await api(srv.base, 'POST', '/api/caja/fondo', CAJERO, { monto: 700 });
    assert.strictEqual(r.status, 409, `un segundo registro del cajero debía rechazarse: ${r.status}`);
    assert.strictEqual(r.body?.codigo, 'FONDO_YA_REGISTRADO');
    r = await api(srv.base, 'GET', '/api/caja/fondo', CAJERO);
    assert.strictEqual(r.body?.fondo, 500, `el segundo registro cambió el fondo: ${JSON.stringify(r.body)}`);

    const ayer = new Date(Date.parse(fondoHoy + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
    r = await api(srv.base, 'POST', '/api/caja/fondo', CAJERO, { monto: 1, fecha: ayer });
    assert.strictEqual(r.status, 403, `el cajero registró el fondo de otro día: ${r.status}`);
    r = await api(srv.base, 'POST', '/api/caja/fondo', OPERADOR, { monto: 1 });
    assert.ok(rechazoPorRol(r), `el operador registró el fondo: ${r.status}`);

    r = await api(srv.base, 'POST', '/api/caja/fondo', ADMIN, { monto: 650 });
    assert.strictEqual(r.status, 200, `el admin no pudo corregir el fondo: ${r.status} ${JSON.stringify(r.body)}`);
    r = await api(srv.base, 'GET', '/api/caja/fondo', ADMIN);
    assert.strictEqual(r.body?.fondo, 650, `la corrección del admin no quedó: ${JSON.stringify(r.body)}`);
  });

  // ── D. Usuarios ──
  await t('USUARIOS', 'el admin da de alta un cajero y lo cambia a operador y de vuelta; nunca a admin', async () => {
    const alta = await api(srv.base, 'POST', '/api/admin/usuarios', ADMIN,
      { tipo: 'cajero', nombre: 'Cajero Alta', email: `cajero-alta-${Date.now()}@xabor.test`, password: 'contrasena-de-prueba-2' });
    assert.strictEqual(alta.status, 201, `alta de cajero: ${alta.status} ${JSON.stringify(alta.body)}`);
    assert.strictEqual(alta.body?.rol, 'cajero');
    creados.push(alta.body.id);
    const rolEnBase = async (id) => (await pool.query(
      'SELECT rol FROM usuario_negocios WHERE usuario_id = $1 AND negocio_id = $2', [id, SEED.negocioA])).rows[0]?.rol;
    assert.strictEqual(await rolEnBase(alta.body.id), 'cajero');

    let r = await api(srv.base, 'PATCH', `/api/admin/usuarios/${alta.body.id}/rol`, ADMIN, { rol: 'staff' });
    assert.strictEqual(r.status, 200, `a operador: ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await rolEnBase(alta.body.id), 'staff');
    r = await api(srv.base, 'PATCH', `/api/admin/usuarios/${alta.body.id}/rol`, ADMIN, { rol: 'cajero' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await rolEnBase(alta.body.id), 'cajero');

    r = await api(srv.base, 'PATCH', `/api/admin/usuarios/${alta.body.id}/rol`, ADMIN, { rol: 'admin' });
    assert.strictEqual(r.status, 400, `la ruta aceptó fabricar un admin: ${r.status}`);
    assert.strictEqual(await rolEnBase(alta.body.id), 'cajero');
    r = await api(srv.base, 'PATCH', `/api/admin/usuarios/${SEED.adminNegocioAUsuarioId}/rol`, ADMIN, { rol: 'staff' });
    assert.strictEqual(r.status, 400, `el admin se cambió su propio rol: ${r.status}`);

    // A un admin (que no sea uno mismo) no lo toca.
    const otroAdmin = await crearUsuarioConPassword({
      negocioId: SEED.negocioA, nombre: 'Otro admin de prueba', email: `admin-prueba-${Date.now()}@xabor.test`,
      password: 'contrasena-de-prueba-3', rol: 'admin',
    });
    creados.push(otroAdmin.id);
    r = await api(srv.base, 'PATCH', `/api/admin/usuarios/${otroAdmin.id}/rol`, ADMIN, { rol: 'staff' });
    assert.strictEqual(r.status, 404, `la ruta degradó a un admin: ${r.status}`);
    assert.strictEqual(await rolEnBase(otroAdmin.id), 'admin');

    // tipo 'admin' en el alta no fabrica un admin: sale operador.
    const altaAdmin = await api(srv.base, 'POST', '/api/admin/usuarios', ADMIN,
      { tipo: 'admin', rol: 'admin', nombre: 'No soy admin', email: `no-admin-${Date.now()}@xabor.test`, password: 'contrasena-de-prueba-4' });
    assert.strictEqual(altaAdmin.status, 201);
    creados.push(altaAdmin.body.id);
    assert.strictEqual(await rolEnBase(altaAdmin.body.id), 'staff');

    for (const [quien, galleta] of [['el cajero', CAJERO], ['el operador', OPERADOR]]) {
      r = await api(srv.base, 'PATCH', `/api/admin/usuarios/${alta.body.id}/rol`, galleta, { rol: 'staff' });
      assert.ok(rechazoPorRol(r), `${quien} cambió un rol: ${r.status}`);
    }
  });

  // ── E. WebSocket ──
  const conectar = (galleta) => new Promise((resolve, reject) => {
    const ws = new WebSocket(srv.base.replace(/^http/, 'ws') + '/ws/panel', { headers: { Cookie: galleta } });
    const recibidos = [];
    ws.on('message', (d) => { try { recibidos.push(JSON.parse(String(d))); } catch { /* ignorar */ } });
    ws.on('open', () => resolve({ ws, recibidos }));
    ws.on('error', reject);
    sockets.push(ws);
  });
  const esperar = (ms) => new Promise(r => setTimeout(r, ms));

  await t('WS', 'el panel del cajero se conecta y recibe los chats y los pedidos nuevos', async () => {
    await guardarMensaje(TEL, 'Cliente prueba cajero', 'entrante', 'hola, ¿me cotizan un pastel?', SEED.negocioA);
    const cajeroWs = await conectar(CAJERO);
    const operadorWs = await conectar(OPERADOR);
    await esperar(400);
    let r = await api(srv.base, 'POST', `/api/conversacion/${TEL}/pausar`, CAJERO);
    assert.strictEqual(r.status, 200, `el cajero no pudo tomar la conversación: ${r.status} ${JSON.stringify(r.body)}`);
    await esperar(600);
    await api(srv.base, 'POST', `/api/conversacion/${TEL}/reactivar`, CAJERO);
    r = await api(srv.base, 'POST', '/test/pedido', ADMIN);
    assert.strictEqual(r.status, 200, `no se pudo crear el pedido de prueba: ${r.status}`);
    const folio = r.body?.pedido?.id;
    await esperar(800);
    try {
      const deChat = (lista) => lista.filter(m => m.tipo === 'bot_pausado' && m.telefono === TEL).length;
      assert.ok(deChat(cajeroWs.recibidos) >= 1, 'al cajero no le llegó el evento de chat');
      assert.strictEqual(deChat(operadorWs.recibidos), 0, 'al operador le llegó un evento de chat');
      assert.ok(cajeroWs.recibidos.some(m => m.tipo === 'nuevo_pedido' && m.pedido?.id === folio), 'al cajero no le llegó el pedido nuevo');
    } finally {
      if (folio) await pool.query(`DELETE FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, SEED.negocioA]).catch(() => {});
    }
  });
  await t('WS', 'si el admin lo pasa a operador, su panel abierto deja de recibir los chats al momento', async () => {
    const cajeroWs = await conectar(CAJERO);
    const adminWs = await conectar(ADMIN);
    await esperar(400);
    let r = await api(srv.base, 'PATCH', `/api/admin/usuarios/${cajero.id}/rol`, ADMIN, { rol: 'staff' });
    assert.strictEqual(r.status, 200, `no se pudo cambiar el rol: ${r.status} ${JSON.stringify(r.body)}`);
    try {
      r = await api(srv.base, 'POST', `/api/conversacion/${TEL}/pausar`, ADMIN);
      assert.strictEqual(r.status, 200, `el admin no pudo pausar la conversación: ${r.status}`);
      await esperar(600);
      await api(srv.base, 'POST', `/api/conversacion/${TEL}/reactivar`, ADMIN);
      await esperar(400);
      const deChat = (lista) => lista.filter(m => m.tipo === 'bot_pausado' && m.telefono === TEL).length;
      assert.ok(deChat(adminWs.recibidos) >= 1, 'al admin no le llegó el evento de chat (la prueba no prueba nada)');
      assert.strictEqual(deChat(cajeroWs.recibidos), 0, 'ya como operador, a su panel abierto le siguió llegando el chat');
    } finally {
      await api(srv.base, 'PATCH', `/api/admin/usuarios/${cajero.id}/rol`, ADMIN, { rol: 'cajero' });
    }
  });
} finally {
  for (const ws of sockets) { try { ws.close(); } catch { /* ya cerrado */ } }
  srv.detener();
  await pool.query(`DELETE FROM mensajes WHERE negocio_id = $1 AND telefono = $2`, [SEED.negocioA, TEL]).catch(() => {});
  await pool.query(`DELETE FROM conversaciones_control WHERE negocio_id = $1 AND telefono = $2`, [SEED.negocioA, TEL]).catch(() => {});
  if (fondoHoy) {
    await pool.query('DELETE FROM caja_fondos WHERE negocio_id = $1 AND fecha = $2', [SEED.negocioA, fondoHoy]).catch(() => {});
    if (fondoAntes !== null) {
      await pool.query('INSERT INTO caja_fondos (fecha, fondo, negocio_id) VALUES ($1, $2, $3)', [fondoHoy, fondoAntes, SEED.negocioA]).catch(() => {});
    }
  }
  for (const modulo of MODULOS_PRUEBA) {
    const antes = modulosAntes.find(m => m.modulo === modulo);
    if (antes) await pool.query('UPDATE negocio_modulos SET estado = $3 WHERE negocio_id = $1 AND modulo = $2', [SEED.negocioA, modulo, antes.estado]).catch(() => {});
    else await pool.query('DELETE FROM negocio_modulos WHERE negocio_id = $1 AND modulo = $2', [SEED.negocioA, modulo]).catch(() => {});
  }
  if (creados.length) {
    await pool.query('DELETE FROM usuario_negocios WHERE usuario_id = ANY($1::uuid[])', [creados]).catch(() => {});
    await pool.query('DELETE FROM usuarios WHERE id = ANY($1::uuid[])', [creados]).catch(() => {});
  }
  await pool.end().catch(() => {});
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
