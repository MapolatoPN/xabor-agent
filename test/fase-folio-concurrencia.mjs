// Hotfix P0 — Conflicto silencioso de folio.
//
// Antes de esta corrección, guardarPedidoActivo() devolvía `true` aunque el
// INSERT ... ON CONFLICT (folio) DO NOTHING no hubiera escrito ninguna fila:
// registrarPedido() confirmaba al cliente un pedido cuya fila en la base era
// OTRO pedido (incluso de OTRO negocio), y el contador de folios se
// incrementaba DESPUÉS del await, así que dos creaciones concurrentes leían
// el mismo número.
//
// Esta suite fija el contrato corregido: el retorno distingue INSERT real /
// conflicto / error SQL; el folio se reserva de forma síncrona; un conflicto
// se reintenta con el siguiente folio (nunca se adopta el pedido existente);
// un error de base de datos NO se reintenta; y al agotar el tope se falla con
// FOLIO_NO_DISPONIBLE en vez de confirmar un pedido inexistente.
//
// Dos instancias reales: el proceso de esta suite (orderManager en memoria) y
// el servidor hijo levantado abajo, ambos contra la MISMA base y arrancando
// con el MISMO contador — es la simulación del deploy con dos réplicas.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4946';

const { pool, guardarPedidoActivo } = await import('../src/services/database.js');
const { registrarPedido, cargarPedidosDesdeDB, obtenerPedidos } = await import('../src/orders/orderManager.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
async function api(base, path, { cookie, method = 'GET', body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (cookie) h['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
async function fijarModulo(negocioId, modulo, estado = 'activo') {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}
const siguienteFolio = (folio, n = 1) => `XAB-${String(parseInt(folio.replace('XAB-', ''), 10) + n).padStart(4, '0')}`;
const contarFolio = async (folio) => (await pool.query(`SELECT COUNT(*)::int c FROM pedidos_activos WHERE folio=$1`, [folio])).rows[0].c;
const filaDe = async (folio) => (await pool.query(`SELECT negocio_id, estado, datos FROM pedidos_activos WHERE folio=$1`, [folio])).rows[0] || null;

const A = SEED.negocioA, B = SEED.negocioB;
const ordenBase = (negocioId, extra = {}) => ({
  negocioId, cliente: { nombre: 'Cliente Folio', telefono: '8781110000' },
  modalidad: 'recoger en tienda', items: [], subtotal: 100, costo_envio: 0, descuento: 0, total: 100, ...extra
});

// ── Limpieza re-ejecutable (al inicio; se repite al final) ────────────────
async function limpiar() {
  await pool.query(`DELETE FROM pedidos_activos WHERE folio LIKE 'FOLIOTEST-%'`);
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = ANY($1) AND datos->>'canal' IN ('foliotest','foliotest-b','rappi','pos','otra-instancia','programado-test')`, [[A, B]]);
}
await limpiar();
for (const n of [A, B]) { await fijarModulo(n, 'pos'); await fijarModulo(n, 'menu'); await fijarModulo(n, 'repartidores'); }

// ═════════ 1-4) Contrato de guardarPedidoActivo (sin contador) ═════════
// Folios con prefijo FOLIOTEST-: invisibles para obtenerMaxFolioNum
// (^XAB-[0-9]+$), así que no mueven el contador de ninguna instancia.
await t('CONTRATO', 'INSERT real: insertado=true, conflicto=false y la fila existe', async () => {
  const r = await guardarPedidoActivo({ id: 'FOLIOTEST-INS', estado: 'nuevo', canal: 'foliotest', total: 100 }, A);
  assert.deepStrictEqual(r, { ok: true, insertado: true, conflicto: false });
  assert.strictEqual(await contarFolio('FOLIOTEST-INS'), 1);
});
await t('CONTRATO', 'conflicto directo: insertado=false, conflicto=true y NO devuelve éxito de inserción', async () => {
  const r = await guardarPedidoActivo({ id: 'FOLIOTEST-INS', estado: 'nuevo', canal: 'foliotest', total: 999 }, A);
  assert.deepStrictEqual(r, { ok: true, insertado: false, conflicto: true });
  assert.strictEqual(r.insertado, false, 'el bug original devolvía true aquí');
  assert.strictEqual(await contarFolio('FOLIOTEST-INS'), 1);
  const fila = await filaDe('FOLIOTEST-INS');
  assert.strictEqual(Number(fila.datos.total), 100, 'la fila original no se sobrescribe');
});
await t('CONTRATO', 'dos tenants con el MISMO folio: el segundo no escribe y la fila sigue siendo del primero', async () => {
  const primero = await guardarPedidoActivo({ id: 'FOLIOTEST-TENANT', estado: 'nuevo', canal: 'foliotest', total: 100 }, A);
  const segundo = await guardarPedidoActivo({ id: 'FOLIOTEST-TENANT', estado: 'nuevo', canal: 'foliotest-b', total: 999 }, B);
  assert.strictEqual(primero.insertado, true);
  assert.strictEqual(segundo.insertado, false, 'reproducción del incidente: antes devolvía true');
  assert.strictEqual(segundo.conflicto, true);
  const fila = await filaDe('FOLIOTEST-TENANT');
  assert.strictEqual(fila.negocio_id, A, 'la fila jamás cambia de negocio');
  assert.strictEqual(fila.datos.canal, 'foliotest');
  assert.strictEqual(await contarFolio('FOLIOTEST-TENANT'), 1);
});
await t('CONTRATO', 'error SQL real: ok=false y conflicto=false (nunca se confunde con un folio ocupado)', async () => {
  const r = await guardarPedidoActivo({ id: null, estado: 'nuevo' }, A); // folio es PK NOT NULL
  assert.deepStrictEqual(r, { ok: false, insertado: false, conflicto: false });
});

// ═════════ Dos instancias con el MISMO contador inicial ═════════
// El servidor hijo arranca primero y fija su contador desde la base; esta
// instancia carga el suyo justo después → ambos apuntan al mismo folio.
const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;
await cargarPedidosDesdeDB();

// ═════════ 5-9) registrarPedido: reserva, conflicto y contador ═════════
let folio1 = null;
await t('REGISTRAR', 'persiste de verdad: folio XAB-, fila con el negocio y canal correctos', async () => {
  const p = await registrarPedido(ordenBase(A), 'foliotest');
  folio1 = p.id;
  assert.match(p.id, /^XAB-\d{4,}$/);
  const fila = await filaDe(p.id);
  assert.ok(fila, 'debe existir la fila antes de que registrarPedido devuelva');
  assert.strictEqual(fila.negocio_id, A);
  assert.strictEqual(fila.datos.canal, 'foliotest');
  assert.strictEqual(fila.estado, 'nuevo');
});
await t('REGISTRAR', 'el contador avanza: el siguiente pedido toma el folio consecutivo', async () => {
  const p = await registrarPedido(ordenBase(A), 'foliotest');
  assert.strictEqual(p.id, siguienteFolio(folio1), `esperaba ${siguienteFolio(folio1)}, dio ${p.id}`);
  folio1 = p.id;
});
await t('REGISTRAR', 'conflicto: si el siguiente folio ya es de OTRO negocio, se reintenta con el siguiente (no se adopta la fila ajena)', async () => {
  const ocupado = siguienteFolio(folio1);
  const r = await guardarPedidoActivo({ id: ocupado, estado: 'nuevo', canal: 'otra-instancia', total: 777 }, B);
  assert.strictEqual(r.insertado, true, 'precondición: la otra instancia ganó ese folio');

  const p = await registrarPedido(ordenBase(A), 'foliotest');
  assert.notStrictEqual(p.id, ocupado, 'jamás debe devolver un folio cuya fila es de otro pedido');
  assert.strictEqual(p.id, siguienteFolio(ocupado), 'el conflicto consume ese número y usa el siguiente');
  const ajena = await filaDe(ocupado);
  assert.strictEqual(ajena.negocio_id, B, 'la fila ajena queda intacta');
  assert.strictEqual(Number(ajena.datos.total), 777);
  const propia = await filaDe(p.id);
  assert.strictEqual(propia.negocio_id, A);
  folio1 = p.id;
});
await t('REGISTRAR', 'un folio en conflicto no se reutiliza después (el contador no retrocede)', async () => {
  const p = await registrarPedido(ordenBase(A), 'foliotest');
  assert.strictEqual(p.id, siguienteFolio(folio1));
  folio1 = p.id;
});
await t('REGISTRAR', 'agotar el tope de reintentos falla con FOLIO_NO_DISPONIBLE, sin confirmar nada', async () => {
  const ocupados = [];
  for (let i = 1; i <= 20; i++) ocupados.push(siguienteFolio(folio1, i));
  for (const f of ocupados) await guardarPedidoActivo({ id: f, estado: 'nuevo', canal: 'otra-instancia', total: 1 }, B);

  const antesMem = obtenerPedidos(A).length;
  await assert.rejects(() => registrarPedido(ordenBase(A), 'foliotest'), /FOLIO_NO_DISPONIBLE/);
  assert.strictEqual(obtenerPedidos(A).length, antesMem, 'un pedido fallido nunca entra a memoria');
  for (const f of ocupados) {
    const fila = await filaDe(f);
    assert.strictEqual(fila.negocio_id, B, `la fila ajena ${f} no fue tocada`);
  }
  // El contador quedó más allá de los 20 intentos: la siguiente creación
  // funciona sin intervención manual.
  const p = await registrarPedido(ordenBase(A), 'foliotest');
  assert.strictEqual(p.id, siguienteFolio(folio1, 21));
  folio1 = p.id;
});
await t('REGISTRAR', 'un error real de base de datos NO entra al reintento: un solo intento y PEDIDO_NO_PERSISTIDO', async () => {
  const origQuery = pool.query.bind(pool);
  let intentos = 0;
  pool.query = async (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('INSERT INTO pedidos_activos')) {
      intentos++;
      throw new Error('conexión simulada caída');
    }
    return origQuery(...args);
  };
  try {
    const antesMem = obtenerPedidos(A).length;
    await assert.rejects(() => registrarPedido(ordenBase(A), 'foliotest'), /PEDIDO_NO_PERSISTIDO/);
    assert.strictEqual(intentos, 1, 'un error SQL no debe reintentarse con otro folio');
    assert.strictEqual(obtenerPedidos(A).length, antesMem);
  } finally {
    pool.query = origQuery;
  }
});

// ═════════ 10-13) Concurrencia real ═════════
await t('CONCURRENCIA', '20 creaciones simultáneas → 20 pedidos persistidos con folios únicos', async () => {
  const res = await Promise.all(Array.from({ length: 20 }, () => registrarPedido(ordenBase(A), 'foliotest')));
  const folios = res.map(p => p.id);
  assert.strictEqual(new Set(folios).size, 20, 'ningún folio repetido');
  const { rows } = await pool.query(`SELECT folio, negocio_id FROM pedidos_activos WHERE folio = ANY($1)`, [folios]);
  assert.strictEqual(rows.length, 20, 'las 20 filas deben existir (el bug perdía la mitad en silencio)');
  assert.ok(rows.every(r => r.negocio_id === A), 'todas con el negocio correcto');
});
await t('CONCURRENCIA', '100 creaciones simultáneas → 100 filas reales, sin pérdidas silenciosas', async () => {
  const res = await Promise.all(Array.from({ length: 100 }, () => registrarPedido(ordenBase(A), 'foliotest')));
  const folios = res.map(p => p.id);
  assert.strictEqual(new Set(folios).size, 100);
  const { rows } = await pool.query(`SELECT COUNT(*)::int c FROM pedidos_activos WHERE folio = ANY($1)`, [folios]);
  assert.strictEqual(rows[0].c, 100);
});
await t('CONCURRENCIA', 'dos negocios en paralelo: cada fila conserva su propio tenant', async () => {
  const mezcla = Array.from({ length: 30 }, (_, i) => registrarPedido(ordenBase(i % 2 ? B : A), i % 2 ? 'foliotest-b' : 'foliotest'));
  const res = await Promise.all(mezcla);
  const esperado = new Map(res.map((p, i) => [p.id, i % 2 ? B : A]));
  assert.strictEqual(esperado.size, 30, 'folios únicos entre negocios');
  const { rows } = await pool.query(`SELECT folio, negocio_id FROM pedidos_activos WHERE folio = ANY($1)`, [[...esperado.keys()]]);
  assert.strictEqual(rows.length, 30);
  for (const r of rows) assert.strictEqual(r.negocio_id, esperado.get(r.folio), `folio ${r.folio} quedó en el negocio equivocado`);
});
await t('CONCURRENCIA', 'multi-instancia: la otra réplica gana varios folios y esta reintenta hasta persistir los suyos', async () => {
  const { rows: [{ max }] } = await pool.query(`SELECT COALESCE(MAX(CAST(SUBSTRING(folio FROM '^XAB-([0-9]+)$') AS INTEGER)),0) max FROM pedidos_activos WHERE folio ~ '^XAB-[0-9]+$'`);
  const ajenos = [];
  for (let i = 1; i <= 5; i++) ajenos.push(`XAB-${String(max + i).padStart(4, '0')}`);
  for (const f of ajenos) await guardarPedidoActivo({ id: f, estado: 'nuevo', canal: 'otra-instancia', total: 5 }, B);

  const res = await Promise.all(Array.from({ length: 5 }, () => registrarPedido(ordenBase(A), 'foliotest')));
  const folios = res.map(p => p.id);
  assert.strictEqual(new Set(folios).size, 5);
  for (const f of folios) assert.ok(!ajenos.includes(f), `no debe devolver ${f}, ya era de la otra instancia`);
  const { rows } = await pool.query(`SELECT folio, negocio_id FROM pedidos_activos WHERE folio = ANY($1)`, [folios]);
  assert.strictEqual(rows.length, 5);
  assert.ok(rows.every(r => r.negocio_id === A));
  for (const f of ajenos) assert.strictEqual((await filaDe(f)).negocio_id, B, 'las filas de la otra instancia quedan intactas');
});

// ═════════ 14-17) Llamadores idempotentes y canales ═════════
await t('LLAMADORES', 'WhatsApp: el re-guardado defensivo del MISMO pedido es un conflicto esperado, no duplica ni sobrescribe', async () => {
  const p = await registrarPedido(ordenBase(A, { cliente: { nombre: 'Cliente WA', telefono: '8781110001' } }), 'whatsapp');
  const r = await guardarPedidoActivo(p, A); // exactamente lo que hace whatsapp-meta.js
  assert.strictEqual(r.ok, true, 'nunca es un error');
  assert.strictEqual(r.insertado, false);
  assert.strictEqual(r.conflicto, true);
  assert.strictEqual(await contarFolio(p.id), 1);
  assert.strictEqual((await filaDe(p.id)).datos.cliente.nombre, 'Cliente WA');
});
await t('LLAMADORES', 'Scheduler: reinsertar un pedido programado con folio propio inserta una vez y luego es no-op', async () => {
  const pedido = { id: 'FOLIOTEST-PROG', estado: 'nuevo', canal: 'programado-test', negocioId: A, total: 120 };
  const primera = await guardarPedidoActivo(pedido, A);
  const segunda = await guardarPedidoActivo(pedido, A);
  assert.strictEqual(primera.insertado, true);
  assert.strictEqual(segunda.insertado, false);
  assert.strictEqual(segunda.ok, true, 'el scheduler ignora el retorno y no debe romperse');
  assert.strictEqual(await contarFolio('FOLIOTEST-PROG'), 1);
});
await t('LLAMADORES', 'Rappi y otros canales usan el mismo camino corregido', async () => {
  const p = await registrarPedido(ordenBase(A, { cliente: { nombre: 'Cliente Rappi', telefono: '8781110002' } }), 'rappi');
  const fila = await filaDe(p.id);
  assert.ok(fila, 'la fila existe antes de devolver el pedido');
  assert.strictEqual(fila.datos.canal, 'rappi');
  assert.strictEqual(fila.negocio_id, A);
});
await t('LLAMADORES', 'Restaurante (RM-): folio determinista propio, sin pasar por guardarPedidoActivo ni por el contador', async () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'services', 'restauranteService.js'), 'utf8');
  assert.ok(!/guardarPedidoActivo/.test(src), 'restauranteService no usa la función corregida');
  assert.ok(/ON CONFLICT \(folio\) DO NOTHING/.test(src), 'conserva su propia idempotencia por folio determinista');
  const { rows } = await pool.query(`SELECT COUNT(*)::int c FROM pedidos_activos WHERE folio LIKE 'RM-%'`);
  assert.ok(rows[0].c >= 0);
});

// ═════════ 18-21) POS por HTTP (la otra instancia, con su propio contador) ═════════
const adminA = SEED.adminNegocioAUsuarioId;
const cookieAdminA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: adminA, negocioId: A, rol: 'admin' }))}`;
await pool.query(`DELETE FROM menu_categorias WHERE nombre = 'Cat prueba Folio' AND negocio_id = $1`, [A]);
const { rows: [catFolio] } = await pool.query(
  `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'Cat prueba Folio',TRUE,0) RETURNING id`, [A]);
const { rows: [prodFolio] } = await pool.query(
  `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, descripcion, precio, disponible, orden)
   VALUES ($1,$2,$3,'Producto Folio','',100,TRUE,0) RETURNING id`, [A, catFolio.id, 'PF' + Math.floor(Math.random() * 1e9).toString(36)]);
const cuerpoPOS = () => ({ tipo: 'recoger', cliente: { nombre: 'Cliente POS Folio', telefono: '8781110003' }, items: [{ producto_id: prodFolio.id, cantidad: 1 }], formaPago: 'efectivo' });

await t('POS', '20 pedidos POS simultáneos (instancia con contador atrasado) → 20 folios únicos persistidos', async () => {
  const res = await Promise.all(Array.from({ length: 20 }, () => api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method: 'POST', body: cuerpoPOS() })));
  assert.ok(res.every(r => r.status === 200), `todas deben responder 200: ${JSON.stringify(res.find(r => r.status !== 200)?.body)}`);
  const folios = res.map(r => r.body.pedido.id);
  assert.strictEqual(new Set(folios).size, 20, 'ningún folio repetido entre instancias');
  const { rows } = await pool.query(`SELECT folio, negocio_id FROM pedidos_activos WHERE folio = ANY($1)`, [folios]);
  assert.strictEqual(rows.length, 20);
  assert.ok(rows.every(r => r.negocio_id === A));
});
await t('POS', 'la idempotencia por Idempotency-Key sigue intacta (doble clic = un solo pedido)', async () => {
  const key = 'folio-' + Date.now();
  const cuerpo = cuerpoPOS();
  const [r1, r2] = await Promise.all([
    api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method: 'POST', headers: { 'Idempotency-Key': key }, body: cuerpo }),
    api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method: 'POST', headers: { 'Idempotency-Key': key }, body: cuerpo }),
  ]);
  assert.strictEqual(r1.status, 200); assert.strictEqual(r2.status, 200);
  assert.strictEqual(r1.body.pedido.id, r2.body.pedido.id, 'el mismo key devuelve el mismo folio');
  assert.strictEqual(await contarFolio(r1.body.pedido.id), 1);
});
await t('POS', 'si la creación falla, la clave se libera y un reintento con el mismo key sí crea el pedido', async () => {
  const key = 'folio-fallo-' + Date.now();
  const invalido = { ...cuerpoPOS(), cliente: { telefono: '8781110003' } }; // sin nombre → 400
  const malo = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method: 'POST', headers: { 'Idempotency-Key': key }, body: invalido });
  assert.strictEqual(malo.status, 400);
  const bueno = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method: 'POST', headers: { 'Idempotency-Key': key }, body: cuerpoPOS() });
  assert.strictEqual(bueno.status, 200, 'una clave sin pedido real no debe bloquear el reintento');
  assert.ok(await filaDe(bueno.body.pedido.id));
});
await t('POS', 'un folio confirmado por la API siempre tiene fila: nunca se confirma un pedido no persistido', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method: 'POST', body: cuerpoPOS() });
  assert.strictEqual(r.status, 200);
  const fila = await filaDe(r.body.pedido.id);
  assert.ok(fila, 'la comanda/pago/repartidor solo pueden existir sobre una fila real');
  assert.strictEqual(fila.negocio_id, A);
  const detalle = await api(base, `/api/pos/envios/${r.body.pedido.id}`, { cookie: cookieAdminA });
  assert.ok([200, 404].includes(detalle.status), 'el detalle responde sobre el folio confirmado');
});
await t('POS', 'ningún folio de esta suite quedó duplicado en pedidos_activos', async () => {
  const { rows } = await pool.query(`SELECT folio, COUNT(*)::int c FROM pedidos_activos GROUP BY folio HAVING COUNT(*) > 1`);
  assert.strictEqual(rows.length, 0, `folios duplicados: ${rows.map(r => r.folio).join(', ')}`);
});

// ── Limpieza final (deja la base como estaba para el resto de la batería) ──
await pool.query(`DELETE FROM menu_categorias WHERE nombre = 'Cat prueba Folio' AND negocio_id = $1`, [A]);
await limpiar();

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
