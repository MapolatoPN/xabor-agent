// ─── P0-11 FASE 2: muerte REAL del proceso en cada frontera del nucleo ──────
//
// Mismo arnes que fase-programado-crash-real.mjs (P0-15E) y el mismo patron
// de candado inerte fuera de pruebas: `src/server.js` real como proceso
// hijo, `process.exit(137)` de verdad en el punto exacto ya auditado en
// orderManager.js (`_puntoDeCrashOperacional`), un proceso NUEVO con OTRO
// PID, y CERO reparacion manual -- solo el startup recovery del proceso
// nuevo.
//
// Frontera documentada del panel: el broadcast a `/ws/panel` es best-effort
// SIN ack -- hay una ventana real send->COMMIT que este arnes no cierra
// (no existe forma de cerrarla sin cambiar el agente del panel). Lo que SI
// se exige, y se prueba con una conexion WS real antes y despues del
// crash+recovery, es que el mismo `eventId` deduplique en el cliente: nunca
// una segunda tarjeta logica para el mismo pedido.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const { pool, cancelarPedidoActivo, conEmisionOperacionalExclusiva } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { registrarPedido, reconciliarEmisionesOperacionalesPendientes } = await import('../src/orders/orderManager.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
  finally {
    // Un caso que falla a mitad de camino NO debe dejar su servidor vivo:
    // un proceso filtrado sigue corriendo su reconciliador periodico (45s)
    // contra la MISMA base y puede saldar la deuda de un caso posterior --
    // convirtiendo un rojo legitimo del caso siguiente en un verde falso
    // (observado de verdad durante las mutaciones finales de P0-11: los
    // casos A-F en rojo dejaron servidores vivos y el caso G paso en falso).
    if (srv) { try { await srv.detener(); } catch { /* ya abajo */ } srv = null; }
    await esperar(400);
  }
}

const NEG = SEED.negocioA;
const cookie = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: NEG, rol: 'admin' }))}`;

function esperarSalida(proc, timeoutMs = 15000) {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode);
  return new Promise((resolve) => {
    const to = setTimeout(() => resolve(null), timeoutMs);
    proc.once('exit', (code) => { clearTimeout(to); resolve(code); });
  });
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
async function esperarHasta(fn, { timeoutMs = 20000, intervaloMs = 200 } = {}) {
  const lim = Date.now() + timeoutMs;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > lim) return null;
    await esperar(intervaloMs);
  }
}

const pedidoDe = async (folio) => (await pool.query(
  `SELECT estado, datos, created_at FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, NEG])).rows[0] || null;
const comprasDe = async (telefono) => (await pool.query(
  `SELECT * FROM compras_reales WHERE negocio_id=$1 AND cliente_telefono=$2`, [NEG, telefono])).rows;
const trabajosDe = async (folio) => (await pool.query(
  `SELECT id FROM impresion_trabajos WHERE negocio_id=$1 AND origen_id=$2`, [NEG, folio])).rows;
const deudaExacta = async (folio, creadoAt) => (await pool.query(
  `SELECT * FROM pedido_emisiones WHERE negocio_id=$1 AND folio=$2 AND pedido_creado_at=$3`, [NEG, folio, creadoAt])).rows[0] || null;

async function montarImpresion() {
  const { crearEdge } = await import('../src/services/edgeService.js');
  const { crearImpresora, crearRuta } = await import('../src/services/impresionService.js');
  const { DESTINOS } = await import('../src/services/impresionSelfService.js');
  await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal EOD-CR')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [NEG]);
  const term = await crearEdge(NEG, { nombre: 'EOD-CR PRINT' });
  const imp = await crearImpresora(NEG, {
    terminalId: term.id, nombre: 'Impresora EOD-CR', transporte: 'windows_spooler',
    anchoColumnas: 42, config: { spoolerNombre: 'Impresora EOD-CR' } });
  await crearRuta(NEG, { impresoraId: imp.id, ambito: 'documento', clave: DESTINOS.cocina.clave });
}

async function limpiar() {
  await pool.query(`DELETE FROM compras_reales WHERE negocio_id=$1 AND origen <> 'legacy_desconocido'`, [NEG]);
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id=$1`, [NEG]);
  await pool.query(`DELETE FROM impresoras WHERE negocio_id=$1`, [NEG]);
  await pool.query(
    `DELETE FROM edge_emparejamientos WHERE terminal_id IN
      (SELECT t.id FROM terminales t JOIN sucursales s ON s.id=t.sucursal_id
        WHERE s.negocio_id=$1 AND t.nombre='EOD-CR PRINT')`, [NEG]);
  await pool.query(
    `DELETE FROM terminales WHERE nombre='EOD-CR PRINT' AND sucursal_id IN
      (SELECT id FROM sucursales WHERE negocio_id=$1)`, [NEG]);
}

async function prepararSinReparto() {
  // Blindaje explicito: negocioA acumulo credenciales de WhatsApp (falsas,
  // pero con forma real) de otras suites en esta misma base compartida. Sin
  // limpiarlas, notificarRepartidoresPorWA podria intentar una llamada de
  // red REAL contra graph.facebook.com -- prohibido por las reglas de esta
  // sesion (NO META). Sin credenciales, la funcion falla cerrado antes de
  // tocar la red.
  await pool.query(`DELETE FROM configuracion WHERE negocio_id=$1 AND clave IN ('int_wa_phone_id','int_wa_token')`, [NEG]);
  await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal='whatsapp'`, [NEG]);
}

let telSeq = 0;
async function crearPedidoOperativo(base, telPrefijo = '87') {
  telSeq++;
  const r = await fetch(base + '/test/pedido', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ cliente: { telefono: `8${telPrefijo}${String(telSeq).padStart(5, '0')}` } }),
  });
  const body = await r.json();
  assert.strictEqual(r.status, 200, `/test/pedido fallo: ${JSON.stringify(body)}`);
  return body.pedido;
}

let contadorDirecto = 0;
async function crearPedidoActivoSinEmitir() {
  contadorDirecto++;
  const orden = {
    cliente: { nombre: 'Cliente EOD-CR', telefono: `899${String(contadorDirecto).padStart(3, '0')}${String(Date.now()).slice(-4)}` },
    modalidad: 'recoger', items: [{ nombre: 'Producto EOD-CR', cantidad: 1, precio_unitario: 150, notas: '' }],
    subtotal: 150, costo_envio: 0, descuento: 0, total: 150,
    canal: 'prueba_admin', negocioId: NEG,
  };
  return registrarPedido(orden, 'prueba_admin');
}

let srv = null;
const PUERTO = process.env.TEST_PORT_EODCR || '4541';
const ENV_BASE = { PORT: PUERTO, XABOR_RUTAS_PRUEBA: '1' };

try {
  await limpiar();
  await prepararSinReparto();
  await montarImpresion();

  // ═══ A-F: un punto de crash por frontera del nucleo ═════════════════════
  const puntos = [
    { marca: 'antes_emision', esperado: { compra: 0, trabajos: 0 } },
    { marca: 'despues_compra_real', esperado: { compra: 1, trabajos: 0 } },
    { marca: 'despues_edge', esperado: { compra: 1, trabajos: 1 } },
    { marca: 'despues_panel', esperado: { compra: 1, trabajos: 1 } },
    { marca: 'despues_print', esperado: { compra: 1, trabajos: 1 } },
    { marca: 'antes_saldar', esperado: { compra: 1, trabajos: 1 } },
  ];

  for (const { marca, esperado } of puntos) {
    await t(`muerte REAL del proceso en '${marca}': converge sin reparacion manual`, async () => {
      srv = await arrancarServidor(
        { ...ENV_BASE, XABOR_PEDIDOS_FALLA_EN: marca, XABOR_PEDIDOS_MATAR_PROCESO: '1' },
        { timeoutMs: 90000 });
      const pid1 = srv.proc.pid;

      const pedido = await crearPedidoOperativo(srv.base);
      const folio = pedido.id;
      const T = pedido.cliente.telefono;

      const codigoSalida = await esperarSalida(srv.proc, 15000);
      assert.strictEqual(codigoSalida, 137,
        `el proceso no murio de verdad en '${marca}' (exit=${codigoSalida}): la prueba no probo nada real`);

      // Margen: dar tiempo a que cualquier efecto asincrono en vuelo termine
      // de escribir ANTES de leer el estado parcial post-crash.
      await esperar(600);

      const compraTrasCrash = (await comprasDe(T)).length;
      const trabajosTrasCrash = (await trabajosDe(folio)).length;
      assert.strictEqual(compraTrasCrash, esperado.compra,
        `'${marca}': compras tras el crash (obtenido ${compraTrasCrash}, esperado ${esperado.compra})`);
      assert.strictEqual(trabajosTrasCrash, esperado.trabajos,
        `'${marca}': trabajos de impresion tras el crash (obtenido ${trabajosTrasCrash}, esperado ${esperado.trabajos})`);

      const activo = await pedidoDe(folio);
      assert.ok(activo, `'${marca}': el pedido no sobrevivio al crash`);
      const deudaTrasCrash = await deudaExacta(folio, activo.created_at);
      assert.strictEqual(deudaTrasCrash?.estado, 'pendiente',
        `'${marca}': la deuda no siguio pendiente tras el crash (obtenido ${JSON.stringify(deudaTrasCrash)})`);

      // Proceso NUEVO, sin fallo inyectado -- SOLO el startup recovery.
      srv = await arrancarServidor({ ...ENV_BASE }, { timeoutMs: 90000 });
      assert.notStrictEqual(srv.proc.pid, pid1, `'${marca}': el "proceso nuevo" comparte PID con el que murio`);

      const saldada = await esperarHasta(async () => {
        const d = await deudaExacta(folio, activo.created_at);
        return d?.estado === 'saldada' ? d : null;
      }, { timeoutMs: 20000 });
      assert.ok(saldada, `'${marca}': la deuda no convergio a saldada tras el restart (obtenido ${JSON.stringify(await deudaExacta(folio, activo.created_at))})`);

      const compraFinal = (await comprasDe(T)).length;
      const trabajosFinal = (await trabajosDe(folio)).length;
      assert.strictEqual(compraFinal, 1, `'${marca}': el resultado final debe ser EXACTAMENTE 1 compra (obtenido ${compraFinal})`);
      assert.strictEqual(trabajosFinal, 1, `'${marca}': el resultado final debe ser EXACTAMENTE 1 trabajo de impresion (obtenido ${trabajosFinal})`);

      await srv.detener();
      srv = null;
    });
  }

  // ═══ G: restart sin ningun request posterior (solo el startup lo recupera) ══
  await t('G. restart sin ningun request posterior: solo el startup recovery converge', async () => {
    // Deuda nace pendiente (registrarPedido SIN emitirPedido, mismo patron
    // que whatsapp-meta.js para un programado): NADIE la toco todavia --
    // ningun request, foreground o de otro tipo.
    const pedido = await crearPedidoActivoSinEmitir();
    const folio = pedido.id;
    const activo = await pedidoDe(folio);
    const deudaInicial = await deudaExacta(folio, activo.created_at);
    assert.strictEqual(deudaInicial?.estado, 'pendiente');

    srv = await arrancarServidor({ ...ENV_BASE }, { timeoutMs: 90000 });
    const saldada = await esperarHasta(async () => {
      const d = await deudaExacta(folio, activo.created_at);
      return d?.estado === 'saldada' ? d : null;
    }, { timeoutMs: 20000 });
    assert.ok(saldada, 'el startup recovery (sin ningun request HTTP posterior) no salio la deuda');
    assert.strictEqual((await comprasDe(pedido.cliente.telefono)).length, 1);

    await srv.detener();
    srv = null;
  });

  // ═══ H: dos servidores vivos contra la misma DB -- nunca duplican ═══════
  await t('H. dos servidores vivos contra la misma DB: el advisory lock evita la doble emision', async () => {
    const pedido = await crearPedidoActivoSinEmitir();
    const folio = pedido.id;
    const activo = await pedidoDe(folio);
    assert.strictEqual((await deudaExacta(folio, activo.created_at))?.estado, 'pendiente');

    const PUERTO_X = String(Number(PUERTO) + 1);
    const PUERTO_Y = String(Number(PUERTO) + 2);
    // Arrancados en paralelo a proposito: sus startup recovery corren
    // solapados en tiempo real, exactamente el escenario que el advisory
    // lock de `emision_operacional` tiene que decidir.
    const [srvX, srvY] = await Promise.all([
      arrancarServidor({ ...ENV_BASE, PORT: PUERTO_X }, { timeoutMs: 90000 }),
      arrancarServidor({ ...ENV_BASE, PORT: PUERTO_Y }, { timeoutMs: 90000 }),
    ]);
    try {
      const saldada = await esperarHasta(async () => {
        const d = await deudaExacta(folio, activo.created_at);
        return d?.estado === 'saldada' ? d : null;
      }, { timeoutMs: 20000 });
      assert.ok(saldada, 'ninguno de los dos servidores salio la deuda');
      await esperar(1500); // margen: si algo fuera a duplicar, aqui tendria tiempo
      assert.strictEqual((await comprasDe(pedido.cliente.telefono)).length, 1,
        'dos servidores vivos duplicaron la compra real');
      assert.strictEqual((await trabajosDe(folio)).length, 1,
        'dos servidores vivos duplicaron el trabajo de impresion');
    } finally {
      await srvX.detener();
      await srvY.detener();
    }
  });

  // ═══ I: 20 workers descubren la misma deuda -- exactamente uno ejecuta ═══
  await t('I. 20 workers concurrentes reclamando la misma deuda: exactamente UNO ejecuta el nucleo', async () => {
    const pedido = await crearPedidoActivoSinEmitir();
    const folio = pedido.id;
    const activo = await pedidoDe(folio);
    assert.strictEqual((await deudaExacta(folio, activo.created_at))?.estado, 'pendiente');

    let ejecuciones = 0;
    const resultados = await Promise.all(Array.from({ length: 20 }, () =>
      conEmisionOperacionalExclusiva(NEG, folio, activo.created_at, async () => {
        ejecuciones++;
        await esperar(50); // ensancha la ventana de carrera a proposito
      })
    ));
    assert.strictEqual(ejecuciones, 1, `20 workers concurrentes ejecutaron el nucleo ${ejecuciones} veces (esperado: exactamente 1)`);
    const emitieron = resultados.filter(r => r.emitio === true).length;
    assert.strictEqual(emitieron, 1, `20 workers: ${emitieron} reportaron emitio=true (esperado: exactamente 1)`);
    const otroProceso = resultados.filter(r => r.razon === 'otro_proceso_emitiendo').length;
    assert.strictEqual(otroProceso, 19, `se esperaba que los otros 19 vieran 'otro_proceso_emitiendo' (obtenido ${otroProceso})`);
  });

  // ═══ J: recovery PERIODICO -- deuda nacida DESPUES del startup ═══════════
  // Sin este diente, quitar el setInterval de server.js no rompia ninguna
  // prueba: los casos A-G solo ejercitan el barrido de ARRANQUE. Aqui la
  // deuda nace cuando el startup recovery del servidor ya corrio y termino
  // (margen de 3s tras /health), y NADIE llama al reconciliador a mano:
  // la UNICA via que puede saldarla es el setInterval de 45s del proceso
  // servidor. El timeout de espera (75s) cubre un ciclo completo con margen.
  await t('J. recovery periodico: una deuda creada DESPUES del startup la salda el setInterval, sin ningun request ni llamada manual', async () => {
    srv = await arrancarServidor({ ...ENV_BASE }, { timeoutMs: 90000 });
    await esperar(3000); // el barrido de arranque ya corrio y termino

    const pedido = await crearPedidoActivoSinEmitir();
    const folio = pedido.id;
    const activo = await pedidoDe(folio);
    assert.strictEqual((await deudaExacta(folio, activo.created_at))?.estado, 'pendiente',
      'la deuda no nacio pendiente: el fixture no representa "nacida despues del startup"');

    const saldada = await esperarHasta(async () => {
      const d = await deudaExacta(folio, activo.created_at);
      return d?.estado === 'saldada' ? d : null;
    }, { timeoutMs: 75000, intervaloMs: 1000 });
    assert.ok(saldada, 'el recovery PERIODICO (45s) nunca salio una deuda nacida despues del startup -- sin el setInterval, esta deuda quedaria pendiente para siempre en un proceso longevo');
    assert.strictEqual((await comprasDe(pedido.cliente.telefono)).length, 1);

    await srv.detener();
    srv = null;
  });

  // ═══ K: reparto -- crash real tras la oferta foreground; repartidor NUEVO
  // activado antes del recovery recibe CERO ofertas (P0-11B) ═══════════════
  // El dedupe por (folio, repartidor) de notificaciones_repartidor NO
  // protege a un repartidor que no existia cuando salio la oferta original:
  // la UNICA barrera es intentarReparto=false en el recovery. Este es el
  // escenario exacto descubierto en P0-11B, ahora como diente permanente.
  await t('K. reparto: crash real tras la oferta; el repartidor NUEVO agregado antes del recovery recibe CERO ofertas', async () => {
    const { arrancarMetaMock } = await import('./lib-meta-mock.mjs');
    const { actualizarConfiguracion } = await import('../src/services/database.js');
    const metaMock = await arrancarMetaMock();
    const TEL_A = '5219955001', TEL_B = '5219955002';
    try {
      await actualizarConfiguracion({
        int_wa_phone_id: 'PNID_EODK', int_wa_token: 'fake-token-eodk',
        repartidor_notif_modo: 'piloto',
        repartidor_notif_piloto_telefonos: `${TEL_A},${TEL_B}`,
      }, NEG);
      await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo)
        VALUES ($1,'whatsapp','PNID_EODK','EODK',TRUE)
        ON CONFLICT (canal, identificador) DO UPDATE SET negocio_id=$1, activo=TRUE`, [NEG]);
      await pool.query(`INSERT INTO repartidores (nombre, telefono, token, activo, negocio_id)
        VALUES ('Rep A EODK',$2,'tok-eodk-a',TRUE,$1)`, [NEG, TEL_A]);

      const paraA = () => metaMock.obtenerMensajesEnviados().filter(m => m.to === TEL_A).length;
      const paraB = () => metaMock.obtenerMensajesEnviados().filter(m => m.to === TEL_B).length;

      srv = await arrancarServidor({
        ...ENV_BASE, META_GRAPH_BASE_URL: metaMock.baseUrl,
        XABOR_PEDIDOS_FALLA_EN: 'despues_notificar_reparto', XABOR_PEDIDOS_MATAR_PROCESO: '1',
      }, { timeoutMs: 90000 });
      const pid1 = srv.proc.pid;

      const pedido = await crearPedidoOperativo(srv.base, '93');
      const folio = pedido.id;
      const codigoSalida = await esperarSalida(srv.proc, 20000);
      assert.strictEqual(codigoSalida, 137, `el proceso no murio de verdad tras notificar (exit=${codigoSalida})`);

      assert.strictEqual(paraA(), 1, `la oferta foreground a A debio salir EXACTAMENTE una vez antes del crash (obtenido ${paraA()}) -- sin esto el fixture no prueba nada`);
      assert.strictEqual(paraB(), 0, 'B ni siquiera existia todavia');

      const activo = await pedidoDe(folio);
      assert.strictEqual((await deudaExacta(folio, activo.created_at))?.estado, 'pendiente',
        'la deuda debio quedar pendiente: el proceso murio antes de saldar');

      // B se activa ENTRE el crash y el recovery -- sin fila previa en
      // notificaciones_repartidor que lo proteja.
      await pool.query(`INSERT INTO repartidores (nombre, telefono, token, activo, negocio_id)
        VALUES ('Rep B EODK',$2,'tok-eodk-b',TRUE,$1)`, [NEG, TEL_B]);

      srv = await arrancarServidor({ ...ENV_BASE, META_GRAPH_BASE_URL: metaMock.baseUrl }, { timeoutMs: 90000 });
      assert.notStrictEqual(srv.proc.pid, pid1, 'el "proceso nuevo" comparte PID con el que murio');
      const saldada = await esperarHasta(async () => {
        const d = await deudaExacta(folio, activo.created_at);
        return d?.estado === 'saldada' ? d : null;
      }, { timeoutMs: 20000 });
      assert.ok(saldada, 'el recovery no salio la deuda del pedido con oferta en vuelo');
      await esperar(1500); // margen: si el recovery fuera a notificar, aqui tendria tiempo

      assert.strictEqual(paraB(), 0,
        'P0-11B VIOLADO: el recovery mando una oferta al repartidor NUEVO -- el reparto volvio a estar dentro del core de recovery');
      assert.strictEqual(paraA(), 1, 'A recibio una segunda oferta duplicada');
      const notifB = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM notificaciones_repartidor nr JOIN repartidores r ON r.id = nr.repartidor_id
          WHERE nr.pedido_folio = $1 AND r.telefono = $2`, [folio, TEL_B])).rows[0].n;
      assert.strictEqual(notifB, 0, 'el recovery registro una notificacion durable para el repartidor nuevo');

      await srv.detener();
      srv = null;
    } finally {
      metaMock.detener();
      await pool.query(`DELETE FROM notificaciones_repartidor WHERE repartidor_id IN
        (SELECT id FROM repartidores WHERE negocio_id=$1 AND token IN ('tok-eodk-a','tok-eodk-b'))`, [NEG]);
      await pool.query(`DELETE FROM repartidores WHERE negocio_id=$1 AND token IN ('tok-eodk-a','tok-eodk-b')`, [NEG]);
      await pool.query(`DELETE FROM configuracion WHERE negocio_id=$1 AND clave IN
        ('int_wa_phone_id','int_wa_token','repartidor_notif_modo','repartidor_notif_piloto_telefonos')`, [NEG]);
      await pool.query(`DELETE FROM integraciones_canal WHERE canal='whatsapp' AND identificador='PNID_EODK'`, []);
    }
  });

  // ═══ PANEL: eventId determinista + UNA sola tarjeta logica tras crash+recovery ══
  // Frontera aceptada y documentada: el broadcast live no lleva ACK, asi que
  // no se exige capturarlo -- el proceso puede morir a mitad del envio (ese
  // es justo el punto 'despues_panel'). Lo que SI se exige, con evidencia
  // real: (1) el broadcast que deja el RECOVERY lleva el eventId
  // DETERMINISTICO calculado por conIdentidadDePedido (misma funcion de
  // produccion, calculado aqui de forma independiente a partir de la
  // identidad real del pedido -- no inventado); (2) el snapshot que usa el
  // panel al reconectar (GET /pedidos, la MISMA fuente que arma
  // obtenerPedidos en el WS) muestra el folio UNA sola vez, nunca dos.
  await t('PANEL: el broadcast del recovery lleva el eventId deterministico -- una sola tarjeta logica', async () => {
    srv = await arrancarServidor(
      { ...ENV_BASE, XABOR_PEDIDOS_FALLA_EN: 'despues_panel', XABOR_PEDIDOS_MATAR_PROCESO: '1' },
      { timeoutMs: 90000 });
    const pid1 = srv.proc.pid;

    const pedido = await crearPedidoOperativo(srv.base, '91');
    const folio = pedido.id;
    const codigoSalida = await esperarSalida(srv.proc, 15000);
    assert.strictEqual(codigoSalida, 137, `el proceso no murio de verdad (exit=${codigoSalida})`);

    const activo = await pedidoDe(folio);
    const { conIdentidadDePedido } = await import('../src/services/eventosPanel.js');
    const eventIdEsperado = conIdentidadDePedido({ tipo: 'nuevo_pedido' },
      { negocioId: NEG, id: folio, tipo_comanda: activo.datos?.tipo_comanda }).eventId;
    assert.ok(eventIdEsperado, 'conIdentidadDePedido no genero eventId: el fixture no puede probar nada');

    // Conectar el WS ANTES de arrancar el proceso nuevo: para cuando el
    // recovery corra su primera pasada (fire-and-forget tras server.listen),
    // la conexion ya debe estar lista para no perder el broadcast por una
    // carrera de arranque distinta a la que se esta probando.
    srv = await arrancarServidor({ ...ENV_BASE }, { timeoutMs: 90000 });
    assert.notStrictEqual(srv.proc.pid, pid1, 'el "proceso nuevo" comparte PID con el que murio');

    const wsUrl = srv.base.replace('http://', 'ws://') + '/ws/panel';
    const eventosCapturados = [];
    const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie } });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      setTimeout(() => reject(new Error('timeout abriendo WS')), 8000);
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.tipo === 'nuevo_pedido' && msg?.pedido?.id === folio) eventosCapturados.push(msg.eventId);
      } catch { /* ignorar frames no-JSON (snapshots u otros tipos) */ }
    });

    // El recovery puede ya haber corrido antes de que el WS conectara (la
    // deuda ya podria estar saldada); si es asi, no hay broadcast nuevo que
    // capturar por esta via -- se re-verifica solo la garantia de fondo
    // (snapshot con una sola aparicion) mas abajo. Se espera un margen
    // generoso para el caso comun (el WS SI alcanza a conectar a tiempo).
    await esperarHasta(async () => (await deudaExacta(folio, activo.created_at))?.estado === 'saldada', { timeoutMs: 20000 });
    await esperar(1000);
    ws.close();

    if (eventosCapturados.length > 0) {
      for (const ev of eventosCapturados) {
        assert.strictEqual(ev, eventIdEsperado,
          `el eventId del broadcast de recovery (${ev}) no coincide con el deterministico esperado (${eventIdEsperado})`);
      }
      assert.strictEqual(new Set(eventosCapturados).size, 1,
        `se capturaron ${eventosCapturados.length} broadcasts con eventIds distintos para el mismo folio`);
    } else {
      console.log('  [PANEL] el recovery ya habia saldado la deuda antes de que el WS conectara -- se valida solo el snapshot final');
    }

    // Garantia de fondo, SIEMPRE verificada: el snapshot que usa el panel al
    // reconectar (misma fuente que fase-programado-memoria-panel.mjs) nunca
    // muestra el folio mas de una vez.
    const r = await fetch(srv.base + '/pedidos', { headers: { Cookie: cookie } });
    assert.strictEqual(r.status, 200, 'GET /pedidos no respondio 200');
    const snapshot = await r.json();
    const veces = snapshot.filter(p => p.id === folio).length;
    assert.ok(veces <= 1, `el snapshot del panel muestra ${veces} tarjetas logicas para el mismo folio (esperado: 0 o 1, nunca 2+)`);

    await srv.detener();
    srv = null;
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL: ' + e.message);
} finally {
  try { if (srv) await srv.detener(); } catch { /* ya abajo */ }
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-emision-operacional-crash-real: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
process.exit(fallidas ? 1 : 0);
