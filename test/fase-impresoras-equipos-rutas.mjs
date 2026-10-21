// Configuración → Impresoras, Fases 1 y 2: equipos, rutas y papel de 48.
//
// A. Sin base: el papel «80 mm a todo lo ancho», el módulo del panel
//    (panel/impresorasEquipos.js) y su conexión con index.html.
// B. Con Postgres, los servicios:
//    - el estado de cada equipo (nunca conectado, desde cuándo, versión);
//    - cada ruta con su estado (ok / impresora fuera de uso / equipo sin
//      conexión) y cambiarla de impresora;
//    - el papel de 48 sobrevive a «Guardar» y a «Imprimir prueba»;
//    - «Olvidar este equipo»: qué cancela, qué quita, qué deja; que no se
//      puede con un equipo conectado ni de otro negocio; que después se puede
//      volver a dar de alta el mismo nombre y la misma impresora; y que lo
//      que salía ahí sale en Cocina.
// C. Con el servidor real: solo administradores, la versión que manda un
//    Edge conectado y el olvido por HTTP con su auditoría.
// D. En Chrome real, la pantalla entera.
import assert from 'assert';
import vm from 'vm';
import { randomUUID, createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { PAPELES, papelParaColumnas } from '../src/services/impresionSelfService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}`); }
}

const PANEL = readFileSync(join(__dirname, '../panel/index.html'), 'utf8');
const MODULO = readFileSync(join(__dirname, '../panel/impresorasEquipos.js'), 'utf8');

// El módulo del panel, cargado en un «navegador» mínimo.
function cargarModulo({ confirmar = () => true, respuestas = {}, categorias = undefined } = {}) {
  const llamadas = [];
  const avisos = [];
  const window = {
    confirm: (m) => { llamadas.push({ confirm: m }); return confirmar(m); },
    apiFetch: async (url, opts = {}) => {
      llamadas.push({ url, metodo: opts.method || 'GET', cuerpo: opts.body ? JSON.parse(opts.body) : null });
      const r = respuestas[`${opts.method || 'GET'} ${url}`] || { status: 200, body: {} };
      return { ok: r.status < 400, status: r.status, json: async () => r.body };
    },
    impProgreso: (txt, error) => avisos.push({ txt, error: !!error }),
    cargarImpresoras: async () => { llamadas.push({ recargar: true }); },
    impCategoriasPrep: categorias,
  };
  const document = { getElementById: () => null };
  vm.runInNewContext(MODULO, { window, document, Date, JSON, Math, String, encodeURIComponent, isFinite });
  return { XI: window.XaborImpresoras, llamadas, avisos };
}

// Lo que el usuario alcanza a leer de un bloque de JS que arma HTML (mismo
// criterio que fase-impresion-autoservicio).
function textoVisible(js) {
  const sinComentarios = js.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const literales = sinComentarios.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) || [];
  return literales.map((s) => s.slice(1, -1)).join(' ').replace(/<[^>]*>/g, ' ');
}

const hace = (min) => new Date(Date.now() - min * 60000).toISOString();

// ═══════════ A. Sin base ═══════════
console.log('\nA. Papel y panel');

await t('A', '1. «80 mm a todo lo ancho» son 48 columnas, y una impresora en 48 se reconoce así', () => {
  assert.deepStrictEqual(Object.fromEntries(Object.entries(PAPELES).map(([k, v]) => [k, v.columnas])), { 58: 32, 80: 42, '80-completo': 48 });
  assert.strictEqual(papelParaColumnas(32), '58');
  assert.strictEqual(papelParaColumnas(42), '80');
  assert.strictEqual(papelParaColumnas(48), '80-completo');
  assert.strictEqual(papelParaColumnas(44), '80');
  assert.strictEqual(papelParaColumnas(null), '80');
});

await t('A', '2. index.html carga el módulo con su huella y lo usa en equipos, papel y rutas', () => {
  const huella = createHash('sha256').update(MODULO).digest('hex').slice(0, 8);
  const m = /<script src="\/impresorasEquipos\.js\?v=([0-9a-f]{8})"><\/script>/.exec(PANEL);
  assert.ok(m, 'falta la etiqueta de impresorasEquipos.js con ?v=');
  assert.strictEqual(m[1], huella, `el ?v= dice "${m[1]}" y el archivo tiene huella "${huella}": pon "${huella}" en index.html`);
  const pintar = PANEL.slice(PANEL.indexOf('function pintarImpresoras()'), PANEL.indexOf('function renderRutasPreparacion()'));
  for (const uso of ['XI.estadoEquipo(eq)', 'XI.botonOlvidar(eq)', 'XI.notaEquipo(eq)', 'XI.ayudaPapel()', 'a.papel ||']) {
    assert.ok(pintar.includes(uso), `pintarImpresoras no usa ${uso}`);
  }
  assert.ok(/function renderRutasPreparacion\(\) \{\s*return window\.XaborImpresoras \? window\.XaborImpresoras\.rutasHtml\(impEstado/.test(PANEL),
    'las rutas no las pinta el módulo');
  assert.ok(PANEL.includes('impEstado.papeles ||'), 'el selector de papel no ofrece los papeles del servidor');
  assert.ok(/body: JSON\.stringify\(\{ terminalId: equipoId, nombreWindows: nombre, destinos: destinos, papel: papel \}\)/.test(PANEL),
    'Guardar no manda el papel elegido (volvería a 42 una impresora en 48)');
  for (const viejo of ['guardarRutaPreparacion', 'eliminarRutaPreparacion', 'impImpresorasPrep', 'impRutasPrep']) {
    assert.ok(!PANEL.includes(viejo), `quedó ${viejo} en index.html`);
  }
});

await t('A', '3. sin jerga técnica a la vista y sin ids internos pintados', () => {
  const visible = textoVisible(MODULO);
  for (const palabra of ['spooler', 'WebSocket', 'terminal', 'ambito', 'impresion_rutas', 'token', 'uuid', 'columnas']) {
    assert.ok(!new RegExp(palabra, 'i').test(visible), `"${palabra}" aparece en el texto de la pantalla`);
  }
});

await t('A', '4. estado de cada equipo: conectado con versión, versión vieja, nunca conectado, desde cuándo', () => {
  const { XI } = cargarModulo();
  const con = XI.estadoEquipo({ conectado: true, version: '1.2.0' });
  assert.ok(con.includes('Conectado') && con.includes('Xabor Edge 1.2.0'), con);
  assert.strictEqual(XI.notaEquipo({ conectado: true, version: '1.2.0' }), '');
  assert.ok(XI.notaEquipo({ conectado: true, version: null }).includes('versi&oacute;n anterior'), 'un Edge viejo no se señala');
  assert.ok(XI.estadoEquipo({ conectado: false, nuncaConectado: true }).includes('Nunca se ha conectado'));
  assert.ok(XI.estadoEquipo({ conectado: false, ultimaConexion: hace(3 * 24 * 60) }).includes('hace 3 días'));
  assert.ok(XI.estadoEquipo({ conectado: false, ultimaConexion: hace(5 * 60) }).includes('hace 5 horas'));
  assert.ok(XI.estadoEquipo({ conectado: false, ultimaConexion: hace(10) }).includes('hace 10 minutos'));
  assert.strictEqual(XI.botonOlvidar({ id: 'x', nombre: 'Caja', conectado: true }), '', 'un equipo conectado no se ofrece olvidar');
  assert.ok(XI.botonOlvidar({ id: 'x', nombre: 'Caja', conectado: false }).includes('Olvidar este equipo'));
});

const ESTADO_EJEMPLO = {
  impresorasParaRutas: [
    { id: 'i-coc', nombre: 'COCINA', equipoNombre: 'PC caja' },
    { id: 'i-beb', nombre: 'BEBIDAS', equipoNombre: 'PC barra' },
  ],
  rutasPreparacion: [
    { id: 'r1', ambito: 'categoria', clave: 'bebidas', impresoraId: 'i-beb', impresoraNombre: 'BEBIDAS', equipoNombre: 'PC barra', estado: 'equipo_desconectado' },
    { id: 'r2', ambito: 'categoria', clave: 'Postres', impresoraId: 'i-vieja', impresoraNombre: 'POSTRES VIEJA', equipoNombre: 'PC vieja', estado: 'impresora_apagada' },
    { id: 'r4', ambito: 'categoria', clave: 'ensaladas frias', impresoraId: 'i-coc', impresoraNombre: 'COCINA', equipoNombre: 'PC caja', estado: 'ok' },
    { id: 'r3', ambito: 'producto', clave: '<img src=x onerror=alert(1)>', impresoraId: 'i-coc', impresoraNombre: 'COCINA', equipoNombre: 'PC caja', estado: 'ok' },
  ],
  porDefecto: { comanda: [{ impresoraNombre: 'COCINA', equipoNombre: 'PC caja', estado: 'ok' }], cuenta: [] },
};

await t('A', '5. rutas: se ve qué sale dónde y se marcan las que no funcionan', () => {
  const { XI } = cargarModulo();
  // Las claves llegan normalizadas (sin acentos, minúsculas): se muestran con el nombre del menú.
  const html = XI.rutasHtml(ESTADO_EJEMPLO, ['Bebidas', 'Tacos', 'Ensaladas Frías']);
  assert.ok(html.includes('<b>Ensaladas Frías</b>'), 'la ruta no se muestra con el nombre del menú');
  assert.ok(html.includes('Ensaladas Frías (ya tiene ruta)'), 'con acentos no se reconoce que ya tiene ruta');
  assert.ok(!html.includes('Tacos (ya tiene ruta)'));
  const huerfana = XI.rutasHtml({ ...ESTADO_EJEMPLO, rutasPreparacion: [{ ...ESTADO_EJEMPLO.rutasPreparacion[0], clave: 'aguas frescas' }] }, []);
  assert.ok(huerfana.includes('<b>Aguas frescas</b>'), 'una categoría que ya no está en el menú sale en minúsculas');
  const r1 = html.slice(html.indexOf('<b>Bebidas</b>'), html.indexOf('<b>Postres</b>'));
  assert.ok(r1.includes('no est&aacute; conectado'), 'una ruta a un equipo sin conexión no avisa');
  const r2 = html.slice(html.indexOf('<b>Postres</b>'));
  assert.ok(r2.includes('fuera de uso'), 'una ruta a una impresora apagada no avisa');
  assert.ok(r2.includes('POSTRES VIEJA (fuera de uso)</option>'), 'no se ve a dónde apunta hoy la ruta rota');
  assert.ok(html.includes('Todo lo dem&aacute;s (Cocina)</b> &rarr; COCINA'), 'falta a dónde va lo que no tiene ruta');
  assert.ok(/Ticket del cliente \(Caja\)<\/b> &rarr; <span[^>]*>ninguna<\/span>/.test(html), 'sin impresora de ticket debe decir «ninguna»');
  assert.ok(html.includes('(platillo)'), 'una ruta por platillo no se distingue');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;') && !html.includes('<img src=x'), 'el nombre de la ruta no se escapa');
  assert.ok(html.includes('Bebidas (ya tiene ruta)'), 'al agregar no se ve qué categoría ya tiene ruta');
  assert.ok(html.includes('COCINA &middot; PC caja'), 'con varios equipos, cada impresora debe decir de cuál');
});

await t('A', '6. cambiar y quitar una ruta llaman a la API correcta; quitar pide confirmación', async () => {
  const { XI, llamadas } = cargarModulo();
  await XI.cambiarRuta('r1', { value: 'i-coc' });
  assert.deepStrictEqual(llamadas.find(l => l.url)?.cuerpo, { impresoraId: 'i-coc' });
  assert.strictEqual(llamadas.find(l => l.url).metodo, 'PATCH');
  assert.strictEqual(llamadas.find(l => l.url).url, '/api/impresion/rutas/r1');
  const nada = cargarModulo({ confirmar: () => false });
  await nada.XI.quitarRuta('r2', 'Postres');
  assert.ok(!nada.llamadas.some(l => l.url), 'quitar sin confirmar llamó a la API');
  const si = cargarModulo();
  await si.XI.quitarRuta('r2', 'Postres');
  assert.ok(si.llamadas.some(l => l.url === '/api/impresion/rutas/r2' && l.metodo === 'DELETE'));
});

await t('A', '7. olvidar: primero dice qué se pierde, y sin confirmar no olvida', async () => {
  const resumen = { status: 200, body: { conectado: false, impresoras: ['POS 1'], trabajosEnEspera: 70,
    rutas: [{ ambito: 'categoria', clave: 'Bebidas' }, { ambito: 'documento', clave: 'comanda' }] } };
  const no = cargarModulo({ confirmar: () => false, respuestas: { 'GET /api/impresion/edges/e1/olvido': resumen } });
  await no.XI.olvidar('e1', 'PC-CAJA');
  const msg = no.llamadas.find(l => l.confirm)?.confirm || '';
  assert.ok(msg.includes('PC-CAJA') && msg.includes('70 impresiones') && msg.includes('Bebidas') && msg.includes('POS 1'), msg);
  assert.ok(!msg.includes('comanda'), 'el aviso habla de rutas internas de documento');
  assert.ok(!no.llamadas.some(l => l.metodo === 'POST'), 'olvidó sin confirmar');
  // Con menú, el aviso usa su nombre (las claves se guardan sin acentos).
  const conMenu = cargarModulo({ confirmar: () => false, categorias: ['Bebidas Frías'], respuestas: { 'GET /api/impresion/edges/e1/olvido':
    { status: 200, body: { ...resumen.body, rutas: [{ ambito: 'categoria', clave: 'bebidas frias' }] } } } });
  await conMenu.XI.olvidar('e1', 'PC-CAJA');
  assert.ok((conMenu.llamadas.find(l => l.confirm)?.confirm || '').includes('(Bebidas Frías)'), 'el aviso no usa el nombre del menú');
  const si = cargarModulo({ respuestas: { 'GET /api/impresion/edges/e1/olvido': resumen,
    'POST /api/impresion/edges/e1/olvidar': { status: 200, body: { ok: true, trabajosCancelados: 70 } } } });
  await si.XI.olvidar('e1', 'PC-CAJA');
  assert.ok(si.llamadas.some(l => l.url === '/api/impresion/edges/e1/olvidar' && l.metodo === 'POST'));
  assert.ok(si.llamadas.some(l => l.recargar), 'tras olvidar no se refresca la pantalla');
  assert.ok(si.avisos.some(a => a.txt.includes('70 impresiones')), JSON.stringify(si.avisos));
  const vivo = cargarModulo({ respuestas: { 'GET /api/impresion/edges/e1/olvido': { status: 200, body: { ...resumen.body, conectado: true } } } });
  await vivo.XI.olvidar('e1', 'PC-CAJA');
  assert.ok(!vivo.llamadas.some(l => l.confirm), 'a un equipo conectado se le ofreció olvidar');
  assert.ok(vivo.avisos.some(a => a.error), 'un equipo conectado debe explicar por qué no');
});

// ═══════════ B, C, D: con Postgres ═══════════
const SEED_PATH = join(__dirname, '.datos-prueba.json');
const url = process.env.DATABASE_URL || '';
if (!url || /railway|rlwy/.test(url) || !existsSync(SEED_PATH)) {
  console.log('\n(Partes B, C y D omitidas: hace falta DATABASE_URL local y test/.datos-prueba.json)');
} else {
  console.log('\nB. Servicios');
  const SEED = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  const { pool } = await import('../src/services/database.js');
  const S = await import('../src/services/impresionService.js');
  const SS = await import('../src/services/impresionSelfService.js');
  const EQ = await import('../src/services/equiposImpresion.js');
  const ED = await import('../src/services/edgeService.js');
  const nid = SEED.negocioA;
  const nidB = SEED.negocioB;
  const sufijo = randomUUID().slice(0, 8);
  const { rows: [suc] } = await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1, $2) RETURNING id`, [nid, `Equipos ${sufijo}`]);
  const sid = suc.id;
  const equipo = (nombre) => ED.crearEdge(nid, { nombre: `${nombre}-${sufijo}`, sucursalId: sid });
  const latido = (id, sql) => pool.query(`UPDATE terminales SET ultima_conexion = ${sql} WHERE id = $1`, [id]);
  const trabajo = async (term, imp, estado) => (await pool.query(
    `INSERT INTO impresion_trabajos (negocio_id, sucursal_id, terminal_id, impresora_id, impresora_nombre, documento,
                                     origen_tipo, origen_id, idempotency_key, payload, estado)
     VALUES ($1,$2,$3,$4,$5,'comanda','prueba_equipos',$6,$7,'{}'::jsonb,$8) RETURNING id`,
    [nid, sid, term.id, imp.id, imp.nombre, randomUUID(), `eq-${randomUUID()}`, estado])).rows[0].id;

  const viva = await equipo('VIVA');
  const vieja = await equipo('VIEJA');
  const fantasma = await equipo('FANTASMA');
  const reciente = await equipo('RECIENTE');
  await latido(viva.id, 'NOW()');
  await latido(vieja.id, "NOW() - INTERVAL '3 days'");
  await latido(reciente.id, "NOW() - INTERVAL '30 seconds'");
  const cocina = await S.crearImpresora(nid, { terminalId: viva.id, nombre: `COCINA-${sufijo}`, transporte: 'mock' });
  const barra = await S.crearImpresora(nid, { terminalId: vieja.id, nombre: `BARRA-${sufijo}`, transporte: 'mock' });
  const apagada = await S.crearImpresora(nid, { terminalId: viva.id, nombre: `APAGADA-${sufijo}`, transporte: 'mock' });
  await S.actualizarImpresora(nid, apagada.id, { activa: false });
  const postresImp = await S.crearImpresora(nid, { terminalId: reciente.id, nombre: `POSTRES-${sufijo}`, transporte: 'mock' });
  const cat = (x) => `${x}-${sufijo}`;
  const rBebidas = await S.crearRuta(nid, { impresoraId: barra.id, ambito: 'categoria', clave: cat('Bebidas') });
  const rEnsaladas = await S.crearRuta(nid, { impresoraId: apagada.id, ambito: 'categoria', clave: cat('Ensaladas') });
  const rPostres = await S.crearRuta(nid, { impresoraId: postresImp.id, ambito: 'categoria', clave: cat('Postres') });
  const rChilaquiles = await S.crearRuta(nid, { impresoraId: cocina.id, ambito: 'producto', clave: cat('Chilaquiles') });
  await S.crearRuta(nid, { impresoraId: cocina.id, ambito: 'documento', clave: 'comanda' });

  const conectadas = new Set([viva.id]);
  const versiones = new Map([[viva.id, '1.2.0']]);
  const estado = () => SS.estadoImpresorasNegocio(nid, {
    pedirImpresoras: async (id) => ({ ok: true, conectado: conectadas.has(id), impresoras: [] }),
    versionDeTerminal: (id) => versiones.get(id) ?? null,
  });
  const eqDe = (e, term) => e.equipos.find(x => x.id === term.id);
  const rutaDe = (e, r) => e.rutasPreparacion.find(x => x.id === r.id);

  let srv = null;
  try {
    await t('B', '8. cada equipo dice si nunca se conectó, desde cuándo y su versión', async () => {
      const e = await estado();
      assert.strictEqual(eqDe(e, fantasma).nuncaConectado, true);
      assert.strictEqual(eqDe(e, vieja).nuncaConectado, false);
      assert.ok(Date.now() - new Date(eqDe(e, vieja).ultimaConexion).getTime() > 2 * 24 * 3600 * 1000);
      assert.strictEqual(eqDe(e, viva).version, '1.2.0');
      assert.strictEqual(eqDe(e, viva).conectado, true);
      assert.strictEqual(eqDe(e, vieja).version, null);
      assert.deepStrictEqual(e.papeles.map(p => p.v), ['58', '80', '80-completo']);
    });

    await t('B', '9. cada ruta trae su estado con el mismo criterio que el reparto', async () => {
      const e = await estado();
      assert.strictEqual(rutaDe(e, rBebidas).estado, 'equipo_desconectado', 'equipo sin señal hace 3 días');
      assert.strictEqual(rutaDe(e, rEnsaladas).estado, 'impresora_apagada');
      assert.strictEqual(rutaDe(e, rPostres).estado, 'ok', 'señal hace 30 s: dentro de la gracia de 2 minutos');
      assert.strictEqual(rutaDe(e, rChilaquiles).estado, 'ok');
      assert.strictEqual(rutaDe(e, rChilaquiles).ambito, 'producto');
      assert.ok(e.porDefecto.comanda.some(d => d.impresoraNombre === cocina.nombre && d.estado === 'ok'));
      const ids = e.impresorasParaRutas.map(i => i.id);
      assert.ok(ids.includes(cocina.id) && ids.includes(barra.id), 'faltan impresoras en uso');
      assert.ok(!ids.includes(apagada.id), 'una impresora fuera de uso no se ofrece');
      assert.strictEqual(e.impresorasParaRutas.find(i => i.id === cocina.id).equipoNombre, viva.nombre);
    });

    await t('B', '10. cambiar una ruta de impresora: solo a una en uso, del negocio y sin duplicar', async () => {
      const r = await S.cambiarImpresoraDeRuta(nid, rBebidas.id, cocina.id);
      assert.strictEqual(r.impresora_id, cocina.id);
      assert.strictEqual(rutaDe(await estado(), rBebidas).estado, 'ok');
      const falla = async (fn, code) => { await assert.rejects(fn, (e) => e.code === code, `se esperaba ${code}`); };
      await falla(() => S.cambiarImpresoraDeRuta(nid, rBebidas.id, apagada.id), 'IMPRESORA_INACTIVA');
      const { rows: [ajena] } = await pool.query(`SELECT id FROM impresoras WHERE negocio_id <> $1 LIMIT 1`, [nid]);
      if (ajena) await falla(() => S.cambiarImpresoraDeRuta(nid, rBebidas.id, ajena.id), 'IMPRESORA_NO_ENCONTRADA');
      // Del mismo negocio pero de OTRA sucursal: las reglas son por sucursal.
      const { rows: [suc2] } = await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1, $2) RETURNING id`, [nid, `Equipos 2 ${sufijo}`]);
      const pc2 = await ED.crearEdge(nid, { nombre: `OTRA-SUC-${sufijo}`, sucursalId: suc2.id });
      const imp2 = await S.crearImpresora(nid, { terminalId: pc2.id, nombre: `OTRA-SUC-${sufijo}`, transporte: 'mock' });
      await falla(() => S.cambiarImpresoraDeRuta(nid, rBebidas.id, imp2.id), 'IMPRESORA_NO_ENCONTRADA');
      await pool.query(`UPDATE terminales SET activo = false WHERE id = $1`, [pc2.id]);
      await pool.query(`UPDATE impresoras SET activa = false WHERE id = $1`, [imp2.id]);
      await falla(() => S.cambiarImpresoraDeRuta(nidB, rBebidas.id, cocina.id), 'RUTA_NO_ENCONTRADA');
      await falla(() => S.cambiarImpresoraDeRuta(nid, 'no-es-uuid', cocina.id), 'RUTA_NO_ENCONTRADA');
      const otra = await S.crearRuta(nid, { impresoraId: barra.id, ambito: 'categoria', clave: cat('Bebidas') });
      await falla(() => S.cambiarImpresoraDeRuta(nid, otra.id, cocina.id), 'RUTA_DUPLICADA');
      await S.eliminarRuta(nid, otra.id);
      await S.cambiarImpresoraDeRuta(nid, rBebidas.id, barra.id);
    });

    await t('B', '11. el papel de 48 sobrevive a «Guardar» y a «Imprimir prueba»; «80 mm» sigue siendo 42', async () => {
      const ventana = `EC LINE 80-${sufijo}`;
      const ancho = async () => (await pool.query(
        `SELECT ancho_columnas FROM impresoras WHERE terminal_id = $1 AND config->>'spoolerNombre' = $2`, [viva.id, ventana])).rows[0]?.ancho_columnas;
      let r = await SS.asignarImpresora(nid, { terminalId: viva.id, nombreWindows: ventana, destinos: ['cocina'], papel: '80-completo' });
      assert.ok(r.ok, r.error);
      assert.strictEqual(await ancho(), 48);
      assert.strictEqual(r.papel, '80-completo');
      await SS.registrarImpresoraParaPrueba(nid, { terminalId: viva.id, nombreWindows: ventana });
      assert.strictEqual(await ancho(), 48, 'imprimir prueba cambió el ancho');
      const e = await estado();
      assert.strictEqual(eqDe(e, viva).asignadas.find(a => a.nombreWindows === ventana).papel, '80-completo');
      r = await SS.asignarImpresora(nid, { terminalId: viva.id, nombreWindows: ventana, destinos: ['cocina'], anchoMm: 80 });
      assert.strictEqual(await ancho(), 42, 'anchoMm 80 de siempre');
      r = await SS.asignarImpresora(nid, { terminalId: viva.id, nombreWindows: ventana, destinos: ['cocina'], papel: '58' });
      assert.strictEqual(await ancho(), 32);
      r = await SS.asignarImpresora(nid, { terminalId: viva.id, nombreWindows: ventana, destinos: ['cocina'], papel: '96' });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(await ancho(), 32, 'un papel inválido cambió algo');
      await SS.quitarImpresora(nid, { terminalId: viva.id, nombreWindows: ventana });
    });

    const tVieja = {};
    await t('B', '12. antes de olvidar se sabe qué se pierde', async () => {
      tVieja.pendiente = await trabajo(vieja, barra, 'pendiente');
      tVieja.entregado = await trabajo(vieja, barra, 'entregado');
      tVieja.fallido = await trabajo(vieja, barra, 'fallido');
      tVieja.incierto = await trabajo(vieja, barra, 'incierto');
      tVieja.agotado = await trabajo(vieja, barra, 'agotado');
      tVieja.enviado = await trabajo(vieja, barra, 'enviado');
      const r = await EQ.resumenParaOlvidar(nid, vieja.id);
      assert.strictEqual(r.trabajosEnEspera, 3);
      assert.deepStrictEqual(r.impresoras, [barra.nombre]);
      assert.deepStrictEqual(r.rutas.map(x => x.clave), [cat('Bebidas').toLowerCase()], 'las claves se guardan normalizadas');
      assert.strictEqual(r.conectado, false);
      assert.strictEqual((await EQ.resumenParaOlvidar(nid, reciente.id)).conectado, true, 'señal hace 30 s cuenta como conectado');
    });

    await t('B', '13. un equipo conectado, con señal reciente o de otro negocio no se olvida', async () => {
      await assert.rejects(() => EQ.olvidarEquipo(nid, viva.id, { estaConectado: (id) => conectadas.has(id) }), (e) => e.code === 'EQUIPO_CONECTADO');
      await assert.rejects(() => EQ.olvidarEquipo(nid, reciente.id), (e) => e.code === 'EQUIPO_CONECTADO');
      await assert.rejects(() => EQ.olvidarEquipo(nidB, vieja.id), (e) => e.code === 'EDGE_NO_ENCONTRADO');
      await assert.rejects(() => EQ.resumenParaOlvidar(nidB, vieja.id), (e) => e.code === 'EDGE_NO_ENCONTRADO');
      await assert.rejects(() => EQ.olvidarEquipo(nid, 'x'), (e) => e.code === 'EDGE_NO_ENCONTRADO');
      const { rows: [v] } = await pool.query(`SELECT activo FROM terminales WHERE id = $1`, [vieja.id]);
      assert.strictEqual(v.activo, true);
      const { rows: [j] } = await pool.query(`SELECT estado FROM impresion_trabajos WHERE id = $1`, [tVieja.pendiente]);
      assert.strictEqual(j.estado, 'pendiente', 'un intento rechazado tocó trabajos');
    });

    await t('B', '14. olvidar: cancela lo que esperaba, quita rutas, apaga y renombra, retira la credencial y lo registra', async () => {
      const { codigo } = await ED.generarEmparejamiento(nid, vieja.id);
      await ED.canjearEmparejamiento(codigo);
      const { codigo: sinUsar } = await ED.generarEmparejamiento(nid, vieja.id);
      const r = await EQ.olvidarEquipo(nid, vieja.id, { actor: { actorUsuarioId: SEED.adminNegocioAUsuarioId } });
      assert.deepStrictEqual([r.trabajosCancelados, r.rutasQuitadas, r.impresorasApagadas], [3, 1, 1]);
      const estados = Object.fromEntries(await Promise.all(Object.entries(tVieja).map(async ([k, id]) =>
        [k, (await pool.query(`SELECT estado, motivo FROM impresion_trabajos WHERE id = $1`, [id])).rows[0]])));
      for (const k of ['pendiente', 'entregado', 'fallido']) {
        assert.strictEqual(estados[k].estado, 'cancelado', `${k} no se canceló`);
        assert.strictEqual(estados[k].motivo, EQ.MOTIVO_OLVIDO);
      }
      for (const k of ['incierto', 'agotado', 'enviado']) assert.strictEqual(estados[k].estado, k, `${k} no debía tocarse`);
      const { rows: [term] } = await pool.query(`SELECT activo, token_hash, nombre, codigo FROM terminales WHERE id = $1`, [vieja.id]);
      assert.strictEqual(term.activo, false);
      assert.strictEqual(term.token_hash, null, 'la credencial sigue viva');
      assert.ok(term.nombre.startsWith(vieja.nombre + ' (olvidado') && term.codigo !== vieja.codigo, term.nombre);
      const { rows: [imp] } = await pool.query(`SELECT activa, nombre FROM impresoras WHERE id = $1`, [barra.id]);
      assert.strictEqual(imp.activa, false);
      assert.ok(imp.nombre !== barra.nombre);
      assert.strictEqual((await pool.query(`SELECT 1 FROM impresion_rutas WHERE id = $1`, [rBebidas.id])).rowCount, 0);
      await assert.rejects(() => ED.canjearEmparejamiento(sinUsar), 'un código sin usar todavía sirve');
      assert.strictEqual((await pool.query(
        `SELECT 1 FROM edge_emparejamientos WHERE terminal_id = $1 AND usado_at IS NULL`, [vieja.id])).rowCount, 0,
        'quedó un código de vinculación vigente');
      const { rows: aud } = await pool.query(
        `SELECT actor_usuario_id FROM auditoria_plataforma WHERE negocio_id = $1 AND accion = 'olvidar_equipo_impresion'
            AND estado_anterior->>'terminalId' = $2`, [nid, vieja.id]);
      assert.strictEqual(aud.length, 1, 'no quedó en auditoría');
      assert.strictEqual(aud[0].actor_usuario_id, SEED.adminNegocioAUsuarioId);
      const e = await estado();
      assert.ok(!eqDe(e, vieja), 'el equipo olvidado sigue en la pantalla');
      assert.ok(!(await ED.listarEdges(nid, { soloActivos: true })).some(x => x.id === vieja.id));
      assert.ok((await ED.listarEdges(nid)).some(x => x.id === vieja.id), 'el historial del equipo debe quedarse');
      await assert.rejects(() => EQ.olvidarEquipo(nid, vieja.id), (x) => x.code === 'EDGE_NO_ENCONTRADO');
    });

    await t('B', '15. después se puede dar de alta otra vez el mismo nombre y la misma impresora', async () => {
      const otra = await ED.crearEdge(nid, { nombre: vieja.nombre, sucursalId: sid });
      const r = await S.crearImpresora(nid, { terminalId: otra.id, nombre: barra.nombre, transporte: 'mock' });
      assert.strictEqual(r.nombre, barra.nombre);
    });

    await t('B', '16. lo que salía en el equipo olvidado sale en Cocina, sin desvío ni espera', async () => {
      const otra = await equipo('ESTACION');
      const estacion = await S.crearImpresora(nid, { terminalId: otra.id, nombre: `ESTACION-${sufijo}`, transporte: 'mock' });
      await S.crearRuta(nid, { impresoraId: estacion.id, ambito: 'categoria', clave: cat('Tacos') });
      await latido(otra.id, "NOW() - INTERVAL '2 days'");
      S.setConexionTerminal((id) => conectadas.has(id));
      try {
        const pedido = () => ({ id: `XAB-E${randomUUID().slice(0, 6)}`, negocioId: nid, canal: 'pos',
          items: [{ producto: `Taco ${sufijo}`, categoria: cat('Tacos'), cantidad: 1 }] });
        const antes = await S.crearTrabajosDePedido({ negocioId: nid, sucursalId: sid, pedido: pedido() });
        assert.deepStrictEqual(antes.desviadas.map(d => d.de), [estacion.nombre], 'antes de olvidar debía desviarse');
        await EQ.olvidarEquipo(nid, otra.id);
        const despues = await S.crearTrabajosDePedido({ negocioId: nid, sucursalId: sid, pedido: pedido() });
        assert.deepStrictEqual(despues.creados.map(c => c.impresora_nombre), [cocina.nombre]);
        assert.deepStrictEqual([despues.desviadas, despues.enEspera], [[], []]);
        await pool.query(`UPDATE impresion_trabajos SET estado = 'cancelado' WHERE sucursal_id = $1 AND estado = 'pendiente'`, [sid]);
      } finally { S._resetConexionTerminalParaPruebas(); }
    });

    // ═══════════ C. Servidor real ═══════════
    console.log('\nC. Servidor');
    const { arrancarServidor } = await import('./lib-servidor.mjs');
    const { crearTokenSesion } = await import('../src/services/session.js');
    const PUERTO = process.env.TEST_PORT || '4985';
    const base = `http://localhost:${PUERTO}`;
    const sesion = (usuarioId, rol) => encodeURIComponent(crearTokenSesion({ usuarioId, negocioId: nid, rol }));
    const ADMIN = sesion(SEED.adminNegocioAUsuarioId, 'admin');
    const STAFF = sesion(SEED.staffNegocioAUsuarioId, 'staff');
    const api = async (ruta, { metodo = 'GET', cuerpo, cookie = ADMIN } = {}) => {
      const r = await fetch(base + ruta, { method: metodo,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: `xabor_sesion=${cookie}` } : {}) },
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 90000 });

    const enLinea = await equipo('ENLINEA');
    const { codigo } = await ED.generarEmparejamiento(nid, enLinea.id);
    const cred = await ED.canjearEmparejamiento(codigo);
    const agente = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PUERTO}/ws/print-agent`);
      ws.on('open', () => ws.send(JSON.stringify({ tipo: 'autenticar_terminal', terminalId: cred.terminalId, token: cred.token,
        instalacionId: `inst-${sufijo}`, version: '1.2.0' })));
      ws.on('message', (crudo) => {
        const msg = JSON.parse(crudo.toString());
        if (msg.tipo === 'terminal_autenticada') resolve(ws);
        if (msg.tipo === 'solicitar_impresoras') {
          ws.send(JSON.stringify({ tipo: 'impresoras_detectadas', solicitudId: msg.solicitudId, ok: true,
            impresoras: [{ nombre: `EC LINE-${sufijo}`, predeterminada: true, estado: 'listo' }] }));
        }
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('el Edge de prueba no se autenticó')), 8000);
    });
    // Cocina de verdad en el equipo conectado, para la parte D.
    await SS.asignarImpresora(nid, { terminalId: enLinea.id, nombreWindows: `EC LINE-${sufijo}`, destinos: ['cocina'], papel: '80' });

    await t('C', '17. solo administradores: olvidar, ver qué se pierde y cambiar rutas', async () => {
      for (const [metodo, ruta] of [['GET', `/api/impresion/edges/${fantasma.id}/olvido`], ['POST', `/api/impresion/edges/${fantasma.id}/olvidar`],
                                    ['PATCH', `/api/impresion/rutas/${rPostres.id}`]]) {
        assert.strictEqual((await api(ruta, { metodo, cookie: STAFF, cuerpo: metodo === 'GET' ? undefined : {} })).status, 403, `${metodo} ${ruta} con staff`);
        assert.ok([401, 403].includes((await api(ruta, { metodo, cookie: null, cuerpo: metodo === 'GET' ? undefined : {} })).status), `${metodo} ${ruta} sin sesión`);
      }
      const { rows: [f] } = await pool.query(`SELECT activo FROM terminales WHERE id = $1`, [fantasma.id]);
      assert.strictEqual(f.activo, true);
    });

    await t('C', '18. la pantalla ve la versión del Edge conectado, y ese equipo no se puede olvidar', async () => {
      const r = await api('/api/impresion/self-service');
      assert.strictEqual(r.status, 200);
      const e = r.body.equipos.find(x => x.id === enLinea.id);
      assert.strictEqual(e.conectado, true);
      assert.strictEqual(e.version, '1.2.0');
      assert.strictEqual(r.body.equipos.find(x => x.id === fantasma.id).nuncaConectado, true);
      // Con la última señal vieja en la base, lo que lo protege es el socket abierto.
      await latido(enLinea.id, "NOW() - INTERVAL '1 hour'");
      const no = await api(`/api/impresion/edges/${enLinea.id}/olvidar`, { metodo: 'POST' });
      assert.strictEqual(no.status, 409);
      assert.match(no.body.error, /conectado/);
      assert.strictEqual((await api(`/api/impresion/edges/${enLinea.id}/olvido`)).body.conectado, true);
    });

    await t('C', '19. olvidar por HTTP, con auditoría a nombre del administrador; otro negocio no lo ve', async () => {
      // Una sesión de otro negocio no alcanza el equipo (404 si llega al servicio, 403 si la membresía lo frena antes).
      const ajeno = await api(`/api/impresion/edges/${fantasma.id}/olvidar`, { metodo: 'POST',
        cookie: encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: nidB, rol: 'admin' })) });
      assert.ok([403, 404].includes(ajeno.status), `otro negocio respondió ${ajeno.status}`);
      assert.strictEqual((await pool.query('SELECT activo FROM terminales WHERE id = $1', [fantasma.id])).rows[0].activo, true);
      const r = await api(`/api/impresion/edges/${fantasma.id}/olvidar`, { metodo: 'POST' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.ok, true);
      const e = await api('/api/impresion/self-service');
      assert.ok(!e.body.equipos.some(x => x.id === fantasma.id));
      const { rows } = await pool.query(`SELECT actor_usuario_id FROM auditoria_plataforma WHERE accion = 'olvidar_equipo_impresion' AND estado_anterior->>'terminalId' = $1`, [fantasma.id]);
      assert.deepStrictEqual(rows.map(x => x.actor_usuario_id), [SEED.adminNegocioAUsuarioId]);
    });

    await t('C', '20. cambiar una ruta y elegir el papel por HTTP', async () => {
      const r = await api(`/api/impresion/rutas/${rPostres.id}`, { metodo: 'PATCH', cuerpo: { impresoraId: cocina.id } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual((await api(`/api/impresion/rutas/${rPostres.id}`, { metodo: 'PATCH', cuerpo: { impresoraId: apagada.id } })).status, 409);
      await api(`/api/impresion/rutas/${rPostres.id}`, { metodo: 'PATCH', cuerpo: { impresoraId: postresImp.id } });
      const p = await api('/api/impresion/self-service/asignar', { metodo: 'POST',
        cuerpo: { terminalId: enLinea.id, nombreWindows: `EC LINE-${sufijo}`, destinos: ['cocina'], papel: '80-completo' } });
      assert.strictEqual(p.status, 200, JSON.stringify(p.body));
      const e = await api('/api/impresion/self-service');
      assert.strictEqual(e.body.equipos.find(x => x.id === enLinea.id).asignadas[0].papel, '80-completo');
      await api('/api/impresion/self-service/asignar', { metodo: 'POST',
        cuerpo: { terminalId: enLinea.id, nombreWindows: `EC LINE-${sufijo}`, destinos: ['cocina'], papel: '80' } });
    });

    // ═══════════ D. Chrome ═══════════
    console.log('\nD. Navegador');
    await t('D', '21. en el panel: estados, papel de 48, cambiar una ruta y olvidar un equipo', async () => {
      // Un equipo viejo con una impresora, una ruta y dos comandas esperándolo.
      const pcVieja = await equipo('PCVIEJA');
      await latido(pcVieja.id, "NOW() - INTERVAL '3 days'");
      const impVieja = await S.crearImpresora(nid, { terminalId: pcVieja.id, nombre: `VIEJA IMP-${sufijo}`, transporte: 'mock' });
      const rVieja = await S.crearRuta(nid, { impresoraId: impVieja.id, ambito: 'categoria', clave: cat('Helados') });
      await trabajo(pcVieja, impVieja, 'pendiente');
      await trabajo(pcVieja, impVieja, 'pendiente');
      const fantasma2 = await equipo('FANTASMA2');

      const puppeteer = (await import('puppeteer')).default;
      const nav = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      const errores = [];
      const dialogos = [];
      try {
        const pag = await nav.newPage();
        pag.on('pageerror', e => errores.push(e.message));
        pag.on('dialog', d => { dialogos.push(d.message()); d.accept().catch(() => {}); });
        await pag.setViewport({ width: 1280, height: 900 });
        await pag.setCookie({ name: 'xabor_sesion', value: ADMIN, domain: 'localhost', path: '/' });
        await pag.goto(`${base}/app#config`, { waitUntil: 'networkidle0', timeout: 60000 });
        const abrir = async () => {
          await pag.evaluate(async () => { mostrarTab('config'); cfgIr('equipos'); await cargarImpresoras(); });
          await pag.waitForFunction(() => document.getElementById('impresoras-panel')?.textContent.includes('Rutas de preparaci'), { timeout: 20000 });
        };
        const bloque = async (nombre) => {
          const r = await pag.evaluate((n) => {
            const s = [...document.querySelectorAll('#impresoras-panel span')].find(x => x.textContent.trim() === n);
            return s ? s.parentElement.parentElement.textContent : null;
          }, nombre);
          if (r === null) {
            const visto = await pag.evaluate(() => document.getElementById('impresoras-panel')?.textContent.slice(0, 600));
            throw new Error(`no aparece el equipo «${nombre}» en la pantalla; se ve: ${visto}`);
          }
          return r;
        };
        await abrir();

        assert.match(await bloque(pcVieja.nombre), /Sin conexión desde hace 3 días/);
        assert.match(await bloque(pcVieja.nombre), /Olvidar este equipo/);
        assert.match(await bloque(fantasma2.nombre), /Nunca se ha conectado/);
        const linea = await bloque(enLinea.nombre);
        assert.match(linea, /Conectado ✓ · Xabor Edge 1\.2\.0/);
        assert.ok(!linea.includes('Olvidar este equipo'), 'a un equipo conectado se le ofrece olvidar');

        // Papel de 48: elegirlo, guardar, y que siga así al recargar.
        const sel = await pag.evaluate((n) => {
          const fila = [...document.querySelectorAll('#impresoras-panel div')].find(d => d.firstChild?.textContent === n && d.querySelector('select'));
          const s = fila.querySelector('select');
          return { id: s.id, opciones: [...s.options].map(o => o.textContent) };
        }, `EC LINE-${sufijo}`);
        assert.deepStrictEqual(sel.opciones, ['58 mm', '80 mm', '80 mm a todo lo ancho']);
        await pag.select(`#${sel.id}`, '80-completo');
        await pag.evaluate((id) => {
          const fila = document.getElementById(id).closest('div');
          [...fila.querySelectorAll('button')].find(b => b.textContent.trim() === 'Guardar').click();
        }, sel.id);
        await pag.waitForFunction(() => document.getElementById('imp-progreso')?.textContent.includes('ya est'), { timeout: 15000 });
        const { rows: [w] } = await pool.query(`SELECT ancho_columnas FROM impresoras WHERE terminal_id = $1 AND activa`, [enLinea.id]);
        assert.strictEqual(w.ancho_columnas, 48, 'Guardar no dejó 48 columnas');
        await pag.reload({ waitUntil: 'networkidle0' });
        await abrir();
        assert.strictEqual(await pag.$eval(`#${sel.id}`, s => s.value), '80-completo', 'al recargar volvió a otro papel');

        // La ruta a la PC vieja avisa; cambiarla a la cocina conectada quita el aviso.
        const filaRuta = () => pag.evaluate((c) => {
          const b = [...document.querySelectorAll('#impresoras-panel b')].find(x => x.textContent === c);
          return b ? b.closest('div[style*="border-bottom"]').textContent : null;
        }, cat('Helados'));
        assert.match(await filaRuta(), /no está conectado/);
        await pag.evaluate((c, imp) => {
          const b = [...document.querySelectorAll('#impresoras-panel b')].find(x => x.textContent === c);
          const s = b.closest('div[style*="border-bottom"]').querySelector('select');
          s.value = imp;
          s.dispatchEvent(new Event('change'));
        }, cat('Helados'), cocina.id);
        await pag.waitForFunction(() => document.getElementById('ruta-prep-msg')?.textContent.includes('Ruta cambiada'), { timeout: 15000 });
        assert.ok(!(await filaRuta()).includes('no está conectado'), 'el aviso siguió tras cambiar la ruta');
        assert.strictEqual((await pool.query(`SELECT impresora_id FROM impresion_rutas WHERE id = $1`, [rVieja.id])).rows[0].impresora_id, cocina.id);
        await S.cambiarImpresoraDeRuta(nid, rVieja.id, impVieja.id);
        await abrir();

        // Olvidar la PC vieja: el aviso dice lo que se pierde, y desaparece.
        await pag.evaluate((n) => {
          const s = [...document.querySelectorAll('#impresoras-panel span')].find(x => x.textContent.trim() === n);
          [...s.parentElement.querySelectorAll('button')].find(b => b.textContent.includes('Olvidar')).click();
        }, pcVieja.nombre);
        await pag.waitForFunction((n) => ![...document.querySelectorAll('#impresoras-panel span')].some(x => x.textContent.trim() === n),
          { timeout: 15000 }, pcVieja.nombre);
        const aviso = dialogos.find(d => d.includes(pcVieja.nombre)) || '';
        assert.ok(aviso.includes('2 impresiones') && aviso.includes(cat('Helados')) && aviso.includes(impVieja.nombre), aviso);
        await pag.waitForFunction(() => document.getElementById('imp-progreso')?.textContent.includes('ya no aparece'), { timeout: 10000 });
        assert.strictEqual((await pool.query(`SELECT activo FROM terminales WHERE id = $1`, [pcVieja.id])).rows[0].activo, false);

        // Teléfono: sin desbordar a lo ancho.
        await pag.setViewport({ width: 390, height: 844 });
        await new Promise(r => setTimeout(r, 300));
        const desborde = await pag.evaluate(() => {
          const s = document.getElementById('impresoras-panel');
          return s.scrollWidth - s.clientWidth;
        });
        assert.ok(desborde <= 2, `la pantalla se desborda ${desborde}px en un teléfono`);
        assert.deepStrictEqual(errores, [], `errores de JavaScript: ${errores.join(' | ')}`);
      } finally { await nav.close(); }
    });

    agente.close();
  } finally {
    srv?.detener();
    await pool.query(`UPDATE impresion_trabajos SET estado = 'cancelado' WHERE sucursal_id = $1 AND estado IN ('pendiente','entregado','fallido')`, [sid]).catch(() => {});
    await pool.query(`UPDATE terminales SET activo = false, token_hash = NULL WHERE sucursal_id = $1`, [sid]).catch(() => {});
    await pool.query(`UPDATE impresoras SET activa = false WHERE sucursal_id = $1`, [sid]).catch(() => {});
    await pool.query(`DELETE FROM impresion_rutas WHERE sucursal_id = $1`, [sid]).catch(() => {});
    await pool.end();
  }
}

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) console.log(fallos.join('\n'));
process.exitCode = fallidas > 0 ? 1 : 0;
