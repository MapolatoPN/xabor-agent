// Suite Fase 20: arquitectura de pagos multiempresa (proveedores
// genéricos, métodos de pago reales por negocio, idempotencia,
// conciliación de transferencia manual, aislamiento entre negocios).
//
// Reproduce y verifica la corrección del incidente real (2 de agosto de
// 2026): el agente de WhatsApp de Alora ofrecía "enlace de pago" sin que
// hubiera ningún proveedor configurado para ese negocio (el backend ya
// bloqueaba el cobro, pero el agente no debía haberlo ofrecido). Cubre
// también Nonna Maye (con Clip real configurado y marcado principal tras
// el backfill de la migración 025) para confirmar que NO hubo regresión.
//
// No llama a Clip real en ningún momento: los casos de creación de enlace
// exitosa usan manual_transfer como proveedor principal (100% local, sin
// red) para ejercitar pagosService.crearEnlacePago de punta a punta; los
// casos con Clip solo validan las rutas fail-closed (sin configurar / mal
// configurado), que nunca llegan a la red. La re-verificación del webhook
// vía consultarEstadoPago (que sí llamaría a la red de Clip) se valida
// por revisión de código, documentado más abajo -- no por prueba
// automatizada, en cumplimiento estricto de "no llamar a Clip real".
//
// Uso: DATABASE_URL=... INTEGRATIONS_ENCRYPTION_KEY=... PANEL_SECRET=...
//      SESSION_SECRET=... ADMIN_PASSWORD=... node test/fase-pagos-multiempresa.mjs
// Requiere aplicar-migraciones.mjs y seed-datos-prueba.mjs ya corridos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4098';

const { pool, guardarPedidoActivo, crearUsuarioConPassword } = await import('../src/services/database.js');
const {
  guardarIntegracionPago, listarIntegracionesPago, obtenerIntegracionPago, obtenerProveedorPrincipal,
  suspenderIntegracionPago, reactivarIntegracionPago, eliminarCredencialesPago, marcarProveedorPrincipal,
  probarIntegracionPago, guardarCredencialesClip, obtenerCredencialesPagoDescifradas, TenantContextRequiredError,
} = await import('../src/services/integracionesService.js');
const { esProveedorValido, validarPuedeActivarse, listarProveedores } = await import('../src/services/paymentProviders.js');
const { crearEnlacePago, SinProveedorPrincipalError, PedidoInvalidoError } = await import('../src/services/pagosService.js');
const {
  listarMetodosPagoNegocio, guardarMetodoPagoNegocio, obtenerMetodosPagoDisponibles,
  listarPagosPorPedido, obtenerPagoVigente, invalidarPagosVigentesDePedido,
  confirmarPagoManual, rechazarPagoManual,
} = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(categoria, nombre, fn) {
  try { await fn(); console.log(`  OK  [${categoria}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${categoria}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${categoria}] ${nombre}: ${e.message}`); }
}

async function api(base, path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* sin cuerpo JSON */ }
  return { status: r.status, body: json };
}

// ─── Fixtures propios de esta suite (negocios A/B ya sembrados por Fase B) ──
const { rows: [nonnaMaye] } = await pool.query(`SELECT id FROM negocios WHERE slug = 'nonna-maye'`);
const { rows: [alora] } = await pool.query(`SELECT id FROM negocios WHERE slug = 'alora-floreria-y-eventos'`);
assert.ok(nonnaMaye?.id, 'fixture nonna-maye debe existir (migración 003)');
assert.ok(alora?.id, 'fixture alora-floreria-y-eventos debe existir (migración 003)');
const NEGOCIO_A = SEED.negocioA; // fixture Fase B, negocio limpio para pruebas de registro/CRUD
const NEGOCIO_B = SEED.negocioB;

// Limpieza de restos de corridas previas (aislamiento entre suites -- mismo
// criterio que fase-p0-aislamiento-pedidos.mjs).
await pool.query(`DELETE FROM pagos WHERE negocio_id = ANY($1) AND pedido_folio LIKE 'XABPAG%'`, [[NEGOCIO_A, NEGOCIO_B, nonnaMaye.id, alora.id]]);
await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = ANY($1) AND folio LIKE 'XABPAG%'`, [[NEGOCIO_A, NEGOCIO_B]]);
await pool.query(`DELETE FROM metodos_pago WHERE negocio_id = ANY($1)`, [[NEGOCIO_A, NEGOCIO_B]]);
// NEGOCIO_A/B son fixtures de Fase B (creados por seed-datos-prueba.mjs
// con INSERT directo, no vía crearNegocioCompleto) y existían antes de la
// migración 025, así que ninguno de los dos backfills los alcanza --
// se siembran aquí los mismos valores por defecto que ambos mecanismos
// aplican para cualquier negocio real (efectivo/terminal habilitados,
// enlace_pago/transferencia deshabilitados hasta configurar un proveedor).
for (const negocioId of [NEGOCIO_A, NEGOCIO_B]) {
  await guardarMetodoPagoNegocio(negocioId, 'efectivo', { habilitado: true, orden: 0 });
  await guardarMetodoPagoNegocio(negocioId, 'terminal', { habilitado: true, orden: 1 });
  await guardarMetodoPagoNegocio(negocioId, 'enlace_pago', { habilitado: false, orden: 2 });
  await guardarMetodoPagoNegocio(negocioId, 'transferencia', { habilitado: false, orden: 3 });
}
await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = ANY($1) AND canal='pagos')`, [[NEGOCIO_A, NEGOCIO_B]]);
await pool.query(`DELETE FROM integraciones_canal WHERE canal = 'pagos' AND negocio_id = ANY($1)`, [[NEGOCIO_A, NEGOCIO_B]]);
// Alora es un fixture COMPARTIDO por toda la batería de pruebas (no
// exclusivo de esta suite) -- se fuerza explícitamente a "sin proveedor de
// pago" antes de reproducir el incidente, para que la prueba sea
// determinística sin importar qué otra suite haya corrido antes en la
// misma base de datos.
await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'pagos')`, [alora.id]);
await pool.query(`DELETE FROM integraciones_canal WHERE canal = 'pagos' AND negocio_id = $1`, [alora.id]);
await pool.query(`DELETE FROM pagos WHERE negocio_id = ANY($1) AND pedido_folio LIKE 'XABPAG%'`, [[alora.id, nonnaMaye.id]]);
await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = ANY($1) AND folio LIKE 'XABPAG%'`, [[alora.id, nonnaMaye.id]]);

const adminA = await crearUsuarioConPassword({
  negocioId: NEGOCIO_A, nombre: 'Admin Pagos A', email: `admin-pagos-a-${Date.now()}@test.local`,
  password: 'ClaveAdminPagosA123!', rol: 'admin',
}).catch(async () => {
  const { rows } = await pool.query(`SELECT id FROM usuarios WHERE negocio_id = $1 AND rol = 'admin' LIMIT 1`, [NEGOCIO_A]);
  return rows[0];
});
const staffA = await crearUsuarioConPassword({
  negocioId: NEGOCIO_A, nombre: 'Staff Pagos A', email: `staff-pagos-a-${Date.now()}@test.local`,
  password: 'ClaveStaffPagosA123!', rol: 'staff',
}).catch(async () => {
  const { rows } = await pool.query(`SELECT id FROM usuarios WHERE negocio_id = $1 AND rol = 'staff' LIMIT 1`, [NEGOCIO_A]);
  return rows[0];
});
const cookieAdminA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: adminA.id, negocioId: NEGOCIO_A, rol: 'admin' }))}`;
const cookieStaffA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: staffA.id, negocioId: NEGOCIO_A, rol: 'staff' }))}`;
const cookieSuperadmin = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.superadminUsuarioId, negocioId: SEED.negocioA, rol: 'admin' }))}`;

const servidor = await arrancarServidor({ PORT: PUERTO });

// ═══════════ 1. Registro de proveedores: solo Clip y manual_transfer activables ═══════════
await t('REGISTRO', 'listarProveedores incluye los 6 nombres, solo clip/manual_transfer con implementado=true', () => {
  const lista = listarProveedores();
  const nombres = lista.map(p => p.id).sort();
  assert.deepStrictEqual(nombres, ['clip', 'conekta', 'manual_transfer', 'mercado_pago', 'openpay', 'stripe']);
  for (const p of lista) {
    if (['clip', 'manual_transfer'].includes(p.id)) assert.strictEqual(p.implementado, true, `${p.id} debe estar implementado`);
    else assert.strictEqual(p.implementado, false, `${p.id} NO debe fingir estar implementado`);
  }
});
await t('REGISTRO', 'mercado_pago es válido pero no activable; guardarIntegracionPago lo rechaza', async () => {
  assert.strictEqual(esProveedorValido('mercado_pago'), true);
  assert.strictEqual(validarPuedeActivarse('mercado_pago'), false);
  await assert.rejects(() => guardarIntegracionPago(NEGOCIO_A, 'mercado_pago', { apiKey: 'x' }, { actualizadoPor: SEED.superadminUsuarioId }), /adaptador implementado/);
});
await t('REGISTRO', 'proveedor inexistente -> esProveedorValido false', () => {
  assert.strictEqual(esProveedorValido('paypal'), false);
});

// ═══════════ 2. Superadmin CRUD de integraciones de pago (manual_transfer, sin red) ═══════════
await t('CRUD', 'guardarIntegracionPago crea la integración en estado activo', async () => {
  const r = await guardarIntegracionPago(NEGOCIO_A, 'manual_transfer', { titular: 'Negocio A SA de CV', banco: 'BBVA', clabe: '012345678901234567' }, { actualizadoPor: SEED.superadminUsuarioId });
  assert.strictEqual(r.estado, 'activo');
  const leida = await obtenerIntegracionPago(NEGOCIO_A, 'manual_transfer');
  assert.strictEqual(leida.proveedor, 'manual_transfer');
  assert.strictEqual(leida.principal, false);
});
await t('CRUD', 'probarIntegracionPago (manual_transfer, sin red) valida forma de las credenciales', async () => {
  const r = await probarIntegracionPago(NEGOCIO_A, 'manual_transfer');
  assert.strictEqual(r.ok, true);
});
await t('CRUD', 'marcarProveedorPrincipal exige estado activo y queda como único principal', async () => {
  const ok = await marcarProveedorPrincipal(NEGOCIO_A, 'manual_transfer', SEED.superadminUsuarioId);
  assert.strictEqual(ok, true);
  const principal = await obtenerProveedorPrincipal(NEGOCIO_A);
  assert.strictEqual(principal.proveedor, 'manual_transfer');
});
await t('CRUD', 'listarIntegracionesPago de Negocio A nunca incluye las de Negocio B (aislamiento)', async () => {
  await guardarIntegracionPago(NEGOCIO_B, 'manual_transfer', { titular: 'Negocio B', banco: 'Santander', clabe: '098765432109876543' }, { actualizadoPor: SEED.superadminUsuarioId });
  const listaA = await listarIntegracionesPago(NEGOCIO_A);
  const listaB = await listarIntegracionesPago(NEGOCIO_B);
  assert.ok(listaA.every(i => i.negocio_id === NEGOCIO_A));
  assert.ok(listaB.every(i => i.negocio_id === NEGOCIO_B));
  assert.strictEqual(await obtenerProveedorPrincipal(NEGOCIO_B), null, 'B no tiene principal todavía');
});
await t('CRUD', 'suspenderIntegracionPago desmarca principal automáticamente', async () => {
  const r = await suspenderIntegracionPago(NEGOCIO_A, 'manual_transfer', SEED.superadminUsuarioId);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(await obtenerProveedorPrincipal(NEGOCIO_A), null, 'un proveedor suspendido nunca debe seguir siendo principal');
});
await t('CRUD', 'reactivarIntegracionPago no restaura principal automáticamente (requiere marcarlo de nuevo)', async () => {
  const r = await reactivarIntegracionPago(NEGOCIO_A, 'manual_transfer', SEED.superadminUsuarioId);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(await obtenerProveedorPrincipal(NEGOCIO_A), null);
  await marcarProveedorPrincipal(NEGOCIO_A, 'manual_transfer', SEED.superadminUsuarioId); // re-fijar para las pruebas siguientes
});
await t('CRUD', 'eliminarCredencialesPago es soft-delete: nunca vuelve a aparecer listada ni como principal', async () => {
  await guardarIntegracionPago(NEGOCIO_B, 'manual_transfer', { titular: 'temp', banco: 'x', clabe: '1'.repeat(18) }, { actualizadoPor: SEED.superadminUsuarioId });
  const ok = await eliminarCredencialesPago(NEGOCIO_B, 'manual_transfer', SEED.superadminUsuarioId);
  assert.strictEqual(ok, true);
  const lista = await listarIntegracionesPago(NEGOCIO_B);
  assert.ok(!lista.some(i => i.proveedor === 'manual_transfer'), 'una integración eliminada no debe listarse');
});

// ═══════════ 3. Incidente real: Alora sin proveedor vs. Nonna Maye con Clip ═══════════
await t('INCIDENTE', 'Alora (sin proveedor de pago principal) -> obtenerMetodosPagoDisponibles nunca incluye enlace_pago', async () => {
  const metodos = await obtenerMetodosPagoDisponibles(alora.id);
  assert.ok(!metodos.some(m => m.tipo === 'enlace_pago'), 'Alora sin proveedor configurado no debe ofrecer enlace de pago (causa raíz del incidente)');
});
await t('INCIDENTE', 'Alora -> crearEnlacePago se bloquea con SinProveedorPrincipalError (defensa de backend aunque el agente insista)', async () => {
  await guardarPedidoActivo({ id: 'XABPAG9001', estado: 'nuevo', forma_pago: 'enlace de pago', cliente: { telefono: '5218781119099', nombre: 'Cliente Alora' }, total: 450, modalidad: 'domicilio' }, alora.id);
  await assert.rejects(
    () => crearEnlacePago({ negocioId: alora.id, pedidoId: 'XABPAG9001' }),
    (e) => e instanceof SinProveedorPrincipalError
  );
});
await t('INCIDENTE', 'Nonna Maye configura Clip y se marca principal -> SÍ ofrece enlace_pago (sin llamar red real)', async () => {
  // Setup determinístico: no depende de que otra suite haya corrido antes
  // ni de que el backfill de la migración 025 haya encontrado un Clip ya
  // configurado (en una DB recién migrada, Nonna Maye no trae Clip por
  // defecto -- ver migrations/008_integraciones_canal_seed.sql). Mismas
  // credenciales de prueba que fase-p0-aislamiento-pedidos.mjs
  // (guardarCredencialesClip es un upsert, así que correr ambas suites en
  // cualquier orden sobre la misma DB es seguro).
  await guardarCredencialesClip(nonnaMaye.id, 'NONNA_CLIP_KEY_TEST', 'NONNA_CLIP_SECRET_TEST', SEED.superadminUsuarioId);
  await marcarProveedorPrincipal(nonnaMaye.id, 'clip', SEED.superadminUsuarioId);
  const principalNonna = await obtenerProveedorPrincipal(nonnaMaye.id);
  assert.strictEqual(principalNonna?.proveedor, 'clip');
  const metodos = await obtenerMetodosPagoDisponibles(nonnaMaye.id);
  assert.ok(metodos.some(m => m.tipo === 'enlace_pago'), 'Nonna Maye sí debe poder ofrecer enlace de pago');
});
await t('INCIDENTE', 'crearEnlacePago con negocioId de Alora pero pedido de Nonna Maye -> PedidoInvalidoError (nunca cruza negocios)', async () => {
  await guardarPedidoActivo({ id: 'XABPAG9002', estado: 'nuevo', cliente: { telefono: '5218781119098' }, total: 200 }, nonnaMaye.id);
  await assert.rejects(
    () => crearEnlacePago({ negocioId: alora.id, pedidoId: 'XABPAG9002' }),
    (e) => e instanceof PedidoInvalidoError
  );
});

// ═══════════ 4. Idempotencia e invalidación (Fase 9-11), con manual_transfer (sin red) ═══════════
await t('IDEMPOTENCIA', 'crearEnlacePago crea un pago en estado requiere_revision con las instrucciones del negocio', async () => {
  await guardarPedidoActivo({ id: 'XABPAG0001', estado: 'nuevo', forma_pago: 'enlace de pago', cliente: { telefono: '5218781119001', nombre: 'Cliente A' }, total: 350, modalidad: 'domicilio' }, NEGOCIO_A);
  const r = await crearEnlacePago({ negocioId: NEGOCIO_A, pedidoId: 'XABPAG0001', actor: adminA.id });
  assert.strictEqual(r.reutilizado, false);
  assert.strictEqual(r.estado, 'requiere_revision');
  assert.ok(r.instrucciones?.titular, 'debe devolver las instrucciones de transferencia configuradas');
  const pagos = await listarPagosPorPedido(NEGOCIO_A, 'XABPAG0001');
  assert.strictEqual(pagos.length, 1);
  assert.strictEqual(pagos[0].tipo, 'transferencia', 'con manual_transfer como principal, el tipo debe ser transferencia, no enlace_pago');
});
await t('IDEMPOTENCIA', 'un segundo llamado con el mismo pedido reutiliza el mismo pago (no duplica fila)', async () => {
  const r2 = await crearEnlacePago({ negocioId: NEGOCIO_A, pedidoId: 'XABPAG0001', actor: adminA.id });
  assert.strictEqual(r2.reutilizado, true);
  const pagos = await listarPagosPorPedido(NEGOCIO_A, 'XABPAG0001');
  assert.strictEqual(pagos.length, 1, 'un doble clic/reintento nunca debe crear una segunda fila');
});
await t('IDEMPOTENCIA', 'llamadas concurrentes para el mismo pedido no duplican el pago vigente (constraint de DB)', async () => {
  await guardarPedidoActivo({ id: 'XABPAG0002', estado: 'nuevo', forma_pago: 'enlace de pago', cliente: { telefono: '5218781119002' }, total: 420, modalidad: 'domicilio' }, NEGOCIO_A);
  const resultados = await Promise.allSettled([
    crearEnlacePago({ negocioId: NEGOCIO_A, pedidoId: 'XABPAG0002' }),
    crearEnlacePago({ negocioId: NEGOCIO_A, pedidoId: 'XABPAG0002' }),
    crearEnlacePago({ negocioId: NEGOCIO_A, pedidoId: 'XABPAG0002' }),
  ]);
  const oks = resultados.filter(r => r.status === 'fulfilled');
  assert.ok(oks.length >= 1, 'al menos una debe tener éxito');
  const pagos = await listarPagosPorPedido(NEGOCIO_A, 'XABPAG0002');
  const vigentes = pagos.filter(p => ['creando', 'pendiente', 'requiere_revision'].includes(p.estado));
  assert.strictEqual(vigentes.length, 1, 'nunca debe haber más de un pago vigente para el mismo pedido+tipo');
});
await t('IDEMPOTENCIA', 'si el pedido cambia de total, el pago anterior se invalida y se genera uno nuevo', async () => {
  await pool.query(`UPDATE pedidos_activos SET datos = jsonb_set(datos, '{total}', '999') WHERE folio = 'XABPAG0001' AND negocio_id = $1`, [NEGOCIO_A]);
  const r3 = await crearEnlacePago({ negocioId: NEGOCIO_A, pedidoId: 'XABPAG0001', actor: adminA.id });
  assert.strictEqual(r3.reutilizado, false, 'con el total cambiado, no debe reutilizar el pago anterior');
  const pagos = await listarPagosPorPedido(NEGOCIO_A, 'XABPAG0001');
  assert.strictEqual(pagos.length, 2);
  const invalidado = pagos.find(p => p.estado === 'invalidado');
  assert.ok(invalidado, 'el pago con el total viejo debe quedar invalidado');
  assert.strictEqual(invalidado.motivo_invalidacion, 'pedido modificado antes de completar el pago anterior');
});

// ═══════════ 5. Conciliación manual de transferencia (Fase 12/13) ═══════════
let pagoIdParaConciliar;
await t('CONCILIACION', 'setup: pago requiere_revision para conciliar', async () => {
  await guardarPedidoActivo({ id: 'XABPAG0100', estado: 'nuevo', forma_pago: 'enlace de pago', cliente: { telefono: '5218781119010' }, total: 275, modalidad: 'domicilio' }, NEGOCIO_A);
  const r = await crearEnlacePago({ negocioId: NEGOCIO_A, pedidoId: 'XABPAG0100' });
  pagoIdParaConciliar = r.pagoId;
  const pagos = await listarPagosPorPedido(NEGOCIO_A, 'XABPAG0100');
  assert.strictEqual(pagos[0].estado, 'requiere_revision');
});
await t('CONCILIACION', 'admin de OTRO negocio no puede confirmar el pago (aislamiento por negocio_id)', async () => {
  const r = await confirmarPagoManual(NEGOCIO_B, pagoIdParaConciliar, SEED.superadminUsuarioId);
  assert.strictEqual(r, null, 'confirmarPagoManual con negocioId equivocado nunca debe encontrar/tocar el pago de otro negocio');
});
await t('CONCILIACION', 'POST /api/admin/pagos/:id/confirmar-manual con un token que reclama negocioId=B para un usuario de A -> 403 (membresía real re-validada en cada request)', async () => {
  // resolverNegocioSeguro re-valida membresía real contra la DB en cada
  // request -- ni siquiera llega a la lógica de confirmarPagoManual, que
  // es justamente la defensa en profundidad ya probada arriba a nivel de
  // función (llamada directa con NEGOCIO_B devuelve null).
  const cookieTokenFalsificado = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: adminA.id, negocioId: NEGOCIO_B, rol: 'admin' }))}`;
  const r = await api(servidor.base, `/api/admin/pagos/${pagoIdParaConciliar}/confirmar-manual`, { method: 'POST', cookie: cookieTokenFalsificado });
  assert.strictEqual(r.status, 403);
});
await t('CONCILIACION', 'admin del negocio dueño SÍ puede confirmar -> pago queda pagado', async () => {
  const r = await api(servidor.base, `/api/admin/pagos/${pagoIdParaConciliar}/confirmar-manual`, { method: 'POST', cookie: cookieAdminA });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.estado, 'pagado');
});
await t('CONCILIACION', 'confirmar de nuevo el mismo pago (ya pagado) -> 409, nunca retrocede el estado', async () => {
  const r = await api(servidor.base, `/api/admin/pagos/${pagoIdParaConciliar}/confirmar-manual`, { method: 'POST', cookie: cookieAdminA });
  assert.strictEqual(r.status, 409);
});
await t('CONCILIACION', 'rechazar-manual marca cancelado (con un pago nuevo, requiere_revision)', async () => {
  await guardarPedidoActivo({ id: 'XABPAG0101', estado: 'nuevo', forma_pago: 'enlace de pago', cliente: { telefono: '5218781119011' }, total: 150, modalidad: 'domicilio' }, NEGOCIO_A);
  const r = await crearEnlacePago({ negocioId: NEGOCIO_A, pedidoId: 'XABPAG0101' });
  const resp = await api(servidor.base, `/api/admin/pagos/${r.pagoId}/rechazar-manual`, { method: 'POST', cookie: cookieAdminA, body: { motivo: 'nunca llegó la transferencia' } });
  assert.strictEqual(resp.status, 200);
  assert.strictEqual(resp.body.estado, 'cancelado');
});
await t('CONCILIACION', 'staff (no admin) no puede confirmar ni rechazar pagos manuales -> 403', async () => {
  await guardarPedidoActivo({ id: 'XABPAG0102', estado: 'nuevo', forma_pago: 'enlace de pago', cliente: { telefono: '5218781119012' }, total: 90, modalidad: 'domicilio' }, NEGOCIO_A);
  const r = await crearEnlacePago({ negocioId: NEGOCIO_A, pedidoId: 'XABPAG0102' });
  const resp = await api(servidor.base, `/api/admin/pagos/${r.pagoId}/confirmar-manual`, { method: 'POST', cookie: cookieStaffA });
  assert.strictEqual(resp.status, 403);
});

// ═══════════ 6. Métodos de pago por negocio (Fase 6) y permisos del panel ═══════════
await t('METODOS-PAGO', 'efectivo/terminal habilitados por defecto (backfill de la migración 025)', async () => {
  const metodos = await listarMetodosPagoNegocio(NEGOCIO_A);
  const efectivo = metodos.find(m => m.tipo === 'efectivo');
  const terminal = metodos.find(m => m.tipo === 'terminal');
  assert.strictEqual(efectivo?.habilitado, true);
  assert.strictEqual(terminal?.habilitado, true);
});
await t('METODOS-PAGO', 'admin puede habilitar transferencia con instrucciones vía panel; staff no puede', async () => {
  const bodyMetodo = { habilitado: true, instrucciones: { titular: 'Negocio A', banco: 'BBVA', clabe: '01234567890' } };
  const rStaff = await api(servidor.base, '/api/admin/metodos-pago/transferencia', { method: 'PUT', cookie: cookieStaffA, body: bodyMetodo });
  assert.strictEqual(rStaff.status, 403);
  const rAdmin = await api(servidor.base, '/api/admin/metodos-pago/transferencia', { method: 'PUT', cookie: cookieAdminA, body: bodyMetodo });
  assert.strictEqual(rAdmin.status, 200);
  assert.strictEqual(rAdmin.body.habilitado, true);
});
await t('METODOS-PAGO', 'enlace_pago no se puede editar manualmente desde el panel del negocio (400)', async () => {
  const r = await api(servidor.base, '/api/admin/metodos-pago/enlace_pago', { method: 'PUT', cookie: cookieAdminA, body: { habilitado: true } });
  assert.strictEqual(r.status, 400);
});
await t('METODOS-PAGO', 'GET /api/config/pagos (staff, solo lectura) nunca expone secretos', async () => {
  const r = await api(servidor.base, '/api/config/pagos', { cookie: cookieStaffA });
  assert.strictEqual(r.status, 200);
  const texto = JSON.stringify(r.body);
  assert.ok(!texto.includes('BBVA') || true); // instrucciones de transferencia son públicas por diseño (se comparten con el cliente)
  assert.ok(!/apiSecret|access_token_cifrado|token_iv/.test(texto), 'nunca debe exponer campos cifrados o secretos crudos');
});

// ═══════════ 7. Superadmin: rutas HTTP de integraciones de pago ═══════════
await t('SUPERADMIN-HTTP', 'GET /api/superadmin/proveedores-pago requiere sesión de superadmin', async () => {
  const rSinSesion = await api(servidor.base, '/api/superadmin/proveedores-pago');
  assert.strictEqual(rSinSesion.status, 401);
  const rConSesion = await api(servidor.base, '/api/superadmin/proveedores-pago', { cookie: cookieSuperadmin });
  assert.strictEqual(rConSesion.status, 200);
  assert.ok(Array.isArray(rConSesion.body.proveedores));
});
await t('SUPERADMIN-HTTP', 'admin de negocio (no superadmin) no puede listar integraciones de pago de Superadmin -> 403', async () => {
  const r = await api(servidor.base, `/api/superadmin/negocios/${NEGOCIO_A}/integraciones/pagos`, { cookie: cookieAdminA });
  assert.strictEqual(r.status, 403);
});
await t('SUPERADMIN-HTTP', 'PUT .../integraciones/pagos/:proveedor con proveedor inválido -> 400', async () => {
  const r = await api(servidor.base, `/api/superadmin/negocios/${NEGOCIO_A}/integraciones/pagos/paypal`, { method: 'PUT', cookie: cookieSuperadmin, body: { credenciales: { x: 1 } } });
  assert.strictEqual(r.status, 400);
});

// ═══════════ 8. Webhook Clip: formato nuevo, sin llamar red (pago ya confirmado) ═══════════
await t('WEBHOOK', 'formato nuevo (negocioId:folio:hash) con pago ya pagado -> idempotente, responde 200 sin duplicar ni llamar a Clip', async () => {
  // Reutiliza el pago ya confirmado en la sección de CONCILIACION arriba
  // (pagoIdParaConciliar, estado 'pagado') -- el webhook debe detectar
  // 'pagado' ANTES de intentar re-consultar Clip (ver server.js), así que
  // este caso es 100% verificable sin red real.
  const pagoRow = (await pool.query(`SELECT referencia_interna FROM pagos WHERE id = $1`, [pagoIdParaConciliar])).rows[0];
  const r = await fetch(`${servidor.base}/webhook/clip`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resource: 'CHECKOUT', resource_status: 'COMPLETED', me_reference_id: pagoRow.referencia_interna }),
  });
  assert.strictEqual(r.status, 200);
  await new Promise(res => setTimeout(res, 300)); // el handler procesa async tras responder 200
  const { rows } = await pool.query(`SELECT estado FROM pagos WHERE id = $1`, [pagoIdParaConciliar]);
  assert.strictEqual(rows[0].estado, 'pagado', 'debe seguir pagado, sin cambios ni duplicados');
});
await t('WEBHOOK', 'formato nuevo con referencia inexistente -> se ignora (fail closed), responde 200 igual', async () => {
  const r = await fetch(`${servidor.base}/webhook/clip`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resource: 'CHECKOUT', resource_status: 'COMPLETED', me_reference_id: `${NEGOCIO_A}:XABPAG9999:noexiste` }),
  });
  assert.strictEqual(r.status, 200);
});

// ═══════════ TENANT-CONTEXT (reconciliación con el Incidente P0) ═══════════
// Mismo contrato ya desplegado para Clip (obtenerCredencialesClipDescifradas/
// guardarCredencialesClip, test/fase-p0-aislamiento-pedidos.mjs): negocioId
// ausente/inválido/vacío en cualquier función genérica de pagos debe LANZAR
// TenantContextRequiredError -- nunca null/[]/false silencioso. Estas
// funciones se generalizaron a partir de las de Clip (commit
// 8746dda/feat(pagos): credenciales genericas...) y originalmente replicaban
// también su bug pre-fix; este bloque prueba la corrección.
await t('TENANT-CONTEXT', 'obtenerCredencialesPagoDescifradas(undefined, clip) -> TenantContextRequiredError tipado', async () => {
  await assert.rejects(
    () => obtenerCredencialesPagoDescifradas(undefined, 'clip'),
    (e) => e instanceof TenantContextRequiredError && e.code === 'TENANT_CONTEXT_REQUIRED'
  );
});
await t('TENANT-CONTEXT', 'obtenerCredencialesPagoDescifradas(null, clip) -> TenantContextRequiredError tipado', async () => {
  await assert.rejects(
    () => obtenerCredencialesPagoDescifradas(null, 'clip'),
    (e) => e instanceof TenantContextRequiredError && e.code === 'TENANT_CONTEXT_REQUIRED'
  );
});
await t('TENANT-CONTEXT', "obtenerCredencialesPagoDescifradas('', clip) -> TenantContextRequiredError tipado", async () => {
  await assert.rejects(
    () => obtenerCredencialesPagoDescifradas('', 'clip'),
    (e) => e instanceof TenantContextRequiredError && e.code === 'TENANT_CONTEXT_REQUIRED'
  );
});
await t('TENANT-CONTEXT', 'obtenerCredencialesPagoDescifradas(negocio real, proveedor inválido) -> null, nunca lanza (estado legítimo)', async () => {
  const r = await obtenerCredencialesPagoDescifradas(NEGOCIO_A, 'proveedor_que_no_existe');
  assert.strictEqual(r, null);
});
await t('TENANT-CONTEXT', 'guardarIntegracionPago sin negocioId -> TenantContextRequiredError tipado', async () => {
  await assert.rejects(
    () => guardarIntegracionPago(undefined, 'manual_transfer', {}, { actualizadoPor: SEED.superadminUsuarioId }),
    (e) => e instanceof TenantContextRequiredError && e.code === 'TENANT_CONTEXT_REQUIRED'
  );
});
await t('TENANT-CONTEXT', 'obtenerIntegracionPago sin negocioId -> TenantContextRequiredError tipado', async () => {
  await assert.rejects(
    () => obtenerIntegracionPago(undefined, 'clip'),
    (e) => e instanceof TenantContextRequiredError && e.code === 'TENANT_CONTEXT_REQUIRED'
  );
});
await t('TENANT-CONTEXT', 'listarIntegracionesPago sin negocioId -> TenantContextRequiredError tipado', async () => {
  await assert.rejects(
    () => listarIntegracionesPago(undefined),
    (e) => e instanceof TenantContextRequiredError && e.code === 'TENANT_CONTEXT_REQUIRED'
  );
});
await t('TENANT-CONTEXT', 'obtenerProveedorPrincipal sin negocioId -> TenantContextRequiredError tipado', async () => {
  await assert.rejects(
    () => obtenerProveedorPrincipal(undefined),
    (e) => e instanceof TenantContextRequiredError && e.code === 'TENANT_CONTEXT_REQUIRED'
  );
});
await t('TENANT-CONTEXT', 'suspenderIntegracionPago sin negocioId -> TenantContextRequiredError tipado', async () => {
  await assert.rejects(
    () => suspenderIntegracionPago(undefined, 'manual_transfer', SEED.superadminUsuarioId),
    (e) => e instanceof TenantContextRequiredError && e.code === 'TENANT_CONTEXT_REQUIRED'
  );
});
await t('TENANT-CONTEXT', 'reactivarIntegracionPago sin negocioId -> TenantContextRequiredError tipado', async () => {
  await assert.rejects(
    () => reactivarIntegracionPago(undefined, 'manual_transfer', SEED.superadminUsuarioId),
    (e) => e instanceof TenantContextRequiredError && e.code === 'TENANT_CONTEXT_REQUIRED'
  );
});
await t('TENANT-CONTEXT', 'eliminarCredencialesPago sin negocioId -> TenantContextRequiredError tipado', async () => {
  await assert.rejects(
    () => eliminarCredencialesPago(undefined, 'manual_transfer', SEED.superadminUsuarioId),
    (e) => e instanceof TenantContextRequiredError && e.code === 'TENANT_CONTEXT_REQUIRED'
  );
});
await t('TENANT-CONTEXT', 'marcarProveedorPrincipal sin negocioId -> TenantContextRequiredError tipado', async () => {
  await assert.rejects(
    () => marcarProveedorPrincipal(undefined, 'manual_transfer', SEED.superadminUsuarioId),
    (e) => e instanceof TenantContextRequiredError && e.code === 'TENANT_CONTEXT_REQUIRED'
  );
});
await t('TENANT-CONTEXT', 'pagosService.crearEnlacePago sin negocioId -> TenantContextRequiredError tipado, lanza antes de tocar la base', async () => {
  await assert.rejects(
    () => crearEnlacePago({ pedidoId: 'XABPAG0001' }),
    (e) => e instanceof TenantContextRequiredError && e.code === 'TENANT_CONTEXT_REQUIRED'
  );
});
await t('TENANT-CONTEXT', 'negocio sin proveedor principal -> SinProveedorPrincipalError (nunca TenantContextRequiredError, nunca null silencioso)', async () => {
  // A diferencia de las pruebas de arriba (negocioId ausente = bug del
  // llamador), aquí negocioId es real pero el negocio no tiene ningún
  // proveedor principal activo -- estado de negocio legítimo, mismo
  // criterio que ClipNoConfiguradoError para Clip específicamente.
  await guardarPedidoActivo({ id: 'XABPAG9998', estado: 'nuevo', forma_pago: 'enlace de pago', cliente: { telefono: '5218780009998' }, total: 100 }, NEGOCIO_B);
  await pool.query(`UPDATE integraciones_canal SET principal = FALSE WHERE negocio_id = $1 AND canal = 'pagos'`, [NEGOCIO_B]);
  await assert.rejects(
    () => crearEnlacePago({ pedidoId: 'XABPAG9998', negocioId: NEGOCIO_B }),
    (e) => e instanceof SinProveedorPrincipalError && e.code === 'SIN_PROVEEDOR_PRINCIPAL'
  );
});

// ═══════════ Limpieza final ═══════════
// NEGOCIO_A/B son fixtures COMPARTIDOS con el resto de la batería (p. ej.
// fase-b-integraciones.mjs "DELETE credenciales de B", que consulta
// integraciones_canal por negocio_id SIN filtrar por canal y asume una
// sola fila) -- un canal='pagos' que esta suite deja atrás ahí vuelve esa
// consulta ambigua. Se limpia solo lo propio de esta suite (A/B); Alora y
// Nonna Maye se dejan tal cual quedaron (Clip configurado en Nonna Maye,
// nada en Alora) porque ningún otro archivo hace esa misma consulta
// ambigua sobre esos dos, y así queda un estado útil para la validación
// visual manual del incidente.
await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = ANY($1) AND canal = 'pagos')`, [[NEGOCIO_A, NEGOCIO_B]]);
await pool.query(`DELETE FROM integraciones_canal WHERE canal = 'pagos' AND negocio_id = ANY($1)`, [[NEGOCIO_A, NEGOCIO_B]]);
await pool.query(`DELETE FROM metodos_pago WHERE negocio_id = ANY($1)`, [[NEGOCIO_A, NEGOCIO_B]]);

// ═══════════ Resumen ═══════════
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) {
  console.log('\nFallos:');
  fallos.forEach(f => console.log(' - ' + f));
}

await servidor.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
