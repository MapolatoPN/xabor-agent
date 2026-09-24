// ─── PEDIDO PROGRAMADO DEL AGENTE, CONTRA POSTGRES REAL ────────────────────
//
// E2E del caller productivo, pago por webhook Clip y scheduler. El modelo es
// un guion local; todas las decisiones y efectos que pueden mandar una comanda
// antes de tiempo usan código y Postgres reales:
//
//   atenderTurnoConHerramientas (modelo simulado)
//     -> programar_para
//     -> confirmar_pedido
//     -> confirmarYEmitir
//     -> registrarPedido (gate de catálogo y Postgres reales)
//     -> convertirPedidoAProgramado (transacción real)
//     -> crear enlace sobre la reserva -> /webhook/clip real
//     -> scheduler del servidor al llegar a -1 h
//     -> emitirPedido (deuda operacional real, una sola vez)
//
// Incluye además un crash real justo después de registrar y antes de convertir:
// el siguiente proceso repara la saga en bootstrap, sin POST ni retry manual.
// El cerrojo local va ANTES de importar cualquier módulo que abra la base. La
// suite crea negocio, usuario y proveedor aislados; Clip es un mock local y no
// llama a Meta ni a una impresora.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { arrancarServidor } from './lib-servidor.mjs';

const { Client } = pg;

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const HOST = new URL(process.env.DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(HOST)) {
  throw new Error('Esta prueba registra y activa pedidos: solo acepta Postgres local');
}
// Debe fijarse antes de importar webhookPagos/promoUsosAuditoria: permite
// reproducir un fallo real de lock sin convertir la suite en una espera larga.
process.env.XABOR_PROMO_AUDIT_LOCK_TIMEOUT_MS = '50';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUERTO = String(process.env.TEST_PORT_AGP || 4976);
const PUERTO_CLIP = Number(process.env.TEST_PORT_AGP_CLIP || 4977);
const CLIP_BASE = `http://localhost:${PUERTO_CLIP}`;
process.env.CLIP_API_BASE_URL = CLIP_BASE;
process.env.XABOR_URL_PUBLICA = `http://localhost:${PUERTO}`;

const {
  pool, actualizarConfiguracion, crearUsuarioConPassword,
  obtenerPedidoParaPagoPorFolio, obtenerPedidoPorFolioAmplio,
  obtenerPedidosCobrablesPorTelefono,
  marcarPedidoProgramadoActivado,
  reservarFolioPedido,
} = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const {
  obtenerPedidos, registrarPedido, convertirPedidoAProgramado,
  reconciliarConversionesProgramadasPendientes,
} = await import('../src/orders/orderManager.js');
const {
  atenderTurnoConHerramientas,
} = await import('../src/mesero-agente/agenteDelMesero.js');
const { estadoNuevo } = await import('../src/mesero-agente/ejecutorDeHerramientas.js');
const { almacenEnMemoria, libroDeOperaciones } = await import('../src/mesero-agente/libroDeOperaciones.js');
const { confirmarYEmitir } = await import('../src/mesero-agente/canalDelAgente.js');
const { obtenerConfigTienda } = await import('../src/services/tiendaOnline.js');
const { guardarIntegracionPago, marcarProveedorPrincipal } = await import('../src/services/integracionesService.js');
const { crearEnlacePago } = await import('../src/services/pagosService.js');
const { derivarPedidoPorPagoAsentado } = await import('../src/services/webhookPagos.js');
const {
  MENSAJE_FALLO_CONSULTA_PAGO,
  resolverPedidoCobrablePorFolio,
  responderFalloConsultaPago,
} = await import('../src/channels/pagoFolioSeguro.js');

const PREFIJO = 'AGP ';
const TELEFONO = '5281990098';
const ZONA = 'America/Matamoros';
const REGLAS = {
  timezone: ZONA,
  horarios: Object.fromEntries(
    ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
      .map((d) => [d, { abierto: true, apertura: '00:00', cierre: '23:59' }]),
  ),
  pedidos: { modalidades: ['recoger en tienda'], tiempo_preparacion_minutos: 25 },
};

let NEG = null;
let USER = null;
let srv = null;
let pasadas = 0;
const fallos = [];
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let nCheckout = 0;
const CHECKOUTS = new Map();
const clipMock = createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (c) => { cuerpo += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/checkout') {
      const b = JSON.parse(cuerpo || '{}');
      const id = `clip-agp-${++nCheckout}`;
      const expiresAt = b.expires_at
        ? new Date(Date.parse(b.expires_at)).toISOString()
        : new Date(Date.now() + 3600e3).toISOString();
      CHECKOUTS.set(id, {
        referencia: b.metadata?.external_reference || null,
        estado: 'PENDING', monto: Number(b.amount), expiresAt,
      });
      res.end(JSON.stringify({
        object_type: 'payment_link', payment_request_id: id,
        payment_request_url: `https://pago.mock/${id}`,
        status: 'CHECKOUT_CREATED', created_at: new Date().toISOString(), expires_at: expiresAt,
      }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/v2/checkout/')) {
      const id = decodeURIComponent(req.url.split('/').pop());
      const c = CHECKOUTS.get(id);
      if (!c) { res.statusCode = 404; res.end('{}'); return; }
      const status = c.estado === 'COMPLETED' ? 'CHECKOUT_COMPLETED' : 'CHECKOUT_PENDING';
      res.end(JSON.stringify({
        object_type: 'payment_link', payment_request_id: id, status,
        amount: c.monto, currency: 'MXN',
        metadata: { external_reference: c.referencia, customer_info: {} },
        payment_request_url: `https://pago.mock/${id}`,
        created_at: '2026-09-23T00:00:00.000Z', expires_at: c.expiresAt,
        last_status_message: status,
      }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
});

async function ejecutarHijoCrash(env) {
  const archivo = join(__dirname, 'fixtures', 'agente-programado-crash-caller.mjs');
  return new Promise((resolve, reject) => {
    const hijo = spawn(process.execPath, [archivo], {
      cwd: join(__dirname, '..'), env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let salida = '';
    hijo.stdout.on('data', (c) => { salida += c; });
    hijo.stderr.on('data', (c) => { salida += c; });
    hijo.once('error', reject);
    hijo.once('exit', (code, signal) => resolve({ code, signal, salida }));
  });
}

async function hasta(fn, { limiteMs = 20000, pasoMs = 150, que = 'la condición' } = {}) {
  const fin = Date.now() + limiteMs;
  while (Date.now() < fin) {
    const valor = await fn();
    if (valor) return valor;
    await esperar(pasoMs);
  }
  throw new Error(`se agotó la espera de ${que}`);
}

async function t(nombre, fn) {
  try {
    await fn();
    pasadas += 1;
    console.log(`    OK  ${nombre}`);
  } catch (e) {
    fallos.push(`${nombre}: ${e.message}`);
    console.log(`> FALLO ${nombre}: ${e.message}`);
  }
}

async function limpiar() {
  if (!NEG) return;
  // Dependencias creadas por registrarPedido/emitirPedido y por el fixture.
  await pool.query('DELETE FROM conversacion_estado WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM pagos WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM tienda_promocion_usos WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM tienda_promociones WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM impresion_trabajos WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM compras_reales WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM pedido_emisiones WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM pedidos_activos WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM pedidos_programados WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM pedidos WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM clientes WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM tienda_config WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM metodos_pago WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query(
    'DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id=$1)',
    [NEG]).catch(() => {});
  await pool.query('DELETE FROM integraciones_canal WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM menu_productos WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM menu_categorias WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM usuario_negocios WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM configuracion WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM negocio_modulos WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM folios_pedido_usados WHERE negocio_id=$1', [NEG]).catch(() => {});
  if (USER) await pool.query('DELETE FROM usuarios WHERE id=$1', [USER]).catch(() => {});
  await pool.query('DELETE FROM negocios WHERE id=$1', [NEG]).catch(() => {});
}

function fechaYHoraEnZona(fecha) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(fecha);
  const valor = (tipo) => partes.find((p) => p.type === tipo)?.value;
  return {
    fecha: `${valor('year')}-${valor('month')}-${valor('day')}`,
    hora: `${valor('hour')}:${valor('minute')}`,
  };
}

function ultimoResultado(payload) {
  const mensajes = payload?.messages || [];
  for (let i = mensajes.length - 1; i >= 0; i -= 1) {
    const contenido = mensajes[i]?.content;
    if (!Array.isArray(contenido)) continue;
    for (let j = contenido.length - 1; j >= 0; j -= 1) {
      if (contenido[j]?.type !== 'tool_result') continue;
      try { return JSON.parse(contenido[j].content); } catch { return null; }
    }
  }
  return null;
}

async function snapshotPanel(base, cookie) {
  const r = await fetch(base + '/pedidos', { headers: { Cookie: cookie } });
  assert.equal(r.status, 200, `GET /pedidos respondió ${r.status}`);
  return r.json();
}

async function detenerServidor() {
  if (!srv) return;
  const actual = srv;
  srv = null;
  if (actual.proc?.exitCode === null) {
    const salio = new Promise((resolve) => actual.proc.once('exit', resolve));
    actual.detener();
    await Promise.race([salio, esperar(5000)]);
  }
}

async function arrancarApp(env = {}) {
  await detenerServidor();
  srv = await arrancarServidor({
    PORT: PUERTO,
    XABOR_RUTAS_PRUEBA: '1',
    CLIP_API_BASE_URL: CLIP_BASE,
    XABOR_URL_PUBLICA: `http://localhost:${PUERTO}`,
    ...env,
  }, { timeoutMs: 90000 });
  return srv;
}

async function servidorDebeFallarEnBootstrap(env = {}) {
  const puerto = String(Number(PUERTO) + 20);
  const archivo = join(__dirname, '..', 'src', 'server.js');
  const hijo = spawn(process.execPath, [archivo], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, PORT: puerto, CLIP_API_BASE_URL: CLIP_BASE, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let salida = '';
  hijo.stdout.on('data', (c) => { salida += c; });
  hijo.stderr.on('data', (c) => { salida += c; });
  const resultado = await Promise.race([
    new Promise((resolve, reject) => {
      hijo.once('error', reject);
      hijo.once('exit', (code, signal) => resolve({ code, signal, salida }));
    }),
    esperar(30000).then(() => ({ timeout: true, salida })),
  ]);
  if (resultado.timeout) hijo.kill();
  return { ...resultado, puerto };
}

async function webhookClip(base, checkoutId) {
  return fetch(base + '/webhook/clip', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: checkoutId, origin: 'checkout-api', event_type: 'UPDATE' }),
  });
}

async function pagoDe(folio) {
  return (await pool.query(
    `SELECT id, estado, monto, referencia_externa, url, derivacion_pendiente
       FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2 ORDER BY created_at DESC LIMIT 1`,
    [NEG, folio])).rows[0] || null;
}

async function crearActivoProgramadoDirecto({ telefono, programadoPara, estado = 'nuevo' }) {
  const folio = await reservarFolioPedido();
  const datos = {
    id: folio, negocioId: NEG, canal: 'test', estado,
    modalidad: 'recoger en tienda', forma_pago: 'efectivo',
    total: 105, subtotal: 105, costo_envio: 0,
    programado_para: programadoPara,
    cliente: { nombre: 'Cliente recovery AGP', telefono },
    items: [{ nombre: PREFIJO + 'Waffle', cantidad: 1, precio_unitario: 105 }],
    timestamp: new Date().toISOString(),
  };
  const { rowCount } = await pool.query(
    `INSERT INTO pedidos_activos (folio, datos, estado, negocio_id)
     VALUES ($1,$2::jsonb,$3,$4)`, [folio, JSON.stringify(datos), estado, NEG]);
  assert.equal(rowCount, 1, `no se creó activo huérfano ${folio}`);
  return { folio, datos };
}

try {
  await new Promise((resolve, reject) => {
    clipMock.once('error', reject);
    clipMock.listen(PUERTO_CLIP, resolve);
  });
  await t('caller real -> reserva oculta -> activación -1 h -> una sola emisión', async () => {
    // Negocio y carta propios: nada de esta ejecución pisa los fixtures de otra.
    const { rows: [negocio] } = await pool.query(
      'INSERT INTO negocios (nombre, slug) VALUES ($1,$2) RETURNING id',
      [PREFIJO + 'Programados', `agp-programados-${randomUUID()}`],
    );
    NEG = negocio.id;

    await actualizarConfiguracion({
      nombre_negocio: PREFIJO + 'Programados',
      modo_pedidos: 'transaccional',
      timezone: ZONA,
      reglas_atencion: JSON.stringify(REGLAS),
    }, NEG);
    await pool.query(
      `INSERT INTO negocio_modulos (negocio_id, modulo, estado)
       VALUES ($1,'pos','activo'),($1,'tienda_online','activo'),
              ($1,'pagos','activo'),($1,'whatsapp','activo')`, [NEG],
    );
    await pool.query(
      `INSERT INTO tienda_config
         (negocio_id, estado, modalidades, acepta_programados, anticipacion_minutos, publicada_at)
       VALUES ($1,'publicada','["recoger"]'::jsonb,TRUE,40,NOW())`, [NEG],
    );
    USER = (await crearUsuarioConPassword({
      negocioId: NEG, nombre: 'Admin AGP',
      email: `agp-${randomUUID()}@test.local`, password: 'AGP-Prueba-2026!', rol: 'admin',
    })).id;
    await pool.query(
      `INSERT INTO metodos_pago
         (negocio_id, tipo, habilitado, disponible_para_bot, disponible_para_operador, orden)
       VALUES ($1,'efectivo',TRUE,TRUE,TRUE,10)`, [NEG],
    );
    const { rows: [categoria] } = await pool.query(
      'INSERT INTO menu_categorias (negocio_id,nombre,activa,orden) VALUES ($1,$2,TRUE,0) RETURNING id',
      [NEG, PREFIJO + 'Carta'],
    );
    const { rows: [producto] } = await pool.query(
      `INSERT INTO menu_productos
         (negocio_id,categoria_id,nombre,precio,disponible,agotado,orden)
       VALUES ($1,$2,$3,105,TRUE,FALSE,0) RETURNING id,nombre,precio`,
      [NEG, categoria.id, PREFIJO + 'Waffle'],
    );
    await guardarIntegracionPago(NEG, 'clip', {
      apiKey: 'AGP-CLIP-KEY-LOCAL', apiSecret: 'AGP-CLIP-SECRET-LOCAL',
    }, { actualizadoPor: USER });
    assert.equal(await marcarProveedorPrincipal(NEG, 'clip', USER), true,
      'no se pudo marcar Clip principal');
    const { rows: [promoAuditada] } = await pool.query(
      `INSERT INTO tienda_promociones
         (negocio_id,nombre,tipo,automatica,valor,minimo_compra,limite_usos,canales,activa)
       VALUES ($1,$2,'monto_fijo',TRUE,5,0,100,'["whatsapp"]'::jsonb,TRUE)
       RETURNING id`,
      [NEG, PREFIJO + 'Promo programado pagado'],
    );

    const configTienda = await obtenerConfigTienda(NEG);
    assert.equal(configTienda.aceptaProgramados, true);
    assert.equal(configTienda.anticipacionMinutos, 40);

    const estado = estadoNuevo({ negocioId: NEG, conversacionId: `agp:${TELEFONO}` });
    estado.programacionRequerida = true;
    estado.carrito.items = [{
      lid: 'agp-linea-1', id: String(producto.id), nombre: producto.nombre,
      cantidad: 1, modificadores: [], notas: '',
    }];
    estado.carrito.datos = {
      modalidad: 'recoger en tienda', forma_pago: 'enlace_pago',
      cliente: { nombre: 'Cliente AGP', telefono: TELEFONO },
    };

    // Tres horas: primero debe quedar fuera de la ventana del scheduler.
    const objetivoInicial = new Date(Date.now() + 3 * 3600e3);
    objetivoInicial.setUTCSeconds(0, 0);
    const local = fechaYHoraEnZona(objetivoInicial);
    let paso = 0;
    let emisionesDelCaller = 0;
    let promptConFecha = false;
    const llamarModelo = async (payload) => {
      paso += 1;
      if (paso === 1) {
        return { stop_reason: 'tool_use', content: [{
          type: 'tool_use', id: 'agp-programar', name: 'programar_para', input: local,
        }] };
      }
      if (paso === 2) {
        promptConFecha = String(payload?.system || '').includes(objetivoInicial.toISOString());
        return { stop_reason: 'tool_use', content: [{
          type: 'tool_use', id: 'agp-ver', name: 'ver_pedido', input: {},
        }] };
      }
      if (paso === 3) {
        const visto = ultimoResultado(payload);
        assert.ok(visto?.pedido?.huella, `ver_pedido no devolvió huella: ${JSON.stringify(visto)}`);
        return { stop_reason: 'tool_use', content: [{
          type: 'tool_use', id: 'agp-confirmar', name: 'confirmar_pedido',
          input: { huella_resumen: visto.pedido.huella },
        }] };
      }
      return { stop_reason: 'end_turn', content: [{
        type: 'text', text: 'Tu pedido quedó registrado para la fecha indicada.',
      }] };
    };

    const salida = await atenderTurnoConHerramientas({
      negocioId: NEG, conversacionId: estado.conversacionId, turnoId: 'agp-turno-1',
      mensaje: `Quiero este pedido para ${local.fecha} a las ${local.hora}; sí, lo confirmo.`,
      catalogo: [{ id: categoria.id, nombre: categoria.nombre, productos: [{
        id: producto.id, nombre: producto.nombre, precio: Number(producto.precio),
        disponible: true, agotado: false, modificadores: [],
      }] }],
      precios: { [producto.nombre]: Number(producto.precio) },
      requierePago: true,
      metodosPago: [{ tipo: 'enlace_pago', etiqueta: 'Enlace de pago' }],
      modalidades: ['recoger en tienda'], reglas: REGLAS, configTienda,
      zonaDelNegocio: ZONA, estado,
      libro: libroDeOperaciones(almacenEnMemoria()),
      llamarModelo,
      contexto: { textoCiclo: `pedido ${producto.nombre} para ${local.fecha} ${local.hora}` },
      efectos: {
        confirmar: ({ estado: estadoActual, pedido }) => confirmarYEmitir({
          negocioId: NEG, telefono: TELEFONO, nombre: 'Cliente AGP', canal: 'whatsapp',
          estado: estadoActual, pedido, registrar: registrarPedido,
          emitir: async () => { emisionesDelCaller += 1; },
          guardar: async () => {}, textoDelCiclo: 'pedido programado confirmado',
        }),
      },
    });

    const confirmacion = salida.operaciones.find((o) => o.herramienta === 'confirmar_pedido')?.resultado;
    assert.equal(confirmacion?.aplicado, true, confirmacion?.motivo);
    assert.equal(salida.confirmado, true);
    assert.ok(salida.folio, 'el caller no devolvió folio');
    assert.equal(confirmacion.programado_para, objetivoInicial.toISOString());
    assert.equal(promptConFecha, true, 'el prompt posterior a programar_para ocultó la fecha al modelo');
    assert.equal(emisionesDelCaller, 0, 'confirmarYEmitir emitió el programado inmediatamente');
    const folio = salida.folio;
    assert.ok(confirmacion.enlace_pago, 'confirmarYEmitir no creó enlace sobre la reserva');

    const activoInmediato = await pool.query(
      'SELECT 1 FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2', [NEG, folio]);
    const reservado = await pool.query(
      `SELECT activado, programado_para, datos, created_at FROM pedidos_programados
        WHERE negocio_id=$1 AND folio=$2`, [NEG, folio]);
    assert.equal(activoInmediato.rowCount, 0, 'la conversión dejó el pedido activo');
    assert.equal(reservado.rowCount, 1, 'no existe la reserva en pedidos_programados');
    assert.equal(reservado.rows[0].activado, false);
    assert.equal(reservado.rows[0].datos.programado_para, objetivoInicial.toISOString(),
      'la reserva perdió el instante ISO canónico validado por programar_para');
    assert.equal(reservado.rows[0].datos.estado, 'pendiente_pago',
      'un programado con enlace no nació pendiente de pago');
    assert.equal(Number(reservado.rows[0].datos.total), 100,
      'el programado no conservó el total real con promoción');
    assert.equal(
      reservado.rows[0].datos.descuentos?.promociones?.filter(
        (p) => p.promocionId === promoAuditada.id,
      ).length,
      1,
      'el snapshot durable no conservó la promoción que justificó el cobro',
    );
    // El resto de la suite comparte negocio. Desactivarla ahora no cambia el
    // snapshot histórico del pedido y evita concederla a casos posteriores.
    await pool.query('UPDATE tienda_promociones SET activa=FALSE WHERE id=$1', [promoAuditada.id]);
    assert.equal(obtenerPedidos(NEG).some((p) => p.id === folio), false,
      'la proyección de memoria del caller todavía muestra el programado futuro');
    assert.equal((await pool.query(
      'SELECT 1 FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2', [NEG, folio])).rowCount, 0,
    'nació una deuda/emisión antes de la ventana de una hora');

    // Con folio y sin folio llegan a la misma reserva. Repetir cualquiera de
    // los dos caminos reutiliza exactamente un checkout.
    const pagoInicial = await pagoDe(folio);
    assert.equal(pagoInicial?.estado, 'pendiente');
    assert.ok(pagoInicial?.referencia_externa);
    assert.equal(Number(pagoInicial?.monto), 100,
      'el checkout no cobró el total promocionado que quedó en la reserva');
    const checkoutsTrasConfirmar = nCheckout;
    const porFolio = await obtenerPedidoParaPagoPorFolio(folio, NEG);
    assert.equal(porFolio?._origen, 'programado');
    const sinFolio = await obtenerPedidosCobrablesPorTelefono(TELEFONO, NEG);
    assert.equal(sinFolio.filter((p) => p.folio === folio).length, 1);
    const [reintentoFolio, reintentoSinFolio] = await Promise.all([
      crearEnlacePago({ negocioId: NEG, pedidoId: folio }),
      crearEnlacePago({ negocioId: NEG, pedidoId: sinFolio.find((p) => p.folio === folio).folio }),
    ]);
    assert.equal(reintentoFolio.url, confirmacion.enlace_pago);
    assert.equal(reintentoSinFolio.url, confirmacion.enlace_pago);
    assert.equal(nCheckout, checkoutsTrasConfirmar, 'un reintento creó otro checkout');

    assert.equal((await pool.query(
      `SELECT 1 FROM tienda_promocion_usos
        WHERE negocio_id=$1 AND promocion_id=$2 AND pedido_folio=$3`,
      [NEG, promoAuditada.id, folio])).rowCount, 0,
    'una reserva pendiente de pago contó la promoción antes de recibir dinero');

    const cookie = `xabor_sesion=${encodeURIComponent(crearTokenSesion({
      usuarioId: USER, negocioId: NEG, rol: 'admin',
    }))}`;
    await arrancarApp();
    const panelFuturo = await snapshotPanel(srv.base, cookie);
    assert.equal(panelFuturo.some((p) => p.id === folio), false,
      'el snapshot real del panel muestra el programado antes de -1 h');

    CHECKOUTS.get(pagoInicial.referencia_externa).estado = 'COMPLETED';
    const recibido = await webhookClip(srv.base, pagoInicial.referencia_externa);
    assert.equal(recibido.status, 200);
    await hasta(async () => {
      const pago = await pagoDe(folio);
      const { rows: [p] } = await pool.query(
        'SELECT datos FROM pedidos_programados WHERE negocio_id=$1 AND folio=$2', [NEG, folio]);
      return pago?.estado === 'pagado' && pago.derivacion_pendiente === false
        && p?.datos?.pago_confirmado === true && p?.datos?.estado === 'nuevo';
    }, { que: 'el pago verificado de la reserva' });
    assert.equal((await pool.query(
      'SELECT 1 FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2', [NEG, folio])).rowCount, 0,
    'el webhook activó el programado antes de tiempo');
    assert.equal((await pool.query(
      'SELECT 1 FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2', [NEG, folio])).rowCount, 0,
    'el webhook emitió el programado antes de -1 h');
    assert.equal((await pool.query(
      'SELECT 1 FROM compras_reales WHERE negocio_id=$1 AND folio=$2', [NEG, folio])).rowCount, 1,
    'el dinero verificado debe registrar una sola compra financiera, sin emisión operacional');
    const usosTrasWebhook = await pool.query(
      `SELECT estado, canal FROM tienda_promocion_usos
        WHERE negocio_id=$1 AND promocion_id=$2 AND pedido_folio=$3`,
      [NEG, promoAuditada.id, folio],
    );
    assert.equal(usosTrasWebhook.rowCount, 1,
      'el webhook no auditó inmediatamente la promoción del programado pagado');
    assert.deepEqual(usosTrasWebhook.rows[0], { estado: 'consumida', canal: 'whatsapp' });

    // Reproduce con Postgres real la carrera crítica. Se reconstruye el estado
    // durable posterior a un fallo de auditoría (dinero/pedido confirmados,
    // uso ausente y deuda abierta) y un SHARE lock permite leer, pero hace que
    // el INSERT de auditoría falle por lock_timeout. Mientras el fallo sigue
    // presente, el scheduler activa la reserva. El retry posterior ya ve el
    // origen SQL `activo` y aun así debe auditar desde el snapshot de la deuda.
    await pool.query(
      `DELETE FROM tienda_promocion_usos
        WHERE negocio_id=$1 AND promocion_id=$2 AND pedido_folio=$3`,
      [NEG, promoAuditada.id, folio],
    );
    await pool.query(
      `UPDATE pagos
          SET derivacion_pendiente=TRUE, derivacion_saldada_at=NULL
        WHERE id=$1 AND negocio_id=$2`,
      [pagoInicial.id, NEG],
    );

    const bloqueadorAuditoria = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: false,
    });
    await bloqueadorAuditoria.connect();
    try {
      await bloqueadorAuditoria.query('BEGIN');
      await bloqueadorAuditoria.query(
        'LOCK TABLE tienda_promocion_usos IN SHARE MODE',
      );
      const falloAuditoria = await derivarPedidoPorPagoAsentado({
        pagoId: pagoInicial.id, negocioId: NEG, folio,
      });
      assert.deepEqual(
        { derivado: falloAuditoria.derivado, razon: falloAuditoria.razon },
        { derivado: false, razon: 'auditoria_promocion_pendiente' },
        'el fallo real de auditoría no dejó una deuda reintentable',
      );
      assert.equal((await pagoDe(folio)).derivacion_pendiente, true,
        'el fallo de auditoría saldó prematuramente la deuda');
      assert.equal((await pool.query(
        `SELECT 1 FROM tienda_promocion_usos
          WHERE negocio_id=$1 AND promocion_id=$2 AND pedido_folio=$3`,
        [NEG, promoAuditada.id, folio])).rowCount, 0,
      'el lock de prueba no reprodujo el uso ausente');

      // Simula el avance del reloj sin esperar dos horas: la reserva entra en
      // la misma condición productiva `programado_para <= NOW() + 1 hour`.
      const { rows: [movido] } = await pool.query(
        `UPDATE pedidos_programados
            SET programado_para=NOW() + INTERVAL '55 minutes'
          WHERE negocio_id=$1 AND folio=$2
        RETURNING programado_para`, [NEG, folio],
      );
      assert.ok(movido?.programado_para, 'no se pudo mover la reserva a la ventana de activación');

      await arrancarApp();
      const panelActivado = await hasta(async () => {
        const lista = await snapshotPanel(srv.base, cookie);
        return lista.filter((p) => p.id === folio).length === 1 ? lista : null;
      }, { que: 'el pedido programado en el panel' });
      assert.equal(panelActivado.filter((p) => p.id === folio).length, 1,
        'el scheduler no dejó exactamente una proyección en el panel');
      await hasta(async () => (await pool.query(
        'SELECT 1 FROM pedidos_programados WHERE negocio_id=$1 AND folio=$2 AND activado=TRUE',
        [NEG, folio])).rowCount === 1,
      { que: 'la reserva marcada como activada' });

      const deuda = await hasta(async () => {
        const { rows } = await pool.query(
          'SELECT estado FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2', [NEG, folio]);
        return rows.length === 1 && rows[0].estado === 'saldada' ? rows[0] : null;
      }, { que: 'la única emisión operacional saldada' });
      assert.equal(deuda.estado, 'saldada');
      // Detiene el reconciliador antes de soltar el lock: así el retry que se
      // comprueba abajo es determinista y no compite con el intervalo real.
      await detenerServidor();
    } finally {
      await bloqueadorAuditoria.query('ROLLBACK').catch(() => {});
      await bloqueadorAuditoria.end().catch(() => {});
    }

    const retryTrasActivacion = await derivarPedidoPorPagoAsentado({
      pagoId: pagoInicial.id, negocioId: NEG, folio,
    });
    assert.equal(retryTrasActivacion.derivado, true);
    assert.equal((await pool.query(
      `SELECT 1 FROM tienda_promocion_usos
        WHERE negocio_id=$1 AND promocion_id=$2 AND pedido_folio=$3`,
      [NEG, promoAuditada.id, folio])).rowCount, 1,
    'el retry tras activar saldó la deuda sin reponer el uso de promoción');
    assert.equal((await pagoDe(folio)).derivacion_pendiente, false,
      'el retry auditado no saldó la deuda');
    assert.equal((await pool.query(
      'SELECT 1 FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2',
      [NEG, folio])).rowCount, 1,
    'el retry financiero duplicó la emisión del programado ya activado');

    const retryIdempotente = await derivarPedidoPorPagoAsentado({
      pagoId: pagoInicial.id, negocioId: NEG, folio,
    });
    assert.deepEqual(
      { derivado: retryIdempotente.derivado, razon: retryIdempotente.razon },
      { derivado: false, razon: 'sin_deuda' },
    );
    assert.equal((await pool.query(
      'SELECT 1 FROM compras_reales WHERE negocio_id=$1 AND folio=$2', [NEG, folio])).rowCount, 1,
    'la activación no produjo exactamente una compra real');

    // Un segundo arranque no puede volver a emitir ni auditar la reserva.
    await arrancarApp();
    await esperar(500);
    assert.equal((await pool.query(
      'SELECT 1 FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2', [NEG, folio])).rowCount, 1,
    'un reinicio creó una segunda deuda/emisión del mismo programado');
    assert.equal((await pool.query(
      'SELECT 1 FROM compras_reales WHERE negocio_id=$1 AND folio=$2', [NEG, folio])).rowCount, 1,
    'un reinicio registró dos compras para el mismo programado');
    assert.equal((await pool.query(
      `SELECT 1 FROM tienda_promocion_usos
        WHERE negocio_id=$1 AND promocion_id=$2 AND pedido_folio=$3`,
      [NEG, promoAuditada.id, folio])).rowCount, 1,
    'un reinicio duplicó el uso de promoción del programado');
  });

  await t('la marca activada espera la obligación y nunca cruza de negocio', async () => {
    await detenerServidor();
    const programadoPara = new Date(Date.now() + 4 * 3600e3).toISOString();
    const { folio, datos } = await crearActivoProgramadoDirecto({
      telefono: '528199009899', programadoPara,
    });
    const conversion = await convertirPedidoAProgramado(datos, programadoPara);
    assert.equal(conversion.ok, true, JSON.stringify(conversion));

    const bloqueador = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: false,
    });
    await bloqueador.connect();
    let marcaTerminada = false;
    let marca = null;
    try {
      await bloqueador.query('BEGIN');
      await bloqueador.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        ['obligacion_pago', `${NEG}:${folio}`],
      );
      marca = marcarPedidoProgramadoActivado(folio, NEG)
        .finally(() => { marcaTerminada = true; });
      await esperar(120);
      assert.equal(marcaTerminada, false,
        'la marca ignoró el candado de la obligación de pago');
      assert.equal(
        await marcarPedidoProgramadoActivado(folio, randomUUID()),
        false,
        'otro negocio pudo marcar una reserva ajena',
      );
    } finally {
      await bloqueador.query('ROLLBACK').catch(() => {});
      await bloqueador.end().catch(() => {});
    }
    assert.equal(await marca, true, 'la marca no continuó al liberar el candado');
    assert.equal((await pool.query(
      `SELECT 1 FROM pedidos_programados
        WHERE negocio_id=$1 AND folio=$2 AND activado=TRUE`,
      [NEG, folio])).rowCount, 1);
  });

  await t('crash real registrar→convertir: bootstrap falla cerrado y luego recupera sin POST', async () => {
    await detenerServidor();
    const telefonoCrash = '528199009801';
    const objetivo = new Date(Date.now() + 4 * 3600e3);
    objetivo.setUTCSeconds(0, 0);
    const hijo = await ejecutarHijoCrash({
      NODE_ENV: 'test',
      AGP_NEGOCIO_ID: NEG,
      AGP_PRODUCTO_NOMBRE: PREFIJO + 'Waffle',
      AGP_PRODUCTO_PRECIO: '105',
      AGP_TELEFONO: telefonoCrash,
      AGP_PROGRAMADO_PARA: objetivo.toISOString(),
      XABOR_PROGRAMADOS_FALLA_EN: 'despues_registrar_antes_convertir',
      XABOR_PROGRAMADOS_MATAR_PROCESO: '1',
    });
    assert.equal(hijo.code, 137, `el hijo no murió en la frontera: ${hijo.salida.slice(-800)}`);

    const { rows: activos } = await pool.query(
      `SELECT folio, created_at, datos FROM pedidos_activos
        WHERE negocio_id=$1 AND datos->'cliente'->>'telefono'=$2`, [NEG, telefonoCrash]);
    assert.equal(activos.length, 1, 'el COMMIT previo al crash no dejó exactamente un activo recuperable');
    const huérfano = activos[0];
    assert.equal(huérfano.datos.programado_para, objetivo.toISOString());
    assert.equal((await pool.query(
      'SELECT 1 FROM pedidos_programados WHERE negocio_id=$1 AND folio=$2', [NEG, huérfano.folio])).rowCount, 0);
    assert.equal((await pool.query(
      'SELECT 1 FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2', [NEG, huérfano.folio])).rowCount, 0);

    // La misma fila con una conversión que falla debe impedir listen: /health
    // no puede dar 200 con el build que no logró reconciliar.
    const fallido = await servidorDebeFallarEnBootstrap({
      NODE_ENV: 'test', XABOR_PROGRAMADOS_FALLA_EN: 'tras_insert_programado',
    });
    assert.equal(fallido.timeout, undefined, `el servidor siguió vivo: ${fallido.salida.slice(-1000)}`);
    assert.notEqual(fallido.code, 0, 'el bootstrap abrió servicio pese a no recuperar el programado');
    assert.match(fallido.salida, /PROGRAMADOS|conversion|recuperar|arranque/i);
    assert.equal((await pool.query(
      'SELECT 1 FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2', [NEG, huérfano.folio])).rowCount, 1,
    'el intento fallido perdió el activo');
    assert.equal((await pool.query(
      'SELECT 1 FROM pedidos_programados WHERE negocio_id=$1 AND folio=$2', [NEG, huérfano.folio])).rowCount, 0,
    'el intento fallido dejó un híbrido');

    await arrancarApp();
    const cookie = `xabor_sesion=${encodeURIComponent(crearTokenSesion({
      usuarioId: USER, negocioId: NEG, rol: 'admin',
    }))}`;
    const panel = await snapshotPanel(srv.base, cookie);
    assert.equal(panel.some((p) => p.id === huérfano.folio), false,
      'el bootstrap mostró el activo programado huérfano en el panel');
    const { rows: [reserva] } = await pool.query(
      `SELECT created_at, activado FROM pedidos_programados
        WHERE negocio_id=$1 AND folio=$2`, [NEG, huérfano.folio]);
    assert.ok(reserva, 'el bootstrap no creó la reserva sin ayuda HTTP');
    assert.equal(reserva.activado, false);
    assert.equal(new Date(reserva.created_at).getTime(), new Date(huérfano.created_at).getTime(),
      'la recuperación cambió la identidad temporal del pedido');
    assert.equal((await pool.query(
      'SELECT 1 FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2', [NEG, huérfano.folio])).rowCount, 0);
    assert.equal((await pool.query(
      'SELECT 1 FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2', [NEG, huérfano.folio])).rowCount, 0,
    'la recuperación emitió antes de -1 h');
    await detenerServidor();
  });

  await t('respuesta perdida después del COMMIT se concilia en la puerta compartida', async () => {
    const programadoPara = new Date(Date.now() + 4.5 * 3600e3).toISOString();
    const pedido = await registrarPedido({
      negocioId: NEG, telefono_conversacion: '528199009802', programado_para: programadoPara,
      cliente: { nombre: 'Cliente Commit AGP', telefono: '528199009802' },
      modalidad: 'recoger en tienda', forma_pago: 'efectivo',
      items: [{ nombre: PREFIJO + 'Waffle', cantidad: 1 }],
    }, 'whatsapp');
    const anterior = process.env.XABOR_PROGRAMADOS_FALLA_EN;
    process.env.XABOR_PROGRAMADOS_FALLA_EN = 'despues_commit_antes_respuesta';
    let conv;
    try {
      conv = await convertirPedidoAProgramado(pedido, programadoPara);
    } finally {
      if (anterior === undefined) delete process.env.XABOR_PROGRAMADOS_FALLA_EN;
      else process.env.XABOR_PROGRAMADOS_FALLA_EN = anterior;
    }
    assert.equal(conv.ok, true, `no adoptó el COMMIT existente: ${JSON.stringify(conv)}`);
    assert.equal(conv.recuperadoTrasRespuestaPerdida, true);
    assert.equal(obtenerPedidos(NEG).some((p) => p.id === pedido.id), false,
      'la conciliación compartida no retiró la proyección vieja');
    assert.equal((await pool.query(
      'SELECT 1 FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2', [NEG, pedido.id])).rowCount, 0);
    assert.equal((await pool.query(
      'SELECT 1 FROM pedidos_programados WHERE negocio_id=$1 AND folio=$2', [NEG, pedido.id])).rowCount, 1);
    assert.equal((await pool.query(
      'SELECT 1 FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2', [NEG, pedido.id])).rowCount, 0);
  });

  await t('pago antes de convertir: 0 emisiones ahora, 1 al activar y 1 compra', async () => {
    await arrancarApp();
    const telefono = '528199009803';
    const programadoPara = new Date(Date.now() + 3.5 * 3600e3).toISOString();
    // Forma legacy deliberada: el gate canónico debe reconocer su tipo y
    // hacerlo nacer pendiente_pago aunque el caller no mande la bandera.
    const pedido = await registrarPedido({
      negocioId: NEG, telefono_conversacion: telefono, programado_para: programadoPara,
      cliente: { nombre: 'Cliente Carrera AGP', telefono },
      modalidad: 'recoger en tienda', forma_pago: 'enlace de pago',
      items: [{ nombre: PREFIJO + 'Waffle', cantidad: 1 }],
    }, 'whatsapp');
    assert.equal(pedido.estado, 'pendiente_pago',
      'el programado legacy con enlace nació emitible');
    const enlace = await crearEnlacePago({ negocioId: NEG, pedidoId: pedido.id });
    const pago = await pagoDe(pedido.id);
    assert.equal(enlace.url, pago.url);
    CHECKOUTS.get(pago.referencia_externa).estado = 'COMPLETED';
    const r = await webhookClip(srv.base, pago.referencia_externa);
    assert.equal(r.status, 200);
    let ultimoEstadoPago = null;
    let activoPagado;
    try {
      activoPagado = await hasta(async () => {
        const { rows: [fila] } = await pool.query(
          'SELECT estado, datos FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2', [NEG, pedido.id]);
        const pagoActual = await pagoDe(pedido.id);
        const { rows: [emisiones] } = await pool.query(
          'SELECT count(*)::int AS total FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2',
          [NEG, pedido.id]);
        ultimoEstadoPago = {
          estadoSql: fila?.estado || null,
          estadoDatos: fila?.datos?.estado || null,
          pagoConfirmado: fila?.datos?.pago_confirmado === true,
          programadoPara: fila?.datos?.programado_para || null,
          programadoId: fila?.datos?.programado_id || null,
          estadoPago: pagoActual?.estado || null,
          derivacionPendiente: pagoActual?.derivacion_pendiente ?? null,
          emisiones: emisiones?.total ?? null,
        };
        return fila?.datos?.pago_confirmado === true && fila?.datos?.estado === 'pendiente_pago'
          && pagoActual?.estado === 'pagado' && pagoActual.derivacion_pendiente === false ? fila : null;
      }, { que: 'pago asentado antes de convertir' });
    } catch (error) {
      const salidaServidor = srv?.obtenerSalida?.().slice(-1800) || '(sin salida del servidor)';
      throw new Error(`${error.message}; ultimo estado=${JSON.stringify(ultimoEstadoPago)}; servidor=${salidaServidor}`);
    }
    assert.equal(activoPagado.estado, 'pendiente_pago',
      'el activo temporal se volvió visible antes de asegurar la reserva programada');
    assert.equal(activoPagado.datos.estado, 'pendiente_pago',
      'SQL y JSON divergieron contra la autoridad de la migración 086');
    assert.equal((await pool.query(
      'SELECT 1 FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2', [NEG, pedido.id])).rowCount, 0,
    'el webhook emitió el activo programado huérfano');
    assert.equal((await pool.query(
      'SELECT 1 FROM compras_reales WHERE negocio_id=$1 AND folio=$2', [NEG, pedido.id])).rowCount, 1,
    'el pago previo a conversión no produjo exactamente una compra financiera');

    const conv = await convertirPedidoAProgramado(pedido, programadoPara);
    assert.equal(conv.ok, true, conv.razon);
    const { rows: [reserva] } = await pool.query(
      'SELECT datos FROM pedidos_programados WHERE negocio_id=$1 AND folio=$2', [NEG, pedido.id]);
    assert.equal(reserva.datos.pago_confirmado, true);
    assert.equal(reserva.datos.estado, 'nuevo');
    assert.equal((await pool.query(
      'SELECT 1 FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2', [NEG, pedido.id])).rowCount, 0);

    await pool.query(
      `UPDATE pedidos_programados SET programado_para=NOW()+INTERVAL '55 minutes'
        WHERE negocio_id=$1 AND folio=$2`, [NEG, pedido.id]);
    await arrancarApp();
    await hasta(async () => (await pool.query(
      `SELECT 1 FROM pedido_emisiones
        WHERE negocio_id=$1 AND folio=$2 AND estado='saldada'`, [NEG, pedido.id])).rowCount === 1,
    { que: 'emisión única de la carrera pago/conversión' });
    const comprasTrasActivar = (await pool.query(
      `SELECT pedido_creado_at, origen FROM compras_reales
        WHERE negocio_id=$1 AND folio=$2 ORDER BY pedido_creado_at`, [NEG, pedido.id])).rows;
    assert.equal(comprasTrasActivar.length, 1,
      `la activación duplicó la identidad financiera: ${JSON.stringify(comprasTrasActivar)}`);
    assert.equal((await pool.query(
      'SELECT 1 FROM pagos WHERE negocio_id=$1 AND pedido_folio=$2', [NEG, pedido.id])).rowCount, 1);
    await arrancarApp();
    await esperar(500);
    assert.equal((await pool.query(
      'SELECT 1 FROM compras_reales WHERE negocio_id=$1 AND folio=$2', [NEG, pedido.id])).rowCount, 1,
    'el reinicio duplicó la compra de la carrera');
  });

  await t('promo desfasada en reserva: dos intentos fallan y cero checkouts', async () => {
    const telefono = '528199009804';
    const programadoPara = new Date(Date.now() + 5 * 3600e3).toISOString();
    const pedido = await registrarPedido({
      negocioId: NEG, telefono_conversacion: telefono, programado_para: programadoPara,
      cliente: { nombre: 'Cliente Promo Programada', telefono },
      modalidad: 'recoger en tienda', forma_pago: 'enlace de pago',
      items: [{ nombre: PREFIJO + 'Waffle', cantidad: 1 }],
    }, 'whatsapp');
    const { rows: [promo] } = await pool.query(
      `INSERT INTO tienda_promociones
         (negocio_id,nombre,tipo,codigo,automatica,valor,minimo_compra,
          limite_usos,canales,activa)
       VALUES ($1,'AGP promo desfasada','monto_fijo','AGPSTALE',FALSE,30,200,1,
               '["whatsapp"]'::jsonb,TRUE)
       RETURNING id`, [NEG]);

    // Simula el snapshot de una promoción que justificaba $30 en la versión
    // anterior, pero ya no llega al mínimo. La conversión debe conservarlo en
    // la reserva para probar el mismo camino que usa el canario.
    await pool.query(
      `UPDATE pedidos_activos
          SET datos = datos
            || '{"subtotal":105,"descuento":30,"total":75}'::jsonb
            || jsonb_build_object('tienda', jsonb_build_object(
                 'promociones', jsonb_build_array(jsonb_build_object(
                   'id',$3::text,'codigo','AGPSTALE','descuento',30)),
                 'envio_base',0))
        WHERE negocio_id=$1 AND folio=$2`, [NEG, pedido.id, promo.id]);
    await pool.query(
      `INSERT INTO tienda_promocion_usos
         (negocio_id,promocion_id,pedido_folio,cliente_telefono,monto_descuento,
          estado,pedido_version)
       VALUES ($1,$2,$3,$4,30,'reservada','version-anterior')`,
      [NEG, promo.id, pedido.id, telefono]);
    await pool.query('UPDATE tienda_promociones SET usos=1 WHERE id=$1', [promo.id]);

    const conv = await convertirPedidoAProgramado(pedido, programadoPara);
    assert.equal(conv.ok, true, JSON.stringify(conv));
    const checkoutsAntes = nCheckout;
    for (let intento = 1; intento <= 2; intento += 1) {
      await assert.rejects(
        () => crearEnlacePago({ negocioId: NEG, pedidoId: pedido.id }),
        /ya no aplica|recalcular/i,
        `el intento ${intento} cobró el precio viejo de la reserva`,
      );
    }
    assert.equal(nCheckout, checkoutsAntes, 'se hizo POST al proveedor con promoción inválida');
    const { rows: [marcada] } = await pool.query(
      `SELECT datos FROM pedidos_programados
        WHERE negocio_id=$1 AND folio=$2 AND activado=FALSE`, [NEG, pedido.id]);
    assert.equal(marcada?.datos?.tienda?.promocion_recalculo_pendiente, true,
      'la barrera no quedó durable en pedidos_programados');
    assert.equal((await pool.query(
      `SELECT 1 FROM tienda_promocion_usos
        WHERE negocio_id=$1 AND pedido_folio=$2 AND estado='reservada'`,
      [NEG, pedido.id])).rowCount, 0, 'la reserva promo inválida no fue liberada');

    // La salida existe también para reservas: recalcular server-side corrige
    // el total y es la única operación que levanta la barrera.
    const { recalcularPromocionesDelPedido } = await import('../src/services/tiendaPromociones.js');
    const rec = await recalcularPromocionesDelPedido(NEG, pedido.id, { timezone: ZONA });
    assert.equal(rec.ok, true, JSON.stringify(rec));
    const { rows: [recalculada] } = await pool.query(
      'SELECT datos FROM pedidos_programados WHERE negocio_id=$1 AND folio=$2', [NEG, pedido.id]);
    assert.notEqual(recalculada.datos.tienda.promocion_recalculo_pendiente, true);
    assert.equal(Number(recalculada.datos.descuento), 0);
    assert.equal(Number(recalculada.datos.total), 105);
  });

  await t('bootstrap drena 51 huérfanos aunque el lote sea 50', async () => {
    await detenerServidor();
    const programadoPara = new Date(Date.now() + 5 * 3600e3).toISOString();
    const folios = [];
    for (let i = 0; i < 51; i += 1) {
      const creado = await crearActivoProgramadoDirecto({
        telefono: `52819910${String(i).padStart(4, '0')}`, programadoPara,
      });
      folios.push(creado.folio);
    }
    const recuperadas = await reconciliarConversionesProgramadasPendientes(50);
    assert.equal(recuperadas, 51);
    const { rows: [conteo] } = await pool.query(
      `SELECT
         count(*) FILTER (WHERE a.folio IS NOT NULL)::int AS activos,
         count(*) FILTER (WHERE p.folio IS NOT NULL)::int AS reservas
       FROM unnest($1::text[]) f(folio)
       LEFT JOIN pedidos_activos a ON a.folio=f.folio AND a.negocio_id=$2
       LEFT JOIN pedidos_programados p ON p.folio=f.folio AND p.negocio_id=$2`, [folios, NEG]);
    assert.equal(conteo.activos, 0);
    assert.equal(conteo.reservas, 51);
  });

  await t('lookup sin folio filtra 3 pagados antes del LIMIT y cobra el impago viejo', async () => {
    await arrancarApp();
    const telefono = '528199009805';
    const ahora = Date.now();
    let folioImpago = null;
    for (const [indice, pagado] of [true, true, true, false].entries()) {
      const folio = await reservarFolioPedido();
      const creadoAt = new Date(ahora - (pagado ? (indice + 1) * 60000 : 4 * 3600e3));
      const datos = {
        id: folio, negocioId: NEG, canal: 'whatsapp',
        estado: pagado ? 'nuevo' : 'pendiente_pago',
        modalidad: 'recoger en tienda', forma_pago: 'enlace_pago',
        forma_pago_tipo: 'enlace_pago', requierePagoAnticipado: true,
        pago_confirmado: pagado,
        total: 105, subtotal: 105, costo_envio: 0,
        cliente: { nombre: 'Cliente lookup AGP', telefono },
        items: [{ nombre: PREFIJO + 'Waffle', cantidad: 1, precio_unitario: 105 }],
        timestamp: creadoAt.toISOString(),
      };
      await pool.query(
        `INSERT INTO pedidos_activos (folio, datos, estado, negocio_id, created_at)
         VALUES ($1,$2::jsonb,$3,$4,$5)`,
        [folio, JSON.stringify(datos), datos.estado, NEG, creadoAt],
      );
      if (!pagado) folioImpago = folio;
    }

    const cobrables = await obtenerPedidosCobrablesPorTelefono(telefono, NEG);
    assert.deepEqual(cobrables.map((p) => p.folio), [folioImpago],
      'los tres pagados recientes ocultaron el único impago anterior al LIMIT');
    const checkoutsAntes = nCheckout;
    const enlace = await crearEnlacePago({ negocioId: NEG, pedidoId: folioImpago });
    assert.match(enlace.url, /^https:\/\/pago\.mock\//);
    assert.equal(nCheckout, checkoutsAntes + 1,
      'el pedido impago recuperado no llegó al proveedor de pago');
  });

  await t('error SQL por folio se propaga y el canal responde revisión sin checkout', async () => {
    const errorDb = new Error('db_folio_no_disponible_prueba');
    await assert.rejects(
      () => obtenerPedidoPorFolioAmplio('XAB-9998', NEG, {
        consultar: async () => { throw errorDb; },
      }),
      /db_folio_no_disponible_prueba/,
      'el lookup amplio convirtió el error SQL en folio inexistente',
    );

    let checkouts = 0;
    let revision = null;
    const respuestas = [];
    try {
      const pedido = await resolverPedidoCobrablePorFolio({
        folio: 'XAB-9998', negocioId: NEG,
        buscarParaPago: async () => null,
        buscarAmplio: async () => { throw errorDb; },
      });
      if (pedido) checkouts += 1;
    } catch (error) {
      await responderFalloConsultaPago({
        folio: 'XAB-9998', error, telefono: '528199009806',
        nombreMeta: 'Cliente DB caída', negocioId: NEG, credenciales: {},
      }, {
        marcarRevision: async (datos) => { revision = datos; return true; },
        enviar: async (_telefono, texto) => { respuestas.push(texto); },
        guardar: async () => true,
      });
    }
    assert.equal(checkouts, 0, 'un error de lookup alcanzó la creación de checkout');
    assert.equal(revision?.motivo, 'PAGO_CONSULTA_PEDIDO_FALLIDA');
    assert.deepEqual(respuestas, [MENSAJE_FALLO_CONSULTA_PAGO]);
    assert.doesNotMatch(respuestas[0], /no encontramos/i,
      'la caída de DB se presentó falsamente como folio inexistente');
  });

  await t('consulta de cobro falla cerrado si SQL cae', async () => {
    await assert.rejects(
      () => obtenerPedidosCobrablesPorTelefono('528199009899', NEG, {
        consultar: async () => { throw new Error('db_no_disponible_prueba'); },
      }),
      /db_no_disponible_prueba/,
    );
  });
} finally {
  try { await detenerServidor(); } catch { /* ya detenido */ }
  try { await limpiar(); } finally {
    await new Promise((resolve) => clipMock.close(() => resolve())).catch(() => {});
    await pool.end().catch(() => {});
  }
}

console.log(`\n═══ fase-agente-programados-db: ${pasadas} OK · ${fallos.length} fallos ═══`);
for (const fallo of fallos) console.log(`  · ${fallo}`);
process.exit(fallos.length ? 1 : 0);
