// ─── CRM de clientes por negocio: suite end-to-end ─────────────────────────
//
// El tab Clientes deja de leer `clientes` (PK global por teléfono, primero
// que llega gana) y `perfiles_clientes` (métricas sin negocio) y pasa a leer
// `clientes_negocio` con métricas calculadas POR NEGOCIO desde los pedidos.
//
// Las cinco preguntas que esta suite existe para responder:
//   1. ¿Un negocio puede ver, buscar o abrir a un cliente de otro?   (nunca)
//   2. ¿La misma persona en dos negocios mezcla sus números?          (nunca)
//   3. ¿Los pedidos, Rewards, direcciones y consentimientos de la
//      ficha son los de ESTE negocio?                                  (sí)
//   4. ¿Aparecen los que se registraron sin comprar, los migrados de
//      Rewards, los que compraron de invitado y los de WhatsApp?       (todos)
//   5. ¿El backfill de la 081 y el reconciliador son idempotentes?    (sí)
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { execFileSync } from 'child_process';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4791';

const { pool, crearUsuarioConPassword } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { guardarDireccion, registrarConsentimiento, vincularRewards } = await import('../src/services/clientesNegocio.js');
const { crearSesion } = await import('../src/services/clienteAuth.js');
const { reconciliarClientesDesdePedidos } = await import('../src/services/clientesCrm.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

const A = SEED.negocioA, B = SEED.negocioB;
// Teléfonos fijos (se limpian al empezar): la lista se aísla con q=CRMT.
const TEL = { P1: '8790000001', P2: '8790000002', P3: '8790000003', P4: '8790000004', P5: '8790000005' };
const TELS = Object.values(TEL);
const dias = (n) => new Date(Date.now() - n * 86400000).toISOString();
const isoDia = (n) => dias(n).slice(0, 10);

async function adminDe(negocioId) {
  const { rows } = await pool.query(
    `SELECT usuario_id FROM usuario_negocios WHERE negocio_id = $1 AND rol = 'admin' AND activo LIMIT 1`, [negocioId]);
  if (rows[0]) return rows[0].usuario_id;
  const email = 'admin-crm-b@test.local';
  try {
    const u = await crearUsuarioConPassword({ negocioId, nombre: 'Admin CRM B', email, password: 'ClaveCrmB123!', rol: 'admin' });
    return u.id;
  } catch {
    const { rows: [u] } = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'admin') ON CONFLICT (usuario_id, negocio_id) DO UPDATE SET rol='admin', activo=TRUE`, [u.id, negocioId]);
    return u.id;
  }
}
const cookie = (usuarioId, negocioId, rol) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;

// ── Limpieza y fixture ────────────────────────────────────────────────────
await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = ANY($1) AND folio LIKE 'CRMT-%'`, [[A, B]]);
await pool.query(`DELETE FROM clientes_negocio WHERE negocio_id = ANY($1) AND telefono = ANY($2)`, [[A, B], TELS]);
await pool.query(`DELETE FROM rewards_accounts WHERE tenant_id = ANY($1) AND telefono = ANY($2)`, [[A, B], TELS]);
for (const n of [A, B]) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'rewards','activo')
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [n]);
  await pool.query(
    `INSERT INTO rewards_config (tenant_id, activo, monto_por_punto, puntos_por_peso, canje_minimo, canal_tienda)
     VALUES ($1,TRUE,10,0.5,100,TRUE) ON CONFLICT (tenant_id) DO UPDATE SET activo=TRUE`, [n]);
}

// Un pedido tal como lo deja registrarPedido, insertado directo (como hacen
// otras suites) con folio propio: los triggers de folio lo dejan pasar.
async function pedido(negocioId, folio, telefono, nombre, canal, total, hace, estado = 'entregado') {
  const datos = { canal, modalidad: canal === 'tienda_online' ? 'entrega a domicilio' : 'recoger en tienda', total, forma_pago: 'efectivo',
    cliente: { nombre, telefono }, items: [{ nombre: 'Producto CRMT', cantidad: 1, precio: total }] };
  await pool.query(
    `INSERT INTO pedidos_activos (folio, estado, datos, created_at, updated_at, negocio_id) VALUES ($1,$2,$3,$4,$4,$5)`,
    [folio, estado, JSON.stringify(datos), dias(hace), negocioId]);
}
async function cuentaRewards(negocioId, telefono, puntos) {
  await pool.query(`INSERT INTO clientes (telefono) VALUES ($1) ON CONFLICT (telefono) DO NOTHING`, [telefono]);
  await pool.query(
    `INSERT INTO rewards_accounts (telefono, tenant_id, negocio_id, puntos_balance, puntos_acumulados_total)
     VALUES ($1,$2,$3::uuid,$4,$4)
     ON CONFLICT (telefono, tenant_id) DO UPDATE SET puntos_balance=$4, puntos_acumulados_total=$4, cliente_id=NULL`,
    [telefono, negocioId, negocioId, puntos]);
}

// P1: registrada en la tienda de A, con 2 direcciones, consentimiento WA,
// 300 pts y 3 pedidos en A (uno con teléfono en formato WhatsApp y uno
// cancelado que NO debe contar). La misma persona compró UNA vez en B.
const { rows: [p1a] } = await pool.query(
  `INSERT INTO clientes_negocio (negocio_id, telefono, nombre, email, origen) VALUES ($1,$2,'CRMT Persona Uno','uno@crmt.test','tienda') RETURNING *`, [A, TEL.P1]);
const tokenP1 = await crearSesion({ negocioId: A, clienteId: p1a.id, ip: '127.0.0.1', userAgent: 'suite' });
await guardarDireccion(A, p1a.id, { alias: 'Casa', calle: 'Uno Casa', numeroExterior: '1', colonia: 'Centro' });
await guardarDireccion(A, p1a.id, { alias: 'Trabajo', calle: 'Uno Trabajo', numeroExterior: '2', colonia: 'Norte' });
await registrarConsentimiento(A, p1a.id, { canal: 'whatsapp', otorgado: true, fuente: 'mi_cuenta' });
await cuentaRewards(A, TEL.P1, 300);
await vincularRewards({ id: p1a.id, negocio_id: A, telefono: TEL.P1 });
await pedido(A, 'CRMT-A-1', '521' + TEL.P1, 'CRMT Persona Uno', 'whatsapp', 150, 20);
await pedido(A, 'CRMT-A-2', TEL.P1, 'CRMT Persona Uno', 'presencial', 250, 10);
await pedido(A, 'CRMT-A-3', TEL.P1, 'CRMT Persona Uno', 'tienda_online', 200, 2);
await pedido(A, 'CRMT-A-9', TEL.P1, 'CRMT Persona Uno', 'presencial', 999, 1, 'cancelado');
await pedido(B, 'CRMT-B-1', TEL.P1, 'CRMT Persona Uno B', 'presencial', 80, 5);
// P2: migrada de Rewards en A, sin sesión ni pedidos.
const { rows: [p2a] } = await pool.query(
  `INSERT INTO clientes_negocio (negocio_id, telefono, nombre, origen) VALUES ($1,$2,'CRMT Persona Dos','rewards') RETURNING *`, [A, TEL.P2]);
await cuentaRewards(A, TEL.P2, 120);
await vincularRewards({ id: p2a.id, negocio_id: A, telefono: TEL.P2 });
// P3: solo compró de invitado en la tienda de A (el backfill la debe crear).
await pedido(A, 'CRMT-A-4', TEL.P3, 'CRMT Persona Tres', 'tienda_online', 300, 3);
// P4: registrada solo en B.
const { rows: [p4b] } = await pool.query(
  `INSERT INTO clientes_negocio (negocio_id, telefono, nombre, email, origen) VALUES ($1,$2,'CRMT Persona Cuatro','cuatro@crmt.test','tienda') RETURNING *`, [B, TEL.P4]);
await crearSesion({ negocioId: B, clienteId: p4b.id, ip: '127.0.0.1', userAgent: 'suite' });
// Teléfonos sintéticos: jamás se vuelven clientes.
await pedido(A, 'CRMT-A-5', 'pos-abc12345', 'Mostrador', 'presencial', 50, 1);
await pedido(A, 'CRMT-A-6', 'rappi-99', 'Rappi', 'rappi', 60, 1);

// ── Backfill de la 081 (dos veces: idempotente) ───────────────────────────
const correr081 = () => execFileSync(process.execPath, [join(RAIZ, 'scripts', 'predeploy-081-crm-clientes-negocio.mjs')], { env: process.env, encoding: 'utf8' });
const salida081a = correr081();
const salida081b = correr081();

const adminA = cookie(SEED.adminNegocioAUsuarioId, A, 'admin');
const staffA = cookie(SEED.staffNegocioAUsuarioId, A, 'staff');
const adminB = cookie(await adminDe(B), B, 'admin');

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 40000 });
const base = srv.base;
async function get(ruta, ck) {
  const r = await fetch(base + ruta, { headers: { Cookie: ck } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function post(ruta, ck, cuerpo) {
  const r = await fetch(base + ruta, { method: 'POST', headers: { Cookie: ck, 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const lista = async (ck, qs) => { const r = await get('/api/admin/clientes/v2?' + qs, ck); assert.strictEqual(r.status, 200, JSON.stringify(r.body)); return r.body; };
const porTel = (rows, tel) => rows.find(c => c.telefono === tel);

try {
  await t('BACKFILL', '1. la 081 crea al comprador de invitado y a la persona en B; segunda corrida no cambia nada', async () => {
    assert.match(salida081a, /Pedidos y Rewards intactos/);
    assert.match(salida081b, /Ya aplicada/);
    const { rows: p3 } = await pool.query('SELECT origen, nombre, telefono_original FROM clientes_negocio WHERE negocio_id=$1 AND telefono=$2', [A, TEL.P3]);
    assert.strictEqual(p3.length, 1, 'P3 existe en A');
    assert.strictEqual(p3[0].origen, 'checkout');
    assert.strictEqual(p3[0].nombre, 'CRMT Persona Tres');
    const { rows: p1b } = await pool.query('SELECT origen, nombre FROM clientes_negocio WHERE negocio_id=$1 AND telefono=$2', [B, TEL.P1]);
    assert.strictEqual(p1b.length, 1, 'P1 existe en B como cliente propio de B');
    assert.strictEqual(p1b[0].origen, 'mostrador');
    const { rows: p1aDespues } = await pool.query('SELECT origen, nombre, email FROM clientes_negocio WHERE id=$1', [p1a.id]);
    assert.strictEqual(p1aDespues[0].origen, 'tienda', 'la fila que ya existía conserva su origen');
    assert.strictEqual(p1aDespues[0].email, 'uno@crmt.test');
    const { rows: sint } = await pool.query(`SELECT count(*)::int AS n FROM clientes_negocio WHERE negocio_id=$1 AND (telefono_original LIKE 'pos-%' OR telefono_original LIKE 'rappi-%')`, [A]);
    assert.strictEqual(sint[0].n, 0, 'teléfonos sintéticos no se vuelven clientes');
  });

  await t('LISTA', '2. el negocio A ve a sus tres personas CRMT y no a la de B', async () => {
    const r = await lista(adminA, 'q=CRMT');
    const tels = r.clientes.map(c => c.telefono).sort();
    assert.deepStrictEqual(tels, [TEL.P1, TEL.P2, TEL.P3]);
    assert.strictEqual(r.total, 3);
    assert.ok(!porTel(r.clientes, TEL.P4), 'P4 es de B');
  });

  await t('METRICAS', '3. P1 en A: 3 pedidos, $600, ticket $200, sin el cancelado; registrada, 300 pts, WA sí, frecuente', async () => {
    const r = await lista(adminA, 'q=CRMT');
    const c = porTel(r.clientes, TEL.P1);
    assert.strictEqual(c.pedidos, 3, 'el cancelado no cuenta');
    assert.strictEqual(c.totalGastado, 600);
    assert.strictEqual(c.ticketPromedio, 200);
    assert.strictEqual(c.primeraCompra.slice(0, 10), isoDia(20));
    assert.strictEqual(c.ultimaCompra.slice(0, 10), isoDia(2));
    assert.strictEqual(c.origen, 'tienda');
    assert.strictEqual(c.registrado, true);
    assert.strictEqual(c.conRewards, true);
    assert.strictEqual(c.puntos, 300);
    assert.strictEqual(c.consentWhatsapp, true);
    assert.strictEqual(c.consentEmail, false);
    assert.strictEqual(c.email, 'uno@crmt.test');
    assert.strictEqual(c.segmento, 'frecuente');
    const p2 = porTel(r.clientes, TEL.P2);
    assert.deepStrictEqual([p2.pedidos, p2.origen, p2.registrado, p2.puntos, p2.segmento, p2.ultimaCompra], [0, 'rewards', false, 120, 'nuevo', null]);
    const p3 = porTel(r.clientes, TEL.P3);
    assert.deepStrictEqual([p3.pedidos, p3.origen, p3.registrado, p3.totalGastado, p3.nombre], [1, 'checkout', false, 300, 'CRMT Persona Tres']);
  });

  await t('METRICAS', '4. la misma persona en B tiene su propia historia: 1 pedido, $80, mostrador, sin puntos', async () => {
    const r = await lista(adminB, 'q=' + TEL.P1);
    assert.strictEqual(r.total, 1);
    const c = r.clientes[0];
    assert.deepStrictEqual([c.pedidos, c.totalGastado, c.origen, c.registrado, c.puntos, c.conRewards, c.consentWhatsapp],
      [1, 80, 'mostrador', false, 0, false, false]);
    assert.strictEqual(c.nombre, 'CRMT Persona Uno B');
  });

  await t('AISLAMIENTO', '5. la búsqueda por teléfono y por correo no cruza negocios', async () => {
    assert.strictEqual((await lista(adminA, 'q=' + TEL.P4)).total, 0, 'el teléfono de P4 no existe para A');
    assert.strictEqual((await lista(adminA, 'q=cuatro@crmt')).total, 0, 'ni su correo');
    assert.strictEqual((await lista(adminB, 'q=cuatro@crmt')).total, 1);
    assert.strictEqual((await lista(adminB, 'q=uno@crmt')).total, 0, 'el correo de P1 vive en A, no en B');
    const conFormato = await lista(adminA, 'q=' + encodeURIComponent('+52 879 000 0001'));
    assert.strictEqual(conFormato.total, 1, 'el buscador normaliza el teléfono');
    assert.strictEqual(conFormato.clientes[0].telefono, TEL.P1);
  });

  await t('FILTROS', '6. origen, registrado, Rewards, consentimiento, segmento, compró y última compra', async () => {
    const t1 = (qs) => lista(adminA, 'q=CRMT&' + qs).then(r => r.clientes.map(c => c.telefono).sort());
    assert.deepStrictEqual(await t1('origen=rewards'), [TEL.P2]);
    assert.deepStrictEqual(await t1('origen=checkout'), [TEL.P3]);
    assert.deepStrictEqual(await t1('registrado=si'), [TEL.P1]);
    assert.deepStrictEqual(await t1('registrado=no'), [TEL.P2, TEL.P3]);
    assert.deepStrictEqual(await t1('rewards=si'), [TEL.P1, TEL.P2]);
    assert.deepStrictEqual(await t1('consent_wa=si'), [TEL.P1]);
    assert.deepStrictEqual(await t1('consent_email=si'), []);
    assert.deepStrictEqual(await t1('segmento=nuevo'), [TEL.P2]);
    assert.deepStrictEqual(await t1('segmento=frecuente'), [TEL.P1, TEL.P3]);
    assert.deepStrictEqual(await t1('compro=no'), [TEL.P2]);
    assert.deepStrictEqual(await t1('ultima_desde=' + isoDia(2)), [TEL.P1]);
    assert.deepStrictEqual(await t1('ultima_hasta=' + isoDia(3)), [TEL.P3]);
  });

  await t('PAGINACION', '7. paginación en servidor: total real, páginas y página vacía', async () => {
    const p1 = await lista(adminA, 'q=CRMT&limit=2&orden=nombre');
    assert.strictEqual(p1.clientes.length, 2);
    assert.strictEqual(p1.total, 3);
    assert.strictEqual(p1.paginas, 2);
    assert.deepStrictEqual(p1.clientes.map(c => c.nombre), ['CRMT Persona Dos', 'CRMT Persona Tres']);
    const p2 = await lista(adminA, 'q=CRMT&limit=2&orden=nombre&page=2');
    assert.deepStrictEqual(p2.clientes.map(c => c.nombre), ['CRMT Persona Uno']);
    const p9 = await lista(adminA, 'q=CRMT&limit=2&page=9');
    assert.strictEqual(p9.clientes.length, 0);
    assert.strictEqual(p9.total, 3, 'el total no depende de la página');
    const tope = await lista(adminA, 'limit=100000');
    assert.strictEqual(tope.limit, 100, 'el tope es 100 por página');
  });

  await t('RESUMEN', '8. las tarjetas del resumen salen del mismo conjunto', async () => {
    const r = await get('/api/admin/clientes/v2/resumen', adminA);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    for (const k of ['total', 'registrados', 'con_rewards', 'consent_whatsapp', 'compraron_30d', 'nuevos_30d', 'sin_compras', 'puntos_vivos']) {
      assert.strictEqual(typeof r.body[k], 'number', k);
    }
    assert.ok(r.body.total >= 3 && r.body.registrados >= 1 && r.body.con_rewards >= 2 && r.body.puntos_vivos >= 420);
    assert.ok(r.body.total >= r.body.registrados && r.body.total >= r.body.sin_compras);
  });

  await t('FICHA', '9. la ficha de P1 en A trae Rewards, 2 direcciones, 3 pedidos (solo de A), consentimiento y 1 sesión', async () => {
    const r = await get('/api/admin/clientes/v2/' + p1a.id, adminA);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const f = r.body;
    assert.strictEqual(f.cliente.pedidos, 3);
    assert.strictEqual(f.cliente.totalGastado, 600);
    assert.strictEqual(f.rewards.activo, true);
    assert.strictEqual(f.rewards.puntos, 300);
    assert.ok(Array.isArray(f.rewards.movimientos));
    assert.strictEqual(f.direcciones.length, 2);
    assert.strictEqual(f.direcciones.filter(d => d.predeterminada).length, 1);
    assert.deepStrictEqual(f.pedidos.map(p => p.folio).sort(), ['CRMT-A-1', 'CRMT-A-2', 'CRMT-A-3', 'CRMT-A-9']);
    assert.ok(f.pedidos.every(p => !p.folio.startsWith('CRMT-B')), 'ningún pedido de B');
    assert.strictEqual(f.pedidos.find(p => p.folio === 'CRMT-A-9').estado, 'cancelado', 'el cancelado se lista con su estado, pero no cuenta');
    assert.strictEqual(f.pedidos.find(p => p.folio === 'CRMT-A-1').canal, 'whatsapp');
    assert.strictEqual(f.consentimientos.whatsapp.otorgado, true);
    assert.strictEqual(f.consentimientos.whatsapp.fuente, 'mi_cuenta');
    assert.strictEqual(f.consentimientos.email.otorgado, false);
    assert.strictEqual(f.sesiones.activas, 1);
  });

  await t('AISLAMIENTO', '10. una ficha ajena no existe: id de B desde A → 404, id inventado → 404', async () => {
    assert.strictEqual((await get('/api/admin/clientes/v2/' + p4b.id, adminA)).status, 404);
    const { rows: [p1b] } = await pool.query('SELECT id FROM clientes_negocio WHERE negocio_id=$1 AND telefono=$2', [B, TEL.P1]);
    assert.strictEqual((await get('/api/admin/clientes/v2/' + p1b.id, adminA)).status, 404, 'el P1 de B no es visible desde A');
    assert.strictEqual((await get('/api/admin/clientes/v2/' + p1a.id, adminB)).status, 404, 'ni el P1 de A desde B');
    assert.strictEqual((await get('/api/admin/clientes/v2/00000000-0000-0000-0000-000000000000', adminA)).status, 404);
    assert.strictEqual((await get('/api/admin/clientes/v2/no-es-uuid', adminA)).status, 404);
    assert.strictEqual((await post('/api/admin/clientes/v2/' + p4b.id + '/cerrar-sesiones', adminA)).status, 404);
  });

  await t('SESIONES', '11. cerrar todas las sesiones del cliente las revoca de verdad', async () => {
    const r = await post('/api/admin/clientes/v2/' + p1a.id + '/cerrar-sesiones', adminA);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const f = await get('/api/admin/clientes/v2/' + p1a.id, adminA);
    assert.strictEqual(f.body.sesiones.activas, 0);
    const { rows } = await pool.query('SELECT revocada_at FROM cliente_sesiones WHERE cliente_id=$1', [p1a.id]);
    assert.ok(rows.length >= 1 && rows.every(s => s.revocada_at), 'todas revocadas');
    assert.ok(tokenP1, 'el token existía');
  });

  await t('SEGURIDAD', '12. el CRM es de administrador: el staff no entra, sin sesión tampoco', async () => {
    assert.strictEqual((await get('/api/admin/clientes/v2', staffA)).status, 403);
    assert.strictEqual((await get('/api/admin/clientes/v2/resumen', staffA)).status, 403);
    const sin = await fetch(base + '/api/admin/clientes/v2');
    assert.ok([401, 403].includes(sin.status));
  });

  await t('RECONCILIADOR', '13. un pedido nuevo por WhatsApp se vuelve cliente del negocio en segundo plano, una sola vez', async () => {
    await pedido(A, 'CRMT-A-7', '521' + TEL.P5, 'CRMT Persona Cinco', 'whatsapp', 120, 0);
    const n1 = await reconciliarClientesDesdePedidos('1 hour');
    assert.ok(n1 >= 1, 'creó al menos uno');
    const { rows } = await pool.query('SELECT origen, nombre, telefono_original FROM clientes_negocio WHERE negocio_id=$1 AND telefono=$2', [A, TEL.P5]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].origen, 'whatsapp');
    assert.strictEqual(rows[0].nombre, 'CRMT Persona Cinco');
    assert.strictEqual(rows[0].telefono_original, '521' + TEL.P5);
    const n2 = await reconciliarClientesDesdePedidos('1 hour');
    assert.strictEqual(n2, 0, 'segunda pasada: nada nuevo');
    const r = await lista(adminA, 'q=' + TEL.P5);
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.clientes[0].pedidos, 1);
  });

  await t('COMPATIBILIDAD', '14. el endpoint viejo sigue respondiendo igual', async () => {
    const r = await get('/api/admin/clientes', adminA);
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });
} finally {
  console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
  if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
  if (fallidas) {
    const salida = srv.obtenerSalida().split('\n').filter(l => /error|\[CRM\]|FALLO/i.test(l)).slice(-12).join('\n');
    if (salida) console.log('\nErrores del servidor:\n' + salida);
  }
  await srv.detener();
  await pool.end();
  process.exitCode = fallidas > 0 ? 1 : 0;
}
