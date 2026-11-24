// AVISOS DEL PANEL (la campanita), 24-nov-2026.
//
// Mario decidió que los avisos al dueño no vayan por WhatsApp sino que se vean
// dentro del panel. Esta suite cubre:
//   A. el servicio (services/avisosPanel.js) contra Postgres: bandera por
//      negocio apagada por omisión, aislamiento entre negocios, no repetir el
//      aviso del mismo cliente sin ver, datos recortados, ventana de 7 días, y
//      que nunca lance;
//   B. los seis puntos donde nace un aviso, EJECUTADOS: cinco se recortan del
//      whatsapp-meta.js real y se corren con dobles; «cliente esperando» corre
//      contra Postgres;
//   C. las rutas con el servidor real: solo administrador, solo su negocio;
//   D. el archivo del panel: textos, huella ?v= y conexión en index.html;
//   E. la campanita en un navegador real (puppeteer): número rojo, lista,
//      «Visto», un aviso EN VIVO (el job de rescate del servidor), «Ir al
//      chat», texto del cliente que no se interpreta como HTML, el operador
//      no la ve, la bandera apagada la esconde, y el celular.
import assert from 'assert';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raiz = (r) => join(__dirname, '..', r);
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL'); process.exit(2); }
if (/railway|rlwy/i.test(process.env.DATABASE_URL)) { console.error('Esta suite no corre contra Railway'); process.exit(2); }

const { pool, actualizarConfiguracion } = await import('../src/services/database.js');
const AP = await import('../src/services/avisosPanel.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  if (process.env.CASOS && !new RegExp(process.env.CASOS).test(nombre)) return;
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const TEL_A1 = '5219990042001';
const TEL_A2 = '5219990042002';
const TEL_B1 = '5219990042101';
const BANDERA = AP.BANDERA_AVISOS_PANEL;

async function bandera(neg, valor) {
  await pool.query('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2', [neg, BANDERA]);
  if (valor !== undefined) await actualizarConfiguracion({ [BANDERA]: valor }, neg);
}
async function limpiarAvisos() {
  await pool.query('DELETE FROM avisos_panel WHERE negocio_id = ANY($1::uuid[])', [[NEG_A, NEG_B]]);
}
const filas = async (neg) => (await pool.query(
  'SELECT id::text, tipo, telefono, datos, visto_en, visto_por FROM avisos_panel WHERE negocio_id = $1 ORDER BY id', [neg])).rows;
const emitidos = [];
AP.setBroadcastAvisosPanel((n, data) => emitidos.push({ n, data }));

const banderaAntes = await pool.query('SELECT negocio_id, valor FROM configuracion WHERE clave = $1 AND negocio_id = ANY($2::uuid[])', [BANDERA, [NEG_A, NEG_B]]);

// ═══ A. El servicio, contra Postgres ════════════════════════════════════════
await t('A0. la tabla existe con su lista cerrada de tipos (migración 160)', async () => {
  const { rows: [r] } = await pool.query("SELECT to_regclass('public.avisos_panel') IS NOT NULL AS hay");
  assert.ok(r.hay, 'falta la tabla avisos_panel: aplica scripts/predeploy-160-avisos-panel.mjs');
  await assert.rejects(pool.query(`INSERT INTO avisos_panel (negocio_id, tipo) VALUES ($1, 'otro')`, [NEG_A]), /avisos_panel_tipo/);
  await assert.rejects(pool.query(`INSERT INTO avisos_panel (negocio_id, tipo, datos) VALUES ($1, 'fallas_bot', '[]')`, [NEG_A]), /avisos_panel_datos_objeto/);
  assert.deepStrictEqual([...AP.TIPOS_AVISO_PANEL].sort(),
    ['bot_retomo', 'cliente_esperando', 'fallas_bot', 'negativa_falsa', 'pago_sin_proveedor', 'revision_humana']);
});

await t('A1. nace apagado: sin la bandera no se guarda nada, la lista dice activo:false y no se marca nada', async () => {
  await limpiarAvisos(); await bandera(NEG_A); emitidos.length = 0;
  assert.strictEqual(await AP.registrarAvisoPanel(NEG_A, 'fallas_bot', { datos: { errores: 3 } }), null);
  assert.strictEqual(await AP.registrarAvisoPanel(NEG_A, 'cliente_esperando', { telefono: TEL_A1 }), null);
  assert.deepStrictEqual(await filas(NEG_A), []);
  assert.deepStrictEqual(emitidos, [], 'apagado no debe avisar al panel');
  assert.deepStrictEqual(await AP.listarAvisosPanel(NEG_A), { activo: false, sinVer: 0, avisos: [] });
  assert.deepStrictEqual(await AP.marcarAvisosVistos(NEG_A), { activo: false, marcados: 0 });
  await bandera(NEG_A, 'si');
  assert.strictEqual(await AP.registrarAvisoPanel(NEG_A, 'fallas_bot'), null, 'solo «true» la enciende');
});

await t('A2. encendida: guarda cada tipo, lo manda en vivo a SU negocio y la lista lo trae', async () => {
  await limpiarAvisos(); await bandera(NEG_A, 'true'); emitidos.length = 0;
  for (const tipo of AP.TIPOS_AVISO_PANEL) {
    const f = await AP.registrarAvisoPanel(NEG_A, tipo, { telefono: TEL_A1, datos: { minutos: 7 } });
    assert.ok(f && f.id && f.tipo === tipo, `${tipo} no se guardó`);
  }
  assert.strictEqual((await filas(NEG_A)).length, 6);
  assert.strictEqual(emitidos.length, 6);
  for (const e of emitidos) {
    assert.strictEqual(e.n, NEG_A);
    assert.strictEqual(e.data.tipo, 'aviso_panel');
    assert.strictEqual(e.data.aviso.telefono, TEL_A1);
  }
  const l = await AP.listarAvisosPanel(NEG_A);
  assert.strictEqual(l.activo, true);
  assert.strictEqual(l.sinVer, 6);
  assert.deepStrictEqual(l.avisos.map((a) => a.tipo), [...AP.TIPOS_AVISO_PANEL].reverse(), 'lo más nuevo primero');
});

await t('A3. un negocio no ve, no cuenta y no marca los avisos de otro', async () => {
  await limpiarAvisos(); await bandera(NEG_A, 'true'); await bandera(NEG_B, 'true');
  const a = await AP.registrarAvisoPanel(NEG_A, 'revision_humana', { telefono: TEL_A1, datos: { razon: 'el cliente pidió hablar con una persona' } });
  const b = await AP.registrarAvisoPanel(NEG_B, 'revision_humana', { telefono: TEL_B1 });
  const la = await AP.listarAvisosPanel(NEG_A);
  const lb = await AP.listarAvisosPanel(NEG_B);
  assert.deepStrictEqual(la.avisos.map((x) => x.id), [a.id]);
  assert.deepStrictEqual(lb.avisos.map((x) => x.id), [b.id]);
  assert.strictEqual(la.sinVer, 1); assert.strictEqual(lb.sinVer, 1);
  assert.deepStrictEqual(await AP.marcarAvisosVistos(NEG_B, { id: a.id }), { activo: true, marcados: 0 }, 'B marcó un aviso de A');
  assert.strictEqual((await filas(NEG_A))[0].visto_en, null);
  assert.strictEqual((await AP.marcarAvisosVistos(NEG_B)).marcados, 1, '«todos» de B solo marca el suyo');
  assert.strictEqual((await filas(NEG_A))[0].visto_en, null, '«todos» de B tocó el de A');
  await bandera(NEG_B);
  assert.deepStrictEqual(await AP.listarAvisosPanel(NEG_B), { activo: false, sinVer: 0, avisos: [] }, 'la bandera de A no enciende a B');
  assert.strictEqual(await AP.registrarAvisoPanel(NEG_B, 'fallas_bot'), null);
});

await t('A4. el mismo aviso del mismo cliente no se repite mientras siga sin verse', async () => {
  await limpiarAvisos(); await bandera(NEG_A, 'true');
  assert.ok(await AP.registrarAvisoPanel(NEG_A, 'cliente_esperando', { telefono: TEL_A1, datos: { minutos: 6 } }));
  assert.strictEqual(await AP.registrarAvisoPanel(NEG_A, 'cliente_esperando', { telefono: TEL_A1, datos: { minutos: 7 } }), null);
  assert.ok(await AP.registrarAvisoPanel(NEG_A, 'cliente_esperando', { telefono: TEL_A2 }), 'otro cliente sí');
  assert.ok(await AP.registrarAvisoPanel(NEG_A, 'revision_humana', { telefono: TEL_A1 }), 'otro tipo sí');
  await AP.marcarAvisosVistos(NEG_A);
  assert.ok(await AP.registrarAvisoPanel(NEG_A, 'cliente_esperando', { telefono: TEL_A1 }), 'ya visto: el siguiente sí se guarda');
  await pool.query(`UPDATE avisos_panel SET creado_en = now() - interval '31 minutes' WHERE negocio_id = $1 AND visto_en IS NULL`, [NEG_A]);
  assert.ok(await AP.registrarAvisoPanel(NEG_A, 'cliente_esperando', { telefono: TEL_A1 }), 'pasados 30 min se vuelve a avisar');
  assert.ok(await AP.registrarAvisoPanel(NEG_A, 'fallas_bot'), 'sin cliente siempre se guarda');
  assert.ok(await AP.registrarAvisoPanel(NEG_A, 'fallas_bot'), 'sin cliente siempre se guarda (el canal trae su freno)');
});

await t('A5. datos: solo los campos que el panel usa, recortados', async () => {
  await limpiarAvisos(); await bandera(NEG_A, 'true');
  const largo = 'x'.repeat(500);
  const f = await AP.registrarAvisoPanel(NEG_A, 'negativa_falsa', {
    datos: { negado: ` ${largo} `, existen: ['a', 'b', 'c', 'd', '', null], texto: 'mensaje completo del cliente', minutos: '7', errores: -3 },
  });
  assert.strictEqual(f.datos.negado.length, 120);
  assert.deepStrictEqual(f.datos.existen, ['a', 'b', 'c']);
  assert.strictEqual(f.datos.minutos, 7);
  assert.ok(!('texto' in f.datos), 'se guardó un campo que no se usa');
  assert.ok(!('errores' in f.datos), 'se guardó un número negativo');
  assert.deepStrictEqual(AP.limpiarDatosAviso(null), {});
  assert.deepStrictEqual(AP.limpiarDatosAviso([1, 2]), {});
  const g = await AP.registrarAvisoPanel(NEG_A, 'pago_sin_proveedor', { telefono: 'x'.repeat(60) });
  assert.strictEqual(g.telefono, null, 'un teléfono absurdo no se guarda');
});

await t('A6. la lista y el número rojo son de los últimos 7 días', async () => {
  await limpiarAvisos(); await bandera(NEG_A, 'true');
  const viejo = await AP.registrarAvisoPanel(NEG_A, 'fallas_bot');
  await pool.query(`UPDATE avisos_panel SET creado_en = now() - interval '8 days' WHERE id = $1`, [viejo.id]);
  const nuevo = await AP.registrarAvisoPanel(NEG_A, 'fallas_bot');
  const l = await AP.listarAvisosPanel(NEG_A);
  assert.deepStrictEqual(l.avisos.map((a) => a.id), [nuevo.id]);
  assert.strictEqual(l.sinVer, 1);
});

await t('A7. «Visto» guarda quién; sin usuario válido, sin nombre; un id raro no marca nada', async () => {
  await limpiarAvisos(); await bandera(NEG_A, 'true');
  const a = await AP.registrarAvisoPanel(NEG_A, 'fallas_bot');
  const b = await AP.registrarAvisoPanel(NEG_A, 'fallas_bot');
  assert.strictEqual((await AP.marcarAvisosVistos(NEG_A, { id: 'abc' })).marcados, 0);
  assert.strictEqual((await AP.marcarAvisosVistos(NEG_A, { id: a.id, usuarioId: SEED.adminNegocioAUsuarioId })).marcados, 1);
  assert.strictEqual((await AP.marcarAvisosVistos(NEG_A, { id: a.id })).marcados, 0, 'dos veces el mismo');
  assert.strictEqual((await AP.marcarAvisosVistos(NEG_A, { id: b.id, usuarioId: 'soporte' })).marcados, 1);
  const [fa, fb] = await filas(NEG_A);
  assert.strictEqual(fa.visto_por, SEED.adminNegocioAUsuarioId);
  assert.ok(fb.visto_en && fb.visto_por === null);
});

await t('A8. nunca lanza: tipo o negocio inválidos, emisor roto o la base caída', async () => {
  await limpiarAvisos(); await bandera(NEG_A, 'true');
  assert.strictEqual(await AP.registrarAvisoPanel(NEG_A, 'no_existe'), null);
  assert.strictEqual(await AP.registrarAvisoPanel('', 'fallas_bot'), null);
  assert.strictEqual(await AP.registrarAvisoPanel(null, 'fallas_bot'), null);
  assert.strictEqual(await AP.registrarAvisoPanel('no-es-uuid', 'fallas_bot'), null);
  AP.setBroadcastAvisosPanel(() => { throw new Error('ws roto'); });
  try {
    assert.ok(await AP.registrarAvisoPanel(NEG_A, 'fallas_bot'), 'un emisor roto no debe perder el aviso');
  } finally { AP.setBroadcastAvisosPanel((n, data) => emitidos.push({ n, data })); }
  await pool.query('ALTER TABLE avisos_panel RENAME TO avisos_panel_fuera');
  try {
    assert.strictEqual(await AP.registrarAvisoPanel(NEG_A, 'fallas_bot'), null);
  } finally { await pool.query('ALTER TABLE avisos_panel_fuera RENAME TO avisos_panel'); }
});

await t('A9. producción la crea: el runner del Pre-Deploy corre la 160 después de la 149', () => {
  const runner = readFileSync(raiz('scripts/predeploy-run-032-033.mjs'), 'utf8');
  const lista = runner.slice(runner.indexOf('const SCRIPTS = ['), runner.indexOf('];', runner.indexOf('const SCRIPTS = [')));
  const nombres = [...lista.matchAll(/^\s*'([0-9a-z-]+)',/gm)].map((m) => m[1]);
  assert.ok(nombres.includes('160-avisos-panel'), 'la 160 no está en SCRIPTS: nunca llegaría a producción');
  assert.ok(nombres.indexOf('160-avisos-panel') > nombres.indexOf('149-rewards-inscripcion'), 'la 160 debe ir después de la 149');
  assert.ok(readFileSync(raiz('scripts/predeploy-160-avisos-panel.mjs'), 'utf8').includes("'../migrations/160_avisos_panel.sql'"));
  assert.match(readFileSync(raiz('migrations/160_avisos_panel_down.sql'), 'utf8'), /^DROP TABLE IF EXISTS avisos_panel;$/m);
});

// ═══ B. Los seis puntos donde nace un aviso ═════════════════════════════════
const CANAL = readFileSync(raiz('src/channels/whatsapp-meta.js'), 'utf8');

function recortarBloque(fuente, ancla, desde = 0) {
  const i = fuente.indexOf(ancla, desde);
  assert.ok(i >= 0, `no se encontró «${ancla}»`);
  const abre = fuente.indexOf('{', i + ancla.length - 1);
  let nivel = 0;
  for (let k = abre; k < fuente.length; k++) {
    if (fuente[k] === '{') nivel++;
    else if (fuente[k] === '}' && --nivel === 0) return fuente.slice(i, k + 1);
  }
  throw new Error(`bloque sin cerrar: ${ancla}`);
}
const ETIQUETAS = new Function(`${recortarBloque(CANAL, 'const ETIQUETA_MOTIVO = ')};\nreturn ETIQUETA_MOTIVO;`)();

function dobles() {
  const avisos = []; const enviados = [];
  return {
    avisos, enviados,
    registrarAvisoPanel: (n, tipo, extra = {}) => { avisos.push({ n, tipo, ...extra }); return Promise.resolve(null); },
    // Sin número del dueño ni credenciales: el aviso del panel no depende de WhatsApp.
    obtenerConfiguracion: async () => ({}),
    obtenerCredencialesWhatsappNegocio: async () => null,
    enviarMensaje: async (numero, texto) => { enviados.push({ numero, texto }); },
  };
}
const NEG_X = 'aaaaaaaa-0000-4000-8000-000000000042';

await t('B1. el bot falla 3 veces en 5 min → un aviso «fallas_bot», aunque el negocio no tenga número', async () => {
  const d = dobles();
  const decl = CANAL.slice(CANAL.indexOf('const erroresPorNegocio'), CANAL.indexOf('async function registrarError'));
  const fn = new Function('obtenerConfiguracion', 'obtenerCredencialesWhatsappNegocio', 'enviarMensaje', 'registrarAvisoPanel', 'setTimeout',
    `${decl}\n${recortarBloque(CANAL, 'async function registrarError(negocioId)')}\nreturn registrarError;`)(
    d.obtenerConfiguracion, d.obtenerCredencialesWhatsappNegocio, d.enviarMensaje, d.registrarAvisoPanel, () => 0);
  await fn(NEG_X); await fn(NEG_X);
  assert.deepStrictEqual(d.avisos, [], 'con 2 errores todavía no');
  await fn(NEG_X); await fn(NEG_X);
  assert.deepStrictEqual(d.avisos, [{ n: NEG_X, tipo: 'fallas_bot', datos: { errores: 3 } }], 'uno solo, con el freno de 15 min');
  assert.deepStrictEqual(d.enviados, [], 'no debe salir WhatsApp');
});

await t('B2. el bot iba a negar algo que sí se vende → «negativa_falsa» con el producto, una vez cada 30 min', async () => {
  const d = dobles();
  const decl = CANAL.slice(CANAL.indexOf('const avisoNegativa'), CANAL.indexOf('registrarAvisoNegativaFalsa(async'));
  let cb = null;
  new Function('obtenerConfiguracion', 'obtenerCredencialesWhatsappNegocio', 'enviarMensaje', 'registrarAvisoPanel', 'registrarAvisoNegativaFalsa',
    `${decl}\n${recortarBloque(CANAL, 'registrarAvisoNegativaFalsa(async (negocioId, hallazgos) =>')});`)(
    d.obtenerConfiguracion, d.obtenerCredencialesWhatsappNegocio, d.enviarMensaje, d.registrarAvisoPanel, (f) => { cb = f; });
  await cb(NEG_X, [{ negado: 'chilaquiles', existen: ['Chilaquiles verdes', 'Chilaquiles rojos'] }]);
  await cb(NEG_X, [{ negado: 'otra cosa', existen: [] }]);
  assert.deepStrictEqual(d.avisos, [{ n: NEG_X, tipo: 'negativa_falsa', datos: { negado: 'chilaquiles', existen: ['Chilaquiles verdes', 'Chilaquiles rojos'] } }]);
  await cb('bbbbbbbb-0000-4000-8000-000000000042', null);
  assert.strictEqual(d.avisos.length, 2, 'hallazgos vacíos también avisan, sin romperse');
  assert.deepStrictEqual(d.enviados, []);
});

await t('B3. una conversación pasa a una persona → «revision_humana» con su motivo, aunque la pausa falle', async () => {
  const d = dobles();
  const flecha = recortarBloque(CANAL, 'alRevision: async (n,t,motivo) =>').replace(/^alRevision:\s*/, '');
  const mk = (setBotPausado) => new Function('registrarAvisoPanel', 'setBotPausado', 'wsBroadcast', 'ETIQUETA_MOTIVO', `return (${flecha});`)(
    d.registrarAvisoPanel, setBotPausado, null, ETIQUETAS);
  await mk(async () => {})(NEG_X, TEL_A1, 'SOLICITUD_CLIENTE');
  assert.deepStrictEqual(d.avisos, [{ n: NEG_X, tipo: 'revision_humana', telefono: TEL_A1,
    datos: { motivo: 'SOLICITUD_CLIENTE', razon: ETIQUETAS.SOLICITUD_CLIENTE } }]);
  await assert.rejects(mk(async () => { throw new Error('base caída'); })(NEG_X, TEL_A2, 'MOTIVO_NUEVO'));
  assert.strictEqual(d.avisos.length, 2, 'si la pausa falla, el aviso ya quedó');
  assert.strictEqual(d.avisos[1].datos.razon, 'MOTIVO_NUEVO', 'un motivo sin etiqueta se muestra tal cual');
});

await t('B4. el bot retoma una conversación sin atender → «bot_retomo» con los minutos', async () => {
  const d = dobles();
  const flecha = recortarBloque(CANAL, 'alLiberar: async (n,t,motivo,edadMin) =>').replace(/^alLiberar:\s*/, '');
  const fn = new Function('registrarAvisoPanel', 'obtenerConfiguracion', 'obtenerCredencialesWhatsappNegocio', 'enviarMensaje', 'ETIQUETA_MOTIVO', 'wsBroadcast',
    `return (${flecha});`)(d.registrarAvisoPanel, d.obtenerConfiguracion, d.obtenerCredencialesWhatsappNegocio, d.enviarMensaje, ETIQUETAS, null);
  await fn(NEG_X, TEL_A1, 'ESCALADA_MODELO', 30);
  await fn(NEG_X, TEL_A2, null, 45);
  assert.deepStrictEqual(d.avisos, [
    { n: NEG_X, tipo: 'bot_retomo', telefono: TEL_A1, datos: { minutos: 30, razon: ETIQUETAS.ESCALADA_MODELO } },
    { n: NEG_X, tipo: 'bot_retomo', telefono: TEL_A2, datos: { minutos: 45, razon: 'una duda del asistente' } },
  ]);
  assert.deepStrictEqual(d.enviados, []);
});

await t('B5. un cliente quiere pagar y no hay proveedor → «pago_sin_proveedor» con su teléfono', async () => {
  const d = dobles();
  const escalaciones = [];
  const fn = new Function('enviarMensaje', 'guardarMensaje', 'notificarEscalacion', 'registrarAvisoPanel',
    `${recortarBloque(CANAL, 'async function manejarClipNoConfigurado(')}\nreturn manejarClipNoConfigurado;`)(
    d.enviarMensaje, async () => ({}), async (tel) => { escalaciones.push(tel); }, d.registrarAvisoPanel);
  await fn(TEL_A1, 'Cliente', NEG_X, { token: 'x' });
  assert.deepStrictEqual(d.avisos, [{ n: NEG_X, tipo: 'pago_sin_proveedor', telefono: TEL_A1 }]);
  assert.deepStrictEqual(escalaciones, [TEL_A1], 'la escalación de siempre sigue');
  assert.strictEqual(d.enviados.length, 1, 'el cliente sigue recibiendo «Permítenos un momento»');
});

await t('B6. whatsapp-meta.js: exactamente esos cinco puntos, sin esperar (void) y con el import', () => {
  assert.match(CANAL, /^import \{ registrarAvisoPanel \} from '\.\.\/services\/avisosPanel\.js';$/m);
  const llamadas = [...CANAL.matchAll(/(\bvoid\s+)?registrarAvisoPanel\((\w+), '([a-z_]+)'/g)];
  assert.deepStrictEqual(llamadas.map((m) => m[3]).sort(),
    ['bot_retomo', 'fallas_bot', 'negativa_falsa', 'pago_sin_proveedor', 'revision_humana']);
  for (const m of llamadas) assert.ok(m[1], `${m[3]} espera a la base: debe ser «void registrarAvisoPanel(...)»`);
});

const { revisarConversacionesEnEspera, reiniciarAvisos } = await import('../src/services/rescateConversaciones.js');
async function limpiarEspera() {
  await pool.query(`DELETE FROM mensajes WHERE telefono LIKE '52199900420%' OR telefono LIKE '52199900421%'`);
  await pool.query(`DELETE FROM clientes WHERE telefono LIKE '52199900420%' OR telefono LIKE '52199900421%'`);
  reiniciarAvisos();
}
async function esperando(neg, tel, minutos = 10) {
  await pool.query(
    `INSERT INTO clientes (telefono, negocio_id, human_takeover_until, last_business_app_message_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 minutes', NOW())
     ON CONFLICT (telefono) DO UPDATE SET negocio_id = $2, human_takeover_until = NOW() + INTERVAL '30 minutes'`, [tel, neg]);
  await pool.query(
    `INSERT INTO mensajes (telefono, direccion, texto, negocio_id, origen, "timestamp")
     VALUES ($1,'entrante','¿siguen ahí?',$2,'cliente', NOW() - make_interval(mins => $3::int))`, [tel, neg, minutos]);
}

await t('B7. «cliente esperando» (job de rescate, contra Postgres): a la campanita de SU negocio, solo con la bandera', async () => {
  await limpiarAvisos(); await limpiarEspera();
  await bandera(NEG_A, 'true'); await bandera(NEG_B);
  await esperando(NEG_A, TEL_A1); await esperando(NEG_B, TEL_B1);
  await revisarConversacionesEnEspera({ minutos: 5, log: () => {}, broadcastPanel: () => {}, avisoPanel: AP.registrarAvisoPanel });
  const a = (await filas(NEG_A)).filter((f) => f.telefono === TEL_A1);
  assert.strictEqual(a.length, 1, 'A debía tener su aviso');
  assert.strictEqual(a[0].tipo, 'cliente_esperando');
  assert.ok(a[0].datos.minutos >= 9 && a[0].datos.minutos <= 11, `minutos=${a[0].datos.minutos}`);
  assert.deepStrictEqual((await filas(NEG_B)).filter((f) => f.telefono === TEL_B1), [], 'B no lo encendió');
  // Quien llama sin avisoPanel (código anterior) sigue funcionando.
  reiniciarAvisos();
  assert.ok(await revisarConversacionesEnEspera({ minutos: 5, log: () => {}, broadcastPanel: () => {} }) >= 1);
  await limpiarEspera();
});

// ═══ C. Las rutas, con el servidor real ═════════════════════════════════════
const { crearTokenSesion } = await import('../src/services/session.js');
const { hashPassword } = await import('../src/services/password.js');
const { arrancarServidor } = await import('./lib-servidor.mjs');
const SUF = Date.now().toString(36);
const { rows: [adminB] } = await pool.query(
  `INSERT INTO usuarios (negocio_id, nombre, email, password_hash, activo) VALUES ($1, 'Admin B avisos', $2, $3, true) RETURNING id`,
  [NEG_B, `avisos-b-${SUF}@test.local`, hashPassword('clave-de-prueba-avisos-1')]);
await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1, $2, 'admin', true)`, [adminB.id, NEG_B]);

const sesion = (usuarioId, negocioId, rol) => encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }));
const SES = {
  adminA: sesion(SEED.adminNegocioAUsuarioId, NEG_A, 'admin'),
  staffA: sesion(SEED.staffNegocioAUsuarioId, NEG_A, 'staff'),
  adminB: sesion(adminB.id, NEG_B, 'admin'),
};
const PUERTO = process.env.TEST_PORT_AVISOS || '4793';
const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 40000 });
const BASE = srv.base;
async function api(ruta, ses, metodo = 'GET') {
  const r = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(ses ? { Cookie: `xabor_sesion=${ses}` } : {}) },
    body: metodo === 'POST' ? '{}' : undefined,
  });
  let datos = null; try { datos = await r.json(); } catch {}
  return { status: r.status, datos };
}

let navegador = null;
try {
  await t('C1. sin sesión 401, el operador 403 (leer y marcar); el administrador ve SOLO lo de su negocio', async () => {
    await limpiarAvisos(); await bandera(NEG_A, 'true'); await bandera(NEG_B, 'true');
    const a = await AP.registrarAvisoPanel(NEG_A, 'fallas_bot', { datos: { errores: 3 } });
    const b = await AP.registrarAvisoPanel(NEG_B, 'fallas_bot', { datos: { errores: 4 } });
    assert.strictEqual((await api('/api/admin/avisos-panel', null)).status, 401);
    assert.strictEqual((await api('/api/admin/avisos-panel', SES.staffA)).status, 403);
    assert.strictEqual((await api('/api/admin/avisos-panel/visto-todos', SES.staffA, 'POST')).status, 403);
    assert.strictEqual((await api(`/api/admin/avisos-panel/${a.id}/visto`, SES.staffA, 'POST')).status, 403);
    const la = await api('/api/admin/avisos-panel', SES.adminA);
    assert.strictEqual(la.status, 200);
    assert.deepStrictEqual([la.datos.activo, la.datos.sinVer, la.datos.avisos.map((x) => x.id)], [true, 1, [a.id]]);
    const lb = await api('/api/admin/avisos-panel', SES.adminB);
    assert.deepStrictEqual(lb.datos.avisos.map((x) => x.id), [b.id]);
  });

  await t('C2. el administrador de A no puede marcar un aviso de B; «todos» solo marca los suyos', async () => {
    const [b] = await filas(NEG_B);
    const r = await api(`/api/admin/avisos-panel/${b.id}/visto`, SES.adminA, 'POST');
    assert.deepStrictEqual([r.status, r.datos.marcados], [200, 0]);
    assert.strictEqual((await api('/api/admin/avisos-panel/visto-todos', SES.adminA, 'POST')).datos.marcados, 1);
    assert.strictEqual((await filas(NEG_B))[0].visto_en, null, 'se marcó el aviso de B');
    const [a] = await filas(NEG_A);
    assert.strictEqual(a.visto_por, SEED.adminNegocioAUsuarioId, 'debe quedar quién lo vio');
    assert.strictEqual((await api('/api/admin/avisos-panel/abc/visto', SES.adminA, 'POST')).status, 400);
  });

  await t('C3. con la bandera apagada responde activo:false y no marca nada', async () => {
    await bandera(NEG_B);
    const r = await api('/api/admin/avisos-panel', SES.adminB);
    assert.deepStrictEqual([r.status, r.datos], [200, { activo: false, sinVer: 0, avisos: [] }]);
    assert.deepStrictEqual((await api('/api/admin/avisos-panel/visto-todos', SES.adminB, 'POST')).datos, { activo: false, marcados: 0 });
    assert.strictEqual((await filas(NEG_B))[0].visto_en, null);
  });

  await t('C4. server.js: rutas de administrador, emisor filtrado y evento solo de administrador', () => {
    const SERVER = readFileSync(raiz('src/server.js'), 'utf8');
    for (const ruta of ["app.get('/api/admin/avisos-panel'", "app.post('/api/admin/avisos-panel/visto-todos'", "app.post('/api/admin/avisos-panel/:id/visto'"]) {
      assert.ok(SERVER.includes(`${ruta}, requireAdminSeguro, requireModulo('whatsapp'),`), `${ruta} sin requireAdminSeguro`);
    }
    assert.match(SERVER, /^setBroadcastAvisosPanel\(broadcastNegocio\);$/m);
    const soloAdmin = SERVER.match(/const EVENTOS_WS_SOLO_ADMIN = new Set\(\[([^\]]*)\]\)/)[1];
    assert.ok(soloAdmin.includes("'aviso_panel'"), 'aviso_panel le llegaría al operador');
    assert.match(SERVER, /avisoPanel: registrarAvisoPanel,/, 'el job de rescate no guarda el aviso');
    const push = recortarBloque(SERVER, 'function dispararPushParaEvento(data, negocioId)');
    assert.ok(!push.includes('aviso_panel'), 'decisión de Mario: sin notificación de la computadora');
  });

  // ═══ D. El archivo del panel ══════════════════════════════════════════════
  const JS = readFileSync(raiz('panel/avisos-panel.js'), 'utf8');
  const HTML = readFileSync(raiz('panel/index.html'), 'utf8');
  const ctx = {}; vm.createContext(ctx); vm.runInContext(JS, ctx);
  const M = ctx.XaborAvisosPanel;

  await t('D1. el texto de cada aviso', () => {
    const tx = (tipo, datos = {}) => M.textoDeAviso({ tipo, datos });
    assert.strictEqual(tx('cliente_esperando', { minutos: 7 }).titulo, 'Un cliente lleva 7 min esperando respuesta');
    assert.match(tx('revision_humana', { razon: 'el cliente pidió hablar con una persona' }).detalle, /^Motivo: el cliente pidió hablar con una persona\./);
    assert.strictEqual(tx('bot_retomo', { minutos: 30 }).titulo, 'El bot retomó una conversación que nadie atendió en 30 min');
    assert.strictEqual(tx('fallas_bot', { errores: 3 }).titulo, 'El bot tuvo 3 errores en 5 minutos');
    assert.strictEqual(tx('negativa_falsa', { negado: 'chilaquiles' }).titulo, 'El bot iba a decir que no manejan «chilaquiles»');
    assert.match(tx('negativa_falsa', { existen: ['A', 'B'] }).detalle, /^Sí lo tienen \(A, B\)\./);
    assert.match(tx('pago_sin_proveedor').titulo, /no hay forma de cobro/);
    assert.strictEqual(tx('cliente_esperando').titulo, 'Un cliente lleva unos minutos esperando respuesta', 'sin minutos no dice «NaN»');
    assert.strictEqual(M.textoDeAviso({ tipo: 'otro' }).titulo, 'Aviso');
    assert.strictEqual(M.textoDeAviso(null).titulo, 'Aviso');
    for (const tipo of AP.TIPOS_AVISO_PANEL) assert.notStrictEqual(tx(tipo).titulo, 'Aviso', `${tipo} sin texto en el panel`);
  });

  await t('D2. la huella ?v= es el sha256 del archivo', () => {
    const huella = createHash('sha256').update(readFileSync(raiz('panel/avisos-panel.js'))).digest('hex').slice(0, 8);
    assert.ok(HTML.includes(`<script src="/avisos-panel.js?v=${huella}"></script>`), `la huella correcta es ?v=${huella}`);
  });

  await t('D3. index.html: botón en la cabecera, solo administrador, evento en vivo; el módulo no usa innerHTML', () => {
    assert.match(HTML, /<button class="header-btn" id="btn-avisos" type="button" hidden><\/button>/);
    assert.match(HTML, /if \(window\.XaborAvisosPanel && ROL === 'admin'\) \{/);
    assert.match(HTML, /if \(msg\.tipo === 'aviso_panel'\) window\.XaborAvisosPanel\?\.alEvento\(msg\.aviso\);/);
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(JS), 'el módulo arma HTML con texto: un producto del cliente se ejecutaría');
  });

  // ═══ E. En un navegador real ══════════════════════════════════════════════
  let puppeteer = null;
  try { puppeteer = (await import('puppeteer')).default; } catch { /* sin navegador */ }
  if (!puppeteer) {
    await t('E. navegador real (puppeteer)', () => { throw new Error('puppeteer no está instalado: no se probó en navegador'); });
  } else {
    navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    async function abrirPanel(ses, { ancho = 1280, alto = 800 } = {}) {
      const ctxN = await navegador.createBrowserContext();
      await ctxN.setCookie({ name: 'xabor_sesion', value: ses, url: BASE, httpOnly: true, sameSite: 'Lax' });
      const page = await ctxN.newPage();
      await page.setViewport({ width: ancho, height: alto });
      const pedidas = [];
      const errores = [];
      page.on('request', (r) => { if (r.url().includes('/api/admin/avisos-panel')) pedidas.push(r.url()); });
      page.on('pageerror', (e) => errores.push(e.message));
      await page.evaluateOnNewDocument(() => { window.__xss = 0; });
      await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
      return { page, pedidas, errores, cerrar: () => ctxN.close() };
    }
    const contador = (page) => page.$eval('#btn-avisos .av-contador', (e) => (e.hidden ? '' : e.textContent));
    const XSS = '<img src=x onerror="window.__xss=1">';

    await t('E1. administrador: 🔔 con el número rojo; la lista muestra el texto del cliente como texto', async () => {
      await limpiarAvisos(); await bandera(NEG_A, 'true');
      await AP.registrarAvisoPanel(NEG_A, 'negativa_falsa', { datos: { negado: XSS, existen: ['Chilaquiles verdes'] } });
      await AP.registrarAvisoPanel(NEG_A, 'revision_humana', { telefono: TEL_A1, datos: { razon: 'el cliente pidió hablar con una persona' } });
      const p = await abrirPanel(SES.adminA);
      try {
        await p.page.waitForSelector('#btn-avisos:not([hidden])', { timeout: 20000 });
        assert.strictEqual(await contador(p.page), '2');
        await p.page.click('#btn-avisos');
        await p.page.waitForSelector('#menu-avisos:not([hidden]) .av-item', { timeout: 10000 });
        const items = await p.page.$$eval('#menu-avisos .av-item', (els) => els.map((e) => e.textContent));
        assert.strictEqual(items.length, 2);
        assert.ok(items.some((x) => x.includes(`no manejan «${XSS}»`)), 'el producto del cliente no se ve tal cual');
        assert.ok(items.some((x) => x.includes('Una conversación pasó a una persona') && x.includes(TEL_A1)));
        assert.strictEqual(await p.page.$('#menu-avisos img'), null, 'el texto del cliente se volvió una etiqueta');
        assert.strictEqual(await p.page.evaluate(() => window.__xss), 0);
        assert.deepStrictEqual(p.errores, []);
      } finally { await p.cerrar(); }
    });

    await t('E2. «Visto» baja el número y queda en la base; «Marcar todos» lo deja en cero', async () => {
      const p = await abrirPanel(SES.adminA);
      try {
        await p.page.waitForSelector('#btn-avisos:not([hidden])', { timeout: 20000 });
        await p.page.click('#btn-avisos');
        await p.page.waitForSelector('#menu-avisos .av-marcar', { timeout: 10000 });
        await p.page.$eval('#menu-avisos .av-marcar', (e) => e.click());
        await p.page.waitForFunction(() => document.querySelector('#btn-avisos .av-contador')?.textContent === '1', { timeout: 10000 });
        assert.strictEqual((await filas(NEG_A)).filter((f) => f.visto_en).length, 1);
        await p.page.$eval('#menu-avisos .av-todos', (e) => e.click());
        await p.page.waitForFunction(() => document.querySelector('#btn-avisos .av-contador')?.hidden === true, { timeout: 10000 });
        assert.strictEqual((await filas(NEG_A)).filter((f) => !f.visto_en).length, 0);
      } finally { await p.cerrar(); }
    });

    await t('E3. EN VIVO: el job de rescate del servidor guarda el aviso y la campanita lo muestra sin recargar; «Ir al chat» abre la conversación', async () => {
      await limpiarAvisos(); await limpiarEspera(); await bandera(NEG_A, 'true');
      const p = await abrirPanel(SES.adminA);
      try {
        await p.page.waitForSelector('#btn-avisos:not([hidden])', { timeout: 20000 });
        assert.strictEqual(await contador(p.page), '');
        await esperando(NEG_A, TEL_A2, 8);
        // El job corre cada minuto dentro del servidor.
        await p.page.waitForSelector('#letrero-aviso-panel', { timeout: 90000 });
        assert.match(await p.page.$eval('#letrero-aviso-panel', (e) => e.textContent), /Un cliente lleva \d+ min esperando respuesta/);
        assert.strictEqual(await contador(p.page), '1');
        await p.page.click('#btn-avisos');
        await p.page.waitForSelector('#menu-avisos .av-ir', { timeout: 10000 });
        await p.page.$eval('#menu-avisos .av-ir', (e) => e.click());
        await p.page.waitForFunction((tel) => document.getElementById('vista-chats')?.style.display === 'block'
          && document.getElementById('chat-header-nombre')?.textContent.includes(tel.slice(-4)), { timeout: 10000 }, TEL_A2);
        await p.page.waitForFunction(() => document.querySelector('#btn-avisos .av-contador')?.hidden === true, { timeout: 10000 });
        const [f] = await filas(NEG_A);
        assert.ok(f && f.tipo === 'cliente_esperando' && f.telefono === TEL_A2 && f.visto_en, 'ir al chat debía marcarlo como visto');
      } finally { await p.cerrar(); await limpiarEspera(); }
    });

    await t('E4. el operador no ve la campanita ni la pide', async () => {
      const p = await abrirPanel(SES.staffA);
      try {
        await p.page.waitForFunction(() => typeof ROL === 'string' && ROL === 'staff', { timeout: 20000 });
        await new Promise((r) => setTimeout(r, 2500));
        assert.strictEqual(await p.page.$eval('#btn-avisos', (e) => e.hidden), true);
        assert.deepStrictEqual(p.pedidas, []);
      } finally { await p.cerrar(); }
    });

    await t('E5. con la bandera apagada el administrador tampoco la ve', async () => {
      await bandera(NEG_A);
      const p = await abrirPanel(SES.adminA);
      try {
        await p.page.waitForFunction(() => typeof ROL === 'string' && ROL === 'admin', { timeout: 20000 });
        await new Promise((r) => setTimeout(r, 2500));
        assert.ok(p.pedidas.length >= 1, 'el administrador sí pregunta');
        assert.strictEqual(await p.page.$eval('#btn-avisos', (e) => e.hidden), true);
      } finally { await p.cerrar(); }
    });

    await t('E6. celular (375 px): la cabecera cabe y la lista no se sale de la pantalla', async () => {
      await limpiarAvisos(); await bandera(NEG_A, 'true');
      await AP.registrarAvisoPanel(NEG_A, 'fallas_bot', { datos: { errores: 3 } });
      const p = await abrirPanel(SES.adminA, { ancho: 375, alto: 812 });
      try {
        await p.page.waitForSelector('#btn-avisos:not([hidden])', { timeout: 20000 });
        const cab = await p.page.evaluate(() => {
          const h = document.querySelector('header'); const b = document.getElementById('btn-avisos').getBoundingClientRect();
          return { ancho: document.documentElement.scrollWidth, cabecera: h.scrollWidth, cliente: h.clientWidth, derecha: b.right };
        });
        assert.ok(cab.ancho <= 376, `la página se desborda: ${cab.ancho}px`);
        assert.ok(cab.derecha <= 375, `el botón queda fuera: ${cab.derecha}px`);
        await p.page.click('#btn-avisos');
        await p.page.waitForSelector('#menu-avisos:not([hidden]) .av-item', { timeout: 10000 });
        const m = await p.page.$eval('#menu-avisos', (e) => { const r = e.getBoundingClientRect(); return { izq: r.left, der: r.right }; });
        assert.ok(m.izq >= 0 && m.der <= 375, `la lista se sale: ${JSON.stringify(m)}`);
      } finally { await p.cerrar(); }
    });
  }

  // ═══ Z. La reversa y el Pre-Deploy, en esta copia desechable ═══════════════
  await t('Z1. reversa: el _down quita la tabla, el Pre-Deploy la vuelve a crear vacía y la segunda vez no hace nada', async () => {
    const { execFileSync } = await import('child_process');
    const correr = () => execFileSync(process.execPath, ['scripts/predeploy-160-avisos-panel.mjs'],
      { cwd: raiz(''), env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(correr(), /\[predeploy-160\] Ya aplicada/);
    await pool.query(readFileSync(raiz('migrations/160_avisos_panel_down.sql'), 'utf8'));
    const { rows: [sin] } = await pool.query("SELECT to_regclass('public.avisos_panel') IS NULL AS fuera");
    assert.ok(sin.fuera, 'el _down no quitó la tabla');
    assert.match(correr(), /\[predeploy-160\] Aplicada: tabla avisos_panel vacía/);
    assert.match(correr(), /\[predeploy-160\] Ya aplicada/);
    const { rows: [c] } = await pool.query('SELECT COUNT(*)::int AS n FROM avisos_panel');
    assert.strictEqual(c.n, 0);
  });
} finally {
  if (navegador) await navegador.close().catch(() => {});
  try { srv.detener(); } catch { /* ya terminó */ }
  await limpiarAvisos().catch(() => {});
  await limpiarEspera().catch(() => {});
  for (const neg of [NEG_A, NEG_B]) {
    const antes = banderaAntes.rows.find((r) => r.negocio_id === neg);
    await bandera(neg, antes ? antes.valor : undefined).catch(() => {});
  }
  await pool.query('DELETE FROM usuario_negocios WHERE usuario_id = $1', [adminB.id]).catch(() => {});
  await pool.query('DELETE FROM usuarios WHERE id = $1', [adminB.id]).catch(() => {});
}

console.log(`\n${pasadas} OK, ${fallidas} FALLO`);
if (fallos.length) { console.log(fallos.map((f) => `  - ${f}`).join('\n')); }
await pool.end().catch(() => {});
process.exit(fallidas ? 1 : 0);
