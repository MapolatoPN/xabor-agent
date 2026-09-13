// LA CONFIGURACIÓN EXACTA DEL DESPLIEGUE, EN UN SOLO PROCESO.
//
// Tres negocios a la vez, con los mensajes intercalados:
//
//   ROL SOMBRA   bot OFF · mesero_whatsapp_shadow=true · mesero_whatsapp_v1=false
//                · pedido_reconciliador_v2 ausente          -> observa y calla
//   ROL LEGACY A bot ON  · ninguna bandera                  -> contesta como siempre
//   ROL LEGACY B bot ON  · ninguna bandera                  -> contesta como siempre
//
// Son los papeles de Obispado, Acuña y Nonna Maye en el despliegue que viene.
// Aquí se representan con los negocios del seed: escribir sus nombres o sus
// UUID en una prueba la ataría a la producción de hoy, y el 12 de septiembre ya
// enseñó lo que cuesta confundir un negocio con otro.
//
// Lo que hay que demostrar, y en el mismo proceso porque el incidente fue
// exactamente eso:
//
//   · solo el de sombra ejecuta el Mesero;
//   · solo él produce líneas de sombra;
//   · los otros dos SIGUEN CONTESTANDO — si se callaran, el despliegue les
//     habría roto el negocio;
//   · el estado sombra no se comparte;
//   · ni el catálogo ni las propuestas se cruzan.
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { createHash } from 'node:crypto';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_DEPLOY || '4357';
const TEL = '5218811490';

// Los tres papeles. `neg` es un negocio del seed; el papel es lo que importa.
const ROLES = [
  { rol: 'SOMBRA', neg: SEED.negocioA, pnid: 'PNID_DEP_S', bot: false, sombra: true, plato: 'DEP Enchiladas' },
  { rol: 'LEGACY_A', neg: SEED.negocioB, pnid: 'PNID_DEP_A', bot: true, sombra: false, plato: 'DEP Pozole' },
  { rol: 'LEGACY_B', neg: SEED.negocioC, pnid: 'PNID_DEP_B', bot: true, sombra: false, plato: 'DEP Menudo' },
];

const { pool, actualizarConfiguracion } = await import('../src/services/database.js');

let ok = 0, fail = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); ok++; console.log(`  OK  ${nombre}`); }
  catch (e) { fail++; fallos.push(`${nombre}: ${e.message}`); console.log(`FALLO ${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Montaje ────────────────────────────────────────────────────────────────
await pool.query('DELETE FROM whatsapp_entradas WHERE telefono LIKE $1', [TEL + '%']);
await pool.query('DELETE FROM whatsapp_conversaciones WHERE telefono LIKE $1', [TEL + '%']);
await pool.query('DELETE FROM conversacion_estado WHERE session_id LIKE $1', ['%' + TEL + '%']);
await pool.query('DELETE FROM mensajes WHERE telefono LIKE $1', [TEL + '%']);
await pool.query('DELETE FROM clientes WHERE telefono LIKE $1', [TEL + '%']);
await pool.query('DELETE FROM integraciones_canal WHERE canal=$1 AND identificador = ANY($2)',
  ['whatsapp', ROLES.map((r) => r.pnid)]);
for (const r of ROLES) {
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono' LIKE $2`,
    [r.neg, TEL + '%']).catch(() => {});
  await pool.query("DELETE FROM menu_productos WHERE negocio_id=$1 AND nombre LIKE 'DEP %'", [r.neg]);
  await pool.query("DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre LIKE 'DEP %'", [r.neg]);
}

// ABIERTO los siete días: los dos negocios LEGACY tienen que poder contestar, y
// eso no puede depender de la hora a la que alguien corra la suite.
const abiertoSiempre = {
  horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
    .map((d) => [d, { abierto: true, apertura: '00:00', cierre: '23:59' }])),
};

const previo = {};
for (const r of ROLES) {
  const { rows: [cfg] } = await pool.query(
    "SELECT valor FROM configuracion WHERE negocio_id=$1 AND clave='reglas_atencion'", [r.neg]);
  const { rows: creds } = await pool.query(
    "SELECT clave, valor FROM configuracion WHERE negocio_id=$1 AND clave IN ('int_wa_phone_id','int_wa_token')",
    [r.neg]);
  const { rows: [b] } = await pool.query('SELECT bot_whatsapp_activo FROM negocios WHERE id=$1', [r.neg]);
  previo[r.neg] = {
    reglas: cfg?.valor ?? null, bot: b?.bot_whatsapp_activo !== false,
    creds: Object.fromEntries(creds.map((c) => [c.clave, c.valor])),
    tenia: new Set(creds.map((c) => c.clave)),
  };

  const { rows: [cat] } = await pool.query(
    'INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,995) RETURNING id',
    [r.neg, `DEP Carta ${r.rol}`]);
  await pool.query(`INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
    VALUES ($1,$2,$3,120,TRUE,0)`, [r.neg, cat.id, r.plato]);

  for (const modulo of [['whatsapp', 'activo'], ['asistente_comercial_cotizaciones', 'no_configurado']]) {
    await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
      ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado=$3`, [r.neg, modulo[0], modulo[1]]);
  }
  await actualizarConfiguracion({
    int_wa_phone_id: r.pnid, int_wa_token: `fake-dep-${r.rol}`,
    modo_pedidos: 'transaccional', reglas_atencion: JSON.stringify(abiertoSiempre),
  }, r.neg);
  // LEGACY es AUSENCIA de banderas, no `false`. Es la configuración de un
  // negocio que nunca se tocó, que es lo que hay que demostrar.
  await pool.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave = ANY($2)',
    [r.neg, ['pedido_reconciliador_v2', 'pedido_shadow', 'mesero_whatsapp_v1', 'mesero_whatsapp_shadow']]);
  if (r.sombra) await actualizarConfiguracion({ mesero_whatsapp_shadow: 'true' }, r.neg);
  await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo)
    VALUES ($1,'whatsapp',$2,$3,TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [r.neg, r.pnid, r.rol]);
  await pool.query('UPDATE negocios SET bot_whatsapp_activo=$2 WHERE id=$1', [r.neg, r.bot]);
}

const metaMock = await arrancarMetaMock();
const anthropicMock = await arrancarAnthropicMock();
const srv = await arrancarServidor({
  PORT: PUERTO,
  META_GRAPH_BASE_URL: metaMock.baseUrl,
  ANTHROPIC_BASE_URL: anthropicMock.baseUrl,
  ANTHROPIC_API_KEY: 'sk-ant-test-dep',
  MESERO_SHADOW_MODE: 'true',
  PEDIDO_SHADOW_MODE: 'false',
}, { timeoutMs: 30000 });

const esAcuse = (m) => m?.status === 'read';
const comunicaciones = () => metaMock.obtenerMensajesEnviados().filter((m) => !esAcuse(m));
const salida = () => srv.obtenerSalida().split(String.fromCharCode(10));
const registros = () => salida().filter((l) => l.includes('[SOMBRA-MESERO] {'))
  .map((l) => { try { return JSON.parse(l.slice(l.indexOf('{'))); } catch { return null; } })
  .filter(Boolean);
const hashConv = (neg, tel) => createHash('sha256').update(`meta-${neg}-${tel}`).digest('hex').slice(0, 10);

// ── EL MOCK RESPONDE POR CONTENIDO, NO POR TURNO ────────────────────────────
//
// La cola del mock es FIFO y COMPARTIDA por los tres negocios, y el canal
// agrupa seis segundos: cuando por fin se procesa, ya se mandaron los siete
// mensajes. Un responder encolado «para este turno» acaba contestándole a otro
// negocio, y la prueba mide el desorden de su propio andamio en vez del
// comportamiento. La primera versión de esta suite lo hizo y parecía una fuga
// entre negocios.
//
// Así que el responder MIRA el mensaje y contesta lo que corresponda. Con eso
// el orden deja de importar.
function responderPorContenido(payload) {
  const sys = String(payload?.system || '');
  if (sys.includes('MENCIONES COMERCIALES')) return JSON.stringify({ menciones: [] });
  const dicho = JSON.stringify(payload?.messages || []);
  const suyo = ROLES.find((r) => dicho.includes(r.plato));
  if (sys.includes('Extrae el pedido que el cliente')) {
    return JSON.stringify({ items: suyo ? [{ nombre: suyo.plato, cantidad: 1 }] : [] });
  }
  return suyo ? `Claro, te anoto un ${suyo.plato}.` : 'Con gusto.';
}
for (let i = 0; i < 120; i++) anthropicMock.encolarRespuesta(responderPorContenido);

let seq = 0;
async function mandar(rol, tel, texto) {
  await fetch(srv.base + '/webhook/whatsapp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: rol.pnid },
        messages: [{ type: 'text', from: tel, id: `wamid.DEP-${Date.now()}-${seq++}`, text: { body: texto } }],
        contacts: [{ profile: { name: 'Cliente Deploy' } }],
      } }] }],
    }),
  });
  await esperar(300);
}

try {

// ── La conversación INTERCALADA ─────────────────────────────────────────────
const tel = Object.fromEntries(ROLES.map((r, i) => [r.rol, `${TEL}${i}${i}`]));
const guion = [
  ['SOMBRA', 'quiero unas DEP Enchiladas'],
  ['LEGACY_A', 'quiero un DEP Pozole'],
  ['LEGACY_B', 'quiero un DEP Menudo'],
  ['SOMBRA', 'que me recomiendas?'],
  ['LEGACY_A', 'para recoger'],
  ['SOMBRA', 'si'],
  ['LEGACY_B', 'para recoger'],
];
for (const [rolNombre, texto] of guion) {
  const rol = ROLES.find((r) => r.rol === rolNombre);
  await mandar(rol, tel[rolNombre], texto);
}
await esperar(10000);   // la cola de 6 s del canal, con margen para los tres

const deSombra = ROLES.find((r) => r.rol === 'SOMBRA');
const mensajesA = (t) => comunicaciones().filter((m) => m?.to === t);

await t('D1. SOLO el negocio en sombra ejecuta el Mesero', async () => {
  const todos = registros();
  assert(todos.length >= 2, `el negocio en sombra no observó nada (${todos.length} registros)`);
  assert(todos.every((r) => r.negocio === deSombra.neg),
    `observó a un negocio que no lo pidió: ${JSON.stringify([...new Set(todos.map((r) => r.negocio))])}`);
  const conv = hashConv(deSombra.neg, tel.SOMBRA);
  assert(todos.every((r) => r.conv === conv), 'se observó otra conversación');
});

await t('D2. el negocio en sombra NO le contesta nada al cliente', async () => {
  assert.deepEqual(mensajesA(tel.SOMBRA), [],
    `el negocio en sombra habló: ${JSON.stringify(mensajesA(tel.SOMBRA)).slice(0, 200)}`);
});

await t('D3. LOS DOS NEGOCIOS LEGACY SIGUEN CONTESTANDO', async () => {
  // Si esto falla, el despliegue les rompió el negocio a dos restaurantes que
  // no pidieron nada. Es la prueba que más importa de toda la suite.
  for (const rol of ['LEGACY_A', 'LEGACY_B']) {
    const salidas = mensajesA(tel[rol]);
    assert(salidas.length >= 1, `${rol} dejó de contestar: el bot se le apagó solo`);
  }
});

await t('D4. ningún negocio LEGACY produce una sola línea de sombra', async () => {
  const ajenos = registros().filter((r) => r.negocio !== deSombra.neg);
  assert.deepEqual(ajenos, [], `un negocio legacy acabó observado: ${JSON.stringify(ajenos).slice(0, 200)}`);
  // Y tampoco la sombra del RECONCILIADOR, que es otro experimento y está apagado.
  assert.equal(salida().some((l) => l.includes('evento=carrito_sombra')), false,
    'corrió la sombra del reconciliador, que no se pidió');
});

await t('D5. el estado sombra no se comparte entre negocios', async () => {
  // El pedido hipotético del negocio observado solo contiene SU plato.
  const suyos = registros();
  const texto = JSON.stringify(suyos.map((r) => r.pedido_hipotetico));
  assert(texto.includes(deSombra.plato), `no observó su propio plato: ${texto}`);
  for (const otro of ROLES.filter((r) => r.rol !== 'SOMBRA')) {
    assert.equal(texto.includes(otro.plato), false,
      `el plato de ${otro.rol} se coló en el estado sombra: ${texto}`);
  }
});

await t('D6. no hay contaminación de catálogo: solo se consulta la carta propia', async () => {
  const texto = JSON.stringify(registros());
  for (const otro of ROLES.filter((r) => r.rol !== 'SOMBRA')) {
    assert.equal(texto.includes(otro.plato), false,
      `la carta de ${otro.rol} llegó al negocio observado`);
    assert.equal(texto.includes(`DEP Carta ${otro.rol}`), false, 'se coló una categoría ajena');
  }
  // Y lo que SÍ aparece tiene que existir en la carta del negocio observado.
  // Ese negocio es del seed y tiene más productos que los de esta suite: que
  // aparezca uno suyo es correcto, y que aparezca uno ajeno no.
  const { rows } = await pool.query(
    `SELECT p.nombre FROM menu_productos p JOIN menu_categorias c ON c.id = p.categoria_id
      WHERE p.negocio_id=$1 AND c.activa = TRUE`, [deSombra.neg]);
  const suyos = new Set(rows.map((r) => r.nombre));
  for (const reg of registros()) {
    for (const linea of reg.pedido_hipotetico || []) {
      assert(suyos.has(linea.n), `"${linea.n}" no está en la carta del negocio observado`);
    }
  }
});

await t('D7. no hay contaminación de propuestas', async () => {
  const recomendadas = registros().flatMap((r) => r.recomendaciones || []);
  for (const otro of ROLES.filter((r) => r.rol !== 'SOMBRA')) {
    assert.equal(recomendadas.includes(otro.plato), false,
      `se recomendó el plato de ${otro.rol}`);
  }
  // Y lo que se recomendó, si algo, sale de SU carta — que es la del seed más
  // lo que monta esta suite, no solo el plato de aquí.
  const { rows } = await pool.query(
    `SELECT p.nombre FROM menu_productos p JOIN menu_categorias c ON c.id = p.categoria_id
      WHERE p.negocio_id=$1 AND c.activa = TRUE`, [deSombra.neg]);
  const suyos = new Set(rows.map((r) => r.nombre));
  for (const r of recomendadas) {
    assert(suyos.has(r), `recomendó "${r}", que no está en su carta`);
  }
});

await t('D8. el negocio en sombra no registró ningún pedido', async () => {
  const { rows } = await pool.query(
    `SELECT folio FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono'=$2`,
    [deSombra.neg, tel.SOMBRA]);
  assert.deepEqual(rows, [], `la sombra registró un pedido: ${JSON.stringify(rows)}`);
});

await t('D9. los modos resueltos son los tres que se pidieron', async () => {
  const { modoDelPedido } = await import('../src/orders/modoDelPedido.js');
  const antes = process.env.MESERO_SHADOW_MODE;
  try {
    process.env.MESERO_SHADOW_MODE = 'true';
    for (const r of ROLES) {
      const m = await modoDelPedido(r.neg);
      assert.equal(m.modo, 'legacy', `${r.rol}: el modo de pedido debía seguir siendo legacy`);
      assert.equal(m.v2, false, `${r.rol}: V2 productivo encendido`);
      assert.equal(m.mesero, false, `${r.rol}: mesero productivo encendido`);
      assert.equal(m.meseroSombra, r.sombra, `${r.rol}: meseroSombra debía ser ${r.sombra}`);
    }
  } finally {
    if (antes === undefined) delete process.env.MESERO_SHADOW_MODE; else process.env.MESERO_SHADOW_MODE = antes;
  }
});

} finally {
  for (const r of ROLES) {
    await pool.query("DELETE FROM menu_productos WHERE negocio_id=$1 AND nombre LIKE 'DEP %'", [r.neg]).catch(() => {});
    await pool.query("DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre LIKE 'DEP %'", [r.neg]).catch(() => {});
    await pool.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave = ANY($2)',
      [r.neg, ['mesero_whatsapp_shadow', 'mesero_whatsapp_v1']]).catch(() => {});
    for (const clave of ['int_wa_phone_id', 'int_wa_token']) {
      if (previo[r.neg]?.tenia?.has(clave)) {
        await actualizarConfiguracion({ [clave]: previo[r.neg].creds[clave] }, r.neg).catch(() => {});
      } else {
        await pool.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2', [r.neg, clave]).catch(() => {});
      }
    }
    if (previo[r.neg]?.reglas === null) {
      await pool.query("DELETE FROM configuracion WHERE negocio_id=$1 AND clave='reglas_atencion'", [r.neg]).catch(() => {});
    } else if (previo[r.neg]) {
      await actualizarConfiguracion({ reglas_atencion: previo[r.neg].reglas }, r.neg).catch(() => {});
    }
    await pool.query('UPDATE negocios SET bot_whatsapp_activo=$2 WHERE id=$1',
      [r.neg, previo[r.neg]?.bot ?? false]).catch(() => {});
    await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono' LIKE $2`,
      [r.neg, TEL + '%']).catch(() => {});
  }
  await pool.query('DELETE FROM whatsapp_entradas WHERE telefono LIKE $1', [TEL + '%']).catch(() => {});
  await pool.query('DELETE FROM whatsapp_conversaciones WHERE telefono LIKE $1', [TEL + '%']).catch(() => {});
  await pool.query('DELETE FROM conversacion_estado WHERE session_id LIKE $1', ['%' + TEL + '%']).catch(() => {});
  await pool.query('DELETE FROM mensajes WHERE telefono LIKE $1', [TEL + '%']).catch(() => {});
  await pool.query('DELETE FROM clientes WHERE telefono LIKE $1', [TEL + '%']).catch(() => {});
  await pool.query('DELETE FROM integraciones_canal WHERE canal=$1 AND identificador = ANY($2)',
    ['whatsapp', ROLES.map((r) => r.pnid)]).catch(() => {});
  try { srv.detener(); } catch { /* ya estaba muerto */ }
  metaMock.detener();
  anthropicMock.detener();
  await pool.end().catch(() => {});
}

console.log(`\n${fail === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${ok} pasadas, ${fail} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
process.exit(fail ? 1 : 0);
