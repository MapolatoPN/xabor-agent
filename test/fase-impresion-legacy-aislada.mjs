// ─── La salida segura del camino de impresión legado ───────────────────────
//
// El agente viejo (anterior a /ws/print-agent) se conecta a la raíz "/" y no
// manda ninguna identidad. Durante mucho tiempo eso significó tres cosas, todas
// documentadas en el propio código como deuda:
//
//   · al conectarse recibía el tablero COMPLETO de TODOS los negocios;
//   · ese volcado no llevaba printJobId, así que nada podía deduplicarlo;
//   · y el agente viejo imprime cuanto le llega -- cada reconexión reimprimía
//     todo lo activo, incluidos pedidos de otros negocios.
//
// Esta suite fija el comportamiento nuevo: la conexión pertenece a UN negocio
// resuelto por el servidor, recibe solo SUS trabajos pendientes, cada uno con
// printJobId, y nunca dos veces.
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const A = SEED.negocioA;
const B = SEED.negocioB;
const USUARIO = SEED.adminNegocioAUsuarioId;
const cookie = (negocioId) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: USUARIO, negocioId, rol: 'admin' }))}`;
const COOKIE_A = cookie(A);
const COOKIE_B = cookie(B);
const PUERTO = String(process.env.TEST_PORT_LEGACY || 4261);
const base = `http://localhost:${PUERTO}`;
const wsBase = base.replace('http://', 'ws://');

// Probar que algo NO llega exige esperar un poco: no hay evento de "ya no va a
// llegar nada". Es sincronización de la prueba, no del producto.
const asentar = (ms = 600) => new Promise(r => setTimeout(r, ms));

function abrirLegacy() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + '/');
    const to = setTimeout(() => reject(new Error('timeout abriendo WS legado')), 8000);
    ws.recibidos = [];
    ws.on('message', (raw) => {
      let d; try { d = JSON.parse(raw.toString()); } catch { return; }
      ws.recibidos.push(d);
    });
    ws.on('open', () => { clearTimeout(to); resolve(ws); });
    ws.on('unexpected-response', (_req, res) => { clearTimeout(to); reject(new Error(`upgrade rechazado ${res.statusCode}`)); });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

// Cierra y espera de verdad: reconectar antes de que el servidor procese el
// cierre haría que la prueba midiera dos conexiones vivas, no una reconexión.
function cerrar(ws) {
  return new Promise((resolve) => { ws.on('close', resolve); ws.close(); });
}

async function crearPedido(cookieNegocio) {
  const r = await fetch(`${base}/test/pedido`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieNegocio },
    body: JSON.stringify({}),
  });
  const cuerpo = await r.json().catch(() => ({}));
  assert.strictEqual(r.status, 200, `no se creó el pedido: ${JSON.stringify(cuerpo)}`);
  return cuerpo.pedido.id;
}

const comandasDe = (ws, folio) =>
  ws.recibidos.filter(d => d.tipo === 'nuevo_pedido' && d.pedido?.id === folio);

async function filaLegacy(negocioId, folio) {
  const { rows: [r] } = await pool.query(
    `SELECT estado, destinatarios FROM impresion_legacy_emitida
      WHERE negocio_id = $1 AND print_job_id = $2`, [negocioId, `${folio}:comanda`]);
  return r || null;
}

async function modoLegacy(negocioId, activo) {
  if (activo) {
    await pool.query(
      `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'print_agent_legacy_activo','true')
       ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = 'true'`, [negocioId]);
  } else {
    await pool.query(
      `DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'print_agent_legacy_activo'`, [negocioId]);
  }
}

async function limpiar() {
  for (const n of [A, B]) {
    await pool.query(`DELETE FROM impresion_legacy_emitida WHERE negocio_id = $1`, [n]).catch(() => {});
    await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id = $1`, [n]).catch(() => {});
    await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id = $1`, [n]).catch(() => {});
    await pool.query(`DELETE FROM impresoras WHERE negocio_id = $1`, [n]).catch(() => {});
    await pool.query(
      `DELETE FROM terminales WHERE sucursal_id IN (SELECT id FROM sucursales WHERE negocio_id = $1)`,
      [n]).catch(() => {});
    await pool.query(
      `DELETE FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'canal' = 'prueba_admin'`, [n]);
  }
  await modoLegacy(A, false);
  await modoLegacy(B, false);
}

// El seed de arranque (initDB) deja a Nonna Maye en modo legado -- es el negocio
// real que todavía no migra a Edge. Para esta suite se aparta temporalmente:
// si no, habría DOS candidatos y el servidor rechazaría toda conexión, que es
// justo lo que prueba el caso 6a. Se restaura al final.
let legadoNonnaOriginal = null;
async function apartarLegadoNonna() {
  const { rows } = await pool.query(
    `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'print_agent_legacy_activo'`,
    [SEED.nonnaMayeId]);
  legadoNonnaOriginal = rows[0]?.valor ?? null;
  await pool.query(
    `DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'print_agent_legacy_activo'`,
    [SEED.nonnaMayeId]);
}
async function restaurarLegadoNonna() {
  if (legadoNonnaOriginal === null) return;
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'print_agent_legacy_activo',$2)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`,
    [SEED.nonnaMayeId, legadoNonnaOriginal]);
}

// Edge montado para B: sirve para probar que un negocio con Edge activo jamás
// toca el camino legado, ni siquiera con un agente legado conectado al lado.
async function montarEdge(negocioId) {
  const { crearEdge } = await import('../src/services/edgeService.js');
  const { crearImpresora, crearRuta } = await import('../src/services/impresionService.js');
  const { DESTINOS } = await import('../src/services/impresionSelfService.js');
  const { rows: [suc] } = await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true RETURNING id`, [negocioId]);
  const term = await crearEdge(negocioId, { nombre: 'PC LEGACY TEST' });
  const imp = await crearImpresora(negocioId, {
    terminalId: term.id, nombre: 'Impresora legacy test', transporte: 'windows_spooler',
    anchoColumnas: 42, config: { spoolerNombre: 'Impresora legacy test' },
  });
  await crearRuta(negocioId, { impresoraId: imp.id, ambito: 'documento', clave: DESTINOS.cocina.clave });
  return suc.id;
}

let srv = null;
try {
  await limpiar();
  // El usuario de pruebas necesita ser admin de los DOS negocios para poder
  // crear un pedido en cada uno por el camino real.
  await pool.query(
    `INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,'admin',TRUE)
     ON CONFLICT (usuario_id, negocio_id) DO UPDATE SET rol='admin', activo=TRUE`, [USUARIO, B]);
  for (const n of [A, B]) {
    await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'pos','activo')
      ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [n]);
  }
  await montarEdge(B);          // B imprime por Edge
  await modoLegacy(A, true);    // A es el único negocio legado

  srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 90000 });
  // DESPUES de arrancar: initDB() vuelve a sembrar el modo legado de Nonna Maye
  // en cada arranque, asi que apartarlo antes no serviria de nada. Que lo
  // resiembre confirma que ese negocio es el legado por diseño, no por descuido.
  await apartarLegadoNonna();

  // ─── 1. Aislamiento entre negocios ───
  await t('1. el agente legado de A JAMÁS recibe un pedido de B', async () => {
    const ws = await abrirLegacy();
    await asentar(400);
    const folioB = await crearPedido(COOKIE_B);
    const folioA = await crearPedido(COOKIE_A);
    await asentar();
    await cerrar(ws);

    assert.strictEqual(comandasDe(ws, folioB).length, 0,
      `¡FUGA ENTRE NEGOCIOS! el agente de A recibió el pedido ${folioB} de B`);
    assert.strictEqual(comandasDe(ws, folioA).length, 1,
      `el agente de A debía recibir su propio pedido exactamente una vez`);
    const [msg] = comandasDe(ws, folioA);
    assert.strictEqual(msg.printJobId, `${folioA}:comanda`, 'llegó sin printJobId determinista');
    assert.strictEqual(msg.tipoDocumento, 'comanda');
  });

  // ─── 2. Reconexión no reimprime ───
  await t('2. un pedido ya entregado NO se vuelve a mandar al reconectar', async () => {
    const ws1 = await abrirLegacy();
    await asentar(400);
    const folio = await crearPedido(COOKIE_A);
    await asentar();
    assert.strictEqual(comandasDe(ws1, folio).length, 1, 'no llegó en vivo');
    assert.strictEqual((await filaLegacy(A, folio))?.estado, 'entregado');
    await cerrar(ws1);

    const ws2 = await abrirLegacy();
    await asentar();
    await cerrar(ws2);
    assert.strictEqual(comandasDe(ws2, folio).length, 0,
      '¡PAPEL DUPLICADO! la reconexión volvió a mandar una comanda ya entregada');
  });

  // ─── 3. Un pedido creado sin agente conectado NO se pierde ───
  await t('3. pedido creado con el agente desconectado → queda pendiente y llega al reconectar', async () => {
    const folio = await crearPedido(COOKIE_A);   // nadie escuchando
    await asentar();
    const fila = await filaLegacy(A, folio);
    assert.ok(fila, 'no quedó registro del trabajo');
    assert.strictEqual(fila.estado, 'pendiente',
      'el trabajo se dio por entregado sin que hubiera nadie conectado: se habría perdido');
    assert.strictEqual(fila.destinatarios, 0);

    const ws = await abrirLegacy();
    await asentar();
    await cerrar(ws);
    const recibidas = comandasDe(ws, folio);
    assert.strictEqual(recibidas.length, 1, `esperaba 1 comanda al reconectar, llegaron ${recibidas.length}`);
    assert.strictEqual(recibidas[0].printJobId, `${folio}:comanda`, 'el pendiente llegó sin printJobId');
    assert.strictEqual((await filaLegacy(A, folio))?.estado, 'entregado');
  });

  // ─── 4. Cinco reconexiones, una sola impresión ───
  await t('4. cinco reconexiones más → ni una comanda extra', async () => {
    const folio = await crearPedido(COOKIE_A);   // sin agente: queda pendiente
    await asentar();
    let total = 0;
    for (let i = 0; i < 6; i++) {
      const ws = await abrirLegacy();
      await asentar(500);
      total += comandasDe(ws, folio).length;
      await cerrar(ws);
    }
    assert.strictEqual(total, 1, `el folio ${folio} se mandó ${total} veces en seis conexiones`);
  });

  // ─── 5. Edge de otro negocio en paralelo ───
  await t('5. con Edge de B activo, el agente legado de A no ve nada de B', async () => {
    const ws = await abrirLegacy();
    await asentar(400);
    const folioB = await crearPedido(COOKIE_B);
    await asentar();
    await cerrar(ws);

    assert.strictEqual(comandasDe(ws, folioB).length, 0, 'el agente legado de A vio un trabajo de B');
    assert.strictEqual(await filaLegacy(B, folioB), null,
      'B pasó por el camino legado teniendo Edge configurado');
    const { rows: [tr] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM impresion_trabajos
        WHERE negocio_id = $1 AND origen_tipo = 'pedido' AND origen_id = $2`, [B, folioB]);
    assert.strictEqual(tr.n, 1, 'Edge de B no generó su trabajo');
  });

  // ─── 6. Fail closed sin identidad inequívoca ───
  await t('6a. con DOS negocios en modo legado, la conexión se rechaza', async () => {
    await modoLegacy(B, true);
    try {
      const ws = await abrirLegacy();
      await cerrar(ws);
      assert.fail('la conexión legada fue ACEPTADA con dos negocios candidatos');
    } catch (e) {
      assert.ok(/upgrade rechazado 403/.test(e.message), `esperaba 403, dio: ${e.message}`);
    } finally {
      await modoLegacy(B, false);
    }
  });

  await t('6b. sin NINGÚN negocio en modo legado, la ruta "/" se cierra sola', async () => {
    await modoLegacy(A, false);
    try {
      const ws = await abrirLegacy();
      await cerrar(ws);
      assert.fail('la conexión legada fue ACEPTADA sin ningún negocio legado');
    } catch (e) {
      assert.ok(/upgrade rechazado 403/.test(e.message), `esperaba 403, dio: ${e.message}`);
    } finally {
      await modoLegacy(A, true);
    }
  });

  await t('6c. ya no existe ninguna vía para volcar los pedidos de todos los negocios', async () => {
    // El volcado global era la causa raíz. Se comprueba que la función que lo
    // hacía ya no existe, no solo que nadie la llame hoy.
    const om = await import('../src/orders/orderManager.js');
    assert.strictEqual(om.obtenerTodosPedidosParaWebSocketLegacy, undefined,
      'obtenerTodosPedidosParaWebSocketLegacy sigue exportada');
    const fuente = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.ok(!/obtenerTodosPedidosParaWebSocketLegacy/.test(fuente),
      'server.js todavía menciona el volcado global');
    assert.ok(!/MULTIEMPRESA INSEGURO/.test(fuente),
      'server.js todavía declara una ruta multiempresa insegura');
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++;
} finally {
  if (srv) { try { await srv.detener(); } catch {} }
  await limpiar().catch(() => {});
  await restaurarLegadoNonna().catch(() => {});
  await pool.query(`DELETE FROM usuario_negocios WHERE usuario_id = $1 AND negocio_id = $2`,
    [USUARIO, B]).catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-impresion-legacy-aislada: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log('  · ' + f)); }
process.exit(fallidas ? 1 : 0);
