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

// Limpieza de los pedidos POS de prueba (no tocar XAB-0108/0109 reales).
await pool.query(`DELETE FROM pagos WHERE negocio_id = ANY($1) AND pedido_folio LIKE 'XAB-%' AND created_at > NOW() - INTERVAL '5 minutes'`, [[A, B]]).catch(()=>{});
await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = ANY($1) AND datos->>'canal' = 'pos'`, [[A, B]]);
await pool.query(`DELETE FROM menu_categorias WHERE nombre = 'Cat prueba POS' AND negocio_id = ANY($1)`, [[A, B]]);

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
