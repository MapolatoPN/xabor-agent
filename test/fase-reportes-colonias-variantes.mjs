// Reportes → Ventas: las formas de escribir una misma colonia (20-nov-2026).
//
// Origen: el dueño vio en «Colonias con más envíos» colonias repetidas por una
// letra mal escrita. limpiarColonia ya juntaba mayúsculas, acentos y «Col.»;
// lo demás salía como otra colonia. Ahora (services/coloniasVariantes.js):
//   · SEGURAS, se unen solas: b/v, s/z/c, y/ll, h muda, letras repetidas,
//     palabras pegadas, abreviaturas, el sector como número, «Los/Las» al
//     principio, dos letras volteadas, singular/plural de palabra larga;
//   · SUGERIDAS: una letra distinta (dos en nombres largos). Nunca se unen
//     solas: «Las Fuentes» y «Las Puentes» pueden ser dos colonias;
//   · el administrador decide Unir / Son distintas / Deshacer, por negocio;
//   · los pedidos NO se tocan, Σ envíos sigue cuadrando con Domicilios.
//
// Todas las colonias son inventadas: el repo es público.
//
// Uso: DATABASE_URL=... (y el resto de variables de las suites) node test/fase-reportes-colonias-variantes.mjs
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT_REPVARIANTES || '4979';
const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { construirReporteVentas, armarReporteVentas, limpiarColonia } = await import('../src/services/reporteVentas.js');
const V = await import('../src/services/coloniasVariantes.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const DOM = 'entrega a domicilio';
const clave = (texto) => limpiarColonia(texto).clave;
const info = (texto) => ({ llave: V.llaveDeColonia(clave(texto)), palabras: V.palabrasDeColonia(clave(texto)) });
const segura = (a, b) => V.mismaColoniaSegura(info(a), info(b));
const sugerida = (a, b) => V.pareceMismaColonia(info(a).llave, info(b).llave);
let n = 0;
const envio = (colonia, total = 100, extra = {}) => ({
  folio: `CV-${++n}`, estado: 'entregado', creado_at: new Date('2026-10-07T17:00:00Z'),
  datos: { canal: 'pos', modalidad: DOM, forma_pago: 'efectivo', total, cliente: { nombre: `C${n}`, colonia }, ...extra },
});
const muchos = (colonia, veces, total = 100) => Array.from({ length: veces }, () => envio(colonia, total));
const renglones = (r) => r.por_colonia.colonias.map(x => [x.colonia, x.pedidos]);

// ─── A. Las reglas, sin base ───────────────────────────────────────────────
const MISMAS = [
  ['Vista Serena', 'Bista Serena'], ['Vista Serena', 'Vistaserena'], ['Vista Serena', 'VISTA  SERENA.'],
  ['Valle Hondo', 'Valle Ondo'], ['Valle Hondo', 'Vallehondo'], ['Valle Hondo', 'Valle Hondoo'],
  ['Los Encinos', 'Encinos'], ['Los Encinos', 'Los Ensinos'], ['Jardines del Llano', 'Jardines del Yano'],
  ['Arboledas del Sur', 'Arboledas del Sru'], ['Arboledas del Sur', 'Arboleda del Sur'], ['Arboledas del Sur', 'Arboledas Del Zur'],
  ['Santa Rosalía Norte', 'Sta. Rosalia Norte'], ['Santa Rosalía Norte', 'Santa Rosalia Nte'],
  ['Lomas Claras 1er Sector', 'Lomas Claras Primer Sector'], ['Lomas Claras 1er Sector', 'Lomas Claras 1 Sector'],
  ['Ampliación Pradera', 'Ampl. Pradera'], ['Cerrada Quetzal', 'Serrada Ketzal'], ['Gerona Uno', 'Jerona Uno'],
];
const DISTINTAS = [
  ['Centro', 'Cerro'], ['Roma', 'Loma'], ['Loma', 'Lomas'], ['San José', 'San Jorge'], ['Mitras Norte', 'Mitras Sur'],
  ['Valle Alto', 'Valle Real'], ['Moderna', 'Modelo'], ['Las Palmas', 'Palmar'], ['Linda Vista', 'Alta Vista'],
  ['Morelos', 'Moreno'], ['Hidalgo', 'Fidalgo'], ['Bellavista', 'Buenavista'], ['Las Fuentes', 'Las Puentes'],
  ['Lomas Claras 1er Sector', 'Lomas Claras 2do Sector'], ['Sector 3', 'Sector 4'], ['Quinta Real', 'Real'],
  ['Infonavit Uno', 'Infonavit Dos'], ['Aurora', 'Aeropuerto'],
  // Singular y plural de una palabra corta: puede ser otra colonia; se pregunta.
  ['Lomas del Pino', 'Lomas del Pinos'],
];

await t('REGLA', '1. lo que se escribe distinto pero se lee igual es la misma colonia', async () => {
  const fallan = MISMAS.filter(([a, b]) => !segura(a, b));
  assert.deepStrictEqual(fallan, [], `no se unieron: ${JSON.stringify(fallan)}`);
});

await t('REGLA', '2. una letra distinta, otro número de sector o un nombre parecido NUNCA se unen solos', async () => {
  const unidas = DISTINTAS.filter(([a, b]) => segura(a, b));
  assert.deepStrictEqual(unidas, [], `se unieron solas: ${JSON.stringify(unidas)}`);
});

await t('REGLA', '3. se sugieren solo las de una letra (dos si son largas) y nunca con otro número', async () => {
  for (const [a, b] of [['Las Fuentes', 'Las Puentes'], ['Hidalgo', 'Fidalgo'], ['Vista Serena', 'Vista Sereno'], ['Jardines del Llano', 'Jardines del Lano'],
    ['Lomas del Pino', 'Lomas del Pinos']]) {
    assert.ok(sugerida(a, b), `no se sugirió ${a} / ${b}`);
  }
  for (const [a, b] of [['Roma', 'Loma'], ['Centro', 'Cerro'], ['Lomas Claras 1er Sector', 'Lomas Claras 2do Sector'],
    ['Sector 3', 'Sector 4'], ['San José', 'San Jorge'], ['Vista Serena', 'Vista Serena'], ['Valle Alto', 'Valle Real']]) {
    assert.ok(!sugerida(a, b), `se sugirió ${a} / ${b}`);
  }
});

await t('REGLA', '4. «Primer», «Quinta» y «V» solo son número junto a sector/etapa; «Col.» y «Fracc.» sobran en cualquier lugar', async () => {
  assert.strictEqual(V.palabrasDeColonia('quinta real'), 'kinta real');
  assert.strictEqual(V.palabrasDeColonia('primavera'), 'primabera');
  assert.strictEqual(V.palabrasDeColonia('primera de mayo'), 'primera de mayo', '«Primera» lejos de «sector» no es número');
  assert.strictEqual(V.palabrasDeColonia('lomas claras primer sector'), V.palabrasDeColonia('lomas claras 1er sector'));
  assert.strictEqual(V.palabrasDeColonia('etapa v pradera'), 'etapa 5 pradera');
  assert.strictEqual(V.llaveDeColonia('residencial fracc olmos'), V.llaveDeColonia('res olmos'));
  assert.strictEqual(V.llaveDeColonia('fracc los olmos'), V.llaveDeColonia('olmos'));
  assert.notStrictEqual(V.llaveDeColonia('chapultepec'), V.llaveDeColonia('capultepec'), 'la ch no es c');
});

await t('REGLA', '5. sin cadenas: una forma se compara con la que encabeza el grupo, no con cualquier miembro', async () => {
  // «Bonitsa» es Bonitas con dos letras volteadas; «Bonista» lo es de Bonitsa, NO de Bonitas.
  // Bonitsa tiene más envíos: ya está en el grupo cuando llega Bonista.
  const r = construirReporteVentas([...muchos('Lomas Bonitas', 3), ...muchos('Lomas Bonitsa', 2), envio('Lomas Bonista')]);
  assert.deepStrictEqual(renglones(r), [['Lomas Bonitas', 5], ['Lomas Bonista', 1]]);
  assert.deepStrictEqual(r.por_colonia.posibles_duplicados.map(s => [s.de.colonia, s.a.colonia]), [['Lomas Bonista', 'Lomas Bonitas']],
    'la que se parece se sugiere');
});

// ─── B. En el reporte, sin base ────────────────────────────────────────────
const MEZCLA = [
  ...muchos('Vista Serena', 3, 100), envio('Bista Serena', 50), envio('vistaserena', 70),
  ...muchos('Las Fuentes', 3), ...muchos('Las Puentes', 2),
  ...muchos('Hidalgo', 2), envio('Fidalgo'),
  envio('Roma', 40),
  envio(null, 30, { cliente: { nombre: 'X', direccion: 'Pino 3, Bista Serena, Zona X' }, canal: 'whatsapp' }),
  envio(null, 30, { cliente: { nombre: 'Y', direccion: 'Frente a la plaza' }, canal: 'whatsapp' }),
];

await t('REPORTE', '6. un renglón por colonia, con la forma más escrita; Σ envíos (con sin colonia) = Domicilios', async () => {
  const r = construirReporteVentas(MEZCLA);
  const pc = r.por_colonia;
  assert.deepStrictEqual(renglones(r), [['Vista Serena', 6], ['Las Fuentes', 3], ['Hidalgo', 2], ['Las Puentes', 2], ['Fidalgo', 1], ['Roma', 1]]);
  const vs = pc.colonias[0];
  assert.strictEqual(vs.venta, 450, 'la venta de las variantes no se sumó');
  assert.deepStrictEqual(vs.variantes.map(v => [v.nombre, v.pedidos, v.a_mano, v.separar_de]),
    [['Bista Serena', 2, false, 'vista serena'], ['Vistaserena', 1, false, 'vista serena']], JSON.stringify(vs.variantes));
  assert.strictEqual(pc.colonias.reduce((s, x) => s + x.pedidos, 0) + pc.sin_colonia.pedidos, r.resumen.domicilios);
  assert.strictEqual(pc.colonias.reduce((s, x) => s + Math.round(x.pct_con_colonia * 10), 0), 1000, 'los % no suman 100');
  assert.strictEqual(pc.sin_colonia.pedidos, 1);
});

await t('REPORTE', '7. el tramo de WhatsApp escrito de otra forma («Bista Serena») cuenta para la colonia ya vista', async () => {
  const r = construirReporteVentas(MEZCLA);
  const wa = r.ventas.find(v => v.canal === 'whatsapp' && v.colonia);
  assert.strictEqual(wa?.colonia, 'Vista Serena', 'el tramo no se reconoció');
  assert.strictEqual(r.por_colonia.del_texto, 1);
});

await t('REPORTE', '8. cada venta (y el CSV) lleva el nombre de su renglón, no la forma en que se escribió', async () => {
  const r = construirReporteVentas(MEZCLA);
  const colonias = new Set(r.ventas.map(v => v.colonia));
  assert.ok(!colonias.has('Bista Serena') && !colonias.has('Vistaserena'), `quedaron variantes: ${[...colonias]}`);
  assert.strictEqual(r.ventas.filter(v => v.colonia === 'Vista Serena').length, 6);
});

await t('REPORTE', '9. las parecidas se sugieren (la de menos envíos primero en el par), nunca se unen solas', async () => {
  const s = construirReporteVentas(MEZCLA).por_colonia.posibles_duplicados;
  assert.deepStrictEqual(s.map(x => [x.de.colonia, x.de.pedidos, x.a.colonia, x.a.pedidos]),
    [['Las Puentes', 2, 'Las Fuentes', 3], ['Fidalgo', 1, 'Hidalgo', 2]], JSON.stringify(s));
  assert.deepStrictEqual(s[0].de.clave, 'las puentes');
});

const dec = (tipo, de, a) => ({ tipo, de, a, de_nombre: de, a_nombre: a, en: null });

await t('DECISION', '10. «Unir» junta dos renglones (marcados a mano) y quita la sugerencia', async () => {
  const r = construirReporteVentas(MEZCLA, null, { decisionesColonias: [dec('unir', 'las puentes', 'las fuentes')] });
  const lf = r.por_colonia.colonias.find(x => x.colonia === 'Las Fuentes');
  assert.strictEqual(lf.pedidos, 5);
  assert.deepStrictEqual(lf.variantes.map(v => [v.nombre, v.a_mano, v.separar_de]), [['Las Puentes', true, null]]);
  assert.ok(!r.por_colonia.colonias.some(x => x.colonia === 'Las Puentes'));
  assert.deepStrictEqual(r.por_colonia.posibles_duplicados.map(x => x.de.colonia), ['Fidalgo']);
  assert.ok(r.ventas.filter(v => v.colonia === 'Las Fuentes').length === 5, 'el CSV no siguió la unión');
  assert.deepStrictEqual(r.por_colonia.decisiones.map(d => d.tipo), ['unir'], 'el reporte no trae las decisiones');
});

await t('DECISION', '11. «Son distintas» quita la sugerencia y separa una forma que se había unido sola', async () => {
  const r = construirReporteVentas(MEZCLA, null, { decisionesColonias: [
    dec('distintas', 'fidalgo', 'hidalgo'), dec('distintas', 'bista serena', 'vista serena')] });
  assert.deepStrictEqual(r.por_colonia.posibles_duplicados.map(x => x.de.colonia), ['Las Puentes']);
  const vs = r.por_colonia.colonias.find(x => x.colonia === 'Vista Serena');
  assert.deepStrictEqual([vs.pedidos, vs.variantes.map(v => v.nombre)], [4, ['Vistaserena']], JSON.stringify(vs));
  // El tramo «Bista Serena» de WhatsApp se va con la forma que escribió.
  assert.strictEqual(r.por_colonia.colonias.find(x => x.colonia === 'Bista Serena')?.pedidos, 2);
  assert.strictEqual(r.por_colonia.colonias.reduce((s, x) => s + x.pedidos, 0) + r.por_colonia.sin_colonia.pedidos, r.resumen.domicilios);
});

await t('DECISION', '12. aplicarDecision: la última gana, «Deshacer» la quita y lo inválido no entra', async () => {
  let r = V.aplicarDecision([], { accion: 'unir', de: 'las puentes', a: 'las fuentes', de_nombre: 'Las Puentes', a_nombre: 'Las Fuentes' },
    { ahora: new Date('2026-11-20T10:00:00Z') });
  assert.deepStrictEqual(r.decisiones, [{ tipo: 'unir', de: 'las puentes', a: 'las fuentes', de_nombre: 'Las Puentes', a_nombre: 'Las Fuentes', en: '2026-11-20T10:00:00.000Z' }]);
  r = V.aplicarDecision(r.decisiones, { accion: 'distintas', de: 'las fuentes', a: 'las puentes' });
  assert.deepStrictEqual(r.decisiones.map(d => [d.tipo, d.de, d.a]), [['distintas', 'las fuentes', 'las puentes']], 'el mismo par quedó dos veces');
  r = V.aplicarDecision(r.decisiones, { accion: 'deshacer', de: 'las puentes', a: 'las fuentes' });
  assert.deepStrictEqual(r.decisiones, []);
  for (const [cuerpo, code] of [
    [{ accion: 'borrar', de: 'a b', a: 'c d' }, 'ACCION_INVALIDA'],
    [{ accion: 'unir', de: 'Las Fuentes', a: 'las puentes' }, 'COLONIA_INVALIDA'],
    [{ accion: 'unir', de: '<img src=x>', a: 'las puentes' }, 'COLONIA_INVALIDA'],
    [{ accion: 'unir', de: 'a'.repeat(121), a: 'las puentes' }, 'COLONIA_INVALIDA'],
    [{ accion: 'unir', de: 'centro', a: 'centro' }, 'MISMA_COLONIA'],
    [null, 'ACCION_INVALIDA'],
  ]) {
    assert.strictEqual(V.aplicarDecision([], cuerpo).code, code, JSON.stringify(cuerpo));
  }
  const llenas = Array.from({ length: V.MAX_DECISIONES }, (_, i) => dec('distintas', `c${i}`, `d${i}`));
  assert.strictEqual(V.aplicarDecision(llenas, { accion: 'unir', de: 'x', a: 'y' }).code, 'DEMASIADAS_DECISIONES');
  assert.strictEqual(V.aplicarDecision(llenas, { accion: 'deshacer', de: 'c0', a: 'd0' }).decisiones.length, V.MAX_DECISIONES - 1,
    'con el tope lleno no se pudo deshacer');
});

await t('DECISION', '13. lo guardado se lee con cuidado: JSON roto, basura, pares repetidos y nombres con control', async () => {
  assert.deepStrictEqual(V.normalizarDecisiones('{roto'), []);
  assert.deepStrictEqual(V.normalizarDecisiones(null), []);
  assert.deepStrictEqual(V.normalizarDecisiones('{"decisiones":"no"}'), []);
  const d = V.normalizarDecisiones(JSON.stringify({ version: 1, decisiones: [
    { tipo: 'unir', de: 'las puentes', a: 'las fuentes', de_nombre: 'Las\u0000 Puentes\n', a_nombre: 'x'.repeat(300), en: '2026-11-20T10:00:00Z' },
    { tipo: 'distintas', de: 'las fuentes', a: 'las puentes' },
    { tipo: 'otra', de: 'a', a: 'b' }, { tipo: 'unir', de: 'A', a: 'b' }, { tipo: 'unir', de: 'a', a: 'a' }, 'texto', null,
  ] }));
  assert.strictEqual(d.length, 1, JSON.stringify(d));
  assert.deepStrictEqual([d[0].de_nombre, d[0].a_nombre.length, d[0].en], ['Las Puentes', 120, '2026-11-20T10:00:00.000Z']);
});

await t('COMPARA', '14. contra el periodo anterior: la misma colonia aunque allá se escribiera de otra forma, y con las mismas decisiones', async () => {
  // «Arboleda del Sur» no suena igual que «Arboledas del Sur» (es su singular):
  // allá encabezaba y aquí es la variante.
  const actual = [...muchos('Vista Serena', 3), envio('Bista Serena'), ...muchos('Las Fuentes', 2), envio('Roma'),
    ...muchos('Arboledas del Sur', 2), envio('Arboleda del Sur')];
  const anterior = [...muchos('Bista Serena', 2), ...muchos('Las Puentes', 4), envio('Loma'), ...muchos('Arboleda del Sur', 3)];
  const r = armarReporteVentas({ filas: actual, filasAnteriores: anterior, desde: '2026-10-01', hasta: '2026-10-31',
    tz: 'America/Matamoros', hoy: '2026-11-20', decisionesColonias: [dec('unir', 'las puentes', 'las fuentes')] });
  assert.deepStrictEqual(r.por_colonia.colonias.map(x => [x.colonia, x.pedidos, x.pedidos_anterior]),
    [['Vista Serena', 4, 2], ['Arboledas del Sur', 3, 3], ['Las Fuentes', 2, 4], ['Roma', 1, 0]], JSON.stringify(r.por_colonia.colonias));
  const sin = armarReporteVentas({ filas: actual, filasAnteriores: anterior, desde: '2026-10-01', hasta: '2026-10-31',
    tz: 'America/Matamoros', hoy: '2026-11-20' });
  assert.strictEqual(sin.por_colonia.colonias.find(x => x.colonia === 'Las Fuentes').pedidos_anterior, 0, 'sin la decisión no debía compararse');
});

await t('REPORTE', '15. muchas parecidas: a lo más 20 sugerencias, las de más envíos primero', async () => {
  const filas = [];
  for (let i = 0; i < 30; i++) {
    const base = `Rinconada ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}lpha`;
    filas.push(...muchos(base, 40 - i), envio(base.replace('lpha', 'lfa')));
  }
  const s = construirReporteVentas(filas).por_colonia.posibles_duplicados;
  assert.strictEqual(s.length, V.MAX_SUGERENCIAS);
  assert.ok(s.every((x, i) => i === 0 || s[i - 1].a.pedidos >= x.a.pedidos), 'no van de más a menos');
});

// ─── C. Con Postgres real y el servidor ────────────────────────────────────
const SLUGS = ['reportes-colonias-variantes-a', 'reportes-colonias-variantes-b'];
async function limpiar() {
  const { rows } = await pool.query(`SELECT id FROM negocios WHERE slug = ANY($1)`, [SLUGS]);
  for (const { id } of rows) {
    const q = (sql) => pool.query(sql, [id]).catch(() => {});
    await q(`DELETE FROM pedidos_activos WHERE negocio_id = $1`);
    await q(`DELETE FROM configuracion WHERE negocio_id = $1`);
    await q(`DELETE FROM negocio_modulos WHERE negocio_id = $1`);
    await q(`DELETE FROM usuario_negocios WHERE negocio_id = $1`);
    await q(`DELETE FROM usuarios WHERE negocio_id = $1`);
    await q(`DELETE FROM negocios WHERE id = $1`);
  }
}
await limpiar();

async function usuario(negId, slug, rol) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,'x') RETURNING id`,
    [negId, `${rol} ${slug}`, `${slug}-${rol}-${Date.now()}@test.local`]);
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,$3)`, [u.id, negId, rol]);
  return `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: u.id, negocioId: negId, rol }))}`;
}
async function negocio(slug, nombre) {
  const { rows: [neg] } = await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ($1, $2) RETURNING id`, [nombre, slug]);
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'pos','activo')`, [neg.id]);
  return { id: neg.id, admin: await usuario(neg.id, slug, 'admin'), staff: await usuario(neg.id, slug, 'staff') };
}
const A = await negocio(SLUGS[0], 'Colonias Variantes A');
const B = await negocio(SLUGS[1], 'Colonias Variantes B');
async function pedido(neg, folio, colonia) {
  await pool.query(`INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at) VALUES ($1,'entregado',$2,$3,'2020-10-07 17:00:00'::timestamp)`,
    [folio, JSON.stringify({ id: folio, negocioId: neg, canal: 'pos', modalidad: DOM, forma_pago: 'efectivo', total: 100, cliente: { nombre: folio, colonia } }), neg]);
}
const DIA = '2020-10-07';
let k = 0;
for (const [colonia, veces] of [['Las Fuentes', 3], ['Las Puentes', 2], ['Vista Serena', 2], ['Bista Serena', 1]]) {
  for (let i = 0; i < veces; i++) { await pedido(A.id, `RCV-${String(++k).padStart(4, '0')}`, colonia); await pedido(B.id, `RCVB-${String(k).padStart(4, '0')}`, colonia); }
}

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
async function api(path, galleta, cuerpo) {
  const r = await fetch(srv.base + path, {
    method: cuerpo === undefined ? 'GET' : 'POST',
    headers: { ...(galleta ? { Cookie: galleta } : {}), ...(cuerpo === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(cuerpo === undefined ? {} : { body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo) }),
  });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
}
const RUTA = '/api/reportes/colonias/decisiones';
const reporteDe = async (neg) => (await api(`/api/reportes/ventas?desde=${DIA}&hasta=${DIA}`, neg.admin)).body.por_colonia;
const guardado = async (neg) => {
  const { rows } = await pool.query(`SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2`, [neg.id, V.CLAVE_DECISIONES]);
  return rows[0] ? JSON.parse(rows[0].valor) : null;
};

try {
  await t('HTTP', '16. el reporte agrupa las variantes y sugiere las parecidas, leído de la base', async () => {
    const pc = await reporteDe(A);
    assert.deepStrictEqual(pc.colonias.map(x => [x.colonia, x.pedidos, x.variantes.map(v => v.nombre).join()]),
      [['Las Fuentes', 3, ''], ['Vista Serena', 3, 'Bista Serena'], ['Las Puentes', 2, '']], JSON.stringify(pc.colonias));
    assert.deepStrictEqual(pc.posibles_duplicados.map(s => [s.de.clave, s.a.clave]), [['las puentes', 'las fuentes']]);
    assert.deepStrictEqual(pc.decisiones, []);
  });

  await t('HTTP', '17. «Unir» del administrador se guarda y el reporte la aplica; la venta y los pedidos no cambian', async () => {
    const antes = await pool.query(`SELECT folio, datos FROM pedidos_activos WHERE negocio_id = $1 ORDER BY folio`, [A.id]);
    const r = await api(RUTA, A.admin, { accion: 'unir', de: 'las puentes', a: 'las fuentes', de_nombre: 'Las Puentes', a_nombre: 'Las Fuentes' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.decisiones.map(d => [d.tipo, d.de, d.a]), [['unir', 'las puentes', 'las fuentes']]);
    const g = await guardado(A);
    assert.strictEqual(g.version, 1);
    assert.strictEqual(g.decisiones.length, 1);
    const pc = await reporteDe(A);
    assert.deepStrictEqual(pc.colonias.map(x => [x.colonia, x.pedidos]), [['Las Fuentes', 5], ['Vista Serena', 3]]);
    assert.deepStrictEqual(pc.posibles_duplicados, []);
    const despues = await pool.query(`SELECT folio, datos FROM pedidos_activos WHERE negocio_id = $1 ORDER BY folio`, [A.id]);
    assert.deepStrictEqual(despues.rows, antes.rows, 'se modificó un pedido');
  });

  await t('SEGURIDAD', '18. solo el administrador decide; el operador y sin sesión no; el negocio sale de la sesión', async () => {
    const op = await api(RUTA, A.staff, { accion: 'distintas', de: 'bista serena', a: 'vista serena' });
    assert.strictEqual(op.status, 403, `operador: ${op.status}`);
    const anon = await api(RUTA, null, { accion: 'distintas', de: 'bista serena', a: 'vista serena' });
    assert.ok([401, 403].includes(anon.status), `sin sesión: ${anon.status}`);
    assert.strictEqual((await guardado(A)).decisiones.length, 1, 'el operador o un anónimo guardó algo');
    // B intenta decidir por A mandando su id: se guarda en B.
    const b = await api(`${RUTA}?negocioId=${A.id}`, B.admin, { accion: 'distintas', de: 'bista serena', a: 'vista serena', negocioId: A.id });
    assert.strictEqual(b.status, 200);
    assert.strictEqual((await guardado(A)).decisiones.length, 1, 'B escribió en A');
    assert.deepStrictEqual((await guardado(B)).decisiones.map(d => d.tipo), ['distintas']);
    const pcA = await reporteDe(A), pcB = await reporteDe(B);
    assert.strictEqual(pcA.colonias.find(x => x.colonia === 'Vista Serena').pedidos, 3, 'la decisión de B separó en A');
    assert.ok(pcB.colonias.some(x => x.colonia === 'Bista Serena'), 'B no aplicó su decisión');
    assert.ok(pcB.colonias.some(x => x.colonia === 'Las Puentes'), 'la unión de A se aplicó en B');
  });

  await t('HTTP', '19. lo inválido responde 400 sin tocar lo guardado; JSON roto en la base no tumba el reporte', async () => {
    for (const cuerpo of [{ accion: 'unir', de: 'LAS PUENTES', a: 'las fuentes' }, { accion: 'x' }, { accion: 'unir', de: 'centro', a: 'centro' }]) {
      const r = await api(RUTA, A.admin, cuerpo);
      assert.strictEqual(r.status, 400, `${JSON.stringify(cuerpo)} → ${r.status}`);
      assert.ok(r.body?.code, 'sin código de error');
    }
    assert.strictEqual((await guardado(A)).decisiones.length, 1);
    await pool.query(`UPDATE configuracion SET valor = '{roto' WHERE negocio_id = $1 AND clave = $2`, [B.id, V.CLAVE_DECISIONES]);
    const r = await api(`/api/reportes/ventas?desde=${DIA}&hasta=${DIA}`, B.admin);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.por_colonia.decisiones, []);
    const w = await api(RUTA, B.admin, { accion: 'unir', de: 'las puentes', a: 'las fuentes' });
    assert.strictEqual(w.status, 200, 'con la fila rota no se pudo volver a guardar');
    assert.strictEqual((await guardado(B)).decisiones.length, 1);
  });

  await t('HTTP', '20. diez decisiones a la vez desde dos pantallas: se guardan las diez', async () => {
    const r = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      api(RUTA, A.admin, { accion: 'distintas', de: `colonia ${i}`, a: `otra ${i}` })));
    assert.ok(r.every(x => x.status === 200), r.map(x => x.status).join());
    assert.strictEqual((await guardado(A)).decisiones.length, 11, 'se perdió una decisión al guardar a la vez');
  });

  await t('HTTP', '21. con el tope lleno responde 409, pero «Deshacer» sigue funcionando', async () => {
    const llenas = Array.from({ length: V.MAX_DECISIONES }, (_, i) => ({ tipo: 'distintas', de: `c${i}`, a: `d${i}` }));
    await pool.query(`UPDATE configuracion SET valor = $3 WHERE negocio_id = $1 AND clave = $2`,
      [B.id, V.CLAVE_DECISIONES, JSON.stringify({ version: 1, decisiones: llenas })]);
    const r = await api(RUTA, B.admin, { accion: 'unir', de: 'x', a: 'y' });
    assert.strictEqual(r.status, 409, `${r.status} ${JSON.stringify(r.body)}`);
    const d = await api(RUTA, B.admin, { accion: 'deshacer', de: 'c0', a: 'd0' });
    assert.strictEqual(d.status, 200);
    assert.strictEqual((await guardado(B)).decisiones.length, V.MAX_DECISIONES - 1);
  });
} finally {
  srv.detener();
}

await limpiar().catch(() => {});
await pool.end();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  · ' + fallos.join('\n  · ')); process.exit(1); }
process.exit(0);
