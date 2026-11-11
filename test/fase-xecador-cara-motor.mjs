// XECADOR · Cara — el motor de verdad (XECADOR_CARA_MOTOR=yunet-sface).
//
// Lo que protege:
//   1. Solo corren los modelos verificados: con un archivo que falta o que
//      cambió aunque sea un byte, no hay motor (y la cara no se enciende).
//   2. Lo que hace con los números de YuNet y SFace es lo mismo que OpenCV:
//      cómo se leen las salidas, qué caras se quedan, cómo se endereza la
//      cara y en qué orden van los colores.
//   3. Una foto que no sirve no tumba nada: el motor lanza y quien lo llama
//      (caraService) lo vuelve «cara sin verificar». Varias fotos a la vez
//      esperan su turno: nunca más de 2 en el motor.
//   4. Lo que llega a Railway: la dependencia exacta, sin los binarios de
//      CUDA (que bajaría su instalación en Linux) y solo los de esa máquina.
//
// No hace falta base de datos. Las pruebas con caras de verdad (que el motor
// reconozca a la misma persona y no a otra) esperan fotos con permiso: aquí
// no hay ninguna.
import assert from 'assert';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(RAIZ, 'modelos', 'cara');
process.env.XECADOR_CARA_MOTOR = 'yunet-sface';
delete process.env.XECADOR_CARA_MODELOS;

const R = await import('../src/services/caraMotorReal.js');
const MOTOR = await import('../src/services/caraMotor.js');
const G = await import('../src/services/caraGeometria.js');
const { default: sharp } = await import('sharp');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const cerca = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

/** estadoMotor() en un proceso aparte, con estas variables. */
function estadoCon(env) {
  const codigo = `const m = await import(${JSON.stringify(pathToFileURL(join(RAIZ, 'src/services/caraMotor.js')).href)});
    console.log(JSON.stringify(m.estadoMotor()));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', codigo], {
    env: { ...process.env, NODE_OPTIONS: '', ...env }, encoding: 'utf8', timeout: 60000 });
  const linea = (r.stdout || '').trim().split('\n').at(-1);
  try { return JSON.parse(linea); } catch { throw new Error(`salida inesperada: ${r.stdout} ${r.stderr}`); }
}

// ═══ A. Los modelos y lo que llega a Railway ═══════════════════════════════
console.log('\n── A. Modelos y despliegue');

await t('A1. los modelos del repo son los verificados: tamaño y sha256 iguales a los del código, a ORIGEN.txt y con su licencia', () => {
  const origen = readFileSync(join(DIR, 'ORIGEN.txt'), 'utf8');
  for (const m of Object.values(R.MODELOS)) {
    const bytes = readFileSync(join(DIR, m.archivo));
    assert.strictEqual(bytes.length, m.bytes, m.archivo);
    assert.strictEqual(sha256(bytes), m.sha256, m.archivo);
    assert.ok(origen.includes(m.sha256) && origen.includes(m.archivo), `ORIGEN.txt no cita ${m.archivo}`);
  }
  assert.match(readFileSync(join(DIR, 'LICENSE-yunet.txt'), 'utf8'), /^MIT License/);
  assert.match(readFileSync(join(DIR, 'LICENSE-sface.txt'), 'utf8'), /Apache License\s+Version 2\.0/);
  assert.match(readFileSync(join(RAIZ, '.gitattributes'), 'utf8'), /^\*\.onnx binary$/m, 'git no debe convertir los modelos');
});

await t('A2. Railway: onnxruntime-node con versión exacta, sin los binarios de CUDA y solo con los de su máquina', () => {
  const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.dependencies['onnxruntime-node'], '1.31.1');
  const lock = JSON.parse(readFileSync(join(RAIZ, 'package-lock.json'), 'utf8'));
  assert.strictEqual(lock.packages['node_modules/onnxruntime-node'].version, '1.31.1');
  assert.strictEqual(lock.packages['node_modules/onnxruntime-node'].integrity,
    'sha512-ijnSghbDHVWaQ2nDPmVccPlCHI8kH1Mx1aJ4a/qzRP16bBcVs4E3EqZQKZCkhWnbqN1tuQWxagimFtDpbPYYQw==');
  const docker = readFileSync(join(RAIZ, 'Dockerfile'), 'utf8');
  const ci = docker.split('\n').find((l) => /\bnpm ci\b/.test(l) && /^RUN\b/.test(l));
  assert.ok(ci && /\bONNXRUNTIME_NODE_INSTALL=skip\b/.test(ci), 'el skip va en la misma línea que npm ci');
  assert.match(docker, /bin\/napi-v6.*process\.platform\+'\/'\+process\.arch/, 'se quedan solo los binarios de esta máquina');
  assert.ok(!/^\s*modelos\b/m.test(readFileSync(join(RAIZ, '.dockerignore'), 'utf8')), 'los modelos entran a la imagen');
});

await t('A3. sin el motor instalado, sin un modelo o con un byte distinto: no hay motor; con los verificados sí, también en producción', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'xcara-modelos-'));
  try {
    const vacio = join(tmp, 'vacio'), alterado = join(tmp, 'alterado'), bueno = join(tmp, 'bueno');
    for (const d of [vacio, alterado, bueno]) mkdirSync(d);
    for (const m of Object.values(R.MODELOS)) { copyFileSync(join(DIR, m.archivo), join(alterado, m.archivo)); copyFileSync(join(DIR, m.archivo), join(bueno, m.archivo)); }
    const y = join(alterado, R.MODELOS.detector.archivo);
    const b = readFileSync(y); b[b.length >> 1] ^= 0x01; writeFileSync(y, b);
    const base = { XECADOR_CARA_MOTOR: 'yunet-sface', NODE_ENV: 'development' };
    assert.deepStrictEqual(estadoCon({ ...base, XECADOR_CARA_MODELOS: vacio }), { disponible: false, modelo: null, motivo: 'sin_modelos' });
    assert.deepStrictEqual(estadoCon({ ...base, XECADOR_CARA_MODELOS: alterado }), { disponible: false, modelo: null, motivo: 'modelo_no_verificado' });
    assert.deepStrictEqual(estadoCon({ ...base, XECADOR_CARA_MODELOS: bueno }), { disponible: true, modelo: R.ID_MOTOR_REAL, motivo: null });
    assert.deepStrictEqual(estadoCon({ ...base, NODE_ENV: 'production' }), { disponible: true, modelo: R.ID_MOTOR_REAL, motivo: null },
      'el motor real sí corre en producción (el de prueba no)');
    assert.deepStrictEqual(estadoCon({ XECADOR_CARA_MOTOR: '', NODE_ENV: 'production' }), { disponible: false, modelo: null, motivo: 'sin_motor' },
      'sin la variable sigue sin motor');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  assert.match(R.ID_MOTOR_REAL, /^[a-z0-9][a-z0-9-]{0,39}$/, 'cabe en xecador_caras.modelo');
});

// ═══ B. Lo mismo que OpenCV ════════════════════════════════════════════════
console.log('\n── B. Las cuentas de YuNet y SFace');

/** Salidas de YuNet vacías (todo en 0) para escribirles una cara a mano. */
function salidasVacias() {
  const s = {};
  for (const paso of [8, 16, 32]) {
    const n = (640 / paso) ** 2;
    s[`cls_${paso}`] = new Float32Array(n); s[`obj_${paso}`] = new Float32Array(n);
    s[`bbox_${paso}`] = new Float32Array(n * 4); s[`kps_${paso}`] = new Float32Array(n * 10);
  }
  return s;
}
function ponerCara(s, { paso, r, c, cls, obj, bbox, kps }) {
  const i = r * (640 / paso) + c;
  s[`cls_${paso}`][i] = cls; s[`obj_${paso}`][i] = obj;
  s[`bbox_${paso}`].set(bbox, i * 4); s[`kps_${paso}`].set(kps, i * 10);
}

await t('B1. salidas de YuNet: caja, 5 puntos y puntuación como OpenCV (raíz de cls·obj, recortadas a [0,1]); debajo de 0.9 no hay cara', () => {
  const s = salidasVacias();
  ponerCara(s, { paso: 16, r: 10, c: 12, cls: 0.95, obj: 0.9, bbox: [0.5, 0.25, Math.log(5), Math.log(6)],
    kps: [-1, -1, 1, -1, 0, 0.5, -0.5, 1.5, 0.5, 1.5] });
  ponerCara(s, { paso: 8, r: 3, c: 4, cls: 0.5, obj: 0.9, bbox: [0, 0, 0, 0], kps: new Array(10).fill(0) });   // 0.67: no
  ponerCara(s, { paso: 32, r: 1, c: 1, cls: 1.7, obj: 0.81, bbox: [0, 0, 0, 0], kps: new Array(10).fill(0) });   // 1.7 → 1
  const caras = R.decodificarYunet(s);
  assert.strictEqual(caras.length, 2);
  const [a, b] = caras;
  assert.ok(cerca(a.puntuacion, Math.sqrt(0.95 * 0.9)));
  // centro (12 + 0.5, 10 + 0.25) × 16 = (200, 164); ancho 5 × 16 = 80, alto 6 × 16 = 96
  [160, 116, 80, 96].forEach((v, k) => assert.ok(cerca(a.caja[k], v, 1e-4), `caja[${k}] = ${a.caja[k]}`));
  const esperados = [[176, 144], [208, 144], [192, 168], [184, 184], [200, 184]];
  a.puntos.forEach(([x, y], k) => assert.ok(cerca(x, esperados[k][0]) && cerca(y, esperados[k][1]), `punto ${k}: ${x},${y}`));
  assert.ok(cerca(b.puntuacion, 0.9), 'cls recortada a 1: raíz de 0.81');
  assert.deepStrictEqual(R.decodificarYunet(salidasVacias()), []);
});

await t('B2. la misma cara vista varias veces queda en una (la de mejor puntuación); dos caras separadas quedan las dos', () => {
  const c = (x, p) => ({ caja: [x, 100, 80, 96], puntos: [], puntuacion: p });
  assert.deepStrictEqual(R.quitarEncimadas([c(100, 0.91), c(104, 0.97), c(98, 0.93)]).map((x) => x.puntuacion), [0.97]);
  assert.deepStrictEqual(R.quitarEncimadas([c(100, 0.91), c(400, 0.95)]).map((x) => x.puntuacion), [0.95, 0.91]);
  // Se enciman, pero poco (traslape ≤ 0.3): son dos.
  assert.strictEqual(R.quitarEncimadas([c(100, 0.9), c(150, 0.95)]).length, 2);
});

await t('B3. enderezar: los puntos de la plantilla dan la identidad; una cara girada, más grande y movida vuelve a la plantilla', () => {
  const id = R.aPlantilla(R.PLANTILLA);
  assert.ok(cerca(id.a, 1) && cerca(id.b, 0) && cerca(id.tx, 0, 1e-4) && cerca(id.ty, 0, 1e-4), JSON.stringify(id));
  // Los puntos de una cara: la plantilla girada 25°, ×2.5 y movida a (300, 200).
  const ang = 25 * Math.PI / 180, k = 2.5;
  const cara = R.PLANTILLA.map(([x, y]) => [300 + k * (x * Math.cos(ang) - y * Math.sin(ang)), 200 + k * (x * Math.sin(ang) + y * Math.cos(ang))]);
  const tr = R.aPlantilla(cara);
  cara.forEach(([x, y], i) => {
    const u = tr.a * x - tr.b * y + tr.tx, v = tr.b * x + tr.a * y + tr.ty;
    assert.ok(cerca(u, R.PLANTILLA[i][0], 1e-6) && cerca(v, R.PLANTILLA[i][1], 1e-6), `punto ${i}: ${u},${v}`);
  });
  assert.strictEqual(R.aPlantilla(new Array(5).fill([7, 7])), null, 'todos en el mismo lugar: no hay transformación');
});

await t('B4. enderezar copia la foto en RGB por planos (identidad exacta); un corrimiento la corre; fuera de la foto, negro', () => {
  const L = R.LADO, rgb = Buffer.alloc(L * L * 3);
  for (let y = 0; y < L; y++) for (let x = 0; x < L; x++) { const o = (y * L + x) * 3; rgb[o] = x; rgb[o + 1] = y; rgb[o + 2] = 200; }
  const out = R.enderezar(rgb, L, L, { a: 1, b: 0, tx: 0, ty: 0 });
  const plano = L * L;
  for (const [x, y] of [[0, 0], [5, 7], [111, 111], [60, 3]]) {
    assert.deepStrictEqual([out[y * L + x], out[plano + y * L + x], out[2 * plano + y * L + x]], [x, y, 200], `pixel ${x},${y}`);
  }
  const corrida = R.enderezar(rgb, L, L, { a: 1, b: 0, tx: 10, ty: 0 });   // u = x + 10
  assert.strictEqual(corrida[5 * L + 30], 20, 'u=30 viene de x=20');
  assert.strictEqual(corrida[5 * L + 4], 0, 'u=4 viene de x=-6: fuera, negro');
  const media = R.enderezar(rgb, L, L, { a: 1, b: 0, tx: -0.5, ty: 0 });    // x = u + 0.5
  assert.ok(cerca(media[5 * L + 30], 30.5), 'interpolación lineal');
  // Un cuarto de vuelta: u = 111 − y, v = x; el pixel (u=10, v=20) viene de x=20, y=101.
  const vuelta = R.enderezar(rgb, L, L, { a: 0, b: 1, tx: 111, ty: 0 });
  assert.deepStrictEqual([vuelta[20 * L + 10], vuelta[plano + 20 * L + 10]], [20, 101], 'con giro');
});

await t('B6. foto grande: lo que vio YuNet en la reducida vuelve a las coordenadas de la original; quedan las 2 caras más grandes', () => {
  const s = salidasVacias();
  ponerCara(s, { paso: 16, r: 10, c: 12, cls: 1, obj: 1, bbox: [0.5, 0.25, Math.log(5), Math.log(6)], kps: [-1, -1, 1, -1, 0, 0.5, -0.5, 1.5, 0.5, 1.5] });
  ponerCara(s, { paso: 8, r: 50, c: 10, cls: 1, obj: 1, bbox: [0, 0, Math.log(4), Math.log(4)], kps: new Array(10).fill(0) });   // 32×32
  ponerCara(s, { paso: 8, r: 50, c: 60, cls: 1, obj: 1, bbox: [0, 0, Math.log(2), Math.log(2)], kps: new Array(10).fill(0) });  // 16×16: sobra
  // 1600×1200 reducida a 640×480: todo ×2.5.
  const caras = R.carasEnLaFoto(s, { ancho: 1600, alto: 1200, anchoChica: 640, altoChica: 480 });
  assert.strictEqual(caras.length, 2, 'solo las 2 más grandes');
  [400, 290, 200, 240].forEach((v, k) => assert.ok(cerca(caras[0].caja[k], v, 1e-3), `caja[${k}] = ${caras[0].caja[k]}`));
  assert.ok(cerca(caras[0].puntos[2][0], 480, 1e-3) && cerca(caras[0].puntos[2][1], 420, 1e-3), `nariz ${caras[0].puntos[2]}`);
  assert.ok(cerca(caras[1].caja[2], 80, 1e-3), 'la segunda: 32 × 2.5');
});

await t('B5. la entrada de YuNet va en BGR (como OpenCV), arriba a la izquierda, con negro el resto', () => {
  const rgb = Buffer.from([10, 20, 30, 40, 50, 60]);   // 2×1: (10,20,30) y (40,50,60)
  const x = R.entradaDetector(rgb, 2, 1), plano = 640 * 640;
  assert.deepStrictEqual([x[0], x[plano], x[2 * plano]], [30, 20, 10], 'B, G, R');
  assert.deepStrictEqual([x[1], x[plano + 1], x[2 * plano + 1]], [60, 50, 40]);
  assert.deepStrictEqual([x[2], x[640], x[plano + 640]], [0, 0, 0], 'relleno negro');
});

// ═══ C. El motor con fotos ═════════════════════════════════════════════════
console.log('\n── C. El motor con fotos');
const motor = MOTOR.obtenerMotor();
const lisa = (w, h, color) => sharp({ create: { width: w, height: h, channels: 3, background: color } });

await t('C1. el motor elegido es el real, con los umbrales de SFace', () => {
  assert.deepStrictEqual(MOTOR.estadoMotor(), { disponible: true, modelo: R.ID_MOTOR_REAL, motivo: null });
  assert.strictEqual(motor.id, R.ID_MOTOR_REAL);
  assert.deepStrictEqual(motor.umbrales, { coincide: 0.363, misma: 0.363, registro: 0.45 });
});

await t('C2. fotos sin cara (lisa, ruido, grande, en gris, WebP con transparencia): ninguna cara y sin error', async () => {
  const ruido = Buffer.alloc(480 * 640 * 3);
  for (let i = 0; i < ruido.length; i++) ruido[i] = (i * 2654435761) >>> 24;
  const fotos = [
    await lisa(640, 480, '#808080').jpeg().toBuffer(),
    await sharp(ruido, { raw: { width: 640, height: 480, channels: 3 } }).jpeg().toBuffer(),
    await lisa(1600, 1200, '#405060').jpeg().toBuffer(),
    await lisa(320, 240, '#aaaaaa').greyscale().jpeg().toBuffer(),
    await sharp({ create: { width: 640, height: 480, channels: 4, background: '#33669980' } }).webp().toBuffer(),
  ];
  for (const [i, f] of fotos.entries()) assert.deepStrictEqual(await motor.analizar(f), { caras: [] }, `foto ${i}`);
  assert.strictEqual(G.evaluarChecada({ analisis: [{ caras: [] }], registro: [], umbrales: motor.umbrales }).detalle, 'sin_cara');
});

await t('C3. bytes que no son foto: el motor lanza (y quien lo llama lo vuelve «cara sin verificar»)', async () => {
  await assert.rejects(motor.analizar(Buffer.from('no es una foto')));
  await assert.rejects(motor.analizar(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])), 'un JPEG cortado');
});

await t('C4. ocho fotos a la vez: todas responden, nunca hay más de 2 en el motor y al final no queda ninguna', async () => {
  const f = await lisa(640, 480, '#556677').jpeg().toBuffer();
  let max = 0;
  const vigilar = setInterval(() => { max = Math.max(max, R.enElMotor()); }, 1);
  const r = await Promise.allSettled([...Array.from({ length: 7 }, () => motor.analizar(f)), motor.analizar(Buffer.from('rota'))]);
  clearInterval(vigilar);
  assert.deepStrictEqual(r.map((x) => x.status), [...new Array(7).fill('fulfilled'), 'rejected'], 'una rota no frena a las demás');
  assert.ok(max >= 1 && max <= 2, `máximo en el motor: ${max}`);
  assert.strictEqual(R.enElMotor(), 0);
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('\nFallos:'); fallos.forEach((f) => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
