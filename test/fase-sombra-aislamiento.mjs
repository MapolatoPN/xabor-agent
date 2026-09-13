// SOMBRA: OBSERVAR SIN TOCAR.
//
// La afirmación bajo prueba, palabra por palabra:
//
//   Con PEDIDO_SHADOW_MODE=true se puede recibir tráfico real de WhatsApp y
//   ejecutar el nuevo reconciliador, y el experimento no produce ningún cambio
//   ni comunicación observable para el cliente, ni ningún efecto operativo.
//
// No basta con que pasen las pruebas del carrito: esta suite entra por el
// WEBHOOK real, contra un servidor de verdad levantado con la bandera puesta, y
// mira lo que se puede mirar desde fuera —mensajes salientes, pedidos,
// impresión, cobros— además del log.
//
// La primera versión de la bandera NO habría pasado esto: apagaba el carrito
// pero dejaba al bot contestando, registrando e imprimiendo. La observación
// vive ahora donde el sistema ya está callado.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_SOMBRA || '4311';
const NEG = SEED.negocioA;
const PNID = 'PNID_SOMBRA_A';
const TEL_BASE = '5218800919';

const { pool, actualizarConfiguracion } = await import('../src/services/database.js');
const sombra = await import('../src/orders/registroSombra.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Preparación ────────────────────────────────────────────────────────────
await pool.query(`DELETE FROM mensajes WHERE telefono LIKE $1`, [TEL_BASE + '%']);
await pool.query(`DELETE FROM clientes WHERE telefono LIKE $1`, [TEL_BASE + '%']);
// Higiene obligatoria: una corrida anterior --o una prueba de mordida-- pudo
// dejar estas conversaciones señaladas para revisión, y S6b comprueba justo
// eso. Sin limpiarlas, la prueba heredaría el resultado de la corrida pasada.
// El ORDEN importa y el error NO se traga: `whatsapp_entradas` tiene una clave
// foránea contra `whatsapp_conversaciones`, así que borrar primero la
// conversación falla. Con el fallo silenciado, una fila vieja con
// requiere_revision=true sobrevivía y bloqueaba el turno de S6b, que entonces
// medía el resultado de la corrida anterior en vez del suyo.
await pool.query(`DELETE FROM whatsapp_entradas WHERE telefono LIKE $1`, [TEL_BASE + '%']);
await pool.query(`DELETE FROM whatsapp_conversaciones WHERE telefono LIKE $1`, [TEL_BASE + '%']);
await pool.query(`DELETE FROM conversacion_estado WHERE session_id LIKE $1`, ['%' + TEL_BASE + '%']).catch(() => {});
await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono' LIKE $2`,
  [NEG, TEL_BASE + '%']).catch(() => {});
await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1 AND nombre LIKE 'SOMBRA %'`, [NEG]);
await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre LIKE 'SOMBRA %'`, [NEG]);
await pool.query(`DELETE FROM integraciones_canal WHERE canal='whatsapp' AND identificador=$1`, [PNID]);

const { rows: [cat] } = await pool.query(
  `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'SOMBRA Carta',TRUE,999) RETURNING id`, [NEG]);
await pool.query(
  `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
   VALUES ($1,$2,'SOMBRA Torta',95,TRUE,0)`, [NEG, cat.id]);

await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'whatsapp','activo')
  ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [NEG]);
await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'asistente_comercial_cotizaciones','no_configurado')
  ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='no_configurado'`, [NEG]);
await actualizarConfiguracion({ int_wa_phone_id: PNID, int_wa_token: 'fake-token-sombra', modo_pedidos: 'transaccional' }, NEG);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo)
  VALUES ($1,'whatsapp',$2,'Sombra',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [NEG, PNID]);
// La sombra necesita DOS llaves: la global del proceso (PEDIDO_SHADOW_MODE, que
// se le pasa al servidor) y la de ESTE negocio. Sin la segunda no se observa a
// nadie, que es la corrección del incidente multiempresa.
await actualizarConfiguracion({ pedido_shadow: 'true', pedido_reconciliador_v2: 'false' }, NEG);

// EL BOT ESTÁ APAGADO. Es el estado en el que se hace el experimento.
//
// Se anota cómo estaba para devolverlo al terminar: este negocio es del seed y
// lo comparten otras suites. Dejarlo apagado hace fallar a la siguiente que dé
// por hecho que responde, y ese fallo no se parece en nada a su causa.
const { rows: [estadoBot] } = await pool.query('SELECT bot_whatsapp_activo FROM negocios WHERE id = $1', [NEG]);
const BOT_ANTES = estadoBot?.bot_whatsapp_activo !== false;
await pool.query(`UPDATE negocios SET bot_whatsapp_activo = FALSE WHERE id = $1`, [NEG]);

const metaMock = await arrancarMetaMock();
const anthropicMock = await arrancarAnthropicMock();
const srv = await arrancarServidor({
  PORT: PUERTO,
  META_GRAPH_BASE_URL: metaMock.baseUrl,
  ANTHROPIC_BASE_URL: anthropicMock.baseUrl,
  ANTHROPIC_API_KEY: 'sk-ant-test-sombra',
  PEDIDO_SHADOW_MODE: 'true',
}, { timeoutMs: 30000 });

let wamidSeq = 0;
async function mensajeEntrante(telefono, texto) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: PNID },
      messages: [{ type: 'text', from: telefono, id: `wamid.SOMBRA-${Date.now()}-${wamidSeq++}`, text: { body: texto } }],
      contacts: [{ profile: { name: 'Cliente Sombra' } }],
    } }] }],
  };
  await fetch(srv.base + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}
// El canal agrupa los turnos en una cola de 6 s antes de procesarlos.
const esperarTurno = () => esperar(9000);

// COMUNICACIÓN vs ACUSE.
//
// Al canal le salen dos cosas distintas hacia Meta: mensajes con contenido
// —texto, imagen, botones— y acuses de lectura (`status: 'read'`, la doble
// palomita azul). El acuse se manda al RECIBIR el mensaje, muchas líneas antes
// de que se decida si el bot contesta, y ya salía así con el bot apagado antes
// de que existiera la sombra (el diff del canal en esta rama solo añade).
//
// Es un efecto observable por el cliente y hay que decirlo, pero no es del
// experimento. Lo que la sombra tiene prohibido es COMUNICAR: aquí se separan
// para que la prueba mida lo que dice medir.
const esAcuseDeLectura = (m) => m?.status === 'read';
const comunicaciones = () => metaMock.obtenerMensajesEnviados().filter((m) => !esAcuseDeLectura(m));
const salientes = (tel) => metaMock.obtenerMensajesEnviados().filter((m) => String(m.to) === tel);
const lineasSombra = () => srv.obtenerSalida().split('\n').filter((l) => l.includes('evento=carrito_sombra'));
const ultimaSombra = () => {
  const l = lineasSombra().pop();
  return l ? JSON.parse(l.slice(l.indexOf('{'))) : null;
};
const pedidosDe = async (tel) => (await pool.query(
  `SELECT folio FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono' LIKE $2`,
  [NEG, tel + '%'])).rows;

// El extractor acotado que el canal le inyecta al observador. Se le encolan
// respuestas al mock igual que en cualquier otra suite.
const encolarPropuesta = (items) => anthropicMock.encolarRespuesta(JSON.stringify({ items }));

try {

// ═══ S1 — se observa y no sale nada ════════════════════════════════════════
await t('S1. mensaje real con sombra activa: evalúa, registra y no envía nada', async () => {
  const tel = TEL_BASE + '01';
  const antesComunicaciones = comunicaciones().length;
  const antesTodo = metaMock.obtenerMensajesEnviados().length;
  const antesLineas = lineasSombra().length;
  encolarPropuesta([{ nombre: 'SOMBRA Torta', cantidad: 2 }]);
  await mensajeEntrante(tel, 'quiero dos sombra torta');
  await esperarTurno();
  assert.ok(lineasSombra().length > antesLineas,
    'debía quedar una línea de observación — cola del servidor: ' + srv.obtenerSalida().slice(-1800));
  assert.strictEqual(comunicaciones().length, antesComunicaciones,
    `cero comunicaciones al cliente — ${JSON.stringify(comunicaciones().slice(antesComunicaciones))}`);
  const nuevos = metaMock.obtenerMensajesEnviados().slice(antesTodo);
  assert.ok(nuevos.every(esAcuseDeLectura),
    `lo único que puede salir es el acuse de lectura de siempre — ${JSON.stringify(nuevos)}`);
  const l = ultimaSombra();
  assert.ok(l.conv && !/\d{10}/.test(l.conv), `la conversación va por hash — ${l.conv}`);
  assert.ok(l.ts, 'con sello de tiempo');
  assert.match(JSON.stringify(l.quedaria), /SOMBRA Torta/i, `y con lo que habría quedado — ${JSON.stringify(l)}`);
});

// ═══ S2-S5 — un pedido completo que normalmente terminaría en cocina ═══════
await t('S2. pedido completo: la sombra calcula y NO se crea pedido', async () => {
  const tel = TEL_BASE + '02';
  encolarPropuesta([{ nombre: 'SOMBRA Torta', cantidad: 1 }]);
  await mensajeEntrante(tel, 'una sombra torta porfa');
  await esperarTurno();
  encolarPropuesta([{ nombre: 'SOMBRA Torta', cantidad: 1 }]);
  await mensajeEntrante(tel, 'para recoger, en efectivo, a nombre de Ana');
  await esperarTurno();
  assert.strictEqual((await pedidosDe(tel)).length, 0, 'cero pedidos creados');
  assert.match(JSON.stringify(ultimaSombra()?.quedaria), /SOMBRA Torta/i, 'pero sí calculó qué habría hecho');
});

await t('S3. confirmación explícita: no confirma nada', async () => {
  const tel = TEL_BASE + '02';
  const antesComunicaciones = comunicaciones().length;
  encolarPropuesta([{ nombre: 'SOMBRA Torta', cantidad: 1 }]);
  await mensajeEntrante(tel, 'si, confirmo mi pedido');
  await esperarTurno();
  assert.strictEqual((await pedidosDe(tel)).length, 0, 'sigue sin haber pedido');
  assert.strictEqual(comunicaciones().length, antesComunicaciones, 'y sin decirle nada al cliente');
  const salida = srv.obtenerSalida();
  assert.ok(!/NUEVO PEDIDO/.test(salida), 'jamás se anuncia un pedido nuevo');
  assert.ok(!/confirmacion_desde_snapshot/.test(salida), 'jamás se confirma desde snapshot');
});

await t('S4. no imprime: ni comanda ni ticket', async () => {
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM impresion_trabajos WHERE negocio_id=$1 AND created_at > now() - interval '5 minutes'`, [NEG]);
  assert.strictEqual(rows[0].n, 0, `cero trabajos de impresión — ${rows[0].n}`);
  assert.ok(!/imprimirComanda|comanda_bloqueada|\[Impresion\]/.test(srv.obtenerSalida()), 'ni rastro de impresión');
});

await t('S5. no cobra: ni enlace de pago ni método tocado', async () => {
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM pagos WHERE negocio_id=$1 AND created_at > now() - interval '5 minutes'`, [NEG]).catch(() => ({ rows: [{ n: 0 }] }));
  assert.strictEqual(rows[0].n, 0, 'cero cobros');
  assert.ok(!/Link creado|crearEnlacePago|pago\.clip\.mx/.test(srv.obtenerSalida()), 'ni un enlace de pago');
});

await t('S6b. la sombra explota DE VERDAD dentro del canal: no manda la conversación a revisión', async () => {
  // El fallo es real y alcanzable: el extractor lanza BORRADOR_SIN_ITEMS cuando
  // el modelo devuelve algo con forma de JSON pero sin `items`.
  //
  // Importa porque el catch de `whatsappContinuidad` marca la conversación con
  // EJECUCION_NO_VERIFICADA ante CUALQUIER excepción de `procesar`: pausa el bot
  // para ese cliente y levanta una alerta en el panel. Un fallo del experimento
  // acabaría señalando una conversación real, que es exactamente el efecto
  // operativo que la sombra promete no tener.
  const tel = TEL_BASE + '06';
  const antesComunicaciones = comunicaciones().length;
  anthropicMock.drenar();
  anthropicMock.encolarRespuesta('{"esto_no_trae_items": true}');
  await mensajeEntrante(tel, 'quiero una sombra torta');
  await esperarTurno();

  const { rows } = await pool.query(
    `SELECT requiere_revision, motivo FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2`,
    [NEG, tel]);
  assert.ok(!rows[0]?.requiere_revision,
    `la conversación no puede quedar señalada — ${JSON.stringify(rows[0])}`);
  assert.ok(!/EJECUCION_NO_VERIFICADA/.test(srv.obtenerSalida()),
    'ni dispararse el camino de revisión de la continuidad');
  assert.strictEqual(comunicaciones().length, antesComunicaciones, 'y el cliente no se entera de nada');
});

// ═══ S6-S7 — fail closed ═══════════════════════════════════════════════════
await t('S6. excepción DENTRO del reconciliador: no lanza y no deja rastro de efecto', async () => {
  process.env.PEDIDO_SHADOW_MODE = 'true';
  sombra.reiniciarSombra();
  const r = await sombra.observarTurno({
    sessionId: 'sombra-s6', negocioId: NEG, mensaje: 'quiero algo',
    proponer: () => { throw new Error('explota el extractor'); },
  });
  assert.strictEqual(r.ok, false, 'el turno se marca no evaluado');
  assert.match(r.motivo, /explota/, r.motivo);
});

await t('S7. excepción al REGISTRAR: tampoco cambia nada ni lanza', async () => {
  process.env.PEDIDO_SHADOW_MODE = 'true';
  sombra.reiniciarSombra();
  const warn = console.warn;
  console.warn = () => { throw new Error('log roto'); };
  let r;
  try {
    r = await sombra.observarTurno({
      sessionId: 'sombra-s7', negocioId: NEG, mensaje: 'una sombra torta',
      proponer: async () => ({ items: [{ nombre: 'SOMBRA Torta', cantidad: 1 }] }),
    });
  } finally { console.warn = warn; }
  assert.strictEqual(r.ok, true, 'el registro falla por dentro y se traga solo');
});

// ═══ S8-S9 — la bandera ════════════════════════════════════════════════════
await t('S8. PEDIDO_SHADOW_MODE=false: la sombra no corre', async () => {
  const antes = process.env.PEDIDO_SHADOW_MODE;
  process.env.PEDIDO_SHADOW_MODE = 'false';
  try {
    assert.strictEqual(sombra.sombraActiva(), false, '"false" es una cadena; jamás puede encender por truthiness');
    const r = await sombra.observarTurno({ sessionId: 'sombra-s8', negocioId: NEG, mensaje: 'hola',
      proponer: () => { throw new Error('no debió llamarse'); } });
    assert.strictEqual(r.motivo, 'apagado', JSON.stringify(r));
  } finally { process.env.PEDIDO_SHADOW_MODE = antes; }
});

await t('S9. sin la variable: apagada, y el flujo productivo intacto', async () => {
  const antes = process.env.PEDIDO_SHADOW_MODE;
  delete process.env.PEDIDO_SHADOW_MODE;
  try {
    assert.strictEqual(sombra.sombraActiva(), false, 'ausente = apagado');
  } finally { if (antes !== undefined) process.env.PEDIDO_SHADOW_MODE = antes; }

  // Y con el bot ENCENDIDO, el mismo servidor con la bandera puesta sigue
  // atendiendo como siempre: la sombra solo mira los turnos que nadie contesta.
  await pool.query(`UPDATE negocios SET bot_whatsapp_activo = TRUE WHERE id = $1`, [NEG]);
  const tel = TEL_BASE + '09';
  const antesComunicaciones = comunicaciones().length;
  const antesLineas = lineasSombra().length;
  anthropicMock.drenar();
  anthropicMock.encolarRespuesta('Con gusto, ¿algo más?');
  anthropicMock.encolarRespuesta(JSON.stringify({ menciones: [] }));
  await mensajeEntrante(tel, 'hola buenas tardes');
  await esperarTurno();
  await pool.query(`UPDATE negocios SET bot_whatsapp_activo = FALSE WHERE id = $1`, [NEG]);
  assert.ok(comunicaciones().length > antesComunicaciones,
    'con el bot encendido el cliente SÍ recibe respuesta: producción intacta');
  assert.strictEqual(lineasSombra().length, antesLineas,
    'y ese turno NO se observa: la sombra mira los turnos callados, no los atendidos');
});

// ═══ Semántica exacta de la variable ═══════════════════════════════════════
await t('S9b. la bandera se compara explícitamente, valor por valor', async () => {
  const antes = process.env.PEDIDO_SHADOW_MODE;
  const casos = [[undefined, false], ['', false], ['false', false], ['0', false], ['no', false],
    ['1', false], ['true', true], ['TRUE', true], ['  true  ', true]];
  try {
    for (const [valor, esperado] of casos) {
      if (valor === undefined) delete process.env.PEDIDO_SHADOW_MODE;
      else process.env.PEDIDO_SHADOW_MODE = valor;
      assert.strictEqual(sombra.sombraActiva(), esperado, `${JSON.stringify(valor)} debía dar ${esperado}`);
    }
  } finally { if (antes === undefined) delete process.env.PEDIDO_SHADOW_MODE; else process.env.PEDIDO_SHADOW_MODE = antes; }
});

await t('S13. un negocio SIN pedido_shadow no se observa aunque la global esté puesta', async () => {
  // El segundo negocio es el que faltaba: con uno solo, quitar el gate local no
  // se nota, porque ese único negocio tenía la llave. Aquí conviven los dos en
  // el MISMO proceso y solo uno debe aparecer en el log.
  const { rows: [otro] } = await pool.query(
    `INSERT INTO negocios(nombre,slug) VALUES ('Sombra Ajena', $1) RETURNING id`,
    ['sombra-ajena-' + Date.now()]);
  const PNID2 = 'PNID_SOMBRA_B';
  const tel2 = TEL_BASE + '77';
  try {
    await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'whatsapp','activo')
      ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [otro.id]);
    await actualizarConfiguracion({ int_wa_phone_id: PNID2, int_wa_token: 'fake-token-ajeno' }, otro.id);
    await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo)
      VALUES ($1,'whatsapp',$2,'Sombra Ajena',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [otro.id, PNID2]);
    await pool.query(`UPDATE negocios SET bot_whatsapp_activo = FALSE WHERE id = $1`, [otro.id]);
    // Sin `pedido_shadow`: es un negocio cualquiera que no pidió nada.

    const antesLineas = lineasSombra().length;
    const antesComunicaciones = comunicaciones().length;
    // Se le deja al extractor una respuesta VÁLIDA preparada. Sin ella, quitar
    // el gate no se notaría: la observación arrancaría, se quedaría sin
    // respuesta del modelo y moriría en su propio catch sin escribir nada. La
    // prueba pasaría por el motivo equivocado.
    anthropicMock.drenar();
    encolarPropuesta([{ nombre: 'SOMBRA Torta', cantidad: 1 }]);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: PNID2 },
        messages: [{ type: 'text', from: tel2, id: `wamid.AJENO-${Date.now()}`, text: { body: 'quiero una torta' } }],
        contacts: [{ profile: { name: 'Cliente Ajeno' } }],
      } }] }],
    };
    await fetch(srv.base + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    await esperarTurno();

    // Que el turno HAYA LLEGADO. Sin esto la prueba pasaría por no haber
    // ocurrido nada, que es la peor forma de pasar: quitar el gate no la
    // tumbaría y estaríamos protegidos por una casualidad.
    const { rows: llego } = await pool.query(
      'SELECT estado FROM whatsapp_entradas WHERE telefono = $1', [tel2]);
    assert.ok(llego.length, 'el mensaje del otro negocio tenía que entrar al canal');
    // Y que el canal haya LLEGADO al punto donde vive el enganche de la sombra:
    // esa línea la imprime el mismo `if` que decide callar, justo antes.
    assert.ok(srv.obtenerSalida().includes(`Bot de WhatsApp desactivado para el negocio ${otro.id}`),
      'el turno tenía que llegar hasta la decisión de callar, que es donde se observa');

    assert.strictEqual(lineasSombra().length, antesLineas,
      'un negocio sin la llave local no se observa, aunque el proceso tenga la global');
    assert.strictEqual(comunicaciones().length, antesComunicaciones, 'y desde luego no se le contesta');
  } finally {
    await pool.query(`DELETE FROM whatsapp_entradas WHERE telefono = $1`, [tel2]).catch(() => {});
    await pool.query(`DELETE FROM whatsapp_conversaciones WHERE telefono = $1`, [tel2]).catch(() => {});
    await pool.query(`DELETE FROM mensajes WHERE telefono = $1`, [tel2]).catch(() => {});
    await pool.query(`DELETE FROM clientes WHERE telefono = $1`, [tel2]).catch(() => {});
    await pool.query(`DELETE FROM integraciones_canal WHERE identificador = $1`, [PNID2]).catch(() => {});
    await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1`, [otro.id]).catch(() => {});
    await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id = $1`, [otro.id]).catch(() => {});
    await pool.query(`DELETE FROM negocios WHERE id = $1`, [otro.id]).catch(() => {});
  }
});

await t('S14. tres negocios intercalados: uno observado, dos atendidos, sin filtraciones', async () => {
  // El escenario que se quiere desplegar, en el nivel donde de verdad vive la
  // sombra: el canal. A es el del bot apagado y con la llave; B y C atienden
  // clientes y no tienen ninguna llave. Los tres, en el MISMO proceso.
  const { createHash } = await import('node:crypto');
  const hash = (neg, tel) => createHash('sha256').update(`meta-${neg}-${tel}`).digest('hex').slice(0, 12);

  const otros = [];
  for (const etiqueta of ['b', 'c']) {
    const { rows: [n] } = await pool.query(
      `INSERT INTO negocios(nombre,slug) VALUES ($1,$2) RETURNING id`,
      [`Legacy ${etiqueta}`, `legacy-${etiqueta}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`]);
    const pnid = `PNID_LEGACY_${etiqueta.toUpperCase()}`;
    const tel = TEL_BASE + (etiqueta === 'b' ? '81' : '82');
    await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'whatsapp','activo')
      ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [n.id]);
    await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'asistente_comercial_cotizaciones','no_configurado')
      ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='no_configurado'`, [n.id]);
    await actualizarConfiguracion({ int_wa_phone_id: pnid, int_wa_token: `fake-${etiqueta}` }, n.id);
    await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo)
      VALUES ($1,'whatsapp',$2,$3,TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [n.id, pnid, `Legacy ${etiqueta}`]);
    // BOT ENCENDIDO y SIN ninguna llave: es el estado de Acuña y Nonna Maye.
    await pool.query(`UPDATE negocios SET bot_whatsapp_activo = TRUE WHERE id = $1`, [n.id]);
    await pool.query(`DELETE FROM configuracion WHERE negocio_id=$1 AND clave IN ('pedido_shadow','pedido_reconciliador_v2')`, [n.id]);
    otros.push({ id: n.id, pnid, tel, etiqueta });
  }
  const [B, C] = otros;
  const A = { id: NEG, pnid: PNID, tel: TEL_BASE + '80', etiqueta: 'a' };

  const mandar = async (neg, texto) => {
    anthropicMock.drenar();
    // Un respondedor que sirve para los tres: el turno del asistente y las
    // llamadas auxiliares, sin depender de cuántas haga cada camino.
    for (let i = 0; i < 6; i++) {
      anthropicMock.encolarRespuesta((payload) => {
        const sys = String(payload?.system || '');
        if (sys.includes('MENCIONES COMERCIALES')) return JSON.stringify({ menciones: [] });
        if (sys.includes('Extrae el pedido que el cliente')) return JSON.stringify({ items: [] });
        return 'Con gusto, ¿algo más?';
      });
    }
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: neg.pnid },
        messages: [{ type: 'text', from: neg.tel, id: `wamid.MIX-${neg.etiqueta}-${Date.now()}-${Math.random()}`, text: { body: texto } }],
        contacts: [{ profile: { name: 'Cliente ' + neg.etiqueta } }],
      } }] }],
    };
    await fetch(srv.base + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    await esperarTurno();
  };

  try {
    const antesLineas = lineasSombra().length;
    const antesPorTel = (tel) => comunicaciones().filter((m) => String(m.to) === tel).length;
    const comB0 = antesPorTel(B.tel), comC0 = antesPorTel(C.tel), comA0 = antesPorTel(A.tel);

    // A → B → C → A → C → B
    for (const [neg, texto] of [[A, 'hola, quiero una sombra torta'], [B, 'hola'], [C, 'hola'],
      [A, 'y para recoger'], [C, 'gracias'], [B, 'gracias']]) {
      await mandar(neg, texto);
    }

    const lineas = srv.obtenerSalida().split(String.fromCharCode(10))
      .filter((l) => l.includes('evento=carrito_sombra')).slice(antesLineas);
    const convs = lineas.map((l) => JSON.parse(l.slice(l.indexOf('{'))).conv);

    // A: observado las dos veces, sin una palabra al cliente.
    assert.strictEqual(convs.filter((c) => c === hash(A.id, A.tel)).length, 2,
      `los dos turnos de A tenían que observarse — ${JSON.stringify(convs)}`);
    assert.strictEqual(antesPorTel(A.tel), comA0, 'y A no recibe respuesta: su bot está apagado');

    // B y C: atendidos como siempre, y jamás observados.
    for (const n of [B, C]) {
      assert.strictEqual(convs.filter((c) => c === hash(n.id, n.tel)).length, 0,
        `${n.etiqueta} no puede aparecer en el log de sombra — ${JSON.stringify(convs)}`);
    }
    assert.ok(antesPorTel(B.tel) > comB0, 'B tiene que seguir contestándole a su cliente');
    assert.ok(antesPorTel(C.tel) > comC0, 'C tiene que seguir contestándole a su cliente');

    // Y nadie más se coló: las únicas líneas son las de A.
    assert.strictEqual(convs.length, 2, `solo A se observa — ${JSON.stringify(convs)}`);
  } finally {
    for (const n of otros) {
      for (const tabla of ['whatsapp_entradas', 'whatsapp_conversaciones', 'mensajes', 'clientes']) {
        await pool.query(`DELETE FROM ${tabla} WHERE telefono = $1`, [n.tel]).catch(() => {});
      }
      await pool.query(`DELETE FROM integraciones_canal WHERE identificador = $1`, [n.pnid]).catch(() => {});
      await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1`, [n.id]).catch(() => {});
      await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id = $1`, [n.id]).catch(() => {});
      await pool.query(`DELETE FROM negocios WHERE id = $1`, [n.id]).catch(() => {});
    }
    for (const tabla of ['whatsapp_entradas', 'whatsapp_conversaciones', 'mensajes', 'clientes']) {
      await pool.query(`DELETE FROM ${tabla} WHERE telefono = $1`, [TEL_BASE + '80']).catch(() => {});
    }
  }
});

// ═══ S10-S12 — lo que las mordidas deben tumbar ════════════════════════════
//
// Estas tres no se prueban desactivando una condición, sino comprobando que la
// capacidad NO EXISTE. Es la forma correcta para una garantía de aislamiento:
// una protección que se puede apagar con un `if` es una protección; no tener la
// función a mano es una imposibilidad. Las mordidas correspondientes (bite S10,
// S11, S12) reintroducen la capacidad en el código y estas pruebas caen.
await t('S10. el observador no puede escribir el carrito real (no lo conoce)', async () => {
  const bruto = readFileSync(join(__dirname, '..', 'src', 'orders', 'registroSombra.js'), 'utf8');
  const fuente = bruto.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/session\s*\./.test(fuente), 'el módulo de sombra no toca ninguna sesión');
  assert.ok(!/carritoSombra/.test(fuente), 'ni deja estado dentro de la sesión productiva');
  const durable = readFileSync(join(__dirname, '..', 'src', 'agent', 'sesionDurable.js'), 'utf8');
  assert.ok(!/carritoSombra/.test(durable), 'la foto durable no carga con el experimento');
  const cerebro = readFileSync(join(__dirname, '..', 'src', 'agent', 'brain.js'), 'utf8');
  assert.ok(!/PEDIDO_SHADOW_MODE|carritoSombra/.test(cerebro),
    'el turno productivo no tiene una sola rama de sombra');
});

await t('S11. el observador no puede responderle al cliente (no importa nada que envíe)', async () => {
  const fuente = readFileSync(join(__dirname, '..', 'src', 'orders', 'registroSombra.js'), 'utf8');
  const sinComentarios = fuente.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const prohibido of ['enviarMensaje', 'enviarImagen', 'sendMessage', 'reaccionar', 'fetch(']) {
    assert.ok(!sinComentarios.includes(prohibido), `no puede haber "${prohibido}" en el observador`);
  }
  assert.ok(!/^import .*(whatsapp|channels)/m.test(sinComentarios), 'ni importar el canal');
});

await t('S12. el observador no puede crear ni confirmar pedidos (no los conoce)', async () => {
  const fuente = readFileSync(join(__dirname, '..', 'src', 'orders', 'registroSombra.js'), 'utf8');
  const sinComentarios = fuente.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const prohibido of ['registrarPedido', 'guardarPedidoActivo', 'orderManager', 'previsualizarPedido',
    'crearEnlacePago', 'imprimir', 'pool.query', 'database.js']) {
    assert.ok(!sinComentarios.includes(prohibido), `no puede haber "${prohibido}" en el observador`);
  }
});

await t('S12b. el grafo COMPLETO del observador no alcanza base, canal ni pedidos', async () => {
  // Mirar solo el archivo del observador no basta: bastaría con que importara
  // algo que a su vez importe la base. Se recorre el grafo entero.
  const raiz = join(__dirname, '..');
  const vistos = new Set(); const cola = ['src/orders/registroSombra.js'];
  while (cola.length) {
    const f = cola.shift();
    if (vistos.has(f)) continue;
    vistos.add(f);
    let s; try { s = readFileSync(join(raiz, f), 'utf8'); } catch { continue; }
    for (const m of s.matchAll(/^import[^']*'([^']+)'/gm)) {
      if (!m[1].startsWith('.')) continue;
      cola.push(join(f, '..', m[1]).split('\\').join('/'));
    }
  }
  const conEfectos = [...vistos].filter((f) => /database|server\.js|channels|orderManager|pagos|impres/i.test(f));
  assert.deepStrictEqual(conEfectos, [],
    `el observador no puede alcanzar nada con efectos — llega a ${conEfectos.join(', ')}`);
});

} finally {
  await pool.query(`UPDATE negocios SET bot_whatsapp_activo = $2 WHERE id = $1`, [NEG, BOT_ANTES]).catch(() => {});
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1 AND nombre LIKE 'SOMBRA %'`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre LIKE 'SOMBRA %'`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM integraciones_canal WHERE canal='whatsapp' AND identificador=$1`, [PNID]).catch(() => {});
  srv.detener(); metaMock.detener(); anthropicMock.detener();
  await pool.end();
}

console.log(`\n${fallidas ? 'CON FALLOS' : 'TODO VERDE'} — ${pasadas} pasadas, ${fallidas} fallidas`);
for (const f of fallos) console.log('  · ' + f);
process.exit(fallidas ? 1 : 0);
