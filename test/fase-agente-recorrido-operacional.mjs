// ─── EL RECORRIDO COMPLETO DE UN PEDIDO DEL AGENTE ─────────────────────────
//
// El riesgo abierto en `docs/mesero-rescue-status.md` §14 decía, con todas sus
// letras: «falta demostrar con base y canal de prueba que el mensaje al
// cliente, el panel y la impresión reciban el mismo folio». El replay y el
// humo simulado no ejercitan ese tramo — prueban que Xabor DECIDE bien, no que
// el pedido LLEGUE.
//
// Aquí se ejercita, de punta a punta y con las piezas reales:
//
//   webhook de WhatsApp
//     -> whatsapp-meta.js (el sitio de llamada del agente, el de verdad)
//     -> atenderConAgente -> el bucle -> confirmar_pedido
//     -> registrarPedido        (la única puerta, con su gate P0)
//     -> emitirPedido           (deuda de la 063, advisory lock, relectura)
//          -> registrarCompraReal      ← la compra durable
//          -> Edge                     ← el PAPEL
//          -> wsBroadcastNegocio       ← el PANEL
//     -> Meta                          ← el CLIENTE
//
// Y la pregunta que cierra el riesgo: **¿todos miran el mismo folio?**
//
// ── QUÉ ES DE MENTIRA AQUÍ Y QUÉ NO ──────────────────────────────────────
//
// De mentira, exactamente tres cosas, y ninguna del lado de Xabor:
//
//   · el MODELO — un mock HTTP que devuelve `tool_use`. El modelo real no
//     decide nada de lo que se afirma aquí: quien valida, reconcilia, registra
//     y emite es el código de producción;
//   · META — el mock de siempre, para no mandar WhatsApp de verdad;
//   · la IMPRESORA — una terminal Edge falsa que habla el protocolo exacto de
//     `edge/connection.js` y confirma el trabajo. El papel no existe; el
//     trabajo de impresión y su ruta sí, y son los de producción.
//
// De verdad: el servidor real, Postgres real, el WebSocket del panel real, la
// migración 084 real con su índice único, `registrarPedido` real, `emitirPedido`
// real con su deuda de emisión.
//
// ── LO QUE ESTA PRUEBA NO DEMUESTRA ──────────────────────────────────────
//
// Que una EC Line 80mm escupa papel, y que el navegador del panel dibuje la
// comanda. Eso solo se ve con hardware y un navegador delante. Lo que sí queda
// demostrado es que los dos reciben el mismo folio que se registró, que es la
// parte que un despliegue no puede arreglar si está mal.
//
// Uso: DATABASE_URL a un Postgres LOCAL (la prueba se niega con cualquier
// otro), más las variables de la batería.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import assert from 'assert';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';
import { crearContinuidad } from '../src/services/whatsappContinuidad.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

// ── EL CERROJO: esta prueba escribe pedidos, compras y trabajos de impresión.
// Contra una base que no sea local, eso es tocar datos de alguien.
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const HOST = new URL(process.env.DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(HOST)) {
  throw new Error('Esta prueba crea pedidos reales: solo acepta Postgres local');
}

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { crearEdge, generarEmparejamiento, canjearEmparejamiento } = await import('../src/services/edgeService.js');
const { crearImpresora, crearRuta } = await import('../src/services/impresionService.js');

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

let NEG = null;
const PNID = `AGR-${randomUUID()}`;
const TEL = '5281990001';            // el número del canario
const TEL_CAIDA = '5281990002';      // el de la parte B
const PUERTO = String(process.env.TEST_PORT_AGR || 4967);
const PREFIJO = 'AGR ';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(condicion, { limiteMs = 12000, pasoMs = 80, que = 'la condición' } = {}) {
  const fin = Date.now() + limiteMs;
  while (Date.now() < fin) {
    const v = await condicion();
    if (v) return v;
    await esperar(pasoMs);
  }
  throw new Error(`se agotó la espera de ${que}`);
}

// ── LIMPIEZA del negocio que esta ejecución creó ─────────────────────────
async function limpiar() {
  if (!NEG) return;
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono' LIKE $2`,
    [NEG, '528199%']).catch(() => {});
  await pool.query('DELETE FROM agente_operaciones WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM conversacion_estado WHERE negocio_id=$1 AND session_id LIKE $2',
    [NEG, 'agente%']).catch(() => {});
  await pool.query('DELETE FROM whatsapp_entradas WHERE negocio_id=$1 AND telefono LIKE $2',
    [NEG, '528199%']).catch(() => {});
  await pool.query('DELETE FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono LIKE $2',
    [NEG, '528199%']).catch(() => {});
  await pool.query('DELETE FROM mensajes WHERE negocio_id=$1 AND telefono LIKE $2',
    [NEG, '528199%']).catch(() => {});
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1 AND nombre LIKE $2`, [NEG, PREFIJO + '%']);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre LIKE $2`, [NEG, PREFIJO + '%']);
  await pool.query('DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal=$2 AND identificador=$3',
    [NEG, 'whatsapp', PNID]);
  await pool.query("DELETE FROM metodos_pago WHERE negocio_id=$1 AND tipo='efectivo'", [NEG]).catch(() => {});
  await pool.query('DELETE FROM compras_reales WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM impresion_trabajos WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM impresion_rutas WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM impresoras WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query(`DELETE FROM edge_instalaciones WHERE terminal_id IN
    (SELECT t.id FROM terminales t JOIN sucursales s ON s.id=t.sucursal_id WHERE s.negocio_id=$1)`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM terminales WHERE sucursal_id IN
    (SELECT id FROM sucursales WHERE negocio_id=$1)`, [NEG]).catch(() => {});
  await pool.query('DELETE FROM sucursales WHERE negocio_id=$1 AND nombre LIKE $2', [NEG, PREFIJO + '%']).catch(() => {});
  await pool.query('DELETE FROM usuario_negocios WHERE negocio_id=$1 AND usuario_id=$2',
    [NEG, SEED.adminNegocioAUsuarioId]).catch(() => {});
  await pool.query('DELETE FROM pedido_emisiones WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM pedidos WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM clientes WHERE negocio_id=$1', [NEG]).catch(() => {});
  await pool.query('DELETE FROM configuracion WHERE negocio_id=$1', [NEG]);
  await pool.query('DELETE FROM negocio_modulos WHERE negocio_id=$1', [NEG]);
  await pool.query('DELETE FROM negocios WHERE id=$1', [NEG]);
}

let metaMock = null;
let anthropicMock = null;
let srv = null;
let panel = null;
let edge = null;

try {
// Un negocio nuevo en cada ejecución: ni el montaje ni la limpieza pueden
// alterar el negocio D del seed u otra suite que comparta Postgres local.
const { rows: [negocio] } = await pool.query(
  'INSERT INTO negocios (nombre, slug) VALUES ($1,$2) RETURNING id',
  [PREFIJO + 'Recorrido', `agr-recorrido-${randomUUID()}`]);
NEG = negocio.id;

// ── LA CARTA, creada como la de cualquier negocio ────────────────────────
const { rows: [cat] } = await pool.query(
  'INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,994) RETURNING id',
  [NEG, PREFIJO + 'Desayunos']);
const { rows: [prod] } = await pool.query(
  `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
   VALUES ($1,$2,$3,105,TRUE,0) RETURNING id`, [NEG, cat.id, PREFIJO + 'Waffle']);
const PRODUCTO_ID = prod.id;

// ── EL CANARIO, con alcance EXPLÍCITO ────────────────────────────────────
const { actualizarConfiguracion } = await import('../src/services/database.js');
await actualizarConfiguracion({
  int_wa_phone_id: PNID, int_wa_token: 'fake-agr',
  nombre_negocio: 'Prueba Recorrido',
  mesero_agente_v1: 'true',
  mesero_agente_telefonos: `${TEL},${TEL_CAIDA}`,
  mesero_agente_porcentaje: '0',
  mesero_agente_shadow: 'false',
  pedido_requiere_pago: 'true',
  reglas_atencion: JSON.stringify({
    horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
      .map((d) => [d, { abierto: true, apertura: '00:00', cierre: '23:59' }])),
  }),
}, NEG);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo)
  VALUES ($1,'whatsapp',$2,'AGR',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [NEG, PNID]);
await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'whatsapp','activo')
  ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [NEG]);
// El canario del agente debe funcionar aunque el bot legacy permanezca apagado.
await pool.query('UPDATE negocios SET bot_whatsapp_activo=FALSE WHERE id=$1', [NEG]);

// ── LOS MÉTODOS DE PAGO, declarados como en cualquier negocio real ──────
//
// `politicaDePagos.evaluarFormaPago` lee la lista real de `metodos_pago`.
// Una lista VACÍA no significa «acepta lo de siempre»: significa que el
// negocio no declaró ninguno, y entonces se rechaza todo, incluido el
// efectivo. Un negocio sin métodos configurados tiene un agente que no
// puede cerrar un pedido, así que el fixture declara el suyo en vez de
// apoyarse en un valor por omisión que no existe.
await pool.query(
  `INSERT INTO metodos_pago (negocio_id, tipo, habilitado, disponible_para_bot, disponible_para_operador, orden)
   VALUES ($1,'efectivo',TRUE,TRUE,TRUE,10)`, [NEG]);

// ── LA IMPRESORA: una terminal Edge de verdad, con su ruta de comanda ────
//
// El Edge se instala en una sucursal; este negocio de prueba no tenía ninguna.
// Se crea marcada con el prefijo para poder retirarla al terminar.
const { rows: [sucursal] } = await pool.query(
  'INSERT INTO sucursales (negocio_id, nombre, activo) VALUES ($1,$2,TRUE) RETURNING id',
  [NEG, PREFIJO + 'Sucursal']);
const EDGE = await crearEdge(NEG, { nombre: 'PC Edge Recorrido', sucursalId: sucursal.id });
const { codigo } = await generarEmparejamiento(NEG, EDGE.id);
const CRED = await canjearEmparejamiento(codigo);
const IMPRESORA = await crearImpresora(NEG, {
  terminalId: EDGE.id, nombre: 'COCINA AGR', transporte: 'mock', anchoColumnas: 42 });
await crearRuta(NEG, { impresoraId: IMPRESORA.id, ambito: 'documento', clave: 'comanda' });

// ── EL MODELO DE GUION, por HTTP ─────────────────────────────────────────
//
// Devuelve `tool_use` igual que el modelo real. Dos piezas se leen del propio
// payload —el `producto_id` que encontró la búsqueda y la huella del resumen—
// porque escribirlas a mano dejaría de probar que el agente las produjo: un
// valor fijo pasaría aunque `buscar_producto` no devolviera nada.
const bloqueTexto = (texto) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: texto }] });
let nTool = 0;
const bloqueHerramienta = (name, input) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: `tu_agr_${++nTool}`, name, input }],
});

/** El último `tool_result` del payload, ya parseado. */
function ultimoResultado(payload) {
  const msgs = payload?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const c = msgs[i]?.content;
    if (!Array.isArray(c)) continue;
    for (let j = c.length - 1; j >= 0; j -= 1) {
      if (c[j]?.type === 'tool_result') {
        try { return JSON.parse(c[j].content); } catch { return null; }
      }
    }
  }
  return null;
}

metaMock = await arrancarMetaMock();
anthropicMock = await arrancarAnthropicMock();
srv = await arrancarServidor({
  PORT: PUERTO,
  META_GRAPH_BASE_URL: metaMock.baseUrl,
  ANTHROPIC_BASE_URL: anthropicMock.baseUrl,
  ANTHROPIC_API_KEY: 'sk-ant-test-agr',
  MESERO_AGENTE_MODE: 'true',
  MESERO_AGENTE_SHADOW: 'false',
}, { timeoutMs: 30000 });

// El panel exige que quien abre el WebSocket sea miembro ACTIVO del negocio
// —si no, 403, y hace bien—. Este negocio de prueba no tenía a nadie dentro.
await pool.query(
  `INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,'admin',TRUE)
   ON CONFLICT (usuario_id, negocio_id) DO UPDATE SET rol='admin', activo=TRUE`,
  [SEED.adminNegocioAUsuarioId, NEG]);

const ADMIN = `xabor_sesion=${encodeURIComponent(
  crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: NEG, rol: 'admin' }))}`;

function abrirPanel() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(srv.base.replace('http://', 'ws://') + '/ws/panel', { headers: { Cookie: ADMIN } });
    const to = setTimeout(() => reject(new Error('timeout abriendo el WS del panel')), 8000);
    ws.on('open', () => { clearTimeout(to); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

/** La terminal Edge falsa: el protocolo exacto de `edge/connection.js`. */
function conectarEdgeFalso() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(srv.base.replace('http://', 'ws://') + '/ws/print-agent');
    const recibidos = [];
    const to = setTimeout(() => reject(new Error('timeout autenticando el Edge falso')), 8000);
    ws.on('open', () => ws.send(JSON.stringify({
      tipo: 'autenticar_terminal', terminalId: CRED.terminalId, token: CRED.token,
      instalacionId: 'agr-instalacion-1' })));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.tipo === 'terminal_autenticada') { clearTimeout(to); resolve({ ws, recibidos }); }
      if (m.tipo === 'trabajo_impresion' && m.trabajo?.id) {
        recibidos.push(m.trabajo);
        ws.send(JSON.stringify({ tipo: 'ack_impresion', trabajoId: m.trabajo.id, resultado: 'enviado' }));
      }
    });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

panel = await abrirPanel();
const vistosPorElPanel = [];
panel.on('message', (raw) => { try { vistosPorElPanel.push(JSON.parse(raw.toString())); } catch { /* ruido */ } });
edge = await conectarEdgeFalso();

let seq = 0;
async function webhook(tel, texto) {
  await fetch(srv.base + '/webhook/whatsapp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: PNID },
        messages: [{ type: 'text', from: tel, id: `wamid.AGR-${Date.now()}-${seq++}`, text: { body: texto } }],
        contacts: [{ profile: { name: 'Cliente Recorrido' } }],
      } }] }],
    }),
  });
}

const esAcuse = (m) => m?.status === 'read';
const alCliente = () => metaMock.obtenerMensajesEnviados().filter((m) => !esAcuse(m));
const RESUMEN = 'Un AGR Waffle, $105, para recoger, pago en efectivo. ¿Lo confirmo?';

let FOLIO = null;

// ═══════════════════════════════════════════════════════════════════════════
// PARTE A — EL RECORRIDO, con el servidor real
// ═══════════════════════════════════════════════════════════════════════════

await t('R1 el webhook arma el pedido y el agente responde por el canal real', async () => {
  anthropicMock.drenar();
  anthropicMock.encolarRespuesta(() => bloqueHerramienta('buscar_producto', { texto: 'waffle' }));
  anthropicMock.encolarRespuesta((payload) => {
    // El id NO se escribe a mano: se toma del resultado de la búsqueda, que es
    // de donde lo toma el modelo real. Un valor fijo pasaría aunque
    // `buscar_producto` no hubiera devuelto nada.
    const hallazgo = ultimoResultado(payload);
    const encontrados = hallazgo?.encontrados || [];
    assert.ok(encontrados.length >= 1,
      `buscar_producto no encontró el waffle en la carta real: ${JSON.stringify(hallazgo).slice(0, 300)}`);
    const id = encontrados[0].producto_id ?? encontrados[0].id;
    assert.ok(id, `la ficha no trae id: ${JSON.stringify(encontrados[0]).slice(0, 200)}`);
    return bloqueHerramienta('agregar_producto', { producto_id: String(id), cantidad: 1 });
  });
  anthropicMock.encolarRespuesta(() => bloqueHerramienta('definir_entrega', { modalidad: 'recoger en tienda' }));
  anthropicMock.encolarRespuesta(() => bloqueHerramienta('definir_pago', { forma_pago: 'efectivo' }));
  anthropicMock.encolarRespuesta(() => bloqueHerramienta('ver_pedido', {}));
  anthropicMock.encolarRespuesta(() => bloqueTexto(RESUMEN));

  const antes = alCliente().length;
  await webhook(TEL, 'quiero un waffle para recoger, pago en efectivo');
  await hasta(() => alCliente().length > antes, { que: 'la respuesta al cliente' });

  const dicho = alCliente().slice(antes).map((m) => m.text?.body || '').join(' | ');
  assert.ok(/waffle/i.test(dicho), `el agente tenía que resumir el pedido: ${dicho}`);

  // El pedido está armado pero NO confirmado: nada en pedidos_activos todavía.
  const { rows } = await pool.query(
    `SELECT folio FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono'=$2`, [NEG, TEL]);
  assert.equal(rows.length, 0, 'un resumen no es una confirmación: no debía haber pedido aún');
});

await t('R2 al confirmar nace UN pedido, con folio, por la puerta de siempre', async () => {
  anthropicMock.drenar();
  anthropicMock.encolarRespuesta(() => bloqueHerramienta('ver_pedido', {}));
  anthropicMock.encolarRespuesta((payload) => {
    const vista = ultimoResultado(payload);
    const huella = vista?.pedido?.huella ?? vista?.huella;
    assert.ok(huella, 'el agente tenía que entregar la huella del resumen en ver_pedido');
    return bloqueHerramienta('confirmar_pedido', { huella_resumen: huella });
  });
  anthropicMock.encolarRespuesta(() => bloqueTexto('¡Listo! Tu pedido quedó confirmado.'));

  await webhook(TEL, 'sí, confírmalo');
  const fila = await hasta(async () => {
    const { rows } = await pool.query(
      `SELECT folio, estado, datos FROM pedidos_activos
        WHERE negocio_id=$1 AND datos->'cliente'->>'telefono'=$2`, [NEG, TEL]);
    return rows[0] || null;
  }, { que: 'el pedido en pedidos_activos' });

  FOLIO = fila.folio;
  assert.ok(/^XAB-\d+$/.test(FOLIO), `el folio no tiene la forma de siempre: ${FOLIO}`);
  const { rows: todos } = await pool.query(
    `SELECT folio FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono'=$2`, [NEG, TEL]);
  assert.equal(todos.length, 1, `nació más de un pedido: ${JSON.stringify(todos)}`);
});

await t('R3 el PANEL recibe nuevo_pedido con ESE folio', async () => {
  assert.ok(FOLIO, 'sin folio no hay nada que comprobar: R2 tenía que haber pasado');
  const evento = await hasta(
    () => vistosPorElPanel.find((m) => m.tipo === 'nuevo_pedido' && m.pedido?.id === FOLIO),
    { que: `el evento nuevo_pedido de ${FOLIO} en el panel` });
  assert.equal(evento.pedido.id, FOLIO);
  assert.equal(evento.pedido.negocioId, NEG, 'el panel de otro negocio no puede recibirlo');
  // Lo que el panel necesita para imprimir la comanda de cocina.
  assert.ok(Array.isArray(evento.pedido.items) && evento.pedido.items.length >= 1,
    'sin renglones no hay comanda que imprimir');
});

await t('R4 la IMPRESIÓN recibe un trabajo con ESE folio', async () => {
  assert.ok(FOLIO, 'sin folio no hay nada que comprobar: R2 tenía que haber pasado');
  // Durable primero: el trabajo existe en la base, con su pedido.
  const trabajo = await hasta(async () => {
    const { rows } = await pool.query(
      `SELECT id, estado, origen_id, payload FROM impresion_trabajos
        WHERE negocio_id=$1 AND origen_tipo='pedido' AND origen_id=$2
        ORDER BY created_at DESC LIMIT 1`, [NEG, FOLIO]);
    return rows[0] || null;
  }, { que: `el trabajo de impresión de ${FOLIO}` });
  assert.equal(trabajo.origen_id, FOLIO, 'el papel se imprimiría con otro folio');

  // Y la terminal lo recibió por el protocolo real y lo confirmó.
  const entregado = await hasta(
    () => edge.recibidos.find((x) => String(x.id) === String(trabajo.id)),
    { que: 'la entrega del trabajo a la terminal Edge' });
  assert.ok(entregado, 'el papel no llegó a la impresora');
});

await t('R5 la COMPRA DURABLE lleva ESE folio', async () => {
  assert.ok(FOLIO, 'sin folio no hay nada que comprobar: R2 tenía que haber pasado');
  const compra = await hasta(async () => {
    const { rows } = await pool.query(
      'SELECT folio, negocio_id FROM compras_reales WHERE negocio_id=$1 AND folio=$2', [NEG, FOLIO]);
    return rows[0] || null;
  }, { que: `la compra real de ${FOLIO}` });
  assert.equal(compra.folio, FOLIO);
});

await t('R6 los CUATRO observadores miran el mismo folio', async () => {
  // El riesgo de §14, resuelto en una sola afirmación.
  assert.ok(FOLIO, 'sin folio no hay nada que comprobar: R2 tenía que haber pasado');
  const { rows: [pedido] } = await pool.query(
    'SELECT folio FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2', [NEG, FOLIO]);
  const enElPanel = vistosPorElPanel.find((m) => m.tipo === 'nuevo_pedido' && m.pedido?.id === FOLIO);
  const { rows: [impreso] } = await pool.query(
    `SELECT origen_id FROM impresion_trabajos
      WHERE negocio_id=$1 AND origen_tipo='pedido' AND origen_id=$2 LIMIT 1`, [NEG, FOLIO]);
  const { rows: [compra] } = await pool.query(
    'SELECT folio FROM compras_reales WHERE negocio_id=$1 AND folio=$2', [NEG, FOLIO]);

  const vistos = {
    registro: pedido?.folio, panel: enElPanel?.pedido?.id,
    impresion: impreso?.origen_id, compra: compra?.folio,
  };
  assert.deepStrictEqual(vistos, { registro: FOLIO, panel: FOLIO, impresion: FOLIO, compra: FOLIO },
    `no todos ven el mismo folio: ${JSON.stringify(vistos)}`);
});

await t('R7 el cliente recibió la confirmación, y una sola vez', async () => {
  assert.ok(FOLIO, 'sin folio no hay confirmación que valga: R2 tenía que haber pasado');
  const confirmaciones = alCliente().filter((m) => /confirmad/i.test(m.text?.body || ''));
  assert.equal(confirmaciones.length, 1,
    `el cliente recibió ${confirmaciones.length} confirmaciones: ${JSON.stringify(confirmaciones.map((m) => m.text?.body))}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTE B — LA CAÍDA DESPUÉS DEL COMMIT, contra Postgres de verdad
// ═══════════════════════════════════════════════════════════════════════════
//
// `test/fase-agente-confirmacion-perdida.mjs` ya corre este caso entero sin
// base, con el libro en memoria. Lo que faltaba —y lo dice §14— es que el
// bloqueo lo haga el ÍNDICE ÚNICO REAL de la 084 y no su equivalente en
// memoria. Aquí el COMMIT es real: `registrarPedido` escribe de verdad en
// Postgres y es la RESPUESTA la que se pierde, que es el accidente exacto.

const { atenderConAgente } = await import('../src/mesero-agente/canalDelAgente.js');
const { registrarPedido } = await import('../src/orders/orderManager.js');

const handoffs = [];
const escalarAHumano = async (n, tel, motivo) => { handoffs.push({ n, tel, motivo }); return true; };

// El registro REAL, con la respuesta perdida justo después del COMMIT.
let perderRespuesta = true;
const registrarYPerderLaRespuesta = async (orden, canal) => {
  const r = await registrarPedido(orden, canal);          // ← COMMIT de verdad
  if (perderRespuesta) {
    throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
  }
  return r;
};

function guionDelAgente(pasos) {
  let i = 0;
  return async () => {
    const paso = pasos[i]; i += 1;
    if (!paso) return { stop_reason: 'end_turn', content: [{ type: 'text', text: '(guion agotado)' }] };
    if (paso.texto !== undefined) return { stop_reason: 'end_turn', content: [{ type: 'text', text: paso.texto }] };
    return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu_b_${i}`, name: paso.name, input: paso.input }] };
  };
}

const GUION_ARMAR_B = [
  { name: 'agregar_producto', input: { producto_id: String(PRODUCTO_ID), cantidad: 1 } },
  { name: 'definir_entrega', input: { modalidad: 'recoger en tienda' } },
  { name: 'definir_pago', input: { forma_pago: 'efectivo' } },
  { name: 'ver_pedido', input: {} },
  { texto: RESUMEN },
];

/** El guion que confirma, leyendo la huella viva del último ver_pedido. */
function guionConfirmarB() {
  let i = 0;
  let huella = null;
  return async (peticion) => {
    i += 1;
    if (i === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_bc_1', name: 'ver_pedido', input: {} }] };
    if (i === 2) {
      const msgs = peticion?.messages || [];
      for (let k = msgs.length - 1; k >= 0 && !huella; k -= 1) {
        const c = msgs[k]?.content;
        if (!Array.isArray(c)) continue;
        for (const b of c) {
          if (b?.type === 'tool_result') {
            try { const v = JSON.parse(b.content); huella = v?.pedido?.huella ?? v?.huella ?? null; } catch { /* ruido */ }
          }
        }
      }
      return { stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_bc_2', name: 'confirmar_pedido', input: { huella_resumen: huella } }] };
    }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: '¡Listo!' }] };
  };
}

const llamarB = (guion) => async (peticion) => guion(peticion);
let pedidosTrasLaCaida = [];

await t('R8 el COMMIT es real aunque la respuesta se pierda', async () => {
  await atenderConAgente({
    negocioId: NEG, telefono: TEL_CAIDA, mensaje: 'un waffle para recoger, efectivo',
    canal: 'whatsapp', llamarModelo: llamarB(guionDelAgente(GUION_ARMAR_B)),
    escalarAHumano, emitir: async () => {}, guardar: async () => {},
  });

  const r = await atenderConAgente({
    negocioId: NEG, telefono: TEL_CAIDA, mensaje: 'sí, confírmalo',
    canal: 'whatsapp', llamarModelo: llamarB(guionConfirmarB()),
    escalarAHumano, registrar: registrarYPerderLaRespuesta,
    emitir: async () => {}, guardar: async () => {},
  });

  const { rows } = await pool.query(
    `SELECT folio FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono'=$2`, [NEG, TEL_CAIDA]);
  pedidosTrasLaCaida = rows;
  assert.equal(rows.length, 1, `el COMMIT tenía que quedar: ${JSON.stringify(rows)}`);
  assert.equal(r.folio ?? null, null, 'no se puede conocer un folio cuya respuesta se perdió');
});

await t('R9 el HANDOFF humano sí se emite tras la caída', async () => {
  assert.ok(handoffs.length > 0,
    'la caída dejó al cliente esperando a una persona que nadie llamó');
  const motivos = handoffs.map((h) => h.motivo);
  assert.ok(motivos.includes('AGENTE_ESTADO_INCIERTO'),
    `el aviso tenía que decir que el estado quedó incierto: ${JSON.stringify(motivos)}`);
  assert.ok(handoffs.every((h) => h.tel === TEL_CAIDA), 'el handoff apunta a otra conversación');
});

await t('R10 el ÍNDICE ÚNICO real de la 084 anotó la confirmación caída', async () => {
  // Acotado a ESTA conversación: en la parte A hay otra confirmación —la que
  // sí salió bien— y contarlas juntas mediría el negocio en vez del accidente.
  const { rows } = await pool.query(
    `SELECT operacion_clave, estado, aplicada FROM agente_operaciones
      WHERE negocio_id=$1 AND conversacion_id=$2 AND herramienta='confirmar_pedido'`,
    [NEG, 'agente:' + TEL_CAIDA]);
  assert.equal(rows.length, 1, `la confirmación caída tenía que dejar UNA fila: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].estado, 'error', 'una respuesta perdida no es un desenlace cerrado');
  assert.equal(rows[0].aplicada, false);
});

await t('R11 el turno siguiente NO crea un segundo pedido (lo bloquea Postgres)', async () => {
  // El cliente insiste. El estado de la conversación quedó congelado por
  // `confirmacionIncierta`, y por debajo el libro REAL de la 084 tiene la
  // confirmación anterior anotada: ningún camino llega a un segundo pedido.
  perderRespuesta = false;   // aunque ahora el registro funcionara, no debe llamarse
  const r = await atenderConAgente({
    negocioId: NEG, telefono: TEL_CAIDA, mensaje: 'oye, ¿sí entró mi pedido? confírmalo por favor',
    canal: 'whatsapp', llamarModelo: llamarB(guionConfirmarB()),
    escalarAHumano, registrar: registrarYPerderLaRespuesta,
    emitir: async () => {}, guardar: async () => {},
  });

  const { rows } = await pool.query(
    `SELECT folio FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono'=$2`, [NEG, TEL_CAIDA]);
  assert.equal(rows.length, 1,
    `nació un segundo pedido por el mismo waffle: ${JSON.stringify(rows)} (antes: ${JSON.stringify(pedidosTrasLaCaida)})`);
  assert.equal(rows[0].folio, pedidosTrasLaCaida[0].folio, 'el folio cambió: hubo un registro nuevo');
  assert.equal(r.folio ?? null, null, 'no se le puede anunciar al cliente un folio que nadie conoce');
});

await t('R12 y el pedido que sí quedó NO se emitió: por eso hace falta una persona', async () => {
  // La consecuencia operativa del accidente, dicha en la prueba: el pedido
  // existe en Postgres y no llegó ni al panel ni al papel. Quien lo concilia
  // es el humano al que R9 llamó.
  const folio = pedidosTrasLaCaida[0].folio;
  const enElPanel = vistosPorElPanel.filter((m) => m.tipo === 'nuevo_pedido' && m.pedido?.id === folio);
  assert.deepEqual(enElPanel, [], 'un pedido cuya respuesta se perdió no pudo emitirse');
  const { rows } = await pool.query(
    `SELECT id FROM impresion_trabajos WHERE negocio_id=$1 AND origen_tipo='pedido' AND origen_id=$2`,
    [NEG, folio]);
  assert.deepEqual(rows, [], 'tampoco pudo imprimirse');
});

await t('R13 la revisión existente recibe el motivo preciso de la caída', async () => {
  const avisos = [];
  const continuidad = crearContinuidad({
    pool, locks: { connect: () => pool.connect() },
    procesar: async () => {}, cargarSesion: async () => {}, leerSesion: async () => ({}),
    alRevision: async (_n, _t, motivo) => { avisos.push(motivo); },
  });
  assert.equal(await continuidad.enviarARevision(NEG, TEL_CAIDA, 'AGENTE_PIDE_HUMANO'), true);
  assert.equal(await continuidad.enviarARevision(NEG, TEL_CAIDA, 'AGENTE_ESTADO_INCIERTO'), true);
  assert.deepEqual(avisos, ['AGENTE_PIDE_HUMANO', 'AGENTE_ESTADO_INCIERTO']);
  const { rows: [fila] } = await pool.query(
    'SELECT requiere_revision, motivo FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2',
    [NEG, TEL_CAIDA]);
  assert.equal(fila.requiere_revision, true);
  assert.equal(fila.motivo, 'AGENTE_ESTADO_INCIERTO');
});

} finally {
  try { panel?.close(); } catch { /* ya cerrado */ }
  try { edge?.ws?.close(); } catch { /* ya cerrado */ }
  try { srv?.detener(); } catch { /* ya detenido */ }
  try { metaMock?.detener(); } catch { /* ya detenido */ }
  try { anthropicMock?.detener(); } catch { /* ya detenido */ }
  try { await limpiar(); } finally { await pool.end().catch(() => {}); }
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`PASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
