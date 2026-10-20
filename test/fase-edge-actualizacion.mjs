// Actualización automática de Xabor Edge.
//
// A. Verificador (installer/actualizador.mjs): solo acepta lo firmado con la
//    clave del dueño, con el SHA-256 y el tamaño exactos, rutas dentro de
//    edge/ y una versión mayor que no haya fallado antes.
// B. Lanzador (installer/lanzador.mjs), como proceso de verdad: aplica la
//    versión nueva, la deja a prueba, y regresa a la anterior si se cae al
//    arrancar, si ni siquiera carga o si no se conecta a tiempo.
// C. La parte del Edge (edge/actualizacion.js): de dónde baja, cuándo se
//    reinicia (cola quieta) y qué hace sin lanzador.
// D. De punta a punta con el servidor real y Postgres: la nube ofrece, el
//    Edge verifica, baja, prepara y pide reiniciarse; y todo lo que no debe
//    pasar no pasa.
import assert from 'assert';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, createHash, sign, randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as V from '../installer/actualizador.mjs';
import { crearActualizacion, urlDelPaquete, CODIGO_ACTUALIZAR } from '../edge/actualizacion.js';
import { VERSION_EDGE } from '../edge/version.js';
import { loggerSilencioso } from '../edge/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ_REPO = join(__dirname, '..');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}`); }
}
const temporales = [];
const dirTemporal = () => { const d = mkdtempSync(join(tmpdir(), 'xabor-act-')); temporales.push(d); return d; };
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Claves y paquetes de prueba ────────────────────────────────────────────
const nuevoPar = () => generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const DUENO = nuevoPar();
const INTRUSO = nuevoPar();

function empaquetar(version, archivos, { privada = DUENO.privateKey, versionInterna = version } = {}) {
  const enB64 = Object.fromEntries(Object.entries(archivos).map(([r, c]) => [r, Buffer.from(c).toString('base64')]));
  const bytes = Buffer.from(JSON.stringify({ version: versionInterna, archivos: enB64 }), 'utf8');
  const m = { version, sha256: createHash('sha256').update(bytes).digest('hex'), tamano: bytes.length };
  m.firma = sign(null, Buffer.from(V.textoFirmado(m), 'utf8'), privada).toString('base64');
  return { bytes, manifiesto: m };
}
const clavePublica = (pem) => { const d = dirTemporal(); writeFileSync(join(d, V.ARCHIVO_CLAVE), pem); return V.leerClavePublica(d); };
const CLAVE = clavePublica(DUENO.publicKey);

// Un Edge de mentira, para ver qué versión arrancó el lanzador y cómo se
// porta: 'ok' se confirma y sale, 'cae' muere al arrancar, 'mudo' se queda
// vivo sin conectarse nunca.
const edgeFalso = (v, modo = 'ok') => ({
  'index.js': `import { appendFileSync } from 'node:fs';
export async function arrancarProceso({ actualizacion }) {
  appendFileSync(process.env.MARCA, '${v}\\n');
  ${modo === 'ok' ? `actualizacion.verificador.confirmarVersion(actualizacion.raiz, '${v}'); process.exit(0);` : ''}
  ${modo === 'cae' ? 'process.exit(1);' : ''}
  ${modo === 'mudo' ? 'setInterval(() => {}, 1000);' : ''}
}
`,
  'version.js': `export const VERSION_EDGE = '${v}';\n`,
});

// ═══════════ A. Verificador ═══════════
console.log('\nA. Verificador');

await t('A', '1. un manifiesto firmado por el dueño pasa; con otra clave, con algo cambiado o sin clave, no', () => {
  const { manifiesto } = empaquetar('1.3.0', edgeFalso('1.3.0'));
  assert.strictEqual(V.verificarManifiesto(manifiesto, CLAVE).version, '1.3.0');
  const ajeno = empaquetar('1.3.0', edgeFalso('1.3.0'), { privada: INTRUSO.privateKey }).manifiesto;
  assert.throws(() => V.verificarManifiesto(ajeno, CLAVE), /firma/);
  for (const cambio of [{ version: '9.9.9' }, { sha256: 'a'.repeat(64) }, { tamano: manifiesto.tamano + 1 }]) {
    assert.throws(() => V.verificarManifiesto({ ...manifiesto, ...cambio }, CLAVE), /firma/, JSON.stringify(cambio));
  }
  assert.throws(() => V.verificarManifiesto({ ...manifiesto, firma: '' }, CLAVE), /sin firma/);
  assert.throws(() => V.verificarManifiesto({ ...manifiesto, version: '1.3' }, CLAVE), /versión inválida/);
  assert.throws(() => V.verificarManifiesto({ ...manifiesto, tamano: V.MAX_PAQUETE + 1 }, CLAVE), /tamaño/);
  assert.throws(() => V.verificarManifiesto(manifiesto, null), /apagada/);
});

await t('A', '2. el paquete tiene que ser exactamente el firmado', () => {
  const { bytes, manifiesto } = empaquetar('1.3.0', edgeFalso('1.3.0'));
  assert.ok(V.verificarPaquete(bytes, manifiesto).archivos['index.js']);
  const otro = Buffer.from(bytes); otro[otro.length - 3] ^= 1;
  assert.throws(() => V.verificarPaquete(otro, manifiesto), /no es el que se firmó/);
  assert.throws(() => V.verificarPaquete(Buffer.concat([bytes, Buffer.from(' ')]), manifiesto), /tamaño/);
  const mentiroso = empaquetar('1.3.0', edgeFalso('1.3.0'), { versionInterna: '1.2.9' });
  assert.throws(() => V.verificarPaquete(mentiroso.bytes, mentiroso.manifiesto), /versión firmada/);
});

await t('A', '3. ninguna ruta sale de edge/ ni trae otra cosa que código', () => {
  const malas = ['../x.js', 'a/../../x.js', '/x.js', 'C:/x.js', 'a\\b.js', 'x.exe', 'x.ps1', 'x.cmd', '.env',
                 'a/./b.js', 'a//b.js', 'node_modules/../../x.js', 'x.js.exe', ''];
  for (const ruta of malas) {
    const { bytes, manifiesto } = empaquetar('1.3.0', { ...edgeFalso('1.3.0'), [ruta]: 'x' });
    assert.throws(() => V.verificarPaquete(bytes, manifiesto), /ruta no permitida|contenido/, `aceptó «${ruta}»`);
  }
  const { bytes, manifiesto } = empaquetar('1.3.0', { 'version.js': 'x' });
  assert.throws(() => V.verificarPaquete(bytes, manifiesto), /index\.js/);
});

await t('A', '4. solo versiones mayores, y nunca una que ya falló en el equipo', () => {
  const raiz = dirTemporal();
  const prep = (v, actual) => {
    const { bytes, manifiesto } = empaquetar(v, edgeFalso(v));
    return V.prepararActualizacion(raiz, V.verificarPaquete(bytes, V.verificarManifiesto(manifiesto, CLAVE)), { versionActual: actual });
  };
  assert.throws(() => prep('1.2.0', '1.2.0'), /no es mayor/);
  assert.throws(() => prep('1.1.9', '1.2.0'), /no es mayor/);
  assert.throws(() => prep('1.10.0', '2.0.0'), /no es mayor/);
  const destino = prep('1.10.0', '1.9.0');
  assert.strictEqual(readFileSync(join(destino, '.version'), 'utf8'), '1.10.0');
  assert.ok(readFileSync(join(destino, 'index.js'), 'utf8').includes('arrancarProceso'));
  assert.strictEqual(V.leerEstado(raiz).pendiente, '1.10.0');
  V.escribirEstado(raiz, { ...V.leerEstado(raiz), rechazadas: ['1.11.0'] });
  assert.throws(() => prep('1.11.0', '1.10.0'), /ya falló/);
});

// ═══════════ B. Lanzador, como proceso ═══════════
console.log('\nB. Lanzador');

function montarRaiz(version = '1.2.0', modo = 'ok') {
  const raiz = dirTemporal();
  copyFileSync(join(RAIZ_REPO, 'installer', 'lanzador.mjs'), join(raiz, 'lanzador.mjs'));
  copyFileSync(join(RAIZ_REPO, 'installer', 'actualizador.mjs'), join(raiz, 'actualizador.mjs'));
  writeFileSync(join(raiz, V.ARCHIVO_CLAVE), DUENO.publicKey);
  writeFileSync(join(raiz, 'correr.mjs'),
    "import { lanzar } from './lanzador.mjs';\nawait lanzar({ pruebaMs: Number(process.env.PRUEBA_MS) || undefined });\n");
  mkdirSync(join(raiz, 'edge'));
  for (const [r, c] of Object.entries(edgeFalso(version, modo))) writeFileSync(join(raiz, 'edge', r), c);
  return raiz;
}

function preparar(raiz, version, modo = 'ok', actual = '1.2.0', archivos = null) {
  const { bytes, manifiesto } = empaquetar(version, archivos || edgeFalso(version, modo));
  const clave = V.leerClavePublica(raiz);
  V.prepararActualizacion(raiz, V.verificarPaquete(bytes, V.verificarManifiesto(manifiesto, clave)), { versionActual: actual });
}

function correr(raiz, { pruebaMs = 0, limiteMs = 20000 } = {}) {
  return new Promise((listo) => {
    const p = spawn(process.execPath, [join(raiz, 'correr.mjs')], {
      env: { ...process.env, MARCA: join(raiz, 'marca.txt'), PRUEBA_MS: String(pruebaMs) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let salida = '';
    p.stdout.on('data', d => { salida += d; });
    p.stderr.on('data', d => { salida += d; });
    const corte = setTimeout(() => p.kill(), limiteMs);
    p.on('exit', (codigo) => { clearTimeout(corte); listo({ codigo, salida }); });
  });
}
const arrancadas = (raiz) => existsSync(join(raiz, 'marca.txt'))
  ? readFileSync(join(raiz, 'marca.txt'), 'utf8').trim().split('\n') : [];

await t('B', '5. sin nada pendiente arranca lo instalado', async () => {
  const raiz = montarRaiz();
  const r = await correr(raiz);
  assert.strictEqual(r.codigo, 0, r.salida);
  assert.deepStrictEqual(arrancadas(raiz), ['1.2.0']);
});

let raizB = null;
await t('B', '6. aplica la versión pendiente, la confirma y conserva la anterior', async () => {
  raizB = montarRaiz();
  preparar(raizB, '1.2.1');
  const r = await correr(raizB);
  assert.strictEqual(r.codigo, 0, r.salida);
  assert.deepStrictEqual(arrancadas(raizB), ['1.2.1']);
  assert.ok(readFileSync(join(raizB, 'edge.anterior', 'version.js'), 'utf8').includes("'1.2.0'"));
  assert.ok(!existsSync(join(raizB, 'edge.nueva')), 'edge.nueva tenía que desaparecer');
  const e = V.leerEstado(raizB);
  assert.strictEqual(e.probando, null, 'quedó a prueba aunque se confirmó');
  assert.strictEqual(e.pendiente, null);
  await correr(raizB);
  assert.deepStrictEqual(arrancadas(raizB), ['1.2.1', '1.2.1']);
});

await t('B', '7. una versión que se cae al arrancar se revierte al cuarto arranque y queda rechazada', async () => {
  preparar(raizB, '1.2.2', 'cae', '1.2.1');
  for (let i = 0; i < 3; i++) assert.notStrictEqual((await correr(raizB)).codigo, 0);
  const r = await correr(raizB);
  assert.strictEqual(r.codigo, 0, r.salida);
  assert.deepStrictEqual(arrancadas(raizB).slice(-4), ['1.2.2', '1.2.2', '1.2.2', '1.2.1']);
  assert.ok(V.leerEstado(raizB).rechazadas.includes('1.2.2'));
  assert.ok(existsSync(join(raizB, 'edge.fallida-1.2.2', 'index.js')), 'la versión fallida se guarda para revisarla');
  assert.throws(() => preparar(raizB, '1.2.2', 'ok', '1.2.1'), /ya falló/);
});

await t('B', '8. una versión que ni siquiera carga se revierte en ese mismo arranque', async () => {
  const raiz = montarRaiz();
  preparar(raiz, '1.2.3', 'ok', '1.2.0', { 'index.js': 'export async function arrancarProceso( {', 'version.js': "export const VERSION_EDGE = '1.2.3';\n" });
  const r1 = await correr(raiz);
  assert.notStrictEqual(r1.codigo, 0);
  assert.ok(/lanzador\.carga\.fallo/.test(r1.salida), r1.salida);
  const r2 = await correr(raiz);
  assert.strictEqual(r2.codigo, 0, r2.salida);
  assert.deepStrictEqual(arrancadas(raiz), ['1.2.0']);
  assert.ok(V.leerEstado(raiz).rechazadas.includes('1.2.3'));
});

await t('B', '9. una versión que arranca pero no se conecta a tiempo se revierte', async () => {
  const raiz = montarRaiz();
  preparar(raiz, '1.2.4', 'mudo');
  const r1 = await correr(raiz, { pruebaMs: 1500 });
  assert.notStrictEqual(r1.codigo, 0, 'el vigía tenía que terminar el proceso');
  assert.ok(/lanzador\.prueba\.vencida/.test(r1.salida), r1.salida);
  const r2 = await correr(raiz);
  assert.strictEqual(r2.codigo, 0, r2.salida);
  assert.deepStrictEqual(arrancadas(raiz), ['1.2.4', '1.2.0']);
  assert.ok(V.leerEstado(raiz).rechazadas.includes('1.2.4'));
});

await t('B', '10. sin edge/ (un apagón entre dos renombres) recupera edge.anterior', async () => {
  const raiz = montarRaiz();
  preparar(raiz, '1.2.5');
  await correr(raiz);
  rmSync(join(raiz, 'edge'), { recursive: true });
  const r = await correr(raiz);
  assert.strictEqual(r.codigo, 0, r.salida);
  assert.deepStrictEqual(arrancadas(raiz), ['1.2.5', '1.2.0']);
});

await t('B', '11. un edge.nueva que no trae la versión pendiente no se aplica', async () => {
  const raiz = montarRaiz();
  preparar(raiz, '1.2.6');
  writeFileSync(join(raiz, 'edge.nueva', '.version'), '9.9.9');
  const r = await correr(raiz);
  assert.strictEqual(r.codigo, 0, r.salida);
  assert.deepStrictEqual(arrancadas(raiz), ['1.2.0']);
  assert.strictEqual(V.leerEstado(raiz).pendiente, null);
});

await t('B', '12. solo la MISMA versión que se puso a prueba puede confirmarse', async () => {
  const raiz = montarRaiz();
  // El paquete 1.2.8 trae un Edge que se presenta como 1.2.7: nunca queda
  // confirmado y el vigía lo revierte.
  preparar(raiz, '1.2.8', 'ok', '1.2.0', {
    'index.js': `import { appendFileSync } from 'node:fs';
export async function arrancarProceso({ actualizacion }) {
  appendFileSync(process.env.MARCA, '1.2.8\\n');
  actualizacion.verificador.confirmarVersion(actualizacion.raiz, '1.2.7');
  setInterval(() => {}, 1000);
}
`,
    'version.js': "export const VERSION_EDGE = '1.2.7';\n",
  });
  const r1 = await correr(raiz, { pruebaMs: 1500, limiteMs: 6000 });
  assert.ok(/lanzador\.prueba\.vencida/.test(r1.salida), r1.salida);
  const r2 = await correr(raiz);
  assert.strictEqual(r2.codigo, 0, r2.salida);
  assert.deepStrictEqual(arrancadas(raiz), ['1.2.8', '1.2.0']);
});

await t('B', '13. el plazo para conectarse cuenta desde cada arranque, no desde que se aplicó', async () => {
  const raiz = montarRaiz();
  // Se cae la primera vez (la PC se apagó) y la segunda se conecta al segundo
  // y medio, un día después de haberse aplicado.
  preparar(raiz, '1.2.9', 'ok', '1.2.0', {
    'index.js': `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
export async function arrancarProceso({ actualizacion }) {
  appendFileSync(process.env.MARCA, '1.2.9\\n');
  const bandera = process.env.MARCA + '.cayo';
  if (!existsSync(bandera)) { writeFileSync(bandera, '1'); process.exit(1); }
  setTimeout(() => { actualizacion.verificador.confirmarVersion(actualizacion.raiz, '1.2.9'); process.exit(0); }, 1500);
}
`,
    'version.js': "export const VERSION_EDGE = '1.2.9';\n",
  });
  assert.notStrictEqual((await correr(raiz, { pruebaMs: 3000 })).codigo, 0);
  V.escribirEstado(raiz, { ...V.leerEstado(raiz), desde: Date.now() - 24 * 3600 * 1000 });
  const r = await correr(raiz, { pruebaMs: 3000 });
  assert.strictEqual(r.codigo, 0, r.salida);
  assert.deepStrictEqual(arrancadas(raiz), ['1.2.9', '1.2.9']);
  assert.strictEqual(V.leerEstado(raiz).probando, null);
});

// ═══════════ C. La parte del Edge ═══════════
console.log('\nC. Edge');

await t('C', '14. baja SIEMPRE del servidor configurado, a una ruta fija', () => {
  assert.strictEqual(urlDelPaquete('wss://xabor.mx/ws/print-agent', '1.3.0'), 'https://xabor.mx/edge/actualizaciones/edge-1.3.0.json');
  assert.strictEqual(urlDelPaquete('ws://localhost:4972/ws/print-agent?x=1', '1.3.0'), 'http://localhost:4972/edge/actualizaciones/edge-1.3.0.json');
  assert.strictEqual(urlDelPaquete('wss://u:p@xabor.mx/ws', '1.3.0'), 'https://xabor.mx/edge/actualizaciones/edge-1.3.0.json');
  assert.throws(() => urlDelPaquete('https://xabor.mx', '1.3.0'));
});

function almacenFalso() {
  const a = { listos: 0, enviando: 0 };
  return { a, pendientes: () => Array.from({ length: a.listos }, (_, i) => ({ id: i })), contarPorEstado: () => (a.enviando ? { enviando: a.enviando } : {}) };
}
const siguiente = (v) => v.replace(/\d+$/, (n) => String(Number(n) + 1));

await t('C', '15. sin lanzador no se instala nada', async () => {
  let pedido = false;
  const act = crearActualizacion({ config: { urlNube: 'ws://x/ws' }, logger: loggerSilencioso, almacen: almacenFalso(),
    fetchImpl: async () => { pedido = true; throw new Error('no'); } });
  const { manifiesto } = empaquetar(siguiente(VERSION_EDGE), edgeFalso(siguiente(VERSION_EDGE)));
  const r = await act.ofrecida(manifiesto);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(act.activa, false);
  assert.strictEqual(pedido, false, 'no debía bajar nada');
});

await t('C', '16. no reinicia con la cola ocupada; con el tope agotado, sí', async () => {
  const raiz = dirTemporal();
  writeFileSync(join(raiz, V.ARCHIVO_CLAVE), DUENO.publicKey);
  const v = siguiente(VERSION_EDGE);
  const { bytes, manifiesto } = empaquetar(v, edgeFalso(v));
  const alm = almacenFalso();
  alm.a.listos = 2;
  let reinicio = null;
  const act = crearActualizacion({
    config: { urlNube: 'ws://x/ws' }, logger: loggerSilencioso, almacen: alm, raiz, verificador: V,
    fetchImpl: async () => new Response(bytes), inactivoMs: 0, pasoMs: 20, maxEsperaMs: 60000,
    alListo: async (c) => { reinicio = c; },
  });
  const promesa = act.ofrecida(manifiesto);
  await esperar(300);
  assert.strictEqual(reinicio, null, 'reinició con comandas listas para imprimir');
  assert.strictEqual(V.leerEstado(raiz).pendiente, v, 'tenía que dejarla preparada mientras espera');
  alm.a.listos = 0; alm.a.enviando = 1;
  await esperar(150);
  assert.strictEqual(reinicio, null, 'reinició con una comanda a medio enviar');
  alm.a.enviando = 0;
  await promesa;
  assert.strictEqual(reinicio, CODIGO_ACTUALIZAR);

  const raiz2 = dirTemporal();
  writeFileSync(join(raiz2, V.ARCHIVO_CLAVE), DUENO.publicKey);
  const alm2 = almacenFalso(); alm2.a.listos = 1;
  let reinicio2 = null;
  const act2 = crearActualizacion({
    config: { urlNube: 'ws://x/ws' }, logger: loggerSilencioso, almacen: alm2, raiz: raiz2, verificador: V,
    fetchImpl: async () => new Response(bytes), inactivoMs: 0, pasoMs: 20, maxEsperaMs: 200,
    alListo: async (c) => { reinicio2 = c; },
  });
  try {
    await Promise.race([act2.ofrecida(manifiesto), esperar(3000)]);
    assert.strictEqual(reinicio2, CODIGO_ACTUALIZAR, 'una impresora apagada no puede detener la actualización para siempre');
  } finally { alm2.a.listos = 0; }
});

await t('C', '17. un trabajo recién llegado aplaza el reinicio', async () => {
  const raiz = dirTemporal();
  writeFileSync(join(raiz, V.ARCHIVO_CLAVE), DUENO.publicKey);
  const v = siguiente(VERSION_EDGE);
  const { bytes, manifiesto } = empaquetar(v, edgeFalso(v));
  let reinicio = null;
  const act = crearActualizacion({
    config: { urlNube: 'ws://x/ws' }, logger: loggerSilencioso, almacen: almacenFalso(), raiz, verificador: V,
    fetchImpl: async () => new Response(bytes), inactivoMs: 400, pasoMs: 20,
    alListo: async (c) => { reinicio = c; },
  });
  act.trabajoRecibido();
  const promesa = act.ofrecida(manifiesto);
  await esperar(150);
  assert.strictEqual(reinicio, null);
  await promesa;
  assert.strictEqual(reinicio, CODIGO_ACTUALIZAR);
});

// ═══════════ D. Con el servidor real ═══════════
const SEED_PATH = join(__dirname, '.datos-prueba.json');
const url = process.env.DATABASE_URL || '';
if (!url || /railway|rlwy/.test(url) || !existsSync(SEED_PATH)) {
  console.log('\n(Parte D omitida: hace falta DATABASE_URL local y test/.datos-prueba.json)');
} else {
  console.log('\nD. Servidor y Edge');
  const SEED = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  const { pool } = await import('../src/services/database.js');
  const { crearEdge: altaEdge, generarEmparejamiento, canjearEmparejamiento } = await import('../src/services/edgeService.js');
  const { arrancarServidor } = await import('./lib-servidor.mjs');
  const { crearEdge } = await import('../edge/index.js');
  const { cargarConfig } = await import('../edge/config.js');
  const S = await import('../src/printing/actualizacionesEdge.js');

  const PUERTO = process.env.TEST_PORT || '4981';
  const nid = SEED.negocioA;
  const sufijo = randomUUID().slice(0, 8);
  const { rows: [suc] } = await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1, $2) RETURNING id`, [nid, `Act ${sufijo}`]);
  const eq = await altaEdge(nid, { nombre: `ACT-${sufijo}`, sucursalId: suc.id });
  const { codigo } = await generarEmparejamiento(nid, eq.id);
  const cred = await canjearEmparejamiento(codigo);

  // Lo que publicaría el dueño: la versión siguiente, firmada.
  const NUEVA = siguiente(VERSION_EDGE);
  const pub = dirTemporal();
  const publicar = (version, { privada = DUENO.privateKey, terminales = null, archivos = edgeFalso(version) } = {}) => {
    const { bytes, manifiesto } = empaquetar(version, archivos, { privada });
    writeFileSync(join(pub, `edge-${version}.json`), bytes);
    writeFileSync(join(pub, `edge-${version}.manifiesto.json`), JSON.stringify(manifiesto));
    writeFileSync(join(pub, 'vigente.json'), JSON.stringify(terminales ? { version, terminales } : { version }));
    return { bytes, manifiesto };
  };
  const { bytes: bytesNueva } = publicar(NUEVA);

  const srv = await arrancarServidor({ PORT: PUERTO, XABOR_EDGE_ACTUALIZACIONES_DIR: pub }, { timeoutMs: 30000 });
  const base = `http://localhost:${PUERTO}`;

  function edgeConLanzador({ conLanzador = true } = {}) {
    const raiz = dirTemporal();
    writeFileSync(join(raiz, V.ARCHIVO_CLAVE), DUENO.publicKey);
    const reinicios = [];
    const edge = crearEdge({
      config: {
        ...cargarConfig({ env: {} }),
        urlNube: `ws://localhost:${PUERTO}/ws/print-agent`, terminalId: cred.terminalId, terminalToken: cred.token,
        rutaDatos: join(raiz, 'datos'), almacen: 'sqlite', reconexionBaseMs: 50, reconexionMaximaMs: 400, heartbeatMs: 2000,
      },
      logger: loggerSilencioso,
      actualizacion: conLanzador ? { raiz, verificador: V } : null,
      alListoParaActualizar: async (c) => { reinicios.push(c); },
      opcionesActualizacion: { inactivoMs: 100, pasoMs: 20 },
    });
    return { edge, raiz, reinicios };
  }
  const salidaDesde = (marca) => srv.obtenerSalida().slice(marca);

  try {
    await t('D', '18. la nube sirve solo el paquete exacto, sin sesión', async () => {
      const r = await fetch(`${base}/edge/actualizaciones/edge-${NUEVA}.json`);
      assert.strictEqual(r.status, 200);
      assert.ok(Buffer.from(await r.arrayBuffer()).equals(bytesNueva), 'los bytes servidos no son los publicados');
      for (const otra of ['vigente.json', `edge-${NUEVA}.manifiesto.json`, '..%2Fpackage.json', '%2e%2e%2fpackage.json', 'edge-9.9.9.json', 'edge-1.2.json']) {
        const x = await fetch(`${base}/edge/actualizaciones/${otra}`);
        assert.strictEqual(x.status, 404, `${otra} respondió ${x.status}`);
      }
    });

    await t('D', '19. la oferta: solo a un Edge con versión, menor que la vigente, y de la lista si la hay', () => {
      assert.strictEqual(S.ofertaParaEdge({ versionEdge: VERSION_EDGE, terminalId: 'x' }, pub)?.version, NUEVA);
      assert.strictEqual(S.ofertaParaEdge({ versionEdge: null, terminalId: 'x' }, pub), null, 'un Edge 1.1.0 no dice su versión');
      assert.strictEqual(S.ofertaParaEdge({ versionEdge: NUEVA, terminalId: 'x' }, pub), null);
      assert.strictEqual(S.ofertaParaEdge({ versionEdge: '9.0.0', terminalId: 'x' }, pub), null);
      const vig = readFileSync(join(pub, 'vigente.json'), 'utf8');
      writeFileSync(join(pub, 'vigente.json'), JSON.stringify({ version: NUEVA, terminales: ['otra'] }));
      assert.strictEqual(S.ofertaParaEdge({ versionEdge: VERSION_EDGE, terminalId: 'x' }, pub), null);
      assert.ok(S.ofertaParaEdge({ versionEdge: VERSION_EDGE, terminalId: 'otra' }, pub));
      writeFileSync(join(pub, 'vigente.json'), vig);
    });

    await t('D', '20. de punta a punta: ofrece, verifica, baja, prepara y pide reiniciar; la nube lo registra', async () => {
      const marca = srv.obtenerSalida().length;
      const { edge, raiz, reinicios } = edgeConLanzador();
      await edge.iniciar();
      try {
        const fin = Date.now() + 10000;
        while (!reinicios.length && Date.now() < fin) await esperar(50);
        assert.deepStrictEqual(reinicios, [CODIGO_ACTUALIZAR]);
        assert.strictEqual(readFileSync(join(raiz, 'edge.nueva', '.version'), 'utf8'), NUEVA);
        assert.strictEqual(V.leerEstado(raiz).pendiente, NUEVA);
        // El aviso «preparada» viaja por el WebSocket y luego por la salida
        // del servidor: puede llegar unos milisegundos después del reinicio.
        const preparada = new RegExp(`version=${NUEVA.replace(/\./g, '\\.')} estado=preparada`);
        const hastaLog = Date.now() + 5000;
        while (!preparada.test(salidaDesde(marca)) && Date.now() < hastaLog) await esperar(50);
        const log = salidaDesde(marca);
        assert.ok(log.includes(`version=${VERSION_EDGE}`), 'la nube no registró la versión del Edge');
        assert.ok(log.includes(`actualización ofrecida terminal=${cred.terminalId}`), log.slice(-1500));
        assert.ok(new RegExp(`version=${NUEVA.replace(/\./g, '\\.')} estado=preparada`).test(log), 'el Edge no avisó que quedó preparada');
      } finally { await edge.detener(); }
    });

    await t('D', '21. al conectarse, la versión a prueba queda confirmada', async () => {
      const { edge, raiz } = edgeConLanzador();
      V.escribirEstado(raiz, { pendiente: null, probando: VERSION_EDGE, intentos: 1, desde: Date.now(), rechazadas: [] });
      writeFileSync(join(pub, 'vigente.json'), JSON.stringify({ version: VERSION_EDGE }));
      await edge.iniciar();
      try {
        const fin = Date.now() + 8000;
        while (V.leerEstado(raiz).probando && Date.now() < fin) await esperar(50);
        assert.strictEqual(V.leerEstado(raiz).probando, null);
      } finally { await edge.detener(); publicar(NUEVA); }
    });

    await t('D', '22. un manifiesto que no firmó el dueño se rechaza sin bajar nada', async () => {
      const OTRA = siguiente(NUEVA);
      publicar(OTRA, { privada: INTRUSO.privateKey });
      const marca = srv.obtenerSalida().length;
      const { edge, raiz, reinicios } = edgeConLanzador();
      await edge.iniciar();
      try {
        const fin = Date.now() + 8000;
        while (!/estado=rechazada/.test(salidaDesde(marca)) && Date.now() < fin) await esperar(50);
        assert.ok(/estado=rechazada motivo=la firma no corresponde/.test(salidaDesde(marca)), salidaDesde(marca).slice(-1200));
        await esperar(300);
        assert.deepStrictEqual(reinicios, []);
        assert.ok(!existsSync(join(raiz, 'edge.nueva')));
      } finally { await edge.detener(); publicar(NUEVA); }
    });

    await t('D', '23. un paquete cambiado en el servidor después de firmarlo no se instala', async () => {
      const original = readFileSync(join(pub, `edge-${NUEVA}.json`));
      const cambiado = Buffer.from(original.toString('utf8').replace(/"index\.js":"[^"]+"/, `"index.js":"${Buffer.from('/* otro */').toString('base64')}"`));
      const relleno = Buffer.alloc(Math.max(0, original.length - cambiado.length), 0x20);
      writeFileSync(join(pub, `edge-${NUEVA}.json`), Buffer.concat([cambiado, relleno]).subarray(0, original.length));
      const marca = srv.obtenerSalida().length;
      const { edge, raiz, reinicios } = edgeConLanzador();
      await edge.iniciar();
      try {
        const fin = Date.now() + 8000;
        while (!/estado=error/.test(salidaDesde(marca)) && Date.now() < fin) await esperar(50);
        assert.ok(/estado=error motivo=el paquete no es el que se firmó/.test(salidaDesde(marca)), salidaDesde(marca).slice(-1200));
        assert.deepStrictEqual(reinicios, []);
        assert.ok(!existsSync(join(raiz, 'edge.nueva')));
      } finally { await edge.detener(); writeFileSync(join(pub, `edge-${NUEVA}.json`), original); }
    });

    await t('D', '24. un Edge sin lanzador (como la 1.1.0 o a mano) no se toca', async () => {
      const marca = srv.obtenerSalida().length;
      const { edge, raiz, reinicios } = edgeConLanzador({ conLanzador: false });
      await edge.iniciar();
      try {
        const fin = Date.now() + 5000;
        while (!salidaDesde(marca).includes('actualización ofrecida') && Date.now() < fin) await esperar(50);
        await esperar(500);
        assert.deepStrictEqual(reinicios, []);
        assert.ok(!existsSync(join(raiz, 'edge.nueva')));
      } finally { await edge.detener(); }
    });

    await t('D', '25. con procesos de verdad: el lanzador y el Edge real salen con 75, aplican la nueva y la confirman', async () => {
      // La carpeta {app}\app de una PC, como la deja el instalador.
      const app = dirTemporal();
      for (const f of ['lanzador.mjs', 'actualizador.mjs']) copyFileSync(join(RAIZ_REPO, 'installer', f), join(app, f));
      writeFileSync(join(app, V.ARCHIVO_CLAVE), DUENO.publicKey);
      cpSync(join(RAIZ_REPO, 'edge'), join(app, 'edge'), { recursive: true, filter: (o) => !/[\\/](datos|\.env)$/.test(o) });
      // ws COPIADO, no enlazado: borrar la carpeta temporal no puede tocar el original.
      cpSync(dirname(createRequire(import.meta.url).resolve('ws')), join(app, 'node_modules', 'ws'), { recursive: true });

      // La versión siguiente es el edge/ real con otro número.
      const archivos = {};
      const recorrer = (pre = '') => {
        for (const n of readdirSync(join(RAIZ_REPO, 'edge', pre))) {
          const rel = pre ? `${pre}/${n}` : n;
          if (statSync(join(RAIZ_REPO, 'edge', rel)).isDirectory()) { if (n !== 'datos') recorrer(rel); }
          else if (/\.(js|mjs|json|md)$/.test(n)) archivos[rel] = readFileSync(join(RAIZ_REPO, 'edge', rel));
        }
      };
      recorrer();
      archivos['version.js'] = `export const VERSION_EDGE = '${NUEVA}';\n`;
      publicar(NUEVA, { archivos });

      const lanzar = () => {
        const p = spawn(process.execPath, [join(app, 'lanzador.mjs')], {
          cwd: app,
          env: { ...process.env, XABOR_EDGE_WS_URL: `ws://localhost:${PUERTO}/ws/print-agent`,
                 XABOR_TERMINAL_ID: cred.terminalId, XABOR_TERMINAL_TOKEN: cred.token,
                 XABOR_EDGE_DATOS: join(app, 'datos'), XABOR_EDGE_RECONEXION_MS: '200', XABOR_EDGE_PROGRAMDATA: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        p.salida = '';
        p.stdout.on('data', d => { p.salida += d; });
        p.stderr.on('data', d => { p.salida += d; });
        p.fin = new Promise(r => p.on('exit', (c) => r(c)));
        return p;
      };

      const marca = srv.obtenerSalida().length;
      const p1 = lanzar();
      const codigo1 = await Promise.race([p1.fin, esperar(90000).then(() => 'tiempo')]);
      if (codigo1 === 'tiempo') p1.kill();
      assert.strictEqual(codigo1, CODIGO_ACTUALIZAR, `el Edge salió con ${codigo1}:\n${p1.salida.slice(-1500)}`);
      assert.strictEqual(readFileSync(join(app, 'edge.nueva', '.version'), 'utf8'), NUEVA);

      const p2 = lanzar();
      try {
        const fin = Date.now() + 20000;
        const confirmada = new RegExp(`terminal=${cred.terminalId} version=${NUEVA.replace(/\./g, '\\.')} estado=confirmada`);
        while (!confirmada.test(salidaDesde(marca)) && Date.now() < fin) await esperar(100);
        assert.ok(confirmada.test(salidaDesde(marca)), `no se confirmó:\n${p2.salida.slice(-1500)}`);
        assert.ok(salidaDesde(marca).includes(`version=${NUEVA}`), 'la nube no vio la versión nueva');
        assert.ok(/lanzador\.aplicada/.test(p2.salida), p2.salida.slice(-800));
        assert.strictEqual(V.leerEstado(app).probando, null);
        assert.ok(readFileSync(join(app, 'edge', 'version.js'), 'utf8').includes(NUEVA));
        assert.ok(readFileSync(join(app, 'edge.anterior', 'version.js'), 'utf8').includes(VERSION_EDGE));
      } finally { p2.kill(); await p2.fin; }
    });
  } finally {
    srv.detener();
    await pool.query(`DELETE FROM terminales WHERE id = $1`, [eq.id]).catch(() => {});
    await pool.query(`DELETE FROM sucursales WHERE id = $1`, [suc.id]).catch(() => {});
    await pool.end();
  }
}

for (const d of temporales) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) console.log(fallos.join('\n'));
process.exitCode = fallidas > 0 ? 1 : 0;
