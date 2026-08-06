// Red de repartidores POR NEGOCIO (Frente B del MVP de escala).
// Cubre: migración 038, evaluación de solicitud (activa/horario/cobertura/
// modo manual), costo, configuración HTTP con roles y aislamiento,
// integración end-to-end con el motor real de notificaciones (meta mock):
// red inactiva no oferta, activa sí, solicitud manual bloquea el automático
// y habilita el endpoint manual, cobertura por colonia, y la central de
// reparto de Superadmin con estados derivados.
//
// Uso: DATABASE_URL=... PANEL_SECRET=... SESSION_SECRET=... ADMIN_PASSWORD=...
//      INTEGRATIONS_ENCRYPTION_KEY=... node test/fase-red-por-negocio.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4940';

const { pool, actualizarConfiguracion, registrarRepartidor, asignarRepartidor } = await import('../src/services/database.js');
const { obtenerConfigRed, guardarConfigRed, evaluarSolicitudRed, calcularCostoRed, obtenerCentralReparto } = await import('../src/services/redRepartidores.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
async function esperarHasta(fn, { timeoutMs = 6000, intervaloMs = 150 } = {}) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) { const r = await fn(); if (r) return r; await esperar(intervaloMs); }
  return null;
}

// ═══════════ Unit: evaluarSolicitudRed / calcularCostoRed ═══════════
const enHora = (hhmm) => new Date(`2026-08-06T${hhmm}:00-05:00`); // America/Matamoros = UTC-5 en agosto

await t('EVALUACION', 'sin config -> procede (comportamiento legado intacto)', async () => {
  const r = evaluarSolicitudRed({ cliente: {} }, null, 'auto');
  assert.strictEqual(r.procede, true);
  assert.strictEqual(r.razon, 'sin_config_legado');
});
await t('EVALUACION', 'red inactiva -> nunca procede, ni en manual', async () => {
  const cfg = { red_activa: false };
  assert.strictEqual(evaluarSolicitudRed({}, cfg, 'auto').procede, false);
  assert.strictEqual(evaluarSolicitudRed({}, cfg, 'manual').procede, false);
});
await t('EVALUACION', 'solicitud_automatica=false bloquea auto pero permite manual', async () => {
  const cfg = { red_activa: true, solicitud_automatica: false };
  assert.strictEqual(evaluarSolicitudRed({}, cfg, 'auto').razon, 'solicitud_manual_requerida');
  assert.strictEqual(evaluarSolicitudRed({}, cfg, 'manual').procede, true);
});
await t('EVALUACION', 'horario: dentro procede, fuera no, y el cruce de medianoche funciona', async () => {
  const cfg = { red_activa: true, horario_inicio: '09:00', horario_fin: '22:00' };
  assert.strictEqual(evaluarSolicitudRed({}, cfg, 'auto', enHora('12:00')).procede, true);
  assert.strictEqual(evaluarSolicitudRed({}, cfg, 'auto', enHora('23:30')).razon, 'fuera_de_horario');
  const nocturno = { red_activa: true, horario_inicio: '18:00', horario_fin: '02:00' };
  assert.strictEqual(evaluarSolicitudRed({}, nocturno, 'auto', enHora('23:30')).procede, true);
  assert.strictEqual(evaluarSolicitudRed({}, nocturno, 'auto', enHora('12:00')).razon, 'fuera_de_horario');
});
await t('EVALUACION', 'cobertura por colonia: incluida procede, excluida no, sin colonia no', async () => {
  const cfg = { red_activa: true, zonas: ['Centro', 'Las Fuentes'] };
  assert.strictEqual(evaluarSolicitudRed({ cliente: { colonia: 'centro' } }, cfg, 'auto').procede, true);
  assert.strictEqual(evaluarSolicitudRed({ cliente: { colonia: 'Otra' } }, cfg, 'auto').razon, 'fuera_de_cobertura');
  assert.strictEqual(evaluarSolicitudRed({ cliente: {} }, cfg, 'auto').razon, 'sin_colonia_para_evaluar_cobertura');
});
await t('COSTO', 'costo base + por km y quién absorbe', async () => {
  const cfg = { costo_base: 35, costo_por_km: 8, quien_absorbe: 'compartido' };
  assert.deepStrictEqual(calcularCostoRed(cfg), { costo: 35, quienAbsorbe: 'compartido' });
  assert.deepStrictEqual(calcularCostoRed(cfg, 3), { costo: 59, quienAbsorbe: 'compartido' });
  assert.strictEqual(calcularCostoRed(null), null);
});

// ═══════════ Persistencia + aislamiento ═══════════
await t('CONFIG', 'migración 038 presente; guardar valida horario y zonas', async () => {
  const tabla = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name='red_repartidores_config'`);
  assert.strictEqual(tabla.rows.length, 1);
  await assert.rejects(() => guardarConfigRed(SEED.negocioA, { horario_inicio: '25:99' }), e => e.code === 'CONFIG_INVALIDA');
  await assert.rejects(() => guardarConfigRed(SEED.negocioA, { zonas: 'centro' }), e => e.code === 'CONFIG_INVALIDA');
});
await t('CONFIG', 'la config de A nunca toca a B (aislamiento)', async () => {
  await guardarConfigRed(SEED.negocioA, { red_activa: true, costo_base: 45 });
  const a = await obtenerConfigRed(SEED.negocioA);
  const b = await obtenerConfigRed(SEED.negocioB);
  assert.strictEqual(a.red_activa, true);
  assert.strictEqual(Number(a.costo_base), 45);
  assert.strictEqual(b, null, 'B nunca configuró su red -- sigue en modo legado');
});

// ═══════════ Setup HTTP end-to-end (mismo patrón que tiempo-real) ═══════════
const sufijo = Date.now().toString().slice(-6);
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}
await fijarModulo(SEED.negocioA, 'pos', 'activo');
await fijarModulo(SEED.negocioA, 'repartidores', 'activo');
await actualizarConfiguracion({ int_wa_phone_id: `PNID_RN_${sufijo}`, int_wa_token: 'fake-token-rn' }, SEED.negocioA);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,'Red Negocio A',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [SEED.negocioA, `PNID_RN_${sufijo}`]);
await actualizarConfiguracion({ repartidor_notif_modo: 'completo', repartidor_notif_plantilla_v2_activo: 'true' }, SEED.negocioA);

const metaMock = await arrancarMetaMock();
const srv = await arrancarServidor({ PORT: PUERTO, META_GRAPH_BASE_URL: metaMock.baseUrl }, { timeoutMs: 30000 });
const base = srv.base;
const cookieAdminA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: SEED.negocioA, rol: 'admin' }))}`;
const cookieStaffA = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.staffNegocioAUsuarioId, negocioId: SEED.negocioA, rol: 'staff' }))}`;
const cookieSuperadmin = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.superadminUsuarioId, negocioId: SEED.negocioA, rol: 'admin' }))}`;

async function api(path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
async function crearPedidoPrueba() {
  const r = await api('/test/pedido', { cookie: cookieAdminA, method: 'POST' });
  assert.strictEqual(r.status, 200);
  return r.body.pedido.id;
}
async function conteoNotificaciones(folio) {
  const { rows } = await pool.query(`SELECT count(*)::int AS c FROM notificaciones_repartidor WHERE pedido_folio = $1`, [folio]);
  return rows[0].c;
}

const repA = await registrarRepartidor(`RN Disp ${sufijo}`, `87806${sufijo}`, SEED.negocioA);

// ═══════════ HTTP: configuración con roles ═══════════
await t('HTTP-CONFIG', 'admin lee y guarda; staff 403; sin sesión 401', async () => {
  const rGet = await api('/api/config/red-repartidores', { cookie: cookieAdminA });
  assert.strictEqual(rGet.status, 200);
  const rPut = await api('/api/config/red-repartidores', { cookie: cookieAdminA, method: 'PUT', body: { red_activa: true, zonas: ['Centro'], costo_base: 40 } });
  assert.strictEqual(rPut.status, 200);
  assert.strictEqual(rPut.body.config.red_activa, true);
  const rStaff = await api('/api/config/red-repartidores', { cookie: cookieStaffA, method: 'PUT', body: { red_activa: false } });
  assert.strictEqual(rStaff.status, 403);
  const rNada = await api('/api/config/red-repartidores');
  assert.strictEqual(rNada.status, 401);
});

// ═══════════ E2E con el motor real de ofertas ═══════════
await t('E2E', 'red activa + cobertura Centro -> el pedido SÍ genera ofertas', async () => {
  // /test/pedido usa colonia 'Centro' en su fixture.
  await guardarConfigRed(SEED.negocioA, { red_activa: true, zonas: ['Centro'], solicitud_automatica: true, horario_inicio: null, horario_fin: null });
  const folio = await crearPedidoPrueba();
  const n = await esperarHasta(async () => (await conteoNotificaciones(folio)) > 0);
  assert.ok(n, 'debía registrarse al menos una oferta');
});

await t('E2E', 'red inactiva -> el mismo flujo NO genera ninguna oferta', async () => {
  await guardarConfigRed(SEED.negocioA, { red_activa: false });
  const folio = await crearPedidoPrueba();
  await esperar(2500); // margen: si fuera a ofertar, ya habría fila
  assert.strictEqual(await conteoNotificaciones(folio), 0);
});

await t('E2E', 'fuera de cobertura -> no oferta; dentro -> oferta', async () => {
  await guardarConfigRed(SEED.negocioA, { red_activa: true, zonas: ['Colonia Inexistente'] });
  const folioFuera = await crearPedidoPrueba();
  await esperar(2500);
  assert.strictEqual(await conteoNotificaciones(folioFuera), 0, 'Centro no está en zonas -> sin oferta');
  await guardarConfigRed(SEED.negocioA, { zonas: ['Centro'] });
  const folioDentro = await crearPedidoPrueba();
  const n = await esperarHasta(async () => (await conteoNotificaciones(folioDentro)) > 0);
  assert.ok(n);
});

await t('E2E', 'solicitud_automatica=false: el pedido no oferta solo; el endpoint manual sí; folio ajeno 404', async () => {
  await guardarConfigRed(SEED.negocioA, { red_activa: true, zonas: [], solicitud_automatica: false });
  const folio = await crearPedidoPrueba();
  await esperar(2500);
  assert.strictEqual(await conteoNotificaciones(folio), 0, 'en modo manual el pedido nunca oferta solo');
  const rManual = await api(`/api/pedidos/${folio}/solicitar-repartidor`, { cookie: cookieAdminA, method: 'POST' });
  assert.strictEqual(rManual.status, 200);
  const n = await esperarHasta(async () => (await conteoNotificaciones(folio)) > 0);
  assert.ok(n, 'la solicitud manual debía generar la oferta');
  const r404 = await api('/api/pedidos/XAB-9999/solicitar-repartidor', { cookie: cookieAdminA, method: 'POST' });
  assert.strictEqual(r404.status, 404);
});

// ═══════════ Central de reparto (Superadmin) ═══════════
await t('CENTRAL', 'estados derivados buscando/asignado y filtro por estado', async () => {
  await guardarConfigRed(SEED.negocioA, { red_activa: true, zonas: [], solicitud_automatica: true });
  const folio = await crearPedidoPrueba();
  await esperarHasta(async () => (await conteoNotificaciones(folio)) > 0);
  const buscando = await obtenerCentralReparto({ estado: 'buscando', negocioId: SEED.negocioA });
  assert.ok(buscando.servicios.some(s => s.folio === folio), 'recién creado debe estar en buscando');
  const ok = await asignarRepartidor(folio, repA.id, repA.nombre, SEED.negocioA);
  assert.strictEqual(ok, true);
  const asignado = await obtenerCentralReparto({ estado: 'asignado', negocioId: SEED.negocioA });
  const fila = asignado.servicios.find(s => s.folio === folio);
  assert.ok(fila, 'tras asignar debe aparecer como asignado');
  assert.strictEqual(String(fila.repartidor_id), String(repA.id));
  assert.ok(Number(fila.ofertas_enviadas) >= 1);
});

await t('CENTRAL', 'HTTP: superadmin 200 con paginado; admin de negocio 403', async () => {
  const rS = await api('/api/superadmin/red-repartidores/central?limit=5', { cookie: cookieSuperadmin });
  assert.strictEqual(rS.status, 200);
  assert.ok(Array.isArray(rS.body.servicios));
  const rA = await api('/api/superadmin/red-repartidores/central', { cookie: cookieAdminA });
  assert.strictEqual(rA.status, 403);
});

await t('CENTRAL', 'Rappi nunca aparece en la central', async () => {
  const todos = await obtenerCentralReparto({ negocioId: SEED.negocioA, limit: 100 });
  assert.ok(todos.servicios.every(s => s.modalidad === 'entrega a domicilio'));
});

// Limpieza: dejar al negocio A sin configuración de red para no contaminar
// otras suites que corran después en esta misma base (comportamiento legado).
await pool.query('DELETE FROM red_repartidores_config WHERE negocio_id = $1', [SEED.negocioA]);

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(` - ${f}`)); }
await srv.detener();
await metaMock.detener?.();
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
