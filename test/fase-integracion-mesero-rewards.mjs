// ─── Convivencia: Mesero Shadow (WhatsApp) + Rewards (tienda online) ──────
//
// POR QUÉ EXISTE ESTA SUITE: los dos módulos se despliegan juntos por primera
// vez. Cada uno tiene su propia batería y las dos pasan; lo que nadie había
// probado es que no se estorben. La pregunta no es «¿funciona Rewards?» ni
// «¿funciona el Mesero?», es «¿puede Obispado tener el bot APAGADO, el Mesero
// observando en sombra y Rewards cobrando en la tienda, los tres a la vez, sin
// que uno mueva al otro?».
//
// Lo que se afirma aquí es DEMOSTRABLE sin red y sin modelo: los dos sistemas
// se tocan (si acaso) a través de tres sitios compartidos -- la tabla
// `configuracion` del negocio, la memoria del proceso y el catálogo -- y esta
// suite los vigila uno por uno.
//
// I1..I10 del plan de integración. Uso: mismas env vars que la batería.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

const { pool } = await import('../src/services/database.js');
const { modoDelPedido, CLAVE_MESERO, CLAVE_MESERO_SOMBRA, CLAVE_V2, CLAVE_SHADOW } =
  await import('../src/orders/modoDelPedido.js');
const { observarTurnoDelMesero, reiniciarSombraMesero, conversacionesObservadas, verEstadoSombra } =
  await import('../src/mesero-whatsapp/sombraDelMesero.js');
const { rewardsDeTienda, saldoParaTienda, planDeCanje } =
  await import('../src/services/tiendaRewards.js');
const { actualizarConfig, obtenerConfig, acumularPuntos } =
  await import('../src/services/rewardsService.js');

// Esta suite reproduce el ENTORNO DEL DESPLIEGUE, no un laboratorio: la sombra
// del Mesero solo corre si el proceso trae MESERO_SHADOW_MODE=true (dos llaves:
// la del proceso y la del negocio). Sin esa variable las afirmaciones sobre la
// sombra serían vacías -- pasarían por no haber nada que observar --, así que
// se para antes de mentir.
if (String(process.env.MESERO_SHADOW_MODE || '').toLowerCase() !== 'true') {
  console.error('Esta suite exige MESERO_SHADOW_MODE=true (la llave del proceso que usa ' +
    'el despliegue). Sin ella la sombra nunca corre y las pruebas no probarían nada.');
  process.exit(1);
}

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(id, nombre, fn) {
  try { await fn(); console.log(`  OK  [${id}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${id}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${id}] ${nombre}: ${e.message}`); }
}

// Tres negocios que imitan el reparto real del despliegue.
const OBISPADO = SEED.negocioA;   // bot OFF + Mesero sombra + Rewards tienda
const ACUNA    = SEED.negocioB;   // LEGACY puro
const NONNA    = SEED.negocioC;   // LEGACY puro
const TODOS = [OBISPADO, ACUNA, NONNA];

const cfgDe = async (negocioId, clave) => (await pool.query(
  `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2`,
  [negocioId, clave])).rows[0]?.valor ?? null;

const ponerCfg = (negocioId, clave, valor) => pool.query(
  `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)
   ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $3`, [negocioId, clave, valor]);

const quitarCfg = (negocioId, clave) => pool.query(
  `DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2`, [negocioId, clave]);

async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}

// Retrato COMPLETO de los flags del Mesero de un negocio. Sirve para afirmar
// "nada se movió" comparando dos retratos, en vez de mirar un flag suelto.
async function retratoMesero(negocioId) {
  const modo = await modoDelPedido(negocioId);
  return {
    modo,
    flags: {
      [CLAVE_MESERO]: await cfgDe(negocioId, CLAVE_MESERO),
      [CLAVE_MESERO_SOMBRA]: await cfgDe(negocioId, CLAVE_MESERO_SOMBRA),
      [CLAVE_V2]: await cfgDe(negocioId, CLAVE_V2),
      [CLAVE_SHADOW]: await cfgDe(negocioId, CLAVE_SHADOW),
      bot_activo: await cfgDe(negocioId, 'bot_activo'),
    },
    conversacionesEnSombra: conversacionesObservadas(),
  };
}

// Un turno de sombra REAL: mismo `observarTurnoDelMesero` que llama el canal,
// con catalogo y extractor inyectados para no tocar red ni modelo. Es el
// camino de produccion, no una imitacion: si el Mesero contaminara algo, lo
// contaminaria aqui.
const CATALOGO = [{ id: 1, nombre: 'INT Chilaquiles', precio: 120, categoria: 'Desayunos' }];
const turnoDeSombra = (negocioId, sessionId, mensaje = 'unos chilaquiles') =>
  observarTurnoDelMesero({
    sessionId, negocioId, mensaje,
    cargarCatalogo: async () => CATALOGO,
    proponer: async () => ({ items: [{ nombre: 'INT Chilaquiles', cantidad: 1 }] }),
  });

const suf = Date.now().toString().slice(-6);
const TEL = `77${suf}01`;

async function limpiar() {
  for (const n of TODOS) {
    for (const c of [CLAVE_MESERO, CLAVE_MESERO_SOMBRA, CLAVE_V2, CLAVE_SHADOW]) await quitarCfg(n, c).catch(() => {});
    await pool.query(`DELETE FROM rewards_movements WHERE tenant_id = $1`, [n]).catch(() => {});
    await pool.query(`DELETE FROM rewards_accounts WHERE tenant_id = $1`, [n]).catch(() => {});
    await pool.query(`DELETE FROM rewards_config WHERE tenant_id = $1`, [n]).catch(() => {});
  }
  await pool.query(`DELETE FROM clientes WHERE telefono = $1`, [TEL]).catch(() => {});
  reiniciarSombraMesero();
}

// ═══════════════════════════════════════════════════════════════════════════
try {
  await limpiar();
  // Reparto del despliegue: solo Obispado lleva banderas.
  await fijarModulo(OBISPADO, 'rewards', 'activo');
  await fijarModulo(OBISPADO, 'tienda_online', 'activo');
  await ponerCfg(OBISPADO, CLAVE_MESERO_SOMBRA, 'true');
  await ponerCfg(OBISPADO, 'bot_activo', 'false');

  // ── I1: un turno de Mesero Shadow no toca Rewards ────────────────────────
  await t('I1', 'un turno observado en sombra no crea cuentas, movimientos ni config de Rewards', async () => {
    const antes = {
      cuentas: (await pool.query(`SELECT count(*)::int n FROM rewards_accounts WHERE tenant_id=$1`, [OBISPADO])).rows[0].n,
      movs: (await pool.query(`SELECT count(*)::int n FROM rewards_movements WHERE tenant_id=$1`, [OBISPADO])).rows[0].n,
      cfg: await obtenerConfig(OBISPADO),
    };
    // Un turno observado DE VERDAD, por el mismo camino que el canal.
    const obs = await turnoDeSombra(OBISPADO, `meta-${OBISPADO}-${TEL}`);
    assert.ok(obs && obs.ok !== undefined, 'la sombra no respondio');
    assert.ok(conversacionesObservadas() > 0, 'la sombra no observo nada: el fixture no prueba nada');

    const despues = {
      cuentas: (await pool.query(`SELECT count(*)::int n FROM rewards_accounts WHERE tenant_id=$1`, [OBISPADO])).rows[0].n,
      movs: (await pool.query(`SELECT count(*)::int n FROM rewards_movements WHERE tenant_id=$1`, [OBISPADO])).rows[0].n,
      cfg: await obtenerConfig(OBISPADO),
    };
    assert.deepStrictEqual(despues, antes, 'el Mesero en sombra movió algo de Rewards');
    assert.strictEqual(despues.cfg, null, 'apareció configuración de Rewards de la nada');
  });

  // ── I2: una compra de tienda no toca el estado de la sombra ──────────────
  await t('I2', 'acumular puntos de una venta de tienda no toca estadoMeseroSombra', async () => {
    await actualizarConfig(OBISPADO, { nombre_programa: 'Obispado Rewards', activo: true, canal_tienda: true });
    await turnoDeSombra(OBISPADO, `meta-${OBISPADO}-i2`);
    const antesTamano = conversacionesObservadas();
    const antesEstado = JSON.stringify(verEstadoSombra(OBISPADO, `meta-${OBISPADO}-i2`));

    const r = await acumularPuntos(`INT-${suf}-1`, {
      total: 300, canal: 'tienda_online', cliente: { telefono: TEL, nombre: 'Cliente Int' },
    }, OBISPADO);
    assert.ok(r && r.puntos > 0, 'la venta de tienda no acreditó (¿integración rota?)');

    assert.strictEqual(conversacionesObservadas(), antesTamano,
      'la compra cambió cuántas conversaciones se observan');
    assert.strictEqual(JSON.stringify(verEstadoSombra(OBISPADO, `meta-${OBISPADO}-i2`)), antesEstado,
      'la compra alteró el estado observado de una conversación');
  });

  // ── I3: guardar rewards_config no mueve ninguna bandera del Mesero ───────
  await t('I3', 'guardar rewards_config no cambia mesero_whatsapp_shadow, v1, v2 ni el bot', async () => {
    const antes = await retratoMesero(OBISPADO);
    await actualizarConfig(OBISPADO, {
      nombre_programa: 'Otro nombre', monto_por_punto: 25, canje_minimo: 50, canal_tienda: true });
    const despues = await retratoMesero(OBISPADO);
    assert.deepStrictEqual(despues.flags, antes.flags, 'guardar Rewards movió una bandera del Mesero');
    assert.deepStrictEqual(despues.modo, antes.modo, 'guardar Rewards cambió modoDelPedido');
  });

  // ── I4: encender canal_tienda no enciende el Mesero ──────────────────────
  await t('I4', 'activar canal_tienda deja el Mesero exactamente donde estaba', async () => {
    await actualizarConfig(OBISPADO, { canal_tienda: false });
    const antes = await retratoMesero(OBISPADO);
    await actualizarConfig(OBISPADO, { canal_tienda: true });
    const despues = await retratoMesero(OBISPADO);

    assert.strictEqual((await obtenerConfig(OBISPADO)).canal_tienda, true, 'no se encendió el canal');
    assert.deepStrictEqual(despues.flags, antes.flags, 'encender la tienda tocó una bandera del Mesero');
    assert.strictEqual(despues.modo.mesero, antes.modo.mesero);
    assert.strictEqual(despues.modo.meseroSombra, antes.modo.meseroSombra);
  });

  // ── I5: configurar el Mesero Shadow no enciende Rewards ──────────────────
  await t('I5', 'encender/apagar mesero_whatsapp_shadow no toca la configuración de Rewards', async () => {
    const antes = await obtenerConfig(OBISPADO);
    const rwAntes = await rewardsDeTienda(OBISPADO);
    await ponerCfg(OBISPADO, CLAVE_MESERO_SOMBRA, 'false');
    await ponerCfg(OBISPADO, CLAVE_MESERO_SOMBRA, 'true');
    await ponerCfg(OBISPADO, CLAVE_MESERO, 'true');   // incluso el v1
    try {
      const despues = await obtenerConfig(OBISPADO);
      assert.deepStrictEqual(
        { ...despues, updated_at: null }, { ...antes, updated_at: null },
        'tocar el Mesero cambió rewards_config');
      const rwDespues = await rewardsDeTienda(OBISPADO);
      assert.strictEqual(rwDespues.activo, rwAntes.activo, 'tocar el Mesero cambió si Rewards está activo en tienda');
    } finally { await quitarCfg(OBISPADO, CLAVE_MESERO); }
  });

  // ── I6: Acuña y Nonna siguen LEGACY con Rewards vivo en el proceso ───────
  await t('I6', 'Acuña y Nonna siguen LEGACY aunque Rewards exista en el mismo proceso', async () => {
    for (const [etq, neg] of [['Acuña', ACUNA], ['Nonna', NONNA]]) {
      const modo = await modoDelPedido(neg);
      assert.strictEqual(modo.modo, 'legacy', `${etq} dejó de ser legacy: ${modo.modo}`);
      assert.strictEqual(modo.mesero, false, `${etq} tiene el Mesero encendido`);
      assert.strictEqual(modo.meseroSombra, false, `${etq} está observando en sombra`);
      assert.strictEqual(modo.v2, false, `${etq} tiene V2 encendido`);
      // Y Rewards tampoco se les enciende de rebote.
      const rw = await rewardsDeTienda(neg);
      assert.strictEqual(rw.activo, false, `${etq} tiene Rewards de tienda encendido sin pedirlo`);
    }
  });

  // ── I7: los tres estados a la vez en Obispado ────────────────────────────
  await t('I7', 'Obispado: bot OFF + Mesero Sombra ON + Rewards tienda ON, los tres a la vez', async () => {
    const modo = await modoDelPedido(OBISPADO);
    const rw = await rewardsDeTienda(OBISPADO);
    assert.strictEqual(await cfgDe(OBISPADO, 'bot_activo'), 'false', 'el bot no está apagado');
    assert.strictEqual(await cfgDe(OBISPADO, CLAVE_MESERO_SOMBRA), 'true', 'la sombra no está encendida');
    assert.strictEqual(modo.mesero, false, 'el Mesero PRODUCTIVO está encendido: no debe estarlo');
    assert.strictEqual(rw.activo, true, 'Rewards de tienda no quedó activo');
    // Y el saldo de la tienda responde con el programa encendido.
    const saldo = await saldoParaTienda(OBISPADO, TEL, 300);
    assert.strictEqual(saldo.activo, true);
    assert.ok(saldo.puntos > 0, 'el cliente que compró en I2 debería tener saldo');
  });

  // ── I8: un error de Rewards no rompe el canal de WhatsApp ────────────────
  await t('I8', 'un fallo de Rewards no impide leer el modo del pedido ni observar en sombra', async () => {
    // Se rompe Rewards de la forma más cruda posible: el módulo deja de estar
    // contratado a media operación. Rewards debe fallar CERRADO y el canal de
    // WhatsApp no debe enterarse siquiera.
    await fijarModulo(OBISPADO, 'rewards', 'no_contratado');
    try {
      const rw = await rewardsDeTienda(OBISPADO);
      assert.strictEqual(rw.activo, false, 'Rewards debe fallar cerrado');

      const modo = await modoDelPedido(OBISPADO);
      assert.strictEqual(modo.meseroSombra, true, 'el canal perdió la sombra por un fallo de Rewards');
      // Y la acumulación devuelve null sin lanzar: el hook del pedido es
      // fire-and-forget y no puede tumbar nada.
      const r = await acumularPuntos(`INT-${suf}-2`, {
        total: 300, canal: 'tienda_online', cliente: { telefono: TEL } }, OBISPADO);
      assert.strictEqual(r, null, 'acumuló sin módulo contratado');
    } finally { await fijarModulo(OBISPADO, 'rewards', 'activo'); }
  });

  // ── I9: un error del Mesero Shadow no rompe el checkout de la tienda ─────
  await t('I9', 'con el estado de la sombra reventado, el canje de la tienda sigue calculándose', async () => {
    // Se revienta la sombra por donde de verdad se rompe: el extractor lanza
    // y el catalogo falla. Es lo que pasaria con el proveedor caido.
    const roto1 = await observarTurnoDelMesero({
      sessionId: `meta-${OBISPADO}-roto`, negocioId: OBISPADO, mensaje: 'algo',
      cargarCatalogo: async () => { throw new Error('catalogo caido'); },
      proponer: () => { throw new Error('extractor explotado'); } });
    assert.strictEqual(roto1.ok, false, 'la sombra debia fallar cerrada, no propagar');
    const roto2 = await observarTurnoDelMesero({
      sessionId: `meta-${OBISPADO}-roto2`, negocioId: OBISPADO, mensaje: 'algo',
      cargarCatalogo: async () => CATALOGO,
      proponer: () => { throw new Error('extractor explotado'); } });
    assert.ok(roto2, 'la sombra no devolvio nada tras el fallo del extractor');
    try {
      const rw = await rewardsDeTienda(OBISPADO);
      assert.strictEqual(rw.activo, true, 'la tienda perdió Rewards por un estado corrupto del Mesero');
      const saldo = await saldoParaTienda(OBISPADO, TEL, 300);
      assert.strictEqual(saldo.activo, true);
      const plan = await planDeCanje({ negocioId: OBISPADO, telefono: TEL, puntosSolicitados: 50, total: 300 });
      // El plan puede ser null por saldo insuficiente, pero NO por una excepción.
      assert.ok(plan === null || plan.puntos > 0, 'el canje se rompió por culpa del Mesero');
    } finally { reiniciarSombraMesero(); }
  });

  // ── I10: no se contaminan catálogo, cliente ni configuración ─────────────
  await t('I10', 'la sombra no escribe en pedidos, clientes ni menú', async () => {
    const cuenta = async (sql, p) => (await pool.query(sql, p)).rows[0].n;
    const antes = {
      pedidos: await cuenta(`SELECT count(*)::int n FROM pedidos_activos WHERE negocio_id=$1`, [OBISPADO]),
      clientes: await cuenta(`SELECT count(*)::int n FROM clientes WHERE negocio_id=$1`, [OBISPADO]),
      productos: await cuenta(`SELECT count(*)::int n FROM menu_productos WHERE negocio_id=$1`, [OBISPADO]),
      config: await cuenta(`SELECT count(*)::int n FROM configuracion WHERE negocio_id=$1`, [OBISPADO]),
    };
    for (let i = 0; i < 5; i++) {
      await turnoDeSombra(OBISPADO, `meta-${OBISPADO}-ruido-${i}`, 'quiero algo ' + i);
    }
    assert.ok(conversacionesObservadas() >= 5, 'la sombra no observo los turnos del fixture');
    const despues = {
      pedidos: await cuenta(`SELECT count(*)::int n FROM pedidos_activos WHERE negocio_id=$1`, [OBISPADO]),
      clientes: await cuenta(`SELECT count(*)::int n FROM clientes WHERE negocio_id=$1`, [OBISPADO]),
      productos: await cuenta(`SELECT count(*)::int n FROM menu_productos WHERE negocio_id=$1`, [OBISPADO]),
      config: await cuenta(`SELECT count(*)::int n FROM configuracion WHERE negocio_id=$1`, [OBISPADO]),
    };
    assert.deepStrictEqual(despues, antes, 'la sombra escribió en tablas del negocio');
    reiniciarSombraMesero();
  });

  await t('I10', 'el estado de la sombra es por (negocio, sesión) y Rewards no lo indexa', async () => {
    // Rewards no debe tener ninguna referencia al estado del Mesero, ni al revés.
    const svcRewards = readFileSync(join(__dirname, '..', 'src', 'services', 'tiendaRewards.js'), 'utf8');
    const svcRewards2 = readFileSync(join(__dirname, '..', 'src', 'services', 'rewardsService.js'), 'utf8');
    for (const [etq, txt] of [['tiendaRewards.js', svcRewards], ['rewardsService.js', svcRewards2]]) {
      assert.ok(!/mesero/i.test(txt), `${etq} menciona al Mesero: los módulos deben ignorarse`);
      assert.ok(!/sombraDelMesero|estadoMeseroSombra/.test(txt), `${etq} importa estado del Mesero`);
    }
    const sombra = readFileSync(join(__dirname, '..', 'src', 'mesero-whatsapp', 'sombraDelMesero.js'), 'utf8');
    assert.ok(!/reward/i.test(sombra), 'la sombra del Mesero menciona Rewards');
  });

  // ── 11. MAPOLATO OBISPADO: el recorrido completo del fixture ─────────────
  await t('MAPO', 'fixture Obispado: de sin-config a Rewards ON sin tocar el Mesero', async () => {
    // Estado REAL leído en producción: módulo rewards activo, tienda_online
    // activa y publicada, CERO filas en rewards_config, y el Mesero en sombra.
    await pool.query(`DELETE FROM rewards_config WHERE tenant_id = $1`, [OBISPADO]);
    await fijarModulo(OBISPADO, 'rewards', 'activo');
    await fijarModulo(OBISPADO, 'tienda_online', 'activo');
    await ponerCfg(OBISPADO, CLAVE_MESERO_SOMBRA, 'true');
    const meseroInicial = await retratoMesero(OBISPADO);

    // 1) antes de configurar: apagado
    assert.strictEqual((await rewardsDeTienda(OBISPADO)).activo, false, '1) debía estar OFF sin config');
    assert.strictEqual(await obtenerConfig(OBISPADO), null, '1) no debía existir fila');

    // 2) el panel pinta valores de fábrica (se comprueba que los DEFAULT de la
    //    tabla son los que el panel muestra; el render está cubierto en
    //    fase-rewards-config-upsert)
    const { rows: def } = await pool.query(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name='rewards_config' AND column_name='canal_tienda'`);
    assert.strictEqual(String(def[0].column_default), 'false', '2) el default de canal_tienda no es false');

    // 3) guardar crea la fila
    const creada = await actualizarConfig(OBISPADO, {
      nombre_programa: 'Mapolato Rewards', activo: true, monto_por_punto: 10,
      puntos_por_peso: 0.5, canje_minimo: 100 });
    assert.ok(creada, '3) no se creó la configuración');
    const { rows: n } = await pool.query(
      `SELECT count(*)::int n FROM rewards_config WHERE tenant_id=$1`, [OBISPADO]);
    assert.strictEqual(n[0].n, 1, '3) debía quedar exactamente una fila');

    // 4) canal_tienda sigue false
    assert.strictEqual(creada.canal_tienda, false, '4) el alta encendió la tienda sola');
    assert.strictEqual((await rewardsDeTienda(OBISPADO)).activo, false, '4) Rewards de tienda quedó ON sin pedirlo');

    // 5) activar «Tienda en línea»
    const encendida = await actualizarConfig(OBISPADO, { canal_tienda: true });
    assert.strictEqual(encendida.canal_tienda, true, '5) no persistió el encendido');

    // 6) ahora sí
    const rw = await rewardsDeTienda(OBISPADO);
    assert.strictEqual(rw.activo, true, '6) Rewards de tienda no quedó ON');
    assert.strictEqual(rw.config.nombre_programa, 'Mapolato Rewards');

    // 7) el Mesero, exactamente igual que al empezar
    const meseroFinal = await retratoMesero(OBISPADO);
    assert.deepStrictEqual(meseroFinal.flags, meseroInicial.flags, '7) el recorrido movió una bandera del Mesero');
    assert.deepStrictEqual(meseroFinal.modo, meseroInicial.modo, '7) el recorrido cambió modoDelPedido');
    assert.strictEqual(meseroFinal.modo.meseroSombra, true, '7) Obispado dejó de observar en sombra');
    assert.strictEqual(meseroFinal.modo.mesero, false, '7) se encendió el Mesero productivo');
  });

} catch (e) {
  console.error('ERROR FATAL EN LA SUITE:', e);
  fallidas++; fallos.push(`fatal: ${e.message}`);
} finally {
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
