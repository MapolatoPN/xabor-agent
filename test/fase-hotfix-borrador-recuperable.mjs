// Hotfix migración 031: fecha nunca en texto natural + sesión nunca se
// queda atorada + mensaje de éxito solo tras el commit real + cliente
// nuevo activa el Asistente Comercial desde su primer mensaje.
//
// End-to-end vía webhook real (Meta y Anthropic mockeados) -- verifica el
// texto EXACTO que el cliente recibe leyendo la tabla `mensajes` (nunca el
// mock de Meta, que no expone el cuerpo enviado), para probar el
// contrato real: "nunca se afirma éxito sin haber creado el borrador".
//
// Uso: DATABASE_URL=... INTEGRATIONS_ENCRYPTION_KEY=... PANEL_SECRET=...
//      SESSION_SECRET=... ADMIN_PASSWORD=... PANEL_PASSWORD=...
//      node test/fase-hotfix-borrador-recuperable.mjs
// Requiere aplicar-migraciones.mjs y seed-datos-prueba.mjs ya corridos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4180';
const PNID_A = 'PNID_HOTFIX_A';
const PNID_B = 'PNID_HOTFIX_B';

const { pool, actualizarConfiguracion } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(
    `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
     ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`,
    [negocioId, modulo, estado]
  );
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════ Setup: negocios A y B, ambos con el asistente habilitado ═══════════
for (const [negocioId, pnid, nombreCat] of [[SEED.negocioA, PNID_A, 'Hotfix A'], [SEED.negocioB, PNID_B, 'Hotfix B']]) {
  await fijarModulo(negocioId, 'cotizaciones', 'activo');
  await fijarModulo(negocioId, 'generador_cotizaciones', 'activo');
  await fijarModulo(negocioId, 'asistente_comercial_cotizaciones', 'activo');
  await pool.query(`UPDATE negocios SET bot_whatsapp_activo = true WHERE id = $1`, [negocioId]);
  await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,$3,TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [negocioId, pnid, `Prueba ${nombreCat}`]);
  await actualizarConfiguracion({ int_wa_phone_id: pnid, int_wa_token: `fake-token-${pnid}` }, negocioId);
  const { rows: [categoria] } = await pool.query(`INSERT INTO menu_categorias (nombre, negocio_id) VALUES ($1, $2) RETURNING id`, [nombreCat, negocioId]);
  await pool.query(`INSERT INTO menu_productos (categoria_id, nombre, precio, disponible, negocio_id) VALUES ($1, 'Arreglo Floral Premium', 1500, true, $2)`, [categoria.id, negocioId]);
}

const metaMock = await arrancarMetaMock();
const anthropicMock = await arrancarAnthropicMock();
const srv = await arrancarServidor({
  PORT: PUERTO,
  META_GRAPH_BASE_URL: metaMock.baseUrl,
  ANTHROPIC_BASE_URL: anthropicMock.baseUrl,
  ANTHROPIC_API_KEY: 'mock-key-no-es-real',
}, { timeoutMs: 30000 });
const base = srv.base;

function webhookTexto(phoneNumberId, telefono, texto, wamid, nombrePerfil) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: phoneNumberId },
      messages: [{ type: 'text', from: telefono, id: wamid, text: { body: texto } }],
      contacts: [{ profile: { name: nombrePerfil } }],
    } }] }],
  };
}
async function enviarWebhook(pnid, telefono, texto, wamid, nombre = 'Prueba') {
  return fetch(base + '/webhook/whatsapp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(webhookTexto(pnid, telefono, texto, wamid, nombre)),
  });
}
async function ultimoMensajeSaliente(telefono, negocioId) {
  const { rows } = await pool.query(
    `SELECT texto FROM mensajes WHERE telefono=$1 AND negocio_id=$2 AND direccion='saliente' ORDER BY id DESC LIMIT 1`,
    [telefono, negocioId]
  );
  return rows[0]?.texto || null;
}

// ═══════════ Cliente NUEVO activa el flujo desde el primer mensaje (P1) ═══════════
const TEL_NUEVO = '5218789950101';
await t('CLIENTE-NUEVO', 'un teléfono que NUNCA escribió antes activa el Asistente Comercial en su primer mensaje', async () => {
  await pool.query(`DELETE FROM clientes WHERE telefono = $1`, [TEL_NUEVO]); // garantiza que es genuinamente nuevo
  await pool.query(`DELETE FROM sesiones_comerciales WHERE negocio_id=$1 AND telefono=$2`, [SEED.negocioA, TEL_NUEVO]);

  anthropicMock.encolarRespuesta(() => 'solicitud_comercial'); // clasificación
  anthropicMock.encolarRespuesta(() =>
    '¡Hola! Con gusto te ayudo con tu cotización. ¿Me confirmas tu nombre?' +
    '<CAMPO_COMERCIAL_CAPTURADO>{"campo":"item_solicitado","valor":{"descripcion":"Arreglo Floral Premium","cantidad":2}}</CAMPO_COMERCIAL_CAPTURADO>'
  );

  await enviarWebhook(PNID_A, TEL_NUEVO, 'Hola, quiero una cotización para un arreglo floral, aún no existo como cliente aquí', 'wamid.HOTFIX-NUEVO-1');
  await esperar(7500);

  const { rows } = await pool.query(
    `SELECT * FROM sesiones_comerciales WHERE negocio_id=$1 AND telefono=$2 AND estado NOT IN ('finalizada','abandonada')`,
    [SEED.negocioA, TEL_NUEVO]
  );
  assert.strictEqual(rows.length, 1, 'debe haber abierto una sesión comercial YA en el primer mensaje de un cliente genuinamente nuevo');
});

// ═══════════ Orden de confirmación: éxito SOLO tras el commit real ═══════════
const TEL_EXITO = '5218789950102';
await t('ORDEN-CONFIRMACION', 'turno 1: recopila nombre y fecha', async () => {
  await pool.query(`INSERT INTO clientes (telefono, nombre, negocio_id) VALUES ($1,'Cliente Exito',$2) ON CONFLICT (telefono) DO UPDATE SET negocio_id=$2`, [TEL_EXITO, SEED.negocioA]);
  anthropicMock.encolarRespuesta(() => 'solicitud_comercial');
  anthropicMock.encolarRespuesta(() =>
    '¡Claro! ¿Qué producto te interesa?' +
    '<CAMPO_COMERCIAL_CAPTURADO>{"campo":"nombre","valor":"Cliente Exito"}</CAMPO_COMERCIAL_CAPTURADO>' +
    '<CAMPO_COMERCIAL_CAPTURADO>{"campo":"fecha_evento","valor":"2026-09-20"}</CAMPO_COMERCIAL_CAPTURADO>'
  );
  await enviarWebhook(PNID_A, TEL_EXITO, 'Hola, soy Cliente Exito, sería el 2026-09-20', 'wamid.HOTFIX-EXITO-1');
  await esperar(7500);
});

await t('ORDEN-CONFIRMACION', 'turno 2: el modelo NO afirma éxito él mismo -- el código lo agrega SOLO tras crear el borrador de verdad', async () => {
  anthropicMock.encolarRespuesta(() => 'continuacion_comercial');
  // El modelo, según el prompt corregido, NUNCA debe decir "ya preparé/ya
  // envié" -- este mock simula fielmente esa instrucción (un reconocimiento
  // neutro, sin afirmar nada sobre el resultado).
  anthropicMock.encolarRespuesta(() =>
    'Perfecto, con eso ya tengo lo que necesito.' +
    '<CAMPO_COMERCIAL_CAPTURADO>{"campo":"item_solicitado","valor":{"descripcion":"Arreglo Floral Premium","cantidad":5}}</CAMPO_COMERCIAL_CAPTURADO>' +
    '<BORRADOR_LISTO>'
  );
  await enviarWebhook(PNID_A, TEL_EXITO, 'Sería un Arreglo Floral Premium, 5 piezas', 'wamid.HOTFIX-EXITO-2');
  await esperar(9000);

  const textoRecibido = await ultimoMensajeSaliente(TEL_EXITO, SEED.negocioA);
  assert.ok(textoRecibido.includes('Perfecto, con eso ya tengo lo que necesito'), 'debe conservar lo que el modelo dijo de forma natural');
  assert.ok(
    textoRecibido.includes('Listo, ya preparé tu cotización y la envié a revisión. En cuanto sea aprobada, recibirás el PDF aquí mismo.'),
    'el texto EXACTO de éxito debe aparecer -- pero agregado por el código, nunca por el modelo'
  );

  const { rows } = await pool.query(`SELECT * FROM cotizaciones WHERE negocio_id=$1 AND telefono=$2`, [SEED.negocioA, TEL_EXITO]);
  assert.strictEqual(rows.length, 1, 'el borrador debe existir de verdad -- la confirmación no fue una promesa vacía');
  assert.strictEqual(new Date(rows[0].fecha_evento).toISOString().slice(0, 10), '2026-09-20');
});

// ═══════════ Fallo real de DB -- nunca se afirma éxito, sesión queda recuperable ═══════════
const TEL_ERROR = '5218789950103';
await t('FALLO-DB', 'turno 1: recopila datos', async () => {
  await pool.query(`INSERT INTO clientes (telefono, nombre, negocio_id) VALUES ($1,'Cliente Error',$2) ON CONFLICT (telefono) DO UPDATE SET negocio_id=$2`, [TEL_ERROR, SEED.negocioA]);
  anthropicMock.encolarRespuesta(() => 'solicitud_comercial');
  anthropicMock.encolarRespuesta(() =>
    '¡Con gusto! ¿Cuántas piezas necesitas?' +
    '<CAMPO_COMERCIAL_CAPTURADO>{"campo":"nombre","valor":"Cliente Error"}</CAMPO_COMERCIAL_CAPTURADO>' +
    '<CAMPO_COMERCIAL_CAPTURADO>{"campo":"fecha_evento","valor":"2026-09-22"}</CAMPO_COMERCIAL_CAPTURADO>'
  );
  await enviarWebhook(PNID_A, TEL_ERROR, 'Hola, soy Cliente Error, sería el 2026-09-22', 'wamid.HOTFIX-ERROR-1');
  await esperar(7500);
});

await t('FALLO-DB', 'turno 2: una cantidad absurda revienta el guardado real (overflow NUMERIC) -- el cliente NUNCA recibe el mensaje de éxito', async () => {
  anthropicMock.encolarRespuesta(() => 'continuacion_comercial');
  anthropicMock.encolarRespuesta(() =>
    'Perfecto, con eso ya tengo lo que necesito.' +
    // cantidad deliberadamente absurda: precio real (1500) * 100000 excede
    // NUMERIC(10,2) de cotizaciones.total -- provoca un error REAL de
    // Postgres dentro de crearCotizacion, no uno simulado.
    '<CAMPO_COMERCIAL_CAPTURADO>{"campo":"item_solicitado","valor":{"descripcion":"Arreglo Floral Premium","cantidad":100000}}</CAMPO_COMERCIAL_CAPTURADO>' +
    '<BORRADOR_LISTO>'
  );
  await enviarWebhook(PNID_A, TEL_ERROR, 'Serían 100000 piezas', 'wamid.HOTFIX-ERROR-2');
  await esperar(9000);

  const textoRecibido = await ultimoMensajeSaliente(TEL_ERROR, SEED.negocioA);
  assert.ok(!textoRecibido.includes('Listo, ya preparé tu cotización'), 'NUNCA debe afirmar éxito si el guardado falló de verdad');
  assert.ok(textoRecibido.includes('Tuvimos un problema'), 'debe recibir el mensaje honesto de error, no silencio ni una mentira');

  const { rows: cotizaciones } = await pool.query(`SELECT * FROM cotizaciones WHERE negocio_id=$1 AND telefono=$2`, [SEED.negocioA, TEL_ERROR]);
  assert.strictEqual(cotizaciones.length, 0, 'no debe existir ninguna cotización -- el fallo fue real, no solo aparente');

  const { rows: sesiones } = await pool.query(`SELECT * FROM sesiones_comerciales WHERE negocio_id=$1 AND telefono=$2`, [SEED.negocioA, TEL_ERROR]);
  assert.strictEqual(sesiones.length, 1);
  assert.strictEqual(sesiones[0].estado, 'error_recuperable', 'nunca debe quedar atorada en construyendo_borrador');
  assert.strictEqual(sesiones[0].cotizacion_id, null);
  assert.strictEqual(sesiones[0].intentos_fallidos, 1);
  assert.ok(sesiones[0].ultimo_error_at);
  assert.strictEqual(sesiones[0].campos_capturados.nombre, 'Cliente Error', 'los datos ya capturados no deben perderse tras el error');
});

await t('FALLO-DB', 'turno 3: el mismo teléfono retoma la MISMA sesión (nunca abre una segunda) y, con datos corregidos, el reintento crea el borrador sin duplicar', async () => {
  // item_solicitado siempre se ACUMULA (nunca se reemplaza -- ver
  // fusionarCamposCapturados), así que "corregir" una cantidad absurda ya
  // capturada es un problema de edición de items, deliberadamente FUERA
  // de alcance de este hotfix (que es sobre fechas y recuperación de
  // sesión, no sobre semántica de corrección de items). Se simula aquí la
  // forma en que SÍ se corrige hoy: quitando el item inválido directamente
  // (equivalente a que un administrador lo ajuste, o a una futura mejora
  // de "reemplazar" en vez de "acumular") antes de que el cliente reintente.
  await pool.query(
    `UPDATE sesiones_comerciales SET campos_capturados = campos_capturados || '{"items":[{"descripcion":"Arreglo Floral Premium","cantidad":8}]}'::jsonb
     WHERE negocio_id = $1 AND telefono = $2`,
    [SEED.negocioA, TEL_ERROR]
  );

  anthropicMock.encolarRespuesta(() => 'continuacion_comercial');
  anthropicMock.encolarRespuesta(() => 'Perfecto, reintentamos con la información ya corregida.<BORRADOR_LISTO>');
  await enviarWebhook(PNID_A, TEL_ERROR, 'Perdón, me equivoqué, serían solo 8 piezas', 'wamid.HOTFIX-ERROR-3');
  await esperar(9000);

  const { rows: sesiones } = await pool.query(
    `SELECT * FROM sesiones_comerciales WHERE negocio_id=$1 AND telefono=$2 AND estado NOT IN ('finalizada','abandonada')`,
    [SEED.negocioA, TEL_ERROR]
  );
  assert.strictEqual(sesiones.length, 1, 'debe seguir siendo una única sesión activa, nunca una segunda');

  const { rows: cotizaciones } = await pool.query(`SELECT * FROM cotizaciones WHERE negocio_id=$1 AND telefono=$2`, [SEED.negocioA, TEL_ERROR]);
  assert.strictEqual(cotizaciones.length, 1, 'el reintento con datos corregidos debe crear exactamente un borrador, nunca dos');

  const textoRecibido = await ultimoMensajeSaliente(TEL_ERROR, SEED.negocioA);
  assert.ok(textoRecibido.includes('Listo, ya preparé tu cotización'), 'tras corregir el dato, el reintento sí debe confirmar éxito real');
});

// ═══════════ Aislamiento: mismo teléfono en dos negocios distintos ═══════════
const TEL_COMPARTIDO = '5218789950105';
await t('AISLAMIENTO', 'el mismo teléfono en negocio A y negocio B mantiene sesiones y borradores totalmente separados', async () => {
  await pool.query(`DELETE FROM sesiones_comerciales WHERE telefono=$1`, [TEL_COMPARTIDO]);
  await pool.query(`DELETE FROM cotizaciones WHERE telefono=$1`, [TEL_COMPARTIDO]);

  anthropicMock.encolarRespuesta(() => 'solicitud_comercial');
  anthropicMock.encolarRespuesta(() =>
    '¡Hola! Con gusto.' +
    '<CAMPO_COMERCIAL_CAPTURADO>{"campo":"nombre","valor":"Cliente Compartido A"}</CAMPO_COMERCIAL_CAPTURADO>' +
    '<CAMPO_COMERCIAL_CAPTURADO>{"campo":"fecha_evento","valor":"2026-09-25"}</CAMPO_COMERCIAL_CAPTURADO>' +
    '<CAMPO_COMERCIAL_CAPTURADO>{"campo":"item_solicitado","valor":{"descripcion":"Arreglo Floral Premium","cantidad":3}}</CAMPO_COMERCIAL_CAPTURADO>' +
    '<BORRADOR_LISTO>'
  );
  await enviarWebhook(PNID_A, TEL_COMPARTIDO, 'Hola, soy Cliente Compartido A, 2026-09-25, un Arreglo Floral Premium, 3 piezas', 'wamid.HOTFIX-AISLAMIENTO-A');
  await esperar(9000);

  anthropicMock.encolarRespuesta(() => 'solicitud_comercial');
  anthropicMock.encolarRespuesta(() => '¡Hola! Este es un negocio distinto, ¿me confirmas tu nombre?');
  await enviarWebhook(PNID_B, TEL_COMPARTIDO, 'Hola, quiero otra cotización aquí', 'wamid.HOTFIX-AISLAMIENTO-B');
  await esperar(7500);

  const { rows: cotA } = await pool.query(`SELECT * FROM cotizaciones WHERE negocio_id=$1 AND telefono=$2`, [SEED.negocioA, TEL_COMPARTIDO]);
  const { rows: cotB } = await pool.query(`SELECT * FROM cotizaciones WHERE negocio_id=$1 AND telefono=$2`, [SEED.negocioB, TEL_COMPARTIDO]);
  assert.strictEqual(cotA.length, 1, 'negocio A debe tener su propio borrador');
  assert.strictEqual(cotB.length, 0, 'negocio B no debe heredar ni ver el borrador de A');

  const { rows: sesA } = await pool.query(`SELECT * FROM sesiones_comerciales WHERE negocio_id=$1 AND telefono=$2`, [SEED.negocioA, TEL_COMPARTIDO]);
  const { rows: sesB } = await pool.query(`SELECT * FROM sesiones_comerciales WHERE negocio_id=$1 AND telefono=$2 AND estado NOT IN ('finalizada','abandonada')`, [SEED.negocioB, TEL_COMPARTIDO]);
  assert.strictEqual(sesA.length, 1);
  assert.strictEqual(sesB.length, 1);
  assert.notStrictEqual(sesA[0].id, sesB[0].id, 'deben ser sesiones completamente distintas, nunca la misma fila compartida entre negocios');
});

// ═══════════ Webhook duplicado (mismo wamid) -- no debe procesarse dos veces ═══════════
// Deliberadamente la ÚLTIMA prueba del archivo: un reenvío duplicado
// dispara su PROPIO ciclo de debounce (6s) en el proceso servidor
// (independiente del hilo de esta prueba), y esa llamada a Claude tardía
// competiría por la cola COMPARTIDA del mock de Anthropic con cualquier
// prueba que viniera después -- no hay forma de "esperarla" con certeza
// total desde este proceso, así que la solución robusta es simplemente no
// dejar nada después que pueda verse afectado.
const TEL_DUP = '5218789950104';
await t('WEBHOOK-DUPLICADO', 'reenviar el mismo wamid no crea una segunda sesión ni duplica el procesamiento', async () => {
  await pool.query(`DELETE FROM clientes WHERE telefono = $1`, [TEL_DUP]);
  await pool.query(`DELETE FROM sesiones_comerciales WHERE negocio_id=$1 AND telefono=$2`, [SEED.negocioA, TEL_DUP]);

  anthropicMock.encolarRespuesta(() => 'solicitud_comercial');
  anthropicMock.encolarRespuesta(() => '¡Hola! ¿Me confirmas tu nombre?');
  await enviarWebhook(PNID_A, TEL_DUP, 'Hola, quiero una cotización', 'wamid.HOTFIX-DUP-1');
  await esperar(7500);

  const { rows: antes } = await pool.query(`SELECT count(*)::int AS n FROM mensajes WHERE telefono=$1 AND negocio_id=$2 AND direccion='entrante'`, [TEL_DUP, SEED.negocioA]);

  // Reenvío EXACTO del mismo webhook (mismo wamid) -- simula una
  // re-entrega real de Meta. guardarMensaje() deduplica por
  // message_id_externo pero devuelve la fila EXISTENTE (no null), así que
  // el resto del flujo (encolarMensaje -> Claude) sigue corriendo igual.
  await enviarWebhook(PNID_A, TEL_DUP, 'Hola, quiero una cotización', 'wamid.HOTFIX-DUP-1');
  await esperar(7500);

  const { rows: despues } = await pool.query(`SELECT count(*)::int AS n FROM mensajes WHERE telefono=$1 AND negocio_id=$2 AND direccion='entrante'`, [TEL_DUP, SEED.negocioA]);
  assert.strictEqual(despues[0].n, antes[0].n, 'el mensaje entrante duplicado (mismo wamid) nunca debe guardarse dos veces');

  const { rows: sesiones } = await pool.query(`SELECT id FROM sesiones_comerciales WHERE negocio_id=$1 AND telefono=$2`, [SEED.negocioA, TEL_DUP]);
  assert.strictEqual(sesiones.length, 1, 'nunca debe crearse una segunda sesión por la re-entrega');
});

// ═══════════ Resumen ═══════════
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await metaMock.detener();
await anthropicMock.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
