// POS — Envíos / Pedidos a domicilio. Verifica que el POS reutilice el MISMO
// motor (registrarPedido/emitirPedido → folio/comanda), recalcule precios
// desde el menú del propio negocio, valide multi-tenant estricto (un producto
// de otro negocio se rechaza; un folio ajeno da 404), no duplique enlaces de
// pago, y sea idempotente ante doble clic.
//
// Fixtures propios ("Producto de prueba A/B") — NUNCA el fixture hardcodeado
// de /test/pedido (que usa el menú de Nonna y confundió a Carnitas Moreno).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4940';

const { pool, crearUsuarioConPassword } = await import('../src/services/database.js');
const { guardarIntegracionPago, marcarProveedorPrincipal } = await import('../src/services/integracionesService.js');
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
async function crearProducto(negocioId, nombre, precio) {
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,0) RETURNING id`, [negocioId, 'Cat prueba POS']);
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, descripcion, precio, disponible, orden)
     VALUES ($1,$2,$3,$4,'',$5,TRUE,0) RETURNING id`, [negocioId, cat.id, 'P'+Math.floor(Math.random()*1e9).toString(36), nombre, precio]);
  return p.id;
}

const A = SEED.negocioA, B = SEED.negocioB;
for (const n of [A, B]) { await fijarModulo(n, 'pos'); await fijarModulo(n, 'menu'); await fijarModulo(n, 'repartidores'); }

// Limpieza re-ejecutable
await pool.query(`DELETE FROM menu_categorias WHERE nombre = 'Cat prueba POS' AND negocio_id = ANY($1)`, [[A, B]]);

const prodA = await crearProducto(A, 'Producto de prueba A', 100);
const prodA2 = await crearProducto(A, 'Producto de prueba A2', 50);
const prodB = await crearProducto(B, 'Producto de prueba B', 200);

// manual_transfer como proveedor principal de A → enlace-pago devuelve una
// referencia sin llamar a Clip real (mismo patrón que fase-pagos).
await guardarIntegracionPago(A, 'manual_transfer', { titular: 'Negocio A POS', banco: 'BBVA', clabe: '012345678901234567' }, { actualizadoPor: SEED.superadminUsuarioId }).catch(()=>{});
await marcarProveedorPrincipal(A, 'manual_transfer', SEED.superadminUsuarioId).catch(e=>console.log('principal:', e.message));

const adminB = await crearUsuarioConPassword({ negocioId: B, nombre: 'Admin POS B', email: `admin-pos-b-${Date.now()}@test.local`, password: 'ClaveAdminPosB123!', rol: 'admin' })
  .catch(async () => (await pool.query(`SELECT id FROM usuarios WHERE negocio_id=$1 AND rol='admin' LIMIT 1`, [B])).rows[0]);
const staffA = await crearUsuarioConPassword({ negocioId: A, nombre: 'Staff POS A', email: `staff-pos-a-${Date.now()}@test.local`, password: 'ClaveStaffPosA123!', rol: 'staff' })
  .catch(async () => (await pool.query(`SELECT id FROM usuarios WHERE negocio_id=$1 AND rol='staff' LIMIT 1`, [A])).rows[0]);

const cookieAdminA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: A, rol: 'admin' }))}`;
const cookieAdminB = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: adminB.id, negocioId: B, rol: 'admin' }))}`;
const cookieStaffA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: staffA.id, negocioId: A, rol: 'staff' }))}`;

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;

const CLIENTE = { nombre: 'Cliente POS', telefono: '8781234500' };
const DIRECCION = { calle: 'Av. Reforma', numero_exterior: '123', colonia: 'Centro', entre_calles: 'A y B', referencia: 'Portón azul' };
function itemsA(){ return [{ producto_id: prodA, cantidad: 2 }]; } // 2 x 100 = 200

// ═══════════ 1-2) Crear recoger / domicilio con el mismo motor ═══════════
let folioDomicilio = null;
await t('CREAR', 'domicilio: registra pedido (canal=pos), folio XAB-, total = subtotal + envío', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method:'POST', body: {
    tipo:'domicilio', cliente: CLIENTE, direccion: DIRECCION, items: itemsA(), costoEnvio: 40, formaPago:'efectivo' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const p = r.body.pedido;
  assert.match(p.id, /^XAB-\d+$/);
  assert.strictEqual(p.canal, 'pos');
  assert.strictEqual(p.total, 240); // 200 + 40 envío
  assert.strictEqual(p.modalidad, 'entrega a domicilio');
  assert.strictEqual(p.cliente.calle, 'Av. Reforma');
  assert.strictEqual(p.cliente.colonia, 'Centro');
  folioDomicilio = p.id;
});
await t('CREAR', 'recoger: sin envío, modalidad recoger en tienda', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method:'POST', body: {
    tipo:'recoger', cliente: CLIENTE, items: itemsA(), formaPago:'efectivo' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.pedido.total, 200);
  assert.strictEqual(r.body.pedido.costo_envio, 0);
  assert.strictEqual(r.body.pedido.modalidad, 'recoger en tienda');
});

// ═══════════ 3-7) Validaciones ═══════════
await t('VALIDA', 'nombre requerido', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method:'POST', body: { tipo:'recoger', cliente:{ telefono:'8781234500' }, items: itemsA() } });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.codigo, 'NOMBRE_REQUERIDO');
});
await t('VALIDA', 'teléfono inválido', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method:'POST', body: { tipo:'recoger', cliente:{ nombre:'X', telefono:'123' }, items: itemsA() } });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.codigo, 'TELEFONO_INVALIDO');
});
await t('VALIDA', 'teléfono se normaliza a 10 dígitos', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method:'POST', body: { tipo:'recoger', cliente:{ nombre:'X', telefono:'+52 878 123 4599' }, items: itemsA() } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.pedido.cliente.telefono, '8781234599');
});
await t('VALIDA', 'domicilio sin calle → CALLE_REQUERIDA; sin colonia → COLONIA_REQUERIDA', async () => {
  const sinCalle = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method:'POST', body: { tipo:'domicilio', cliente: CLIENTE, direccion:{ colonia:'Centro' }, items: itemsA() } });
  assert.strictEqual(sinCalle.body.codigo, 'CALLE_REQUERIDA');
  const sinCol = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method:'POST', body: { tipo:'domicilio', cliente: CLIENTE, direccion:{ calle:'X' }, items: itemsA() } });
  assert.strictEqual(sinCol.body.codigo, 'COLONIA_REQUERIDA');
});

// ═══════════ 8-11) Productos, tenant, recálculo ═══════════
await t('PRODUCTO', 'producto de OTRO negocio → 400 PRODUCTO_AJENO (no se filtra silenciosamente)', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method:'POST', body: { tipo:'recoger', cliente: CLIENTE, items:[{ producto_id: prodB, cantidad:1 }] } });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.codigo, 'PRODUCTO_AJENO');
});
await t('PRECIO', 'el backend IGNORA el precio del frontend y recalcula desde el menú', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method:'POST', body: {
    tipo:'recoger', cliente: CLIENTE, items:[{ producto_id: prodA, cantidad:1, precio_unitario: 1 }] } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.pedido.total, 100); // precio real 100, no el 1 enviado
});
await t('TOTAL', 'multi-producto: total correcto (2x100 + 1x50 + envío 30 = 280)', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method:'POST', body: {
    tipo:'domicilio', cliente: CLIENTE, direccion: DIRECCION, costoEnvio: 30,
    items:[{ producto_id: prodA, cantidad:2 }, { producto_id: prodA2, cantidad:1 }] } });
  assert.strictEqual(r.body.pedido.total, 280);
});

// ═══════════ 15-17) Enlace de pago sin duplicados ═══════════
await t('PAGO', 'enlace de pago: primera vez reutilizado=false; segunda vez reutilizado=true (no duplica checkout)', async () => {
  const p1 = await api(base, `/api/pos/envios/${folioDomicilio}/enlace-pago`, { cookie: cookieAdminA, method:'POST' });
  assert.strictEqual(p1.status, 200, JSON.stringify(p1.body));
  assert.strictEqual(p1.body.reutilizado, false);
  const p2 = await api(base, `/api/pos/envios/${folioDomicilio}/enlace-pago`, { cookie: cookieAdminA, method:'POST' });
  assert.strictEqual(p2.status, 200);
  assert.strictEqual(p2.body.reutilizado, true, 'un segundo intento debe REUTILIZAR el enlace, no crear otro');
  // Un solo pago vigente en BD para ese pedido.
  const { rows } = await pool.query(`SELECT COUNT(*) c FROM pagos WHERE pedido_folio=$1 AND negocio_id=$2 AND estado IN ('pendiente','requiere_revision')`, [folioDomicilio, A]);
  assert.strictEqual(Number(rows[0].c), 1, 'nunca debe haber dos enlaces vigentes para el mismo pedido');
});

// ═══════════ 18-20) Comanda / canal / folio ═══════════
await t('MOTOR', 'el pedido POS existe en pedidos_activos con negocio_id correcto y canal pos', async () => {
  const { rows } = await pool.query(`SELECT negocio_id, datos->>'canal' AS canal FROM pedidos_activos WHERE folio=$1`, [folioDomicilio]);
  assert.strictEqual(rows[0].negocio_id, A);
  assert.strictEqual(rows[0].canal, 'pos');
});

// ═══════════ 28-31) Multi-tenant en listado / detalle ═══════════
await t('TENANT', 'GET /envios de A no incluye pedidos de B y viceversa', async () => {
  // Crear uno en B
  const rb = await api(base, '/api/pos/pedidos', { cookie: cookieAdminB, method:'POST', body: { tipo:'domicilio', cliente: CLIENTE, direccion: DIRECCION, items:[{ producto_id: prodB, cantidad:1 }], costoEnvio: 10 } });
  assert.strictEqual(rb.status, 200);
  const folioB = rb.body.pedido.id;
  const listaA = await api(base, '/api/pos/envios', { cookie: cookieAdminA });
  const listaB = await api(base, '/api/pos/envios', { cookie: cookieAdminB });
  assert.ok(!listaA.body.envios.some(e => e.folio === folioB), 'A no debe ver el envío de B');
  assert.ok(!listaB.body.envios.some(e => e.folio === folioDomicilio), 'B no debe ver el envío de A');
});
await t('TENANT', 'detalle de un folio ajeno → 404 (no 403 que revelaría existencia)', async () => {
  const r = await api(base, `/api/pos/envios/${folioDomicilio}`, { cookie: cookieAdminB });
  assert.strictEqual(r.status, 404);
});
await t('TENANT', 'enlace de pago sobre folio ajeno → 404', async () => {
  const r = await api(base, `/api/pos/envios/${folioDomicilio}/enlace-pago`, { cookie: cookieAdminB, method:'POST' });
  assert.strictEqual(r.status, 404);
});

// ═══════════ Seguridad de sesión ═══════════
await t('SEGURIDAD', 'sin sesión → 401 en crear/listar', async () => {
  const c = await api(base, '/api/pos/pedidos', { method:'POST', body:{ tipo:'recoger', cliente: CLIENTE, items: itemsA() } });
  assert.ok([401,403].includes(c.status));
  const l = await api(base, '/api/pos/envios', {});
  assert.ok([401,403].includes(l.status));
});

// ═══════════ 34) Idempotencia ═══════════
await t('IDEMPOTENCIA', 'mismo Idempotency-Key (doble clic) devuelve el MISMO folio, no crea dos pedidos', async () => {
  const key = 'pos-test-' + Date.now();
  const body = { tipo:'recoger', cliente: CLIENTE, items: itemsA() };
  const [r1, r2] = await Promise.all([
    api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method:'POST', headers:{ 'Idempotency-Key': key }, body }),
    api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method:'POST', headers:{ 'Idempotency-Key': key }, body }),
  ]);
  assert.strictEqual(r1.status, 200); assert.strictEqual(r2.status, 200);
  assert.strictEqual(r1.body.pedido.id, r2.body.pedido.id, 'el doble clic debe devolver el mismo folio');
});

// ═══════════ 35-37) Cancelación ═══════════
await t('CANCELAR', 'cancelar requiere motivo y admin; conserva la fila (no borra)', async () => {
  const crear = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method:'POST', body: { tipo:'domicilio', cliente: CLIENTE, direccion: DIRECCION, items: itemsA(), costoEnvio: 10 } });
  const folio = crear.body.pedido.id;
  const sinMotivo = await api(base, `/api/pos/envios/${folio}/cancelar`, { cookie: cookieAdminA, method:'POST', body:{} });
  assert.strictEqual(sinMotivo.status, 400);
  const ok = await api(base, `/api/pos/envios/${folio}/cancelar`, { cookie: cookieAdminA, method:'POST', body:{ motivo:'prueba' } });
  assert.strictEqual(ok.status, 200);
  const { rows } = await pool.query(`SELECT estado FROM pedidos_activos WHERE folio=$1`, [folio]);
  assert.strictEqual(rows[0].estado, 'cancelado', 'se conserva la fila, marcada cancelado (no DELETE)');
});
await t('PERMISOS', 'un staff (no admin) NO puede solicitar repartidor ni cancelar', async () => {
  const sol = await api(base, `/api/pos/envios/${folioDomicilio}/solicitar-repartidor`, { cookie: cookieStaffA, method:'POST' });
  assert.ok([401,403].includes(sol.status), `staff no debe solicitar repartidor, dio ${sol.status}`);
  const can = await api(base, `/api/pos/envios/${folioDomicilio}/cancelar`, { cookie: cookieStaffA, method:'POST', body:{ motivo:'x' } });
  assert.ok([401,403].includes(can.status));
});

// ═══════════ 38-42) Notas de ENTREGA a nivel PEDIDO ═══════════
// Regresión de un bug SILENCIOSO: el backend siempre soportó `notas` (se
// desestructura en POST /api/pos/pedidos y construirOrdenPOS la persiste),
// pero envCrearPedido armaba el body SIN ella — y aun así limpiaba
// #env-notas-entrega al terminar. El operador tecleaba "dejar en portón",
// veía el campo vacío y daba por hecho que se había guardado. Nunca llegaba
// al repartidor. Por eso aquí se cubren LOS DOS lados: que el backend las
// persista (contrato) y que el panel realmente las MANDE (la causa raíz —
// un test solo de backend habría pasado también con el bug presente).
//
// OJO: son las notas del PEDIDO/entrega, no las notas POR LÍNEA del carrito
// (ENV_CARRITO[i].notas → item.notas), que viajan dentro de cada item.
const PANEL = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');
const ENV_CREAR = PANEL.slice(
  PANEL.indexOf('async function envCrearPedido()'),
  PANEL.indexOf('async function cargarEnviosActivos()'));

await t('FRONTEND', 'el campo no puede exceder los 500 que guarda construirOrdenPOS', async () => {
  assert.match(PANEL, /<input id="env-notas-entrega"[^>]*maxlength="500"/,
    'sin maxlength el backend recorta a 500 en silencio');
});

// Ejecuta el envCrearPedido REAL —el mismo texto que se despacha en el panel—
// con los globales inyectados. No es un regex sobre la fuente: es la función
// corriendo, y lo que se afirma es el BODY que sale hacia la red. Así queda
// demostrado (no supuesto) que en domicilio las notas viajan y en recoger no.
function ejecutarEnvCrear({ tipo, notasTecleadas }) {
  const campos = {
    'env-nombre': 'Ana Domicilio', 'env-telefono': '8781234500',
    'env-calle': 'Av. Reforma', 'env-numext': '123', 'env-numint': '',
    'env-colonia': 'Centro', 'env-entrecalles': 'A y B', 'env-referencia': 'Portón azul',
    'env-notas-entrega': notasTecleadas,
    'env-metodo-pago': 'efectivo', 'env-costo-envio': '35',
  };
  const doc = { getElementById: (id) => ({
    get value() { return campos[id] ?? ''; },
    set value(v) { campos[id] = v; },
    style: {}, textContent: '', disabled: false,
  }) };
  let enviado = null;
  const apiFetchFalso = async (_ruta, opciones) => {
    enviado = JSON.parse(opciones.body);
    return { ok: true, json: async () => ({ pedido: { id: 'XAB-0001' } }) };
  };
  const nada = () => {};
  const crear = new Function('document', 'apiFetch', 'alert', 'envRenderCarrito', 'envSub', 'TIPO',
    'let ENV_TIPO = TIPO;' +
    'let ENV_CARRITO = [{ producto_id: 1, nombre: "P", precio: 100, cantidad: 1 }];' +
    ENV_CREAR + ' ; return envCrearPedido;'
  )(doc, apiFetchFalso, nada, nada, nada, tipo);
  return crear().then(() => enviado);
}

await t('FRONTEND', 'DOMICILIO: lo tecleado en #env-notas-entrega sale en body.notas', async () => {
  const body = await ejecutarEnvCrear({ tipo: 'domicilio', notasTecleadas: 'Dejar en portón, no tocar timbre' });
  assert.strictEqual(body.notas, 'Dejar en portón, no tocar timbre');
  assert.strictEqual(body.tipo, 'domicilio');
});

await t('FRONTEND', 'RECOGER: el campo está OCULTO, así que su texto NO se cuela en el pedido', async () => {
  // El operador pudo teclear notas en domicilio y luego cambiar a recoger: el
  // input sigue poblado pero invisible. Un campo que no se ve no debe viajar.
  const body = await ejecutarEnvCrear({ tipo: 'recoger', notasTecleadas: 'Dejar en portón, no tocar timbre' });
  assert.ok(!('notas' in body), 'recoger no debe mandar notas de entrega; mandó: ' + JSON.stringify(body.notas));
  assert.ok(!('direccion' in body), 'mismo criterio que direccion, que ya era así');
});

await t('FRONTEND', 'sólo espacios: no se manda una nota en blanco', async () => {
  const body = await ejecutarEnvCrear({ tipo: 'domicilio', notasTecleadas: '     ' });
  assert.ok(!('notas' in body), 'una nota de puros espacios no aporta nada al repartidor');
});

await t('FRONTEND', 'la nota del PEDIDO no se copia dentro de los items', async () => {
  const body = await ejecutarEnvCrear({ tipo: 'domicilio', notasTecleadas: 'Portón azul' });
  for (const it of body.items || []) {
    assert.notStrictEqual(it.notas, 'Portón azul', 'entrega != preparación: son campos distintos');
  }
});

let folioNotas = null;
const NOTA = 'Dejar en portón azul, no tocar timbre (perro)';
await t('NOTAS', 'domicilio con notas: sobreviven hasta pedidos_activos.datos', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method:'POST', body: {
    tipo:'domicilio', cliente: CLIENTE, direccion: DIRECCION, items: itemsA(), costoEnvio: 20,
    formaPago:'efectivo', notas: NOTA } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.pedido.notas, NOTA, 'la respuesta ya debe traerlas');
  folioNotas = r.body.pedido.id;
  const { rows } = await pool.query(`SELECT datos->>'notas' AS notas FROM pedidos_activos WHERE folio=$1`, [folioNotas]);
  assert.strictEqual(rows[0].notas, NOTA, 'deben quedar persistidas en pedidos_activos.datos');
});

await t('NOTAS', 'las notas del PEDIDO no se mezclan con las notas por LÍNEA del item', async () => {
  const { rows } = await pool.query(`SELECT datos FROM pedidos_activos WHERE folio=$1`, [folioNotas]);
  const d = rows[0].datos;
  assert.strictEqual(d.notas, NOTA);
  for (const it of d.items || []) {
    assert.notStrictEqual(it.notas, NOTA, 'la nota de entrega jamás debe copiarse a un item');
  }
});

await t('NOTAS', 'sin notas: queda null (no cadena vacía ni "undefined")', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method:'POST', body: {
    tipo:'domicilio', cliente: CLIENTE, direccion: DIRECCION, items: itemsA(), costoEnvio: 20, formaPago:'efectivo' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.pedido.notas, null);
  const { rows } = await pool.query(`SELECT datos->>'notas' AS notas FROM pedidos_activos WHERE folio=$1`, [r.body.pedido.id]);
  assert.strictEqual(rows[0].notas, null);
});

await t('NOTAS', 'un texto larguísimo se recorta a 500 (no revienta el insert)', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method:'POST', body: {
    tipo:'domicilio', cliente: CLIENTE, direccion: DIRECCION, items: itemsA(), costoEnvio: 20,
    formaPago:'efectivo', notas: 'x'.repeat(900) } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.pedido.notas.length, 500);
});

// ═══════════ 43) La cadena COMPLETA: del POS al repartidor ═══════════
// El único destino donde estas notas se VEN es el portal del repartidor
// (panel/repartidor.html). La comanda de cocina imprime item.notas, no las
// del pedido — a propósito: son indicaciones de ENTREGA. Esta prueba recorre
// el camino real de punta a punta (POS crea → repartidor acepta → las lee)
// con folio de la secuencia durable, así que es re-ejecutable.
const TEL_REP = '5218782200077';
await pool.query(`DELETE FROM notificaciones_repartidor WHERE repartidor_id IN (SELECT id FROM repartidores WHERE telefono = $1)`, [TEL_REP]).catch(()=>{});
await pool.query(`DELETE FROM repartidores WHERE telefono = $1`, [TEL_REP]);

await t('E2E', 'las notas del POS llegan al portal del repartidor que entrega', async () => {
  const { rows: [neg] } = await pool.query(`SELECT slug FROM negocios WHERE id = $1`, [A]);
  const alta = await api(base, '/api/repartidor/registro', { method:'POST', body: { nombre:'Rep Notas POS', telefono: TEL_REP, negocioSlug: neg.slug } });
  assert.strictEqual(alta.status, 200, JSON.stringify(alta.body));
  const tok = { 'x-rep-token': alta.body.token };

  const NOTA_E2E = 'Edificio B, timbre descompuesto: marcar al llegar';
  const crear = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method:'POST', body: {
    tipo:'domicilio', cliente: CLIENTE, direccion: DIRECCION, items: itemsA(), costoEnvio: 35,
    formaPago:'efectivo', notas: NOTA_E2E } });
  assert.strictEqual(crear.status, 200, JSON.stringify(crear.body));
  const folio = crear.body.pedido.id;

  const acc = await api(base, `/api/repartidor/pedido/${folio}/aceptar`, { method:'POST', headers: tok });
  assert.strictEqual(acc.status, 200, JSON.stringify(acc.body));

  const actual = await api(base, '/api/repartidor/pedido-actual', { headers: tok });
  assert.strictEqual(actual.status, 200);
  const mio = (actual.body.pedidos || []).find(p => p.folio === folio);
  assert.ok(mio, 'el pedido aceptado debe aparecer en el portal del repartidor');
  assert.strictEqual(mio.notas, NOTA_E2E, 'quien entrega tiene que poder LEER las notas de entrega');
});

await pool.query(`DELETE FROM repartidores WHERE telefono = $1`, [TEL_REP]).catch(()=>{});

// ═══════════ 44-55) Las notas de entrega, VISIBLES en el panel ═══════════
// Guardarlas y enseñárselas al repartidor no alcanzaba: quien atiende el
// mostrador —el que decide qué se despacha, y el que tiene que dictárselas por
// teléfono a quien ya salió— no tenía dónde leerlas. Su único destino visible
// era panel/repartidor.html.
//
// Se cubren otra vez LOS DOS lados: que el SERVIDOR las exponga (listado y
// detalle) y que el PANEL las PINTE. Y se vigila el límite explícito: la
// comanda de cocina imprime las notas del ITEM (preparación) y JAMÁS la del
// PEDIDO (entrega) — que no se imprima es la decisión, no un descuido.

// Código REAL del listado y del detalle, ejecutado con document y apiFetch
// inyectados. Mismo criterio que el bloque FRONTEND de arriba: se afirma el
// HTML que el operador acaba viendo, no la forma del código fuente.
const ENV_HELPERS = PANEL.slice(
  PANEL.indexOf('const ENV_ESTADOS_LBL'),
  PANEL.indexOf('async function abrirEnvios()'));
const ENV_VISTA = PANEL.slice(
  PANEL.indexOf('async function cargarEnviosActivos()'),
  PANEL.indexOf('async function envSolicitarRep(folio)'));

function montarEnvios({ envios = [], pedido = null, detalleOk = true } = {}) {
  const nodos = {}, rutas = [];
  const doc = { getElementById: (id) => (nodos[id] = nodos[id] || { innerHTML:'', textContent:'', style:{} }) };
  const apiFetchFalso = async (ruta) => {
    rutas.push(ruta);
    if (ruta === '/api/pos/envios') return { ok: true, json: async () => ({ envios }) };
    if (!detalleOk) return { ok: false, json: async () => ({ error: 'no' }) };
    return { ok: true, json: async () => ({ pedido }) };
  };
  const vista = new Function('document', 'apiFetch',
    ENV_HELPERS + ENV_VISTA +
    '; return { cargarEnviosActivos, envAbrirDetalle, envDetalleHTML, envChipNotas };'
  )(doc, apiFetchFalso);
  return { ...vista, nodos, rutas };
}

const NOTA_PANEL = 'Dejar en el portón, no tocar timbre (perro)';
const PEDIDO_FIXTURE = {
  id: 'XAB-9001', estado: 'en_preparacion', modalidad: 'entrega a domicilio', canal: 'pos',
  cliente: { nombre: 'Ana Ruiz', telefono: '8781234500', calle: 'Av. Reforma', numero_exterior: '123',
             colonia: 'Centro', entre_calles: 'A y B', referencia: 'Portón azul' },
  items: [{ nombre: 'Orden de tacos', cantidad: 2, precio_unitario: 100, notas: 'sin cebolla' }],
  subtotal: 200, costo_envio: 40, descuento: 0, total: 240, forma_pago: 'efectivo',
  notas: NOTA_PANEL,
};

await t('VISTA', 'el LISTADO trae las notas (vistaEnvioPOS las omitía: la tabla no podía marcarlas)', async () => {
  const lista = await api(base, '/api/pos/envios', { cookie: cookieAdminA });
  assert.strictEqual(lista.status, 200);
  const fila = lista.body.envios.find(e => e.folio === folioNotas);
  assert.ok(fila, 'el pedido con notas debe seguir en el listado');
  assert.strictEqual(fila.notas, NOTA, 'sin esto la tabla no sabe qué filas traen indicaciones');
});

await t('VISTA', 'un envío SIN notas trae notas:null en el listado (no undefined ni "")', async () => {
  const r = await api(base, '/api/pos/pedidos', { cookie: cookieAdminA, method:'POST', body: {
    tipo:'domicilio', cliente: CLIENTE, direccion: DIRECCION, items: itemsA(), costoEnvio: 15, formaPago:'efectivo' } });
  assert.strictEqual(r.status, 200);
  const lista = await api(base, '/api/pos/envios', { cookie: cookieAdminA });
  const fila = lista.body.envios.find(e => e.folio === r.body.pedido.id);
  assert.strictEqual(fila.notas, null, 'un null explícito es lo que distingue "sin nota" de "no vino el campo"');
});

await t('VISTA', 'el DETALLE devuelve las notas completas (fuente del modal)', async () => {
  const r = await api(base, `/api/pos/envios/${folioNotas}`, { cookie: cookieAdminA });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.pedido.notas, NOTA);
});

await t('PANEL', 'el detalle muestra la nota ROTULADA y ARRIBA de los demás campos', async () => {
  const vista = montarEnvios();
  const html = vista.envDetalleHTML(PEDIDO_FIXTURE);
  assert.ok(html.includes('Notas de entrega'), 'la nota va rotulada, no suelta entre campos');
  const iBloque = html.indexOf('env-detalle-notas');
  const iNota = html.indexOf('Dejar en el portón');
  const iCliente = html.indexOf('Ana Ruiz');
  assert.ok(iBloque >= 0, 'debe existir el bloque destacado');
  assert.ok(iNota > iBloque, 'la nota va DENTRO de ese bloque');
  assert.ok(iCliente > iNota, 'destacada = antes que cliente/dirección/items, no una fila más del montón');
});

await t('PANEL', 'sin notas lo DICE; no deja un hueco mudo', async () => {
  const vista = montarEnvios();
  for (const vacia of [null, undefined, '', '     ']) {
    const html = vista.envDetalleHTML({ ...PEDIDO_FIXTURE, notas: vacia });
    assert.ok(html.includes('Sin notas de entrega'), `con notas=${JSON.stringify(vacia)} hay que decirlo`);
    assert.ok(!html.includes('Notas de entrega<'), 'no debe quedar el rótulo con nada debajo');
  }
});

await t('PANEL', 'una nota tecleada por el operador no puede inyectar HTML', async () => {
  const vista = montarEnvios();
  const html = vista.envDetalleHTML({ ...PEDIDO_FIXTURE, notas: '<img src=x onerror="alert(1)">' });
  assert.ok(!html.includes('<img'), 'el texto del operador entra escapado, no como etiqueta');
  assert.ok(html.includes('&lt;img'), 'y se ve como el texto que es');
});

await t('PANEL', 'ENTREGA y PREPARACIÓN se ven las dos, rotuladas distinto, sin suplantarse', async () => {
  const vista = montarEnvios();
  const html = vista.envDetalleHTML(PEDIDO_FIXTURE);
  assert.ok(html.includes('Preparación: sin cebolla'), 'la nota del item es de cocina y se rotula así');
  assert.ok(!html.includes('Preparación: Dejar en el portón'), 'la de entrega jamás se rotula como preparación');
  assert.ok(html.indexOf('Dejar en el portón') < html.indexOf('sin cebolla'), 'entrega arriba; cocina, dentro de su item');
});

await t('PANEL', 'el LISTADO marca con 📝 sólo las filas que traen notas', async () => {
  const fila = (folio, notas) => ({ folio, cliente:'Ana', telefono:'8781234500', colonia:'Centro', total:240,
    formaPago:'efectivo', pagoConfirmado:false, entregaEstado:'sin_repartidor',
    modalidad:'entrega a domicilio', repartidorNombre:null, notas });
  const vista = montarEnvios({ envios: [fila('XAB-9001', 'Dejar en el portón'), fila('XAB-9002', null)] });
  await vista.cargarEnviosActivos();
  const tabla = vista.nodos['env-tabla-activos'].innerHTML;
  const conNotas = tabla.slice(tabla.indexOf('XAB-9001'), tabla.indexOf('XAB-9002'));
  const sinNotas = tabla.slice(tabla.indexOf('XAB-9002'));
  assert.ok(conNotas.includes('📝'), 'sin marca en la tabla nadie abre el detalle y la nota sigue invisible');
  assert.ok(conNotas.includes('title="Dejar en el portón"'), 'el texto asoma al pasar el mouse, sin abrir nada');
  assert.ok(!sinNotas.includes('📝'), 'una fila sin notas no debe marcar nada (marcar todo es no marcar)');
  assert.ok(conNotas.includes('envAbrirDetalle('), 'y debe haber por dónde abrir el detalle');
});

await t('PANEL', 'el detalle se RELEE del servidor, no de la fila que lleva minutos en pantalla', async () => {
  const vista = montarEnvios({ pedido: PEDIDO_FIXTURE });
  await vista.envAbrirDetalle('XAB-9001');
  assert.ok(vista.rutas.includes('/api/pos/envios/XAB-9001'), 'lo que se va a ejecutar en la calle se pide fresco');
  assert.strictEqual(vista.nodos['env-detalle-overlay'].style.display, 'flex', 'el modal debe quedar abierto');
  assert.strictEqual(vista.nodos['env-detalle-folio'].textContent, 'XAB-9001');
  assert.ok(vista.nodos['env-detalle-cuerpo'].innerHTML.includes('Dejar en el portón'));
});

await t('PANEL', 'si el detalle no carga se dice; no se pinta un modal en blanco', async () => {
  const vista = montarEnvios({ detalleOk: false });
  await vista.envAbrirDetalle('XAB-9001');
  const cuerpo = vista.nodos['env-detalle-cuerpo'].innerHTML;
  assert.ok(/No se pudo cargar|Error de red/.test(cuerpo), 'un modal vacío se lee como "no traía notas"');
  assert.ok(!cuerpo.includes('Sin notas de entrega'), 'y jamás debe AFIRMAR que no había notas cuando no pudo saberlo');
});

// ═══════════ 56-57) La impresión NO se toca ═══════════
// Notas del ITEM = preparación (las imprime la comanda). Notas del PEDIDO =
// entrega (no se imprimen: se leen en pantalla y en el portal del repartidor).
// Esta prueba EJECUTA las funciones de impresión reales con un pedido que trae
// las dos, para que si alguna vez alguien "mejora" la comanda agregándole
// p.notas, se entere aquí y no en la cocina.
const IMPRESION = PANEL.slice(
  PANEL.indexOf('function comandaHTML(p) {'),
  PANEL.indexOf('function pedidoPrueba()'));
function montarImpresion() {
  return new Function('esc','modsAgrupados','getNombre','horaCST','getTelefono','etiquetaFormaPago','getPrecioItem','totalEnLetras','negocio',
    IMPRESION + '; return { comandaHTML, ticketHTML };')(
      s => String(s ?? ''), () => [], p => p.cliente?.nombre || '', () => '12:00',
      p => p.cliente?.telefono || '', () => 'Efectivo', it => Number(it.precio_unitario || 0),
      () => 'doscientos cuarenta pesos 00/100 M.N.',
      { nombre:'Xabor', nombre_corto:'XABOR', rfc:'XAXX010101000', direccion:'Calle 1', ciudad:'Matamoros', telefono:'8781234567', whatsapp:'8781234567' });
}

await t('IMPRESIÓN', 'la COMANDA de cocina imprime la nota del ITEM y NO la de ENTREGA', async () => {
  const comanda = montarImpresion().comandaHTML(PEDIDO_FIXTURE);
  assert.ok(comanda.includes('sin cebolla'), 'la preparación del item sí va a la cocina');
  assert.ok(!comanda.includes('Dejar en el portón'),
    'la nota de ENTREGA no es para la cocina: si aparece aquí, alguien cruzó los dos campos');
});

await t('IMPRESIÓN', 'el TICKET del cliente tampoco lleva la nota de entrega', async () => {
  const ticket = montarImpresion().ticketHTML(PEDIDO_FIXTURE);
  assert.ok(!ticket.includes('Dejar en el portón'), 'el recibo del cliente no es el lugar de una instrucción interna');
});

// Limpieza de los pedidos POS de prueba (no tocar XAB-0108/0109 reales).
await pool.query(`DELETE FROM pagos WHERE negocio_id = ANY($1) AND pedido_folio LIKE 'XAB-%' AND created_at > NOW() - INTERVAL '5 minutes'`, [[A, B]]).catch(()=>{});
await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = ANY($1) AND datos->>'canal' = 'pos'`, [[A, B]]);
await pool.query(`DELETE FROM menu_categorias WHERE nombre = 'Cat prueba POS' AND negocio_id = ANY($1)`, [[A, B]]);

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
