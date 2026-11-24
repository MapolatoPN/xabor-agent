// AVISOS AL DUEÑO: el número es el que guarda el panel, y cada aviso tiene su
// interruptor por negocio.
//
// El panel (Config › Integraciones › «Número para reportes internos») guarda el
// número como `int_wa_admin_numero`; los avisos leían `wa_admin_numero` y, en
// los negocios configurados desde el panel, se omitían sin avisar a nadie. Esta
// suite cubre:
//   A. el ayudante (numeroAdminNegocio.js): qué clave gana, interruptores y sus
//      valores por omisión;
//   B. los cinco avisos de whatsapp-meta.js, EJECUTADOS: se recorta cada uno
//      del archivo real (importarlo levantaría server.js) y se corre con
//      dependencias de prueba;
//   C. «cliente esperando» contra Postgres: nace apagado, se enciende por
//      negocio, y cada negocio avisa a SU número;
//   D. el traspaso del agente (avisoRescateHumano) conserva su bandera y ya lee
//      el número del panel;
//   E. que no quede ninguna lectura directa de la clave vieja.
import assert from 'assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raiz = (r) => join(__dirname, '..', r);
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

const H = await import('../src/services/numeroAdminNegocio.js');
const { numeroAdminNegocio, avisoDuenoEncendido, numeroParaAvisoDueno, AVISOS_DUENO } = H;

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const PANEL = '520000000101';    // lo que guarda el panel (int_wa_admin_numero)
const VIEJO = '520000000102';    // la clave sin prefijo
const NUM_B = '520000000103';    // el de otro negocio

// ═══ A. El ayudante ═════════════════════════════════════════════════════════
await t('A1. el número del panel gana; si falta, la clave vieja; sin ninguno, vacío', () => {
  assert.strictEqual(numeroAdminNegocio({ int_wa_admin_numero: PANEL }), PANEL);
  assert.strictEqual(numeroAdminNegocio({ wa_admin_numero: VIEJO }), VIEJO);
  assert.strictEqual(numeroAdminNegocio({ int_wa_admin_numero: PANEL, wa_admin_numero: VIEJO }), PANEL,
    'con las dos, manda lo que se ve y se edita en el panel');
  assert.strictEqual(numeroAdminNegocio({ int_wa_admin_numero: '   ', wa_admin_numero: VIEJO }), VIEJO,
    'un número en blanco no cuenta');
  assert.strictEqual(numeroAdminNegocio({ int_wa_admin_numero: ` ${PANEL} ` }), PANEL, 'sin espacios');
  assert.strictEqual(numeroAdminNegocio({}), '');
  assert.strictEqual(numeroAdminNegocio(null), '');
  assert.strictEqual(numeroAdminNegocio({ int_wa_admin_numero: 520000000101 }), '', 'solo texto, como guarda configuracion');
});

await t('A2. valores por omisión: encendidos los de poco volumen, apagado «cliente esperando»', () => {
  const esperado = {
    fallas_bot: true, revision_humana: true, negativa_falsa: true,
    bot_retomo: true, pago_sin_proveedor: true, cliente_esperando: false,
  };
  assert.deepStrictEqual(Object.keys(AVISOS_DUENO).sort(), Object.keys(esperado).sort(), 'la lista de avisos cambió');
  for (const [tipo, v] of Object.entries(esperado)) {
    assert.strictEqual(avisoDuenoEncendido({}, tipo), v, `${tipo} por omisión`);
  }
});

await t('A3. el interruptor del negocio manda sobre el valor por omisión', () => {
  for (const [tipo, { clave }] of Object.entries(AVISOS_DUENO)) {
    assert.strictEqual(avisoDuenoEncendido({ [clave]: 'true' }, tipo), true, `${tipo} encendido`);
    assert.strictEqual(avisoDuenoEncendido({ [clave]: 'false' }, tipo), false, `${tipo} apagado`);
    assert.strictEqual(avisoDuenoEncendido({ [clave]: ' TRUE ' }, tipo), true, `${tipo} con mayúsculas y espacios`);
  }
  assert.strictEqual(avisoDuenoEncendido({ aviso_dueno_wa_cliente_esperando: 'si' }, 'cliente_esperando'), false,
    'un valor raro deja el valor por omisión');
  assert.strictEqual(avisoDuenoEncendido({}, 'no_existe'), false, 'un aviso que no está en la lista no avisa');
  assert.ok(Object.isFrozen(AVISOS_DUENO) && Object.isFrozen(AVISOS_DUENO.fallas_bot), 'la lista no se puede alterar');
});

await t('A4. numeroParaAvisoDueno: número solo si el aviso está encendido', () => {
  assert.strictEqual(numeroParaAvisoDueno({ int_wa_admin_numero: PANEL }, 'fallas_bot'), PANEL);
  assert.strictEqual(numeroParaAvisoDueno({ int_wa_admin_numero: PANEL }, 'cliente_esperando'), '');
  assert.strictEqual(numeroParaAvisoDueno({ int_wa_admin_numero: PANEL, aviso_dueno_wa_fallas_bot: 'false' }, 'fallas_bot'), '');
  assert.strictEqual(numeroParaAvisoDueno({ aviso_dueno_wa_cliente_esperando: 'true' }, 'cliente_esperando'), '',
    'encendido pero sin número: no hay a quién');
});

// ═══ B. Los avisos de whatsapp-meta.js, ejecutados ══════════════════════════
const CANAL = readFileSync(raiz('src/channels/whatsapp-meta.js'), 'utf8');

/** Devuelve el texto desde `ancla` hasta la llave que cierra su primer bloque. */
function recortarBloque(fuente, ancla, desde = 0) {
  const i = fuente.indexOf(ancla, desde);
  assert.ok(i >= 0, `no se encontró «${ancla}» en whatsapp-meta.js`);
  const abre = fuente.indexOf('{', i + ancla.length - 1);
  let nivel = 0;
  for (let k = abre; k < fuente.length; k++) {
    if (fuente[k] === '{') nivel++;
    else if (fuente[k] === '}' && --nivel === 0) return { inicio: i, fin: k + 1, texto: fuente.slice(i, k + 1) };
  }
  throw new Error(`bloque sin cerrar: ${ancla}`);
}

function dobles(cfg) {
  const enviados = [];
  return {
    enviados,
    obtenerConfiguracion: async () => ({ ...cfg }),
    obtenerCredencialesWhatsappNegocio: async () => ({ token: 'x', phoneId: 'y' }),
    enviarMensaje: (numero, texto) => { enviados.push({ numero, texto }); return Promise.resolve({}); },
  };
}

const DEPS = ['obtenerConfiguracion', 'obtenerCredencialesWhatsappNegocio', 'enviarMensaje', 'numeroParaAvisoDueno'];

// Cada aviso: cómo construirlo, cómo dispararlo y su interruptor.
const AVISOS_CANAL = [
  {
    tipo: 'fallas_bot',
    construir: (d) => {
      const decl = CANAL.slice(CANAL.indexOf('const erroresPorNegocio'), CANAL.indexOf('async function registrarError'));
      const fn = recortarBloque(CANAL, 'async function registrarError(negocioId)').texto;
      return new Function(...DEPS, 'setTimeout', `${decl}\n${fn}\nreturn registrarError;`)(
        d.obtenerConfiguracion, d.obtenerCredencialesWhatsappNegocio, d.enviarMensaje, numeroParaAvisoDueno, () => 0);
    },
    disparar: async (fn) => { for (let i = 0; i < 3; i++) await fn('neg-prueba'); },
  },
  {
    tipo: 'negativa_falsa',
    construir: (d) => {
      const decl = CANAL.slice(CANAL.indexOf('const avisoNegativa'), CANAL.indexOf('registrarAvisoNegativaFalsa(async'));
      const reg = recortarBloque(CANAL, 'registrarAvisoNegativaFalsa(async (negocioId, hallazgos) =>').texto + ');';
      let cb = null;
      new Function(...DEPS, 'registrarAvisoNegativaFalsa', `${decl}\n${reg}`)(
        d.obtenerConfiguracion, d.obtenerCredencialesWhatsappNegocio, d.enviarMensaje, numeroParaAvisoDueno, (f) => { cb = f; });
      assert.strictEqual(typeof cb, 'function', 'el aviso de negativa falsa no se registró');
      return cb;
    },
    disparar: (fn) => fn('neg-prueba', [{ negado: 'chilaquiles', existen: ['Chilaquiles verdes'] }]),
  },
  {
    tipo: 'revision_humana',
    construir: (d) => new Function(...DEPS, 'ETIQUETA_MOTIVO',
      `${recortarBloque(CANAL, 'async function avisarEquipoRevision(').texto}\nreturn avisarEquipoRevision;`)(
      d.obtenerConfiguracion, d.obtenerCredencialesWhatsappNegocio, d.enviarMensaje, numeroParaAvisoDueno, {}),
    disparar: (fn) => fn('neg-prueba', '5219990000999', 'SOLICITUD_CLIENTE', null),
  },
  {
    tipo: 'pago_sin_proveedor',
    construir: (d) => new Function(...DEPS, 'NUMERO_SOPORTE', 'twilio',
      `${recortarBloque(CANAL, 'async function notificarEscalacion(').texto}\nreturn notificarEscalacion;`)(
      d.obtenerConfiguracion, d.obtenerCredencialesWhatsappNegocio, d.enviarMensaje, numeroParaAvisoDueno, '', null),
    disparar: (fn) => fn('5219990000999', 'neg-prueba', { token: 'x' }),
  },
  {
    tipo: 'bot_retomo',
    construir: (d) => {
      const b = recortarBloque(CANAL, 'alLiberar: async (n,t,motivo,edadMin) =>');
      const flecha = b.texto.replace(/^alLiberar:\s*/, '');
      return new Function(...DEPS, 'ETIQUETA_MOTIVO', 'wsBroadcast', `return (${flecha});`)(
        d.obtenerConfiguracion, d.obtenerCredencialesWhatsappNegocio, d.enviarMensaje, numeroParaAvisoDueno, {}, null);
    },
    disparar: (fn) => fn('neg-prueba', '5219990000999', 'SOLICITUD_CLIENTE', 30),
  },
];

for (const a of AVISOS_CANAL) {
  await t(`B. ${a.tipo}: llega al número del panel, cae a la clave vieja, calla sin número o con el interruptor apagado`, async () => {
    const correr = async (cfg) => { const d = dobles(cfg); await a.disparar(a.construir(d)); return d.enviados; };
    const soloPanel = await correr({ int_wa_admin_numero: PANEL });
    assert.strictEqual(soloPanel.length, 1, `con solo el número del panel debía salir 1 aviso, salieron ${soloPanel.length}`);
    assert.strictEqual(soloPanel[0].numero, PANEL);
    const soloViejo = await correr({ wa_admin_numero: VIEJO });
    assert.deepStrictEqual(soloViejo.map((e) => e.numero), [VIEJO], 'la clave vieja debía seguir sirviendo');
    const ambos = await correr({ int_wa_admin_numero: PANEL, wa_admin_numero: VIEJO });
    assert.deepStrictEqual(ambos.map((e) => e.numero), [PANEL], 'con las dos, gana el panel');
    assert.strictEqual((await correr({})).length, 0, 'sin número no debía salir nada');
    const apagado = await correr({ int_wa_admin_numero: PANEL, [AVISOS_DUENO[a.tipo].clave]: 'false' });
    assert.strictEqual(apagado.length, 0, `con ${AVISOS_DUENO[a.tipo].clave}=false no debía salir nada`);
  });
}

// ═══ C. «Cliente esperando», contra Postgres ════════════════════════════════
const { pool, actualizarConfiguracion } = await import('../src/services/database.js');
const { revisarConversacionesEnEspera, reiniciarAvisos } = await import('../src/services/rescateConversaciones.js');
const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const TEL_A = '5219990041001';
const TEL_B = '5219990041002';
const CLAVES_C = ['int_wa_admin_numero', 'wa_admin_numero', AVISOS_DUENO.cliente_esperando.clave];

async function leerClaves(neg) {
  const { rows } = await pool.query('SELECT clave, valor FROM configuracion WHERE negocio_id = $1 AND clave = ANY($2)', [neg, CLAVES_C]);
  return Object.fromEntries(rows.map((r) => [r.clave, r.valor]));
}
async function fijar(neg, valores) {
  await pool.query('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = ANY($2)', [neg, CLAVES_C]);
  const fila = Object.fromEntries(Object.entries(valores).filter(([, v]) => v !== undefined));
  if (Object.keys(fila).length) await actualizarConfiguracion(fila, neg);
}
async function limpiarConversaciones() {
  await pool.query(`DELETE FROM mensajes WHERE telefono LIKE '521999004100%'`);
  await pool.query(`DELETE FROM clientes WHERE telefono LIKE '521999004100%'`);
  reiniciarAvisos();
}
async function esperando(neg, tel) {
  await pool.query(
    `INSERT INTO clientes (telefono, negocio_id, human_takeover_until, last_business_app_message_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 minutes', NOW())
     ON CONFLICT (telefono) DO UPDATE SET negocio_id = $2, human_takeover_until = NOW() + INTERVAL '30 minutes'`, [tel, neg]);
  await pool.query(
    `INSERT INTO mensajes (telefono, direccion, texto, negocio_id, origen, "timestamp")
     VALUES ($1,'entrante','¿siguen ahí?',$2,'cliente', NOW() - INTERVAL '10 minutes')`, [tel, neg]);
}
async function revisar() {
  const avisos = [];
  await revisarConversacionesEnEspera({
    minutos: 5, log: () => {}, broadcastPanel: () => {},
    enviarAvisoWhatsapp: async (numero, texto, negocioId) => { avisos.push({ numero, texto, negocioId }); },
  });
  // Solo los de esta suite: la base de prueba puede traer otras esperas.
  return avisos.filter((a) => a.texto.includes('***1001') || a.texto.includes('***1002'));
}

const antesA = await leerClaves(NEG_A);
const antesB = await leerClaves(NEG_B);
try {
  await t('C1. nace apagado: con número del panel y sin interruptor, no sale WhatsApp', async () => {
    await limpiarConversaciones();
    await fijar(NEG_A, { int_wa_admin_numero: PANEL });
    await esperando(NEG_A, TEL_A);
    assert.deepStrictEqual(await revisar(), []);
  });

  await t('C2. encendido en el negocio: sale al número que guarda el panel', async () => {
    await limpiarConversaciones();
    await fijar(NEG_A, { int_wa_admin_numero: PANEL, [AVISOS_DUENO.cliente_esperando.clave]: 'true' });
    await esperando(NEG_A, TEL_A);
    const avisos = await revisar();
    assert.deepStrictEqual(avisos.map((a) => [a.numero, a.negocioId]), [[PANEL, NEG_A]]);
  });

  await t('C3. dos negocios: cada espera avisa al número de SU negocio, nunca al del otro', async () => {
    await limpiarConversaciones();
    await fijar(NEG_A, { int_wa_admin_numero: PANEL, [AVISOS_DUENO.cliente_esperando.clave]: 'true' });
    await fijar(NEG_B, { int_wa_admin_numero: NUM_B, [AVISOS_DUENO.cliente_esperando.clave]: 'true' });
    await esperando(NEG_A, TEL_A);
    await esperando(NEG_B, TEL_B);
    const avisos = await revisar();
    const de = (tel) => avisos.filter((a) => a.texto.includes(`***${tel.slice(-4)}`));
    assert.deepStrictEqual(de(TEL_A).map((a) => [a.numero, a.negocioId]), [[PANEL, NEG_A]]);
    assert.deepStrictEqual(de(TEL_B).map((a) => [a.numero, a.negocioId]), [[NUM_B, NEG_B]]);
  });

  await t('C4. el interruptor de un negocio no enciende al otro', async () => {
    await limpiarConversaciones();
    await fijar(NEG_A, { int_wa_admin_numero: PANEL, [AVISOS_DUENO.cliente_esperando.clave]: 'true' });
    await fijar(NEG_B, { int_wa_admin_numero: NUM_B });
    await esperando(NEG_A, TEL_A);
    await esperando(NEG_B, TEL_B);
    const avisos = await revisar();
    assert.deepStrictEqual(avisos.map((a) => a.numero), [PANEL], 'B no lo encendió: no debía recibir nada');
  });
} finally {
  await limpiarConversaciones();
  await fijar(NEG_A, antesA);
  await fijar(NEG_B, antesB);
}

// ═══ D. El traspaso del agente: su bandera de siempre, el número del panel ══
const R = await import('../src/mesero-agente/rescateHumano.js');
const A = await import('../src/services/avisoRescateHumano.js');
async function traspaso(cfg) {
  const whatsapp = [];
  A.reiniciarAvisoRescate();
  A.configurarAvisoRescate({
    broadcastPanel: () => {},
    enviarAvisoWhatsapp: async (numero) => { whatsapp.push(numero); },
    leerConfiguracion: async () => ({ [R.BANDERA_RESCATE]: 'true', ...cfg }),
    leerRevision: async () => ({ requiere_revision: true, revision: 1, motivo: 'X', actualizado_at: new Date() }),
    log: () => {}, reloj: () => Date.now(),
  });
  await A.avisarEquipoDeHandoff({ negocioId: 'aaaaaaaa-0000-4000-8000-000000000041', telefono: '5219990004321', motivo: 'X' });
  await A.esperarAvisosEnCurso();
  return whatsapp;
}
await t('D1. con su bandera encendida, el aviso del traspaso va al número del panel', async () => {
  assert.deepStrictEqual(await traspaso({ [A.BANDERA_AVISO_WHATSAPP]: 'true', int_wa_admin_numero: PANEL }), [PANEL]);
  assert.deepStrictEqual(await traspaso({ [A.BANDERA_AVISO_WHATSAPP]: 'true', wa_admin_numero: VIEJO }), [VIEJO]);
});
await t('D2. sin su bandera no sale, aunque haya número (decisión del 3-oct, sin cambios)', async () => {
  assert.deepStrictEqual(await traspaso({ int_wa_admin_numero: PANEL }), []);
});

// ═══ E. Nadie vuelve a leer la clave vieja directo ══════════════════════════
await t('E1. ningún aviso lee wa_admin_numero por su cuenta', () => {
  const archivos = ['src/channels/whatsapp-meta.js', 'src/services/rescateConversaciones.js',
    'src/services/avisoRescateHumano.js', 'src/services/vencimientoPausasWhatsapp.js'];
  for (const f of archivos) {
    const fuente = readFileSync(raiz(f), 'utf8');
    assert.ok(!/(cfg|config|cfgRev)\??\.(int_)?wa_admin_numero/.test(fuente), `${f} todavía lee la clave directo`);
    assert.match(fuente, /from '\.\.?\/(services\/)?numeroAdminNegocio\.js'/, `${f} no usa el ayudante`);
  }
  const tipos = [...CANAL.matchAll(/numeroParaAvisoDueno\(cfg, '([a-z_]+)'\)/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(tipos, ['bot_retomo', 'fallas_bot', 'negativa_falsa', 'pago_sin_proveedor', 'revision_humana']);
});

await t('E2. la premisa: el panel guarda el número con el prefijo int_', () => {
  const servidor = readFileSync(raiz('src/server.js'), 'utf8');
  assert.match(servidor, /cambios\['int_' \+ k\] = v\.trim\(\)/, 'PUT /api/admin/integraciones cambió cómo guarda');
  assert.match(servidor, /'wa_token','wa_phone_id','wa_verify_token','wa_admin_numero'/);
});

console.log(`\n${fallidas === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
await pool.end().catch(() => {});
process.exit(fallidas === 0 ? 0 : 1);
