// El operador (rol staff) solo genera pedidos y opera mesas.
//
// Excepción del dueño (2026-10-21): la caja también entrega en el mostrador
// la liga y el QR de factura de una venta (botón «Factura» del tablero).
//
// Regla del dueño (2026-09-24): de todo el panel, el operador usa
// "+ Nuevo pedido", el tablero de Pedidos y Mesas. Chats, caja/corte,
// historial, cotizaciones, llamadas, compras y Rappi son de admin -- y no
// basta con esconder botones: el servidor lo rechaza aunque el operador
// llegue por dirección, por el celular o con curl.
//
// Lo que esta suite protege:
//   A. (estático) que ninguna ruta NUEVA se abra al operador sin decidirlo:
//      las rutas con la puerta de "cualquier usuario del panel" deben estar
//      en la lista de abajo, que es exactamente pedidos + mesas + lo que esas
//      pantallas leen.
//   B. (servidor real) que el operador reciba "permiso insuficiente" en lo
//      que no es suyo, que el admin siga entrando, y que lo de pedidos y
//      mesas le siga abierto.
//   C. (WebSocket real) que los eventos de chat (con el TEXTO de los
//      mensajes) no lleguen al panel del operador, y los de pedidos sí.
//
// Solo el operador toca rutas restringidas con métodos que escriben: la
// puerta lo rechaza antes de cualquier efecto. El admin solo hace GET.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import assert from 'assert';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_PERMISOS_OPERADOR || '4796';
const SERVER = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf8');
const COMPRAS = readFileSync(join(__dirname, '..', 'src', 'services', 'comprasRutas.js'), 'utf8');
// Las rutas de documentos de facturación (PDF, XML, correo, bitácora) se
// registran desde su módulo; se leen junto con server.js.
const RUTAS = SERVER + '\n' + readFileSync(join(__dirname, '..', 'src', 'services', 'facturacionDocumentos.js'), 'utf8');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// ─── A. Qué rutas le quedan al operador (sin servidor) ──────────────────────
// Pedidos y cobro, POS/envíos, mesas, y lo que esas pantallas leen: menú,
// métodos de pago, Rewards del cliente (se asigna al pedido), la factura al
// cerrar una mesa, push de pedidos nuevos y la propia sesión. «Aplicar
// promoción» es del cajero: el importe lo decide el servidor y FUERA de su
// horario solo la aplica un administrador (fase-promo-vigencia-manual M5).
// La vista previa de promociones del carrito (22-oct-2026) también es del
// cajero: es de solo lectura y calcula lo mismo que el alta del POS, que ya
// es suya. Quitar una promoción ya aplicada sigue siendo de administrador.
const ABIERTAS_AL_OPERADOR = new Set(`
  GET /pedidos
  PATCH /pedidos/:id/estado
  PATCH /pedidos/:folio/cobro
  GET /api/pedidos/:folio/promociones-aplicables
  POST /api/pedidos/:folio/promocion
  DELETE /pedidos/:id
  POST /api/pedido-presencial
  GET /api/pedidos-programados
  POST /api/pos/pedidos
  POST /api/pos/promociones/previsualizar
  GET /api/pos/envios
  GET /api/pos/envios/:folio
  POST /api/pos/envios/:folio/enlace-pago
  POST /api/admin/pedido/:folio/enlace-pago
  GET /api/admin/pedido/:folio/pagos
  GET /api/menu
  GET /api/config/operativa
  GET /api/config/pagos
  GET /api/rewards/clientes/buscar
  GET /api/rewards/cliente/:telefono
  GET /api/rewards/cliente/:telefono/canje-disponible
  POST /api/rewards/cliente
  POST /api/facturacion/pedidos/:folio/autofactura
  POST /api/facturacion/pedidos/:folio/recibo
  GET /api/facturacion/pedidos/:folio/estado
  GET /api/facturacion/facturas/:facturaId/pdf
  GET /api/restaurante/mesas
  POST /api/restaurante/mesas/abrir
  GET /api/restaurante/meseros
  GET /api/restaurante/ordenes-persona
  GET /api/restaurante/indicadores
  GET /api/restaurante/cuentas/:cuentaId
  POST /api/restaurante/cuentas/:cuentaId/items
  DELETE /api/restaurante/cuentas/:cuentaId/items/:itemId
  POST /api/restaurante/cuentas/:cuentaId/items/:itemId/cancelar
  GET /api/restaurante/autorizacion
  PATCH /api/restaurante/cuentas/:cuentaId/items/:itemId/cantidad
  PATCH /api/restaurante/cuentas/:cuentaId/items/:itemId/notas
  POST /api/restaurante/cuentas/:cuentaId/comanda
  POST /api/restaurante/cuentas/:cuentaId/precuenta
  POST /api/restaurante/cuentas/:cuentaId/precuenta-division
  GET /api/restaurante/cuentas/:cuentaId/division
  GET /api/restaurante/cuentas/:cuentaId/dividir
  POST /api/restaurante/cuentas/:cuentaId/pagos
  POST /api/restaurante/cuentas/:cuentaId/cobros-consumo
  POST /api/restaurante/cuentas/:cuentaId/cobros-partes
  POST /api/restaurante/cuentas/:cuentaId/cerrar
  POST /api/restaurante/cuentas/:cuentaId/liberar
  POST /api/restaurante/cuentas/:cuentaId/ticket
  POST /api/restaurante/cuentas/:cuentaId/descuento
  DELETE /api/restaurante/cuentas/:cuentaId/descuento
  POST /api/restaurante/cuentas/:cuentaId/mover
  POST /api/push/subscribe
  DELETE /api/push/subscribe
  GET /api/auth/me
  GET /api/auth/verify
  POST /api/auth/soporte/salir
`.trim().split('\n').map(s => s.trim()));

// Puertas que dejan pasar a cualquier usuario del panel (operador incluido),
// y puertas de admin: una ruta con las dos (p. ej. requireAuthSeguro +
// requireAdminNegocio) es de admin.
const PUERTA_PANEL = /\b(requireAuthSeguro|requireAuth|requireOperacionRestaurante)\b|requireSesionNegocio\(\s*\)|resolverNegocioSeguro\(\s*\)/;
const PUERTA_ADMIN = /\b(requireAdminSeguro|requireAdmin|requireAdminNegocio|requireAdminModerno|requireSuperadmin|soloAdmin)\b|requireSesionNegocio\(\s*'admin'\s*\)|resolverNegocioSeguro\(\s*'admin'\s*\)/;
function rutasAbiertasAlOperador(src) {
  const abiertas = [];
  for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2([^\n]*)/g)) {
    const inicioLinea = src.lastIndexOf('\n', m.index) + 1;
    if (src.slice(inicioLinea, m.index).includes('//')) continue;   // ejemplo dentro de un comentario
    if (PUERTA_PANEL.test(m[4]) && !PUERTA_ADMIN.test(m[4])) abiertas.push(`${m[1].toUpperCase()} ${m[3]}`);
  }
  return abiertas;
}

await t('RUTAS', 'ninguna ruta se abre al operador sin estar en la lista de pedidos y mesas', () => {
  const abiertas = rutasAbiertasAlOperador(RUTAS);
  const sobran = abiertas.filter(r => !ABIERTAS_AL_OPERADOR.has(r));
  assert.deepStrictEqual(sobran, [],
    `rutas abiertas al operador fuera de pedidos/mesas (¿debían ser requireAdminSeguro?): ${sobran.join(', ')}`);
  assert.ok(abiertas.length >= 40, `se leyeron muy pocas rutas (${abiertas.length}): el lector dejó de entender server.js`);
});

await t('RUTAS', 'la lista no guarda rutas que ya no existen', () => {
  const abiertas = new Set(rutasAbiertasAlOperador(RUTAS));
  const fantasmas = [...ABIERTAS_AL_OPERADOR].filter(r => !abiertas.has(r));
  assert.deepStrictEqual(fantasmas, [], `rutas de la lista que ya no están abiertas al operador: ${fantasmas.join(', ')}`);
});

await t('RUTAS', 'Rappi (token de operador) y Compras quedan solo para admin', () => {
  for (const [metodo, ruta] of [['put', '/api/rappi/stockout'], ['post', '/api/rappi/subir-catalogo'],
    ['post', '/api/rappi/actualizar-schedule'], ['put', '/api/rappi/estado-tienda']]) {
    const linea = SERVER.match(new RegExp(`app\\.${metodo}\\('${ruta.replace(/\//g, '\\/')}'[^\\n]*`));
    assert.ok(linea && /\brequireAdmin\b/.test(linea[0]) && !/\brequireAuth\b/.test(linea[0]), `${ruta} no es solo de admin`);
  }
  assert.match(COMPRAS, /\(req\.rol \|\| req\.role\) !== 'admin'\) return res\.status\(403\)\.json\(\{error:'No tienes acceso a esta sección'\}\)/,
    'la puerta de Compras vuelve a dejar pasar al operador');
});

await t('RUTAS', 'los eventos de chat del WebSocket son solo de admin; los de pedidos no', () => {
  const m = SERVER.match(/const EVENTOS_WS_SOLO_ADMIN = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'no se encontró EVENTOS_WS_SOLO_ADMIN');
  const tipos = [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
  for (const tipo of ['nuevo_mensaje', 'bot_pausado', 'documento_actualizado', 'cotizacion_borrador_ia']) {
    assert.ok(tipos.includes(tipo), `${tipo} llega al panel del operador`);
  }
  for (const tipo of ['nuevo_pedido', 'actualizar_estado', 'eliminar_pedido', 'pago_confirmado', 'actualizar_pago', 'cancelar_pedido']) {
    assert.ok(!tipos.includes(tipo), `${tipo} (de pedidos) ya no le llegaría al operador`);
  }
  assert.match(SERVER, /if \(client\.rol === 'staff' && EVENTOS_WS_SOLO_ADMIN\.has\(data\?\.tipo\)\) return;/,
    'broadcastNegocio ya no filtra los eventos de chat para el operador');
});

// ─── B y C. Con el servidor real ────────────────────────────────────────────
const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, guardarMensaje } = await import('../src/services/database.js');
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
// `codigo` (modulo_no_contratado...). Así no depende de qué módulos tenga el
// negocio de prueba.
const rechazoPorRol = (r) => r.status === 403 && !(r.body && r.body.codigo);

const TEL = '5218789990421';
const UUID = randomUUID();
const RESTRINGIDAS = [
  ['GET', '/api/conversaciones'], ['GET', `/api/conversacion/${TEL}`], ['GET', `/api/conversacion/${TEL}/estado-bot`],
  ['POST', `/api/conversacion/${TEL}/pausar`], ['POST', `/api/conversacion/${TEL}/reactivar`], ['POST', '/api/send-message'],
  ['GET', '/api/conversaciones/revision-en-lote'], ['POST', '/api/conversaciones/revision-en-lote'],
  ['GET', '/api/bot-whatsapp'], ['POST', '/api/documentos/enviar'], ['GET', `/api/documentos/${UUID}`],
  ['GET', `/api/documentos/${UUID}/archivo`], ['POST', '/api/imagenes/enviar'], ['GET', `/api/imagenes/${UUID}`],
  ['GET', `/api/imagenes/${UUID}/archivo`],
  ['GET', '/api/caja/fondo'], ['POST', '/api/caja/fondo'], ['GET', '/api/corte-caja'], ['GET', '/api/corte-caja/historial'],
  ['POST', '/api/corte-caja/movimientos'], ['POST', '/api/corte-caja/cerrar'], ['PATCH', `/api/corte-caja/movimientos/${UUID}`],
  ['POST', `/api/corte-caja/movimientos/${UUID}/anular`], ['GET', '/api/corte-caja/2026-09-01/ticket'],
  ['POST', '/api/corte-caja/2026-09-01/imprimir'],
  ['GET', '/api/historial'], ['GET', '/api/cotizaciones'], ['GET', `/api/cotizaciones/${UUID}`],
  ['GET', `/api/cotizaciones/${UUID}/pdf`], ['POST', `/api/cotizaciones/${UUID}/enviar`],
  ['GET', '/api/llamadas'], ['GET', '/api/llamadas/CA00000000000000000000000000000000'],
  // Timbrar es solo del admin, también desde Mesas (Mario, 23-oct); XML,
  // reenvío por correo y bitácora de facturación también.
  ['POST', '/api/facturacion/pedidos/XAB-0001/emitir'], ['GET', '/api/admin/factura/fact_000001/xml'],
  ['POST', '/api/admin/factura/fact_000001/correo'], ['GET', '/api/admin/facturacion/bitacora'],
];
const DEL_OPERADOR = [
  ['GET', '/pedidos'], ['GET', '/api/pedidos-programados'], ['GET', '/api/menu'], ['GET', '/api/config/pagos'],
  ['GET', '/api/restaurante/mesas'], ['GET', '/api/pos/envios'], ['GET', '/api/auth/me'],
  ['GET', '/api/rewards/clientes/buscar?q=878'],
];

const srv = await arrancarServidor({ PORT: PUERTO, XABOR_URL_PUBLICA: process.env.XABOR_URL_PUBLICA || 'https://xabor.test' });
const sockets = [];
try {
  await t('HTTP', `el operador recibe "permiso insuficiente" en las ${RESTRINGIDAS.length} rutas que no son suyas`, async () => {
    const pasan = [];
    for (const [metodo, ruta] of RESTRINGIDAS) {
      const r = await api(srv.base, metodo, ruta, OPERADOR);
      if (!rechazoPorRol(r)) pasan.push(`${metodo} ${ruta} → ${r.status}`);
    }
    assert.deepStrictEqual(pasan, [], `el operador pasó: ${pasan.join(' | ')}`);
  });

  await t('HTTP', 'el admin sigue entrando a esas mismas rutas (GET)', async () => {
    const rechazadas = [];
    for (const [metodo, ruta] of RESTRINGIDAS.filter(([m]) => m === 'GET')) {
      const r = await api(srv.base, metodo, ruta, ADMIN);
      if (rechazoPorRol(r) || r.status === 401) rechazadas.push(`${ruta} → ${r.status}`);
    }
    assert.deepStrictEqual(rechazadas, [], `al admin lo rechazó la puerta: ${rechazadas.join(' | ')}`);
  });

  // Regla del dueño (2026-09-24, Fase 3): el total de ventas solo lo ve el
  // administrador. Estas son las rutas que devuelven dinero AGREGADO (ventas
  // del periodo, corte, reporte diario, resúmenes). El operador ve el importe
  // de cada pedido o mesa (lo necesita para cobrar), nunca una suma. Una ruta
  // nueva de este tipo se agrega aquí.
  const TOTALES_DE_VENTAS = [
    ['GET', '/api/ventas'], ['GET', '/api/ventas/resumen'],
    ['GET', '/api/corte-caja'], ['GET', '/api/corte-caja/historial'], ['GET', '/api/corte-caja/2026-09-01/ticket'],
    ['POST', '/api/admin/reporte-diario/enviar'],
    ['GET', '/api/admin/clientes/v2/resumen'], ['GET', '/api/rewards/resumen'], ['GET', '/api/admin/compras/resumen'],
  ];
  await t('HTTP', 'el total de ventas solo lo ve el administrador (regla del dueño)', async () => {
    const pasan = [];
    for (const [metodo, ruta] of TOTALES_DE_VENTAS) {
      const r = await api(srv.base, metodo, ruta, OPERADOR);
      if (!rechazoPorRol(r)) pasan.push(`${metodo} ${ruta} → ${r.status}`);
    }
    assert.deepStrictEqual(pasan, [], `el operador llegó a totales de ventas: ${pasan.join(' | ')}`);
    // El admin sí (solo lecturas: el reporte diario manda un WhatsApp).
    const rechazadas = [];
    for (const [metodo, ruta] of TOTALES_DE_VENTAS.filter(([m]) => m === 'GET')) {
      const r = await api(srv.base, metodo, ruta, ADMIN);
      if (rechazoPorRol(r) || r.status === 401) rechazadas.push(`${ruta} → ${r.status}`);
    }
    assert.deepStrictEqual(rechazadas, [], `al admin lo rechazó la puerta: ${rechazadas.join(' | ')}`);
  });

  await t('HTTP', 'lo de pedidos y mesas le sigue abierto al operador', async () => {
    const rechazadas = [];
    for (const [metodo, ruta] of DEL_OPERADOR) {
      const r = await api(srv.base, metodo, ruta, OPERADOR);
      if (rechazoPorRol(r) || r.status === 401) rechazadas.push(`${metodo} ${ruta} → ${r.status}`);
    }
    assert.deepStrictEqual(rechazadas, [], `al operador le cerraron: ${rechazadas.join(' | ')}`);
  });

  // Excepción del 2026-10-21: la caja pide la liga de factura de una venta.
  // Solo de su negocio, solo pagada, y solo si el negocio tiene Facturación.
  await t('HTTP', 'la caja obtiene la liga y el QR de factura de una venta pagada de su negocio, y nada más', async () => {
    const F = { pagada: 'XAB-PERMFACA', sinPagar: 'XAB-PERMFACB', ajena: 'XAB-PERMFACC' };
    const venta = (negocioId, folio, pagada) => pool.query(
      `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, entregado_at) VALUES ($1,$2,$3,$4::jsonb, NOW())`,
      [negocioId, folio, pagada ? 'entregado' : 'nuevo', JSON.stringify({ total: 245, forma_pago: pagada ? 'efectivo' : 'por_cobrar',
        pago_confirmado: pagada, modalidad: 'recoger en tienda', cliente: { nombre: 'Cliente caja', telefono: '5218780000421' } })]);
    const limpiar = async () => {
      for (const tabla of ['autofacturas', 'pedidos_activos']) await pool.query(`DELETE FROM ${tabla} WHERE folio = ANY($1)`, [Object.values(F)]);
    };
    const previo = (await pool.query(`SELECT estado FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [SEED.negocioA])).rows[0]?.estado ?? null;
    const modulo = (estado) => pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'facturacion',$2)
      ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado=$2`, [SEED.negocioA, estado]);
    const pedir = (folio) => api(srv.base, 'POST', `/api/facturacion/pedidos/${folio}/autofactura`, OPERADOR);
    await limpiar();
    try {
      await modulo('activo');
      await venta(SEED.negocioA, F.pagada, true);
      await venta(SEED.negocioA, F.sinPagar, false);
      await venta(SEED.negocioB, F.ajena, true);
      const ok = await pedir(F.pagada);
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.match(ok.body.autofactura.url, /\/f\/[A-Za-z0-9_-]{20,}$/);
      assert.ok(ok.body.autofactura.qr?.size > 20 && ok.body.autofactura.qr.data?.length === ok.body.autofactura.qr.size ** 2, 'sin matriz QR');
      const delAdmin = await api(srv.base, 'POST', `/api/admin/facturacion/autofacturas/${F.pagada}`, ADMIN);
      assert.strictEqual(delAdmin.body?.autofactura?.url, ok.body.autofactura.url, 'la caja y el admin no ven la misma liga');
      const sinPagar = await pedir(F.sinPagar);
      assert.strictEqual(sinPagar.status, 409); assert.strictEqual(sinPagar.body?.codigo, 'PEDIDO_NO_PAGADO');
      const ajena = await pedir(F.ajena);
      assert.strictEqual(ajena.status, 404, `venta de otro negocio → ${ajena.status}`);
      assert.strictEqual((await pool.query('SELECT count(*)::int n FROM autofacturas WHERE folio=$1', [F.ajena])).rows[0].n, 0, 'creó liga en otro negocio');
      await modulo('no_contratado');
      const sinModulo = await pedir(F.pagada);
      assert.strictEqual(sinModulo.status, 403); assert.strictEqual(sinModulo.body?.codigo, 'modulo_no_contratado');
    } finally {
      await limpiar();
      if (previo === null) await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [SEED.negocioA]);
      else await modulo(previo);
    }
  });

  await t('HTTP', 'Compras: el operador ve "No tienes acceso a esta sección"; el admin entra', async () => {
    const op = await api(srv.base, 'GET', '/api/admin/compras/contexto', OPERADOR);
    assert.strictEqual(op.status, 403);
    assert.strictEqual(op.body?.error, 'No tienes acceso a esta sección');
    const escribe = await api(srv.base, 'POST', '/api/admin/compras/manual', OPERADOR, { proveedor: 'No debería' });
    assert.strictEqual(escribe.status, 403, 'el operador pudo capturar una compra');
    const admin = await api(srv.base, 'GET', '/api/admin/compras/contexto', ADMIN);
    assert.ok(admin.status !== 403 && admin.status !== 401, `al admin lo rechazó Compras: ${admin.status}`);
  });

  // ── C. WebSocket ──
  const conectar = (galleta) => new Promise((resolve, reject) => {
    const ws = new WebSocket(srv.base.replace(/^http/, 'ws') + '/ws/panel', { headers: { Cookie: galleta } });
    const recibidos = [];
    ws.on('message', (d) => { try { recibidos.push(JSON.parse(String(d))); } catch { /* ignorar */ } });
    ws.on('open', () => resolve({ ws, recibidos }));
    ws.on('error', reject);
    sockets.push(ws);
  });
  const esperar = (ms) => new Promise(r => setTimeout(r, ms));

  await t('WS', 'el operador no recibe los eventos de chat; el admin sí', async () => {
    await guardarMensaje(TEL, 'Cliente prueba permisos', 'entrante', 'hola, ¿tienen chilaquiles?', SEED.negocioA);
    const admin = await conectar(ADMIN);
    const operador = await conectar(OPERADOR);
    await esperar(400);
    const r = await api(srv.base, 'POST', `/api/conversacion/${TEL}/pausar`, ADMIN);
    assert.strictEqual(r.status, 200, `no se pudo pausar la conversación de prueba: ${r.status} ${JSON.stringify(r.body)}`);
    await esperar(600);
    await api(srv.base, 'POST', `/api/conversacion/${TEL}/reactivar`, ADMIN);
    await esperar(400);
    const deChat = (lista) => lista.filter(m => m.tipo === 'bot_pausado' && m.telefono === TEL).length;
    assert.ok(deChat(admin.recibidos) >= 1, 'el admin no recibió bot_pausado (la prueba no prueba nada)');
    assert.strictEqual(deChat(operador.recibidos), 0, 'al operador le llegó un evento de chat');
  });

  await t('WS', 'los pedidos nuevos siguen llegando al operador', async () => {
    const admin = await conectar(ADMIN);
    const operador = await conectar(OPERADOR);
    await esperar(400);
    const r = await api(srv.base, 'POST', '/test/pedido', ADMIN);
    assert.strictEqual(r.status, 200, `no se pudo crear el pedido de prueba: ${r.status}`);
    const folio = r.body?.pedido?.id;
    await esperar(800);
    try {
      const llego = (lista) => lista.some(m => m.tipo === 'nuevo_pedido' && m.pedido?.id === folio);
      assert.ok(llego(admin.recibidos), 'al admin no le llegó el pedido nuevo');
      assert.ok(llego(operador.recibidos), 'al operador ya no le llega el pedido nuevo');
    } finally {
      if (folio) await pool.query(`DELETE FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, SEED.negocioA]).catch(() => {});
    }
  });
} finally {
  for (const ws of sockets) { try { ws.close(); } catch { /* ya cerrado */ } }
  srv.detener();
  await pool.query(`DELETE FROM mensajes WHERE negocio_id = $1 AND telefono = $2`, [SEED.negocioA, TEL]).catch(() => {});
  await pool.query(`DELETE FROM conversaciones_control WHERE negocio_id = $1 AND telefono = $2`, [SEED.negocioA, TEL]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
