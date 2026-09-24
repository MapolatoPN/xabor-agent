// La ruta ÚNICA de facturación por WhatsApp: manejarFacturacionWhatsapp.
//
// Contexto: existía una segunda rama, legacy, que dependía de que el MODELO
// decidiera incluir un marcador `<FACTURA>` en su respuesta (después de
// recolectar RFC/razón social/etc. EN EL CHAT). Esa rama llamaba a
// `generarFactura`, que ya no existe en facturapi.js -- por eso `npm start`
// llegó a fallar al importar el módulo. Se eliminó por completo, sin
// reemplazo: la única vía autorizada para facturar por WhatsApp es
// manejarFacturacionWhatsapp, que intercepta por reglas ANTES de llamar al
// modelo y nunca recolecta datos fiscales en el chat.
//
// Esta suite demuestra, de punta a punta (webhook real → servidor real →
// WhatsApp de Meta simulado), que una solicitud de factura reconocida:
//   1. Se contesta con el enlace de autofactura (el mismo recibo ya creado
//      por asegurarReciboPedido, con su URL determinista de prueba).
//   2. NUNCA llega al modelo -- se prueba con la cola del mock de Anthropic:
//      si algo hubiera caído al bot legado, se habría consumido una de las
//      respuestas encoladas. Con la ruta nueva, la cola queda intacta.
//
// Uso: mismas env vars que la batería. Requiere aplicar-migraciones.mjs y
// seed-datos-prueba.mjs ya corridos sobre el mismo DATABASE_URL.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4197';
const NEG = SEED.negocioA;

const { pool, actualizarConfiguracion } = await import('../src/services/database.js');
const { guardarCredencialesFacturapi } = await import('../src/services/integracionesService.js');
const { guardarConfiguracionFacturacion } = await import('../src/services/facturacionService.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
// 16000ms, igual que el E2E de continuidad (fase-continuidad-webhook.mjs):
// el mismo procesamiento asíncrono de webhook que ese archivo cubre.
async function esperarHasta(fn, { timeoutMs = 16000, intervaloMs = 300 } = {}) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const r = await fn();
    if (r) return r;
    await esperar(intervaloMs);
  }
  return null;
}

// ═══════════ Setup — fixture aislado por corrida ═══════════
// PROBLEMA QUE ESTO CORRIGE: con TEL/PNID fijos, whatsappContinuidad deja
// estado durable en whatsapp_conversaciones/whatsapp_entradas (igual que
// documenta fase-continuidad-webhook.mjs). Una corrida fallida podía dejar
// requiere_revision=true con motivo EJECUCION_NO_VERIFICADA, y las corridas
// siguientes reusaban ese mismo teléfono ya marcado en revisión -- sin volver
// a procesarse jamás. La solución no es "limpiar antes de empezar": es que
// cada corrida tenga su PROPIO teléfono/PNID/folio, para que no haya nada de
// una corrida anterior con lo que chocar.
const PNID = 'fact-ruta-unica-' + randomUUID();
const TEL = '5218' + Date.now().toString().slice(-6) + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
const FOLIO = 'XAB-' + String(Math.floor(Math.random() * 90000000) + 10000000);
const URL_AUTOFACTURA_FIJA = 'https://facturapi.example/self/RUTA-UNICA';

// ═══ Estado EXACTO de negocioA antes de tocarlo ═══
// negocioA lo comparten muchas suites. Todo lo que este fixture sobrescribe
// se captura tal cual está y en finally vuelve tal cual: sin defaults
// inventados. Lo que no existía, se borra; lo que existía, se reescribe con
// sus valores capturados.
const filaUnica = async (sql, params) => (await pool.query(sql, params)).rows[0] || null;
const previo = {
  botWhatsapp: (await filaUnica('SELECT bot_whatsapp_activo FROM negocios WHERE id=$1', [NEG])).bot_whatsapp_activo,
  modulos: Object.fromEntries((await pool.query(
    `SELECT modulo, estado FROM negocio_modulos WHERE negocio_id=$1 AND modulo IN ('whatsapp','facturacion')`, [NEG]))
    .rows.map((r) => [r.modulo, r.estado])),
  configWA: Object.fromEntries((await pool.query(
    `SELECT clave, valor FROM configuracion WHERE negocio_id=$1 AND clave IN ('int_wa_phone_id','int_wa_token')`, [NEG]))
    .rows.map((r) => [r.clave, r.valor])),
  facturacionCfg: await filaUnica('SELECT * FROM facturacion_configuracion WHERE negocio_id=$1', [NEG]),
  facturapiIntegracion: await filaUnica(
    `SELECT * FROM integraciones_canal WHERE negocio_id=$1 AND canal='facturacion' AND proveedor='facturapi'`, [NEG]),
};
previo.facturapiCredenciales = previo.facturapiIntegracion
  ? await filaUnica('SELECT * FROM integraciones_canal_credenciales WHERE integracion_id=$1', [previo.facturapiIntegracion.id])
  : null;

// Reescribe TODAS las columnas de una fila con lo capturado (menos las del
// WHERE). Los jsonb se serializan explícitamente: node-postgres convierte un
// arreglo JS en arreglo de Postgres, no en JSON, y eso rompería la columna.
async function restaurarFila(tabla, fila, whereCols) {
  const cols = Object.keys(fila).filter((c) => !whereCols.includes(c));
  const valor = (v) => (v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v) ? JSON.stringify(v) : v);
  const set = cols.map((c, i) => `${c}=$${i + 1}`).join(', ');
  const where = whereCols.map((c, i) => `${c}=$${cols.length + i + 1}`).join(' AND ');
  await pool.query(`UPDATE ${tabla} SET ${set} WHERE ${where}`,
    [...cols.map((c) => valor(fila[c])), ...whereCols.map((c) => fila[c])]);
}

async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}
await fijarModulo(NEG, 'whatsapp', 'activo');
await fijarModulo(NEG, 'facturacion', 'activo');
await actualizarConfiguracion({ int_wa_phone_id: PNID, int_wa_token: 'fake-token-fact-ruta-unica' }, NEG);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,'Fact ruta unica',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [NEG, PNID]);
await pool.query(`UPDATE negocios SET bot_whatsapp_activo = TRUE WHERE id = $1`, [NEG]);

// Cuenta de Facturapi + IVA: ambos exigidos por asegurarReciboPedido antes de
// crear cualquier recibo (sin esto, manejarFacturacionWhatsapp escalaría en
// vez de responder con un enlace, y la suite no probaría lo que quiere probar).
await guardarCredencialesFacturapi(NEG, 'sk_test_nunca_se_debe_usar_de_verdad_ruta_unica', SEED.superadminUsuarioId);
await guardarConfiguracionFacturacion(NEG, { ivaTasa: 0.16, autoemitirRecibo: true });

// Pedido ya pagado y entregado -- lo único que hace falta para que el folio
// sea facturable.
await pool.query(
  `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, entregado_at)
   VALUES ($1,$2,'entregado',$3::jsonb, NOW())
   ON CONFLICT (folio) DO UPDATE SET negocio_id=$1, estado='entregado', datos=$3::jsonb, entregado_at=NOW()`,
  [NEG, FOLIO, JSON.stringify({
    total: 150, forma_pago: 'efectivo', pago_confirmado: true, telefono_conversacion: TEL,
  })]);

// El recibo YA existe y está abierto, con una URL fija que solo
// manejarFacturacionWhatsapp puede haber devuelto (el modelo no la conoce ni
// podría inventarla igual).
await pool.query(
  `INSERT INTO facturacion_recibos
     (negocio_id, folio, total, idempotency_key, recibo_id, clave, url_autofactura, estado)
   VALUES ($1,$2,$3,$4,$5,$6,$7,'abierto')
   ON CONFLICT (negocio_id, folio) DO UPDATE SET
     recibo_id=EXCLUDED.recibo_id, clave=EXCLUDED.clave,
     url_autofactura=EXCLUDED.url_autofactura, estado='abierto', updated_at=NOW()`,
  [NEG, FOLIO, 150, `xabor:${NEG}:${FOLIO}`, `rec_ruta_unica`, `clave-ruta-unica`, URL_AUTOFACTURA_FIJA]);

const metaMock = await arrancarMetaMock();
const anthropicMock = await arrancarAnthropicMock();
// Si la ruta legacy (ya eliminada) o cualquier otra cosa hiciera caer el
// mensaje al modelo, consumiría UNA de estas respuestas -- y el mensaje que
// le llegaría al cliente sería este texto libre, no el enlace de autofactura.
for (let i = 0; i < 5; i++) anthropicMock.encolarRespuesta('Con gusto, dame un momento para ayudarte con eso.');

const srv = await arrancarServidor({
  PORT: PUERTO,
  META_GRAPH_BASE_URL: metaMock.baseUrl,
  ANTHROPIC_BASE_URL: anthropicMock.baseUrl,
  ANTHROPIC_API_KEY: 'sk-ant-test-mock',
}, { timeoutMs: 30000 });
const base = srv.base;

let wamidSeq = 0;
async function mensajeEntrante(telefono, texto) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: PNID },
      messages: [{ type: 'text', from: telefono, id: `wamid.FACTRUTA-${Date.now()}-${wamidSeq++}`, text: { body: texto } }],
      contacts: [{ profile: { name: 'Cliente Ruta Unica' } }],
    } }] }],
  };
  const r = await fetch(base + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return r.status;
}
function salientesA(telefono, desde = 0) {
  return metaMock.obtenerMensajesEnviados().slice(desde)
    .filter((m) => m.text?.body && String(m.to) === telefono)
    .map((m) => m.text.body);
}
async function respuestaDelBot(telefono, desde) {
  const r = await esperarHasta(() => {
    const msgs = salientesA(telefono, desde);
    return msgs.length ? msgs : null;
  });
  return r || [];
}

// Al fallar, imprime toda línea del servidor que toque las tres capas
// involucradas (continuidad, gate de facturación, envío a Meta) para que el
// PRÓXIMO fallo revele la excepción real sin diagnóstico manual adicional.
function volcarDiagnostico() {
  const lineas = (srv.obtenerSalida?.() || '').split('\n')
    .filter((l) => /wa-continuidad|Facturacion WA|Meta WA/i.test(l));
  console.log('--- LÍNEAS DEL SERVIDOR (wa-continuidad / Facturacion WA / Meta WA) ---\n'
    + (lineas.length ? lineas.join('\n') : '(ninguna línea del servidor coincidió con esos marcadores)'));
}

try {

await t('una solicitud de factura reconocida se contesta con el enlace de autofactura y jamás toca el modelo', async () => {
  try {
    const pendientesAntes = anthropicMock.pendientes();
    const antes = metaMock.obtenerMensajesEnviados().length;

    const status = await mensajeEntrante(TEL, `factura ${FOLIO}`);
    assert.strictEqual(status, 200, 'el webhook debe responder 200');

    const respuestas = await respuestaDelBot(TEL, antes);
    assert.ok(respuestas.length, 'el cliente debía recibir una respuesta');

    // LA PRUEBA CENTRAL: la respuesta es la de manejarFacturacionWhatsapp (la
    // URL fija del recibo que YA existía), no una respuesta libre del modelo.
    const conEnlace = respuestas.filter((m) => m.includes(URL_AUTOFACTURA_FIJA));
    assert.strictEqual(conEnlace.length, 1, `debía responder exactamente una vez con el enlace de autofactura; respondió: ${JSON.stringify(respuestas)}`);
    assert.ok(conEnlace[0].includes('captura tus datos fiscales aquí'),
      'el mensaje debe ser el de manejarFacturacionWhatsapp, no uno inventado');

    // Ninguna respuesta coincide con lo que hubiera contestado el modelo.
    assert.ok(!respuestas.some((m) => m.includes('Con gusto, dame un momento')),
      'el mensaje del modelo simulado no debía usarse -- la ruta legacy ya no existe');

    // LA GARANTÍA ESTRUCTURAL: la cola del "modelo" sigue intacta. Si el
    // mensaje hubiera caído al bot/modelo legado (la rama `resultado.factura`
    // que se eliminó, o cualquier otro camino), se habría consumido una
    // respuesta encolada.
    assert.strictEqual(anthropicMock.pendientes(), pendientesAntes,
      'el mensaje llegó al modelo -- la ruta legacy sigue viva en alguna forma');

    // El recibo sigue abierto: reconocer y responder no factura nada.
    const { rows: [recibo] } = await pool.query(
      'SELECT estado FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2', [NEG, FOLIO]);
    assert.strictEqual(recibo.estado, 'abierto');
  } catch (e) {
    volcarDiagnostico();
    throw e;
  }
});

} finally {
  srv.detener();
  metaMock.detener();
  anthropicMock.detener();
  // Limpieza de TODO lo creado por ESTA corrida -- identificado por el
  // TEL/PNID/FOLIO únicos generados arriba, nunca por un residuo ajeno.
  await pool.query('DELETE FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2', [NEG, FOLIO]);
  await pool.query('DELETE FROM facturacion_whatsapp_estado WHERE negocio_id=$1 AND telefono=$2', [NEG, TEL]);
  await pool.query('DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2', [NEG, FOLIO]);
  await pool.query('DELETE FROM integraciones_canal WHERE negocio_id=$1 AND identificador=$2', [NEG, PNID]);
  await pool.query('DELETE FROM whatsapp_entradas WHERE negocio_id=$1 AND telefono=$2', [NEG, TEL]);
  await pool.query('DELETE FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2', [NEG, TEL]);
  await pool.query('DELETE FROM conversaciones_control WHERE negocio_id=$1 AND telefono=$2', [NEG, TEL]);
  await pool.query('DELETE FROM mensajes WHERE negocio_id=$1 AND telefono=$2', [NEG, TEL]);
  // Cliente sintético: clientes.telefono es PK GLOBAL, pero TEL se generó
  // único para esta corrida, así que identificarlo por TEL+negocio (sin
  // negocio_id no se borra -- sería tocar una fila que pudiera pertenecer a
  // otro negocio) es seguro.
  await pool.query('DELETE FROM clientes WHERE telefono=$1 AND negocio_id=$2', [TEL, NEG]);

  // ═══ negocioA vuelve EXACTAMENTE a como estaba ═══
  // Facturapi: la integración y su credencial cifrada.
  if (previo.facturapiIntegracion) {
    if (previo.facturapiCredenciales) {
      await restaurarFila('integraciones_canal_credenciales', previo.facturapiCredenciales, ['integracion_id']);
    } else {
      await pool.query('DELETE FROM integraciones_canal_credenciales WHERE integracion_id=$1', [previo.facturapiIntegracion.id]);
    }
    await restaurarFila('integraciones_canal', previo.facturapiIntegracion, ['id']);
  } else {
    // No existía: se va la integración creada por esta corrida (la credencial
    // cae en cascada, y se borra explícita por si acaso).
    await pool.query(
      `DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN
         (SELECT id FROM integraciones_canal WHERE negocio_id=$1 AND canal='facturacion' AND proveedor='facturapi')`, [NEG]);
    await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal='facturacion' AND proveedor='facturapi'`, [NEG]);
  }
  // Configuración de facturación (IVA, serie, autoemitir).
  if (previo.facturacionCfg) await restaurarFila('facturacion_configuracion', previo.facturacionCfg, ['negocio_id']);
  else await pool.query('DELETE FROM facturacion_configuracion WHERE negocio_id=$1', [NEG]);
  // Configuración de WhatsApp: clave por clave, la que no existía se borra.
  for (const clave of ['int_wa_phone_id', 'int_wa_token']) {
    if (clave in previo.configWA) {
      await pool.query('UPDATE configuracion SET valor=$3 WHERE negocio_id=$1 AND clave=$2', [NEG, clave, previo.configWA[clave]]);
    } else {
      await pool.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2', [NEG, clave]);
    }
  }
  // Módulos: el estado previo, o ninguna fila si no la había.
  for (const modulo of ['whatsapp', 'facturacion']) {
    if (modulo in previo.modulos) {
      await pool.query('UPDATE negocio_modulos SET estado=$3 WHERE negocio_id=$1 AND modulo=$2', [NEG, modulo, previo.modulos[modulo]]);
    } else {
      await pool.query('DELETE FROM negocio_modulos WHERE negocio_id=$1 AND modulo=$2', [NEG, modulo]);
    }
  }
  await pool.query('UPDATE negocios SET bot_whatsapp_activo=$2 WHERE id=$1', [NEG, previo.botWhatsapp]);
  await pool.end().catch(() => {});
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`PASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
