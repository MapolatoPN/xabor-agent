// UN CANAL QUE PUEDE CALLAR, Y QUE NO CALLA CUANDO NO DEBE.
//
// Origen: el smoke del 13-sep en producción. El negocio debía estar con el bot
// apagado y observándose en sombra, y el cliente recibió tres respuestas: un
// saludo, el menú y el aviso de que el restaurante estaba cerrado.
//
// La auditoría del interruptor mostró que el bot había sido ENCENDIDO a las
// 04:12:44Z y apagado a las 04:15:24Z, y que la conversación entera ocurrió
// dentro de esa ventana. Es decir: el canal hizo lo correcto para la
// configuración que de verdad estaba puesta. Pero la suite no tenía forma de
// demostrarlo, y esa es la deuda que salda este archivo.
//
// Dos familias de casos, y las dos importan:
//
//   R1-R7   con el bot APAGADO, y fuera de horario, no sale NADA hacia el
//           cliente: ni saludo, ni menú, ni aviso de cerrado, ni error;
//   INC     con el bot ENCENDIDO, tener `pedido_shadow='true'` NO silencia
//           nada: el turno es productivo y la sombra no corre. Es lo que pasó,
//           y es correcto — pero tiene que estar escrito.
//
// El horario se fija cerrado los siete días para que el caso no dependa de la
// hora a la que alguien corra la suite.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { createHash } from 'node:crypto';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_CALLADO || '4344';
const NEG = SEED.negocioA;
const PNID = 'PNID_CALLADO';
const TEL_BASE = '5218800922';

const { pool, actualizarConfiguracion } = await import('../src/services/database.js');

let ok = 0, fail = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); ok++; console.log(`  OK  ${nombre}`); }
  catch (e) { fail++; fallos.push(`${nombre}: ${e.message}`); console.log(`FALLO ${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Preparación ────────────────────────────────────────────────────────────
// El orden importa: `whatsapp_entradas` tiene FK contra `whatsapp_conversaciones`.
await pool.query(`DELETE FROM whatsapp_entradas WHERE telefono LIKE $1`, [TEL_BASE + '%']);
await pool.query(`DELETE FROM whatsapp_conversaciones WHERE telefono LIKE $1`, [TEL_BASE + '%']);
await pool.query(`DELETE FROM conversacion_estado WHERE session_id LIKE $1`, ['%' + TEL_BASE + '%']);
await pool.query(`DELETE FROM mensajes WHERE telefono LIKE $1`, [TEL_BASE + '%']);
await pool.query(`DELETE FROM clientes WHERE telefono LIKE $1`, [TEL_BASE + '%']);
await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono' LIKE $2`,
  [NEG, TEL_BASE + '%']).catch(() => {});
await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1 AND nombre LIKE 'CAL %'`, [NEG]);
await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre='CAL Carta'`, [NEG]);
await pool.query(`DELETE FROM integraciones_canal WHERE canal='whatsapp' AND identificador=$1`, [PNID]);

const { rows: [cat] } = await pool.query(
  `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'CAL Carta',TRUE,997) RETURNING id`, [NEG]);
await pool.query(`INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
  VALUES ($1,$2,'CAL Chilaquiles',150,TRUE,0)`, [NEG, cat.id]);

// CERRADO los siete días: así el caso no depende de la hora de la corrida.
const cerradoSiempre = {
  horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
    .map((d) => [d, { abierto: false, apertura: null, cierre: null }])),
};
await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'whatsapp','activo')
  ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [NEG]);
await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'asistente_comercial_cotizaciones','no_configurado')
  ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='no_configurado'`, [NEG]);
await actualizarConfiguracion({
  int_wa_phone_id: PNID, int_wa_token: 'fake-token-callado',
  modo_pedidos: 'transaccional', reglas_atencion: JSON.stringify(cerradoSiempre),
  pedido_shadow: 'true', pedido_reconciliador_v2: 'false',
}, NEG);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo)
  VALUES ($1,'whatsapp',$2,'Callado',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [NEG, PNID]);
// Se guarda lo que hubiera ANTES para devolverlo: este negocio es del seed y lo
// comparten otras suites. Borrar su `reglas_atencion` al terminar dejaría a la
// siguiente sin horario, y ese fallo no se parecería en nada a su causa.
const { rows: [cfgAntes] } = await pool.query(
  `SELECT valor FROM configuracion WHERE negocio_id=$1 AND clave='reglas_atencion'`, [NEG]);
const REGLAS_ANTES = cfgAntes?.valor ?? null;
const { rows: [botAntes] } = await pool.query('SELECT bot_whatsapp_activo FROM negocios WHERE id=$1', [NEG]);
const BOT_ANTES = botAntes?.bot_whatsapp_activo !== false;

const metaMock = await arrancarMetaMock();
const anthropicMock = await arrancarAnthropicMock();
const srv = await arrancarServidor({
  PORT: PUERTO,
  META_GRAPH_BASE_URL: metaMock.baseUrl,
  ANTHROPIC_BASE_URL: anthropicMock.baseUrl,
  ANTHROPIC_API_KEY: 'sk-ant-test-callado',
  PEDIDO_SHADOW_MODE: 'true',
}, { timeoutMs: 30000 });

const ponerBot = (activo) => pool.query('UPDATE negocios SET bot_whatsapp_activo=$2 WHERE id=$1', [NEG, activo]);

// COMUNICACIÓN vs ACUSE: el acuse de lectura sale al RECIBIR, muchas líneas
// antes de decidir si se contesta, y ya salía así antes de todo esto. Lo que
// aquí se prohíbe es COMUNICAR.
const esAcuse = (m) => m?.status === 'read';
const comunicaciones = () => metaMock.obtenerMensajesEnviados().filter((m) => !esAcuse(m));
const lineasSombra = () => srv.obtenerSalida().split(String.fromCharCode(10)).filter((l) => l.includes('evento=carrito_sombra'));
const respuestasEnviadas = () => srv.obtenerSalida().split(String.fromCharCode(10)).filter((l) => l.includes('Respuesta enviada')).length;
const hashConv = (tel) => createHash('sha256').update(`meta-${NEG}-${tel}`).digest('hex').slice(0, 12);

let seq = 0;
async function mandar(tel, ...textos) {
  anthropicMock.drenar();
  // Un respondedor que sirve para cualquier turno: si el modelo llegara a
  // llamarse —que es justo lo que NO debe pasar con el bot apagado— tendría
  // con qué contestar. Que la prueba pase por falta de respuestas del mock
  // sería pasar por el motivo equivocado.
  for (let i = 0; i < 8; i++) {
    anthropicMock.encolarRespuesta((payload) => {
      const sys = String(payload?.system || '');
      if (sys.includes('MENCIONES COMERCIALES')) return JSON.stringify({ menciones: [] });
      if (sys.includes('Extrae el pedido que el cliente')) return JSON.stringify({ items: [] });
      return 'Buenas noches, estamos cerrados. <ENVIAR_MENU>';
    });
  }
  for (const texto of textos) {
    await fetch(srv.base + '/webhook/whatsapp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: {
          metadata: { phone_number_id: PNID },
          messages: [{ type: 'text', from: tel, id: `wamid.CAL-${Date.now()}-${seq++}`, text: { body: texto } }],
          contacts: [{ profile: { name: 'Cliente Callado' } }],
        } }] }],
      }),
    });
    await esperar(400);   // ráfaga: dentro de la ventana de agrupación del canal
  }
  await esperar(9000);    // la cola de 6 s del canal, con margen
}

/** Con el bot apagado, esto es lo que hay que poder afirmar de CUALQUIER turno. */
async function silencioTotal(etiqueta, tel, ...textos) {
  const com0 = comunicaciones().length;
  const resp0 = respuestasEnviadas();
  await mandar(tel, ...textos);
  const nuevas = comunicaciones().slice(com0);
  assert.strictEqual(nuevas.length, 0,
    `${etiqueta}: cero comunicaciones al cliente — salió ${JSON.stringify(nuevas).slice(0, 300)}`);
  assert.strictEqual(respuestasEnviadas(), resp0,
    `${etiqueta}: el canal no puede llegar a "Respuesta enviada"`);
  // Y que el turno HAYA entrado: si no, la prueba pasaría por no haber ocurrido.
  const { rows } = await pool.query('SELECT 1 FROM whatsapp_entradas WHERE telefono=$1 LIMIT 1', [tel]);
  assert.ok(rows.length, `${etiqueta}: el mensaje tenía que entrar al canal`);
}

try {

await ponerBot(false);

await t('R1. bot OFF, fuera de horario, "Hola": cero salida', async () => {
  await silencioTotal('R1', TEL_BASE + '01', 'Hola');
});

await t('R2. "Quiero ordenar": cero salida', async () => {
  await silencioTotal('R2', TEL_BASE + '02', 'Quiero ordenar');
});

await t('R3. "Me pasas el menú?": ni el menú, que va por otra ruta (imagen)', async () => {
  await silencioTotal('R3', TEL_BASE + '03', 'Me pasas el menú?');
});

await t('R4. pedido completo fuera de horario: cero salida', async () => {
  await silencioTotal('R4', TEL_BASE + '04',
    'Quiero unos CAL Chilaquiles suizos con huevo revuelto y frijoles y papas con chorizo');
});

await t('R5. ráfaga agrupada por el debounce real: cero salida', async () => {
  await silencioTotal('R5', TEL_BASE + '05',
    'Quiero ordenar', 'Me pasas el menú?', 'Quiero unos CAL Chilaquiles', 'Suizos');
});

await t('R6. la rutina de "negocio cerrado" no puede enviar con el bot apagado', () => {
  // El aviso de cerrado no lo redacta ninguna función del canal: sale del
  // system prompt (`construirSystemPrompt` inyecta el estado del horario) y por
  // tanto SOLO existe si se llegó a `brain.js`. Con el bot apagado el canal
  // retorna antes, así que la comprobación de verdad es que en toda la corrida
  // no haya salido una sola comunicación — ya afirmado arriba — y que el aviso
  // no aparezca por ninguna otra puerta.
  const salida = srv.obtenerSalida();
  assert.ok(!/estamos cerrados/i.test(JSON.stringify(comunicaciones())),
    'el aviso de cerrado no puede haber salido');
  assert.ok(!/procesarConClaude|Respuesta enviada/.test(salida.split('R6')[0] || '') || respuestasEnviadas() === 0,
    'no se llegó a enviar ninguna respuesta en toda la corrida con el bot apagado');
});

await t('R7. el saludo tampoco: no hay saludo automático fuera de brain', async () => {
  await silencioTotal('R7', TEL_BASE + '07', 'Buenas noches');
  assert.strictEqual(respuestasEnviadas(), 0,
    'con el bot apagado no se envió una sola respuesta en toda la corrida');
});

await t('R8. el bot se apaga DURANTE la ventana de agrupación: se calla igual', async () => {
  // El estado se lee al PROCESAR, no al recibir. Si se guardara la lectura del
  // encolado, un mensaje que entró con el bot encendido saldría contestado
  // aunque alguien lo hubiera apagado mientras tanto — que es exactamente lo
  // que hizo el dueño en el smoke, a las 04:15:24Z.
  const tel = TEL_BASE + '08';
  const com0 = comunicaciones().length;
  await ponerBot(true);
  anthropicMock.drenar();
  for (let i = 0; i < 8; i++) {
    anthropicMock.encolarRespuesta((payload) => {
      const sys = String(payload?.system || '');
      if (sys.includes('MENCIONES COMERCIALES')) return JSON.stringify({ menciones: [] });
      if (sys.includes('Extrae el pedido que el cliente')) return JSON.stringify({ items: [] });
      return 'No debí contestar.';
    });
  }
  await fetch(srv.base + '/webhook/whatsapp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: PNID },
        messages: [{ type: 'text', from: tel, id: `wamid.CAL-R8-${Date.now()}`, text: { body: 'Hola' } }],
        contacts: [{ profile: { name: 'Cliente R8' } }],
      } }] }] }),
  });
  await esperar(1500);            // dentro de la ventana de 6 s
  await ponerBot(false);          // el dueño lo apaga a media espera
  await esperar(9000);
  assert.strictEqual(comunicaciones().length, com0,
    `apagarlo durante la espera tiene que bastar — salió ${JSON.stringify(comunicaciones().slice(com0)).slice(0, 200)}`);
});
// ── El incidente, tal como ocurrió ─────────────────────────────────────────
await t('INC. con el bot ENCENDIDO, pedido_shadow NO silencia: turno productivo y cero sombra', async () => {
  // Esto es lo que pasó el 13-sep: alguien encendió el bot para hacer el smoke
  // y el cliente recibió respuestas. No es una fuga — es lo correcto para esa
  // configuración— pero tiene que estar escrito, porque la expectativa era la
  // contraria y nada lo desmentía.
  const tel = TEL_BASE + '09';
  const com0 = comunicaciones().length;
  const sombra0 = lineasSombra().length;
  await ponerBot(true);
  try {
    await mandar(tel, 'Hola');
    assert.ok(comunicaciones().length > com0,
      'con el bot encendido el cliente SÍ recibe respuesta, aunque el negocio tenga pedido_shadow');
    assert.strictEqual(lineasSombra().length, sombra0,
      'y la sombra NO corre: observa los turnos que nadie contesta, no los atendidos');
    assert.ok(!lineasSombra().some((l) => l.includes(hashConv(tel))),
      'ninguna línea de sombra puede llevar esta conversación');
  } finally {
    await ponerBot(false);
  }
});

await t('INC2. y al volver a apagarlo, el silencio regresa en el siguiente mensaje', async () => {
  await silencioTotal('INC2', TEL_BASE + '10', 'Hola de nuevo');
});

} finally {
  await ponerBot(BOT_ANTES);
  await pool.query(`DELETE FROM configuracion WHERE negocio_id=$1 AND clave IN
    ('pedido_shadow','pedido_reconciliador_v2')`, [NEG]).catch(() => {});
  if (REGLAS_ANTES === null) {
    await pool.query(`DELETE FROM configuracion WHERE negocio_id=$1 AND clave='reglas_atencion'`, [NEG]).catch(() => {});
  } else {
    await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'reglas_atencion',$2)
      ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`, [NEG, REGLAS_ANTES]).catch(() => {});
  }
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1 AND nombre LIKE 'CAL %'`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre='CAL Carta'`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM integraciones_canal WHERE canal='whatsapp' AND identificador=$1`, [PNID]).catch(() => {});
  srv.detener(); metaMock.detener(); anthropicMock.detener();
  await pool.end();
}

console.log(`\n${fail ? 'CON FALLOS' : 'TODO VERDE'} — ${ok} pasadas, ${fail} fallidas`);
for (const f of fallos) console.log('  · ' + f);
process.exit(fail ? 1 : 0);
