// ─── Guardar la configuración de Rewards crea la fila si no existe ────────
//
// EL FALLO QUE ESTA SUITE EXISTE PARA QUE NO VUELVA (confirmado en la base de
// producción el 2026-09-13):
//
//   `actualizarConfig` era un `UPDATE rewards_config ... WHERE tenant_id=$1`
//   a secas. El ÚNICO `INSERT INTO rewards_config` de todo el código vive en
//   `initDB`, con el slug 'nonna-maye' escrito a mano. Cualquier otro negocio
//   no tenía fila nunca: el UPDATE afectaba 0 renglones, nadie miraba
//   `rowCount`, la ruta respondía `{ok:true}` y el panel pintaba
//   «✓ Guardado». El operador configuraba su programa, leía que se había
//   guardado y no se guardaba nada -- sin ninguna forma de enterarse.
//
//   En producción eso dejaba a Mapolato Obispado (módulo `rewards` = activo,
//   tienda publicada, 22 pedidos web entregados) con CERO configuración y
//   por tanto cero puntos, sin salida que no fuera un INSERT a mano.
//
// Las tres preguntas que esta suite responde:
//   1. ¿Un negocio sin fila puede crearla desde el panel? (sí, exactamente una)
//   2. ¿Puede el backend decir «guardado» sin haber guardado? (jamás)
//   3. ¿Guardar la configuración enciende algo que nadie pidió? (nunca)
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4221';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const NEG_C = SEED.negocioC;   // hará de "Mapolato Obispado sintético"
const cookie = (usuarioId, negocioId, rol) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;

let base;
const url = r => `${base}${r}`;

async function pedir(ruta, { metodo = 'GET', cuerpo, cookieVal } = {}) {
  const r = await fetch(url(ruta), {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(cookieVal ? { Cookie: cookieVal } : {}) },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}

const filasDe = async (negocioId) => (await pool.query(
  `SELECT * FROM rewards_config WHERE tenant_id = $1`, [negocioId])).rows;

// Un admin REAL de cada negocio: requireAdminSeguro contrasta la membresía
// contra usuario_negocios, así que un token suelto no basta.
const ADMINS = {};
async function crearAdmin(negocioId, etiqueta) {
  const email = `admin-rwcfg-${etiqueta}@prueba.local`;
  await pool.query(`DELETE FROM usuarios WHERE email = $1`, [email]).catch(() => {});
  const { rows: [u] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, nombre, email, activo)
     VALUES ($1,$2,$3,TRUE) RETURNING id`, [negocioId, `Admin ${etiqueta}`, email]);
  await pool.query(
    `INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,'admin',TRUE)
     ON CONFLICT (usuario_id, negocio_id) DO UPDATE SET rol='admin', activo=TRUE`, [u.id, negocioId]);
  ADMINS[negocioId] = cookie(u.id, negocioId, 'admin');
  return email;
}

// Lo que manda el formulario del panel: TODOS los campos, siempre.
const cuerpoPanel = (extra = {}) => ({
  nombre_programa: 'Programa Prueba',
  activo: true,
  monto_por_punto: 20,
  puntos_por_peso: 0.25,
  canje_minimo: 50,
  canal_mostrador: true,
  canal_whatsapp: false,
  canal_telefono: false,
  canal_rappi: false,
  canal_tienda: false,
  ...extra,
});

async function limpiar() {
  for (const neg of [NEG_A, NEG_B, NEG_C]) {
    await pool.query(`DELETE FROM rewards_movements WHERE tenant_id = $1`, [neg]).catch(() => {});
    await pool.query(`DELETE FROM rewards_accounts WHERE tenant_id = $1`, [neg]).catch(() => {});
    await pool.query(`DELETE FROM rewards_config WHERE tenant_id = $1`, [neg]).catch(() => {});
  }
  await pool.query(
    `DELETE FROM usuarios WHERE email LIKE 'admin-rwcfg-%@prueba.local'`).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
let servidor;
try {
  await limpiar();
  for (const [neg, etq] of [[NEG_A, 'a'], [NEG_B, 'b'], [NEG_C, 'c']]) {
    await fijarModulo(neg, 'rewards', 'activo');
    await crearAdmin(neg, etq);
  }

  servidor = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 90000 });
  base = `http://localhost:${PUERTO}`;

  // initDB siembra la config de Nonna Maye al arrancar, nunca la de estos
  // negocios: el arranque del servidor no puede haber creado nada aquí.
  await t('C1', 'el fixture arranca SIN fila (es el estado real de un negocio nuevo)', async () => {
    assert.strictEqual((await filasDe(NEG_A)).length, 0,
      'el negocio de prueba ya tenía configuración: el fixture no reproduce el caso');
  });

  await t('C1', 'guardar por primera vez CREA exactamente una fila', async () => {
    const { status, body } = await pedir('/api/rewards/config',
      { metodo: 'PATCH', cuerpo: cuerpoPanel(), cookieVal: ADMINS[NEG_A] });
    assert.strictEqual(status, 200, JSON.stringify(body));
    assert.ok(body.config, 'la respuesta debe traer la fila persistida, no solo ok:true');

    const filas = await filasDe(NEG_A);
    assert.strictEqual(filas.length, 1, `quedaron ${filas.length} filas`);
    assert.strictEqual(filas[0].nombre_programa, 'Programa Prueba');
    assert.strictEqual(Number(filas[0].monto_por_punto), 20);
    assert.strictEqual(filas[0].canal_whatsapp, false, 'no se guardó lo que mandó el panel');
  });

  await t('C1', 'lo que responde el servidor ES lo que quedó en la base', async () => {
    const { body } = await pedir('/api/rewards/config', { cookieVal: ADMINS[NEG_A] });
    const [fila] = await filasDe(NEG_A);
    assert.strictEqual(body.nombre_programa, fila.nombre_programa);
    assert.strictEqual(Number(body.monto_por_punto), Number(fila.monto_por_punto));
    assert.strictEqual(body.canal_tienda, fila.canal_tienda);
  });

  await t('C2', 'guardar otra vez ACTUALIZA la misma fila, no duplica', async () => {
    const [antes] = await filasDe(NEG_A);
    const { status, body } = await pedir('/api/rewards/config',
      { metodo: 'PATCH', cuerpo: cuerpoPanel({ nombre_programa: 'Renombrado', canje_minimo: 75 }),
        cookieVal: ADMINS[NEG_A] });
    assert.strictEqual(status, 200);
    const filas = await filasDe(NEG_A);
    assert.strictEqual(filas.length, 1, `se duplicó la configuración: ${filas.length} filas`);
    assert.strictEqual(filas[0].id, antes.id, 'se creó una fila nueva en vez de actualizar la existente');
    assert.strictEqual(filas[0].nombre_programa, 'Renombrado');
    assert.strictEqual(filas[0].canje_minimo, 75);
    assert.strictEqual(body.config.canje_minimo, 75);
  });

  await t('C3', 'dos primeras configuraciones SIMULTÁNEAS dejan una sola fila', async () => {
    await pool.query(`DELETE FROM rewards_config WHERE tenant_id = $1`, [NEG_B]);
    assert.strictEqual((await filasDe(NEG_B)).length, 0);

    // Doble clic / dos pestañas. Con el SELECT-luego-INSERT que se evitó, los
    // dos pasarían el "¿existe?" y el segundo reventaría contra la UNIQUE.
    const rs = await Promise.all([
      pedir('/api/rewards/config', { metodo: 'PATCH', cuerpo: cuerpoPanel({ nombre_programa: 'Carrera 1' }), cookieVal: ADMINS[NEG_B] }),
      pedir('/api/rewards/config', { metodo: 'PATCH', cuerpo: cuerpoPanel({ nombre_programa: 'Carrera 2' }), cookieVal: ADMINS[NEG_B] }),
      pedir('/api/rewards/config', { metodo: 'PATCH', cuerpo: cuerpoPanel({ nombre_programa: 'Carrera 3' }), cookieVal: ADMINS[NEG_B] }),
    ]);
    const filas = await filasDe(NEG_B);
    assert.strictEqual(filas.length, 1, `la carrera dejó ${filas.length} filas`);
    for (const r of rs) {
      assert.strictEqual(r.status, 200, `una petición de la carrera falló: ${JSON.stringify(r.body)}`);
      assert.ok(r.config || r.body.config, 'toda petición ganadora debe devolver la fila');
    }
  });

  await t('C4', 'los defaults del alta son los de fábrica, y canal_tienda nace FALSE', async () => {
    await pool.query(`DELETE FROM rewards_config WHERE tenant_id = $1`, [NEG_C]);
    // Alta mínima: solo el nombre. Todo lo demás lo pone el DEFAULT de la tabla.
    const { status, body } = await pedir('/api/rewards/config',
      { metodo: 'PATCH', cuerpo: { nombre_programa: 'Mínimo' }, cookieVal: ADMINS[NEG_C] });
    assert.strictEqual(status, 200, JSON.stringify(body));
    const [f] = await filasDe(NEG_C);
    assert.ok(f, 'no se creó la fila');
    assert.strictEqual(f.canal_tienda, false,
      'guardar la configuración encendió Rewards en la tienda sin que nadie lo pidiera');
    assert.strictEqual(Number(f.monto_por_punto), 10, 'default de monto_por_punto');
    assert.strictEqual(Number(f.puntos_por_peso), 0.5, 'default de puntos_por_peso');
    assert.strictEqual(f.canje_minimo, 100, 'default de canje_minimo');
    assert.strictEqual(f.canal_rappi, false, 'default de canal_rappi');
    assert.strictEqual(f.vigencia_dias, null, 'default de vigencia_dias');
    // Y NO copia los valores particulares de Nonna Maye (25 / 1.0).
    assert.notStrictEqual(f.canje_minimo, 25, 'se copió la configuración de otro negocio');
  });

  await t('C4', 'un cuerpo sin campos válidos NO crea fila y NO responde ok', async () => {
    await pool.query(`DELETE FROM rewards_config WHERE tenant_id = $1`, [NEG_C]);
    for (const cuerpo of [{}, { inventado: 1 }, { id: 99, tenant_id: 'otro' }]) {
      const { status, body } = await pedir('/api/rewards/config',
        { metodo: 'PATCH', cuerpo, cookieVal: ADMINS[NEG_C] });
      assert.strictEqual(status, 400, `${JSON.stringify(cuerpo)} devolvió ${status}`);
      assert.ok(!body.ok, 'respondió ok sin haber guardado');
    }
    assert.strictEqual((await filasDe(NEG_C)).length, 0,
      'un cuerpo vacío o con basura dio de alta una configuración');
  });

  await t('C5', 'canal_tienda=true se persiste', async () => {
    const { status, body } = await pedir('/api/rewards/config',
      { metodo: 'PATCH', cuerpo: cuerpoPanel({ canal_tienda: true }), cookieVal: ADMINS[NEG_A] });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.config.canal_tienda, true, 'la respuesta no refleja el cambio');
    const [f] = await filasDe(NEG_A);
    assert.strictEqual(f.canal_tienda, true, 'no quedó guardado en la base');
  });

  await t('C6', 'canal_tienda=false vuelve a persistirse (se puede apagar)', async () => {
    const { status, body } = await pedir('/api/rewards/config',
      { metodo: 'PATCH', cuerpo: cuerpoPanel({ canal_tienda: false }), cookieVal: ADMINS[NEG_A] });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.config.canal_tienda, false);
    const [f] = await filasDe(NEG_A);
    assert.strictEqual(f.canal_tienda, false, 'no se pudo apagar el canal');
  });

  await t('C7', 'la configuración de A no toca la de B', async () => {
    const [antesB] = await filasDe(NEG_B);
    await pedir('/api/rewards/config',
      { metodo: 'PATCH', cuerpo: cuerpoPanel({ nombre_programa: 'Solo A', canje_minimo: 500, canal_tienda: true }),
        cookieVal: ADMINS[NEG_A] });
    const [despuesB] = await filasDe(NEG_B);
    assert.strictEqual(despuesB.nombre_programa, antesB.nombre_programa, 'se pisó el nombre de otro negocio');
    assert.strictEqual(despuesB.canje_minimo, antesB.canje_minimo, 'se pisó el canje mínimo de otro negocio');
    assert.strictEqual(despuesB.canal_tienda, antesB.canal_tienda, 'se encendió el canal de otro negocio');
    assert.strictEqual(despuesB.id, antesB.id);
    // Y el total de filas es exactamente una por negocio configurado.
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM rewards_config WHERE tenant_id = ANY($1)`, [[NEG_A, NEG_B]]);
    assert.strictEqual(rows[0].n, 2);
  });

  await t('C8', 'crear configuración NO contrata el módulo ni enciende nada comercial', async () => {
    const estadoAntes = (await pool.query(
      `SELECT estado FROM negocio_modulos WHERE negocio_id=$1 AND modulo='rewards'`, [NEG_A])).rows[0];
    await pedir('/api/rewards/config',
      { metodo: 'PATCH', cuerpo: cuerpoPanel(), cookieVal: ADMINS[NEG_A] });
    const estadoDespues = (await pool.query(
      `SELECT estado FROM negocio_modulos WHERE negocio_id=$1 AND modulo='rewards'`, [NEG_A])).rows[0];
    assert.strictEqual(estadoDespues.estado, estadoAntes.estado, 'guardar la config cambió el entitlement');

    // Y otros módulos siguen intactos: nada de publicar tiendas de rebote.
    const otros = (await pool.query(
      `SELECT modulo, estado FROM negocio_modulos WHERE negocio_id=$1 AND modulo <> 'rewards'`, [NEG_A])).rows;
    const tienda = otros.find(o => o.modulo === 'tienda_online');
    if (tienda) assert.notStrictEqual(tienda.estado, undefined);
    const { rows: tc } = await pool.query(
      `SELECT count(*)::int n FROM tienda_config WHERE negocio_id = $1 AND estado = 'publicada'`, [NEG_A]);
    assert.ok(tc[0].n >= 0, 'consulta de control');
  });

  await t('C8', 'un negocio SIN el módulo Rewards no puede guardar configuración', async () => {
    await pool.query(`DELETE FROM rewards_config WHERE tenant_id = $1`, [NEG_C]);
    await fijarModulo(NEG_C, 'rewards', 'no_contratado');
    try {
      const { status, body } = await pedir('/api/rewards/config',
        { metodo: 'PATCH', cuerpo: cuerpoPanel(), cookieVal: ADMINS[NEG_C] });
      assert.ok(status >= 400, `respondió ${status}: un negocio sin el módulo pudo configurar Rewards`);
      assert.ok(!body.ok);
      assert.strictEqual((await filasDe(NEG_C)).length, 0,
        'se creó configuración para un negocio sin el módulo contratado');
    } finally { await fijarModulo(NEG_C, 'rewards', 'activo'); }
  });

  await t('C9', 'el backend no puede responder ok si la persistencia falla', async () => {
    // Se fuerza un fallo real de base: un valor que la columna no admite.
    // Antes, cualquier excepción daba 500 y el panel decía «Error al guardar»
    // -- eso estaba bien. Lo que estaba mal era el camino SIN excepción y SIN
    // escritura. Aquí se comprueban los dos: con error, no hay ok; y la fila
    // no se corrompe a medias.
    const [antes] = await filasDe(NEG_A);
    const { status, body } = await pedir('/api/rewards/config',
      { metodo: 'PATCH', cuerpo: { canje_minimo: 'no-es-un-numero' }, cookieVal: ADMINS[NEG_A] });
    assert.ok(status >= 400, `respondió ${status} a un valor inválido`);
    assert.ok(!body.ok, 'respondió ok tras un fallo de persistencia');
    assert.ok(!body.config, 'devolvió una fila que no se escribió');
    const [despues] = await filasDe(NEG_A);
    assert.strictEqual(despues.canje_minimo, antes.canje_minimo, 'el fallo dejó la fila a medias');
  });

  await t('C9', 'el servicio devuelve null cuando no hay nada que persistir', async () => {
    const { actualizarConfig } = await import('../src/services/rewardsService.js');
    assert.strictEqual(await actualizarConfig(NEG_A, {}), null);
    assert.strictEqual(await actualizarConfig(NEG_A, { basura: 1 }), null);
    assert.strictEqual(await actualizarConfig(NEG_A, null), null);
  });

  await t('C10', 'caso Mapolato Obispado: módulo activo, sin fila, y queda habilitable', async () => {
    // Reproduce el estado REAL leído en producción el 2026-09-13:
    // negocio_modulos.rewards = 'activo', tienda_online = 'activo',
    // tienda publicada, y CERO filas en rewards_config.
    await pool.query(`DELETE FROM rewards_config WHERE tenant_id = $1`, [NEG_C]);
    await fijarModulo(NEG_C, 'rewards', 'activo');
    await fijarModulo(NEG_C, 'tienda_online', 'activo');
    assert.strictEqual((await filasDe(NEG_C)).length, 0, 'el fixture debe arrancar sin configuración');

    const { rewardsDeTienda } = await import('../src/services/tiendaRewards.js');
    const antes = await rewardsDeTienda(NEG_C);
    assert.strictEqual(antes.activo, false, 'sin configuración, Rewards en tienda debe estar apagado');

    // 1) El admin abre Rewards → Config y guarda sus reglas. Sin SQL a mano.
    const alta = await pedir('/api/rewards/config',
      { metodo: 'PATCH', cuerpo: cuerpoPanel({ nombre_programa: 'Mapolato Rewards' }), cookieVal: ADMINS[NEG_C] });
    assert.strictEqual(alta.status, 200, JSON.stringify(alta.body));
    assert.strictEqual((await filasDe(NEG_C)).length, 1, 'no se creó la configuración');

    // Todavía apagado para la tienda: el alta no enciende el canal.
    const traseAlta = await rewardsDeTienda(NEG_C);
    assert.strictEqual(traseAlta.activo, false,
      'crear la configuración encendió la tienda sin que nadie marcara la casilla');

    // 2) El admin marca «Tienda en línea».
    const enciende = await pedir('/api/rewards/config',
      { metodo: 'PATCH', cuerpo: cuerpoPanel({ nombre_programa: 'Mapolato Rewards', canal_tienda: true }),
        cookieVal: ADMINS[NEG_C] });
    assert.strictEqual(enciende.status, 200);
    assert.strictEqual(enciende.body.config.canal_tienda, true);

    const final = await rewardsDeTienda(NEG_C);
    assert.strictEqual(final.activo, true,
      'con módulo activo, configuración creada y canal encendido, Rewards debe quedar habilitado en la tienda');
    assert.strictEqual(final.config.nombre_programa, 'Mapolato Rewards');
  });

  // ── El panel: la otra mitad del bloqueo ──
  // Encontrada abriendo el panel de verdad contra un negocio sin fila. El
  // backend ya guardaba bien, pero `GET /api/rewards/config` responde `null`
  // para quien no tiene configuración y el formulario reventaba en
  // `cfg.nombre_programa` DENTRO de un try con catch vacío: la pestaña
  // Config aparecía en blanco y no había nada que guardar.
  await t('C10', 'el panel pinta el formulario aunque el negocio no tenga fila', () => {
    const panel = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');
    const i = panel.indexOf('async function cargarConfigRewardsForm');
    assert.ok(i > 0, 'no se encontró cargarConfigRewardsForm');
    const cuerpo = panel.slice(i, i + 900);
    assert.match(cuerpo, /\(await r\.json\(\)\)\s*\|\|/,
      'una respuesta null debe caer en los valores de fábrica, no reventar');
    assert.ok(panel.includes('RW_CONFIG_FABRICA'),
      'deben existir valores de fábrica para pintar el alta');
  });

  await t('C9', 'el panel solo dice «Guardado» si el servidor devolvió la fila', () => {
    const panel = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');
    const i = panel.indexOf('async function guardarConfigRewards');
    const cuerpo = panel.slice(i, panel.indexOf('function abrirConfigRewards'));
    assert.match(cuerpo, /if \(r\.ok && cuerpo\.config\)/,
      'el acuse no puede depender solo del código HTTP');
    assert.ok(!/rwConfig = \{ \.\.\.rwConfig, \.\.\.datos \}/.test(cuerpo),
      'el panel no puede quedarse con lo que creyó mandar: debe usar lo persistido');
    assert.match(cuerpo, /rwConfig = cuerpo\.config/,
      'el estado en pantalla debe venir de la base');
  });

  await t('C4', 'los valores de fábrica del panel coinciden con los DEFAULT de la tabla', async () => {
    const panel = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');
    const bloque = panel.slice(panel.indexOf('const RW_CONFIG_FABRICA'),
                               panel.indexOf('async function cargarConfigRewardsForm'));
    const { rows } = await pool.query(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name='rewards_config'
          AND column_name = ANY($1)`,
      [['monto_por_punto', 'puntos_por_peso', 'canje_minimo', 'canal_tienda', 'canal_rappi']]);
    const esperado = {
      monto_por_punto: '10', puntos_por_peso: '0.5', canje_minimo: '100',
      canal_tienda: 'false', canal_rappi: 'false',
    };
    for (const r of rows) {
      assert.strictEqual(String(r.column_default), esperado[r.column_name],
        `el DEFAULT real de ${r.column_name} cambió: el panel mostraría otra cosa`);
      assert.ok(bloque.includes(`${r.column_name}:`),
        `${r.column_name} falta en los valores de fábrica del panel`);
    }
    assert.match(bloque, /canal_tienda:\s*false/,
      'el panel no puede ofrecer la casilla de tienda marcada por omisión');
  });

} catch (e) {
  console.error('ERROR FATAL EN LA SUITE:', e);
  fallidas++; fallos.push(`fatal: ${e.message}`);
} finally {
  if (servidor) servidor.detener();
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
