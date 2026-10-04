// Formulario «tienda» (tienda_v1), Fase 1: vitrina y precalentamiento
// (src/services/vitrinaTienda.js). Pura: la consulta, la configuración y las
// miniaturas se inyectan; no abre conexiones (el pool de database.js se crea
// pero nunca consulta).
//
// Garantías que prueba:
//   vitrina   orden comercial (orden y, en empate, id numérico) sin depender del
//             ORDER BY; descripciones; llaves peligrosas fuera; inmutable
//   caché     60 s por negocio; dos peticiones a la vez, una consulta; invalidar
//             descarta también la consulta en vuelo; un error no se guarda ni lanza
//   bandera   whatsapp_flow_tienda_v1 'prueba' o 'true'; cualquier otro valor apaga
//   precalentar  orden comercial; solo con la bandera; tras guardar foto, sin
//             esperar ni lanzar
//   fuera de la foto  la foto del formulario no cambia con descripciones, fotos
//             ni con la bandera (Fase 1 no conecta nada al canal)
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armarVitrina, crearVitrinas, portadaDeCategoria, modoTienda, precalentarVitrina, precalentarNegocio, precalentarAlArrancar,
  fotoDeProductoCambiada, esperarPrecalentamiento, leerModoTienda, SQL_VITRINA, TTL_VITRINA_MS, BANDERA_TIENDA, FLOW_TIENDA_ID,
  TELEFONOS_TIENDA, VITRINA_VACIA, precalentarFormularioTienda, vitrinaParaFormulario, ESPERA_VITRINA_MS } from '../src/services/vitrinaTienda.js';
import { fotoFormulario } from '../src/mesero-agente/formularioAgrupado.js';

let pasadas = 0, fallidas = 0;
const t = async (nombre, fn) => {
  try { await fn(); pasadas++; console.log(`  ok  ${nombre}`); } catch (e) { fallidas++; console.log(`FALLA ${nombre}: ${e.message}`); }
};
const rechazos = [];
process.on('unhandledRejection', (e) => rechazos.push(e));
const silencio = () => {};
const tic = () => new Promise((r) => setImmediate(r));
const diferida = () => { let resolver, rechazar; const promesa = new Promise((a, b) => { resolver = a; rechazar = b; }); return { promesa, resolver, rechazar }; };
const K = (n) => `development/negocios/neg/productos/${n}.jpg`;

// Filas como las devuelve SQL_VITRINA, desordenadas a propósito.
const FILAS = [
  { id: 30, descripcion: '  Dos piezas \n', orden: 2, storage_key: K('hotcakes'), categoria_id: 9, categoria: 'DESAYUNOS', categoria_orden: 1 },
  { id: 4, descripcion: null, orden: 0, storage_key: null, categoria_id: 2, categoria: 'BEBIDAS', categoria_orden: 0 },
  { id: 12, descripcion: 'Waffle', orden: 1, storage_key: '../../etc/passwd', categoria_id: 9, categoria: 'DESAYUNOS', categoria_orden: 1 },
  { id: 2, descripcion: 'Molletes', orden: 1, storage_key: K('molletes'), categoria_id: 9, categoria: 'DESAYUNOS', categoria_orden: 1 },
  { id: 7, descripcion: '', orden: 0, storage_key: K('pay'), categoria_id: 10, categoria: 'POSTRES', categoria_orden: 1 },
  { id: 5, descripcion: 'Café', orden: null, storage_key: 123, categoria_id: 2, categoria: 'BEBIDAS', categoria_orden: 0 },
];
/** Miniaturas falsas: anota cada encolar. */
function miniaturasFalsas() {
  const encoladas = [];
  return { encoladas, encolar: (k, v = ['lista96', 'cat128', 'ficha480']) => { encoladas.push([k, ...v]); return v.length; }, esperar: async () => {} };
}

// ── Bandera ──────────────────────────────────────────────────────────────
await t('bandera: whatsapp_flow_tienda_v1 «true» = todos, «prueba» = solo los teléfonos de prueba; cualquier otro valor la apaga', () => {
  assert.deepEqual([BANDERA_TIENDA, FLOW_TIENDA_ID, TELEFONOS_TIENDA], ['whatsapp_flow_tienda_v1', 'whatsapp_flow_tienda_id', 'whatsapp_flow_tienda_telefonos']);
  assert.equal(modoTienda({ whatsapp_flow_tienda_v1: 'true' }), 'todos');
  assert.equal(modoTienda({ whatsapp_flow_tienda_v1: 'prueba' }), 'prueba');
  for (const v of [undefined, null, '', 'false', 'TRUE', ' true', 'si', '1', true, 'Prueba']) assert.equal(modoTienda({ whatsapp_flow_tienda_v1: v }), null, String(v));
  assert.equal(modoTienda(undefined), null); assert.equal(modoTienda({}), null);
});

// ── Vitrina ──────────────────────────────────────────────────────────────
await t('vitrina: orden comercial (orden y, en empate, id numérico) aunque las filas lleguen desordenadas', () => {
  const v = armarVitrina(FILAS);
  assert.deepEqual(v.categorias.map((c) => [c.id, c.nombre]), [['2', 'BEBIDAS'], ['9', 'DESAYUNOS'], ['10', 'POSTRES']], '9 antes que 10');
  assert.deepEqual(v.categorias.map((c) => c.productos), [['4', '5'], ['2', '12', '30'], ['7']], 'orden null = 0 (empata con 4 y gana el id menor); 2 antes que 12');
  assert.deepEqual(armarVitrina([...FILAS].reverse()), v, 'el resultado no depende del orden de llegada');
  assert.equal(v.error, null);
});
await t('vitrina: descripción recortada, foto solo con una llave válida', () => {
  const v = armarVitrina(FILAS);
  assert.deepEqual(v.productos['30'], { id: '30', orden: 2, descripcion: 'Dos piezas', storageKey: K('hotcakes'), categoriaId: '9' });
  assert.deepEqual([v.productos['4'].descripcion, v.productos['4'].storageKey], ['', null]);
  assert.equal(v.productos['12'].storageKey, null, 'una llave con «..» no es foto');
  assert.equal(v.productos['5'].storageKey, null, 'una llave que no es texto no es foto');
  assert.deepEqual(armarVitrina([]), { categorias: [], productos: {}, error: null });
});
await t('vitrina: inmutable (la caché la comparte entre peticiones)', () => {
  const v = armarVitrina(FILAS);
  assert.throws(() => { v.productos['30'].descripcion = 'otra'; }, TypeError);
  assert.throws(() => { v.categorias[0].productos.push('99'); }, TypeError);
  assert.throws(() => { v.categorias.pop(); }, TypeError);
  assert.throws(() => { v.productos['99'] = {}; }, TypeError);
  assert(Object.isFrozen(VITRINA_VACIA));
});
await t('portada de categoría: el primer producto con foto en orden comercial, opcionalmente entre los visibles', () => {
  const v = armarVitrina(FILAS);
  assert.equal(portadaDeCategoria(v, '9'), K('molletes'));
  assert.equal(portadaDeCategoria(v, 9, ['30', '12']), K('hotcakes'), 'si Molletes no se muestra, la siguiente con foto');
  assert.equal(portadaDeCategoria(v, '2'), null, 'BEBIDAS no tiene fotos válidas');
  assert.equal(portadaDeCategoria(v, '77'), null); assert.equal(portadaDeCategoria(null, '9'), null);
});
await t('consulta: una sola, del negocio, con publicados de categorías activas', () => {
  assert.match(SQL_VITRINA, /FROM whatsapp_productos wp/);
  assert.match(SQL_VITRINA, /wp\.negocio_id = \$1 AND wp\.publicado = TRUE AND c\.activa = TRUE/);
  assert.match(SQL_VITRINA, /p\.negocio_id = wp\.negocio_id/); assert.match(SQL_VITRINA, /c\.negocio_id = p\.negocio_id/);
  assert.match(SQL_VITRINA, /jsonb_typeof\(p\.opciones -> 'imagen' -> 'storage_key'\) = 'string'/);
});

// ── Caché de vitrinas ────────────────────────────────────────────────────
await t('caché: 60 s por negocio; vencida, se vuelve a consultar; cada negocio la suya', async () => {
  let reloj = 0; const consultas = [];
  const vs = crearVitrinas({ consultar: async (id) => { consultas.push(id); return id === 'a' ? FILAS : []; }, ahora: () => reloj });
  assert.equal(TTL_VITRINA_MS, 60_000);
  const v1 = await vs.obtener('a'), v2 = await vs.obtener(' a ');
  assert.equal(v1, v2); assert.deepEqual(consultas, ['a']);
  reloj += TTL_VITRINA_MS - 1; await vs.obtener('a'); assert.equal(consultas.length, 1);
  reloj += 1; await vs.obtener('a'); assert.deepEqual(consultas, ['a', 'a']);
  assert.equal((await vs.obtener('b')).categorias.length, 0); assert.deepEqual(consultas, ['a', 'a', 'b']);
});
await t('caché: dos peticiones a la vez comparten la consulta; la consulta nunca corre dentro de la llamada', async () => {
  const d = diferida(); let llamadas = 0;
  const vs = crearVitrinas({ consultar: () => { llamadas++; return d.promesa; } });
  const p1 = vs.obtener('a'), p2 = vs.obtener('a');
  assert.equal(llamadas, 0, 'obtener no consulta de forma síncrona');
  await tic(); assert.equal(llamadas, 1);
  d.resolver(FILAS);
  assert.equal(await p1, await p2);
});
await t('caché: invalidar descarta la vitrina y la consulta en vuelo (una lectura anterior a un cambio no se guarda)', async () => {
  const respuestas = [diferida(), diferida()]; let n = 0;
  const vs = crearVitrinas({ consultar: () => respuestas[n++].promesa });
  const vieja = vs.obtener('a'); await tic();
  vs.invalidar('a'); // la foto cambió mientras se leía
  const nueva = vs.obtener('a'); await tic();
  assert.equal(n, 2, 'después de invalidar no se une a la consulta vieja');
  // La lectura vieja llega DESPUÉS que la nueva: no debe pisarla en la caché.
  respuestas[1].resolver(FILAS); assert.equal((await nueva).categorias.length, 3);
  respuestas[0].resolver(FILAS.slice(0, 1)); assert.equal((await vieja).categorias.length, 1);
  assert.equal((await vs.obtener('a')).categorias.length, 3, 'la caché guarda la lectura nueva, no la vieja');
  assert.equal(n, 2);
  // Invalidar con la caché llena también fuerza otra consulta.
  vs.invalidar('a'); respuestas.push(diferida()); const otra = vs.obtener('a'); await tic(); respuestas[2].resolver([]);
  assert.equal((await otra).categorias.length, 0); assert.equal(n, 3);
});
await t('caché: si la lectura falla, vitrina vacía con error, sin lanzar y sin guardarse', async () => {
  const avisos = []; let n = 0;
  const vs = crearVitrinas({ consultar: async () => { n++; if (n === 1) throw new Error('relation "whatsapp_productos" does not exist'); return FILAS; }, avisar: (m) => avisos.push(m) });
  const v = await vs.obtener('a');
  assert.deepEqual([v.categorias.length, v.error], [0, 'lectura_vitrina']); assert(Object.isFrozen(v));
  assert.match(avisos[0], /negocio=a/);
  assert.equal((await vs.obtener('a')).categorias.length, 3, 'el error no se guarda en la caché');
  const sincrona = crearVitrinas({ consultar: () => { throw new Error('síncrono'); }, avisar: silencio });
  assert.equal((await sincrona.obtener('a')).error, 'lectura_vitrina');
});
await t('caché: un negocio inválido da la vitrina vacía sin consultar', async () => {
  let n = 0; const vs = crearVitrinas({ consultar: async () => { n++; return FILAS; } });
  for (const id of [undefined, null, '', '  ', 42]) assert.equal(await vs.obtener(id), VITRINA_VACIA);
  vs.invalidar(null);
  assert.equal(n, 0);
});

// ── Precalentamiento ─────────────────────────────────────────────────────
await t('precalentar una vitrina: portada (cat128) y luego cada foto (lista96 y ficha480), en orden comercial', () => {
  const m = miniaturasFalsas();
  assert.equal(precalentarVitrina(armarVitrina(FILAS), { miniaturas: m }), 8);
  assert.deepEqual(m.encoladas, [
    [K('molletes'), 'cat128'], [K('molletes'), 'lista96', 'ficha480'], [K('hotcakes'), 'lista96', 'ficha480'],
    [K('pay'), 'cat128'], [K('pay'), 'lista96', 'ficha480']]);
  assert.equal(precalentarVitrina(VITRINA_VACIA, { miniaturas: m }), 0);
});
await t('precalentar con visibles (Fase 2B, al mandar una tienda): solo los platillos de la foto, y la portada se busca entre ellos', () => {
  const m = miniaturasFalsas();
  assert.equal(precalentarVitrina(armarVitrina(FILAS), { miniaturas: m, visibles: ['30', 4] }), 3);
  assert.deepEqual(m.encoladas, [[K('hotcakes'), 'cat128'], [K('hotcakes'), 'lista96', 'ficha480']]);
});
await t('precalentar al mandar una tienda: con la vitrina del negocio y los ids de la foto; sin esperar ni lanzar', async () => {
  const m = miniaturasFalsas(), avisos = [];
  const vs = { obtener: async () => armarVitrina(FILAS) };
  assert.equal(precalentarFormularioTienda('neg', { productos: [{ id: '2' }, { id: '7' }] }, { vitrinas: vs, miniaturas: m, avisar: (x) => avisos.push(x) }), undefined);
  assert.deepEqual(m.encoladas, [], 'nada dentro de la llamada');
  await esperarPrecalentamiento({ miniaturas: m });
  assert.deepEqual(m.encoladas, [[K('molletes'), 'cat128'], [K('molletes'), 'lista96', 'ficha480'], [K('pay'), 'cat128'], [K('pay'), 'lista96', 'ficha480']]);
  const rota = { obtener: async () => { throw new Error('caída'); } }, conError = { obtener: async () => ({ ...VITRINA_VACIA, error: 'lectura_vitrina' }) };
  precalentarFormularioTienda('neg', { productos: [{ id: '2' }] }, { vitrinas: rota, miniaturas: m, avisar: (x) => avisos.push(x) });
  precalentarFormularioTienda('neg', { productos: [{ id: '2' }] }, { vitrinas: conError, miniaturas: m, avisar: (x) => avisos.push(x) });
  precalentarFormularioTienda('neg', null, { vitrinas: { obtener: () => { throw new Error('no debió consultarse'); } }, miniaturas: m, avisar: (x) => avisos.push(x) });
  await esperarPrecalentamiento({ miniaturas: m });
  assert.equal(m.encoladas.length, 4); assert.equal(avisos.length, 1); assert.match(avisos[0], /caída/);
});
await t('vitrina para el endpoint: la de la caché con su lector de miniaturas; con error o si tarda, null (sin fotos), nunca lanza', async () => {
  const pedidas = [], miniaturas = { obtener: (k, v) => { pedidas.push([k, v]); return 'b64'; } };
  const v = await vitrinaParaFormulario('neg', { vitrinas: { obtener: async () => armarVitrina(FILAS) }, miniaturas });
  assert.equal(v.productos['30'].descripcion, 'Dos piezas'); assert.equal(v.miniatura(K('pay'), 'lista96'), 'b64');
  assert.deepEqual(pedidas, [[K('pay'), 'lista96']]);
  assert.equal(await vitrinaParaFormulario('neg', { vitrinas: { obtener: async () => ({ ...VITRINA_VACIA, error: 'lectura_vitrina' }) }, miniaturas }), null);
  assert.equal(await vitrinaParaFormulario('neg', { vitrinas: { obtener: async () => { throw new Error('x'); } }, miniaturas }), null);
  const inicio = Date.now();
  assert.equal(await vitrinaParaFormulario('neg', { vitrinas: { obtener: () => new Promise(() => {}) }, miniaturas, esperaMs: 30 }), null);
  assert(Date.now() - inicio < 1000, 'no espera más de su tope');
  assert.equal(ESPERA_VITRINA_MS, 1500);
});
await t('precalentar un negocio: solo con la bandera encendida', async () => {
  const m = miniaturasFalsas(); let lecturas = 0;
  const vitrinas = { obtener: async () => { lecturas++; return armarVitrina(FILAS); } };
  assert.equal(await precalentarNegocio('a', { vitrinas, miniaturas: m, leerModo: async () => null }), 0);
  assert.deepEqual([lecturas, m.encoladas.length], [0, 0], 'apagada: ni lee la vitrina');
  assert.equal(await precalentarNegocio('a', { vitrinas, miniaturas: m, leerModo: async () => 'prueba' }), 8);
  assert.equal(lecturas, 1);
});
await t('leer la bandera: una consulta a configuracion del negocio, con el mismo criterio', async () => {
  const consultas = [];
  const db = (valor) => ({ query: async (sql, params) => { consultas.push([sql, params]); return { rows: valor === undefined ? [] : [{ valor }] }; } });
  assert.equal(await leerModoTienda('neg-1', { db: db('true') }), 'todos');
  assert.equal(await leerModoTienda('neg-1', { db: db('TRUE') }), null);
  assert.equal(await leerModoTienda('neg-1', { db: db(undefined) }), null);
  assert.equal(await leerModoTienda('', { db: db('true') }), null);
  assert.equal(consultas.length, 3);
  assert.deepEqual(consultas[0], ['SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2', ['neg-1', 'whatsapp_flow_tienda_v1']]);
});
await t('al arrancar: solo los negocios con la bandera encendida; uno que falla no detiene a los demás', async () => {
  const m = miniaturasFalsas(), avisos = [], consultas = [];
  const db = { query: async (sql, params) => { consultas.push([sql, params]); return { rows: [{ negocio_id: 'a' }, { negocio_id: 'b' }, { negocio_id: 'c' }] }; } };
  const vitrinas = { obtener: async (id) => { if (id === 'b') throw new Error('se cayó'); return id === 'a' ? armarVitrina(FILAS) : VITRINA_VACIA; } };
  assert.equal(await precalentarAlArrancar({ db, vitrinas, miniaturas: m, avisar: (x) => avisos.push(x) }), 8);
  assert.match(consultas[0][0], /WHERE clave = \$1 AND valor IN \('prueba', 'true'\)/);
  assert.deepEqual(consultas[0][1], ['whatsapp_flow_tienda_v1']);
  assert.equal(avisos.length, 1); assert.match(avisos[0], /negocio=b/);
});
await t('tras guardar una foto: invalida la vitrina ya, no devuelve nada que esperar y con la bandera encola sus tres variantes', async () => {
  const m = miniaturasFalsas(), invalidadas = [];
  const vitrinas = { invalidar: (id) => invalidadas.push(id) };
  let pendiente = diferida();
  const r = fotoDeProductoCambiada('neg', K('nueva'), { vitrinas, miniaturas: m, leerModo: () => pendiente.promesa });
  try {
    assert.equal(r, undefined, 'nada que esperar');
    assert.deepEqual(invalidadas, ['neg'], 'la vitrina se invalida en la misma llamada');
    assert.equal(m.encoladas.length, 0);
  } finally { pendiente.resolver('prueba'); } // si algo falla, no deja colgado al resto de la suite
  await esperarPrecalentamiento({ miniaturas: m });
  assert.deepEqual(m.encoladas, [[K('nueva'), 'lista96', 'cat128', 'ficha480']]);
  // Apagada: invalida, pero no encola.
  pendiente = diferida(); fotoDeProductoCambiada('neg', K('otra'), { vitrinas, miniaturas: m, leerModo: () => pendiente.promesa });
  pendiente.resolver(null); await esperarPrecalentamiento({ miniaturas: m });
  assert.equal(m.encoladas.length, 1); assert.deepEqual(invalidadas, ['neg', 'neg']);
  // Foto quitada: solo invalida, ni lee la bandera.
  let leida = false;
  fotoDeProductoCambiada('neg', null, { vitrinas, miniaturas: m, leerModo: async () => { leida = true; return 'todos'; } });
  await esperarPrecalentamiento({ miniaturas: m });
  assert.equal(leida, false); assert.equal(invalidadas.length, 3);
});
await t('tras guardar una foto: ningún fallo sale de la llamada ni queda como rechazo suelto', async () => {
  const avisos = [], m = miniaturasFalsas();
  assert.doesNotThrow(() => fotoDeProductoCambiada('neg', K('x'), { vitrinas: { invalidar: () => { throw new Error('caché rota'); } }, miniaturas: m, avisar: (x) => avisos.push(x) }));
  fotoDeProductoCambiada('neg', K('x'), { vitrinas: { invalidar: () => {} }, miniaturas: m, leerModo: () => { throw new Error('sin base'); }, avisar: (x) => avisos.push(x) });
  fotoDeProductoCambiada('neg', K('x'), { vitrinas: { invalidar: () => {} }, miniaturas: m, leerModo: async () => { throw new Error('timeout'); }, avisar: (x) => avisos.push(x) });
  await esperarPrecalentamiento({ miniaturas: m }); await tic();
  assert.equal(avisos.length, 3); assert.match(avisos[1], /sin base/); assert.match(avisos[2], /timeout/);
  assert.equal(m.encoladas.length, 0); assert.equal(rechazos.length, 0, String(rechazos[0]));
});

// ── Fuera de la foto del formulario, y nada conectado al canal ───────────
const catalogo = (descripcion, imagen) => [{ id: 1, nombre: 'DESAYUNOS', orden: 0, productos: [
  { id: 10, nombre: 'Hotcakes', precio: '139.00', descripcion, disponible: true, orden: 1, opciones: imagen ? { imagen: { storage_key: imagen } } : null,
    imagen: imagen ? `/img/producto/10?v=${imagen.slice(-12)}` : null, modificadores: [] },
  { id: 11, nombre: 'Waffles', precio: '149.00', descripcion: 'Dos piezas', disponible: true, orden: 2, opciones: null, imagen: null, modificadores: [] }] }];
const foto = (cat, cfg) => fotoFormulario({ estado: { carrito: { items: [] } }, catalogo: cat, modalidades: [], metodosPago: [], cfg, reglas: {} }, 'flow_productos');
await t('la foto del formulario no cambia con descripciones ni fotos (lo visual no la invalida)', () => {
  const base = foto(catalogo('La orden incluye 2 piezas', null), {});
  assert.equal(base.productos.length, 2);
  assert.deepEqual(foto(catalogo('Otra descripción', K('h1')), {}), base);
  assert.deepEqual(foto(catalogo('', K('h2')), {}), base);
  assert.equal(JSON.stringify(base).includes('descripcion') || JSON.stringify(base).includes('storage_key'), false);
});
await t('la bandera sola (sin dirección, nota ni Flow de categorías) no cambia la foto del formulario', () => {
  const base = foto(catalogo('x', K('h1')), {});
  for (const v of ['true', 'prueba']) assert.deepEqual(foto(catalogo('x', K('h1')), { whatsapp_flow_tienda_v1: v, whatsapp_flow_tienda_id: '123456789' }), base, v);
});
await t('quién carga la vitrina: imagenesProducto.js y server.js (arranque); canalDelAgente.js y flowRepetibleSql.js solo con import() diferido (una tienda); solo la vitrina importa las miniaturas', () => {
  const raiz = fileURLToPath(new URL('../src/', import.meta.url)), importadores = { vitrinaTienda: [], miniaturasMenu: [] };
  const recorrer = (dir) => {
    for (const f of readdirSync(dir)) {
      const ruta = join(dir, f);
      if (statSync(ruta).isDirectory()) { recorrer(ruta); continue; }
      if (!/\.(m?js)$/.test(f)) continue;
      const fuente = readFileSync(ruta, 'utf8');
      for (const m of Object.keys(importadores)) if (new RegExp(`from '[^']*/${m}\\.js'|import\\('[^']*/${m}\\.js'\\)`).test(fuente)) importadores[m].push(ruta.slice(raiz.length).replaceAll('\\', '/'));
    }
  };
  recorrer(raiz);
  for (const k of Object.keys(importadores)) importadores[k].sort();
  assert.deepEqual(importadores, { vitrinaTienda: ['mesero-agente/canalDelAgente.js', 'mesero-agente/flowRepetibleSql.js', 'server.js', 'services/imagenesProducto.js'],
    miniaturasMenu: ['services/vitrinaTienda.js'] });
  // Con la bandera apagada el canal y el endpoint ni cargan el módulo (base, sharp): solo import() diferido.
  for (const f of ['mesero-agente/canalDelAgente.js', 'mesero-agente/flowRepetibleSql.js']) {
    const fuente = readFileSync(join(raiz, f), 'utf8');
    assert.doesNotMatch(fuente, /from '[^']*\/vitrinaTienda\.js'/, f);
    assert.match(fuente, /import\('[^']*\/vitrinaTienda\.js'\)/, f);
  }
});

await tic();
console.log(`RESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas} (vitrina tienda)`);
process.exit(fallidas || rechazos.length ? 1 : 0);
