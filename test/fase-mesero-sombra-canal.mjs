// SMOKE DEL MESERO EN SOMBRA, POR EL CANAL DE VERDAD.
//
// MS1–MS12. Entra un webhook real de Meta, sale (o no sale) lo que tenga que
// salir. Nada de llamar a `atenderTurno` a mano: lo que hay que demostrar es
// que con el bot APAGADO y el mesero en sombra, el mesero corre y el cliente no
// recibe nada — y eso solo se ve entrando por donde entra el tráfico.
//
// La carta se crea EN LA BASE, no en el archivo: la sombra tiene que usar el
// catálogo efectivo del negocio, cargado por `obtenerMenuCompleto`, igual que
// lo usaría el bot real. Una carta sintética inyectada en la integración
// probaría el mesero y no la integración.
//
// El horario se fija cerrado los siete días para que ningún caso dependa de la
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
const PUERTO = process.env.TEST_PORT_MSH || '4351';
const A = SEED.negocioA;
const B = SEED.negocioB;
const PNID_A = 'PNID_MSH_A';
const PNID_B = 'PNID_MSH_B';
const TEL = '5218811470';

const { pool, actualizarConfiguracion } = await import('../src/services/database.js');

let ok = 0, fail = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); ok++; console.log(`  OK  ${nombre}`); }
  catch (e) { fail++; fallos.push(`${nombre}: ${e.message}`); console.log(`FALLO ${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Limpieza y montaje ─────────────────────────────────────────────────────
await pool.query('DELETE FROM whatsapp_entradas WHERE telefono LIKE $1', [TEL + '%']);
await pool.query('DELETE FROM whatsapp_conversaciones WHERE telefono LIKE $1', [TEL + '%']);
await pool.query('DELETE FROM conversacion_estado WHERE session_id LIKE $1', ['%' + TEL + '%']);
await pool.query('DELETE FROM mensajes WHERE telefono LIKE $1', [TEL + '%']);
await pool.query('DELETE FROM clientes WHERE telefono LIKE $1', [TEL + '%']);
for (const neg of [A, B]) {
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono' LIKE $2`,
    [neg, TEL + '%']).catch(() => {});
  await pool.query(`DELETE FROM menu_modificadores_opciones WHERE negocio_id=$1 AND grupo_id IN
    (SELECT g.id FROM menu_modificadores_grupos g JOIN menu_productos p ON p.id=g.producto_id
     WHERE p.negocio_id=$1 AND p.nombre LIKE 'MSH %')`, [neg]);
  await pool.query(`DELETE FROM menu_modificadores_grupos WHERE negocio_id=$1 AND producto_id IN
    (SELECT id FROM menu_productos WHERE negocio_id=$1 AND nombre LIKE 'MSH %')`, [neg]);
  await pool.query("DELETE FROM menu_productos WHERE negocio_id=$1 AND nombre LIKE 'MSH %'", [neg]);
  await pool.query("DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre LIKE 'MSH %'", [neg]);
}
await pool.query('DELETE FROM integraciones_canal WHERE canal=$1 AND identificador = ANY($2)',
  ['whatsapp', [PNID_A, PNID_B]]);

/** La carta del caso frijoles, creada en la base como la de cualquier negocio. */
async function montarCarta(neg, sufijo) {
  const { rows: [cat] } = await pool.query(
    'INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,996) RETURNING id',
    [neg, `MSH Carta ${sufijo}`]);
  const { rows: [prod] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
     VALUES ($1,$2,$3,150,TRUE,0) RETURNING id`, [neg, cat.id, `MSH Chilaquiles ${sufijo}`]);
  const { rows: [grupo] } = await pool.query(
    `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
     VALUES ($1,$2,'Guarnicion',FALSE,0,1,0) RETURNING id`, [neg, prod.id]);
  for (const [i, nombre] of ['Frijoles naturales', 'Frijoles con chorizo', 'Papas naturales', 'Papas con chorizo'].entries()) {
    await pool.query(`INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, disponible, orden)
      VALUES ($1,$2,$3,TRUE,$4)`, [neg, grupo.id, nombre, i]);
  }
  await pool.query(`INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
    VALUES ($1,$2,$3,40,TRUE,1)`, [neg, cat.id, `MSH Cafe ${sufijo}`]);
  return { cat: cat.id, prod: prod.id };
}
await montarCarta(A, 'A');
await montarCarta(B, 'B');

const cerradoSiempre = {
  horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
    .map((d) => [d, { abierto: false, apertura: null, cierre: null }])),
};

// Se guarda lo de antes: estos negocios son del seed y los comparten otras suites.
const previo = {};
for (const neg of [A, B]) {
  const { rows: [r] } = await pool.query(
    "SELECT valor FROM configuracion WHERE negocio_id=$1 AND clave='reglas_atencion'", [neg]);
  const { rows: [b] } = await pool.query('SELECT bot_whatsapp_activo FROM negocios WHERE id=$1', [neg]);
  // Las credenciales de canal también: este negocio es del seed y otras suites
  // comprueban justamente que NO tenga token propio. Dejarle uno de mentira
  // hace fallar a `fase-whatsapp-invariante-activo` con un error que no se
  // parece en nada a su causa. Pasó, y por eso está escrito aquí.
  const { rows: creds } = await pool.query(
    "SELECT clave, valor FROM configuracion WHERE negocio_id=$1 AND clave IN ('int_wa_phone_id','int_wa_token')",
    [neg]);
  previo[neg] = {
    reglas: r?.valor ?? null,
    bot: b?.bot_whatsapp_activo !== false,
    creds: Object.fromEntries(creds.map((c) => [c.clave, c.valor])),
    tenia: new Set(creds.map((c) => c.clave)),
  };
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'whatsapp','activo')
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [neg]);
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado)
    VALUES ($1,'asistente_comercial_cotizaciones','no_configurado')
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='no_configurado'`, [neg]);
}

// LA CONFIGURACIÓN QUE PIDE EL ENCARGO, exacta:
//   MESERO_SHADOW_MODE=true (proceso) · mesero_whatsapp_shadow=true (negocio)
//   bot OFF · mesero_whatsapp_v1=false · pedido_reconciliador_v2=false
await actualizarConfiguracion({
  int_wa_phone_id: PNID_A, int_wa_token: 'fake-msh-a',
  modo_pedidos: 'transaccional', reglas_atencion: JSON.stringify(cerradoSiempre),
  mesero_whatsapp_shadow: 'true', mesero_whatsapp_v1: 'false',
  pedido_reconciliador_v2: 'false', pedido_shadow: 'false',
}, A);
await actualizarConfiguracion({
  int_wa_phone_id: PNID_B, int_wa_token: 'fake-msh-b',
  modo_pedidos: 'transaccional', reglas_atencion: JSON.stringify(cerradoSiempre),
  mesero_whatsapp_shadow: 'true', mesero_whatsapp_v1: 'false',
  pedido_reconciliador_v2: 'false', pedido_shadow: 'false',
}, B);
for (const [neg, pnid] of [[A, PNID_A], [B, PNID_B]]) {
  await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo)
    VALUES ($1,'whatsapp',$2,'MSH',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [neg, pnid]);
}

const metaMock = await arrancarMetaMock();
const anthropicMock = await arrancarAnthropicMock();
const srv = await arrancarServidor({
  PORT: PUERTO,
  META_GRAPH_BASE_URL: metaMock.baseUrl,
  ANTHROPIC_BASE_URL: anthropicMock.baseUrl,
  ANTHROPIC_API_KEY: 'sk-ant-test-msh',
  MESERO_SHADOW_MODE: 'true',
  PEDIDO_SHADOW_MODE: 'false',
}, { timeoutMs: 30000 });

const ponerBot = (neg, activo) => pool.query('UPDATE negocios SET bot_whatsapp_activo=$2 WHERE id=$1', [neg, activo]);
await ponerBot(A, false);
await ponerBot(B, false);

const esAcuse = (m) => m?.status === 'read';
const comunicaciones = () => metaMock.obtenerMensajesEnviados().filter((m) => !esAcuse(m));
const salida = () => srv.obtenerSalida().split(String.fromCharCode(10));
const lineasMesero = () => salida().filter((l) => l.includes('[SOMBRA-MESERO]'));
const registros = () => lineasMesero()
  .map((l) => { try { return JSON.parse(l.slice(l.indexOf('{'))); } catch { return null; } })
  .filter(Boolean);
const hashConv = (neg, tel) => createHash('sha256').update(`meta-${neg}-${tel}`).digest('hex').slice(0, 10);
const respuestasEnviadas = () => salida().filter((l) => l.includes('Respuesta enviada')).length;

let seq = 0;
/** Un turno real por el webhook. `extraer` es lo que devolvería el modelo. */
async function mandar({ tel, pnid, textos, extraer = () => ({ items: [] }) }) {
  anthropicMock.drenar();
  for (let i = 0; i < 10; i++) {
    anthropicMock.encolarRespuesta((payload) => {
      const sys = String(payload?.system || '');
      if (sys.includes('MENCIONES COMERCIALES')) return JSON.stringify({ menciones: [] });
      if (sys.includes('Extrae el pedido que el cliente')) return JSON.stringify(extraer(payload));
      return 'Buenas noches, estamos cerrados.';
    });
  }
  for (const texto of textos) {
    await fetch(srv.base + '/webhook/whatsapp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: {
          metadata: { phone_number_id: pnid },
          messages: [{ type: 'text', from: tel, id: `wamid.MSH-${Date.now()}-${seq++}`, text: { body: texto } }],
          contacts: [{ profile: { name: 'Cliente Sombra' } }],
        } }] }],
      }),
    });
    await esperar(350);
  }
  await esperar(9000);
}

/** Cero salida hacia el cliente, y el mensaje SÍ entró. */
async function silencio(etiqueta, tel) {
  const { rows } = await pool.query('SELECT 1 FROM whatsapp_entradas WHERE telefono=$1 LIMIT 1', [tel]);
  assert.ok(rows.length, `${etiqueta}: el mensaje tenía que entrar al canal`);
}

try {

// ── MS1 ─────────────────────────────────────────────────────────────────────
await t('MS1. bot OFF + mesero en sombra: el mesero corre y loguea, y el cliente no recibe NADA', async () => {
  const tel = TEL + '01';
  const com0 = comunicaciones().length, resp0 = respuestasEnviadas();
  await mandar({ tel, pnid: PNID_A, textos: ['hola, unos MSH Chilaquiles A'],
    extraer: () => ({ items: [{ nombre: 'MSH Chilaquiles A', cantidad: 1 }] }) });

  assert.equal(comunicaciones().length - com0, 0,
    `salió algo al cliente: ${JSON.stringify(comunicaciones().slice(com0)).slice(0, 300)}`);
  assert.equal(respuestasEnviadas(), resp0, 'el canal llegó a "Respuesta enviada"');
  await silencio('MS1', tel);

  const mios = registros().filter((r) => r.conv === hashConv(A, tel));
  assert.equal(mios.length >= 1, true, `el mesero no observó: ${lineasMesero().length} líneas de sombra`);
  assert.equal(mios[0].negocio, A);
  assert.deepEqual(mios[0].pedido_hipotetico.map((x) => x.n), ['MSH Chilaquiles A']);
});

// ── MS2 ─────────────────────────────────────────────────────────────────────
await t('MS2. un pedido completo NO crea pedido productivo, ni preview, ni sesión', async () => {
  const tel = TEL + '02';
  await mandar({ tel, pnid: PNID_A,
    textos: ['quiero dos MSH Chilaquiles A para recoger y pago en efectivo'],
    extraer: () => ({ items: [{ nombre: 'MSH Chilaquiles A', cantidad: 2 }],
      modalidad: 'recoger', forma_pago: 'efectivo' }) });

  const { rows: pedidos } = await pool.query(
    `SELECT folio FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono'=$2`, [A, tel]);
  assert.deepEqual(pedidos, [], `se creó un pedido productivo: ${JSON.stringify(pedidos)}`);
  const { rows: hist } = await pool.query('SELECT id FROM pedidos WHERE telefono=$1', [tel]);
  assert.deepEqual(hist, [], 'se escribió en el historial de pedidos');
  // El canal SÍ persiste la conversación —eso es de siempre y pasa con el bot
  // apagado— pero lo que no puede haber ahí dentro es nada del mesero: ni
  // carrito, ni contexto, ni modalidad, ni pago.
  const { rows: estado } = await pool.query(
    'SELECT estado FROM conversacion_estado WHERE session_id LIKE $1', ['%' + tel + '%']);
  for (const fila of estado) {
    const e = fila.estado || {};
    assert.equal(e.carrito ?? null, null, 'la sombra escribió un carrito en la sesión durable');
    assert.equal(e.contextoMesero ?? null, null, 'la sombra escribió su contexto en la sesión durable');
    assert.equal(e.previewPedido ?? null, null, 'la sombra dejó un preview productivo');
    const crudo = JSON.stringify(e);
    assert.equal(/recoger|efectivo/.test(crudo), false,
      `la sombra escribió modalidad o pago productivos: ${crudo.slice(0, 200)}`);
  }
  assert.equal(comunicaciones().filter((m) => m?.to === tel).length, 0, 'salió una respuesta');

  // Y la sombra sí vio el pedido completo, en su copia.
  const mio = registros().filter((r) => r.conv === hashConv(A, tel)).at(-1);
  assert.equal(mio.pedido_hipotetico[0].c, 2, JSON.stringify(mio.pedido_hipotetico));
});

// ── MS3 ─────────────────────────────────────────────────────────────────────
await t('MS3. una consulta de menú se observa y no se contesta', async () => {
  const tel = TEL + '03';
  const com0 = comunicaciones().length;
  await mandar({ tel, pnid: PNID_A, textos: ['¿qué MSH Carta A tienen?'] });
  assert.equal(comunicaciones().length - com0, 0, 'se contestó una consulta con el bot apagado');
  const mio = registros().filter((r) => r.conv === hashConv(A, tel)).at(-1);
  assert.ok(mio, 'no se observó la consulta');
  assert.equal(mio.intenciones.some((i) => i.startsWith('CONSULTA_')), true, JSON.stringify(mio.intenciones));
  assert.deepEqual(mio.pedido_hipotetico, [], 'una consulta metió algo al pedido hipotético');
});

// ── MS4 y MS5 ───────────────────────────────────────────────────────────────
await t('MS4. «frijoles» registra la aclaración que habría hecho, y NO elige', async () => {
  const tel = TEL + '04';
  await mandar({ tel, pnid: PNID_A, textos: ['unos MSH Chilaquiles A'],
    extraer: () => ({ items: [{ nombre: 'MSH Chilaquiles A', cantidad: 1 }] }) });
  await mandar({ tel, pnid: PNID_A, textos: ['frijoles'],
    extraer: () => ({ items: [{ nombre: 'MSH Chilaquiles A', cantidad: 1,
      modificadores: [{ grupo: 'Guarnicion', opciones: ['Frijoles naturales'] }] }] }) });

  const mio = registros().filter((r) => r.conv === hashConv(A, tel)).at(-1);
  assert.ok(mio, 'no se observó el turno');
  const amb = mio.ambiguedades.find((a) => a.tipo === 'opcion_ambigua');
  assert.ok(amb, `no se registró la ambigüedad: ${JSON.stringify(mio.ambiguedades)}`);
  assert.deepEqual(amb.candidatos.slice().sort(), ['Frijoles con chorizo', 'Frijoles naturales']);
  assert.equal(mio.aclaracion_que_haria.length >= 1, true, 'no se anotó la pregunta que habría hecho');
  assert.equal(JSON.stringify(mio.pedido_hipotetico).includes('Frijoles'), false,
    `eligió una guarnición: ${JSON.stringify(mio.pedido_hipotetico)}`);
  assert.equal(comunicaciones().filter((m) => m?.to === tel).length, 0,
    'la aclaración se ENVIÓ: en sombra solo se anota');
});

await t('MS5. «con chorizo» después resuelve el candidato correcto, en el estado sombra', async () => {
  const tel = TEL + '04';
  await mandar({ tel, pnid: PNID_A, textos: ['con chorizo'],
    extraer: () => ({ items: [{ nombre: 'MSH Chilaquiles A', cantidad: 1,
      modificadores: [{ grupo: 'Guarnicion', opciones: ['Frijoles con chorizo'] }] }] }) });

  const mio = registros().filter((r) => r.conv === hashConv(A, tel)).at(-1);
  const texto = JSON.stringify(mio.pedido_hipotetico);
  assert(texto.includes('Frijoles con chorizo'), `no resolvió: ${texto}`);
  assert.equal(texto.includes('Papas'), false, 'coló unas papas');
  assert.deepEqual(mio.ambiguedades.filter((a) => a.tipo === 'opcion_ambigua'), []);
});

// ── MS6 y MS7 ───────────────────────────────────────────────────────────────
await t('MS6. un producto que el modelo se inventa queda bloqueado, y se mide', async () => {
  const tel = TEL + '06';
  await mandar({ tel, pnid: PNID_A, textos: ['para recoger'],
    extraer: () => ({ items: [{ nombre: 'MSH Cafe A', cantidad: 3 }], modalidad: 'recoger' }) });
  const mio = registros().filter((r) => r.conv === hashConv(A, tel)).at(-1);
  assert.deepEqual(mio.pedido_hipotetico, [], `entró un producto inventado: ${JSON.stringify(mio.pedido_hipotetico)}`);
  assert.deepEqual(mio.invenciones_bloqueadas, ['MSH Cafe A'], JSON.stringify(mio.invenciones_bloqueadas));
});

await t('MS7. el modelo no puede cambiar la línea equivocada', async () => {
  const tel = TEL + '07';
  await mandar({ tel, pnid: PNID_A, textos: ['unos MSH Chilaquiles A y un MSH Cafe A'],
    extraer: () => ({ items: [{ nombre: 'MSH Chilaquiles A', cantidad: 1 }, { nombre: 'MSH Cafe A', cantidad: 1 }] }) });
  // El cliente habla del café; el modelo le sube la cantidad a los chilaquiles.
  await mandar({ tel, pnid: PNID_A, textos: ['el MSH Cafe A que sean dos'],
    extraer: () => ({ items: [{ nombre: 'MSH Chilaquiles A', cantidad: 2 }, { nombre: 'MSH Cafe A', cantidad: 1 }] }) });

  const mio = registros().filter((r) => r.conv === hashConv(A, tel)).at(-1);
  const chil = mio.pedido_hipotetico.find((x) => /Chilaquiles/.test(x.n));
  assert.equal(chil?.c, 1, `subió la cantidad del renglón equivocado: ${JSON.stringify(mio.pedido_hipotetico)}`);
  assert(mio.bloqueado.some((b) => /cantidad/.test(b)), JSON.stringify(mio.bloqueado));
});

// ── MS8 y MS9 ───────────────────────────────────────────────────────────────
await t('MS8. una excepción del mesero no afecta al canal', async () => {
  const tel = TEL + '08';
  const com0 = comunicaciones().length;
  // El extractor devuelve algo que no es JSON: el modelo del mesero revienta.
  await mandar({ tel, pnid: PNID_A, textos: ['hola'], extraer: () => 'esto no es json' });
  assert.equal(comunicaciones().length - com0, 0, 'el fallo del mesero produjo una salida al cliente');
  await silencio('MS8', tel);
  const { rows } = await pool.query(
    'SELECT requiere_revision FROM whatsapp_conversaciones WHERE telefono=$1 AND negocio_id=$2', [tel, A]);
  for (const r of rows) {
    assert.notEqual(r.requiere_revision, true,
      'un fallo de la sombra marcó la conversación para revisión humana');
  }
});

await t('MS9. sin catálogo no se observa: fail closed, y se dice por qué', async () => {
  const tel = TEL + '09';
  // Se apagan TODAS las categorías del negocio —no solo las de esta suite— para
  // que `obtenerMenuCompleto` devuelva de verdad []. Se restauran en el finally.
  const { rows: activasAntes } = await pool.query(
    'SELECT id FROM menu_categorias WHERE negocio_id=$1 AND activa=TRUE', [A]);
  await pool.query('UPDATE menu_categorias SET activa=FALSE WHERE negocio_id=$1', [A]);
  const antes = registros().length;
  const com0 = comunicaciones().length;
  try {
    await mandar({ tel, pnid: PNID_A, textos: ['unos MSH Chilaquiles A'],
      extraer: () => ({ items: [{ nombre: 'MSH Chilaquiles A', cantidad: 1 }] }) });
    assert.equal(registros().length, antes, 'se escribió un registro con la carta vacía');
    assert(salida().some((l) => l.includes('[SOMBRA-MESERO] no evaluado') && l.includes('catalogo')),
      'no quedó dicho por qué no se observó');
    assert.equal(comunicaciones().length - com0, 0);
  } finally {
    await pool.query('UPDATE menu_categorias SET activa=TRUE WHERE id = ANY($1)',
      [activasAntes.map((r) => r.id)]);
  }
});

// ── MS10 ────────────────────────────────────────────────────────────────────
await t('MS10. dos negocios intercalados: el estado sombra no se mezcla', async () => {
  const telA = TEL + '10', telB = TEL + '11';
  await mandar({ tel: telA, pnid: PNID_A, textos: ['unos MSH Chilaquiles A'],
    extraer: () => ({ items: [{ nombre: 'MSH Chilaquiles A', cantidad: 1 }] }) });
  await mandar({ tel: telB, pnid: PNID_B, textos: ['un MSH Cafe B'],
    extraer: () => ({ items: [{ nombre: 'MSH Cafe B', cantidad: 1 }] }) });
  await mandar({ tel: telA, pnid: PNID_A, textos: ['frijoles'],
    extraer: () => ({ items: [{ nombre: 'MSH Chilaquiles A', cantidad: 1,
      modificadores: [{ grupo: 'Guarnicion', opciones: ['Frijoles naturales'] }] }] }) });

  const rA = registros().filter((r) => r.conv === hashConv(A, telA));
  const rB = registros().filter((r) => r.conv === hashConv(B, telB));
  assert.equal(rA.length >= 2, true, `A observó ${rA.length} turnos`);
  assert.equal(rB.length >= 1, true, `B observó ${rB.length} turnos`);
  assert.equal(rA.every((r) => r.negocio === A), true);
  assert.equal(rB.every((r) => r.negocio === B), true);
  // Ni un producto del otro negocio en ningún pedido hipotético.
  assert.equal(JSON.stringify(rA.map((r) => r.pedido_hipotetico)).includes('MSH Cafe B'), false,
    'un producto del negocio B se coló en el pedido hipotético de A');
  assert.equal(JSON.stringify(rB.map((r) => r.pedido_hipotetico)).includes('Chilaquiles A'), false,
    'un producto del negocio A se coló en el de B');
  // Y la ambigüedad de A no aparece en B.
  assert.equal(JSON.stringify(rB).includes('Frijoles'), false, 'la carta de A contaminó a B');
});

// ── MS11 ────────────────────────────────────────────────────────────────────
await t('MS11. con el bot ENCENDIDO el mesero en sombra NO corre', async () => {
  const tel = TEL + '12';
  const antes = registros().length;
  await ponerBot(A, true);
  try {
    await mandar({ tel, pnid: PNID_A, textos: ['unos MSH Chilaquiles A'],
      extraer: () => ({ items: [{ nombre: 'MSH Chilaquiles A', cantidad: 1 }] }) });
    // El turno SÍ es productivo: el bot contesta. Eso es lo correcto, y es lo
    // que hace que la observación no tenga sentido aquí.
    assert.equal(registros().length, antes,
      'el mesero observó un turno que el bot estaba atendiendo');
    assert(salida().some((l) => l.includes('Respuesta enviada')),
      'el bot encendido tenía que contestar: si no, la prueba pasa por el motivo equivocado');
  } finally {
    await ponerBot(A, false);
  }
});

// ── MS12 ────────────────────────────────────────────────────────────────────
await t('MS12. sin la llave del proceso, el mesero en sombra no corre', async () => {
  // El servidor de esta suite arranca con MESERO_SHADOW_MODE=true, así que la
  // ausencia se comprueba donde se decide: `modoDelPedido`, con la variable
  // fuera y la del negocio puesta. Es la misma función que consulta el canal.
  const { modoDelPedido } = await import('../src/orders/modoDelPedido.js');
  const antes = process.env.MESERO_SHADOW_MODE;
  try {
    delete process.env.MESERO_SHADOW_MODE;
    const m = await modoDelPedido(A);
    assert.equal(m.meseroSombra, false, 'observó sin el interruptor del proceso');
    process.env.MESERO_SHADOW_MODE = 'true';
    const n = await modoDelPedido(A);
    assert.equal(n.meseroSombra, true, 'con las dos llaves debía observar');
    // Y el negocio sigue en LEGACY para todo lo demás: la sombra del mesero no
    // enciende V2 ni el mesero productivo.
    assert.equal(n.v2, false);
    assert.equal(n.mesero, false);
    assert.equal(n.modo, 'legacy');
  } finally {
    if (antes === undefined) delete process.env.MESERO_SHADOW_MODE;
    else process.env.MESERO_SHADOW_MODE = antes;
  }
});

// ── El registro, y lo que se podrá medir ────────────────────────────────────
await t('MS13. cada registro trae lo que hace falta para comparar después', async () => {
  const r = registros().at(-1);
  assert.ok(r, 'no hubo ni un registro');
  for (const campo of ['ts', 'conv', 'negocio', 'ms', 'llamadas_modelo', 'dijo', 'antes', 'antes_items',
    'intenciones', 'foco', 'referencia', 'propuestas', 'autorizado', 'bloqueado', 'invenciones_bloqueadas',
    'ambiguedades', 'aclaracion_que_haria', 'despues', 'pedido_hipotetico', 'falta', 'fase']) {
    assert.ok(campo in r, `al registro le falta ${campo}`);
  }
  assert.equal(typeof r.ms, 'number');
  assert.equal(r.llamadas_modelo, 1, `el mesero llamó al modelo ${r.llamadas_modelo} veces por turno`);
});

await t('MS14. el registro no lleva teléfono, correo ni el mensaje entero', async () => {
  const tel = TEL + '13';
  await mandar({ tel, pnid: PNID_A, textos: ['soy Ana, mi tel es 8781234567, mando a Hidalgo 4521'] });
  const mio = registros().filter((r) => r.conv === hashConv(A, tel)).at(-1);
  assert.ok(mio);
  const texto = JSON.stringify(mio);
  assert.equal(/8781234567|4521/.test(texto), false, `se filtró un número: ${mio.dijo}`);
  assert.equal(/\d{7,}/.test(texto), false, 'quedó una racha de dígitos larga');
  assert.equal(mio.conv.length, 10, 'la conversación no está hasheada');
});

} finally {
  // Se devuelve todo como estaba: estos negocios los comparten otras suites.
  for (const neg of [A, B]) {
    await pool.query(`DELETE FROM menu_modificadores_opciones WHERE negocio_id=$1 AND grupo_id IN
      (SELECT g.id FROM menu_modificadores_grupos g JOIN menu_productos p ON p.id=g.producto_id
       WHERE p.negocio_id=$1 AND p.nombre LIKE 'MSH %')`, [neg]).catch(() => {});
    await pool.query(`DELETE FROM menu_modificadores_grupos WHERE negocio_id=$1 AND producto_id IN
      (SELECT id FROM menu_productos WHERE negocio_id=$1 AND nombre LIKE 'MSH %')`, [neg]).catch(() => {});
    await pool.query("DELETE FROM menu_productos WHERE negocio_id=$1 AND nombre LIKE 'MSH %'", [neg]).catch(() => {});
    await pool.query("DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre LIKE 'MSH %'", [neg]).catch(() => {});
    await pool.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave = ANY($2)',
      [neg, ['mesero_whatsapp_shadow', 'mesero_whatsapp_v1']]).catch(() => {});
    for (const clave of ['int_wa_phone_id', 'int_wa_token']) {
      if (previo[neg]?.tenia?.has(clave)) {
        await actualizarConfiguracion({ [clave]: previo[neg].creds[clave] }, neg).catch(() => {});
      } else {
        await pool.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2', [neg, clave]).catch(() => {});
      }
    }
    if (previo[neg]?.reglas === null) {
      await pool.query("DELETE FROM configuracion WHERE negocio_id=$1 AND clave='reglas_atencion'", [neg]).catch(() => {});
    } else if (previo[neg]) {
      await actualizarConfiguracion({ reglas_atencion: previo[neg].reglas }, neg).catch(() => {});
    }
    await ponerBot(neg, previo[neg]?.bot ?? false).catch(() => {});
  }
  await pool.query('DELETE FROM whatsapp_entradas WHERE telefono LIKE $1', [TEL + '%']).catch(() => {});
  await pool.query('DELETE FROM whatsapp_conversaciones WHERE telefono LIKE $1', [TEL + '%']).catch(() => {});
  await pool.query('DELETE FROM mensajes WHERE telefono LIKE $1', [TEL + '%']).catch(() => {});
  await pool.query('DELETE FROM clientes WHERE telefono LIKE $1', [TEL + '%']).catch(() => {});
  await pool.query('DELETE FROM integraciones_canal WHERE canal=$1 AND identificador = ANY($2)',
    ['whatsapp', [PNID_A, PNID_B]]).catch(() => {});
  try { srv.detener(); } catch { /* ya estaba muerto */ }
  metaMock.detener();
  anthropicMock.detener();
  await pool.end().catch(() => {});
}

console.log(`\n${fail === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${ok} pasadas, ${fail} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
process.exit(fail ? 1 : 0);
