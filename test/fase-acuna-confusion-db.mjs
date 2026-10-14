// ─── CONFUSIÓN DEL BOT EN ACUÑA (14-OCT-2026), CON BASE ─────────────────────
//
//   T — contestar desde el panel calla al bot 30 min en ESA conversación (antes
//       solo la Business App lo hacía y el bot hablaba encima del personal).
//   R — sin el módulo «repartidores», WhatsApp no registra ni enruta
//       repartidores: «La ubicación … se la renvía al repartidor» registró a un
//       cliente como repartidor. Con el módulo, todo sigue como antes.
//   P — «Aplicar promoción» no lista la copia vencida de una promoción que ya
//       tiene su versión vigente; la lista de la tienda marca las vencidas.
//
// Uso: mismas env vars que la batería. Requiere aplicar-migraciones.mjs y
// seed-datos-prueba.mjs ya corridos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_ACUNA_CONFUSION || '4747';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, actualizarConfiguracion, getTakeoverHumanoActivo } = await import('../src/services/database.js');
const { listarPromocionesParaPedido } = await import('../src/services/promocionManual.js');
const { listarPromociones } = await import('../src/services/tiendaPromociones.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function t(cat, nombre, fn) {
  if (SOLO.length && !SOLO.some((p) => `${cat}${nombre}`.startsWith(p) || cat === p)) return;
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const NEG_A = SEED.negocioA, NEG_B = SEED.negocioB;
const ADMIN_A = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: NEG_A, rol: 'admin' }))}`;

// ═══════════ Setup ═══════════
const PNID = 'PNID_ACUNA_CONFUSION_A';
// Un teléfono por mensaje de prueba: si un mensaje deja la conversación en
// pausa o en revisión, el siguiente no llegaría al alta y el caso pasaría
// sin probar nada.
const TEL = { panel: '5218781007001', ajeno: '5218781007002', alta: '5218781007003', alta2: '5218781007008',
  altaConModulo: '5218781007004', registrado: '5218781007005', sufijo: '5218781007006', sufijo2: '5218781007009',
  oferta: '5218781007007' };
const TELS = Object.values(TEL);
// `repartidores.telefono` se guarda con 10 dígitos (normalizarTelefono).
const d10 = (t) => String(t).slice(-10);
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}
const { rows: [modAntes] } = await pool.query(`SELECT estado FROM negocio_modulos WHERE negocio_id = $1 AND modulo = 'repartidores'`, [NEG_A]);
const CLAVES_OFERTA = ['repartidor_notif_plantilla_activo', 'repartidor_notif_piloto_telefonos'];
const { rows: cfgOfertaAntes } = await pool.query(`SELECT clave, valor FROM configuracion WHERE negocio_id = $1 AND clave = ANY($2)`, [NEG_A, CLAVES_OFERTA]);
async function limpiar() {
  await pool.query(`DELETE FROM notificaciones_repartidor WHERE repartidor_id IN (SELECT id FROM repartidores WHERE right(telefono, 10) = ANY($1))`, [TELS.map(d10)]);
  await pool.query(`DELETE FROM repartidores WHERE right(telefono, 10) = ANY($1)`, [TELS.map(d10)]);
  await pool.query(`DELETE FROM mensajes WHERE telefono = ANY($1)`, [TELS]);
  await pool.query(`DELETE FROM clientes WHERE telefono = ANY($1)`, [TELS]);
}
await limpiar();
await fijarModulo(NEG_A, 'pos', 'activo');
await fijarModulo(NEG_A, 'whatsapp', 'activo');
await actualizarConfiguracion({ int_wa_phone_id: PNID, int_wa_token: 'fake-token-acuna-confusion' }, NEG_A);
await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE identificador = $1)`, [PNID]);
await pool.query(`DELETE FROM integraciones_canal WHERE identificador = $1`, [PNID]);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,'Acuña confusión A',TRUE)`, [NEG_A, PNID]);
const { rows: [botAntes] } = await pool.query(`SELECT bot_whatsapp_activo FROM negocios WHERE id = $1`, [NEG_A]);
// Bot ENCENDIDO: con el bot apagado el webhook termina antes del alta y del
// enrutamiento de repartidores, y los casos R pasarían sin probar nada.
await pool.query(`UPDATE negocios SET bot_whatsapp_activo = TRUE WHERE id = $1`, [NEG_A]);

const metaMock = await arrancarMetaMock();
const anthropicMock = await arrancarAnthropicMock();
const srv = await arrancarServidor({ PORT: PUERTO, META_GRAPH_BASE_URL: metaMock.baseUrl,
  ANTHROPIC_BASE_URL: anthropicMock.baseUrl, ANTHROPIC_API_KEY: 'sk-ant-test-mock', OPENAI_API_KEY: '' }, { timeoutMs: 30000 });
const api = async (path, { method = 'GET', body, cookie = ADMIN_A } = {}) => {
  const r = await fetch(srv.base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, body: json };
};
async function webhook(telefono, texto) {
  const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
    metadata: { phone_number_id: PNID },
    messages: [{ type: 'text', from: telefono, id: `wamid.ACUNACONF-${Date.now()}-${Math.random()}`, text: { body: texto } }],
    contacts: [{ profile: { name: 'Cliente Acuña Confusión' } }],
  } }] }] };
  // El webhook guarda el mensaje al recibirlo y lo PROCESA después (alta y
  // enrutamiento de repartidores incluidos): se espera la línea de entrada
  // del procesamiento, no solo la fila guardada.
  const entradas = () => (srv.obtenerSalida().match(/\[Meta WA\] entrada negocio=/g) || []).length;
  const antes = entradas();
  await fetch(srv.base + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const limite = Date.now() + 25000;
  while (entradas() <= antes && Date.now() < limite) await esperar(150);
  if (entradas() <= antes) throw new Error(`el servidor no procesó el mensaje «${texto.slice(0, 30)}»`);
  await esperar(1200); // margen para el registro / la respuesta, si la hubiera
}
const textosEnviadosA = (telefono) => metaMock.obtenerMensajesEnviados().filter((m) => m.to === telefono).map((m) => m.text?.body || '');

// La tarjeta de la promoción en Tienda → Promociones, tal cual está en el panel.
const PANEL = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');
function extraerFuncion(nombre) {
  const inicio = PANEL.indexOf(`function ${nombre}(`);
  assert.ok(inicio > 0, `no se encontró function ${nombre}() en panel/index.html`);
  let nivel = 0;
  for (let j = PANEL.indexOf('{', inicio); j < PANEL.length; j++) {
    if (PANEL[j] === '{') nivel++;
    else if (PANEL[j] === '}') { nivel--; if (nivel === 0) return PANEL.slice(inicio, j + 1); }
  }
  throw new Error(`no se pudo delimitar ${nombre}()`);
}
const tndTarjetaPromo = new Function('TND_TIPOS', 'TND_DIAS', 'TND_CANALES', 'tndDinero', 'tndEsc',
  `${extraerFuncion('tndTarjetaPromo')}; return tndTarjetaPromo;`)({ '2x1': '2x1' }, ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'],
  { pos: 'Mostrador', whatsapp: 'WhatsApp' }, (n) => `$${n}`, (s) => String(s));

const promosCreadas = [];
let folioP = null;
try {
  // ─── V — la tarjeta del panel ─────────────────────────────────────────────
  await t('V', '1. la tarjeta muestra la vigencia y marca «Vencida» solo si ya terminó', async () => {
    const base = { id: 'x', nombre: 'Miercoles de Chilaquiles', tipo: '2x1', activa: true, canales: ['pos'], diasSemana: [3],
      vigenciaDesde: '2026-09-01', vigenciaHasta: '2026-09-30', metricas: { usos: 0 } };
    const vencida = tndTarjetaPromo({ ...base, vencida: true });
    assert.match(vencida, />Vencida</);
    assert.match(vencida, /del 01\/09\/2026 al 30\/09\/2026/);
    assert.doesNotMatch(tndTarjetaPromo({ ...base, vencida: false }), />Vencida</);
    const inactiva = tndTarjetaPromo({ ...base, activa: false, vencida: true });
    assert.match(inactiva, />Inactiva</); assert.doesNotMatch(inactiva, />Vencida</, 'inactiva ya lo dice todo');
    assert.doesNotMatch(tndTarjetaPromo({ ...base, vigenciaDesde: null, vigenciaHasta: null }), /del |al \d/);
  });

  // ─── T — el panel calla al bot ────────────────────────────────────────────
  await t('T', '1. contestar desde el panel activa la pausa de 30 min de ESA conversación', async () => {
    assert.strictEqual(await getTakeoverHumanoActivo(TEL.panel, NEG_A), false, 'arranca sin pausa');
    const r = await api('/api/send-message', { method: 'POST', body: { telefono: TEL.panel, mensaje: 'Hola, el costo de envío es de $60' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(await getTakeoverHumanoActivo(TEL.panel, NEG_A), true, 'el bot debía quedar callado');
    const { rows: [c] } = await pool.query(`SELECT EXTRACT(EPOCH FROM (human_takeover_until - NOW())) / 60 AS min FROM clientes WHERE telefono = $1`, [TEL.panel]);
    assert.ok(c.min > 25 && c.min <= 30.5, `la pausa debía ser de ~30 min, fue de ${Number(c.min).toFixed(1)}`);
  });
  await t('T', '2. no toca la conversación de un cliente de OTRO negocio', async () => {
    await pool.query(`INSERT INTO clientes (telefono, negocio_id) VALUES ($1, $2)`, [TEL.ajeno, NEG_B]);
    const r = await api('/api/send-message', { method: 'POST', body: { telefono: TEL.ajeno, mensaje: 'mensaje de prueba' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const { rows: [c] } = await pool.query(`SELECT negocio_id, human_takeover_until FROM clientes WHERE telefono = $1`, [TEL.ajeno]);
    assert.strictEqual(c.negocio_id, NEG_B);
    assert.strictEqual(c.human_takeover_until, null, 'la pausa no debe cruzar de negocio');
  });
  await t('T', '3. si el envío a Meta falla, no hay pausa (el mensaje no salió)', async () => {
    await pool.query(`DELETE FROM clientes WHERE telefono = $1`, [TEL.panel]);
    metaMock.forzarErrorSiguienteEnvio();
    const r = await api('/api/send-message', { method: 'POST', body: { telefono: TEL.panel, mensaje: 'no sale' } });
    assert.notStrictEqual(r.status, 200);
    assert.strictEqual(await getTakeoverHumanoActivo(TEL.panel, NEG_A), false);
  });

  // ─── R — repartidores solo con el módulo ──────────────────────────────────
  await fijarModulo(NEG_A, 'repartidores', 'no_configurado');
  await t('R', '1. sin el módulo, «… al repartidor» de un cliente NO lo registra como repartidor', async () => {
    await webhook(TEL.alta, 'La ubicación no sé si pueda enviarla por aquí porque está algo confundido y ya se la renvia al repartidor');
    await webhook(TEL.alta2, 'Repartidor Juan Pérez');
    const { rows } = await pool.query(`SELECT id FROM repartidores WHERE right(telefono, 10) = ANY($1)`, [[TEL.alta, TEL.alta2].map(d10)]);
    assert.strictEqual(rows.length, 0, 'se registró un repartidor sin el módulo');
    assert.ok(![TEL.alta, TEL.alta2].some((t) => textosEnviadosA(t).some((x) => /registrado como repartidor/i.test(x))),
      'se le dijo que quedó registrado');
  });
  await t('R', '2. sin el módulo, un teléfono que YA tiene registro sigue como cliente («Listo» no es una entrega)', async () => {
    await pool.query(`INSERT INTO repartidores (nombre, telefono, token, activo, negocio_id, modo_actual)
      VALUES ('Registro viejo', $1, $2, TRUE, $3, 'repartidor')`, [d10(TEL.registrado), `tok-acunaconf-${Date.now()}`, NEG_A]);
    await webhook(TEL.registrado, 'Listo');
    const enviados = textosEnviadosA(TEL.registrado);
    assert.ok(!enviados.some((x) => /pedidos activos asignados|repartidor\.html|modo repartidor/i.test(x)),
      `recibió mensajes de repartidor: ${JSON.stringify(enviados)}`);
  });
  await t('R', '3. CON el módulo, el alta por WhatsApp funciona como antes (el candado es el módulo)', async () => {
    await fijarModulo(NEG_A, 'repartidores', 'activo');
    await webhook(TEL.altaConModulo, 'Repartidor Juan Pérez');
    const { rows } = await pool.query(`SELECT nombre FROM repartidores WHERE right(telefono, 10) = $1`, [d10(TEL.altaConModulo)]);
    assert.strictEqual(rows.length, 1, 'con el módulo debía registrarse · servidor: '
      + srv.obtenerSalida().split('\n').filter((l) => /Meta WA|epartidor|Bot |Takeover|pausad/i.test(l)).slice(-6).join(' | '));
    assert.strictEqual(rows[0].nombre, 'Juan Pérez');
  });
  await t('R', '4. CON el módulo, una frase que TERMINA en «repartidor» ya no da de alta', async () => {
    await webhook(TEL.sufijo, 'ya se la renvia al repartidor');
    await webhook(TEL.sufijo2, 'Soy el repartidor');
    const { rows } = await pool.query(`SELECT nombre FROM repartidores WHERE right(telefono, 10) = ANY($1)`, [[TEL.sufijo, TEL.sufijo2].map(d10)]);
    assert.strictEqual(rows.length, 0, `se registró: ${JSON.stringify(rows)}`);
  });
  await t('R', '5. sin el módulo no sale ninguna oferta; con él, sí (control)', async () => {
    await actualizarConfiguracion({ repartidor_notif_plantilla_activo: 'true', repartidor_notif_piloto_telefonos: TEL.oferta }, NEG_A);
    await pool.query(`INSERT INTO repartidores (nombre, telefono, token, activo, negocio_id) VALUES ('Oferta Acuña', $1, $2, TRUE, $3)`,
      [TEL.oferta, `tok-acunaconf-oferta-${Date.now()}`, NEG_A]);
    const ofertas = () => metaMock.obtenerMensajesEnviados().filter((m) => m.to === TEL.oferta && m.template).length;
    const pedir = async () => assert.strictEqual((await api('/test/pedido', { method: 'POST' })).status, 200);
    await fijarModulo(NEG_A, 'repartidores', 'no_configurado');
    await pedir();
    await esperar(3500);
    assert.strictEqual(ofertas(), 0, 'sin el módulo salió una oferta');
    await fijarModulo(NEG_A, 'repartidores', 'activo');
    await pedir();
    const limite = Date.now() + 8000;
    while (!ofertas() && Date.now() < limite) await esperar(200);
    assert.ok(ofertas() > 0, 'con el módulo tampoco salió oferta: el caso «sin módulo» no demostraría nada');
  });

  // ─── P — promociones vencidas ─────────────────────────────────────────────
  const sufijo = Date.now().toString(36);
  const crearPromo = async (nombre, { desde = null, hasta = null, dias = null } = {}) => {
    const { rows: [p] } = await pool.query(`INSERT INTO tienda_promociones (negocio_id, nombre, tipo, automatica, valor, canales,
        vigencia_desde, vigencia_hasta, dias_semana, activa, prioridad)
      VALUES ($1, $2, 'porcentaje', TRUE, 10, '["pos","whatsapp"]', $3, $4, $5, TRUE, 100) RETURNING id`,
      [NEG_A, nombre, desde, hasta, dias ? JSON.stringify(dias) : null]);
    promosCreadas.push(p.id);
    return p.id;
  };
  const ayer = new Date(Date.now() - 86400000).toISOString();
  const enUnMes = new Date(Date.now() + 30 * 86400000).toISOString();
  const haceUnMes = new Date(Date.now() - 30 * 86400000).toISOString();
  // La copia vieja y las bloqueadas se crean ANTES que la vigente (misma
  // prioridad): sin reordenar, la vigente quedaría al final de la lista.
  const VIEJA = await crearPromo(`Miércoles de Chilaquiles ${sufijo}`, { desde: haceUnMes, hasta: ayer });
  const SOLA = await crearPromo(`Jueves de Combitos ${sufijo}`, { desde: haceUnMes, hasta: ayer });
  const OTRO_DIA = await crearPromo(`Otro día ${sufijo}`, { dias: [((new Date().getUTCDay() + 3) % 7)] });
  const NUEVA = await crearPromo(`Miercoles de chilaquiles ${sufijo}`, { desde: ayer, hasta: enUnMes });
  folioP = `XAB-ACC${sufijo.slice(-5).toUpperCase()}`;
  await pool.query(`INSERT INTO pedidos_activos (folio, negocio_id, estado, datos) VALUES ($1, $2, 'nuevo', $3)`,
    [folioP, NEG_A, JSON.stringify({ canal: 'pos', modalidad: 'recoger en tienda', forma_pago: 'efectivo', total: 300,
      items: [{ producto_id: 1, nombre: 'Chilaquiles', cantidad: 2, precio_unitario: 150 }] })]);

  await t('P', '1. la copia vencida con versión vigente no se lista; la vigente sí', async () => {
    const { promociones } = await listarPromocionesParaPedido(NEG_A, folioP);
    const ids = promociones.map((p) => p.id);
    assert.ok(!ids.includes(VIEJA), 'la copia vencida seguía en la lista');
    assert.ok(ids.includes(NUEVA), 'faltaba la vigente');
  });
  await t('P', '2. una vencida SIN reemplazo sigue (un administrador puede aplicarla con motivo)', async () => {
    const { promociones } = await listarPromocionesParaPedido(NEG_A, folioP);
    const sola = promociones.find((p) => p.id === SOLA);
    assert.ok(sola, 'la vencida sin reemplazo desapareció');
    assert.strictEqual(sola.motivoHorario, 'Esta promoción ya venció');
  });
  await t('P', '3. primero lo que se puede aplicar, después lo que pide administrador', async () => {
    const { promociones } = await listarPromocionesParaPedido(NEG_A, folioP);
    const nuestras = promociones.filter((p) => [NUEVA, SOLA, OTRO_DIA].includes(p.id));
    assert.strictEqual(nuestras[0].id, NUEVA, `orden: ${nuestras.map((p) => p.nombre).join(' | ')}`);
    const rango = (p) => (p.motivo ? 2 : p.motivoHorario ? 1 : 0);
    const todos = promociones.map(rango);
    assert.deepStrictEqual(todos, [...todos].sort((a, b) => a - b), 'la lista no va ordenada por lo que aplica');
  });
  await t('P', '4. la lista de la tienda marca la vencida (y no la vigente)', async () => {
    const lista = await listarPromociones(NEG_A);
    const de = (id) => lista.find((p) => p.id === id);
    assert.strictEqual(de(VIEJA).vencida, true);
    assert.strictEqual(de(SOLA).vencida, true);
    assert.strictEqual(de(NUEVA).vencida, false);
    assert.strictEqual(de(OTRO_DIA).vencida, false, 'sin fecha final no vence');
  });
} finally {
  if (promosCreadas.length) await pool.query(`DELETE FROM tienda_promociones WHERE id = ANY($1)`, [promosCreadas]);
  if (folioP) await pool.query(`DELETE FROM pedidos_activos WHERE folio = $1`, [folioP]);
  await limpiar();
  await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = ANY($2)`, [NEG_A, CLAVES_OFERTA]);
  for (const c of cfgOfertaAntes) await actualizarConfiguracion({ [c.clave]: c.valor }, NEG_A);
  if (modAntes) await fijarModulo(NEG_A, 'repartidores', modAntes.estado);
  else await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id = $1 AND modulo = 'repartidores'`, [NEG_A]);
  await pool.query(`UPDATE negocios SET bot_whatsapp_activo = $2 WHERE id = $1`, [NEG_A, botAntes?.bot_whatsapp_activo ?? false]);
  await pool.query(`DELETE FROM integraciones_canal WHERE identificador = $1`, [PNID]);
  await srv.detener?.();
  metaMock.detener();
  anthropicMock.detener?.();
  await pool.end();
}

console.log(`\nfase-acuna-confusion-db: ${pasadas} OK, ${fallidas} fallos`);
if (fallos.length) { for (const f of fallos) console.log(' - ' + f); process.exitCode = 1; }
